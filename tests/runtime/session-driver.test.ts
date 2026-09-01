import { describe, expect, it } from "vitest";
import { mapEvent } from "../../src/runtime/session-driver.js";

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
