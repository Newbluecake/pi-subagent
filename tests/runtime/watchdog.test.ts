import { describe, expect, it } from "vitest";
import { FakeClock } from "../../src/core/clock.js";
import { DEFAULT_BUDGET } from "../../src/core/deadline.js";
import { createInitialState, reduce } from "../../src/core/state-machine.js";
import type { DeadlineBudget, RunEffect, RunInput, RunState } from "../../src/core/types.js";
import { EventWatchdog } from "../../src/runtime/watchdog.js";

/* ------------------------------------------------------------------------- *
 * timeout-notify watchdog suite (arch §9.3): the EventWatchdog is the 1Hz
 * scanner that turns armed timers into deadline_fired inputs. These tests
 * pin the total_grace due source, the RK-1 oracle (no residual `total` in
 * grace), and "grace must not mask a genuine sub-phase hang".
 *
 * The harness folds dispatched inputs back through the real reducer, exactly
 * like RuntimeRunner.fireDeadline does.
 * ------------------------------------------------------------------------- */

/** totalMs=1000, grace 500, ceiling factor 2 ⇒ deadlineAt=1000, hardDeadlineAt=2000, grace until 1500. */
const base: DeadlineBudget = {
  ...DEFAULT_BUDGET,
  queueWaitMs: 0,
  totalMs: 1_000,
  totalGraceMs: 500,
  maxExtensions: 1,
  maxTotalFactor: 2,
};

function harness(budget: DeadlineBudget) {
  const clock = new FakeClock();
  let state = reduce(
    createInitialState("r", 1, 0),
    { generation: 1, input: { kind: "enqueued", at: 0, budget } },
    budget,
  ).state;
  const fired: Extract<RunInput, { kind: "deadline_fired" }>[] = [];
  const effects: RunEffect[] = [];
  const watchdog = new EventWatchdog({
    clock,
    budget,
    getState: () => state,
    dispatch: (_id, _gen, input) => {
      const out = reduce(state, { generation: 1, input }, budget);
      state = out.state;
      fired.push(input as Extract<RunInput, { kind: "deadline_fired" }>);
      for (const e of out.effects) effects.push(e.effect);
    },
    tickMs: 10,
  });
  watchdog.arm("r", 1); // ticks are driven manually via tick(t); the interval never advances (FakeClock)
  return {
    watchdog,
    fired,
    effects,
    getState: () => state,
    drive: (input: RunInput) => {
      state = reduce(state, { generation: 1, input }, budget).state;
    },
  };
}

/** Parks the run at model_turn (entered at `at`) via genuine reduce() transitions. */
function enterModelTurn(h: ReturnType<typeof harness>, at: number) {
  h.drive({ kind: "slot_acquired", at: 1 });
  h.drive({ kind: "phase_entered", at, phase: "model_turn" });
}

describe("EventWatchdog total_grace (arch §9.3)", () => {
  it("takes the total_grace due from deadlines.graceUntil, not deadlineAt", () => {
    const h = harness(base);
    enterModelTurn(h, 2);
    h.watchdog.tick(1_000); // soft deadline → grace (until 1500)
    expect(h.fired.map((f) => f.timer)).toEqual(["total"]);
    expect(h.getState().deadlines.graceUntil).toBe(1_500);
    h.watchdog.tick(1_200); // deadlineAt (1000) is long past — but total is disarmed…
    h.watchdog.tick(1_499); // …and graceUntil not yet reached: nothing fires
    expect(h.fired).toHaveLength(1);
    h.watchdog.tick(1_500); // grace cutoff reached
    expect(h.fired).toHaveLength(2);
    expect(h.fired[1]).toMatchObject({ timer: "total_grace", reason: "total", at: 1_500 });
  });

  it("never re-fires total during grace (RK-1 oracle: total ∉ armedTimers)", () => {
    const h = harness(base);
    enterModelTurn(h, 2);
    h.watchdog.tick(1_000); // enter grace
    const s = h.getState();
    expect(s.armedTimers).toContain("total_grace");
    expect(s.armedTimers).not.toContain("total");
    // If a residual `total` were still armed, every tick at now ≥ deadlineAt
    // would dispatch deadline_fired{total} again (double grace / notice storm).
    h.watchdog.tick(1_100);
    h.watchdog.tick(1_200);
    h.watchdog.tick(1_400);
    expect(h.fired).toHaveLength(1);
    expect(h.getState().diag.overtime?.graces).toBe(1);
    expect(h.getState().status).not.toBe("stopping");
  });

  it("still fires sub-phase timers during grace (grace must not mask a genuine hang)", () => {
    // idleMs=300; model_turn entered at 850 ⇒ idle due 1150, inside the grace
    // window (1000..1500) but after the soft deadline (1000).
    const h = harness({ ...base, idleMs: 300 });
    enterModelTurn(h, 850);
    h.watchdog.tick(1_000); // idle due 1150 > 1000 → skipped; total fires → grace
    expect(h.fired.map((f) => f.timer)).toEqual(["total"]);
    expect(h.getState().deadlines.graceUntil).toBe(1_500);
    h.watchdog.tick(1_149);
    expect(h.fired).toHaveLength(1);
    h.watchdog.tick(1_150); // idle deadline reached inside the grace window
    expect(h.fired[1]).toMatchObject({ timer: "idle", reason: "idle" });
    const s = h.getState();
    expect(s.status).toBe("stopping");
    expect(s.phase).toBe("abort_grace");
    expect(s.diag.timeoutReason).toBe("idle"); // NOT "total" — the real hang is reported
  });

  it("full lifecycle: grace at totalMs with notice, killed at graceUntil with timeoutReason total", () => {
    const h = harness(base); // totalMs=1000, totalGraceMs=500, maxExtensions=1, maxTotalFactor=2
    enterModelTurn(h, 2);
    h.watchdog.tick(999);
    expect(h.fired).toHaveLength(0);
    h.watchdog.tick(1_000); // t=totalMs → grace + notify, run keeps going
    expect(h.fired.map((f) => f.timer)).toEqual(["total"]);
    expect(h.effects.some((e) => e.kind === "notify_deadline" && e.notice.kind === "grace")).toBe(true);
    expect(h.getState().status).toBe("starting"); // parked via phase_entered — unchanged by grace
    expect(h.getState().phase).toBe("model_turn");
    expect(h.getState().diag.overtime).toMatchObject({ graces: 1, grace: { startedAt: 1_000, until: 1_500 } });
    h.watchdog.tick(1_500); // t=graceUntil → killed via the original total semantics…
    expect(h.fired[1]).toMatchObject({ timer: "total_grace", reason: "total" });
    expect(h.getState().phase).toBe("abort_grace");
    expect(h.getState().diag.timeoutReason).toBe("total");
    h.watchdog.tick(1_501); // …and the re-armed past-due total_grace settles it (S22: ≈1 tick)
    expect(h.getState().status).toBe("timed_out");
    expect(h.getState().outcome?.timeoutReason).toBe("total");
  });
});
