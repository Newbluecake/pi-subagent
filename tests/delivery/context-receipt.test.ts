import { describe, expect, it } from "vitest";
import { createContextReceiptTracker, runIdsFromNotificationDetails } from "../../src/delivery/context-receipt.js";

describe("ContextReceiptTracker", () => {
  it("tracks pending delivery and entered notification", () => {
    const tracker = createContextReceiptTracker();
    tracker.noteDelivery("run-1", 1, "delivered", 10);
    expect(tracker.receiptOf("run-1")).toEqual({ kind: "pending", at: 10 });
    tracker.noteEntered(["run-1"], 20);
    expect(tracker.receiptOf("run-1")).toEqual({ kind: "entered", at: 20 });
  });

  it("treats consumed as entered and dropped or abandoned as undeliverable", () => {
    const consumed = createContextReceiptTracker();
    consumed.noteDelivery("consumed", 1, "consumed", 4);
    expect(consumed.receiptOf("consumed")).toEqual({ kind: "entered", at: 4 });

    for (const state of ["dropped", "abandoned"] as const) {
      const tracker = createContextReceiptTracker();
      tracker.noteDelivery(state, 1, state, 4);
      expect(tracker.receiptOf(state)).toEqual({ kind: "undeliverable" });
    }
  });

  it("keeps entered ahead of later delivery states and noteEntered is first-wins", () => {
    const tracker = createContextReceiptTracker();
    tracker.noteEntered(["run-1"], 20);
    tracker.noteEntered(["run-1"], 30);
    tracker.noteDelivery("run-1", 1, "abandoned", 40);
    expect(tracker.receiptOf("run-1")).toEqual({ kind: "entered", at: 20 });
  });

  it("parses single and digest notification details", () => {
    expect(runIdsFromNotificationDetails({ runId: "one" })).toEqual(["one"]);
    expect(runIdsFromNotificationDetails({ kind: "digest", items: [{ runId: "a" }, { runId: "b" }] })).toEqual([
      "a",
      "b",
    ]);
    expect(runIdsFromNotificationDetails({ kind: "digest", items: [{ runId: "a" }, {}, null, { runId: 3 }] })).toEqual([
      "a",
    ]);
    expect(runIdsFromNotificationDetails({ kind: "digest", items: "bad", runId: "fallback" })).toEqual(["fallback"]);
    expect(runIdsFromNotificationDetails(null)).toEqual([]);
    expect(runIdsFromNotificationDetails("message")).toEqual([]);
  });

  it("prunes entries outside keep and by entered linger or pending await bounds", () => {
    const tracker = createContextReceiptTracker();
    tracker.noteEntered(["entered"], 100);
    tracker.noteDelivery("pending", 1, "delivered", 100);
    tracker.noteDelivery("kept", 1, "delivered", 100);
    tracker.prune(new Set(["kept"]), 106, { lingerMs: 5, awaitMs: 5 });
    expect(tracker.receiptOf("entered").kind).toBe("untracked");
    expect(tracker.receiptOf("pending").kind).toBe("untracked");
    expect(tracker.receiptOf("kept").kind).toBe("pending");

    tracker.prune(new Set(["kept"]), 111, { lingerMs: 5, awaitMs: 5 });
    expect(tracker.receiptOf("kept").kind).toBe("untracked");
  });
});
