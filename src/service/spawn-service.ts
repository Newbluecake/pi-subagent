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
}
export function createSpawnService(deps: SpawnServiceDeps): SpawnService & { snapshots(): readonly RunSnapshot[] } {
  const now = deps.now ?? (() => Date.now());
  const records = new Map<RunId, RunSnapshot>();
  const outcomes = new Map<RunId, RunOutcome>();
  const waits = new Map<RunId, Set<(outcome: RunOutcome) => void>>();
  const running = new Set<RunId>();
  const resumeLocks = new Set<string>();
  const labels = new Map<string, RunId>();
  const tombstones = deps.tombstones ?? new TombstoneStore(30 * 60 * 1000, now);
  const terminal = (s: string) => ["completed", "failed", "timed_out", "aborted"].includes(s);
  const finish = (outcome: RunOutcome) => {
    outcomes.set(outcome.runId, outcome);
    running.delete(outcome.runId);
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
      if (req.resumeFrom) resumeLocks.delete(req.resumeFrom);
    }
  };
  const service: SpawnService & { snapshots(): readonly RunSnapshot[] } = {
    async spawn(req) {
      const config = deps.types.get(req.type);
      if (!config) return { error: { kind: "config", message: `unknown agent type: ${req.type}`, retryable: false } };
      let resolvedReq = req;
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
      }
      const runId = randomUUID();
      const budget = mergeBudget(deps.budget, config.budgetOverride, req.budgetOverride);
      if (req.label) labels.set(req.label, runId);
      void start(resolvedReq, runId, config, budget);
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
