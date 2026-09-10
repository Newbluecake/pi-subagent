import type { Clock } from "./clock.js";
import { toErrorInfo } from "./errors.js";
import { isTerminalStatus } from "./status.js";
import type { DeadlineBudget, ErrorInfo, Millis, RunDeadlines, RunDiagnostics, RunPhase, RunState } from "./types.js";
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
  totalGraceMs: 90_000,
  maxExtensions: 3,
  maxTotalFactor: 2,
};
/**
 * set_model 的固定上界：切换只等 pi 的一次 auth 校验 + 状态写入，与 run 预算无关
 * （per-run budget 只在 run() 内可见），故不进 DeadlineBudget。与 steerMs 同取 5s
 * （一次 provider 往返的量级），理由各自独立（plan m1：steerRun 无界是已知缺陷）。
 */
export const SET_MODEL_TIMEOUT_MS = 5_000;
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

/** 相位集合：既是“可进宽限”也是“可延长”（D-14）。state-machine 复用同一常量，不许各写各的。 */
export const OVERTIME_PHASES: readonly RunPhase[] = [
  "prompt_dispatch",
  "model_turn",
  "tool_exec",
  "retry_backoff",
  "compaction",
];

/** 当前生效的总截止：宽限中取 graceUntil，否则取 deadlineAt。所有 timer/guard 计算的唯一入口。 */
export function effectiveDeadlineAt(d: RunDeadlines): Millis | undefined {
  return d.graceUntil ?? d.deadlineAt;
}

/**
 * spawn-service 在 mergeBudget 之后、传给 runner 之前调用一次（D-10 / D-16）。
 * - explicitTotal：per-spawn 覆盖了 totalMs ⇒ 硬顶：maxTotalFactor = 1（H = deadlineAt ⇒ no_headroom ⇒ 无宽限无延长）
 * - extensionsEnabled = false：maxExtensions = 0（宽限与延长一并关闭，任何层的覆盖都盖不回来）
 */
export function applyBudgetPolicy(
  budget: DeadlineBudget,
  opts: { explicitTotal: boolean; extensionsEnabled: boolean },
): DeadlineBudget {
  let out = budget;
  if (opts.explicitTotal && out.maxTotalFactor !== 1) out = { ...out, maxTotalFactor: 1 };
  if (!opts.extensionsEnabled && out.maxExtensions !== 0) out = { ...out, maxExtensions: 0 };
  return out;
}

/** enqueue 时算一次。totalMs ≤ 0 只可能来自绕过 mergeBudget 的直接输入（测试）⇒ 防御性返回 undefined（D-11）。 */
export function hardDeadlineAtFor(
  enqueuedAt: Millis,
  budget: DeadlineBudget,
  capAt: Millis | undefined,
): Millis | undefined {
  if (!(budget.totalMs > 0)) return undefined;
  const factor = Math.max(1, budget.maxTotalFactor);
  const raw = enqueuedAt + Math.ceil(budget.totalMs * factor);
  return capAt === undefined ? raw : Math.min(raw, capAt);
}

/**
 * 延长/宽限的唯一判定口径：reducer 用它做决策，runner/工具层用它生成拒绝理由。
 * 一份逻辑两处消费，不允许各写各的。
 */
export function extendability(
  state: RunState,
  budget: DeadlineBudget,
  now: Millis,
):
  | { ok: true; headroomMs: Millis }
  | {
      ok: false;
      reason: "already_terminal" | "stopping" | "not_started" | "uncapped" | "limit_reached" | "no_headroom";
    } {
  if (isTerminalStatus(state.status)) return { ok: false, reason: "already_terminal" };
  if (state.phase === "abort_grace" || state.phase === "reap") return { ok: false, reason: "stopping" };
  if (!OVERTIME_PHASES.includes(state.phase)) return { ok: false, reason: "not_started" }; // D-14
  const { deadlineAt, hardDeadlineAt } = state.deadlines;
  if (deadlineAt === undefined || hardDeadlineAt === undefined) return { ok: false, reason: "uncapped" }; // 防御
  if ((state.diag.overtime?.extensions ?? 0) >= budget.maxExtensions) return { ok: false, reason: "limit_reached" };
  const headroom = hardDeadlineAt - Math.max(now, deadlineAt);
  if (headroom <= 0) return { ok: false, reason: "no_headroom" }; // 含 D-10：显式预算 run 恒落此处
  return { ok: true, headroomMs: headroom };
}

/** 宽限窗口：夹在硬天花板之内（D-7）。返回 undefined = 没有可用宽限。 */
export function graceWindow(state: RunState, budget: DeadlineBudget, at: Millis): Millis | undefined {
  if (budget.totalGraceMs <= 0) return undefined;
  if (!extendability(state, budget, at).ok) return undefined; // D-6：没额度就不宽限；D-14：非 OVERTIME 相位不宽限
  const h = state.deadlines.hardDeadlineAt!; // extendability ok ⇒ 非 undefined
  const until = Math.min(at + budget.totalGraceMs, h);
  return until > at ? until : undefined;
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
