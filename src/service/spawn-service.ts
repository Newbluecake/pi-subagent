import { mergeBudget } from "../config/settings.js";
import { newRunId, isRunId } from "../core/ids.js";
import { toErrorInfo } from "../core/errors.js";
import type { AgentTypeRegistry } from "../config/agent-types.js";
import type {
  DeadlineBudget,
  ErrorInfo,
  RunId,
  RunOutcome,
  RunSnapshot,
  SpawnRequest,
  StopCause,
} from "../core/types.js";
import type { LifecycleSink, Runner, RunnerSpec, SlotPool } from "./ports.js";
import { TombstoneStore } from "./tombstone.js";
import {
  resolveResumeTarget,
  resolveRunId,
  type ResolveResumeResult,
  type ResolveRunResult,
} from "./resolve-target.js";

export interface SpawnLabelTarget {
  readonly runId: RunId;
  readonly type: SpawnRequest["type"];
}
export type BoundedWaitResult = { kind: "settled"; outcome: RunOutcome } | { kind: "pending" };
export interface SpawnService {
  spawn(req: SpawnRequest): Promise<{ runId: RunId } | { error: ErrorInfo }>;
  spawnAndWait(req: SpawnRequest): Promise<RunOutcome>;
  waitOutcome(runId: RunId, waitMs?: number): Promise<BoundedWaitResult>;
  markAutoBackgrounded(runId: RunId): void;
  abort(runId: RunId, cause?: StopCause): Promise<boolean>;
  waitAll(opts?: { runIds?: RunId[]; waitMs?: number }): Promise<{ settled: RunOutcome[]; pending: RunId[] }>;
  /** Resolve a label without exposing the mutable internal index. */
  getLabel?(label: string): SpawnLabelTarget | undefined;
  /** Resolve model-facing run handles to their canonical process-local id. */
  resolveRun(handle: string): ResolveRunResult;
  /** Resolve a model-facing resume handle to an owned, existing session file. */
  resolveResume(handle: string): ResolveResumeResult;
  /**
   * CC1 (workflow design §8.2 / §3.7 OS1–OS4): the only owner-stop entry
   * point for a caller whose own id is never a tracked run (e.g. a future
   * workflow orchestrator's `WorkflowId` — it has no session/RunState, so
   * `abort(workflowId)` would return `false` at its first-line `!running.has`
   * guard without ever cascading). Reuses the exact same recursive cascade
   * `abort()` already performs (`cascadeChildren`) — there is only ever one
   * cascade implementation, never a second one (OS1).
   */
  stopChildrenOf(parentId: RunId, cause?: StopCause): Promise<{ stopped: RunId[]; pending: RunId[] }>;
}
export interface SpawnServiceDeps {
  types: AgentTypeRegistry;
  pool: SlotPool;
  runner: Runner;
  now?: () => number;
  budget?: Partial<DeadlineBudget>;
  onSnapshot?: (snapshot: RunSnapshot) => void;
  onLifecycle?: LifecycleSink;
  onOutcomeConsumed?: (outcome: RunOutcome) => void;
  notifyTerminalFailure?: (outcome: RunOutcome) => void;
  /** X6 bridge: fired when a label is first registered (mention registry feed). */
  onLabel?: (label: string, target: SpawnLabelTarget) => void;
  tombstones?: TombstoneStore;
  /** X3: hard cap on nested-delegation depth (top-level run = depth 0). Default 3. */
  maxNestedDepth?: number;
  /**
   * Fuzzy model-hint resolution (frontmatter `model:` non-pair value or the
   * Agent tool's free-form `model` param), wired in stack.ts over pi's
   * model registry. Undefined = hints cannot resolve and are rejected with
   * a config error (fail-closed, never silently inherited).
   */
  resolveModelHint?: (hint: string) => { provider: string; id: string } | undefined;
}
export function createSpawnService(deps: SpawnServiceDeps): SpawnService & { snapshots(): readonly RunSnapshot[] } {
  const now = deps.now ?? (() => Date.now());
  const maxNestedDepth = deps.maxNestedDepth ?? 3;
  const records = new Map<RunId, RunSnapshot>();
  const outcomes = new Map<RunId, RunOutcome>();
  const waits = new Map<RunId, Set<(outcome: RunOutcome) => void>>();
  const autoBackgroundedAt = new Map<RunId, number>();
  const running = new Set<RunId>();
  const resumeLocks = new Set<string>();
  const labels = new Map<string, SpawnLabelTarget>();
  const tombstones = deps.tombstones ?? new TombstoneStore(30 * 60 * 1000, now);
  // X3: nested-delegation bookkeeping. `nesting` holds, for every currently
  // *running* top-level or nested run, the depth it was spawned at plus the
  // canSpawn whitelist of its own agent type (i.e. what it, in turn, is
  // allowed to spawn) — this is the authoritative enforcement point,
  // independent of (and in addition to) the injected nested Agent tool's own
  // check in tools/agent-tool.ts. `childrenOf`/`parentOf` track the run tree
  // purely for cascading abort; both are cleaned up as runs finish so they
  // never grow past the number of currently-running nested runs.
  const nesting = new Map<RunId, { depth: number; canSpawn?: string[] }>();
  const childrenOf = new Map<RunId, Set<RunId>>();
  const parentOf = new Map<RunId, RunId>();
  const targetDeps = () => ({
    labels,
    liveSnapshots: () => [...records.values()],
    records: () => [...records.values()],
    tombstones,
    now,
  });
  const resolveRun = (handle: string) => resolveRunId(handle, targetDeps());
  const resolveResume = (handle: string) => resolveResumeTarget(handle, targetDeps());
  const terminal = (s: string) => ["completed", "failed", "timed_out", "aborted"].includes(s);
  const finish = (outcome: RunOutcome) => {
    outcomes.set(outcome.runId, outcome);
    running.delete(outcome.runId);
    nesting.delete(outcome.runId);
    const parent = parentOf.get(outcome.runId);
    if (parent !== undefined) {
      parentOf.delete(outcome.runId);
      const siblings = childrenOf.get(parent);
      if (siblings) {
        siblings.delete(outcome.runId);
        if (siblings.size === 0) childrenOf.delete(parent);
      }
    }
    const snapshot = outcome.diag
      ? ({
          runId: outcome.runId,
          generation: outcome.diag.generation,
          status: outcome.status,
          phase: "settled",
          deadlines: {
            enqueuedAt: outcome.diag.enqueuedAt ?? outcome.diag.createdAt,
            deadlineAt: outcome.diag.deadlineAt,
            queueDeadlineAt: undefined,
          },
          diag: {
            ...outcome.diag,
            ...(outcome.diag.autoBackgroundedAt !== undefined
              ? { autoBackgroundedAt: outcome.diag.autoBackgroundedAt }
              : records.get(outcome.runId)?.diag.autoBackgroundedAt !== undefined
                ? { autoBackgroundedAt: records.get(outcome.runId)!.diag.autoBackgroundedAt }
                : autoBackgroundedAt.has(outcome.runId)
                  ? { autoBackgroundedAt: autoBackgroundedAt.get(outcome.runId) }
                  : {}),
          },
          outcome,
          updatedAt: now(),
        } satisfies RunSnapshot)
      : undefined;
    if (snapshot) {
      records.set(outcome.runId, snapshot);
      tombstones.register(snapshot);
      deps.onSnapshot?.(snapshot);
    }
    for (const resolve of waits.get(outcome.runId) ?? []) resolve(outcome);
    waits.delete(outcome.runId);
    autoBackgroundedAt.delete(outcome.runId);
  };
  const start = async (
    req: SpawnRequest,
    runId: RunId,
    config: NonNullable<ReturnType<AgentTypeRegistry["get"]>>,
    budget: DeadlineBudget,
    resumeLockKeys: readonly string[] = [],
    depth = 0,
    // Resolved at spawn admission (strict pair or fuzzy hint, request
    // override winning over the type's config) — start() itself never
    // re-derives it from req/config.
    model?: { provider: string; id: string },
  ) => {
    running.add(runId);
    try {
      const spec: RunnerSpec = {
        runId,
        type: config,
        // Extensions (X1 worktree) key side effects off the run id; give them
        // a deterministic one instead of a label fallback.
        request: { ...req, runId },
        ...(req.cwd ? { cwd: req.cwd } : {}),
        ...(model ? { model } : {}),
        budget,
        depth,
      };
      const outcome = await deps.runner.run(spec, {
        ...(deps.onLifecycle ? { onLifecycle: deps.onLifecycle } : {}),
        onSnapshot: (s) => {
          const markedAt = autoBackgroundedAt.get(runId);
          if (markedAt !== undefined) s.diag.autoBackgroundedAt = markedAt;
          records.set(runId, s);
          deps.onSnapshot?.(s);
        },
      });
      finish(outcome);
    } catch (error) {
      const failed: RunOutcome = {
        runId,
        status: "failed",
        turns: 0,
        durationMs: 0,
        diag: {
          createdAt: now(),
          phase: "settled",
          phaseEnteredAt: now(),
          pendingTools: 0,
          turns: 0,
          escalation: [],
          orphaned: false,
          generation: 1,
          degraded: [],
          staleInputs: 0,
          unkillable: [],
        },
        error: toErrorInfo(error),
      };
      finish(failed);
      deps.notifyTerminalFailure?.(failed);
    } finally {
      // Release every key acquired at spawn time (targetId AND sessionFile) —
      // deleting only req.resumeFrom leaks the targetId lock forever once
      // resumeFrom has been rewritten to the session file (P1: repeat-resume
      // of the same session was permanently rejected).
      for (const key of resumeLockKeys) resumeLocks.delete(key);
    }
  };
  /**
   * CC1: extracted, byte-for-byte, from abort()'s pre-existing children loop
   * (the recursion below re-enters `service.abort`, which is what actually
   * disambiguates already-finished/never-started children via `running.has`
   * — unchanged from before this extraction). Both `abort()` and the new
   * `stopChildrenOf()` call this and nothing else; there is exactly one
   * cascade implementation (OS1/OS3).
   */
  async function cascadeChildren(runId: RunId, cause: StopCause): Promise<RunId[]> {
    const children = [...(childrenOf.get(runId) ?? [])].filter((c) => running.has(c));
    if (children.length) await Promise.all(children.map((c) => service.abort(c, cause)));
    return children;
  }
  const service: SpawnService & { snapshots(): readonly RunSnapshot[] } = {
    async spawn(req) {
      // CC4/CP1 (workflow design §4.4.1 F2, CP1-a/b/c): must be the first
      // statement in spawn() — strictly before ANY mutable state write
      // (resumeLocks/labels/nesting/parentOf/childrenOf/running below). A
      // rejected resume request must never write a resumeLocks entry that
      // only `start()`'s `finally` would ever clean up (that path never runs
      // for a request rejected here), which would otherwise permanently lock
      // out the resume target (same failure class as the already-fixed
      // "leaks the targetId lock forever" bug in this file). Zero side
      // effects: no runId, no index writes, no H2, no worktree, no slot.
      if (req.deadlineAt !== undefined && req.deadlineAt <= now())
        return { error: { kind: "config", message: "deadlineAt already expired", retryable: false } };
      const config = deps.types.get(req.type);
      if (!config) {
        // Self-correcting error: list the valid names so a model that missed
        // (or predates) the system-prompt type section recovers in one turn
        // instead of burning turns on trial-and-error guesses.
        const known = deps.types.list().map((t) => t.name);
        const hint = known.length ? `Valid types: ${known.join(", ")}` : "No agent types are registered.";
        return { error: { kind: "config", message: `unknown agent type: ${req.type}. ${hint}`, retryable: false } };
      }
      // Model-hint admission check (fuzzy frontmatter `model:` / Agent tool
      // `model` param). Strict provider/id pairs pass through untouched and
      // are validated later by the session driver's registry lookup; only
      // hints need resolving here, and an unresolvable hint is rejected
      // BEFORE any mutable state write (same admission discipline as the
      // resume/CC4 checks) instead of settling as a failed run — and never
      // silently downgraded to the parent/default model.
      let admittedModel = req.modelOverride ?? config.model;
      if (!admittedModel) {
        const modelHint = req.modelHintOverride ?? config.modelHint;
        if (modelHint) {
          const resolved = deps.resolveModelHint?.(modelHint);
          if (!resolved)
            return {
              error: {
                kind: "config",
                message: `unknown model hint: "${modelHint}" — pass a strict provider/id, or a bare id/substring of an available model (pi /model lists what's available)`,
                retryable: false,
              },
            };
          admittedModel = resolved;
        }
      }
      // X3: nesting depth + canSpawn whitelist. Authoritative for real
      // nested chains produced by the injected nested Agent tool, whose
      // parentRunId always names a currently-tracked, still-running entry
      // (the tool only exists inside an active session). `parentRunId` is
      // NOT a model-facing parameter of the top-level Agent tool, so an
      // untracked/foreign parentRunId cannot originate from tool-call input
      // — it is either a stale/finished reference or a caller using
      // `parentRunId` purely as a display label (pre-X3 usage, still
      // supported); neither case is a nested-delegation privilege
      // escalation, so it is left unrestricted (depth 0, no canSpawn cap)
      // rather than rejected. The check below only fires when the parent IS
      // currently tracked, i.e. it is a real, live nesting relationship.
      let depth = 0;
      if (req.parentRunId) {
        const parent = nesting.get(req.parentRunId);
        if (parent) {
          if (!parent.canSpawn?.includes(req.type))
            return {
              error: {
                kind: "config",
                message: `nested delegation is not permitted: parent's agent type may only spawn [${(parent.canSpawn ?? []).join(", ")}], not "${req.type}"`,
                retryable: false,
              },
            };
          depth = parent.depth + 1;
          if (depth > maxNestedDepth)
            return {
              error: {
                kind: "config",
                message: `nested delegation depth ${depth} exceeds the configured maximum (${maxNestedDepth})`,
                retryable: false,
              },
            };
        }
      }
      let resolvedReq = req;
      let lockKeys: string[] = [];
      const runId = newRunId((id) => records.has(id) || running.has(id) || tombstones.has(id));
      if (req.resumeFrom) {
        // Resolve once for the running hint, then resolve the owned session
        // file. Both calls are synchronous and this whole admission section
        // runs before the first await, so lock checks and writes are atomic
        // with respect to every other spawn() call in this process.
        const target = resolveRun(req.resumeFrom);
        if (!target.ok) {
          const resume = resolveResume(req.resumeFrom);
          return {
            error: { kind: "config", message: resume.ok ? target.error : resume.error, retryable: false },
          };
        }
        const targetId = target.runId;
        if (running.has(targetId))
          return {
            error: {
              kind: "config",
              message: `run ${targetId} is still running; use steer_subagent instead`,
              retryable: false,
            },
          };
        const resume = resolveResume(req.resumeFrom);
        if (!resume.ok) return { error: { kind: "config", message: resume.error, retryable: false } };
        if (resumeLocks.has(targetId) || resumeLocks.has(resume.sessionFile))
          return {
            error: { kind: "config", message: `run ${targetId} already has a resume in progress`, retryable: false },
          };
        resumeLocks.add(targetId);
        resumeLocks.add(resume.sessionFile);
        resolvedReq = { ...req, resumeFrom: resume.sessionFile };
        lockKeys = [targetId, resume.sessionFile];
      }
      const budget = mergeBudget(deps.budget, config.budgetOverride, req.budgetOverride);
      if (req.label && isRunId(req.label)) {
        console.warn(`[pi-subagent] label "${req.label}" looks like a run id; not registering it as a label`);
      } else if (req.label && !labels.has(req.label)) {
        labels.set(req.label, { runId, type: req.type });
        deps.onLabel?.(req.label, { runId, type: req.type });
      } else if (req.label) {
        console.warn(`[pi-subagent] label conflict for "${req.label}"; keeping the first registration`);
      }
      nesting.set(runId, { depth, ...(config.canSpawn ? { canSpawn: config.canSpawn } : {}) });
      if (req.parentRunId) {
        parentOf.set(runId, req.parentRunId);
        const siblings = childrenOf.get(req.parentRunId) ?? new Set<RunId>();
        siblings.add(runId);
        childrenOf.set(req.parentRunId, siblings);
      }
      void start(resolvedReq, runId, config, budget, lockKeys, depth, admittedModel);
      return { runId };
    },
    async spawnAndWait(req) {
      const started = await service.spawn(req);
      if ("error" in started) throw new Error(started.error.message);
      const result = await new Promise<RunOutcome>((resolve) => {
        const done = outcomes.get(started.runId);
        if (done) resolve(done);
        else {
          const set = waits.get(started.runId) ?? new Set();
          set.add(resolve);
          waits.set(started.runId, set);
        }
      });
      try {
        deps.onOutcomeConsumed?.(result);
      } catch {
        // Best effort only; consumption must not alter the returned outcome.
      }
      return result;
    },
    async waitOutcome(runId, waitMs) {
      const done = outcomes.get(runId);
      if (done) return { kind: "settled", outcome: done };
      return new Promise<BoundedWaitResult>((resolve) => {
        let settledFlag = false;
        let timer: ReturnType<typeof setTimeout> | undefined;
        const set = waits.get(runId) ?? new Set<(outcome: RunOutcome) => void>();
        const waiter = (outcome: RunOutcome) => {
          if (settledFlag) return;
          cleanup();
          resolve({ kind: "settled", outcome });
        };
        const cleanup = () => {
          if (settledFlag) return;
          settledFlag = true;
          if (timer !== undefined) clearTimeout(timer);
          set.delete(waiter);
          if (set.size === 0) waits.delete(runId);
        };
        set.add(waiter);
        waits.set(runId, set);
        if (waitMs !== undefined) {
          timer = setTimeout(() => {
            if (settledFlag) return;
            cleanup();
            const late = outcomes.get(runId);
            resolve(late ? { kind: "settled", outcome: late } : { kind: "pending" });
          }, waitMs);
          (timer as { unref?: () => void }).unref?.();
        }
      });
    },
    markAutoBackgrounded(runId) {
      if (!running.has(runId)) return;
      const markedAt = now();
      autoBackgroundedAt.set(runId, markedAt);
      const live = records.get(runId);
      if (live) {
        live.diag.autoBackgroundedAt = markedAt;
        deps.onSnapshot?.(live);
      }
    },
    async abort(runId, cause = "user_stop") {
      if (!running.has(runId)) return false;
      // X3: cascade to nested children before/alongside aborting this run
      // itself. Recurses through `service.abort` so grandchildren are
      // reached too; idempotent against the double-hop that also arrives via
      // RunnerDeps.onChildAbort (runtime/runner.ts → index.ts wiring) once
      // this run's own cancellation actually fires — `running.has()` /
      // createCancelHandle's already-aborted guard make the second pass a
      // no-op rather than an infinite loop.
      await cascadeChildren(runId, "parent_abort");
      if (deps.runner.abort) return (await deps.runner.abort(runId, cause)).ok;
      return false;
    },
    async stopChildrenOf(parentId, cause = "parent_abort") {
      // CC1 (OS1/OS2): the only owner-stop entry point that works when
      // `parentId` itself is not (and never will be) a tracked run — unlike
      // abort(), this never calls `running.has(parentId)` and never calls
      // `deps.runner.abort` on `parentId`. Reuses the identical cascade
      // abort() uses; the only difference is the guard swapped from
      // `running.has` to "does this id have any children at all".
      const stopped = await cascadeChildren(parentId, cause);
      // OS4: snapshot taken AFTER the cascade attempt, for the caller's own
      // sweep pass — children that hadn't actually finished yet (still
      // tracked in childrenOf; cascadeChildren's fire of `service.abort` does
      // not itself remove them, only their eventual `finish()` does).
      const pending = [...(childrenOf.get(parentId) ?? [])];
      return { stopped, pending };
    },
    async waitAll(opts = {}) {
      const ids = opts.runIds ?? [...running];
      const settled: RunOutcome[] = [];
      const pending: RunId[] = [];
      await Promise.all(
        ids.map(async (id) => {
          const result = await new Promise<RunOutcome | undefined>((resolve) => {
            const done = outcomes.get(id);
            if (done) return resolve(done);
            const set = waits.get(id) ?? new Set();
            set.add(resolve as (o: RunOutcome) => void);
            waits.set(id, set);
            if (opts.waitMs !== undefined) setTimeout(() => resolve(undefined), opts.waitMs);
          });
          if (result) settled.push(result);
          else pending.push(id);
        }),
      );
      return { settled, pending };
    },
    getLabel: (label) => labels.get(label),
    resolveRun,
    resolveResume,
    snapshots: () => [...records.values()],
  };
  return service;
}
