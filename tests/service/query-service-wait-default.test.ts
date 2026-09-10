import { describe, expect, it } from "vitest";
import { FakeClock } from "../../src/core/clock.js";
import { createQueryService, WAIT_SETTLEMENT_GRACE_MS } from "../../src/service/query-service.js";
import type { RunRegistry, Runner } from "../../src/service/ports.js";
import type { RunOutcome, RunSnapshot } from "../../src/core/types.js";

function snapshot(overrides: {
  deadlineAt?: number;
  hardDeadlineAt?: number;
  overtime?: RunSnapshot["diag"]["overtime"];
  outcome?: RunOutcome;
  status?: RunSnapshot["status"];
}): RunSnapshot {
  return {
    runId: "r1",
    generation: 1,
    status: overrides.status ?? "running",
    phase: "streaming",
    deadlines: {
      enqueuedAt: 0,
      deadlineAt: overrides.deadlineAt,
      queueDeadlineAt: undefined,
      ...(overrides.hardDeadlineAt === undefined ? {} : { hardDeadlineAt: overrides.hardDeadlineAt }),
    },
    diag: {
      createdAt: 0,
      phase: "streaming",
      phaseEnteredAt: 0,
      pendingTools: 0,
      turns: 0,
      escalation: [],
      orphaned: false,
      generation: 1,
      degraded: [],
      staleInputs: 0,
      unkillable: [],
      ...(overrides.overtime === undefined ? {} : { overtime: overrides.overtime }),
    },
    ...(overrides.outcome ? { outcome: overrides.outcome } : {}),
    updatedAt: 0,
  };
}

function outcome(): RunOutcome {
  return {
    runId: "r1",
    status: "completed",
    text: "done",
    turns: 1,
    durationMs: 5,
    diag: snapshot({}).diag,
  };
}

const runner: Runner = {} as Runner;

/**
 * Default wait budget derivation (no explicit waitMs): dynamic per-run
 * "remaining deadline + settlement grace" first, then the host's static
 * defaultWaitMs, then the hardcoded 30min floor.
 */
describe("query-service: default wait budget", () => {
  it("derives the default from the run's deadlineAt so it outlives a static default", async () => {
    const clock = new FakeClock(1_000);
    let current = snapshot({ deadlineAt: 6_000 }); // 5s of run budget left
    const registry: RunRegistry = { get: () => current, list: () => [current] };
    // A tiny static default (50ms) that would time out long before the run's
    // own deadline — the dynamic default must take precedence over it.
    const q = createQueryService({ registry, runner, clock, defaultWaitMs: 50 });
    const pending = q.wait("r1");
    // Outcome lands at t=+2000 (after the static default, well before deadline+grace).
    clock.setTimer(2_000, () => {
      current = snapshot({ deadlineAt: 6_000, outcome: outcome(), status: "completed" });
    });
    clock.advance(2_100);
    await expect(pending).resolves.toEqual({ ok: true, outcome: outcome() });
  });

  it("falls back to the static defaultWaitMs when the snapshot has no deadlineAt", async () => {
    const clock = new FakeClock(0);
    const current = snapshot({}); // never settles, no deadline
    const registry: RunRegistry = { get: () => current, list: () => [current] };
    const q = createQueryService({ registry, runner, clock, defaultWaitMs: 500 });
    const pending = q.wait("r1");
    clock.advance(600);
    await expect(pending).resolves.toEqual({ ok: false, reason: "wait_timeout" });
  });

  it("dynamic default times out shortly after the run's deadline + grace, not the 30min floor", async () => {
    const clock = new FakeClock(0);
    const current = snapshot({ deadlineAt: 5_000 }); // never settles (pathological)
    const registry: RunRegistry = { get: () => current, list: () => [current] };
    const q = createQueryService({ registry, runner, clock });
    const pending = q.wait("r1");
    clock.advance(5_000 + WAIT_SETTLEMENT_GRACE_MS + 100);
    await expect(pending).resolves.toEqual({ ok: false, reason: "wait_timeout" });
  });

  // RK-5 (timeout-notify): the dynamic basis escalates to the hard ceiling
  // ONLY once the run actually entered grace / was extended (diag.overtime
  // exists); otherwise every bare wait window would silently double to
  // maxTotalFactor × totalMs.
  it("keeps the deadlineAt basis when a hardDeadlineAt exists but the run never entered overtime", async () => {
    const clock = new FakeClock(0);
    const current = snapshot({ deadlineAt: 5_000, hardDeadlineAt: 60_000 }); // no overtime
    const registry: RunRegistry = { get: () => current, list: () => [current] };
    const q = createQueryService({ registry, runner, clock });
    const pending = q.wait("r1");
    // Times out shortly after deadlineAt + grace — hardDeadlineAt (60s) must NOT be the basis.
    clock.advance(5_000 + WAIT_SETTLEMENT_GRACE_MS + 100);
    await expect(pending).resolves.toEqual({ ok: false, reason: "wait_timeout" });
  });

  it("uses the hardDeadlineAt basis once the run has overtime, so an extended run is not wait_timeout'd early", async () => {
    const clock = new FakeClock(0);
    let current = snapshot({
      deadlineAt: 5_000,
      hardDeadlineAt: 200_000,
      overtime: { graces: 0, extensions: 1, grantedMs: 15_000 },
    });
    const registry: RunRegistry = { get: () => current, list: () => [current] };
    const q = createQueryService({ registry, runner, clock });
    const pending = q.wait("r1");
    let settled = false;
    void pending.then(() => {
      settled = true;
    });
    // Past the ORIGINAL deadline + settlement grace: a deadlineAt-based wait
    // would already have timed out; the overtime-aware basis must still wait.
    clock.advance(5_000 + WAIT_SETTLEMENT_GRACE_MS + 100);
    await Promise.resolve();
    expect(settled).toBe(false);
    // The run completes at t≈41s (well before the 200s hard ceiling): the wait resolves with it.
    clock.setTimer(5_000, () => {
      current = snapshot({ deadlineAt: 200_000, outcome: outcome(), status: "completed" });
    });
    clock.advance(6_000);
    await expect(pending).resolves.toEqual({ ok: true, outcome: outcome() });
  });

  it("an explicit waitMs always wins over the dynamic default", async () => {
    const clock = new FakeClock(0);
    const current = snapshot({ deadlineAt: 3_600_000 }); // huge remaining budget
    const registry: RunRegistry = { get: () => current, list: () => [current] };
    const q = createQueryService({ registry, runner, clock });
    const pending = q.wait("r1", { waitMs: 100 });
    clock.advance(200);
    await expect(pending).resolves.toEqual({ ok: false, reason: "wait_timeout" });
  });
});
