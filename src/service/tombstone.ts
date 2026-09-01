import type { RunId, RunSnapshot } from "../core/types.js";

export interface Tombstone {
  readonly runId: RunId;
  readonly generation: number;
  readonly sessionFile: string;
  readonly createdAt: number;
  readonly expiresAt: number;
}

/** In-memory terminal handle index. Entries are intentionally bounded by TTL. */
export class TombstoneStore {
  private readonly entries = new Map<string, Tombstone>();
  constructor(
    private readonly ttlMs = 30 * 60 * 1000,
    private readonly now = () => Date.now(),
  ) {}

  register(snapshot: RunSnapshot): void {
    const sessionFile = snapshot.diag.sessionFile;
    if (!sessionFile) return;
    const createdAt = this.now();
    this.entries.set(snapshot.runId, {
      runId: snapshot.runId,
      generation: snapshot.generation,
      sessionFile,
      createdAt,
      expiresAt: createdAt + this.ttlMs,
    });
  }
  has(runId: RunId): boolean {
    this.cleanup();
    return this.entries.has(runId);
  }
  get(runId: RunId): Tombstone | undefined {
    this.cleanup();
    return this.entries.get(runId);
  }
  resolve(handle: string): Tombstone | undefined {
    this.cleanup();
    return this.entries.get(handle) ?? [...this.entries.values()].find((entry) => entry.sessionFile === handle);
  }
  cleanup(): number {
    const now = this.now();
    let removed = 0;
    for (const [key, entry] of this.entries) {
      if (entry.expiresAt <= now) {
        this.entries.delete(key);
        removed++;
      }
    }
    return removed;
  }
  list(): readonly Tombstone[] {
    this.cleanup();
    return [...this.entries.values()];
  }
}
