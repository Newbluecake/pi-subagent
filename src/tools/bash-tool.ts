import { Type, type Static } from "@sinclair/typebox";
import { createBashToolDefinition } from "@earendil-works/pi-coding-agent";
import type {
  BashOperations,
  BashToolDetails,
  ExtensionContext,
  ToolDefinition,
} from "@earendil-works/pi-coding-agent";
import type { BashJobManager, CreatedJob } from "../bash/manager.js";
import type { JobId } from "../bash/types.js";
import { formatDuration } from "../ui/fleet-panel.js";

/**
 * bash auto-background §2 — the same-name override of pi's built-in `bash`
 * tool: a foreground call that outlives the configured threshold returns early
 * with a `job_id` while **the process keeps running** (§1 Z1/Z2).
 *
 * Compatibility doctrine (§2.1/§2.3): the short-command path is not an
 * imitation of the built-in tool, it *is* the built-in tool. Every call builds
 * a real `createBashToolDefinition(ctx.cwd, { operations })` and delegates to
 * its `execute`; output accumulation, truncation, the temp-file footer,
 * `(no output)`, `Command exited with code N`, `Command aborted`,
 * `Command timed out after Ns` and the 100 ms-throttled `onUpdate` stream are
 * all produced by pi's own code, and the resolve/reject is passed through
 * verbatim. The only thing this file owns is:
 *
 *  - `BashOperations.exec` — routed through `BashJobManager` so the process is
 *    a detached group leader with its output tee'd to a job log (the built-in
 *    accumulator still gets every byte, so the foreground result is unchanged);
 *  - `race(inner, threshold)` plus the relay/abort state gate copied from
 *    `agent-tool.ts:318-334`: after backgrounding, a caller abort must **not**
 *    reach the process (§2.4), and the inner promise is handed to the manager
 *    so its eventual settlement lands in `finalText` instead of becoming an
 *    unhandled rejection (§2.3).
 *
 * Layering: no session/stack state is captured — the manager and the threshold
 * arrive as getters so `src/index.ts` can forward the current stack's instance
 * (the extension re-activates in-process on `/reload`).
 */

/**
 * §2.1/R7 — hand-written schema. pi does not export `bashSchema`, and deriving
 * from `inner.parameters` would cross two different typebox instances
 * (`@sinclair/typebox` here, pi's bundled `typebox` there). The `command` /
 * `timeout` descriptions are therefore duplicated verbatim and pinned against
 * the real thing by a drift test (`tests/tools/bash-tool.test.ts` T1).
 */
export const BashToolParams = Type.Object({
  command: Type.String({ description: "Shell command to execute" }),
  timeout: Type.Optional(Type.Number({ description: "Timeout in seconds (optional, no default timeout)" })),
  run_in_background: Type.Optional(
    Type.Boolean({
      description:
        "If true, the command is started in the background immediately and the call returns with a job_id; " +
        "the process keeps running (check on it with the bash_job tool). Use this ONLY for fire-and-forget " +
        "commands whose result you will never need. For a long command whose result you DO need, omit this " +
        "and run it in the foreground — the call returns early on its own once it passes the auto-background " +
        "threshold, so explicitly backgrounding and then blocking on bash_job wait wastes an extra request.",
    }),
  ),
});
export type BashToolParams = Static<typeof BashToolParams>;

/** Details of a backgrounded call (§2.4/§8). Foreground details stay pi's `BashToolDetails`. */
export interface BashBackgroundDetails {
  jobId: JobId;
  background: true;
  /** Set only when the threshold (not `run_in_background`) triggered it. */
  autoBackgrounded?: true;
  pid: number;
  logPath: string;
}

export type BashOverrideDetails = BashToolDetails | BashBackgroundDetails | undefined;

export interface BashToolDeps {
  /** Current session's job manager; `undefined` ⇒ pure pass-through to pi. */
  manager: () => BashJobManager | undefined;
  /** Auto-background threshold in ms; `0`/negative ⇒ pure pass-through. */
  autoBackgroundMs: () => number;
  /** Diagnostics sink (defaults to `console.warn`, like the rest of the plugin). */
  warn?: (message: string) => void;
}

/** pi's own cap, replicated so an invalid `timeout` fails before anything spawns. */
const MAX_TIMEOUT_MS = 2_147_483_647;
const MAX_TIMEOUT_SECONDS = MAX_TIMEOUT_MS / 1000;

/**
 * Byte-identical to pi's private `resolveTimeoutMs` (`dist/core/tools/bash.js`)
 * — same messages, same order — so an invalid timeout throws exactly what the
 * built-in tool throws, before a job record is ever created.
 */
function resolveTimeoutMs(timeout: number | undefined): number | undefined {
  if (timeout === undefined) return undefined;
  if (!Number.isFinite(timeout) || timeout <= 0) {
    throw new Error("Invalid timeout: must be a finite number of seconds");
  }
  const timeoutMs = timeout * 1000;
  if (timeoutMs > MAX_TIMEOUT_MS) {
    throw new Error(`Invalid timeout: maximum is ${MAX_TIMEOUT_SECONDS} seconds`);
  }
  return timeoutMs;
}

function unrefTimer(timer: ReturnType<typeof setTimeout>): ReturnType<typeof setTimeout> {
  // A ref'd timer wedges `pi -p` (AGENTS.md).
  (timer as unknown as { unref?: () => void }).unref?.();
  return timer;
}

/** §8 — deliberately isomorphic to the Agent tool's auto-background wording. */
export function formatAutoBackgroundText(jobId: JobId, elapsedMs: number, logPath: string): string {
  return (
    `Bash command is still running after ${formatDuration(elapsedMs)} and has been moved to the background ` +
    `(job_id: ${jobId}). The process was NOT killed — it keeps running with output captured to a log ` +
    `(${logPath}), and you will receive a completion notification when it finishes. Do not block or poll for it now. ` +
    `Later: bash_job(action: "status", job_id: "${jobId}") for a summary plus the log tail, or read that log path ` +
    `directly — it is a plain file, so the read tool and tail/grep/awk all work (grep a large log rather than ` +
    `reading it whole). Stop it with bash_job(action: "kill", job_id: "${jobId}").`
  );
}

/** §2.2 — the explicit `run_in_background: true` variant (no "still running after" prefix). */
export function formatExplicitBackgroundText(jobId: JobId, pid: number, logPath: string): string {
  return (
    `Bash command started in the background (job_id: ${jobId}, pid: ${pid}). The process was NOT killed — ` +
    `output is captured to a log (${logPath}), and you will receive a completion notification when it finishes. ` +
    `Do not block or poll for it now. Later: bash_job(action: "status", job_id: "${jobId}") for a summary plus the ` +
    `log tail, or read that log path directly — it is a plain file, so the read tool and tail/grep/awk all work ` +
    `(grep a large log rather than reading it whole). Stop it with bash_job(action: "kill", job_id: "${jobId}").`
  );
}

/** §3.8 — the threshold fired but every background slot is taken: stay in the foreground. */
export function formatCapacityNote(maxBackgroundJobs: number): string {
  return (
    `[This command exceeded the auto-background threshold but all ${maxBackgroundJobs} background job slots ` +
    `were in use, so the call kept waiting in the foreground. Finish or kill an existing job with bash_job ` +
    `to free a slot.]`
  );
}

function capacityError(maxBackgroundJobs: number): Error {
  return new Error(
    `cannot start a background bash job: all ${maxBackgroundJobs} background job slots are in use ` +
      `(settings bashJobs.maxBackgroundJobs). Wait for a job to finish, or free a slot with ` +
      `bash_job(action: "kill", job_id: "…"), or re-run the command in the foreground ` +
      `(omit run_in_background).`,
  );
}

/** Threshold sentence appended to pi's own bash description (§2.1). */
export function formatDescriptionSuffix(autoBackgroundMs: number): string {
  return (
    ` If a command runs longer than ~${formatDuration(autoBackgroundMs)}, the call returns early on its own ` +
    `with a job_id — the process is NOT killed, it keeps running with its output captured to a log file, and ` +
    `you are notified when it finishes. So for a long-running command whose result you need, just run it in ` +
    `the foreground and let this threshold move it to the background — do NOT set run_in_background: true and ` +
    `then block on bash_job wait; that wastes an extra request for nothing. Reserve run_in_background: true ` +
    `for fire-and-forget commands whose result you will never need. Manage a backgrounded job with the ` +
    `bash_job tool (status / wait / kill / list); the log is a plain file, so you can also read it directly ` +
    `with the read tool or with tail/grep/awk.`
  );
}

interface InnerParams {
  command: string;
  timeout?: number;
}

/**
 * Per-call bookkeeping shared between the injected `exec` and the outer race.
 * `job` is only known once the spawn has succeeded — the background branches
 * both wait for it, so a `job_id` is never invented for a process that does
 * not exist (§2.2).
 */
interface CallState {
  job?: CreatedJob;
  jobReady: Promise<CreatedJob | undefined>;
  resolveJobReady: (job: CreatedJob | undefined) => void;
}

function createCallState(): CallState {
  let resolveJobReady: (job: CreatedJob | undefined) => void = () => {};
  const jobReady = new Promise<CreatedJob | undefined>((resolve) => {
    resolveJobReady = resolve;
  });
  return { jobReady, resolveJobReady };
}

export function createBashTool(deps: BashToolDeps): ToolDefinition<typeof BashToolParams, BashOverrideDetails> {
  const warn = deps.warn ?? ((message: string) => console.warn(`[pi-subagent] ${message}`));
  // §2.1: renderers do not depend on `operations`, so one stateless definition
  // (never executed) supplies the whole static surface and both renderers.
  const surface = createBashToolDefinition(process.cwd());
  const thresholdForDescription = safeThreshold(deps, warn);

  return {
    name: "bash",
    label: surface.label,
    description: surface.description + formatDescriptionSuffix(thresholdForDescription),
    ...(surface.promptSnippet !== undefined ? { promptSnippet: surface.promptSnippet } : {}),
    ...(surface.promptGuidelines !== undefined ? { promptGuidelines: [...surface.promptGuidelines] } : {}),
    parameters: BashToolParams,

    async execute(toolCallId, params, signal, onUpdate, ctx) {
      const manager = deps.manager();
      const thresholdMs = safeThreshold(deps, warn);
      const innerParams: InnerParams = {
        command: params.command,
        ...(params.timeout !== undefined ? { timeout: params.timeout } : {}),
      };

      // §2.6 / feature-off (threshold 0, or no session stack behind the
      // holder): nothing to manage, so run pi's tool untouched.
      if (!manager || thresholdMs <= 0) {
        const passthrough = createBashToolDefinition(ctx.cwd);
        return runInner(passthrough, toolCallId, innerParams, signal, onUpdate, ctx);
      }

      // §3.8: an explicit background request over the cap is a config error the
      // model can correct — and it is raised *before* anything spawns, so no
      // process is left dangling behind the rejection.
      if (params.run_in_background === true && !manager.hasBackgroundCapacity()) {
        throw capacityError(manager.maxBackgroundJobs);
      }

      const state = createCallState();
      const startedAt = Date.now();
      let forwardAbort = true;
      let forwardUpdates = true;
      let listenerAttached = false;
      const relay = new AbortController();
      const onAbort = (): void => {
        if (forwardAbort) relay.abort();
      };
      // Entering already aborted keeps the built-in semantics exactly: the
      // relay is pre-aborted, so `exec` throws "aborted" before spawning.
      if (signal?.aborted) relay.abort();
      else if (signal) {
        signal.addEventListener("abort", onAbort, { once: true });
        listenerAttached = true;
      }
      const stopForwarding = (): void => {
        forwardAbort = false;
        if (listenerAttached) {
          signal?.removeEventListener("abort", onAbort);
          listenerAttached = false;
        }
      };

      const operations: BashOperations = {
        exec: (command, cwd, options) => execViaManager(manager, state, command, cwd, options),
      };
      const inner = createBashToolDefinition(ctx.cwd, { operations });
      const gatedUpdate = onUpdate
        ? (update: Parameters<NonNullable<typeof onUpdate>>[0]) => {
            if (forwardUpdates) onUpdate(update);
          }
        : undefined;

      let innerPromise: Promise<Awaited<ReturnType<typeof runInner>>>;
      try {
        innerPromise = runInner(inner, toolCallId, innerParams, relay.signal, gatedUpdate, ctx);
      } catch (error) {
        // Defensive: `execute` is async, so this is unreachable in practice.
        stopForwarding();
        throw error;
      }
      // Nothing may observe this promise until the race is decided, but an
      // early rejection must not surface as an unhandled rejection either.
      const settled = innerPromise.then(
        (result) => ({ ok: true as const, result }),
        (error: unknown) => ({ ok: false as const, error }),
      );

      // The background trigger: the pid for an explicit request, the threshold
      // timer otherwise. Both resolve to "we may hand this call back now".
      let thresholdTimer: ReturnType<typeof setTimeout> | undefined;
      const trigger =
        params.run_in_background === true
          ? state.jobReady.then(() => undefined)
          : new Promise<void>((resolve) => {
              thresholdTimer = unrefTimer(setTimeout(resolve, thresholdMs));
            });

      try {
        const raced = await Promise.race([settled, trigger.then(() => "trigger" as const)]);
        if (raced !== "trigger") {
          // Short-command path: pi's own resolve/reject, verbatim (§2.3 T1).
          stopForwarding();
          if (raced.ok) return raced.result;
          throw raced.error;
        }

        const job = state.job ?? (await Promise.race([state.jobReady, settled.then(() => undefined)]));
        if (!job) {
          // The spawn has not (or will never) produce a pid — there is no job
          // to hand over, so keep waiting for the inner result.
          stopForwarding();
          return await finishForeground(settled);
        }
        if (!manager.hasBackgroundCapacity()) {
          // §3.8: refuse to background, keep the foreground wait, tell the model why.
          warn(
            `bash job ${job.jobId} stayed in the foreground: all ${manager.maxBackgroundJobs} background slots are in use`,
          );
          const result = await finishForeground(settled);
          return appendCapacityNote(result, manager.maxBackgroundJobs);
        }

        // ── hand the call back; the process lives on (§1 Z2) ────────────────
        forwardUpdates = false;
        stopForwarding();
        await manager.markBackgrounded(job.jobId);
        adoptInnerPromise(manager, job.jobId, settled, warn);
        const autoBackgrounded = params.run_in_background !== true;
        return {
          content: [
            {
              type: "text" as const,
              text: autoBackgrounded
                ? formatAutoBackgroundText(job.jobId, Date.now() - startedAt, job.logPath)
                : formatExplicitBackgroundText(job.jobId, job.pid, job.logPath),
            },
          ],
          details: {
            jobId: job.jobId,
            background: true,
            ...(autoBackgrounded ? { autoBackgrounded: true as const } : {}),
            pid: job.pid,
            logPath: job.logPath,
          } satisfies BashBackgroundDetails,
        };
      } finally {
        stopForwarding();
        if (thresholdTimer !== undefined) clearTimeout(thresholdTimer);
      }
    },

    renderCall(args, theme, context) {
      // Delegation, not reimplementation: the extra `run_in_background` field
      // is simply ignored by pi's `$ <command>` renderer.
      return surface.renderCall!(args as never, theme, context as never);
    },

    renderResult(result, options, theme, context) {
      // Background results carry our own details shape, which pi's renderer
      // treats as "no truncation, no temp file" — plain text (§2.1).
      return surface.renderResult!(result as never, options, theme, context as never);
    },
  };
}

type InnerDefinition = ReturnType<typeof createBashToolDefinition>;
type InnerResult = Awaited<ReturnType<InnerDefinition["execute"]>>;

function runInner(
  definition: InnerDefinition,
  toolCallId: string,
  params: InnerParams,
  signal: AbortSignal | undefined,
  onUpdate: unknown,
  ctx: ExtensionContext,
): Promise<InnerResult> {
  return definition.execute(toolCallId, params as never, signal, onUpdate as never, ctx);
}

type Settled = { ok: true; result: InnerResult } | { ok: false; error: unknown };

async function finishForeground(settled: Promise<Settled>): Promise<InnerResult> {
  const outcome = await settled;
  if (outcome.ok) return outcome.result;
  throw outcome.error;
}

/** §3.8 foreground fallback: annotate the successful result, never the rejection. */
function appendCapacityNote(result: InnerResult, maxBackgroundJobs: number): InnerResult {
  const note = formatCapacityNote(maxBackgroundJobs);
  const content = [...result.content];
  const last = content.length - 1;
  const tail = last >= 0 ? content[last] : undefined;
  if (tail && tail.type === "text") content[last] = { ...tail, text: `${tail.text}\n\n${note}` };
  else content.push({ type: "text", text: note });
  return { ...result, content };
}

/**
 * §2.3: once the call has returned, the inner promise has no consumer left.
 * The manager takes it over — the built-in final text (including
 * "Command exited with code N") becomes the job's `finalText`, and the
 * rejection can never reach `process.on("unhandledRejection")` (T9).
 */
function adoptInnerPromise(
  manager: BashJobManager,
  jobId: JobId,
  settled: Promise<Settled>,
  warn: (message: string) => void,
): void {
  void settled
    .then((outcome) => {
      const text = outcome.ok ? innerResultText(outcome.result) : errorText(outcome.error);
      return manager.setFinalText(jobId, text);
    })
    .catch((error: unknown) => {
      warn(`bash job ${jobId} final text could not be recorded: ${String(error)}`);
    });
}

function innerResultText(result: InnerResult): string {
  return result.content
    .map((part) => (part.type === "text" ? part.text : ""))
    .filter(Boolean)
    .join("\n");
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * The plugin's `BashOperations.exec` (§1 ①): pi's inner tool still owns output
 * accumulation and result formatting, while the process itself is created and
 * owned by `BashJobManager` so it can outlive this call.
 *
 * Semantics replicated from `createLocalShellOperations`
 * (`dist/core/tools/bash.js:38-114`): pre-aborted signal throws before
 * spawning, abort kills the tree and throws `"aborted"`, an expired `timeout`
 * kills the tree and throws `timeout:<s>`, otherwise the exit code is
 * returned (`null` when signalled).
 */
async function execViaManager(
  manager: BashJobManager,
  state: CallState,
  command: string,
  cwd: string,
  options: {
    onData: (data: Buffer) => void;
    signal?: AbortSignal;
    timeout?: number;
    env?: NodeJS.ProcessEnv;
  },
): Promise<{ exitCode: number | null }> {
  const timeoutMs = resolveTimeoutMs(options.timeout);
  if (options.signal?.aborted) {
    state.resolveJobReady(undefined);
    throw new Error("aborted");
  }

  let job: CreatedJob;
  try {
    job = await manager.create({
      command,
      cwd,
      ...(options.env !== undefined ? { env: options.env } : {}),
      onData: (chunk) => options.onData(Buffer.from(chunk, "utf8")),
    });
  } catch (error) {
    state.resolveJobReady(undefined);
    throw error;
  }
  state.job = job;
  state.resolveJobReady(job);

  let timedOut = false;
  let timeoutHandle: ReturnType<typeof setTimeout> | undefined;
  const killTree = (reason: "killed" | "timed_out"): void => {
    void manager.kill(job.jobId).catch(() => undefined);
    // `kill()` pins `killed` synchronously before its first await, so this
    // relabels the pending exit for the timeout path (§2.3 `timed_out`).
    manager.noteTermination(job.jobId, reason);
  };
  const onAbort = (): void => killTree("killed");

  try {
    if (timeoutMs !== undefined) {
      timeoutHandle = unrefTimer(
        setTimeout(() => {
          timedOut = true;
          killTree("timed_out");
        }, timeoutMs),
      );
    }
    if (options.signal) {
      if (options.signal.aborted) onAbort();
      else options.signal.addEventListener("abort", onAbort, { once: true });
    }
    const record = await job.exit;
    if (options.signal?.aborted) throw new Error("aborted");
    if (timedOut) throw new Error(`timeout:${options.timeout}`);
    return { exitCode: record.exitCode };
  } finally {
    if (timeoutHandle !== undefined) clearTimeout(timeoutHandle);
    if (options.signal) options.signal.removeEventListener("abort", onAbort);
  }
}

function safeThreshold(deps: BashToolDeps, warn: (message: string) => void): number {
  try {
    const value = deps.autoBackgroundMs();
    return Number.isFinite(value) && value > 0 ? value : 0;
  } catch (error) {
    warn(`bash auto-background threshold unavailable (feature disabled for this call): ${String(error)}`);
    return 0;
  }
}
