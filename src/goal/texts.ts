/**
 * /goal 文案 builder（纯函数，中文，对齐 compact-hint/threshold.ts 风格）。
 * 注入模型的续跑指令用中文（v4 M-e），目标原文照引。
 */

import type { GoalRecord, GoalStopReason } from "./state.js";
import { maxEvalsOf } from "./state.js";

/** X10 双重校验的评估输出结构（verifier 经 StructuredOutput 工具提交）。 */
export const GOAL_EVAL_SCHEMA = {
  type: "object",
  properties: {
    goal_met: { type: "boolean", description: "停止条件是否已满足" },
    gap: { type: "string", description: "未满足时的差距说明与下轮指引（≤3 句）；满足时为空字符串" },
  },
  required: ["goal_met", "gap"],
  additionalProperties: false,
} as const;

export function stopReasonLabel(reason: GoalStopReason): string {
  switch (reason) {
    case "achieved":
      return "目标达成";
    case "budget":
      return "预算/时长耗尽";
    case "max-evals":
      return "评估次数上限";
    case "delivery-failed":
      return "续跑投递失败";
    case "eval-failures":
      return "评估器连续失败";
  }
}

function conditionLines(record: GoalRecord): string[] {
  const lines: string[] = [];
  if (record.untilCmd !== undefined) lines.push(`- 命令判定：\`${record.untilCmd}\` 退出码为 0`);
  if (record.untilText !== undefined) lines.push(`- 条件判定：${record.untilText}`);
  return lines;
}

/**
 * 续跑指令（未达成时 followUp 注入）。v4 M-b：明令 goal 运行期间禁止调用
 * ask_user——遇到阻塞把问题写进本轮输出，继续推进其他部分。
 */
export function buildContinuationText(record: GoalRecord, gap: string | undefined): string {
  const conditions = conditionLines(record);
  return [
    `[pi-subagent /goal 续跑 · 第 ${record.iteration} 轮] 目标尚未达成，继续推进，不要停下来等确认。`,
    "",
    `目标：${record.objective}`,
    ...(conditions.length > 0 ? ["完成条件：", ...conditions] : []),
    ...(gap !== undefined && gap.length > 0 ? ["", `上轮评估差距：${gap}`] : []),
    "",
    "要求：",
    "- 直接继续干活，优先消除上面的差距；",
    "- goal 运行期间禁止调用 ask_user：遇到阻塞把问题写进本轮输出，然后继续推进其他可推进的部分；",
    "- 不要重复已完成的步骤；每轮结束时确保改动已落盘（评估器只看仓库实况）。",
  ].join("\n");
}

/** 达成后的收尾总结指令（注入主 agent，让它面向用户总结）。 */
export function buildAchievedText(record: GoalRecord): string {
  return [
    `[pi-subagent /goal 达成] 完成条件已满足（共 ${record.iteration} 轮迭代 / ${record.evalCount} 次评估）。`,
    "",
    `目标：${record.objective}`,
    "",
    "goal 已自动停止。请用一小段话向用户总结：最终状态、关键改动、以及如何验证。",
  ].join("\n");
}

/** 撞线终止报告指令（v1 §4：不静默消失，让主 agent 总结进展与卡点）。 */
export function buildBrakeReportText(record: GoalRecord, reason: Exclude<GoalStopReason, "achieved">): string {
  return [
    `[pi-subagent /goal 终止] goal 因「${stopReasonLabel(reason)}」已停止（${record.iteration} 轮迭代 / ${record.evalCount} 次评估）。`,
    "",
    `目标：${record.objective}`,
    ...(record.lastEvalNote !== undefined && record.lastEvalNote.length > 0
      ? [`最后一次评估结论：${record.lastEvalNote}`]
      : []),
    "",
    "请向用户总结：当前进展、卡点在哪、距离目标还差什么，以及继续所需的预算调整建议" +
      "（恢复用 /goal resume，预算类需 /goal resume --reset-budget）。",
  ].join("\n");
}

/** session_start 读回到未完成 goal 的提示（resume/fork；v4 条件 8）。 */
export function buildResumeHintText(record: GoalRecord): string {
  return (
    `/goal：检测到未完成的 goal「${truncate(record.objective, 60)}」` +
    `（已跑 ${record.iteration} 轮，已降级为 paused）。输入 /goal resume 继续，/goal clear 丢弃。`
  );
}

/** 评估器任务 prompt（D3：循环场景重写，与 verifier 类型的「一次性终验」框架区分）。 */
export function buildVerifierPrompt(record: GoalRecord): string {
  return [
    "这是一轮进行中的目标驱动循环评估（不是最终验收）：判定停止条件是否已经满足。",
    "",
    `目标：${record.objective}`,
    `停止条件：${record.untilText ?? ""}`,
    "",
    "纪律：",
    "- 只读取证：用 read/grep/bash（只读命令）核实仓库实况，不要修改任何文件；",
    "- 以证据为准，不要相信会话里的自述；",
    "- 判定后必须调用 StructuredOutput 工具提交 { goal_met, gap }：",
    "  goal_met=true 当且仅当停止条件已满足；未满足时 gap 用 ≤3 句说明差距并给出下轮最该做的事。",
  ].join("\n");
}

/**
 * M-a fallback：verifier 类型不存在时降级到 general 类型的内置评估 prompt
 * （general 没有角色 prompt，这里自带只读纪律与 schema 提交要求）。
 */
export function buildGeneralEvaluatorPrompt(record: GoalRecord): string {
  return [
    "你是目标驱动循环的独立评估器。工作仍在进行中，你的唯一任务是判定停止条件是否已满足。",
    "",
    `目标：${record.objective}`,
    `停止条件：${record.untilText ?? ""}`,
    "",
    "纪律：",
    "- 严格只读：只用 read/grep/find/ls 与只读 bash 命令取证，禁止任何写操作；",
    "- 以仓库实况为唯一依据；",
    "- 完成判定后必须调用 StructuredOutput 工具提交 { goal_met: boolean, gap: string }：",
    "  goal_met=true 表示条件已满足；否则 gap 用 ≤3 句说明差距与下轮指引。",
  ].join("\n");
}

/** /goal 设置确认的多行文本（左边框树形风格，与 fleet widget 的 ╰ hook 一致；
 * 不用封闭边框：CJK 双宽字符下右侧 │ 无法对齐）。 */
export function buildSetConfirmText(record: GoalRecord, replaced: boolean): string {
  const conditions: string[] = [];
  if (record.untilCmd !== undefined) conditions.push(`until-cmd: ${record.untilCmd}`);
  if (record.untilText !== undefined) conditions.push(`until: ${record.untilText}`);
  const brakes =
    `${record.maxTurns} 轮 · ${record.maxTurns * 2} 次评估 · ` +
    (record.maxMinutes > 0 ? `${record.maxMinutes} 分钟` : "不限时");
  const lines = [`╭ 🎯 goal 已设置${replaced ? "（替换原 goal）" : ""}：${record.objective}`];
  if (conditions.length > 0) {
    lines.push(`│ 完成条件：${conditions.join("；")}`);
  } else {
    lines.push("│ ⚠️ 未设完成条件，只能靠刹车停止（建议补 --until-cmd/--until）");
  }
  lines.push(`│ 刹车：${brakes}`);
  lines.push("╰ /goal status 查看 · /goal pause 暂停 · /goal clear 清除");
  return lines.join("\n");
}

/** 状态栏徽标文本（cache-ttl 先例；返回 undefined = 清除）。 */
export function goalBadgeText(record: GoalRecord | undefined): string | undefined {
  if (!record) return undefined;
  switch (record.state) {
    case "active":
      return `🎯 goal ${record.iteration}/${record.maxTurns}`;
    case "paused":
      return `🎯 goal ⏸ ${record.iteration}/${record.maxTurns}`;
    case "stopped":
      return undefined;
    case "none":
      return undefined;
  }
}

/** /goal status 的多行状态文本。 */
export function buildStatusText(record: GoalRecord | undefined, maxMinutesDefault: number): string {
  if (!record || record.state === "none") {
    return '当前没有 goal。用法：/goal <目标> [--until-cmd "cmd"] [--until "条件"] [--max-turns N] [--budget-tokens N] [--max-minutes N]';
  }
  const stateLabel =
    record.state === "active"
      ? "active（运行中）"
      : record.state === "paused"
        ? "paused（已暂停）"
        : `stopped（${record.stopReason !== undefined ? stopReasonLabel(record.stopReason) : "已停止"}）`;
  const lines = [
    `goal 状态：${stateLabel}（epoch ${record.epoch}）`,
    `目标：${record.objective}`,
    ...conditionLines(record),
    `进度：${record.iteration} 轮迭代 / ${record.evalCount} 次评估（上限 ${maxEvalsOf(record)}）`,
    `预算：turns ${record.iteration}/${record.maxTurns}；` +
      `tokens ${record.tokensUsed}/${record.budgetTokens > 0 ? record.budgetTokens : "∞"}；` +
      `成本 $${record.costUsdUsed.toFixed(4)}/${record.budgetCostUsd > 0 ? `$${record.budgetCostUsd}` : "∞"}；` +
      `时长上限 ${record.maxMinutes > 0 ? `${record.maxMinutes}min` : `${maxMinutesDefault}min（默认）`}`,
  ];
  if (record.lastEvalNote !== undefined && record.lastEvalNote.length > 0)
    lines.push(`上次评估：${record.lastEvalNote}`);
  return lines.join("\n");
}

function truncate(text: string, max: number): string {
  return text.length <= max ? text : `${text.slice(0, max - 1)}…`;
}
