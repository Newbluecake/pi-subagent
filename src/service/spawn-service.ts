import { randomUUID } from "node:crypto";
import { mergeBudget } from "../config/settings.js";
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

export interface SpawnService {
  spawn(req: SpawnRequest): Promise<{ runId: RunId } | { error: ErrorInfo }>;
  spawnAndWait(req: SpawnRequest): Promise<RunOutcome>;
  abort(runId: RunId, cause?: StopCause): Promise<boolean>;
  waitAll(opts?: { runIds?: RunId[]; waitMs?: number }): Promise<{ settled: RunOutcome[]; pending: RunId[] }>;
}
export interface SpawnServiceDeps {
  types: AgentTypeRegistry;
  pool: SlotPool;
  runner: Runner;
  now?: () => number;
  budget?: Partial<DeadlineBudget>;
  onSnapshot?: (snapshot: RunSnapshot) => void;
  onLifecycle?: LifecycleSink;
  tombstones?: TombstoneStore;
  /** X3: hard cap on nested-delegation depth (top-level run = depth 0). Default 3. */
  maxNestedDepth?: number;
}
export function createSpawnService(deps: SpawnServiceDeps): SpawnService & { snapshots(): readonly RunSnapshot[] } {
  const now = deps.now ?? (() => Date.now());
  const maxNestedDepth = deps.maxNestedDepth ?? 3;
  const records = new Map<RunId, RunSnapshot>();
  const outcomes = new Map<RunId, RunOutcome>();
  const waits = new Map<RunId, Set<(outcome: RunOutcome) => void>>();
  const running = new Set<RunId>();
  const resumeLocks = new Set<string>();
  const labels = new Map<string, RunId>();
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
          diag: outcome.diag,
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
  };
  const start = async (
    req: SpawnRequest,
    runId: RunId,
    config: NonNullable<ReturnType<AgentTypeRegistry["get"]>>,
    budget: DeadlineBudget,
    resumeLockKeys: readonly string[] = [],
    depth = 0,
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
        ...((req.modelOverride ?? config.model) ? { model: req.modelOverride ?? config.model } : {}),
        budget,
        depth,
      };
      const outcome = await deps.runner.run(spec, {
        ...(deps.onLifecycle ? { onLifecycle: deps.onLifecycle } : {}),
        onSnapshot: (s) => {
          records.set(runId, s);
          deps.onSnapshot?.(s);
        },
      });
      finish(outcome);
    } catch (error) {
      finish({
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
      });
    } finally {
      // Release every key acquired at spawn time (targetId AND sessionFile) —
      // deleting only req.resumeFrom leaks the targetId lock forever once
      // resumeFrom has been rewritten to the session file (P1: repeat-resume
      // of the same session was permanently rejected).
      for (const key of resumeLockKeys) resumeLocks.delete(key);
    }
  };
  const service: SpawnService & { snapshots(): readonly RunSnapshot[] } = {
    async spawn(req) {
      const config = deps.types.get(req.type);
      if (!config) return { error: { kind: "config", message: `unknown agent type: ${req.type}`, retryable: false } };
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
      if (req.resumeFrom) {
        const targetId = labels.get(req.resumeFrom) ?? req.resumeFrom;
        if (running.has(targetId))
          return {
            error: {
              kind: "config",
              message: `run ${targetId} is still running; use steer_subagent instead`,
              retryable: false,
            },
          };
        if (resumeLocks.has(targetId))
          return {
            error: { kind: "config", message: `run ${targetId} already has a resume in progress`, retryable: false },
          };
        const tombstone = tombstones.resolve(targetId);
        if (!tombstone)
          return {
            error: {
              kind: "config",
              message: `resume target not found or expired: ${req.resumeFrom}`,
              retryable: false,
            },
          };
        resumeLocks.add(targetId);
        resumeLocks.add(tombstone.sessionFile);
        resolvedReq = { ...req, resumeFrom: tombstone.sessionFile };
        lockKeys = [targetId, tombstone.sessionFile];
      }
      const runId = randomUUID();
      const budget = mergeBudget(deps.budget, config.budgetOverride, req.budgetOverride);
      if (req.label) labels.set(req.label, runId);
      nesting.set(runId, { depth, ...(config.canSpawn ? { canSpawn: config.canSpawn } : {}) });
      if (req.parentRunId) {
        parentOf.set(runId, req.parentRunId);
        const siblings = childrenOf.get(req.parentRunId) ?? new Set<RunId>();
        siblings.add(runId);
        childrenOf.set(req.parentRunId, siblings);
      }
      void start(resolvedReq, runId, config, budget, lockKeys, depth);
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
      return result;
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
      const children = [...(childrenOf.get(runId) ?? [])].filter((c) => running.has(c));
      if (children.length) await Promise.all(children.map((c) => service.abort(c, "parent_abort")));
      if (deps.runner.abort) return (await deps.runner.abort(runId, cause)).ok;
      return false;
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
    snapshots: () => [...records.values()],
  };
  return service;
}
