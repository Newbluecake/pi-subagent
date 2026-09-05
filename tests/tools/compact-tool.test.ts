import { describe, expect, it, vi } from "vitest";
import { createCompactTool } from "../../src/tools/compact-tool.js";

type CompactCallbacks = {
  customInstructions?: string;
  onComplete: (result: { tokensBefore: number }) => void;
  onError: (error: Error) => void;
};

function harness(options: { mode?: "print" | "json"; now?: () => number; cooldownMs?: number } = {}) {
  let callbacks: CompactCallbacks | undefined;
  const compact = vi.fn((next: CompactCallbacks) => {
    callbacks = next;
  });
  const sendUserMessage = vi.fn();
  const ctx = {
    mode: options.mode,
    compact,
    getContextUsage: () => ({ tokens: 12_345 }),
    ui: { notify: vi.fn() },
  };
  const tool = createCompactTool({
    sendUserMessage,
    ...(options.now === undefined ? {} : { now: options.now }),
    ...(options.cooldownMs === undefined ? {} : { cooldownMs: options.cooldownMs }),
  });
  const execute = (params: Record<string, unknown> = {}) =>
    tool.execute!("call", params as never, undefined as never, undefined as never, ctx as never);
  return { callbacks: () => callbacks, compact, ctx, execute, sendUserMessage };
}

describe("tools/compact-tool", () => {
  it("rejects print and json modes without compacting", async () => {
    for (const mode of ["print", "json"] as const) {
      const h = harness({ mode });
      const result = await h.execute();
      expect(result.details).toEqual({ ok: false, reason: "non_interactive_mode" });
      expect(h.compact).not.toHaveBeenCalled();
    }
  });

  it("triggers compaction with custom instructions and terminates", async () => {
    const h = harness();
    const result = await h.execute({ instructions: "Keep the implementation plan and open files." });
    expect(h.compact).toHaveBeenCalledOnce();
    expect(h.callbacks()?.customInstructions).toBe("Keep the implementation plan and open files.");
    expect(result.terminate).toBe(true);
    expect(result.details).toEqual({ ok: true });
  });

  it("rejects a second call while compaction is in flight", async () => {
    const h = harness();
    await h.execute();
    const result = await h.execute();
    expect(result.details).toEqual({ ok: false, reason: "in_flight" });
    expect(h.compact).toHaveBeenCalledOnce();
  });

  it("enforces cooldown and allows a later trigger", async () => {
    let now = 100_000;
    const h = harness({ now: () => now, cooldownMs: 1_000 });
    await h.execute();
    h.callbacks()!.onComplete({ tokensBefore: 10_000 });
    expect((await h.execute()).details).toEqual({ ok: false, reason: "cooldown" });
    now += 1_001;
    await h.execute();
    expect(h.compact).toHaveBeenCalledTimes(2);
  });

  it("sends the default resume message on completion, but not when resume is false", async () => {
    const first = harness();
    await first.execute();
    first.callbacks()!.onComplete({ tokensBefore: 10_000 });
    expect(first.sendUserMessage).toHaveBeenCalledWith(expect.stringContaining("[compact_context]"));

    const second = harness();
    await second.execute({ resume: false });
    second.callbacks()!.onComplete({ tokensBefore: 10_000 });
    expect(second.sendUserMessage).not.toHaveBeenCalled();
  });

  it("sends a failure resume message and resets the guard on error", async () => {
    let now = 100_000;
    const h = harness({ now: () => now, cooldownMs: 1_000 });
    await h.execute();
    h.callbacks()!.onError(new Error("compaction failed"));
    expect(h.sendUserMessage).toHaveBeenCalledWith(expect.stringContaining("[compact_context]"));
    now += 1_001;
    await h.execute();
    expect(h.compact).toHaveBeenCalledTimes(2);
  });

  it("propagates synchronous compact errors and resets the guard", async () => {
    let now = 100_000;
    const error = new Error("stale context");
    const h = harness({ now: () => now, cooldownMs: 1_000 });
    h.compact.mockImplementationOnce(() => {
      throw error;
    });
    await expect(h.execute()).rejects.toBe(error);
    now += 1_001;
    await expect(h.execute()).resolves.toMatchObject({ terminate: true });
    expect(h.compact).toHaveBeenCalledTimes(2);
  });
});
