import { describe, expect, it } from "vitest";
import { DEFAULT_BUDGET } from "../../src/core/deadline.js";
import { FakeClock } from "../../src/core/clock.js";
import type { RunOutcome } from "../../src/core/types.js";
import { SingleSlotPool } from "../../src/runtime/slot-pool.js";
import { BasicEffectInterpreter, RuntimeRunner, type ResolvedSpawnRequest } from "../../src/runtime/runner.js";
import type { SessionDriver, SessionHandle } from "../../src/runtime/session-driver.js";
import { EscalatingReaper } from "../../src/runtime/reaper.js";
import type { Watchdog } from "../../src/runtime/watchdog.js";

const never = <T>() => new Promise<T>(() => undefined);
const request: ResolvedSpawnRequest = { runId: "r", prompt: "hello" };
const budget = {
  ...DEFAULT_BUDGET,
  queueWaitMs: 10,
  startupMs: 10,
  bindMs: 10,
  totalMs: 30,
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
  arm() {
    /* runner owns prompt deadline */
  }
  disarm() {}
  tick() {}
}
function deps(clock: FakeClock, driver: SessionDriver) {
  const pool = new SingleSlotPool(clock, 1);
  const store = {
    put() {},
    get() {
      return undefined;
    },
    list() {
      return [];
    },
    appendOutbox() {},
  };
  const reaper = new EscalatingReaper(clock);
  const effects = new BasicEffectInterpreter();
  return { clock, driver, pool, store, watchdog: new FakeWatchdog(), reaper, effects, emit() {}, deliver() {} };
}
async function settle<T>(p: Promise<T>, clock: FakeClock, ms: number) {
  for (let i = 0; i < 20; i++) await Promise.resolve();
  clock.advance(ms);
  for (let i = 0; i < 20; i++) await Promise.resolve();
  return p;
}

describe("slot pool", () => {
  it("releases synchronously and drains on a microtask", async () => {
    const clock = new FakeClock();
    const pool = new SingleSlotPool(clock, 1);
    const first = await pool.acquire("a", { queueWaitMs: 10 });
    const second = pool.acquire("b", { queueWaitMs: 10 });
    expect(pool.stats.queued).toBe(1);
    if (!first.ok) throw new Error("first acquire failed");
    first.ticket.release();
    expect(pool.stats.inUse).toBe(0);
    await Promise.resolve();
    expect((await second).ok).toBe(true);
    expect(pool.stats.inUse).toBe(1);
  });
  it("does not queue an already-aborted waiter", async () => {
    const clock = new FakeClock();
    const pool = new SingleSlotPool(clock, 1);
    const c = new AbortController();
    c.abort();
    expect(await pool.acquire("a", { queueWaitMs: 10, signal: c.signal })).toEqual({ ok: false, reason: "aborted" });
  });
});

describe("runner hang bounds", () => {
  it("settles and releases the slot when prompt never resolves", async () => {
    const clock = new FakeClock();
    const d = deps(clock, {
      create: async () => handle({ prompt: () => never() }),
      bind: async () => undefined,
      onLateArrival() {},
    });
    const p = new RuntimeRunner(d).run(request, budget);
    const outcome = await settle(p, clock, 31);
    expect(outcome.status).toBe("timed_out");
    expect(d.pool.stats.inUse).toBe(0);
  });
  it("settles and releases the slot when create never resolves", async () => {
    const clock = new FakeClock();
    const d = deps(clock, { create: () => never(), bind: async () => undefined, onLateArrival() {} });
    const p = new RuntimeRunner(d).run(request, budget);
    const outcome = await settle(p, clock, 11);
    expect(outcome.status).toBe("timed_out");
    expect(d.pool.stats.inUse).toBe(0);
  });
  it("settles and releases the slot when bind never resolves", async () => {
    const clock = new FakeClock();
    const d = deps(clock, { create: async () => handle(), bind: () => never(), onLateArrival() {} });
    const p = new RuntimeRunner(d).run(request, budget);
    const outcome = await settle(p, clock, 11);
    expect(outcome.status).toBe("timed_out");
    expect(d.pool.stats.inUse).toBe(0);
  });
  it("resumes through the same bounded create path and passes the session file", async () => {
    const clock = new FakeClock();
    let resumed = "";
    const d = deps(clock, {
      create: async () => {
        throw new Error("fresh path must not run");
      },
      resume: async (file) => {
        resumed = file;
        return handle({ sessionFile: file, prompt: () => Promise.resolve() });
      },
      bind: async () => undefined,
      onLateArrival() {},
    });
    const result = await new RuntimeRunner(d).run({ ...request, resumeFrom: "/tmp/previous.jsonl" }, budget);
    expect(result.status).toBe("completed");
    expect(resumed).toBe("/tmp/previous.jsonl");
    expect(result.diag.sessionFile).toBe("/tmp/previous.jsonl");
  });

  it("times out a resumed prompt through the same total guard", async () => {
    const clock = new FakeClock();
    const d = deps(clock, {
      create: async () => handle(),
      resume: async () => handle({ prompt: () => never(), sessionFile: "/tmp/previous.jsonl" }),
      bind: async () => undefined,
      onLateArrival() {},
    });
    const p = new RuntimeRunner(d).run({ ...request, resumeFrom: "/tmp/previous.jsonl" }, budget);
    const result = await settle(p, clock, 31);
    expect(result.status).toBe("timed_out");
    expect(d.pool.stats.inUse).toBe(0);
  });

  it("reaper returns when abort never resolves", async () => {
    const clock = new FakeClock();
    const reaper = new EscalatingReaper(clock);
    const c = new AbortController();
    const cancel = {
      runId: "r",
      generation: 1,
      signal: c.signal,
      cancel() {
        c.abort();
      },
      whenCancelled: never<never>(),
      detach() {},
    };
    const p = reaper.reap({
      runId: "r",
      generation: 1,
      cancel,
      handle: handle({ requestAbort: () => never() }),
      phase: "model_turn",
      budget,
    });
    for (let i = 0; i < 20; i++) await Promise.resolve();
    for (let i = 0; i < 20; i++) {
      clock.advance(1);
      await Promise.resolve();
    }
    const result = await p;
    expect(result.disposed).toBe(true);
    expect(result.escalation.some((e) => e.level === "L2" && !e.ok)).toBe(true);
  });
});

describe("turn error surfacing (regression: empty success)", () => {
  it("maps a settled session with stopReason=error to failed(model), not completed", async () => {
    const clock = new FakeClock();
    const driver: SessionDriver = {
      create: async () => handle({ getTurnError: () => "Cannot read properties of undefined (reading 'includes')" }),
      bind: async () => undefined,
    };
    const runner = new RuntimeRunner(deps(clock, driver));
    const outcome = await runner.run({ ...request, runId: "r-err" }, budget);
    expect(outcome.status).toBe("failed");
    expect(outcome.error?.kind).toBe("model");
    expect(outcome.error?.message).toContain("includes");
  });
});

/**
 * CC4 F3/F4 (workflow design §4.4.1): `ResolvedSpawnRequest.deadlineAt` must
 * actually reach the state machine as `RunInput.enqueued.deadlineCapAt` —
 * this is the runner.ts half of the transport (the adapter half is
 * `service/request-threading.ts`, tested separately).
 */
describe("CC4: ResolvedSpawnRequest.deadlineAt threads through to the enqueued deadline cap", () => {
  it("a deadlineAt tighter than the relative budget wins, and survives to the terminal outcome", async () => {
    const clock = new FakeClock();
    const d = deps(clock, { create: async () => handle(), bind: async () => undefined, onLateArrival() {} });
    // budget.totalMs = 30 (see module-level `budget`) -> raw deadline = 0+30 = 30.
    // deadlineAt = 5 is tighter and must win.
    const outcome = await new RuntimeRunner(d).run({ ...request, runId: "r-cap", deadlineAt: 5 }, budget);
    expect(outcome.status).toBe("completed");
    expect(outcome.diag.deadlineAt).toBe(5);
  });

  it("an already-expired deadlineAt fails the run before pool.acquire is ever reached (CP3)", async () => {
    const clock = new FakeClock();
    let createCalled = false;
    const d = deps(clock, {
      create: async () => {
        createCalled = true;
        return handle();
      },
      bind: async () => undefined,
      onLateArrival() {},
    });
    const outcome = await new RuntimeRunner(d).run({ ...request, runId: "r-expired", deadlineAt: -1 }, budget);
    expect(outcome.status).toBe("failed");
    expect(outcome.error?.kind).toBe("config");
    expect(outcome.error?.message).toContain("already expired");
    expect(createCalled).toBe(false);
    expect(d.pool.stats.inUse).toBe(0);
  });

  it("omitting deadlineAt leaves the relative-only deadline calculation exactly as before CC4", async () => {
    const clock = new FakeClock();
    const d = deps(clock, { create: async () => handle(), bind: async () => undefined, onLateArrival() {} });
    const outcome = await new RuntimeRunner(d).run({ ...request, runId: "r-no-cap" }, budget);
    expect(outcome.status).toBe("completed");
    expect(outcome.diag.deadlineAt).toBe(30); // 0 (enqueue at) + budget.totalMs (30), unaffected by CC4
  });
});
