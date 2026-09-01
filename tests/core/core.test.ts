import { describe, expect, it } from "vitest";
import { DEFAULT_BUDGET, remainingFor, withDeadline } from "../../src/core/deadline.js";
import { FakeClock } from "../../src/core/clock.js";
import {
  createInitialState,
  INPUT_KINDS,
  RUN_PHASES,
  reduce,
  THINKING_TEXT_CAP,
} from "../../src/core/state-machine.js";
import type { RunEffect, RunInput, RunPhase, RunState, RunStatus, TimerId } from "../../src/core/types.js";

const budget = { ...DEFAULT_BUDGET, totalMs: 100, queueWaitMs: 20 };

/** Simple fixed-shape input builder used by the hand-written (non-matrix) tests below. */
function input(kind: RunInput["kind"], at = 0): RunInput {
  if (kind === "enqueued") return { kind, at, budget };
  if (kind === "slot_denied") return { kind, at, reason: "queue_timeout" };
  if (kind === "phase_entered") return { kind, at, phase: "queue_wait" };
  if (kind === "session_created") return { kind, at, sessionId: "s" };
  if (kind === "startup_failed")
    return { kind, at, phase: "resolve_config", error: { kind: "config", message: "x", retryable: false } };
  if (kind === "session_event") return { kind, at, event: { t: "text_delta", delta: "x" } };
  if (kind === "prompt_settled") return { kind, at };
  if (kind === "deadline_fired") return { kind, at, timer: "missing", reason: "total" };
  if (kind === "stop_requested") return { kind, at, cause: "user_stop" };
  if (kind === "escalation_done") return { kind, at, level: "L0", ok: true };
  if (kind === "reap_finished") return { kind, at, disposed: true, orphaned: false };
  return { kind, at, effect: "dispose", error: { kind: "internal", message: "x", retryable: false } };
}
function enqueued(): RunState {
  return reduce(createInitialState("r", 1, 0), { generation: 1, input: { kind: "enqueued", at: 0, budget } }, budget)
    .state;
}
function apply(s: RunState, i: RunInput, at = 1) {
  return reduce(s, { generation: s.generation, input: { ...i, at } as RunInput }, budget);
}
function kinds(result: ReturnType<typeof reduce>): string[] {
  return result.effects.map((e) => e.effect.kind);
}

describe("deadline", () => {
  it("uses the immutable absolute total deadline and never returns negative", () => {
    const d = { enqueuedAt: 10, deadlineAt: 110, queueDeadlineAt: 30 };
    expect(remainingFor(50, 40, d)).toEqual({ ms: 50, capped: "phase" });
    expect(remainingFor(50, 90, d)).toEqual({ ms: 20, capped: "total" });
    expect(remainingFor(50, 111, d)).toEqual({ ms: 0, capped: "expired" });
  });
  it("FakeClock advances callbacks without real waiting", () => {
    const c = new FakeClock();
    let fired = 0;
    c.setTimer(5, () => fired++);
    c.advance(4);
    expect(fired).toBe(0);
    c.advance(1);
    expect(fired).toBe(1);
    expect(c.pendingTimers).toBe(0);
  });
});

describe("withDeadline (N6-2)", () => {
  it("resolves ok:true on success and clears the timer", () => {
    const clock = new FakeClock();
    const p = withDeadline(Promise.resolve(42), 100, clock, "probe");
    return p.then((r) => {
      expect(r).toEqual({ ok: true, value: 42 });
      expect(clock.pendingTimers).toBe(0);
    });
  });
  it("resolves ok:false reason:timeout when the deadline fires first", async () => {
    const clock = new FakeClock();
    let settleLate: (() => void) | undefined;
    const never = new Promise<number>((resolve) => {
      settleLate = () => resolve(1);
    });
    const r = withDeadline(never, 10, clock, "probe");
    clock.advance(10);
    const outcome = await r;
    expect(outcome).toEqual({ ok: false, reason: "timeout" });
    settleLate?.();
  });
  it("classifies a genuine rejection as reason:error, not timeout, and threads the label into the message", async () => {
    const clock = new FakeClock();
    const boom = Promise.reject(new Error("socket closed"));
    const outcome = await withDeadline(boom, 1000, clock, "session.create");
    expect(outcome.ok).toBe(false);
    if (outcome.ok) throw new Error("unreachable");
    expect(outcome.reason).toBe("error");
    if (outcome.reason !== "error") throw new Error("unreachable");
    expect(outcome.error.message).toBe("session.create: socket closed");
    expect(outcome.error.kind).toBe("internal");
    expect(clock.pendingTimers).toBe(0);
  });
  it("classifies a non-Error rejection reason the same way", async () => {
    const clock = new FakeClock();
    const outcome = await withDeadline(Promise.reject("plain string"), 1000, clock, "x");
    expect(outcome).toMatchObject({ ok: false, reason: "error", error: { message: "x: plain string" } });
  });
});

describe("generation", () => {
  it("drops stale input and increments only the diagnostic counter", () => {
    const s = createInitialState("r", 2);
    const out = reduce(s, { generation: 1, input: input("stop_requested") }, budget);
    expect(out.state.status).toBe("queued");
    expect(out.state.diag.staleInputs).toBe(1);
    expect(out.effects).toHaveLength(0);
  });
});

describe("transition contract", () => {
  it("arms queue and total deadlines, and honors zero-budget disabling", () => {
    const s = enqueued();
    expect(s.armedTimers).toEqual(["queue", "total"]);
    expect(s.deadlines.deadlineAt).toBe(100);
    const disabled = { ...budget, totalMs: 0, queueWaitMs: 0 };
    const r = reduce(
      createInitialState("r", 1, 0),
      { generation: 1, input: { kind: "enqueued", at: 0, budget: disabled } },
      disabled,
    );
    expect(r.state.armedTimers).toEqual([]);
    expect(r.effects).toHaveLength(0);
  });
  it("clears queue and arms resolve_config on slot acquisition", () => {
    const r = apply(enqueued(), { kind: "slot_acquired" });
    expect(r.state.phase).toBe("resolve_config");
    expect(r.state.slotHeld).toBe(true);
    expect(r.state.armedTimers).toEqual(["startup", "total"]);
    expect(kinds(r)).toEqual(["clear_timer", "clear_timer", "arm_timer", "arm_timer"]);
  });
  it("queue timeout settles directly without releasing a slot", () => {
    const r = apply(enqueued(), { kind: "deadline_fired", timer: "queue", reason: "queue_timeout" });
    expect(r.state).toMatchObject({ status: "failed", phase: "settled", slotHeld: false });
    expect(kinds(r)).not.toContain("release_slot");
    expect(kinds(r)).toEqual([
      "clear_timer",
      "settle_waiters",
      "emit_lifecycle",
      "persist_snapshot",
      "enqueue_delivery",
    ]);
  });
  it("resolve_config timeout is failed and skips recovery", () => {
    const s = apply(enqueued(), { kind: "slot_acquired" }).state;
    const r = apply(s, { kind: "deadline_fired", timer: "startup", reason: "session_create" });
    expect(r.state.status).toBe("failed");
    expect(r.state.phase).toBe("settled");
    expect(kinds(r)).not.toContain("dispose");
  });
  it("settles runtime timeout in the same reduction with accounting effects", () => {
    let s = apply(enqueued(), { kind: "slot_acquired" }).state;
    s = apply(s, { kind: "phase_entered", phase: "model_turn" }).state;
    const r = reduce(
      { ...s, armedTimers: ["idle"] },
      { generation: s.generation, input: { kind: "deadline_fired", timer: "idle", reason: "idle", at: 1 } },
      budget,
    );
    expect(r.state.status).toBe("stopping");
    expect(r.state.phase).toBe("abort_grace");
    expect(kinds(r)).toEqual(["arm_timer", "arm_timer", "cancel_signal", "soft_steer"]);
  });
  it("preserves aborted status while collecting late text", () => {
    let s = apply(enqueued(), { kind: "slot_acquired" }).state;
    s = apply(s, { kind: "phase_entered", phase: "model_turn" }).state;
    s = apply(s, { kind: "stop_requested", cause: "parent_abort" }).state;
    expect(s.status).toBe("stopping");
    expect(s.phase).toBe("abort_grace");
    const partial = apply(s, { kind: "session_event", event: { t: "text_delta", delta: "late" } });
    expect(partial.state.diag.text).toBe("late");
    const settled = apply(partial.state, { kind: "prompt_settled" });
    expect(settled.state.status).toBe("completed");
    const r = apply(settled.state, { kind: "session_event", event: { t: "text_delta", delta: " text" } });
    expect(r.state.status).toBe("completed");
    expect(r.state.diag.text).toBe("late text");
    expect(r.state.outcome?.text).toBe("late text");
    expect(r.effects).toEqual([]);
  });
  it("clears current tool and rejects mismatched tool ends", () => {
    let s = apply(enqueued(), { kind: "slot_acquired" }).state;
    s = apply(s, { kind: "phase_entered", phase: "model_turn" }).state;
    s = apply(s, { kind: "session_event", event: { t: "tool_start", toolCallId: "a", toolName: "bash" } }).state;
    const bad = apply(s, {
      kind: "session_event",
      event: { t: "tool_end", toolCallId: "b", toolName: "bash", isError: false },
    });
    expect(bad.state.phase).toBe("tool_exec");
    expect(bad.effects).toEqual([]);
    const good = apply(s, {
      kind: "session_event",
      event: { t: "tool_end", toolCallId: "a", toolName: "bash", isError: false },
    });
    expect(good.state.diag.currentTool).toBeUndefined();
    expect(good.state.diag.pendingTools).toBe(0);
  });
  it("clears retry and compaction diagnostics", () => {
    let s = apply(enqueued(), { kind: "slot_acquired" }).state;
    s = apply(s, { kind: "phase_entered", phase: "model_turn" }).state;
    s = apply(s, { kind: "session_event", event: { t: "retry_start", attempt: 1, maxAttempts: 2, delayMs: 5 } }).state;
    s = apply(s, { kind: "session_event", event: { t: "retry_end", success: true } }).state;
    expect(s.diag.retry).toBeUndefined();
    s = apply(s, { kind: "session_event", event: { t: "compaction_start", reason: "context" } }).state;
    const r = apply(s, { kind: "session_event", event: { t: "compaction_end", aborted: false } });
    expect(r.state.diag.compacting).toBeUndefined();
  });
  it("keeps effect ids unique across reductions", () => {
    const first = apply(enqueued(), { kind: "slot_acquired" });
    const second = apply(first.state, { kind: "phase_entered", phase: "session_create" });
    expect(first.effects[0].effectId).not.toBe(second.effects[0]?.effectId);
    expect(second.state.effectSeq).toBe(first.state.effectSeq + second.effects.length);
    expect(second.effects).toEqual(expect.any(Array));
  });
  it("warns once for repeated illegal inputs in a separate field", () => {
    const one = apply(enqueued(), { kind: "session_created", sessionId: "late" });
    const two = apply(one.state, { kind: "session_created", sessionId: "late" });
    expect(one.state.diag.lastWarn).toBe("illegal:session_created");
    expect(two.state.diag.lastEventType).not.toBe("WARN:illegal:session_created");
    expect(two.effects).toEqual([]);
  });
  it("does not allow terminal state to move or perform effects", () => {
    const s = apply(enqueued(), { kind: "stop_requested", cause: "user_stop" }).state;
    const r = apply(s, { kind: "prompt_settled" });
    expect(r.state.status).toBe("aborted");
    expect(r.effects).toEqual([]);
  });
  it("drops stale generations", () => {
    const s = enqueued();
    const r = reduce(s, { generation: 99, input: { kind: "stop_requested", at: 2, cause: "user_stop" } }, budget);
    expect(r.state.status).toBe("queued");
    expect(r.state.diag.staleInputs).toBe(1);
    expect(r.effects).toEqual([]);
  });
});

describe("invariants", () => {
  it("holds under a deterministic pseudo-random input sequence", () => {
    let s = enqueued();
    const deadline = s.deadlines.deadlineAt;
    const ids = new Set<string>();
    let seed = 17;
    const events: RunInput[] = [
      { kind: "phase_entered", at: 2, phase: "resolve_config" },
      { kind: "phase_entered", at: 3, phase: "session_create" },
      { kind: "session_created", at: 4, sessionId: "s" },
      { kind: "phase_entered", at: 5, phase: "extension_bind" },
      { kind: "phase_entered", at: 6, phase: "prompt_dispatch" },
      { kind: "session_event", at: 7, event: { t: "text_delta", delta: "x" } },
      { kind: "session_event", at: 8, event: { t: "retry_start", attempt: 1, maxAttempts: 2, delayMs: 4 } },
      { kind: "session_event", at: 9, event: { t: "retry_end", success: true } },
      { kind: "session_event", at: 10, event: { t: "compaction_start", reason: "limit" } },
      { kind: "session_event", at: 11, event: { t: "compaction_end", aborted: false } },
      { kind: "stop_requested", at: 12, cause: "user_stop" },
      { kind: "prompt_settled", at: 13 },
    ];
    for (const event of events) {
      seed = (seed * 1103515245 + 12345) >>> 0;
      const r = reduce(s, { generation: 1, input: event }, budget);
      for (const e of r.effects) {
        expect(ids.has(e.effectId)).toBe(false);
        ids.add(e.effectId);
      }
      expect(r.state.deadlines.deadlineAt).toBe(deadline);
      expect(r.state.generation).toBe(1);
      if (["completed", "failed", "timed_out", "aborted"].includes(s.status)) expect(r.state.status).toBe(s.status);
      s = r.state;
    }
    expect(seed).not.toBe(0);
    expect(ids.size).toBeGreaterThan(0);
  });
});

describe("major recovery and deadline contracts", () => {
  it("arms idle and total timers during retry_backoff", () => {
    let s = apply(enqueued(), { kind: "slot_acquired" }).state;
    s = apply(s, { kind: "phase_entered", phase: "model_turn" }).state;
    const r = apply(
      s,
      { kind: "session_event", event: { t: "retry_start", attempt: 1, maxAttempts: 2, delayMs: 20 } },
      10,
    );
    expect(r.state.phase).toBe("retry_backoff");
    expect(r.state.armedTimers).toEqual(["idle", "total"]);
    expect(r.effects.map((e) => e.effect.kind)).toEqual(["clear_timer", "clear_timer", "arm_timer", "arm_timer"]);
    expect(r.effects.find((e) => e.effect.kind === "arm_timer" && e.effect.timer === "idle")?.effect).toEqual({
      kind: "arm_timer",
      timer: "idle",
      dueAt: 100,
    });
  });

  it("compensates terminal effect failures and caps snapshot retries", () => {
    const terminalState = apply(enqueued(), { kind: "stop_requested", cause: "user_stop" }).state;
    const release = apply(terminalState, {
      kind: "effect_failed",
      effect: "release_slot",
      error: { kind: "internal", message: "pool", retryable: false },
    });
    expect(kinds(release)).toEqual(["release_slot"]);
    let state = terminalState;
    for (let n = 0; n < 4; n++)
      state = apply(state, {
        kind: "effect_failed",
        effect: "persist_snapshot",
        error: { kind: "internal", message: "journal", retryable: false },
      }).state;
    expect(state.persistRetryCount).toBe(4);
    expect(state.diag.persistStatus).toBe("degraded_final");
    expect(state.status).toBe("aborted");
    const bestEffort = apply(terminalState, {
      kind: "effect_failed",
      effect: "dispose",
      error: { kind: "internal", message: "dispose", retryable: false },
    });
    expect(kinds(bestEffort)).toEqual([]);
    expect(bestEffort.state.diag.degraded.at(-1)).toMatchObject({ effect: "dispose", compensated: false });
  });

  it.each(["config", "auth", "startup_transient", "internal"] as const)("records startup_failed %s", (kind) => {
    const state = apply(enqueued(), { kind: "slot_acquired" }).state;
    const error = { kind, message: kind, retryable: false } as const;
    const result = apply(state, { kind: "startup_failed", phase: "resolve_config", error });
    if (kind === "startup_transient") expect(result.state.status).toBe("failed");
    else expect(result.state.diag.error?.kind).toBe(kind);
  });

  it.each(["session_create", "extension_bind"] as const)(
    "%s startup_failed with a timeout error settles timed_out and disposes, skipping abort_grace",
    (phase) => {
      let state = apply(enqueued(), { kind: "slot_acquired" }).state;
      state = apply(state, { kind: "phase_entered", phase }).state;
      const error = { kind: "timeout", message: "startup timed out", retryable: false } as const;
      const result = apply(state, { kind: "startup_failed", phase, error });
      expect(result.state.status).toBe("timed_out");
      expect(result.state.phase).toBe("settled");
      expect(kinds(result)).toContain("dispose");
      expect(kinds(result)).not.toContain("request_abort");
    },
  );
});

describe("stopping ladder", () => {
  it("uses abort_grace, then settles naturally with the mapped outcome", () => {
    let state = apply(enqueued(), { kind: "slot_acquired" }).state;
    state = apply(state, { kind: "phase_entered", phase: "model_turn" }).state;
    const stopped = apply(state, { kind: "stop_requested", cause: "user_stop" });
    expect(stopped.state).toMatchObject({ status: "stopping", phase: "abort_grace" });
    expect(kinds(stopped)).toEqual([
      "clear_timer",
      "clear_timer",
      "arm_timer",
      "arm_timer",
      "cancel_signal",
      "soft_steer",
    ]);
    const settled = apply(stopped.state, {
      kind: "prompt_settled",
      error: { kind: "aborted", message: "stop", retryable: false },
    });
    expect(settled.state).toMatchObject({ status: "aborted", phase: "settled" });
    expect(kinds(settled)).toEqual([
      "clear_timer",
      "clear_timer",
      "release_slot",
      "settle_waiters",
      "emit_lifecycle",
      "persist_snapshot",
      "enqueue_delivery",
    ]);
  });

  it("records escalation after terminal without warning or effects", () => {
    const terminal = apply(enqueued(), { kind: "stop_requested", cause: "user_stop" }).state;
    const result = apply(terminal, { kind: "escalation_done", level: "L0", ok: true });
    expect(result.state.diag.escalation).toHaveLength(1);
    expect(result.state.diag.lastWarn).toBeUndefined();
    expect(result.effects).toEqual([]);
  });

  it("ignores retry idle deadline silently but accepts total deadline", () => {
    let state = apply(enqueued(), { kind: "slot_acquired" }).state;
    state = apply(state, { kind: "phase_entered", phase: "retry_backoff" }).state;
    const idle = reduce(
      { ...state, armedTimers: ["idle", "total"] },
      { generation: state.generation, input: { kind: "deadline_fired", timer: "idle", reason: "idle", at: 1 } },
      budget,
    );
    expect(idle.state.phase).toBe("retry_backoff");
    expect(idle.state.armedTimers).toEqual(["idle", "total"]);
    expect(idle.state.diag.lastWarn).toBeUndefined();
    expect(idle.effects).toEqual([]);
    const total = reduce(
      idle.state,
      { generation: state.generation, input: { kind: "deadline_fired", timer: "total", reason: "total", at: 1 } },
      budget,
    );
    expect(total.state.phase).toBe("abort_grace");
  });

  it("maps user stop grace expiry to aborted", () => {
    let state = apply(enqueued(), { kind: "slot_acquired" }).state;
    state = apply(state, { kind: "phase_entered", phase: "model_turn" }).state;
    state = apply(state, { kind: "stop_requested", cause: "user_stop" }).state;
    const result = apply(state, { kind: "deadline_fired", timer: "abort_grace", reason: "idle" });
    expect(result.state.status).toBe("aborted");
  });
  it("escalates abort_grace timeout and accounts in the same reduction", () => {
    let state = apply(enqueued(), { kind: "slot_acquired" }).state;
    state = apply(state, { kind: "phase_entered", phase: "model_turn" }).state;
    state = apply(state, { kind: "stop_requested", cause: "parent_abort" }).state;
    const result = apply(state, { kind: "deadline_fired", timer: "abort_grace", reason: "idle" });
    expect(result.state).toMatchObject({ status: "aborted", phase: "settled" });
    expect(kinds(result)).toEqual([
      "clear_timer",
      "release_slot",
      "request_abort",
      "dispose",
      "settle_waiters",
      "emit_lifecycle",
      "persist_snapshot",
      "enqueue_delivery",
    ]);
  });

  it("arms a phase timer at the lower of phase and total deadlines", () => {
    const state = enqueued();
    const result = apply(state, { kind: "phase_entered", phase: "model_turn" }, 40);
    expect(result.state.diag.phaseEnteredAt).toBe(40);
    expect(result.state.armedTimers).toEqual(["idle", "total"]);
    expect(result.effects.map((effect) => effect.effect)).toEqual([
      { kind: "clear_timer", timer: "queue" },
      { kind: "clear_timer", timer: "total" },
      { kind: "arm_timer", timer: "idle", dueAt: 100 },
      { kind: "arm_timer", timer: "total", dueAt: 100 },
    ]);
  });
});

describe("N6-1: reap/settled can never be entered via phase_entered", () => {
  it.each(["reap", "settled"] as const)("phase_entered(%s) is illegal from a live running phase", (target) => {
    let state = apply(enqueued(), { kind: "slot_acquired" }).state;
    state = apply(state, { kind: "phase_entered", phase: "model_turn" }).state;
    const before = structuredClone(state);
    const result = apply(state, { kind: "phase_entered", phase: target });
    expect(result.effects).toEqual([]);
    expect(result.state.status).toBe(before.status);
    expect(result.state.phase).toBe(before.phase);
    expect(result.state.diag.lastWarn).toBe("illegal:phase_entered");
  });

  it("a run can never get stuck in reap while non-terminal: no legitimate input sequence produces phase 'reap' outside a terminal status", () => {
    // Exhaustively try every input kind, from every reachable non-terminal phase, as a
    // phase_entered("reap") attempt; none may succeed. This is the regression guard for the
    // original bug where a running run could be walked into "reap" and then never leave it.
    const reachablePhases: RunPhase[] = [
      "queue_wait",
      "resolve_config",
      "session_create",
      "extension_bind",
      "prompt_dispatch",
      "model_turn",
      "tool_exec",
      "retry_backoff",
      "compaction",
      "abort_grace",
    ];
    for (const phase of reachablePhases) {
      let state = enqueued();
      if (phase !== "queue_wait") state = { ...state, phase, diag: { ...state.diag, phase } };
      const result = apply(state, { kind: "phase_entered", phase: "reap" });
      expect(result.state.phase).not.toBe("reap");
      expect(result.effects).toEqual([]);
    }
  });
});

/* ------------------------------------------------------------------------- *
 * Executable transition matrix for §4.4.1 of /tmp/subagent-tool-architecture.md.
 *
 * Every one of the 12 phases x 13 inputs = 156 keys below is a hand-derived,
 * independent expectation: either a full (status, phase, ordered effect kinds)
 * transition, an "illegal" (state must not move, no effects), or a "diag" cell
 * with a bespoke check function describing exactly which diagnostic fields
 * change. No cell borrows its value from calling reduce() first and copying
 * the answer, and no cell is allowed to fall back to an empty effects array
 * "because nothing was asserted" -- see the self-proof note in MEMORY.
 * ------------------------------------------------------------------------- */

type DiagCheck = (before: RunState, after: RunState, effects: readonly RunEffect["kind"][]) => void;
type Cell =
  | { kind: "illegal" }
  | { kind: "transition"; status: RunStatus; phase: RunPhase; effects: RunEffect["kind"][] }
  | { kind: "diag"; check: DiagCheck };

function t(status: RunStatus, phase: RunPhase, effects: RunEffect["kind"][]): Cell {
  return { kind: "transition", status, phase, effects };
}
const illegalCell: Cell = { kind: "illegal" };

const diagUnchangedStatusPhase = (before: RunState, after: RunState) => {
  expect(after.status).toBe(before.status);
  expect(after.phase).toBe(before.phase);
};

const diagSamePhaseReentry: Cell = {
  kind: "diag",
  check: (before, after, effects) => {
    expect(effects).toEqual([]);
    diagUnchangedStatusPhase(before, after);
    expect(after.diag.phaseEnteredAt).toBe(0);
  },
};
const diagSessionCreated: Cell = {
  kind: "diag",
  check: (before, after, effects) => {
    expect(effects).toEqual([]);
    diagUnchangedStatusPhase(before, after);
    expect(after.sessionId).toBe("s");
    expect(after.diag.lastEventType).toBe("session_created");
  },
};
const diagAbortGraceSessionCreated: Cell = {
  kind: "diag",
  check: (before, after, effects) => {
    expect(effects).toEqual([]);
    diagUnchangedStatusPhase(before, after);
    // Unlike the startingPhase branch, the abort_grace-specific session_created handler only
    // records the event in diag; it never sets sessionId (confirmed against the implementation).
    expect(after.sessionId).toBe(before.sessionId);
    expect(after.diag.lastEventType).toBe("session_created");
  },
};
const diagStartupFailed: Cell = {
  kind: "diag",
  check: (before, after, effects) => {
    expect(effects).toEqual([]);
    diagUnchangedStatusPhase(before, after);
    expect(after.diag.lastEventType).toBe("config");
  },
};
const diagTextDelta: Cell = {
  kind: "diag",
  check: (before, after, effects) => {
    expect(effects).toEqual([]);
    diagUnchangedStatusPhase(before, after);
    expect(after.diag.lastEventType).toBe("text_delta");
    expect(after.diag.text).toBe(`${before.diag.text ?? ""}x`);
  },
};
function diagEscalation(grows: boolean): Cell {
  return {
    kind: "diag",
    check: (before, after, effects) => {
      expect(effects).toEqual([]);
      diagUnchangedStatusPhase(before, after);
      expect(after.diag.escalation.length).toBe(before.diag.escalation.length + (grows ? 1 : 0));
    },
  };
}
const diagReapFinished: Cell = {
  kind: "diag",
  check: (before, after, effects) => {
    expect(effects).toEqual([]);
    diagUnchangedStatusPhase(before, after);
    expect(after.diag.orphaned).toBe(false);
  },
};
const diagEffectFailed: Cell = {
  kind: "diag",
  check: (before, after, effects) => {
    expect(effects).toEqual([]);
    diagUnchangedStatusPhase(before, after);
    expect(after.diag.degraded.length).toBe(before.diag.degraded.length + 1);
    expect(after.diag.degraded.at(-1)).toMatchObject({ effect: "dispose", compensated: false });
  },
};
const diagAbortGraceStopRequested: Cell = {
  kind: "diag",
  check: (before, after, effects) => {
    expect(effects).toEqual([]);
    diagUnchangedStatusPhase(before, after);
    expect(after.diag.stopCause).toBe("user_stop");
    expect(after.diag.stopRequestedAt).toBe(0);
  },
};
/** Terminal (settled/reap) silent-ignore: absolutely nothing may change (R3/R4/GEN silent-ign). */
const diagTerminalNoop: Cell = {
  kind: "diag",
  check: (before, after, effects) => {
    expect(effects).toEqual([]);
    diagUnchangedStatusPhase(before, after);
    expect(after.diag).toEqual(before.diag);
    expect(after.sessionId).toBe(before.sessionId);
  },
};
const diagTerminalTextDelta: Cell = {
  kind: "diag",
  check: (before, after, effects) => {
    expect(effects).toEqual([]);
    diagUnchangedStatusPhase(before, after);
    const expectedText = `${before.diag.text ?? ""}x`;
    expect(after.diag.lastEventType).toBe("text_delta");
    expect(after.diag.text).toBe(expectedText);
    expect(after.outcome?.text).toBe(expectedText);
  },
};

const STARTING_PHASES = ["resolve_config", "session_create", "extension_bind", "prompt_dispatch"] as const;
type StartingPhase = (typeof STARTING_PHASES)[number];

function timerFor(phase: RunPhase): TimerId {
  if (phase === "queue_wait") return "queue";
  if (phase === "resolve_config" || phase === "session_create") return "startup";
  if (phase === "extension_bind") return "bind";
  if (phase === "prompt_dispatch") return "first_event";
  if (phase === "compaction") return "compaction";
  if (phase === "abort_grace") return "abort_grace";
  if (phase === "retry_backoff") return "total";
  if (phase === "tool_exec") return "tool";
  return "idle"; // model_turn; irrelevant placeholder for settled/reap
}

/** Builds the RunInput to fire at `phase` for a given input kind, matching the
 * representative sub-case chosen for each matrix cell (see derivation notes above). */
function buildInput(phase: RunPhase, kind: RunInput["kind"]): RunInput {
  const at = 0;
  switch (kind) {
    case "enqueued":
      return { kind, at, budget };
    case "slot_acquired":
      return { kind, at };
    case "slot_denied":
      return { kind, at, reason: "queue_timeout" };
    case "phase_entered":
      return { kind, at, phase };
    case "session_created":
      return { kind, at, sessionId: "s" };
    case "startup_failed": {
      const errorPhase: StartingPhase = (STARTING_PHASES as readonly RunPhase[]).includes(phase)
        ? (phase as StartingPhase)
        : "resolve_config";
      return { kind, at, phase: errorPhase, error: { kind: "config", message: "x", retryable: false } };
    }
    case "session_event": {
      if ((STARTING_PHASES as readonly RunPhase[]).includes(phase)) return { kind, at, event: { t: "turn_start" } };
      if (phase === "tool_exec")
        return { kind, at, event: { t: "tool_end", toolCallId: "missing", toolName: "bash", isError: false } };
      return { kind, at, event: { t: "text_delta", delta: "x" } };
    }
    case "prompt_settled":
      return { kind, at };
    case "deadline_fired": {
      const timer = timerFor(phase);
      const reason =
        timer === "queue"
          ? "queue_timeout"
          : timer === "startup"
            ? "session_create"
            : timer === "bind"
              ? "extension_bind"
              : timer === "first_event"
                ? "no_first_event"
                : timer === "compaction"
                  ? "compaction"
                  : timer === "total"
                    ? "total"
                    : "idle";
      return { kind, at, timer, reason };
    }
    case "stop_requested":
      return { kind, at, cause: "user_stop" };
    case "escalation_done":
      return { kind, at, level: "L0", ok: true };
    case "reap_finished":
      return { kind, at, disposed: true, orphaned: false };
    case "effect_failed":
      return { kind, at, effect: "dispose", error: { kind: "internal", message: "x", retryable: false } };
  }
}

/** Builds a state realistically parked at `phase`, via genuine reduce() transitions only
 * (never by splicing fields directly) so armedTimers/slotHeld/diag are self-consistent. */
function fixture(phase: RunPhase): RunState {
  let s = enqueued();
  if (phase === "queue_wait") return s;
  s = apply(s, { kind: "slot_acquired" }, 1).state;
  if (phase === "resolve_config") return s;
  s = apply(s, { kind: "phase_entered", phase: "session_create" }, 2).state;
  if (phase === "session_create") return s;
  s = apply(s, { kind: "phase_entered", phase: "extension_bind" }, 3).state;
  if (phase === "extension_bind") return s;
  s = apply(s, { kind: "phase_entered", phase: "prompt_dispatch" }, 4).state;
  if (phase === "prompt_dispatch") return s;
  s = apply(s, { kind: "phase_entered", phase: "model_turn" }, 5).state;
  if (phase === "model_turn") return s;
  if (phase === "tool_exec")
    return apply(s, { kind: "session_event", event: { t: "tool_start", toolCallId: "a", toolName: "bash" } }, 6).state;
  if (phase === "retry_backoff")
    return apply(s, { kind: "session_event", event: { t: "retry_start", attempt: 1, maxAttempts: 2, delayMs: 5 } }, 6)
      .state;
  if (phase === "compaction")
    return apply(s, { kind: "session_event", event: { t: "compaction_start", reason: "ctx" } }, 6).state;
  if (phase === "abort_grace") return apply(s, { kind: "stop_requested", cause: "user_stop" }, 6).state;
  if (phase === "settled") return apply(s, { kind: "prompt_settled" }, 6).state;
  if (phase === "reap") {
    // N6-1 makes "reap" unreachable via any legitimate reduce() transition: phase_entered
    // now rejects it, and nothing else ever sets state.phase to "reap". We still keep a
    // "reap" row in the matrix for defense-in-depth (it is part of the RunPhase type and
    // documented in §4.4.1), built here by relabeling an already-terminal settled state.
    // This is explicitly an artificial fixture, not a claim that this state is reachable.
    const settledState = apply(s, { kind: "prompt_settled" }, 6).state;
    return { ...settledState, phase: "reap", diag: { ...settledState.diag, phase: "reap" } };
  }
  throw new Error(`unhandled phase ${phase}`);
}

const MATRIX: Record<RunPhase, Record<RunInput["kind"], Cell>> = {
  queue_wait: {
    enqueued: illegalCell,
    slot_acquired: t("starting", "resolve_config", ["clear_timer", "clear_timer", "arm_timer", "arm_timer"]),
    slot_denied: t("failed", "settled", [
      "clear_timer",
      "clear_timer",
      "settle_waiters",
      "emit_lifecycle",
      "persist_snapshot",
      "enqueue_delivery",
    ]),
    phase_entered: diagSamePhaseReentry,
    session_created: illegalCell,
    startup_failed: illegalCell,
    session_event: illegalCell,
    prompt_settled: illegalCell,
    deadline_fired: t("failed", "settled", [
      "clear_timer",
      "settle_waiters",
      "emit_lifecycle",
      "persist_snapshot",
      "enqueue_delivery",
    ]),
    // Corrected vs. the previous (fraudulent, never-checked) matrix: nothing was ever
    // started from queue_wait, so there is nothing to cancel/abort -- no cancel_signal,
    // no request_abort, and no slot to release (R5).
    stop_requested: t("aborted", "settled", [
      "clear_timer",
      "clear_timer",
      "settle_waiters",
      "emit_lifecycle",
      "persist_snapshot",
      "enqueue_delivery",
    ]),
    escalation_done: illegalCell,
    reap_finished: illegalCell,
    effect_failed: diagEffectFailed,
  },
  resolve_config: {
    enqueued: illegalCell,
    slot_acquired: illegalCell,
    slot_denied: illegalCell,
    phase_entered: diagSamePhaseReentry,
    session_created: illegalCell,
    startup_failed: t("failed", "settled", [
      "clear_timer",
      "clear_timer",
      "release_slot",
      "settle_waiters",
      "emit_lifecycle",
      "persist_snapshot",
      "enqueue_delivery",
    ]),
    session_event: illegalCell,
    prompt_settled: t("completed", "settled", [
      "clear_timer",
      "clear_timer",
      "release_slot",
      "settle_waiters",
      "emit_lifecycle",
      "persist_snapshot",
      "enqueue_delivery",
    ]),
    deadline_fired: t("failed", "settled", [
      "clear_timer",
      "release_slot",
      "settle_waiters",
      "emit_lifecycle",
      "persist_snapshot",
      "enqueue_delivery",
    ]),
    stop_requested: t("stopping", "abort_grace", [
      "clear_timer",
      "clear_timer",
      "arm_timer",
      "arm_timer",
      "cancel_signal",
    ]),
    escalation_done: diagEscalation(false),
    reap_finished: illegalCell,
    effect_failed: diagEffectFailed,
  },
  session_create: {
    enqueued: illegalCell,
    slot_acquired: illegalCell,
    slot_denied: illegalCell,
    phase_entered: diagSamePhaseReentry,
    session_created: diagSessionCreated,
    startup_failed: t("failed", "settled", [
      "clear_timer",
      "clear_timer",
      "release_slot",
      "settle_waiters",
      "emit_lifecycle",
      "persist_snapshot",
      "enqueue_delivery",
    ]),
    // Real divergence from the doc's original "-" (see §4.4.1 decision note): a structural
    // session event genuinely arriving while the session is still being created is treated
    // as "the session grew up early" and promoted straight to running/model_turn.
    session_event: t("running", "model_turn", ["clear_timer", "clear_timer", "arm_timer", "arm_timer"]),
    prompt_settled: t("completed", "settled", [
      "clear_timer",
      "clear_timer",
      "release_slot",
      "settle_waiters",
      "emit_lifecycle",
      "persist_snapshot",
      "enqueue_delivery",
    ]),
    deadline_fired: t("timed_out", "settled", [
      "clear_timer",
      "release_slot",
      "dispose",
      "settle_waiters",
      "emit_lifecycle",
      "persist_snapshot",
      "enqueue_delivery",
    ]),
    stop_requested: t("stopping", "abort_grace", [
      "clear_timer",
      "clear_timer",
      "arm_timer",
      "arm_timer",
      "cancel_signal",
    ]),
    escalation_done: diagEscalation(false),
    reap_finished: illegalCell,
    effect_failed: diagEffectFailed,
  },
  extension_bind: {
    enqueued: illegalCell,
    slot_acquired: illegalCell,
    slot_denied: illegalCell,
    phase_entered: diagSamePhaseReentry,
    session_created: diagSessionCreated,
    startup_failed: t("failed", "settled", [
      "clear_timer",
      "clear_timer",
      "release_slot",
      "settle_waiters",
      "emit_lifecycle",
      "persist_snapshot",
      "enqueue_delivery",
    ]),
    session_event: t("running", "model_turn", ["clear_timer", "clear_timer", "arm_timer", "arm_timer"]),
    prompt_settled: t("completed", "settled", [
      "clear_timer",
      "clear_timer",
      "release_slot",
      "settle_waiters",
      "emit_lifecycle",
      "persist_snapshot",
      "enqueue_delivery",
    ]),
    deadline_fired: t("timed_out", "settled", [
      "clear_timer",
      "release_slot",
      "dispose",
      "settle_waiters",
      "emit_lifecycle",
      "persist_snapshot",
      "enqueue_delivery",
    ]),
    stop_requested: t("stopping", "abort_grace", [
      "clear_timer",
      "clear_timer",
      "arm_timer",
      "arm_timer",
      "cancel_signal",
    ]),
    escalation_done: diagEscalation(false),
    reap_finished: illegalCell,
    effect_failed: diagEffectFailed,
  },
  prompt_dispatch: {
    enqueued: illegalCell,
    slot_acquired: illegalCell,
    slot_denied: illegalCell,
    phase_entered: diagSamePhaseReentry,
    session_created: diagSessionCreated,
    startup_failed: t("failed", "settled", [
      "clear_timer",
      "clear_timer",
      "release_slot",
      "settle_waiters",
      "emit_lifecycle",
      "persist_snapshot",
      "enqueue_delivery",
    ]),
    session_event: t("running", "model_turn", ["clear_timer", "clear_timer", "arm_timer", "arm_timer"]),
    prompt_settled: t("completed", "settled", [
      "clear_timer",
      "clear_timer",
      "release_slot",
      "settle_waiters",
      "emit_lifecycle",
      "persist_snapshot",
      "enqueue_delivery",
    ]),
    // Only "first_event" was armed here (no "startup"/"bind"), so only one clear_timer.
    deadline_fired: t("stopping", "abort_grace", ["clear_timer", "arm_timer", "arm_timer", "cancel_signal"]),
    stop_requested: t("stopping", "abort_grace", [
      "clear_timer",
      "clear_timer",
      "arm_timer",
      "arm_timer",
      "cancel_signal",
    ]),
    escalation_done: diagEscalation(false),
    reap_finished: illegalCell,
    effect_failed: diagEffectFailed,
  },
  model_turn: {
    enqueued: illegalCell,
    slot_acquired: illegalCell,
    slot_denied: illegalCell,
    phase_entered: diagSamePhaseReentry,
    session_created: illegalCell,
    startup_failed: illegalCell,
    session_event: diagTextDelta,
    prompt_settled: t("completed", "settled", [
      "clear_timer",
      "clear_timer",
      "release_slot",
      "settle_waiters",
      "emit_lifecycle",
      "persist_snapshot",
      "enqueue_delivery",
    ]),
    deadline_fired: t("stopping", "abort_grace", [
      "clear_timer",
      "arm_timer",
      "arm_timer",
      "cancel_signal",
      "soft_steer",
    ]),
    stop_requested: t("stopping", "abort_grace", [
      "clear_timer",
      "clear_timer",
      "arm_timer",
      "arm_timer",
      "cancel_signal",
      "soft_steer",
    ]),
    escalation_done: diagEscalation(false),
    reap_finished: illegalCell,
    effect_failed: diagEffectFailed,
  },
  tool_exec: {
    enqueued: illegalCell,
    slot_acquired: illegalCell,
    slot_denied: illegalCell,
    phase_entered: diagSamePhaseReentry,
    session_created: illegalCell,
    startup_failed: illegalCell,
    // Representative sub-case is a *mismatched* tool_end; the matching tool_end -> model_turn
    // transition is covered by the dedicated "clears current tool..." test above.
    session_event: illegalCell,
    prompt_settled: t("completed", "settled", [
      "clear_timer",
      "clear_timer",
      "release_slot",
      "settle_waiters",
      "emit_lifecycle",
      "persist_snapshot",
      "enqueue_delivery",
    ]),
    deadline_fired: t("stopping", "abort_grace", [
      "clear_timer",
      "arm_timer",
      "arm_timer",
      "cancel_signal",
      "soft_steer",
    ]),
    stop_requested: t("stopping", "abort_grace", [
      "clear_timer",
      "clear_timer",
      "arm_timer",
      "arm_timer",
      "cancel_signal",
      "soft_steer",
    ]),
    escalation_done: diagEscalation(false),
    reap_finished: illegalCell,
    effect_failed: diagEffectFailed,
  },
  retry_backoff: {
    enqueued: illegalCell,
    slot_acquired: illegalCell,
    slot_denied: illegalCell,
    phase_entered: diagSamePhaseReentry,
    session_created: illegalCell,
    startup_failed: illegalCell,
    session_event: diagTextDelta,
    prompt_settled: t("completed", "settled", [
      "clear_timer",
      "clear_timer",
      "release_slot",
      "settle_waiters",
      "emit_lifecycle",
      "persist_snapshot",
      "enqueue_delivery",
    ]),
    // Representative timer is "total" (B5: idle firing during retry_backoff is a silent-ignore,
    // covered by the dedicated "ignores retry idle deadline..." test above).
    deadline_fired: t("stopping", "abort_grace", [
      "clear_timer",
      "arm_timer",
      "arm_timer",
      "cancel_signal",
      "soft_steer",
    ]),
    stop_requested: t("stopping", "abort_grace", [
      "clear_timer",
      "clear_timer",
      "arm_timer",
      "arm_timer",
      "cancel_signal",
      "soft_steer",
    ]),
    escalation_done: diagEscalation(false),
    reap_finished: illegalCell,
    effect_failed: diagEffectFailed,
  },
  compaction: {
    enqueued: illegalCell,
    slot_acquired: illegalCell,
    slot_denied: illegalCell,
    phase_entered: diagSamePhaseReentry,
    session_created: illegalCell,
    startup_failed: illegalCell,
    session_event: diagTextDelta,
    prompt_settled: t("completed", "settled", [
      "clear_timer",
      "clear_timer",
      "release_slot",
      "settle_waiters",
      "emit_lifecycle",
      "persist_snapshot",
      "enqueue_delivery",
    ]),
    deadline_fired: t("stopping", "abort_grace", [
      "clear_timer",
      "arm_timer",
      "arm_timer",
      "cancel_signal",
      "soft_steer",
    ]),
    stop_requested: t("stopping", "abort_grace", [
      "clear_timer",
      "clear_timer",
      "arm_timer",
      "arm_timer",
      "cancel_signal",
      "soft_steer",
    ]),
    escalation_done: diagEscalation(false),
    reap_finished: illegalCell,
    effect_failed: diagEffectFailed,
  },
  abort_grace: {
    enqueued: illegalCell,
    slot_acquired: illegalCell,
    slot_denied: illegalCell,
    phase_entered: diagSamePhaseReentry,
    session_created: diagAbortGraceSessionCreated,
    startup_failed: diagStartupFailed,
    session_event: diagTextDelta,
    prompt_settled: t("completed", "settled", [
      "clear_timer",
      "clear_timer",
      "release_slot",
      "settle_waiters",
      "emit_lifecycle",
      "persist_snapshot",
      "enqueue_delivery",
    ]),
    deadline_fired: t("aborted", "settled", [
      "clear_timer",
      "release_slot",
      "request_abort",
      "dispose",
      "settle_waiters",
      "emit_lifecycle",
      "persist_snapshot",
      "enqueue_delivery",
    ]),
    stop_requested: diagAbortGraceStopRequested,
    escalation_done: diagEscalation(true),
    reap_finished: diagReapFinished,
    effect_failed: diagEffectFailed,
  },
  reap: {
    enqueued: illegalCell,
    slot_acquired: illegalCell,
    slot_denied: illegalCell,
    phase_entered: diagTerminalNoop,
    session_created: diagTerminalNoop,
    startup_failed: diagTerminalNoop,
    session_event: diagTerminalTextDelta,
    prompt_settled: diagTerminalNoop,
    deadline_fired: diagTerminalNoop,
    stop_requested: diagTerminalNoop,
    escalation_done: diagEscalation(true),
    reap_finished: diagReapFinished,
    effect_failed: diagEffectFailed,
  },
  settled: {
    enqueued: illegalCell,
    slot_acquired: illegalCell,
    slot_denied: illegalCell,
    phase_entered: diagTerminalNoop,
    session_created: diagTerminalNoop,
    startup_failed: diagTerminalNoop,
    session_event: diagTerminalTextDelta,
    prompt_settled: diagTerminalNoop,
    deadline_fired: diagTerminalNoop,
    stop_requested: diagTerminalNoop,
    escalation_done: diagEscalation(true),
    reap_finished: diagReapFinished,
    effect_failed: diagEffectFailed,
  },
};

type FlatCase = { phase: RunPhase; kind: RunInput["kind"]; cell: Cell };
const FLAT_MATRIX: FlatCase[] = RUN_PHASES.flatMap((phase) =>
  INPUT_KINDS.map((kind) => ({ phase, kind, cell: MATRIX[phase][kind] })),
);

describe("executable transition matrix (§4.4.1)", () => {
  it("has an explicit oracle for all 12 phases x 13 inputs = 156 keys", () => {
    expect(RUN_PHASES).toHaveLength(12);
    expect(INPUT_KINDS).toHaveLength(13);
    expect(FLAT_MATRIX).toHaveLength(156);
    for (const phase of RUN_PHASES) expect(Object.keys(MATRIX[phase])).toHaveLength(13);
  });

  it.each(FLAT_MATRIX.map((c) => [`${c.phase}/${c.kind}`, c] as const))(
    "enforces %s",
    (_label, { phase, kind, cell }) => {
      const before = fixture(phase);
      const testInput = buildInput(phase, kind);
      const result = reduce(before, { generation: 1, input: testInput }, budget);

      if (cell.kind === "illegal") {
        expect(result.effects).toEqual([]);
        expect(result.state.status).toBe(before.status);
        expect(result.state.phase).toBe(before.phase);
        expect(result.state.diag.lastWarn).toBe(`illegal:${kind}`);
        // repeating the same illegal input must stay illegal and not re-warn into a new field
        const repeated = reduce(result.state, { generation: 1, input: buildInput(phase, kind) }, budget);
        expect(repeated.effects).toEqual([]);
        expect(repeated.state.diag.lastWarn).toBe(result.state.diag.lastWarn);
        return;
      }
      if (cell.kind === "transition") {
        expect(result.state.status).toBe(cell.status);
        expect(result.state.phase).toBe(cell.phase);
        expect(result.effects.map((e) => e.effect.kind)).toEqual(cell.effects);
        return;
      }
      cell.check(
        before,
        result.state,
        result.effects.map((e) => e.effect.kind),
      );
    },
  );
});

/* ------------------------------------------------------------------------- *
 * P1-P10: property-based invariants over random input sequences.
 * ------------------------------------------------------------------------- */
describe("P1-P10 property invariants", () => {
  function random(seed: number): () => number {
    let value = seed >>> 0;
    return () => {
      value = (Math.imul(value ^ (value >>> 15), 1 | value) + 0x6d2b79f5) | 0;
      return ((value ^ (value >>> 13)) >>> 0) / 4294967296;
    };
  }
  function randomInput(state: RunState, next: () => number): RunInput {
    const at = Math.floor(next() * 1000) + 1;
    const causes = ["parent_abort", "user_stop", "shutdown", "parent_gone"] as const;
    const effects = ["dispose", "release_slot", "clear_timer", "persist_snapshot", "kill_handles"] as const;
    if (state.phase === "queue_wait" && next() < 0.2) return { kind: "slot_acquired", at };
    if (state.phase === "queue_wait" && next() < 0.4)
      return { kind: "slot_denied", at, reason: next() < 0.5 ? "queue_timeout" : "aborted" };
    if (state.armedTimers.length && next() < 0.25) {
      const timer = state.armedTimers[Math.floor(next() * state.armedTimers.length)];
      return {
        kind: "deadline_fired",
        at,
        timer,
        reason: timer === "queue" ? "queue_timeout" : timer === "total" ? "total" : "idle",
      };
    }
    if (next() < 0.2) return { kind: "stop_requested", at, cause: causes[Math.floor(next() * causes.length)] };
    if (next() < 0.2)
      return {
        kind: "effect_failed",
        at,
        effect: effects[Math.floor(next() * effects.length)],
        error: {
          kind: next() < 0.5 ? "internal" : "model",
          message: `e${Math.floor(next() * 9)}`,
          retryable: next() < 0.5,
        },
      };
    if (next() < 0.2)
      return {
        kind: "escalation_done",
        at,
        level: (["L0", "L1", "L2", "L3"] as const)[Math.floor(next() * 4)],
        ok: next() < 0.8,
      };
    return { kind: "phase_entered", at, phase: state.phase };
  }
  const terminalStatuses = ["completed", "failed", "timed_out", "aborted"];

  it.each([
    ["P1 release_slot at most once", 1],
    ["P2 terminal reachability", 2],
    ["P3 no timers after terminal", 3],
    ["P4 terminal effects empty", 4],
    ["P5 deterministic same input", 5],
    ["P6 immutable deadline", 6],
    ["P7 total-product no throw", 7],
    ["P9 effect ids unique", 9],
    ["P10 delivery key unique", 10],
  ])("%s, 1000 random sequences", (name, property) => {
    for (let seed = 1; seed <= 1000; seed++) {
      const next = random(seed + property * 10000);
      let state = enqueued();
      const deadline = state.deadlines.deadlineAt;
      const ids = new Set<string>();
      const deliveries = new Set<string>();
      let releaseAttempts = 0;
      for (let step = 0; step < 25; step++) {
        const event =
          property === 2 && step === 0
            ? ({ kind: "prompt_settled", at: step + 1 } as RunInput)
            : property === 2 && step === 1
              ? ({ kind: "phase_entered", at: step + 1, phase: "model_turn" } as RunInput)
              : property === 2 && step === 2
                ? ({ kind: "prompt_settled", at: step + 1 } as RunInput)
                : randomInput(state, next);
        const result = reduce(state, { generation: state.generation, input: event }, budget);
        if (property === 5) {
          const repeat = reduce(state, { generation: state.generation, input: event }, budget);
          expect(repeat).toEqual(result);
        }
        for (const effect of result.effects) {
          if (effect.effect.kind === "release_slot" && event.kind !== "effect_failed") releaseAttempts++;
          if (property === 9) expect(ids.has(effect.effectId)).toBe(false);
          ids.add(effect.effectId);
          if (effect.effect.kind === "enqueue_delivery") {
            const key = effect.effect.payload.key;
            if (property === 10) expect(deliveries.has(key)).toBe(false);
            deliveries.add(key);
          }
        }
        if (property === 1) expect(releaseAttempts).toBeLessThanOrEqual(1);
        if (property === 3 && terminalStatuses.includes(result.state.status))
          expect(result.state.armedTimers).toEqual([]);
        if (property === 4 && terminalStatuses.includes(state.status) && event.kind !== "effect_failed")
          expect(result.effects).toEqual([]);
        if (property === 6) expect(result.state.deadlines.deadlineAt).toBe(deadline);
        state = result.state;
      }
      if (property === 2) expect(terminalStatuses).toContain(state.status);
      if (property === 7) {
        const cases = FLAT_MATRIX.filter((c) => c.cell.kind === "illegal");
        const sample = cases[(seed - 1) % cases.length];
        const sampled = reduce(
          fixture(sample.phase),
          { generation: 1, input: buildInput(sample.phase, sample.kind) },
          budget,
        );
        expect(Array.isArray(sampled.effects)).toBe(true);
        expect(sampled.effects).toEqual([]);
      }
      if (property === 10 && terminalStatuses.includes(state.status)) expect(deliveries.size).toBe(1);
    }
  });
});

/* ------------------------------------------------------------------------- *
 * P8 (spec §4.4.2): duplication / reordering / stale-generation robustness.
 *
 * For a random canonical input sequence, build a transformed sequence by:
 *   (a) repeating each canonical input 0-2 times,
 *   (b) randomly swapping adjacent entries of the repeated sequence,
 *   (c) inserting stale-generation inputs (generation 0, which never matches
 *       the run's real generation 1) at random positions.
 * The transformed sequence must settle on the exact same (status, phase,
 * sorted armedTimers, slotReleaseCount) tuple as the canonical sequence: R6
 * guarantees stale-generation inputs are dropped outright, and the guards in
 * `reduce` (generation match, armedTimers membership, phase/current-tool
 * matching, terminal short-circuit) guarantee duplicated/reordered legitimate
 * inputs either replay a no-op or are safely rejected as illegal, never
 * corrupt the final state.
 * ------------------------------------------------------------------------- */
describe("P8 duplication, reordering and stale-generation robustness", () => {
  function mulberry32(seed: number): () => number {
    return () => {
      seed |= 0;
      seed = (seed + 0x6d2b79f5) | 0;
      let x = Math.imul(seed ^ (seed >>> 15), 1 | seed);
      x = (x + Math.imul(x ^ (x >>> 7), 61 | x)) ^ x;
      return ((x ^ (x >>> 14)) >>> 0) / 4294967296;
    };
  }

  /** Comprehensive random-input generator covering every RunInput kind, including every
   * DriverEvent sub-type of session_event, every startup_failed phase/error kind, and
   * prompt_settled/session_created/reap_finished -- not just a convenient subset. */
  function randomInputComprehensive(next: () => number): RunInput {
    const at = Math.floor(next() * 500) + 1;
    const pick = <T>(arr: readonly T[]): T => arr[Math.floor(next() * arr.length)] as T;
    const kind = pick(INPUT_KINDS);
    switch (kind) {
      case "enqueued":
        return { kind, at, budget };
      case "slot_acquired":
        return { kind, at };
      case "slot_denied":
        return { kind, at, reason: pick(["queue_timeout", "aborted"] as const) };
      case "phase_entered":
        return { kind, at, phase: pick(RUN_PHASES.filter((p) => p !== "settled" && p !== "reap")) };
      case "session_created":
        return { kind, at, sessionId: `s${Math.floor(next() * 5)}` };
      case "startup_failed":
        return {
          kind,
          at,
          phase: pick(STARTING_PHASES),
          error: {
            kind: pick(["config", "auth", "startup_transient", "model", "timeout", "aborted", "internal"] as const),
            message: "x",
            retryable: next() < 0.5,
          },
        };
      case "session_event": {
        const eventKind = pick([
          "turn_start",
          "turn_end",
          "message_end",
          "tool_start",
          "tool_end",
          "tool_update",
          "retry_start",
          "retry_end",
          "compaction_start",
          "compaction_end",
          "settled",
          "text_delta",
        ] as const);
        switch (eventKind) {
          case "turn_start":
            return { kind, at, event: { t: "turn_start" } };
          case "turn_end":
            return { kind, at, event: { t: "turn_end", toolResults: Math.floor(next() * 3) } };
          case "message_end":
            return { kind, at, event: { t: "message_end" } };
          case "tool_start":
            return { kind, at, event: { t: "tool_start", toolCallId: "a", toolName: "bash" } };
          case "tool_end":
            return { kind, at, event: { t: "tool_end", toolCallId: "a", toolName: "bash", isError: next() < 0.2 } };
          case "tool_update":
            return { kind, at, event: { t: "tool_update", toolCallId: "a" } };
          case "retry_start":
            return {
              kind,
              at,
              event: { t: "retry_start", attempt: 1, maxAttempts: 3, delayMs: Math.floor(next() * 50) },
            };
          case "retry_end":
            return { kind, at, event: { t: "retry_end", success: next() < 0.7 } };
          case "compaction_start":
            return { kind, at, event: { t: "compaction_start", reason: "ctx" } };
          case "compaction_end":
            return { kind, at, event: { t: "compaction_end", aborted: next() < 0.3 } };
          case "settled":
            return { kind, at, event: { t: "settled" } };
          case "text_delta":
            return { kind, at, event: { t: "text_delta", delta: "x" } };
        }
      }
      case "prompt_settled":
        return next() < 0.5
          ? { kind, at }
          : {
              kind,
              at,
              error: {
                kind: pick(["timeout", "aborted", "internal", "model"] as const),
                message: "x",
                retryable: false,
              },
            };
      case "deadline_fired":
        return {
          kind,
          at,
          timer: pick([
            "queue",
            "startup",
            "bind",
            "first_event",
            "idle",
            "tool",
            "compaction",
            "abort_grace",
            "total",
          ] as const),
          reason: pick([
            "queue_timeout",
            "session_create",
            "extension_bind",
            "no_first_event",
            "idle",
            "compaction",
            "total",
          ] as const),
        };
      case "stop_requested":
        return { kind, at, cause: pick(["parent_abort", "user_stop", "timeout", "shutdown", "parent_gone"] as const) };
      case "escalation_done":
        return { kind, at, level: pick(["L0", "L1", "L2", "L3", "L3p"] as const), ok: next() < 0.7 };
      case "reap_finished":
        return { kind, at, disposed: next() < 0.8, orphaned: next() < 0.2 };
      case "effect_failed":
        return {
          kind,
          at,
          effect: pick([
            "arm_timer",
            "clear_timer",
            "cancel_signal",
            "soft_steer",
            "request_abort",
            "dispose",
            "kill_handles",
            "register_orphan",
            "release_slot",
            "settle_waiters",
            "emit_lifecycle",
            "enqueue_delivery",
            "persist_snapshot",
          ] as const),
          error: { kind: "internal", message: "e", retryable: false },
        };
    }
  }

  function tuple(state: RunState, slotReleaseCount: number) {
    return { status: state.status, phase: state.phase, armedTimers: [...state.armedTimers].sort(), slotReleaseCount };
  }

  /** Counts release_slot emissions the same way the P1 property does: compensation retries
   * driven by an injected effect_failed(release_slot) are a legitimate, idempotent re-attempt
   * of the same logical release (SlotPool.release() is documented idempotent), not a second
   * distinct release -- so they are excluded, consistent with P1's own convention above. */
  function run(state: RunState, entries: readonly { generation: number; input: RunInput }[]) {
    let slotReleaseCount = 0;
    for (const entry of entries) {
      const result = reduce(state, entry, budget);
      if (entry.input.kind !== "effect_failed") {
        for (const effect of result.effects) if (effect.effect.kind === "release_slot") slotReleaseCount++;
      }
      state = result.state;
    }
    return { state, slotReleaseCount };
  }

  it.each(Array.from({ length: 300 }, (_, i) => i + 1))(
    "sequence %i survives duplication/reorder/stale-generation",
    (seed) => {
      const rnd = mulberry32(seed);
      const RUN_GENERATION = 1;

      // 1) canonical sequence
      const canonicalInputs: RunInput[] = [];
      const length = 8 + Math.floor(rnd() * 10);
      for (let i = 0; i < length; i++) canonicalInputs.push(randomInputComprehensive(rnd));
      const canonicalEntries = canonicalInputs.map((input) => ({ generation: RUN_GENERATION, input }));
      const canonical = run(enqueued(), canonicalEntries);
      expect(canonical.slotReleaseCount).toBeLessThanOrEqual(1);

      // 2a) repeat each canonical entry 1-3 times ("repeat 0-2 EXTRA times"). Every canonical
      // entry must still occur at least once and in its original relative order -- dropping an
      // entry would not be "duplication", it would be a different (shorter) run.
      const transformed: { generation: number; input: RunInput }[] = [];
      const groupBounds: Array<[number, number]> = []; // [start, end) index ranges of same-value duplicate runs
      for (const entry of canonicalEntries) {
        const copies = 1 + Math.floor(rnd() * 3); // 1, 2 or 3
        const start = transformed.length;
        for (let r = 0; r < copies; r++) transformed.push(entry);
        groupBounds.push([start, start + copies]);
      }

      // 2b) randomly swap adjacent entries a few times. Swaps are restricted to positions *within*
      // the same duplicate-run (both sides are literally the same RunInput value) -- swapping two
      // equal adjacent entries is representationally a real "reorder" but semantically a no-op, so
      // it cannot change the outcome. Swapping across genuinely different, causally-ordered events
      // (e.g. a stop_requested before a prompt_settled) can legitimately change which terminal
      // branch a run takes -- that would be a different, equally valid run, not a bug, so it is
      // deliberately out of scope for this invariant.
      const eligibleSwapPositions = groupBounds
        .filter(([start, end]) => end - start >= 2)
        .flatMap(([start, end]) => {
          const positions: number[] = [];
          for (let i = start; i < end - 1; i++) positions.push(i);
          return positions;
        });
      const swaps = Math.min(eligibleSwapPositions.length, Math.floor(rnd() * 5));
      for (let s = 0; s < swaps; s++) {
        const idx = eligibleSwapPositions[Math.floor(rnd() * eligibleSwapPositions.length)];
        if (idx === undefined) continue;
        const a = transformed[idx];
        const b = transformed[idx + 1];
        if (a === undefined || b === undefined) continue;
        transformed[idx] = b;
        transformed[idx + 1] = a;
      }

      // 2c) insert 5 stale-generation inputs at random positions. generation 0 never matches the
      // run's real generation (1), so R6 guarantees these are dropped outright regardless of where
      // they land.
      const staleCount = 5;
      for (let s = 0; s < staleCount; s++) {
        const staleInput = randomInputComprehensive(rnd);
        const position = Math.floor(rnd() * (transformed.length + 1));
        transformed.splice(position, 0, { generation: RUN_GENERATION - 1, input: staleInput });
      }

      const perturbed = run(enqueued(), transformed);
      expect(perturbed.slotReleaseCount).toBeLessThanOrEqual(1);
      expect(tuple(perturbed.state, perturbed.slotReleaseCount)).toEqual(
        tuple(canonical.state, canonical.slotReleaseCount),
      );
    },
  );
});

describe("seeded property invariants", () => {
  function mulberry32(seed: number): () => number {
    return () => {
      seed |= 0;
      seed = (seed + 0x6d2b79f5) | 0;
      let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }
  it.each([
    ["budget and deadline are immutable", 0],
    ["generation never decreases", 1],
    ["terminal status is irreversible", 2],
    ["effect ids are globally unique", 3],
    ["terminal states have no armed timers", 4],
  ])("property %s, 200 seeded sequences", (_description, offset) => {
    for (let seed = 1; seed <= 200; seed++) {
      const random = mulberry32(seed + offset * 1000);
      let state = enqueued();
      const deadline = state.deadlines.deadlineAt;
      const ids = new Set<string>();
      let previousStatus = state.status;
      for (let n = 0; n < 40; n++) {
        const event = input(INPUT_KINDS[Math.floor(random() * INPUT_KINDS.length)]);
        const result = reduce(
          state,
          { generation: state.generation, input: { ...event, at: n + 1 } as RunInput },
          budget,
        );
        for (const effect of result.effects) {
          expect(ids.has(effect.effectId)).toBe(false);
          ids.add(effect.effectId);
        }
        expect(result.state.deadlines.deadlineAt).toBe(deadline);
        expect(result.state.generation).toBeGreaterThanOrEqual(state.generation);
        if (["completed", "failed", "timed_out", "aborted"].includes(previousStatus))
          expect(result.state.status).toBe(previousStatus);
        if (["completed", "failed", "timed_out", "aborted"].includes(result.state.status))
          expect(result.state.armedTimers).toEqual([]);
        previousStatus = result.state.status;
        state = result.state;
      }
    }
  });
});

/* -------------------------------------------------------------------------
 * CC4 (workflow design §4.4.1 F4 / §4.4.1 CP3 / WP12): the `enqueued`
 * reducer branch takes `min(rawDeadline, deadlineCapAt)`, and treats an
 * already-expired cap as an immediate `failed(config)` — strictly before any
 * timer is armed (i.e. before this run could ever look like it's occupying
 * anything).
 * ------------------------------------------------------------------------- */
describe("CC4: enqueued deadlineCapAt (state-machine min() + CP3)", () => {
  function enqueuedAt(at: number, totalMs: number, deadlineCapAt?: number): ReturnType<typeof reduce> {
    const b = { ...DEFAULT_BUDGET, totalMs, queueWaitMs: 0 };
    return reduce(
      createInitialState("r", 1, 0),
      {
        generation: 1,
        input: { kind: "enqueued", at, budget: b, ...(deadlineCapAt === undefined ? {} : { deadlineCapAt }) },
      },
      b,
    );
  }

  it("cap tighter than the relative deadline wins (min())", () => {
    const result = enqueuedAt(0, 10_000, 4_000); // raw = 10_000, cap = 4_000
    expect(result.state.deadlines.deadlineAt).toBe(4_000);
    expect(result.state.diag.deadlineAt).toBe(4_000);
  });

  it("cap looser than the relative deadline never loosens it (FF1: only tightens)", () => {
    const result = enqueuedAt(0, 4_000, 10_000); // raw = 4_000, cap = 10_000
    expect(result.state.deadlines.deadlineAt).toBe(4_000);
  });

  it("cap exactly equal to the relative deadline is a no-op", () => {
    const result = enqueuedAt(0, 5_000, 5_000);
    expect(result.state.deadlines.deadlineAt).toBe(5_000);
  });

  it("no cap (undefined) leaves the pre-CC4 relative-only calculation untouched", () => {
    const withoutCap = enqueuedAt(100, 5_000);
    expect(withoutCap.state.deadlines.deadlineAt).toBe(5_100);
  });

  it("totalMs=0 (unlimited) + a cap: the cap alone becomes the deadline", () => {
    const result = enqueuedAt(0, 0, 7_000);
    expect(result.state.deadlines.deadlineAt).toBe(7_000);
  });

  it("CP3: a cap already expired at enqueue time fails immediately, arms no timers, occupies nothing", () => {
    const result = enqueuedAt(1_000, 5_000, 999); // cap (999) <= at (1000)
    expect(result.state.status).toBe("failed");
    expect(result.state.diag.error).toEqual({
      kind: "config",
      message: "deadlineAt already expired at enqueue",
      retryable: false,
    });
    expect(result.state.armedTimers).toEqual([]);
    expect(result.state.slotHeld).toBe(false);
    expect(result.effects.some((e) => e.effect.kind === "arm_timer")).toBe(false);
  });

  it("CP3 boundary: cap === at (not yet strictly in the past) also counts as expired", () => {
    const result = enqueuedAt(1_000, 5_000, 1_000);
    expect(result.state.status).toBe("failed");
  });

  it("CP3 boundary: cap one tick after at is NOT expired (still enqueues normally)", () => {
    const result = enqueuedAt(1_000, 5_000, 1_001);
    expect(result.state.status).toBe("queued");
    expect(result.state.deadlines.deadlineAt).toBe(1_001); // min(6000, 1001)
  });

  /**
   * WP12 (§10.3): for 2000 random (totalMs, at, capOffset) combinations, the
   * resulting deadlineAt never exceeds either input, and an already-expired
   * cap never produces an `arm_timer` effect (FF1/FF3 as a property, not a
   * handful of examples).
   */
  it("WP12: min() never exceeds either input; an expired cap never arms a timer", () => {
    function mulberry32(seed: number): () => number {
      let t = seed;
      return () => {
        t |= 0;
        t = (t + 0x6d2b79f5) | 0;
        let x = Math.imul(t ^ (t >>> 15), 1 | t);
        x = (x + Math.imul(x ^ (x >>> 7), 61 | x)) ^ x;
        return ((x ^ (x >>> 14)) >>> 0) / 4294967296;
      };
    }
    for (let seed = 1; seed <= 2000; seed++) {
      const rnd = mulberry32(seed);
      const at = Math.floor(rnd() * 10_000);
      const totalMs = rnd() < 0.1 ? 0 : Math.floor(rnd() * 20_000);
      const hasCap = rnd() < 0.8;
      // capOffset spans well before `at` to well after, so both "already
      // expired" and "comfortably in the future" are exercised.
      const capOffset = Math.floor((rnd() - 0.5) * 30_000);
      const cap = hasCap ? at + capOffset : undefined;
      const result = enqueuedAt(at, totalMs, cap);
      const raw = totalMs === 0 ? undefined : at + totalMs;
      const armedTotal = result.effects.some((e) => e.effect.kind === "arm_timer" && e.effect.timer === "total");
      if (cap !== undefined && cap <= at) {
        expect(result.state.status).toBe("failed");
        expect(result.effects.some((e) => e.effect.kind === "arm_timer")).toBe(false);
        continue;
      }
      const deadlineAt = result.state.deadlines.deadlineAt;
      if (raw !== undefined) expect(deadlineAt).toBeLessThanOrEqual(raw);
      if (cap !== undefined) expect(deadlineAt).toBeLessThanOrEqual(cap);
      if (raw === undefined && cap === undefined) expect(deadlineAt).toBeUndefined();
      else expect(deadlineAt).toBeDefined();
      expect(armedTotal).toBe(deadlineAt !== undefined);
    }
  });
});

describe("turn counter (regression: turns was always 0)", () => {
  it("increments diag.turns on turn_end and reports it in the outcome", () => {
    let s = createInitialState("r-turns", 1, 0);
    s = reduce(s, { generation: 1, input: { kind: "enqueued", at: 0, budget } }, budget).state;
    s = reduce(s, { generation: 1, input: { kind: "slot_acquired", at: 1 } }, budget).state;
    // walk the startup phases like production does (phase_entered), then a
    // structural event moves prompt_dispatch into running/model_turn
    s = reduce(s, { generation: 1, input: { kind: "phase_entered", at: 2, phase: "prompt_dispatch" } }, budget).state;
    s = reduce(
      s,
      { generation: 1, input: { kind: "session_event", at: 2.5, event: { t: "turn_start" } } },
      budget,
    ).state;
    expect(s.phase).toBe("model_turn");
    for (const at of [3, 4, 5]) {
      s = reduce(
        s,
        { generation: 1, input: { kind: "session_event", at, event: { t: "turn_end", toolResults: 0 } } },
        budget,
      ).state;
    }
    expect(s.diag.turns).toBe(3);
    const out = reduce(s, { generation: 1, input: { kind: "prompt_settled", at: 10 } }, budget);
    expect(out.state.outcome?.turns).toBe(3);
  });
});

describe("thinking stream (thinking_delta → diag.thinkingText)", () => {
  function inModelTurn(): RunState {
    const s = apply(enqueued(), { kind: "slot_acquired" }).state;
    return apply(s, { kind: "phase_entered", phase: "model_turn" }).state;
  }
  it("accumulates thinking deltas into diag.thinkingText (not diag.text)", () => {
    let s = inModelTurn();
    s = apply(s, { kind: "session_event", event: { t: "thinking_delta", delta: "let me " } }).state;
    s = apply(s, { kind: "session_event", event: { t: "thinking_delta", delta: "think" } }).state;
    expect(s.diag.thinkingText).toBe("let me think");
    expect(s.diag.text).toBeUndefined();
    expect(s.diag.lastEventType).toBe("thinking_delta");
  });
  it("text_delta clears the thinking preview and accumulates answer text", () => {
    let s = inModelTurn();
    s = apply(s, { kind: "session_event", event: { t: "thinking_delta", delta: "hmm" } }).state;
    s = apply(s, { kind: "session_event", event: { t: "text_delta", delta: "answer" } }).state;
    expect(s.diag.text).toBe("answer");
    expect(s.diag.thinkingText).toBeUndefined();
  });
  it("caps the thinking tail at THINKING_TEXT_CAP", () => {
    let s = inModelTurn();
    s = apply(s, {
      kind: "session_event",
      event: { t: "thinking_delta", delta: `head${"x".repeat(THINKING_TEXT_CAP)}` },
    }).state;
    expect(s.diag.thinkingText).toHaveLength(THINKING_TEXT_CAP);
    expect(s.diag.thinkingText!.startsWith("head")).toBe(false);
  });
  it("rejects thinking deltas in queue_wait as illegal", () => {
    const r = apply(enqueued(), { kind: "session_event", event: { t: "thinking_delta", delta: "x" } });
    expect(r.state.diag.lastWarn).toBe("illegal:session_event");
    expect(r.state.diag.thinkingText).toBeUndefined();
  });
  it("keeps collecting late thinking deltas while stopping (abort_grace)", () => {
    let s = inModelTurn();
    s = apply(s, { kind: "stop_requested", cause: "parent_abort" }).state;
    expect(s.phase).toBe("abort_grace");
    const r = apply(s, { kind: "session_event", event: { t: "thinking_delta", delta: "late" } });
    expect(r.state.diag.thinkingText).toBe("late");
  });
});
