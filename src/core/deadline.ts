import type { Clock } from "./clock.js";
import { toErrorInfo } from "./errors.js";
import type { DeadlineBudget, ErrorInfo, Millis, RunDeadlines, RunDiagnostics, RunPhase } from "./types.js";
export const DEFAULT_BUDGET: DeadlineBudget = {
  queueWaitMs: 600_000,
  startupMs: 30_000,
  bindMs: 60_000,
  firstEventMs: 120_000,
  idleMs: 240_000,
  toolMs: 600_000,
  compactionMs: 300_000,
  totalMs: 1_800_000,
  abortGraceMs: 10_000,
  steerMs: 5_000,
  reapMs: 5_000,
  startupRetries: 2,
  retrySlackMs: 5_000,
};
export function remainingFor(
  phaseBudgetMs: Millis,
  now: Millis,
  d: RunDeadlines,
): { ms: Millis; capped: "phase" | "total" } | { ms: 0; capped: "expired" } {
  const phase = Math.max(0, phaseBudgetMs);
  if (d.deadlineAt !== undefined) {
    const left = Math.max(0, d.deadlineAt - now);
    if (left <= 0) return { ms: 0, capped: "expired" };
    return left < phase ? { ms: left, capped: "total" } : { ms: phase, capped: "phase" };
  }
  return { ms: phase, capped: "phase" };
}
export function dueAtFor(phase: RunPhase, diag: RunDiagnostics, budget: DeadlineBudget): Millis | undefined {
  const start = diag.phaseEnteredAt;
  const ms =
    phase === "queue_wait"
      ? budget.queueWaitMs
      : phase === "resolve_config" || phase === "session_create"
        ? budget.startupMs
        : phase === "extension_bind"
          ? budget.bindMs
          : phase === "prompt_dispatch"
            ? budget.firstEventMs
            : phase === "model_turn"
              ? budget.idleMs
              : phase === "tool_exec"
                ? budget.toolMs
                : phase === "compaction"
                  ? budget.compactionMs
                  : phase === "abort_grace"
                    ? budget.abortGraceMs
                    : phase === "reap"
                      ? budget.reapMs
                      : undefined;
  return ms === undefined || ms === 0 ? undefined : start + ms;
}
export function idleDueAt(diag: RunDiagnostics, budget: DeadlineBudget): Millis {
  const base = diag.lastEventAt ?? diag.phaseEnteredAt;
  return base + budget.idleMs + (diag.retry?.delayMs ?? 0) + budget.retrySlackMs;
}
export type DeadlineResult<T> =
  { ok: true; value: T } | { ok: false; reason: "timeout" } | { ok: false; reason: "error"; error: ErrorInfo };

/**
 * N6-2: a rejection of `p` is a genuine failure of the underlying operation, not
 * a timeout — it must be classified as reason:"error" (carrying the real error,
 * prefixed with `label` so callers can tell which awaited operation failed),
 * never silently folded into reason:"timeout". `label` is otherwise unused by
 * design (withDeadline itself never times anything by name), so it must show up
 * somewhere observable — it is threaded into the error message.
 */
export function withDeadline<T>(p: Promise<T>, ms: Millis, clock: Clock, label: string): Promise<DeadlineResult<T>> {
  if (ms <= 0) {
    p.catch(() => undefined);
    return Promise.resolve({ ok: false, reason: "timeout" });
  }
  return new Promise((resolve) => {
    let done = false;
    const timer = clock.setTimer(ms, () => {
      if (!done) {
        done = true;
        resolve({ ok: false, reason: "timeout" });
        p.catch(() => undefined);
      }
    });
    p.then(
      (value) => {
        if (!done) {
          done = true;
          clock.clearTimer(timer);
          resolve({ ok: true, value });
        }
      },
      (err: unknown) => {
        if (!done) {
          done = true;
          clock.clearTimer(timer);
          const info = toErrorInfo(err);
          resolve({ ok: false, reason: "error", error: { ...info, message: `${label}: ${info.message}` } });
        }
      },
    );
  });
}
