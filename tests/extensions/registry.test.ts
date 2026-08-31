import { describe, expect, it, vi } from "vitest";
import { mergeExtensionPoints } from "../../src/extensions/registry.js";
import type { DeliveryPayload, LifecycleEvent, RunOutcome, SubagentExtensionPoints } from "../../src/core/types.js";

const lifecycleEvent: LifecycleEvent = { runId: "r", generation: 1, status: "completed", at: 0 };
const outcome: RunOutcome = {
  runId: "r",
  status: "completed",
  turns: 0,
  durationMs: 0,
  diag: {
    createdAt: 0,
    phase: "settled",
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
const payload: DeliveryPayload = {
  key: "r:1:completed",
  runId: "r",
  generation: 1,
  status: "completed",
  textPreview: "",
  diag: { phase: "settled", status: "completed", pendingTools: 0, staleInputs: 0, degraded: 0 },
  createdAt: 0,
  reconcileRound: 0,
};

describe("mergeExtensionPoints", () => {
  it("returns an extension-less object with no hooks defined when given an empty list", () => {
    const merged = mergeExtensionPoints([]);
    expect(merged.onLifecycle).toBeUndefined();
    expect(merged.resolveSessionSpec).toBeUndefined();
    expect(merged.beforeReap).toBeUndefined();
    expect(merged.onDelivery).toBeUndefined();
  });

  it("H1: fans out onLifecycle to every extension, isolating a throw from one so the rest still run", () => {
    const calls: string[] = [];
    const a: SubagentExtensionPoints = {
      onLifecycle: () => {
        calls.push("a");
        throw new Error("boom from a");
      },
    };
    const b: SubagentExtensionPoints = { onLifecycle: () => calls.push("b") };
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const merged = mergeExtensionPoints([a, b]);
    expect(() => merged.onLifecycle?.(lifecycleEvent)).not.toThrow();
    expect(calls).toEqual(["a", "b"]);
    expect(warn).toHaveBeenCalledTimes(1);
    warn.mockRestore();
  });

  it("H2: composes resolveSessionSpec in registration order, each extension seeing the previous one's output", () => {
    const a: SubagentExtensionPoints = {
      resolveSessionSpec: (spec) => ({ ...spec, cwd: `${spec.cwd ?? ""}/a` }),
    };
    const b: SubagentExtensionPoints = {
      resolveSessionSpec: (spec) => ({ ...spec, cwd: `${spec.cwd ?? ""}/b` }),
    };
    const merged = mergeExtensionPoints([a, b]);
    return Promise.resolve(merged.resolveSessionSpec?.({}, { type: "worker", prompt: "x" })).then((spec) => {
      expect(spec?.cwd).toBe("/a/b");
    });
  });

  it("H2: does NOT swallow a thrown/rejected resolveSessionSpec — the caller must see the failure", async () => {
    const a: SubagentExtensionPoints = {
      resolveSessionSpec: () => {
        throw new Error("bad worktree config");
      },
    };
    const merged = mergeExtensionPoints([a]);
    await expect(Promise.resolve(merged.resolveSessionSpec?.({}, { type: "worker", prompt: "x" }))).rejects.toThrow(
      "bad worktree config",
    );
  });

  it("H3: runs beforeReap sequentially, catching a throw so remaining extensions and the caller still complete", async () => {
    const calls: string[] = [];
    const a: SubagentExtensionPoints = {
      beforeReap: async () => {
        calls.push("a");
        throw new Error("commit failed");
      },
    };
    const b: SubagentExtensionPoints = { beforeReap: async () => calls.push("b") };
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const merged = mergeExtensionPoints([a, b]);
    await expect(merged.beforeReap?.(outcome, { cwd: "/tmp/x", deadlineMs: 5000 })).resolves.toBeUndefined();
    expect(calls).toEqual(["a", "b"]);
    expect(warn).toHaveBeenCalledTimes(1);
    warn.mockRestore();
  });

  it("H4: fans out onDelivery to every extension, isolating a throw from one so the rest still run", () => {
    const calls: string[] = [];
    const a: SubagentExtensionPoints = {
      onDelivery: () => {
        calls.push("a");
        throw new Error("webhook down");
      },
    };
    const b: SubagentExtensionPoints = { onDelivery: () => calls.push("b") };
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const merged = mergeExtensionPoints([a, b]);
    expect(() => merged.onDelivery?.(payload, "delivered")).not.toThrow();
    expect(calls).toEqual(["a", "b"]);
    warn.mockRestore();
  });
});
