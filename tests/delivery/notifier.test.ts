import { describe, expect, it, vi } from "vitest";
import { FakeClock } from "../../src/core/clock.js";
import { createNotifier } from "../../src/delivery/notifier.js";
import type { PersistedDelivery, OutboxStore } from "../../src/delivery/notifier.js";
import type { DeliveryPayload } from "../../src/core/types.js";

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
