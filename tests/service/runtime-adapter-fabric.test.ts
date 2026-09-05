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
  const runner = createRuntimeRunnerAdapter({
    clock,
    pool: new SingleSlotPool(clock, 1),
    store: new MemoryRunStore(),
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
}

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
