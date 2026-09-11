export type Millis = number;
export type RunId = string;
export type AgentTypeName = string;
export type Generation = number;
export type TimerId = string;

import type { CanMessage } from "./message.js";

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
  /** 总预算。恒 > 0：非法值（≤ 0 / 非有限数）由 mergeBudget 逐层丢弃并回退下一层（D-11）。 */
  totalMs: Millis;
  abortGraceMs: Millis;
  steerMs: Millis;
  reapMs: Millis;
  startupRetries: number;
  retrySlackMs: Millis;
  /** 总预算到点后的续跑宽限；0 = 关闭宽限（到点即按原逻辑终止）。 */
  totalGraceMs: Millis;
  /** 单个 run 允许的 deadline 延长次数上限；0 = 禁止延长（同时也禁用宽限：graceWindow 经 extendability 判额度）。 */
  maxExtensions: number;
  /** 硬天花板倍数：hardDeadlineAt = enqueuedAt + ceil(totalMs * maxTotalFactor)（≥ 1）。显式预算 run 被 applyBudgetPolicy 钳为 1。 */
  maxTotalFactor: number;
}
export interface RunDeadlines {
  readonly enqueuedAt: Millis;
  /** 当前生效的软截止。**只可向后移动**，且只经由 deadline_extended，且 ≤ hardDeadlineAt。 */
  readonly deadlineAt: Millis | undefined;
  readonly queueDeadlineAt: Millis | undefined;
  /** 续跑宽限截止；undefined = 不在宽限中。进宽限时置位，被延长时清除；**终态时保留作审计痕迹**（BL-5）。 */
  readonly graceUntil?: Millis;
  /**
   * 绝对硬天花板：enqueue 时算一次、永久冻结（原 deadlineAt 的 B1 不变量迁移至此）。
   * = min(enqueuedAt + ceil(totalMs * maxTotalFactor), SpawnRequest.deadlineAt ?? ∞)
   * 配置层已禁止 totalMs ≤ 0（D-11），故正常路径下必有值；undefined 分支仅为防御（直接喂 reducer 的测试输入）。
   */
  readonly hardDeadlineAt?: Millis;
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
  /** Frontmatter `can_message`: relations this run may address through fabric. */
  canMessage?: CanMessage[];
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
  /**
   * Per-spawn budget override. `totalMs` 有值 ⇒ 该 run 为显式预算 run：
   * spawn-service 用 applyBudgetPolicy 钳 maxTotalFactor = 1（硬顶，无宽限无延长）。
   */
  budgetOverride?: Partial<DeadlineBudget>;
  slotless?: boolean;
  parentRunId?: RunId;
  /** Caller will synchronously acknowledge the terminal outcome. */
  expectAck?: boolean;
  /**
   * Request an isolated git worktree for this run. Created from the current
   * HEAD (uncommitted main-checkout changes are not visible); on reap all
   * changes are committed to a `pi-agent-<runId>` branch and the worktree is
   * removed. Fails as `failed(config)` with no fallback when unavailable.
   */
  isolation?: "worktree";
  signal?: AbortSignal;
  /**
   * When true, the external `signal` only takes effect during spawn
   * admission (the existing `external?.aborted` immediate-cancel check in
   * createCancelHandle is unaffected); once the run starts, the runner
   * detaches the external listener so an abort of the caller's turn (Esc /
   * compact_context / compact-hint forced compaction) no longer cancels
   * this run. Only for fire-and-forget background spawns — foreground
   * spawnAndWait keeps full-turn linkage on purpose (Esc killing a
   * foreground run is a feature). Cancellation paths that go through
   * activeCancels (abort_subagent, watchdog timeout, ...) are unaffected
   * because detach only removes the external listener.
   */
  detachSignalOnStart?: boolean;
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
   *   ③ B1 "computed once at enqueue, then frozen forever" now protects
   *      deadlines.hardDeadlineAt = min(enqueuedAt + ceil(totalMs * maxTotalFactor), deadlineAt);
   *      deadlineAt itself is the initial soft cap — it may only move LATER,
   *      only via deadline_extended, and never beyond hardDeadlineAt
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
  /** Truncated dispatch prompt for agent-tree previews and /agent status. */
  taskPrompt?: string;
}

export interface UsageDelta {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  costUsd: number;
}
export interface ContextUsageInfo {
  tokens: number | null;
  contextWindow: number;
  percent: number | null;
}
export type DriverEvent =
  | { t: "turn_start" }
  | { t: "turn_end"; toolResults: number }
  | { t: "message_end"; usage?: UsageDelta }
  | { t: "context_usage"; usage: ContextUsageInfo }
  | { t: "tool_start"; toolCallId: string; toolName: string; argsPreview?: string }
  | { t: "tool_end"; toolCallId: string; toolName: string; isError: boolean }
  | { t: "tool_update"; toolCallId: string }
  | { t: "retry_start"; attempt: number; maxAttempts: number; delayMs: Millis }
  | { t: "retry_end"; success: boolean }
  | { t: "compaction_start"; reason: string }
  | { t: "compaction_end"; aborted: boolean }
  | { t: "settled" }
  | { t: "text_delta"; delta: string }
  | { t: "thinking_delta"; delta: string }
  /** set_model: the live session's model was switched mid-run (display-only diag patch; see state-machine.ts reduce's early-return branch). */
  | { t: "model_changed"; model: { provider: string; id: string } };
/**
 * set_model switch result union (docs/dev/set-model/set-model-plan.md §4.1).
 * The runner returns a reason union instead of throwing (unlike steer) so
 * "unknown_model" stays distinguishable from "the session refused" — the
 * tool turns the two into different, self-correcting messages (§6).
 * Defined here (not in runtime/runner.ts) because core has no pi imports
 * (I1) and runner / ports / query-service / the tool layer all share it.
 */
export type SetModelOutcome =
  | { ok: true; model: { provider: string; id: string }; thinking?: string }
  | { ok: false; reason: "not_running" }
  /** driver/handle does not expose the set_model capability. */
  | { ok: false; reason: "unsupported" }
  /** Not in pi's model registry / no auth configured for the provider. */
  | { ok: false; reason: "unknown_model"; detail: string }
  | { ok: false; reason: "timeout" }
  /** pi refused the switch (e.g. no API key for the provider). */
  | { ok: false; reason: "rejected"; detail: string };

/** v1 只有工具一个来源（D-13）；预留联合类型扩展位。 */
export type ExtendSource = "tool";

/** 送往宿主通知层的纯数据；core 不做任何文案格式化（I1：core 无 pi 依赖）。 */
export interface DeadlineNotice {
  kind: "grace" | "extended";
  runId: RunId;
  generation: Generation;
  at: Millis;
  phase: RunPhase;
  label?: string;
  agentType?: string;
  taskPreview?: string;
  /** 变更后的软截止。 */
  deadlineAt: Millis;
  /** kind === "grace" 时必有：本次宽限的截止时刻。 */
  graceUntil?: Millis;
  hardDeadlineAt: Millis;
  extensionsUsed: number;
  maxExtensions: number;
  /** kind === "grace" 时必有：文案里“可直接抄”的建议值 = min(totalMs, headroom)，core 一次算好（毫秒；文案层换成秒）。 */
  suggestedExtendMs?: Millis;
  /** kind === "extended" 时必有。 */
  requestedMs?: Millis;
  grantedMs?: Millis;
  source?: ExtendSource;
}

/** 与 SetModelOutcome 同置（既有先例）：给工具层生成自纠错文案。 */
export type ExtendOutcome =
  | {
      ok: true;
      runId: RunId;
      previousDeadlineAt: Millis;
      deadlineAt: Millis;
      requestedMs: Millis;
      grantedMs: Millis;
      /** grantedMs < requestedMs（被硬天花板夹过）。 */
      clamped: boolean;
      extensionsUsed: number;
      extensionsRemaining: number;
      hardDeadlineAt: Millis;
      /** 本次延长把 run 从续跑宽限中救了出来。 */
      rescuedFromGrace: boolean;
    }
  | {
      ok: false;
      reason:
        | "unknown_run"
        | "already_terminal"
        | "stopping"
        | "not_started" // queue_wait / resolve_config / session_create / extension_bind（D-14）
        | "uncapped" // 防御性：deadlineAt/hardDeadlineAt 缺席（配置层已禁止 totalMs ≤ 0，见 D-11）
        | "limit_reached"
        | "no_headroom" // 含 D-10 显式预算 run（H = deadlineAt）
        | "unsupported";
      detail?: string;
    };
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
  /** Best-effort live context snapshot; trailing events after terminal only update memory and are not persisted again. */
  contextUsage?: ContextUsageInfo;
  /** M-A: display-only spawn metadata (model/label/type), set once at enqueue. */
  model?: { provider: string; id: string };
  label?: string;
  agentType?: string;
  /** Truncated dispatch prompt for agent-tree pending-row previews and /agent status. */
  taskPrompt?: string;
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
  /** hardDeadlineAt 的展示镜像（与 diag.deadlineAt 同款），enqueue 时写一次；spawn-service 终态重建从此处恢复（BL-5）。 */
  hardDeadlineAt?: Millis;
  /** 超时宽限/延长的审计记录；从未发生过时整个字段缺席。 */
  overtime?: {
    /** 进入过几次续跑宽限。 */
    graces: number;
    /** 当前（或终态时最后一次）宽限窗口；被延长救出时删除。终态快照保留它 = 审计痕迹（BL-5）。 */
    grace?: { startedAt: Millis; until: Millis };
    /** 已批准的延长次数。 */
    extensions: number;
    /** 累计实际批准的延长毫秒（可能小于请求量，被天花板夹过）。 */
    grantedMs: Millis;
    /** 最近一次延长的 reason 参数（展示/审计用，截断 200 字符）。 */
    lastReason?: string;
    /** 最近一次延长的来源（v1 只有 "tool"，D-13）。 */
    lastSource?: ExtendSource;
  };
  degraded: Array<{ effect: RunEffect["kind"]; at: Millis; error: string; compensated: boolean }>;
  persistStatus?: "verifying" | "retrying" | "persisted" | "degraded_final";
  staleInputs: number;
  unkillable: Array<{ kind: string; id: string }>;
  deliveryKey?: string;
  lastWarn?: string;
  /**
   * During execution, the text_delta stream preview buffer. On normal
   * prompt_settled, finalText replaces it and sets textFinal; non-normal
   * terminal states retain the accumulated partial output.
   */
  text?: string;
  /** Normal completion has installed the authoritative final assistant text. */
  textFinal?: true;
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
  | {
      kind: "deadline_extended";
      at: Millis;
      /** 请求追加的毫秒数（叠加在 max(at, deadlineAt) 之上）；由 reducer 负责夹紧。工具层已把 extend_s × 1000。 */
      extendMs: Millis;
      source: ExtendSource;
      reason?: string;
    }
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
  | { kind: "notify_deadline"; notice: DeadlineNotice }
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
