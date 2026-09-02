import type { Millis } from "../core/types.js";

/**
 * bash auto-background (docs/dev/bash-auto-background/plan-fable.md §3.2/§3.5):
 * the pure domain layer for backgrounded bash jobs — record shape, schema
 * validation and the state machine.
 *
 * Layering (mirrors `src/core/`): **no pi imports, no `node:child_process`,
 * no `node:fs`**. Spawning lives in `src/bash/process.ts`, persistence in
 * `src/bash/job-store.ts`; everything here is a pure function over plain data.
 */

/** `b_` + 8 Crockford chars (see `./ids.js`). */
export type JobId = string;

/**
 * §3.2 lifecycle. `staged` is a job whose record exists but whose process has
 * not been confirmed spawned yet; `running` is the only non-terminal live
 * state; the remaining six are terminal (see `TERMINAL_JOB_STATUSES`).
 *
 * - `completed` — process exited 0.
 * - `failed` — process exited non-zero, or spawn itself failed.
 * - `timed_out` — the inner `timeout` parameter expired and killed the tree.
 * - `killed` — `bash_job kill` or a foreground caller abort killed the tree.
 * - `exited_unknown` — recovery found the pid gone; the exit code is lost but
 *   the log file survives.
 * - `orphaned` — recovery could not safely attribute the pid (pid reuse
 *   guard, §3.3). Marked only, **never killed**.
 */
export type JobStatus =
  "staged" | "running" | "completed" | "failed" | "timed_out" | "killed" | "exited_unknown" | "orphaned";

/** Every status, in lifecycle order. Exhaustive by construction (see types.test.ts). */
export const JOB_STATUSES: readonly JobStatus[] = [
  "staged",
  "running",
  "completed",
  "failed",
  "timed_out",
  "killed",
  "exited_unknown",
  "orphaned",
];

/** §3.2 terminal set: once entered, a job never moves again. */
export const TERMINAL_JOB_STATUSES: ReadonlySet<JobStatus> = new Set<JobStatus>([
  "completed",
  "failed",
  "timed_out",
  "killed",
  "exited_unknown",
  "orphaned",
]);

export function isTerminalJobStatus(status: JobStatus): boolean {
  return TERMINAL_JOB_STATUSES.has(status);
}

export function isJobStatus(value: unknown): value is JobStatus {
  return typeof value === "string" && (JOB_STATUSES as readonly string[]).includes(value);
}

/**
 * §3.5 on-disk schema version. Bump only for breaking record changes; the
 * store treats any other value as an unreadable file (WARN + skip) rather
 * than guessing at a migration.
 */
export const JOB_RECORD_VERSION = 1 as const;

/** Cap for the persisted `finalText` (the inner bash tool's final text/error text). */
export const FINAL_TEXT_MAX_BYTES = 16 * 1024;

/** Cap for one-line command previews rendered by `bash_job list` / `/agent status`. */
export const COMMAND_PREVIEW_MAX = 200;

/**
 * §3.5 persisted job record — one JSON file per job. Optional fields are
 * genuinely absent (not `undefined`) on disk: `exactOptionalPropertyTypes` is
 * on, so builders below use conditional spreads rather than `x: undefined`.
 */
export interface JobRecord {
  readonly v: typeof JOB_RECORD_VERSION;
  readonly jobId: JobId;
  /** Full command as given to the tool (never truncated; see `previewCommand`). */
  readonly command: string;
  readonly cwd: string;
  readonly sessionId: string;
  /** pid of the pi process that created the job — used for adoption scoping (§3.4). */
  readonly hostPid: number;
  /** Child pid; absent while `staged` or when the spawn failed. */
  readonly pid?: number;
  /** POSIX detached child is a group leader, so this equals `pid` in practice. */
  readonly pgid?: number;
  /** `/proc/<pid>/stat` field 22 (Linux best-effort) — pid-reuse guard (§3.3). */
  readonly procStartTime?: string;
  readonly status: JobStatus;
  readonly createdAt: Millis;
  readonly spawnedAt?: Millis;
  /** Set when the call was handed back to the model as a job (§2.4). */
  readonly backgroundedAt?: Millis;
  readonly endedAt?: Millis;
  /** `null` when unknown (still running, or killed by a signal / `exited_unknown`). */
  readonly exitCode: number | null;
  /** Inner tool's final text or error text, tail-truncated to FINAL_TEXT_MAX_BYTES. */
  readonly finalText?: string;
  readonly logPath: string;
  readonly logBytes: number;
  /** True once the log hit `maxLogBytes` and further output was dropped (§3.4). */
  readonly outputTruncated: boolean;
  /** Set once the completion notification was delivered (§5 idempotency key). */
  readonly notifiedAt?: Millis;
  /**
   * Persisted incremental-read offset. **No longer driven by the tool layer**:
   * `bash_job status` reads a bounded tail with `advanceCursor: false`, and the
   * completion notice always did. The field is kept because the on-disk record
   * schema (`v: 1`) must stay readable across versions, and because an internal
   * consumer (or a future action) may want a resumable cursor again.
   */
  readonly readCursor: number;
}

/**
 * Human phrase for a job's outcome, carrying the exit code when there is one.
 * Lives here (not in the tool layer) because the log footer written by the
 * manager must use exactly the same wording as the model-facing tool text.
 */
export function describeJobStatus(record: Pick<JobRecord, "status" | "exitCode">): string {
  const code = record.exitCode;
  switch (record.status) {
    case "staged":
      return "not started yet";
    case "running":
      return "running";
    case "completed":
      return `completed (exit ${code ?? 0})`;
    case "failed":
      return code === null ? "failed (no exit code)" : `failed (exit ${code})`;
    case "timed_out":
      return "timed out";
    case "killed":
      return "killed";
    case "exited_unknown":
      return "gone (its process disappeared, exit code lost)";
    case "orphaned":
      return "orphaned (left behind by an earlier pi process)";
  }
}

/** Prefix of the terminal footer line appended to a job log (change B). */
export const JOB_LOG_FOOTER_PREFIX = "[pi-subagent]";

/**
 * The single line appended to a job's log when it reaches a terminal state, so
 * the log is self-contained: `tail -3 <log>` answers "how did this end?"
 * without a tool call. Wording is `describeJobStatus`, so no exit code is
 * invented for killed / timed-out / exit-code-lost jobs.
 */
export function formatJobLogFooter(input: {
  jobId: JobId;
  status: JobStatus;
  exitCode: number | null;
  duration: string;
}): string {
  const phrase = describeJobStatus({ status: input.status, exitCode: input.exitCode });
  return `${JOB_LOG_FOOTER_PREFIX} job ${input.jobId} ${phrase} after ${input.duration}`;
}

/** One-line, length-capped command preview for UI/model-facing summaries. */
export function previewCommand(command: string, max: number = COMMAND_PREVIEW_MAX): string {
  const oneLine = command.replace(/\s+/g, " ").trim();
  return oneLine.length <= max ? oneLine : `${oneLine.slice(0, Math.max(0, max - 1))}…`;
}

/** Tail-truncate the inner tool's final text; the tail carries the exit status line. */
export function truncateFinalText(text: string, max: number = FINAL_TEXT_MAX_BYTES): string {
  return text.length <= max ? text : text.slice(text.length - max);
}

export interface NewJobRecordInit {
  jobId: JobId;
  command: string;
  cwd: string;
  sessionId: string;
  hostPid: number;
  logPath: string;
  createdAt: Millis;
}

/** Build a fresh `staged` record. Pure; the store decides when it hits disk. */
export function createJobRecord(init: NewJobRecordInit): JobRecord {
  return {
    v: JOB_RECORD_VERSION,
    jobId: init.jobId,
    command: init.command,
    cwd: init.cwd,
    sessionId: init.sessionId,
    hostPid: init.hostPid,
    status: "staged",
    createdAt: init.createdAt,
    exitCode: null,
    logPath: init.logPath,
    logBytes: 0,
    outputTruncated: false,
    readCursor: 0,
  };
}

/**
 * §3.2 transition table. `staged` may also reach `killed` directly: a caller
 * abort can land before the spawn callback resolves, and `killed` is the
 * honest label for that (documented addition to the plan's diagram, which only
 * draws `staged → running | failed`).
 *
 * Terminal states are sinks — including self-transitions, so a double
 * `exit` callback or a re-`recover()` can never rewrite an exit code.
 */
export const ALLOWED_JOB_TRANSITIONS: Readonly<Record<JobStatus, readonly JobStatus[]>> = {
  staged: ["running", "failed", "killed"],
  running: ["completed", "failed", "timed_out", "killed", "exited_unknown", "orphaned"],
  completed: [],
  failed: [],
  timed_out: [],
  killed: [],
  exited_unknown: [],
  orphaned: [],
};

export function canTransitionJob(from: JobStatus, to: JobStatus): boolean {
  return (ALLOWED_JOB_TRANSITIONS[from] as readonly string[]).includes(to);
}

/** Fields a transition is allowed to stamp alongside the status change. */
export interface JobTransitionPatch {
  /** Wall-clock of the transition: fills `spawnedAt` / `endedAt`. */
  at: Millis;
  exitCode?: number | null;
  finalText?: string;
  pid?: number;
  pgid?: number;
  procStartTime?: string;
  logBytes?: number;
  outputTruncated?: boolean;
}

export type JobTransition =
  { readonly ok: true; readonly record: JobRecord } | { readonly ok: false; readonly reason: string };

/**
 * Pure state transition. Rejects illegal moves instead of throwing so callers
 * (manager, recovery) can log and continue — an illegal transition is a bug
 * signal, never a reason to lose a live process.
 */
export function transitionJob(record: JobRecord, to: JobStatus, patch: JobTransitionPatch): JobTransition {
  if (!canTransitionJob(record.status, to)) {
    return { ok: false, reason: `illegal bash job transition ${record.status} -> ${to} (${record.jobId})` };
  }
  const next: {
    -readonly [K in keyof JobRecord]: JobRecord[K];
  } = { ...record, status: to };
  if (to === "running" && record.spawnedAt === undefined) next.spawnedAt = patch.at;
  if (isTerminalJobStatus(to)) next.endedAt = patch.at;
  if (patch.exitCode !== undefined) next.exitCode = patch.exitCode;
  if (patch.finalText !== undefined) next.finalText = truncateFinalText(patch.finalText);
  if (patch.pid !== undefined) next.pid = patch.pid;
  if (patch.pgid !== undefined) next.pgid = patch.pgid;
  if (patch.procStartTime !== undefined) next.procStartTime = patch.procStartTime;
  if (patch.logBytes !== undefined) next.logBytes = patch.logBytes;
  if (patch.outputTruncated !== undefined) next.outputTruncated = patch.outputTruncated;
  return { ok: true, record: next };
}

/** True when the job reached a terminal state but no notification has gone out (§5). */
export function needsCompletionNotice(record: JobRecord): boolean {
  return isTerminalJobStatus(record.status) && record.notifiedAt === undefined;
}

export type JobRecordParse =
  { readonly ok: true; readonly record: JobRecord } | { readonly ok: false; readonly reason: string };

function finiteNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}
function nonEmptyString(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

/**
 * Schema-validate an untrusted parsed JSON blob (§3.5). Identity fields are
 * mandatory — a record without them cannot be acted on safely — while
 * cosmetic/derived fields fall back field-by-field (the `loadSettings`
 * tolerance model). Never throws.
 */
export function parseJobRecord(value: unknown): JobRecordParse {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return { ok: false, reason: "record is not a JSON object" };
  }
  const raw = value as Record<string, unknown>;
  if (raw.v !== JOB_RECORD_VERSION) {
    return { ok: false, reason: `unsupported schema version ${JSON.stringify(raw.v)}` };
  }
  const jobId = nonEmptyString(raw.jobId);
  if (jobId === undefined) return { ok: false, reason: "missing jobId" };
  const command = typeof raw.command === "string" ? raw.command : undefined;
  if (command === undefined) return { ok: false, reason: `missing command (${jobId})` };
  if (!isJobStatus(raw.status)) return { ok: false, reason: `unknown status ${JSON.stringify(raw.status)} (${jobId})` };
  const createdAt = finiteNumber(raw.createdAt);
  if (createdAt === undefined) return { ok: false, reason: `missing createdAt (${jobId})` };
  const logPath = nonEmptyString(raw.logPath);
  if (logPath === undefined) return { ok: false, reason: `missing logPath (${jobId})` };

  const logBytes = finiteNumber(raw.logBytes);
  const readCursor = finiteNumber(raw.readCursor);
  const pid = finiteNumber(raw.pid);
  const pgid = finiteNumber(raw.pgid);
  const spawnedAt = finiteNumber(raw.spawnedAt);
  const backgroundedAt = finiteNumber(raw.backgroundedAt);
  const endedAt = finiteNumber(raw.endedAt);
  const notifiedAt = finiteNumber(raw.notifiedAt);
  const procStartTime = nonEmptyString(raw.procStartTime);
  const finalText = typeof raw.finalText === "string" ? raw.finalText : undefined;

  return {
    ok: true,
    record: {
      v: JOB_RECORD_VERSION,
      jobId,
      command,
      cwd: typeof raw.cwd === "string" ? raw.cwd : "",
      sessionId: typeof raw.sessionId === "string" ? raw.sessionId : "",
      hostPid: finiteNumber(raw.hostPid) ?? 0,
      status: raw.status,
      createdAt,
      exitCode: finiteNumber(raw.exitCode) ?? null,
      logPath,
      logBytes: logBytes !== undefined && logBytes >= 0 ? logBytes : 0,
      outputTruncated: raw.outputTruncated === true,
      readCursor: readCursor !== undefined && readCursor >= 0 ? readCursor : 0,
      ...(pid !== undefined ? { pid } : {}),
      ...(pgid !== undefined ? { pgid } : {}),
      ...(procStartTime !== undefined ? { procStartTime } : {}),
      ...(spawnedAt !== undefined ? { spawnedAt } : {}),
      ...(backgroundedAt !== undefined ? { backgroundedAt } : {}),
      ...(endedAt !== undefined ? { endedAt } : {}),
      ...(finalText !== undefined ? { finalText } : {}),
      ...(notifiedAt !== undefined ? { notifiedAt } : {}),
    },
  };
}
