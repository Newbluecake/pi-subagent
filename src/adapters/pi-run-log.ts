import type { CustomEntry } from "@earendil-works/pi-coding-agent";
import type { SnapshotStore, OutboxRecord } from "../core/store.js";
import type { RunId, RunSnapshot, Generation } from "../core/types.js";

export const RUN_CUSTOM_TYPE = "subagent:run";

export interface PiRunLogHost {
  appendEntry<T = unknown>(customType: string, data?: T): void;
  sessionManager: { getEntries(): ReadonlyArray<{ type: string; customType?: string; data?: unknown }> };
}

/**
 * G5a: wraps a SnapshotStore so every terminal put() also lands a
 * "subagent:run" custom entry via pi.appendEntry, and exposes
 * verifyLanded() to read it back via pi.sessionManager.getEntries()
 * (architecture 2.5 - appendEntry has no ack, so "persisted" must mean
 * "read back successfully", not just "the call did not throw").
 */
export function wrapWithRunLog(
  base: SnapshotStore,
  pi: PiRunLogHost,
): SnapshotStore & { verifyLanded(runId: RunId, generation: Generation): boolean } {
  return {
    put(snapshot: RunSnapshot) {
      base.put(snapshot);
      try {
        pi.appendEntry(RUN_CUSTOM_TYPE, snapshot);
      } catch {
        // Best-effort: verifyLanded() is the actual detection mechanism for
        // G5a degradation, not this try/catch (appendEntry itself has no ack
        // even when it does not throw, architecture 2.5).
      }
    },
    get(runId, generation) {
      return base.get(runId, generation);
    },
    list(filter) {
      return base.list(filter);
    },
    appendOutbox(entry: OutboxRecord) {
      base.appendOutbox(entry);
    },
    verifyLanded(runId: RunId, generation: Generation) {
      return pi.sessionManager
        .getEntries()
        .some(
          (e) =>
            e.type === "custom" &&
            (e as CustomEntry).customType === RUN_CUSTOM_TYPE &&
            (e as CustomEntry<RunSnapshot>).data?.runId === runId &&
            (e as CustomEntry<RunSnapshot>).data?.generation === generation,
        );
    },
  };
}
