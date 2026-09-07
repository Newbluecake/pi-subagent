import { describe, expect, it } from "vitest";
import { createQueryService } from "../../src/service/query-service.js";
import type { RunSnapshot, RunOutcome, SetModelOutcome } from "../../src/core/types.js";
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
const model = { provider: "anthropic", id: "claude-haiku-4" };
function make(status: RunSnapshot["status"], setModel?: Runner["setModel"], get = () => snapshot(status)) {
  const registry: RunRegistry = { get, list: () => [] };
  return createQueryService({ registry, runner: { run: async () => outcome, ...(setModel ? { setModel } : {}) } });
}

describe("QueryService.setModel", () => {
  it("forwards to the runner for a running run, threading model + thinking", async () => {
    let seen: { runId: string; model: unknown; opts: unknown } | undefined;
    const ok: SetModelOutcome = { ok: true, model, thinking: "high" };
    const q = make("running", async (runId, m, opts) => {
      seen = { runId, model: m, opts };
      return ok;
    });
    expect(await q.setModel("run-1", model, { thinking: "high" })).toEqual(ok);
    expect(seen).toEqual({ runId: "run-1", model, opts: { thinking: "high" } });
  });

  it("returns not_running for unknown / non-running runs without touching the runner", async () => {
    let called = false;
    const spy = (async () => {
      called = true;
      return { ok: true, model } as const;
    }) satisfies Runner["setModel"];
    expect(await make("completed", spy).setModel("run-1", model)).toEqual({ ok: false, reason: "not_running" });
    expect(
      await createQueryService({
        registry: { get: () => undefined, list: () => [] },
        runner: { run: async () => outcome, setModel: spy },
      }).setModel("missing", model),
    ).toEqual({ ok: false, reason: "not_running" });
    expect(called).toBe(false);
  });

  it("treats a runner without setModel (legacy driver) as not_running", async () => {
    expect(await make("running").setModel("run-1", model)).toEqual({ ok: false, reason: "not_running" });
  });

  it("maps a throwing runner to rejected + detail", async () => {
    const q = make("running", async () => {
      throw new Error("driver exploded");
    });
    expect(await q.setModel("run-1", model)).toEqual({ ok: false, reason: "rejected", detail: "driver exploded" });
  });
});
