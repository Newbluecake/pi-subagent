import { spawn, type ChildProcess } from "node:child_process";
import { readFileSync } from "node:fs";
import { uptime } from "node:os";
import { basename } from "node:path";
import type { Readable } from "node:stream";
import type { Millis } from "../core/types.js";
import type { JobRecord } from "./types.js";

/**
 * bash auto-background §3.3 — **the plugin's only `node:child_process`
 * boundary**.
 *
 * Everything process-shaped lives behind `ProcessPort` so `BashJobManager`
 * (S4) can be unit-tested against a fake: spawning a detached process-group
 * leader, the TERM → grace → KILL termination ladder, liveness probing and the
 * pid-reuse guard used when adopting jobs after a pi restart.
 *
 * Layering rules for this file:
 * - no pi imports (the spawn semantics of pi's `createLocalShellOperations`,
 *   `dist/core/tools/bash.js:38-114`, are replicated, not imported — pi's
 *   `getShellConfig` / `killProcessTree` / `waitForChildProcess` are not
 *   reachable through the package `exports` map);
 * - no settings import — `shellPath` / `graceMs` are injected by the caller,
 *   which owns the defaults;
 * - no mutable module-level state (the extension re-activates in-process on
 *   `/reload`);
 * - every timer is `unref()`ed (a ref'd timer wedges `pi -p`).
 *
 * Safety doctrine (§3.3, §11): when identity cannot be established we report
 * "unsafe" and the caller marks the job `orphaned` — **we would rather leak a
 * process than signal an unrelated one**.
 */

export type DrainStop = "ended" | "idle" | "capped" | "error";

export interface JobExit {
  /** `null` when the child was terminated by a signal. */
  readonly exitCode: number | null;
  readonly signal: NodeJS.Signals | null;
  /** A post-spawn `error` event, surfaced instead of rejecting. */
  readonly error?: Error;
}

export interface DrainedResult {
  /** The same frozen object resolved by `processExitPromise`. */
  readonly exit: JobExit;
  readonly stop: DrainStop;
}

/** Result of a spawn. `stdout`/`stderr` are live pipes; attach listeners immediately. */
export interface SpawnedJob {
  readonly pid: number;
  /** POSIX `detached` makes the child its own group leader, so this equals `pid`. */
  readonly pgid: number;
  readonly stdout: Readable;
  readonly stderr: Readable;
  /** Exit/close first event settles; never rejects. */
  readonly processExitPromise: Promise<JobExit>;
  /** Bounded pipe drain settles after end/idle/cap/error; never rejects. */
  readonly drainedPromise: Promise<DrainedResult>;
  /** `/proc/<pid>/stat` field 22 — Linux best-effort pid-reuse guard. */
  readonly procStartTime?: string;
}

export type KillOutcome =
  /** The group leader was already gone (ESRCH) — `killJobTree` is idempotent. */
  | "already-dead"
  /** Died within the grace window after SIGTERM. */
  | "terminated"
  /** Outlived the grace window and was SIGKILLed. */
  | "killed"
  /** Identity/group checks failed; nothing was signalled (§3.3 safety floor). */
  | "refused";

export interface KillJobTreeOptions {
  /** SIGTERM → SIGKILL escalation window. Defaults to the port's `graceMs`. */
  graceMs?: Millis;
  /** When given, a readable-but-different `/proc` starttime refuses the kill. */
  expectedProcStartTime?: string;
}

/** "alive" = ours and running, "dead" = certainly gone, "unsafe" = unverifiable. */
export type PidOwnership = "alive" | "dead" | "unsafe";

/**
 * The identity fields a `JobRecord` carries for the reuse guard — a
 * `JobRecord` is structurally assignable, so callers pass records directly.
 */
export type PidIdentity = Pick<JobRecord, "pid" | "procStartTime" | "spawnedAt">;

export interface ProcessPort {
  /**
   * Spawn `command` through the resolved shell as a detached process-group
   * leader. Resolves on the `spawn` event (so `pid` is real), rejects with the
   * spawn error (ENOENT, missing `cwd`, …) — the caller maps that to
   * `staged → failed`.
   */
  spawnJob(command: string, cwd: string, env?: NodeJS.ProcessEnv): Promise<SpawnedJob>;
  /** TERM → grace → KILL on the whole process group. Idempotent. */
  killJobTree(pid: number, options?: KillJobTreeOptions): Promise<KillOutcome>;
  /** `kill(pid, 0)` liveness probe; EPERM counts as alive. */
  probePid(pid: number): boolean;
  /** Linux-only best-effort `/proc/<pid>/stat` field 22. */
  readProcStartTime(pid: number): string | undefined;
  /** Pid-reuse guard used by `recover()` (§3.6). */
  checkPidOwnership(identity: PidIdentity): PidOwnership;
}

export interface ProcessPortOptions {
  /** Explicit shell (`settings.bashJobs.shellPath`). Wins over `$SHELL`. */
  shellPath?: string;
  /** Default SIGTERM → SIGKILL window. */
  graceMs?: Millis;
  /** Liveness poll cadence inside the grace window. */
  killPollMs?: Millis;
  /** Hard cap on post-exit pipe draining; defaults to 30 seconds. */
  drainTimeoutMs?: Millis;
}
export interface ShellConfig {
  readonly shell: string;
  readonly args: readonly string[];
}

/** §3.3: only these `$SHELL` basenames are honoured; all take `-c`. */
export const ALLOWED_SHELL_BASENAMES: ReadonlySet<string> = new Set(["bash", "zsh", "sh"]);

export const DEFAULT_KILL_GRACE_MS = 2_000;
export const DEFAULT_DRAIN_TIMEOUT_MS = 30_000;
const DEFAULT_KILL_POLL_MS = 50;
/**
 * Exit and drain are decoupled: drain semantics mirror pi#5303, but are bounded.
 */
const EXIT_STDIO_GRACE_MS = 100;

/**
 * Resolve the shell: explicit `shellPath` → `$SHELL` (whitelisted basename) →
 * `"bash"`. Pure, so the fallback ladder is directly testable.
 *
 * Deliberate divergence from pi's `getShellConfig` (which probes Git Bash /
 * `/bin/bash` / `sh` and supports the legacy WSL stdin transport): the tool is
 * named `bash` and bash semantics are the contract, so exotic shells
 * (fish, nushell) fall back to bash instead of being used with `-c`.
 */
export function resolveShell(shellPath?: string, envShell?: string): ShellConfig {
  if (shellPath !== undefined && shellPath.trim().length > 0) {
    return { shell: shellPath, args: ["-c"] };
  }
  if (envShell !== undefined && envShell.trim().length > 0 && ALLOWED_SHELL_BASENAMES.has(basename(envShell))) {
    return { shell: envShell, args: ["-c"] };
  }
  return { shell: "bash", args: ["-c"] };
}

function isPosix(): boolean {
  return process.platform !== "win32";
}

function errnoOf(error: unknown): string | undefined {
  return typeof error === "object" && error !== null ? (error as NodeJS.ErrnoException).code : undefined;
}

/** Fields of `/proc/<pid>/stat` from field 3 on (the `comm` field may contain spaces). */
function readProcStatFields(pid: number): string[] | undefined {
  if (process.platform !== "linux" || !Number.isInteger(pid) || pid <= 0) return undefined;
  let raw: string;
  try {
    raw = readFileSync(`/proc/${pid}/stat`, "utf8");
  } catch {
    return undefined;
  }
  const close = raw.lastIndexOf(")");
  if (close < 0) return undefined;
  const fields = raw
    .slice(close + 1)
    .trim()
    .split(/\s+/);
  return fields.length > 0 ? fields : undefined;
}

/** `stat` field 22 (starttime) → index 19 once fields 1-2 (`pid (comm)`) are dropped. */
const STAT_INDEX_STARTTIME = 19;
/** `stat` field 5 (pgrp). */
const STAT_INDEX_PGRP = 2;

export function readProcStartTime(pid: number): string | undefined {
  const value = readProcStatFields(pid)?.[STAT_INDEX_STARTTIME];
  return value !== undefined && value.length > 0 ? value : undefined;
}

function readProcGroup(pid: number): number | undefined {
  const value = readProcStatFields(pid)?.[STAT_INDEX_PGRP];
  if (value === undefined) return undefined;
  const parsed = Number.parseInt(value, 10);
  return Number.isInteger(parsed) ? parsed : undefined;
}

export function probePid(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    // EPERM: the pid exists but belongs to another user — alive, not ours.
    return errnoOf(error) === "EPERM";
  }
}

/** Clock skew slack for the boot-time fallback; never shrink identity checks to the wire. */
const BOOT_TIME_SLACK_MS = 60_000;

function bootTimeMs(): Millis {
  return Date.now() - uptime() * 1000;
}

/**
 * §3.3 pid-reuse guard. Linux: the recorded `/proc` starttime must match.
 * Elsewhere (or when `/proc` is unreadable) the only certain negative is a
 * reboot since the spawn; anything else is `"unsafe"` → caller marks the job
 * `orphaned` and never kills.
 */
export function checkPidOwnership(identity: PidIdentity): PidOwnership {
  const { pid } = identity;
  if (pid === undefined || !Number.isInteger(pid) || pid <= 0) return "dead";
  if (!probePid(pid)) return "dead";
  const current = readProcStartTime(pid);
  if (identity.procStartTime !== undefined && current !== undefined) {
    // A different starttime means the pid was recycled: our process is gone
    // for certain, and reporting "dead" is safe because dead never kills.
    return current === identity.procStartTime ? "alive" : "dead";
  }
  if (identity.spawnedAt !== undefined && identity.spawnedAt + BOOT_TIME_SLACK_MS < bootTimeMs()) {
    return "dead";
  }
  return "unsafe";
}

function sleepUnref(ms: Millis): Promise<void> {
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, Math.max(0, ms));
    (timer as { unref?: () => void }).unref?.();
  });
}

/** `false` on ESRCH (already dead); `true` otherwise (EPERM counts as alive). */
function signalGroup(pid: number, signal: NodeJS.Signals): boolean {
  try {
    // Negative pid = whole process group, so `sleep 60 & wait` descendants die
    // with the shell. Non-POSIX has no groups: fall back to the pid itself.
    process.kill(isPosix() ? -pid : pid, signal);
    return true;
  } catch (error) {
    return errnoOf(error) !== "ESRCH";
  }
}

/**
 * Exit/drain watcher. The first exit or close event freezes the result and
 * settles processExitPromise; pipe draining continues independently.
 */
export function watchChild(
  child: ChildProcess,
  drainTimeoutMs: Millis,
): {
  processExitPromise: Promise<JobExit>;
  drainedPromise: Promise<DrainedResult>;
} {
  let resultCaptured = false;
  let exited = false;
  let stdoutEnded = child.stdout === null;
  let stderrEnded = child.stderr === null;
  let idleTimer: ReturnType<typeof setTimeout> | undefined;
  let capTimer: ReturnType<typeof setTimeout> | undefined;
  let resolveExit!: (exit: JobExit) => void;
  let resolveDrained!: (result: DrainedResult) => void;
  const processExitPromise = new Promise<JobExit>((resolve) => {
    resolveExit = resolve;
  });
  const drainedPromise = new Promise<DrainedResult>((resolve) => {
    resolveDrained = resolve;
  });

  const clearTimers = (): void => {
    if (idleTimer) clearTimeout(idleTimer);
    if (capTimer) clearTimeout(capTimer);
    idleTimer = undefined;
    capTimer = undefined;
  };
  const cleanup = (): void => {
    clearTimers();
    child.removeListener("error", onError);
    child.removeListener("exit", onExit);
    child.removeListener("close", onClose);
    child.stdout?.removeListener("end", onStdoutEnd);
    child.stderr?.removeListener("end", onStderrEnd);
    child.stdout?.removeListener("data", onData);
    child.stderr?.removeListener("data", onData);
  };
  const finishDrain = (stop: DrainStop): void => {
    cleanup();
    child.stdout?.destroy();
    child.stderr?.destroy();
    resolveDrained({ exit: exitResult, stop });
  };
  const armIdleTimer = (): void => {
    if (idleTimer) clearTimeout(idleTimer);
    idleTimer = setTimeout(() => finishDrain("idle"), EXIT_STDIO_GRACE_MS);
    (idleTimer as { unref?: () => void }).unref?.();
  };
  let exitResult: JobExit = Object.freeze({ exitCode: null, signal: null });
  const maybeEnd = (): void => {
    if (exited && stdoutEnded && stderrEnded) finishDrain("ended");
  };
  const captureExit = (code: number | null, signal: NodeJS.Signals | null): void => {
    if (resultCaptured) return;
    resultCaptured = true;
    exited = true;
    exitResult = Object.freeze({ exitCode: code, signal });
    resolveExit(exitResult);
    maybeEnd();
    if (!stdoutEnded || !stderrEnded) {
      armIdleTimer();
      // The cap arms exactly once and is never re-armed: it is the absolute
      // bound that keeps a perpetually chatty detached descendant from
      // wedging the event loop (the idle timer alone would defer forever).
      capTimer = setTimeout(() => finishDrain("capped"), Math.max(0, drainTimeoutMs));
      (capTimer as { unref?: () => void }).unref?.();
    }
  };
  const onStdoutEnd = (): void => {
    stdoutEnded = true;
    maybeEnd();
  };
  const onStderrEnd = (): void => {
    stderrEnded = true;
    maybeEnd();
  };
  const onExit = (code: number | null, signal: NodeJS.Signals | null): void => captureExit(code, signal);
  const onClose = (code: number | null, signal: NodeJS.Signals | null): void => {
    stdoutEnded = true;
    stderrEnded = true;
    captureExit(code, signal);
    maybeEnd();
  };
  /**
   * Post-exit output re-arms the *idle* cutoff only (pi#5303: a descendant
   * still flushing its tail must not be truncated mid-write), and never
   * touches the absolute cap. Without this re-arm the idle timer fires 100ms
   * after exit unconditionally and the cap is dead code for any
   * `drainTimeoutMs` >= EXIT_STDIO_GRACE_MS.
   */
  const onData = (): void => {
    if (resultCaptured) armIdleTimer();
  };
  const onError = (error: Error): void => {
    if (resultCaptured) return;
    resultCaptured = true;
    exited = true;
    exitResult = Object.freeze({ exitCode: null, signal: null, error });
    resolveExit(exitResult);
    finishDrain("error");
  };

  child.stdout?.once("end", onStdoutEnd);
  child.stderr?.once("end", onStderrEnd);
  child.stdout?.on("data", onData);
  child.stderr?.on("data", onData);
  child.once("error", onError);
  child.once("exit", onExit);
  child.once("close", onClose);
  return { processExitPromise, drainedPromise };
}

export function createProcessPort(options: ProcessPortOptions = {}): ProcessPort {
  const graceDefault = options.graceMs ?? DEFAULT_KILL_GRACE_MS;
  const pollMs = options.killPollMs ?? DEFAULT_KILL_POLL_MS;

  async function spawnJob(command: string, cwd: string, env?: NodeJS.ProcessEnv): Promise<SpawnedJob> {
    // `$SHELL` is read per call: the extension re-activates in-process and the
    // environment is not ours to snapshot at module load.
    const { shell, args } = resolveShell(options.shellPath, process.env.SHELL);
    const child = spawn(shell, [...args, command], {
      cwd,
      // POSIX: detached makes the child a process-group leader (pgid === pid),
      // which is what lets `killJobTree` reach its descendants. win32 has no
      // groups (and is out of scope for v1, R6) — mirror pi and stay attached.
      detached: isPosix(),
      env: env ?? process.env,
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true,
    });

    // Bind the exit watcher before awaiting `spawn` so an immediate exit is
    // never missed, and keep an inert catch on it: the promise may be handed
    // to an owner that only consumes it much later.
    const { processExitPromise, drainedPromise } = watchChild(
      child,
      Number.isFinite(options.drainTimeoutMs) && (options.drainTimeoutMs ?? 0) >= 0
        ? Math.trunc(options.drainTimeoutMs ?? DEFAULT_DRAIN_TIMEOUT_MS)
        : DEFAULT_DRAIN_TIMEOUT_MS,
    );
    void processExitPromise.catch(() => {});
    void drainedPromise.catch(() => {});

    try {
      await new Promise<void>((resolve, reject) => {
        const onSpawn = (): void => {
          child.removeListener("error", onError);
          resolve();
        };
        const onError = (error: Error): void => {
          child.removeListener("spawn", onSpawn);
          reject(error);
        };
        child.once("spawn", onSpawn);
        child.once("error", onError);
      });
    } catch (error) {
      child.stdout?.destroy();
      child.stderr?.destroy();
      throw error instanceof Error ? error : new Error(String(error));
    }

    const pid = child.pid;
    if (pid === undefined || child.stdout === null || child.stderr === null) {
      // Defensive: `spawn` fired, so both hold in practice.
      child.stdout?.destroy();
      child.stderr?.destroy();
      throw new Error(`failed to spawn ${shell}: no pid or stdio pipes`);
    }

    const procStartTime = readProcStartTime(pid);
    return {
      pid,
      pgid: readProcGroup(pid) ?? pid,
      stdout: child.stdout,
      stderr: child.stderr,
      processExitPromise,
      drainedPromise,
      ...(procStartTime !== undefined ? { procStartTime } : {}),
    };
  }

  async function killJobTree(pid: number, killOptions: KillJobTreeOptions = {}): Promise<KillOutcome> {
    // pid <= 1 would signal "everything we may signal" / init — never.
    if (!Number.isInteger(pid) || pid <= 1) return "refused";

    if (killOptions.expectedProcStartTime !== undefined) {
      const current = readProcStartTime(pid);
      if (current !== undefined && current !== killOptions.expectedProcStartTime) return "refused";
    }
    // Only ever signal a group we own: a non-leader pid means the group id we
    // would target belongs to somebody else (§3.3 / §11 "误杀无关进程").
    const pgrp = readProcGroup(pid);
    if (pgrp !== undefined && pgrp !== pid) return "refused";

    if (!signalGroup(pid, "SIGTERM")) return "already-dead";

    const graceMs = Math.max(0, killOptions.graceMs ?? graceDefault);
    const deadline = Date.now() + graceMs;
    while (Date.now() < deadline) {
      await sleepUnref(Math.min(pollMs, Math.max(1, deadline - Date.now())));
      if (!probePid(pid)) return "terminated";
    }
    if (!probePid(pid)) return "terminated";

    signalGroup(pid, "SIGKILL");
    return "killed";
  }

  return { spawnJob, killJobTree, probePid, readProcStartTime, checkPidOwnership };
}
