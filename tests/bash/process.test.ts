import { afterEach, describe, expect, it } from "vitest";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import {
  ALLOWED_SHELL_BASENAMES,
  createProcessPort,
  probePid,
  readProcStartTime,
  resolveShell,
  type ProcessPort,
  type SpawnedJob,
  watchChild,
} from "../../src/bash/process.js";

/** §3.3 process boundary, exercised against **real** child processes: fakes
 * cannot prove the thing that matters here (a detached group leader whose
 * descendants die with it, and an idempotent ESRCH path).
 *
 * Every spawn is registered in `spawned` and force-killed in `afterEach`, so a
 * failing assertion can never leak a `sleep 60` into the developer's machine.
 */

const posix = process.platform !== "win32";
const linux = process.platform === "linux";

let port: ProcessPort;
const spawned: SpawnedJob[] = [];
const envShellBackup = process.env.SHELL;

async function launch(command: string, cwd = process.cwd()): Promise<SpawnedJob> {
  const job = await port.spawnJob(command, cwd);
  spawned.push(job);
  return job;
}

function collect(job: SpawnedJob): { out: () => string; err: () => string } {
  let out = "";
  let err = "";
  job.stdout.on("data", (chunk: Buffer) => {
    out += chunk.toString("utf8");
  });
  job.stderr.on("data", (chunk: Buffer) => {
    err += chunk.toString("utf8");
  });
  return { out: () => out, err: () => err };
}

/** Poll until `predicate` holds; returns false on timeout (no fake timers here). */
async function until(predicate: () => boolean, timeoutMs = 5_000): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return true;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  return predicate();
}

describe("resolveShell", () => {
  it("prefers an explicit shellPath and always uses -c", () => {
    expect(resolveShell("/opt/weird/fish", "/bin/bash")).toEqual({ shell: "/opt/weird/fish", args: ["-c"] });
  });

  it("accepts whitelisted $SHELL basenames", () => {
    for (const name of ALLOWED_SHELL_BASENAMES) {
      expect(resolveShell(undefined, `/usr/local/bin/${name}`)).toEqual({
        shell: `/usr/local/bin/${name}`,
        args: ["-c"],
      });
    }
  });

  it("falls back to bash for non-whitelisted shells, empty values and missing input", () => {
    expect(resolveShell(undefined, "/bin/fish")).toEqual({ shell: "bash", args: ["-c"] });
    expect(resolveShell(undefined, "/usr/bin/nu")).toEqual({ shell: "bash", args: ["-c"] });
    expect(resolveShell(undefined, undefined)).toEqual({ shell: "bash", args: ["-c"] });
    expect(resolveShell("   ", "  ")).toEqual({ shell: "bash", args: ["-c"] });
  });
});

describe("watchChild", () => {
  function fake(): { child: EventEmitter & { stdout: PassThrough; stderr: PassThrough }; emit: EventEmitter["emit"] } {
    const child = Object.assign(new EventEmitter(), { stdout: new PassThrough(), stderr: new PassThrough() });
    return { child, emit: child.emit.bind(child) };
  }

  it("uses the first exit/close result and shares the frozen object", async () => {
    const cases: Array<[string, (child: EventEmitter) => void, number | null]> = [
      [
        "exit then close",
        (child) => {
          child.emit("exit", 3, null);
          child.emit("close", 0, null);
        },
        3,
      ],
      [
        "close then exit",
        (child) => {
          child.emit("close", 0, null);
          child.emit("exit", 3, null);
        },
        0,
      ],
      [
        "null close",
        (child) => {
          child.emit("exit", 4, null);
          child.emit("close", null, null);
        },
        4,
      ],
    ];
    for (const [, drive, code] of cases) {
      const { child } = fake();
      const watched = watchChild(child as never, 600);
      drive(child);
      child.stdout.end();
      child.stderr.end();
      const exit = await watched.processExitPromise;
      const drained = await watched.drainedPromise;
      expect(exit.exitCode).toBe(code);
      expect(drained.stop).toBe("ended");
      expect(Object.isFrozen(exit)).toBe(true);
      expect(drained.exit).toBe(exit);
    }
  });

  it("settles both promises with error before exit", async () => {
    const { child } = fake();
    const watched = watchChild(child as never, 600);
    const error = new Error("pipe");
    child.emit("error", error);
    child.emit("exit", 0, null);
    const exit = await watched.processExitPromise;
    const drained = await watched.drainedPromise;
    expect(exit.error).toBe(error);
    expect(drained).toEqual({ exit, stop: "error" });
  });

  it("ignores post-exit errors and caps a busy pipe", async () => {
    const { child } = fake();
    const watched = watchChild(child as never, 20);
    child.emit("exit", 0, null);
    child.emit("error", new Error("noise"));
    const exit = await watched.processExitPromise;
    const drained = await watched.drainedPromise;
    expect(exit.error).toBeUndefined();
    expect(drained.stop).toBe("capped");
    expect(child.stdout.destroyed).toBe(true);
    expect(child.stderr.destroyed).toBe(true);
  });
});
describe.skipIf(!posix)("createProcessPort (POSIX)", () => {
  afterEach(async () => {
    // Belt-and-braces reaper: kill anything the test left running.
    for (const job of spawned.splice(0)) {
      try {
        process.kill(-job.pid, "SIGKILL");
      } catch {
        /* already gone */
      }
    }
    if (envShellBackup === undefined) delete process.env.SHELL;
    else process.env.SHELL = envShellBackup;
    await Promise.resolve();
  });

  it("spawns, streams both pipes and reports the exit code", async () => {
    port = createProcessPort();
    const job = await launch("echo out; echo err 1>&2; exit 7");
    const streams = collect(job);

    expect(job.pid).toBeGreaterThan(0);
    const { exit } = await job.drainedPromise;

    expect(exit.exitCode).toBe(7);
    expect(exit.signal).toBeNull();
    expect(exit.error).toBeUndefined();
    expect(streams.out()).toContain("out");
    expect(streams.err()).toContain("err");
  });

  it("makes the child a process group leader (pgid === pid)", async () => {
    port = createProcessPort();
    const job = await launch("exit 0");
    expect(job.pgid).toBe(job.pid);
    await job.drainedPromise;
  });

  it("honours cwd", async () => {
    port = createProcessPort();
    const job = await launch("pwd", "/tmp");
    const streams = collect(job);
    await job.drainedPromise;
    // /tmp may be a symlink (macOS → /private/tmp); pwd resolves the logical path.
    expect(streams.out().trim().endsWith("/tmp")).toBe(true);
  });

  it("rejects when the shell or cwd does not exist (spawn error, not a hang)", async () => {
    const missingShell = createProcessPort({ shellPath: "/nonexistent/shell-xyz" });
    await expect(missingShell.spawnJob("echo hi", process.cwd())).rejects.toThrow(/ENOENT/);

    port = createProcessPort();
    await expect(port.spawnJob("echo hi", "/nonexistent/dir-xyz")).rejects.toThrow(/ENOENT/);
  });

  it("kills the whole process group so grandchildren die with the shell", async () => {
    port = createProcessPort({ graceMs: 500 });
    // The shell exec's nothing: `sleep 60 &` is a background grandchild that
    // would survive a plain kill(pid) but not kill(-pgid).
    const job = await launch("sleep 60 & echo $! ; wait");
    const streams = collect(job);
    expect(await until(() => streams.out().trim().length > 0)).toBe(true);
    const grandchild = Number.parseInt(streams.out().trim(), 10);
    expect(Number.isInteger(grandchild)).toBe(true);
    expect(probePid(grandchild)).toBe(true);

    const outcome = await port.killJobTree(job.pid);
    expect(["terminated", "killed"]).toContain(outcome);

    const exit = await job.drainedPromise;
    expect(exit.exitCode === null || exit.exitCode !== 0).toBe(true);
    expect(await until(() => !probePid(job.pid))).toBe(true);
    expect(await until(() => !probePid(grandchild))).toBe(true);
  });

  it("escalates to SIGKILL when the group ignores SIGTERM", async () => {
    port = createProcessPort({ graceMs: 150, killPollMs: 20 });
    const job = await launch("trap '' TERM; sleep 60");
    // Give the shell a moment to install the trap.
    await new Promise((resolve) => setTimeout(resolve, 200));

    const outcome = await port.killJobTree(job.pid);
    expect(outcome).toBe("killed");
    await job.drainedPromise;
    expect(await until(() => !probePid(job.pid))).toBe(true);
  });

  it("is idempotent: a second kill of a dead group reports already-dead (ESRCH)", async () => {
    port = createProcessPort({ graceMs: 200, killPollMs: 20 });
    const job = await launch("sleep 60");
    expect(["terminated", "killed"]).toContain(await port.killJobTree(job.pid));
    await job.drainedPromise;
    expect(await until(() => !probePid(job.pid))).toBe(true);

    expect(await port.killJobTree(job.pid)).toBe("already-dead");
    expect(await port.killJobTree(job.pid)).toBe("already-dead");
  });

  it("refuses to signal pid <= 1 or a recycled pid", async () => {
    port = createProcessPort({ graceMs: 50 });
    expect(await port.killJobTree(1)).toBe("refused");
    expect(await port.killJobTree(0)).toBe("refused");
    expect(await port.killJobTree(-5)).toBe("refused");

    const job = await launch("sleep 60");
    if (linux) {
      // A starttime mismatch means the pid was reused: nothing may be signalled.
      expect(await port.killJobTree(job.pid, { expectedProcStartTime: "1" })).toBe("refused");
      expect(probePid(job.pid)).toBe(true);
      // The real starttime still kills.
      expect(["terminated", "killed"]).toContain(
        await port.killJobTree(job.pid, { expectedProcStartTime: job.procStartTime ?? "" }),
      );
    }
    await port.killJobTree(job.pid);
    await job.drainedPromise;
  });

  it("decouples process exit from a chatty detached writer (exit ≠ drain)", async () => {
    port = createProcessPort();
    // The shell exits at once; the detached writer keeps the inherited pipe
    // busy every 50ms for ~2s. Before the exit/drain split this wedged the
    // job in "running" until the writer stopped; a 100ms-only idle cutoff
    // (no re-arm) would silently truncate the tail instead.
    const job = await launch("(i=0; while [ $i -lt 40 ]; do echo tick; i=$((i+1)); sleep 0.05; done &) ; exit 0");
    const streams = collect(job);
    const t0 = Date.now();

    const exit = await job.processExitPromise;
    expect(exit.exitCode).toBe(0);
    expect(Date.now() - t0).toBeLessThan(1_000);

    // The writer is still going: drained must not have settled yet.
    const drainedEarly = await Promise.race([
      job.drainedPromise.then(() => true as const),
      new Promise<false>((resolve) => setTimeout(() => resolve(false), 200)),
    ]);
    expect(drainedEarly).toBe(false);

    const drained = await job.drainedPromise;
    // The tail was captured in full (idle re-armed by writes), not cut at 100ms.
    expect(Date.now() - t0).toBeGreaterThan(1_500);
    expect(drained.stop === "ended" || drained.stop === "idle").toBe(true);
    expect(drained.exit).toBe(exit);
    expect(streams.out().match(/tick/g)?.length).toBe(40);
  });

  it("caps the drain of a perpetually busy pipe and destroys it (cap >= idle window)", async () => {
    port = createProcessPort({ drainTimeoutMs: 600 });
    const job = await launch("(while :; do echo tick; sleep 0.05; done &) ; exit 0");
    collect(job);
    const t0 = Date.now();

    const exit = await job.processExitPromise;
    expect(exit.exitCode).toBe(0);

    const drained = await job.drainedPromise;
    const elapsed = Date.now() - t0;
    expect(drained.stop).toBe("capped");
    // The idle window (100ms) can never fire while writes arrive every 50ms,
    // so settling at ~600ms proves the cap — not the idle timer — fired.
    expect(elapsed).toBeGreaterThanOrEqual(550);
    expect(elapsed).toBeLessThan(3_000);
    expect(job.stdout.destroyed).toBe(true);
    expect(job.stderr.destroyed).toBe(true);
    // afterEach SIGKILLs the group, reaping the infinite writer.
  });

  it("probePid distinguishes live from dead pids", async () => {
    port = createProcessPort({ graceMs: 100, killPollMs: 20 });
    expect(port.probePid(process.pid)).toBe(true);
    expect(port.probePid(0)).toBe(false);
    expect(port.probePid(-1)).toBe(false);
    // pid 1 exists everywhere and is not ours → EPERM counts as alive
    // (unless the test runs as root/PID-1 namespace, where it is plainly alive).
    expect(port.probePid(1)).toBe(true);

    const job = await launch("exit 0");
    await job.drainedPromise;
    expect(await until(() => !port.probePid(job.pid))).toBe(true);
  });

  it("falls back to bash when $SHELL is not whitelisted", async () => {
    process.env.SHELL = "/bin/fish";
    port = createProcessPort();
    const job = await launch('echo "shell=${BASH_VERSION:+bash}"');
    const streams = collect(job);
    const { exit } = await job.drainedPromise;
    expect(exit.exitCode).toBe(0);
    // Only bash defines BASH_VERSION; fish would never have been able to run
    // this command at all (and is not installed in CI).
    expect(streams.out()).toContain("shell=bash");
  });

  it("checkPidOwnership: alive for our own child, dead once it exits", async () => {
    port = createProcessPort({ graceMs: 100, killPollMs: 20 });
    const job = await launch("sleep 60");
    const identity = {
      pid: job.pid,
      spawnedAt: Date.now(),
      ...(job.procStartTime !== undefined ? { procStartTime: job.procStartTime } : {}),
    };
    // Linux records a starttime → verifiable "alive"; elsewhere the honest
    // answer is "unsafe" (never killed, marked orphaned by the caller).
    expect(port.checkPidOwnership(identity)).toBe(linux ? "alive" : "unsafe");

    await port.killJobTree(job.pid);
    await job.drainedPromise;
    expect(await until(() => port.checkPidOwnership(identity) === "dead")).toBe(true);
  });

  it("checkPidOwnership: missing pid is dead, unverifiable identity is unsafe", () => {
    port = createProcessPort();
    expect(port.checkPidOwnership({ pid: undefined })).toBe("dead");
    expect(port.checkPidOwnership({ pid: 0 })).toBe("dead");
    // Live pid, no recorded identity → cannot prove it is ours.
    expect(port.checkPidOwnership({ pid: process.pid })).toBe("unsafe");
    // Live pid whose record predates the last boot → certainly stale.
    expect(port.checkPidOwnership({ pid: process.pid, spawnedAt: 0 })).toBe("dead");
  });

  it("readProcStartTime is a stable digit string on Linux and undefined elsewhere", () => {
    const value = readProcStartTime(process.pid);
    if (linux) {
      expect(value).toMatch(/^\d+$/);
      expect(readProcStartTime(process.pid)).toBe(value);
    } else {
      expect(value).toBeUndefined();
    }
    expect(readProcStartTime(0)).toBeUndefined();
  });
});
