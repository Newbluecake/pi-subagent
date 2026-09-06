import { formatDuration } from "../ui/fleet-panel.js";

/**
 * Anti-polling-loop guards shared by the "check on a background thing" tools
 * (get_subagent_result, bash_job status/wait). A model that polls the same
 * target in a loop burns turns and can deadlock the agent loop — completion
 * notifications are only injected between turns, so the poll never sees the
 * event it is waiting for.
 *
 * Two guards for the two loop shapes:
 *
 * - **Frequency guard** (createPollGuard) for the non-blocking reads. Calls
 *   are tracked per key (run_id / job_id) inside a sliding window: collecting
 *   results for several parallel targets in quick succession after their
 *   notifications arrive is the normal flow and must not trip the guard. The
 *   window must span several agent-loop turns — each poll costs a full model
 *   turn (typically seconds to tens of seconds), so a 10s window would only
 *   catch same-message bursts and never a real cross-turn polling loop. When
 *   one key's call count within the window exceeds maxCalls, record() returns
 *   a warning string the caller prepends to the tool result, telling the
 *   model to stop polling.
 *
 * - **Timeout-streak guard** (createTimeoutStreak) for the blocking waits. A
 *   wait blocks up to its budget by design, so "frequency" is meaningless —
 *   the loop signal is the same target timing out again and again. The streak
 *   counts consecutive timeouts per key (reset when a terminal outcome is
 *   observed); past maxStreak the caller escalates its message, pointing at
 *   the two ways out: raise the wait budget, or end the turn and await the
 *   completion notification.
 */
export interface PollGuardOptions {
  /** Sliding window in ms. Default 120_000 (must outlast a few model turns, see above). */
  windowMs?: number | undefined;
  /** Calls per key allowed within the window before warning. Default 3. */
  maxCalls?: number | undefined;
  /** Clock override for tests. Default Date.now. */
  now?: (() => number) | undefined;
  /** Custom warning text; defaults to the get_subagent_result wording. */
  message?: ((key: string, count: number, windowMs: number) => string) | undefined;
}

export function createPollGuard(opts?: PollGuardOptions) {
  const windowMs = opts?.windowMs ?? 120_000;
  const maxCalls = opts?.maxCalls ?? 3;
  const now = opts?.now ?? Date.now;
  const message =
    opts?.message ??
    ((key: string, count: number, window: number) =>
      `⚠️ Polling too frequently: get_subagent_result has been called ${count} times for run "${key}" ` +
      `within ${formatDuration(window)}. This looks like a polling loop — STOP calling this tool for now. ` +
      `End your turn and wait for the run's completion notification to arrive; if the notification genuinely ` +
      `seems lost, make ONE final call with wait: true instead of repeated non-wait polls.`);
  const calls = new Map<string, number[]>();
  return {
    /** Records a call; returns a warning string when the rate is exceeded. */
    record(key: string): string | undefined {
      const t = now();
      const recent = (calls.get(key) ?? []).filter((ts) => t - ts <= windowMs);
      recent.push(t);
      calls.set(key, recent);
      if (recent.length <= maxCalls) return undefined;
      return message(key, recent.length, windowMs);
    },
  };
}
export type PollGuard = ReturnType<typeof createPollGuard>;

export interface TimeoutStreakOptions {
  /** Consecutive timeouts tolerated before escalation. Default 1 (the 2nd consecutive timeout escalates). */
  maxStreak?: number | undefined;
}

export interface TimeoutStreakResult {
  /** Consecutive timeouts recorded for this key so far (including this one). */
  streak: number;
  /** Total ms spent blocked inside this streak. */
  totalWaitedMs: number;
  /** True once the streak has passed maxStreak — the caller escalates its message. */
  escalate: boolean;
}

/**
 * Consecutive-timeout tracker for the bounded waits. Blocking loops are slow
 * (each iteration costs the full wait budget), so instead of a rate limit
 * this counts how many times in a row the same target timed out without a
 * terminal outcome in between, plus the cumulative time wasted blocking.
 */
export function createTimeoutStreak(opts?: TimeoutStreakOptions) {
  const maxStreak = opts?.maxStreak ?? 1;
  const streaks = new Map<string, { count: number; totalMs: number }>();
  return {
    /** Records a timeout; escalation info tells the caller how firmly to warn. */
    timeout(key: string, waitedMs: number): TimeoutStreakResult {
      const entry = streaks.get(key) ?? { count: 0, totalMs: 0 };
      entry.count += 1;
      entry.totalMs += waitedMs;
      streaks.set(key, entry);
      return { streak: entry.count, totalWaitedMs: entry.totalMs, escalate: entry.count > maxStreak };
    },
    /** Clears the streak once a terminal outcome (or any real progress) is observed. */
    reset(key: string): void {
      streaks.delete(key);
    },
  };
}
export type TimeoutStreak = ReturnType<typeof createTimeoutStreak>;
