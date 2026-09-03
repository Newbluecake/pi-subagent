import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createBashToolDefinition } from "@earendil-works/pi-coding-agent";
import type { BashOperations, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { createBashJobManager, type BashJobManager } from "../../src/bash/manager.js";
import { createJobStore } from "../../src/bash/job-store.js";
import type {
  JobExit,
  KillJobTreeOptions,
  KillOutcome,
  PidIdentity,
  PidOwnership,
  ProcessPort,
  SpawnedJob,
} from "../../src/bash/process.js";
import { FakeClock } from "../../src/core/clock.js";
import { BashToolParams, createBashTool, type BashBackgroundDetails } from "../../src/tools/bash-tool.js";

/**
 * §10 T1-T9 for the bash override tool.
 *
 * The process boundary is faked (`tests/bash/process.test.ts` owns the real
 * spawn contract) but the job store, the log files and pi's *real* bash tool
 * definition are all genuine: T1's whole point is that the foreground path is
 * the built-in tool's own code, so proving it against a reimplementation would
 * prove nothing.
 */

const HUGE_THRESHOLD_MS = 10 * 60_000;

class FakeProc {
  readonly stdout = new PassThrough();
  readonly stderr = new PassThrough();
  private settleExit!: (exit: JobExit) => void;
  private settleDrain!: (result: { exit: JobExit; stop: "ended" | "idle" | "capped" | "error" }) => void;
  private lastExit: JobExit | undefined;
  readonly processExitPromise = new Promise<JobExit>((resolve) => {
    this.settleExit = resolve;
  });
  readonly drainedPromise = new Promise<{ exit: JobExit; stop: "ended" | "idle" | "capped" | "error" }>((resolve) => {
    this.settleDrain = resolve;
  });
  constructor(readonly pid: number) {}

  get spawned(): SpawnedJob {
    return {
      pid: this.pid,
      pgid: this.pid,
      stdout: this.stdout,
      stderr: this.stderr,
      processExitPromise: this.processExitPromise,
      drainedPromise: this.drainedPromise,
    };
  }

  write(text: string): void {
    this.stdout.write(Buffer.from(text, "utf8"));
  }

  exitOnly(exit: Partial<JobExit> = {}): void {
    if (this.lastExit) return;
    this.lastExit = { exitCode: 0, signal: null, ...exit };
    this.settleExit(this.lastExit);
  }

  drain(stop: "ended" | "idle" | "capped" | "error" = "ended"): void {
    if (!this.lastExit) this.exitOnly();
    this.stdout.end();
    this.stderr.end();
    this.settleDrain({ exit: this.lastExit!, stop });
  }

  exit(exit: Partial<JobExit> = {}): void {
    this.exitOnly(exit);
    this.drain();
  }
}

class FakePort implements ProcessPort {
  readonly procs: FakeProc[] = [];
  readonly spawns: { command: string; cwd: string; env?: NodeJS.ProcessEnv }[] = [];
  readonly killCalls: { pid: number; options?: KillJobTreeOptions }[] = [];
  nextPid = 7000;
  /** Runs right after a spawn resolves; drives the scripted output/exit. */
  script?: (proc: FakeProc) => void | Promise<void>;

  async spawnJob(command: string, cwd: string, env?: NodeJS.ProcessEnv): Promise<SpawnedJob> {
    this.spawns.push({ command, cwd, ...(env !== undefined ? { env } : {}) });
    const proc = new FakeProc(this.nextPid++);
    this.procs.push(proc);
    if (this.script) setImmediate(() => void this.script?.(proc));
    return proc.spawned;
  }

  async killJobTree(pid: number, options?: KillJobTreeOptions): Promise<KillOutcome> {
    this.killCalls.push({ pid, ...(options !== undefined ? { options } : {}) });
    // A real kill ends the process; the tee/exit path must run identically.
    this.procs.find((proc) => proc.pid === pid)?.exit({ exitCode: null, signal: "SIGTERM" });
    return "terminated";
  }

  probePid(): boolean {
    return true;
  }
  readProcStartTime(): string | undefined {
    return undefined;
  }
  checkPidOwnership(identity: PidIdentity): PidOwnership {
    return identity.pid === undefined ? "dead" : "alive";
  }

  last(): FakeProc {
    const proc = this.procs[this.procs.length - 1];
    if (!proc) throw new Error("no fake process spawned");
    return proc;
  }
}

interface Harness {
  dir: string;
  port: FakePort;
  manager: BashJobManager;
  warnings: string[];
  ctx: ExtensionContext;
}

const disposers: Array<() => void | Promise<void>> = [];

afterEach(async () => {
  vi.useRealTimers();
  for (const dispose of disposers.splice(0)) await dispose();
});

async function makeHarness(options: { maxBackgroundJobs?: number } = {}): Promise<Harness> {
  const dir = await mkdtemp(join(tmpdir(), "pi-bash-tool-"));
  const clock = new FakeClock(1_000);
  const store = createJobStore({ dir, retentionMs: 60_000, clock });
  const port = new FakePort();
  const warnings: string[] = [];
  const manager = createBashJobManager({
    store,
    processPort: port,
    clock,
    sessionId: "session-1",
    warn: (message) => warnings.push(message),
    ...(options.maxBackgroundJobs !== undefined ? { maxBackgroundJobs: options.maxBackgroundJobs } : {}),
  });
  disposers.push(() => {
    manager.dispose();
    return rm(dir, { recursive: true, force: true });
  });
  return { dir, port, manager, warnings, ctx: makeCtx(dir) };
}

function makeCtx(cwd: string): ExtensionContext {
  return {
    cwd,
    sessionManager: { getSessionId: () => "session-1", getSessionFile: () => undefined },
    model: { provider: "test", id: "test-model" },
    thinkingLevel: undefined,
  } as unknown as ExtensionContext;
}

/** Drain microtasks/immediates so stream + fs callbacks land. */
async function settle(times = 30): Promise<void> {
  for (let i = 0; i < times; i++) await new Promise((resolve) => setImmediate(resolve));
}

/**
 * Every step of the manager's create path is a real filesystem round-trip, so
 * assertions wait for the observable effect rather than a fixed number of
 * event-loop turns (and `setImmediate` is never faked here, so this works with
 * `vi.useFakeTimers` too).
 */
async function waitFor(predicate: () => boolean, label: string): Promise<void> {
  for (let i = 0; i < 5_000; i++) {
    if (predicate()) return;
    await new Promise((resolve) => setImmediate(resolve));
  }
  throw new Error(`timed out waiting for ${label}`);
}

function toolFor(harness: Harness, autoBackgroundMs: number) {
  return createBashTool({
    manager: () => harness.manager,
    autoBackgroundMs: () => autoBackgroundMs,
    warn: (message) => harness.warnings.push(message),
  });
}

// ── T1: golden equivalence with the built-in bash tool ─────────────────────

interface Scenario {
  name: string;
  chunks: string[];
  /** `undefined` for the abort/timeout paths (the process never exits cleanly). */
  exitCode?: number | null;
  kind?: "abort" | "timeout";
  timeout?: number;
}

const BIG_OUTPUT = `${Array.from({ length: 2100 }, (_, i) => `line ${i}`).join("\n")}\n`;

const SCENARIOS: Scenario[] = [
  { name: "success with output", chunks: ["hello\n", "world\n"], exitCode: 0 },
  { name: "no output", chunks: [], exitCode: 0 },
  { name: "non-zero exit", chunks: ["boom\n"], exitCode: 3 },
  { name: "signal death (exitCode null)", chunks: ["partial\n"], exitCode: null },
  { name: "truncated output", chunks: [BIG_OUTPUT], exitCode: 0 },
  { name: "abort", chunks: ["before abort\n"], kind: "abort" },
  { name: "timeout", chunks: ["slow\n"], kind: "timeout", timeout: 0.05 },
];

/** Normalizes the per-run temp file path so two independent runs can be compared. */
function normalize(value: unknown): unknown {
  return JSON.parse(
    JSON.stringify(value, (_key, raw: unknown) =>
      typeof raw === "string" ? raw.replace(/\/[^\s"]*pi-bash[^\s"\]]*/g, "<tmp>") : raw,
    ),
  );
}

type Captured = { ok: true; result: unknown } | { ok: false; message: string };

async function capture(run: () => Promise<unknown>): Promise<Captured> {
  try {
    return { ok: true, result: normalize(await run()) };
  } catch (error) {
    return { ok: false, message: (error as Error).message.replace(/\/[^\s"]*pi-bash[^\s"\]]*/g, "<tmp>") };
  }
}

describe("bash override tool — T1 built-in golden equivalence", () => {
  it("keeps the hand-written schema in sync with pi's bash schema (R7 drift guard)", () => {
    const inner = createBashToolDefinition(process.cwd());
    const innerProps = (inner.parameters as unknown as { properties: Record<string, { description?: string }> })
      .properties;
    expect(Object.keys(BashToolParams.properties)).toEqual(["command", "timeout", "run_in_background"]);
    expect(BashToolParams.properties.command.description).toBe(innerProps.command?.description);
    expect(BashToolParams.properties.timeout.description).toBe(innerProps.timeout?.description);
    // The override's static surface is pi's own, plus the threshold paragraph.
    const tool = createBashTool({ manager: () => undefined, autoBackgroundMs: () => 120_000 });
    expect(tool.name).toBe("bash");
    expect(tool.description.startsWith(inner.description)).toBe(true);
    expect(tool.promptSnippet).toBe(inner.promptSnippet);
    expect(tool.promptGuidelines).toEqual(inner.promptGuidelines);
  });

  for (const scenario of SCENARIOS) {
    it(`matches the built-in result for: ${scenario.name}`, async () => {
      const harness = await makeHarness();
      const params = {
        command: "run-it",
        ...(scenario.timeout !== undefined ? { timeout: scenario.timeout } : {}),
      };

      // (a) the built-in definition driven by fake operations.
      const builtinOps: BashOperations = {
        exec: async (_command, _cwd, options) => {
          if (options.signal?.aborted) throw new Error("aborted");
          for (const chunk of scenario.chunks) options.onData(Buffer.from(chunk, "utf8"));
          if (scenario.kind === "abort") {
            await new Promise<void>((resolve) => options.signal?.addEventListener("abort", () => resolve()));
            throw new Error("aborted");
          }
          if (scenario.kind === "timeout") {
            await new Promise((resolve) => setTimeout(resolve, (options.timeout ?? 0) * 1000 + 20));
            throw new Error(`timeout:${options.timeout}`);
          }
          return { exitCode: scenario.exitCode ?? 0 };
        },
      };
      const builtin = createBashToolDefinition(harness.dir, { operations: builtinOps });
      const builtinAbort = new AbortController();
      const builtinRun = capture(() =>
        builtin.execute("call-1", params as never, builtinAbort.signal, undefined, harness.ctx),
      );
      if (scenario.kind === "abort") {
        await settle(5);
        builtinAbort.abort();
      }
      const builtinResult = await builtinRun;

      // (b) the override tool over a process port scripted to the same bytes.
      harness.port.script = (proc) => {
        for (const chunk of scenario.chunks) proc.write(chunk);
        if (scenario.kind === undefined) proc.exit({ exitCode: scenario.exitCode ?? 0, signal: null });
      };
      const tool = toolFor(harness, HUGE_THRESHOLD_MS);
      const overrideAbort = new AbortController();
      const overrideRun = capture(() => tool.execute("call-2", params, overrideAbort.signal, undefined, harness.ctx));
      if (scenario.kind === "abort") {
        await settle(5);
        overrideAbort.abort();
      }
      const overrideResult = await overrideRun;

      expect(overrideResult).toEqual(builtinResult);
    });
  }
});

// ── T2-T9: auto-background behaviour ───────────────────────────────────────

describe("bash override tool — auto-background", () => {
  it("T2: downgrades to a job once the threshold expires", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    const harness = await makeHarness();
    harness.port.script = (proc) => proc.write("still working\n");
    const updates: unknown[] = [];
    const tool = toolFor(harness, 120_000);
    const run = tool.execute("call-1", { command: "npm run build" }, undefined, (u) => updates.push(u), harness.ctx);
    await waitFor(() => harness.port.spawns.length === 1, "the job to spawn");
    await settle();
    const updatesBefore = updates.length;
    expect(harness.port.spawns).toHaveLength(1);

    await vi.advanceTimersByTimeAsync(120_000);
    await settle();
    const result = await run;

    const text = result.content.map((part) => (part.type === "text" ? part.text : "")).join("");
    const details = result.details as BashBackgroundDetails;
    expect(details.background).toBe(true);
    expect(details.autoBackgrounded).toBe(true);
    expect(details.jobId).toMatch(/^b_[0-9A-Z]{8}$/);
    expect(details.pid).toBe(harness.port.last().pid);
    expect(details.logPath).toContain(details.jobId);
    expect(text).toContain(details.jobId);
    expect(text).toContain("NOT killed");
    expect(text).toContain('bash_job(action: "status"');
    // Change A: no `output` action — the log is a plain file the model reads.
    expect(text).not.toContain('bash_job(action: "output"');
    expect(text).toMatch(/plain file/);
    expect(text).toMatch(/tail\/grep\/awk/);
    expect(text).toContain('bash_job(action: "kill"');
    // The process was not touched and the job is now notification-eligible.
    expect(harness.port.killCalls).toHaveLength(0);
    expect(harness.manager.get(details.jobId)?.status).toBe("running");
    expect(harness.manager.get(details.jobId)?.backgroundedAt).toBeDefined();

    // The update gate is closed: further output no longer reaches the caller.
    harness.port.last().write("late output\n");
    await settle();
    expect(updates.length).toBe(updatesBefore);
  });

  it("T3: a caller abort after backgrounding never reaches the process", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    const harness = await makeHarness();
    harness.port.script = (proc) => proc.write("working\n");
    const controller = new AbortController();
    const tool = toolFor(harness, 120_000);
    const run = tool.execute("call-1", { command: "sleep 900" }, controller.signal, undefined, harness.ctx);
    await waitFor(() => harness.port.spawns.length === 1, "the job to spawn");
    await vi.advanceTimersByTimeAsync(120_000);
    await settle();
    const details = (await run).details as BashBackgroundDetails;

    controller.abort();
    await settle();
    expect(harness.port.killCalls).toHaveLength(0);
    expect(harness.manager.get(details.jobId)?.status).toBe("running");
  });

  it("T4: a caller abort before the threshold kills the tree and throws like the built-in", async () => {
    const harness = await makeHarness();
    harness.port.script = (proc) => proc.write("partial\n");
    const controller = new AbortController();
    const tool = toolFor(harness, HUGE_THRESHOLD_MS);
    const run = tool.execute("call-1", { command: "sleep 900" }, controller.signal, undefined, harness.ctx);
    await waitFor(() => harness.port.spawns.length === 1, "the job to spawn");
    controller.abort();

    // Byte-identical to the built-in: accumulated output, blank line, status.
    await expect(run).rejects.toThrow(/^partial\n+Command aborted$/);
    expect(harness.port.killCalls).toHaveLength(1);
    const job = harness.manager.list()[0]!;
    expect(job.status).toBe("killed");
  });

  it("T5: an already-aborted signal throws before anything spawns", async () => {
    const harness = await makeHarness();
    const controller = new AbortController();
    controller.abort();
    const tool = toolFor(harness, HUGE_THRESHOLD_MS);

    await expect(
      tool.execute("call-1", { command: "echo hi" }, controller.signal, undefined, harness.ctx),
    ).rejects.toThrow("Command aborted");
    expect(harness.port.spawns).toHaveLength(0);
    expect(harness.manager.list()).toHaveLength(0);
  });

  it("T6: aborting after a normal return has no effect (listener detached)", async () => {
    const harness = await makeHarness();
    harness.port.script = (proc) => {
      proc.write("done\n");
      proc.exit({ exitCode: 0, signal: null });
    };
    const controller = new AbortController();
    const tool = toolFor(harness, HUGE_THRESHOLD_MS);
    const result = await tool.execute("call-1", { command: "echo done" }, controller.signal, undefined, harness.ctx);
    expect(result.content[0]).toEqual({ type: "text", text: "done\n" });

    controller.abort();
    await settle();
    expect(harness.port.killCalls).toHaveLength(0);
  });

  it("T7: run_in_background returns immediately, and throws when the cap is full", async () => {
    const harness = await makeHarness({ maxBackgroundJobs: 1 });
    harness.port.script = (proc) => proc.write("bg\n");
    const tool = toolFor(harness, 120_000);

    const result = await tool.execute(
      "call-1",
      { command: "npm test", run_in_background: true },
      undefined,
      undefined,
      harness.ctx,
    );
    const details = result.details as BashBackgroundDetails;
    expect(details.background).toBe(true);
    expect(details.autoBackgrounded).toBeUndefined();
    expect(details.pid).toBe(harness.port.last().pid);
    const text = result.content.map((part) => (part.type === "text" ? part.text : "")).join("");
    expect(text).toContain(details.jobId);
    expect(text).toContain("NOT killed");
    expect(harness.manager.backgroundJobCount()).toBe(1);

    // Slot full → config error, raised *before* a second process is spawned.
    await expect(
      tool.execute("call-2", { command: "npm run build", run_in_background: true }, undefined, undefined, harness.ctx),
    ).rejects.toThrow(/all 1 background job slots are in use/);
    expect(harness.port.spawns).toHaveLength(1);
  });

  it("T8: the threshold expires but every slot is taken → keep waiting in the foreground", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    const harness = await makeHarness({ maxBackgroundJobs: 1 });
    harness.port.script = (proc) => proc.write("occupied\n");
    // Occupy the only slot with an already backgrounded job.
    const occupier = await harness.manager.create({ command: "sleep 900", cwd: harness.dir });
    await harness.manager.markBackgrounded(occupier.jobId);

    harness.port.script = (proc) => proc.write("slow\n");
    const tool = toolFor(harness, 120_000);
    const run = tool.execute("call-1", { command: "npm test" }, undefined, undefined, harness.ctx);
    await waitFor(() => harness.port.spawns.length === 2, "the foreground job to spawn");
    await vi.advanceTimersByTimeAsync(120_000);
    await waitFor(
      () => harness.warnings.some((line) => line.includes("stayed in the foreground")),
      "the capacity warning",
    );

    // Still foreground: no background details, the job is not marked.
    const foregroundJob = harness.manager.list().find((record) => record.jobId !== occupier.jobId)!;
    expect(foregroundJob.backgroundedAt).toBeUndefined();
    expect(harness.warnings.some((line) => line.includes("stayed in the foreground"))).toBe(true);

    harness.port.last().exit({ exitCode: 0, signal: null });
    const result = await run;
    const text = result.content.map((part) => (part.type === "text" ? part.text : "")).join("");
    expect(text).toContain("slow");
    expect(text).toContain("background job slots");
    expect((result.details as BashBackgroundDetails | undefined)?.background).toBeUndefined();
  });

  it("T9: a post-background inner rejection lands in finalText without an unhandled rejection", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    const unhandled: unknown[] = [];
    const onUnhandled = (reason: unknown): void => void unhandled.push(reason);
    process.on("unhandledRejection", onUnhandled);
    try {
      const harness = await makeHarness();
      harness.port.script = (proc) => proc.write("failing\n");
      const tool = toolFor(harness, 120_000);
      const run = tool.execute("call-1", { command: "false" }, undefined, undefined, harness.ctx);
      await waitFor(() => harness.port.spawns.length === 1, "the job to spawn");
      await vi.advanceTimersByTimeAsync(120_000);
      const details = (await run).details as BashBackgroundDetails;

      harness.port.last().exit({ exitCode: 1, signal: null });
      await waitFor(
        () => harness.manager.get(details.jobId)?.finalText !== undefined,
        "the inner result to reach finalText",
      );

      const record = harness.manager.get(details.jobId)!;
      expect(record.status).toBe("failed");
      expect(record.exitCode).toBe(1);
      expect(record.finalText).toContain("Command exited with code 1");
      vi.useRealTimers();
      await new Promise((resolve) => setTimeout(resolve, 20));
      expect(unhandled).toEqual([]);
    } finally {
      process.off("unhandledRejection", onUnhandled);
    }
  });

  it("passes straight through to pi when the feature is off (no manager / zero threshold)", async () => {
    const harness = await makeHarness();
    const offTool = createBashTool({ manager: () => undefined, autoBackgroundMs: () => 120_000 });
    const result = await offTool.execute("call-1", { command: "echo passthrough" }, undefined, undefined, harness.ctx);
    expect(result.content[0]).toEqual({ type: "text", text: "passthrough\n" });
    // Nothing was routed through the manager.
    expect(harness.port.spawns).toHaveLength(0);

    const zeroTool = toolFor(harness, 0);
    const zero = await zeroTool.execute("call-2", { command: "echo zero" }, undefined, undefined, harness.ctx);
    expect(zero.content[0]).toEqual({ type: "text", text: "zero\n" });
    expect(harness.port.spawns).toHaveLength(0);
  });
});
