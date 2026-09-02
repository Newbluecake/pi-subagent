export type Millis = number;
export type RunId = string;
export type AgentTypeName = string;
export type Generation = number;
export type TimerId = string;

export type RunPhase =
  | "queue_wait"
  | "resolve_config"
  | "session_create"
  | "extension_bind"
  | "prompt_dispatch"
  | "model_turn"
  | "tool_exec"
  | "retry_backoff"
  | "compaction"
  | "abort_grace"
  | "reap"
  | "settled";
export type RunStatus =
  "queued" | "starting" | "running" | "stopping" | "completed" | "failed" | "timed_out" | "aborted";
export type TimeoutReason =
  | "queue_timeout"
  | "session_create"
  | "extension_bind"
  | "no_first_event"
  | "idle"
  | "compaction"
  | "total"
  | `tool:${string}`;
export type StopCause = "parent_abort" | "user_stop" | "timeout" | "shutdown" | "parent_gone";
export type ErrorKind =
  | "config"
  | "auth"
  | "startup_transient"
  | "model"
  | "timeout"
  | "aborted"
  | "internal"
  /** X10: run reached a terminal state without a schema-valid StructuredOutput submission. */
  | "schema";

/** X10: opaque JSON Schema object (subset validated by core/json-schema.ts). */
export type JsonSchema = Record<string, unknown>;
export interface ErrorInfo {
  kind: ErrorKind;
  message: string;
  stack?: string;
  retryable: boolean;
}

export interface DeadlineBudget {
  queueWaitMs: Millis;
  startupMs: Millis;
  bindMs: Millis;
  firstEventMs: Millis;
  idleMs: Millis;
  /** 单轮模型调用的硬上限（不论是否仍在产出 delta）；0 = 不限制，仅受 totalMs 约束。 */
  modelTurnMs: Millis;
  toolMs: Millis;
  compactionMs: Millis;
  totalMs: Millis;
  abortGraceMs: Millis;
  steerMs: Millis;
  reapMs: Millis;
  startupRetries: number;
  retrySlackMs: Millis;
}
export interface RunDeadlines {
  readonly enqueuedAt: Millis;
  readonly deadlineAt: Millis | undefined;
  readonly queueDeadlineAt: Millis | undefined;
}

/**
 * Thinking levels accepted by agent-type frontmatter (`thinking:`) and by the
 * per-spawn `SpawnRequest.thinkingOverride` / Agent-tool `thinking` parameter.
 * pi itself knows more levels (minimal/xhigh) but the subagent surface
 * deliberately exposes only these four (config/agent-types.ts).
 */
export const THINKING_LEVELS = ["off", "low", "medium", "high"] as const;
export type ThinkingLevel = (typeof THINKING_LEVELS)[number];

export interface AgentTypeConfig {
  name: AgentTypeName;
  displayName?: string;
  description: string;
  systemPrompt: string;
  promptMode: "replace" | "append";
  tools?: string[];
  model?: { provider: string; id: string };
  /**
   * Raw frontmatter `model:` value when it is NOT a strict `provider/id`
   * pair — a fuzzy hint (bare id or substring alias, e.g. "sonnet"),
   * resolved against pi's available models at spawn admission
   * (src/config/model-hint.ts). `model` (strict pair) and `modelHint` are
   * mutually exclusive per type; a strict pair never needs resolving.
   */
  modelHint?: string;
  thinkingLevel?: ThinkingLevel;
  maxTurns?: number;
  color?: string;
  budgetOverride?: Partial<DeadlineBudget>;
  sourcePath?: string;
  /**
   * X3: agent type names this type is allowed to spawn as nested subagents.
   * Undefined/empty = this type cannot nest (no Agent tool is injected into
   * its own session). This is a declaration on the *parent* type, distinct
   * from `tools` (frontmatter `tools` still gates the host's own top-level
   * Agent tool visibility if used there; `canSpawn` gates the *injected*
   * nested Agent tool's subagent_type whitelist and, authoritatively, the
   * spawn-service-level depth/whitelist check — architecture §7.2 X3).
   */
  canSpawn?: string[];
}
export interface SpawnRequest {
  /** Assigned run identifier, used by lifecycle extensions for resource names. */
  runId?: RunId;
  type: AgentTypeName;
  prompt: string;
  label?: string;
  cwd?: string;
  modelOverride?: { provider: string; id: string };
  /**
   * Free-form Agent tool `model` param value that is not a strict
   * `provider/id` pair — resolved as a fuzzy hint at spawn admission.
   * Takes precedence over the agent type's `modelHint`, loses to a strict
   * `modelOverride`/`config.model` pair.
   */
  modelHintOverride?: string;
  /**
   * Per-spawn thinking-level override (Agent tool `thinking` param): takes
   * precedence over the agent type's configured `thinkingLevel` when set;
   * unset = the type's frontmatter `thinking:` (or pi's global default when
   * the type defines none). Merged into `sessionSpec.thinkingLevel` by the
   * runtime adapter, same pattern as `modelOverride`.
   */
  thinkingOverride?: ThinkingLevel;
  budgetOverride?: Partial<DeadlineBudget>;
  slotless?: boolean;
  parentRunId?: RunId;
  /** Request an isolated git worktree for this run. */
  isolation?: "worktree";
  signal?: AbortSignal;
  /** Resume a terminal run by run id or directly by its persisted session file. */
  resumeFrom?: string;
  /**
   * X10: require the subagent to submit its final result through an
   * injected StructuredOutput tool matching this JSON Schema. Validated both
   * at submission time (child-side, inside the injected tool) and again
   * independently against the raw captured payload once the run reaches a
   * terminal state (host-side) — architecture §7.2 X10 "双重校验".
   */
  schema?: JsonSchema;
  /**
   * CC4: absolute wall-clock upper bound (epoch millis) on this run's
   * deadline. Semantics:
   *   ① the run's deadlines.deadlineAt = min(enqueuedAt + budget.totalMs, deadlineAt)
   *   ② only tightens, never loosens (min() makes this automatic)
   *   ③ computed once at enqueue time, then frozen forever (core invariant B1)
   *   ④ if already expired at enqueue time -> failed(config, "deadlineAt already expired"),
   *      without acquiring a slot or creating a session (see CP1/CP2/CP3)
   *   ⑤ must be threaded through every hop explicitly (service/request-threading.ts)
   *      or it is silently dropped — this repo has prior art for that failure mode
   *      (see ResolvedSpawnRequest.parentRunId below).
   */
  deadlineAt?: Millis;
}
/**
 * M-A (presentation): one observed tool call of a run, kept in
 * RunDiagnostics.toolHistory (bounded ring, TOOL_HISTORY_CAP) so both the
 * foreground Agent tool card and the fleet/agent-tree widget can render a
 * live execution trail without re-reading the child session file.
 */
export interface ToolCallRecord {
  name: string;
  toolCallId: string;
  startedAt: Millis;
  endedAt?: Millis;
  isError?: boolean;
  /** Truncated single-line preview of the tool arguments (display only). */
  argsPreview?: string;
}

/** M-A (presentation): display-only spawn metadata threaded into diag at enqueue time. */
export interface RunDisplayMeta {
  model?: { provider: string; id: string };
  label?: string;
  agentType?: string;
}

export interface UsageDelta {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  costUsd: number;
}
export type DriverEvent =
  | { t: "turn_start" }
  | { t: "turn_end"; toolResults: number }
  | { t: "message_end"; usage?: UsageDelta }
  | { t: "tool_start"; toolCallId: string; toolName: string; argsPreview?: string }
  | { t: "tool_end"; toolCallId: string; toolName: string; isError: boolean }
  | { t: "tool_update"; toolCallId: string }
  | { t: "retry_start"; attempt: number; maxAttempts: number; delayMs: Millis }
  | { t: "retry_end"; success: boolean }
  | { t: "compaction_start"; reason: string }
  | { t: "compaction_end"; aborted: boolean }
  | { t: "settled" }
  | { t: "text_delta"; delta: string }
  | { t: "thinking_delta"; delta: string };
export interface RunOutcome {
  runId: RunId;
  status: Extract<RunStatus, "completed" | "failed" | "timed_out" | "aborted">;
  text?: string;
  error?: ErrorInfo;
  timeoutReason?: TimeoutReason;
  usage?: UsageDelta;
  /** X10: the schema-validated payload submitted via StructuredOutput, once host-side re-validation has also passed. Absent when no schema was requested, or when the run failed(schema). */
  structuredResult?: unknown;
  turns: number;
  durationMs: Millis;
  diag: RunDiagnostics;
  /**
   * G5a: set when persist_snapshot exhausted its durable-retry budget
   * (diag.persistStatus === "degraded_final"). The terminal record itself is
   * never lost (see the fallback JSONL path), but callers must be able to see
   * that the append-entry journal channel did not confirm it landed.
   */
  persistFailed?: boolean;
}
export interface RunDiagnostics {
  createdAt: Millis;
  /** Display-only timestamp when a foreground call was moved to background. */
  autoBackgroundedAt?: Millis;
  enqueuedAt?: Millis;
  startedAt?: Millis;
  promptDispatchedAt?: Millis;
  settledAt?: Millis;
  phase: RunPhase;
  phaseEnteredAt: Millis;
  lastEventAt?: Millis;
  lastEventType?: string;
  currentTool?: { name: string; toolCallId: string; startedAt: Millis };
  pendingTools: number;
  turns: number;
  retry?: { attempt: number; maxAttempts: number; delayMs: Millis; startedAt: Millis };
  compacting?: { reason: string; startedAt: Millis };
  /**
   * X9: lifetime accumulator, summed across every `message_end` event seen
   * for this run (including ones observed after the run reached a terminal
   * status, and across compaction — each message_end usage delta is summed
   * exactly once, so it is unaffected by the session's own stats resetting
   * post-compaction). Not derived from SessionHandle.getUsage()/session
   * stats by design (architecture §7.2 X9).
   */
  usage?: UsageDelta;
  /** M-A: display-only spawn metadata (model/label/type), set once at enqueue. */
  model?: { provider: string; id: string };
  label?: string;
  agentType?: string;
  /** M-A: bounded ring of observed tool calls (cap: state-machine TOOL_HISTORY_CAP). */
  toolHistory?: ToolCallRecord[];
  /** M-A: lifetime per-tool-name counters — unaffected by toolHistory ring eviction. */
  toolCounts?: Record<string, number>;
  stopRequestedAt?: Millis;
  stopCause?: StopCause;
  timeoutReason?: TimeoutReason;
  error?: ErrorInfo;
  escalation: Array<{ level: "L0" | "L1" | "L2" | "L3" | "L3p" | "L4"; at: Millis; ok: boolean; detail?: string }>;
  orphaned: boolean;
  generation: number;
  deadlineAt?: Millis;
  degraded: Array<{ effect: RunEffect["kind"]; at: Millis; error: string; compensated: boolean }>;
  persistStatus?: "verifying" | "retrying" | "persisted" | "degraded_final";
  staleInputs: number;
  unkillable: Array<{ kind: string; id: string }>;
  deliveryKey?: string;
  lastWarn?: string;
  text?: string;
  /**
   * Display-only tail of the model's in-progress thinking (reasoning) stream
   * for the current turn — the agent tree's `»` preview line. Accumulated
   * from thinking_delta events, hard-capped (state-machine THINKING_TEXT_CAP),
   * and cleared when the turn's answer text starts streaming (text_delta) so
   * the preview falls back to the answer. Never fed back to a model.
   */
  thinkingText?: string;
  /** Persisted pi session used by X2 resume. */
  sessionFile?: string;
}
export interface DiagSummary {
  phase: RunPhase;
  status: RunStatus;
  timeoutReason?: TimeoutReason;
  pendingTools: number;
  staleInputs: number;
  degraded: number;
}
export interface LifecycleEvent {
  runId: RunId;
  generation: Generation;
  status: RunStatus;
  at: Millis;
}
export type SendResult = "sent" | "buffered";

export interface DeliveryPayload {
  key: string;
  runId: RunId;
  generation: Generation;
  status: RunOutcome["status"];
  textPreview: string;
  diag: DiagSummary;
  createdAt: Millis;
  reconcileRound: number;
  attempts?: number;
  finalized?: boolean;
  degradedReason?: "pre-finalize" | "policy-error";
  structuredPreview?: string;
  failReason?: string;
  label?: string;
}
export interface RunSnapshot {
  runId: RunId;
  generation: Generation;
  status: RunStatus;
  phase: RunPhase;
  deadlines: RunDeadlines;
  diag: RunDiagnostics;
  outcome?: RunOutcome;
  updatedAt: Millis;
  /** Set when the run was spawned as a nested/child run (X3 slotless nesting). */
  parentRunId?: RunId;
}

export type RunInput =
  | { kind: "enqueued"; at: Millis; budget: DeadlineBudget; deadlineCapAt?: Millis; meta?: RunDisplayMeta }
  | { kind: "slot_acquired"; at: Millis }
  | { kind: "slot_denied"; at: Millis; reason: "queue_timeout" | "aborted" }
  | { kind: "phase_entered"; at: Millis; phase: RunPhase }
  | {
      kind: "session_created";
      at: Millis;
      sessionId: string;
      sessionFile?: string;
      model?: { provider: string; id: string };
    }
  | {
      kind: "startup_failed";
      at: Millis;
      phase: Extract<RunPhase, "resolve_config" | "session_create" | "extension_bind" | "prompt_dispatch">;
      error: ErrorInfo;
    }
  | { kind: "session_event"; at: Millis; event: DriverEvent }
  | { kind: "prompt_settled"; at: Millis; error?: ErrorInfo; text?: string }
  | { kind: "deadline_fired"; at: Millis; timer: TimerId; reason: TimeoutReason }
  | { kind: "stop_requested"; at: Millis; cause: StopCause }
  | { kind: "escalation_done"; at: Millis; level: "L0" | "L1" | "L2" | "L3" | "L3p"; ok: boolean }
  | { kind: "reap_finished"; at: Millis; disposed: boolean; orphaned: boolean }
  | { kind: "effect_failed"; at: Millis; effect: RunEffect["kind"]; error: ErrorInfo; timer?: TimerId };
export interface StampedInput {
  readonly generation: number;
  readonly input: RunInput;
}
export type RunEffect =
  | { kind: "arm_timer"; timer: TimerId; dueAt: Millis }
  | { kind: "clear_timer"; timer: TimerId }
  | { kind: "cancel_signal"; reason: string }
  | { kind: "soft_steer"; text: string }
  | { kind: "request_abort" }
  | { kind: "dispose" }
  | { kind: "kill_handles" }
  | { kind: "register_orphan"; unkillable: ReadonlyArray<{ kind: string; id: string }> }
  | { kind: "release_slot" }
  | { kind: "settle_waiters"; outcome: RunOutcome }
  | { kind: "emit_lifecycle"; event: LifecycleEvent }
  | { kind: "enqueue_delivery"; payload: DeliveryPayload }
  | { kind: "persist_snapshot"; snapshot: RunSnapshot };
export interface EffectEnvelope {
  readonly effectId: string;
  readonly effect: RunEffect;
  readonly criticality: "critical" | "best_effort";
}
export interface RunState {
  readonly runId: RunId;
  readonly generation: number;
  readonly status: RunStatus;
  readonly phase: RunPhase;
  readonly deadlines: RunDeadlines;
  readonly diag: RunDiagnostics;
  readonly armedTimers: readonly TimerId[];
  readonly slotHeld: boolean;
  readonly sessionId?: string;
  readonly outcome?: RunOutcome;
  readonly effectSeq: number;
  readonly persistRetryCount: number;
  readonly parentRunId?: RunId;
}

// ── Canonical shapes shared across runtime/service adapters (single source of
// truth; downstream modules import these instead of redeclaring them) ──

/**
 * Input to SessionDriver.create(): the minimal, pi-shaped session
 * configuration. This is the *execution-layer* spec (what the driver needs to
 * start a session) — distinct from the service-layer RunnerSpec
 * (service/ports.ts), which additionally carries the resolved AgentTypeConfig,
 * the original SpawnRequest and the DeadlineBudget.
 */
export interface SessionSpec {
  cwd?: string;
  agentDir?: string;
  model?: unknown;
  thinkingLevel?: string;
  tools?: string[];
  excludeTools?: string[];
  noTools?: "all" | "builtin";
  prompt?: string;
  /** Whether a fresh session must be persisted for later resume. */
  persist?: boolean;
  /** Existing session file to open for X2 resume. */
  resumeFrom?: string;
  /**
   * Additional tool definitions to register for this session (pi's
   * `createAgentSession({ customTools })`, see 2.9). Typed `unknown[]` here
   * (not `ToolDefinition[]`) to keep core/types.ts free of
   * `@earendil-works/*` imports (I1); the driver casts at the point of use
   * (matches the existing `model?: unknown` convention on this interface).
   * X3 (nested Agent tool) and X10 (StructuredOutput tool) are injected this
   * way by service/runtime-adapter.ts before H2 extensions run.
   */
  customTools?: unknown[];
}

/** A resource an injected tool holds that reaper can synchronously, idempotently kill (2.2.2). */
export interface KillableHandle {
  readonly kind: "process" | "socket" | "fd" | "timer";
  readonly id: string;
  kill(): void;
}

/** L4 registry entry for a run whose physical resources could not be fully reclaimed (4.3.2). */
export interface OrphanRecord {
  runId: RunId;
  sessionId?: string;
  phase: RunPhase;
  reason: TimeoutReason | StopCause;
  lastEventAt?: Millis;
  registeredAt: Millis;
  unkillable: Array<{ kind: string; id: string }>;
  lateArrival: boolean;
}

/**
 * The four documented extension hooks (architecture §7.1). Only-read observer
 * (onLifecycle/onDelivery) and bounded pre/post hooks (resolveSessionSpec/
 * beforeReap). Not deeply wired in M1; the index.ts assembly forwards
 * onLifecycle today, the rest are reserved extension points for later
 * milestones (X1/X3/X9 etc.).
 */
export interface SubagentExtensionPoints {
  onLifecycle?(e: LifecycleEvent): void;
  resolveSessionSpec?(spec: SessionSpec, req: SpawnRequest): Promise<SessionSpec> | SessionSpec;
  beforeReap?(outcome: RunOutcome, ctx: { cwd: string; deadlineMs: Millis }): Promise<void> | void;
  onDelivery?(p: DeliveryPayload, state: string): void;
}
