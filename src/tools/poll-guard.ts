import { formatDuration } from "../ui/fleet-panel.js";

/**
 * Anti-polling-loop guard shared by the "check on a background thing" tools
 * (get_subagent_result, bash_job status). A model that polls the same target
 * in a tight loop burns turns and can deadlock the agent loop — completion
 * notifications are only injected between turns, so the poll never sees the
 * event it is waiting for.
 *
 * Calls are tracked per key (run_id / job_id): collecting results for several
 * parallel targets in quick succession after their notifications arrive is the
 * normal flow and must not trip the guard. When one key's call count within
 * the sliding window exceeds maxCalls, record() returns a warning string the
 * caller prepends to the tool result, telling the model to stop polling.
 */
export interface PollGuardOptions {
  /** Sliding window in ms. Default 10_000. */
  windowMs?: number | undefined;
  /** Calls per key allowed within the window before warning. Default 3. */
  maxCalls?: number | undefined;
  /** Clock override for tests. Default Date.now. */
  now?: (() => number) | undefined;
  /** Custom warning text; defaults to the get_subagent_result wording. */
  message?: ((key: string, count: number, windowMs: number) => string) | undefined;
}

export function createPollGuard(opts?: PollGuardOptions) {
  const windowMs = opts?.windowMs ?? 10_000;
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
