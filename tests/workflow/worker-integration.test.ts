import { describe, expect, it } from "vitest";
import { systemClock } from "../../src/core/clock.js";
import { createWorkerHost } from "../../src/workflow/lifecycle.js";
import type { WorkerHostInit } from "../../src/workflow/types.js";

/**
 * WC01–WC07 (workflow design §10.1): contract tests against real
 * `node:worker_threads`/`node:vm` behavior — these are exactly the
 * assumptions the isolation shell's safety story rests on, so they run
 * against the genuine runtime, not fakes. Timings are scaled down (tens to
 * low-hundreds of ms) to keep the suite fast; the mechanism being tested
 * (vm slice wall, heartbeat, sandbox denylist) does not depend on absolute
 * magnitude.
 */

function scriptWith(body: string): string {
  return `export const meta = { name: "t", description: "t" };\n${body}`;
}

async function runOnce(
  script: string,
  init: Partial<WorkerHostInit> = {},
): Promise<{
  returned?: unknown;
  threw?: { message: string; stack?: string };
  metaError?: string;
  exited?: { code: number; expected: boolean };
  errored?: { message: string };
  host: ReturnType<typeof createWorkerHost>;
}> {
  const host = createWorkerHost({ clock: systemClock });
  const boot = await host.boot({
    scriptSource: script,
    scriptSliceMs: 300,
    heartbeatMs: 0,
    workerBootMs: 5_000,
    terminateConfirmMs: 2_000,
    ...init,
  });
  expect(boot.ok).toBe(true);

  return new Promise((resolve) => {
    let done = false;
    const finish = (r: Omit<Parameters<typeof resolve>[0], "host">) => {
      if (done) return;
      done = true;
      resolve({ ...r, host });
    };
    host.events.onScriptReturned((returned) => finish({ returned }));
    host.events.onScriptThrew((threw) => finish({ threw }));
    host.events.onMetaError((metaError) => finish({ metaError }));
    host.events.onExit((code, expected) => finish({ exited: { code, expected } }));
    host.events.onError((errored) => finish({ errored }));
  });
}

describe("WC01: top-level synchronous infinite loop is bounded by the vm slice wall (P1), and precedes heartbeatStallMs", () => {
  it("a `while(true){}` script throws within scriptSliceMs, well before any diagnostic heartbeat window would fire", async () => {
    const start = Date.now();
    const outcome = await runOnce(scriptWith("while(true) {}"), { scriptSliceMs: 200 });
    const elapsed = Date.now() - start;
    expect(outcome.threw).toBeDefined();
    expect(outcome.threw?.message).toMatch(/Script execution timed out/i);
    expect(elapsed).toBeLessThan(2_000); // generous slack over the 200ms slice wall for CI jitter
    await outcome.host.terminate("test-done");
  }, 10_000);

  it("the host's own event loop is never blocked by the worker's infinite loop (no >50ms stall observed while it runs)", async () => {
    const host = createWorkerHost({ clock: systemClock });
    await host.boot({
      scriptSource: scriptWith("while(true) {}"),
      scriptSliceMs: 400,
      heartbeatMs: 0,
      workerBootMs: 5_000,
      terminateConfirmMs: 2_000,
    });
    let maxGapMs = 0;
    let last = Date.now();
    const probe = setInterval(() => {
      const now = Date.now();
      maxGapMs = Math.max(maxGapMs, now - last);
      last = now;
    }, 10);
    await new Promise((r) => setTimeout(r, 300));
    clearInterval(probe);
    expect(maxGapMs).toBeLessThan(50 + 30); // small CI-jitter slack over the §GW5 50ms bound
    await host.terminate("test-done");
  }, 10_000);
});

describe("WC02: an await-then-microtask-loop death spiral is NOT caught by the vm slice wall (documented, narrow coverage of P1)", () => {
  it("`vm` timeout does not fire for a microtask starvation loop after the first await", async () => {
    const script = scriptWith(
      "await Promise.resolve();\n" +
        "async function spin(){ while(true){ await Promise.resolve(); } }\n" +
        "await spin();",
    );
    const host = createWorkerHost({ clock: systemClock });
    await host.boot({
      scriptSource: script,
      scriptSliceMs: 150,
      heartbeatMs: 30,
      workerBootMs: 5_000,
      terminateConfirmMs: 500,
    });
    // Give it much longer than scriptSliceMs; if the vm timeout covered this
    // case it would have already reported script_threw.
    let sawOutcome = false;
    host.events.onScriptReturned(() => (sawOutcome = true));
    host.events.onScriptThrew(() => (sawOutcome = true));
    await new Promise((r) => setTimeout(r, 400));
    expect(sawOutcome).toBe(false); // P1 genuinely does not cover this — that's the point of WC02.

    // The heartbeat, however, does observe the stall (P2 — diagnostic only).
    const hb = host.readHeartbeat();
    expect(hb.stalledMs).toBeGreaterThan(0);

    // And terminate() still confirms boundedly despite the worker being
    // permanently busy in microtasks (WC09/S1-S8 do not depend on the
    // script cooperating).
    const terminateStart = Date.now();
    const result = await host.terminate("test-done");
    expect(Date.now() - terminateStart).toBeLessThan(2_000);
    expect(result.detached).toBe(true);
  }, 10_000);
});

describe("WC03: unbounded synchronous recursion (stack overflow) settles boundedly", () => {
  it("a script that recurses without a base case throws RangeError, reported as script_threw", async () => {
    const outcome = await runOnce(scriptWith("function r(){ return r(); }\nr();"));
    expect(outcome.threw).toBeDefined();
    expect(outcome.threw?.message).toMatch(/call stack/i);
    await outcome.host.terminate("test-done");
  }, 10_000);
});

describe("WC04: resourceLimits bounds worker memory; exceeding it is reported boundedly, not as a process crash", () => {
  it("allocating far past a tiny maxOldGenerationSizeMb cap ends in an 'error'/'exit' the host observes", async () => {
    const host = createWorkerHost({ clock: systemClock });
    await host.boot({
      scriptSource: scriptWith("const chunks = []; while(true) { chunks.push(new Array(1_000_000).fill(0)); }"),
      scriptSliceMs: 5_000,
      heartbeatMs: 0,
      workerBootMs: 5_000,
      terminateConfirmMs: 2_000,
      maxOldGenerationSizeMb: 16,
      maxYoungGenerationSizeMb: 8,
    });
    const outcome = await new Promise<{ kind: string }>((resolve) => {
      let done = false;
      const finish = (kind: string) => {
        if (done) return;
        done = true;
        resolve({ kind });
      };
      host.events.onError(() => finish("error"));
      host.events.onExit((_code, expected) => {
        if (!expected) finish("exit");
      });
      host.events.onScriptThrew(() => finish("threw")); // acceptable: some Node versions raise this as a catchable RangeError instead
    });
    expect(["error", "exit", "threw"]).toContain(outcome.kind);
    await host.terminate("test-done");
  }, 15_000);
});

describe("WC05: terminate() confirms even while the worker is busy (no host RPC to await yet in M3.1 — modeled as a busy microtask loop)", () => {
  it("terminate() resolves boundedly for a worker stuck in an unresolvable await-chain", async () => {
    const script = scriptWith("await new Promise(() => {});"); // never resolves
    const host = createWorkerHost({ clock: systemClock });
    await host.boot({
      scriptSource: script,
      scriptSliceMs: 200,
      heartbeatMs: 0,
      workerBootMs: 5_000,
      terminateConfirmMs: 1_000,
    });
    const start = Date.now();
    const result = await host.terminate("test-done");
    expect(Date.now() - start).toBeLessThan(2_000);
    expect(result.detached).toBe(true);
  }, 10_000);
});

describe("WC06: heartbeat SharedArrayBuffer visibility is genuinely cross-thread", () => {
  it("Atomics.store from the worker thread is observed via Atomics.load on the host thread", async () => {
    const host = createWorkerHost({ clock: systemClock });
    // The script itself returns immediately; what's under test is that the
    // *trusted scaffold's* heartbeat setInterval keeps ticking on the worker
    // thread afterwards (it is idle, not busy), and that Atomics.load on the
    // host thread observes those cross-thread stores. (A script that never
    // yields to the worker's macrotask queue — e.g. a pure microtask spin —
    // would starve even this trusted timer; see WC02's finding that heartbeat
    // is a best-effort diagnostic, not a guarantee, for exactly that reason.)
    await host.boot({
      scriptSource: scriptWith("return 1;"),
      scriptSliceMs: 2_000,
      heartbeatMs: 20,
      workerBootMs: 5_000,
      terminateConfirmMs: 1_000,
    });
    const seqs: number[] = [];
    for (let i = 0; i < 5; i += 1) {
      await new Promise((r) => setTimeout(r, 30));
      seqs.push(host.readHeartbeat().seq);
    }
    expect(new Set(seqs).size).toBeGreaterThan(1); // seq actually advanced across multiple polls
    await host.terminate("test-done");
  }, 10_000);
});

describe("WC07: sandbox denylist — dangerous globals are unavailable inside the user script's vm context", () => {
  const cases: Array<{ label: string; body: string; expect: RegExp }> = [
    { label: "eval", body: "eval('1+1');", expect: /eval/i },
    { label: "new Function", body: "new Function('return 1')();", expect: /not defined|code generation|function/i },
    { label: "require", body: "require('node:fs');", expect: /not (a )?function|not defined/i },
    { label: "process", body: "process.exit(0);", expect: /cannot read propert|not defined/i },
    { label: "Atomics", body: "Atomics.load(new Int32Array(1), 0);", expect: /cannot read propert|not defined/i },
    { label: "SharedArrayBuffer", body: "new SharedArrayBuffer(4);", expect: /not a constructor|not defined/i },
    { label: "Date.now", body: "Date.now();", expect: /Date\.now\(\) is disabled/i },
    { label: "new Date", body: "new Date();", expect: /Date is disabled/i },
    { label: "Math.random", body: "Math.random();", expect: /Math\.random\(\) is disabled/i },
  ];
  for (const c of cases) {
    it(`${c.label} is blocked`, async () => {
      const outcome = await runOnce(scriptWith(c.body));
      expect(outcome.threw).toBeDefined();
      expect(outcome.threw?.message).toMatch(c.expect);
      await outcome.host.terminate("test-done");
    }, 10_000);
  }

  it("log() and a well-behaved return value both work (the sandbox is not so locked down it's useless)", async () => {
    const outcome = await runOnce(scriptWith("log('hello from sandbox');\nreturn { ok: true, n: 42 };"));
    expect(outcome.returned).toEqual({ ok: true, n: 42 });
    await outcome.host.terminate("test-done");
  }, 10_000);
});
