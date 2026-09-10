import { describe, expect, it } from "vitest";
import { DEFAULT_BUDGET } from "../../src/core/deadline.js";
import { FakeClock } from "../../src/core/clock.js";
import type { RunOutcome } from "../../src/core/types.js";
import { SingleSlotPool } from "../../src/runtime/slot-pool.js";
import { BasicEffectInterpreter, RuntimeRunner, type ResolvedSpawnRequest } from "../../src/runtime/runner.js";
import type { DriverEvent, SessionDriver, SessionHandle } from "../../src/runtime/session-driver.js";
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
  totalGraceMs: 0, // S21 基线预置：关闭宽限，保持既有超时语义
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

describe("set_model: RuntimeRunner.setModelForRun", () => {
  const target = { provider: "anthropic", id: "claude-haiku-4" };
  /** Start a run whose prompt hangs, leaving the handle active; caller settles via clock. */
  async function start(overrides: Partial<SessionHandle>, driverExtra: Partial<SessionDriver> = {}) {
    const clock = new FakeClock();
    const h = handle({ prompt: () => never(), ...overrides });
    const driver: SessionDriver = {
      create: async () => h,
      bind: async () => undefined,
      onLateArrival() {},
      ...driverExtra,
    };
    const d = deps(clock, driver);
    const runner = new RuntimeRunner(d);
    const runPromise = runner.run({ ...request, runId: "r-sm" }, budget);
    // Flush microtasks until create/bind have run and activeHandles is populated.
    for (let i = 0; i < 20; i++) await Promise.resolve();
    return { clock, runner, runPromise, d };
  }

  it("switches the active run's model, reports the read-back ref, and patches diag.model", async () => {
    let switchedTo: unknown;
    const { clock, runner, runPromise } = await start(
      {
        setModel: async (m) => {
          switchedTo = m;
        },
        getModelRef: () => ({ provider: "anthropic", id: "actual-readback" }),
        getThinkingLevel: () => "low",
      },
      { resolveModelRef: (p, id) => ({ resolved: `${p}/${id}` }) },
    );
    const outcome = await runner.setModelForRun("r-sm", target);
    expect(switchedTo).toEqual({ resolved: "anthropic/claude-haiku-4" });
    expect(outcome).toEqual({ ok: true, model: { provider: "anthropic", id: "actual-readback" }, thinking: "low" });
    expect(runner.getRunState("r-sm")?.diag.model).toEqual({ provider: "anthropic", id: "actual-readback" });
    await settle(runPromise, clock, 31);
  });

  it("returns not_running when no active handle exists (never spawned / already settled)", async () => {
    const clock = new FakeClock();
    const runner = new RuntimeRunner(deps(clock, { create: async () => handle(), bind: async () => undefined }));
    expect(await runner.setModelForRun("nope", target)).toEqual({ ok: false, reason: "not_running" });
    // And after a run settles, activeHandles is cleaned by generation.
    const outcome = await runner.run({ ...request, runId: "r-settled" }, budget);
    expect(outcome.status).toBe("completed");
    expect(await runner.setModelForRun("r-settled", target)).toEqual({ ok: false, reason: "not_running" });
  });

  it("returns unsupported when the driver/handle lack the capability", async () => {
    const { clock, runner, runPromise } = await start({}); // no setModel on handle, no resolveModelRef on driver
    expect(await runner.setModelForRun("r-sm", target)).toEqual({ ok: false, reason: "unsupported" });
    await settle(runPromise, clock, 31);
  });

  it("returns unknown_model without calling handle.setModel when the registry misses", async () => {
    let called = false;
    const { clock, runner, runPromise } = await start(
      {
        setModel: async () => {
          called = true;
        },
      },
      { resolveModelRef: () => undefined },
    );
    expect(await runner.setModelForRun("r-sm", target)).toEqual({
      ok: false,
      reason: "unknown_model",
      detail: "anthropic/claude-haiku-4",
    });
    expect(called).toBe(false);
    await settle(runPromise, clock, 31);
  });

  it("maps a rejecting session.setModel to rejected + detail", async () => {
    const { clock, runner, runPromise } = await start(
      {
        setModel: async () => {
          throw new Error("No API key for anthropic/claude-haiku-4");
        },
      },
      { resolveModelRef: (p, id) => ({ p, id }) },
    );
    const outcome = await runner.setModelForRun("r-sm", target);
    expect(outcome.ok).toBe(false);
    if (!outcome.ok && outcome.reason === "rejected") expect(outcome.detail).toContain("No API key");
    else throw new Error("expected rejected");
    await settle(runPromise, clock, 31);
  });

  it("times out a hung session.setModel within SET_MODEL_TIMEOUT_MS (zero-hang)", async () => {
    const { clock, runner, runPromise } = await start(
      { setModel: () => never() },
      { resolveModelRef: (p, id) => ({ p, id }) },
    );
    const p = runner.setModelForRun("r-sm", target);
    for (let i = 0; i < 10; i++) await Promise.resolve();
    clock.advance(5_000);
    expect(await p).toEqual({ ok: false, reason: "timeout" });
    await settle(runPromise, clock, 31);
  });

  it("writes back the pre-switch thinking level when none is requested (pi recomputes to its default)", async () => {
    let level: string | undefined = "high";
    const written: string[] = [];
    const { clock, runner, runPromise } = await start(
      {
        // Simulate pi: the switch itself re-applies the global default (medium).
        setModel: async () => {
          level = "medium";
        },
        getThinkingLevel: () => level,
        setThinkingLevel: (l) => {
          written.push(l);
          level = l;
        },
        getModelRef: () => target,
      },
      { resolveModelRef: (p, id) => ({ p, id }) },
    );
    const outcome = await runner.setModelForRun("r-sm", target);
    expect(written).toEqual(["high"]); // previous level written back over pi's recompute
    expect(outcome).toEqual({ ok: true, model: target, thinking: "high" });
    await settle(runPromise, clock, 31);
  });

  it("an explicit thinking param wins over the previous level", async () => {
    let level: string | undefined = "high";
    const written: string[] = [];
    const { clock, runner, runPromise } = await start(
      {
        setModel: async () => {
          level = "medium";
        },
        getThinkingLevel: () => level,
        setThinkingLevel: (l) => {
          written.push(l);
          level = l;
        },
        getModelRef: () => target,
      },
      { resolveModelRef: (p, id) => ({ p, id }) },
    );
    const outcome = await runner.setModelForRun("r-sm", target, { thinking: "low" });
    expect(written).toEqual(["low"]);
    expect(outcome).toEqual({ ok: true, model: target, thinking: "low" });
    await settle(runPromise, clock, 31);
  });
});

describe("final assistant text", () => {
  it("prefers the final assistant message over streamed narrative deltas", async () => {
    const clock = new FakeClock();
    let emit: ((event: DriverEvent) => void) | undefined;
    const driver: SessionDriver = {
      create: async () =>
        handle({
          getLastAssistantText: () => "final",
          prompt: async () => {
            emit?.({ t: "text_delta", delta: "narrative " });
            emit?.({ t: "turn_end", toolResults: 0 });
            emit?.({ t: "text_delta", delta: "again" });
          },
        }),
      bind: async (_handle, onEvent) => {
        emit = onEvent;
      },
    };
    const outcome = await new RuntimeRunner(deps(clock, driver)).run({ ...request, runId: "r-final" }, budget);
    expect(outcome.text).toBe("final");
  });

  it("keeps streamed partial output when the final turn reports an error", async () => {
    const clock = new FakeClock();
    let emit: ((event: { t: "text_delta"; delta: string }) => void) | undefined;
    const driver: SessionDriver = {
      create: async () =>
        handle({
          getLastAssistantText: () => "truncated",
          getTurnError: () => "provider failed",
          prompt: async () => emit?.({ t: "text_delta", delta: "partial" }),
        }),
      bind: async (_handle, onEvent) => {
        emit = onEvent as typeof emit;
      },
    };
    const outcome = await new RuntimeRunner(deps(clock, driver)).run({ ...request, runId: "r-error-text" }, budget);
    expect(outcome.status).toBe("failed");
    expect(outcome.text).toBe("partial");
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
