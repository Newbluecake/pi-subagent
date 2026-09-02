import { withDeadline } from "../core/deadline.js";
import type { Clock } from "../core/clock.js";
import type { RunId, RunOutcome, RunPhase, RunSnapshot, RunStatus, StopCause } from "../core/types.js";
import type { Runner, RunRegistry } from "./ports.js";

export type StopResult =
  | { ok: true; escalatedTo: "L2" | "L3" | "L4" }
  | { ok: false; reason: "unknown_run" }
  | { ok: false; reason: "already_terminal"; status: RunStatus }
  | { ok: false; reason: "stop_failed"; escalatedTo: "L2" | "L3" | "L4" };

export interface QueryService {
  get(runId: RunId): RunSnapshot | undefined;
  list(filter?: { status?: RunStatus[]; parentRunId?: RunId }): RunSnapshot[];
  wait(
    runId: RunId,
    opts?: { waitMs?: number; signal?: AbortSignal },
  ): Promise<{ ok: true; outcome: RunOutcome } | { ok: false; reason: "wait_timeout" | "aborted" | "unknown_run" }>;
  waitAll(opts?: { runIds?: RunId[]; waitMs?: number }): Promise<{ settled: RunOutcome[]; pending: RunId[] }>;
  steer(
    runId: RunId,
    text: string,
  ): Promise<{ ok: true } | { ok: false; reason: "not_running" | "steer_timeout" | "steer_rejected"; detail?: string }>;
  stop(runId: RunId, cause?: StopCause): Promise<StopResult>;
}
export interface QueryServiceDeps {
  registry: RunRegistry;
  runner: Runner;
  clock?: Clock;
  defaultWaitMs?: number;
}
const terminal = (status: RunStatus) =>
  status === "completed" || status === "failed" || status === "timed_out" || status === "aborted";
/**
 * Grace added on top of the awaited run's own deadline when deriving the
 * *default* wait budget: the run settles at deadlineAt, then needs abort
 * grace + reap + bookkeeping before its outcome lands in the registry. A
 * default wait should outlive that settlement, not race it.
 */
export const WAIT_SETTLEMENT_GRACE_MS = 30_000;
export function createQueryService(deps: QueryServiceDeps): QueryService {
  const clock = deps.clock ?? {
    now: () => Date.now(),
    setTimer: (ms: number, fn: () => void) => ({ id: setTimeout(fn, ms) as unknown as number }),
    clearTimer: (h: { id: number }) => clearTimeout(h.id),
  };
  return {
    get: (id) => deps.registry.get(id),
    list: (filter) => deps.registry.list(filter),
    async wait(id, opts = {}) {
      const snapshot = deps.registry.get(id);
      if (!snapshot) return { ok: false, reason: "unknown_run" };
      if (snapshot.outcome && terminal(snapshot.status)) return { ok: true, outcome: snapshot.outcome };
      // Default wait budget, in precedence order: explicit opts.waitMs →
      // dynamic "the awaited run's remaining lifetime + settlement grace"
      // (deadlineAt is absolute, set at enqueue — core/types.ts ①) → host
      // static default → hardcoded 30min. The dynamic default means a bare
      // wait normally settles WITH the run instead of timing out earlier
      // (e.g. a 2h timeout_ms run awaited under a 30min static default).
      const remaining =
        snapshot.deadlines.deadlineAt !== undefined
          ? Math.max(0, snapshot.deadlines.deadlineAt - clock.now()) + WAIT_SETTLEMENT_GRACE_MS
          : undefined;
      const waitMs = opts.waitMs ?? remaining ?? deps.defaultWaitMs ?? 1_800_000;
      const waiter = new Promise<RunOutcome>((resolve) => {
        const poll = () => {
          const current = deps.registry.get(id);
          if (current?.outcome && terminal(current.status)) resolve(current.outcome);
          else clock.setTimer(10, poll);
        };
        poll();
      });
      if (opts.signal?.aborted) return { ok: false, reason: "aborted" };
      const cancelled = new Promise<never>((_, reject) =>
        opts.signal?.addEventListener("abort", () => reject(new Error("aborted")), { once: true }),
      );
      const result = await withDeadline(Promise.race([waiter, cancelled]), waitMs, clock, "wait");
      if (result.ok) return { ok: true, outcome: result.value };
      if (result.reason === "error" && opts.signal?.aborted) return { ok: false, reason: "aborted" };
      return { ok: false, reason: result.reason === "error" ? "wait_timeout" : "wait_timeout" };
    },
    async waitAll(opts = {}) {
      const ids =
        opts.runIds ??
        deps.registry
          .list()
          .filter((s) => !terminal(s.status))
          .map((s) => s.runId);
      const results = await Promise.all(
        ids.map((id) => this.wait(id, opts.waitMs === undefined ? {} : { waitMs: opts.waitMs })),
      );
      const settled: RunOutcome[] = [];
      const pending: RunId[] = [];
      results.forEach((r, i) => (r.ok ? settled.push(r.outcome) : pending.push(ids[i]!)));
      return { settled, pending };
    },
    async steer(id, text) {
      const snapshot = deps.registry.get(id);
      if (!snapshot || snapshot.status !== "running" || !deps.runner.steer) return { ok: false, reason: "not_running" };
      try {
        await deps.runner.steer(id, text);
        return { ok: true };
      } catch (error) {
        return { ok: false, reason: "steer_rejected", detail: error instanceof Error ? error.message : String(error) };
      }
    },
    async stop(id, cause = "user_stop") {
      const snapshot = deps.registry.get(id);
      if (!snapshot) return { ok: false, reason: "unknown_run" };
      if (terminal(snapshot.status)) return { ok: false, reason: "already_terminal", status: snapshot.status };
      if (!deps.runner.abort) return { ok: false, reason: "stop_failed", escalatedTo: "L4" };
      try {
        const result = await deps.runner.abort(id, cause);
        if (result.ok) return { ok: true, escalatedTo: result.escalatedTo };
        const after = deps.registry.get(id);
        if (after && terminal(after.status)) return { ok: false, reason: "already_terminal", status: after.status };
        return { ok: false, reason: "stop_failed", escalatedTo: result.escalatedTo };
      } catch {
        return { ok: false, reason: "stop_failed", escalatedTo: "L4" };
      }
    },
  };
}
export type DiagnosticView = {
  runId: RunId;
  status: RunStatus;
  phase: RunPhase;
  pendingTools: number;
  staleInputs: number;
  degraded: number;
  orphaned: boolean;
};
