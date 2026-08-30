import type { CustomEntry } from "@earendil-works/pi-coding-agent";
import type { OutboxStore, PersistedDelivery } from "../delivery/notifier.js";

export const OUTBOX_CUSTOM_TYPE = "subagent:outbox";

export interface PiOutboxHost {
  appendEntry<T = unknown>(customType: string, data?: T): void;
  sessionManager: { getEntries(): ReadonlyArray<{ type: string; customType?: string; data?: unknown }> };
}

/**
 * G5a persistence: backs the Notifier's OutboxStore with `pi.appendEntry` /
 * `pi.sessionManager.getEntries()` (architecture §2.5/§5.11) instead of pure
 * memory, so a terminal delivery record survives a session reload and can be
 * read back to verify it actually landed. `appendEntry` is append-only, so
 * `put`/`update` both append a fresh custom entry carrying the full current
 * record; `list()` folds the entry log down to the latest record per key.
 * This is real persistence (not a no-op stub) — the reconcile path at
 * session_start seeds the in-memory cache straight from `getEntries()`.
 */
export function createPiOutboxStore(pi: PiOutboxHost): OutboxStore {
  const cache = new Map<string, PersistedDelivery>();
  for (const entry of pi.sessionManager.getEntries()) {
    if (entry.type === "custom" && (entry as CustomEntry).customType === OUTBOX_CUSTOM_TYPE) {
      const record = (entry as CustomEntry<PersistedDelivery>).data;
      if (record?.key) cache.set(record.key, record);
    }
  }
  return {
    put(record: PersistedDelivery) {
      cache.set(record.key, record);
      pi.appendEntry(OUTBOX_CUSTOM_TYPE, record);
    },
    update(key: string, patch: Partial<PersistedDelivery>) {
      const current = cache.get(key);
      if (!current) return;
      const next = { ...current, ...patch };
      cache.set(key, next);
      pi.appendEntry(OUTBOX_CUSTOM_TYPE, next);
    },
    list() {
      return [...cache.values()];
    },
  };
}
