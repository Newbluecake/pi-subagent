import { describe, expect, it } from "vitest";
import {
  applyBudgetPolicy,
  DEFAULT_BUDGET,
  effectiveDeadlineAt,
  extendability,
  graceWindow,
  hardDeadlineAtFor,
  OVERTIME_PHASES,
} from "../../src/core/deadline.js";
import { isTerminalStatus, TERMINAL_STATUSES } from "../../src/core/status.js";
import type { DeadlineBudget, RunState } from "../../src/core/types.js";

const budget: DeadlineBudget = { ...DEFAULT_BUDGET };

/** 最小 RunState fixture：extendability/graceWindow 只读 status/phase/deadlines/diag.overtime。 */
function state(overrides: {
  status?: RunState["status"];
  phase?: RunState["phase"];
  deadlines?: Partial<RunState["deadlines"]>;
  extensions?: number;
}): RunState {
  return {
    runId: "r1",
    generation: 1,
    status: overrides.status ?? "running",
    phase: overrides.phase ?? "model_turn",
    deadlines: {
      enqueuedAt: 0,
      deadlineAt: 100_000,
      queueDeadlineAt: undefined,
      hardDeadlineAt: 200_000,
      ...overrides.deadlines,
    },
    diag: {
      createdAt: 0,
      phase: overrides.phase ?? "model_turn",
      phaseEnteredAt: 0,
      pendingTools: 0,
      turns: 0,
      escalation: [],
      orphaned: false,
      generation: 1,
      degraded: [],
      staleInputs: 0,
      unkillable: [],
      ...(overrides.extensions === undefined
        ? {}
        : { overtime: { graces: 0, extensions: overrides.extensions, grantedMs: 0 } }),
    },
    armedTimers: [],
    slotHeld: true,
    effectSeq: 0,
    persistRetryCount: 0,
  };
}

describe("core/status: terminal status single source (D-15)", () => {
  it("classifies exactly the four terminal statuses", () => {
    for (const s of ["completed", "failed", "timed_out", "aborted"] as const) expect(isTerminalStatus(s)).toBe(true);
    for (const s of ["queued", "starting", "running", "stopping"] as const)
      expect(TERMINAL_STATUSES.has(s as never)).toBe(false);
  });
});

describe("core/deadline: hardDeadlineAtFor", () => {
  it("is enqueuedAt + ceil(totalMs * factor) without a cap", () => {
    expect(hardDeadlineAtFor(1_000, { ...budget, totalMs: 100, maxTotalFactor: 2 }, undefined)).toBe(1_200);
  });
  it("treats factor < 1 as 1", () => {
    expect(hardDeadlineAtFor(0, { ...budget, totalMs: 100, maxTotalFactor: 0.5 }, undefined)).toBe(100);
  });
  it("a tighter SpawnRequest.deadlineAt cap wins", () => {
    expect(hardDeadlineAtFor(0, { ...budget, totalMs: 100, maxTotalFactor: 3 }, 150)).toBe(150);
  });
  it("a looser cap does not loosen the factor ceiling", () => {
    expect(hardDeadlineAtFor(0, { ...budget, totalMs: 100, maxTotalFactor: 2 }, 999_999)).toBe(200);
  });
  it("totalMs <= 0 is a defensive undefined (config layer forbids it, D-11)", () => {
    expect(hardDeadlineAtFor(0, { ...budget, totalMs: 0 }, undefined)).toBeUndefined();
    expect(hardDeadlineAtFor(0, { ...budget, totalMs: -5 }, undefined)).toBeUndefined();
  });
});

describe("core/deadline: applyBudgetPolicy (D-10/D-16)", () => {
  it("explicitTotal clamps maxTotalFactor to 1", () => {
    const out = applyBudgetPolicy(budget, { explicitTotal: true, extensionsEnabled: true });
    expect(out.maxTotalFactor).toBe(1);
    expect(out.maxExtensions).toBe(budget.maxExtensions);
  });
  it("extensionsEnabled=false clamps maxExtensions to 0", () => {
    const out = applyBudgetPolicy(budget, { explicitTotal: false, extensionsEnabled: false });
    expect(out.maxExtensions).toBe(0);
    expect(out.maxTotalFactor).toBe(budget.maxTotalFactor);
  });
  it("both flags combine", () => {
    const out = applyBudgetPolicy(budget, { explicitTotal: true, extensionsEnabled: false });
    expect(out).toMatchObject({ maxTotalFactor: 1, maxExtensions: 0 });
  });
  it("neither flag returns the budget untouched", () => {
    expect(applyBudgetPolicy(budget, { explicitTotal: false, extensionsEnabled: true })).toBe(budget);
  });
});

describe("core/deadline: effectiveDeadlineAt", () => {
  it("prefers graceUntil over deadlineAt", () => {
    expect(effectiveDeadlineAt({ enqueuedAt: 0, deadlineAt: 100, queueDeadlineAt: undefined, graceUntil: 150 })).toBe(
      150,
    );
    expect(effectiveDeadlineAt({ enqueuedAt: 0, deadlineAt: 100, queueDeadlineAt: undefined })).toBe(100);
    expect(effectiveDeadlineAt({ enqueuedAt: 0, deadlineAt: undefined, queueDeadlineAt: undefined })).toBeUndefined();
  });
});

describe("core/deadline: extendability", () => {
  it("ok with headroom for an overtime phase under the ceiling", () => {
    const verdict = extendability(state({}), budget, 50_000);
    expect(verdict).toEqual({ ok: true, headroomMs: 100_000 });
  });
  it("already_terminal for each terminal status", () => {
    for (const status of ["completed", "failed", "timed_out", "aborted"] as const) {
      expect(extendability(state({ status }), budget, 0)).toEqual({ ok: false, reason: "already_terminal" });
    }
  });
  it("stopping in abort_grace / reap", () => {
    expect(extendability(state({ phase: "abort_grace" }), budget, 0)).toEqual({ ok: false, reason: "stopping" });
    expect(extendability(state({ phase: "reap" }), budget, 0)).toEqual({ ok: false, reason: "stopping" });
  });
  it("not_started for the four startup phases (D-14)", () => {
    for (const phase of ["queue_wait", "resolve_config", "session_create", "extension_bind"] as const) {
      expect(extendability(state({ phase }), budget, 0)).toEqual({ ok: false, reason: "not_started" });
    }
    for (const phase of OVERTIME_PHASES) {
      expect(extendability(state({ phase }), budget, 0).ok).toBe(true);
    }
  });
  it("uncapped when deadlineAt/hardDeadlineAt is missing (defensive)", () => {
    expect(extendability(state({ deadlines: { deadlineAt: undefined } }), budget, 0)).toEqual({
      ok: false,
      reason: "uncapped",
    });
    expect(extendability(state({ deadlines: { hardDeadlineAt: undefined } }), budget, 0)).toEqual({
      ok: false,
      reason: "uncapped",
    });
  });
  it("limit_reached once extensions are exhausted", () => {
    expect(extendability(state({ extensions: budget.maxExtensions }), budget, 0)).toEqual({
      ok: false,
      reason: "limit_reached",
    });
  });
  it("no_headroom at/past the ceiling — including explicit-budget runs (H = deadlineAt, D-10)", () => {
    expect(extendability(state({}), budget, 200_000)).toEqual({ ok: false, reason: "no_headroom" });
    expect(extendability(state({ deadlines: { deadlineAt: 100_000, hardDeadlineAt: 100_000 } }), budget, 0)).toEqual({
      ok: false,
      reason: "no_headroom",
    });
  });
});

describe("core/deadline: graceWindow", () => {
  it("is at + totalGraceMs clamped to the hard ceiling (D-7)", () => {
    const b = { ...budget, totalGraceMs: 90_000 };
    expect(graceWindow(state({}), b, 100_000)).toBe(190_000);
    expect(graceWindow(state({}), b, 150_000)).toBe(200_000);
  });
  it("undefined when totalGraceMs = 0 (grace off)", () => {
    expect(graceWindow(state({}), { ...budget, totalGraceMs: 0 }, 100_000)).toBeUndefined();
  });
  it("undefined when extensions are already exhausted (D-6)", () => {
    expect(graceWindow(state({ extensions: 3 }), budget, 100_000)).toBeUndefined();
  });
  it("undefined when maxExtensions = 0", () => {
    expect(graceWindow(state({}), { ...budget, maxExtensions: 0 }, 100_000)).toBeUndefined();
  });
  it("undefined at the hard ceiling (until must be > at)", () => {
    expect(graceWindow(state({}), budget, 200_000)).toBeUndefined();
  });
  it("undefined for explicit-budget runs (maxTotalFactor = 1 ⇒ H = deadlineAt, D-10)", () => {
    // 显式预算 run：deadlineAt 与 hardDeadlineAt 同为 enqueuedAt + totalMs ⇒ 无宽限窗口
    const s = state({ deadlines: { deadlineAt: 100_000, hardDeadlineAt: 100_000 } });
    expect(graceWindow(s, budget, 100_000)).toBeUndefined();
  });
  it("undefined outside overtime phases (D-14)", () => {
    expect(graceWindow(state({ phase: "queue_wait" }), budget, 100_000)).toBeUndefined();
  });
});
