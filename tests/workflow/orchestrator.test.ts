import { describe, expect, it, vi } from "vitest";
import { FakeClock } from "../../src/core/clock.js";
import { createWorkerHost } from "../../src/workflow/lifecycle.js";
import { createOrchestrator, type OrchestratorRunRequest } from "../../src/workflow/orchestrator.js";
import { createOrchestratorForTest } from "../../src/workflow/orchestrator.testing.js";
import type { WorkflowRunBudget } from "../../src/workflow/types.js";
import { fakeSpawnWorkerFactory } from "./helpers.js";

const BASE_BUDGET: WorkflowRunBudget = {
  scriptLoadMs: 1_000,
  scriptSliceMs: 1_000,
  workerBootMs: 1_000,
  heartbeatMs: 100,
  heartbeatStallMs: 2_000,
  terminateConfirmMs: 500,
  workflowTotalMs: 5_000,
  runawayPolicy: "diagnose_only",
};

const VALID_SCRIPT = 'export const meta = { name: "t", description: "t" };\nlog(\'hi\');\nreturn 1;';

function makeDeps(clock: FakeClock, spawnOpts?: Parameters<typeof fakeSpawnWorkerFactory>[0]) {
  const factory = fakeSpawnWorkerFactory(spawnOpts);
  const deps = {
    clock,
    createWorkerHost: () => createWorkerHost({ clock, spawnWorker: factory.spawnWorker }),
  };
  return { deps, factory };
}

function req(overrides: Partial<OrchestratorRunRequest> = {}): OrchestratorRunRequest {
  return { workflowId: "wf_test", script: VALID_SCRIPT, budget: BASE_BUDGET, ...overrides };
}

describe("orchestrator.ts (M3.1 skeleton: boot -> script -> settle)", () => {
  it("already-aborted signal never boots a worker and returns aborted immediately", async () => {
    const clock = new FakeClock();
    const { deps, factory } = makeDeps(clock);
    const orch = createOrchestrator(deps);
    const controller = new AbortController();
    controller.abort();
    const outcome = await orch.run(req({ signal: controller.signal }));
    expect(outcome.status).toBe("aborted");
    expect(outcome.stopCause).toBe("user_stop");
    expect(() => factory.worker()).toThrow(); // spawnWorker was never called
  });

  it("rejects an over-size script within scriptLoadMs, before ever booting a worker", async () => {
    const clock = new FakeClock();
    const { deps, factory } = makeDeps(clock);
    const orch = createOrchestrator(deps);
    const huge = "x".repeat(600 * 1024);
    const outcome = await orch.run(req({ script: huge }));
    expect(outcome.status).toBe("failed");
    expect(outcome.error?.message).toMatch(/byte limit/);
    expect(() => factory.worker()).toThrow();
  });

  it("HB1 misconfiguration (heartbeatStallMs too small) throws synchronously instead of producing a workflow outcome", async () => {
    const clock = new FakeClock();
    const { deps } = makeDeps(clock);
    const orch = createOrchestrator(deps);
    await expect(orch.run(req({ budget: { ...BASE_BUDGET, heartbeatStallMs: 100 } }))).rejects.toThrow(/HB1 violated/);
  });

  it("W14: worker boot never comes online -> timed_out(worker_boot), bounded by workerBootMs + terminateConfirmMs", async () => {
    const clock = new FakeClock();
    const { deps } = makeDeps(clock, { autoOnline: false });
    const orch = createOrchestrator(deps);
    const runPromise = orch.run(req());
    // Let the (already-resolved) script_load check's microtask settle before
    // advancing the FakeClock, otherwise its armed withDeadline timer can win
    // the race purely as a FakeClock test artifact (a real Clock's timer
    // never beats an already-resolved promise's microtask).
    await new Promise((r) => setTimeout(r, 0));
    // boot() races workerBootMs; the fake worker's terminate() (called during
    // the boot-failure cleanup path) resolves immediately, so no further
    // advance is needed for S7.
    clock.advance(BASE_BUDGET.workerBootMs);
    const outcome = await runPromise;
    expect(outcome.status).toBe("timed_out");
    expect(outcome.timeoutReason).toBe("worker_boot");
    expect(outcome.durationMs).toBeLessThanOrEqual(BASE_BUDGET.workerBootMs + BASE_BUDGET.terminateConfirmMs);
  });

  it("meta_error is reported as failed(script_error)", async () => {
    const clock = new FakeClock();
    const { deps, factory } = makeDeps(clock);
    const orch = createOrchestrator(deps);
    const runPromise = orch.run(req());
    await new Promise((r) => setTimeout(r, 0)); // let boot's 'online' microtask + boot() resolve
    factory.worker().emit("online"); // no-op if already fired; harmless
    // Simulate the worker reporting a meta parse failure over the port.
    await new Promise((r) => setTimeout(r, 0));
    factory.workerData().commPort.postMessage({ kind: "meta_error", message: "bad meta" });
    const outcome = await runPromise;
    expect(outcome.status).toBe("failed");
    expect(outcome.stopCause).toBe("script_error");
    expect(outcome.error?.message).toBe("bad meta");
  });

  it("script_returned settles as completed with the script's result", async () => {
    const clock = new FakeClock();
    const { deps, factory } = makeDeps(clock);
    const orch = createOrchestrator(deps);
    const runPromise = orch.run(req());
    await new Promise((r) => setTimeout(r, 0));
    factory.workerData().commPort.postMessage({ kind: "script_returned", result: 42 });
    const outcome = await runPromise;
    expect(outcome.status).toBe("completed");
    expect(outcome.result).toBe(42);
    expect(outcome.pendingReconcile).toBe(false);
  });

  it("W04: worker error (e.g. stack overflow) settles bounded as failed(worker_died)", async () => {
    const clock = new FakeClock();
    const { deps, factory } = makeDeps(clock);
    const orch = createOrchestrator(deps);
    const runPromise = orch.run(req());
    await new Promise((r) => setTimeout(r, 0));
    factory.worker().emit("error", new Error("Maximum call stack size exceeded"));
    const outcome = await runPromise;
    expect(outcome.status).toBe("failed");
    expect(outcome.stopCause).toBe("worker_died");
    expect(outcome.error?.message).toMatch(/call stack/);
  });

  it("W05: unexpected worker exit (e.g. OOM kill) settles bounded as failed(worker_died)", async () => {
    const clock = new FakeClock();
    const { deps, factory } = makeDeps(clock);
    const orch = createOrchestrator(deps);
    const runPromise = orch.run(req());
    await new Promise((r) => setTimeout(r, 0));
    factory.worker().emit("exit", 1);
    const outcome = await runPromise;
    expect(outcome.status).toBe("failed");
    expect(outcome.stopCause).toBe("worker_died");
    expect(outcome.error?.message).toMatch(/exited unexpectedly with code 1/);
  });

  it("an EXPECTED exit (host already drove terminate) never produces a failed(worker_died) outcome", async () => {
    // Regression guard for the `expected` flag threaded through onExit:
    // completing normally terminates the worker itself, so a subsequent
    // native 'exit' from that same worker must not be misclassified.
    const clock = new FakeClock();
    const { deps, factory } = makeDeps(clock);
    const orch = createOrchestrator(deps);
    const runPromise = orch.run(req());
    await new Promise((r) => setTimeout(r, 0));
    factory.workerData().commPort.postMessage({ kind: "script_returned", result: "ok" });
    const outcome = await runPromise;
    expect(outcome.status).toBe("completed"); // not overwritten by the exit event terminate() itself triggers
  });

  it("WT8: absolute workflowTotalMs deadline fires even though the worker never sends anything (never-resolving script)", async () => {
    const clock = new FakeClock();
    const { deps } = makeDeps(clock);
    const orch = createOrchestrator(deps);
    const runPromise = orch.run(req());
    await new Promise((r) => setTimeout(r, 0));
    clock.advance(BASE_BUDGET.workflowTotalMs);
    const outcome = await runPromise;
    expect(outcome.status).toBe("timed_out");
    expect(outcome.timeoutReason).toBe("workflow_total");
    expect(outcome.durationMs).toBeLessThanOrEqual(BASE_BUDGET.workflowTotalMs + BASE_BUDGET.terminateConfirmMs);
  });

  it("user_stop via AbortSignal after boot settles as aborted", async () => {
    const clock = new FakeClock();
    const { deps } = makeDeps(clock);
    const orch = createOrchestrator(deps);
    const controller = new AbortController();
    const runPromise = orch.run(req({ signal: controller.signal }));
    await new Promise((r) => setTimeout(r, 0));
    controller.abort();
    const outcome = await runPromise;
    expect(outcome.status).toBe("aborted");
    expect(outcome.stopCause).toBe("user_stop");
  });

  it("W35: terminate()'s S7 hangs forever, but the workflow still settles within deadlineAt + terminateConfirmMs (GW1a/GW1b upper bound holds independent of terminate() success)", async () => {
    const clock = new FakeClock();
    const { deps, factory } = makeDeps(clock, { hangOnTerminate: true });
    const orch = createOrchestrator(deps);
    const start = clock.now();
    const runPromise = orch.run(req());
    await new Promise((r) => setTimeout(r, 0));
    factory.workerData().commPort.postMessage({ kind: "script_returned", result: "done" });
    await new Promise((r) => setTimeout(r, 0));
    clock.advance(BASE_BUDGET.terminateConfirmMs);
    const outcome = await runPromise;

    expect(outcome.status).toBe("completed");
    expect(outcome.result).toBe("done");
    expect(outcome.diag.orphanWorker).toBeDefined(); // terminate() never confirmed -> honestly reported, not swept under the rug
    expect(clock.now() - start).toBeLessThanOrEqual(BASE_BUDGET.terminateConfirmMs + 1);
  });

  it("createOrchestratorForTest builds a working orchestrator identical in behavior to the production factory (M3.1 hook skeleton is a pass-through)", async () => {
    const clock = new FakeClock();
    const { deps, factory } = makeDeps(clock);
    const orch = createOrchestratorForTest(deps, {});
    const runPromise = orch.run(req());
    await new Promise((r) => setTimeout(r, 0));
    factory.workerData().commPort.postMessage({ kind: "script_returned", result: "via-test-factory" });
    const outcome = await runPromise;
    expect(outcome.status).toBe("completed");
    expect(outcome.result).toBe("via-test-factory");
  });

  it("L3 gate: the production factory throws if a caller smuggles __testHooks past the type system with `as any`", () => {
    const clock = new FakeClock();
    const { deps } = makeDeps(clock);
    const smuggled = { ...deps, __testHooks: {} } as unknown as Parameters<typeof createOrchestrator>[0];
    expect(() => createOrchestrator(smuggled)).toThrow(/test hooks are not permitted in the production factory/);
  });
});

describe("HB2 (§2.3): heartbeat stall alone never terminates under the default diagnose_only policy", () => {
  it("W02c analogue: a fake worker reporting a stalled heartbeat for far longer than heartbeatStallMs still lets the script complete normally", async () => {
    const clock = new FakeClock();
    const { deps, factory } = makeDeps(clock);
    const orch = createOrchestrator(deps);
    const runPromise = orch.run(
      req({ budget: { ...BASE_BUDGET, runawayPolicy: "diagnose_only", workflowTotalMs: 60_000 } }),
    );
    await new Promise((r) => setTimeout(r, 0));
    // Advance well past heartbeatStallMs without ever completing — diagnose_only must not react.
    clock.advance(BASE_BUDGET.heartbeatStallMs * 3);
    factory.workerData().commPort.postMessage({ kind: "script_returned", result: "still-fine" });
    const outcome = await runPromise;
    expect(outcome.status).toBe("completed");
    expect(outcome.result).toBe("still-fine");
  });

  it("terminate_on_stall does escalate to failed(runaway) once the heartbeat SAB genuinely stops advancing", async () => {
    const clock = new FakeClock();
    const factory = fakeSpawnWorkerFactory();
    const deps = { clock, createWorkerHost: () => createWorkerHost({ clock, spawnWorker: factory.spawnWorker }) };
    const orch = createOrchestrator(deps);
    const runPromise = orch.run(req({ budget: { ...BASE_BUDGET, runawayPolicy: "terminate_on_stall" } }));
    await new Promise((r) => setTimeout(r, 0));
    // Never write to the heartbeat SAB (the fake worker doesn't run the real
    // scaffold), so readHeartbeat()'s stalledMs grows monotonically with the clock.
    clock.advance(BASE_BUDGET.heartbeatStallMs + BASE_BUDGET.heartbeatMs);
    const outcome = await runPromise;
    expect(outcome.status).toBe("failed");
    expect(outcome.stopCause).toBe("runaway");
  });
});

void vi; // (imported for consistency with other test files even where unused directly)
