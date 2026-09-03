import { describe, expect, it } from "vitest";
import { systemClock } from "../../src/core/clock.js";
import { attachHostCallHandler, type ChildSpawner } from "../../src/workflow/host.js";
import { createWorkerHost } from "../../src/workflow/lifecycle.js";
import { createOrchestrator, type OrchestratorRunRequest } from "../../src/workflow/orchestrator.js";
import type { WorkerHost, WorkflowRunBudget } from "../../src/workflow/types.js";

/**
 * M3.4 (workflow design \u00a75.2/\u00a75.3, WT7): the script API compatibility
 * surface \u2014 `parallel()`/`pipeline()`/`phase()`/`meta`/`log`/`args`/`budget` \u2014
 * plus the phase-level WT7 timeout. Every test here drives a **real**
 * `node:worker_threads` worker (via `createWorkerHost`/`lifecycle.ts`, not a
 * fake `WorkerLike`), exactly like `worker-host-call.test.ts` established:
 * these are the actual sandboxed globals a script sees, not a simulation of
 * them.
 *
 * \u00a75.3 compatibility-matrix self-check performed by this suite (each row
 * gets at least one assertion below):
 *   same     - agent(prompt,opts?) position args / string|object|null return
 *   same     - parallel(thunks): barrier, thrown/rejected thunk -> null, order preserved
 *   same     - pipeline(items, ...stages): no stage barrier, thrown stage -> null for that item only
 *   same     - phase(title): statement form, environment-tags subsequent agent() calls
 *   same     - opts.phase explicit override wins over the environment phase()
 *   same     - args: top-level global (not workflow.args)
 *   same     - budget: { total: null, spent(), remaining() } top-level global
 *   narrowed - unknown agentType rejects (not a silent general-purpose fallback)
 *   changed  - workflow(nameOrRef, args?) rejects "not implemented" (NW5, no nested workflow)
 *   added    - WT7 phaseTotalMs: phase-scoped cancellation, not a global close_gate (WI8)
 */

function scriptWith(body: string): string {
  return `export const meta = { name: "t", description: "t" };\n${body}`;
}

async function bootReal(
  script: string,
  spawner: ChildSpawner,
  opts: { budget?: Partial<WorkflowRunBudget>; args?: unknown } = {},
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
      maxParallel: 8,
      maxChildren: 20,
      maxBatchItems: 20,
      childBudgetPolicy: "inherit_remaining",
      ...opts.budget,
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
    maxBatchItems: opts.budget?.maxBatchItems ?? 20,
    ...(opts.args !== undefined ? { args: opts.args } : {}),
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

function completingSpawner(delayMsByPrompt: Record<string, number> = {}): {
  spawner: ChildSpawner;
  spawnOrder: string[];
  settleOrder: string[];
} {
  const spawnOrder: string[] = [];
  const settleOrder: string[] = [];
  let n = 0;
  const spawner: ChildSpawner = {
    spawn: async (req) => {
      spawnOrder.push(req.prompt);
      return { runId: `r${++n}` };
    },
    abort: async () => true,
    waitAll: async ({ runIds }) => {
      const settled = await Promise.all(
        runIds.map(async (runId) => {
          // runId isn't the prompt, but our fake spawn() above hands back a
          // fresh id per call in submission order — recover the prompt via
          // spawnOrder's matching index (r1 -> spawnOrder[0], etc).
          const idx = Number(runId.slice(1)) - 1;
          const prompt = spawnOrder[idx] ?? "";
          const delay = delayMsByPrompt[prompt] ?? 0;
          if (delay > 0) await new Promise((r) => setTimeout(r, delay));
          settleOrder.push(prompt);
          return { runId, status: "completed" as const, text: `done:${prompt}` };
        }),
      );
      return { settled, pending: [] };
    },
  };
  return { spawner, spawnOrder, settleOrder };
}

describe("M3.4 parallel(thunks) (\u00a75.2/\u00a75.3: barrier, thrown thunk -> null, order preserved)", () => {
  it("waits for every thunk (barrier) and a throwing/rejecting thunk resolves to null without failing its siblings", async () => {
    const { spawner } = completingSpawner({ slow: 60 });
    const script = scriptWith(`
      const results = await parallel([
        async () => { throw new Error("sync boom"); },
        async () => { await agent("slow"); return "slow-done"; },
        () => Promise.reject(new Error("async boom")),
        async () => "immediate",
      ]);
      return results;
    `);
    const { host, outcome } = await bootReal(script, spawner);
    const stageErrors: Array<{ source: string; itemIndex: number; stageIndex?: number; message: string }> = [];
    host.events.onStageError((e) => stageErrors.push(e));
    const result = await outcome;
    expect(result.threw).toBeUndefined();
    // Order preserved; failing thunks -> null; the barrier waited for the
    // 60ms agent() call before the overall parallel() resolved.
    expect(result.returned).toEqual([null, "slow-done", null, "immediate"]);
    // …but the nulls are no longer silent: each thrown thunk was reported.
    expect(stageErrors).toEqual([
      { source: "parallel", itemIndex: 0, message: "sync boom" },
      { source: "parallel", itemIndex: 2, message: "async boom" },
    ]);
    await host.terminate("test-done");
  }, 10_000);

  it("maxBatchItems rejects an oversize parallel() call before any thunk runs", async () => {
    const { spawner } = completingSpawner();
    const script = scriptWith(`
      try {
        await parallel(Array.from({ length: 3 }, () => async () => "x"));
        return "no-throw";
      } catch (e) { return "caught:" + e.message; }
    `);
    const { host, outcome } = await bootReal(script, spawner, { budget: { maxBatchItems: 2 } });
    const result = await outcome;
    expect(result.returned).toMatch(/^caught:.*exceeds maxBatchItems/);
    await host.terminate("test-done");
  }, 10_000);
});

describe("M3.4 pipeline(items, ...stages) (\u00a75.2/\u00a75.3: no stage barrier between items)", () => {
  it("a slow item does not block a faster item's own downstream stage from completing first", async () => {
    const { spawner, settleOrder } = completingSpawner({ slow: 150, fast: 10 });
    const script = scriptWith(`
      const results = await pipeline(
        ["slow", "fast"],
        async (prev, item) => { const r = await agent(item); log("stage1:" + item); return r; },
        async (prev, item) => { log("stage2:" + item); return prev + "|stage2"; },
      );
      return results;
    `);
    const logs: string[] = [];
    const host = createWorkerHost({ clock: systemClock });
    attachHostCallHandler({
      clock: systemClock,
      workerHost: host,
      spawner,
      gateRunner: async () => ({ ok: true, code: 0, stdout: "", stderr: "" }),
      budget: {
        hostCallMs: 3_000,
        gateMs: 3_000,
        maxParallel: 8,
        maxChildren: 20,
        maxBatchItems: 20,
        childBudgetPolicy: "inherit_remaining",
      },
    });
    host.events.onLog((line) => logs.push(line));
    const boot = await host.boot({
      scriptSource: script,
      scriptSliceMs: 2_000,
      heartbeatMs: 0,
      workerBootMs: 5_000,
      terminateConfirmMs: 2_000,
      hostCallMs: 3_000,
      gateMs: 3_000,
      maxBatchItems: 20,
    });
    expect(boot.ok).toBe(true);
    const returned = await new Promise((resolve) => host.events.onScriptReturned(resolve));
    expect(returned).toEqual(["done:slow|stage2", "done:fast|stage2"]);
    // No stage barrier (\u00a75.2): the fast item's stage1+stage2 both complete
    // (log lines emitted) before the slow item's agent() call even settles.
    expect(settleOrder).toEqual(["fast", "slow"]);
    const stage2FastIdx = logs.indexOf("stage2:fast");
    const stage1SlowIdx = logs.indexOf("stage1:slow");
    expect(stage2FastIdx).toBeGreaterThanOrEqual(0);
    expect(stage1SlowIdx).toBeGreaterThan(stage2FastIdx); // fast item fully done before slow item's stage1 even runs
    await host.terminate("test-done");
  }, 10_000);

  it("a stage that throws settles that item to null and skips its remaining stages, without affecting other items", async () => {
    const { spawner } = completingSpawner();
    const script = scriptWith(`
      const results = await pipeline(
        ["a", "b"],
        async (prev, item) => { if (item === "a") throw new Error("stage1 boom"); return await agent(item); },
        async (prev, item) => prev + "|stage2-" + item,
      );
      return results;
    `);
    const { host, outcome } = await bootReal(script, spawner);
    const stageErrors: Array<{ source: string; itemIndex: number; stageIndex?: number; message: string }> = [];
    host.events.onStageError((e) => stageErrors.push(e));
    const result = await outcome;
    expect(result.returned).toEqual([null, "done:b|stage2-b"]);
    // The thrown stage was reported with its item and stage index (stage 1
    // for item "a" never ran — the item was already skipped).
    expect(stageErrors).toEqual([{ source: "pipeline", itemIndex: 0, stageIndex: 0, message: "stage1 boom" }]);
    await host.terminate("test-done");
  }, 10_000);
});

describe("M3.4 phase(title) (\u00a75.2/\u00a75.3: statement form, environment tag, opts.phase override)", () => {
  it("phase(title) tags subsequent agent() calls; an explicit opts.phase overrides the environment", async () => {
    const seenPhases: Array<string | undefined> = [];
    const spawner: ChildSpawner = {
      spawn: async (req) => {
        // The workflow design routes `phase` through `opts.phase` (host.ts
        // reads it back off the same `agent()` args envelope worker-source.ts
        // sends) \u2014 not part of `ChildSpawner.spawn`'s own request shape, so
        // this test observes it via `host.children[].phaseId` below instead.
        return { runId: `r${seenPhases.push(undefined)}` };
      },
      abort: async () => true,
      waitAll: async ({ runIds }) => ({
        settled: runIds.map((runId) => ({ runId, status: "completed" as const, text: "ok" })),
        pending: [],
      }),
    };
    const script = scriptWith(`
      phase("collect");
      await agent("env-tagged");
      await agent("explicit-override", { phase: "analyze" });
      phase("finish");
      await agent("finish-tagged");
      return "ok";
    `);
    const host = createWorkerHost({ clock: systemClock });
    const handler = attachHostCallHandler({
      clock: systemClock,
      workerHost: host,
      spawner,
      gateRunner: async () => ({ ok: true, code: 0, stdout: "", stderr: "" }),
      budget: {
        hostCallMs: 3_000,
        gateMs: 3_000,
        maxParallel: 8,
        maxChildren: 20,
        maxBatchItems: 20,
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
      maxBatchItems: 20,
    });
    expect(boot.ok).toBe(true);
    await new Promise((resolve) => host.events.onScriptReturned(resolve));
    await new Promise((r) => setTimeout(r, 20)); // let the last settle land
    expect(handler.children.map((c) => c.phaseId)).toEqual(["collect", "analyze", "finish"]);
    expect(handler.currentPhaseId).toBe("finish");
    await host.terminate("test-done");
  }, 10_000);
});

describe("M3.4 args / budget top-level globals (\u00a75.2/\u00a75.3: not workflow.args, same 3-method budget shape)", () => {
  it("args carries the tool-call argument through as a plain top-level global; budget matches the documented upstream shape", async () => {
    const { spawner } = completingSpawner();
    const script = scriptWith(`
      return {
        argsSeen: args,
        budgetTotal: budget.total,
        budgetSpent: budget.spent(),
        budgetRemaining: budget.remaining(),
      };
    `);
    const { host, outcome } = await bootReal(script, spawner, { args: { targetRepo: "acme/widgets", n: 3 } });
    const result = await outcome;
    expect(result.threw).toBeUndefined();
    expect(result.returned).toEqual({
      argsSeen: { targetRepo: "acme/widgets", n: 3 },
      budgetTotal: null,
      budgetSpent: 0,
      budgetRemaining: Number.POSITIVE_INFINITY,
    });
    await host.terminate("test-done");
  }, 10_000);

  it("args defaults to null when the tool call didn't supply one", async () => {
    const { spawner } = completingSpawner();
    const { host, outcome } = await bootReal(scriptWith("return args;"), spawner);
    const result = await outcome;
    expect(result.returned).toBeNull();
    await host.terminate("test-done");
  }, 10_000);
});

describe("M3.4 \u00a75.3 'narrowed'/'changed' compat rows", () => {
  it("narrowed: an unknown agentType rejects agent() with a catchable error, not a silent general-purpose fallback", async () => {
    const spawner: ChildSpawner = {
      spawn: async () => ({ error: { message: "unknown agent type: bogus-type" } }),
      abort: async () => true,
      waitAll: async () => ({ settled: [], pending: [] }),
    };
    const script = scriptWith(`
      try {
        await agent("x", { agentType: "bogus-type" });
        return "no-throw";
      } catch (e) { return "caught:" + e.message; }
    `);
    const { host, outcome } = await bootReal(script, spawner);
    const result = await outcome;
    expect(result.returned).toBe("caught:unknown agent type: bogus-type");
    await host.terminate("test-done");
  }, 10_000);

  it("changed (NW5): workflow(nameOrRef, args?) rejects 'not implemented' instead of running a nested script", async () => {
    const { spawner } = completingSpawner();
    const script = scriptWith(`
      try {
        await workflow("some-other-script");
        return "no-throw";
      } catch (e) { return "caught:" + e.message; }
    `);
    const { host, outcome } = await bootReal(script, spawner);
    const result = await outcome;
    expect(result.returned).toMatch(/^caught:.*not implemented/);
    await host.terminate("test-done");
  }, 10_000);
});

describe("M3.4 WT7 phaseTotalMs (\u00a74.1/\u00a77.2 WI8: phase-scoped cancellation, workflow keeps running)", () => {
  it("a call still active when its phase's budget expires is cancelled (phase_timeout), while a call in the next phase is unaffected", async () => {
    let resolveStuck!: (v: { runId: string; status: "aborted"; error: { message: string } }) => void;
    const abortedRunIds: string[] = [];
    let n = 0;
    const runIdByPrompt: Record<string, string> = {};
    const spawner: ChildSpawner = {
      spawn: async (req) => {
        const runId = `r${++n}`;
        runIdByPrompt[req.prompt] = runId;
        return { runId };
      },
      abort: async (runId) => {
        abortedRunIds.push(runId);
        // Simulate the real core's eventual effect: aborting the child
        // makes its `waitAll()` outcome resolve (as "aborted") shortly after.
        if (runId === runIdByPrompt.stuck) {
          resolveStuck({ runId, status: "aborted", error: { message: "phase_timeout" } });
        }
        return true;
      },
      waitAll: async ({ runIds }) => {
        const settled = await Promise.all(
          runIds.map(async (runId) => {
            if (runId === runIdByPrompt.stuck) {
              return new Promise<{ runId: string; status: "aborted"; error: { message: string } }>((resolve) => {
                resolveStuck = resolve;
              });
            }
            return { runId, status: "completed" as const, text: `done:${runId}` };
          }),
        );
        return { settled, pending: [] };
      },
    };
    const script = scriptWith(`
      phase("gather");
      const stuckResult = agent("stuck"); // deliberately not awaited yet — synchronously tagged "gather" before the next line runs
      phase("finish");
      const fastResult = await agent("fast");
      const stuck = await stuckResult;
      return { stuck, fast: fastResult };
    `);
    const { host, outcome } = await bootReal(script, spawner, { budget: { phaseTotalMs: 40 } });
    const result = await outcome;
    expect(result.threw).toBeUndefined();
    // The "gather"-phase call never got a real answer (it was cancelled by
    // WT7) -> null, same terminal-failure semantics as any other agent()
    // failure (\u00a75.2). The "finish"-phase call is completely unaffected.
    expect(result.returned).toEqual({ stuck: null, fast: "done:r2" });
    expect(abortedRunIds).toContain(runIdByPrompt.stuck);
    await host.terminate("test-done");
  }, 10_000);
});

describe("M3.4 orchestrator wiring: args/phaseTotalMs reach the real worker end-to-end through OrchestratorRunRequest", () => {
  it("OrchestratorRunRequest.args flows through boot() into the script's args global", async () => {
    const BASE_BUDGET: WorkflowRunBudget = {
      scriptLoadMs: 2_000,
      scriptSliceMs: 2_000,
      workerBootMs: 5_000,
      heartbeatMs: 0,
      heartbeatStallMs: 10_000,
      terminateConfirmMs: 2_000,
      workflowTotalMs: 10_000,
      runawayPolicy: "diagnose_only",
    };
    const orch = createOrchestrator({
      clock: systemClock,
      createWorkerHost: () => createWorkerHost({ clock: systemClock }),
    });
    const req: OrchestratorRunRequest = {
      workflowId: "wf_args_test",
      script: scriptWith("return args;"),
      budget: BASE_BUDGET,
      args: { hello: "world" },
    };
    const outcome = await orch.run(req);
    expect(outcome.status).toBe("completed");
    expect(outcome.result).toEqual({ hello: "world" });
  }, 10_000);
});
