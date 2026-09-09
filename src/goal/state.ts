/**
 * /goal 目标驱动持续运行 —— 纯领域模块（零 pi import，对齐 src/core/ 纯度）。
 *
 * 状态机 v4（docs/dev/goal/goal-plan.md，评审放行条件 2 + O4 折中）：
 *
 *   none ──set──▶ active ──achieved──▶ stopped("achieved")
 *                   │──pause──▶ paused ──resume──▶ active
 *                   │──abort（用户 Ctrl+C）──▶ paused（自动）
 *                   │──brake（预算/评估上限/投递失败/评估连败）──▶ stopped(reason)
 *   rehydrate（session_start 读回）──▶ paused（强制降级，仅 /goal resume 可迁出）
 *   任意 ──clear──▶ none
 *
 * - stopped 除 "achieved" 外均可 resume（预算类需 --reset-budget，由命令层把关）。
 * - 持久化只写 active/paused 态记录；stopped/none 也落地为终态记录，rehydrate
 *   遇到终态不提示、不继承（见 store.ts）。
 */

export type GoalPhase = "none" | "active" | "paused" | "stopped";

export type GoalStopReason = "achieved" | "budget" | "max-evals" | "delivery-failed" | "eval-failures";

/** session_start 读回时的来源（对齐 pi 的 SessionStartEvent.reason，此处用纯字符串避免 pi import）。 */
export type GoalSessionStartReason = "startup" | "reload" | "new" | "resume" | "fork";

/**
 * session 级 goal 运行态（挂 Stack.goal）。settings 是 buildSessionStack 时捕获的
 * GoalSettings 快照引用（/agent settings 的 in-place 写入对新评估即时生效）；
 * record 为当前 goal 实体（undefined = 从未设置）。运行时闩锁/看门狗在 hook 闭包里，不进这里。
 */
export interface GoalSession {
  settings: import("../config/settings.js").GoalSettings;
  record: GoalRecord | undefined;
}

export interface GoalRecord {
  /** 目标原文（用户输入照引）。 */
  objective: string;
  /** 确定性判定命令；exit 0 = 通过。 */
  untilCmd?: string;
  /** 自然语言完成条件（verifier 评估）。与 untilCmd 叠加时为 AND 语义，until-cmd 先行短路。 */
  untilText?: string;
  /** 主动迭代轮数封顶（--max-turns / goal.maxTurns）。 */
  maxTurns: number;
  /** wall-clock 封顶（分钟）；在评估点检查，滞后一整轮（v4 M-h）。0 = 不限。 */
  maxMinutes: number;
  /** 累计 token 预算（仅 input+output，v4 条件 6）；0 = 不限。 */
  budgetTokens: number;
  /** 累计成本预算（美元，usage.cost.total 口径）；0 = 不限。 */
  budgetCostUsd: number;
  createdAt: number;
  state: GoalPhase;
  stopReason?: GoalStopReason;
  /** 单调递增令牌：set/pause/resume/clear/rehydrate/abort 均 +1；评估开始时快照，应用结果前校验（v4 条件 7）。 */
  epoch: number;
  /** 主动迭代轮（仅文案展示，不作刹车口径，v4 条件 3）。 */
  iteration: number;
  /** 评估硬计数：每次进入评估无条件 +1（含通知触发的被动 run），上限 maxEvalsOf()。 */
  evalCount: number;
  /** 连续评估失败（verifier 报错/超时）计数；≥2 → stopped("eval-failures")。 */
  consecutiveEvalFailures: number;
  /** 累计 token（主会话 agent_end 累加 + verifier RunOutcome.usage，仅 input+output）。 */
  tokensUsed: number;
  /** 累计成本（美元，cost.total 主口径；verifier 成本计入）。 */
  costUsdUsed: number;
  /** 上次评估结论/差距（/goal status 展示 + 下轮指引）。 */
  lastEvalNote?: string;
  lastEvalAt?: number;
}

export type GoalEvent =
  | { type: "set" }
  | { type: "pause" }
  | { type: "resume" }
  | { type: "clear" }
  | { type: "achieved" }
  | { type: "brake"; reason: Exclude<GoalStopReason, "achieved"> }
  | { type: "abort" }
  | { type: "rehydrate" };

export interface GoalTransition {
  phase: GoalPhase;
  stopReason?: GoalStopReason;
}

/**
 * 纯函数迁移表。非法迁移返回 undefined（调用方忽略或报错）。
 * 注意：transition 只负责状态与 stopReason；epoch++/计数重置由调用方按事件语义处理。
 */
export function transition(
  phase: GoalPhase,
  event: GoalEvent,
  currentStop?: GoalStopReason,
): GoalTransition | undefined {
  switch (event.type) {
    case "set":
      // 任意状态可设置/替换 goal（替换的确认交互由命令层负责）。
      return { phase: "active" };
    case "clear":
      return { phase: "none" };
    case "pause":
      return phase === "active" ? { phase: "paused" } : undefined;
    case "resume":
      if (phase === "paused") return { phase: "active" };
      // stopped 除 achieved 外均可恢复（预算类的 --reset-budget 门槛在命令层）。
      if (phase === "stopped" && currentStop !== undefined && currentStop !== "achieved") return { phase: "active" };
      return undefined;
    case "achieved":
      return phase === "active" ? { phase: "stopped", stopReason: "achieved" } : undefined;
    case "brake":
      return phase === "active" ? { phase: "stopped", stopReason: event.reason } : undefined;
    case "abort":
      // v4 条件 1（BLK-1）：用户中断 = 人工介入信号，自动暂停而非继续空转。
      return phase === "active" ? { phase: "paused" } : undefined;
    case "rehydrate":
      // v4 条件 2（BLK-2）：读回一律降级 paused，绝不自动续跑；终态保持终态（不提示）。
      if (phase === "active") return { phase: "paused" };
      if (phase === "paused" || phase === "stopped" || phase === "none") return { phase };
      return undefined;
  }
}

export interface GoalRecordInit {
  objective: string;
  untilCmd?: string;
  untilText?: string;
  maxTurns: number;
  maxMinutes: number;
  budgetTokens: number;
  budgetCostUsd: number;
  now: number;
  /** 延续上一个 record 的 epoch（替换场景），默认 0（→ 新 record epoch=1）。 */
  previousEpoch?: number;
}

export function createGoalRecord(init: GoalRecordInit): GoalRecord {
  return {
    objective: init.objective,
    ...(init.untilCmd !== undefined ? { untilCmd: init.untilCmd } : {}),
    ...(init.untilText !== undefined ? { untilText: init.untilText } : {}),
    maxTurns: init.maxTurns,
    maxMinutes: init.maxMinutes,
    budgetTokens: init.budgetTokens,
    budgetCostUsd: init.budgetCostUsd,
    createdAt: init.now,
    state: "active",
    epoch: (init.previousEpoch ?? 0) + 1,
    iteration: 0,
    evalCount: 0,
    consecutiveEvalFailures: 0,
    tokensUsed: 0,
    costUsdUsed: 0,
  };
}

/**
 * BLK-3 刹车旁路的硬上限：evalCount 每次评估无条件 +1，上限 = maxTurns × 2
 * （被动 run 也会触发评估，单纯 iteration 计数会被绕过）。至少为 1。
 */
export function maxEvalsOf(record: Pick<GoalRecord, "maxTurns">): number {
  return Math.max(1, record.maxTurns * 2);
}

/** 预算类刹车判定（评估点检查；v4 条件 6 口径：token 仅 input+output，成本 cost.total）。 */
export function budgetBrakeReason(
  record: Pick<
    GoalRecord,
    "budgetTokens" | "budgetCostUsd" | "maxMinutes" | "tokensUsed" | "costUsdUsed" | "createdAt"
  >,
  now: number,
): "budget" | undefined {
  if (record.budgetTokens > 0 && record.tokensUsed >= record.budgetTokens) return "budget";
  if (record.budgetCostUsd > 0 && record.costUsdUsed >= record.budgetCostUsd) return "budget";
  if (record.maxMinutes > 0 && now - record.createdAt >= record.maxMinutes * 60_000) return "budget";
  return undefined;
}

/** 读回记录的最低限度清洗：非法输入返回 undefined（不继承），缺省字段补默认。never throws。 */
export function sanitizeGoalRecord(raw: unknown): GoalRecord | undefined {
  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) return undefined;
  const value = raw as Record<string, unknown>;
  if (typeof value.objective !== "string" || value.objective.length === 0) return undefined;
  const state = value.state;
  if (state !== "none" && state !== "active" && state !== "paused" && state !== "stopped") return undefined;
  const num = (key: string, fallback: number): number => {
    const v = value[key];
    return typeof v === "number" && Number.isFinite(v) && v >= 0 ? v : fallback;
  };
  const stopReason = value.stopReason;
  const validStop =
    stopReason === "achieved" ||
    stopReason === "budget" ||
    stopReason === "max-evals" ||
    stopReason === "delivery-failed" ||
    stopReason === "eval-failures"
      ? stopReason
      : undefined;
  return {
    objective: value.objective,
    ...(typeof value.untilCmd === "string" && value.untilCmd.length > 0 ? { untilCmd: value.untilCmd } : {}),
    ...(typeof value.untilText === "string" && value.untilText.length > 0 ? { untilText: value.untilText } : {}),
    maxTurns: num("maxTurns", 20),
    maxMinutes: num("maxMinutes", 120),
    budgetTokens: num("budgetTokens", 0),
    budgetCostUsd: num("budgetCostUsd", 0),
    createdAt: num("createdAt", 0),
    state,
    ...(validStop !== undefined ? { stopReason: validStop } : {}),
    epoch: Math.max(1, Math.floor(num("epoch", 1))),
    iteration: Math.floor(num("iteration", 0)),
    evalCount: Math.floor(num("evalCount", 0)),
    consecutiveEvalFailures: Math.floor(num("consecutiveEvalFailures", 0)),
    tokensUsed: num("tokensUsed", 0),
    costUsdUsed: num("costUsdUsed", 0),
    ...(typeof value.lastEvalNote === "string" ? { lastEvalNote: value.lastEvalNote } : {}),
    ...(typeof value.lastEvalAt === "number" && Number.isFinite(value.lastEvalAt)
      ? { lastEvalAt: value.lastEvalAt }
      : {}),
  };
}
