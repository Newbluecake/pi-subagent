import { mkdir, readFile, readdir, rename, unlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { Clock } from "../core/clock.js";
import type { Millis } from "../core/types.js";
import { isJobId } from "./ids.js";
import { isTerminalJobStatus, parseJobRecord, type JobId, type JobRecord } from "./types.js";

/**
 * bash auto-background §3.4/§3.5: one JSON file per job under a flat
 * directory (`~/.pi/agent/bash-jobs` by default), written atomically with
 * tmp+rename so a crash mid-write can never leave a half-parsed record, and
 * scanned on startup so jobs survive `/reload` and full pi restarts.
 *
 * Everything the store needs is injected (`dir`, `retentionMs`, `clock`,
 * `warn`) — it deliberately does not read the settings module, so the
 * `bashJobs` settings block can evolve independently.
 */

export interface JobStoreOptions {
  /** Directory holding `b_XXXXXXXX.json` + `b_XXXXXXXX.log`. Created on demand. */
  dir: string;
  /** Terminal jobs are pruned this long after they ended. `<= 0` disables pruning. */
  retentionMs: Millis;
  clock: Clock;
  /** Diagnostics sink for unreadable files; defaults to `console.warn`. */
  warn?: (message: string) => void;
}

export interface JobStore {
  readonly dir: string;
  /** Absolute path of the job's JSON record. */
  recordPath(jobId: JobId): string;
  /** Absolute path of the job's merged stdout+stderr log (§3.4 D3). */
  logPath(jobId: JobId): string;
  /** Atomically persist a record (tmp + rename). Writes are serialized per store. */
  save(record: JobRecord): Promise<void>;
  /** `undefined` when the file is missing or unreadable (a WARN is emitted for the latter). */
  load(jobId: JobId): Promise<JobRecord | undefined>;
  /** Every readable record in `dir`; unreadable files are WARNed and skipped. */
  loadAll(): Promise<JobRecord[]>;
  /**
   * Serialized read-modify-write. `mutate` returning `undefined` means "no
   * change" and skips the write. Resolves to the stored record (or `undefined`
   * when the job is gone).
   */
  update(jobId: JobId, mutate: (record: JobRecord) => JobRecord | undefined): Promise<JobRecord | undefined>;
  /** Persist the `bash_job output` cursor (§4.3). Monotonic: never moves backwards. */
  setReadCursor(jobId: JobId, cursor: number): Promise<JobRecord | undefined>;
  /** Delete the record and its log file. Idempotent. */
  remove(jobId: JobId): Promise<void>;
  /** Prune expired terminal jobs; resolves to the ids removed. */
  pruneExpired(): Promise<JobId[]>;
}

const RECORD_SUFFIX = ".json";
const LOG_SUFFIX = ".log";

export function createJobStore(options: JobStoreOptions): JobStore {
  const { dir, retentionMs, clock } = options;
  const warn = options.warn ?? ((message: string) => console.warn(`[pi-subagent] ${message}`));
  const recordPath = (jobId: JobId) => join(dir, `${jobId}${RECORD_SUFFIX}`);
  const logPath = (jobId: JobId) => join(dir, `${jobId}${LOG_SUFFIX}`);

  /**
   * Single serialization chain. It orders atomic writes (as in
   * `schedule/store.ts`) *and* makes `update`'s read-modify-write indivisible
   * against concurrent saves from the same process.
   */
  let queue: Promise<unknown> = Promise.resolve();
  let tmpSeq = 0;
  function enqueue<T>(fn: () => Promise<T>): Promise<T> {
    const next = queue.then(fn, fn);
    // Keep the chain alive regardless of individual failures.
    queue = next.then(
      () => undefined,
      () => undefined,
    );
    return next;
  }

  async function writeAtomic(record: JobRecord): Promise<void> {
    await mkdir(dir, { recursive: true });
    const target = recordPath(record.jobId);
    const temp = `${target}.${process.pid}.${clock.now()}.${tmpSeq++}.tmp`;
    try {
      await writeFile(temp, `${JSON.stringify(record, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
      await rename(temp, target);
    } finally {
      // After a successful rename the tmp path is already gone; this only
      // cleans up the failure case.
      await unlink(temp).catch(() => undefined);
    }
  }

  async function readRecord(jobId: JobId): Promise<JobRecord | undefined> {
    let text: string;
    try {
      text = await readFile(recordPath(jobId), "utf8");
    } catch (error) {
      if (errorCode(error) !== "ENOENT") warn(`failed to read bash job ${jobId}: ${String(error)}`);
      return undefined;
    }
    return decode(jobId, text, warn);
  }

  function loadAll(): Promise<JobRecord[]> {
    return enqueue(async () => {
      let entries: string[];
      try {
        entries = await readdir(dir);
      } catch (error) {
        if (errorCode(error) !== "ENOENT") warn(`failed to scan bash job dir ${dir}: ${String(error)}`);
        return [];
      }
      const records: JobRecord[] = [];
      for (const entry of entries.sort()) {
        if (!entry.endsWith(RECORD_SUFFIX)) continue;
        const jobId = entry.slice(0, -RECORD_SUFFIX.length);
        if (!isJobId(jobId)) {
          warn(`skipping bash job file with an unexpected name: ${entry}`);
          continue;
        }
        const record = await readRecord(jobId);
        if (record) records.push(record);
      }
      return records;
    });
  }

  function update(jobId: JobId, mutate: (record: JobRecord) => JobRecord | undefined): Promise<JobRecord | undefined> {
    return enqueue(async () => {
      const current = await readRecord(jobId);
      if (!current) return undefined;
      const next = mutate(current);
      if (!next) return current;
      await writeAtomic(next);
      return next;
    });
  }

  function remove(jobId: JobId): Promise<void> {
    return enqueue(async () => {
      await unlink(recordPath(jobId)).catch(() => undefined);
      await unlink(logPath(jobId)).catch(() => undefined);
    });
  }

  return {
    dir,
    recordPath,
    logPath,
    loadAll,
    update,
    remove,

    save(record) {
      return enqueue(() => writeAtomic(record));
    },

    load(jobId) {
      return enqueue(() => readRecord(jobId));
    },

    setReadCursor(jobId, cursor) {
      const wanted = Number.isFinite(cursor) ? Math.max(0, Math.trunc(cursor)) : 0;
      return update(jobId, (record) =>
        // Monotonic: `bash_job output` may be called with an explicit older
        // offset (offset: 0 = replay), which must not rewind the cursor.
        wanted > record.readCursor ? { ...record, readCursor: wanted } : undefined,
      );
    },

    async pruneExpired() {
      if (!(retentionMs > 0)) return [];
      const now = clock.now();
      const records = await loadAll();
      const removed: JobId[] = [];
      for (const record of records) {
        if (!isTerminalJobStatus(record.status)) continue;
        const endedAt = record.endedAt ?? record.createdAt;
        if (now - endedAt < retentionMs) continue;
        await remove(record.jobId);
        removed.push(record.jobId);
      }
      return removed;
    },
  };
}

function decode(jobId: JobId, text: string, warn: (message: string) => void): JobRecord | undefined {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch (error) {
    warn(`skipping corrupt bash job record ${jobId}: ${String(error)}`);
    return undefined;
  }
  const result = parseJobRecord(parsed);
  if (!result.ok) {
    warn(`skipping invalid bash job record ${jobId}: ${result.reason}`);
    return undefined;
  }
  if (result.record.jobId !== jobId) {
    warn(`skipping bash job record ${jobId}: file name does not match jobId ${result.record.jobId}`);
    return undefined;
  }
  return result.record;
}

function errorCode(error: unknown): string | undefined {
  return error && typeof error === "object" && "code" in error && typeof error.code === "string"
    ? error.code
    : undefined;
}
