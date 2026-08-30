import type { RunId, RunOutcome, RunSnapshot, Generation, RunStatus } from "./types.js";
export interface OutboxRecord {
  readonly key: string;
  readonly kind: "snapshot" | "delivery";
  readonly payload: RunSnapshot | unknown;
  readonly createdAt: number;
  readonly attempts: number;
  readonly state: "pending" | "delivered" | "dropped" | "consumed";
}
export interface SnapshotStore {
  put(snapshot: RunSnapshot): void;
  get(runId: RunId, generation?: Generation): RunSnapshot | undefined;
  list(filter?: { status?: RunStatus[] }): readonly RunSnapshot[];
  appendOutbox(entry: OutboxRecord): void;
}
/**
 * Canonical, reusable put/update/list outbox contract (single source of
 * truth — delivery/notifier.ts imports this instead of redeclaring its own
 * shape). Generic over the record type so both the delivery outbox
 * (PersistedDelivery) and any other durable-queue need can share it.
 */
export interface OutboxStore<T extends { key: string }> {
  put(record: T): void;
  update(key: string, patch: Partial<T>): void;
  list(): readonly T[];
}
export class MemoryOutboxStore<T extends { key: string }> implements OutboxStore<T> {
  private readonly records = new Map<string, T>();
  put(record: T): void {
    this.records.set(record.key, record);
  }
  update(key: string, patch: Partial<T>): void {
    const current = this.records.get(key);
    if (current) this.records.set(key, { ...current, ...patch });
  }
  list(): readonly T[] {
    return [...this.records.values()];
  }
}
export class MemoryRunStore implements SnapshotStore {
  private snapshots = new Map<string, RunSnapshot>();
  private outboxEntries = new Map<string, OutboxRecord>();
  put(snapshot: RunSnapshot): void {
    this.snapshots.set(`${snapshot.runId}:${snapshot.generation}`, snapshot);
  }
  get(runId: RunId, generation?: Generation): RunSnapshot | undefined {
    if (generation !== undefined) return this.snapshots.get(`${runId}:${generation}`);
    return [...this.snapshots.values()].filter((s) => s.runId === runId).sort((a, b) => b.generation - a.generation)[0];
  }
  list(filter?: { status?: RunStatus[] }): readonly RunSnapshot[] {
    return [...this.snapshots.values()].filter((s) => filter?.status === undefined || filter.status.includes(s.status));
  }
  appendOutbox(entry: OutboxRecord): void {
    if (!this.outboxEntries.has(entry.key)) this.outboxEntries.set(entry.key, entry);
  }
  get outbox(): readonly OutboxRecord[] {
    return [...this.outboxEntries.values()];
  }
  outcomeOf(runId: RunId, generation?: Generation): RunOutcome | undefined {
    return this.get(runId, generation)?.outcome;
  }
}
