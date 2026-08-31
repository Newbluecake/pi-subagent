import { describe, expect, it } from "vitest";
import { systemClock } from "../../src/core/clock.js";
import { attachHostCallHandler, type ChildSpawner } from "../../src/workflow/host.js";
import { createWorkerHost } from "../../src/workflow/lifecycle.js";
import type { WorkerHost } from "../../src/workflow/types.js";

/**
 * M3.2 verification Blocker B (fixed here): `HostAckEnvelope`/
 * `HostSettleEnvelope` (src/workflow/types.ts) previously had **no `kind`
 * field**, and `host.ts` sent them to the worker exactly as-is via
 * `WorkerHost.send()`. But `worker-source.ts`'s inbound dispatch
 * (`commPort.on("message", ...)`) switches on `msg.kind === "host_ack"` /
 * `"host_settle"` and silently drops anything that doesn't match. The net
 * effect: **every real `agent()`/`gate()` call's ack and settle were
 * dropped worker-side**, and the calling script's `await agent(...)` hung
 * until the worker-side HR1 client-side timeout fired (or, with a large
 * `hostCallMs`, effectively hung until WT8).
 *
 * `host.test.ts`'s M3.2 coverage never caught this because it always used a
 * `FakeWorkerHost` double whose `.send()` just records the payload — it
 * never round-tripped through the real worker-source.ts dispatcher (the
 * milestone task's own doc comment for `host.test.ts` references a
 * "wc-host-call.test.ts" that never existed — this file is that missing
 * test, under the name the M3.3 verification asked for).
 *
 * These tests boot a **real** `node:worker_threads` worker (via
 * `createWorkerHost`/`lifecycle.ts`, not a fake `WorkerLike`) running a
 * script that calls the real, unmodified `agent()`/`gate()` sandboxed
 * globals (worker-source.ts), and wire it to `attachHostCallHandler`
 * (host.ts) with a scripted `ChildSpawner` standing in for `SpawnService`.
 * If the `kind` field regresses, every one of these tests times out instead
 * of asserting a value — that is deliberate: HR1's own timeout message
 * ("did not settle before its deadline") is itself the regression signal.
 */

function scriptWith(body: string): string {
  return `export const meta = { name: "t", description: "t" };\n${body}`;
}

async function bootReal(
  script: string,
  spawner: ChildSpawner,
): Promise<{ host: WorkerHost; outcome: Promise<{ returned?: unknown; threw?: { message: string } }> }> {
  const host = createWorkerHost({ clock: systemClock });
  attachHostCallHandler({
    clock: systemClock,
    workerHost: host,
    spawner,
    gateRunner: async () => ({ ok: true, code: 0, stdout: "", stderr: "" }),
    budget: {
      hostCallMs: 3_000,
      gateMs: 3_000,
      maxParallel: 4,
      maxChildren: 10,
      maxBatchItems: 10,
      childBudgetPolicy: "inherit_remaining",
    },
  });
  const boot = await host.boot({
    scriptSource: script,
    scriptSliceMs: 2_000,
    heartbeatMs: 0,
    workerBootMs: 5_000,
    terminateConfirmMs: 2_000,
    hostCallMs: 3_000,
    gateMs: 3_000,
  });
  expect(boot.ok).toBe(true);

  const outcome = new Promise<{ returned?: unknown; threw?: { message: string } }>((resolve) => {
    let done = false;
    host.events.onScriptReturned((returned) => {
      if (done) return;
      done = true;
      resolve({ returned });
    });
    host.events.onScriptThrew((threw) => {
      if (done) return;
      done = true;
      resolve({ threw });
    });
  });
  return { host, outcome };
}

describe("real-worker agent() host-call round trip (M3.2/M3.3 Blocker B regression coverage)", () => {
  it("a normal agent() call round-trips through the real worker and resolves to the fake child's result", async () => {
    const spawner: ChildSpawner = {
      spawn: async () => ({ runId: "r1" }),
      abort: async () => true,
      waitAll: async ({ runIds }) => ({
        settled: runIds.map((runId) => ({ runId, status: "completed" as const, text: "hello from child" })),
        pending: [],
      }),
    };
    const { host, outcome } = await bootReal(scriptWith('return await agent("do the thing");'), spawner);
    const result = await outcome;
    expect(result.threw).toBeUndefined();
    expect(result.returned).toBe("hello from child");
    await host.terminate("test-done");
  }, 10_000);

  it("a child that fails resolves agent() to null (§5.2/§5.3 upstream-plugin-compatible semantics), not a hang", async () => {
    const spawner: ChildSpawner = {
      spawn: async () => ({ runId: "r2" }),
      abort: async () => true,
      waitAll: async ({ runIds }) => ({
        settled: runIds.map((runId) => ({ runId, status: "failed" as const, error: { message: "child boom" } })),
        pending: [],
      }),
    };
    const { host, outcome } = await bootReal(
      scriptWith('const r = await agent("x"); return r === null ? "was-null" : "not-null:" + JSON.stringify(r);'),
      spawner,
    );
    const result = await outcome;
    expect(result.threw).toBeUndefined();
    expect(result.returned).toBe("was-null");
    await host.terminate("test-done");
  }, 10_000);

  it("an admission-time error (e.g. unknown agentType / budget exhausted) rejects agent(), catchable by the script", async () => {
    const spawner: ChildSpawner = {
      spawn: async () => ({ error: { message: "unknown agent type 'nope'" } }),
      abort: async () => true,
      waitAll: async () => ({ settled: [], pending: [] }),
    };
    const { host, outcome } = await bootReal(
      scriptWith(
        'try { await agent("x", { agentType: "nope" }); return "no-throw"; } ' +
          'catch (e) { return "caught:" + e.message; }',
      ),
      spawner,
    );
    const result = await outcome;
    expect(result.threw).toBeUndefined();
    expect(result.returned).toBe("caught:unknown agent type 'nope'");
    await host.terminate("test-done");
  }, 10_000);

  it("gate() also round-trips through the real worker (single-segment ack, same kind-tagged envelope)", async () => {
    const spawner: ChildSpawner = {
      spawn: async () => ({ runId: "unused" }),
      abort: async () => true,
      waitAll: async () => ({ settled: [], pending: [] }),
    };
    const { host, outcome } = await bootReal(scriptWith('const r = await gate("true"); return r.ok;'), spawner);
    const result = await outcome;
    expect(result.threw).toBeUndefined();
    expect(result.returned).toBe(true);
    await host.terminate("test-done");
  }, 10_000);
});
