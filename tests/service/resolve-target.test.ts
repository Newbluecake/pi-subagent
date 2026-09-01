import { describe, expect, it } from "vitest";
import { resolveResumeTarget, resolveRunId, type ResolveTargetDeps } from "../../src/service/resolve-target.js";
import { TombstoneStore } from "../../src/service/tombstone.js";
import type { RunSnapshot } from "../../src/core/types.js";

const sessionFile = new URL("../../package.json", import.meta.url).pathname;
function snapshot(runId: string, status: RunSnapshot["status"] = "completed", file = sessionFile): RunSnapshot {
  return {
    runId,
    generation: 1,
    status,
    phase: status === "completed" ? "settled" : "model_turn",
    deadlines: { enqueuedAt: 0, deadlineAt: undefined, queueDeadlineAt: undefined },
    diag: {
      createdAt: 0,
      phase: status === "completed" ? "settled" : "model_turn",
      phaseEnteredAt: 0,
      pendingTools: 0,
      turns: 1,
      escalation: [],
      orphaned: false,
      generation: 1,
      degraded: [],
      staleInputs: 0,
      unkillable: [],
      ...(file === undefined ? {} : { sessionFile: file }),
    },
    updatedAt: 0,
  };
}
function deps(snapshots: RunSnapshot[], labels = new Map<string, { runId: string }>()): ResolveTargetDeps {
  return { labels, liveSnapshots: [], records: snapshots, tombstones: new TombstoneStore(), now: () => 60_000 };
}

describe("model-facing target resolution", () => {
  it("uses an exact run id before a same-named label", () => {
    const exact = "r_ABCDEFGH";
    const other = "r_ABCDEFGJ";
    const result = resolveRunId(exact, deps([snapshot(exact), snapshot(other)], new Map([[exact, { runId: other }]])));
    expect(result).toEqual({ ok: true, runId: exact });
  });

  it("rejects an ambiguous prefix and reports only resumable terminal candidates", () => {
    const result = resolveResumeTarget("r_", deps([snapshot("r_ABCDEFGH"), snapshot("r_ABCDEFGJ", "running")]));
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error).toContain("Resumable targets:");
    expect(result.error).toContain("r_ABCDEFGH");
    expect(result.error).not.toContain("r_ABCDEFGJ (running");
    expect(result.candidates).toHaveLength(1);
  });

  it("normalizes candidate labels and caps the list", () => {
    const labels = new Map<string, { runId: string }>();
    const snapshots = Array.from({ length: 12 }, (_, i) => {
      const runId = `r_${String(i).padStart(8, "0")}`;
      labels.set(`line\nlabel\u0001${"x".repeat(60)}`, { runId });
      return snapshot(runId);
    });
    const result = resolveRunId("missing", deps(snapshots, labels));
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.candidates).toHaveLength(10);
    expect(result.candidates[0]?.label).not.toContain("\n");
    expect(result.candidates[0]?.label.length).toBeLessThanOrEqual(40);
  });
});
