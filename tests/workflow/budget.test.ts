import { describe, expect, it } from "vitest";
import { deriveChildBudget } from "../../src/workflow/budget.js";

/**
 * BW1-BW10 (workflow design §4.4.3). These are pure-function unit tests —
 * `deriveChildBudget` is deterministic given `{ now, ... }`, so no clock/timer
 * machinery is needed.
 */
describe("deriveChildBudget (§4.4.3 BW1-BW10)", () => {
  it("BW9'/CC4: deadlineAt = workflowDeadlineAt when no phase cap exists — the numeric example from the milestone brief", () => {
    // Workflow enqueued at t=0 with a 3_600_000ms (1h) total budget; we derive
    // a child at t=3_590_400 (10s remaining, matching the design's own §4.4
    // worked example of the *problem* this fixes).
    const now = 3_590_400;
    const workflowDeadlineAt = 3_600_000;
    const result = deriveChildBudget({ now, workflowDeadlineAt, policy: "inherit_remaining" }, undefined);
    // `policy:"inherit_remaining"` derives exactly `workflowRemaining`, so this
    // is a tie between the "policy" and "workflow" candidates in BW1's
    // min() — either label is accurate (both equal 9_600ms); what matters for
    // this test is the numeric deadline, not which label wins the tie.
    expect(result.capped).toBe("policy");
    expect(result.totalMs).toBe(9_600); // 3_600_000 - 3_590_400
    // BW9': the structural guarantee under test — child's absolute deadline
    // is exactly the workflow's, never later (this is what CC4 makes
    // *structural*: SpawnRequest.deadlineAt is threaded straight through to
    // core's `min(enqueuedAt + totalMs, cap)`, so even if the child's own
    // `spawn()` admission is delayed, its frozen deadlineAt cannot exceed
    // this value — see src/core/state-machine.ts's `enqueued` branch).
    expect(result.deadlineAt).toBe(3_600_000);
    expect(result.deadlineAt).toBeLessThanOrEqual(workflowDeadlineAt);
  });

  it("BW2: a workflow already past its deadline reports capped:'expired' and totalMs:0 — the caller must not spawn", () => {
    const result = deriveChildBudget(
      { now: 3_600_500, workflowDeadlineAt: 3_600_000, policy: "inherit_remaining" },
      undefined,
    );
    expect(result.capped).toBe("expired");
    expect(result.totalMs).toBe(0);
    expect(result.deadlineAt).toBeUndefined();
  });

  it("BW1: min(want, phaseRemaining, workflowRemaining) — an explicit `want` smaller than either cap wins on totalMs", () => {
    const result = deriveChildBudget(
      { now: 0, workflowDeadlineAt: 100_000, phaseDeadlineAt: 50_000, policy: "inherit_remaining" },
      10_000,
    );
    expect(result.totalMs).toBe(10_000);
    expect(result.capped).toBe("want");
    // BW9': even though `want` capped totalMs, the absolute deadlineAt still
    // reflects the tighter of the two structural caps (phase, here) — a
    // script asking for "only 10s" must not be handed a deadline later than
    // its actual phase/workflow ceiling.
    expect(result.deadlineAt).toBe(50_000);
  });

  it("BW1: the phase cap can be tighter than the workflow cap and wins", () => {
    const result = deriveChildBudget(
      { now: 0, workflowDeadlineAt: 100_000, phaseDeadlineAt: 20_000, policy: "inherit_remaining" },
      undefined,
    );
    expect(result.totalMs).toBe(20_000);
    expect(result.capped).toBe("phase");
    expect(result.deadlineAt).toBe(20_000);
  });

  it("BW5: policy=fraction derives a fraction of the remaining workflow budget", () => {
    const result = deriveChildBudget(
      { now: 0, workflowDeadlineAt: 100_000, policy: "fraction", fraction: 0.25 },
      undefined,
    );
    expect(result.totalMs).toBe(25_000);
    expect(result.capped).toBe("policy");
  });

  it("BW6: policy=fixed uses min(fixedTotalMs, remaining)", () => {
    const smallerFixed = deriveChildBudget(
      { now: 0, workflowDeadlineAt: 100_000, policy: "fixed", fixedTotalMs: 5_000 },
      undefined,
    );
    expect(smallerFixed.totalMs).toBe(5_000);

    const largerFixed = deriveChildBudget(
      { now: 0, workflowDeadlineAt: 10_000, policy: "fixed", fixedTotalMs: 999_999 },
      undefined,
    );
    expect(largerFixed.totalMs).toBe(10_000); // capped by the workflow, not the fixed request
    expect(largerFixed.capped).toBe("workflow");
  });

  it("BW10: workflowTotalMs=0 (no workflowDeadlineAt) and no phase cap ⇒ genuinely unbounded (deadlineAt undefined)", () => {
    const result = deriveChildBudget({ now: 0, policy: "inherit_remaining" }, undefined);
    expect(result.deadlineAt).toBeUndefined();
    expect(result.totalMs).toBeGreaterThan(0);
  });

  it("BW10: phaseTotalMs=0 (no phaseDeadlineAt) but a finite workflow cap still applies", () => {
    const result = deriveChildBudget({ now: 0, workflowDeadlineAt: 7_000, policy: "inherit_remaining" }, undefined);
    expect(result.totalMs).toBe(7_000);
    expect(result.deadlineAt).toBe(7_000);
  });
});
