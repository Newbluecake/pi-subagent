import type { Millis, RunId } from "../core/types.js";
import type { RunawayPolicy } from "../config/settings.js";

/**
 * M3.1 (workflow design §3.1/§3.2): shared types for the isolation shell.
 * Deliberately narrow — host call (`agent()`/`parallel()`/…), the reduce-based
 * workflow state machine, journal/replay and abort propagation are all out of
 * scope until M3.2/M3.3/M3.5. This file only carries what `worker-source.ts`,
 * `lifecycle.ts`, `runaway.ts` and `orchestrator.ts` need to boot a worker,
 * run a script that can only `log`/`return`, and settle to a bounded outcome.
 *
 * WI2 (§3.1): zero `Runner`/`SessionDriver`/`SlotPool` imports anywhere under
 * `src/workflow/**` — this module (like its siblings) only reaches into
 * `core/` and `config/settings.ts` for shared primitives.
 */

export type WorkflowId = string;

/**
 * M3.2 (workflow design §3.6): one `agent()`/`gate()` host call. In M3.2
 * there is no journal/replay (M3.5) and no reduce-based `CallPhase` state
 * machine wired to `QueryService` (M3.3), so `CallId` is just the RPC
 * envelope id the worker minted for the call — reusing it (instead of a
 * second identifier scheme) keeps `CallRegistry` trivially correlatable
 * with the wire protocol in worker-source.ts/host.ts.
 */
export type CallId = string;

/**
 * §3.6 `CallPhase`, M3.2 slice: `runner_startup`/`running` are collapsed
 * into a single observable `"running"` phase (CR8 in the full design wants
 * phase transitions driven only by `QueryService`/H1 lifecycle events; that
 * plumbing is M3.3). The A2 bounded-retry cancel loop (§3.6 "A2 窗口的处置")
 * does not actually need to distinguish `runner_startup` from `running` —
 * both retry `SpawnService.abort(runId)` identically — so this is a
 * documented simplification, not a silent one.
 */
export type CallPhase = "admission" | "pre_runner" | "running" | "settled";

export interface CallCancelIntent {
  readonly cause: string;
  readonly at: Millis;
  attempts: number;
  lastAttemptAt: Millis;
}

export interface CallState {
  readonly callId: CallId;
  readonly submittedAt: Millis;
  phase: CallPhase;
  runId?: RunId;
  settledAt?: Millis;
  cancelIntent?: CallCancelIntent;
}

/** §3.6: `cancel()`'s honest, non-lying report of what actually happened (CR6). */
export type CallCancelEffect = "withheld" | "retrying" | "stopped" | "already_settled" | "unknown";

/** §3.3 `WorkflowChildSummary`, M3.2 slice: no `taskKey`/`occurrence`/`phaseId`/`source` yet (those need journal/phase tracking, M3.4/M3.5) beyond a fixed `"live"` (no replay exists in M3.2). */
export interface WorkflowChildSummary {
  readonly callId: CallId;
  readonly runId?: RunId;
  readonly label?: string;
  readonly source: "live";
  readonly status: "completed" | "failed" | "timed_out" | "aborted" | "withheld" | "running" | "stopping";
  readonly durationMs: Millis;
  readonly textPreview?: string;
}

/** §2.3.1: the worker's terminated-after state machine, S1 (spawning/ready) through S8 (orphan probe). */
export type WorkerLifecycle = "spawning" | "ready" | "closing" | "detached" | "terminated" | "orphaned";

export interface ScriptMeta {
  readonly name: string;
  readonly description: string;
  readonly phases?: readonly { readonly title: string }[];
}

/** §3.2: why a workflow run stopped (M3.1 subset — no child/abort causes yet, those land in M3.3). */
export type WorkflowStopCause = "user_stop" | "timeout" | "script_error" | "worker_died" | "runaway" | "shutdown";

/** §3.2: which absolute/relative deadline fired (M3.1 subset of WT1–WT19). */
export type WorkflowTimeoutReason =
  "script_load" | "worker_boot" | "script_slice" | "heartbeat_stall" | "workflow_total" | "terminate_confirm";

export type WorkflowTerminalStatus = "completed" | "failed" | "timed_out" | "aborted";

export interface WorkflowHeartbeatDiag {
  readonly seq: number;
  readonly observedAt: Millis;
  readonly stalledMs: Millis;
}

export interface WorkflowDiagnostics {
  readonly createdAt: Millis;
  readonly startedAt?: Millis;
  readonly settledAt?: Millis;
  readonly deadlineAt?: Millis;
  readonly heartbeat: WorkflowHeartbeatDiag;
  readonly logLines: number;
  readonly orphanWorker?: { readonly threadId?: number; readonly reason: string; readonly at: Millis };
}

/**
 * §3.3 (M3.1 slice): `WorkflowOutcome` without `children`/`replay`/`usage` —
 * those require host call (M3.2) and journal (M3.5). `pendingReconcile` is
 * always `false` in M3.1: there is nothing to reconcile because no child runs
 * exist yet.
 */
export interface WorkflowOutcome {
  readonly workflowId: WorkflowId;
  readonly status: WorkflowTerminalStatus;
  readonly pendingReconcile: false;
  readonly result?: unknown;
  readonly error?: { readonly message: string; readonly stack?: string };
  readonly timeoutReason?: WorkflowTimeoutReason;
  readonly stopCause?: WorkflowStopCause;
  readonly durationMs: Millis;
  readonly diag: WorkflowDiagnostics;
  /**
   * M3.2 (§3.3, slice): every `agent()` call submitted during this run, in
   * submission order (stable, assertable — mirrors the full design's
   * `WorkflowChildSummary[]`). Always `[]` for scripts that never call
   * `agent()`. `pendingReconcile` stays permanently `false` in M3.2 (no
   * abort/reconcile pipeline yet, M3.3) — by the time `run()` resolves, the
   * host's own accounting has every submitted call in a terminal phase
   * (settled or withheld), because `terminate()`'s S4 (host.ts) rejects
   * whatever is still pending before the orchestrator ever calls `settle()`.
   */
  readonly children: readonly WorkflowChildSummary[];
}

/** §2.3/§4.1 WT2/WT3/WT9/WT11: the M3.1 slice of `WorkflowBudget` actually consumed by the isolation shell. */
export interface WorkflowRunBudget {
  readonly scriptLoadMs: Millis;
  readonly scriptSliceMs: Millis;
  readonly workerBootMs: Millis;
  readonly heartbeatMs: Millis;
  readonly heartbeatStallMs: Millis;
  readonly terminateConfirmMs: Millis;
  readonly workflowTotalMs: Millis;
  readonly runawayPolicy: RunawayPolicy;
  readonly maxOldGenerationSizeMb?: number;
  readonly maxYoungGenerationSizeMb?: number;
  /** M3.2 WT4: per-host-call (non-`agent`-settle, non-`gate`) double-sided timeout (HR1+HR2). Optional — defaults applied by orchestrator.ts/host.ts so M3.1-era budgets (scripts that never call `agent()`/`gate()`) keep compiling and behaving unchanged. */
  readonly hostCallMs?: Millis;
  /** M3.2 WT6: `gate()` shell command upper bound (`pi.exec`-equivalent timeout + host-side `withDeadline`). Optional, see `hostCallMs`. */
  readonly gateMs?: Millis;
  /** M3.2 §5.3: local concurrency gate on top of the core `SlotPool` (D-W3) — a workflow-scoped, not global, cap. Optional, see `hostCallMs`. */
  readonly maxParallel?: number;
  /** M3.2: hard cap on `agent()` calls per workflow run (anti spawn-bomb). Optional, see `hostCallMs`. */
  readonly maxChildren?: number;
  /** M3.2: `parallel()`/`pipeline()` item cap. Optional, see `hostCallMs`. */
  readonly maxBatchItems?: number;
  /** §4.4.3 BW4–BW6: how a child's absolute deadline is derived from the workflow's remaining budget. Optional, see `hostCallMs`. */
  readonly childBudgetPolicy?: "inherit_remaining" | "fixed" | "fraction";
  readonly childBudgetFraction?: number;
  readonly childTotalMs?: Millis;
}

/** §3.5: what `WorkerHost.boot()` needs to start the worker thread and its sandboxed script. */
export interface WorkerHostInit {
  readonly scriptSource: string;
  readonly scriptSliceMs: Millis;
  readonly heartbeatMs: Millis;
  /** WT3: bounds the wait for the worker thread's native 'online' event. */
  readonly workerBootMs: Millis;
  /** WT11/S7: bounds how long terminate() waits for the native worker.terminate() to confirm. */
  readonly terminateConfirmMs: Millis;
  readonly maxOldGenerationSizeMb?: number;
  readonly maxYoungGenerationSizeMb?: number;
  /** M3.2 HR1: worker-side client timeout for the `agent()`/`gate()` ack round trip. */
  readonly hostCallMs?: Millis;
  /** M3.2 HR1: worker-side client timeout for `gate()`'s single-segment RPC (its ack IS its result). */
  readonly gateMs?: Millis;
  /** M3.2 §5.3: `parallel()`/`pipeline()` item cap, enforced sandbox-side so an oversize batch fails fast without a host round trip. */
  readonly maxBatchItems?: number;
}

export type WorkerBootOutcome =
  | { readonly ok: true; readonly threadId: number; readonly epoch: number }
  | { readonly ok: false; readonly reason: "boot_timeout" | "boot_error"; readonly detail?: string };

/**
 * §2.3.1: the S1–S8 terminate() contract. `detached: true` is the ①-adjacent
 * guarantee (S6 completed — late messages are physically unreachable,
 * independent of whether the native `worker.terminate()` (S7) ever resolves).
 */
export interface WorkerTerminateOutcome {
  readonly detached: true;
  readonly terminated: boolean;
  readonly orphaned: boolean;
  readonly ms: Millis;
}

export interface SerializedError {
  readonly message: string;
  readonly stack?: string;
}

export interface WorkerHostEvents {
  onMetaError(cb: (message: string) => void): void;
  onLog(cb: (line: string) => void): void;
  onScriptReturned(cb: (result: unknown) => void): void;
  onScriptThrew(cb: (error: SerializedError) => void): void;
  /** Native `Worker` 'exit'. `expected` is true only when the host itself drove S1–S8 first. */
  onExit(cb: (code: number, expected: boolean) => void): void;
  /** Native `Worker` 'error' (e.g. `ERR_WORKER_OUT_OF_MEMORY`). */
  onError(cb: (error: SerializedError) => void): void;
  /** M3.2 §3.5: a `HostCallEnvelope` arrived from the worker (`agent`/`gate`/`log`). */
  onHostCall(cb: (envelope: HostCallEnvelope) => void): void;
  /**
   * M3.2 HR8: fired synchronously at the start of `terminate()` (S2), before
   * any I/O — the one hook host.ts needs to flush its own host-side pending
   * call table (ack-not-yet-sent, settle-not-yet-pushed) in the same breath
   * lifecycle.ts flushes its own worker-facing state, rather than racing it.
   */
  onTerminating(cb: (reason: string) => void): void;
}

export interface WorkerHostStats {
  /** WK2: messages that arrived after `detached` (S6) and were dropped without producing any observable effect. */
  lateMessages: number;
  /** WT11/S7: `terminate()` calls whose native `worker.terminate()` did not confirm within `terminateConfirmMs`. */
  terminateForced: number;
}

/** M3.2 §3.5: the worker->host half of the call/ack two-segment protocol (§3.3). `log` stays a fire-and-forget one-way message (unchanged from M3.1) — it never needs an ack/settle round trip, so it is deliberately not part of this envelope. */
export interface HostCallEnvelope {
  readonly id: string;
  readonly op: "agent" | "gate";
  readonly args: unknown;
}

/** M3.2 §3.5: the host->worker ack segment. `agent` acks carry `{ callId, deadlineAt }` (HR3); `gate` acks carry the finished exec result (single-segment RPC, §4.1 WT6). */
export type HostAckEnvelope =
  | { readonly id: string; readonly ok: true; readonly value: unknown }
  | { readonly id: string; readonly ok: false; readonly error: { readonly message: string } }
  | { readonly id: string; readonly ok: false; readonly cancelled: true; readonly cause: string };

/** M3.2 §3.3 HR3: the host->worker settle segment, pushed asynchronously once an `agent()` child reaches a terminal state. */
export type HostSettleEnvelope =
  | { readonly callId: string; readonly ok: true; readonly value: unknown }
  | { readonly callId: string; readonly ok: false; readonly error: { readonly message: string } };

/**
 * §3.5: the host-side handle for one worker thread running one workflow's
 * script. One `WorkerHost` = one worker = one workflow run in M3.1 (no
 * restart-on-failure, no worker reuse — WK4).
 */
export interface WorkerHost {
  boot(init: WorkerHostInit): Promise<WorkerBootOutcome>;
  readonly lifecycle: WorkerLifecycle;
  readonly epoch: number;
  /** P2/HB2: diagnostic-only. Never itself changes `WorkflowStatus` — that's the caller's job (runaway.ts / orchestrator.ts). */
  readHeartbeat(): WorkflowHeartbeatDiag;
  /** S3: best-effort, non-blocking notification to the worker. Never throws. */
  postCancel(reason: string): void;
  /** M3.2 §3.5: generic best-effort send to the worker (host_ack/host_settle envelopes). Never throws — same S3/S5 best-effort contract as `postCancel`. */
  send(msg: unknown): void;
  /** §2.3.1 S1–S8, idempotent (WK: repeat calls return the cached first result). */
  terminate(reason: string): Promise<WorkerTerminateOutcome>;
  readonly events: WorkerHostEvents;
  readonly stats: WorkerHostStats;
}
