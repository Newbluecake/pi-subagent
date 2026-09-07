import { describe, expect, it } from "vitest";

import { STALE_RUN_MS, SubagentTracker, buildSubagentSummaryText } from "../../src/feishu-notify/core.js";

describe("SubagentTracker: started -> settled -> runningCount", () => {
  it("goes from 1 running to 0 running after settled", () => {
    const t = new SubagentTracker();
    t.markStarted("r1", 1000);
    expect(t.runningCount(1000)).toBe(1);
    t.markSettled("r1", "completed", 2000);
    expect(t.runningCount(2000)).toBe(0);
    expect(t.hasFinished()).toBe(true);
  });

  it("is idempotent for repeated started/settled (endedAt not overwritten)", () => {
    const t = new SubagentTracker();
    t.markStarted("r1", 1000);
    t.markStarted("r1", 1500); // repeated started, ignored
    t.markSettled("r1", "completed", 2000);
    t.markSettled("r1", "failed", 5000); // repeated settled (same/no generation), should not overwrite
    const [rec] = t.drainFinished();
    if (!rec) throw new Error("expected a record");
    expect(rec.status).toBe("completed");
    expect(rec.endedAt).toBe(2000);
    expect(rec.startedAt).toBe(1000);
  });
});

describe("SubagentTracker: ingestDelivery", () => {
  it("parses a single DeliveryPayload", () => {
    const t = new SubagentTracker();
    t.markStarted("r1", 1000);
    t.ingestDelivery({ runId: "r1", status: "completed", label: "build", textPreview: "ok" }, 2000);
    const [rec] = t.drainFinished();
    if (!rec) throw new Error("expected a record");
    expect(rec.status).toBe("completed");
    expect(rec.label).toBe("build");
    expect(rec.textPreview).toBe("ok");
    expect(rec.hadDelivery).toBe(true);
  });

  it("parses a digest without double-counting the top-level runId == items[0].runId", () => {
    const t = new SubagentTracker();
    t.markStarted("r1", 1000);
    t.markStarted("r2", 1000);
    t.ingestDelivery(
      {
        runId: "r1",
        status: "completed",
        kind: "digest",
        items: [
          { runId: "r1", status: "completed", label: "a" },
          { runId: "r2", status: "failed", label: "b", failReason: "boom" },
        ],
      },
      2000,
    );
    expect(t.hasFinished()).toBe(true);
    const recs = t.drainFinished();
    expect(recs).toHaveLength(2);
    const r1 = recs.find((r) => r.runId === "r1")!;
    const r2 = recs.find((r) => r.runId === "r2")!;
    expect(r1.status).toBe("completed");
    expect(r2.status).toBe("failed");
    expect(r2.failReason).toBe("boom");
  });

  it("resets the record when generation differs (keeps startedAt)", () => {
    const t = new SubagentTracker();
    t.markStarted("r1", 1000);
    t.ingestDelivery({ runId: "r1", generation: 1, status: "completed", label: "gen1" }, 2000);
    // new generation arrives: should reset (treated as a new run under same id)
    t.ingestDelivery({ runId: "r1", generation: 2, status: "failed", label: "gen2", failReason: "retry-failed" }, 5000);
    const [rec] = t.drainFinished();
    if (!rec) throw new Error("expected a record");
    expect(rec.generation).toBe(2);
    expect(rec.status).toBe("failed");
    expect(rec.label).toBe("gen2");
    expect(rec.startedAt).toBe(1000);
  });

  it("handles channel B arriving before channel A (out of order)", () => {
    const t = new SubagentTracker();
    // no markStarted called yet
    t.ingestDelivery({ runId: "r1", status: "completed", label: "x" }, 2000);
    expect(t.runningCount(2000)).toBe(0);
    expect(t.hasFinished()).toBe(true);
    const [rec] = t.drainFinished();
    if (!rec) throw new Error("expected a record");
    expect(rec.status).toBe("completed");
    expect(rec.hadDelivery).toBe(true);
  });

  it("degrades gracefully when label/failReason missing", () => {
    const t = new SubagentTracker();
    t.ingestDelivery({ runId: "abcdef1234567890", status: "failed" }, 1000);
    const [rec] = t.drainFinished();
    if (!rec) throw new Error("expected a record");
    const text = buildSubagentSummaryText([rec]);
    expect(text).toContain("abcdef12"); // runId.slice(0,8)
    expect(text).toContain("failed"); // failReason ?? status
  });
});

describe("SubagentTracker: stale protection", () => {
  it("started-only record older than STALE_RUN_MS is not counted as running", () => {
    const t = new SubagentTracker();
    t.markStarted("r1", 0);
    expect(t.runningCount(0)).toBe(1);
    expect(t.runningCount(STALE_RUN_MS + 1)).toBe(0);
  });

  it("pruneStale removes the stale started-only record", () => {
    const t = new SubagentTracker();
    t.markStarted("r1", 0);
    t.pruneStale(STALE_RUN_MS + 1);
    expect(t.hasFinished()).toBe(false);
    expect(t.runningCount(STALE_RUN_MS + 1)).toBe(0);
  });

  it("pendingDeliveryWaitMs: three states", () => {
    const t = new SubagentTracker();
    // no finished records -> 0
    expect(t.pendingDeliveryWaitMs(1000, 6000)).toBe(0);

    t.markSettled("r1", "completed", 1000); // no delivery yet
    // within grace -> remaining > 0
    expect(t.pendingDeliveryWaitMs(3000, 6000)).toBe(6000 - 2000);
    // past grace -> 0
    expect(t.pendingDeliveryWaitMs(10000, 6000)).toBe(0);
  });
});

describe("SubagentTracker: drain/discard semantics", () => {
  it("drainFinished removes and returns finished records; discardFinished removes without returning", () => {
    const t = new SubagentTracker();
    t.markSettled("r1", "completed", 1000);
    t.markSettled("r2", "failed", 1000);
    t.discardFinished();
    expect(t.hasFinished()).toBe(false);

    t.markSettled("r3", "completed", 2000);
    const recs = t.drainFinished();
    expect(recs).toHaveLength(1);
    expect(t.hasFinished()).toBe(false);
  });

  it("buildSubagentSummaryText formats rows with icon/label/duration/detail", () => {
    const recs = [
      { runId: "r1", status: "completed", label: "build", startedAt: 0, endedAt: 5000, textPreview: "built ok" },
      { runId: "r2", status: "failed", label: "test", startedAt: 0, endedAt: 3000, failReason: "3 tests failed" },
    ];
    const text = buildSubagentSummaryText(recs);
    expect(text).toContain("✅ build · 5 秒 · built ok");
    expect(text).toContain("🔴 test · 3 秒 · 3 tests failed");
  });
});
