import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { spawn } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { DEFAULT_SETTINGS, type AgentSettings } from "../../src/config/settings.js";
import type { AgentTypeRegistry } from "../../src/config/agent-types.js";
import { bashJobsEnabled, buildSessionStack, formatBashJobNotification } from "../../src/stack.js";
import { probePid, readProcStartTime } from "../../src/bash/process.js";
import type { JobRecord } from "../../src/bash/types.js";

/**
 * S7 wiring: the pieces `src/stack.ts` and `src/index.ts` own for bash
 * auto-background — manager construction + `recover()`, the single
 * notification channel bound to `pi.sendMessage` (customType
 * `bash-job:notification`, triggerTurn), and the §3.7 shutdown policy table
 * (reload/new/resume/fork keep the processes; only `quit` + `shutdownPolicy:
 * "kill"` signals them, bounded).
 *
 * Everything below runs against a temporary agent dir — no test may read or
 * mutate the developer's real `~/.pi/agent/bash-jobs`.
 */
const HOST_KEY = Symbol.for("pi-subagent:host");
const posix = process.platform !== "win32";

function fakePi() {
  const handlers = new Map<string, ((event: unknown, ctx: unknown) => unknown)[]>();
  const sent: { message: Record<string, unknown>; options?: { triggerTurn?: boolean } }[] = [];
  const tools: string[] = [];
  const pi = {
    registerTool: (tool: { name: string }) => tools.push(tool.name),
    registerCommand: () => undefined,
    on(event: string, handler: (event: unknown, ctx: unknown) => unknown) {
      handlers.set(event, [...(handlers.get(event) ?? []), handler]);
    },
    sendMessage: (message: Record<string, unknown>, options?: { triggerTurn?: boolean }) => {
      sent.push({ message, ...(options ? { options } : {}) });
    },
    appendEntry: () => undefined,
    events: { on: () => () => undefined, emit: () => undefined },
    exec: async () => ({ code: 0, stdout: "", stderr: "", killed: false }),
  };
  const emit = async (event: string, payload: unknown = {}, ctx: unknown = {}) => {
    for (const handler of handlers.get(event) ?? []) await handler(payload, ctx);
  };
  return { pi: pi as unknown as ExtensionAPI, emit, sent, tools, handlers };
}

const ctx = {
  sessionManager: { getEntries: () => [], getSessionId: () => "session-under-test" },
  modelRegistry: { getAvailable: () => [], find: () => undefined },
  ui: {},
  cwd: process.cwd(),
} as unknown as ExtensionContext;

const types = {
  get: () => undefined,
  list: () => [],
  reload: async () => ({ types: [], errors: [] }),
} as unknown as AgentTypeRegistry;

function settingsWith(dir: string, overrides: Partial<AgentSettings["bashJobs"]> = {}): AgentSettings {
  return {
    ...DEFAULT_SETTINGS,
    fleetWidget: false,
    bashJobs: { ...DEFAULT_SETTINGS.bashJobs, dir, ...overrides },
  };
}

function seedRecord(dir: string, record: Partial<JobRecord> & { jobId: string }): JobRecord {
  mkdirSync(dir, { recursive: true });
  const full: JobRecord = {
    v: 1,
    command: "sleep 30",
    cwd: "/repo",
    sessionId: "previous-session",
    hostPid: process.pid,
    status: "running",
    createdAt: Date.now() - 60_000,
    spawnedAt: Date.now() - 60_000,
    backgroundedAt: Date.now() - 59_000,
    exitCode: null,
    logPath: join(dir, `${record.jobId}.log`),
    logBytes: 0,
    outputTruncated: false,
    readCursor: 0,
    ...record,
  } as JobRecord;
  writeFileSync(join(dir, `${full.jobId}.json`), JSON.stringify(full), "utf8");
  if (!existsSync(full.logPath)) writeFileSync(full.logPath, "", "utf8");
  return full;
}

let tmpRoot: string;
beforeEach(() => {
  delete (globalThis as Record<symbol, unknown>)[HOST_KEY];
  tmpRoot = mkdtempSync(join(tmpdir(), "pi-subagent-bash-"));
});
afterEach(() => {
  delete (globalThis as Record<symbol, unknown>)[HOST_KEY];
  rmSync(tmpRoot, { recursive: true, force: true });
});

describe("S7 stack wiring: BashJobManager construction", () => {
  it("builds a manager when the feature is on and none at all when the threshold is 0", () => {
    const dir = join(tmpRoot, "jobs");
    const on = buildSessionStack(fakePi().pi, ctx, settingsWith(dir), types, []);
    expect(bashJobsEnabled(settingsWith(dir))).toBe(posix);
    expect(on.bashJobs?.dir).toBe(posix ? dir : undefined);
    on.bashJobs?.dispose();

    const off = buildSessionStack(fakePi().pi, ctx, settingsWith(dir, { autoBackgroundMs: 0 }), types, []);
    expect(off.bashJobs).toBeUndefined();
    expect(bashJobsEnabled(settingsWith(dir, { autoBackgroundMs: 0 }))).toBe(false);
  });

  it.runIf(posix)(
    "recover() picks up a terminal unnotified job and delivers exactly one bash-job:notification",
    async () => {
      const dir = join(tmpRoot, "jobs");
      const record = seedRecord(dir, {
        jobId: "b_TEST0001",
        command: "npm test",
        status: "failed",
        exitCode: 1,
        spawnedAt: Date.now() - 452_000,
        endedAt: Date.now(),
        finalText: "Command exited with code 1",
      });
      writeFileSync(record.logPath, "line one\nline two\nfailing assertion\n", "utf8");

      const host = fakePi();
      const stack = buildSessionStack(host.pi, ctx, settingsWith(dir), types, []);
      await vi.waitFor(() => expect(host.sent.length).toBe(1), { timeout: 8_000, interval: 50 });

      const [delivery] = host.sent;
      expect(delivery!.message.customType).toBe("bash-job:notification");
      expect(delivery!.message.display).toBe(true);
      expect(delivery!.options?.triggerTurn).toBe(true);
      const content = delivery!.message.content as string;
      expect(content).toContain("Bash job b_TEST0001 ($ npm test) finished: exit 1 after");
      expect(content).toContain("--- output tail ---");
      expect(content).toContain("failing assertion");
      // Change A: the notice names the log file once and authorises reading it.
      expect(content).toContain(`Full log: ${record.logPath}`);
      expect(content).toMatch(/read tool.*tail\/grep\/awk/);
      expect(content.split(record.logPath).length - 1).toBe(1);
      // Distinguishable from the subagent channel (delivery/format.ts).
      expect(content.startsWith("Subagent")).toBe(false);
      expect(delivery!.message.details).toMatchObject({
        kind: "bash-job",
        jobId: "b_TEST0001",
        status: "failed",
        exitCode: 1,
        logPath: record.logPath,
      });

      // notifiedAt is persisted (just after the send resolves), so the next
      // session (a /reload) stays quiet.
      let persisted!: JobRecord;
      await vi.waitFor(
        () => {
          persisted = JSON.parse(readFileSync(join(dir, "b_TEST0001.json"), "utf8")) as JobRecord;
          expect(persisted.notifiedAt).toBeTypeOf("number");
        },
        { timeout: 5_000, interval: 25 },
      );
      // The model-facing read cursor must not have been consumed by the tail read.
      expect(persisted.readCursor).toBe(0);

      const next = fakePi();
      const rebuilt = buildSessionStack(next.pi, ctx, settingsWith(dir), types, []);
      await new Promise((resolve) => setTimeout(resolve, 2_500));
      expect(next.sent).toEqual([]);
      expect(stack.bashJobs).not.toBe(rebuilt.bashJobs);
      rebuilt.bashJobs?.dispose();
    },
  );
});

describe("S7 notification text", () => {
  const base: JobRecord = {
    v: 1,
    jobId: "b_TEST0003",
    command: "npm test",
    cwd: "/repo",
    sessionId: "s",
    hostPid: 1,
    status: "completed",
    createdAt: 0,
    spawnedAt: 0,
    endedAt: 452_000,
    exitCode: 0,
    logPath: "/tmp/b_TEST0003.log",
    logBytes: 0,
    outputTruncated: false,
    readCursor: 0,
  };

  it("uses the exit code when known and the status phrase otherwise", () => {
    expect(formatBashJobNotification(base, undefined, 0)).toContain(
      "Bash job b_TEST0003 ($ npm test) finished: exit 0 after 7m32s.",
    );
    expect(formatBashJobNotification({ ...base, status: "timed_out", exitCode: null }, undefined, 0)).toContain(
      "finished: timed out after 7m32s.",
    );
    expect(formatBashJobNotification({ ...base, status: "killed", exitCode: null }, undefined, 0)).toContain(
      "finished: killed after",
    );
  });

  it("omits the tail block when there is no output and flags a capped log", () => {
    expect(formatBashJobNotification(base, undefined, 0)).not.toContain("--- output tail ---");
    expect(formatBashJobNotification({ ...base, outputTruncated: true }, "tail", 0)).toContain(
      "the job's log hit its size cap",
    );
  });
});

describe("S7 index wiring: session_shutdown policy table (§3.7)", () => {
  function withTempHome(shutdownPolicy: "keep" | "kill"): { home: string; jobsDir: string; restore: () => void } {
    const home = join(tmpRoot, `home-${shutdownPolicy}`);
    const agentDir = join(home, ".pi", "agent");
    mkdirSync(agentDir, { recursive: true });
    writeFileSync(
      join(agentDir, "pi-subagent.json"),
      JSON.stringify({ fleetWidget: false, bashJobs: { shutdownPolicy } }),
      "utf8",
    );
    const previousHome = process.env.HOME;
    process.env.HOME = home;
    return {
      home,
      jobsDir: join(agentDir, "bash-jobs"),
      restore: () => {
        if (previousHome === undefined) delete process.env.HOME;
        else process.env.HOME = previousHome;
      },
    };
  }

  async function activateWith(jobsDir: string, pid: number) {
    const { default: activate } = await import("../../src/index.js");
    const host = fakePi();
    activate(host.pi);
    await host.emit("session_start", {}, ctx);
    // Wait for recover() to adopt the seeded job (adoption stamps backgroundedAt).
    await vi.waitFor(
      () => {
        const raw = JSON.parse(readFileSync(join(jobsDir, "b_TEST0002.json"), "utf8")) as JobRecord;
        expect(raw.backgroundedAt).toBeTypeOf("number");
        expect(probePid(pid)).toBe(true);
      },
      { timeout: 5_000, interval: 25 },
    );
    return host;
  }

  it.runIf(posix)("keeps running jobs on reload and on quit with the default keep policy", async () => {
    const child = spawn("sleep", ["30"], { detached: true, stdio: "ignore" });
    const pid = child.pid!;
    child.unref();
    const home = withTempHome("keep");
    try {
      seedRecord(home.jobsDir, {
        jobId: "b_TEST0002",
        pid,
        pgid: pid,
        ...(readProcStartTime(pid) !== undefined ? { procStartTime: readProcStartTime(pid)! } : {}),
      });
      const reload = await activateWith(home.jobsDir, pid);
      expect(reload.tools).toContain("bash");
      expect(reload.tools).toContain("bash_job");
      await reload.emit("session_shutdown", { reason: "reload" });
      expect(probePid(pid), "reload must never touch a background process").toBe(true);

      const quit = await activateWith(home.jobsDir, pid);
      await quit.emit("session_shutdown", { reason: "quit" });
      expect(probePid(pid), 'shutdownPolicy "keep" must survive quit').toBe(true);
    } finally {
      home.restore();
      try {
        process.kill(-pid, "SIGKILL");
      } catch {
        /* already gone */
      }
    }
  });

  it.runIf(posix)('kills running jobs on quit when shutdownPolicy is "kill"', async () => {
    const child = spawn("sleep", ["30"], { detached: true, stdio: "ignore" });
    const pid = child.pid!;
    child.unref();
    const home = withTempHome("kill");
    try {
      seedRecord(home.jobsDir, {
        jobId: "b_TEST0002",
        pid,
        pgid: pid,
        ...(readProcStartTime(pid) !== undefined ? { procStartTime: readProcStartTime(pid)! } : {}),
      });
      const fork = await activateWith(home.jobsDir, pid);
      await fork.emit("session_shutdown", { reason: "fork" });
      expect(probePid(pid), "fork is a session replacement, not an exit").toBe(true);

      const quit = await activateWith(home.jobsDir, pid);
      await quit.emit("session_shutdown", { reason: "quit" });
      await vi.waitFor(() => expect(probePid(pid)).toBe(false), { timeout: 5_000, interval: 25 });
    } finally {
      home.restore();
      try {
        process.kill(-pid, "SIGKILL");
      } catch {
        /* already gone */
      }
    }
  });
});
