import { DEFAULT_BUDGET, dueAtFor, idleDueAt } from "./deadline.js";
import type {
  DeadlineBudget,
  EffectEnvelope,
  ErrorInfo,
  LifecycleEvent,
  RunDiagnostics,
  RunEffect,
  RunInput,
  RunOutcome,
  RunPhase,
  RunState,
  RunStatus,
  StampedInput,
  TimerId,
  UsageDelta,
} from "./types.js";

/**
 * X9: sum a message_end usage delta into the run's lifetime accumulator.
 * Every message_end event carries the usage of *that* message only (not a
 * running session total), so plain summation is correct across compaction
 * (pi's own session-level stats reset post-compaction; this accumulator
 * never reads them and is therefore unaffected — architecture §7.2 X9).
 */
function accumulateUsage(prev: UsageDelta | undefined, delta: UsageDelta | undefined): UsageDelta | undefined {
  if (!delta) return prev;
  const base = prev ?? { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, costUsd: 0 };
  return {
    input: base.input + delta.input,
    output: base.output + delta.output,
    cacheRead: base.cacheRead + delta.cacheRead,
    cacheWrite: base.cacheWrite + delta.cacheWrite,
    costUsd: base.costUsd + delta.costUsd,
  };
}

export const RUN_PHASES: readonly RunPhase[] = [
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
  "reap",
  "settled",
];
export const INPUT_KINDS: readonly RunInput["kind"][] = [
  "enqueued",
  "slot_acquired",
  "slot_denied",
  "phase_entered",
  "session_created",
  "startup_failed",
  "session_event",
  "prompt_settled",
  "deadline_fired",
  "stop_requested",
  "escalation_done",
  "reap_finished",
  "effect_failed",
];
const terminal = (s: RunStatus): s is RunOutcome["status"] =>
  s === "completed" || s === "failed" || s === "timed_out" || s === "aborted";
const startingPhase = (p: RunPhase) => p === "session_create" || p === "extension_bind" || p === "prompt_dispatch";
const phaseTimer = (p: RunPhase): TimerId | undefined =>
  ({
    queue_wait: "queue",
    resolve_config: "startup",
    session_create: "startup",
    extension_bind: "bind",
    prompt_dispatch: "first_event",
    model_turn: "idle",
    tool_exec: "tool",
    retry_backoff: "idle",
    compaction: "compaction",
    abort_grace: "abort_grace",
    reap: "reap",
    settled: undefined,
  })[p];
function makeDiag(at: number, generation: number): RunDiagnostics {
  return {
    createdAt: at,
    phase: "queue_wait",
    phaseEnteredAt: at,
    pendingTools: 0,
    turns: 0,
    escalation: [],
    orphaned: false,
    generation,
    degraded: [],
    staleInputs: 0,
    unkillable: [],
  };
}
export function createInitialState(runId: string, generation = 1, at = 0, parentRunId?: string): RunState {
  return {
    runId,
    generation,
    status: "queued",
    phase: "queue_wait",
    deadlines: { enqueuedAt: at, deadlineAt: undefined, queueDeadlineAt: undefined },
    diag: makeDiag(at, generation),
    armedTimers: [],
    slotHeld: false,
    effectSeq: 0,
    persistRetryCount: 0,
    ...(parentRunId === undefined ? {} : { parentRunId }),
  };
}
function envelope(state: RunState, seq: number, effect: RunEffect): EffectEnvelope {
  const criticality =
    effect.kind === "release_slot" ||
    effect.kind === "settle_waiters" ||
    effect.kind === "clear_timer" ||
    effect.kind === "persist_snapshot"
      ? "critical"
      : "best_effort";
  return { effectId: `${state.runId}:${state.generation}:${seq}`, effect, criticality };
}
function emit(state: RunState, effects: RunEffect[]): { state: RunState; effects: readonly EffectEnvelope[] } {
  const wrapped = effects.map((e, i) => envelope(state, state.effectSeq + i, e));
  return { state: { ...state, effectSeq: state.effectSeq + wrapped.length }, effects: wrapped };
}
function clearAndArm(
  state: RunState,
  phase: RunPhase,
  at: number,
  budget: DeadlineBudget,
): { state: RunState; effects: RunEffect[] } {
  const effects: RunEffect[] = state.armedTimers.map((timer) => ({ kind: "clear_timer" as const, timer }));
  const phaseTimerId = phaseTimer(phase);
  const phaseDiag = { ...state.diag, phase, phaseEnteredAt: at };
  const phaseDue =
    phase === "retry_backoff"
      ? idleDueAt({ ...phaseDiag, lastEventAt: at }, budget)
      : phaseTimerId === undefined
        ? undefined
        : dueAtFor(phase, phaseDiag, budget);
  const timers: TimerId[] = [];
  if (phaseTimerId !== undefined && phaseDue !== undefined && budget.totalMs !== 0) {
    timers.push(phaseTimerId);
    effects.push({
      kind: "arm_timer",
      timer: phaseTimerId,
      dueAt: state.deadlines.deadlineAt === undefined ? phaseDue : Math.min(phaseDue, state.deadlines.deadlineAt),
    });
  }
  if (state.deadlines.deadlineAt !== undefined && budget.totalMs !== 0) {
    timers.push("total");
    effects.push({ kind: "arm_timer", timer: "total", dueAt: state.deadlines.deadlineAt });
  }
  return {
    state: { ...state, phase, diag: phaseDiag, armedTimers: timers },
    effects,
  };
}
function enter(
  state: RunState,
  status: RunStatus,
  phase: RunPhase,
  at: number,
  budget: DeadlineBudget,
  patch: Partial<RunDiagnostics> = {},
): { state: RunState; effects: readonly EffectEnvelope[] } {
  const entered = clearAndArm({ ...state, status, diag: { ...state.diag, ...patch } }, phase, at, budget);
  return emit(entered.state, entered.effects);
}
function finish(
  state: RunState,
  status: RunStatus,
  at: number,
  budget: DeadlineBudget,
  patch: Partial<RunDiagnostics> = {},
  extra: RunEffect[] = [],
): { state: RunState; effects: readonly EffectEnvelope[] } {
  const d = { ...state.diag, ...patch, phase: "settled" as const, phaseEnteredAt: at, settledAt: at };
  const next: RunState = { ...state, status, phase: "settled", diag: d, armedTimers: [] };
  const outcome: RunOutcome = {
    runId: state.runId,
    status: status as RunOutcome["status"],
    ...(d.text === undefined ? {} : { text: d.text }),
    ...(d.usage === undefined ? {} : { usage: d.usage }),
    turns: d.turns,
    durationMs: Math.max(0, at - state.deadlines.enqueuedAt),
    ...(d.timeoutReason ? { timeoutReason: d.timeoutReason } : {}),
    ...(d.error ? { error: d.error } : {}),
    diag: d,
  };
  const lifecycle: LifecycleEvent = { runId: state.runId, generation: state.generation, status, at };
  const snapshot = {
    runId: state.runId,
    generation: state.generation,
    status,
    phase: "settled" as const,
    deadlines: state.deadlines,
    diag: d,
    outcome,
    updatedAt: at,
    ...(state.parentRunId === undefined ? {} : { parentRunId: state.parentRunId }),
  };
  const effects = [
    ...state.armedTimers.map((timer) => ({ kind: "clear_timer", timer }) as RunEffect),
    ...(state.slotHeld ? [{ kind: "release_slot" as const }] : []),
    ...extra,
    { kind: "settle_waiters", outcome },
    { kind: "emit_lifecycle", event: lifecycle },
    { kind: "persist_snapshot", snapshot },
    {
      kind: "enqueue_delivery",
      payload: {
        key: `${state.runId}:${state.generation}:${status}`,
        runId: state.runId,
        generation: state.generation,
        status,
        textPreview: d.text ?? "",
        diag: {
          phase: "settled",
          status,
          pendingTools: d.pendingTools,
          staleInputs: d.staleInputs,
          degraded: d.degraded.length,
        },
        createdAt: at,
        reconcileRound: 0,
      },
    },
  ] as RunEffect[];
  return emit({ ...next, outcome }, effects);
}
function illegal(state: RunState, input: RunInput): { state: RunState; effects: readonly EffectEnvelope[] } {
  const warning = `illegal:${input.kind}`;
  if (state.diag.lastWarn === warning) return { state, effects: [] };
  return { state: { ...state, diag: { ...state.diag, lastWarn: warning } }, effects: [] };
}
function terminalUpdate(state: RunState, input: RunInput): { state: RunState; effects: readonly EffectEnvelope[] } {
  const d = { ...state.diag };
  if (input.kind === "escalation_done") {
    d.escalation = [...d.escalation, { level: input.level, at: input.at, ok: input.ok }];
    return { state: { ...state, diag: d }, effects: [] };
  }
  if (input.kind === "reap_finished") {
    return { state: { ...state, diag: { ...d, orphaned: input.orphaned } }, effects: [] };
  }
  if (input.kind === "session_event") {
    d.lastEventAt = input.at;
    d.lastEventType = input.event.t;
    if (input.event.t === "text_delta") {
      d.text = (d.text ?? "") + input.event.delta;
      if (state.outcome)
        return {
          state: { ...state, diag: d, outcome: { ...state.outcome, text: d.text, diag: d } },
          effects: [],
        };
    }
    // X9: usage must keep accumulating even after the run has settled (a
    // trailing message_end can still arrive while abort/reap teardown is in
    // flight) so outcome.usage reflects the true lifetime total, not a
    // snapshot frozen at the moment `finish()` ran.
    if (input.event.t === "message_end") {
      const nextUsage = accumulateUsage(d.usage, input.event.usage);
      if (nextUsage === undefined) delete d.usage;
      else d.usage = nextUsage;
      if (state.outcome)
        return {
          state: {
            ...state,
            diag: d,
            outcome: { ...state.outcome, ...(d.usage === undefined ? {} : { usage: d.usage }), diag: d },
          },
          effects: [],
        };
    }
    return { state: { ...state, diag: d }, effects: [] };
  }
  if (
    input.kind === "prompt_settled" ||
    input.kind === "deadline_fired" ||
    input.kind === "stop_requested" ||
    input.kind === "phase_entered" ||
    input.kind === "startup_failed" ||
    input.kind === "session_created"
  )
    return { state: { ...state, diag: d }, effects: [] };
  return illegal(state, input);
}
export function reduce(
  state: RunState,
  stamped: StampedInput,
  budget: DeadlineBudget = DEFAULT_BUDGET,
): { state: RunState; effects: readonly EffectEnvelope[] } {
  const input = stamped.input;
  if (stamped.generation !== state.generation)
    return { state: { ...state, diag: { ...state.diag, staleInputs: state.diag.staleInputs + 1 } }, effects: [] };
  // effect_failed is a recovery protocol, including after settlement. It must
  // run before the terminal read-only update so terminal effects can recover.
  if (input.kind === "effect_failed") return handleEffectFailed(state, input);
  if (terminal(state.status)) return terminalUpdate(state, input);
  if (input.kind === "enqueued") {
    if (state.diag.enqueuedAt !== undefined) return illegal(state, input);
    const deadlineAt = input.budget.totalMs === 0 ? undefined : input.at + input.budget.totalMs;
    const queueDeadlineAt = input.budget.queueWaitMs === 0 ? undefined : input.at + input.budget.queueWaitMs;
    let armedTimers: TimerId[] = [];
    const effects: RunEffect[] = [];
    if (queueDeadlineAt !== undefined) {
      armedTimers = ["queue"];
      effects.push({ kind: "arm_timer", timer: "queue", dueAt: queueDeadlineAt });
    }
    if (deadlineAt !== undefined) {
      armedTimers = [...armedTimers, "total"];
      effects.push({ kind: "arm_timer", timer: "total", dueAt: deadlineAt });
    }
    const next: RunState = {
      ...state,
      deadlines: { enqueuedAt: input.at, deadlineAt, queueDeadlineAt },
      diag: { ...state.diag, enqueuedAt: input.at, ...(deadlineAt === undefined ? {} : { deadlineAt }) },
      armedTimers,
    };
    return emit(next, effects);
  }
  if (input.kind === "phase_entered") {
    // N6-1: reap/settled are terminal-only bookkeeping phases, never a legitimate
    // phase_entered target. Accepting them here previously let a run get stuck in
    // "reap" while still non-terminal (running), with no way out.
    if (!RUN_PHASES.includes(input.phase) || input.phase === "settled" || input.phase === "reap")
      return illegal(state, input);
    if (state.phase === input.phase)
      return {
        state: { ...state, diag: { ...state.diag, phase: input.phase, phaseEnteredAt: input.at } },
        effects: [],
      };
    const entered = clearAndArm(state, input.phase, input.at, budget);
    return emit(entered.state, entered.effects);
  }
  if (input.kind === "slot_acquired" && state.phase === "queue_wait")
    return enter({ ...state, slotHeld: true }, "starting", "resolve_config", input.at, budget, { startedAt: input.at });
  if (input.kind === "slot_denied" && state.phase === "queue_wait")
    return finish(
      state,
      input.reason === "aborted" ? "aborted" : "failed",
      input.at,
      budget,
      input.reason === "queue_timeout" ? { timeoutReason: "queue_timeout" } : {},
    );
  if (input.kind === "stop_requested" && (state.phase === "abort_grace" || state.phase === "reap"))
    return {
      state: { ...state, diag: { ...state.diag, stopRequestedAt: input.at, stopCause: input.cause } },
      effects: [],
    };
  if (input.kind === "stop_requested") {
    if (state.phase === "queue_wait")
      return finish(state, "aborted", input.at, budget, { stopCause: input.cause, stopRequestedAt: input.at });
    const running = ["model_turn", "tool_exec", "retry_backoff", "compaction"].includes(state.phase);
    const entered = enter(state, "stopping", "abort_grace", input.at, budget, {
      stopCause: input.cause,
      stopRequestedAt: input.at,
    });
    const controls = emit(entered.state, [
      { kind: "cancel_signal", reason: input.cause },
      ...(running ? [{ kind: "soft_steer" as const, text: "wrap up now" }] : []),
    ]);
    return { state: controls.state, effects: [...entered.effects, ...controls.effects] };
  }
  if (input.kind === "startup_failed" && state.phase === "abort_grace")
    return { state: { ...state, diag: { ...state.diag, lastEventType: input.error.kind } }, effects: [] };
  if (input.kind === "session_created" && state.phase === "abort_grace")
    return { state: { ...state, diag: { ...state.diag, lastEventType: "session_created" } }, effects: [] };
  if (input.kind === "session_created" && startingPhase(state.phase))
    return {
      state: {
        ...state,
        sessionId: input.sessionId,
        diag: {
          ...state.diag,
          lastEventType: "session_created",
          ...(input.sessionFile === undefined ? {} : { sessionFile: input.sessionFile }),
        },
      },
      effects: [],
    };
  if (input.kind === "startup_failed" && state.phase === input.phase) {
    if (input.error.kind === "startup_transient" && input.error.retryable && state.diag.turns < budget.startupRetries)
      return {
        state: { ...state, diag: { ...state.diag, lastEventType: "startup_retry", turns: state.diag.turns + 1 } },
        effects: [],
      };
    if (input.phase === "resolve_config")
      return finish(state, "failed", input.at, budget, {
        lastEventType: input.error.kind,
        error: input.error,
      });
    if (input.error.kind === "timeout")
      return finish(
        state,
        "timed_out",
        input.at,
        budget,
        { timeoutReason: input.phase === "extension_bind" ? "extension_bind" : "session_create" },
        [{ kind: "dispose" }],
      );
    return finish(state, "failed", input.at, budget, { lastEventType: input.error.kind });
  }
  if (input.kind === "session_event") {
    const e = input.event;
    const usage = e.t === "message_end" ? accumulateUsage(state.diag.usage, e.usage) : undefined;
    const base: Partial<RunDiagnostics> = {
      lastEventAt: input.at,
      lastEventType: e.t,
      // X9: threaded through every downstream branch below via `{...state.diag, ...base}`
      // so the accumulator is updated regardless of which phase/branch handles this event
      // (including the abort_grace/reap early-return branch immediately below).
      ...(usage === undefined ? {} : { usage }),
    };
    if (state.phase === "abort_grace" || state.phase === "reap") {
      const diag = {
        ...state.diag,
        ...base,
        ...(e.t === "text_delta" ? { text: (state.diag.text ?? "") + e.delta } : {}),
      };
      return {
        state:
          state.outcome && diag.text !== undefined
            ? { ...state, diag, outcome: { ...state.outcome, text: diag.text, diag } }
            : { ...state, diag },
        effects: [],
      };
    }
    if (e.t === "text_delta") {
      if (state.phase === "queue_wait") return illegal(state, input);
      return {
        state: { ...state, diag: { ...state.diag, ...base, text: (state.diag.text ?? "") + e.delta } },
        effects: [],
      };
    }
    if (e.t === "tool_start" && (state.phase === "model_turn" || state.phase === "prompt_dispatch"))
      return enter({ ...state, diag: { ...state.diag, ...base } }, "running", "tool_exec", input.at, budget, {
        currentTool: { name: e.toolName, toolCallId: e.toolCallId, startedAt: input.at },
        pendingTools: state.diag.pendingTools + 1,
      });
    if (e.t === "tool_end") {
      if (state.phase !== "tool_exec" || state.diag.currentTool?.toolCallId !== e.toolCallId)
        return illegal(state, input);
      const nextDiag = { ...state.diag, ...base, pendingTools: Math.max(0, state.diag.pendingTools - 1) };
      delete nextDiag.currentTool;
      return enter({ ...state, diag: nextDiag }, "running", "model_turn", input.at, budget);
    }
    if (e.t === "retry_start")
      return enter({ ...state, diag: { ...state.diag, ...base } }, "running", "retry_backoff", input.at, budget, {
        retry: { attempt: e.attempt, maxAttempts: e.maxAttempts, delayMs: e.delayMs, startedAt: input.at },
      });
    if (e.t === "retry_end" && state.phase === "retry_backoff") {
      const nextDiag = { ...state.diag, ...base };
      delete nextDiag.retry;
      return enter({ ...state, diag: nextDiag }, "running", "model_turn", input.at, budget);
    }
    if (e.t === "compaction_start")
      return enter({ ...state, diag: { ...state.diag, ...base } }, "running", "compaction", input.at, budget, {
        compacting: { reason: e.reason, startedAt: input.at },
      });
    if (e.t === "compaction_end" && state.phase === "compaction") {
      const nextDiag = { ...state.diag, ...base };
      delete nextDiag.compacting;
      return enter({ ...state, diag: nextDiag }, "running", "model_turn", input.at, budget);
    }
    if (state.phase === "prompt_dispatch" || startingPhase(state.phase))
      return enter({ ...state, diag: { ...state.diag, ...base } }, "running", "model_turn", input.at, budget);
    if (["model_turn", "tool_exec", "retry_backoff", "compaction"].includes(state.phase))
      return { state: { ...state, diag: { ...state.diag, ...base } }, effects: [] };
    return illegal(state, input);
  }
  if (input.kind === "prompt_settled") {
    if (state.phase === "queue_wait" || state.phase === "reap") return illegal(state, input);
    const status =
      input.error === undefined
        ? "completed"
        : input.error.kind === "aborted"
          ? "aborted"
          : input.error.kind === "timeout"
            ? "timed_out"
            : "failed";
    // Final text from SessionHandle.getLastAssistantText() (passed by the
    // runner alongside prompt_settled) only fills in when no text_delta
    // events already accumulated diag.text — deltas are the more granular,
    // already-observed source of truth when both are present.
    const textPatch = input.text !== undefined && state.diag.text === undefined ? { text: input.text } : {};
    return finish(state, status, input.at, budget, {
      ...textPatch,
      ...(input.error === undefined ? {} : { error: input.error }),
      ...(input.error?.kind === "timeout" ? { timeoutReason: "total" as const } : {}),
    });
  }
  if (input.kind === "deadline_fired") {
    if (!state.armedTimers.includes(input.timer)) return illegal(state, input);
    const removed = { ...state, armedTimers: state.armedTimers.filter((t) => t !== input.timer) };
    if (state.phase === "resolve_config")
      return finish(removed, "failed", input.at, budget, { timeoutReason: input.reason });
    if (state.phase === "queue_wait")
      return finish(removed, "failed", input.at, budget, { timeoutReason: "queue_timeout" });
    if (state.phase === "session_create" || state.phase === "extension_bind")
      return finish(removed, "timed_out", input.at, budget, { timeoutReason: input.reason }, [{ kind: "dispose" }]);
    if (state.phase === "abort_grace") {
      const status =
        state.diag.timeoutReason !== undefined || state.diag.stopCause === "timeout" ? "timed_out" : "aborted";
      return finish(removed, status, input.at, budget, { timeoutReason: input.reason }, [
        { kind: "request_abort" },
        { kind: "dispose" },
      ]);
    }
    if (state.phase === "retry_backoff" && input.timer === "idle") return { state, effects: [] };
    const entered = enter(removed, "stopping", "abort_grace", input.at, budget, {
      timeoutReason: input.reason,
      stopCause: "timeout",
    });
    const running = ["model_turn", "tool_exec", "retry_backoff", "compaction"].includes(state.phase);
    const controls = emit(entered.state, [
      { kind: "cancel_signal", reason: "timeout" },
      ...(running ? [{ kind: "soft_steer" as const, text: "wrap up now" }] : []),
    ]);
    return { state: controls.state, effects: [...entered.effects, ...controls.effects] };
  }
  if (input.kind === "escalation_done") {
    if (state.phase === "queue_wait") return illegal(state, input);
    const escalation = ["abort_grace", "reap", "settled"].includes(state.phase)
      ? [...state.diag.escalation, { level: input.level, at: input.at, ok: input.ok }]
      : state.diag.escalation;
    return { state: { ...state, diag: { ...state.diag, escalation } }, effects: [] };
  }
  if (input.kind === "reap_finished") {
    if (state.phase !== "abort_grace" && state.phase !== "reap") return illegal(state, input);
    return { state: { ...state, diag: { ...state.diag, orphaned: input.orphaned } }, effects: [] };
  }
  return illegal(state, input);
}

function handleEffectFailed(
  state: RunState,
  input: Extract<RunInput, { kind: "effect_failed" }>,
): { state: RunState; effects: readonly EffectEnvelope[] } {
  const isCritical = ["release_slot", "settle_waiters", "clear_timer", "persist_snapshot"].includes(input.effect);
  const isPersist = input.effect === "persist_snapshot";
  const retry = isPersist && state.persistRetryCount < 3;
  const degraded = {
    effect: input.effect,
    at: input.at,
    error: input.error.message,
    compensated: isCritical && (!isPersist || retry),
  };
  const diag = {
    ...state.diag,
    degraded: [...state.diag.degraded, degraded],
    ...(isPersist ? { persistStatus: retry ? ("retrying" as const) : ("degraded_final" as const) } : {}),
  };
  const effects: RunEffect[] =
    input.effect === "release_slot"
      ? [{ kind: "release_slot" }]
      : input.effect === "settle_waiters" && state.outcome
        ? [{ kind: "settle_waiters", outcome: state.outcome }]
        : input.effect === "clear_timer" && input.timer
          ? [{ kind: "clear_timer", timer: input.timer }]
          : retry && state.outcome
            ? [
                {
                  kind: "persist_snapshot",
                  snapshot: {
                    runId: state.runId,
                    generation: state.generation,
                    status: state.status as RunOutcome["status"],
                    phase: "settled",
                    deadlines: state.deadlines,
                    diag,
                    outcome: state.outcome,
                    updatedAt: input.at,
                  },
                },
              ]
            : [];
  // G5a (architecture 5.6.1 / 11): once persist_snapshot gives up for good
  // (degraded_final), the outcome itself must carry persistFailed so any
  // caller reading it later (query-service, delivery, /agent status) can see
  // the journal channel never confirmed landing, without re-deriving it from
  // diag.persistStatus every time.
  const outcome =
    isPersist && !retry && state.outcome ? { ...state.outcome, diag, persistFailed: true as const } : state.outcome;
  const next = {
    ...state,
    diag,
    ...(outcome ? { outcome } : {}),
    persistRetryCount: isPersist ? state.persistRetryCount + 1 : state.persistRetryCount,
  };
  return effects.length ? emit(next, effects) : { state: next, effects: [] };
}
