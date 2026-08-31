import type { Millis } from "../core/types.js";
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
}

export interface WorkerHostStats {
  /** WK2: messages that arrived after `detached` (S6) and were dropped without producing any observable effect. */
  lateMessages: number;
  /** WT11/S7: `terminate()` calls whose native `worker.terminate()` did not confirm within `terminateConfirmMs`. */
  terminateForced: number;
}

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
  /** §2.3.1 S1–S8, idempotent (WK: repeat calls return the cached first result). */
  terminate(reason: string): Promise<WorkerTerminateOutcome>;
  readonly events: WorkerHostEvents;
  readonly stats: WorkerHostStats;
}
