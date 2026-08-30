import { describe, expect, it } from "vitest";
import { createSpawnService } from "../../src/service/spawn-service.js";
import type { AgentTypeConfig, RunOutcome } from "../../src/core/types.js";
import type { Runner, SlotPool } from "../../src/service/ports.js";

const type: AgentTypeConfig = { name: "worker", description: "worker", systemPrompt: "", promptMode: "append" };
const outcome: RunOutcome = {
  runId: "x",
  status: "completed",
  turns: 1,
  durationMs: 2,
  diag: {
    createdAt: 0,
    phase: "settled",
    phaseEnteredAt: 2,
    settledAt: 2,
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
function deps(runner: Runner) {
  const pool: SlotPool = { acquire: async (runId) => ({ ok: true, ticket: { runId, release() {} } }) };
  return {
    types: { get: () => type, list: () => [], reload: async () => ({ types: [type], errors: [] }) },
    pool,
    runner,
    now: () => 0,
  };
}
describe("SpawnService", () => {
  it("rejects unknown types without invoking runtime", async () => {
    let called = false;
    const result = await createSpawnService({
      ...deps({
        run: async () => {
          called = true;
          return outcome;
        },
      }),
      types: { get: () => undefined, list: () => [], reload: async () => ({ types: [], errors: [] }) },
    }).spawn({ type: "missing", prompt: "x" });
    expect(result).toEqual({ error: { kind: "config", message: "unknown agent type: missing", retryable: false } });
    expect(called).toBe(false);
  });
  it("passes slotless nested requests and returns the runner outcome", async () => {
    let seen: { slotless?: boolean; parentRunId?: string } | undefined;
    const result = await createSpawnService(
      deps({
        run: async (spec) => {
          seen = { slotless: spec.request.slotless, parentRunId: spec.request.parentRunId };
          return { ...outcome, runId: spec.runId };
        },
      }),
    ).spawnAndWait({ type: "worker", prompt: "x", slotless: true, parentRunId: "parent" });
    expect(result.status).toBe("completed");
    expect(seen).toEqual({ slotless: true, parentRunId: "parent" });
  });
});
