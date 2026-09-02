import { createWriteStream, type WriteStream } from "node:fs";
import { mkdir, open, stat } from "node:fs/promises";
import type { Clock, TimerHandle } from "../core/clock.js";
import type { Millis } from "../core/types.js";
import { newJobId } from "./ids.js";
import type { JobStore } from "./job-store.js";
import type { JobExit, KillOutcome, ProcessPort, SpawnedJob } from "./process.js";
import {
  createJobRecord,
  isTerminalJobStatus,
  needsCompletionNotice,
  previewCommand,
  transitionJob,
  truncateFinalText,
  type JobId,
  type JobRecord,
  type JobStatus,
  type JobTransitionPatch,
} from "./types.js";

/**
 * bash auto-background §3 — `BashJobManager`, the owner of a backgrounded
 * bash job's whole life: spawn, log tee (with a hard size cap), terminal
 * settlement, incremental output reads, prefix resolution, kill, bounded
 * `waitExit`, the single-channel completion notification poll, and the
 * post-restart `recover()` decision tree.
 *
 * Layering:
 * - **no pi imports** — the `notify` callback is injected by `src/stack.ts`,
 *   which owns `pi.sendMessage`; the manager only knows "deliver this record";
 * - no settings import — every knob arrives structurally (`BashJobManagerOptions`),
 *   so the `bashJobs` settings block can evolve independently;
 * - no mutable module-level state (the extension re-activates in-process on
 *   `/reload`);
 * - every timer goes through the injected `Clock`, whose real implementation
 *   `unref()`s (a ref'd timer wedges `pi -p`).
 *
 * Invariants worth preserving:
 * - **I-a** every status change goes through `transitionJob`; an illegal move
 *   is WARNed and dropped, never thrown — a bug signal must not cost us a live
 *   process.
 * - **I-b** notifications have exactly one channel: "terminal on disk +
 *   `backgroundedAt` set + `notifiedAt` unset" observed by the *current*
 *   manager's poll (§3.6). Write paths only persist; a disposed manager's
 *   in-flight `exitPromise` callbacks therefore cannot double-notify after
 *   `/reload`.
 * - **I-c** identity doubt never kills: `checkPidOwnership() === "unsafe"`
 *   marks the job `orphaned` and refuses the kill (§3.3 safety floor).
 */

export const DEFAULT_MAX_LOG_BYTES = 10 * 1024 * 1024;
export const DEFAULT_MAX_BACKGROUND_JOBS = 8;
export const DEFAULT_NOTIFY_POLL_MS = 2_000;
/** Cap on one `readOutput` increment; the cursor makes the rest reachable. */
export const DEFAULT_MAX_READ_BYTES = 1024 * 1024;
/** Candidate list cap in resolution errors (matches `resolve-target.ts`). */
const MAX_CANDIDATES = 10;

/** Marker line appended once the log hits `maxLogBytes` (§3.4). */
export function formatLogTruncationNotice(maxLogBytes: number): string {
  return `\n[log truncated at ${maxLogBytes} bytes]\n`;
}

export interface BashJobManagerOptions {
  store: JobStore;
  processPort: ProcessPort;
  clock: Clock;
  /** Session that owns newly created jobs (recorded for display/filtering). */
  sessionId: string;
  /** Defaults to `process.pid`; injectable so recovery tests can fake hosts. */
  hostPid?: number;
  /**
   * Completion notification sink (§5). Rejecting means "retry next tick" —
   * `notifiedAt` is only stamped after it resolves. Omit it and the manager
   * simply leaves records unnotified for a later session to pick up.
   */
  notify?: (record: JobRecord) => Promise<void> | void;
  maxLogBytes?: number;
  maxBackgroundJobs?: number;
  /** Notification / adopted-liveness poll cadence. */
  pollMs?: Millis;
  /** SIGTERM → SIGKILL window handed to `killJobTree`. */
  killGraceMs?: Millis;
  maxReadBytes?: number;
  warn?: (message: string) => void;
}

export interface CreateJobInit {
  command: string;
  cwd: string;
  env?: NodeJS.ProcessEnv;
  /** Live output relay for the foreground phase (pi's `BashOperations.exec`). */
  onData?: (chunk: string) => void;
}

export interface CreatedJob {
  readonly jobId: JobId;
  /** The `running` record, already persisted. */
  readonly record: JobRecord;
  readonly pid: number;
  readonly pgid: number;
  readonly logPath: string;
  /** Settles with the terminal record. **Never rejects.** */
  readonly exit: Promise<JobRecord>;
}

export interface ReadOutputOptions {
  /** Explicit byte offset; defaults to the persisted `readCursor` (§4.3). */
  offset?: number;
  /** Persist the advanced cursor (default `true`). */
  advanceCursor?: boolean;
  /** Per-call read cap; defaults to the manager's `maxReadBytes`. */
  maxBytes?: number;
}

export interface JobOutputRead {
  readonly jobId: JobId;
  readonly content: string;
  readonly startOffset: number;
  readonly nextOffset: number;
  /** Current size of the log file. */
  readonly logBytes: number;
  readonly state: JobStatus;
  readonly exitCode: number | null;
  /** The log itself was capped at `maxLogBytes` — output was dropped (§3.4). */
  readonly logTruncated: boolean;
  /** Inner tool's closing text; present only once the job is terminal. */
  readonly finalText?: string;
  readonly record: JobRecord;
}

export type KillJobOutcome = KillOutcome | "already-terminal";

export interface KillJobResult {
  readonly jobId: JobId;
  readonly outcome: KillJobOutcome;
  /** True when nothing was signalled because the job had already settled. */
  readonly alreadyTerminal: boolean;
  /** Set when the kill was refused (`outcome === "refused"`). */
  readonly reason?: string;
  readonly record: JobRecord;
}

export interface RecoverSummary {
  /** `running` jobs whose pid was verified ours — now polled by this manager. */
  readonly adopted: readonly JobId[];
  /** `running` jobs whose pid was certainly gone (exit code lost). */
  readonly exitedUnknown: readonly JobId[];
  /** `running` jobs whose pid could not be attributed — marked, never killed. */
  readonly orphaned: readonly JobId[];
  /** `staged` jobs whose spawn outcome was lost with the previous process. */
  readonly lostStaged: readonly JobId[];
  /** Live jobs belonging to another live pi process — left untouched. */
  readonly foreign: readonly JobId[];
  /** Terminal jobs still awaiting their completion notification. */
  readonly pendingNotices: readonly JobId[];
  readonly pruned: readonly JobId[];
}

export interface BashJobManager {
  readonly dir: string;
  readonly maxBackgroundJobs: number;
  recover(): Promise<RecoverSummary>;
  create(init: CreateJobInit): Promise<CreatedJob>;
  /** In-memory snapshot (sync, for `/agent status` and the tool layer). */
  get(jobId: JobId): JobRecord | undefined;
  /** Disk-authoritative read (falls back to memory when the file is gone). */
  load(jobId: JobId): Promise<JobRecord | undefined>;
  list(): readonly JobRecord[];
  /** exact id → unique prefix. Throws a candidate-listing error otherwise. */
  resolve(handle: string): JobId;
  /** Mark the job as handed to the model; enables its completion notice (§5). */
  markBackgrounded(jobId: JobId): Promise<JobRecord | undefined>;
  /** Persist the inner tool's final text (allowed before or after settlement). */
  setFinalText(jobId: JobId, text: string): Promise<JobRecord | undefined>;
  /**
   * Declare *why* the process is about to die, so the exit handler labels the
   * terminal state `killed` / `timed_out` instead of inferring `failed`.
   */
  noteTermination(jobId: JobId, reason: "killed" | "timed_out"): void;
  readOutput(jobId: JobId, options?: ReadOutputOptions): Promise<JobOutputRead>;
  kill(jobId: JobId, options?: { graceMs?: Millis }): Promise<KillJobResult>;
  /** Bounded wait for a terminal state; resolves with the latest record. */
  waitExit(jobId: JobId, timeoutMs: Millis): Promise<JobRecord | undefined>;
  /** §3.8 — this host's `running` **and** backgrounded jobs. */
  backgroundJobCount(): number;
  hasBackgroundCapacity(): boolean;
  /** Clears timers only. Never kills a process, never notifies afterwards. */
  dispose(): void;
}

/** §5 gate: only ownerless (backgrounded) jobs are announced, and never orphans. */
export function shouldNotifyJob(record: JobRecord): boolean {
  return needsCompletionNotice(record) && record.backgroundedAt !== undefined && record.status !== "orphaned";
}

interface LocalHandle {
  readonly spawned: SpawnedJob;
  readonly stream: WriteStream;
  /** Serializes log writes and lets `readOutput` wait for a real flush. */
  flush: Promise<void>;
  written: number;
  truncated: boolean;
  closed: boolean;
  termination?: "killed" | "timed_out";
}

interface Waiter {
  resolve(record: JobRecord | undefined): void;
  timer: TimerHandle;
}

interface Entry {
  record: JobRecord;
  /** Present only for jobs this manager spawned itself (not adopted ones). */
  local?: LocalHandle;
  waiters: Set<Waiter>;
}

export function createBashJobManager(options: BashJobManagerOptions): BashJobManager {
  const { store, processPort, clock } = options;
  const warn = options.warn ?? ((message: string) => console.warn(`[pi-subagent] ${message}`));
  const hostPid = options.hostPid ?? process.pid;
  const maxLogBytes = normalizePositive(options.maxLogBytes, DEFAULT_MAX_LOG_BYTES);
  const maxBackgroundJobs = normalizePositive(options.maxBackgroundJobs, DEFAULT_MAX_BACKGROUND_JOBS);
  const maxReadBytes = normalizePositive(options.maxReadBytes, DEFAULT_MAX_READ_BYTES);
  const pollMs = normalizePositive(options.pollMs, DEFAULT_NOTIFY_POLL_MS);
  const killGraceMs = options.killGraceMs;
  const notify = options.notify;

  const entries = new Map<JobId, Entry>();
  /**
   * Job ids this manager instance created itself. `recover()` must not
   * adjudicate them: `create()` persists a `staged` record *before* awaiting
   * the spawn, so a directory scan racing a fresh call would otherwise see
   * that record as "a staged job whose spawn outcome was lost" and bury a
   * live, still-spawning process under `failed` — after which the real
   * `staged -> running` transition is rejected as illegal and the pid is never
   * persisted, leaving an unkillable background process (worse than the bug it
   * was reporting). The owning `create()` call is always the authority for
   * these ids; recovery only speaks for jobs left behind by someone else.
   */
  const localJobs = new Set<JobId>();
  const notifying = new Set<JobId>();
  let pollTimer: TimerHandle | undefined;
  let ticking = false;
  let disposed = false;

  // ── memory table ─────────────────────────────────────────────────────────

  function ensureEntry(record: JobRecord): Entry {
    const existing = entries.get(record.jobId);
    if (existing) return existing;
    const created: Entry = { record, waiters: new Set() };
    entries.set(record.jobId, created);
    return created;
  }

  /**
   * Adopt a freshly persisted record into the table. A local job's live byte
   * counters win over the (deliberately throttled) on-disk ones, so status and
   * list views never regress while the process is still writing.
   */
  function putRecord(record: JobRecord): JobRecord {
    const entry = ensureEntry(record);
    const handle = entry.local;
    const merged =
      handle && !isTerminalJobStatus(record.status)
        ? {
            ...record,
            logBytes: Math.max(record.logBytes, handle.written),
            outputTruncated: record.outputTruncated || handle.truncated,
          }
        : record;
    entry.record = merged;
    if (isTerminalJobStatus(merged.status)) settleWaiters(entry);
    return merged;
  }

  function settleWaiters(entry: Entry): void {
    for (const waiter of entry.waiters) {
      clock.clearTimer(waiter.timer);
      waiter.resolve(entry.record);
    }
    entry.waiters.clear();
  }

  // ── persistence helpers ──────────────────────────────────────────────────

  async function applyTransition(
    jobId: JobId,
    to: JobStatus,
    patch: JobTransitionPatch,
  ): Promise<JobRecord | undefined> {
    const stored = await store.update(jobId, (current) => {
      const result = transitionJob(current, to, patch);
      if (!result.ok) {
        // I-a: a lost race (double exit callback, poll vs. exit handler) is
        // expected noise, not a reason to throw away a record.
        warn(result.reason);
        return undefined;
      }
      return result.record;
    });
    if (!stored) return undefined;
    return putRecord(stored);
  }

  async function applyPatch(
    jobId: JobId,
    mutate: (record: JobRecord) => JobRecord | undefined,
  ): Promise<JobRecord | undefined> {
    const stored = await store.update(jobId, mutate);
    return stored ? putRecord(stored) : undefined;
  }

  // ── notification poll (single channel, §5 / I-b) ─────────────────────────

  function hasWork(): boolean {
    for (const entry of entries.values()) {
      if (!isTerminalJobStatus(entry.record.status)) return true;
      if (notify !== undefined && shouldNotifyJob(entry.record)) return true;
    }
    return false;
  }

  function ensurePolling(): void {
    if (disposed || pollTimer !== undefined || !hasWork()) return;
    pollTimer = clock.setTimer(pollMs, () => {
      pollTimer = undefined;
      void tick();
    });
  }

  async function tick(): Promise<void> {
    if (disposed || ticking) return;
    ticking = true;
    try {
      for (const entry of [...entries.values()]) await probeAdopted(entry);
      for (const entry of [...entries.values()]) await deliverNotice(entry.record);
    } finally {
      ticking = false;
      ensurePolling();
    }
  }

  /**
   * Adopted jobs have no `exit` event to listen to (their parent died with the
   * previous pi process), so liveness is polled. Only a *certainly dead* pid
   * moves the record; `"unsafe"` leaves it running (I-c).
   */
  async function probeAdopted(entry: Entry): Promise<void> {
    const record = entry.record;
    if (entry.local || record.status !== "running") return;
    if (processPort.checkPidOwnership(record) !== "dead") return;
    const fresh = await store.load(record.jobId);
    if (fresh && isTerminalJobStatus(fresh.status)) {
      putRecord(fresh);
      return;
    }
    await applyTransition(record.jobId, "exited_unknown", { at: clock.now(), exitCode: null });
  }

  async function deliverNotice(record: JobRecord): Promise<void> {
    if (disposed || notify === undefined) return;
    if (!shouldNotifyJob(record) || notifying.has(record.jobId)) return;
    notifying.add(record.jobId);
    try {
      await notify(record);
    } catch (error) {
      // Natural backoff: retried on the next tick (§5).
      warn(`bash job ${record.jobId} notification failed (will retry): ${String(error)}`);
      return;
    } finally {
      notifying.delete(record.jobId);
    }
    const at = clock.now();
    await applyPatch(record.jobId, (current) =>
      current.notifiedAt === undefined ? { ...current, notifiedAt: at } : undefined,
    );
  }

  // ── log tee with a hard cap (§3.4) ───────────────────────────────────────

  function pushWrite(handle: LocalHandle, buffer: Buffer): void {
    if (buffer.length === 0) return;
    handle.written += buffer.length;
    handle.flush = handle.flush.then(
      () =>
        new Promise<void>((resolve) => {
          if (handle.closed) {
            resolve();
            return;
          }
          handle.stream.write(buffer, () => resolve());
        }),
    );
  }

  function teeChunk(entry: Entry, handle: LocalHandle, chunk: Buffer | string, onData?: (text: string) => void): void {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk), "utf8");
    if (onData) {
      try {
        onData(buffer.toString("utf8"));
      } catch (error) {
        warn(`bash job ${entry.record.jobId} output relay threw (ignored): ${String(error)}`);
      }
    }
    if (handle.truncated) return;
    const room = Math.max(0, maxLogBytes - handle.written);
    const overflow = buffer.length > room;
    pushWrite(handle, overflow ? buffer.subarray(0, room) : buffer);
    if (overflow) {
      handle.truncated = true;
      pushWrite(handle, Buffer.from(formatLogTruncationNotice(maxLogBytes), "utf8"));
      const bytes = handle.written;
      // The cap is a durable fact about the job; the running byte count is not
      // (it would thrash the JSON file), so only this edge persists eagerly.
      void applyPatch(entry.record.jobId, (current) =>
        current.outputTruncated ? undefined : { ...current, outputTruncated: true, logBytes: bytes },
      ).catch(() => undefined);
    }
    entry.record = { ...entry.record, logBytes: handle.written, outputTruncated: handle.truncated };
  }

  // ── create ───────────────────────────────────────────────────────────────

  function terminalStatusFor(handle: LocalHandle, exit: JobExit): JobStatus {
    if (handle.termination) return handle.termination;
    if (exit.signal !== null) return "killed";
    return exit.exitCode === 0 ? "completed" : "failed";
  }

  async function finalizeLocal(jobId: JobId, entry: Entry, handle: LocalHandle): Promise<JobRecord> {
    // `exitPromise` never rejects (process.ts contract), so this can only fail
    // on a persistence error — which must not surface as a rejection either.
    const exit = await handle.spawned.exitPromise;
    await handle.flush.catch(() => undefined);
    handle.closed = true;
    await new Promise<void>((resolve) => handle.stream.end(() => resolve()));
    const stored = await applyTransition(jobId, terminalStatusFor(handle, exit), {
      at: clock.now(),
      exitCode: exit.exitCode,
      logBytes: handle.written,
      outputTruncated: handle.truncated,
      ...(exit.error !== undefined ? { finalText: exit.error.message } : {}),
    });
    // I-b: a disposed manager persists but never notifies.
    ensurePolling();
    return stored ?? entry.record;
  }

  async function create(init: CreateJobInit): Promise<CreatedJob> {
    const jobId = newJobId((candidate) => entries.has(candidate));
    localJobs.add(jobId);
    const logPath = store.logPath(jobId);
    const staged = putRecord(
      createJobRecord({
        jobId,
        command: init.command,
        cwd: init.cwd,
        sessionId: options.sessionId,
        hostPid,
        logPath,
        createdAt: clock.now(),
      }),
    );
    // Persist before spawning: a crash between the two leaves a `staged`
    // record that `recover()` can honestly report as lost.
    await store.save(staged);
    await mkdir(store.dir, { recursive: true }).catch(() => undefined);

    let spawned: SpawnedJob;
    try {
      spawned = await processPort.spawnJob(init.command, init.cwd, init.env);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      await applyTransition(jobId, "failed", { at: clock.now(), exitCode: null, finalText: message });
      throw error instanceof Error ? error : new Error(message);
    }

    const entry = ensureEntry(staged);
    const handle: LocalHandle = {
      spawned,
      stream: createWriteStream(logPath, { flags: "a", mode: 0o600 }),
      flush: Promise.resolve(),
      written: 0,
      truncated: false,
      closed: false,
    };
    handle.stream.on("error", (error) => {
      warn(`bash job ${jobId} log write failed: ${String(error)}`);
    });
    entry.local = handle;

    const onChunk = (chunk: Buffer | string): void => teeChunk(entry, handle, chunk, init.onData);
    spawned.stdout.on("data", onChunk);
    spawned.stderr.on("data", onChunk);

    const running = await applyTransition(jobId, "running", {
      at: clock.now(),
      pid: spawned.pid,
      pgid: spawned.pgid,
      ...(spawned.procStartTime !== undefined ? { procStartTime: spawned.procStartTime } : {}),
    });
    const record = running ?? entry.record;

    const exit = finalizeLocal(jobId, entry, handle).catch((error) => {
      warn(`bash job ${jobId} finalization failed: ${String(error)}`);
      return entry.record;
    });
    ensurePolling();

    return { jobId, record, pid: spawned.pid, pgid: spawned.pgid, logPath, exit };
  }

  // ── resolution (§4.3, format aligned with service/resolve-target.ts) ──────

  function candidateLine(record: JobRecord, now: Millis): string {
    const ageMinutes = Math.floor(Math.max(0, now - (record.endedAt ?? record.createdAt)) / 60_000);
    return `${record.jobId} → $ ${previewCommand(record.command, 40)} (${record.status}, ${ageMinutes}m ago)`;
  }

  function formatCandidates(): string {
    const now = clock.now();
    const lines = [...entries.values()]
      .map((entry) => entry.record)
      .sort((a, b) => b.createdAt - a.createdAt)
      .slice(0, MAX_CANDIDATES)
      .map((record) => candidateLine(record, now));
    return lines.length > 0 ? lines.join(", ") : "none";
  }

  function resolve(handle: string): JobId {
    const trimmed = handle.trim();
    if (entries.has(trimmed)) return trimmed;
    // An empty handle is "not found", never "ambiguous": every id starts with it.
    const matches = trimmed.length > 0 ? [...entries.keys()].filter((jobId) => jobId.startsWith(trimmed)) : [];
    const only = matches.length === 1 ? matches[0] : undefined;
    if (only !== undefined) return only;
    const label = previewCommand(trimmed, 40);
    throw new Error(
      matches.length > 1
        ? `ambiguous bash job target: ${label}. Candidates: [${formatCandidates()}]`
        : `bash job not found: ${label}. Candidates: [${formatCandidates()}]`,
    );
  }

  // ── output reads (§4.3) ──────────────────────────────────────────────────

  async function readOutput(jobId: JobId, readOptions: ReadOutputOptions = {}): Promise<JobOutputRead> {
    const entry = entries.get(jobId);
    const record = entry?.record ?? (await store.load(jobId));
    if (!record) throw new Error(`bash job not found: ${jobId}`);
    // A local job may have unflushed writes in the chain; waiting makes reads
    // deterministic ("everything the process has emitted so far").
    if (entry?.local) await entry.local.flush.catch(() => undefined);

    const size = await fileSize(record.logPath);
    const cap = normalizePositive(readOptions.maxBytes, maxReadBytes);
    const startOffset = clampOffset(readOptions.offset ?? record.readCursor, size);
    const length = Math.min(size - startOffset, cap);
    let content = "";
    let bytesRead = 0;
    if (length > 0) {
      const file = await open(record.logPath, "r");
      try {
        const buffer = Buffer.alloc(length);
        const result = await file.read(buffer, 0, length, startOffset);
        bytesRead = result.bytesRead;
        content = buffer.subarray(0, bytesRead).toString("utf8");
      } finally {
        await file.close();
      }
    }
    const nextOffset = startOffset + bytesRead;
    let current = record;
    if (readOptions.advanceCursor !== false && nextOffset > record.readCursor) {
      const stored = await store.setReadCursor(jobId, nextOffset);
      if (stored) current = putRecord(stored);
    }
    return {
      jobId,
      content,
      startOffset,
      nextOffset,
      logBytes: size,
      state: current.status,
      exitCode: current.exitCode,
      logTruncated: current.outputTruncated,
      ...(current.finalText !== undefined ? { finalText: current.finalText } : {}),
      record: current,
    };
  }

  // ── kill (§3.3 ladder, idempotent, identity-guarded) ─────────────────────

  async function kill(jobId: JobId, killOptions: { graceMs?: Millis } = {}): Promise<KillJobResult> {
    const entry = entries.get(jobId);
    const record = entry?.record ?? (await store.load(jobId));
    if (!record) throw new Error(`bash job not found: ${jobId}`);
    if (isTerminalJobStatus(record.status)) {
      return { jobId, outcome: "already-terminal", alreadyTerminal: true, record };
    }
    const pid = record.pid;
    if (pid === undefined) {
      // `staged`: no process to signal yet. Label it honestly and stop.
      const stored = await applyTransition(jobId, "killed", { at: clock.now(), exitCode: null });
      return { jobId, outcome: "already-dead", alreadyTerminal: false, record: stored ?? record };
    }

    const grace = killOptions.graceMs ?? killGraceMs;
    const local = entry?.local;
    if (!local) {
      // Adopted job: prove ownership before signalling anything (I-c).
      const ownership = processPort.checkPidOwnership(record);
      if (ownership === "unsafe") return refuseAsOrphan(jobId, record);
      if (ownership === "dead") {
        const stored = await applyTransition(jobId, "exited_unknown", { at: clock.now(), exitCode: null });
        ensurePolling();
        return { jobId, outcome: "already-dead", alreadyTerminal: false, record: stored ?? record };
      }
    }

    if (local) local.termination = "killed";
    const outcome = await processPort.killJobTree(pid, {
      ...(grace !== undefined ? { graceMs: grace } : {}),
      ...(record.procStartTime !== undefined ? { expectedProcStartTime: record.procStartTime } : {}),
    });
    if (outcome === "refused") {
      if (local) delete local.termination;
      return refuseAsOrphan(jobId, record);
    }
    if (local) {
      // The `exit` event is authoritative for a job we own: it carries the
      // real exit code and flushes the log tail. `killed` is already pinned.
      ensurePolling();
      return { jobId, outcome, alreadyTerminal: false, record: entry?.record ?? record };
    }
    const stored = await applyTransition(jobId, "killed", { at: clock.now(), exitCode: null });
    ensurePolling();
    return { jobId, outcome, alreadyTerminal: false, record: stored ?? record };
  }

  async function refuseAsOrphan(jobId: JobId, record: JobRecord): Promise<KillJobResult> {
    const stored = await applyTransition(jobId, "orphaned", { at: clock.now(), exitCode: null });
    return {
      jobId,
      outcome: "refused",
      alreadyTerminal: false,
      reason:
        `job ${jobId} cannot be safely killed: its pid ownership could not be verified ` +
        `(possible pid reuse), so it was marked orphaned instead of signalled`,
      record: stored ?? record,
    };
  }

  // ── recover (§3.6) ───────────────────────────────────────────────────────

  async function recover(): Promise<RecoverSummary> {
    const pruned = await store.pruneExpired();
    const records = await store.loadAll();
    const adopted: JobId[] = [];
    const exitedUnknown: JobId[] = [];
    const orphaned: JobId[] = [];
    const lostStaged: JobId[] = [];
    const foreign: JobId[] = [];

    for (const record of records) {
      // Our own in-flight/settled job: `create()` owns it end to end.
      if (localJobs.has(record.jobId)) continue;
      if (isTerminalJobStatus(record.status)) {
        putRecord(record);
        continue;
      }
      putRecord(record);
      if (record.status === "staged") {
        // The spawn outcome died with the previous process; there is no pid to
        // probe, so `failed` is the only honest label.
        const stored = await applyTransition(record.jobId, "failed", {
          at: clock.now(),
          exitCode: null,
          finalText: "pi exited before this bash job's spawn was confirmed; the process state is unknown.",
        });
        if (stored) lostStaged.push(record.jobId);
        continue;
      }
      // Another *live* pi process still owns this job: hands off entirely.
      if (record.hostPid > 0 && record.hostPid !== hostPid && processPort.probePid(record.hostPid)) {
        foreign.push(record.jobId);
        continue;
      }
      const ownership = processPort.checkPidOwnership(record);
      if (ownership === "alive") {
        // An adopted job is ownerless by definition — nobody is waiting on its
        // tool call anymore, so it becomes notification-eligible (§5).
        await applyPatch(record.jobId, (current) =>
          current.backgroundedAt === undefined ? { ...current, backgroundedAt: clock.now() } : undefined,
        );
        adopted.push(record.jobId);
        continue;
      }
      if (ownership === "dead") {
        const stored = await applyTransition(record.jobId, "exited_unknown", { at: clock.now(), exitCode: null });
        if (stored) exitedUnknown.push(record.jobId);
        continue;
      }
      // "unsafe" — mark and display only; never kill, never announce (§3.6).
      const stored = await applyTransition(record.jobId, "orphaned", { at: clock.now(), exitCode: null });
      if (stored) orphaned.push(record.jobId);
    }

    const pendingNotices = [...entries.values()]
      .map((entry) => entry.record)
      .filter((record) => shouldNotifyJob(record))
      .map((record) => record.jobId);
    ensurePolling();
    return { adopted, exitedUnknown, orphaned, lostStaged, foreign, pendingNotices, pruned };
  }

  // ── public surface ───────────────────────────────────────────────────────

  /** §3.8 — only this host's live, already-handed-off jobs occupy a slot. */
  function backgroundJobCount(): number {
    let count = 0;
    for (const entry of entries.values()) {
      const record = entry.record;
      if (record.status === "running" && record.backgroundedAt !== undefined && record.hostPid === hostPid) count++;
    }
    return count;
  }

  return {
    dir: store.dir,
    maxBackgroundJobs,
    recover,
    create,
    resolve,
    readOutput,
    kill,

    get(jobId) {
      return entries.get(jobId)?.record;
    },

    async load(jobId) {
      const stored = await store.load(jobId);
      return stored ? putRecord(stored) : entries.get(jobId)?.record;
    },

    list() {
      return [...entries.values()].map((entry) => entry.record).sort((a, b) => a.createdAt - b.createdAt);
    },

    markBackgrounded(jobId) {
      const at = clock.now();
      return applyPatch(jobId, (current) =>
        current.backgroundedAt === undefined ? { ...current, backgroundedAt: at } : undefined,
      ).then((record) => {
        ensurePolling();
        return record;
      });
    },

    setFinalText(jobId, text) {
      // Not a transition: the inner tool's text often arrives just after the
      // exit event, and terminal records must still accept it.
      return applyPatch(jobId, (current) => ({ ...current, finalText: truncateFinalText(text) }));
    },

    noteTermination(jobId, reason) {
      const local = entries.get(jobId)?.local;
      if (local) local.termination = reason;
    },

    waitExit(jobId, timeoutMs) {
      const entry = entries.get(jobId);
      if (!entry) return Promise.resolve(undefined);
      if (isTerminalJobStatus(entry.record.status)) return Promise.resolve(entry.record);
      return new Promise<JobRecord | undefined>((resolve) => {
        const waiter: Waiter = {
          resolve,
          timer: clock.setTimer(Math.max(0, timeoutMs), () => {
            entry.waiters.delete(waiter);
            // Z1: a wait never fails — the caller gets the current record.
            resolve(entry.record);
          }),
        };
        entry.waiters.add(waiter);
      });
    },

    backgroundJobCount,

    hasBackgroundCapacity() {
      return backgroundJobCount() < maxBackgroundJobs;
    },

    dispose() {
      disposed = true;
      if (pollTimer !== undefined) {
        clock.clearTimer(pollTimer);
        pollTimer = undefined;
      }
      // Waiters must not outlive the manager; hand them the last known record.
      for (const entry of entries.values()) {
        for (const waiter of entry.waiters) {
          clock.clearTimer(waiter.timer);
          waiter.resolve(entry.record);
        }
        entry.waiters.clear();
      }
      // Deliberately *not* done here (§3.7): no process is signalled, and the
      // log streams stay open so an in-flight job keeps capturing output for
      // the next stack to adopt.
    },
  };
}

function normalizePositive(value: number | undefined, fallback: number): number {
  return value !== undefined && Number.isFinite(value) && value > 0 ? Math.trunc(value) : fallback;
}

function clampOffset(value: number, size: number): number {
  if (!Number.isFinite(value) || value < 0) return 0;
  return Math.min(Math.trunc(value), size);
}

async function fileSize(path: string): Promise<number> {
  try {
    return (await stat(path)).size;
  } catch {
    return 0;
  }
}
