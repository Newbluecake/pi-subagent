import { describe, expect, it } from "vitest";
import { FakeClock } from "../../src/core/clock.js";
import type { DeliveryPayload } from "../../src/core/types.js";
import { createCoalescer, isCoalescible } from "../../src/delivery/coalescer.js";

const makePayload = (key: string, extra: Partial<DeliveryPayload> = {}): DeliveryPayload => ({
  key,
  runId: key,
  generation: 1,
  status: "completed",
  textPreview: "done",
  diag: { phase: "settled", status: "completed", pendingTools: 0, staleInputs: 0, degraded: 0 },
  createdAt: 0,
  reconcileRound: 0,
  ...extra,
});

describe("coalescer", () => {
  it("merges a window and settles all keys once", () => {
    const clock = new FakeClock();
    const sent: readonly DeliveryPayload[][] = [];
    const settled: unknown[] = [];
    const c = createCoalescer({
      clock,
      windowMs: 100,
      maxBatch: 8,
      send: (items) => (sent as DeliveryPayload[][]).push([...items]),
      onSettled: (keys, ok) => settled.push([keys, ok]),
    });
    c.submit(makePayload("a"));
    c.submit(makePayload("b"));
    c.submit(makePayload("c"));
    expect(sent).toHaveLength(0);
    clock.advance(100);
    expect(sent).toEqual([
      [
        expect.objectContaining({ key: "a" }),
        expect.objectContaining({ key: "b" }),
        expect.objectContaining({ key: "c" }),
      ],
    ]);
    expect(settled).toEqual([[["a", "b", "c"], true]]);
  });

  it("keeps one timer for a window and opens a later window after flush", () => {
    const clock = new FakeClock();
    const sent: string[][] = [];
    const c = createCoalescer({
      clock,
      windowMs: 100,
      maxBatch: 8,
      send: (items) => sent.push(items.map((item) => item.key)),
      onSettled: () => undefined,
    });
    c.submit(makePayload("a"));
    clock.advance(60);
    c.submit(makePayload("b"));
    clock.advance(40);
    c.submit(makePayload("c"));
    clock.advance(100);
    expect(sent).toEqual([["a", "b"], ["c"]]);
  });

  it("flushes synchronously at maxBatch and clears the timer", () => {
    const clock = new FakeClock();
    let sends = 0;
    const c = createCoalescer({ clock, windowMs: 100, maxBatch: 2, send: () => sends++, onSettled: () => undefined });
    c.submit(makePayload("a"));
    c.submit(makePayload("b"));
    expect(sends).toBe(1);
    expect(clock.pendingTimers).toBe(0);
  });

  it("reports flush errors, flushes on dispose once, and sends directly after dispose", () => {
    const clock = new FakeClock();
    const sent: string[][] = [];
    const settled: boolean[] = [];
    const c = createCoalescer({
      clock,
      windowMs: 100,
      maxBatch: 8,
      send: (items) => {
        sent.push(items.map((item) => item.key));
        if (items[0]?.key === "bad") throw new Error("closed");
      },
      onSettled: (_keys, ok) => settled.push(ok),
    });
    c.submit(makePayload("a"));
    c.dispose();
    c.dispose();
    expect(sent).toEqual([["a"]]);
    expect(settled).toEqual([true]);
    expect(c.submit(makePayload("b"))).toBe("sent");
    expect(sent).toEqual([["a"], ["b"]]);

    const failing = createCoalescer({
      clock,
      windowMs: 100,
      maxBatch: 8,
      send: () => {
        throw new Error("closed");
      },
      onSettled: (_keys, ok) => settled.push(ok),
    });
    failing.submit(makePayload("bad"));
    expect(() => failing.dispose()).not.toThrow();
    expect(settled.at(-1)).toBe(false);
  });

  it("cancels buffered entries and recognizes all admission exclusions", () => {
    const clock = new FakeClock();
    const sent: string[][] = [];
    const c = createCoalescer({
      clock,
      windowMs: 10,
      maxBatch: 8,
      send: (items) => sent.push(items.map((x) => x.key)),
      onSettled: () => undefined,
    });
    c.submit(makePayload("a"));
    expect(c.cancel("a")).toBe(true);
    expect(c.cancel("missing")).toBe(false);
    clock.advance(10);
    expect(sent).toEqual([]);
    expect(isCoalescible(makePayload("ok"))).toBe(true);
    expect(isCoalescible(makePayload("failed", { status: "failed" }))).toBe(false);
    expect(isCoalescible(makePayload("degraded", { degradedReason: "pre-finalize" }))).toBe(false);
    expect(isCoalescible(makePayload("round", { reconcileRound: 1 }))).toBe(false);
    expect(isCoalescible(makePayload("retry", { attempts: 1 }))).toBe(false);
  });
});
