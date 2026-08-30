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
export type ErrorKind = "config" | "auth" | "startup_transient" | "model" | "timeout" | "aborted" | "internal";
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

export interface AgentTypeConfig {
  name: AgentTypeName;
  displayName?: string;
  description: string;
  systemPrompt: string;
  promptMode: "replace" | "append";
  tools?: string[];
  model?: { provider: string; id: string };
  thinkingLevel?: "off" | "low" | "medium" | "high";
  maxTurns?: number;
  color?: string;
  budgetOverride?: Partial<DeadlineBudget>;
  sourcePath?: string;
}
export interface SpawnRequest {
  type: AgentTypeName;
  prompt: string;
  label?: string;
  cwd?: string;
  modelOverride?: { provider: string; id: string };
  budgetOverride?: Partial<DeadlineBudget>;
  slotless?: boolean;
  parentRunId?: RunId;
  signal?: AbortSignal;
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
  | { t: "tool_start"; toolCallId: string; toolName: string }
  | { t: "tool_end"; toolCallId: string; toolName: string; isError: boolean }
  | { t: "tool_update"; toolCallId: string }
  | { t: "retry_start"; attempt: number; maxAttempts: number; delayMs: Millis }
  | { t: "retry_end"; success: boolean }
  | { t: "compaction_start"; reason: string }
  | { t: "compaction_end"; aborted: boolean }
  | { t: "settled" }
  | { t: "text_delta"; delta: string };
export interface RunOutcome {
  runId: RunId;
  status: Extract<RunStatus, "completed" | "failed" | "timed_out" | "aborted">;
  text?: string;
  error?: ErrorInfo;
  timeoutReason?: TimeoutReason;
  usage?: UsageDelta;
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
export interface DeliveryPayload {
  key: string;
  runId: RunId;
  generation: Generation;
  status: RunOutcome["status"];
  textPreview: string;
  diag: DiagSummary;
  createdAt: Millis;
  reconcileRound: number;
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
  | { kind: "enqueued"; at: Millis; budget: DeadlineBudget }
  | { kind: "slot_acquired"; at: Millis }
  | { kind: "slot_denied"; at: Millis; reason: "queue_timeout" | "aborted" }
  | { kind: "phase_entered"; at: Millis; phase: RunPhase }
  | { kind: "session_created"; at: Millis; sessionId: string }
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
