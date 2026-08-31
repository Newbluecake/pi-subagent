import { describe, expect, it } from "vitest";
import { createAgentTool, type NestedSpawnPort } from "../../src/tools/agent-tool.js";
import type { RunOutcome, SpawnRequest } from "../../src/core/types.js";

function outcome(runId: string): RunOutcome {
  return {
    runId,
    status: "completed",
    text: "done",
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

function fakePort(): NestedSpawnPort & { seen?: SpawnRequest } {
  const port: NestedSpawnPort & { seen?: SpawnRequest } = {
    async spawn(req) {
      port.seen = req;
      return { runId: "child-1" };
    },
    async spawnAndWait(req) {
      port.seen = req;
      return outcome("child-1");
    },
  };
  return port;
}

describe("tools/agent-tool: X3 nested delegation gating (allowedTypes/forceSlotless)", () => {
  it("rejects a subagent_type outside allowedTypes before ever calling spawn (tool-level defense in depth)", async () => {
    const port = fakePort();
    const tool = createAgentTool({ spawn: port, parentRunId: "parent-1", allowedTypes: ["worker"] });
    await expect(
      tool.execute(
        "tc1",
        { description: "d", prompt: "p", subagent_type: "escalated" },
        undefined,
        undefined,
        {} as never,
      ),
    ).rejects.toThrow(/not in this agent's canSpawn whitelist|nested delegation is not permitted/);
    expect(port.seen).toBeUndefined();
  });

  it("forwards parentRunId, forces slotless, and allows a whitelisted subagent_type", async () => {
    const port = fakePort();
    const tool = createAgentTool({
      spawn: port,
      parentRunId: "parent-1",
      allowedTypes: ["worker"],
      forceSlotless: true,
    });
    await tool.execute(
      "tc1",
      { description: "d", prompt: "p", subagent_type: "worker" },
      undefined,
      undefined,
      {} as never,
    );
    expect(port.seen).toMatchObject({ type: "worker", parentRunId: "parent-1", slotless: true });
  });

  it("the top-level (non-nested) tool has no allowedTypes restriction", async () => {
    const port = fakePort();
    const tool = createAgentTool({ spawn: port });
    await tool.execute(
      "tc1",
      { description: "d", prompt: "p", subagent_type: "anything" },
      undefined,
      undefined,
      {} as never,
    );
    expect(port.seen).toMatchObject({ type: "anything" });
    expect(port.seen?.slotless).toBeUndefined();
  });

  it("forwards an optional schema through to the spawn request", async () => {
    const port = fakePort();
    const tool = createAgentTool({ spawn: port });
    const schema = { type: "object", properties: { ok: { type: "boolean" } } };
    await tool.execute(
      "tc1",
      { description: "d", prompt: "p", subagent_type: "worker", schema },
      undefined,
      undefined,
      {} as never,
    );
    expect(port.seen?.schema).toEqual(schema);
  });
});
