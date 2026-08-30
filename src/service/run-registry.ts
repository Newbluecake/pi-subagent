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
