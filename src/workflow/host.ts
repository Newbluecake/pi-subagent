import type { Clock } from "../core/clock.js";
import { withDeadline } from "../core/deadline.js";
import type { Millis, RunId } from "../core/types.js";
import { deriveChildBudget } from "./budget.js";
import { createCallRegistry, type CallRegistry } from "./call-registry.js";
import { buildEntry, CHAIN_SEED, nextChainDigest, taskKeyOf, type JournalStore } from "./journal.js";
import { decideReplay, type ReplayIndex } from "./replay.js";
import type {
  CallId,
  HostAckEnvelope,
  HostCallEnvelope,
  HostSettleEnvelope,
  OrphanChildSummary,
  ReplayScope,
  TaskKey,
  TaskSemantics,
  WorkerHost,
  WorkflowChildSummary,
  WorkflowReplayStats,
  WorkflowRunBudget,
} from "./types.js";

/**
 * M3.2 (workflow design §3.3/§3.5/§4.4): the host-side call handler —
 * `agent()`/`gate()` land here as `HostCallEnvelope`s, get answered with the
 * ack segment (HR3: `agent`'s ack never waits for the child), and (for
 * `agent`) get a second, asynchronous `settle` push once the spawned child
 * reaches a terminal state.
 *
 * Deliberately **not** importing `SpawnService` from `src/service/` (WI2,
 * carried forward from M3.1: the isolation shell stays decoupled from the
 * core/service layer's concrete types). `ChildSpawner` below is a
 * structural subset `SpawnService` already satisfies — the orchestrator's
 * caller passes a real `SpawnService` instance, TypeScript accepts it
 * because the shapes match, and `src/workflow/**` still has zero import
 * edges into `src/service/**`.
 */

export interface ChildSpawnResult {
  readonly runId: RunId;
}
export interface ChildSpawnError {
  readonly error: { readonly message: string };
}
export interface ChildOutcome {
  readonly runId: RunId;
  readonly status: "completed" | "failed" | "timed_out" | "aborted";
  readonly text?: string;
  readonly error?: { readonly message: string };
}
export interface ChildSpawner {
  spawn(req: {
    type: string;
    prompt: string;
    label?: string;
    deadlineAt?: Millis;
    parentRunId?: string;
    /**
     * M3.3 Minor fix (§4.4.3 BW1/BW3): the relative budget `deriveChildBudget`
     * computed, threaded all the way to `SpawnRequest.budgetOverride` —
     * previously only the absolute `deadlineAt` cap was forwarded, so a
     * `SpawnService` that (like the real one) resolves relative
     * `totalMs`/`queueWaitMs` at the child's own enqueue time had no relative
     * signal at all, only the CC4 ceiling.
     */
    budgetOverride?: { totalMs?: Millis; queueWaitMs?: Millis };
  }): Promise<ChildSpawnResult | ChildSpawnError>;
  abort(runId: RunId, cause?: string): Promise<boolean>;
  waitAll(opts: { runIds: RunId[] }): Promise<{ settled: ChildOutcome[]; pending: RunId[] }>;
  /**
   * M3.3 §3.7 OS1/OS4: workflow-scoped bulk stop — structurally compatible
   * with `SpawnService.stopChildrenOf` (CC1). Optional: when absent, WL2
   * falls back to per-call `abort()` via `CallRegistry.cancelAll` alone
   * (still correct, just without the OS4 sweep's extra safety net for
   * children the registry never learned about).
   */
  stopChildrenOf?(parentRunId: string, cause: string): Promise<{ stopped: RunId[]; pending: RunId[] }>;
  /**
   * M3.5 §6.3 E2: a content hash of `type`'s *resolved* agent-type
   * configuration (systemPrompt/tools/model/thinking, per the design's
   * `agentTypeConfigHash`) — the real assembler wires this to the same
   * `AgentTypeRegistry` `SpawnService` itself resolves against, so an edited
   * `.md` definition changes the hash. Optional: when absent, `handleAgent`
   * falls back to using the bare `type` name (documented gap — a script
   * whose agent-type *definition* changes without its *name* changing will
   * still replay stale results until a real hash is wired in).
   */
  configHashOf?(type: string): string | undefined;
}

export type GateRunner = (
  cmd: string,
  opts: { cwd?: string; timeoutMs: Millis },
) => Promise<{ ok: boolean; code: number; stdout: string; stderr: string }>;

/**
 * M3.5 §6.5/§6.6: everything `handleAgent` needs to run the replay
 * short-circuit + write journal entries for one run. Optional on
 * `HostCallHandlerDeps` — a run with no `journal` configured skips both
 * (unchanged M3.2/M3.4 live-only behavior, zero journal I/O).
 */
export interface JournalRunConfig {
  readonly store: JournalStore;
  readonly dir: string;
  readonly index: ReplayIndex;
  readonly scope: ReplayScope;
  /** RP1. */
  readonly noReplay: boolean;
  readonly replayTtlMs?: Millis;
  readonly journalFlushMs?: Millis;
  /**
   * RP9, mutable: `true` until the worker's `meta` message says otherwise
   * (see orchestrator.ts's `onMeta` wiring — updated *before* boot()
   * resolves the script's first turn, so no `agent()` call can ever observe
   * a stale value). A plain object (not a getter function) so orchestrator.ts
   * and host.ts share one mutable cell without an extra indirection layer.
   */
  readonly deterministic: { current: boolean };
}

export interface HostCallHandlerDeps {
  readonly clock: Clock;
  readonly workerHost: WorkerHost;
  readonly spawner: ChildSpawner;
  readonly gateRunner: GateRunner;
  readonly budget: Pick<
    WorkflowRunBudget,
    | "hostCallMs"
    | "gateMs"
    | "maxParallel"
    | "maxChildren"
    | "maxBatchItems"
    | "childBudgetPolicy"
    | "childBudgetFraction"
    | "childTotalMs"
    | "cancelRetryWindowMs"
    | "phaseTotalMs"
  >;
  /** WR2-equivalent: the workflow's own absolute deadline, computed once at enqueue and never recomputed here. */
  readonly workflowDeadlineAt?: Millis;
  readonly defaultAgentType?: string;
  readonly parentRunId?: string;
  /** M3.5 §6.2: the workflow run's own top-level `args` — folded into every task's `TaskSemantics.workflowArgs`. */
  readonly workflowArgs?: unknown;
  /** M3.5, see `JournalRunConfig`'s doc. */
  readonly journal?: JournalRunConfig;
  /** Fired once per settled/withheld child, in settlement order (feeds `WorkflowOutcome.children`). */
  onChildSettled?(summary: WorkflowChildSummary): void;
  /** M3.4 §9.2: fired once per `phase(title)`/timeout transition (progress-event plumbing; optional, harmless no-op if absent). */
  onPhaseChange?(event: { phaseId: string; kind: "enter" | "timeout"; at: Millis }): void;
}

export interface HostCallHandler {
  readonly registry: CallRegistry;
  readonly children: readonly WorkflowChildSummary[];
  /** M3.4 §9.1/§9.2: the most recent `phase(title)` the script declared, if any (diagnostics only). */
  readonly currentPhaseId: string | undefined;
  /** M3.5 §3.3/§9.4: replay hit/miss/skip counters for this run; `corruptLines` mirrors `deps.journal.index.stats.corruptLines` (fixed at load time). `undefined` when no `journal` was configured. */
  readonly replayStats: WorkflowReplayStats | undefined;
  /** Best-effort: attempts to stop every still-active child (used ahead of a future M3.3 abort pipeline; harmless no-op today if nothing is running). */
  cancelAllChildren(cause: string): void;
  /**
   * M3.3 §7.2 WL1/WL2/WL4 (inline): closes the gate, cascade-cancels every
   * still-active call, waits up to `graceMs` (WT10 `abortGraceMs`) for real
   * settlement, then force-settles and reports whatever is left as
   * orphaned. Idempotent (WI6) — a second call (or a subsequent
   * `WorkerHost.terminate()`'s `onTerminating`) is a no-op once this has run.
   */
  stopOwned(cause: string, graceMs: Millis): Promise<{ orphanChildren: readonly OrphanChildSummary[] }>;
  /** M3.5 JS4: a single bounded best-effort flush of this run's `journal` (no-op if none configured). Intended to be called once, ahead of the workflow's terminal decision (orchestrator.ts). */
  flushJournal(deadlineMs: Millis): Promise<{ written: number; pending: number } | undefined>;
}

const DEFAULT_AGENT_TYPE = "general-purpose";

function errMsg(e: unknown): string {
  if (e instanceof Error) return e.message;
  return String(e);
}

/**
 * Wires `deps.workerHost.events.onHostCall`/`onTerminating` and returns a
 * handle exposing the registry + accumulated child summaries. Call once per
 * workflow run (mirrors `createWorkerHost` — one instance per run, no
 * reuse).
 */
export function attachHostCallHandler(deps: HostCallHandlerDeps): HostCallHandler {
  const budget = {
    hostCallMs: deps.budget.hostCallMs ?? 60_000,
    gateMs: deps.budget.gateMs ?? 600_000,
    maxParallel: deps.budget.maxParallel ?? 4,
    maxChildren: deps.budget.maxChildren ?? 500,
    maxBatchItems: deps.budget.maxBatchItems ?? 1024,
    childBudgetPolicy: deps.budget.childBudgetPolicy ?? "inherit_remaining",
    ...(deps.budget.childBudgetFraction !== undefined ? { childBudgetFraction: deps.budget.childBudgetFraction } : {}),
    ...(deps.budget.childTotalMs !== undefined ? { childTotalMs: deps.budget.childTotalMs } : {}),
  };
  const children: WorkflowChildSummary[] = [];
  const startedAt = new Map<CallId, Millis>();
  const phaseOf = new Map<CallId, string>();
  let terminated = false;
  let currentPhaseId: string | undefined;

  // M3.5 §6.2: per-run chain digest (advances on every submission, hit or
  // miss — 推论 2.2/定理 4') + per-K submission counters (occurrence is
  // assigned here, at *submission* time, never at settle time — the one
  // property that makes completion order irrelevant to matching). Both are
  // no-ops (never read) when `deps.journal` is absent.
  let chainDigest = CHAIN_SEED;
  const occCounters = new Map<string, number>();
  /** callId -> the journal bookkeeping needed to write an entry once this call's live settle arrives (RP3: only successful calls are ever journaled). */
  const journalMetaOf = new Map<
    CallId,
    { taskKey: TaskKey; chainDigestBefore: string; occurrence: number; agentType: string; isolation?: "worktree" }
  >();
  const replayStats = { hits: 0, misses: 0, skipped: 0 };
  /**
   * M3.4 fix (found while adding real WT7 coverage): a *single* "current
   * phase timer" is wrong — clearing the previous phase's timer the instant
   * a script moves on to `phase("next")` means a straggler call left behind
   * in the abandoned phase never gets WT7's cancellation at all (the exact
   * pattern the design's own `agent()`-without-`await` + `parallel`/
   * `pipeline` idioms encourage). Each phase gets its own independent timer,
   * keyed by title, so a still-active call in an *earlier* phase is still
   * bounded by that phase's own budget even after the script has moved on.
   */
  const phaseTimers = new Map<string, ReturnType<Clock["setTimer"]>>();

  function clearAllPhaseTimers(): void {
    for (const timer of phaseTimers.values()) deps.clock.clearTimer(timer);
    phaseTimers.clear();
  }

  /**
   * M3.4 WT7/§7.2 WI8: a script's `phase(title)` statement re-labels the
   * environment every subsequent `agent()` call (without its own
   * `opts.phase`) lands under, and (if `budget.phaseTotalMs` is configured)
   * arms a fresh bounded timer *for that phase title specifically* —
   * independent of whatever other phase timers are already ticking for
   * earlier phases the script has since moved past.
   *
   * WI8 is the crucial distinction from WL1 `close_gate`: on expiry only the
   * calls this function itself tagged with `title` are cancelled
   * (`registry.cancel`, the ordinary A1-A4 per-call path) — the registry is
   * never closed, `terminated` never flips, and the workflow's own status is
   * completely unaffected. A phase timeout is a *local* event.
   */
  function handlePhase(title: string): void {
    if (terminated) return; // WL1 already closed everything down; a late phase() from the worker changes nothing.
    currentPhaseId = title;
    deps.onPhaseChange?.({ phaseId: title, kind: "enter", at: deps.clock.now() });
    const phaseTotalMs = deps.budget.phaseTotalMs;
    if (phaseTotalMs === undefined || phaseTotalMs <= 0) return;
    // Re-entering the same phase title restarts its own clock (a script that
    // calls `phase("retry")` more than once is opting into a fresh budget for
    // that leg, same as any other phase).
    const existing = phaseTimers.get(title);
    if (existing !== undefined) deps.clock.clearTimer(existing);
    phaseTimers.set(
      title,
      deps.clock.setTimer(phaseTotalMs, () => {
        phaseTimers.delete(title);
        for (const active of registry.listActive()) {
          if (phaseOf.get(active.callId) === title) registry.cancel(active.callId, "phase_timeout");
        }
        deps.onPhaseChange?.({ phaseId: title, kind: "timeout", at: deps.clock.now() });
      }),
    );
  }
  deps.workerHost.events.onPhase(handlePhase);

  const registry = createCallRegistry({
    clock: deps.clock,
    abort: (runId, cause) => deps.spawner.abort(runId, cause),
    // WT18: `startupMs`(core default 30s) + slack by default, but honors an
    // explicit budget override so a real assembler (or a test, via
    // `OrchestratorTestHooks.cancelRetryWindowMsOverride`) can thread the
    // *actual* configured window through instead of this fixed fallback.
    cancelRetryWindowMs: deps.budget.cancelRetryWindowMs ?? 35_000,
  });

  function recordSettled(summary: WorkflowChildSummary): void {
    children.push(summary);
    deps.onChildSettled?.(summary);
    if (registry.listActive().length === 0) {
      const waiters = drainWaiters.splice(0, drainWaiters.length);
      for (const cb of waiters) cb();
    }
  }

  // M3.3 §7.2 WL2: event-driven (not polled) wait for "every still-active
  // call has really settled" — `recordSettled` above notifies every waiter
  // the instant the registry drains, so `stopOwned`'s bounded wait resolves
  // as soon as children finish for real instead of only on a fixed poll
  // cadence (also makes it exactly one `Clock.setTimer` per `stopOwned` call,
  // which plays correctly with `FakeClock`-driven tests — a single
  // `clock.advance(graceMs)` is enough to force the timeout branch).
  const drainWaiters: Array<() => void> = [];

  /** A1 (withheld): `cancel()` already synchronously settled these — they never spawned, so there is no runId to report. */
  function settleWithheld(callId: CallId, cause: string): void {
    const durationMs = deps.clock.now() - (startedAt.get(callId) ?? deps.clock.now());
    const phaseId = phaseOf.get(callId);
    journalMetaOf.delete(callId); // never journaled (RP3: withheld isn't a success).
    recordSettled({
      callId,
      source: "live",
      status: "withheld",
      durationMs,
      ...(phaseId !== undefined ? { phaseId } : {}),
    });
    deps.workerHost.send({
      kind: "host_settle",
      callId,
      ok: false,
      error: { message: `workflow terminating (${cause})` },
    } satisfies HostSettleEnvelope);
  }

  /**
   * A2/A3/A4: still active when the workflow decided to stop. Force-settles
   * it as `aborted` rather than waiting for the (now-moot) A2 retry loop to
   * eventually give up on its own `cancelRetryWindowMs` clock — HR8/WL4:
   * nothing may stay pending once the workflow itself has ended.
   */
  function forceSettleActive(callId: CallId, cause: string): void {
    const state = registry.resolve(callId);
    registry.settle(callId, deps.clock.now());
    const durationMs = deps.clock.now() - (startedAt.get(callId) ?? deps.clock.now());
    const phaseId = phaseOf.get(callId);
    journalMetaOf.delete(callId); // never journaled (RP3: forced-abort isn't a success).
    recordSettled({
      callId,
      ...(state?.runId !== undefined ? { runId: state.runId } : {}),
      source: "live",
      status: "aborted",
      durationMs,
      ...(phaseId !== undefined ? { phaseId } : {}),
    });
    // Best-effort: the port may already be closing (S5), but a send racing
    // that close is harmless (WorkerHost.send is a no-throw best-effort primitive).
    deps.workerHost.send({
      kind: "host_settle",
      callId,
      ok: false,
      error: { message: `workflow terminating (${cause})` },
    } satisfies HostSettleEnvelope);
  }

  function remainingWorkflowMs(): Millis {
    if (deps.workflowDeadlineAt === undefined) return Number.POSITIVE_INFINITY;
    return Math.max(0, deps.workflowDeadlineAt - deps.clock.now());
  }

  async function handleAgent(callId: CallId, args: unknown): Promise<HostAckEnvelope> {
    const a = args as {
      prompt?: unknown;
      opts?: { label?: unknown; agentType?: unknown; phase?: unknown } | null;
    };
    if (typeof a.prompt !== "string") {
      return {
        kind: "host_ack",
        id: callId,
        ok: false,
        error: { message: "agent(prompt, opts?): prompt must be a string" },
      };
    }
    const opts = a.opts ?? {};
    const label = typeof opts.label === "string" ? opts.label : undefined;
    const agentType =
      typeof opts.agentType === "string" ? opts.agentType : (deps.defaultAgentType ?? DEFAULT_AGENT_TYPE);
    // M3.4 §5.2: worker-source.ts already resolved \`opts.phase\` against the
    // script's environment \`phase(title)\` (explicit \`opts.phase\` wins) before
    // this call ever left the sandbox — this handler just records whatever it
    // receives, it never itself falls back to a "current phase" notion (that
    // state lives in \`currentPhaseId\`/\`handlePhase\` above, worker-side only).
    const phaseId = typeof opts.phase === "string" ? opts.phase : undefined;
    // M3.5 RP7 (§6.4): opt-in per-call `isolation:"worktree"` marker — not
    // yet threaded into `ChildSpawner.spawn()` (host.ts doesn't call
    // `SpawnService` directly, WI2), so it has no *live* effect on where the
    // child actually runs today. It exists here purely so the journal
    // records it and RP7 can veto replaying it once a future milestone wires
    // real worktree isolation through `ChildSpawner`.
    const isolation: "worktree" | undefined =
      (opts as { isolation?: unknown }).isolation === "worktree" ? "worktree" : undefined;

    // M3.5 §6.2/§6.4: the replay short-circuit. Computed unconditionally
    // whenever a journal is configured, before any admission-limit checks
    // below — occurrence/chain-digest must advance on *every* submission,
    // hit or miss (定理 3 "至多复用一次" depends on `occCounters` incrementing
    // regardless of outcome), and a replay hit never touches the live
    // resource limits below (it doesn't hold a `SlotPool`/parallel slot).
    const journal = deps.journal;
    if (journal) {
      const agentTypeConfigHash = deps.spawner.configHashOf?.(agentType) ?? agentType;
      const sem: TaskSemantics = {
        agentType,
        agentTypeConfigHash,
        prompt: a.prompt,
        ...(isolation !== undefined ? { isolation } : {}),
        ...(deps.workflowArgs !== undefined ? { workflowArgs: deps.workflowArgs } : {}),
      };
      const taskKey = taskKeyOf(sem);
      const chainDigestBefore = chainDigest;
      const kForOccurrence = journal.scope === "content" ? taskKey : nextChainDigest(chainDigestBefore, taskKey);
      const occurrence = occCounters.get(kForOccurrence) ?? 0;
      occCounters.set(kForOccurrence, occurrence + 1);
      // §6.2 step 5: the chain always advances, hit or miss.
      chainDigest = nextChainDigest(chainDigestBefore, taskKey);

      const decision = decideReplay({
        index: journal.index,
        taskKey,
        chainDigestBefore,
        occurrence,
        noReplay: journal.noReplay,
        deterministic: journal.deterministic.current,
        now: deps.clock.now(),
        ...(journal.replayTtlMs !== undefined ? { replayTtlMs: journal.replayTtlMs } : {}),
      });

      if (decision.kind === "hit") {
        replayStats.hits += 1;
        registry.submit(callId, deps.clock.now());
        startedAt.set(callId, deps.clock.now());
        if (phaseId !== undefined) phaseOf.set(callId, phaseId);
        registry.settle(callId, deps.clock.now());
        recordSettled({
          callId,
          source: "replay",
          status: "completed",
          durationMs: 0,
          taskKey,
          occurrence,
          ...(decision.entry.value !== null ? { textPreview: decision.entry.value.slice(0, 2048) } : {}),
          ...(phaseId !== undefined ? { phaseId } : {}),
        });
        // Same two-stage ack/settle shape as the live path (HR3) — the ack
        // returned below is what the caller posts; the settle push happens
        // here, synchronously, since there is nothing to await. Worker-side
        // buffering (`bufferedSettles`, worker-source.ts) already tolerates a
        // settle landing before its own ack is processed, so wire order is
        // not load-bearing here.
        deps.workerHost.send({
          kind: "host_settle",
          callId,
          ok: true,
          value: decision.entry.value,
        } satisfies HostSettleEnvelope);
        return {
          kind: "host_ack",
          id: callId,
          ok: true,
          value: { callId, deadlineAt: deps.clock.now() },
        };
      }
      if (decision.kind === "miss") replayStats.misses += 1;
      else replayStats.skipped += 1;
      journalMetaOf.set(callId, {
        taskKey,
        chainDigestBefore,
        occurrence,
        agentType,
        ...(isolation !== undefined ? { isolation } : {}),
      });
    }

    // §5.3 D-W… "narrowed": M3.2 does not have the agent-type registry
    // reachable at this layer (it lives in `AgentTypeRegistry`, service
    // layer) — unknown-type rejection is enforced by `ChildSpawner.spawn`
    // itself returning `{ error }`, which this handler already threads
    // through to an ack failure below. No separate check needed here.

    const activeCount = ["admission", "pre_runner", "running"].reduce(
      (n, phase) => n + registry.stats[phase as "admission" | "pre_runner" | "running"],
      0,
    );
    if (activeCount >= budget.maxParallel) {
      journalMetaOf.delete(callId);
      return {
        kind: "host_ack",
        id: callId,
        ok: false,
        error: { message: `agent(): maxParallel (${budget.maxParallel}) concurrent children already active` },
      };
    }
    const totalEverSubmitted =
      registry.stats.admission + registry.stats.pre_runner + registry.stats.running + registry.stats.settled;
    if (totalEverSubmitted >= budget.maxChildren) {
      journalMetaOf.delete(callId);
      return {
        kind: "host_ack",
        id: callId,
        ok: false,
        error: { message: `agent(): maxChildren (${budget.maxChildren}) exceeded for this workflow run` },
      };
    }

    const derived = deriveChildBudget(
      {
        now: deps.clock.now(),
        policy: budget.childBudgetPolicy,
        ...(deps.workflowDeadlineAt !== undefined ? { workflowDeadlineAt: deps.workflowDeadlineAt } : {}),
        // M3.2: no phase tracking yet (see budget.ts doc) — `phaseDeadlineAt` deliberately omitted.
        ...(budget.childBudgetFraction !== undefined ? { fraction: budget.childBudgetFraction } : {}),
        ...(budget.childTotalMs !== undefined ? { fixedTotalMs: budget.childTotalMs } : {}),
      },
      undefined,
    );
    if (derived.capped === "expired") {
      journalMetaOf.delete(callId);
      return {
        kind: "host_ack",
        id: callId,
        ok: false,
        error: { message: "WorkflowBudgetExhausted: no remaining budget to spawn a child (BW2)" },
      };
    }

    registry.submit(callId, deps.clock.now());
    startedAt.set(callId, deps.clock.now());
    if (phaseId !== undefined) phaseOf.set(callId, phaseId);

    const spawned = await deps.spawner.spawn({
      type: agentType,
      prompt: a.prompt,
      ...(label !== undefined ? { label } : {}),
      ...(derived.deadlineAt !== undefined ? { deadlineAt: derived.deadlineAt } : {}),
      ...(deps.parentRunId !== undefined ? { parentRunId: deps.parentRunId } : {}),
      budgetOverride: { totalMs: derived.totalMs, queueWaitMs: derived.queueWaitMs },
    });
    if ("error" in spawned) {
      registry.settle(callId, deps.clock.now());
      journalMetaOf.delete(callId);
      recordSettled({
        callId,
        source: "live",
        status: "withheld",
        durationMs: deps.clock.now() - (startedAt.get(callId) ?? deps.clock.now()),
        ...(phaseId !== undefined ? { phaseId } : {}),
      });
      return { kind: "host_ack", id: callId, ok: false, error: spawned.error };
    }

    const bound = registry.bind(callId, spawned.runId);
    if (bound.cancelNow) {
      // M3.3 fix (was previously silently dropped): a cancel arrived while
      // this `agent()`'s `spawner.spawn()` call was still in flight, so
      // `CallRegistry` had already (synchronously, on the A1 admission
      // assumption "never spawns") settled this call as withheld. It *did*
      // spawn — `spawned.runId` is a real, running child. `registry.bind()`
      // itself already kicked off a bounded A2-style retry (`retryOrphanAbort`)
      // against it, so there is nothing further to do here beyond skipping the
      // `waitAll()`/`recordSettled` path below — the withheld summary for this
      // callId was already recorded when the cancel first landed
      // (`settleWithheld`/`forceSettleActive`), and recording it again here
      // would duplicate `children[]`.
      return { kind: "host_ack", id: callId, ok: false, cancelled: true, cause: bound.cause ?? "cancelled" };
    }

    // HR3: fire the settle wait in the background — the ack below returns
    // immediately, independent of how long the child itself takes.
    void deps.spawner.waitAll({ runIds: [spawned.runId] }).then(({ settled }) => {
      const outcome = settled[0];
      registry.settle(callId, deps.clock.now());
      const durationMs = deps.clock.now() - (startedAt.get(callId) ?? deps.clock.now());
      if (!outcome) {
        // The spawner never settled this run (e.g. it was already gone by
        // the time waitAll looked it up) — report it honestly rather than hang.
        journalMetaOf.delete(callId); // never journaled (RP3: not a success).
        const settleMsg: HostSettleEnvelope = {
          kind: "host_settle",
          callId,
          ok: false,
          error: { message: "child run did not settle" },
        };
        recordSettled({
          callId,
          runId: spawned.runId,
          source: "live",
          status: "aborted",
          durationMs,
          ...(phaseId !== undefined ? { phaseId } : {}),
        });
        deps.workerHost.send(settleMsg);
        return;
      }
      recordSettled({
        callId,
        runId: outcome.runId,
        source: "live",
        status: outcome.status,
        durationMs,
        ...(outcome.text !== undefined ? { textPreview: outcome.text.slice(0, 2048) } : {}),
        ...(phaseId !== undefined ? { phaseId } : {}),
      });
      // M3.5 RP3 (§6.4): only a *successful* live settle is ever journaled —
      // failed/aborted/timed-out children never get an entry, matching the
      // upstream plugin's "journaled failure ends the prefix" invariant
      // (§6.1) at the per-entry granularity `chain`/`content` scope already
      // gives us. `append()` is fire-and-forget (JS1) — never awaited here,
      // so a slow/failing disk cannot delay this settle push to the worker.
      if (journal && outcome.status === "completed") {
        const meta = journalMetaOf.get(callId);
        if (meta) {
          journal.store.append(
            journal.dir,
            buildEntry({
              scope: journal.scope,
              key: meta.taskKey,
              chainDigestBefore: meta.chainDigestBefore,
              occurrence: meta.occurrence,
              agentType: meta.agentType,
              ...(meta.isolation !== undefined ? { isolation: meta.isolation } : {}),
              value: outcome.text ?? null,
              completedAt: deps.clock.now(),
              durationMs,
            }),
          );
        }
      }
      journalMetaOf.delete(callId);
      const settleMsg: HostSettleEnvelope =
        outcome.status === "completed"
          ? { kind: "host_settle", callId, ok: true, value: outcome.text ?? null }
          : { kind: "host_settle", callId, ok: false, error: outcome.error ?? { message: `child ${outcome.status}` } };
      deps.workerHost.send(settleMsg);
    });

    return { kind: "host_ack", id: callId, ok: true, value: { callId, deadlineAt: derived.deadlineAt } };
  }

  async function handleGate(callId: CallId, args: unknown): Promise<HostAckEnvelope> {
    const a = args as { cmd?: unknown; cwd?: unknown };
    if (typeof a.cmd !== "string") {
      return { kind: "host_ack", id: callId, ok: false, error: { message: "gate(cmd, opts?): cmd must be a string" } };
    }
    const timeoutMs = Math.min(budget.gateMs, remainingWorkflowMs());
    if (timeoutMs <= 0) {
      return {
        kind: "host_ack",
        id: callId,
        ok: false,
        error: { message: "WorkflowBudgetExhausted: no remaining workflow budget for gate()" },
      };
    }
    try {
      const result = await deps.gateRunner(a.cmd, {
        ...(typeof a.cwd === "string" ? { cwd: a.cwd } : {}),
        timeoutMs,
      });
      return { kind: "host_ack", id: callId, ok: true, value: result };
    } catch (e) {
      return { kind: "host_ack", id: callId, ok: false, error: { message: errMsg(e) } };
    }
  }

  deps.workerHost.events.onHostCall((envelope: HostCallEnvelope) => {
    if (terminated) {
      // Defense-in-depth, not the primary mechanism: once `terminate()`'s S5
      // has actually closed the host's end of the port (§2.3.1/WC09), a
      // message like this one can never be delivered here at all — this
      // branch only matters for the vanishingly narrow synchronous window
      // between `onTerminating` firing (S2) and S5 running, during which no
      // message delivery can happen anyway (JS has no preemption). Kept
      // anyway so a future refactor that widens that window fails safe
      // instead of silently answering a call from a workflow that already
      // decided to stop.
      deps.workerHost.send({
        kind: "host_ack",
        id: envelope.id,
        ok: false,
        cancelled: true,
        cause: "workflow_terminating",
      } satisfies HostAckEnvelope);
      return;
    }
    // HR2: every handler is double-sided-bounded — `hostCallMs` for `agent`'s
    // admission-only ack, `gateMs` for `gate`'s single-segment RPC — capped
    // by whatever workflow budget remains (never lets a handler outlive WT8).
    const opBudgetMs = envelope.op === "gate" ? budget.gateMs : budget.hostCallMs;
    const boundMs = Math.min(opBudgetMs, remainingWorkflowMs());
    // BW2: a workflow with zero (or negative) remaining budget is a distinct,
    // more specific condition than "the handler ran out of time" — report it
    // as such instead of letting `withDeadline(work, 0, ...)`'s ms<=0 fast
    // path win the race against `work` before it ever gets to run its own
    // BW2 check (core/deadline.ts's `withDeadline` resolves synchronously for
    // ms<=0 and only fires `p.catch()` on the real promise, discarding
    // whatever answer it would have produced).
    if (boundMs <= 0) {
      deps.workerHost.send({
        kind: "host_ack",
        id: envelope.id,
        ok: false,
        error: { message: "WorkflowBudgetExhausted: no remaining workflow budget to service this host call (BW2)" },
      } satisfies HostAckEnvelope);
      return;
    }
    const work =
      envelope.op === "agent" ? handleAgent(envelope.id, envelope.args) : handleGate(envelope.id, envelope.args);
    void withDeadline(work, boundMs, deps.clock, `host_call:${envelope.op}`).then((r) => {
      if (terminated) return; // avoid a duplicate ack racing the terminate()-driven one below.
      if (r.ok) {
        deps.workerHost.send(r.value);
      } else {
        deps.workerHost.send({
          kind: "host_ack",
          id: envelope.id,
          ok: false,
          error: { message: `host call '${envelope.op}' did not complete within ${boundMs}ms (HR2)` },
        } satisfies HostAckEnvelope);
      }
    });
  });

  // HR8: on terminate() (S2, before S5/S6 physically cut the port), reject
  // every call this host still has pending — both "ack never sent" (still in
  // admission, e.g. `spawner.spawn` hung) and "ack sent, settle never
  // pushed" (child still running when the workflow ended). `registry.cancel()`
  // on an active (pre_runner/running) call only *starts* the A2 bounded
  // retry loop — it deliberately does not settle the call synchronously
  // (CR7: that loop must not be forced to resolve instantly in the general
  // case). HR8 is a stronger requirement than CR7: once the *workflow itself*
  // is terminating, nothing may be left pending — so this handler explicitly
  // force-settles every still-active call the instant `terminate()` fires,
  // instead of waiting for the (now-moot, since the workflow is over) retry
  // loop to eventually give up on its own on the `cancelRetryWindowMs` clock.
  deps.workerHost.events.onTerminating((reason) => {
    if (terminated) return; // WL3 after WL1/WL2 already ran via stopOwned() — everything is settled, avoid double-recording.
    terminated = true;
    clearAllPhaseTimers(); // WR4-equivalent: no armed timer may survive the workflow's own terminal decision.
    const cancelled = registry.cancelAll(reason);
    for (const callId of cancelled.withheld) settleWithheld(callId, reason);
    for (const callId of cancelled.retrying) forceSettleActive(callId, reason);
  });

  return {
    registry,
    get children() {
      return children;
    },
    get currentPhaseId() {
      return currentPhaseId;
    },
    get replayStats(): WorkflowReplayStats | undefined {
      if (!deps.journal) return undefined;
      return {
        hits: replayStats.hits,
        misses: replayStats.misses,
        skipped: replayStats.skipped,
        corruptLines: deps.journal.index.stats.corruptLines,
      };
    },
    cancelAllChildren(cause) {
      registry.cancelAll(cause);
    },
    async stopOwned(cause, graceMs) {
      if (terminated) return { orphanChildren: [] }; // idempotent (WI6): a prior stopOwned()/terminate() already ran.
      // WL1: close the gate *synchronously*, before anything else — no new
      // agent()/gate() admission can land after this point (onHostCall checks
      // the same `terminated` flag).
      terminated = true;
      clearAllPhaseTimers(); // same WR4-equivalent hygiene as onTerminating above.
      // WL2: cascade-cancel every still-active call (CallRegistry's bounded
      // retry loop +, if the caller supplied one, the core's own owner-stop
      // sweep — OS4).
      const cancelled = registry.cancelAll(cause);
      for (const callId of cancelled.withheld) settleWithheld(callId, cause);
      if (deps.spawner.stopChildrenOf && deps.parentRunId !== undefined) {
        try {
          await deps.spawner.stopChildrenOf(deps.parentRunId, cause);
        } catch {
          // Best-effort sweep (OS4) — CallRegistry's own per-call retry loop
          // (already started by cancelAll above) is the real safety net.
        }
      }
      // WT10 abortGraceMs: give still-active children a real chance to
      // settle for real (their own `handleAgent().then()` callback calls
      // `registry.settle`/`recordSettled` with the true outcome, which wakes
      // this wait immediately via `drainWaiters`) before WL4 gives up on
      // them. Bounded by a single timer — not polled.
      if (registry.listActive().length > 0) {
        await new Promise<void>((resolve) => {
          let settled = false;
          const timer = deps.clock.setTimer(Math.max(0, graceMs), () => {
            if (settled) return;
            settled = true;
            resolve();
          });
          drainWaiters.push(() => {
            if (settled) return;
            settled = true;
            deps.clock.clearTimer(timer);
            resolve();
          });
        });
      }
      // WL4 (reconcile, inline): anything still active after the grace window
      // is force-settled and reported as orphaned (RC3) rather than left
      // dangling in `children[]` with a non-terminal status (RC1).
      const orphanChildren: OrphanChildSummary[] = [];
      for (const active of registry.listActive()) {
        forceSettleActive(active.callId, cause);
        orphanChildren.push({
          callId: active.callId,
          ...(active.runId !== undefined ? { runId: active.runId } : {}),
          reason: "cancel_retry_exhausted",
          at: deps.clock.now(),
        });
      }
      return { orphanChildren };
    },
    async flushJournal(deadlineMs) {
      if (!deps.journal) return undefined;
      return deps.journal.store.flush(deps.journal.dir, deadlineMs);
    },
  };
}
