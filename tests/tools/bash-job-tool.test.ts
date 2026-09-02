import { describe, expect, it } from "vitest";
import {
  createBashJobTool,
  DEFAULT_WAIT_MS,
  MAX_WAIT_MS,
  finalStatusLine,
  formatJobSummary,
  STATUS_TAIL_BYTES,
  STATUS_TAIL_LINES,
  BashJobToolParams,
  type BashJobToolParams as BashJobToolParamsType,
} from "../../src/tools/bash-job-tool.js";
import type { BashJobManager, JobOutputRead, KillJobResult, ReadOutputOptions } from "../../src/bash/manager.js";
import { isTerminalJobStatus, type JobId, type JobRecord, type JobStatus } from "../../src/bash/types.js";

/**
 * T10-T16 (docs/dev/bash-auto-background/plan-fable.md section 9): the
 * `bash_job` tool's four actions against a fake BashJobManager — status
 * wording per state, the log tail `status` carries, bounded wait, idempotent
 * kill, list, and prefix resolution. There is no `output` action: the log is a
 * plain file the model reads directly (change C).
 */

const theme = { fg: (_tone: string, value: string) => value, bold: (value: string) => value } as never;
const renderContext = { lastComponent: undefined } as never;
const NOW = 1_000_000;

function makeRecord(over: Partial<JobRecord> & { jobId: JobId }): JobRecord {
  return {
    v: 1,
    command: "npm test",
    cwd: "/repo",
    sessionId: "s1",
    hostPid: 4242,
    status: "running",
    createdAt: NOW - 60_000,
    spawnedAt: NOW - 60_000,
    exitCode: null,
    logPath: `/tmp/${over.jobId}.log`,
    logBytes: 0,
    outputTruncated: false,
    readCursor: 0,
    ...over,
  };
}

interface FakeManager extends BashJobManager {
  readonly calls: string[];
  failReads?: boolean;
  put(record: JobRecord, log?: string): void;
  setLog(jobId: JobId, log: string): void;
  settleWait(jobId: JobId, record?: JobRecord): void;
}

/** Minimal in-memory stand-in for the real manager (S4). */
function fakeManager(options: { waitResolvesImmediately?: boolean } = {}): FakeManager {
  const records = new Map<JobId, JobRecord>();
  const logs = new Map<JobId, string>();
  const waiters = new Map<JobId, (record: JobRecord | undefined) => void>();
  const calls: string[] = [];

  const manager: FakeManager = {
    calls,
    dir: "/tmp/bash-jobs",
    maxBackgroundJobs: 8,
    put(record, log = "") {
      records.set(record.jobId, record);
      logs.set(record.jobId, log);
    },
    setLog(jobId, log) {
      logs.set(jobId, log);
    },
    settleWait(jobId, record) {
      const resolve = waiters.get(jobId);
      if (record) records.set(jobId, record);
      waiters.delete(jobId);
      resolve?.(record ?? records.get(jobId));
    },
    async recover() {
      throw new Error("unused");
    },
    async create() {
      throw new Error("unused");
    },
    get(jobId) {
      return records.get(jobId);
    },
    async load(jobId) {
      calls.push(`load:${jobId}`);
      return records.get(jobId);
    },
    list() {
      return [...records.values()].sort((a, b) => a.createdAt - b.createdAt);
    },
    resolve(handle) {
      const trimmed = handle.trim();
      if (records.has(trimmed)) return trimmed;
      const matches = trimmed.length > 0 ? [...records.keys()].filter((id) => id.startsWith(trimmed)) : [];
      if (matches.length === 1) return matches[0]!;
      const candidates = [...records.keys()].join(", ") || "none";
      throw new Error(
        matches.length > 1
          ? `ambiguous bash job target: ${trimmed}. Candidates: [${candidates}]`
          : `bash job not found: ${trimmed}. Candidates: [${candidates}]`,
      );
    },
    async markBackgrounded(jobId) {
      return records.get(jobId);
    },
    async setFinalText(jobId) {
      return records.get(jobId);
    },
    noteTermination() {},
    async readOutput(jobId: JobId, readOptions: ReadOutputOptions = {}): Promise<JobOutputRead> {
      const record = records.get(jobId);
      if (!record) throw new Error(`bash job not found: ${jobId}`);
      if (manager.failReads) throw new Error("log unreadable");
      const log = Buffer.from(logs.get(jobId) ?? "", "utf8");
      const startOffset = Math.min(Math.max(0, readOptions.offset ?? record.readCursor), log.length);
      const end = Math.min(log.length, startOffset + (readOptions.maxBytes ?? log.length));
      const content = log.subarray(startOffset, end).toString("utf8");
      const nextOffset = end;
      calls.push(`readOutput:${jobId}:${startOffset}`);
      if (readOptions.advanceCursor !== false && nextOffset > record.readCursor) {
        records.set(jobId, { ...record, readCursor: nextOffset, logBytes: log.length });
      }
      const current = records.get(jobId)!;
      const read: JobOutputRead = {
        jobId,
        content,
        startOffset,
        nextOffset,
        logBytes: log.length,
        state: current.status,
        exitCode: current.exitCode,
        logTruncated: current.outputTruncated,
        ...(current.finalText !== undefined ? { finalText: current.finalText } : {}),
        record: current,
      };
      return read;
    },
    async kill(jobId): Promise<KillJobResult> {
      const record = records.get(jobId);
      if (!record) throw new Error(`bash job not found: ${jobId}`);
      calls.push(`kill:${jobId}`);
      if (isTerminalJobStatus(record.status)) {
        return { jobId, outcome: "already-terminal", alreadyTerminal: true, record };
      }
      if (record.pid === -1) {
        const orphan = { ...record, status: "orphaned" as JobStatus };
        records.set(jobId, orphan);
        return {
          jobId,
          outcome: "refused",
          alreadyTerminal: false,
          reason: `job ${jobId} cannot be safely killed: its pid ownership could not be verified`,
          record: orphan,
        };
      }
      const killed = { ...record, status: "killed" as JobStatus, endedAt: NOW };
      records.set(jobId, killed);
      return { jobId, outcome: "signalled", alreadyTerminal: false, record: killed };
    },
    waitExit(jobId, timeoutMs) {
      calls.push(`waitExit:${jobId}:${timeoutMs}`);
      const record = records.get(jobId);
      if (!record) return Promise.resolve(undefined);
      if (isTerminalJobStatus(record.status) || options.waitResolvesImmediately) return Promise.resolve(record);
      return new Promise((resolve) => waiters.set(jobId, resolve));
    },
    backgroundJobCount() {
      return 0;
    },
    hasBackgroundCapacity() {
      return true;
    },
    dispose() {},
  };
  return manager;
}

/** Yield until the tool has reached the fake manager's `waitExit`. */
async function waitForCall(manager: FakeManager, call: string): Promise<void> {
  for (let i = 0; i < 100 && !manager.calls.includes(call); i++) await Promise.resolve();
  if (!manager.calls.includes(call)) throw new Error(`never observed ${call} (saw ${manager.calls.join(", ")})`);
}

function run(manager: BashJobManager | undefined, params: BashJobToolParamsType) {
  const tool = createBashJobTool({ manager: () => manager, now: () => NOW });
  return tool.execute("tc", params, undefined, undefined, {} as never);
}

describe("bash_job — T10 status wording per state", () => {
  it.each([
    [{ status: "running" as JobStatus, pid: 23456, logBytes: 2048 }, /running for 1m00s \(pid 23456, log 2\.0KB\)/],
    [{ status: "completed" as JobStatus, exitCode: 0, endedAt: NOW - 10_000 }, /completed \(exit 0\) after 50s/],
    [{ status: "failed" as JobStatus, exitCode: 1, endedAt: NOW }, /failed \(exit 1\) after 1m00s/],
    [{ status: "timed_out" as JobStatus, endedAt: NOW }, /timed out after/],
    [{ status: "killed" as JobStatus, endedAt: NOW }, /killed after/],
    [{ status: "exited_unknown" as JobStatus, endedAt: NOW }, /exit code lost/],
    [{ status: "orphaned" as JobStatus, endedAt: NOW }, /orphaned \(left behind by an earlier pi process\)/],
    [{ status: "staged" as JobStatus, spawnedAt: undefined }, /not started yet/],
  ])("summarizes %j", async (over, expected) => {
    const manager = fakeManager();
    manager.put(makeRecord({ jobId: "b_AAAA1111", ...over }));
    const response = await run(manager, { action: "status", job_id: "b_AAAA1111" });
    expect(response.content[0]!.text).toMatch(expected);
    expect(response.content[0]!.text).toContain("$ npm test");
  });

  it("carries a structured details payload and points at the log file", async () => {
    const manager = fakeManager();
    manager.put(
      makeRecord({ jobId: "b_AAAA1111", status: "failed", exitCode: 2, endedAt: NOW, pid: 77, logBytes: 12 }),
      "boom\n",
    );
    const response = await run(manager, { action: "status", job_id: "b_AAAA1111" });
    const out = response.content[0]!.text;
    expect(out).toContain("Full log: /tmp/b_AAAA1111.log");
    expect(out).toMatch(/read tool.*tail\/grep\/awk/);
    expect(out).not.toContain('action: "output"');
    expect(response.details).toMatchObject({
      jobId: "b_AAAA1111",
      status: "failed",
      exitCode: 2,
      terminal: true,
      pid: 77,
      logPath: "/tmp/b_AAAA1111.log",
    });
  });
});

/**
 * T11/T12 (reshaped by change C): `output` is gone; `status` carries a bounded
 * log tail and always names the log file. The tail read must never advance the
 * persisted cursor, so status stays a free, repeatable poll.
 */
describe("bash_job — T11/T12 status log tail", () => {
  it("shows the tail of a running job's log without consuming it", async () => {
    const manager = fakeManager();
    manager.put(makeRecord({ jobId: "b_BBBB2222", logBytes: 6 }), "hello\n");
    const first = await run(manager, { action: "status", job_id: "b_BBBB2222" });
    const out = first.content[0]!.text;
    expect(out).toContain("running for 1m00s");
    expect(out).toContain("--- log tail (last 20 lines");
    expect(out).toContain("hello");
    expect(first.details).toMatchObject({ tailBytes: 6, tailFromOffset: 0 });

    // No cursor was advanced, so the same content is still there next time,
    // and the whole log remains readable from byte 0.
    manager.setLog("b_BBBB2222", "hello\nworld\n");
    const second = await run(manager, { action: "status", job_id: "b_BBBB2222" });
    expect(second.content[0]!.text).toContain("hello");
    expect(second.content[0]!.text).toContain("world");
    expect(manager.get("b_BBBB2222")!.readCursor).toBe(0);
  });

  it("keeps only the last STATUS_TAIL_LINES lines", async () => {
    const manager = fakeManager();
    const log = `${Array.from({ length: 60 }, (_, i) => `line ${i}`).join("\n")}\n`;
    manager.put(makeRecord({ jobId: "b_BBBB2222", logBytes: log.length }), log);
    const out = (await run(manager, { action: "status", job_id: "b_BBBB2222" })).content[0]!.text;
    expect(out).toContain("line 59");
    expect(out).not.toContain("line 39");
    expect(out.split("\n").filter((line) => line.startsWith("line ")).length).toBe(STATUS_TAIL_LINES);
  });

  it("says so when the log is still empty", async () => {
    const manager = fakeManager();
    manager.put(makeRecord({ jobId: "b_BBBB2222" }), "");
    const out = (await run(manager, { action: "status", job_id: "b_BBBB2222" })).content[0]!.text;
    expect(out).toContain("(the log is empty so far)");
    expect(out).toContain("Full log: /tmp/b_BBBB2222.log");
  });

  it("surfaces the terminal footer the manager wrote into the log", async () => {
    const manager = fakeManager();
    const log = "boom\n[pi-subagent] job b_CCCC3333 failed (exit 1) after 2m30s\n";
    manager.put(
      makeRecord({ jobId: "b_CCCC3333", status: "failed", exitCode: 1, endedAt: NOW, logBytes: log.length }),
      log,
    );
    const out = (await run(manager, { action: "status", job_id: "b_CCCC3333" })).content[0]!.text;
    expect(out).toContain("failed (exit 1) after 1m00s");
    expect(out).toContain("[pi-subagent] job b_CCCC3333 failed (exit 1) after 2m30s");
  });

  it("flags a capped log", async () => {
    const manager = fakeManager();
    manager.put(
      makeRecord({ jobId: "b_CCCC3333", status: "killed", endedAt: NOW, outputTruncated: true, logBytes: 8 }),
      "partial\n",
    );
    const out = (await run(manager, { action: "status", job_id: "b_CCCC3333" })).content[0]!.text;
    expect(out).toContain("(the job's log hit its size cap; some output was dropped)");
  });

  it("reads at most STATUS_TAIL_BYTES from the end and clips with truncateTail", async () => {
    const manager = fakeManager();
    const huge = `${Array.from({ length: 5000 }, (_, i) => `line ${i}`).join("\n")}\n`;
    manager.put(makeRecord({ jobId: "b_DDDD4444", logBytes: huge.length }), huge);
    const response = await run(manager, { action: "status", job_id: "b_DDDD4444" });
    const out = response.content[0]!.text;
    expect(out.length).toBeLessThan(huge.length);
    expect(out).toContain("line 4999");
    expect(out).not.toContain("line 0\n");
    expect(response.details).toMatchObject({ tailBytes: STATUS_TAIL_BYTES });
    // Two passes: the record's byte counter can lag behind the real file.
    expect(manager.calls.filter((call) => call.startsWith("readOutput:b_DDDD4444")).length).toBeGreaterThanOrEqual(1);
  });

  it("degrades to a plain summary when the log cannot be read", async () => {
    const manager = fakeManager();
    manager.put(makeRecord({ jobId: "b_DDDD4444", status: "completed", exitCode: 0, endedAt: NOW }));
    manager.failReads = true;
    const out = (await run(manager, { action: "status", job_id: "b_DDDD4444" })).content[0]!.text;
    expect(out).toContain("completed (exit 0)");
    expect(out).toContain("Full log: /tmp/b_DDDD4444.log");
  });

  it("no longer accepts an offset parameter", () => {
    const properties = (BashJobToolParams as { properties: Record<string, unknown> }).properties;
    expect(Object.keys(properties).sort()).toEqual(["action", "job_id", "wait_ms"]);
    expect(properties.offset).toBeUndefined();
    const actions = (
      BashJobToolParams as { properties: { action: { anyOf: { const: string }[] } } }
    ).properties.action.anyOf.map((entry) => entry.const);
    expect(actions).toEqual(["status", "wait", "kill", "list"]);
  });
});

describe("bash_job — T13 bounded wait", () => {
  it("returns the current status on timeout instead of throwing", async () => {
    const manager = fakeManager();
    manager.put(makeRecord({ jobId: "b_EEEE5555", pid: 31337 }));
    const pending = run(manager, { action: "wait", job_id: "b_EEEE5555", wait_ms: 5 });
    // The manager's waitExit owns the deadline; simulate it firing with the
    // still-running record (the real one does exactly this — Z1).
    await waitForCall(manager, "waitExit:b_EEEE5555:5");
    manager.settleWait("b_EEEE5555");
    const response = await pending;
    expect(response.content[0]!.text).toMatch(/running for/);
    expect(response.content[0]!.text).toContain("the job was not stopped");
    expect(response.details).toMatchObject({ finished: false, waitedMs: 5 });
  });

  it("defaults to 30s and caps the wait at 120s", async () => {
    const manager = fakeManager({ waitResolvesImmediately: true });
    manager.put(makeRecord({ jobId: "b_EEEE5555" }));
    await run(manager, { action: "wait", job_id: "b_EEEE5555" });
    await run(manager, { action: "wait", job_id: "b_EEEE5555", wait_ms: 999_999 });
    await run(manager, { action: "wait", job_id: "b_EEEE5555", wait_ms: -5 });
    expect(manager.calls).toContain(`waitExit:b_EEEE5555:${DEFAULT_WAIT_MS}`);
    expect(manager.calls).toContain(`waitExit:b_EEEE5555:${MAX_WAIT_MS}`);
    expect(manager.calls).toContain("waitExit:b_EEEE5555:0");
  });

  it("returns immediately for an already terminal job, without waiting", async () => {
    const manager = fakeManager();
    manager.put(
      makeRecord({
        jobId: "b_FFFF6666",
        status: "completed",
        exitCode: 0,
        endedAt: NOW,
        finalText: "ok\n\nCommand exited with code 0",
      }),
    );
    const response = await run(manager, { action: "wait", job_id: "b_FFFF6666" });
    expect(manager.calls.some((call) => call.startsWith("waitExit:"))).toBe(false);
    expect(response.content[0]!.text).toContain("completed (exit 0)");
    expect(response.content[0]!.text).toContain("Command exited with code 0");
    expect(response.details).toMatchObject({ finished: true });
  });
});

describe("bash_job — T14 kill", () => {
  it("kills a running job and keeps the log readable", async () => {
    const manager = fakeManager();
    manager.put(makeRecord({ jobId: "b_GGGG7777", pid: 999 }));
    const response = await run(manager, { action: "kill", job_id: "b_GGGG7777" });
    expect(response.content[0]!.text).toContain("signalled");
    expect(response.details).toMatchObject({ killed: true, status: "killed", outcome: "signalled" });
  });

  it("is idempotent: a finished job reports already-finished instead of failing", async () => {
    const manager = fakeManager();
    manager.put(makeRecord({ jobId: "b_GGGG7777", status: "completed", exitCode: 0, endedAt: NOW }));
    const response = await run(manager, { action: "kill", job_id: "b_GGGG7777" });
    expect(response.content[0]!.text).toContain("has already finished (completed (exit 0)); nothing to kill");
    expect(response.details).toMatchObject({ alreadyTerminal: true, killed: false });
  });

  it("refuses an orphaned job with a reason, both when refused and when already marked", async () => {
    const manager = fakeManager();
    manager.put(makeRecord({ jobId: "b_HHHH8888", pid: -1 }));
    await expect(run(manager, { action: "kill", job_id: "b_HHHH8888" })).rejects.toThrow(
      /cannot be safely killed.*pid ownership/,
    );
    // Second call: the record is now orphaned — still refused, with the same intent.
    await expect(run(manager, { action: "kill", job_id: "b_HHHH8888" })).rejects.toThrow(
      /left behind by an earlier pi process and cannot be safely killed/,
    );
  });
});

describe("bash_job — T15 list", () => {
  it("reports an empty table", async () => {
    const response = await run(fakeManager(), { action: "list" });
    expect(response.content[0]!.text).toBe("no bash jobs");
    expect(response.details).toMatchObject({ count: 0, jobs: [] });
  });

  it("lists one line per job with state, command preview and age", async () => {
    const manager = fakeManager();
    manager.put(makeRecord({ jobId: "b_AAAA1111", createdAt: NOW - 720_000, command: "npm run build:all" }));
    manager.put(
      makeRecord({
        jobId: "b_BBBB2222",
        createdAt: NOW - 120_000,
        command: "pytest -x",
        status: "completed",
        exitCode: 0,
        endedAt: NOW,
      }),
    );
    const response = await run(manager, { action: "list" });
    const lines = response.content[0]!.text.split("\n");
    expect(lines[0]).toBe("2 bash jobs:");
    expect(lines[1]).toBe("b_AAAA1111 · running · $ npm run build:all · 12m00s ago");
    expect(lines[2]).toBe("b_BBBB2222 · completed (exit 0) · $ pytest -x · 2m00s ago");
    expect(response.details).toMatchObject({ count: 2 });
  });
});

describe("bash_job — T16 job_id resolution and guards", () => {
  it("accepts an exact id and a unique prefix", async () => {
    const manager = fakeManager();
    manager.put(makeRecord({ jobId: "b_AAAA1111" }));
    manager.put(makeRecord({ jobId: "b_ZZZZ9999" }));
    await expect(run(manager, { action: "status", job_id: "b_AAAA1111" })).resolves.toBeDefined();
    const byPrefix = await run(manager, { action: "status", job_id: "b_Z" });
    expect(byPrefix.details).toMatchObject({ jobId: "b_ZZZZ9999" });
  });

  it("throws a candidate-listing error for an ambiguous or unknown handle", async () => {
    const manager = fakeManager();
    manager.put(makeRecord({ jobId: "b_AAAA1111" }));
    manager.put(makeRecord({ jobId: "b_AAAA2222" }));
    await expect(run(manager, { action: "status", job_id: "b_AAAA" })).rejects.toThrow(
      /ambiguous bash job target.*Candidates: \[b_AAAA1111, b_AAAA2222\]/,
    );
    await expect(run(manager, { action: "kill", job_id: "b_NOPE" })).rejects.toThrow(/bash job not found/);
  });

  it("requires job_id for every action except list", async () => {
    const manager = fakeManager();
    for (const action of ["status", "wait", "kill"] as const) {
      await expect(run(manager, { action })).rejects.toThrow(`bash_job(action: "${action}") requires job_id`);
      await expect(run(manager, { action, job_id: "   " })).rejects.toThrow("requires job_id");
    }
    await expect(run(manager, { action: "list" })).resolves.toBeDefined();
  });

  it("fails clearly when no session stack is active", async () => {
    await expect(run(undefined, { action: "list" })).rejects.toThrow("no active session yet");
  });

  it("renders a single-line call", () => {
    const tool = createBashJobTool({ manager: () => undefined });
    const rendered = tool.renderCall!({ action: "status", job_id: "b_AAAA1111" }, theme, renderContext) as {
      text: string;
    };
    expect(rendered.text).toBe("bash_job status b_AAAA1111");
    const list = tool.renderCall!({ action: "list" }, theme, renderContext) as { text: string };
    expect(list.text).toBe("bash_job list");
  });

  it("keeps model-facing strings free of internal jargon", () => {
    const tool = createBashJobTool({ manager: () => undefined });
    const strings = [tool.description, tool.promptSnippet ?? "", JSON.stringify(tool.parameters)];
    for (const value of strings) expect(value).not.toMatch(/[§]|architecture/);
    expect(tool.description).toContain("job_id");
    expect(tool.promptSnippet).toContain("unique prefix");
    // Change A: the model must be told the log is an ordinary file.
    expect(tool.description).toMatch(/plain file/);
    expect(tool.description).toMatch(/read tool|tail\/grep\/awk/);
  });
});

describe("bash_job — exported formatters", () => {
  it("prefers the inner tool's closing line over a synthesized one", () => {
    const record = makeRecord({
      jobId: "b_AAAA1111",
      status: "timed_out",
      endedAt: NOW,
      finalText: "output\n\nCommand timed out after 5 seconds",
    });
    expect(finalStatusLine(record)).toBe("Command timed out after 5 seconds");
    expect(finalStatusLine({ ...record, finalText: "just output" })).toBe(
      "Command timed out and its process tree was killed",
    );
  });

  it("clamps a negative elapsed time instead of rendering nonsense", () => {
    const record = makeRecord({ jobId: "b_AAAA1111", spawnedAt: NOW + 5_000 });
    expect(formatJobSummary(record, NOW)).toContain("running for 0ms");
  });
});
