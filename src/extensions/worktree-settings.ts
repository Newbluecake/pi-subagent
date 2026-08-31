export interface WorktreeSettings {
  /** Worktree isolation is opt-in. */
  enabled: boolean;
  /** Per-command bound for git operations. */
  gitTimeoutMs: number;
}

export const DEFAULT_WORKTREE_SETTINGS: WorktreeSettings = {
  enabled: false,
  gitTimeoutMs: 30_000,
};

export function mergeWorktreeSettings(value: unknown): WorktreeSettings {
  if (value === null || typeof value !== "object") return { ...DEFAULT_WORKTREE_SETTINGS };
  const input = value as Record<string, unknown>;
  return {
    enabled: input.enabled === true,
    gitTimeoutMs:
      typeof input.gitTimeoutMs === "number" && Number.isFinite(input.gitTimeoutMs)
        ? Math.max(1, input.gitTimeoutMs)
        : DEFAULT_WORKTREE_SETTINGS.gitTimeoutMs,
  };
}
