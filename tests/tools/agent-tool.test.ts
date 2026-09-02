import { describe, expect, it } from "vitest";
import { Text } from "@earendil-works/pi-tui";
import { createAgentTool, type NestedSpawnPort } from "../../src/tools/agent-tool.js";
import type { RunDiagnostics, RunOutcome, SpawnRequest } from "../../src/core/types.js";

function outcome(
  runId: string,
  overrides: Partial<RunOutcome> = {},
  diagOverrides: Partial<RunDiagnostics> = {},
): RunOutcome {
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
      ...diagOverrides,
    },
    ...overrides,
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

describe("tools/agent-tool: foreground failure diagnostics", () => {
  const failed = (text?: string, sessionFile?: string) =>
    outcome("failed-42", { status: "failed", text, error: { message: "boom" } }, { sessionFile });

  it("includes runId, a non-committal resume hint, and a capped output tail", async () => {
    const port = fakePort();
    port.spawnAndWait = async () => failed("x".repeat(1000), "/missing/session.json");
    const tool = createAgentTool({ spawn: port });
    await expect(
      tool.execute(
        "tc1",
        { description: "demo", prompt: "p", subagent_type: "general" },
        undefined,
        undefined,
        {} as never,
      ),
    ).rejects.toThrow(/did not complete successfully: boom.*run_id: failed-42.*may be resumable.*resume: "failed-42"/);
    try {
      await tool.execute(
        "tc2",
        { description: "demo", prompt: "p", subagent_type: "general" },
        undefined,
        undefined,
        {} as never,
      );
    } catch (error) {
      const message = String(error);
      expect(message).toContain(`…${"x".repeat(500)}`);
      expect(message).not.toContain("x".repeat(502));
      expect(message.length).toBeGreaterThan(500);
    }
  });

  it("does not check session-file existence before using the non-committal hint", async () => {
    const port = fakePort();
    port.spawnAndWait = async () => failed(undefined, "/definitely/not/on/disk");
    const tool = createAgentTool({ spawn: port });
    await expect(
      tool.execute(
        "tc1",
        { description: "demo", prompt: "p", subagent_type: "general" },
        undefined,
        undefined,
        {} as never,
      ),
    ).rejects.toThrow(/may be resumable/);
  });

  it("explains when no session was created and omits blank output tails", async () => {
    const port = fakePort();
    port.spawnAndWait = async () => failed("   ");
    const tool = createAgentTool({ spawn: port });
    await expect(
      tool.execute(
        "tc1",
        { description: "demo", prompt: "p", subagent_type: "general" },
        undefined,
        undefined,
        {} as never,
      ),
    ).rejects.toThrow(/nothing to resume/);
  });
});

describe("tools/agent-tool: timeout_ms budget override", () => {
  it("threads timeout_ms into budgetOverride.totalMs; omits it when absent", async () => {
    const port = fakePort();
    const tool = createAgentTool({ spawn: port });
    await tool.execute(
      "tc1",
      { description: "d", prompt: "p", subagent_type: "worker", timeout_ms: 120_000 },
      undefined,
      undefined,
      {} as never,
    );
    expect(port.seen?.budgetOverride).toEqual({ totalMs: 120_000 });

    const port2 = fakePort();
    const tool2 = createAgentTool({ spawn: port2 });
    await tool2.execute(
      "tc2",
      { description: "d", prompt: "p", subagent_type: "worker" },
      undefined,
      undefined,
      {} as never,
    );
    expect(port2.seen?.budgetOverride).toBeUndefined();
  });
});

describe("tools/agent-tool: renderCall (TUI call card)", () => {
  // Bare-minimum Theme stand-in: renderCall only uses fg()/bold().
  const theme = { fg: (_color: string, t: string) => t, bold: (t: string) => t };
  const ctx = (lastComponent?: unknown) => ({ lastComponent, state: {} });

  it("renders the task description and subagent_type instead of a bare tool name", () => {
    const tool = createAgentTool({ spawn: fakePort() });
    const comp = tool.renderCall!(
      { description: "analyze project", prompt: "p", subagent_type: "general-purpose" },
      theme as never,
      ctx() as never,
    );
    const out = (comp as Text).render(120).join("\n");
    expect(out).toContain("Agent: analyze project");
    expect(out).toContain("type: general-purpose");
  });

  it("marks background / resume / isolation runs and reuses the last component", () => {
    const tool = createAgentTool({ spawn: fakePort() });
    const first = tool.renderCall!(
      {
        description: "d",
        prompt: "p",
        subagent_type: "worker",
        run_in_background: true,
        resume: "old-label",
        isolation: "worktree",
      },
      theme as never,
      ctx() as never,
    ) as Text;
    const out = first.render(120).join("\n");
    expect(out).toContain("background");
    expect(out).toContain("resume: old-label");
    expect(out).toContain("isolation: worktree");
    const second = tool.renderCall!(
      { description: "d2", prompt: "p", subagent_type: "worker" },
      theme as never,
      ctx(first) as never,
    );
    expect(second).toBe(first); // same Text instance, mutated in place (bash-tool convention)
    expect((second as Text).render(120).join("\n")).toContain("Agent: d2");
  });

  it("tolerates partial streaming args (no description yet)", () => {
    const tool = createAgentTool({ spawn: fakePort() });
    const comp = tool.renderCall!({}, theme as never, ctx() as never) as Text;
    expect(comp.render(120).join("\n")).toContain("Agent:");
  });
});

describe("tools/agent-tool: thinking parameter passthrough", () => {
  it("forwards the thinking param as thinkingOverride on the spawn request", async () => {
    const port = fakePort();
    const tool = createAgentTool({ spawn: port });
    await tool.execute(
      "tc1",
      { description: "d", prompt: "p", subagent_type: "worker", thinking: "low" },
      undefined,
      undefined,
      {} as never,
    );
    expect(port.seen).toMatchObject({ type: "worker", thinkingOverride: "low" });
  });

  it("omits thinkingOverride entirely when the thinking param is not given", async () => {
    const port = fakePort();
    const tool = createAgentTool({ spawn: port });
    await tool.execute(
      "tc1",
      { description: "d", prompt: "p", subagent_type: "worker" },
      undefined,
      undefined,
      {} as never,
    );
    expect(port.seen && "thinkingOverride" in port.seen).toBe(false);
  });
});
