import { describe, expect, it, vi } from "vitest";
import { createQueryService } from "../../src/service/query-service.js";
import type { RunRegistry, Runner } from "../../src/service/ports.js";
import type { ExtendOutcome, RunSnapshot } from "../../src/core/types.js";

function snapshot(runId: string): RunSnapshot {
  return {
    runId,
    generation: 1,
    status: "running",
    phase: "tool_exec",
    deadlines: { enqueuedAt: 0, deadlineAt: 60_000, queueDeadlineAt: undefined, hardDeadlineAt: 120_000 },
    diag: {
      createdAt: 0,
      phase: "tool_exec",
      phaseEnteredAt: 0,
      pendingTools: 0,
      turns: 0,
      escalation: [],
      orphaned: false,
      generation: 1,
      degraded: [],
      staleInputs: 0,
      unkillable: [],
    },
    updatedAt: 0,
  };
}

const registryOf = (...snapshots: RunSnapshot[]): RunRegistry => ({
  get: (id) => snapshots.find((s) => s.runId === id),
  list: () => [...snapshots],
});

/**
 * RK-10: these tests pin the QueryService seam only — the runner behind it
 * is a fake returning prefab ExtendOutcomes, so this suite is green both
 * before and after Pkg A fills in RuntimeRunner.extendDeadline.
 */
describe("query-service: extendTimeout", () => {
  it("unknown run → { ok: false, reason: 'unknown_run' } without touching the runner", () => {
    const extendDeadline = vi.fn();
    const runner: Runner = { extendDeadline } as unknown as Runner;
    const query = createQueryService({ registry: registryOf(), runner });
    expect(query.extendTimeout("ghost", 5_000, { source: "tool" })).toEqual({ ok: false, reason: "unknown_run" });
    expect(extendDeadline).not.toHaveBeenCalled();
  });

  it("a runner without extendDeadline → { ok: false, reason: 'unsupported' }", () => {
    const runner: Runner = {} as Runner;
    const query = createQueryService({ registry: registryOf(snapshot("r1")), runner });
    expect(query.extendTimeout("r1", 5_000, { source: "tool" })).toEqual({ ok: false, reason: "unsupported" });
  });

  it("otherwise passes (runId, extendMs, opts) through synchronously and returns the runner's verdict verbatim", () => {
    const outcome: ExtendOutcome = {
      ok: true,
      runId: "r1",
      previousDeadlineAt: 60_000,
      deadlineAt: 65_000,
      requestedMs: 5_000,
      grantedMs: 5_000,
      clamped: false,
      extensionsUsed: 1,
      extensionsRemaining: 2,
      hardDeadlineAt: 120_000,
      rescuedFromGrace: false,
    };
    const extendDeadline = vi.fn(() => outcome);
    const runner: Runner = { extendDeadline } as unknown as Runner;
    const query = createQueryService({ registry: registryOf(snapshot("r1")), runner });
    const result = query.extendTimeout("r1", 5_000, { source: "tool", reason: "needs more time" });
    expect(result).toBe(outcome); // verbatim, no re-wrapping
    expect(extendDeadline).toHaveBeenCalledWith("r1", 5_000, { source: "tool", reason: "needs more time" });
  });

  it("rejection outcomes pass through untouched as well (single source of truth: runner/reducer)", () => {
    const outcome: ExtendOutcome = { ok: false, reason: "limit_reached" };
    const runner: Runner = { extendDeadline: () => outcome } as unknown as Runner;
    const query = createQueryService({ registry: registryOf(snapshot("r1")), runner });
    expect(query.extendTimeout("r1", 5_000, { source: "tool" })).toBe(outcome);
  });
});
