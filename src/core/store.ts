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
