import { describe, expect, it } from "vitest";
import { FakeClock } from "../../src/core/clock.js";
import { createWorkerHost } from "../../src/workflow/lifecycle.js";
import { attachHostCallHandler, type ChildSpawner, type GateRunner } from "../../src/workflow/host.js";
import { createOrchestrator, type OrchestratorRunRequest } from "../../src/workflow/orchestrator.js";
import { createOrchestratorForTest } from "../../src/workflow/orchestrator.testing.js";
import type { WorkflowRunBudget } from "../../src/workflow/types.js";
import { fakeSpawnWorkerFactory } from "./helpers.js";

/**
 * M3.3 (workflow design section 7 abort propagation, section 3.8.1 TestHooks):
 * the WL1-WL4 escalation pipeline (host.ts's stopOwned + orchestrator.ts's
 * stop/outcomeAt1/settled), plus the effect hooks wired through
 * orchestrator.testing.ts.
 *
 * Documented scope note (see orchestrator.ts's module doc for the full
 * rationale): this milestone does not build the full section-3.4
 * reduce/effect state machine - every trigger source (Esc, WT8, worker
 * death, script error, external stop()) converges on one escalation path
 * that performs WL1 (close_gate) -> WL2 (stop_owned, bounded wait) -> WL3
 * (terminate_worker) -> WL4 (inline reconcile) -> resolve_settled, in that
 * order, exactly once per run. These tests assert that pipeline's real,
 * observable behavior - not a simulated reduce trace.
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
  abortGraceMs: 1_000,
};

async function flush(n = 3): Promise<void> {
  for (let i = 0; i < n; i += 1) await new Promise((r) => setTimeout(r, 0));
}

// ---------------------------------------------------------------------------
// A. host.ts `stopOwned` -- WL1/WL2/WL4 (inline reconcile), driven directly.
// ---------------------------------------------------------------------------

function hostHarness() {
  const clock = new FakeClock();
  const { spawnWorker, workerData } = fakeSpawnWorkerFactory();
  const workerHost = createWorkerHost({ clock, spawnWorker });
  return {
    clock,
    workerHost,
    async boot() {
      await workerHost.boot({
        scriptSource: 'export const meta = { name: "t", description: "t" };',
        scriptSliceMs: 1_000,
        heartbeatMs: 0,
        workerBootMs: 1_000,
        terminateConfirmMs: 500,
      });
    },
    postHostCall(id: string, op: "agent" | "gate", args: unknown) {
      workerData().commPort.postMessage({ kind: "host_call", id, op, args });
    },
  };
}

const gateRunner: GateRunner = async () => ({ ok: true, code: 0, stdout: "", stderr: "" });

describe("host.ts stopOwned (WL1 close_gate + WL2 stop_owned + WL4 inline reconcile)", () => {
  it("WL1: closes the gate synchronously -- a new agent() admission arriving after stopOwned() is rejected as cancelled, not spawned", async () => {
    const h = hostHarness();
    await h.boot();
    let spawnCount = 0;
    const spawner: ChildSpawner = {
      spawn: async () => {
        spawnCount += 1;
        return { runId: "r1" };
      },
      abort: async () => true,
      waitAll: async () => new Promise(() => {}), // never settles -- irrelevant to this test
    };
    const handler = attachHostCallHandler({
      clock: h.clock,
      workerHost: h.workerHost,
      spawner,
      gateRunner,
      budget: BASE_BUDGET,
    });
    const stopPromise = handler.stopOwned("user_stop", 1_000);
    await stopPromise; // nothing was active, resolves immediately
    h.postHostCall("late-1", "agent", { prompt: "too late" });
    await flush();
    expect(spawnCount).toBe(0); // WL1: gate was already closed, no admission happened
  });

  it("WL2: an active call that genuinely settles within abortGraceMs is reported with its REAL outcome, not forced-aborted, and is not orphaned", async () => {
    const h = hostHarness();
    await h.boot();
    let resolveWaitAll!: (v: {
      settled: Array<{ runId: string; status: "completed"; text: string }>;
      pending: string[];
    }) => void;
    const spawner: ChildSpawner = {
      spawn: async () => ({ runId: "r1" }),
      abort: async () => false, // A2-style: abort doesn't immediately take effect
      waitAll: async () =>
        new Promise((resolve) => {
          resolveWaitAll = resolve as typeof resolveWaitAll;
        }),
    };
    const handler = attachHostCallHandler({
      clock: h.clock,
      workerHost: h.workerHost,
      spawner,
      gateRunner,
      budget: BASE_BUDGET,
    });
    h.postHostCall("c1", "agent", { prompt: "do work" });
    await flush();
    expect(handler.registry.listActive().length).toBe(1);

    const stopPromise = handler.stopOwned("user_stop", 1_000);
    await flush();
    // The child finishes for real, inside the grace window -- before the timer fires.
    resolveWaitAll({ settled: [{ runId: "r1", status: "completed", text: "finished for real" }], pending: [] });
    const { orphanChildren } = await stopPromise;

    expect(orphanChildren).toEqual([]);
    expect(handler.children).toHaveLength(1);
    expect(handler.children[0]?.status).toBe("completed");
    expect(handler.children[0]?.textPreview).toBe("finished for real");
    expect(h.clock.pendingTimers).toBe(0); // the grace timer was cleared on early drain, not left armed
  });

  it("WL4: an active call that never settles within abortGraceMs is force-settled as aborted and reported in orphanChildren (RC3)", async () => {
    const h = hostHarness();
    await h.boot();
    const spawner: ChildSpawner = {
      spawn: async () => ({ runId: "r2" }),
      abort: async () => false, // stuck in the A2 window for the whole test
      waitAll: async () => new Promise(() => {}), // never settles
    };
    const handler = attachHostCallHandler({
      clock: h.clock,
      workerHost: h.workerHost,
      spawner,
      gateRunner,
      budget: BASE_BUDGET,
    });
    h.postHostCall("c2", "agent", { prompt: "will hang" });
    await flush();

    const stopPromise = handler.stopOwned("timeout", 1_000);
    await flush();
    h.clock.advance(1_000);
    const { orphanChildren } = await stopPromise;

    expect(orphanChildren).toHaveLength(1);
    expect(orphanChildren[0]).toMatchObject({ runId: "r2", reason: "cancel_retry_exhausted" });
    expect(handler.children).toHaveLength(1);
    expect(handler.children[0]?.status).toBe("aborted"); // RC1: force-settled to a terminal status, not left "running"
    expect(handler.registry.listActive()).toEqual([]); // RC1: nothing left non-terminal in the registry either
  });

  it("idempotent (WI6): calling stopOwned twice does not double-record or double-cancel", async () => {
    const h = hostHarness();
    await h.boot();
    const spawner: ChildSpawner = {
      spawn: async () => ({ runId: "r3" }),
      abort: async () => true,
      waitAll: async () => ({ settled: [{ runId: "r3", status: "completed" as const, text: "ok" }], pending: [] }),
    };
    const handler = attachHostCallHandler({
      clock: h.clock,
      workerHost: h.workerHost,
      spawner,
      gateRunner,
      budget: BASE_BUDGET,
    });
    h.postHostCall("c3", "agent", { prompt: "x" });
    await flush();
    await handler.stopOwned("user_stop", 1_000);
    const second = await handler.stopOwned("user_stop", 1_000);
    expect(second.orphanChildren).toEqual([]); // no-op, not a re-derived orphan list
    expect(handler.children).toHaveLength(1); // not double-recorded
  });

  it("OS4 sweep: when the spawner supplies stopChildrenOf, stopOwned invokes it with the parentRunId and cause", async () => {
    const h = hostHarness();
    await h.boot();
    const sweepCalls: Array<{ parentRunId: string; cause: string }> = [];
    const spawner: ChildSpawner = {
      spawn: async () => ({ runId: "r4" }),
      abort: async () => true,
      waitAll: async () => ({ settled: [{ runId: "r4", status: "completed" as const, text: "ok" }], pending: [] }),
      stopChildrenOf: async (parentRunId, cause) => {
        sweepCalls.push({ parentRunId, cause });
        return { stopped: [], pending: [] };
      },
    };
    const handler = attachHostCallHandler({
      clock: h.clock,
      workerHost: h.workerHost,
      spawner,
      gateRunner,
      budget: BASE_BUDGET,
      parentRunId: "wf_parent_1",
    });
    h.postHostCall("c4", "agent", { prompt: "x" });
    await flush();
    await handler.stopOwned("parent_abort", 1_000);
    expect(sweepCalls).toEqual([{ parentRunId: "wf_parent_1", cause: "parent_abort" }]);
  });

  it("Minor fix regression (section 4.4.3 BW1/BW3): agent()'s spawn request carries budgetOverride.{totalMs,queueWaitMs}, not just the absolute deadlineAt", async () => {
    const h = hostHarness();
    await h.boot();
    const spawnCalls: Array<Parameters<ChildSpawner["spawn"]>[0]> = [];
    const spawner: ChildSpawner = {
      spawn: async (spawnReq) => {
        spawnCalls.push(spawnReq);
        return { runId: "r5" };
      },
      abort: async () => true,
      waitAll: async () => ({ settled: [{ runId: "r5", status: "completed" as const, text: "ok" }], pending: [] }),
    };
    attachHostCallHandler({
      clock: h.clock,
      workerHost: h.workerHost,
      spawner,
      gateRunner,
      budget: { ...BASE_BUDGET, workflowTotalMs: 60_000 },
      workflowDeadlineAt: h.clock.now() + 60_000,
    });
    h.postHostCall("c5", "agent", { prompt: "x" });
    await flush();
    expect(spawnCalls).toHaveLength(1);
    const call = spawnCalls[0]!;
    expect(call.deadlineAt).toBeDefined();
    expect(call.budgetOverride).toBeDefined();
    expect(call.budgetOverride?.totalMs).toBeGreaterThan(0);
    expect(call.budgetOverride?.queueWaitMs).toBeGreaterThan(0);
    // BW3: queueWaitMs must never exceed the child's own totalMs.
    expect(call.budgetOverride!.queueWaitMs!).toBeLessThanOrEqual(call.budgetOverride!.totalMs!);
  });
});

// ---------------------------------------------------------------------------
// B. orchestrator.ts -- outcomeAt1()/settled()/stop() and the six-effect hooks.
// ---------------------------------------------------------------------------

function makeOrchDeps(clock: FakeClock, spawner?: ChildSpawner) {
  const factory = fakeSpawnWorkerFactory();
  const deps = {
    clock,
    createWorkerHost: () => createWorkerHost({ clock, spawnWorker: factory.spawnWorker }),
    ...(spawner ? { spawner } : {}),
    gateRunner,
  };
  return { deps, factory };
}

function req(overrides: Partial<OrchestratorRunRequest> = {}): OrchestratorRunRequest {
  return {
    workflowId: "wf_abort_test",
    script: 'export const meta = { name: "t", description: "t" };\nreturn 1;',
    budget: BASE_BUDGET,
    ...overrides,
  };
}

describe("orchestrator.ts: outcomeAt1()/settled()/stop() (section 3.8, section 4.3.1.1)", () => {
  it("W44-style: outcomeAt1() is readable at (1) (pendingReconcile:true) strictly before settled() resolves at (2)", async () => {
    const clock = new FakeClock();
    // An active, never-(auto)-settling child forces a real ①→② window (WL2's
    // bounded wait genuinely has something to wait on) instead of the whole
    // pipeline collapsing within the same microtask flush.
    const spawner: ChildSpawner = {
      spawn: async () => ({ runId: "r1" }),
      abort: async () => false,
      waitAll: async () => new Promise(() => {}),
    };
    const { deps, factory } = makeOrchDeps(clock, spawner);
    const orch = createOrchestrator(deps);
    const runPromise = orch.run(req());
    await flush();
    factory.workerData().commPort.postMessage({ kind: "host_call", id: "c1", op: "agent", args: { prompt: "x" } });
    await flush();

    const stopPromise = orch.stop("wf_abort_test", "user_stop");
    await flush();

    const at1 = orch.outcomeAt1("wf_abort_test");
    expect(at1).toBeDefined();
    expect(at1?.pendingReconcile).toBe(true);
    expect(at1?.status).toBe("aborted");

    clock.advance(BASE_BUDGET.abortGraceMs ?? 10_000);
    await stopPromise;
    const outcome = await runPromise;
    expect(outcome.pendingReconcile).toBe(false);
    expect(outcome.status).toBe("aborted");
    // RC1/RC3: the never-settling child didn't make it into the grace window -> orphaned, not left non-terminal.
    expect(outcome.orphanChildren).toHaveLength(1);
  });

  it("stop() is idempotent under concurrent calls (W37 analogue): all callers observe the same single settlement", async () => {
    const clock = new FakeClock();
    const { deps } = makeOrchDeps(clock);
    const orch = createOrchestrator(deps);
    const runPromise = orch.run(req());
    await flush();
    const results = await Promise.all([
      orch.stop("wf_abort_test", "user_stop"),
      orch.stop("wf_abort_test", "user_stop"),
      orch.stop("wf_abort_test", "user_stop"),
    ]);
    const outcome = await runPromise;
    expect(results.every((r) => r.ok)).toBe(true);
    expect(outcome.status).toBe("aborted");
    // A second stop() after the run has already settled and been reaped reports ok:false, not an error.
    const late = await orch.stop("wf_abort_test", "user_stop");
    expect(late.ok).toBe(false);
  });

  it("unknown workflowId: stop()/settled() report absence rather than hanging or throwing unexpectedly", async () => {
    const clock = new FakeClock();
    const { deps } = makeOrchDeps(clock);
    const orch = createOrchestrator(deps);
    expect(orch.outcomeAt1("wf_never_ran")).toBeUndefined();
    await expect(orch.stop("wf_never_ran", "user_stop")).resolves.toEqual({ ok: false });
    await expect(orch.settled("wf_never_ran")).rejects.toThrow(/no run found/);
  });
});

describe("orchestrator.testing.ts hooks: WL0-WL4 effect instrumentation (section 3.8.1)", () => {
  it("W37/WP2 analogue: onEffectApplied fires each of the six effects exactly once, in the design's order", async () => {
    const clock = new FakeClock();
    const { deps } = makeOrchDeps(clock);
    const applied: string[] = [];
    const orch = createOrchestratorForTest(deps, {
      onEffectApplied: (kind) => applied.push(kind),
    });
    const runPromise = orch.run(req());
    await flush();
    void orch.stop("wf_abort_test", "user_stop");
    await flush();
    clock.advance(BASE_BUDGET.abortGraceMs ?? 10_000);
    await runPromise;

    expect(applied).toEqual([
      "commit_terminal",
      "close_gate",
      "stop_owned",
      "terminate_worker",
      "reconcile_children",
      "resolve_settled",
    ]);
  });

  it("W39: settledDelivery delayMs (< settlementGraceMs) delays (2) but the final outcome is still the real, non-degraded one", async () => {
    const clock = new FakeClock();
    const { deps, factory } = makeOrchDeps(clock);
    const orch = createOrchestratorForTest(deps, { settledDelivery: { delayMs: 200 } });
    const runPromise = orch.run(req());
    await flush();
    factory.workerData().commPort.postMessage({ kind: "script_returned", result: 1 });
    let resolved = false;
    void runPromise.then(() => {
      resolved = true;
    });
    await flush();
    expect(resolved).toBe(false); // still waiting on the injected delay
    clock.advance(200);
    const outcome = await runPromise;
    expect(outcome.pendingReconcile).toBe(false);
    expect(outcome.status).toBe("completed");
    expect(outcome.diag.degraded).toBeUndefined();
  });

  it("W39b: settledDelivery 'suppress' means (2) never arrives -- outcomeAt1() remains the only readable snapshot (tool-layer WT17 fallback is out of src/workflow/ scope, see orchestrator.ts's module doc)", async () => {
    const clock = new FakeClock();
    const { deps, factory } = makeOrchDeps(clock);
    const orch = createOrchestratorForTest(deps, { settledDelivery: "suppress" });
    const runPromise = orch.run(req());
    await flush();
    factory.workerData().commPort.postMessage({ kind: "script_returned", result: 1 });
    let resolved = false;
    void runPromise.then(() => {
      resolved = true;
    });
    await flush();
    clock.advance(10_000);
    await flush();
    expect(resolved).toBe(false); // (2) genuinely never arrives through the normal path
    const at1 = orch.outcomeAt1("wf_abort_test");
    expect(at1).toBeDefined();
    expect(at1?.pendingReconcile).toBe(true);
    expect(at1?.status).toBe("completed");
  });

  it("W39c: beforeEffect throws on resolve_settled -> EI5 fallback still resolves settled(), marked degraded, instead of hanging forever", async () => {
    const clock = new FakeClock();
    const { deps, factory } = makeOrchDeps(clock);
    const orch = createOrchestratorForTest(deps, {
      beforeEffect: (kind) => (kind === "resolve_settled" ? "throw" : "proceed"),
    });
    const runPromise = orch.run(req());
    await flush();
    factory.workerData().commPort.postMessage({ kind: "script_returned", result: 1 });
    const outcome = await runPromise;
    expect(outcome.diag.degraded).toBe("settlement_apply_failed");
    // EI5 fallback is still bounded and still reachable through settled().
    await expect(orch.settled("wf_abort_test")).resolves.toMatchObject({
      diag: { degraded: "settlement_apply_failed" },
    });
  });

  it("beforeEffect 'skip' on terminate_worker still lets the pipeline reach resolve_settled (EI2: best-effort effects degrade, they do not hang the pipeline)", async () => {
    const clock = new FakeClock();
    const { deps, factory } = makeOrchDeps(clock);
    const applied: string[] = [];
    const orch = createOrchestratorForTest(deps, {
      beforeEffect: (kind) => (kind === "terminate_worker" ? "skip" : "proceed"),
      onEffectApplied: (kind) => applied.push(kind),
    });
    const runPromise = orch.run(req());
    await flush();
    factory.workerData().commPort.postMessage({ kind: "script_returned", result: 1 });
    const outcome = await runPromise;
    expect(outcome.status).toBe("completed");
    expect(outcome.pendingReconcile).toBe(false);
    expect(applied).not.toContain("terminate_worker"); // skipped, not silently still applied
    expect(applied).toContain("resolve_settled");
  });
});
