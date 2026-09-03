import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  createBashJobManager,
  formatLogTruncationNotice,
  shouldNotifyJob,
  type BashJobManager,
  type BashJobManagerOptions,
} from "../../src/bash/manager.js";
import { createJobStore, type JobStore } from "../../src/bash/job-store.js";
import type {
  JobExit,
  KillJobTreeOptions,
  KillOutcome,
  PidIdentity,
  PidOwnership,
  ProcessPort,
  SpawnedJob,
} from "../../src/bash/process.js";
import {
  createJobRecord,
  formatJobLogFooter,
  transitionJob,
  type JobRecord,
  type JobStatus,
} from "../../src/bash/types.js";
import { FakeClock } from "../../src/core/clock.js";
import { handoffInProcess } from "../../src/bash/session-dirs.js";

/**
 * §3 manager suite. The process boundary is faked (`tests/bash/process.test.ts`
 * owns the real-spawn contract), the clock is fake, but the job store is the
 * real one over a `mkdtemp` directory — log tee, cursor persistence and
 * recovery are all filesystem behaviour and fakes would prove nothing.
 */

const HOST_PID = 4242;

class FakeProc {
  readonly stdout = new PassThrough();
  readonly stderr = new PassThrough();
  private settle!: (exit: JobExit) => void;
  readonly exitPromise = new Promise<JobExit>((resolve) => {
    this.settle = resolve;
  });
  constructor(
    readonly pid: number,
    readonly procStartTime: string | undefined,
  ) {}

  get spawned(): SpawnedJob {
    return {
      pid: this.pid,
      pgid: this.pid,
      stdout: this.stdout,
      stderr: this.stderr,
      exitPromise: this.exitPromise,
      ...(this.procStartTime !== undefined ? { procStartTime: this.procStartTime } : {}),
    };
  }

  exit(exit: Partial<JobExit> = {}): void {
    this.stdout.end();
    this.stderr.end();
    this.settle({ exitCode: 0, signal: null, ...exit });
  }
}

class FakePort implements ProcessPort {
  readonly procs: FakeProc[] = [];
  readonly spawns: { command: string; cwd: string; env?: NodeJS.ProcessEnv }[] = [];
  readonly killCalls: { pid: number; options?: KillJobTreeOptions }[] = [];
  killOutcome: KillOutcome = "terminated";
  spawnError: Error | undefined;
  procStartTime: string | undefined = "1000";
  nextPid = 5000;
  readonly ownership = new Map<number, PidOwnership>();
  readonly alivePids = new Set<number>();

  async spawnJob(command: string, cwd: string, env?: NodeJS.ProcessEnv): Promise<SpawnedJob> {
    this.spawns.push({ command, cwd, ...(env !== undefined ? { env } : {}) });
    if (this.spawnError) throw this.spawnError;
    const proc = new FakeProc(this.nextPid++, this.procStartTime);
    this.procs.push(proc);
    this.ownership.set(proc.pid, "alive");
    this.alivePids.add(proc.pid);
    return proc.spawned;
  }

  async killJobTree(pid: number, options?: KillJobTreeOptions): Promise<KillOutcome> {
    this.killCalls.push({ pid, ...(options !== undefined ? { options } : {}) });
    return this.killOutcome;
  }

  probePid(pid: number): boolean {
    return this.alivePids.has(pid);
  }

  readProcStartTime(): string | undefined {
    return this.procStartTime;
  }

  checkPidOwnership(identity: PidIdentity): PidOwnership {
    return identity.pid === undefined ? "dead" : (this.ownership.get(identity.pid) ?? "dead");
  }

  last(): FakeProc {
    const proc = this.procs[this.procs.length - 1];
    if (!proc) throw new Error("no fake process spawned");
    return proc;
  }
}

interface Harness {
  dir: string;
  store: JobStore;
  clock: FakeClock;
  port: FakePort;
  warnings: string[];
  notified: JobRecord[];
  notifyError: () => Error | undefined;
  setNotifyError: (error: Error | undefined) => void;
  manager: BashJobManager;
  /** Rebuild a manager over the same directory (the `/reload` scenario). */
  rebuild(overrides?: Partial<BashJobManagerOptions>): BashJobManager;
}

const managers: BashJobManager[] = [];

/** Drain the microtask + immediate queues so stream/fs callbacks land. */
async function settle(times = 25): Promise<void> {
  for (let i = 0; i < times; i++) await new Promise((resolve) => setImmediate(resolve));
}

/**
 * `pushWrite` chains log writes asynchronously, so draining the event loop a
 * fixed number of times does *not* guarantee the bytes reached the file — under
 * full-suite CPU contention a pending chunk can still be in flight (observed as
 * a ~1-in-5 flake on the log-cap assertion). `readOutput` awaits that chain by
 * contract, so it is the deterministic way to sync before reading the log file
 * directly.
 */
async function flushLog(manager: BashJobManager, jobId: string): Promise<void> {
  await manager.readOutput(jobId, { offset: 0, advanceCursor: false, maxBytes: 1 });
}

/**
 * The notification poll is fire-and-forget (`void tick()`) and each step is a
 * real filesystem round-trip, so poll-driven assertions wait for the observable
 * effect rather than for a fixed number of event-loop turns.
 */
async function waitFor(predicate: () => boolean, label: string): Promise<void> {
  for (let i = 0; i < 500; i++) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 1));
  }
  throw new Error(`timed out waiting for ${label}`);
}

async function harness(
  overrides: Partial<BashJobManagerOptions> = {},
  options: { retentionMs?: number } = {},
): Promise<Harness> {
  const root = await mkdtemp(join(tmpdir(), "pi-subagent-bash-manager-"));
  const dir = join(root, "bash-jobs");
  const clock = new FakeClock(1_000);
  const port = new FakePort();
  const warnings: string[] = [];
  const notified: JobRecord[] = [];
  let notifyError: Error | undefined;
  const store = createJobStore({
    dir,
    retentionMs: options.retentionMs ?? 86_400_000,
    clock,
    warn: (m) => warnings.push(m),
  });
  const build = (extra: Partial<BashJobManagerOptions> = {}): BashJobManager => {
    const manager = createBashJobManager({
      store,
      processPort: port,
      clock,
      sessionId: "s1",
      hostPid: HOST_PID,
      warn: (m) => warnings.push(m),
      notify: (record) => {
        if (notifyError) throw notifyError;
        notified.push(record);
      },
      ...overrides,
      ...extra,
    });
    managers.push(manager);
    return manager;
  };
  return {
    dir,
    store,
    clock,
    port,
    warnings,
    notified,
    notifyError: () => notifyError,
    setNotifyError: (error) => {
      notifyError = error;
    },
    manager: build(),
    rebuild: build,
  };
}

afterEach(() => {
  for (const manager of managers.splice(0)) manager.dispose();
});

/** Write a record straight to disk, bypassing the manager (recovery fixtures). */
async function seed(
  store: JobStore,
  jobId: string,
  patch: Partial<JobRecord> & { status?: JobStatus } = {},
): Promise<JobRecord> {
  const base = createJobRecord({
    jobId,
    command: "sleep 600",
    cwd: "/repo",
    sessionId: "s0",
    hostPid: HOST_PID,
    logPath: store.logPath(jobId),
    createdAt: 500,
  });
  const record = { ...base, ...patch } as JobRecord;
  await store.save(record);
  return record;
}

describe("bash job manager: create and terminal settlement", () => {
  it("spawns, tees both pipes into the log, relays onData and persists the running record", async () => {
    const h = await harness();
    const relayed: string[] = [];
    const job = await h.manager.create({
      command: "npm test",
      cwd: "/repo",
      env: { PI_X: "1" },
      onData: (chunk) => relayed.push(chunk),
    });

    expect(h.port.spawns).toEqual([{ command: "npm test", cwd: "/repo", env: { PI_X: "1" } }]);
    expect(job.jobId).toMatch(/^b_[0-9A-HJKMNP-TV-Z]{8}$/);
    expect(job.record.status).toBe("running");
    expect(job.record.pid).toBe(job.pid);
    expect(job.record.pgid).toBe(job.pgid);
    expect(job.record.procStartTime).toBe("1000");
    expect(job.record.spawnedAt).toBe(1_000);

    const proc = h.port.last();
    proc.stdout.write("out\n");
    proc.stderr.write("err\n");
    await settle();
    await flushLog(h.manager, job.jobId);

    expect(relayed).toEqual(["out\n", "err\n"]);
    expect(await readFile(job.logPath, "utf8")).toBe("out\nerr\n");

    const stored = await h.store.load(job.jobId);
    expect(stored?.status).toBe("running");
    expect(stored?.pid).toBe(job.pid);
  });

  it("settles completed / failed / killed / timed_out and persists the terminal record", async () => {
    const cases: { exit: Partial<JobExit>; note?: "killed" | "timed_out"; status: JobStatus; code: number | null }[] = [
      { exit: { exitCode: 0 }, status: "completed", code: 0 },
      { exit: { exitCode: 3 }, status: "failed", code: 3 },
      { exit: { exitCode: null, signal: "SIGTERM" }, status: "killed", code: null },
      { exit: { exitCode: null, signal: "SIGTERM" }, note: "timed_out", status: "timed_out", code: null },
    ];
    for (const testCase of cases) {
      const h = await harness();
      const job = await h.manager.create({ command: "cmd", cwd: "/repo" });
      if (testCase.note) h.manager.noteTermination(job.jobId, testCase.note);
      h.clock.advance(5_000);
      h.port.last().exit(testCase.exit);

      const final = await job.exit;
      expect(final.status).toBe(testCase.status);
      expect(final.exitCode).toBe(testCase.code);
      expect(final.endedAt).toBe(6_000);
      expect((await h.store.load(job.jobId))?.status).toBe(testCase.status);
      expect(h.manager.get(job.jobId)?.status).toBe(testCase.status);
    }
  });

  it("records a post-spawn error as finalText and never rejects the exit promise", async () => {
    const h = await harness();
    const job = await h.manager.create({ command: "cmd", cwd: "/repo" });
    h.port.last().exit({ exitCode: null, signal: null, error: new Error("pipe blew up") });
    const final = await job.exit;
    expect(final.status).toBe("failed");
    expect(final.finalText).toBe("pipe blew up");
  });

  it("maps a spawn failure to staged -> failed, persists it and rethrows", async () => {
    const h = await harness();
    h.port.spawnError = new Error("spawn bash ENOENT");
    await expect(h.manager.create({ command: "cmd", cwd: "/nope" })).rejects.toThrow(/ENOENT/);

    const records = await h.store.loadAll();
    expect(records).toHaveLength(1);
    expect(records[0]?.status).toBe("failed");
    expect(records[0]?.finalText).toContain("ENOENT");
    // A foreground spawn failure is reported through the tool call itself.
    expect(shouldNotifyJob(records[0] as JobRecord)).toBe(false);
  });

  it("accepts the inner tool's final text before and after settlement", async () => {
    const h = await harness();
    const job = await h.manager.create({ command: "cmd", cwd: "/repo" });
    h.port.last().exit({ exitCode: 1 });
    await job.exit;

    const updated = await h.manager.setFinalText(job.jobId, "boom\n\nCommand exited with code 1");
    expect(updated?.finalText).toBe("boom\n\nCommand exited with code 1");
    expect((await h.store.load(job.jobId))?.finalText).toContain("Command exited with code 1");
  });
});

describe("bash job manager: log cap (§3.4)", () => {
  it("stops writing past maxLogBytes, appends the marker once and persists outputTruncated", async () => {
    const h = await harness({ maxLogBytes: 10 });
    const job = await h.manager.create({ command: "yes", cwd: "/repo" });
    const proc = h.port.last();
    proc.stdout.write("0123456");
    proc.stdout.write("789abcdef");
    proc.stdout.write("ignored entirely");
    await settle();
    await flushLog(h.manager, job.jobId);

    const log = await readFile(job.logPath, "utf8");
    expect(log).toBe(`0123456789${formatLogTruncationNotice(10)}`);
    expect(h.manager.get(job.jobId)?.outputTruncated).toBe(true);
    expect((await h.store.load(job.jobId))?.outputTruncated).toBe(true);

    proc.exit({ exitCode: 0 });
    const final = await job.exit;
    expect(final.outputTruncated).toBe(true);
    // Change B: the terminal footer is appended even though the cap was hit —
    // the conclusion of a log must never be swallowed by a capacity policy, so
    // the file is allowed to end up slightly over maxLogBytes.
    const capped = await readFile(job.logPath, "utf8");
    expect(capped.startsWith(log)).toBe(true);
    expect(capped.trimEnd().endsWith(`job ${job.jobId} completed (exit 0) after 0ms`)).toBe(true);
    expect(capped.length).toBeGreaterThan(10);
    expect(final.logBytes).toBe(capped.length);
    // The cap protects the disk; it is never a reason to kill the process.
    expect(h.port.killCalls).toEqual([]);
  });
});

describe("bash job manager: readOutput cursor (§4.3)", () => {
  it("reads incrementally, advances the persisted cursor and honours explicit offsets", async () => {
    const h = await harness();
    const job = await h.manager.create({ command: "cmd", cwd: "/repo" });
    const proc = h.port.last();
    proc.stdout.write("hello ");
    await settle();

    const first = await h.manager.readOutput(job.jobId);
    expect(first.content).toBe("hello ");
    expect(first.startOffset).toBe(0);
    expect(first.nextOffset).toBe(6);
    expect(first.state).toBe("running");
    expect(first.logTruncated).toBe(false);
    expect((await h.store.load(job.jobId))?.readCursor).toBe(6);

    // Nothing new: an empty increment, cursor unchanged.
    expect((await h.manager.readOutput(job.jobId)).content).toBe("");

    proc.stdout.write("world");
    await settle();
    const second = await h.manager.readOutput(job.jobId);
    expect(second.content).toBe("world");
    expect(second.nextOffset).toBe(11);

    // Explicit replay must not rewind the persisted cursor (store is monotonic).
    const replay = await h.manager.readOutput(job.jobId, { offset: 0 });
    expect(replay.content).toBe("hello world");
    expect((await h.store.load(job.jobId))?.readCursor).toBe(11);

    // maxBytes caps one increment; the rest stays reachable.
    const capped = await h.manager.readOutput(job.jobId, { offset: 0, maxBytes: 5, advanceCursor: false });
    expect(capped.content).toBe("hello");
    expect(capped.nextOffset).toBe(5);

    proc.exit({ exitCode: 2 });
    await job.exit;
    await h.manager.setFinalText(job.jobId, "Command exited with code 2");
    const closing = await h.manager.readOutput(job.jobId);
    expect(closing.state).toBe("failed");
    expect(closing.exitCode).toBe(2);
    expect(closing.finalText).toBe("Command exited with code 2");
    // 11 bytes of output + the terminal footer line (change B).
    const withFooter = await readFile(job.logPath, "utf8");
    expect(closing.logBytes).toBe(withFooter.length);
    expect(withFooter.startsWith("hello world\n[pi-subagent] job ")).toBe(true);
  });

  it("reports an empty read for a job whose log never materialised", async () => {
    const h = await harness();
    await seed(h.store, "b_MSSNG001", { status: "exited_unknown", endedAt: 900 });
    await h.manager.recover();
    const read = await h.manager.readOutput("b_MSSNG001");
    expect(read.content).toBe("");
    expect(read.logBytes).toBe(0);
    expect(read.state).toBe("exited_unknown");
  });

  it("throws for an unknown job id", async () => {
    const h = await harness();
    await expect(h.manager.readOutput("b_NPENPE99")).rejects.toThrow(/not found/);
  });
});

describe("bash job manager: resolution (§4.3)", () => {
  it("resolves exact ids and unique prefixes, and lists candidates otherwise", async () => {
    const h = await harness();
    await seed(h.store, "b_AAAA1111", { status: "completed", endedAt: 700, exitCode: 0, command: "npm test" });
    await seed(h.store, "b_AAAA2222", { status: "completed", endedAt: 700, exitCode: 0 });
    await seed(h.store, "b_BBBB3333", { status: "completed", endedAt: 700, exitCode: 0 });
    await h.manager.recover();

    expect(h.manager.resolve("b_AAAA1111")).toBe("b_AAAA1111");
    expect(h.manager.resolve("b_B")).toBe("b_BBBB3333");
    expect(() => h.manager.resolve("b_AAAA")).toThrow(/ambiguous bash job target: b_AAAA\. Candidates: \[/);
    expect(() => h.manager.resolve("b_AAAA")).toThrow(/b_AAAA1111 → \$ npm test \(completed, \dm ago\)/);
    expect(() => h.manager.resolve("b_ZZZZ")).toThrow(/bash job not found: b_ZZZZ\. Candidates: \[/);
    expect(() => h.manager.resolve("")).toThrow(/not found/);
  });

  it("reports 'none' as the candidate list when nothing is known", async () => {
    const h = await harness();
    expect(() => h.manager.resolve("b_X")).toThrow(/Candidates: \[none\]/);
  });
});

describe("bash job manager: background slots (§3.8)", () => {
  it("counts this host's running, backgrounded jobs only", async () => {
    const h = await harness({ maxBackgroundJobs: 2 });
    expect(h.manager.maxBackgroundJobs).toBe(2);
    const a = await h.manager.create({ command: "a", cwd: "/repo" });
    const b = await h.manager.create({ command: "b", cwd: "/repo" });

    // Foreground jobs do not occupy a slot.
    expect(h.manager.backgroundJobCount()).toBe(0);
    expect(h.manager.hasBackgroundCapacity()).toBe(true);

    await h.manager.markBackgrounded(a.jobId);
    expect(h.manager.backgroundJobCount()).toBe(1);
    await h.manager.markBackgrounded(b.jobId);
    expect(h.manager.backgroundJobCount()).toBe(2);
    expect(h.manager.hasBackgroundCapacity()).toBe(false);

    // markBackgrounded is idempotent (the timestamp is not rewritten).
    const at = h.manager.get(a.jobId)?.backgroundedAt;
    h.clock.advance(1_000);
    await h.manager.markBackgrounded(a.jobId);
    expect(h.manager.get(a.jobId)?.backgroundedAt).toBe(at);

    // A terminal job releases its slot.
    h.port.procs[0]?.exit({ exitCode: 0 });
    await a.exit;
    expect(h.manager.backgroundJobCount()).toBe(1);
    expect(h.manager.hasBackgroundCapacity()).toBe(true);
  });
});

describe("bash job manager: completion notifications (§5)", () => {
  it("notifies a backgrounded job exactly once and stamps notifiedAt", async () => {
    const h = await harness({ pollMs: 2_000 });
    const job = await h.manager.create({ command: "npm test", cwd: "/repo" });
    await h.manager.markBackgrounded(job.jobId);
    h.port.last().exit({ exitCode: 0 });
    await job.exit;
    expect(h.notified).toHaveLength(0);

    h.clock.advance(2_000);
    await waitFor(() => h.manager.get(job.jobId)?.notifiedAt !== undefined, "notifiedAt stamped");
    expect(h.notified.map((r) => r.jobId)).toEqual([job.jobId]);
    expect(h.manager.get(job.jobId)?.notifiedAt).toBe(3_000);
    expect((await h.store.load(job.jobId))?.notifiedAt).toBe(3_000);

    // Further ticks are silent, and the poll stops once there is no work.
    h.clock.advance(10_000);
    await settle();
    expect(h.notified).toHaveLength(1);
    expect(h.clock.pendingTimers).toBe(0);
  });

  it("never notifies a job that was not backgrounded", async () => {
    const h = await harness();
    const job = await h.manager.create({ command: "echo hi", cwd: "/repo" });
    h.port.last().exit({ exitCode: 0 });
    await job.exit;
    h.clock.advance(10_000);
    await settle();
    expect(h.notified).toEqual([]);
  });

  it("retries on the next tick when the sink throws, then stamps once", async () => {
    const h = await harness();
    const job = await h.manager.create({ command: "npm test", cwd: "/repo" });
    await h.manager.markBackgrounded(job.jobId);
    h.setNotifyError(new Error("sendMessage exploded"));
    h.port.last().exit({ exitCode: 1 });
    await job.exit;

    h.clock.advance(2_000);
    await settle();
    expect(h.notified).toEqual([]);
    expect(h.manager.get(job.jobId)?.notifiedAt).toBeUndefined();
    expect(h.warnings.some((w) => w.includes("notification failed"))).toBe(true);

    h.setNotifyError(undefined);
    h.clock.advance(2_000);
    await waitFor(() => h.notified.length > 0, "retried notification");
    expect(h.notified.map((r) => r.jobId)).toEqual([job.jobId]);

    h.clock.advance(10_000);
    await settle();
    expect(h.notified).toHaveLength(1);
  });

  it("re-sends nothing that a previous session already announced (disk idempotency)", async () => {
    const h = await harness();
    await seed(h.store, "b_DNE00001", {
      status: "completed",
      exitCode: 0,
      backgroundedAt: 600,
      endedAt: 700,
      notifiedAt: 800,
    });
    const summary = await h.manager.recover();
    expect(summary.pendingNotices).toEqual([]);
    h.clock.advance(10_000);
    await settle();
    expect(h.notified).toEqual([]);
  });
});

describe("bash job manager: kill (§3.3)", () => {
  it("runs the ladder for a local job and labels the exit killed", async () => {
    const h = await harness({ killGraceMs: 500 });
    const job = await h.manager.create({ command: "sleep 600", cwd: "/repo" });
    const result = await h.manager.kill(job.jobId);

    expect(result.outcome).toBe("terminated");
    expect(result.alreadyTerminal).toBe(false);
    expect(h.port.killCalls).toEqual([{ pid: job.pid, options: { graceMs: 500, expectedProcStartTime: "1000" } }]);

    h.port.last().exit({ exitCode: null, signal: "SIGTERM" });
    const final = await job.exit;
    expect(final.status).toBe("killed");
  });

  it("is idempotent: a terminal job reports already-terminal without signalling", async () => {
    const h = await harness();
    const job = await h.manager.create({ command: "cmd", cwd: "/repo" });
    h.port.last().exit({ exitCode: 0 });
    await job.exit;

    const result = await h.manager.kill(job.jobId);
    expect(result).toMatchObject({ outcome: "already-terminal", alreadyTerminal: true });
    expect(result.record.status).toBe("completed");
    expect(h.port.killCalls).toEqual([]);
  });

  it("refuses to kill an adopted job with unverifiable ownership and marks it orphaned", async () => {
    const h = await harness();
    await seed(h.store, "b_NSAFE001", { status: "running", pid: 9001, spawnedAt: 600, hostPid: HOST_PID });
    h.port.ownership.set(9001, "alive");
    await h.manager.recover();
    // Identity became unverifiable between adoption and the kill request.
    h.port.ownership.set(9001, "unsafe");

    const result = await h.manager.kill("b_NSAFE001");
    expect(result.outcome).toBe("refused");
    expect(result.reason).toMatch(/cannot be safely killed/);
    expect(result.record.status).toBe("orphaned");
    expect(h.port.killCalls).toEqual([]);
    // Orphans are displayed, never announced (§3.6).
    expect(shouldNotifyJob(result.record)).toBe(false);
  });

  it("refuses when the ladder itself refuses (pid reuse guard) and does not lose the record", async () => {
    const h = await harness();
    await seed(h.store, "b_RCYC0001", {
      status: "running",
      pid: 9002,
      spawnedAt: 600,
      procStartTime: "77",
      hostPid: HOST_PID,
    });
    h.port.ownership.set(9002, "alive");
    h.port.killOutcome = "refused";
    await h.manager.recover();

    const result = await h.manager.kill("b_RCYC0001");
    expect(result.outcome).toBe("refused");
    expect(result.record.status).toBe("orphaned");
    expect((await h.store.load("b_RCYC0001"))?.status).toBe("orphaned");
  });

  it("kills an adopted live job and settles it as killed", async () => {
    const h = await harness();
    await seed(h.store, "b_ADPT0001", { status: "running", pid: 9003, spawnedAt: 600, backgroundedAt: 650 });
    h.port.ownership.set(9003, "alive");
    h.port.alivePids.add(9003);
    h.port.killOutcome = "killed";
    await h.manager.recover();

    const result = await h.manager.kill("b_ADPT0001");
    expect(result.outcome).toBe("killed");
    expect(result.record.status).toBe("killed");
    expect((await h.store.load("b_ADPT0001"))?.status).toBe("killed");
  });

  it("marks an adopted job whose pid is already gone as exited_unknown", async () => {
    const h = await harness();
    await seed(h.store, "b_GNE00001", { status: "running", pid: 9004, spawnedAt: 600 });
    h.port.ownership.set(9004, "alive");
    await h.manager.recover();
    // The process died between recovery and the kill request.
    h.port.ownership.set(9004, "dead");

    const result = await h.manager.kill("b_GNE00001");
    expect(result.outcome).toBe("already-dead");
    expect(result.record.status).toBe("exited_unknown");
    expect(h.port.killCalls).toEqual([]);
  });

  it("throws for an unknown job id", async () => {
    const h = await harness();
    await expect(h.manager.kill("b_NPENPE99")).rejects.toThrow(/not found/);
  });
});

describe("bash job manager: waitExit", () => {
  it("resolves when the job settles", async () => {
    const h = await harness();
    const job = await h.manager.create({ command: "cmd", cwd: "/repo" });
    const waiting = h.manager.waitExit(job.jobId, 60_000);
    h.port.last().exit({ exitCode: 0 });
    await job.exit;
    expect((await waiting)?.status).toBe("completed");
    // The waiter's own timer is cleared eagerly; the notification poll retires
    // itself once there is nothing left to do — including the pending discard
    // of this foreground job's record (default 5s grace).
    h.clock.advance(2_000);
    await settle();
    expect(h.clock.pendingTimers).toBe(1);
    h.clock.advance(5_000);
    await waitFor(() => h.manager.get(job.jobId) === undefined, "record discarded");
    expect(h.clock.pendingTimers).toBe(0);
  });

  it("returns the current record on timeout instead of failing (Z1)", async () => {
    const h = await harness();
    const job = await h.manager.create({ command: "cmd", cwd: "/repo" });
    const waiting = h.manager.waitExit(job.jobId, 30_000);
    h.clock.advance(30_000);
    const record = await waiting;
    expect(record?.status).toBe("running");
  });

  it("resolves immediately for an already terminal job and undefined for an unknown one", async () => {
    const h = await harness();
    const job = await h.manager.create({ command: "cmd", cwd: "/repo" });
    h.port.last().exit({ exitCode: 0 });
    await job.exit;
    expect((await h.manager.waitExit(job.jobId, 1_000))?.status).toBe("completed");
    expect(await h.manager.waitExit("b_NPENPE99", 1_000)).toBeUndefined();
  });

  it("releases pending waiters on dispose", async () => {
    const h = await harness();
    const job = await h.manager.create({ command: "cmd", cwd: "/repo" });
    const waiting = h.manager.waitExit(job.jobId, 60_000);
    h.manager.dispose();
    expect((await waiting)?.status).toBe("running");
    expect(h.clock.pendingTimers).toBe(0);
  });
});

describe("bash job manager: handoff ownership (§3.6)", () => {
  it("exports only backgrounded local jobs", async () => {
    const h = await harness();
    const foreground = await h.manager.create({ command: "foreground", cwd: "/repo" });
    expect(h.manager.exportLocalJobs()).toEqual([]);
    await h.manager.markBackgrounded(foreground.jobId);
    expect(h.manager.exportLocalJobs().map((handoff) => handoff.jobId)).toEqual([foreground.jobId]);
  });

  it("transfers ownership through A to B to C and settles exactly once", async () => {
    const h = await harness();
    const job = await h.manager.create({ command: "sleep 1", cwd: "/repo" });
    await h.manager.markBackgrounded(job.jobId);
    const first = h.manager.exportLocalJobs();
    const b = h.rebuild();
    b.adoptLocalJobs(first);
    const second = b.exportLocalJobs();
    const c = h.rebuild();
    c.adoptLocalJobs(second);

    h.port.last().exit({ exitCode: 7 });
    await waitFor(() => c.get(job.jobId)?.status === "failed", "C finalization");
    const stored = await h.store.load(job.jobId);
    expect(stored?.status).toBe("failed");
    expect(stored?.exitCode).toBe(7);
    const log = await readFile(job.logPath, "utf8");
    expect((log.match(/\[pi-subagent\] job .* failed/g) ?? []).length).toBe(1);
  });

  it("updates the in-memory log path before cross-directory adoption", async () => {
    const h = await harness();
    const job = await h.manager.create({ command: "path", cwd: "/repo" });
    await h.manager.markBackgrounded(job.jobId);
    const nextDir = join(h.dir, "next");
    const nextStore = createJobStore({ dir: nextDir, retentionMs: 86_400_000, clock: h.clock });
    const next = h.rebuild({ store: nextStore, sessionId: "s2" });
    await handoffInProcess(h.manager, next, {
      rootDir: h.dir,
      sessionId: "s2",
      retentionMs: 86_400_000,
      clock: h.clock,
      processPort: h.port,
    });
    expect(next.get(job.jobId)?.logPath).toBe(join(nextDir, `${job.jobId}.log`));
    h.port.last().stdout.write("visible\n");
    await settle();
    expect((await next.readOutput(job.jobId, { offset: 0, advanceCursor: false })).content).toContain("visible");
  });

  it("keeps the terminal result when exit races with export", async () => {
    const h = await harness();
    const job = await h.manager.create({ command: "race", cwd: "/repo" });
    await h.manager.markBackgrounded(job.jobId);
    h.port.last().exit({ exitCode: 7 });
    const handoff = h.manager.exportLocalJobs();
    const next = h.rebuild();
    next.adoptLocalJobs(handoff);
    await waitFor(() => next.get(job.jobId)?.status === "failed", "raced finalization");
    expect((await h.store.load(job.jobId))?.exitCode).toBe(7);
  });
});

describe("bash job manager: notification convergence", () => {
  it("marks memory notified when the record is externally removed", async () => {
    const h = await harness({ pollMs: 1_000 });
    const job = await h.manager.create({ command: "notify", cwd: "/repo" });
    await h.manager.markBackgrounded(job.jobId);
    h.port.last().exit({ exitCode: 0 });
    await job.exit;
    await h.store.remove(job.jobId);
    h.clock.advance(1_000);
    await waitFor(() => h.notified.length === 1, "notification after external removal");
    h.clock.advance(5_000);
    await settle();
    expect(h.notified).toHaveLength(1);
    expect(h.manager.get(job.jobId)?.notifiedAt).toBeTypeOf("number");
  });
});

describe("bash job manager: dispose (§3.6 reload safety)", () => {
  it("clears timers, kills nothing and stops notifying while still persisting terminal state", async () => {
    const h = await harness();
    const job = await h.manager.create({ command: "npm test", cwd: "/repo" });
    await h.manager.markBackgrounded(job.jobId);
    h.manager.dispose();

    expect(h.clock.pendingTimers).toBe(0);
    expect(h.port.killCalls).toEqual([]);

    // The old manager's in-flight exit callback must only write to disk.
    h.port.last().exit({ exitCode: 0 });
    const final = await job.exit;
    expect(final.status).toBe("completed");
    expect((await h.store.load(job.jobId))?.status).toBe("completed");
    h.clock.advance(60_000);
    await settle();
    expect(h.notified).toEqual([]);

    // ...and the next stack picks the notice up through the single channel.
    const next = h.rebuild();
    h.port.ownership.clear();
    const summary = await next.recover();
    expect(summary.pendingNotices).toEqual([job.jobId]);
    h.clock.advance(2_000);
    await waitFor(() => h.notified.length > 0, "notice picked up by the next stack");
    expect(h.notified.map((r) => r.jobId)).toEqual([job.jobId]);
  });
});

describe("bash job manager: recover (§3.6)", () => {
  it("adopts a verifiable running job, polls it and announces its exit", async () => {
    const h = await harness();
    await seed(h.store, "b_AVE00001", { status: "running", pid: 9101, spawnedAt: 600, command: "npm run build" });
    h.port.ownership.set(9101, "alive");

    const summary = await h.manager.recover();
    expect(summary).toMatchObject({ adopted: ["b_AVE00001"], exitedUnknown: [], orphaned: [], foreign: [] });
    // Adoption makes the job ownerless → notification eligible.
    expect(h.manager.get("b_AVE00001")?.backgroundedAt).toBe(1_000);

    // Still alive: the poll leaves it running.
    h.clock.advance(2_000);
    await settle();
    expect(h.manager.get("b_AVE00001")?.status).toBe("running");
    expect(h.notified).toEqual([]);

    h.port.ownership.set(9101, "dead");
    h.clock.advance(2_000);
    await waitFor(() => h.manager.get("b_AVE00001")?.status === "exited_unknown", "adopted job settled");
    expect((await h.store.load("b_AVE00001"))?.status).toBe("exited_unknown");

    h.clock.advance(2_000);
    await waitFor(() => h.notified.length > 0, "adopted job notified");
    expect(h.notified.map((r) => r.jobId)).toEqual(["b_AVE00001"]);
  });

  it("marks a dead pid exited_unknown and an unverifiable one orphaned", async () => {
    const h = await harness();
    await seed(h.store, "b_DEAD0001", { status: "running", pid: 9102, spawnedAt: 600, backgroundedAt: 650 });
    await seed(h.store, "b_NSRE0001", { status: "running", pid: 9103, spawnedAt: 600, backgroundedAt: 650 });
    h.port.ownership.set(9102, "dead");
    h.port.ownership.set(9103, "unsafe");

    const summary = await h.manager.recover();
    expect(summary.exitedUnknown).toEqual(["b_DEAD0001"]);
    expect(summary.orphaned).toEqual(["b_NSRE0001"]);
    expect(summary.pendingNotices).toEqual(["b_DEAD0001"]);
    expect(h.port.killCalls).toEqual([]);

    h.clock.advance(2_000);
    await waitFor(() => h.notified.length > 0, "dead job notified");
    await settle();
    // The orphan is displayed but never announced.
    expect(h.notified.map((r) => r.jobId)).toEqual(["b_DEAD0001"]);
    expect(h.manager.get("b_NSRE0001")?.status).toBe("orphaned");
  });

  it("leaves jobs owned by another live pi process untouched", async () => {
    const h = await harness();
    await seed(h.store, "b_FRGN0001", { status: "running", pid: 9104, spawnedAt: 600, hostPid: 777 });
    h.port.alivePids.add(777);
    h.port.ownership.set(9104, "alive");

    const summary = await h.manager.recover();
    expect(summary.foreign).toEqual(["b_FRGN0001"]);
    expect(summary.adopted).toEqual([]);
    expect(h.manager.get("b_FRGN0001")?.status).toBe("running");
    expect(h.manager.get("b_FRGN0001")?.backgroundedAt).toBeUndefined();

    // The dead-host case is adoptable instead.
    await seed(h.store, "b_DEADHST1", { status: "running", pid: 9105, spawnedAt: 600, hostPid: 778 });
    h.port.ownership.set(9105, "alive");
    const next = await h.manager.recover();
    expect(next.adopted).toEqual(["b_DEADHST1"]);
  });

  it("fails a staged job whose spawn outcome was lost with the previous process", async () => {
    const h = await harness();
    await seed(h.store, "b_STAGED01", { status: "staged" });
    const summary = await h.manager.recover();
    expect(summary.lostStaged).toEqual(["b_STAGED01"]);
    const stored = await h.store.load("b_STAGED01");
    expect(stored?.status).toBe("failed");
    expect(stored?.finalText).toMatch(/spawn was confirmed/);
    expect(shouldNotifyJob(stored as JobRecord)).toBe(false);
  });

  it("never adjudicates a job it created itself (recover racing a fresh create)", async () => {
    const h = await harness();
    let release: () => void = () => {};
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const spawnJob = h.port.spawnJob.bind(h.port);
    h.port.spawnJob = async (command, cwd, env) => {
      await gate;
      return spawnJob(command, cwd, env);
    };

    const creating = h.manager.create({ command: "npm test", cwd: "/repo" });
    // The `staged` record is on disk while the spawn is still in flight —
    // exactly what a session_start `recover()` scan can observe.
    await settle();
    const jobId = h.manager.list()[0]!.jobId;
    expect((await h.store.load(jobId))?.status).toBe("staged");

    const summary = await h.manager.recover();
    expect(summary.lostStaged).toEqual([]);
    expect((await h.store.load(jobId))?.status).toBe("staged");

    release();
    const job = await creating;
    // The real transition still applies: a mislabelled `failed` here would
    // reject it and leave a live process with no persisted pid.
    expect(h.manager.get(job.jobId)?.status).toBe("running");
    expect((await h.store.load(job.jobId))?.pid).toBe(job.pid);
  });

  it("prunes expired terminal jobs and skips corrupt records", async () => {
    const h = await harness({}, { retentionMs: 1_000 });
    const old = await seed(h.store, "b_EXPRD001", { status: "completed", exitCode: 0, endedAt: -10_000 });
    await seed(h.store, "b_FRESH001", { status: "completed", exitCode: 0, endedAt: 900 });
    await writeFile(join(h.dir, "b_BRKEN001.json"), "{not json", "utf8");

    const summary = await h.manager.recover();
    expect(summary.pruned).toEqual([old.jobId]);
    expect(h.manager.list().map((r) => r.jobId)).toEqual(["b_FRESH001"]);
    expect(h.warnings.some((w) => w.includes("b_BRKEN001"))).toBe(true);
    // The fake clock sits far behind the corrupt file's real mtime, so its age
    // is not computable and it is (deliberately) kept rather than guessed at.
    expect(summary.prunedFiles).toEqual([]);
  });

  it("reports swept non-record files in prunedFiles", async () => {
    const h = await harness();
    // The sweep judges nameless litter by file mtime (real wall-clock time), so
    // this case needs a clock that can outrun it — hence a store of its own.
    const clock = new FakeClock(Date.now());
    const store = createJobStore({ dir: h.dir, retentionMs: 1_000, clock, warn: (m) => h.warnings.push(m) });
    const manager = h.rebuild({ store, clock });
    await mkdir(h.dir, { recursive: true });
    await writeFile(join(h.dir, "b_0RPHAN11.log"), "left behind", "utf8");
    clock.advance(60_000);

    const summary = await manager.recover();
    expect(summary.prunedFiles).toEqual(["b_0RPHAN11.log"]);
    expect(summary.pruned).toEqual([]);
  });

  it("is safe to run twice (terminal states are sinks)", async () => {
    const h = await harness();
    await seed(h.store, "b_DEAD0002", { status: "running", pid: 9106, spawnedAt: 600, backgroundedAt: 650 });
    h.port.ownership.set(9106, "dead");
    const first = await h.manager.recover();
    const second = await h.manager.recover();
    expect(first.exitedUnknown).toEqual(["b_DEAD0002"]);
    expect(second.exitedUnknown).toEqual([]);
    expect(second.pendingNotices).toEqual(["b_DEAD0002"]);
    expect(h.manager.get("b_DEAD0002")?.endedAt).toBe(1_000);
  });
});

describe("bash job manager: listing and lookups", () => {
  let h: Harness;
  beforeEach(async () => {
    h = await harness();
  });

  it("lists jobs oldest first and exposes memory/disk lookups", async () => {
    const a = await h.manager.create({ command: "a", cwd: "/repo" });
    h.clock.advance(10);
    const b = await h.manager.create({ command: "b", cwd: "/repo" });
    expect(h.manager.list().map((r) => r.jobId)).toEqual([a.jobId, b.jobId]);
    expect(h.manager.get(a.jobId)?.command).toBe("a");
    expect((await h.manager.load(b.jobId))?.command).toBe("b");
    expect(h.manager.get("b_NPENPE99")).toBeUndefined();
    expect(await h.manager.load("b_NPENPE99")).toBeUndefined();
  });

  it("keeps live byte counters visible while the record on disk stays throttled", async () => {
    const job = await h.manager.create({ command: "cmd", cwd: "/repo" });
    h.port.last().stdout.write("12345");
    await settle();
    expect(h.manager.get(job.jobId)?.logBytes).toBe(5);
    // A disk read must not rewind the in-memory counter.
    expect((await h.manager.load(job.jobId))?.logBytes).toBe(5);
    expect((await h.store.load(job.jobId))?.logBytes).toBe(0);
  });
});

describe("transition guards", () => {
  it("warns instead of throwing when a terminal record is re-settled", async () => {
    const h = await harness();
    const job = await h.manager.create({ command: "cmd", cwd: "/repo" });
    h.port.last().exit({ exitCode: 0 });
    await job.exit;

    // Simulate the /reload race: a stale closure tries to settle again.
    const stored = await h.store.load(job.jobId);
    expect(stored).toBeDefined();
    expect(transitionJob(stored as JobRecord, "killed", { at: 9_000 }).ok).toBe(false);
    await h.manager.kill(job.jobId);
    expect((await h.store.load(job.jobId))?.status).toBe("completed");
  });
});

describe("foreground record discard", () => {
  it("drops the record and log of a job that never reached the model", async () => {
    const h = await harness({ pollMs: 1_000, discardGraceMs: 5_000 });
    const job = await h.manager.create({ command: "echo hi", cwd: "/repo" });
    h.port.last().stdout.write("hi\n");
    h.port.last().exit({ exitCode: 0 });
    await job.exit;

    // Inside the grace the record is still fully readable.
    h.clock.advance(1_000);
    await settle();
    expect(h.manager.get(job.jobId)?.status).toBe("completed");
    expect((await h.manager.readOutput(job.jobId)).content).toContain("hi\n");

    h.clock.advance(5_000);
    await waitFor(() => h.manager.get(job.jobId) === undefined, "record discarded");
    expect(h.manager.list()).toHaveLength(0);
    expect(await h.store.load(job.jobId)).toBeUndefined();
    expect(
      await readFile(h.store.logPath(job.jobId), "utf8").then(
        () => true,
        () => false,
      ),
    ).toBe(false);
    // A foreground job is never announced, so nothing was lost by dropping it.
    expect(h.notified).toHaveLength(0);
    expect(h.clock.pendingTimers).toBe(0);
  });

  it("keeps a job backgrounded in the same tick as its exit (threshold race)", async () => {
    const h = await harness({ pollMs: 1_000, discardGraceMs: 0 });
    const job = await h.manager.create({ command: "sleep 300", cwd: "/repo" });
    h.port.last().exit({ exitCode: 0 });
    await job.exit;
    // The threshold fires just after the process settled: the record must
    // survive, because the tool already handed its job_id to the model.
    await h.manager.markBackgrounded(job.jobId);

    h.clock.advance(1_000);
    await waitFor(() => h.notified.length === 1, "notification delivered");
    expect(h.manager.get(job.jobId)?.status).toBe("completed");
    expect(await h.store.load(job.jobId)).toBeDefined();
  });

  it("discards foreground leftovers of a previous process on recover", async () => {
    const h = await harness({ pollMs: 1_000, discardGraceMs: 5_000 });
    const stale = createJobRecord({
      jobId: "b_STAX0001",
      command: "echo leftover",
      cwd: "/repo",
      sessionId: "s0",
      hostPid: HOST_PID,
      logPath: h.store.logPath("b_STAX0001"),
      createdAt: 100,
    });
    const settled = transitionJob(stale, "running", { at: 150, pid: 6_001, pgid: 6_001 });
    expect(settled.ok).toBe(true);
    if (!settled.ok) return;
    const done = transitionJob(settled.record, "completed", { at: 200, exitCode: 0 });
    expect(done.ok).toBe(true);
    if (!done.ok) return;
    await h.store.save(done.record);
    await writeFile(h.store.logPath("b_STAX0001"), "leftover\n");

    const next = h.rebuild();
    await next.recover();
    h.clock.advance(5_000);
    await waitFor(() => next.get("b_STAX0001") === undefined, "leftover discarded");
    expect(await h.store.load("b_STAX0001")).toBeUndefined();
    expect(h.notified).toHaveLength(0);
  });
});

/**
 * §15 change C — a session that never reloads must still clean up. The sweep
 * rides on `create()` behind a throttle: no new timer, no blocking the spawn.
 */
describe("bash job manager: in-session retention sweep (§15)", () => {
  /** Counts sweeps and lets a test make the sweep fail. */
  interface Counting {
    readonly store: JobStore;
    calls(): number;
    fail(error: Error): void;
  }
  function countingStore(store: JobStore): Counting {
    let calls = 0;
    let failure: Error | undefined;
    return {
      store: {
        ...store,
        pruneExpired: (pruneOptions) => {
          calls++;
          return failure ? Promise.reject(failure) : store.pruneExpired(pruneOptions);
        },
      },
      calls: () => calls,
      fail: (error) => {
        failure = error;
      },
    };
  }

  it("sweeps once per interval across back-to-back creates, then again after the interval", async () => {
    const h = await harness();
    const counting = countingStore(h.store);
    const manager = h.rebuild({ store: counting.store, sweepIntervalMs: 600_000 });

    await manager.create({ command: "a", cwd: "/repo" });
    await manager.create({ command: "b", cwd: "/repo" });
    await settle();
    expect(counting.calls()).toBe(1);

    // Still inside the window.
    h.clock.advance(599_000);
    await manager.create({ command: "c", cwd: "/repo" });
    await settle();
    expect(counting.calls()).toBe(1);

    h.clock.advance(1_000);
    await manager.create({ command: "d", cwd: "/repo" });
    await settle();
    expect(counting.calls()).toBe(2);
  });

  it("adds no timer of its own (the poll timer stays the only one)", async () => {
    const h = await harness();
    const counting = countingStore(h.store);
    const manager = h.rebuild({ store: counting.store, sweepIntervalMs: 1_000 });

    await manager.create({ command: "a", cwd: "/repo" });
    await settle();
    const armed = h.clock.pendingTimers;
    expect(armed).toBe(1); // the notification poll

    h.clock.advance(2_000);
    await manager.create({ command: "b", cwd: "/repo" });
    await settle();
    expect(counting.calls()).toBe(2);
    expect(h.clock.pendingTimers).toBe(armed);
  });

  it("never lets a failing sweep break create()", async () => {
    const h = await harness();
    const counting = countingStore(h.store);
    counting.fail(new Error("disk on fire"));
    const manager = h.rebuild({ store: counting.store });

    const job = await manager.create({ command: "npm test", cwd: "/repo" });
    await settle();
    expect(manager.get(job.jobId)?.status).toBe("running");
    expect(counting.calls()).toBe(1);
    expect(h.warnings.some((w) => w.includes("retention sweep failed") && w.includes("disk on fire"))).toBe(true);
  });

  it("treats a live job's log as tracked, never as an orphan", async () => {
    const h = await harness();
    const seen: (((jobId: string) => boolean) | undefined)[] = [];
    const store: JobStore = {
      ...h.store,
      pruneExpired: (pruneOptions) => {
        seen.push(pruneOptions?.isTracked);
        return h.store.pruneExpired(pruneOptions);
      },
    };
    const manager = h.rebuild({ store });
    const job = await manager.create({ command: "npm test", cwd: "/repo" });
    await settle();
    expect(seen).toHaveLength(1);
    expect(seen[0]?.(job.jobId)).toBe(true);
    expect(seen[0]?.("b_M1SS1NG1")).toBe(false);
  });
});

/**
 * Change B — the log is self-contained: its last line states the outcome, so
 * `tail -3 <log>` answers "how did this end?" without a tool call.
 */
describe("bash job manager: terminal log footer (change B)", () => {
  it("appends exactly one footer line, counted in logBytes, on a normal exit", async () => {
    const h = await harness();
    const job = await h.manager.create({ command: "echo hi", cwd: "/repo" });
    h.port.last().stdout.write("hi\n");
    await settle();
    h.clock.advance(2_000);
    h.port.last().exit({ exitCode: 0 });
    const final = await job.exit;

    const log = await readFile(job.logPath, "utf8");
    expect(log).toBe(
      `hi\n${formatJobLogFooter({ jobId: job.jobId, status: "completed", exitCode: 0, duration: "2s" })}\n`,
    );
    expect(final.logBytes).toBe(Buffer.byteLength(log, "utf8"));
    expect((await h.store.load(job.jobId))?.logBytes).toBe(final.logBytes);

    // Idempotent: a repeated terminal settlement must not write a second line.
    h.port.last().exit({ exitCode: 0 });
    await settle();
    expect(await readFile(job.logPath, "utf8")).toBe(log);
    expect((log.match(/\[pi-subagent\]/g) ?? []).length).toBe(1);
  });

  it("starts the footer on its own line when the output has no trailing newline", async () => {
    const h = await harness();
    const job = await h.manager.create({ command: "printf x", cwd: "/repo" });
    h.port.last().stdout.write("no-newline");
    await settle();
    h.port.last().exit({ exitCode: 1 });
    await job.exit;
    const lines = (await readFile(job.logPath, "utf8")).split("\n");
    expect(lines[0]).toBe("no-newline");
    expect(lines[1]).toBe(formatJobLogFooter({ jobId: job.jobId, status: "failed", exitCode: 1, duration: "0ms" }));
  });

  it.each([
    ["killed", { signal: "SIGTERM" as const, exitCode: null }, /killed after/],
    ["timed out", { signal: "SIGKILL" as const, exitCode: null }, /timed out after/],
  ])("writes no invented exit code for a %s job", async (label, exit, expected) => {
    const h = await harness();
    const job = await h.manager.create({ command: "sleep 300", cwd: "/repo" });
    h.manager.noteTermination(job.jobId, label === "killed" ? "killed" : "timed_out");
    h.port.last().exit(exit);
    await job.exit;
    const log = await readFile(job.logPath, "utf8");
    expect(log).toMatch(expected);
    expect(log).not.toMatch(/exit /);
  });

  it("is visible to readOutput, which sees exactly what the file holds", async () => {
    const h = await harness();
    const job = await h.manager.create({ command: "echo done", cwd: "/repo" });
    h.port.last().stdout.write("done\n");
    h.port.last().exit({ exitCode: 0 });
    await job.exit;
    const read = await h.manager.readOutput(job.jobId, { offset: 0, advanceCursor: false });
    expect(read.content).toBe(await readFile(job.logPath, "utf8"));
    expect(read.content.trimEnd().endsWith(`job ${job.jobId} completed (exit 0) after 0ms`)).toBe(true);
    expect(read.logBytes).toBe(Buffer.byteLength(read.content, "utf8"));
  });
});
