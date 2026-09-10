import type { RunStatus } from "./types.js";

/**
 * 终态判定的唯一口径（D-15）。此前仓库里躺着三份各写各的拷贝
 * （state-machine 的 `terminal()`、runner 的本地 Set、query-service 的
 * `terminal()`），必然漂移；收敛到本文件。只 import types.js，无其它依赖。
 */
export type TerminalStatus = Extract<RunStatus, "completed" | "failed" | "timed_out" | "aborted">;

export const TERMINAL_STATUSES: ReadonlySet<RunStatus> = new Set(["completed", "failed", "timed_out", "aborted"]);

export function isTerminalStatus(status: RunStatus): status is TerminalStatus {
  return TERMINAL_STATUSES.has(status);
}
