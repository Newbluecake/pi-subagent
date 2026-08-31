import type { SnapshotStore } from "../core/store.js";
import type { RunId } from "../core/types.js";
import type { RunRegistry } from "./ports.js";

/**
 * Thin RunRegistry adapter over the core SnapshotStore. SnapshotStore.list()
 * only understands `status` filters (it is a pure L1 concept, no notion of
 * parent/child ownership); the parentRunId filter promised by ports.RunRegistry
 * is applied here, one layer up, using RunSnapshot.parentRunId (core §5.1 /
 * X3 nested delegation bookkeeping).
 */
export function createRunRegistry(store: SnapshotStore): RunRegistry {
  return {
    get(runId: RunId) {
      return store.get(runId);
    },
    list(filter) {
      const out = store.list(filter?.status === undefined ? undefined : { status: filter.status });
      const filtered =
        filter?.parentRunId === undefined ? out : out.filter((s) => s.parentRunId === filter.parentRunId);
      return [...filtered];
    },
  };
}

/**
 * Registry backed by SpawnService's live records (every snapshot, including
 * in-flight runs) with the durable store as fallback for terminal runs.
 *
 * Backing the registry ONLY with the store made running runs invisible to
 * get_subagent_result / fleet / status — persist_snapshot is a terminal-only
 * effect by design (I4), so a store-only registry never sees a live run.
 */
export function createLiveRunRegistry(
  live: { snapshots(): readonly import("../core/types.js").RunSnapshot[] },
  store: SnapshotStore,
): RunRegistry {
  const view: SnapshotStore = {
    put: () => {}, // writes flow through the effect interpreter / settle path
    get: (runId) => live.snapshots().find((s) => s.runId === runId) ?? store.get(runId),
    list: (filter) => {
      const current = live.snapshots();
      const liveIds = new Set(current.map((s) => s.runId));
      const merged = [...current, ...store.list().filter((s) => !liveIds.has(s.runId))];
      return filter?.status ? merged.filter((s) => filter.status!.includes(s.status)) : merged;
    },
    appendOutbox: (entry) => store.appendOutbox(entry),
  };
  return createRunRegistry(view);
}
