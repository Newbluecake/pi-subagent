import { describe, expect, it } from "vitest";
import { createResultTool } from "../../src/tools/result-tool.js";
import type { QueryService } from "../../src/service/query-service.js";
import type { RunSnapshot, UsageDelta } from "../../src/core/types.js";

const usage: UsageDelta = { input: 42, output: 17, cacheRead: 3, cacheWrite: 0, costUsd: 0.0055 };

function completedSnapshot(): RunSnapshot {
  return {
    runId: "r1",
    generation: 1,
    status: "completed",
    phase: "settled",
    deadlines: { enqueuedAt: 0, deadlineAt: undefined, queueDeadlineAt: undefined },
    diag: {
      createdAt: 0,
      phase: "settled",
      phaseEnteredAt: 0,
      pendingTools: 0,
      turns: 1,
      escalation: [],
      orphaned: false,
      generation: 1,
      degraded: [],
      staleInputs: 0,
      unkillable: [],
      usage,
    },
    outcome: {
      runId: "r1",
      status: "completed",
      text: "done",
      turns: 1,
      durationMs: 10,
      usage,
      diag: {
        createdAt: 0,
        phase: "settled",
        phaseEnteredAt: 0,
        pendingTools: 0,
        turns: 1,
        escalation: [],
        orphaned: false,
        generation: 1,
        degraded: [],
        staleInputs: 0,
        unkillable: [],
        usage,
      },
    },
    updatedAt: 10,
  };
}

describe("X9 get_subagent_result usage output", () => {
  it("includes usage in both the details payload and the rendered text for a non-waiting lookup", async () => {
    const query: QueryService = {
      get: () => completedSnapshot(),
      list: () => [],
      wait: async () => ({ ok: false, reason: "unknown_run" }),
      waitAll: async () => ({ settled: [], pending: [] }),
      steer: async () => undefined,
      stop: async () => false,
    };
    const tool = createResultTool({ query });
    const result = await tool.execute("tc1", { run_id: "r1" }, undefined, () => undefined, {} as never);
    expect((result.details as { usage?: UsageDelta }).usage).toEqual(usage);
    expect((result.content[0] as { text: string }).text).toContain("cost:$0.0055");
  });

  it("includes usage when the caller waits for completion", async () => {
    const query: QueryService = {
      get: () => undefined,
      list: () => [],
      wait: async () => ({ ok: true, outcome: completedSnapshot().outcome! }),
      waitAll: async () => ({ settled: [], pending: [] }),
      steer: async () => undefined,
      stop: async () => false,
    };
    const tool = createResultTool({ query });
    const result = await tool.execute("tc1", { run_id: "r1", wait: true }, undefined, () => undefined, {} as never);
    expect((result.details as { usage?: UsageDelta }).usage).toEqual(usage);
  });
});

describe("pi usage accounting: tool-result usage attach + first-terminal dedupe", () => {
  const query = (): QueryService => ({
    get: () => completedSnapshot(),
    list: () => [],
    wait: async () => ({ ok: true, outcome: completedSnapshot().outcome! }),
    waitAll: async () => ({ settled: [], pending: [] }),
    steer: async () => undefined,
    stop: async () => false,
  });
  type WithUsage = { usage?: { totalTokens: number; cost: { total: number } } };

  it("attaches pi-shaped usage to the FIRST terminal retrieval only (no double counting)", async () => {
    const tool = createResultTool({ query: query() });
    const first = (await tool.execute("tc1", { run_id: "r1" }, undefined, () => undefined, {} as never)) as WithUsage;
    expect(first.usage).toBeDefined();
    expect(first.usage!.cost.total).toBeCloseTo(0.0055);
    expect(first.usage!.totalTokens).toBe(42 + 17 + 3);
    const second = (await tool.execute("tc2", { run_id: "r1" }, undefined, () => undefined, {} as never)) as WithUsage;
    expect(second.usage).toBeUndefined();
    // a different run is still reported
    const other = (await tool.execute(
      "tc3",
      { run_id: "r2", wait: true },
      undefined,
      () => undefined,
      {} as never,
    )) as WithUsage;
    expect(other.usage).toBeDefined();
  });

  it("does not attach usage while the run is still active", async () => {
    const running = completedSnapshot();
    running.status = "running";
    delete (running as { outcome?: unknown }).outcome;
    const q: QueryService = { ...query(), get: () => running };
    const tool = createResultTool({ query: q });
    const result = (await tool.execute("tc1", { run_id: "r1" }, undefined, () => undefined, {} as never)) as WithUsage;
    expect(result.usage).toBeUndefined();
  });
});
