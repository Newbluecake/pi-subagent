import { describe, expect, it } from "vitest";
import { FakeClock } from "../../src/core/clock.js";
import { createWorkerHost } from "../../src/workflow/lifecycle.js";
import {
  attachHostCallHandler,
  type ChildOutcome,
  type ChildSpawner,
  type GateRunner,
} from "../../src/workflow/host.js";
import type { WorkflowRunBudget } from "../../src/workflow/types.js";
import { fakeSpawnWorkerFactory } from "./helpers.js";

/**
 * §3.3/§3.5/§4.4 host.ts: driven entirely by `FakeClock` + the same
 * fake-worker harness `orchestrator.test.ts`/`lifecycle.test.ts` use — the
 * worker side of the protocol is simulated by posting `host_call` envelopes
 * directly onto the fake `MessagePort`, exactly like `orchestrator.test.ts`
 * simulates `script_returned`. This isolates host.ts's own logic (HR2, the
 * budget derivation call site, maxParallel/maxChildren enforcement, HR8)
 * from the real embedded scaffold — the scaffold's own half of the protocol
 * (HR1, the actual `agent()`/`gate()` sandbox functions) is covered
 * end-to-end with a real worker thread in wc-host-call.test.ts.
 */

const BASE_BUDGET: WorkflowRunBudget = {
  scriptLoadMs: 1_000,
  scriptSliceMs: 1_000,
  workerBootMs: 1_000,
  heartbeatMs: 0,
  heartbeatStallMs: 2_000,
  terminateConfirmMs: 500,
  workflowTotalMs: 60_000,
  runawayPolicy: "diagnose_only",
  hostCallMs: 5_000,
  gateMs: 5_000,
  maxParallel: 4,
  maxChildren: 500,
  maxBatchItems: 1024,
  childBudgetPolicy: "inherit_remaining",
};

function noopSpawner(): ChildSpawner {
  return {
    spawn: async () => ({ runId: "unused" }),
    abort: async () => true,
    waitAll: async () => ({ settled: [], pending: [] }),
  };
}

function harness(budgetOverrides: Partial<WorkflowRunBudget> = {}) {
  const clock = new FakeClock();
  const { spawnWorker, workerData } = fakeSpawnWorkerFactory();
  const workerHost = createWorkerHost({ clock, spawnWorker });
  const sent: unknown[] = [];
  return {
    clock,
    workerHost,
    workerData,
    sent,
    async boot() {
      await workerHost.boot({
        scriptSource: 'export const meta = { name: "t", description: "t" };',
        scriptSliceMs: 1_000,
        heartbeatMs: 0,
        workerBootMs: 1_000,
        terminateConfirmMs: 500,
      });
      workerData().commPort.on("message", (m) => sent.push(m));
    },
    postHostCall(id: string, op: "agent" | "gate", args: unknown) {
      workerData().commPort.postMessage({ kind: "host_call", id, op, args });
    },
    attach(spawner: ChildSpawner, gateRunner: GateRunner, workflowDeadlineAt?: number) {
      return attachHostCallHandler({
        clock,
        workerHost,
        spawner,
        gateRunner,
        budget: { ...BASE_BUDGET, ...budgetOverrides },
        ...(workflowDeadlineAt !== undefined ? { workflowDeadlineAt } : {}),
      });
    },
  };
}

async function flush(n = 3): Promise<void> {
  for (let i = 0; i < n; i += 1) await new Promise((r) => setTimeout(r, 0));
}

describe("host.ts: agent() call/ack/settle (§3.3 HR3)", () => {
  it("ack returns immediately (before the child settles); a separate host_settle arrives once waitAll() resolves", async () => {
    const h = harness();
    await h.boot();
    let resolveOutcome!: (o: { settled: ChildOutcome[]; pending: string[] }) => void;
    const spawner: ChildSpawner = {
      spawn: async () => ({ runId: "run1" }),
      abort: async () => true,
      waitAll: () => new Promise((resolve) => (resolveOutcome = resolve)),
    };
    h.attach(spawner, async () => ({ ok: true, code: 0, stdout: "", stderr: "" }));

    h.postHostCall("1", "agent", { prompt: "hello", opts: null });
    await flush();

    // HR3: the ack must have arrived even though waitAll() is still pending.
    const ack = h.sent.find((m) => (m as { id?: string }).id === "1") as {
      ok: boolean;
      value: { callId: string; deadlineAt?: number };
    };
    expect(ack).toBeDefined();
    expect(ack.ok).toBe(true);
    expect(ack.value.callId).toBe("1");
    expect(h.sent.some((m) => (m as { kind?: string }).kind === "host_settle")).toBe(false);

    resolveOutcome({ settled: [{ runId: "run1", status: "completed", text: "the answer" }], pending: [] });
    await flush();

    const settle = h.sent.find((m) => (m as { callId?: string }).callId === "1") as {
      ok: boolean;
      value: unknown;
    };
    expect(settle).toBeDefined();
    expect(settle.ok).toBe(true);
    expect(settle.value).toBe("the answer");
  });

  it("a failed child settles ok:false with the child's error, distinct from an admission-time ack failure", async () => {
    const h = harness();
    await h.boot();
    const spawner: ChildSpawner = {
      spawn: async () => ({ runId: "run1" }),
      abort: async () => true,
      waitAll: async () => ({
        settled: [{ runId: "run1", status: "failed", error: { message: "boom" } }],
        pending: [],
      }),
    };
    h.attach(spawner, async () => ({ ok: true, code: 0, stdout: "", stderr: "" }));
    h.postHostCall("1", "agent", { prompt: "hello", opts: null });
    await flush();
    const settle = h.sent.find((m) => (m as { callId?: string }).callId === "1") as {
      ok: boolean;
      error?: { message: string };
    };
    expect(settle.ok).toBe(false);
    expect(settle.error?.message).toBe("boom");
  });

  it("an admission-time spawn error (e.g. unknown agent type) acks ok:false and never produces a settle", async () => {
    const h = harness();
    await h.boot();
    const spawner: ChildSpawner = {
      spawn: async () => ({ error: { message: "unknown agent type: bogus" } }),
      abort: async () => true,
      waitAll: async () => ({ settled: [], pending: [] }),
    };
    h.attach(spawner, async () => ({ ok: true, code: 0, stdout: "", stderr: "" }));
    h.postHostCall("1", "agent", { prompt: "hello", opts: { agentType: "bogus" } });
    await flush();
    const ack = h.sent.find((m) => (m as { id?: string }).id === "1") as { ok: boolean; error?: { message: string } };
    expect(ack.ok).toBe(false);
    expect(ack.error?.message).toMatch(/unknown agent type/);
    expect(h.sent.some((m) => (m as { kind?: string }).kind === "host_settle")).toBe(false);
  });

  it("prompt type validation rejects before ever calling spawn()", async () => {
    const h = harness();
    await h.boot();
    let spawnCalls = 0;
    const spawner: ChildSpawner = {
      spawn: async () => {
        spawnCalls += 1;
        return { runId: "run1" };
      },
      abort: async () => true,
      waitAll: async () => ({ settled: [], pending: [] }),
    };
    h.attach(spawner, async () => ({ ok: true, code: 0, stdout: "", stderr: "" }));
    h.postHostCall("1", "agent", { prompt: 42, opts: null });
    await flush();
    expect(spawnCalls).toBe(0);
    const ack = h.sent.find((m) => (m as { id?: string }).id === "1") as { ok: boolean };
    expect(ack.ok).toBe(false);
  });
});

describe("host.ts: BW2 budget exhaustion (§4.4.3)", () => {
  it("agent() is rejected with WorkflowBudgetExhausted once the workflow has no remaining time", async () => {
    const h = harness();
    await h.boot();
    let spawnCalls = 0;
    const spawner: ChildSpawner = {
      spawn: async () => {
        spawnCalls += 1;
        return { runId: "run1" };
      },
      abort: async () => true,
      waitAll: async () => ({ settled: [], pending: [] }),
    };
    // workflowDeadlineAt already in the past relative to the FakeClock's t=0.
    h.attach(spawner, async () => ({ ok: true, code: 0, stdout: "", stderr: "" }), -1);
    h.postHostCall("1", "agent", { prompt: "hi", opts: null });
    await flush();
    expect(spawnCalls).toBe(0);
    const ack = h.sent.find((m) => (m as { id?: string }).id === "1") as { ok: boolean; error?: { message: string } };
    expect(ack.ok).toBe(false);
    expect(ack.error?.message).toMatch(/WorkflowBudgetExhausted/);
  });

  it("§4.4.3 numeric check: a successful spawn's ack carries a deadlineAt <= the workflow's own deadline", async () => {
    const h = harness();
    await h.boot();
    let capturedDeadlineAt: number | undefined;
    const spawner: ChildSpawner = {
      spawn: async (req) => {
        capturedDeadlineAt = req.deadlineAt;
        return { runId: "run1" };
      },
      abort: async () => true,
      waitAll: async () => ({ settled: [], pending: [] }),
    };
    const workflowDeadlineAt = 10_000;
    h.attach(spawner, async () => ({ ok: true, code: 0, stdout: "", stderr: "" }), workflowDeadlineAt);
    h.postHostCall("1", "agent", { prompt: "hi", opts: null });
    await flush();
    expect(capturedDeadlineAt).toBeDefined();
    expect(capturedDeadlineAt).toBeLessThanOrEqual(workflowDeadlineAt);
    const ack = h.sent.find((m) => (m as { id?: string }).id === "1") as {
      ok: boolean;
      value: { deadlineAt?: number };
    };
    expect(ack.value.deadlineAt).toBe(capturedDeadlineAt);
  });
});

describe("host.ts: maxParallel/maxChildren (§5.3)", () => {
  it("maxParallel rejects a new agent() call while the cap's worth of children are still active", async () => {
    const h = harness({ maxParallel: 1 });
    await h.boot();
    let resolveFirst!: (o: { settled: ChildOutcome[]; pending: string[] }) => void;
    let spawnCount = 0;
    const spawner: ChildSpawner = {
      spawn: async () => {
        spawnCount += 1;
        return { runId: `run${spawnCount}` };
      },
      abort: async () => true,
      waitAll: () => new Promise((resolve) => (resolveFirst = resolve)),
    };
    h.attach(spawner, async () => ({ ok: true, code: 0, stdout: "", stderr: "" }));
    h.postHostCall("1", "agent", { prompt: "one", opts: null });
    await flush();
    h.postHostCall("2", "agent", { prompt: "two", opts: null });
    await flush();
    expect(spawnCount).toBe(1); // the 2nd call was rejected before ever reaching spawn()
    const ack2 = h.sent.find((m) => (m as { id?: string }).id === "2") as { ok: boolean; error?: { message: string } };
    expect(ack2.ok).toBe(false);
    expect(ack2.error?.message).toMatch(/maxParallel/);
    resolveFirst({ settled: [{ runId: "run1", status: "completed", text: "ok" }], pending: [] });
    await flush();
  });

  it("maxChildren rejects once the workflow-wide cap is hit, even after earlier children have settled", async () => {
    const h = harness({ maxChildren: 1 });
    await h.boot();
    const spawner: ChildSpawner = {
      spawn: async () => ({ runId: "run1" }),
      abort: async () => true,
      waitAll: async () => ({ settled: [{ runId: "run1", status: "completed", text: "ok" }], pending: [] }),
    };
    h.attach(spawner, async () => ({ ok: true, code: 0, stdout: "", stderr: "" }));
    h.postHostCall("1", "agent", { prompt: "one", opts: null });
    await flush();
    h.postHostCall("2", "agent", { prompt: "two", opts: null });
    await flush();
    const ack2 = h.sent.find((m) => (m as { id?: string }).id === "2") as { ok: boolean; error?: { message: string } };
    expect(ack2.ok).toBe(false);
    expect(ack2.error?.message).toMatch(/maxChildren/);
  });
});

describe("host.ts: gate() (WT6)", () => {
  it("gate() ack carries the exec result (single-segment RPC)", async () => {
    const h = harness();
    await h.boot();
    const gateRunner: GateRunner = async (cmd) => ({ ok: true, code: 0, stdout: `ran: ${cmd}`, stderr: "" });
    h.attach(noopSpawner(), gateRunner);
    h.postHostCall("1", "gate", { cmd: "echo hi" });
    await flush();
    const ack = h.sent.find((m) => (m as { id?: string }).id === "1") as { ok: boolean; value: { stdout: string } };
    expect(ack.ok).toBe(true);
    expect(ack.value.stdout).toBe("ran: echo hi");
  });

  it("gate() acks ok:false when the gateRunner rejects", async () => {
    const h = harness();
    await h.boot();
    const gateRunner: GateRunner = async () => {
      throw new Error("exec failed");
    };
    h.attach(noopSpawner(), gateRunner);
    h.postHostCall("1", "gate", { cmd: "false" });
    await flush();
    const ack = h.sent.find((m) => (m as { id?: string }).id === "1") as { ok: boolean; error?: { message: string } };
    expect(ack.ok).toBe(false);
    expect(ack.error?.message).toBe("exec failed");
  });
});

describe("HR2: a host handler that hangs (spawner.spawn never resolves) is bounded by hostCallMs", () => {
  it("the ack times out at hostCallMs instead of hanging forever, and the eventual late spawn/settle is harmless", async () => {
    const h = harness({ hostCallMs: 1_000 });
    await h.boot();
    let resolveSpawn: ((r: { runId: string }) => void) | undefined;
    const spawner: ChildSpawner = {
      spawn: () => new Promise((resolve) => (resolveSpawn = resolve)), // never resolves within the test's timeline
      abort: async () => true,
      waitAll: async () => ({ settled: [{ runId: "run1", status: "completed", text: "late" }], pending: [] }),
    };
    h.attach(spawner, async () => ({ ok: true, code: 0, stdout: "", stderr: "" }));
    h.postHostCall("1", "agent", { prompt: "hi", opts: null });
    await flush();
    expect(h.sent.length).toBe(0); // nothing sent yet — spawn() is still hanging.

    h.clock.advance(1_000);
    await flush();
    const ack = h.sent.find((m) => (m as { id?: string }).id === "1") as { ok: boolean; error?: { message: string } };
    expect(ack).toBeDefined();
    expect(ack.ok).toBe(false);
    expect(ack.error?.message).toMatch(/did not complete within 1000ms \(HR2\)/);

    // The late spawn eventually "resolves" (simulating a slow but not
    // infinitely-hung backend) — this must not crash or double-send onto an
    // already-answered call id.
    resolveSpawn?.({ runId: "run1" });
    await flush();
    expect(h.sent.filter((m) => (m as { id?: string }).id === "1").length).toBe(1); // still exactly one ack
  });
});

describe("HR8: terminate() rejects every pending host call (§3.3 HR8)", () => {
  it("a still-running child's pending settle is resolved as aborted the moment terminate() fires, not left dangling", async () => {
    const h = harness();
    await h.boot();
    const spawner: ChildSpawner = {
      spawn: async () => ({ runId: "run1" }),
      abort: async () => true,
      waitAll: () => new Promise(() => {}), // never settles on its own
    };
    const handler = h.attach(spawner, async () => ({ ok: true, code: 0, stdout: "", stderr: "" }));
    h.postHostCall("1", "agent", { prompt: "hi", opts: null });
    await flush();
    expect(handler.registry.resolve("1")?.phase).toBe("running");

    await h.workerHost.terminate("workflow_completed");
    await flush();

    expect(handler.registry.resolve("1")?.phase).toBe("settled");
    const settleMsg = h.sent.find((m) => (m as { callId?: string }).callId === "1") as { ok: boolean };
    expect(settleMsg).toBeDefined();
    expect(settleMsg.ok).toBe(false);
    expect(handler.children.some((c) => c.callId === "1" && c.status === "aborted")).toBe(true);
  });

  it("a call still in admission when terminate() fires is recorded as withheld, not left unresolved", async () => {
    const h = harness();
    await h.boot();
    const spawner: ChildSpawner = {
      spawn: () => new Promise(() => {}), // never resolves — still in admission at terminate() time
      abort: async () => true,
      waitAll: async () => ({ settled: [], pending: [] }),
    };
    const handler = h.attach(spawner, async () => ({ ok: true, code: 0, stdout: "", stderr: "" }));
    h.postHostCall("1", "agent", { prompt: "hi", opts: null });
    await flush();
    expect(handler.registry.resolve("1")?.phase).toBe("admission");

    await h.workerHost.terminate("workflow_timed_out");
    expect(handler.children.some((c) => c.callId === "1" && c.status === "withheld")).toBe(true);
  });

  it("a host_call arriving after terminate() has zero effect — S5 has already physically closed the port, so it is never even delivered to host.ts's listener", async () => {
    const h = harness();
    await h.boot();
    const handler = h.attach(noopSpawner(), async () => ({ ok: true, code: 0, stdout: "", stderr: "" }));
    await h.workerHost.terminate("workflow_completed");
    h.postHostCall("1", "agent", { prompt: "too late", opts: null });
    await flush();
    // §2.3.1 S5 (WC09): the host's end of the `MessagePort` is closed before
    // `terminate()` resolves, independent of this module's own `terminated`
    // flag — the flag (checked in the `onHostCall` listener above) is
    // defense-in-depth for a delivery-ordering edge case that cannot actually
    // occur once S5 has run, not something this test can reach through the
    // port. The observable, physically-accurate guarantee is: nothing about
    // this call is ever recorded, and nothing is ever sent for it.
    expect(handler.registry.resolve("1")).toBeUndefined();
    expect(h.sent.find((m) => (m as { id?: string }).id === "1")).toBeUndefined();
  });
});
