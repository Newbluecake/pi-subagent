import type { Clock } from "./clock.js";
import { toErrorInfo } from "./errors.js";
import type { DeadlineBudget, ErrorInfo, Millis, RunDeadlines, RunDiagnostics, RunPhase } from "./types.js";
export const DEFAULT_BUDGET: DeadlineBudget = {
  queueWaitMs: 600_000,
  startupMs: 30_000,
  bindMs: 60_000,
  firstEventMs: 120_000,
  idleMs: 240_000,
  modelTurnMs: 900_000,
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
  // model_turn 的双重约束（M4）：接线后若仍按 phaseEnteredAt+idleMs 一刀切，会误杀
  // 正常的长 thinking 轮次（大上下文 + thinking=high 单轮可达数分钟）；但涓流式
  // “活着但几乎不产出”的响应也不能无限续命。因此：
  //   静默超时 = lastEventAt + idleMs（持续产出 delta 的活跃流不会被误杀）
  //   硬上限   = phaseEnteredAt + modelTurnMs（单轮无论如何不得超过该值）
  // 两者取较早者；任一为 0 表示禁用该约束。
  if (phase === "model_turn") {
    const silence = budget.idleMs === 0 ? undefined : (diag.lastEventAt ?? start) + budget.idleMs;
    const cap = budget.modelTurnMs === 0 ? undefined : start + budget.modelTurnMs;
    if (silence === undefined) return cap;
    if (cap === undefined) return silence;
    return Math.min(silence, cap);
  }
  // retry_backoff（M4 修复盲区）：重试本身是有计划的等待，截止点必须覆盖当前
  // backoff 时长 + 宽限，再以 lastEventAt 为基准计静默——只有重试真正卡住
  // （backoff 结束后迟迟没有 retry_end/新事件）才应触发。
  if (phase === "retry_backoff") return idleDueAt(diag, budget);
  const ms =
    phase === "queue_wait"
      ? budget.queueWaitMs
      : phase === "resolve_config" || phase === "session_create"
        ? budget.startupMs
        : phase === "extension_bind"
          ? budget.bindMs
          : phase === "prompt_dispatch"
            ? budget.firstEventMs
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
