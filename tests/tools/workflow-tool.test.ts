import { describe, expect, it } from "vitest";
import { systemClock } from "../../src/core/clock.js";
import type { ChildOutcome, ChildSpawner } from "../../src/workflow/host.js";
import { createWorkerHost } from "../../src/workflow/lifecycle.js";
import { createOrchestrator, type Orchestrator } from "../../src/workflow/orchestrator.js";
import { createWorkflowActivityRegistry, type WorkflowActivitySnapshot } from "../../src/workflow/activity.js";
import type { WorkflowOutcome, WorkflowRunBudget } from "../../src/workflow/types.js";
import type { RunSnapshot } from "../../src/core/types.js";
import {
  buildWorkflowProgressLines,
  createDisabledWorkflowToolStub,
  createWorkflowTool,
  formatWorkflowSummary,
  type WorkflowToolDeps,
} from "../../src/tools/workflow-tool.js";

/**
 * M3.6 (workflow design §11 M3.6): end-to-end tool coverage.
 *
 *  - "two agents, real worker" proves the tool is not a half-finished shim:
 *    a real `node:worker_threads` worker runs a real script that calls
 *    `agent()` twice and combines the results, through the real
 *    orchestrator/host-call-handler/journal-less path, exactly as a model
 *    invoking `SubagentWorkflow` would exercise it.
 *  - "enabled=false" proves the settings gate index.ts wires actually works
 *    (the stub tool, not the real one, is what a disabled instance exposes).
 *  - WT13/WT17 coverage proves the tool's own timeout/fallback sequence
 *    (§4.3.2) never hangs and never disguises a degraded snapshot as a
 *    confirmed terminal outcome.
 */

const REAL_BUDGET: WorkflowRunBudget = {
  scriptLoadMs: 2_000,
  scriptSliceMs: 2_000,
  workerBootMs: 5_000,
  heartbeatMs: 0,
  heartbeatStallMs: 60_000,
  terminateConfirmMs: 2_000,
  workflowTotalMs: 20_000,
  runawayPolicy: "diagnose_only",
  hostCallMs: 5_000,
  gateMs: 5_000,
  maxParallel: 8,
  maxChildren: 50,
  maxBatchItems: 50,
};

function makeSpawner(): { spawner: ChildSpawner; spawnedPrompts: string[] } {
  const spawnedPrompts: string[] = [];
  let n = 0;
  const promptByRunId = new Map<string, string>();
  const spawner: ChildSpawner = {
    spawn: async (req) => {
      spawnedPrompts.push(req.prompt);
      const runId = `r${++n}`;
      promptByRunId.set(runId, req.prompt);
      return { runId };
    },
    abort: async () => true,
    waitAll: async ({ runIds }) => {
      const settled: ChildOutcome[] = runIds.map((runId) => {
        const prompt = promptByRunId.get(runId) ?? "";
        return { runId, status: "completed" as const, text: `done:${prompt}` };
      });
      return { settled, pending: [] };
    },
    configHashOf: (type) => `cfg:${type}`,
  };
  return { spawner, spawnedPrompts };
}

function realDeps(spawner: ChildSpawner, budget: WorkflowRunBudget = REAL_BUDGET): WorkflowToolDeps {
  return {
    defaultBudget: budget,
    activity: createWorkflowActivityRegistry(),
    createOrchestrator: (workflowId) =>
      createOrchestrator({
        clock: systemClock,
        createWorkerHost: () => createWorkerHost({ clock: systemClock }),
        spawner,
        gateRunner: async () => ({ ok: true, code: 0, stdout: "", stderr: "" }),
        parentRunId: workflowId,
      }),
  };
}

describe("SubagentWorkflow tool (M3.6): real worker end-to-end", () => {
  it("a two-agent script (sequential) runs through a real worker and returns a combined result", async () => {
    const { spawner, spawnedPrompts } = makeSpawner();
    const tool = createWorkflowTool(realDeps(spawner));
    const script =
      'export const meta = { name: "two-agent", description: "t" };\n' +
      'const a = await agent("first task");\n' +
      'const b = await agent("second task");\n' +
      'return a + "|" + b;';
    const result = await tool.execute("call-1", { script }, undefined);
    expect(spawnedPrompts).toEqual(["first task", "second task"]);
    const details = result.details as { status: string; children: unknown[] };
    expect(details.status).toBe("completed");
    expect(details.children).toHaveLength(2);
    expect(result.content[0]).toMatchObject({ type: "text" });
    expect((result.content[0] as { text: string }).text).toContain("done:first task|done:second task");
  }, 15_000);

  it("a two-agent script run in parallel() also completes end-to-end", async () => {
    const { spawner, spawnedPrompts } = makeSpawner();
    const tool = createWorkflowTool(realDeps(spawner));
    const script =
      'export const meta = { name: "parallel-two", description: "t" };\n' +
      'const [a, b] = await parallel([() => agent("p1"), () => agent("p2")]);\n' +
      'return [a, b].join(",");';
    const result = await tool.execute("call-2", { script }, undefined);
    expect(spawnedPrompts.sort()).toEqual(["p1", "p2"]);
    expect((result.details as { status: string }).status).toBe("completed");
  }, 15_000);

  it("already-aborted signal returns immediately and never boots a worker", async () => {
    const { spawner, spawnedPrompts } = makeSpawner();
    const tool = createWorkflowTool(realDeps(spawner));
    const controller = new AbortController();
    controller.abort();
    const result = await tool.execute(
      "call-3",
      { script: 'export const meta = { name: "t", description: "t" };\nreturn 1;' },
      controller.signal,
    );
    expect(spawnedPrompts).toEqual([]);
    expect(result.details).toEqual({ status: "aborted" });
  });

  it("a script error (after an await) surfaces as a thrown tool error with the workflow's diagnostic text", async () => {
    const { spawner } = makeSpawner();
    const tool = createWorkflowTool(realDeps(spawner));
    const script = 'export const meta = { name: "t", description: "t" };\nawait agent("x");\nthrow new Error("boom");';
    await expect(tool.execute("call-4", { script }, undefined)).rejects.toThrow(/boom/);
  }, 10_000);
});

describe("SubagentWorkflow disabled stub (settings.workflow.enabled === false)", () => {
  it("registers under the same tool name but always throws a clear, honest error", async () => {
    const stub = createDisabledWorkflowToolStub();
    expect(stub.name).toBe("SubagentWorkflow");
    await expect(
      stub.execute("call", { script: 'export const meta = { name: "t", description: "t" };\nreturn 1;' }, undefined),
    ).rejects.toThrow(/disabled/);
  });
});

/** A hand-built `Orchestrator` double so WT13/WT17's own timeout/grace-window sequencing can be driven deterministically without waiting on the full `workflowTotalMs`+`abortGraceMs`+`terminateConfirmMs` real chain (that combination is already covered end-to-end by wc02-runaway-gate.test.ts/abort.test.ts at the orchestrator layer). */
function fakeOutcome(overrides: Partial<WorkflowOutcome> = {}): WorkflowOutcome {
  return {
    workflowId: "wf_fake",
    status: "completed",
    pendingReconcile: false,
    durationMs: 1,
    children: [],
    diag: { createdAt: 0, heartbeat: { seq: 0, observedAt: 0, stalledMs: 0 }, logLines: 0 },
    ...overrides,
  };
}

describe("SubagentWorkflow tool: WT13/WT17 timeout+fallback sequence (§4.3.2)", () => {
  it("run() settling within toolCallMs is returned as-is (fast path, no stop()/settled() detour)", async () => {
    let stopCalled = false;
    const orch: Orchestrator = {
      run: async () => fakeOutcome({ result: "fast" }),
      stop: async () => {
        stopCalled = true;
        return { ok: true };
      },
      outcomeAt1: () => undefined,
      settled: async () => fakeOutcome(),
    };
    const tool = createWorkflowTool({
      defaultBudget: { ...REAL_BUDGET, workflowTotalMs: 200, terminateConfirmMs: 50 },
      activity: createWorkflowActivityRegistry(),
      createOrchestrator: () => orch,
    });
    const result = await tool.execute(
      "c",
      { script: 'export const meta={name:"t",description:"t"};\nreturn 1;' },
      undefined,
    );
    expect(stopCalled).toBe(false);
    expect((result.details as { status: string }).status).toBe("completed");
  });

  it("run() hanging past toolCallMs fires an un-awaited stop() and returns settled()'s real terminal outcome (TL2/TL6)", async () => {
    let stopCalledAt = 0;
    const start = Date.now();
    const orch: Orchestrator = {
      run: () => new Promise(() => {}), // never resolves — forces the timeout branch
      stop: async () => {
        stopCalledAt = Date.now() - start;
        return { ok: true };
      },
      outcomeAt1: () =>
        fakeOutcome({ status: "timed_out", pendingReconcile: true, result: "outcomeAt1-fallback-should-not-be-used" }),
      // Resolves shortly after stop() is called, well inside settlementGraceMs.
      settled: () => new Promise((resolve) => setTimeout(() => resolve(fakeOutcome({ status: "timed_out" })), 30)),
    };
    const tool = createWorkflowTool({
      // workflowTotalMs=50 -> the tool races run() against (toolCallMs-3000), which is
      // tiny here, so the timeout branch fires almost immediately.
      defaultBudget: { ...REAL_BUDGET, workflowTotalMs: 50, terminateConfirmMs: 10, abortGraceMs: 10, reconcileMs: 10 },
      activity: createWorkflowActivityRegistry(),
      createOrchestrator: () => orch,
    });
    let message = "";
    try {
      await tool.execute("c", { script: 'export const meta={name:"t",description:"t"};\nreturn 1;' }, undefined);
      throw new Error("expected tool.execute to throw for a non-completed outcome");
    } catch (e) {
      message = e instanceof Error ? e.message : String(e);
    }
    expect(stopCalledAt).toBeGreaterThan(0); // stop() was actually invoked, not skipped
    expect(message).toContain("did not complete successfully: timed_out"); // the *real* settled() outcome
    expect(message).not.toContain("outcomeAt1-fallback-should-not-be-used"); // never fell back to ① when ② was available
  }, 10_000);

  it("run() AND settled() both failing to return within budget falls back to outcomeAt1(), explicitly marked degraded (never disguised as a confirmed terminal state)", async () => {
    const orch: Orchestrator = {
      run: () => new Promise(() => {}),
      stop: async () => ({ ok: true }),
      outcomeAt1: () => fakeOutcome({ status: "timed_out", pendingReconcile: true, result: "partial" }),
      settled: () => new Promise(() => {}), // also never resolves
    };
    const tool = createWorkflowTool({
      defaultBudget: { ...REAL_BUDGET, workflowTotalMs: 50, terminateConfirmMs: 10, abortGraceMs: 10, reconcileMs: 10 },
      activity: createWorkflowActivityRegistry(),
      createOrchestrator: () => orch,
    });
    // The tool must still return (GW1b) — bounded by toolCallMs (~3.3s here from the settlementGraceMs constant), not hang forever.
    const start = Date.now();
    await expect(
      tool.execute("c", { script: 'export const meta={name:"t",description:"t"};\nreturn 1;' }, undefined),
    ).rejects.toThrow(/timed_out/);
    expect(Date.now() - start).toBeLessThan(5_000);
  }, 10_000);

  it("outcomeAt1() itself also gone (EI5 double-failure): the tool still returns a bare, honestly-degraded skeleton instead of hanging", async () => {
    const orch: Orchestrator = {
      run: () => new Promise(() => {}),
      stop: async () => ({ ok: true }),
      outcomeAt1: () => undefined,
      settled: () => new Promise(() => {}),
    };
    const tool = createWorkflowTool({
      defaultBudget: { ...REAL_BUDGET, workflowTotalMs: 50, terminateConfirmMs: 10, abortGraceMs: 10, reconcileMs: 10 },
      activity: createWorkflowActivityRegistry(),
      createOrchestrator: () => orch,
    });
    await expect(
      tool.execute("c", { script: 'export const meta={name:"t",description:"t"};\nreturn 1;' }, undefined),
    ).rejects.toThrow(/timed_out/);
  }, 10_000);
});

describe("M10: buildWorkflowProgressLines", () => {
  const base: WorkflowActivitySnapshot = {
    workflowId: "wf_1",
    name: "demo-flow",
    startedAt: 0,
    activeChildren: [],
    settledChildren: [],
    settledTotal: 0,
    completedTotal: 0,
    replayTotal: 0,
  };

  it("renders the header with name, phase, elapsed and remaining budget", () => {
    const lines = buildWorkflowProgressLines({ ...base, currentPhaseId: "Implement", deadlineAt: 1_800_000 }, 130_000);
    expect(lines[0]).toBe("⏳ demo-flow · phase: Implement · 2m10s · 27m50s left");
    expect(lines).toHaveLength(1); // no tally/children yet
  });

  it("renders the settled/running tally and the recent-settled trail with per-status marks", () => {
    const lines = buildWorkflowProgressLines(
      {
        ...base,
        settledTotal: 3,
        completedTotal: 2,
        replayTotal: 1,
        settledChildren: [
          { callId: "c1", label: "explore:auth", status: "completed", source: "live", durationMs: 48_000 },
          { callId: "c2", label: "dev:api", status: "completed", source: "replay", durationMs: 0 },
          { callId: "c3", label: "dev:web", status: "failed", source: "live", durationMs: 62_000 },
        ],
        activeChildren: [{ callId: "c4", label: "verify:api", enteredAt: 100_000 }],
      },
      130_000,
    );
    expect(lines[1]).toBe("✓ 2 (1 replay) · ✗ 1 · ▸ 1 running");
    expect(lines[2]).toBe("✓ explore:auth (48s) · ↩ dev:api (0ms) · ✗ dev:web (1m02s)");
    // c4 has no snapshot available (snapshotOf not provided) → fallback row.
    expect(lines[3]).toBe("▸ verify:api · spawned 30s ago");
  });

  it("renders a live child's own M-B progress lines re-prefixed with its label when a snapshot is available", () => {
    const snap: RunSnapshot = {
      runId: "run-c1",
      generation: 1,
      status: "running",
      phase: "model_turn",
      deadlines: { enqueuedAt: 0, deadlineAt: undefined, queueDeadlineAt: undefined },
      diag: {
        createdAt: 100_000,
        phase: "model_turn",
        phaseEnteredAt: 100_000,
        pendingTools: 1,
        turns: 3,
        escalation: [],
        orphaned: false,
        generation: 1,
        degraded: [],
        staleInputs: 0,
        unkillable: [],
        model: { provider: "p", id: "kimi-k3" },
        toolHistory: [{ name: "bash", toolCallId: "t1", startedAt: 120_000 }],
        usage: { input: 100, output: 50, cacheRead: 0, cacheWrite: 0, costUsd: 0.08 },
      },
      updatedAt: 130_000,
    };
    const lines = buildWorkflowProgressLines(
      { ...base, activeChildren: [{ callId: "c1", label: "dev:api", runId: "run-c1", enteredAt: 100_000 }] },
      130_000,
      (runId) => (runId === "run-c1" ? snap : undefined),
    );
    expect(lines[1]).toBe("▸ 1 running");
    expect(lines[2]).toContain("▸ dev:api · p/kimi-k3");
    expect(lines[2]).toContain("turn 4");
    expect(lines[2]).toContain("$0.08");
    expect(lines.some((l) => l.includes("▸ bash"))).toBe(true); // the child's running tool row
  });

  it("caps per-child rows and collapses the rest into a +N line", () => {
    const activeChildren = Array.from({ length: 8 }, (_, i) => ({
      callId: `c${i}`,
      label: `t${i}`,
      enteredAt: 0,
    }));
    const lines = buildWorkflowProgressLines({ ...base, activeChildren }, 1_000);
    expect(lines.filter((l) => l.startsWith("▸ t"))).toHaveLength(6);
    expect(lines[lines.length - 1]).toBe("… +2 more running");
  });
});

describe("M10: formatWorkflowSummary", () => {
  it("renders status · duration · children tally (✓/↩/✗) · cost", () => {
    const summary = formatWorkflowSummary(
      fakeOutcome({
        durationMs: 130_000,
        children: [
          { callId: "c1", source: "live", status: "completed", durationMs: 1 },
          { callId: "c2", source: "replay", status: "completed", durationMs: 0 },
          { callId: "c3", source: "live", status: "failed", durationMs: 2 },
        ],
      }),
      { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, costUsd: 0.42 },
    );
    expect(summary).toBe("completed · 2m10s · 3 children (✓2 ↩1 ✗1) · $0.42");
  });

  it("omits the children tally and cost when absent", () => {
    expect(formatWorkflowSummary(fakeOutcome({ durationMs: 500 }))).toBe("completed · 500ms");
  });
});

describe("M10: live tool-card progress (onUpdate)", () => {
  it("streams a header partial immediately and a per-child row once the child spawns", async () => {
    const activity = createWorkflowActivityRegistry();
    let release!: (o: { settled: ChildOutcome[]; pending: string[] }) => void;
    const spawner: ChildSpawner = {
      spawn: async () => ({ runId: "r1" }),
      abort: async () => true,
      waitAll: () => new Promise((resolve) => (release = resolve)),
      configHashOf: (type) => `cfg:${type}`,
    };
    const tool = createWorkflowTool({
      defaultBudget: REAL_BUDGET,
      activity,
      createOrchestrator: (workflowId) =>
        createOrchestrator({
          clock: systemClock,
          createWorkerHost: () => createWorkerHost({ clock: systemClock }),
          spawner,
          gateRunner: async () => ({ ok: true, code: 0, stdout: "", stderr: "" }),
          parentRunId: workflowId,
          // Mirrors stack.ts's wiring: the orchestrator's event stream feeds the activity registry.
          emit: (channel, payload) => activity.onEvent(channel, payload),
        }),
      snapshotOf: () => undefined, // no session snapshots in this harness → fallback rows
    });
    const partials: string[] = [];
    const pending = tool.execute(
      "call-live",
      {
        script:
          'export const meta = { name: "live-card", description: "t" };\n' +
          'return await agent("task one", { label: "dev:a" });',
      },
      undefined,
      ((u: { content?: { type: string; text?: string }[] }) => {
        partials.push(
          (u.content ?? [])
            .map((c) => (c.type === "text" ? (c.text ?? "") : ""))
            .filter(Boolean)
            .join("\n"),
        );
      }) as never,
    );
    try {
      // The 1 Hz progress timer drives per-child rows; poll the collected
      // partials rather than sleeping a fixed interval.
      const deadline = Date.now() + 8_000;
      while (Date.now() < deadline && !partials.some((t) => t.includes("dev:a"))) {
        await new Promise((r) => setTimeout(r, 50));
      }
      expect(partials.some((t) => t.includes("⏳ live-card"))).toBe(true);
      expect(partials.some((t) => t.includes("▸ dev:a"))).toBe(true);
      expect(partials.some((t) => t.includes("▸ 1 running"))).toBe(true);
    } finally {
      release({ settled: [{ runId: "r1", status: "completed", text: "done" }], pending: [] });
    }
    const result = await pending;
    const details = result.details as { status: string; summary?: string };
    expect(details.status).toBe("completed");
    expect(details.summary).toContain("completed");
    expect(details.summary).toContain("1 children");
  }, 20_000);

  it("works unchanged when no onUpdate is provided (no progress plumbing engaged)", async () => {
    const { spawner } = makeSpawner();
    const tool = createWorkflowTool(realDeps(spawner));
    const result = await tool.execute(
      "call-noprogress",
      { script: 'export const meta = { name: "t", description: "t" };\nreturn 42;' },
      undefined,
    );
    expect((result.details as { status: string }).status).toBe("completed");
  }, 15_000);
});
