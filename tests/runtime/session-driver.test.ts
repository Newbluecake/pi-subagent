import { describe, expect, it, vi } from "vitest";
import { mapContextUsage, mapEvent, PiSessionDriver } from "../../src/runtime/session-driver.js";

/**
 * Regression: pi's Usage carries cost as nested `cost.total`, not a flat
 * `costUsd`. Passing the raw object through left `costUsd` undefined and
 * `base + undefined` poisoned the lifetime accumulator with NaN — the fleet
 * widget rendered "$NaN". mapEvent must map + clamp at the boundary.
 */
describe("session-driver mapEvent: usage mapping (pi Usage → UsageDelta)", () => {
  it("maps a full pi usage object, flattening cost.total into costUsd", () => {
    const ev = mapEvent({
      type: "message_end",
      message: {
        usage: {
          input: 10,
          output: 5,
          cacheRead: 2,
          cacheWrite: 1,
          totalTokens: 18,
          cost: { input: 0.001, output: 0.002, cacheRead: 0, cacheWrite: 0, total: 0.003 },
        },
      },
    });
    expect(ev).toEqual({
      t: "message_end",
      usage: { input: 10, output: 5, cacheRead: 2, cacheWrite: 1, costUsd: 0.003 },
    });
  });

  it("clamps a missing cost object to costUsd 0 instead of NaN", () => {
    const ev = mapEvent({ type: "message_end", message: { usage: { input: 3, output: 1 } } });
    expect(ev).toEqual({
      t: "message_end",
      usage: { input: 3, output: 1, cacheRead: 0, cacheWrite: 0, costUsd: 0 },
    });
  });

  it("clamps non-finite provider fields (NaN/undefined) to 0", () => {
    const ev = mapEvent({
      type: "message_end",
      message: {
        usage: {
          input: Number.NaN,
          output: undefined,
          cacheRead: 1,
          cacheWrite: 0,
          cost: { total: Number.POSITIVE_INFINITY },
        },
      },
    });
    expect(ev).toEqual({
      t: "message_end",
      usage: { input: 0, output: 0, cacheRead: 1, cacheWrite: 0, costUsd: 0 },
    });
  });

  it("omits usage entirely when the message carries none", () => {
    for (const raw of [{ type: "message_end", message: {} }, { type: "message_end" }]) {
      const ev = mapEvent(raw);
      expect(ev).toEqual({ t: "message_end" });
      expect(ev && "usage" in ev).toBe(false);
    }
  });
});

describe("session-driver context usage mapping", () => {
  it("validates and normalizes context usage", () => {
    expect(mapContextUsage({ tokens: 12, contextWindow: 262_144, percent: 12.34 })).toEqual({
      tokens: 12,
      contextWindow: 262_144,
      percent: 12.34,
    });
    expect(mapContextUsage({ tokens: null, contextWindow: 262_144, percent: null })).toEqual({
      tokens: null,
      contextWindow: 262_144,
      percent: null,
    });
    expect(mapContextUsage({ tokens: -1, contextWindow: 262_144, percent: 120 })).toEqual({
      tokens: null,
      contextWindow: 262_144,
      percent: 100,
    });
    expect(mapContextUsage({ tokens: Number.NaN, contextWindow: 262_144, percent: -5 })).toEqual({
      tokens: null,
      contextWindow: 262_144,
      percent: 0,
    });
    for (const value of [0, -1, Number.NaN, undefined])
      expect(mapContextUsage({ tokens: 1, contextWindow: value, percent: 1 })).toBeUndefined();
  });

  it("samples after message_end and compaction_end", async () => {
    let subscribe: ((event: unknown) => void) | undefined;
    const getContextUsage = vi.fn(() => ({ tokens: 32_768, contextWindow: 262_144, percent: 12.5 }));
    const handle = { session: { subscribe: (cb: (event: unknown) => void) => (subscribe = cb), getContextUsage } };
    const events: unknown[] = [];
    await new PiSessionDriver().bind(handle as never, (event) => events.push(event));
    subscribe?.({ type: "message_end" });
    subscribe?.({ type: "compaction_end", aborted: false });
    expect(getContextUsage).toHaveBeenCalledTimes(2);
    expect(events).toEqual([
      { t: "message_end" },
      { t: "context_usage", usage: { tokens: 32_768, contextWindow: 262_144, percent: 12.5 } },
      { t: "compaction_end", aborted: false },
      { t: "context_usage", usage: { tokens: 32_768, contextWindow: 262_144, percent: 12.5 } },
    ]);
  });

  it("disables sampling once capability is absent or throws", async () => {
    for (const hasCapability of [false, true]) {
      let subscribe: ((event: unknown) => void) | undefined;
      const getContextUsage = hasCapability
        ? vi.fn(() => {
            throw new Error("x");
          })
        : undefined;
      const session = {
        subscribe: (cb: (event: unknown) => void) => (subscribe = cb),
        ...(getContextUsage === undefined ? {} : { getContextUsage }),
      };
      const events: unknown[] = [];
      await new PiSessionDriver().bind({ session } as never, (event) => events.push(event));
      subscribe?.({ type: "message_end" });
      subscribe?.({ type: "compaction_end", aborted: false });
      expect(events.map((event) => (event as { t: string }).t)).toEqual(["message_end", "compaction_end"]);
      if (getContextUsage) expect(getContextUsage).toHaveBeenCalledTimes(1);
    }
  });
});

describe("session-driver mapEvent: message_update streaming (assistantMessageEvent)", () => {
  it("maps thinking_delta to a thinking_delta driver event", () => {
    const ev = mapEvent({
      type: "message_update",
      message: { role: "assistant", content: [{ type: "thinking", thinking: "let me" }] },
      assistantMessageEvent: { type: "thinking_delta", contentIndex: 0, delta: "let me" },
    });
    expect(ev).toEqual({ t: "thinking_delta", delta: "let me" });
  });

  it("maps text_delta to a text_delta driver event (block-array content never matches the legacy string check)", () => {
    const ev = mapEvent({
      type: "message_update",
      message: { role: "assistant", content: [{ type: "text", text: "hello" }] },
      assistantMessageEvent: { type: "text_delta", contentIndex: 0, delta: "hello" },
    });
    expect(ev).toEqual({ t: "text_delta", delta: "hello" });
  });

  it("ignores non-delta assistant events (thinking_start/text_end/toolcall_delta…)", () => {
    for (const ae of [
      { type: "thinking_start", contentIndex: 0 },
      { type: "thinking_end", contentIndex: 0, content: "done" },
      { type: "text_start", contentIndex: 0 },
      { type: "toolcall_delta", contentIndex: 0, delta: "{}" },
    ]) {
      const ev = mapEvent({
        type: "message_update",
        message: { role: "assistant", content: [] },
        assistantMessageEvent: ae,
      });
      expect(ev).toBeUndefined();
    }
  });

  it("keeps the legacy plain-string content fallback (non-assistant messages)", () => {
    const ev = mapEvent({ type: "message_update", message: { content: "plain" } });
    expect(ev).toEqual({ t: "text_delta", delta: "plain" });
  });
});
