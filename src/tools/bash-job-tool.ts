import { Type, type Static } from "@sinclair/typebox";
import { Text } from "@earendil-works/pi-tui";
import { formatSize, truncateTail, type ToolDefinition } from "@earendil-works/pi-coding-agent";
import type { Millis } from "../core/types.js";
import type { BashJobManager, JobOutputRead } from "../bash/manager.js";
import { isTerminalJobStatus, previewCommand, type JobRecord } from "../bash/types.js";
import { formatDuration } from "../ui/fleet-panel.js";

/**
 * "bash_job" — the management surface for bash commands that were moved to
 * the background (docs/dev/bash-auto-background/plan-fable.md section 4).
 *
 * One tool with an `action` discriminator rather than five tools (decision
 * D5): all five actions are small CRUD operations on the same entity and
 * share the `job_id` parameter, and this plugin already contributes five
 * tools to the table.
 *
 * Zero-hang rules inherited from the rest of the plugin:
 * - `wait` is bounded (default 30s, hard cap 120s) and **returns** the current
 *   status on timeout instead of throwing;
 * - `kill` is idempotent — an already finished job is reported, not an error;
 * - `output` is re-readable: reads advance a persisted cursor but never
 *   consume or delete the job.
 *
 * Only genuine caller errors throw: an unresolvable `job_id`, a missing
 * `job_id`, a kill that had to be refused for safety, or no active session.
 */

/** Default `wait` budget when the model does not ask for one. */
export const DEFAULT_WAIT_MS = 30_000;
/** Hard cap on `wait`, so a single call can never become a new hang point. */
export const MAX_WAIT_MS = 120_000;

export const BashJobToolParams = Type.Object({
  action: Type.Union(
    [Type.Literal("status"), Type.Literal("output"), Type.Literal("wait"), Type.Literal("kill"), Type.Literal("list")],
    {
      description:
        "status: state summary; output: incremental output since your last read; " +
        "wait: block (bounded) until the job exits; kill: terminate the process tree; list: all known jobs.",
    },
  ),
  job_id: Type.Optional(
    Type.String({
      description:
        "Job id returned by a bash call that was moved to the background; a unique prefix is accepted. " +
        "Required for every action except list.",
    }),
  ),
  offset: Type.Optional(
    Type.Number({
      description:
        "output only: byte offset to read from (default: continue from the last read position; 0 = from the beginning).",
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

/** Human phrase for a status, carrying the exit code when there is one. */
export function describeJobStatus(record: JobRecord): string {
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

// ── output assembly ────────────────────────────────────────────────────────

function outputFootnote(read: JobOutputRead, truncatedIncrement: boolean, shownBytes: number): string {
  const bytesRead = read.nextOffset - read.startOffset;
  const state = isTerminalJobStatus(read.state) ? `job ${read.state}` : "job still running";
  const notes = [`[read bytes ${read.startOffset}-${read.nextOffset} of ${read.logBytes}; ${state}]`];
  if (truncatedIncrement) {
    notes.push(
      `[this increment was clipped to its last ${formatSize(shownBytes)} of ${formatSize(bytesRead)}; ` +
        `re-read the skipped part with offset: ${read.startOffset}]`,
    );
  }
  if (read.logTruncated) notes.push("[the job's log hit its size cap; some output was dropped]");
  if (read.nextOffset < read.logBytes) {
    notes.push(`[more output is available; call output again to continue from byte ${read.nextOffset}]`);
  }
  return notes.join("\n");
}

function formatOutput(read: JobOutputRead): string {
  const truncation = truncateTail(read.content);
  const body = truncation.content.length > 0 ? truncation.content : "(no new output)";
  const footnote = outputFootnote(read, truncation.truncated, truncation.outputBytes);
  const done = isTerminalJobStatus(read.state) && read.nextOffset >= read.logBytes;
  const closing = done ? `\n${finalStatusLine(read.record)}` : "";
  return `${body}\n\n${footnote}${closing}`;
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
      "Actions: status (state summary), output (incremental output since your last read), wait (block up to wait_ms, " +
      "returns the current status on timeout), kill (terminate the process tree; safe to repeat), list (all known jobs). " +
      "Reading output never consumes the job, so you can keep polling it.",
    promptSnippet:
      'bash_job(action: "status"|"output"|"wait"|"kill"|"list", job_id?, offset?, wait_ms?) - inspect, wait for, or ' +
      "stop a backgrounded bash command (job_id comes from the bash call that was moved to the background; a unique prefix works)",
    parameters: BashJobToolParams,
    renderCall(args, theme, context) {
      const component = (context.lastComponent as Text | undefined) ?? new Text("", 0, 0);
      const action = args?.action ?? "…";
      const target = args?.action === "list" ? "" : ` ${args?.job_id ?? "…"}`;
      component.setText(theme.fg("toolTitle", theme.bold(`bash_job ${action}${target}`)));
      return component;
    },

    async execute(_toolCallId, params) {
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
        const suffix = isTerminalJobStatus(record.status)
          ? `\nCollect its output with bash_job(action: "output", job_id: "${jobId}").`
          : "";
        return { ...text(`${formatJobSummary(record, at)}${suffix}`), details: jobDetails(record, at) };
      }

      if (params.action === "output") {
        const read = await manager.readOutput(
          jobId,
          params.offset !== undefined && Number.isFinite(params.offset)
            ? { offset: Math.max(0, Math.trunc(params.offset)) }
            : {},
        );
        return {
          ...text(formatOutput(read)),
          details: {
            ...jobDetails(read.record, now()),
            startOffset: read.startOffset,
            nextOffset: read.nextOffset,
            bytesRead: read.nextOffset - read.startOffset,
            done: isTerminalJobStatus(read.state) && read.nextOffset >= read.logBytes,
          },
        };
      }

      if (params.action === "wait") {
        const requested = Number.isFinite(params.wait_ms ?? NaN) ? Math.trunc(params.wait_ms as number) : undefined;
        const waitMs = Math.min(MAX_WAIT_MS, Math.max(0, requested ?? DEFAULT_WAIT_MS));
        const before = await loadRecord(manager, jobId);
        const record = isTerminalJobStatus(before.status)
          ? before
          : ((await manager.waitExit(jobId, waitMs)) ?? (await loadRecord(manager, jobId)));
        const at = now();
        const finished = isTerminalJobStatus(record.status);
        const suffix = finished
          ? `\n${finalStatusLine(record)}\nCollect its output with bash_job(action: "output", job_id: "${jobId}").`
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
      if (result.outcome === "refused") throw new Error(result.reason ?? orphanRefusal(jobId));
      if (result.alreadyTerminal) {
        const phrase = describeJobStatus(result.record);
        return {
          ...text(
            `Bash job ${jobId} has already finished (${phrase}); nothing to kill.\n` +
              `Collect its output with bash_job(action: "output", job_id: "${jobId}").`,
          ),
          details: { ...jobDetails(result.record, at), alreadyTerminal: true, killed: false },
        };
      }
      const how = result.outcome === "already-dead" ? "its process was already gone" : `signalled (${result.outcome})`;
      return {
        ...text(
          `Bash job ${jobId} ($ ${previewCommand(result.record.command, 60)}): ${how}. ` +
            `Its captured output is still readable with bash_job(action: "output", job_id: "${jobId}").`,
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
