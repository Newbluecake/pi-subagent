/**
 * /goal 持久化（v2 C6 / v4 条件 8）：goal 运行态是 session 级实体，走
 * `pi.appendEntry("subagent:goal", record)` 会话条目（随会话文件走、崩溃持久、
 * 会话隔离），不是 settings 文件也不是新 JSON store。
 *
 * 读回口径（v4 条件 8 / MAJ-5）：
 * - 走 `sessionManager.getBranch()` 而非 `getEntries()`（防 fork 废弃分支复活 goal）；
 * - `reason === "new"` 不继承；
 * - `reason === "reload"` 静默读回（模块态已被 /reload 清空，必须读回才能保住 goal，但不弹 toast）；
 * - `reason === "resume" | "fork"` 读回并提示；
 * - `reason === "startup"` 静默读回（常规启动的新会话本来就没有条目，读到即是恢复场景）；
 * - 读回到 active 一律降级 paused（v4 条件 2，见 state.ts rehydrate），绝不自动续跑；
 * - 终态（stopped/none）记录不继承、不提示。
 */

import { sanitizeGoalRecord, transition, type GoalRecord, type GoalSessionStartReason } from "./state.js";

export const GOAL_ENTRY_TYPE = "subagent:goal";

export interface GoalPersistPort {
  appendEntry(customType: string, data?: unknown): void;
}

/**
 * 追加一条 goal 状态条目。只在状态迁移/计数变更时调用（不是每轮心跳，v2 R6）。
 * appendEntry 失败仅 WARN（内存态仍然生效，下次变更再写）。
 */
export function persistGoalRecord(port: GoalPersistPort, record: GoalRecord): void {
  try {
    port.appendEntry(GOAL_ENTRY_TYPE, record);
  } catch (error) {
    console.warn(`[pi-subagent] goal persist failed (in-memory state kept): ${String(error)}`);
  }
}

export interface GoalRehydrateResult {
  /** 读回并降级后的记录；undefined = 不继承（无条目/new 会话/终态记录）。 */
  record: GoalRecord | undefined;
  /** 是否应向用户提示（resume/fork 为 true）。 */
  notify: boolean;
}

/**
 * 从会话分支读回 goal 记录。`branch` 为 `sessionManager.getBranch()` 的条目数组
 * （结构未知字段一律容忍）。never throws。
 */
export function readBackGoalRecord(branch: readonly unknown[], reason: GoalSessionStartReason): GoalRehydrateResult {
  const none: GoalRehydrateResult = { record: undefined, notify: false };
  if (reason === "new") return none;
  let raw: unknown;
  for (let i = branch.length - 1; i >= 0; i--) {
    const entry = branch[i] as { type?: string; customType?: string; data?: unknown } | undefined;
    if (entry?.type === "custom" && entry.customType === GOAL_ENTRY_TYPE) {
      raw = entry.data;
      break;
    }
  }
  const record = sanitizeGoalRecord(raw);
  if (!record) return none;
  if (record.state === "stopped" || record.state === "none") return none;
  // active/paused → rehydrate 强制降级 paused + epoch++（v4 条件 2/7）。
  const next = transition(record.state, { type: "rehydrate" }, record.stopReason);
  if (!next) return none;
  const downgraded: GoalRecord = { ...record, state: next.phase, epoch: record.epoch + 1 };
  return { record: downgraded, notify: reason === "resume" || reason === "fork" };
}
