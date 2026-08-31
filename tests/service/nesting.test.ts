import { describe, expect, it } from "vitest";
import { createSpawnService } from "../../src/service/spawn-service.js";
import type { AgentTypeConfig, RunOutcome, StopCause } from "../../src/core/types.js";
import type { Runner, SlotPool } from "../../src/service/ports.js";

const pool: SlotPool = { acquire: async (runId) => ({ ok: true, ticket: { runId, release() {} } }) };

function outcome(runId: string, status: RunOutcome["status"] = "completed"): RunOutcome {
  return {
    runId,
    status,
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
}

/**
 * A Runner whose run() promises never settle on their own — the test
 * controls exactly when (and whether) each runId "finishes", so a chain of
 * nested spawns can be built deterministically without any race against
 * SpawnService's own finish()/nesting cleanup.
 */
function controllableRunner() {
  const pending = new Map<string, (o: RunOutcome) => void>();
  const abortCalls: Array<{ runId: string; cause?: StopCause }> = [];
  const runner: Runner = {
    run: (spec) =>
      new Promise<RunOutcome>((resolve) => {
        pending.set(spec.runId, resolve);
      }),
    abort: async (runId, cause) => {
      abortCalls.push({ runId, cause });
      return { ok: true, escalatedTo: "L2" };
    },
  };
  return {
    runner,
    abortCalls,
    settle: (runId: string, o: RunOutcome = outcome(runId)) => {
      pending.get(runId)?.(o);
      pending.delete(runId);
    },
  };
}

function typesRegistry(types: AgentTypeConfig[]) {
  return {
    get: (name: string) => types.find((t) => t.name === name),
    list: () => types,
    reload: async () => ({ types, errors: [] }),
  };
}

describe("SpawnService: X3 nested delegation depth + canSpawn whitelist", () => {
  it("rejects nested delegation depth beyond the configured maximum", async () => {
    const recurser: AgentTypeConfig = {
      name: "recurser",
      description: "x",
      systemPrompt: "",
      promptMode: "append",
      canSpawn: ["recurser"],
    };
    const { runner } = controllableRunner();
    const svc = createSpawnService({ types: typesRegistry([recurser]), pool, runner, now: () => 0, maxNestedDepth: 2 });

    const r0 = await svc.spawn({ type: "recurser", prompt: "a" }); // depth 0
    if ("error" in r0) throw new Error(r0.error.message);
    const r1 = await svc.spawn({ type: "recurser", prompt: "b", parentRunId: r0.runId }); // depth 1
    if ("error" in r1) throw new Error(r1.error.message);
    const r2 = await svc.spawn({ type: "recurser", prompt: "c", parentRunId: r1.runId }); // depth 2 (== max, still ok)
    if ("error" in r2) throw new Error(r2.error.message);

    const r3 = await svc.spawn({ type: "recurser", prompt: "d", parentRunId: r2.runId }); // depth 3 > max(2)
    expect(r3).toEqual({
      error: {
        kind: "config",
        message: "nested delegation depth 3 exceeds the configured maximum (2)",
        retryable: false,
      },
    });
  });

  it("rejects a subagent_type not in the parent's canSpawn whitelist", async () => {
    const planner: AgentTypeConfig = {
      name: "planner",
      description: "x",
      systemPrompt: "",
      promptMode: "append",
      canSpawn: ["worker"],
    };
    const other: AgentTypeConfig = { name: "other", description: "x", systemPrompt: "", promptMode: "append" };
    const { runner } = controllableRunner();
    const svc = createSpawnService({ types: typesRegistry([planner, other]), pool, runner, now: () => 0 });

    const top = await svc.spawn({ type: "planner", prompt: "a" });
    if ("error" in top) throw new Error(top.error.message);

    const rejected = await svc.spawn({ type: "other", prompt: "b", parentRunId: top.runId });
    expect(rejected).toEqual({
      error: {
        kind: "config",
        message: 'nested delegation is not permitted: parent\'s agent type may only spawn [worker], not "other"',
        retryable: false,
      },
    });
  });

  it("allows a whitelisted subagent_type at or under the depth cap", async () => {
    const worker: AgentTypeConfig = {
      name: "worker",
      description: "x",
      systemPrompt: "",
      promptMode: "append",
      canSpawn: ["worker"],
    };
    const { runner } = controllableRunner();
    const svc = createSpawnService({ types: typesRegistry([worker]), pool, runner, now: () => 0, maxNestedDepth: 3 });
    const top = await svc.spawn({ type: "worker", prompt: "a" });
    if ("error" in top) throw new Error(top.error.message);
    const child = await svc.spawn({ type: "worker", prompt: "b", parentRunId: top.runId });
    expect("error" in child).toBe(false);
  });
});

describe("SpawnService: X3 cascading abort", () => {
  it("aborts nested children (and grandchildren) before/alongside the explicitly-aborted parent", async () => {
    const worker: AgentTypeConfig = {
      name: "worker",
      description: "x",
      systemPrompt: "",
      promptMode: "append",
      canSpawn: ["worker"],
    };
    const { runner, abortCalls } = controllableRunner();
    const svc = createSpawnService({ types: typesRegistry([worker]), pool, runner, now: () => 0 });

    const parent = await svc.spawn({ type: "worker", prompt: "a" });
    if ("error" in parent) throw new Error(parent.error.message);
    const child = await svc.spawn({ type: "worker", prompt: "b", parentRunId: parent.runId });
    if ("error" in child) throw new Error(child.error.message);
    const grandchild = await svc.spawn({ type: "worker", prompt: "c", parentRunId: child.runId });
    if ("error" in grandchild) throw new Error(grandchild.error.message);

    const ok = await svc.abort(parent.runId, "user_stop");
    expect(ok).toBe(true);

    // Depth-first: grandchild and child are aborted with cause "parent_abort"
    // (never the cause the *top* abort was requested with), before the
    // parent's own runner.abort call carries the original cause through.
    expect(abortCalls).toEqual([
      { runId: grandchild.runId, cause: "parent_abort" },
      { runId: child.runId, cause: "parent_abort" },
      { runId: parent.runId, cause: "user_stop" },
    ]);
  });

  it("does not cascade to a sibling that shares no ancestry with the aborted run", async () => {
    const worker: AgentTypeConfig = {
      name: "worker",
      description: "x",
      systemPrompt: "",
      promptMode: "append",
      canSpawn: ["worker"],
    };
    const { runner, abortCalls } = controllableRunner();
    const svc = createSpawnService({ types: typesRegistry([worker]), pool, runner, now: () => 0 });

    const parentA = await svc.spawn({ type: "worker", prompt: "a" });
    if ("error" in parentA) throw new Error(parentA.error.message);
    const parentB = await svc.spawn({ type: "worker", prompt: "b" });
    if ("error" in parentB) throw new Error(parentB.error.message);
    const childOfA = await svc.spawn({ type: "worker", prompt: "c", parentRunId: parentA.runId });
    if ("error" in childOfA) throw new Error(childOfA.error.message);

    await svc.abort(parentB.runId, "user_stop");

    expect(abortCalls).toEqual([{ runId: parentB.runId, cause: "user_stop" }]);
    expect(abortCalls.some((c) => c.runId === childOfA.runId)).toBe(false);
  });
});
