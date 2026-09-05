import { describe, expect, it, vi } from "vitest";
import { FakeClock } from "../../src/core/clock.js";
import { DEFAULT_BUDGET } from "../../src/core/deadline.js";
import { MemoryRunStore } from "../../src/core/store.js";
import type { AgentTypeConfig } from "../../src/core/types.js";
import type { SessionDriver, SessionHandle, SessionSpec } from "../../src/runtime/session-driver.js";
import { EscalatingReaper } from "../../src/runtime/reaper.js";
import { SingleSlotPool } from "../../src/runtime/slot-pool.js";
import { EventWatchdog } from "../../src/runtime/watchdog.js";
import { createRuntimeRunnerAdapter } from "../../src/service/runtime-adapter.js";
import { mergeExtensionPoints } from "../../src/extensions/registry.js";
import { buildToolScopePolicy, createToolScopeEnforcer } from "../../src/runtime/tool-scope.js";

const budget = {
  ...DEFAULT_BUDGET,
  queueWaitMs: 20,
  startupMs: 20,
  bindMs: 20,
  firstEventMs: 20,
  idleMs: 20,
  toolMs: 20,
  totalMs: 100,
  abortGraceMs: 5,
  steerMs: 10,
  reapMs: 10,
};
const type = (tools?: string[]): AgentTypeConfig => ({
  name: "worker" as AgentTypeConfig["name"],
  description: "worker",
  systemPrompt: "",
  promptMode: "append",
  ...(tools ? { tools } : {}),
});
const outcome = {
  status: "completed" as const,
  turns: 0,
  durationMs: 0,
  diag: {
    createdAt: 0,
    phase: "settled" as const,
    phaseEnteredAt: 0,
    pendingTools: 0,
    turns: 0,
    escalation: [],
    orphaned: false,
    generation: 1,
    degraded: [],
    staleInputs: 0,
    unkillable: [],
  },
};
const notifier = {
  enqueue: vi.fn(),
  finalize: vi.fn(),
  settleBatch: vi.fn(),
  peek: vi.fn(),
  consume: vi.fn(),
  reconcile: vi.fn(),
  verifyPersisted: vi.fn(),
  stats: { staged: 0, pending: 0, batched: 0, delivered: 0, consumed: 0, dropped: 0, abandoned: 0 },
  degraded: [],
};
function makeHandle(active: string[] = []): SessionHandle {
  return {
    sessionId: "s1",
    sessionFile: undefined,
    prompt: async () => undefined,
    steer: async () => undefined,
    requestAbort: async () => undefined,
    dispose: () => ({ returned: true, killed: 0, unkillable: [] }),
    killableHandles: new Set(),
    setActiveTools: (names) => {
      active.splice(0, active.length, ...names);
    },
    getActiveTools: () => active,
    getLastAssistantText: () => "",
    getUsage: () => undefined,
  };
}
async function runWith(driver: SessionDriver, fabric?: { router: unknown }) {
  const clock = new FakeClock();
  const store = new MemoryRunStore();
  const runner = createRuntimeRunnerAdapter({
    clock,
    pool: new SingleSlotPool(clock, 1),
    store,
    watchdog: new EventWatchdog({ clock, budget, getState: () => undefined, dispatch: () => undefined }),
    reaper: new EscalatingReaper(clock),
    notifier,
    driver,
    ...(fabric ? { fabric: fabric as never } : {}),
  });
  const promise = runner.run({ runId: "r_CHILD01", type: type(), request: { type: "worker", prompt: "hi" }, budget });
  for (let i = 0; i < 10; i++) {
    await Promise.resolve();
    clock.advance(1);
  }
  await promise;
  return store;
}

describe("service/runtime-adapter prompt diagnostics", () => {
  it("persists a capped dispatch prompt for fresh and resumed runs", async () => {
    const driver: SessionDriver = {
      create: async () => makeHandle(),
      bind: async () => undefined,
      onLateArrival: () => undefined,
    };
    const store = await runWith(driver);
    expect(store.get("r_CHILD01")?.diag.taskPrompt).toBe("hi");

    const longPrompt = "x".repeat(5000);
    const clock = new FakeClock();
    const longStore = new MemoryRunStore();
    const runner = createRuntimeRunnerAdapter({
      clock,
      pool: new SingleSlotPool(clock, 1),
      store: longStore,
      watchdog: new EventWatchdog({ clock, budget, getState: () => undefined, dispatch: () => undefined }),
      reaper: new EscalatingReaper(clock),
      notifier,
      driver,
    });
    await runner.run({ runId: "r_LONG", type: type(), request: { type: "worker", prompt: longPrompt }, budget });
    expect(longStore.get("r_LONG")?.diag.taskPrompt).toHaveLength(4096);

    await runner.run({
      runId: "r_RESUMED",
      type: type(),
      request: { type: "worker", prompt: "new resume prompt", resumeFrom: "old-session.json" },
      budget,
    });
    expect(longStore.get("r_RESUMED")?.diag.taskPrompt).toBe("new resume prompt");
  });
});

describe("service/runtime-adapter fabric wiring", () => {
  it("injects message_agent only when fabric is enabled", async () => {
    let withFabric: string[] | undefined;
    const driver: SessionDriver = {
      create: async (spec: SessionSpec) => {
        withFabric = spec.customTools?.map((tool) => (tool as { name: string }).name) ?? [];
        return makeHandle();
      },
      bind: async () => undefined,
      onLateArrival: () => undefined,
    };
    await runWith(driver, { router: {} });
    expect(withFabric).toContain("message_agent");

    let withoutFabric: string[] | undefined;
    await runWith({
      ...driver,
      create: async (spec) => {
        withoutFabric = spec.customTools?.map((tool) => (tool as { name: string }).name) ?? [];
        return makeHandle();
      },
    });
    expect(withoutFabric).not.toContain("message_agent");
  });

  it("strips reserved same-name tools when they are not granted", () => {
    const active = ["message_agent", "custom"];
    const enforcer = createToolScopeEnforcer();
    const decision = enforcer.onBind(
      {
        getActiveTools: () => active,
        setActiveTools: (names) => {
          active.splice(0, active.length, ...names);
        },
      },
      buildToolScopePolicy({ tools: ["custom"] }),
    );
    expect(decision.applied).toEqual(["custom"]);
    expect(active).toEqual(["custom"]);
    const merged = mergeExtensionPoints([
      {
        onLifecycle: () => {
          throw new Error("observer failed");
        },
      },
    ]);
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    merged.onLifecycle?.({ runId: "r_CHILD01", generation: 1, status: "failed", at: 0 });
    expect(warn).toHaveBeenCalledWith(expect.stringContaining("extension hook onLifecycle threw"));
    warn.mockRestore();
    expect(active).toEqual(["custom"]);
  });
});

describe("message_agent generation probe (regression)", () => {
  it("resolves the live generation mid-run — persist_snapshot is terminal-only, so the store must NOT be the probe source", async () => {
    const admitted: Array<{ generation?: unknown }> = [];
    const router = {
      admit: (_from: unknown, msg: { generation?: unknown }) => {
        admitted.push(msg);
        return { accepted: true };
      },
    };
    let tool: { execute: (id: string, params: unknown) => Promise<unknown> } | undefined;
    let toolError: unknown;
    const driver: SessionDriver = {
      create: async (spec: SessionSpec) => {
        tool = spec.customTools?.find((t) => (t as { name: string }).name === "message_agent") as never;
        const handle = makeHandle();
        // Execute the tool while the run is genuinely in-flight (prompt dispatch),
        // when the store is guaranteed to hold no snapshot for this run.
        handle.prompt = async () => {
          try {
            await tool!.execute("tc1", { to: "root", kind: "finding", text: "mid-run hello" });
          } catch (err) {
            toolError = err;
          }
        };
        return handle;
      },
      bind: async () => undefined,
      onLateArrival: () => undefined,
    };
    await runWith(driver, { router });
    expect(toolError).toBeUndefined();
    expect(admitted).toHaveLength(1);
    expect(Number.isInteger(admitted[0]!.generation)).toBe(true);
    expect(admitted[0]!.generation).toBe(1);
  });
});
