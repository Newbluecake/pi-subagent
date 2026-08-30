import { describe, expect, it } from "vitest";
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
});
