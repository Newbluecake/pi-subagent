import { describe, expect, it } from "vitest";
import { renderStatus } from "../../src/commands/status.js";
import type { RunSnapshot } from "../../src/core/types.js";

function snapshot(overrides: Partial<RunSnapshot> = {}): RunSnapshot {
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
    },
    updatedAt: 0,
    ...overrides,
  };
}
function deps(runs: RunSnapshot[]) {
  return {
    query: {
      list: () => runs,
      get: () => undefined,
      wait: async () => ({ ok: false as const, reason: "unknown_run" as const }),
      waitAll: async () => ({ settled: [], pending: [] }),
      steer: async () => undefined,
      stop: async () => false,
    },
    orphans: {
      register: () => undefined,
      recordLateRecovered: () => undefined,
      recent: [],
      totalCount: 0,
      lateRecoveredCount: 0,
      countInWindow: () => 0,
      byReason: new Map(),
      resetCircuit: () => undefined,
    },
    notifier: {
      enqueue: () => undefined,
      consume: () => false,
      reconcile: () => ({ redelivered: [], suppressed: [], abandoned: [] }),
      verifyPersisted: () => ({ missing: [] }),
      stats: { pending: 0, delivered: 0, consumed: 0, dropped: 0, abandoned: 0 },
      degraded: [],
    },
  };
}

describe("X9 status usage rendering", () => {
  it("shows per-run usage for active runs", () => {
    const active = snapshot({
      status: "running",
      phase: "model_turn",
      diag: {
        ...snapshot().diag,
        phase: "model_turn",
        usage: { input: 100, output: 50, cacheRead: 10, cacheWrite: 0, costUsd: 0.0123 },
      },
    });
    const text = renderStatus(deps([active]) as never);
    expect(text).toContain("usage=in:100 out:50 cache_r:10 cache_w:0 cost:$0.0123");
  });

  it("shows an aggregate usage line summed across all runs when at least one has usage", () => {
    const a = snapshot({
      runId: "a",
      diag: { ...snapshot().diag, usage: { input: 10, output: 5, cacheRead: 0, cacheWrite: 0, costUsd: 0.01 } },
    });
    const b = snapshot({
      runId: "b",
      diag: { ...snapshot().diag, usage: { input: 20, output: 15, cacheRead: 1, cacheWrite: 0, costUsd: 0.02 } },
    });
    const text = renderStatus(deps([a, b]) as never);
    expect(text).toContain("Usage (all runs): usage=in:30 out:20 cache_r:1 cache_w:0 cost:$0.0300");
  });

  it("omits the aggregate usage line entirely when no run has usage data", () => {
    const text = renderStatus(deps([snapshot()]) as never);
    expect(text).not.toContain("Usage (all runs)");
  });
});
