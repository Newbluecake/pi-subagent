import { describe, expect, it } from "vitest";
import { systemClock } from "../../src/core/clock.js";
import { createWorkerHost } from "../../src/workflow/lifecycle.js";
import { createOrchestrator, type OrchestratorRunRequest } from "../../src/workflow/orchestrator.js";
import type { WorkflowRunBudget } from "../../src/workflow/types.js";

/**
 * WC02 gate check (workflow design §2.4/§12): the milestone's single
 * architectural pass/fail gate. §2.4's R2 revision narrowed the actual gate
 * to WC09 (verified in tests/workflow/lifecycle.test.ts — port.close() makes
 * a still-running worker's messages physically unreachable); WC02 itself
 * ("vm timeout does not catch a post-await microtask loop") is *expected* to
 * fail as a P1-coverage claim — the design says so explicitly — and GW1a/GW1b
 * must hold anyway via the workflowTotalMs deadline + terminate()'s bounded
 * S1-S8, independent of whether the vm slice wall caught anything.
 *
 * This file is the end-to-end version of that claim: real `createOrchestrator`
 * driving a real `WorkerHost` (real `node:worker_threads` + `node:vm`, no
 * fakes anywhere in the chain) against all four runaway-script shapes listed
 * in the design's WC02 gate item (§12): synchronous infinite loop, an
 * await-then-microtask infinite loop, unbounded recursion, and OOM. For each,
 * both halves of the guarantee are asserted:
 *   GW1a (logical terminal state) — `orch.run()`'s returned `WorkflowOutcome`
 *     has a terminal `status`, produced within a bounded wall-clock window.
 *   GW1b (tool return bound) — the SAME promise from `orch.run()` is what a
 *     caller awaits; its resolution *is* the tool-return bound, so bounding
 *     `run()`'s wall-clock duration bounds both simultaneously in this
 *     milestone (M3.1 has no separate outcomeAt1()/settled() split yet —
 *     that lands with the state machine in M3.3).
 */

function scriptWith(body: string): string {
  return `export const meta = { name: "t", description: "t" };\n${body}`;
}

const GATE_BUDGET: WorkflowRunBudget = {
  scriptLoadMs: 1_000,
  scriptSliceMs: 300,
  workerBootMs: 3_000,
  heartbeatMs: 30,
  heartbeatStallMs: 500,
  terminateConfirmMs: 500,
  workflowTotalMs: 1_500, // the hard backstop for the forms P1 can't catch (microtask spin)
  runawayPolicy: "diagnose_only",
};

function runGate(
  script: string,
  budgetOverride: Partial<WorkflowRunBudget> = {},
): { run: Promise<unknown>; start: number } {
  const orch = createOrchestrator({
    clock: systemClock,
    createWorkerHost: () => createWorkerHost({ clock: systemClock }),
  });
  const req: OrchestratorRunRequest = {
    workflowId: "wf_wc02_gate",
    script,
    budget: { ...GATE_BUDGET, ...budgetOverride },
  };
  return { run: orch.run(req), start: Date.now() };
}

const UPPER_BOUND_MS = GATE_BUDGET.workflowTotalMs + GATE_BUDGET.terminateConfirmMs + 1_000; // + generous CI slack

describe("WC02 milestone gate (§12): GW1a/GW1b hold for all four runaway script forms, end-to-end through the real orchestrator + real worker", () => {
  it("form 1/4 — synchronous infinite loop: caught early by P1 (vm slice wall), well under the workflowTotalMs backstop", async () => {
    const { run, start } = runGate(scriptWith("while (true) {}"));
    const outcome = (await run) as { status: string; timeoutReason?: string; durationMs: number };
    const elapsed = Date.now() - start;
    expect(["failed", "timed_out"]).toContain(outcome.status); // GW1a: reached a terminal status
    expect(elapsed).toBeLessThan(UPPER_BOUND_MS); // GW1b: the same promise settled within the bound
    // P1 is expected to have caught this one specifically (it's a pure top-level sync loop):
    expect(elapsed).toBeLessThan(GATE_BUDGET.scriptSliceMs + 1_000);
  }, 10_000);

  it("form 2/4 — await-then-microtask infinite loop: NOT caught by P1 (documented WC02 finding), but the workflowTotalMs backstop still bounds it", async () => {
    const { run, start } = runGate(scriptWith("await Promise.resolve();\nwhile (true) { await Promise.resolve(); }"));
    const outcome = (await run) as { status: string; timeoutReason?: string; durationMs: number };
    const elapsed = Date.now() - start;
    expect(outcome.status).toBe("timed_out"); // GW1a: the workflowTotalMs deadline is what caught it, not P1.
    expect(outcome.timeoutReason).toBe("workflow_total");
    expect(elapsed).toBeLessThan(UPPER_BOUND_MS); // GW1b: still bounded, terminate()'s S1-S6 don't need script cooperation.
    // And it genuinely was NOT caught early — confirms this is the backstop, not P1, doing the work.
    expect(elapsed).toBeGreaterThanOrEqual(GATE_BUDGET.workflowTotalMs);
  }, 10_000);

  it("form 3/4 — unbounded recursion (stack overflow): caught by the worker's own RangeError, bounded well under the backstop", async () => {
    const { run, start } = runGate(scriptWith("function r(){ return 1 + r(); }\nreturn r();"));
    const outcome = (await run) as { status: string; error?: { message: string }; durationMs: number };
    const elapsed = Date.now() - start;
    expect(outcome.status).toBe("failed"); // GW1a
    expect(outcome.error?.message).toMatch(/call stack/i);
    expect(elapsed).toBeLessThan(UPPER_BOUND_MS); // GW1b
  }, 10_000);

  it("form 4/4 — OOM (resourceLimits exceeded): the worker's death is observed boundedly, never a host process crash", async () => {
    const { run, start } = runGate(
      scriptWith("const chunks = []; while(true) { chunks.push(new Array(1_000_000).fill(0)); }"),
      {
        scriptSliceMs: 5_000,
        heartbeatStallMs: 5_200,
        workflowTotalMs: 8_000,
        maxOldGenerationSizeMb: 16,
        maxYoungGenerationSizeMb: 8,
      },
    );
    const outcome = (await run) as { status: string; durationMs: number };
    const elapsed = Date.now() - start;
    expect(["failed", "timed_out"]).toContain(outcome.status); // GW1a: terminal, whether via resourceLimits kill or the backstop.
    expect(elapsed).toBeLessThan(15_000); // GW1b, generous bound for CI memory-pressure jitter.
    // Above all: the assertion below running at all is itself part of the
    // proof — a real OOM'd worker did not take the host test process down with it.
    expect(process.exitCode ?? 0).toBe(0);
  }, 20_000);
});
