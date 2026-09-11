import type { Millis } from "../core/types.js";

/**
 * X6b: latest raw user @ message per run, surfaced by the fleet widget one line
 * below the run's tool trail (and as the ONLY awaiting-entry preview).
 *
 * Lifecycle:
 * - steer path (@ running run): the note is "pending" with a baseline timestamp
 *   captured when the steer landed. Once the target run starts a NEW model turn
 *   after that baseline (turn_start = the steered message entered the model's
 *   context), the note has served its purpose and self-clears on the next read.
 * - resume path (@ terminal run → new run): the note IS the new run's task
 *   description, so it is pinned — it persists for the run's whole lifetime and
 *   doubles as the awaiting-pickup preview after the run settles (terminal runs
 *   emit no further events, so a pending note would never clear anyway; pinning
 *   is explicit about it).
 *
 * Session-scoped, capped FIFO; notes are one-line previews, never read back
 * into context.
 */
export interface MentionNotes {
  /** Latest-wins per runId: a second @ overwrites the first, baseline included. */
  set(runId: string, message: string, pendingSince?: Millis): void;
  get(runId: string): string | undefined;
}

const DEFAULT_CAP = 200;

export function createMentionNotes(opts: {
  /** Live diag lookup powering the self-clear check. */
  diagOf: (runId: string) => { lastEventAt?: Millis; lastEventType?: string } | undefined;
  cap?: number;
}): MentionNotes {
  const cap = opts.cap ?? DEFAULT_CAP;
  const map = new Map<string, { text: string; pendingSince?: Millis }>();
  return {
    set(runId, message, pendingSince) {
      // Evict the oldest only when inserting a NEW key — overwriting an existing
      // note must not evict a third party.
      if (!map.has(runId) && map.size >= cap) map.delete(map.keys().next().value!);
      map.set(runId, pendingSince === undefined ? { text: message } : { text: message, pendingSince });
    },
    get(runId) {
      const note = map.get(runId);
      if (note === undefined) return undefined;
      if (note.pendingSince !== undefined) {
        const diag = opts.diagOf(runId);
        // turn_start past the baseline = the agent opened a fresh model turn with
        // the steered message in context — it is being processed, so the "user
        // said …" reminder below the row has done its job. Trailing events of the
        // in-flight turn (tool_end/turn_end/…) never satisfy this check.
        if (diag?.lastEventType === "turn_start" && (diag.lastEventAt ?? 0) > note.pendingSince) {
          map.delete(runId);
          return undefined;
        }
      }
      return note.text;
    },
  };
}
