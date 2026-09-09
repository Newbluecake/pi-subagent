/**
 * `/goal` 控制面（goal-plan v1 §5 + v4 Nit 消歧）：
 *
 *   /goal <目标> [--until-cmd "cmd"] [--until "条件"] [--max-turns N] [--budget-tokens N] [--max-minutes N]
 *   /goal                     —— 查看状态（同 /goal status）
 *   /goal pause | resume | clear
 *   /goal resume --reset-budget —— 预算类停止后清零预算计数再恢复
 *
 * 消歧规则（v4 Nit）：**单 token** 且精确匹配 pause|resume|clear|status 才按子命令
 * 处理，其余一律视为目标文本；resume 额外容忍仅由 `--reset-budget` 组成的尾巴
 * （预算类恢复的唯一入口，不构成目标文本的合理前缀）。
 */

import type { ExtensionCommandContext, RegisteredCommand } from "@earendil-works/pi-coding-agent";
import { createGoalRecord, transition, type GoalRecord, type GoalSession } from "./state.js";
import { buildStatusText, goalBadgeText } from "./texts.js";

export interface GoalCommandDeps {
  /** 当前 session 的 goal 槽位（holder 透传，session 重建后仍指向新栈）。 */
  goal(): GoalSession | undefined;
  /** 状态落盘（store.persistGoalRecord 绑定到 pi.appendEntry）。 */
  persist(record: GoalRecord): void;
  now?: () => number;
}

/** 引号感知分词：`--until-cmd "npm test -- -u"` → ["--until-cmd", "npm test -- -u"]。 */
export function tokenizeGoalArgs(args: string): string[] {
  const out: string[] = [];
  let current = "";
  let quote: string | undefined;
  let started = false;
  for (const ch of args) {
    if (quote !== undefined) {
      if (ch === quote) quote = undefined;
      else current += ch;
      continue;
    }
    if (ch === '"' || ch === "'") {
      quote = ch;
      started = true;
    } else if (/\s/.test(ch)) {
      if (current.length > 0 || started) out.push(current);
      current = "";
      started = false;
    } else {
      current += ch;
    }
  }
  if (current.length > 0 || started) out.push(current);
  return out;
}

interface ParsedSetArgs {
  objective: string;
  untilCmd?: string;
  untilText?: string;
  maxTurns?: number;
  budgetTokens?: number;
  maxMinutes?: number;
}

const USAGE =
  '用法：/goal <目标> [--until-cmd "cmd"] [--until "条件"] [--max-turns N] [--budget-tokens N] [--max-minutes N]；' +
  "子命令：/goal [status] | pause | resume [--reset-budget] | clear";

function parseSetArgs(tokens: readonly string[]): ParsedSetArgs | { error: string } {
  const result: ParsedSetArgs = { objective: "" };
  const objectiveTokens: string[] = [];
  const numberFlag = (raw: string | undefined, name: string): number | { error: string } => {
    const value = Number(raw);
    if (raw === undefined || !Number.isFinite(value) || !Number.isInteger(value) || value < 0) {
      return { error: `${name} 需要非负整数，收到「${raw ?? ""}」` };
    }
    return value;
  };
  for (let i = 0; i < tokens.length; i++) {
    const token = tokens[i]!;
    if (token === "--until-cmd" || token === "--until") {
      const value = tokens[++i];
      if (value === undefined || value.length === 0) return { error: `${token} 缺少参数值。${USAGE}` };
      if (token === "--until-cmd") result.untilCmd = value;
      else result.untilText = value;
      continue;
    }
    if (token === "--max-turns" || token === "--budget-tokens" || token === "--max-minutes") {
      const parsed = numberFlag(tokens[++i], token);
      if (typeof parsed !== "number") return parsed;
      if (token === "--max-turns") result.maxTurns = parsed;
      else if (token === "--budget-tokens") result.budgetTokens = parsed;
      else result.maxMinutes = parsed;
      continue;
    }
    if (token.startsWith("--")) return { error: `未知参数 ${token}。${USAGE}` };
    objectiveTokens.push(token);
  }
  result.objective = objectiveTokens.join(" ").trim();
  if (result.objective.length === 0) return { error: `缺少目标描述。${USAGE}` };
  return result;
}

function notify(ctx: ExtensionCommandContext, message: string, level: "info" | "warning" | "error" = "info"): void {
  try {
    ctx.ui.notify(message, level);
  } catch {
    // best effort
  }
}

function updateBadge(ctx: ExtensionCommandContext, record: GoalRecord | undefined): void {
  try {
    if (typeof ctx.ui?.setStatus === "function") ctx.ui.setStatus("goal", goalBadgeText(record));
  } catch {
    // best effort
  }
}

export function createGoalCommand(deps: GoalCommandDeps): Omit<RegisteredCommand, "name" | "sourceInfo"> {
  const now = deps.now ?? (() => Date.now());
  return {
    description:
      '目标驱动持续运行：/goal <目标> [--until-cmd "cmd"] [--until "条件"] [--max-turns N] [--budget-tokens N] [--max-minutes N] 后 agent 每轮结束自动评估并续跑，直到条件达成或撞线（预算/轮数/评估上限）。/goal 查看状态，/goal pause|resume|clear 控制。',
    getArgumentCompletions: (argumentPrefix: string) =>
      [
        { value: "status", label: "status", description: "查看当前 goal 状态" },
        { value: "pause", label: "pause", description: "暂停续跑" },
        { value: "resume", label: "resume", description: "恢复续跑（预算类停止加 --reset-budget）" },
        { value: "clear", label: "clear", description: "清除 goal" },
      ].filter((item) => item.value.startsWith(argumentPrefix.trim())),
    handler: async (args: string, ctx: ExtensionCommandContext) => {
      const goal = deps.goal();
      if (!goal) {
        notify(ctx, "pi-subagent：当前没有活动会话，goal 不可用。", "error");
        return;
      }
      if (!goal.settings.enabled) {
        notify(ctx, "/goal 已禁用（goal.enabled=false）。可在 /agent settings 中开启。", "warning");
        return;
      }
      const tokens = tokenizeGoalArgs(args);
      const first = tokens[0];
      // ---- 子命令（v4 Nit：单 token 精确匹配；resume 容忍 --reset-budget 尾巴）----
      if (tokens.length === 0 || (tokens.length === 1 && first === "status")) {
        notify(ctx, buildStatusText(goal.record, goal.settings.maxMinutes));
        return;
      }
      if (tokens.length === 1 && first === "pause") {
        const record = goal.record;
        if (!record || !transition(record.state, { type: "pause" }, record.stopReason)) {
          notify(ctx, "当前没有 active 状态的 goal 可暂停。");
          return;
        }
        record.state = "paused";
        record.epoch += 1;
        deps.persist(record);
        updateBadge(ctx, record);
        notify(ctx, "goal 已暂停。/goal resume 恢复。");
        return;
      }
      if (first === "resume" && tokens.slice(1).every((t) => t === "--reset-budget")) {
        const record = goal.record;
        if (!record) {
          notify(ctx, "当前没有 goal。");
          return;
        }
        if (record.state === "stopped" && record.stopReason === "achieved") {
          notify(ctx, "已达成的 goal 不能恢复；用 /goal <新目标> 设置新 goal。", "warning");
          return;
        }
        if (record.state === "stopped" && (record.stopReason === "budget" || record.stopReason === "max-evals")) {
          // v4 状态机：预算类恢复需显式 --reset-budget。
          if (!tokens.includes("--reset-budget")) {
            notify(ctx, "预算/上限类停止：恢复需 /goal resume --reset-budget（清零预算与评估计数）。", "warning");
            return;
          }
          record.tokensUsed = 0;
          record.costUsdUsed = 0;
          record.evalCount = 0;
          record.createdAt = now();
        }
        const next = transition(record.state, { type: "resume" }, record.stopReason);
        if (!next) {
          notify(ctx, `当前状态（${record.state}）不能 resume。`);
          return;
        }
        record.state = next.phase;
        delete record.stopReason;
        record.consecutiveEvalFailures = 0;
        record.epoch += 1;
        deps.persist(record);
        updateBadge(ctx, record);
        notify(ctx, "goal 已恢复 active。下一轮 run 结束后将继续评估。");
        return;
      }
      if (tokens.length === 1 && first === "clear") {
        const record = goal.record;
        if (!record || record.state === "none") {
          notify(ctx, "当前没有 goal。");
          return;
        }
        record.state = "none";
        delete record.stopReason;
        record.epoch += 1;
        deps.persist(record); // 终态记录落盘：rehydrate 遇到不提示（v4 状态机）
        updateBadge(ctx, record);
        notify(ctx, "goal 已清除。");
        return;
      }
      // ---- 设置/替换 goal ----
      const parsed = parseSetArgs(tokens);
      if ("error" in parsed) {
        notify(ctx, parsed.error, "error");
        return;
      }
      const settings = goal.settings;
      const replaced = goal.record !== undefined && goal.record.state !== "none";
      const record = createGoalRecord({
        objective: parsed.objective,
        ...(parsed.untilCmd !== undefined ? { untilCmd: parsed.untilCmd } : {}),
        ...(parsed.untilText !== undefined ? { untilText: parsed.untilText } : {}),
        maxTurns: parsed.maxTurns ?? settings.maxTurns,
        maxMinutes: parsed.maxMinutes ?? settings.maxMinutes,
        budgetTokens: parsed.budgetTokens ?? settings.budgetTokens,
        budgetCostUsd: settings.budgetCostUsd,
        now: now(),
        previousEpoch: goal.record?.epoch ?? 0,
      });
      goal.record = record;
      deps.persist(record);
      updateBadge(ctx, record);
      const conditions: string[] = [];
      if (record.untilCmd !== undefined) conditions.push(`until-cmd: ${record.untilCmd}`);
      if (record.untilText !== undefined) conditions.push(`until: ${record.untilText}`);
      notify(
        ctx,
        `goal 已设置${replaced ? "（已替换原 goal）" : ""}：${record.objective}\n` +
          (conditions.length > 0
            ? `完成条件：${conditions.join("；")}\n`
            : "⚠️ 未配置完成条件（--until-cmd/--until），goal 只能靠刹车停止。\n") +
          `刹车：${record.maxTurns} 轮 / 评估上限 ${record.maxTurns * 2} 次 / ${record.maxMinutes > 0 ? `${record.maxMinutes} 分钟` : "不限时"}。`,
      );
    },
  };
}
