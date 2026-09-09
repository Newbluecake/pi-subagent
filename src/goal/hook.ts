/**
 * /goal 循环钩子（goal-plan v4 条件 5/MAJ-1）：挂在 `agent_settled`——唯一
 * 「无 retry/压缩/续跑待决」的信号。handler 内只做同步门检，评估统一为
 * fire-and-forget（v2 R1：await verifier 会阻塞 pi 的事件泵），完成后
 * `sendUserMessage(…, { deliverAs: "followUp" })` 起新 run。
 *
 * 关键机制（逐条对应 v4 放行条件）：
 * - 条件 1（BLK-1 急停）：agent_settled 无消息载荷，abort 检测靠 onAgentEnd
 *   记录末条 assistant 的 stopReason（abort 照常 emit agent_end/agent_settled，
 *   假设登记见 adapters/pi-compat.ts）；active 态遇 abort → 自动 paused + toast。
 * - 条件 3（BLK-3 刹车旁路）：evalCount 每次进入评估无条件 +1，上限 maxEvalsOf()。
 * - 条件 4（BLK-4 续跑投递）：sendUserMessage 无错误通道，投递看门狗
 *   （unref timer，默认 30s）未观察到新 run → 重试一次 → stopped("delivery-failed")。
 * - 条件 6（MAJ-2 预算口径）：cost.total 主口径 + token 仅 input+output；
 *   主会话消耗在 onAgentEnd 累加，verifier 成本经 RunOutcome.usage 计入。
 * - 条件 7（MAJ-4 epoch）：评估开始快照 epoch，每个 await 后与应用结果前校验。
 * - 条件 10（评估器硬化）：evalTimeoutMs 超时 race = 闩锁看门狗（强制解锁并计入
 *   连败）；unknown agent type → 降级 general + 内置 prompt（M-a），WARN 一次。
 */

import type { AgentEndEvent, AgentSettledEvent, ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { RunOutcome, SpawnRequest } from "../core/types.js";
import {
  budgetBrakeReason,
  maxEvalsOf,
  transition,
  type GoalEvent,
  type GoalRecord,
  type GoalSession,
  type GoalStopReason,
} from "./state.js";
import {
  buildAchievedText,
  buildBrakeReportText,
  buildContinuationText,
  buildGeneralEvaluatorPrompt,
  buildVerifierPrompt,
  GOAL_EVAL_SCHEMA,
  goalBadgeText,
  stopReasonLabel,
} from "./texts.js";

export interface GoalExecResult {
  code: number;
  killed: boolean;
  stdout?: string;
  stderr?: string;
}

export interface GoalTimerHandle {
  cancel(): void;
}

export interface GoalHookStack {
  goal?: GoalSession;
  spawn?: { spawnAndWait(req: SpawnRequest): Promise<RunOutcome> };
}

export interface GoalHookDeps {
  /** until-cmd 执行口（C2：index.ts 绑定 pi.exec("bash", ["-c", cmd], …)）。 */
  exec(cmd: string, opts: { timeoutMs: number; cwd: string }): Promise<GoalExecResult>;
  /** 续跑/报告注入（index.ts 绑定 deliverAs:"followUp"，v4 条件 4 ①）。 */
  sendUserMessage(text: string): void;
  /** 状态落盘（store.persistGoalRecord 绑定到 pi.appendEntry）。 */
  persist(record: GoalRecord): void;
  now?: () => number;
  warn?: (message: string) => void;
  /** 可注入计时器（默认 setTimeout + unref，仓库铁律）。测试用手动触发。 */
  startTimer?: (ms: number, fn: () => void) => GoalTimerHandle;
}

export interface GoalLoopHook {
  onAgentEnd(event: AgentEndEvent): void;
  onAgentSettled(event: AgentSettledEvent, ctx: ExtensionContext): void;
}

interface Verdict {
  met: boolean;
  gap?: string;
}

class EvalTimeoutError extends Error {
  constructor() {
    super("goal evaluation timed out");
    this.name = "EvalTimeoutError";
  }
}

export function createGoalLoopHook(holder: { current?: GoalHookStack }, deps: GoalHookDeps): GoalLoopHook {
  const now = deps.now ?? (() => Date.now());
  const warn = deps.warn ?? ((message: string) => console.warn(`[pi-subagent] ${message}`));
  const startTimer =
    deps.startTimer ??
    ((ms: number, fn: () => void): GoalTimerHandle => {
      const timer = setTimeout(fn, ms);
      // 仓库铁律：ref'd timer 会楔死 pi -p（print 模式），一律 unref。
      (timer as { unref?: () => void }).unref?.();
      return { cancel: () => clearTimeout(timer) };
    });

  /** 评估 in-flight 闩锁（防抖三件套之一，compact-hint forcing 同款）。 */
  let evalInFlight = false;
  /** onAgentEnd 记录的末条 assistant stopReason（abort 检测，v4 条件 1）。 */
  let lastStopReason: string | undefined;
  let deliveryTimer: GoalTimerHandle | undefined;
  let verifierFallbackWarned = false;

  const updateBadge = (ctx: ExtensionContext, record: GoalRecord | undefined) => {
    try {
      if (typeof ctx.ui?.setStatus === "function") ctx.ui.setStatus("goal", goalBadgeText(record));
    } catch {
      // 状态栏徽标是 best effort。
    }
  };
  const toast = (ctx: ExtensionContext, message: string, level: "info" | "warning" = "info") => {
    if (!ctx.hasUI) return;
    try {
      ctx.ui.notify(message, level);
    } catch {
      // best effort
    }
  };

  /** 应用一次状态迁移：成功则落新态 + epoch++（v4 条件 7）+ 落盘 + 徽标。 */
  const applyEvent = (ctx: ExtensionContext, record: GoalRecord, event: GoalEvent): boolean => {
    const next = transition(record.state, event, record.stopReason);
    if (!next) return false;
    record.state = next.phase;
    if (next.phase === "stopped" && next.stopReason !== undefined) record.stopReason = next.stopReason;
    else delete (record as { stopReason?: GoalStopReason }).stopReason;
    record.epoch += 1;
    deps.persist(record);
    updateBadge(ctx, record);
    return true;
  };

  /** epoch 校验贯穿评估全链路（v4 条件 7）：不等 / 非 active / 被替换 → 丢弃。 */
  const epochValid = (goal: GoalSession, record: GoalRecord, epoch: number): boolean =>
    holder.current?.goal === goal && goal.record === record && record.epoch === epoch && record.state === "active";

  /** 撞线/达成收尾：迁移 + 报告注入（不静默消失，v1 §4）+ toast。 */
  const stopGoal = (
    ctx: ExtensionContext,
    record: GoalRecord,
    event: { type: "achieved" } | { type: "brake"; reason: Exclude<GoalStopReason, "achieved"> },
  ) => {
    if (!applyEvent(ctx, record, event)) return;
    const reason = record.stopReason ?? "budget";
    toast(ctx, `/goal 已停止：${stopReasonLabel(reason)}`, reason === "achieved" ? "info" : "warning");
    try {
      deps.sendUserMessage(reason === "achieved" ? buildAchievedText(record) : buildBrakeReportText(record, reason));
    } catch {
      // sendUserMessage 无错误通道（v4 条件 4）；同步 throw 只可能是 host 失能。
    }
  };

  /**
   * 投递看门狗（v4 条件 4）：发出续跑后启动 unref timer，到期未观察到新 run
   * （isIdle 仍为真且分支无增长）→ 重试一次；再失败 → stopped("delivery-failed")。
   * epoch/状态在触发时校验，pause/clear/replace 天然使其失效。
   */
  const armDeliveryWatchdog = (
    ctx: ExtensionContext,
    goal: GoalSession,
    record: GoalRecord,
    epoch: number,
    text: string,
  ) => {
    deliveryTimer?.cancel();
    const branchLength = () => {
      try {
        return (ctx.sessionManager as { getBranch?: () => readonly unknown[] } | undefined)?.getBranch?.().length ?? 0;
      } catch {
        return 0;
      }
    };
    const baseline = branchLength();
    let retried = false;
    const arm = () => {
      deliveryTimer = startTimer(goal.settings.deliveryWatchdogMs, () => {
        if (!epochValid(goal, record, epoch)) return;
        const observed = (typeof ctx.isIdle === "function" && !ctx.isIdle()) || branchLength() > baseline;
        if (observed) return;
        if (!retried) {
          retried = true;
          warn("goal continuation delivery not observed; retrying once");
          try {
            deps.sendUserMessage(text);
          } catch {
            // 见 stopGoal 注释。
          }
          arm();
          return;
        }
        stopGoal(ctx, record, { type: "brake", reason: "delivery-failed" });
      });
    };
    arm();
  };

  /** 带超时的 Promise 包装（v4 条件 10：评估闩锁看门狗）。 */
  const withTimeout = <T>(promise: Promise<T>, ms: number): Promise<T> =>
    new Promise<T>((resolve, reject) => {
      const timer = startTimer(ms, () => reject(new EvalTimeoutError()));
      promise.then(
        (value) => {
          timer.cancel();
          resolve(value);
        },
        (error: unknown) => {
          timer.cancel();
          reject(error instanceof Error ? error : new Error(String(error)));
        },
      );
    });

  /** verifier 评估（D1-D4 + v4 条件 10/M-a）。基础设施失败一律 throw。 */
  const runVerifier = async (ctx: ExtensionContext, goal: GoalSession, record: GoalRecord): Promise<Verdict> => {
    const spawn = holder.current?.spawn;
    if (!spawn) throw new Error("spawn service unavailable");
    const settings = goal.settings;
    const request: SpawnRequest = {
      type: settings.verifierType,
      prompt: buildVerifierPrompt(record),
      label: `goal-eval-${record.evalCount}`,
      thinkingOverride: "low",
      budgetOverride: { totalMs: settings.evalTimeoutMs },
      schema: GOAL_EVAL_SCHEMA,
      cwd: ctx.cwd,
      ...(settings.verifierModelHint.length > 0 ? { modelHintOverride: settings.verifierModelHint } : {}),
    };
    let outcome: RunOutcome;
    try {
      outcome = await withTimeout(spawn.spawnAndWait(request), settings.evalTimeoutMs);
    } catch (error) {
      // M-a fallback：verifier 类型不存在 → 降级 general + 内置评估 prompt，WARN 一次。
      if (
        !(error instanceof EvalTimeoutError) &&
        /unknown agent type/.test(String(error)) &&
        request.type !== "general"
      ) {
        if (!verifierFallbackWarned) {
          verifierFallbackWarned = true;
          warn(
            `goal verifier type "${settings.verifierType}" unavailable; falling back to "general" with a built-in evaluator prompt`,
          );
        }
        outcome = await withTimeout(
          spawn.spawnAndWait({ ...request, type: "general", prompt: buildGeneralEvaluatorPrompt(record) }),
          settings.evalTimeoutMs,
        );
      } else {
        throw error instanceof Error ? error : new Error(String(error));
      }
    }
    // verifier 成本计入 goal 总账（v4 条件 6）。
    if (outcome.usage) {
      record.tokensUsed += outcome.usage.input + outcome.usage.output;
      record.costUsdUsed += outcome.usage.costUsd;
    }
    if (outcome.status !== "completed") {
      throw new Error(
        `verifier run ${outcome.status}: ${outcome.error?.message ?? outcome.timeoutReason ?? "no detail"}`,
      );
    }
    const payload = outcome.structuredResult;
    if (payload === null || typeof payload !== "object" || Array.isArray(payload)) {
      throw new Error("verifier completed without a schema-valid StructuredOutput payload");
    }
    const met = (payload as { goal_met?: unknown }).goal_met === true;
    const gapRaw = (payload as { gap?: unknown }).gap;
    const gap = typeof gapRaw === "string" && gapRaw.trim().length > 0 ? gapRaw.trim() : undefined;
    return met ? { met: true } : { met: false, ...(gap !== undefined ? { gap } : {}) };
  };

  /** 评估主流程（fire-and-forget 主体）。所有分支先校验 epoch 再落状态。 */
  const evaluate = async (
    ctx: ExtensionContext,
    goal: GoalSession,
    record: GoalRecord,
    epoch: number,
  ): Promise<void> => {
    const settings = goal.settings;
    let verdict: Verdict;
    try {
      let cmdFailedGap: string | undefined;
      // D4：until-cmd 零模型成本先行短路，失败直接续跑，不再 spawn verifier。
      if (record.untilCmd !== undefined) {
        const result = await deps.exec(record.untilCmd, { timeoutMs: settings.untilCmdTimeoutMs, cwd: ctx.cwd });
        if (!epochValid(goal, record, epoch)) return;
        if (!(result.code === 0 && !result.killed)) {
          cmdFailedGap = `until-cmd 未通过（${result.killed ? "超时被终止" : `exit ${result.code}`}）`;
        }
      }
      if (cmdFailedGap !== undefined) {
        verdict = { met: false, gap: cmdFailedGap };
      } else if (record.untilText !== undefined) {
        verdict = await runVerifier(ctx, goal, record);
      } else if (record.untilCmd !== undefined) {
        // until-cmd 已通过且无 untilText → 达成（D4：命令是确定性判定）。
        verdict = { met: true };
      } else {
        // 无任何完成条件：until-cmd 与 until 都没给 → 永远无法判定达成，
        // 仅靠刹车收尾；按未达成续跑（用户在 /goal 设置时应给条件，命令层已提示）。
        verdict = { met: false, gap: "未配置完成条件（--until-cmd/--until），仅靠刹车停止" };
      }
      record.consecutiveEvalFailures = 0;
    } catch (error) {
      if (!epochValid(goal, record, epoch)) return;
      record.consecutiveEvalFailures += 1;
      const message = error instanceof Error ? error.message : String(error);
      warn(`goal evaluation failed (${record.consecutiveEvalFailures}/2): ${message}`);
      if (record.consecutiveEvalFailures >= 2) {
        stopGoal(ctx, record, { type: "brake", reason: "eval-failures" });
        return;
      }
      verdict = { met: false, gap: `评估器出错（${message}），本轮按未达成处理` };
    }
    if (!epochValid(goal, record, epoch)) return;
    record.lastEvalAt = now();
    // 评估后预算复检：verifier 成本可能刚把预算打爆（v4 条件 6）。
    if (budgetBrakeReason(record, now()) !== undefined) {
      stopGoal(ctx, record, { type: "brake", reason: "budget" });
      return;
    }
    if (verdict.met) {
      stopGoal(ctx, record, { type: "achieved" });
      return;
    }
    record.iteration += 1;
    record.lastEvalNote = verdict.gap ?? "（评估未给出差距说明）";
    deps.persist(record);
    updateBadge(ctx, record);
    const text = buildContinuationText(record, verdict.gap);
    try {
      deps.sendUserMessage(text);
    } catch {
      // 同步 throw 无法捕获异步失败（条件 4）；看门狗兜底。
    }
    armDeliveryWatchdog(ctx, goal, record, epoch, text);
  };

  return {
    /**
     * agent_end：① 记录末条 assistant stopReason（agent_settled 无消息载荷，
     * abort 检测只能在这里取数，v4 条件 1）；② 累加本轮 usage 到 goal 总账
     * （v4 条件 6：token 仅 input+output，成本 cost.total）。
     */
    onAgentEnd(event: AgentEndEvent): void {
      const goal = holder.current?.goal;
      const record = goal?.record;
      let stop: string | undefined;
      for (const message of event.messages) {
        const m = message as {
          role?: string;
          stopReason?: string;
          usage?: { input?: number; output?: number; cost?: { total?: number } };
        };
        if (m.role !== "assistant") continue;
        if (typeof m.stopReason === "string") stop = m.stopReason;
        if (record && (record.state === "active" || record.state === "paused") && m.usage) {
          record.tokensUsed += (m.usage.input ?? 0) + (m.usage.output ?? 0);
          record.costUsdUsed += m.usage.cost?.total ?? 0;
        }
      }
      lastStopReason = stop;
    },

    onAgentSettled(_event: AgentSettledEvent, ctx: ExtensionContext): void {
      // v2 C8：一期只支持交互 TUI（字面值 "tui"，不是 "interactive"）。
      if (ctx.mode !== "tui") return;
      const goal = holder.current?.goal;
      const record = goal?.record;
      const stopReason = lastStopReason;
      lastStopReason = undefined;
      if (!goal || !record || !goal.settings.enabled) return;
      // v4 条件 1：用户中断 = 人工介入信号 → 自动暂停，绝不续跑。
      if (stopReason === "aborted") {
        if (applyEvent(ctx, record, { type: "abort" })) {
          toast(ctx, "/goal：检测到人工中断，goal 已自动暂停（/goal resume 继续）", "warning");
        }
        return;
      }
      if (record.state !== "active") return;
      if (evalInFlight) return;
      // MAJ-1 补充防线：settled 语义下本应空闲，仍以现成 API 兜底。
      if (typeof ctx.isIdle === "function" && !ctx.isIdle()) return;
      if (typeof ctx.hasPendingMessages === "function" && ctx.hasPendingMessages()) return;
      // BLK-3：评估硬上限（被动 run 也计数）。
      if (record.evalCount >= maxEvalsOf(record)) {
        stopGoal(ctx, record, { type: "brake", reason: "max-evals" });
        return;
      }
      // 预算/时长刹车（评估前检查）。
      if (budgetBrakeReason(record, now()) !== undefined) {
        stopGoal(ctx, record, { type: "brake", reason: "budget" });
        return;
      }
      record.evalCount += 1;
      deps.persist(record);
      const epoch = record.epoch;
      evalInFlight = true;
      void evaluate(ctx, goal, record, epoch)
        .catch((error: unknown) => {
          // 评估主流程自身已 catch 评估错误；这里只兜结构 bug。
          warn(`goal evaluation crashed: ${String(error)}`);
        })
        .finally(() => {
          evalInFlight = false;
        });
    },
  };
}
