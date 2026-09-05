/** Hint message custom type. */
export const COMPACT_HINT_CUSTOM_TYPE = "subagent:compact-hint";
/** Default raw threshold setting. */
export const DEFAULT_HINT_THRESHOLD_PERCENT = 75;
/** Minimum interval between hints. */
export const COMPACT_HINT_COOLDOWN_MS = 600_000;
/** pi's built-in reserveTokens fallback. */
export const PI_DEFAULT_RESERVE_TOKENS = 16_384;
/** Default raw threshold for forced compaction. */
export const DEFAULT_FORCE_THRESHOLD_PERCENT = 88;

export function maxThresholdPercent(contextWindow: number, reserveTokens: number): number {
  if (!Number.isFinite(contextWindow) || contextWindow <= 0) return 0;
  return Math.max(0, Math.floor(((contextWindow - reserveTokens) / contextWindow) * 100));
}

export function effectiveThresholdPercent(
  thresholdPercent: number,
  contextWindow: number,
  reserveTokens: number,
): number {
  if (thresholdPercent <= 0) return 0;
  return Math.min(thresholdPercent, maxThresholdPercent(contextWindow, reserveTokens));
}

export function buildCompactHintText(percent: number, effective: number, forceAt = 0): string {
  const forceLine =
    forceAt > 0 ? `若用量继续涨至 ${forceAt}%，系统将强制压缩并使用通用摘要，你可能丢失想保留的细节；\n` : "";
  return (
    `[pi-subagent 上下文警告] 上下文已使用约 ${Math.round(percent)}%（阈值 ${effective}%）。\n\n` +
    "建议在当前子任务告一段落后调用 compact_context 主动压缩：\n" +
    "- 通过 instructions 参数写明必须保留的内容（当前目标、关键文件路径、未决决策、TODO），\n" +
    "  这是只有自主压缩才有的控制权；\n" +
    (forceAt > 0 ? `- ${forceLine}` : forceLine) +
    "- 压缩不是终止：压缩后你会带着摘要自动继续当前任务。"
  );
}
