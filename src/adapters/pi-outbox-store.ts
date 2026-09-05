import type { CustomEntry } from "@earendil-works/pi-coding-agent";
import type { OutboxStore } from "../core/store.js";
import type { PersistedDelivery } from "../delivery/notifier.js";

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
export function createPiOutboxStore<T extends { key: string } = PersistedDelivery>(
  pi: PiOutboxHost,
  customType: string = OUTBOX_CUSTOM_TYPE,
  prefetched?: ReadonlyArray<{ type: string; customType?: string; data?: unknown }>,
): OutboxStore<T> {
  const cache = new Map<string, T>();
  for (const entry of prefetched ?? pi.sessionManager.getEntries()) {
    if (entry.type === "custom" && (entry as CustomEntry).customType === customType) {
      const record = (entry as CustomEntry<T>).data;
      if (record?.key) cache.set(record.key, record);
    }
  }
  return {
    put(record: T) {
      const previous = cache.get(record.key);
      cache.set(record.key, record);
      try {
        pi.appendEntry(customType, record);
      } catch (error) {
        if (previous) cache.set(record.key, previous);
        else cache.delete(record.key);
        throw error;
      }
    },
    update(key: string, patch: Partial<T>) {
      const current = cache.get(key);
      if (!current) return;
      const next = { ...current, ...patch };
      cache.set(key, next);
      try {
        pi.appendEntry(customType, next);
      } catch (error) {
        cache.set(key, current);
        throw error;
      }
    },
    list() {
      return [...cache.values()];
    },
  };
}
