import { DEFAULT_BUDGET, dueAtFor } from "./deadline.js";
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
  ToolCallRecord,
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
  // Defense in depth (drivers already clamp at the boundary): a non-finite
  // field must never poison the lifetime accumulator with NaN.
  const add = (a: number, b: number) => (Number.isFinite(b) ? a + b : a);
  return {
    input: add(base.input, delta.input),
    output: add(base.output, delta.output),
    cacheRead: add(base.cacheRead, delta.cacheRead),
    cacheWrite: add(base.cacheWrite, delta.cacheWrite),
    costUsd: add(base.costUsd, delta.costUsd),
  };
}

/**
 * M-A: bounded ring cap for RunDiagnostics.toolHistory. Big enough to show a
 * meaningful trail in the UI, small enough that persist_snapshot stays cheap.
 */
export const TOOL_HISTORY_CAP = 30;

/**
 * Display-only cap for RunDiagnostics.thinkingText (the agent tree's `»`
 * thinking preview). Thinking streams can run to thousands of tokens; only
 * the freshest tail is signal, so keep the last THINKING_TEXT_CAP chars —
 * enough for lastTextLine to find a full line, small enough that
 * persist_snapshot stays cheap.
 */
export const THINKING_TEXT_CAP = 4000;

/** Append a thinking_delta to the capped tail (see THINKING_TEXT_CAP). */
function appendThinkingText(prev: string | undefined, delta: string): string {
  const next = (prev ?? "") + delta;
  return next.length > THINKING_TEXT_CAP ? next.slice(next.length - THINKING_TEXT_CAP) : next;
}

/**
 * Fold a text_delta/thinking_delta into a diag copy: answer text accumulates
 * into `text` (and clears the turn's thinking preview — the answer is the
 * fresher stream), thinking accumulates into the capped `thinkingText` tail.
 */
function streamPatch(diag: RunDiagnostics, e: { t: "text_delta" | "thinking_delta"; delta: string }): RunDiagnostics {
  const d = { ...diag };
  if (e.t === "text_delta") {
    d.text = (diag.text ?? "") + e.delta;
    delete d.thinkingText;
  } else {
    d.thinkingText = appendThinkingText(diag.thinkingText, e.delta);
  }
  return d;
}

/**
 * M-A: fold a tool_start/tool_end driver event into the diag's tool trail.
 * Runs for *every* observed tool event regardless of phase (parallel tool
 * calls can start while the run is already in tool_exec; the phase branches
 * below count them in pendingTools and stay in tool_exec until the last one
 * settles, while this patch keeps the per-call trail complete).
 */
function toolTrailPatch(
  diag: RunDiagnostics,
  e: Extract<RunInput, { kind: "session_event" }>["event"],
  at: number,
): Partial<RunDiagnostics> {
  if (e.t === "tool_start") {
    const record: ToolCallRecord = {
      name: e.toolName,
      toolCallId: e.toolCallId,
      startedAt: at,
      ...(e.argsPreview === undefined ? {} : { argsPreview: e.argsPreview }),
    };
    const history = [...(diag.toolHistory ?? []), record].slice(-TOOL_HISTORY_CAP);
    const counts = { ...(diag.toolCounts ?? {}) };
    counts[e.toolName] = (counts[e.toolName] ?? 0) + 1;
    return { toolHistory: history, toolCounts: counts };
  }
  if (e.t === "tool_end") {
    const history = diag.toolHistory;
    if (!history) return {};
    for (let i = history.length - 1; i >= 0; i--) {
      if (history[i]!.toolCallId === e.toolCallId && history[i]!.endedAt === undefined) {
        const next = [...history];
        next[i] = { ...next[i]!, endedAt: at, isError: e.isError };
        return { toolHistory: next };
      }
    }
    return {}; // record evicted by the ring cap — counts still hold the truth
  }
  return {};
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
  // M4：retry_backoff 不再特判——dueAtFor 已统一处理（内部走 idleDueAt），
  // 进入该相位时调用处已通过 base 把 lastEventAt 刷为当前时刻，两者等价。
  const phaseDue = phaseTimerId === undefined ? undefined : dueAtFor(phase, phaseDiag, budget);
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
    if (input.event.t === "text_delta" || input.event.t === "thinking_delta") {
      const patched = streamPatch(d, input.event);
      if (input.event.t === "text_delta" && state.outcome) {
        // streamPatch just accumulated the delta — text is definitely set.
        const text = patched.text!;
        return {
          state: { ...state, diag: patched, outcome: { ...state.outcome, text, diag: patched } },
          effects: [],
        };
      }
      return { state: { ...state, diag: patched }, effects: [] };
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
    // CC4/CP3: the absolute deadlineAt cap (threaded from SpawnRequest.deadlineAt
    // via RunInput.enqueued.deadlineCapAt, see service/request-threading.ts) may
    // already be expired by the time this run is actually enqueued (H2 extension
    // hooks can take seconds). Caught here, strictly before pool.acquire is ever
    // reached — this run never occupies a slot or creates a session.
    if (input.deadlineCapAt !== undefined && input.deadlineCapAt <= input.at)
      return finish(state, "failed", input.at, budget, {
        lastEventType: "config",
        error: { kind: "config", message: "deadlineAt already expired at enqueue", retryable: false },
      });
    const raw = input.budget.totalMs === 0 ? undefined : input.at + input.budget.totalMs;
    const cap = input.deadlineCapAt;
    // CC4/FF1: deadlineAt only ever tightens the run's deadline, never loosens it
    // — min() makes that automatic. Computed exactly once, right here (FF2: the
    // core B1 invariant — "algorithm decides once, never recomputes" — is
    // unaffected: what changed is *what* gets algorithm-decided, not *when*).
    const deadlineAt = cap === undefined ? raw : raw === undefined ? cap : Math.min(raw, cap);
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
      diag: {
        ...state.diag,
        enqueuedAt: input.at,
        ...(deadlineAt === undefined ? {} : { deadlineAt }),
        // M-A: display-only spawn metadata, set exactly once here.
        ...(input.meta?.model === undefined ? {} : { model: input.meta.model }),
        ...(input.meta?.label === undefined ? {} : { label: input.meta.label }),
        ...(input.meta?.agentType === undefined ? {} : { agentType: input.meta.agentType }),
      },
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
          // M-B2: the live session's actual model overrides spawn-time display
          // metadata (ground truth; also fills pi-default-model runs).
          ...(input.model === undefined ? {} : { model: input.model }),
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
      // turn_end drives the turns counter (G4 diagnostics + outcome.turns);
      // without this branch every run reported turns: 0.
      ...(e.t === "turn_end" ? { turns: state.diag.turns + 1 } : {}),
      // X9: threaded through every downstream branch below via `{...state.diag, ...base}`
      // so the accumulator is updated regardless of which phase/branch handles this event
      // (including the abort_grace/reap early-return branch immediately below).
      ...(usage === undefined ? {} : { usage }),
      // M-A: tool trail (toolHistory/toolCounts) — same threading rationale as usage.
      ...toolTrailPatch(state.diag, e, input.at),
    };
    if (state.phase === "abort_grace" || state.phase === "reap") {
      const diag = {
        ...(e.t === "text_delta" || e.t === "thinking_delta" ? streamPatch(state.diag, e) : state.diag),
        ...base,
      };
      return {
        state:
          state.outcome && diag.text !== undefined
            ? { ...state, diag, outcome: { ...state.outcome, text: diag.text, diag } }
            : { ...state, diag },
        effects: [],
      };
    }
    if (e.t === "text_delta" || e.t === "thinking_delta") {
      if (state.phase === "queue_wait") return illegal(state, input);
      return {
        state: { ...state, diag: { ...streamPatch(state.diag, e), ...base } },
        effects: [],
      };
    }
    if (e.t === "tool_start" && (state.phase === "model_turn" || state.phase === "prompt_dispatch"))
      return enter({ ...state, diag: { ...state.diag, ...base } }, "running", "tool_exec", input.at, budget, {
        currentTool: { name: e.toolName, toolCallId: e.toolCallId, startedAt: input.at },
        pendingTools: state.diag.pendingTools + 1,
      });
    if (e.t === "tool_start" && state.phase === "tool_exec") {
      // Parallel tool call (models routinely emit several per turn): stay in
      // tool_exec, count it, and surface the newest in-flight tool. Without
      // this branch the pendingTools count diverged and the first tool_end
      // dropped the phase back to model_turn while siblings still ran.
      return {
        state: {
          ...state,
          diag: {
            ...state.diag,
            ...base,
            pendingTools: state.diag.pendingTools + 1,
            currentTool: { name: e.toolName, toolCallId: e.toolCallId, startedAt: input.at },
          },
        },
        effects: [],
      };
    }
    if (e.t === "tool_end") {
      if (state.phase !== "tool_exec") return illegal(state, input);
      // Accept the end of ANY known in-flight call (parallel siblings), but
      // still reject unknown toolCallIds (state divergence / driver bug).
      const knownInFlight =
        state.diag.currentTool?.toolCallId === e.toolCallId ||
        (state.diag.toolHistory ?? []).some((r) => r.toolCallId === e.toolCallId && r.endedAt === undefined);
      if (!knownInFlight) return illegal(state, input);
      const remaining = Math.max(0, state.diag.pendingTools - 1);
      const nextDiag = { ...state.diag, ...base, pendingTools: remaining };
      if (remaining > 0) {
        // Sibling tool calls still in flight — stay in tool_exec (the tree
        // must keep showing 🔧 until the LAST one settles) and point
        // currentTool at a remaining in-flight call (base.toolHistory already
        // has this tool_end folded in by toolTrailPatch).
        const inflight = (nextDiag.toolHistory ?? []).filter((r) => r.endedAt === undefined);
        const last = inflight[inflight.length - 1];
        if (last) nextDiag.currentTool = { name: last.name, toolCallId: last.toolCallId, startedAt: last.startedAt };
        return { state: { ...state, diag: nextDiag }, effects: [] };
      }
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
      // M4：deadline_fired 先行进入 abort_grace 时已记录具体 timeoutReason（idle/
      // no_first_event/…），cancel 解除 guard 阻塞后带回来的 prompt_settled 不得把它
      // 抹成笼统的 "total"。
      ...(input.error?.kind === "timeout" ? { timeoutReason: state.diag.timeoutReason ?? ("total" as const) } : {}),
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
    // M4 前这里忽略 retry_backoff+idle（配合 dueAtFor 无 retry_backoff 分支的盲区）：
    // pi 自动重试一旦卡住（backoff 结束后迟迟不来 retry_end），run 会无界地挂到总预算。
    // 现在 dueAtFor 已为 retry_backoff 提供 idleDueAt 截止点，直接落通用路径。
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
