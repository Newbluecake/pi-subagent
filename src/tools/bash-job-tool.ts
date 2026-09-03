import { Type, type Static } from "@sinclair/typebox";
import { Text } from "@earendil-works/pi-tui";
import { formatSize, truncateTail, type ToolDefinition } from "@earendil-works/pi-coding-agent";
import type { Millis } from "../core/types.js";
import type { BashJobManager, JobOutputRead } from "../bash/manager.js";
import { describeJobStatus, isTerminalJobStatus, previewCommand, type JobRecord } from "../bash/types.js";
import { formatDuration } from "../ui/fleet-panel.js";

/**
 * "bash_job" — the management surface for bash commands that were moved to
 * the background (docs/dev/bash-auto-background/plan-fable.md section 4).
 *
 * One tool with an `action` discriminator rather than four tools (decision
 * D5): all four actions are small CRUD operations on the same entity and
 * share the `job_id` parameter, and this plugin already contributes five
 * tools to the table.
 *
 * **The log is a plain file.** There is deliberately no `output` action: the
 * model reads `record.logPath` with the `read` tool or with tail/grep/awk,
 * which is strictly more capable than any parameter set this tool could
 * offer. `status` therefore returns a state summary *plus* a bounded log tail
 * (enough to answer "what is it doing / how did it end?"), and points at the
 * file for anything larger or more targeted.
 *
 * Zero-hang rules inherited from the rest of the plugin:
 * - `wait` is bounded (default 30s, hard cap 120s) and **returns** the current
 *   status on timeout instead of throwing;
 * - `kill` is idempotent — an already finished job is reported, not an error —
 *   and carries the pid-reuse / process-group safety checks (I-c), which is
 *   why it stays a tool rather than becoming "just run kill in bash";
 * - reads never consume a job: `status` never advances a cursor, so it can be
 *   polled freely.
 *
 * Only genuine caller errors throw: an unresolvable `job_id`, a missing
 * `job_id`, a kill that had to be refused for safety, or no active session.
 */

/** Default `wait` budget when the model does not ask for one. */
export const DEFAULT_WAIT_MS = 30_000;
/** Hard cap on `wait`, so a single call can never become a new hang point. */
export const MAX_WAIT_MS = 120_000;
/** Bytes of log tail `status` may read (context-frugal on purpose). */
export const STATUS_TAIL_BYTES = 2048;
/** Lines of log tail `status` shows out of those bytes. */
export const STATUS_TAIL_LINES = 20;

export const BashJobToolParams = Type.Object({
  action: Type.Union([Type.Literal("status"), Type.Literal("wait"), Type.Literal("kill"), Type.Literal("list")], {
    description:
      "status: state summary plus the tail of the job's log; " +
      "wait: block (bounded) until the job exits — while it blocks, the user cannot send new input, so prefer " +
      "status (or simply continuing other work) unless there is nothing else to do; " +
      "kill: terminate the process tree; list: all known jobs.",
  }),
  job_id: Type.Optional(
    Type.String({
      description:
        "Job id returned by a bash call that was moved to the background; a unique prefix is accepted. " +
        "Required for every action except list.",
    }),
  ),
  wait_ms: Type.Optional(
    Type.Number({
      description:
        "wait only: max milliseconds to block (default 30000, capped at 120000). " +
        "Returns the current status on timeout instead of failing.",
    }),
  ),
});
export type BashJobToolParams = Static<typeof BashJobToolParams>;

export interface BashJobToolDeps {
  /** Late-bound so the tool can be registered once and survive session rebuilds. */
  manager: () => BashJobManager | undefined;
  /** Injectable clock for deterministic durations in tests. */
  now?: () => Millis;
}

// ── formatting helpers (model-facing text) ─────────────────────────────────

function jobLabel(record: JobRecord): string {
  return `Bash job ${record.jobId} ($ ${previewCommand(record.command, 60)})`;
}

export { describeJobStatus };

function elapsedMs(record: JobRecord, now: Millis): Millis {
  const start = record.spawnedAt ?? record.createdAt;
  const end = record.endedAt ?? now;
  return Math.max(0, end - start);
}

/** One-sentence summary shared by status / wait / kill. */
export function formatJobSummary(record: JobRecord, now: Millis): string {
  const duration = formatDuration(elapsedMs(record, now));
  const parts: string[] = [];
  if (record.pid !== undefined && !isTerminalJobStatus(record.status)) parts.push(`pid ${record.pid}`);
  parts.push(`log ${formatSize(record.logBytes)}`);
  if (record.outputTruncated) parts.push("log size cap reached");
  const tail = ` (${parts.join(", ")})`;
  const phrase = describeJobStatus(record);
  return isTerminalJobStatus(record.status)
    ? `${jobLabel(record)}: ${phrase} after ${duration}${tail}.`
    : `${jobLabel(record)}: ${phrase} for ${duration}${tail}.`;
}

/**
 * The closing status line for a finished job. The inner bash tool's own text
 * ("Command exited with code 1", "Command timed out after 5 seconds", ...) is
 * authoritative when present; otherwise it is synthesized from the record.
 */
export function finalStatusLine(record: JobRecord): string {
  const fromInner = lastCommandLine(record.finalText);
  if (fromInner) return fromInner;
  switch (record.status) {
    case "completed":
      return `Command exited with code ${record.exitCode ?? 0}`;
    case "failed":
      return record.exitCode === null
        ? "Command failed before reporting an exit code"
        : `Command exited with code ${record.exitCode}`;
    case "timed_out":
      return "Command timed out and its process tree was killed";
    case "killed":
      return "Command was killed";
    case "exited_unknown":
      return "Command's process is gone; its exit code could not be recovered";
    case "orphaned":
      return "Job was left behind by an earlier pi process; its process could not be verified";
    default:
      return `Command is ${describeJobStatus(record)}`;
  }
}

function lastCommandLine(finalText: string | undefined): string | undefined {
  if (!finalText) return undefined;
  const lines = finalText
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.length > 0);
  const last = lines[lines.length - 1];
  return last !== undefined && last.startsWith("Command ") ? last : undefined;
}

function jobDetails(record: JobRecord, now: Millis): Record<string, unknown> {
  return {
    jobId: record.jobId,
    status: record.status,
    exitCode: record.exitCode,
    backgrounded: record.backgroundedAt !== undefined,
    terminal: isTerminalJobStatus(record.status),
    command: previewCommand(record.command),
    logPath: record.logPath,
    logBytes: record.logBytes,
    logTruncated: record.outputTruncated,
    durationMs: elapsedMs(record, now),
    ...(record.pid !== undefined ? { pid: record.pid } : {}),
    ...(record.spawnedAt !== undefined ? { startedAt: record.spawnedAt } : {}),
    ...(record.endedAt !== undefined ? { endedAt: record.endedAt } : {}),
  };
}

function listLine(record: JobRecord, now: Millis): string {
  const age = formatDuration(Math.max(0, now - record.createdAt));
  return `${record.jobId} · ${describeJobStatus(record)} · $ ${previewCommand(record.command, 60)} · ${age} ago`;
}

function text(value: string): { content: [{ type: "text"; text: string }] } {
  return { content: [{ type: "text" as const, text: value }] };
}

// ── status assembly (summary + bounded log tail) ───────────────────────────

/** The model is told, everywhere, that the log is an ordinary file. */
export function formatLogFileHint(logPath: string): string {
  return (
    `Full log: ${logPath} — a plain file: read it directly with the read tool, or with tail/grep/awk. ` +
    `Prefer grep/tail over reading a large log whole.`
  );
}

function tailOffset(size: number): number {
  return Math.max(0, size - STATUS_TAIL_BYTES);
}

function lastLines(content: string, max: number): string {
  const trimmed = content.replace(/\n+$/, "");
  if (trimmed.length === 0) return "";
  const lines = trimmed.split("\n");
  return lines.slice(Math.max(0, lines.length - max)).join("\n");
}

/**
 * Best-effort tail read for `status`. Never advances the persisted cursor —
 * `status` is a pollable, side-effect-free view — and never throws: a missing
 * or unreadable log costs the tail, not the status.
 *
 * Two passes, like the completion notice: a record's `logBytes` can lag behind
 * the file (adopted jobs, throttled counters), and the first read reports the
 * real size.
 */
async function readStatusTail(manager: BashJobManager, record: JobRecord): Promise<JobOutputRead | undefined> {
  const options = { advanceCursor: false as const, maxBytes: STATUS_TAIL_BYTES };
  try {
    let read = await manager.readOutput(record.jobId, { ...options, offset: tailOffset(record.logBytes) });
    if (read.logBytes > record.logBytes) {
      read = await manager.readOutput(record.jobId, { ...options, offset: tailOffset(read.logBytes) });
    }
    return read;
  } catch {
    return undefined;
  }
}

function formatStatus(record: JobRecord, read: JobOutputRead | undefined, at: Millis): string {
  const lines: string[] = [formatJobSummary(record, at)];
  const raw = read ? lastLines(read.content, STATUS_TAIL_LINES) : "";
  if (raw.length > 0) {
    // truncateTail is pi's own context guard: even 20 lines can be huge.
    lines.push(`--- log tail (last ${STATUS_TAIL_LINES} lines, ${formatSize(read!.logBytes)} total) ---`);
    lines.push(truncateTail(raw).content, "---");
  } else {
    lines.push(read && read.logBytes > 0 ? "(no readable log tail)" : "(the log is empty so far)");
  }
  if (record.outputTruncated) lines.push("(the job's log hit its size cap; some output was dropped)");
  lines.push(formatLogFileHint(record.logPath));
  return lines.join("\n");
}

// ── tool ───────────────────────────────────────────────────────────────────

export function createBashJobTool(deps: BashJobToolDeps): ToolDefinition<typeof BashJobToolParams> {
  const now = deps.now ?? (() => Date.now());

  function requireManager(): BashJobManager {
    const manager = deps.manager();
    if (!manager) throw new Error("pi-subagent: no active session yet, bash jobs are unavailable");
    return manager;
  }

  function requireJobId(params: BashJobToolParams): string {
    const handle = params.job_id?.trim();
    if (!handle) throw new Error(`bash_job(action: "${params.action}") requires job_id`);
    return handle;
  }

  async function loadRecord(manager: BashJobManager, jobId: string): Promise<JobRecord> {
    const record = (await manager.load(jobId)) ?? manager.get(jobId);
    if (!record) throw new Error(`bash job not found: ${jobId}`);
    return record;
  }

  return {
    name: "bash_job",
    label: "Bash Job",
    description:
      "Manage bash commands that were moved to the background (a bash call that runs past the threshold returns a " +
      "job_id instead of blocking; the process keeps running with its output captured to a log file). " +
      "Actions: status (state summary plus the tail of the log), wait (block up to wait_ms, returns the current " +
      "status on timeout; while it blocks the user cannot send new input, so prefer status or continuing other " +
      "work unless there is nothing else to do), kill (terminate the process tree; safe to repeat), list (this " +
      "session's jobs). " +
      "The log is a plain file: for the full or a targeted view, read its path directly with the read tool or with " +
      "tail/grep/awk instead of calling this tool (grep a large log rather than reading it whole). " +
      "list and status only expose jobs started by this session. Nothing here consumes the job, so status is safe to poll.",
    promptSnippet:
      'bash_job(action: "status"|"wait"|"kill"|"list", job_id?, wait_ms?) - inspect, wait for, or stop a ' +
      "backgrounded bash command (job_id comes from the bash call that was moved to the background; a unique prefix " +
      "works); its log is a plain file you can also read/tail/grep directly",
    parameters: BashJobToolParams,
    renderCall(args, theme, context) {
      const component = (context.lastComponent as Text | undefined) ?? new Text("", 0, 0);
      const action = args?.action ?? "…";
      const target = args?.action === "list" ? "" : ` ${args?.job_id ?? "…"}`;
      component.setText(theme.fg("toolTitle", theme.bold(`bash_job ${action}${target}`)));
      return component;
    },

    async execute(_toolCallId, params, signal) {
      const manager = requireManager();

      if (params.action === "list") {
        const records = manager.list();
        const at = now();
        if (records.length === 0) return { ...text("no bash jobs"), details: { count: 0, jobs: [] } };
        const lines = records.map((record) => listLine(record, at));
        return {
          ...text(`${records.length} bash job${records.length === 1 ? "" : "s"}:\n${lines.join("\n")}`),
          details: { count: records.length, jobs: records.map((record) => jobDetails(record, at)) },
        };
      }

      // Resolution (exact id or unique prefix) throws a candidate-listing
      // error the model can self-correct from.
      const jobId = manager.resolve(requireJobId(params));

      if (params.action === "status") {
        const record = await loadRecord(manager, jobId);
        const at = now();
        // The tail read is side-effect free (advanceCursor: false), so status
        // stays a safe poll: it never hides output from a later read.
        const read = await readStatusTail(manager, record);
        return {
          ...text(formatStatus(record, read, at)),
          details: {
            ...jobDetails(record, at),
            tailBytes: read ? read.nextOffset - read.startOffset : 0,
            tailFromOffset: read?.startOffset ?? 0,
          },
        };
      }

      if (params.action === "wait") {
        const requested = Number.isFinite(params.wait_ms ?? NaN) ? Math.trunc(params.wait_ms as number) : undefined;
        const waitMs = Math.min(MAX_WAIT_MS, Math.max(0, requested ?? DEFAULT_WAIT_MS));
        const before = await loadRecord(manager, jobId);
        // The abort signal matters here: without it the wait outlasts Esc and
        // session teardown (/exit) until wait_ms fires, wedging the turn.
        const record = isTerminalJobStatus(before.status)
          ? before
          : ((await manager.waitExit(jobId, waitMs, { signal })) ?? (await loadRecord(manager, jobId)));
        if (signal?.aborted) throw new Error("wait was aborted");
        const at = now();
        const finished = isTerminalJobStatus(record.status);
        const suffix = finished
          ? `\n${finalStatusLine(record)}\n${formatLogFileHint(record.logPath)}`
          : `\nStill running after waiting ${formatDuration(waitMs)}; the job was not stopped. ` +
            "Wait again, keep working, or wait for its completion notification.";
        return {
          ...text(`${formatJobSummary(record, at)}${suffix}`),
          details: { ...jobDetails(record, at), waitedMs: waitMs, finished },
        };
      }

      // kill
      const existing = await loadRecord(manager, jobId);
      if (existing.status === "orphaned") throw new Error(orphanRefusal(jobId));
      const result = await manager.kill(jobId);
      const at = now();
      const phrase = describeJobStatus(result.record);
      if (result.outcome === "refused") throw new Error(result.reason ?? orphanRefusal(jobId));
      if (result.alreadyTerminal && result.outcome !== "already-terminal") {
        return {
          ...text(
            `Bash job ${jobId} had already finished (${phrase}); ${result.reason ?? "surviving pipe holders were handled"}.\n` +
              formatLogFileHint(result.record.logPath),
          ),
          details: { ...jobDetails(result.record, at), alreadyTerminal: true, killed: true, outcome: result.outcome },
        };
      }
      if (result.alreadyTerminal) {
        return {
          ...text(
            `Bash job ${jobId} has already finished (${phrase}); nothing to kill.\n` +
              formatLogFileHint(result.record.logPath),
          ),
          details: { ...jobDetails(result.record, at), alreadyTerminal: true, killed: false },
        };
      }
      const how = result.outcome === "already-dead" ? "its process was already gone" : `signalled (${result.outcome})`;
      return {
        ...text(
          `Bash job ${jobId} ($ ${previewCommand(result.record.command, 60)}): ${how}.\n` +
            formatLogFileHint(result.record.logPath),
        ),
        details: { ...jobDetails(result.record, at), alreadyTerminal: false, killed: true, outcome: result.outcome },
      };
    },
  } satisfies ToolDefinition<typeof BashJobToolParams>;
}

function orphanRefusal(jobId: string): string {
  return (
    `bash job ${jobId} was left behind by an earlier pi process and cannot be safely killed ` +
    "(its process identity could not be verified, so killing it might hit an unrelated process)"
  );
}
