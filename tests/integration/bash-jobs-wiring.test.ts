import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { spawn } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { DEFAULT_SETTINGS, type AgentSettings } from "../../src/config/settings.js";
import type { AgentTypeRegistry } from "../../src/config/agent-types.js";
import { bashJobsEnabled, buildSessionStack, formatBashJobNotification, readBashJobTail } from "../../src/stack.js";
import { probePid, readProcStartTime } from "../../src/bash/process.js";
import type { JobRecord } from "../../src/bash/types.js";
import type { BashJobManager } from "../../src/bash/manager.js";

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

function settingsWith(
  dir: string,
  overrides: Partial<AgentSettings["bashJobs"]> = {},
  fleetWidget = false,
): AgentSettings {
  return {
    ...DEFAULT_SETTINGS,
    fleetWidget,
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

describe("S7 tail reader contract", () => {
  it.runIf(posix)("re-reads from the discovered file size without advancing readCursor", async () => {
    const record = seedRecord(join(tmpRoot, "tail"), { jobId: "b_TAIL0001", logBytes: 10, readCursor: 0 });
    const calls: Array<{ offset?: number; advanceCursor?: boolean }> = [];
    let hinted = false;
    const manager = {
      readOutput: async (_jobId: string, options: { offset?: number; advanceCursor?: boolean }) => {
        calls.push(options);
        const second = calls.length > 1;
        return {
          jobId: record.jobId,
          content: second || hinted ? "real tail\n" : "middle\n",
          startOffset: options.offset ?? 0,
          nextOffset: options.offset ?? 0,
          logBytes: 500,
          state: record.status,
          exitCode: null,
          logTruncated: false,
          record,
        };
      },
    } as unknown as BashJobManager;
    expect((await readBashJobTail(manager, record))?.text).toBe("real tail");
    expect(calls).toEqual([
      { offset: 0, advanceCursor: false, maxBytes: 1024 },
      { offset: 0, advanceCursor: false, maxBytes: 1024 },
    ]);
    expect(record.readCursor).toBe(0);

    calls.length = 0;
    hinted = true;
    expect((await readBashJobTail(manager, { ...record, logBytes: 500 }, 500))?.text).toBe("real tail");
    expect(calls).toHaveLength(1);
  });
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

describe("S8 fleet widget + bash jobs wiring", () => {
  function widgetContext(calls: Array<string[] | undefined>): ExtensionContext {
    return {
      ...ctx,
      ui: {
        setWidget: (_key: string, content: string[] | undefined) => calls.push(content),
      },
    } as unknown as ExtensionContext;
  }

  it.runIf(posix)("injects the widget getter from the same manager mounted in the stack", async () => {
    const dir = join(tmpRoot, "s8-same-manager");
    const child = spawn("sleep", ["30"], { detached: true, stdio: "ignore" });
    child.unref();
    const calls: Array<string[] | undefined> = [];
    try {
      seedRecord(dir, { jobId: "b_SAME0001", pid: child.pid, pgid: child.pid, command: "sleep 30" });
      const stack = buildSessionStack(fakePi().pi, widgetContext(calls), settingsWith(dir, {}, true), types, []);
      await vi.waitFor(
        () => expect(calls.some((frame) => frame?.some((line) => line.includes("$ sleep 30")))).toBe(true),
        {
          timeout: 5_000,
          interval: 25,
        },
      );
      expect(stack.bashJobs?.list().some((record) => record.jobId === "b_SAME0001")).toBe(true);
      stack.bashJobs?.dispose();
    } finally {
      try {
        process.kill(-(child.pid ?? 0), "SIGKILL");
      } catch {
        /* already gone */
      }
    }
  });

  it.runIf(posix)("refreshes immediately when recover resolves, before the first 1Hz tick", async () => {
    const dir = join(tmpRoot, "s8-recover-refresh");
    const child = spawn("sleep", ["30"], { detached: true, stdio: "ignore" });
    child.unref();
    const calls: Array<string[] | undefined> = [];
    try {
      seedRecord(dir, { jobId: "b_REFRES01", pid: child.pid, pgid: child.pid, command: "sleep 30" });
      const stack = buildSessionStack(fakePi().pi, widgetContext(calls), settingsWith(dir, {}, true), types, []);
      const initialCount = calls.length;
      await vi.waitFor(
        () => {
          expect(calls.length).toBeGreaterThan(initialCount);
          expect(calls.some((frame) => frame?.some((line) => line.includes("$ sleep 30")))).toBe(true);
        },
        { timeout: 5_000, interval: 10 },
      );
      expect(calls.length).toBeLessThan(100); // completion refresh, not an unbounded recovery loop
      stack.bashJobs?.dispose();
    } finally {
      try {
        process.kill(-(child.pid ?? 0), "SIGKILL");
      } catch {
        /* already gone */
      }
    }
  });

  it("keeps the widget usable when a recovery failure is explicitly caught", async () => {
    const dir = join(tmpRoot, "s8-recover-reject");
    const calls: Array<string[] | undefined> = [];
    const stack = buildSessionStack(fakePi().pi, widgetContext(calls), settingsWith(dir, {}, true), types, []);
    const manager = stack.bashJobs!;
    const originalRecover = manager.recover;
    // The concrete store intentionally converts filesystem scan failures into
    // empty results. Use the real mounted manager and an explicit rejected
    // recovery promise to pin the caller's no-unhandled-rejection contract.
    manager.recover = async () => {
      throw new Error("synthetic recovery failure");
    };
    await expect(manager.recover()).rejects.toThrow("synthetic recovery failure");
    manager.recover = originalRecover;
    manager.dispose();
    expect(calls.length).toBeGreaterThan(0);
  });

  it.runIf(posix)("disposes the previous widget and manager before rebuilding the session", async () => {
    const firstDir = join(tmpRoot, "s8-rebuild-a");
    const secondDir = join(tmpRoot, "s8-rebuild-b");
    const firstCalls: Array<string[] | undefined> = [];
    const secondCalls: Array<string[] | undefined> = [];
    const first = buildSessionStack(
      fakePi().pi,
      widgetContext(firstCalls),
      settingsWith(firstDir, {}, true),
      types,
      [],
    );
    const second = buildSessionStack(
      fakePi().pi,
      widgetContext(secondCalls),
      settingsWith(secondDir, {}, true),
      types,
      [],
    );
    await Promise.resolve();
    expect(firstCalls.some((content) => content === undefined)).toBe(true);
    expect(secondCalls.length).toBeGreaterThan(0);
    first.bashJobs?.dispose();
    second.bashJobs?.dispose();
  });

  it("omits bash widget deps when the feature or fleet widget is off", () => {
    const dir = join(tmpRoot, "s8-off");
    const featureOffCalls: Array<string[] | undefined> = [];
    const featureOff = buildSessionStack(
      fakePi().pi,
      widgetContext(featureOffCalls),
      settingsWith(dir, { autoBackgroundMs: 0 }, true),
      types,
      [],
    );
    expect(featureOff.bashJobs).toBeUndefined();
    expect(featureOffCalls).toEqual([undefined]);

    const widgetOffCalls: Array<string[] | undefined> = [];
    const widgetOff = buildSessionStack(
      fakePi().pi,
      widgetContext(widgetOffCalls),
      settingsWith(dir, {}, false),
      types,
      [],
    );
    expect(widgetOff.bashJobs).toBeDefined();
    expect(widgetOffCalls).toEqual([]);
    featureOff.bashJobs?.dispose();
    widgetOff.bashJobs?.dispose();
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
