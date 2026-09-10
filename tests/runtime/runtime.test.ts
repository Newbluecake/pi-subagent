import { describe, expect, it } from "vitest";
import { DEFAULT_BUDGET } from "../../src/core/deadline.js";
import { FakeClock } from "../../src/core/clock.js";
import type { RunOutcome } from "../../src/core/types.js";
import { SingleSlotPool } from "../../src/runtime/slot-pool.js";
import { BasicEffectInterpreter, RuntimeRunner, type ResolvedSpawnRequest } from "../../src/runtime/runner.js";
import type { DriverEvent, SessionDriver, SessionHandle } from "../../src/runtime/session-driver.js";
import { EscalatingReaper } from "../../src/runtime/reaper.js";
import { EventWatchdog, type Watchdog } from "../../src/runtime/watchdog.js";
import type { RunInput } from "../../src/core/types.js";

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

/* ------------------------------------------------------------------------- *
 * timeout-notify (arch §4.6 / §9.4): deadline-following prompt guard,
 * synchronous extendDeadline, and the review-critical conditional cancel in
 * fireDeadline. graceBudget: enqueued at 0 ⇒ deadlineAt=30, hardDeadlineAt=90,
 * grace window 20ms. The module-level FakeWatchdog never dispatches, so grace
 * entries are driven via runner.fireDeadline() (the watchdog's entry point).
 * ------------------------------------------------------------------------- */
describe("timeout grace & extendDeadline (runner)", () => {
  const graceBudget = { ...budget, totalGraceMs: 20, maxExtensions: 2, maxTotalFactor: 3 };

  /** Starts a run whose prompt hangs forever, parked at prompt_dispatch. */
  async function startHanging(
    runId: string,
    b: typeof budget = graceBudget,
    reqExtra: Partial<ResolvedSpawnRequest> = {},
  ) {
    const clock = new FakeClock();
    const driver: SessionDriver = {
      create: async () => handle({ prompt: () => never() }),
      bind: async () => undefined,
      onLateArrival() {},
    };
    const d = deps(clock, driver);
    const runner = new RuntimeRunner(d);
    const runPromise = runner.run({ ...request, runId, ...reqExtra }, b);
    for (let i = 0; i < 20; i++) await Promise.resolve();
    return { clock, runner, runPromise, d };
  }
  const fireTotal = (at: number): Extract<RunInput, { kind: "deadline_fired" }> => ({
    kind: "deadline_fired",
    at,
    timer: "total",
    reason: "total",
  });

  it("guardUntil re-arms after an extension instead of timing out at the old deadline", async () => {
    const { clock, runner, runPromise } = await startHanging("r-gu");
    const out = runner.extendDeadline("r-gu", 50, { source: "tool" }); // 30 → 80 (ceiling 90)
    expect(out).toMatchObject({
      ok: true,
      runId: "r-gu",
      previousDeadlineAt: 30,
      deadlineAt: 80,
      requestedMs: 50,
      grantedMs: 50,
      clamped: false,
      extensionsUsed: 1,
      extensionsRemaining: 1,
      hardDeadlineAt: 90,
      rescuedFromGrace: false,
    });
    // Advancing past the OLD deadline must not settle the run: the guard timer
    // fires at t=30, re-reads the live deadline (80) and re-arms.
    clock.advance(31);
    for (let i = 0; i < 20; i++) await Promise.resolve();
    expect(runner.getRunState("r-gu")?.outcome).toBeUndefined();
    expect(runner.getRunState("r-gu")?.status).toBe("starting");
    expect(clock.pendingTimers).toBe(1); // exactly the re-armed guard timer — no new intervals (V14)
    // At the new deadline the guard routes the expiry through the reducer,
    // which grants a grace window (until min(80+20, 90) = 90) instead of killing.
    clock.advance(49); // now = 80
    for (let i = 0; i < 20; i++) await Promise.resolve();
    const inGrace = runner.getRunState("r-gu");
    expect(inGrace?.outcome).toBeUndefined();
    expect(inGrace?.status).toBe("starting"); // still alive — grace, not death
    expect(inGrace?.deadlines.graceUntil).toBe(90);
    // The run finally dies at the hard ceiling.
    const outcome = await settle(runPromise, clock, 10); // now = 90
    expect(outcome.status).toBe("timed_out");
    expect(outcome.timeoutReason).toBe("total");
  });

  it("guardUntil with an absent deadline never arms a setTimer(0) fake timeout (D-11 defense) and reports uncapped", async () => {
    // Directly-constructed zero budget: deadlineAt/hardDeadlineAt stay undefined.
    const { clock, runner, runPromise } = await startHanging("r-uncapped", { ...budget, totalMs: 0 });
    expect(runner.extendDeadline("r-uncapped", 1_000, { source: "tool" })).toEqual({ ok: false, reason: "uncapped" });
    clock.advance(3_600_000); // a full hour passes
    for (let i = 0; i < 20; i++) await Promise.resolve();
    expect(runner.getRunState("r-uncapped")?.status).toBe("starting"); // still parked, no fake timeout
    expect(clock.pendingTimers).toBe(0); // guardUntil armed nothing at all
    await runner.abortRun("r-uncapped", "user_stop"); // cleanup: settle the run
    expect((await runPromise).status).toBe("aborted");
  });

  it("extendDeadline maps every reachable rejection reason", async () => {
    // unknown_run — no such run at all
    const idle = new RuntimeRunner(
      deps(new FakeClock(), { create: async () => handle(), bind: async () => undefined }),
    );
    expect(idle.extendDeadline("nope", 1_000, { source: "tool" })).toEqual({ ok: false, reason: "unknown_run" });

    // already_terminal — run settled, dispatcher torn down
    const done = new RuntimeRunner(
      deps(new FakeClock(), { create: async () => handle(), bind: async () => undefined, onLateArrival() {} }),
    );
    expect((await done.run({ ...request, runId: "r-done" }, budget)).status).toBe("completed");
    expect(done.extendDeadline("r-done", 1_000, { source: "tool" })).toEqual({ ok: false, reason: "already_terminal" });

    // stopping — run is inside abort_grace (grace disabled → total fire kills)
    const stopping = await startHanging("r-stopping", budget);
    stopping.runner.fireDeadline("r-stopping", 1, fireTotal(30));
    expect(stopping.runner.getRunState("r-stopping")?.status).toBe("stopping");
    expect(stopping.runner.extendDeadline("r-stopping", 1_000, { source: "tool" })).toEqual({
      ok: false,
      reason: "stopping",
    });
    await settle(stopping.runPromise, stopping.clock, 1); // cleanup (cancel already fired)

    // not_started — queued behind an occupied single slot (D-14)
    const clock = new FakeClock();
    const d = deps(clock, {
      create: async () => handle({ prompt: () => never() }),
      bind: async () => undefined,
      onLateArrival() {},
    });
    const runner = new RuntimeRunner(d);
    const a = runner.run({ ...request, runId: "r-a" }, budget); // occupies the only slot
    const b = runner.run({ ...request, runId: "r-b" }, budget); // waits in queue_wait
    for (let i = 0; i < 20; i++) await Promise.resolve();
    expect(runner.getRunState("r-b")?.phase).toBe("queue_wait");
    expect(runner.extendDeadline("r-b", 1_000, { source: "tool" })).toEqual({ ok: false, reason: "not_started" });
    const outA = await settle(a, clock, 31); // A times out and releases the slot
    expect(outA.status).toBe("timed_out");
    expect((await settle(b, clock, 5)).status).toBe("failed"); // B's own queueWaitMs expired meanwhile

    // limit_reached — both extension slots spent
    const limited = await startHanging("r-limit");
    expect(limited.runner.extendDeadline("r-limit", 50, { source: "tool" })).toMatchObject({ ok: true });
    expect(limited.runner.extendDeadline("r-limit", 10, { source: "tool" })).toMatchObject({
      ok: true,
      deadlineAt: 90,
    });
    expect(limited.runner.extendDeadline("r-limit", 10, { source: "tool" })).toEqual({
      ok: false,
      reason: "limit_reached",
    });
    await settle(limited.runPromise, limited.clock, 91);

    // no_headroom — explicit per-request deadline cap ⇒ ceiling == deadline (D-10 shape)
    const capped = await startHanging("r-cap", graceBudget, { deadlineAt: 30 });
    expect(capped.runner.extendDeadline("r-cap", 1_000, { source: "tool" })).toEqual({
      ok: false,
      reason: "no_headroom",
    });
    await settle(capped.runPromise, capped.clock, 31);
  });

  it("clamps an over-large extension at the hard ceiling", async () => {
    const { clock, runner, runPromise } = await startHanging("r-clamp");
    const out = runner.extendDeadline("r-clamp", 100, { source: "tool" }); // wants 30+100=130, ceiling 90
    expect(out).toMatchObject({ ok: true, deadlineAt: 90, requestedMs: 100, grantedMs: 60, clamped: true });
    // And once at the ceiling there is no headroom left.
    expect(runner.extendDeadline("r-clamp", 10, { source: "tool" })).toEqual({ ok: false, reason: "no_headroom" });
    await settle(runPromise, clock, 91);
  });

  it("fireDeadline entering grace does NOT cancel the run, and the guard kills it at graceUntil", async () => {
    const { clock, runner, runPromise } = await startHanging("r-grace");
    const timersBefore = clock.pendingTimers; // 1: the prompt guard
    runner.fireDeadline("r-grace", 1, fireTotal(30));
    const s = runner.getRunState("r-grace");
    expect(s?.deadlines.graceUntil).toBe(50); // min(30+20, 90)
    expect(s?.status).toBe("starting"); // unchanged — not stopping
    expect(s?.phase).toBe("prompt_dispatch"); // unchanged
    expect(s?.diag.stopCause).toBeUndefined(); // no cancel_signal ⇒ no stop_requested funnelled through
    expect(clock.pendingTimers).toBe(timersBefore); // grace armed no new runner-side timers (V14)
    // alive past the original deadline…
    clock.advance(31);
    for (let i = 0; i < 20; i++) await Promise.resolve();
    expect(runner.getRunState("r-grace")?.outcome).toBeUndefined();
    // …and killed when the grace window expires (guard follows effectiveDeadlineAt).
    const outcome = await settle(runPromise, clock, 19); // now = 50
    expect(outcome.status).toBe("timed_out");
    expect(outcome.timeoutReason).toBe("total");
  });

  it("extension inside grace reports rescuedFromGrace and measures the grant from now", async () => {
    const { clock, runner, runPromise } = await startHanging("r-rescue");
    runner.fireDeadline("r-rescue", 1, fireTotal(30)); // enters grace (until 50)
    expect(runner.getRunState("r-rescue")?.deadlines.graceUntil).toBe(50);
    const out = runner.extendDeadline("r-rescue", 40, { source: "tool", reason: "needs the full test suite" });
    expect(out).toMatchObject({
      ok: true,
      previousDeadlineAt: 30,
      deadlineAt: 70,
      grantedMs: 40,
      clamped: false,
      extensionsUsed: 1,
      rescuedFromGrace: true,
    });
    const s = runner.getRunState("r-rescue");
    expect(s?.deadlines.graceUntil).toBeUndefined(); // grace cleared
    expect(s?.armedTimers).toContain("total");
    expect(s?.armedTimers).not.toContain("total_grace");
    expect(s?.diag.overtime).toMatchObject({ graces: 1, extensions: 1, lastReason: "needs the full test suite" });
    // The re-armed guard fires at the old grace cutoff (50), re-reads the live
    // deadline (70) and re-arms — the old instant no longer kills.
    clock.advance(50); // now = 50
    for (let i = 0; i < 20; i++) await Promise.resolve();
    expect(runner.getRunState("r-rescue")?.outcome).toBeUndefined();
    expect(runner.getRunState("r-rescue")?.deadlines.graceUntil).toBeUndefined();
    // At 70 the guard routes expiry through the reducer again: one extension
    // slot remains, so a second grace window (until the ceiling 90) opens.
    clock.advance(20); // now = 70
    for (let i = 0; i < 20; i++) await Promise.resolve();
    expect(runner.getRunState("r-rescue")?.deadlines.graceUntil).toBe(90);
    const outcome = await settle(runPromise, clock, 20); // now = 90: hard ceiling, no headroom left
    expect(outcome.status).toBe("timed_out");
    expect(outcome.timeoutReason).toBe("total");
  });

  it("extension before the watchdog tick: the tick re-reads the live deadline and does not fire (arch §4.6)", async () => {
    const { clock, runner, runPromise } = await startHanging("r-ext-first");
    const dispatched: string[] = [];
    const wd = new EventWatchdog({
      clock,
      budget: graceBudget,
      getState: (id, gen) => runner.getRunState(id, gen),
      dispatch: (id, gen, input) => {
        dispatched.push(input.kind);
        runner.fireDeadline(id, gen, input as Extract<RunInput, { kind: "deadline_fired" }>);
      },
      tickMs: 10,
    });
    runner.extendDeadline("r-ext-first", 40, { source: "tool" }); // 30 → 70
    wd.arm("r-ext-first", 1);
    wd.tick(30); // the OLD deadline instant — must not fire, deadlineAt is 70 now
    expect(dispatched).toEqual([]);
    expect(runner.getRunState("r-ext-first")?.deadlines.graceUntil).toBeUndefined();
    wd.disarm("r-ext-first", 1);
    // The guard (not the disarmed watchdog) drives the rest: grace at 70, death at the 90 ceiling.
    clock.advance(70);
    for (let i = 0; i < 20; i++) await Promise.resolve();
    expect(runner.getRunState("r-ext-first")?.deadlines.graceUntil).toBe(90);
    const outcome = await settle(runPromise, clock, 20);
    expect(outcome.status).toBe("timed_out");
  });

  it("production path: the guard itself routes deadline expiry into grace — no external fireDeadline", async () => {
    // No manual fireDeadline anywhere: the FakeWatchdog is inert, so every
    // deadline_fired below is produced by the prompt guard itself.
    const { clock, runner, runPromise, d } = await startHanging("r-prod");
    clock.advance(30); // t=deadlineAt: guard fires → fireDeadline{total} → reducer grants grace
    for (let i = 0; i < 20; i++) await Promise.resolve();
    const s = runner.getRunState("r-prod");
    expect(s?.deadlines.graceUntil).toBe(50); // min(30+20, 90)
    expect(s?.status).toBe("starting"); // still running — NOT stopping
    expect(s?.phase).toBe("prompt_dispatch"); // unchanged
    expect(s?.diag.stopCause).toBeUndefined(); // fireDeadline did not cancel the prompt
    expect(s?.diag.overtime?.graces).toBe(1);
    // the notify_deadline effect really flowed through the effect interpreter
    expect(d.effects.audit.some((r) => r.kind === "notify_deadline" && r.ok)).toBe(true);
    // …and when the grace window expires the guard fires again (total_grace)
    // and the run dies with the original terminal semantics.
    const outcome = await settle(runPromise, clock, 20); // now = 50
    expect(outcome.status).toBe("timed_out");
    expect(outcome.timeoutReason).toBe("total");
  });

  it("race both ways: watchdog-first and guard-first converge to the same terminal state", async () => {
    // (a) guard first: covered by the production-path test above (watchdog inert).
    // (b) watchdog first: a real EventWatchdog enters grace at its tick; the
    // guard timer at the old deadline then just re-arms (no double dispatch).
    const { clock, runner, runPromise } = await startHanging("r-race");
    const wd = new EventWatchdog({
      clock,
      budget: graceBudget,
      getState: (id, gen) => runner.getRunState(id, gen),
      dispatch: (id, gen, input) =>
        runner.fireDeadline(id, gen, input as Extract<RunInput, { kind: "deadline_fired" }>),
      tickMs: 10,
    });
    wd.arm("r-race", 1);
    wd.tick(30); // watchdog wins the race: grace entered via the tick
    expect(runner.getRunState("r-race")?.deadlines.graceUntil).toBe(50);
    const gracesAfterTick = runner.getRunState("r-race")?.diag.overtime?.graces;
    clock.advance(30); // guard fires at the old deadline → re-reads graceUntil=50 → re-arms only
    for (let i = 0; i < 20; i++) await Promise.resolve();
    const s = runner.getRunState("r-race");
    expect(s?.diag.overtime?.graces).toBe(gracesAfterTick); // no double grace entry
    expect(s?.status).toBe("starting");
    expect(s?.diag.stopCause).toBeUndefined();
    wd.disarm("r-race", 1);
    const outcome = await settle(runPromise, clock, 20); // now = 50 → guard fires total_grace → kill
    expect(outcome.status).toBe("timed_out");
    expect(outcome.timeoutReason).toBe("total");
    // late watchdog tick after settlement is a complete no-op (fireDeadline
    // short-circuits on terminal state) — idempotency of the losing racer.
    wd.tick(60);
    expect(runner.getRunState("r-race")?.outcome?.status).toBe("timed_out");
  });
});
