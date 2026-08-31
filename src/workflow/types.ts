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
 * M3.4 (workflow design §5.2/§7.1 WI8): the label a script's `phase(title)`
 * statement gives to a group of `agent()` calls (or an explicit
 * `opts.phase` override). Just a string — there is no separate phase
 * registry/tree in this milestone (`meta.phases` remains a purely
 * declarative array for progress-tree UI, see `ScriptMeta`).
 */
export type PhaseId = string;

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

/**
 * M3.5 (workflow design §6.2): content-addressed lookup key for a single
 * `agent()` call's declared semantics (`taskKeyOf`, journal.ts) — a hex
 * digest string, opaque outside journal.ts/replay.ts.
 */
export type TaskKey = string;

/**
 * M3.5 §6.2: the `chain` scope's causal-chain digest — `H(chainDigestBefore
 * ‖ taskKey)`, recomputed identically whether advancing the *current* run's
 * live chain or reconstructing a *historical* entry's chain key from its
 * recorded `chainDigestBefore` (journal.ts's `nextChainDigest`). Same
 * representation as `TaskKey` (opaque hex digest string) — kept as a
 * distinct alias purely for readability at call sites.
 */
export type ChainKey = string;

/** M3.5 §6.2: which lookup key `replay.ts` uses — see journal.ts/replay.ts module docs for the safety/hit-rate tradeoff (定理 4' vs content scope). */
export type ReplayScope = "chain" | "content";

/**
 * M3.5 §6.2 `TaskSemantics` (design's `journal-key.ts`), *narrowed* to the
 * fields the current `agent()` host-call surface (host.ts's `handleAgent`)
 * actually carries — `model`/`effort`/`tools`/`cwd`/`schema`/`gate` are not
 * threaded through `ChildSpawner.spawn()` yet (M3.2/M3.4 scope), so they are
 * not part of the key. This is a documented simplification in the same
 * spirit as every other M3.x narrowing (see host.ts's own doc comments) —
 * a future milestone that wires those fields into `agent()` must add them
 * here too (`KEY_POLICY`-equivalent completeness is enforced by
 * `taskKeyOf`'s exhaustive object literal + `journal.test.ts`'s WP5-style
 * property test, not by a compile-time mapped-type gate, given file scope
 * for this milestone is host.ts/journal.ts/replay.ts only).
 */
export interface TaskSemantics {
  readonly agentType: string;
  /** E2 (§6.3): a content hash of the agent type's *resolved configuration*, not just its name — a `.md` definition edit must miss. Falls back to the bare `agentType` name when the configured `ChildSpawner` cannot report one (documented gap, see host.ts's `ChildSpawner.configHashOf`). */
  readonly agentTypeConfigHash: string;
  readonly prompt: string;
  /** RP7: `isolation:"worktree"` tasks are never replayed by default. */
  readonly isolation?: "worktree";
  /** §6.2: the workflow run's own top-level `args` — included because a script's prompt-construction logic can depend on `args` even where the resulting prompt text does not visibly change (defense-in-depth beyond "prompt is already textually complete"). */
  readonly workflowArgs?: unknown;
}

/**
 * M3.5 §6.5/§6.6 (JournalEntry, v1). One line of `journal.jsonl` — everything
 * `replay.ts` needs to decide RP3/RP4/RP6/RP7 and to reconstruct both the
 * `content`-scope key (`key`) and the `chain`-scope key (`chainKeyOf(key,
 * chainDigestBefore)`) without needing to know which scope was active when
 * this entry was written (see journal.ts's module doc for why `scope` is
 * still recorded and checked at load time regardless).
 */
export interface JournalEntry {
  readonly v: 1;
  /** M3.5: the scope this entry was written under (see journal.ts doc — a scope switch between runs invalidates history under the *other* scope rather than silently miscounting `occurrence`). */
  readonly scope: ReplayScope;
  readonly key: TaskKey;
  readonly chainDigestBefore: string;
  /** §6.2 step 4: assigned at *submission* time, never at settle/write time — the load-bearing property that makes completion order irrelevant to matching (定理 4'/推论 2.1). */
  readonly occurrence: number;
  readonly agentType: string;
  /** RP3: only successful calls are ever journaled. */
  readonly status: "completed";
  readonly isolation?: "worktree";
  /** The value the sandboxed script's `agent()` call resolved to on this run (`outcome.text ?? null`, mirroring host.ts's live settle path). */
  readonly value: string | null;
  /** JS6 (§6.6): `true` when `value` had to be truncated to `JOURNAL_VALUE_MAX_BYTES` at write time — `replay.ts#decideReplay` always `skip`s such an entry (a mutilated result must never be handed back out as a hit). Absent (not `false`) on untruncated entries, matching every other optional `JournalEntry` field's "undefined means no" convention. */
  readonly truncated?: true;
  readonly completedAt: Millis;
  readonly durationMs: Millis;
  /** RP4: sha256 hex over the canonical form of every other field above — recomputed and checked at load time; a mismatch (hand-edited `value` without updating `digest`, or vice versa) demotes the line to `corruptLines`, never to a returned-but-wrong replay hit. */
  readonly digest: string;
}

/** M3.5 §9.4/§10.2 W26/W30: per-run replay counters surfaced on `WorkflowOutcome.replay`. */
export interface WorkflowReplayStats {
  readonly hits: number;
  readonly misses: number;
  /** An entry existed at the (key, occurrence) but an RP precondition (RP1/RP6/RP7/RP9/scope mismatch) vetoed using it — distinct from a plain miss (no entry at all). */
  readonly skipped: number;
  readonly corruptLines: number;
}

export interface WorkflowChildSummary {
  readonly callId: CallId;
  readonly runId?: RunId;
  readonly label?: string;
  readonly phaseId?: PhaseId;
  readonly source: "live" | "replay";
  readonly status: "completed" | "failed" | "timed_out" | "aborted" | "withheld" | "running" | "stopping";
  readonly durationMs: Millis;
  readonly textPreview?: string;
  readonly taskKey?: TaskKey;
  readonly occurrence?: number;
}

/** §2.3.1: the worker's terminated-after state machine, S1 (spawning/ready) through S8 (orphan probe). */
export type WorkerLifecycle = "spawning" | "ready" | "closing" | "detached" | "terminated" | "orphaned";

export interface ScriptMeta {
  readonly name: string;
  readonly description: string;
  readonly phases?: readonly { readonly title: string }[];
  /** M3.5 RP9 (§6.4): `meta.deterministic === false` disables replay *lookups* for the whole run (journal writes are unaffected). Defaults to `true` when absent. */
  readonly deterministic?: boolean;
}

/**
 * §3.2/§7.1: why a workflow run stopped. M3.3 adds `parent_abort` (WI5
 * reverse propagation: this workflow was itself stopped because whatever
 * `stopChildrenOf`-style owner it runs under decided to stop it — the
 * plumbing that actually calls `Orchestrator.stop(id, "parent_abort")` lives
 * above `src/workflow/**` and is out of this milestone's scope, see the
 * hand-off note in orchestrator.ts) and `phase_timeout` (WT7, reserved:
 * phase tracking itself is M3.4, so no code path produces this cause yet —
 * kept here so M3.4 does not need a WorkflowStopCause change).
 */
export type WorkflowStopCause =
  "user_stop" | "timeout" | "script_error" | "worker_died" | "runaway" | "shutdown" | "parent_abort" | "phase_timeout";

/** §3.2: which absolute/relative deadline fired (M3.1 subset of WT1–WT19). */
export type WorkflowTimeoutReason =
  "script_load" | "worker_boot" | "script_slice" | "heartbeat_stall" | "workflow_total" | "terminate_confirm";

export type WorkflowTerminalStatus = "completed" | "failed" | "timed_out" | "aborted";

export interface WorkflowHeartbeatDiag {
  readonly seq: number;
  readonly observedAt: Millis;
  readonly stalledMs: Millis;
}

/**
 * §7.2 WL4 / RC3-RC4: a call whose child never reached a terminal state
 * within `reconcileMs` of the workflow's own logical terminal decision. Once
 * a call lands here it is permanently removed from `WorkflowOutcome.children`
 * (RC1: a `pendingReconcile:false` outcome's `children[]` may only contain
 * terminal/`withheld` entries — no `running`/`stopping` residue).
 */
export interface OrphanChildSummary {
  readonly callId: CallId;
  readonly runId?: RunId;
  readonly reason: "reconcile_timeout" | "cancel_retry_exhausted";
  readonly at: Millis;
}

export interface WorkflowDiagnostics {
  readonly createdAt: Millis;
  readonly startedAt?: Millis;
  readonly settledAt?: Millis;
  readonly deadlineAt?: Millis;
  readonly heartbeat: WorkflowHeartbeatDiag;
  readonly logLines: number;
  readonly orphanWorker?: { readonly threadId?: number; readonly reason: string; readonly at: Millis };
  /** M3.3 §3.6 CR6: calls whose A2 bounded-retry cancel loop is still in flight at the moment this snapshot was taken (only meaningful on `outcomeAt1()`-shaped, `pendingReconcile:true` snapshots — always 0 once `pendingReconcile` is `false`, since WL4's reconcile finalizes every call one way or another). */
  readonly retryingCancels?: number;
  /** M3.3 EI5: set when `resolve_settled` itself failed to apply (a defect in the effect pipeline, not in the workflow) and this outcome is the EI5 fallback rather than a normally-reconciled one. */
  /** M3.3 EI5: set when `resolve_settled` itself failed to apply (a defect in the effect pipeline, not in the workflow) and this outcome is the EI5 fallback rather than a normally-reconciled one. M3.6 TL3 adds `"settlement_timeout"`: the *tool* layer's own WT17 grace window (`settlementGraceMs`) elapsed before `Orchestrator.settled()` ever resolved — `src/tools/workflow-tool.ts` sets this on the `outcomeAt1()`/skeleton snapshot it falls back to, so a caller can tell "this is not a confirmed final state" from the outcome alone, not just from prose in the rendered text. */
  readonly degraded?: "settlement_apply_failed" | "settlement_timeout";
  /** M3.4 §9.1/§9.2: the phase the script's most recent `phase(title)` call declared, if any — diagnostic only (`/agent status`-equivalent), not authoritative for `WorkflowChildSummary.phaseId` (each call records its own phase at submission time). */
  readonly currentPhaseId?: PhaseId;
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
  /**
   * M3.3 (§4.3.1.1): `true` on an `outcomeAt1()`-shaped ("①") snapshot —
   * `children[].status` may then include the non-terminal `"running"` /
   * `"stopping"` values. Every outcome `Orchestrator.run()`/`settled()`
   * resolve with is the "②" snapshot and always has this `false` (RC1);
   * `outcomeAt1()` is the only producer of `true`.
   */
  readonly pendingReconcile: boolean;
  readonly result?: unknown;
  readonly error?: { readonly message: string; readonly stack?: string };
  readonly timeoutReason?: WorkflowTimeoutReason;
  readonly stopCause?: WorkflowStopCause;
  readonly durationMs: Millis;
  readonly diag: WorkflowDiagnostics;
  /**
   * M3.2/M3.3 (§3.3, slice): every `agent()` call submitted during this run,
   * in submission order (stable, assertable — mirrors the full design's
   * `WorkflowChildSummary[]`). Always `[]` for scripts that never call
   * `agent()`. RC1: once `pendingReconcile` is `false`, every entry here is
   * terminal or `withheld` — nothing `running`/`stopping` survives WL4's
   * `reconcile_children` (calls that didn't make it are moved to
   * `orphanChildren` instead, never left behind here).
   */
  readonly children: readonly WorkflowChildSummary[];
  /** M3.3 §7.2 WL4 / RC3-RC4: calls reconcile_children gave up on (bounded `reconcileMs`) or the A2 retry loop gave up on (bounded `cancelRetryWindowMs`, CR7). Always `[]` when nothing needed to be given up on. */
  readonly orphanChildren?: readonly OrphanChildSummary[];
  /** M3.5 §3.3/§9.4: replay hit/miss/skip/corrupt counters for this run. Present only when a journal was configured (`OrchestratorRunRequest.journal` set) — `undefined` for journal-less runs (not `{hits:0,...}`, so callers can tell "replay wasn't in play" from "replay was in play and never fired"). */
  readonly replay?: WorkflowReplayStats;
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
  /** M3.3 WT10: WL2's bounded wait for still-active children to settle for real before WL4 gives up on them. Optional, default 10_000 (§4.1). */
  readonly abortGraceMs?: Millis;
  /** M3.3 WT19: WL4's single bounded snapshot read of whatever is still outstanding after `abortGraceMs`. Optional, default 1_000 (§4.1). */
  readonly reconcileMs?: Millis;
  /** M3.3 WT18/§3.6: the A2 bounded-retry cancel loop's give-up window. Optional, default `startupMs`(30_000)+5_000 (§4.1, matches host.ts's M3.2 fixed default). */
  readonly cancelRetryWindowMs?: Millis;
  /** M3.5 RP6 (§6.4): how long a journaled entry stays eligible for replay. Optional, default 7 days. `0` = unlimited. */
  readonly replayTtlMs?: Millis;
  /** M3.5 JS4 (§6.6): bounds the pre-terminal best-effort journal flush. Optional, default 2_000. */
  readonly journalFlushMs?: Millis;
  /**
   * M3.4 WT7 (§4.1/§7.2 WI8): a single phase's own budget. `0`/undefined =
   * unlimited (workflow's own WT8 `workflowTotalMs` still applies). On
   * expiry only the calls submitted under that `phase(title)` (or an
   * explicit `opts.phase` override) are cancelled — the workflow itself is
   * unaffected and keeps running (this is *not* a global `close_gate`).
   */
  readonly phaseTotalMs?: Millis;
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
  /** M3.4 §5.2: the script's top-level `args` global — structured-cloned into `workerData` at construction (no separate message round trip needed, unlike `phase`/`log`/host calls). `undefined` surfaces to the script as `null` (§5.2: "顶层全局"). */
  readonly args?: unknown;
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
   * M3.4 §5.2/§9.2: the script's `phase(title)` statement fired. Fire-and-
   * forget one-way message, same wire shape as `onLog` — there is no ack,
   * no settle, and (per WI8) no interaction with the abort/close_gate
   * machinery beyond what `host.ts`'s own WT7 timer does with it.
   */
  onPhase(cb: (title: string) => void): void;
  /**
   * M3.5 §6 (RP9): fired once, synchronously ahead of any `host_call`
   * message from the same worker (single ordered `MessagePort`, single
   * script-thread sender — see worker-source.ts's `run()`), right after the
   * script's `meta` literal parses successfully. Carries just the
   * replay-relevant subset of `ScriptMeta` (`deterministic`); a script that
   * never parses (meta_error) never fires this.
   */
  onMeta(cb: (meta: Pick<ScriptMeta, "deterministic">) => void): void;
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

/**
 * M3.2 §3.5: the host->worker ack segment. `agent` acks carry `{ callId, deadlineAt }` (HR3); `gate` acks carry the finished exec result (single-segment RPC, §4.1 WT6).
 *
 * M3.3 Blocker fix (verification finding B): this envelope **must** carry a
 * `kind` discriminator — `worker-source.ts`'s inbound dispatch (`commPort.on("message", ...)`)
 * switches on `msg.kind === "host_ack"`/`"host_settle"` and silently drops anything else.
 * Before this fix `host.ts` sent these envelopes without `kind`, so every real
 * `agent()`/`gate()` ack/settle was dropped worker-side and the calling script's
 * `await` hung until HR1's client-side timeout (or, with no per-call timeout
 * override, effectively until WT8). `host.test.ts`'s coverage used a fake
 * `WorkerHost` double that never round-tripped through the real worker-source
 * dispatcher, so this never showed up there — see `worker-host-call.test.ts`
 * for the real-worker regression coverage this fix adds.
 */
export type HostAckEnvelope =
  | { readonly kind: "host_ack"; readonly id: string; readonly ok: true; readonly value: unknown }
  | {
      readonly kind: "host_ack";
      readonly id: string;
      readonly ok: false;
      readonly error: { readonly message: string };
    }
  | {
      readonly kind: "host_ack";
      readonly id: string;
      readonly ok: false;
      readonly cancelled: true;
      readonly cause: string;
    };

/**
 * M3.2 §3.3 HR3: the host->worker settle segment, pushed asynchronously once
 * an `agent()` child reaches a terminal state. Same M3.3 Blocker fix as
 * `HostAckEnvelope` above — `kind` is required so `worker-source.ts` can
 * actually route it.
 */
export type HostSettleEnvelope =
  | {
      readonly kind: "host_settle";
      readonly callId: string;
      readonly ok: true;
      readonly value: unknown;
      /** M3.6 (workflow design §5.2 `budget.spent()`): this call's live child's output-token usage, so the sandbox's cumulative counter can advance. Absent (not `0`) for a replay hit — a cached result costs nothing, and `budget.spent()`'s doc explicitly promises it "never fabricates a number" for anything it cannot actually account for. */
      readonly outputTokens?: number;
    }
  | {
      readonly kind: "host_settle";
      readonly callId: string;
      readonly ok: false;
      readonly error: { readonly message: string };
    };

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
