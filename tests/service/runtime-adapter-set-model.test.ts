import { describe, expect, it, vi } from "vitest";
import { FakeClock } from "../../src/core/clock.js";
import { DEFAULT_BUDGET } from "../../src/core/deadline.js";
import { MemoryRunStore } from "../../src/core/store.js";
import type { AgentTypeConfig } from "../../src/core/types.js";
import type { SessionDriver, SessionHandle, SessionSpec } from "../../src/runtime/session-driver.js";
import { EscalatingReaper } from "../../src/runtime/reaper.js";
import { SingleSlotPool } from "../../src/runtime/slot-pool.js";
import { EventWatchdog } from "../../src/runtime/watchdog.js";
import { buildToolScopePolicy, createToolScopeEnforcer } from "../../src/runtime/tool-scope.js";
import { createRuntimeRunnerAdapter } from "../../src/service/runtime-adapter.js";

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
function makeHandle(overrides: Partial<SessionHandle> = {}): SessionHandle {
  return {
    sessionId: "s1",
    sessionFile: undefined,
    prompt: async () => undefined,
    steer: async () => undefined,
    requestAbort: async () => undefined,
    dispose: () => ({ returned: true, killed: 0, unkillable: [] }),
    killableHandles: new Set(),
    setActiveTools: () => undefined,
    getActiveTools: () => [],
    getLastAssistantText: () => "",
    getUsage: () => undefined,
    ...overrides,
  };
}
interface InjectedTool {
  name: string;
  execute: (id: string, params: Record<string, unknown>) => Promise<{ content: { text: string }[] }>;
}
async function runWith(
  driver: SessionDriver,
  extra: { resolveModelHint?: (hint: string) => { provider: string; id: string } | undefined } = {},
  runType: AgentTypeConfig = type(),
  runId = "r_SM01",
) {
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
    ...(extra.resolveModelHint ? { resolveModelHint: extra.resolveModelHint } : {}),
  });
  const promise = runner.run({ runId, type: runType, request: { type: "worker", prompt: "hi" }, budget });
  for (let i = 0; i < 10; i++) {
    await Promise.resolve();
    clock.advance(1);
  }
  await promise;
  return store;
}

describe("service/runtime-adapter set_model injection", () => {
  it("① every run's customTools contain a set_model instance", async () => {
    let names: string[] = [];
    const driver: SessionDriver = {
      create: async (spec: SessionSpec) => {
        names = spec.customTools?.map((tool) => (tool as { name: string }).name) ?? [];
        return makeHandle();
      },
      bind: async () => undefined,
      onLateArrival: () => undefined,
    };
    await runWith(driver);
    expect(names).toContain("set_model");
  });

  it("② the injected instance is bound to its own run: self-switch hits this run's live session, foreign run_id is refused", async () => {
    let tool: InjectedTool | undefined;
    let switched: unknown;
    let toolError: unknown;
    let toolResult: string | undefined;
    const driver: SessionDriver = {
      create: async (spec: SessionSpec) => {
        tool = spec.customTools?.find((t) => (t as { name: string }).name === "set_model") as InjectedTool | undefined;
        const h = makeHandle({
          setModel: async (m) => {
            switched = m;
          },
          getModelRef: () => ({ provider: "anthropic", id: "claude-haiku-4" }),
          getThinkingLevel: () => "low",
        });
        // Execute the tool while the run is genuinely in-flight.
        h.prompt = async () => {
          try {
            const r = await tool!.execute("tc1", { model: "haiku" });
            toolResult = r.content[0]!.text;
            await tool!.execute("tc2", { model: "haiku", run_id: "r_OTHER" }).catch((e) => {
              throw e;
            });
          } catch (err) {
            toolError = err;
          }
        };
        return h;
      },
      bind: async () => undefined,
      onLateArrival: () => undefined,
      resolveModelRef: (p, id) => ({ resolved: `${p}/${id}` }),
    };
    const store = await runWith(driver, { resolveModelHint: () => ({ provider: "anthropic", id: "claude-haiku-4" }) });
    // Self-switch went through the runner into THIS run's handle.
    expect(switched).toEqual({ resolved: "anthropic/claude-haiku-4" });
    expect(toolResult).toContain("anthropic/claude-haiku-4");
    // diag.model followed the switch (model_changed dispatch through the state machine).
    expect(store.get("r_SM01")?.outcome?.diag.model).toEqual({ provider: "anthropic", id: "claude-haiku-4" });
    // Foreign run_id refused (self-only, D-2/E8).
    expect(String(toolError)).toMatch(/only switch your own model/);
  });

  it("③ grantedReserved covers set_model: policy does not deny it for this run; an ungranted run strips a same-name tool", () => {
    const granted = buildToolScopePolicy({ granted: ["set_model"] });
    expect(granted.deny.has("set_model")).toBe(false);
    const ungranted = buildToolScopePolicy({});
    expect(ungranted.deny.has("set_model")).toBe(true);
    const active = ["set_model", "read"];
    const enforcer = createToolScopeEnforcer();
    const decision = enforcer.onBind(
      {
        getActiveTools: () => active,
        setActiveTools: (names) => {
          active.splice(0, active.length, ...names);
        },
      },
      ungranted,
    );
    expect(decision.applied).toEqual(["read"]);
    expect(active).toEqual(["read"]);
  });

  it("④ M1: for an agent type declaring a tools: allowlist, the pi-level sessionSpec.tools gains set_model (the injection is not silently dropped by pi's registry filter)", async () => {
    let spec: SessionSpec | undefined;
    const driver: SessionDriver = {
      create: async (s: SessionSpec) => {
        spec = s;
        return makeHandle();
      },
      bind: async () => undefined,
      onLateArrival: () => undefined,
    };
    await runWith(driver, {}, type(["read", "bash"]));
    expect(spec?.tools).toContain("read");
    expect(spec?.tools).toContain("bash");
    expect(spec?.tools).toContain("set_model");
    // customTools still carries the actual definition alongside the allowlist entry.
    expect(spec?.customTools?.map((t) => (t as { name: string }).name)).toContain("set_model");
  });
});
