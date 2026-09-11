import { describe, expect, it, vi } from "vitest";
import { createMentionRegistry } from "../../src/mention/registry.js";
import { installMentionInput, parseMention, routeMention } from "../../src/mention/mention.js";
import type { RunSnapshot } from "../../src/core/types.js";

function snapshot(runId: string, status: RunSnapshot["status"]): RunSnapshot {
  return {
    runId,
    generation: 1,
    status,
    phase: status === "running" ? "prompt_dispatch" : "settled",
    deadlines: { enqueuedAt: 0, deadlineAt: undefined, queueDeadlineAt: undefined },
    updatedAt: 1,
    diag: {
      createdAt: 0,
      phase: status === "running" ? "prompt_dispatch" : "settled",
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
  };
}

describe("X6 @handle mention", () => {
  it("parses only a registered leading handle", () => {
    const registry = createMentionRegistry();
    registry.register("builder", { runId: "run-1", type: "worker" });
    expect(parseMention("@builder fix the test", registry)).toEqual({ label: "builder", message: "fix the test" });
    expect(parseMention("please @builder fix the test", registry)).toBeUndefined();
    expect(parseMention("@missing fix the test", registry)).toBeUndefined();
  });

  it("steers a known running agent", async () => {
    const registry = createMentionRegistry();
    registry.register("builder", { runId: "run-1", type: "worker" });
    const steers: [string, string][] = [];
    const result = await routeMention("@builder inspect the failure", {
      registry,
      query: {
        get: () => snapshot("run-1", "running"),
        steer: async (id, text) => {
          steers.push([id, text]);
          return { ok: true as const };
        },
      },
      spawn: { spawn: async () => ({ runId: "unexpected" }) },
    });
    expect(result).toEqual({ handled: true, action: "steer", runId: "run-1" });
    expect(steers).toEqual([["run-1", "inspect the failure"]]);
  });

  it("resumes a known terminal agent with its registered type", async () => {
    const registry = createMentionRegistry();
    registry.register("builder", { runId: "run-1", type: "worker" });
    let request: { type: string; prompt: string; resumeFrom?: string } | undefined;
    const result = await routeMention("@builder continue from the last checkpoint", {
      registry,
      query: { get: () => snapshot("run-1", "completed"), steer: async () => undefined },
      spawn: { spawn: async (req) => ((request = req), { runId: "run-2" }) },
    });
    expect(result).toEqual({ handled: true, action: "resume", runId: "run-2" });
    expect(request).toEqual({
      type: "worker",
      prompt: "continue from the last checkpoint",
      label: "builder",
      resumeFrom: "run-1",
    });
  });

  it("wraps steered text with the message_agent reply hint when fabric is enabled", async () => {
    const registry = createMentionRegistry();
    registry.register("builder", { runId: "run-1", type: "worker" });
    const steers: [string, string][] = [];
    const result = await routeMention("@builder inspect the failure", {
      registry,
      query: {
        get: () => snapshot("run-1", "running"),
        steer: async (id, text) => {
          steers.push([id, text]);
          return { ok: true as const };
        },
      },
      spawn: { spawn: async () => ({ runId: "unexpected" }) },
      fabricEnabled: () => true,
    });
    expect(result).toEqual({ handled: true, action: "steer", runId: "run-1" });
    expect(steers).toHaveLength(1);
    const [id, text] = steers[0]!;
    expect(id).toBe("run-1");
    expect(text).toContain("@builder");
    expect(text).toContain("message_agent");
    expect(text).toContain('to: "root"');
    expect(text).toContain("用户消息：\ninspect the failure");
  });

  it("wraps the resume prompt with the message_agent reply hint when fabric is enabled", async () => {
    const registry = createMentionRegistry();
    registry.register("builder", { runId: "run-1", type: "worker" });
    let request: { type: string; prompt: string; resumeFrom?: string } | undefined;
    const result = await routeMention("@builder continue from the last checkpoint", {
      registry,
      query: { get: () => snapshot("run-1", "completed"), steer: async () => undefined },
      spawn: { spawn: async (req) => ((request = req), { runId: "run-2" }) },
      fabricEnabled: () => true,
    });
    expect(result).toEqual({ handled: true, action: "resume", runId: "run-2" });
    expect(request?.type).toBe("worker");
    expect(request?.resumeFrom).toBe("run-1");
    expect(request?.prompt).toContain("message_agent");
    expect(request?.prompt).toContain("用户消息：\ncontinue from the last checkpoint");
  });

  it("records the raw user message via noteMention on both steer and resume paths", async () => {
    const registry = createMentionRegistry();
    registry.register("builder", { runId: "run-1", type: "worker" });
    const notes: [string, string, number | undefined][] = [];
    const noteMention = (runId: string, message: string, pendingSince?: number) =>
      notes.push([runId, message, pendingSince]);
    // steer path: noted against the running target, raw (unframed) message, with a
    // pending baseline taken from the target's post-steer lastEventAt
    const steered = snapshot("run-1", "running");
    steered.diag.lastEventAt = 42;
    steered.diag.lastEventType = "tool_end";
    await routeMention("@builder 进展如何", {
      registry,
      query: { get: () => steered, steer: async () => ({ ok: true as const }) },
      spawn: { spawn: async () => ({ runId: "unexpected" }) },
      fabricEnabled: () => true,
      noteMention,
    });
    expect(notes).toEqual([["run-1", "进展如何", 42]]);
    // resume path: noted against the NEW run id, pinned (no baseline)
    const notes2: [string, string, number | undefined][] = [];
    await routeMention("@builder 继续", {
      registry,
      query: { get: () => snapshot("run-1", "completed"), steer: async () => undefined },
      spawn: { spawn: async () => ({ runId: "run-2" }) },
      fabricEnabled: () => true,
      noteMention: (runId, message, pendingSince) => notes2.push([runId, message, pendingSince]),
    });
    expect(notes2).toEqual([["run-2", "继续", undefined]]);
  });

  it("degrades the steer baseline to 0 when the target diag has no events yet", async () => {
    const registry = createMentionRegistry();
    registry.register("builder", { runId: "run-1", type: "worker" });
    const notes: [string, string, number | undefined][] = [];
    await routeMention("@builder 在吗", {
      registry,
      query: { get: () => snapshot("run-1", "running"), steer: async () => ({ ok: true as const }) },
      spawn: { spawn: async () => ({ runId: "unexpected" }) },
      noteMention: (runId, message, pendingSince) => notes.push([runId, message, pendingSince]),
    });
    expect(notes).toEqual([["run-1", "在吗", 0]]);
  });

  it("sends the raw message when fabric is disabled", async () => {
    const registry = createMentionRegistry();
    registry.register("builder", { runId: "run-1", type: "worker" });
    const steers: [string, string][] = [];
    await routeMention("@builder inspect the failure", {
      registry,
      query: {
        get: () => snapshot("run-1", "running"),
        steer: async (id, text) => {
          steers.push([id, text]);
          return { ok: true as const };
        },
      },
      spawn: { spawn: async () => ({ runId: "unexpected" }) },
      fabricEnabled: () => false,
    });
    expect(steers).toEqual([["run-1", "inspect the failure"]]);
  });

  it("passes unknown handles and file paths through to pi", async () => {
    const registry = createMentionRegistry();
    registry.register("builder", { runId: "run-1", type: "worker" });
    const deps = {
      registry,
      query: { get: () => snapshot("run-1", "running"), steer: async () => undefined },
      spawn: { spawn: async () => ({ runId: "unexpected" }) },
    };
    expect((await routeMention("@unknown/path read this", deps)).handled).toBe(false);
    expect((await routeMention("@src/file.ts read this", deps)).handled).toBe(false);
    expect((await routeMention("@builder", deps)).handled).toBe(false);
  });

  it("routes suffixed labels for steer and resume, while the old label remains on its original run", async () => {
    const registry = createMentionRegistry();
    registry.register("builder", { runId: "run-old", type: "worker" });
    registry.register("builder-2", { runId: "run-new", type: "worker" });
    const steers: string[] = [];
    await routeMention("@builder-2 inspect", {
      registry,
      query: {
        get: () => snapshot("run-new", "running"),
        steer: async (id) => (steers.push(id), { ok: true as const }),
      },
      spawn: { spawn: async () => ({ runId: "unexpected" }) },
    });
    expect(steers).toEqual(["run-new"]);
    let resumedFrom: string | undefined;
    await routeMention("@builder continue", {
      registry,
      query: { get: () => snapshot("run-old", "completed"), steer: async () => undefined },
      spawn: { spawn: async (req) => ((resumedFrom = req.resumeFrom), { runId: "run-resumed" }) },
    });
    expect(resumedFrom).toBe("run-old");
  });

  it("keeps the first registration and warns on label conflict", () => {
    const warn = vi.fn();
    const registry = createMentionRegistry(warn);
    expect(registry.register("builder", { runId: "run-1", type: "worker" })).toBe(true);
    expect(registry.register("builder", { runId: "run-2", type: "worker" })).toBe(false);
    expect(registry.resolve("builder")).toEqual({ runId: "run-1", type: "worker" });
    expect(warn).toHaveBeenCalledWith(expect.stringContaining("label conflict"));
  });

  it("reassigns only when explicitly requested and keeps first-wins registration", () => {
    const warn = vi.fn();
    const registry = createMentionRegistry(warn);
    const first = { runId: "run-1", type: "worker" as const, parent: "root" as const };
    const second = { runId: "run-2", type: "worker" as const, parent: "root" as const };
    expect(registry.register("builder", first)).toBe(true);
    expect(registry.register("builder", second)).toBe(false);
    expect(registry.resolve("builder")).toEqual(first);
    registry.reassign("builder", second);
    expect(registry.resolve("builder")).toEqual(second);
    expect(warn).toHaveBeenCalledTimes(1);
  });
  it("reports route errors and consumes the known mention", async () => {
    const registry = createMentionRegistry();
    registry.register("builder", { runId: "run-1", type: "worker" });
    const errors: string[] = [];
    const result = await routeMention("@builder retry", {
      registry,
      query: {
        get: () => snapshot("run-1", "running"),
        steer: async () => ({ ok: false, reason: "steer_rejected", detail: "busy" }),
      },
      spawn: { spawn: async () => ({ runId: "unexpected" }) },
      reportError: (message) => errors.push(message),
    });
    expect(result).toMatchObject({ handled: true, action: "error" });
    expect(errors).toEqual(["cannot steer @builder: busy"]);
  });

  it("registers the pi input handler with conservative actions", async () => {
    const handlers: ((event: { type: "input"; text: string }) => Promise<unknown>)[] = [];
    const sendMessage = vi.fn();
    const registry = createMentionRegistry();
    registry.register("builder", { runId: "run-1", type: "worker" });
    installMentionInput(
      { on: (_event, handler) => handlers.push(handler as (typeof handlers)[number]), sendMessage },
      {
        registry,
        query: {
          get: () => snapshot("run-1", "running"),
          steer: async () => ({ ok: true as const }),
        },
        spawn: { spawn: async () => ({ runId: "unexpected" }) },
      },
    );
    await expect(handlers[0]!({ type: "input", text: "@unknown/path inspect" })).resolves.toEqual({
      action: "continue",
    });
    await expect(handlers[0]!({ type: "input", text: "@builder inspect" })).resolves.toEqual({ action: "handled" });
    expect(sendMessage).not.toHaveBeenCalled();
  });
});
