import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { spawn } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ExtensionAPI, ExtensionContext, ToolDefinition } from "@earendil-works/pi-coding-agent";
import { createBashToolDefinition } from "@earendil-works/pi-coding-agent";
import { DEFAULT_SETTINGS, type AgentSettings } from "../../src/config/settings.js";
import type { AgentTypeRegistry } from "../../src/config/agent-types.js";
import { buildSessionStack } from "../../src/stack.js";
import { createBashTool, type BashBackgroundDetails } from "../../src/tools/bash-tool.js";
import { createBashJobTool } from "../../src/tools/bash-job-tool.js";
import type { BashJobManager } from "../../src/bash/manager.js";
import { probePid } from "../../src/bash/process.js";
import { sanitizeSessionDirName } from "../../src/bash/session-dirs.js";
import { isTerminalJobStatus, type JobRecord } from "../../src/bash/types.js";

/**
 * S8 / §9 I-group — the bash auto-background chain end to end with *real*
 * components: real `bash` processes in real process groups, the real job store
 * on disk, pi's real built-in bash tool inside the override, the real
 * `BashJobManager` built by `buildSessionStack` (so the notification really
 * goes through the `pi.sendMessage` binding of §5), and the real `bash_job`
 * tool on top.
 *
 * Isolation (same doctrine as `bash-jobs-wiring.test.ts`): every test runs
 * under a throwaway `$HOME` **and** a throwaway jobs directory, so nothing
 * here can read or mutate the developer's `~/.pi`. Every process this file
 * starts is killed by the `afterEach` net, whatever the outcome.
 *
 * POSIX-only by construction (R6): the feature is not registered on win32.
 */
const posix = process.platform !== "win32";
/** Long enough for a real spawn + one 2s notification poll on a loaded CI box. */
const WAIT_TIMEOUT_MS = 20_000;
/** The manager's notification poll cadence (`DEFAULT_NOTIFY_POLL_MS`) + slack. */
const QUIET_WINDOW_MS = 3_000;

interface Host {
  pi: ExtensionAPI;
  sent: { message: Record<string, unknown>; options?: { triggerTurn?: boolean } }[];
}

function fakePi(): Host {
  const sent: Host["sent"] = [];
  const pi = {
    registerTool: () => undefined,
    registerCommand: () => undefined,
    on: () => undefined,
    sendMessage: (message: Record<string, unknown>, options?: { triggerTurn?: boolean }) => {
      sent.push({ message, ...(options ? { options } : {}) });
    },
    appendEntry: () => undefined,
    events: { on: () => () => undefined, emit: () => undefined },
    exec: async () => ({ code: 0, stdout: "", stderr: "", killed: false }),
  };
  return { pi: pi as unknown as ExtensionAPI, sent };
}

const types = {
  get: () => undefined,
  list: () => [],
  reload: async () => ({ types: [], errors: [] }),
} as unknown as AgentTypeRegistry;

function makeCtx(cwd: string, sessionId = "session-under-test"): ExtensionContext {
  return {
    cwd,
    sessionManager: { getSessionId: () => sessionId, getEntries: () => [], getSessionFile: () => undefined },
    modelRegistry: { getAvailable: () => [], find: () => undefined },
    model: { provider: "test", id: "test-model" },
    thinkingLevel: undefined,
    ui: {},
  } as unknown as ExtensionContext;
}

function settingsWith(dir: string, overrides: Partial<AgentSettings["bashJobs"]> = {}): AgentSettings {
  return {
    ...DEFAULT_SETTINGS,
    fleetWidget: false,
    bashJobs: { ...DEFAULT_SETTINGS.bashJobs, dir, ...overrides },
  };
}

let tmpRoot: string;
let jobsDir: string;
let workDir: string;
let ctx: ExtensionContext;
let previousHome: string | undefined;
/** Managers to dispose + sweep for live processes, newest first. */
const managers: BashJobManager[] = [];
/** Extra pids started directly by a test (I2 grandchildren, I4 corpses). */
const strayPids: number[] = [];

beforeEach(() => {
  tmpRoot = mkdtempSync(join(tmpdir(), "pi-subagent-bash-e2e-"));
  jobsDir = join(tmpRoot, "jobs");
  workDir = join(tmpRoot, "work");
  mkdirSync(jobsDir, { recursive: true });
  mkdirSync(workDir, { recursive: true });
  ctx = makeCtx(workDir);
  previousHome = process.env.HOME;
  // buildSessionStack touches getAgentDir() for its other stores; keep it inside tmp.
  process.env.HOME = join(tmpRoot, "home");
  mkdirSync(join(tmpRoot, "home", ".pi", "agent"), { recursive: true });
});

afterEach(() => {
  // Kill anything still alive before the manager (and its log stream) go away.
  for (const manager of managers.splice(0).reverse()) {
    for (const record of manager.list()) {
      if (!isTerminalJobStatus(record.status) && record.pid !== undefined) killTree(record.pid);
    }
    manager.dispose();
  }
  for (const pid of strayPids.splice(0)) killTree(pid);
  if (previousHome === undefined) delete process.env.HOME;
  else process.env.HOME = previousHome;
  rmSync(tmpRoot, { recursive: true, force: true });
});

function killTree(pid: number): void {
  try {
    process.kill(-pid, "SIGKILL");
  } catch {
    /* group already gone */
  }
  try {
    process.kill(pid, "SIGKILL");
  } catch {
    /* already gone */
  }
}

interface Harness {
  host: Host;
  manager: BashJobManager;
  bash: ReturnType<typeof createBashTool>;
  jobs: ReturnType<typeof createBashJobTool>;
}

/**
 * One session's worth of the real chain. `autoBackgroundMs` is passed straight
 * to the override (the settings file only stores whole seconds, and these
 * tests need sub-second thresholds to stay fast).
 */
function buildHarness(autoBackgroundMs: number, overrides: Partial<AgentSettings["bashJobs"]> = {}): Harness {
  const host = fakePi();
  const stack = buildSessionStack(host.pi, ctx, settingsWith(jobsDir, { autoBackgroundMs, ...overrides }), types, []);
  const manager = stack.bashJobs;
  if (!manager) throw new Error("bash jobs disabled — the I-group requires the feature on");
  managers.push(manager);
  return {
    host,
    manager,
    bash: createBashTool({ manager: () => manager, autoBackgroundMs: () => autoBackgroundMs }),
    jobs: createBashJobTool({ manager: () => manager }),
  };
}

type AnyTool = ToolDefinition<never, never>;

async function run(
  tool: { execute: AnyTool["execute"] },
  params: Record<string, unknown>,
): Promise<{ content: { type: string; text?: string }[]; details?: unknown }> {
  const result = await (tool as unknown as { execute: (...args: unknown[]) => Promise<unknown> }).execute(
    `call-${Math.random().toString(36).slice(2)}`,
    params,
    undefined,
    undefined,
    ctx,
  );
  return result as { content: { type: string; text?: string }[]; details?: unknown };
}

function textOf(result: { content: { type: string; text?: string }[] }): string {
  return result.content
    .map((part) => (part.type === "text" ? (part.text ?? "") : ""))
    .join("\n")
    .trim();
}

function backgroundDetails(result: { details?: unknown }): BashBackgroundDetails {
  const details = result.details as BashBackgroundDetails | undefined;
  if (!details || details.background !== true) {
    throw new Error(`expected a backgrounded result, got details ${JSON.stringify(details)}`);
  }
  return details;
}

function notices(host: Host): Host["sent"] {
  return host.sent.filter((entry) => entry.message.customType === "bash-job:notification");
}

async function loadRecord(manager: BashJobManager, jobId: string): Promise<JobRecord> {
  const record = (await manager.load(jobId)) ?? manager.get(jobId);
  if (!record) throw new Error(`job ${jobId} vanished`);
  return record;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, ms);
    (timer as unknown as { unref?: () => void }).unref?.();
  });
}

// ── I1: threshold → job_id → exactly one notification → readable output ────

describe("I1 auto-background full chain", () => {
  it.runIf(posix)(
    "returns a job_id past the threshold, notifies once, and keeps the output readable",
    async () => {
      const { host, manager, bash, jobs } = buildHarness(200);

      const result = await run(bash, { command: "sleep 1; echo done" });
      const details = backgroundDetails(result);
      expect(details.autoBackgrounded).toBe(true);
      expect(details.pid).toBeGreaterThan(0);
      expect(details.logPath.startsWith(jobsDir)).toBe(true);
      const jobId = details.jobId;
      expect(jobId).toMatch(/^b_[0-9A-Z]{8}$/);

      const text = textOf(result);
      expect(text).toContain("moved to the background");
      expect(text).toContain(`job_id: ${jobId}`);
      expect(text).toContain("NOT killed");
      // The process really is still running when the call comes back (Z2).
      expect(probePid(details.pid)).toBe(true);

      // §5 single channel: the completion notice is delivered exactly once,
      // with triggerTurn so the model gets a turn to collect the result.
      await vi.waitFor(() => expect(notices(host).length).toBe(1), { timeout: WAIT_TIMEOUT_MS, interval: 50 });
      const notice = notices(host)[0]!;
      expect(notice.message.customType).toBe("bash-job:notification");
      expect(notice.options?.triggerTurn).toBe(true);
      expect(notice.message.display).toBe(true);
      const content = notice.message.content as string;
      expect(content).toContain(`Bash job ${jobId}`);
      expect(content).toContain("finished: exit 0 after");
      expect(content).toContain("done");
      expect(notice.message.details).toMatchObject({ kind: "bash-job", jobId, status: "completed", exitCode: 0 });

      const record = await loadRecord(manager, jobId);
      expect(record.status).toBe("completed");
      expect(record.exitCode).toBe(0);
      // The notice's tail read must not have consumed the model's cursor.
      expect(record.readCursor).toBe(0);

      // Change C: `status` carries the tail; the log file itself is the full
      // record, and its own last line states the outcome (change B).
      const status = await run(jobs, { action: "status", job_id: jobId });
      const statusText = textOf(status);
      expect(statusText).toContain("done");
      expect(statusText).toContain("completed (exit 0)");
      expect(statusText).toContain(`Full log: ${record.logPath}`);
      const rawLog = readFileSync(record.logPath, "utf8");
      expect(rawLog).toContain("done");
      expect(rawLog.trimEnd().endsWith(`[pi-subagent] job ${jobId} completed (exit 0) after 0ms`)).toBe(false);
      expect(rawLog.trimEnd()).toMatch(new RegExp(`\\[pi-subagent\\] job ${jobId} completed \\(exit 0\\) after .+$`));

      // Still exactly one notice after another full poll window (no re-sends).
      await sleep(QUIET_WINDOW_MS);
      expect(notices(host).length).toBe(1);
    },
    60_000,
  );
});

// ── I2: kill really takes down the whole process group ────────────────────

describe("I2 kill chain", () => {
  it.runIf(posix)(
    "kills the whole process group of a background job, descendants included",
    async () => {
      const { manager, bash, jobs } = buildHarness(120_000);

      // The shell backgrounds a child and then blocks: both must die.
      const started = await run(bash, {
        command: "sleep 60 & echo child=$!; sleep 60",
        run_in_background: true,
      });
      const { jobId, pid } = backgroundDetails(started);
      strayPids.push(pid);

      let childPid = 0;
      await vi.waitFor(
        async () => {
          const read = await manager.readOutput(jobId, { advanceCursor: false, offset: 0 });
          const match = /child=(\d+)/.exec(read.content);
          expect(match).not.toBeNull();
          childPid = Number(match![1]);
          expect(probePid(childPid)).toBe(true);
        },
        { timeout: WAIT_TIMEOUT_MS, interval: 50 },
      );
      strayPids.push(childPid);
      expect(childPid).not.toBe(pid);
      expect(probePid(pid)).toBe(true);

      const killed = await run(jobs, { action: "kill", job_id: jobId });
      expect(textOf(killed)).toContain("signalled");
      expect(killed.details).toMatchObject({ jobId, killed: true, alreadyTerminal: false });

      await vi.waitFor(
        () => {
          expect(probePid(pid), "the job's shell must be gone").toBe(false);
          expect(probePid(childPid), "the descendant must die with the group").toBe(false);
        },
        { timeout: WAIT_TIMEOUT_MS, interval: 50 },
      );
      await vi.waitFor(async () => expect((await loadRecord(manager, jobId)).status).toBe("killed"), {
        timeout: WAIT_TIMEOUT_MS,
        interval: 50,
      });

      // Idempotent: a second kill reports, never throws (§4.3).
      const again = await run(jobs, { action: "kill", job_id: jobId });
      expect(textOf(again)).toContain("has already finished");
      expect(again.details).toMatchObject({ alreadyTerminal: true, killed: false });
    },
    60_000,
  );
});

// ── I3: restart adoption across two managers over the same directory ─────

describe("I3 restart recovery", () => {
  it.runIf(posix)(
    "adopts a running job in the next session and notifies exactly once after a kill",
    async () => {
      const first = buildHarness(120_000);
      const started = await run(first.bash, { command: "sleep 60", run_in_background: true });
      const { jobId, pid } = backgroundDetails(started);
      strayPids.push(pid);
      expect(probePid(pid)).toBe(true);

      // Building the next session's stack disposes the previous manager
      // (timers only — the process must survive) and recovers the directory.
      const second = buildHarness(120_000);
      expect(second.manager).not.toBe(first.manager);
      expect(probePid(pid), "a session rebuild must never touch a background process").toBe(true);

      await vi.waitFor(
        () => {
          const adopted = second.manager.get(jobId);
          expect(adopted?.status).toBe("running");
          expect(adopted?.backgroundedAt).toBeTypeOf("number");
        },
        { timeout: WAIT_TIMEOUT_MS, interval: 50 },
      );
      // The adopted job is visible to the model through the new session's tool.
      expect(textOf(await run(second.jobs, { action: "list" }))).toContain(jobId);

      await run(second.jobs, { action: "kill", job_id: jobId });
      await vi.waitFor(() => expect(probePid(pid)).toBe(false), { timeout: WAIT_TIMEOUT_MS, interval: 50 });

      const jobNotices = () => notices(second.host).filter((notice) => notice.message.details?.jobId === jobId);
      await vi.waitFor(() => expect(jobNotices().length).toBe(1), {
        timeout: WAIT_TIMEOUT_MS,
        interval: 50,
      });
      expect(jobNotices()[0]!.message.content as string).toContain("killed after");
      await sleep(QUIET_WINDOW_MS);
      // Exactly once, and only through the *current* manager's channel: the
      // disposed manager's live callbacks may persist but must never notify.
      expect(jobNotices().length).toBe(1);
      expect(notices(first.host).filter((notice) => notice.message.details?.jobId === jobId)).toEqual([]);
    },
    60_000,
  );
});

// ── I4: a running record whose pid is certainly gone ─────────────────────

describe("I3 fork handoff exit code", () => {
  it.runIf(posix)(
    "preserves exitCode 7 across a fork with a new session directory",
    async () => {
      const first = buildHarness(120_000);
      const started = await run(first.bash, {
        command: "sh -c 'sleep 0.3; exit 7'",
        run_in_background: true,
      });
      const { jobId } = backgroundDetails(started);
      ctx = makeCtx(workDir, "forked-session");
      const second = buildHarness(120_000);
      await vi.waitFor(
        async () => {
          const record = await loadRecord(second.manager, jobId);
          expect(record.status).toBe("failed");
          expect(record.exitCode).toBe(7);
        },
        { timeout: WAIT_TIMEOUT_MS, interval: 50 },
      );
      expect((await loadRecord(second.manager, jobId)).exitCode).toBe(7);
    },
    60_000,
  );
});

describe("I4 exited_unknown recovery", () => {
  it.runIf(posix)(
    "labels a running record with a dead pid exited_unknown and still notifies",
    async () => {
      // A real corpse: spawn, wait for the exit, then hand recovery its pid.
      const corpse = spawn("sh", ["-c", "exit 0"], { stdio: "ignore" });
      const deadPid = corpse.pid!;
      await new Promise<void>((resolve) => corpse.on("exit", () => resolve()));
      const sessionDir = join(jobsDir, sanitizeSessionDirName("session-under-test"));
      mkdirSync(sessionDir, { recursive: true });
      const logPath = join(sessionDir, "b_TEST0400.log");
      writeFileSync(logPath, "partial output\nlast line before the crash\n", "utf8");
      const seeded: JobRecord = {
        v: 1,
        jobId: "b_TEST0400",
        command: "npm run build:all",
        cwd: workDir,
        sessionId: "previous-session",
        hostPid: process.pid,
        pid: deadPid,
        pgid: deadPid,
        // A starttime that cannot match (the pid is gone, or was recycled):
        // either way `checkPidOwnership` answers "dead", never "unsafe".
        procStartTime: "1",
        status: "running",
        createdAt: Date.now() - 120_000,
        spawnedAt: Date.now() - 120_000,
        backgroundedAt: Date.now() - 119_000,
        exitCode: null,
        logPath,
        logBytes: 0,
        outputTruncated: false,
        readCursor: 0,
      };
      writeFileSync(join(sessionDir, "b_TEST0400.json"), JSON.stringify(seeded), "utf8");

      const { host, manager, jobs } = buildHarness(120_000);
      await vi.waitFor(() => expect(manager.get("b_TEST0400")?.status).toBe("exited_unknown"), {
        timeout: WAIT_TIMEOUT_MS,
        interval: 50,
      });

      await vi.waitFor(() => expect(notices(host).length).toBe(1), { timeout: WAIT_TIMEOUT_MS, interval: 50 });
      const content = notices(host)[0]!.message.content as string;
      expect(content).toContain("Bash job b_TEST0400 ($ npm run build:all) finished:");
      expect(content).toContain("gone (its process disappeared, exit code lost)");
      expect(content).toContain("last line before the crash");
      expect(notices(host)[0]!.message.details).toMatchObject({ status: "exited_unknown", exitCode: null });

      // The log survives the loss of the exit code — status still shows it,
      // and points at the plain file for the rest.
      const status = await run(jobs, { action: "status", job_id: "b_TEST04" });
      expect(textOf(status)).toContain("partial output");
      expect(textOf(status)).toContain("exit code lost");
      expect(textOf(status)).toMatch(/Full log: .*b_TEST0400\.log/);

      await sleep(QUIET_WINDOW_MS);
      expect(notices(host).length).toBe(1);
    },
    60_000,
  );
});

// ── I5: the short-command path is byte-identical to the built-in tool ────

describe("I5 short-command golden equivalence (real processes)", () => {
  it.runIf(posix)(
    "produces exactly the built-in bash tool's result for a fast command",
    async () => {
      const { bash } = buildHarness(120_000);
      const builtin = createBashToolDefinition(ctx.cwd);

      const overridden = await run(bash, { command: "echo hi" });
      const expected = await run(builtin as unknown as { execute: AnyTool["execute"] }, { command: "echo hi" });
      expect(overridden).toEqual(expected);
      expect(textOf(overridden)).toBe("hi");

      // …including the rejection path: a non-zero exit throws pi's own text.
      const failing = { command: "echo oops >&2; exit 3" };
      const overrideError = await run(bash, failing).catch((error: unknown) => error as Error);
      const builtinError = await run(builtin as unknown as { execute: AnyTool["execute"] }, failing).catch(
        (error: unknown) => error as Error,
      );
      expect(overrideError).toBeInstanceOf(Error);
      expect((overrideError as Error).message).toBe((builtinError as Error).message);
      expect((overrideError as Error).message).toContain("Command exited with code 3");
    },
    60_000,
  );
});
