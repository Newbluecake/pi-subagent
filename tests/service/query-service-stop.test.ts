import { describe, expect, it } from "vitest";
import { createQueryService } from "../../src/service/query-service.js";
import type { RunSnapshot, RunOutcome } from "../../src/core/types.js";
import type { Runner, RunRegistry } from "../../src/service/ports.js";

const outcome: RunOutcome = {
  runId: "run-1",
  status: "completed",
  turns: 1,
  durationMs: 1,
  diag: {
    createdAt: 0,
    phase: "settled",
    phaseEnteredAt: 1,
    pendingTools: 0,
    turns: 1,
    escalation: [],
    orphaned: false,
    generation: 1,
    degraded: [],
    staleInputs: 0,
    unkillable: [],
  },
};
function snapshot(status: RunSnapshot["status"]): RunSnapshot {
  return {
    runId: "run-1",
    generation: 1,
    status,
    phase: status === "completed" ? "settled" : "model_turn",
    deadlines: { enqueuedAt: 0, deadlineAt: undefined, queueDeadlineAt: undefined },
    diag: outcome.diag,
    updatedAt: 0,
    ...(status === "completed" ? { outcome } : {}),
  };
}
function make(status: RunSnapshot["status"], abort?: Runner["abort"], get = () => snapshot(status)) {
  const registry: RunRegistry = { get, list: () => [] };
  return createQueryService({ registry, runner: { run: async () => outcome, ...(abort ? { abort } : {}) } });
}

describe("QueryService.stop", () => {
  it("distinguishes unknown, terminal, missing abort, and success", async () => {
    expect(await make("running").stop("run-1")).toEqual({ ok: false, reason: "stop_failed", escalatedTo: "L4" });
    expect(
      await createQueryService({
        registry: { get: () => undefined, list: () => [] },
        runner: { run: async () => outcome },
      }).stop("missing"),
    ).toEqual({ ok: false, reason: "unknown_run" });
    expect(await make("completed").stop("run-1")).toEqual({
      ok: false,
      reason: "already_terminal",
      status: "completed",
    });
    expect(await make("running", async () => ({ ok: true, escalatedTo: "L2" })).stop("run-1")).toEqual({
      ok: true,
      escalatedTo: "L2",
    });
  });

  it("rechecks the registry after a failed abort for the TOCTOU terminal race", async () => {
    let terminal = false;
    const q = make(
      "running",
      async () => {
        terminal = true;
        return { ok: false, escalatedTo: "L3" };
      },
      () => (terminal ? snapshot("aborted") : snapshot("running")),
    );
    expect(await q.stop("run-1")).toEqual({ ok: false, reason: "already_terminal", status: "aborted" });
  });
});
