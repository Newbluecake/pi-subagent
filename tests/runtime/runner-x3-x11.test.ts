import { describe, expect, it, vi } from "vitest";
import { DEFAULT_BUDGET } from "../../src/core/deadline.js";
import { FakeClock } from "../../src/core/clock.js";
import { SingleSlotPool } from "../../src/runtime/slot-pool.js";
import { BasicEffectInterpreter, RuntimeRunner, type ResolvedSpawnRequest } from "../../src/runtime/runner.js";
import type { DriverEvent } from "../../src/core/types.js";
import type { SessionDriver, SessionHandle } from "../../src/runtime/session-driver.js";
import { EscalatingReaper } from "../../src/runtime/reaper.js";
import type { Watchdog } from "../../src/runtime/watchdog.js";
import { createToolScopeEnforcer, buildToolScopePolicy } from "../../src/runtime/tool-scope.js";

const budget = {
  ...DEFAULT_BUDGET,
  queueWaitMs: 10,
  startupMs: 10,
  bindMs: 10,
  totalMs: 200,
  abortGraceMs: 5,
  reapMs: 5,
  steerMs: 2,
};
function handle(overrides: Partial<SessionHandle> = {}): SessionHandle {
  return {
    sessionId: "s",
    sessionFile: undefined,
    prompt: () => Promise.resolve(),
    steer: () => Promise.resolve(),
    requestAbort: () => Promise.resolve(),
    dispose: () => ({ returned: true, killed: 0, unkillable: [] }),
    killableHandles: new Set(),
    setActiveTools: () => undefined,
    getActiveTools: () => [],
    getLastAssistantText: () => undefined,
    getUsage: () => undefined,
    ...overrides,
  };
}
class FakeWatchdog implements Watchdog {
  arm() {}
  disarm() {}
  tick() {}
}
function deps(clock: FakeClock, driver: SessionDriver) {
  const pool = new SingleSlotPool(clock, 1);
  const store = { put() {}, get: () => undefined, list: () => [], appendOutbox() {} };
  const reaper = new EscalatingReaper(clock);
  const effects = new BasicEffectInterpreter();
  return { clock, driver, pool, store, watchdog: new FakeWatchdog(), reaper, effects, emit() {}, deliver() {} };
}
async function drain(clock: FakeClock, ticks: number, stepMs = 1) {
  for (let i = 0; i < ticks; i++) {
    await Promise.resolve();
    clock.advance(stepMs);
    await Promise.resolve();
  }
}

describe("RuntimeRunner: X11 tool-scope wiring (runtime/runner.ts <-> runtime/tool-scope.ts)", () => {
  it("applies onBind after a successful bind, and re-applies onTurnBoundary at every turn_end", async () => {
    const clock = new FakeClock();
    let onEvent: ((e: DriverEvent) => void) | undefined;
    let active = ["Read", "Bash"];
    const h = handle({
      getActiveTools: () => active,
      setActiveTools: (names) => {
        active = names;
      },
      prompt: async () => {
        onEvent?.({ t: "turn_end", toolResults: 0 });
      },
    });
    const driver: SessionDriver = {
      create: async () => h,
      bind: async (_h, cb) => {
        onEvent = cb;
      },
      onLateArrival() {},
    };
    const setCalls: string[][] = [];
    const enforcer = createToolScopeEnforcer();
    const req: ResolvedSpawnRequest = {
      runId: "r",
      prompt: "hi",
      toolScope: { policy: buildToolScopePolicy({ tools: ["Read"] }), enforcer },
    };
    const runner = new RuntimeRunner(deps(clock, driver));
    // Wrap setActiveTools so we can see both the onBind call (before prompt())
    // and the onTurnBoundary call (from inside prompt()), while the handle
    // itself keeps behaving like a real session (getActiveTools reflects the
    // last setActiveTools call).
    const realSet = h.setActiveTools.bind(h);
    h.setActiveTools = (names) => {
      setCalls.push([...names]);
      realSet(names);
    };
    const p = runner.run(req, budget);
    await drain(clock, 20);
    const outcome = await p;
    expect(outcome.status).toBe("completed");
    // onBind (["Bash","Read"] -> filtered to ["Read"]) then onTurnBoundary
    // sees the same active set again -> no second call (unchanged).
    expect(setCalls).toEqual([["Read"]]);
  });

  it("TS4/late-registration: a tool that only appears at turn_end (not at bind) is stripped, and onBlocked fires", async () => {
    const clock = new FakeClock();
    let onEvent: ((e: DriverEvent) => void) | undefined;
    let active = ["Read"];
    const h = handle({
      getActiveTools: () => active,
      setActiveTools: (names) => {
        active = names;
      },
      prompt: async () => {
        active = ["Read", "mcp_evil_tool"]; // simulated late MCP registration
        onEvent?.({ t: "turn_end", toolResults: 0 });
      },
    });
    const driver: SessionDriver = {
      create: async () => h,
      bind: async (_h, cb) => {
        onEvent = cb;
      },
      onLateArrival() {},
    };
    const setCalls: string[][] = [];
    const realSet2 = h.setActiveTools.bind(h);
    h.setActiveTools = (names) => {
      setCalls.push([...names]);
      realSet2(names);
    };
    const blocked: string[][] = [];
    const enforcer = createToolScopeEnforcer({ onBlocked: (n) => blocked.push([...n]) });
    const req: ResolvedSpawnRequest = {
      runId: "r",
      prompt: "hi",
      toolScope: { policy: buildToolScopePolicy({ tools: ["Read"] }), enforcer },
    };
    const runner = new RuntimeRunner(deps(clock, driver));
    const p = runner.run(req, budget);
    await drain(clock, 20);
    await p;
    expect(blocked).toEqual([["mcp_evil_tool"]]);
    expect(setCalls[setCalls.length - 1]).toEqual(["Read"]); // stripped back down
  });

  /**
   * Race guard (architecture §7.5 "竞态处理"): a turn_end event that arrives
   * after the run has already reached a terminal state must not trigger
   * setActiveTools on a handle that may already be disposed. This directly
   * exercises the isTerminalStatus() check inside RuntimeRunner's bind
   * callback (runtime/runner.ts) — not a stub: it fires a *real* extra event
   * through the same captured onEvent callback the driver used, after
   * run() has already resolved.
   */
  it("does not call setActiveTools for a turn_end event delivered after the run has already settled", async () => {
    const clock = new FakeClock();
    let onEvent: ((e: DriverEvent) => void) | undefined;
    const h = handle({
      getActiveTools: () => ["Read"],
      prompt: async () => undefined,
    });
    const driver: SessionDriver = {
      create: async () => h,
      bind: async (_h, cb) => {
        onEvent = cb;
      },
      onLateArrival() {},
    };
    const setActiveTools = vi.fn();
    h.setActiveTools = setActiveTools;
    const onTurnBoundary = vi.fn(() => ({ applied: [], blockedNewcomers: [], changed: false }));
    const enforcer = { onBind: () => ({ applied: [], blockedNewcomers: [], changed: false }), onTurnBoundary };
    const req: ResolvedSpawnRequest = {
      runId: "r",
      prompt: "hi",
      toolScope: { policy: buildToolScopePolicy({ tools: ["Read"] }), enforcer },
    };
    const runner = new RuntimeRunner(deps(clock, driver));
    const p = runner.run(req, budget);
    await drain(clock, 20);
    const outcome = await p;
    expect(outcome.status).toBe("completed");
    onTurnBoundary.mockClear();
    // Late/racy delivery after settle — must be ignored, not forwarded to the enforcer.
    onEvent?.({ t: "turn_end", toolResults: 0 });
    expect(onTurnBoundary).not.toHaveBeenCalled();
  });
});

describe("RuntimeRunner: X3 onChildAbort cascade funnel point", () => {
  it("calls onChildAbort(runId, 'parent_abort') when the run is explicitly aborted", async () => {
    const clock = new FakeClock();
    const never = <T>() => new Promise<T>(() => undefined);
    const driver: SessionDriver = {
      create: async () => handle({ prompt: () => never() }),
      bind: async () => undefined,
      onLateArrival() {},
    };
    const cascaded: Array<{ runId: string; cause: string }> = [];
    const runner = new RuntimeRunner({
      ...deps(clock, driver),
      onChildAbort: (runId, cause) => cascaded.push({ runId, cause }),
    });
    const req: ResolvedSpawnRequest = { runId: "parent", prompt: "hi" };
    const p = runner.run(req, budget);
    await drain(clock, 3);
    const result = await runner.abortRun("parent", "user_stop");
    expect(result.ok).toBe(true);
    await drain(clock, 10);
    await p;
    expect(cascaded).toEqual([{ runId: "parent", cause: "parent_abort" }]);
  });

  it("calls onChildAbort when the run's own external signal is aborted (not just explicit abortRun())", async () => {
    const clock = new FakeClock();
    const never = <T>() => new Promise<T>(() => undefined);
    const driver: SessionDriver = {
      create: async () => handle({ prompt: () => never() }),
      bind: async () => undefined,
      onLateArrival() {},
    };
    const cascaded: Array<{ runId: string; cause: string }> = [];
    const runner = new RuntimeRunner({
      ...deps(clock, driver),
      onChildAbort: (runId, cause) => cascaded.push({ runId, cause }),
    });
    const controller = new AbortController();
    const req: ResolvedSpawnRequest = { runId: "parent", prompt: "hi", signal: controller.signal };
    const p = runner.run(req, budget);
    await drain(clock, 3);
    controller.abort();
    await drain(clock, 10);
    await p;
    expect(cascaded).toEqual([{ runId: "parent", cause: "parent_abort" }]);
  });
});
