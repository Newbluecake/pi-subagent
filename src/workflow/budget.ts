import { DEFAULT_BUDGET } from "../core/deadline.js";
import type { Millis } from "../core/types.js";
import type { WorkflowRunBudget } from "./types.js";

/**
 * M3.2 (workflow design §4.4.3 `BudgetTree`, §4.4 CC4/BW1-BW10): derives one
 * `agent()` call's absolute `deadlineAt` from the workflow's own remaining
 * budget. This is the *only* place in the workflow module that computes a
 * child's deadline — `host.ts` calls it once per `agent()` admission and
 * threads the result straight into `SpawnRequest.deadlineAt` (CC4, already
 * landed core-side in M3.0 — see `src/core/state-machine.ts`'s `enqueued`
 * branch and `src/service/spawn-service.ts`'s `spawn()` CP1 check).
 *
 * §4.4.3 also has a `phaseDeadlineAt` input (phases are a per-`phase()`
 * concept). M3.2 has no phase-tracking state machine yet (that lands with
 * the full reduce/effect pipeline in M3.3/M3.4) — `WorkflowBudgetView` still
 * carries the field so the shape matches the design and so a future
 * milestone can wire it without changing this function's contract, but for
 * now every caller passes `phaseDeadlineAt: undefined`, which is exactly
 * BW10's `phaseTotalMs=0 ⇒ phaseRemaining=+∞` case.
 */

export interface WorkflowBudgetView {
  readonly now: Millis;
  readonly workflowDeadlineAt?: Millis;
  readonly phaseDeadlineAt?: Millis;
  readonly policy: WorkflowRunBudget["childBudgetPolicy"];
  readonly fraction?: number;
  readonly fixedTotalMs?: Millis;
}

export interface DerivedChildBudget {
  /** Milliseconds this specific child is allotted, before either cap kicks in. */
  readonly totalMs: Millis;
  /**
   * M3.3 Minor fix (workflow design §4.4.3 BW3): `min(DEFAULT_BUDGET.queueWaitMs, totalMs)` —
   * previously computed nowhere, so a workflow-derived child with a short
   * relative budget could still sit in the core's spawn queue for up to the
   * core default `queueWaitMs` (600s) before it was even considered
   * expired, silently defeating BW1's whole point. Threaded through
   * `host.ts` into `ChildSpawner.spawn`'s `budgetOverride.queueWaitMs`.
   */
  readonly queueWaitMs: Millis;
  /** BW9': CC4's absolute upper bound — always `min(workflowDeadlineAt, phaseDeadlineAt)` when either is finite. */
  readonly deadlineAt?: Millis;
  readonly capped: "want" | "policy" | "phase" | "workflow" | "expired";
}

const POSITIVE_INFINITY_MS = Number.POSITIVE_INFINITY;

/**
 * BW1-BW10. `want` is an optional caller-requested total (script's
 * `agent(prompt, { budgetMs })`-style override, not yet exposed by M3.4's
 * script API but already accepted here so that milestone doesn't need to
 * touch this function); `undefined` means "use the policy default".
 */
export function deriveChildBudget(view: WorkflowBudgetView, want: Millis | undefined): DerivedChildBudget {
  const workflowRemaining =
    view.workflowDeadlineAt === undefined ? POSITIVE_INFINITY_MS : Math.max(0, view.workflowDeadlineAt - view.now);
  const phaseRemaining =
    view.phaseDeadlineAt === undefined ? POSITIVE_INFINITY_MS : Math.max(0, view.phaseDeadlineAt - view.now);

  // BW4-BW6: policy-derived default when the caller didn't ask for a specific amount.
  let policyMs: Millis;
  if (want !== undefined) {
    policyMs = want;
  } else if (view.policy === "fixed") {
    policyMs = view.fixedTotalMs ?? workflowRemaining;
  } else if (view.policy === "fraction") {
    const fraction = view.fraction ?? 0.5;
    policyMs = workflowRemaining === POSITIVE_INFINITY_MS ? POSITIVE_INFINITY_MS : workflowRemaining * fraction;
  } else {
    // inherit_remaining (default, BW4)
    policyMs = workflowRemaining;
  }

  // BW1: min(want-or-policy, phaseRemaining, workflowRemaining).
  const candidates: Array<{ ms: Millis; capped: DerivedChildBudget["capped"] }> = [
    { ms: policyMs, capped: want !== undefined ? "want" : "policy" },
    { ms: phaseRemaining, capped: "phase" },
    { ms: workflowRemaining, capped: "workflow" },
  ];
  candidates.sort((a, b) => a.ms - b.ms);
  const winner = candidates[0]!;

  if (winner.ms <= 0) {
    return { totalMs: 0, queueWaitMs: 0, capped: "expired" };
  }

  const totalMs = winner.ms === POSITIVE_INFINITY_MS ? Number.MAX_SAFE_INTEGER : Math.floor(winner.ms);
  // BW3: queue-wait must not outlive the child's own total budget, or the
  // core's queue could hold an admission open long after this workflow could
  // possibly still use its result.
  const queueWaitMs = Math.min(DEFAULT_BUDGET.queueWaitMs, totalMs);

  // BW9': deadlineAt = min(workflowDeadlineAt, phaseDeadlineAt), independent
  // of which one actually capped `totalMs` — this is what makes "child dies
  // no later than the workflow" a *structural* guarantee (CC4) rather than a
  // property of `totalMs` alone (a caller-supplied `want` smaller than both
  // caps must still inherit the absolute ceiling).
  let deadlineAt: Millis | undefined;
  if (view.workflowDeadlineAt !== undefined && view.phaseDeadlineAt !== undefined) {
    deadlineAt = Math.min(view.workflowDeadlineAt, view.phaseDeadlineAt);
  } else if (view.workflowDeadlineAt !== undefined) {
    deadlineAt = view.workflowDeadlineAt;
  } else if (view.phaseDeadlineAt !== undefined) {
    deadlineAt = view.phaseDeadlineAt;
  } else {
    deadlineAt = undefined; // BW10: workflowTotalMs=0 (and no phase cap) ⇒ genuinely unbounded.
  }

  return { totalMs, queueWaitMs, capped: winner.capped, ...(deadlineAt !== undefined ? { deadlineAt } : {}) };
}
