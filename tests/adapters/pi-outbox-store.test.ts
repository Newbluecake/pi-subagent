import { describe, expect, it } from "vitest";
import { createPiOutboxStore } from "../../src/adapters/pi-outbox-store.js";
import { FakeClock } from "../../src/core/clock.js";
import { createNotifier, type PersistedDelivery } from "../../src/delivery/notifier.js";

const record = (key = "r:1:completed"): PersistedDelivery => ({
  key,
  runId: "r",
  generation: 1,
  status: "completed",
  textPreview: "done",
  diag: { phase: "settled", status: "completed", pendingTools: 0, staleInputs: 0, degraded: 0 },
  createdAt: 0,
  reconcileRound: 0,
  state: "pending",
  attempts: 0,
});

function failingHost() {
  return {
    appendEntry: () => {
      throw new Error("append failed");
    },
    sessionManager: { getEntries: () => [] },
  };
}

describe("PiOutboxStore persistence rollback", () => {
  it("rolls update back so the old state remains available for reconcile", () => {
    const initial = record();
    const store = createPiOutboxStore({
      ...failingHost(),
      sessionManager: {
        getEntries: () => [{ type: "custom", customType: "subagent:outbox", data: initial }],
      },
    });
    expect(() => store.update(initial.key, { state: "consumed" })).toThrow("append failed");
    expect(store.list()).toEqual([initial]);
  });

  it("keeps the old state after append failure and notifier retries consume", () => {
    let appendAttempts = 0;
    const host = {
      appendEntry: () => {
        appendAttempts++;
        if (appendAttempts > 1) throw new Error("consume append failed");
      },
      sessionManager: { getEntries: () => [] },
    };
    const store = createPiOutboxStore(host);
    const sent: string[] = [];
    const notifier = createNotifier({ store, clock: new FakeClock(), sender: (p) => sent.push(p.key) });
    notifier.enqueue(record());
    expect(notifier.consume(record().key)).toBe(false);
    expect(store.list()[0].state).toBe("pending");
    const report = notifier.reconcile();
    expect(report.redelivered).toContain(record().key);
    expect(sent).toContain(record().key);
  });

  it("does not retain a put that appendEntry rejected", () => {
    const store = createPiOutboxStore(failingHost());
    expect(() => store.put(record("new"))).toThrow();
    expect(store.list()).toEqual([]);
  });
});
