import { describe, expect, it, vi } from "vitest";
import { FakeClock } from "../../src/core/clock.js";
import { createNotifier } from "../../src/delivery/notifier.js";
import type { PersistedDelivery, OutboxStore } from "../../src/delivery/notifier.js";
import type { DeliveryPayload } from "../../src/core/types.js";
import { MemoryOutboxStore } from "../../src/core/store.js";

const payload: DeliveryPayload = {
  key: "r:1:completed",
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
    const stale = { ...payload, key: "old:1:completed", createdAt: 0, state: "dropped" as const };
    store.put(stale);
    const report = notifier.reconcile();
    expect(report.suppressed).toContain("old:1:completed");
    expect(sent).toContain(payload.key);
  });

  it("H4: invokes onDelivery with the full payload for every state transition (delivered/consumed/abandoned)", () => {
    const clock = new FakeClock(100);
    const store = new FakeOutbox();
    const seen: Array<{ key: string; state: string }> = [];
    const notifier = createNotifier({
      store,
      clock,
      reconcileTtlMs: 10,
      sender: () => undefined,
      onDelivery: (p, state) => seen.push({ key: p.key, state }),
    });
    notifier.enqueue(payload);
    expect(seen).toContainEqual({ key: payload.key, state: "delivered" });
    notifier.consume(payload.key);
    expect(seen).toContainEqual({ key: payload.key, state: "consumed" });
    const stale = { ...payload, key: "old:1:completed", createdAt: 0, state: "dropped" as const };
    store.put(stale);
    notifier.reconcile();
    expect(seen).toContainEqual({ key: "old:1:completed", state: "abandoned" });
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
    const pending = { ...payload, key: "pending:1:completed", createdAt: 100, state: "pending" as const, attempts: 0 };
    const dropped = { ...payload, key: "dropped:1:completed", createdAt: 100, state: "dropped" as const, attempts: 1 };
    const consumed = {
      ...payload,
      key: "consumed:1:completed",
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
    });
    const base = {
      generation: 1,
      status: "completed" as const,
      textPreview: "x",
      diag: { phase: "settled" as const, status: "completed" as const, pendingTools: 0, staleInputs: 0, degraded: 0 },
      createdAt: 0,
      reconcileRound: 0,
    };
    notifier.enqueue({ ...base, key: "r1:1:completed", runId: "r1" });
    clock.advance(10_000); // let attempts fire
    expect(sent).toContain("r1:1:completed");
    expect(store.list().find((r) => r.key === "r1:1:completed")?.state).toBe("delivered");

    // Simulate a restart: fresh notifier over the same persisted store.
    const sent2: string[] = [];
    const notifier2 = createNotifier({ store, clock, sender: (p) => void sent2.push(p.key) });
    store.put({ ...base, key: "r2:1:completed", runId: "r2", state: "pending", attempts: 0 });
    notifier2.reconcile();
    clock.advance(10_000);
    expect(sent2).toEqual(["r2:1:completed"]); // delivered r1 is NOT redelivered
  });
});
