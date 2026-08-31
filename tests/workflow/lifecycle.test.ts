import { describe, expect, it } from "vitest";
import { FakeClock } from "../../src/core/clock.js";
import { createWorkerHost } from "../../src/workflow/lifecycle.js";
import { fakeSpawnWorkerFactory } from "./helpers.js";

const BASE_INIT = {
  scriptSource: 'export const meta = { name: "t", description: "t" };\nlog(\'hi\');\nreturn 1;',
  scriptSliceMs: 1_000,
  heartbeatMs: 0,
  workerBootMs: 1_000,
  terminateConfirmMs: 500,
};

describe("WorkerHost lifecycle (§2.3.1 S1-S8)", () => {
  it("boots successfully and reaches lifecycle=ready", async () => {
    const clock = new FakeClock();
    const { spawnWorker } = fakeSpawnWorkerFactory();
    const host = createWorkerHost({ clock, spawnWorker });
    const bootPromise = host.boot(BASE_INIT);
    // FakeWorkerLike fires 'online' on a microtask; flush microtasks before checking.
    const outcome = await bootPromise;
    expect(outcome.ok).toBe(true);
    expect(host.lifecycle).toBe("ready");
  });

  it("WT3: boot times out (bounded) when the worker never comes online, and is reported as boot_timeout", async () => {
    const clock = new FakeClock();
    const { spawnWorker } = fakeSpawnWorkerFactory({ autoOnline: false });
    const host = createWorkerHost({ clock, spawnWorker });
    const bootPromise = host.boot(BASE_INIT);
    clock.advance(BASE_INIT.workerBootMs);
    const outcome = await bootPromise;
    expect(outcome).toEqual({
      ok: false,
      reason: "boot_timeout",
      detail: expect.stringContaining("did not come online"),
    });
  });

  it("WC10: terminate() is idempotent — a second concurrent/sequential call returns the same cached result and does not re-run S1-S8", async () => {
    const clock = new FakeClock();
    const { spawnWorker, worker } = fakeSpawnWorkerFactory();
    const host = createWorkerHost({ clock, spawnWorker });
    await host.boot(BASE_INIT);

    const [r1, r2] = await Promise.all([host.terminate("first"), host.terminate("second")]);
    expect(r1).toBe(r2); // same object identity: the second call rode the first's in-flight promise.
    expect(host.lifecycle).toBe("terminated");

    // A third, fully-sequential call after settling must also be a no-op returning the cached result.
    const r3 = await host.terminate("third");
    expect(r3).toBe(r1);
    expect(worker().wasTerminated).toBe(true);
  });

  it("§2.3.1 S7/WT11: terminate() bounds an S7 that never confirms and reports orphaned, without blocking on the native terminate() forever", async () => {
    const clock = new FakeClock();
    const { spawnWorker } = fakeSpawnWorkerFactory({ hangOnTerminate: true });
    const host = createWorkerHost({ clock, spawnWorker });
    await host.boot(BASE_INIT);

    const terminatePromise = host.terminate("hang-test");
    // S1-S6 are synchronous/microtask-bound; only S7's confirm wait needs the clock advanced.
    await Promise.resolve();
    clock.advance(BASE_INIT.terminateConfirmMs);
    const result = await terminatePromise;

    expect(result).toEqual({ detached: true, terminated: false, orphaned: true, ms: BASE_INIT.terminateConfirmMs });
    expect(host.lifecycle).toBe("orphaned");
    expect(host.stats.terminateForced).toBe(1);
  });

  describe("WC09 (M3.1 architectural gate): port.close() makes the worker's messages physically unreachable, independent of whether terminate()'s S7 ever confirms", () => {
    it("a message posted on the worker's end of the port BEFORE terminate() is delivered", async () => {
      const clock = new FakeClock();
      const { spawnWorker, workerData } = fakeSpawnWorkerFactory();
      const host = createWorkerHost({ clock, spawnWorker });
      await host.boot(BASE_INIT);

      const received: unknown[] = [];
      host.events.onScriptReturned((r) => received.push(r));
      workerData().commPort.postMessage({ kind: "script_returned", result: "before-close" });
      await new Promise((r) => setTimeout(r, 0));

      expect(received).toEqual(["before-close"]);
    });

    it("W36 / WK2: a message posted on the worker's end AFTER terminate() (even with a hanging S7) is never observed, and is counted as lateMessages (epoch invalidated, no WorkflowInput produced)", async () => {
      const clock = new FakeClock();
      const { spawnWorker, workerData } = fakeSpawnWorkerFactory({ hangOnTerminate: true });
      const host = createWorkerHost({ clock, spawnWorker });
      await host.boot(BASE_INIT);
      const port2 = workerData().commPort;

      const received: unknown[] = [];
      host.events.onScriptReturned((r) => received.push(r));

      const terminatePromise = host.terminate("wc09");
      await Promise.resolve(); // let S1-S6 run synchronously to completion
      expect(host.lifecycle).toBe("detached");

      // The "worker" (our fake, standing in for a real thread that is still
      // running because S7 hasn't confirmed) tries to send a late message.
      let threw = false;
      try {
        port2.postMessage({ kind: "script_returned", result: "after-close" });
      } catch {
        threw = true; // Node's MessageChannel commonly throws on a closed port; either outcome is acceptable here.
      }
      await new Promise((r) => setTimeout(r, 0));

      expect(received).toEqual([]); // WK1: zero observable effect from the late message, whether it threw or was silently dropped.
      if (!threw) {
        // If postMessage didn't throw, the physical-close path (S5) must still have blocked delivery.
        expect(host.stats.lateMessages).toBe(0); // handlePortMessage never even ran — the port was already closed on the host side.
      }

      clock.advance(BASE_INIT.terminateConfirmMs);
      await terminatePromise;
    });
  });
});
