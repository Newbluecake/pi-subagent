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
    expect(request).toEqual({ type: "worker", prompt: "continue from the last checkpoint", resumeFrom: "run-1" });
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

  it("keeps the first registration and warns on label conflict", () => {
    const warn = vi.fn();
    const registry = createMentionRegistry(warn);
    expect(registry.register("builder", { runId: "run-1", type: "worker" })).toBe(true);
    expect(registry.register("builder", { runId: "run-2", type: "worker" })).toBe(false);
    expect(registry.resolve("builder")).toEqual({ runId: "run-1", type: "worker" });
    expect(warn).toHaveBeenCalledWith(expect.stringContaining("label conflict"));
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
