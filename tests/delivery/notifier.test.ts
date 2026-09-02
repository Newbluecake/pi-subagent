import { describe, expect, it, vi } from "vitest";
import { FakeClock } from "../../src/core/clock.js";
import { createNotifier as createNotifierImpl, type NotifierOptions } from "../../src/delivery/notifier.js";
import { createCoalescer, isCoalescible } from "../../src/delivery/coalescer.js";
import type { PersistedDelivery, OutboxStore } from "../../src/delivery/notifier.js";
import type { DeliveryPayload } from "../../src/core/types.js";
import { MemoryOutboxStore } from "../../src/core/store.js";

function createNotifier(
  options: Omit<NotifierOptions, "cancelBuffered"> & Partial<Pick<NotifierOptions, "cancelBuffered">>,
) {
  return createNotifierImpl({ ...options, cancelBuffered: options.cancelBuffered ?? (() => undefined) });
}

const payload: DeliveryPayload = {
  key: "r:1",
  runId: "r",
  generation: 1,
  status: "completed",
  textPreview: "done",
  diag: { phase: "settled", status: "completed", pendingTools: 0, staleInputs: 0, degraded: 0 },
  createdAt: 0,
  reconcileRound: 0,
};
class FakeOutbox implements OutboxStore {
  records = new Map<string, PersistedDelivery>();
  put(record: PersistedDelivery) {
    this.records.set(record.key, record);
  }
  update(key: string, patch: Partial<PersistedDelivery>) {
    const old = this.records.get(key);
    if (old) this.records.set(key, { ...old, ...patch });
  }
  list() {
    return [...this.records.values()];
  }
}
describe("Notifier", () => {
  it("retries synchronous send failures with exponential FakeClock backoff", () => {
    const clock = new FakeClock();
    const store = new FakeOutbox();
    let attempts = 0;
    const notifier = createNotifier({
      store,
      clock,
      backoffMs: 10,
      maxAttempts: 3,
      sender: () => {
        attempts++;
        throw new Error("closed");
      },
    });
    notifier.enqueue(payload);
    expect(attempts).toBe(1);
    expect(notifier.stats.pending).toBe(1);
    clock.advance(9);
    expect(attempts).toBe(1);
    clock.advance(1);
    expect(attempts).toBe(2);
    clock.advance(20);
    expect(attempts).toBe(3);
    expect(notifier.stats.dropped).toBe(1);
    expect(store.records.get(payload.key)?.state).toBe("dropped");
  });
  it("uses CAS-like consume and suppresses stale deliveries during reconcile", () => {
    const clock = new FakeClock(100);
    const store = new FakeOutbox();
    const sent: string[] = [];
    const notifier = createNotifier({ store, clock, reconcileTtlMs: 10, sender: (p) => sent.push(p.key) });
    notifier.enqueue(payload);
    expect(notifier.consume(payload.key)).toBe(true);
    expect(notifier.consume(payload.key)).toBe(false);
    const stale = { ...payload, key: "old:1", createdAt: 0, state: "dropped" as const };
    store.put(stale);
    const report = notifier.reconcile();
    expect(report.suppressed).toContain("old:1");
    expect(sent).toContain(payload.key);
  });

  it("H4: invokes onDelivery with the full payload for every state transition (delivered/consumed/abandoned)", () => {
    const clock = new FakeClock(100);
    const store = new FakeOutbox();
    const seen: Array<{ key: string; state: string }> = [];
    const payloadKeys: string[] = [];
    const notifier = createNotifier({
      store,
      clock,
      reconcileTtlMs: 10,
      sender: () => undefined,
      onDelivery: (p, state) => {
        payloadKeys.push(p.key);
        seen.push({ key: p.key, state });
      },
    });
    notifier.enqueue(payload);
    expect(seen).toContainEqual({ key: payload.key, state: "delivered" });
    notifier.consume(payload.key);
    expect(seen).toContainEqual({ key: payload.key, state: "consumed" });
    const stale = { ...payload, key: "old:1", createdAt: 0, state: "dropped" as const };
    store.put(stale);
    notifier.reconcile();
    expect(seen).toContainEqual({ key: "old:1", state: "abandoned" });
    expect(payloadKeys).toEqual(seen.map((entry) => entry.key));
  });

  it("returns false and leaves the record retryable when consume persistence fails", () => {
    const clock = new FakeClock();
    const store = new FakeOutbox();
    const originalUpdate = store.update.bind(store);
    store.update = (key, patch) => {
      if (patch.state === "consumed") throw new Error("disk full");
      originalUpdate(key, patch);
    };
    const notifier = createNotifier({
      store,
      clock,
      sender: () => {
        throw new Error("send failed");
      },
    });
    notifier.enqueue(payload);
    expect(notifier.consume(payload.key)).toBe(false);
    expect(notifier.stats.consumed).toBe(0);
    expect(notifier.degraded.some((entry) => entry.reason.includes("consume persist failed"))).toBe(true);
    expect(notifier.reconcile().redelivered).toContain(payload.key);
  });

  it("revives dropped deliveries when enqueue is called again", () => {
    const clock = new FakeClock();
    const store = new FakeOutbox();
    const sent: string[] = [];
    const notifier = createNotifier({
      store,
      clock,
      maxAttempts: 1,
      sender: (p) => {
        sent.push(p.key);
        throw new Error("closed");
      },
    });
    notifier.enqueue(payload);
    expect(notifier.stats.dropped).toBe(1);
    notifier.enqueue(payload);
    expect(sent).toHaveLength(2);
    expect(notifier.stats.dropped).toBe(1);
  });

  it("continues backoff when both send and failure-state persistence fail", () => {
    const clock = new FakeClock();
    const store = new FakeOutbox();
    store.update = () => {
      throw new Error("state write failed");
    };
    let sends = 0;
    const audit: Array<{ state: string; error?: string }> = [];
    const notifier = createNotifier({
      store,
      clock,
      backoffMs: 10,
      maxAttempts: 3,
      sender: () => {
        sends++;
        throw new Error("send failed");
      },
      audit: (entry) => audit.push(entry),
    });
    expect(() => notifier.enqueue(payload)).not.toThrow();
    expect(sends).toBe(1);
    clock.advance(10);
    expect(sends).toBe(2);
    expect(notifier.stats.pending).toBe(1);
    expect(notifier.degraded.length).toBeGreaterThanOrEqual(2);
    expect(audit.some((entry) => entry.state === "pending" && entry.error === "send failed")).toBe(true);
  });

  it("keeps delivered state in memory when the success update fails", () => {
    const store = new FakeOutbox();
    store.update = () => {
      throw new Error("append failed");
    };
    const notifier = createNotifier({ store, sender: () => undefined });
    notifier.enqueue(payload);
    expect(notifier.stats.delivered).toBe(1);
    expect(notifier.degraded.length).toBeGreaterThan(0);
  });

  it("H4: a throwing onDelivery is isolated and does not break the notifier's own delivery/retry flow", () => {
    const clock = new FakeClock();
    const store = new FakeOutbox();
    const sent: string[] = [];
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const notifier = createNotifier({
      store,
      clock,
      sender: (p) => sent.push(p.key),
      onDelivery: () => {
        throw new Error("webhook down");
      },
    });
    expect(() => notifier.enqueue(payload)).not.toThrow();
    expect(sent).toContain(payload.key);
    expect(notifier.stats.delivered).toBe(1);
    expect(warn).toHaveBeenCalled();
    warn.mockRestore();
  });
});

describe("reconcile redelivery policy (duplicate-notification regression)", () => {
  it("redelivers unconsumed pending and dropped records while consumed records stay suppressed", () => {
    const clock = new FakeClock(100);
    const store = new MemoryOutboxStore<PersistedDelivery>();
    const sent: string[] = [];
    const notifier = createNotifier({ store, clock, sender: (p) => sent.push(p.key), maxReconcileRounds: 5 });
    const pending = { ...payload, key: "pending:1", createdAt: 100, state: "pending" as const, attempts: 0 };
    const dropped = { ...payload, key: "dropped:1", createdAt: 100, state: "dropped" as const, attempts: 1 };
    const consumed = {
      ...payload,
      key: "consumed:1",
      createdAt: 100,
      state: "consumed" as const,
      attempts: 1,
    };
    store.put(pending);
    store.put(dropped);
    store.put(consumed);
    const report = notifier.reconcile();
    expect(report.redelivered).toEqual(expect.arrayContaining([pending.key, dropped.key]));
    expect(report.redelivered).not.toContain(consumed.key);
    expect(sent).toEqual(expect.arrayContaining([pending.key, dropped.key]));
  });

  it("does not redeliver records already marked delivered; still redelivers pending", async () => {
    const { createNotifier } = await import("../../src/delivery/notifier.js");
    const { MemoryOutboxStore } = await import("../../src/core/store.js");
    const { FakeClock } = await import("../../src/core/clock.js");
    const store = new MemoryOutboxStore();
    const sent: string[] = [];
    const clock = new FakeClock();
    const notifier = createNotifier({
      store,
      clock,
      sender: (p) => {
        sent.push(p.key);
      },
      cancelBuffered: () => undefined,
    });
    const base = {
      generation: 1,
      status: "completed" as const,
      textPreview: "x",
      diag: { phase: "settled" as const, status: "completed" as const, pendingTools: 0, staleInputs: 0, degraded: 0 },
      createdAt: 0,
      reconcileRound: 0,
    };
    notifier.enqueue({ ...base, key: "r1:1", runId: "r1" });
    clock.advance(10_000); // let attempts fire
    expect(sent).toContain("r1:1");
    expect(store.list().find((r) => r.key === "r1:1")?.state).toBe("delivered");

    // Simulate a restart: fresh notifier over the same persisted store.
    const sent2: string[] = [];
    const notifier2 = createNotifier({
      store,
      clock,
      sender: (p) => void sent2.push(p.key),
      cancelBuffered: () => undefined,
    });
    store.put({ ...base, key: "r2:1", runId: "r2", state: "pending", attempts: 0 });
    notifier2.reconcile();
    clock.advance(10_000);
    expect(sent2).toEqual(["r2:1"]); // delivered r1 is NOT redelivered
  });

  it("holds schema delivery until finalize and sends the finalized payload", () => {
    const store = new MemoryOutboxStore<PersistedDelivery>();
    const sent: DeliveryPayload[] = [];
    const notifier = createNotifier({ store, sender: (p) => sent.push(p) });
    notifier.enqueue({ ...payload, key: "r:2", runId: "r", generation: 2 }, { hold: true });
    expect(sent).toHaveLength(0);
    expect(notifier.stats.staged).toBe(1);
    expect(notifier.finalize("r", 2, { status: "failed", failReason: "invalid", textPreview: "" })).toBe("sent");
    expect(sent[0]).toMatchObject({ key: "r:2", status: "failed", failReason: "invalid", finalized: true });
    expect(notifier.stats.staged).toBe(0);
    expect(notifier.stats.delivered).toBe(1);
  });

  it("folds legacy delivered and pending records in favor of pending without rewriting the hidden record", () => {
    const store = new MemoryOutboxStore<PersistedDelivery>();
    store.put({ ...payload, key: "r:1:completed", state: "delivered", createdAt: 1 });
    store.put({ ...payload, key: "r:1:failed", status: "failed", state: "pending", createdAt: 2, failReason: "boom" });
    const sent: DeliveryPayload[] = [];
    const notifier = createNotifier({ store, clock: new FakeClock(100), sender: (p) => sent.push(p) });
    const report = notifier.reconcile();
    expect(report.redelivered).toEqual(["r:1"]);
    expect(sent[0]).toMatchObject({ key: "r:1", status: "failed", failReason: "boom" });
    expect(store.list().find((r) => r.key === "r:1:completed")?.state).toBe("delivered");
  });

  it("releases two staged records with pre-finalize markers and one audit per release", () => {
    const clock = new FakeClock(10);
    const store = new MemoryOutboxStore<PersistedDelivery>();
    const sent: PersistedDelivery[] = [];
    const audits: string[] = [];
    const notifier = createNotifier({
      store,
      clock,
      sender: (p) => sent.push(p as PersistedDelivery),
      audit: (e) => {
        if (e.error) audits.push(e.error);
      },
    });
    notifier.enqueue({ ...payload, key: "r:2", generation: 2, createdAt: 10 }, { hold: true });
    notifier.enqueue({ ...payload, key: "r:3", generation: 3, createdAt: 10 }, { hold: true });
    const report = notifier.reconcile();
    expect(report.redelivered).toEqual(["r:2", "r:3"]);
    expect(sent).toHaveLength(2);
    expect(sent).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ degradedReason: "pre-finalize", finalized: false, reconcileRound: 1 }),
      ]),
    );
    expect(audits.filter((entry) => entry === "pre-finalize release")).toHaveLength(2);
    expect(store.list()).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ key: "r:2", degradedReason: "pre-finalize", finalized: false, reconcileRound: 1 }),
        expect.objectContaining({ key: "r:3", degradedReason: "pre-finalize", finalized: false, reconcileRound: 1 }),
      ]),
    );
  });

  it("uses the physical storageKey for legacy consume, finalize, TTL abandon, and retry writes", () => {
    const updates: string[] = [];
    const store = new MemoryOutboxStore<PersistedDelivery>();
    const originalUpdate = store.update.bind(store);
    store.update = (key, patch) => {
      updates.push(key);
      originalUpdate(key, patch);
    };
    store.put({ ...payload, key: "r:1:completed", state: "pending", createdAt: 100 });
    const clock = new FakeClock(100);
    const notifier = createNotifier({
      store,
      clock,
      maxAttempts: 3,
      sender: () => {
        throw new Error("closed");
      },
    });
    notifier.reconcile();
    clock.advance(1000);
    expect(updates).toContain("r:1:completed");

    expect(notifier.consume("r:1")).toBe(true);
    expect(updates).toContain("r:1:completed");

    const staged = {
      ...payload,
      key: "r:2:completed",
      runId: "r",
      generation: 2,
      state: "staged" as const,
      createdAt: 100,
    };
    store.put(staged);
    notifier.finalize("r", 2, { status: "completed", textPreview: "final" });
    expect(updates).toContain("r:2:completed");

    const stale = {
      ...payload,
      key: "r:3:completed",
      runId: "r",
      generation: 3,
      state: "pending" as const,
      createdAt: 0,
    };
    store.put(stale);
    const ttlNotifier = createNotifier({
      store,
      clock: new FakeClock(100),
      reconcileTtlMs: 10,
      sender: () => undefined,
    });
    ttlNotifier.reconcile();
    expect(updates).toContain("r:3:completed");
    expect(updates.every((key) => key.includes(":"))).toBe(true);
    expect(store.list().some((record) => record.key === "r:1")).toBe(false);
  });

  it("audits and excludes non-terminal legacy keys", () => {
    const store = new MemoryOutboxStore<PersistedDelivery>();
    store.put({ ...payload, key: "r_x:1:running", state: "pending" });
    const audits: string[] = [];
    const sent: DeliveryPayload[] = [];
    const notifier = createNotifier({ store, sender: (p) => sent.push(p), audit: (e) => audits.push(e.error ?? "") });
    expect(notifier.reconcile().redelivered).toEqual([]);
    expect(sent).toHaveLength(0);
    expect(audits).toContain("illegal legacy key");
  });
});

describe("P2 notifier/coalescer integration", () => {
  function p(key: string, extra: Partial<PersistedDelivery> = {}): PersistedDelivery {
    return { ...payload, key, runId: key.split(":")[0]!, ...extra };
  }

  it("12+9: marks batched before synchronous maxBatch flush and never overwrites delivered", () => {
    const clock = new FakeClock();
    const store = new FakeOutbox();
    const writes: Array<{ key: string; state?: string }> = [];
    const originalUpdate = store.update.bind(store);
    store.update = (key, patch) => {
      writes.push({ key, state: patch.state });
      originalUpdate(key, patch);
    };
    const sent: DeliveryPayload[][] = [];
    let notifier!: ReturnType<typeof createNotifier>;
    const coalescer = createCoalescer({
      clock,
      windowMs: 100,
      maxBatch: 2,
      send: (items) => sent.push([...items]),
      onSettled: (keys, ok) => notifier.settleBatch(keys, ok),
    });
    notifier = createNotifier({
      store,
      clock,
      sender: {
        willBuffer: isCoalescible,
        sendMessage: (item) => coalescer.submit(item),
      },
    });
    notifier.enqueue(p("a:1"));
    notifier.enqueue(p("b:1"));
    expect(sent).toHaveLength(1);
    expect(notifier.stats.delivered).toBe(2);
    for (const key of ["a:1", "b:1"]) {
      expect(writes.filter((w) => w.key === key).map((w) => w.state)).toEqual(["batched", "delivered"]);
    }
    const replayed: DeliveryPayload[] = [];
    const restarted = createNotifier({ store, clock, sender: (item) => replayed.push(item) });
    expect(restarted.reconcile().redelivered).toEqual([]);
    expect(replayed).toEqual([]);
  });

  it("11: flush failure returns batched delivery to backoff without changing reconcileRound", async () => {
    const clock = new FakeClock();
    const store = new FakeOutbox();
    let notifier!: ReturnType<typeof createNotifier>;
    const { createCoalescer, isCoalescible } = await import("../../src/delivery/coalescer.js");
    const coalescer = createCoalescer({
      clock,
      windowMs: 10,
      maxBatch: 8,
      send: (items) => {
        if (items[0]?.attempts === 0) throw new Error("closed");
      },
      onSettled: (keys, ok) => notifier.settleBatch(keys, ok),
    });
    notifier = createNotifier({
      store,
      clock,
      backoffMs: 10,
      sender: {
        willBuffer: isCoalescible,
        sendMessage: (item) => (isCoalescible(item) ? coalescer.submit(item) : "sent"),
      },
    });
    notifier.enqueue(p("fail:1"));
    expect(store.records.get("fail:1")?.state).toBe("batched");
    clock.advance(10);
    expect(store.records.get("fail:1")).toMatchObject({ state: "pending", attempts: 1, reconcileRound: 0 });
    expect(clock.pendingTimers).toBe(1);
    clock.advance(10);
    expect(store.records.get("fail:1")).toMatchObject({ state: "delivered", attempts: 2, reconcileRound: 0 });
  });

  it.each([
    ["pending", 0],
    ["dropped", 1],
    ["batched", 0],
  ] as const)("13: reconcile releases %s with effective round 1 and immediate send", async (state, attempts) => {
    const clock = new FakeClock();
    const store = new FakeOutbox();
    const sent: DeliveryPayload[] = [];
    const { createCoalescer, isCoalescible } = await import("../../src/delivery/coalescer.js");
    let notifier!: ReturnType<typeof createNotifier>;
    const coalescer = createCoalescer({
      clock,
      windowMs: 100,
      maxBatch: 8,
      send: (items) => sent.push(...items),
      onSettled: (keys, ok) => notifier.settleBatch(keys, ok),
    });
    const record = p(`reconcile-${state}:1`, { state, attempts });
    store.put(record);
    notifier = createNotifier({
      store,
      clock,
      sender: {
        willBuffer: isCoalescible,
        sendMessage: (item) => (isCoalescible(item) ? coalescer.submit(item) : (sent.push(item), "sent")),
      },
      maxReconcileRounds: 3,
    });
    const report = notifier.reconcile();
    expect(report.redelivered).toEqual([record.key]);
    expect(sent[0]).toMatchObject({ key: record.key, reconcileRound: 1 });
    expect(clock.pendingTimers).toBe(0);
    expect(store.records.get(record.key)?.state).toBe("delivered");
  });

  it("14: failed, degraded, round and retry payloads all bypass the coalescing window", async () => {
    const clock = new FakeClock();
    const store = new FakeOutbox();
    const sent: string[] = [];
    const { createCoalescer, isCoalescible } = await import("../../src/delivery/coalescer.js");
    let notifier!: ReturnType<typeof createNotifier>;
    const coalescer = createCoalescer({
      clock,
      windowMs: 100,
      maxBatch: 8,
      send: (items) => sent.push(...items.map((x) => x.key)),
      onSettled: (keys, ok) => notifier.settleBatch(keys, ok),
    });
    notifier = createNotifier({
      store,
      clock,
      sender: {
        willBuffer: isCoalescible,
        sendMessage: (item) => (isCoalescible(item) ? coalescer.submit(item) : (sent.push(item.key), "sent")),
      },
    });
    for (const record of [
      p("failed:1", { status: "failed" }),
      p("degraded:1", { degradedReason: "pre-finalize" }),
      p("round:1", { reconcileRound: 1 }),
      p("retry:1", { attempts: 1 }),
    ])
      store.put(record);
    expect(notifier.reconcile().redelivered).toHaveLength(4);
    expect(sent).toHaveLength(4);
    expect(clock.pendingTimers).toBe(0);
    expect([...store.records.values()].every((item) => item.state !== "batched")).toBe(true);
  });

  it("15: replays crashed batched records immediately and only once", async () => {
    const clock = new FakeClock();
    const store = new FakeOutbox<PersistedDelivery>();
    for (const key of ["crash-a:1", "crash-b:1", "crash-c:1"]) store.put(p(key, { state: "batched" }));
    const sent: DeliveryPayload[] = [];
    const notifier = createNotifier({ store, clock, sender: (item) => sent.push(item), maxReconcileRounds: 3 });
    expect(notifier.reconcile().redelivered).toHaveLength(3);
    expect(sent.map((item) => item.reconcileRound)).toEqual([1, 1, 1]);
    expect([...store.records.values()].every((item) => item.state === "delivered")).toBe(true);
  });
});

describe("P3 ack matrix", () => {
  function p(key: string, extra: Partial<PersistedDelivery> = {}): PersistedDelivery {
    return { ...payload, key, runId: key.split(":")[0]!, ...extra };
  }
  function setup(extra: { send?: (items: readonly DeliveryPayload[]) => void; cancel?: (key: string) => void } = {}) {
    const clock = new FakeClock();
    const store = new FakeOutbox();
    let notifier!: ReturnType<typeof createNotifier>;
    const coalescer = createCoalescer({
      clock,
      windowMs: 100,
      maxBatch: 8,
      send: extra.send ?? (() => undefined),
      onSettled: (keys, ok) => notifier.settleBatch(keys, ok),
    });
    notifier = createNotifier({
      store,
      clock,
      sender: {
        willBuffer: isCoalescible,
        sendMessage: (item) => (isCoalescible(item) ? coalescer.submit(item) : (extra.send?.([item]), "sent")),
      },
      cancelBuffered: (key) => {
        if (extra.cancel) extra.cancel(key);
        else coalescer.cancel(key);
      },
      backoffMs: 10,
    });
    return { clock, store, notifier, coalescer };
  }

  it("1: acknowledges batched delivery and suppresses its window flush", () => {
    const { clock, store, notifier } = setup();
    notifier.enqueue(p("ack-batched:1"));
    expect(notifier.ack("ack-batched", 1)).toBe(true);
    clock.advance(100);
    expect(store.records.get("ack-batched:1")?.state).toBe("consumed");
    expect(notifier.ackedSuppressions).toBe(1);
  });
  it("2: acknowledges pending backoff and lets the timer self-heal", () => {
    const sent: string[] = [];
    const { clock, store, notifier } = setup({ send: (items) => sent.push(...items.map((x) => x.key)) });
    notifier.enqueue(p("ack-retry:1"));
    store.records.get("ack-retry:1")!.attempts = 1;
    store.records.get("ack-retry:1")!.state = "pending";
    expect(notifier.ack("ack-retry", 1)).toBe(true);
    clock.advance(1000);
    expect(sent).toHaveLength(0);
  });
  it("3: acknowledges after immediate send without withdrawing it", () => {
    const sent: string[] = [];
    const { store, notifier } = setup({ send: (items) => sent.push(...items.map((x) => x.key)) });
    store.put(p("ack-late:1", { state: "pending" }));
    notifier.reconcile();
    expect(sent).toEqual(["ack-late:1"]);
    expect(notifier.ack("ack-late", 1)).toBe(true);
    expect(notifier.ackedSuppressions).toBe(0);
  });
  it("4: acked staged delivery finalizes late without sending", () => {
    const { store, notifier } = setup();
    notifier.enqueue(p("ack-staged:1"), { hold: true });
    expect(notifier.ack("ack-staged", 1)).toBe(true);
    expect(notifier.finalize("ack-staged", 1, { status: "completed", textPreview: "late" })).toBe("late");
    expect(store.records.get("ack-staged:1")?.state).toBe("consumed");
  });
  it("5: rejects dropped, abandoned and missing acknowledgements", () => {
    const { store, notifier } = setup();
    store.put(p("dropped:1", { state: "dropped" }));
    store.put(p("abandoned:1", { state: "abandoned" }));
    expect(notifier.ack("dropped", 1)).toBe(false);
    expect(notifier.ack("abandoned", 1)).toBe(false);
    expect(notifier.ack("missing", 1)).toBe(false);
  });
  it("6: update failure leaves buffered record to flush fail-open", () => {
    const { clock, store, notifier } = setup();
    const original = store.update.bind(store);
    store.update = (key, patch) => {
      if (patch.state === "consumed") throw new Error("disk full");
      original(key, patch);
    };
    notifier.enqueue(p("ack-update-fail:1"));
    expect(notifier.ack("ack-update-fail", 1)).toBe(false);
    clock.advance(100);
    expect(store.records.get("ack-update-fail:1")?.state).toBe("delivered");
  });
  it("7: cancel failure keeps the consumed record fail-open and terminal", () => {
    const { clock, store, notifier } = setup({
      cancel: () => {
        throw new Error("cancel failed");
      },
    });
    notifier.enqueue(p("ack-cancel-fail:1"));
    expect(notifier.ack("ack-cancel-fail", 1)).toBe(true);
    clock.advance(100);
    expect(store.records.get("ack-cancel-fail:1")?.state).toBe("delivered");
    const restarted = createNotifier({ store, clock, sender: () => undefined, cancelBuffered: () => undefined });
    expect(restarted.reconcile().redelivered).toEqual([]);
  });
  it("8: acked records do not replay while unacked batched records do", () => {
    const { store, notifier } = setup();
    notifier.enqueue(p("acked:1"));
    notifier.ack("acked", 1);
    const unackedStore = new FakeOutbox();
    unackedStore.put(p("unacked:1", { state: "batched" }));
    const ackedRestart = createNotifier({ store, sender: () => undefined, cancelBuffered: () => undefined });
    expect(ackedRestart.reconcile().redelivered).toEqual([]);
    const sent: string[] = [];
    const restarted = createNotifier({
      store: unackedStore,
      clock: new FakeClock(),
      sender: (item) => sent.push(item.key),
      cancelBuffered: () => undefined,
    });
    expect(restarted.reconcile().redelivered).toEqual(["unacked:1"]);
    expect(sent).toEqual(["unacked:1"]);
  });
  it("9: requires cancelBuffered at construction", () => {
    expect(() => createNotifierImpl({ store: new FakeOutbox(), sender: () => undefined } as NotifierOptions)).toThrow(
      "cancelBuffered is required",
    );
  });
  it("10: background delivery without an ack is still delivered", () => {
    const sent: string[] = [];
    const { notifier } = setup({ send: (items) => sent.push(...items.map((x) => x.key)) });
    notifier.enqueue(p("background:1", { status: "failed" }));
    expect(sent).toEqual(["background:1"]);
  });
});
