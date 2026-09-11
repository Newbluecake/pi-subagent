import { describe, expect, it } from "vitest";
import { createMentionNotes } from "../../src/mention/notes.js";

type Diag = { lastEventAt?: number; lastEventType?: string } | undefined;

function harness(diags: Record<string, Diag> = {}) {
  const notes = createMentionNotes({ diagOf: (runId) => diags[runId] });
  return { notes, diags };
}

describe("X6b mention notes", () => {
  it("returns the latest message per run and keeps runs independent", () => {
    const { notes } = harness();
    notes.set("run-1", "第一条");
    notes.set("run-2", "别的 run");
    notes.set("run-1", "第二条");
    expect(notes.get("run-1")).toBe("第二条");
    expect(notes.get("run-2")).toBe("别的 run");
  });

  it("keeps a pending note while the run shows no fresh turn_start", () => {
    const { notes, diags } = harness({ "run-1": { lastEventAt: 100, lastEventType: "tool_end" } });
    notes.set("run-1", "进展如何", 100);
    // Trailing events of the in-flight turn never clear the note.
    diags["run-1"] = { lastEventAt: 150, lastEventType: "tool_end" };
    expect(notes.get("run-1")).toBe("进展如何");
    diags["run-1"] = { lastEventAt: 160, lastEventType: "turn_end" };
    expect(notes.get("run-1")).toBe("进展如何");
  });

  it("self-clears a pending note once a turn_start lands past the baseline", () => {
    const { notes, diags } = harness({ "run-1": { lastEventAt: 100, lastEventType: "tool_end" } });
    notes.set("run-1", "进展如何", 100);
    diags["run-1"] = { lastEventAt: 200, lastEventType: "turn_start" };
    expect(notes.get("run-1")).toBeUndefined();
    // Deletion is real, not just a masked read — a stale diag must not resurrect it.
    diags["run-1"] = { lastEventAt: 100, lastEventType: "tool_end" };
    expect(notes.get("run-1")).toBeUndefined();
  });

  it("does not clear on a turn_start at or before the baseline", () => {
    const { notes, diags } = harness({ "run-1": { lastEventAt: 100, lastEventType: "turn_start" } });
    // Baseline captured while the run was already inside a turn.
    notes.set("run-1", "进展如何", 100);
    expect(notes.get("run-1")).toBe("进展如何");
    diags["run-1"] = { lastEventAt: 100, lastEventType: "turn_start" };
    expect(notes.get("run-1")).toBe("进展如何");
  });

  it("pins baseline-less notes (resume path) for the run's whole lifetime", () => {
    const { notes, diags } = harness({ "run-2": { lastEventAt: 300, lastEventType: "turn_start" } });
    notes.set("run-2", "继续");
    expect(notes.get("run-2")).toBe("继续");
    // Even fresh turn_starts must not clear a pinned note.
    diags["run-2"] = { lastEventAt: 400, lastEventType: "turn_start" };
    expect(notes.get("run-2")).toBe("继续");
  });

  it("a re-@ after processing re-arms the note with a fresh baseline", () => {
    const { notes, diags } = harness({ "run-1": { lastEventAt: 100, lastEventType: "tool_end" } });
    notes.set("run-1", "第一条", 100);
    diags["run-1"] = { lastEventAt: 200, lastEventType: "turn_start" };
    expect(notes.get("run-1")).toBeUndefined();
    notes.set("run-1", "第二条", 200);
    expect(notes.get("run-1")).toBe("第二条");
    diags["run-1"] = { lastEventAt: 300, lastEventType: "turn_start" };
    expect(notes.get("run-1")).toBeUndefined();
  });

  it("evicts the oldest only when inserting a new key past the cap", () => {
    const notes = createMentionNotes({ diagOf: () => undefined, cap: 2 });
    notes.set("run-1", "a");
    notes.set("run-2", "b");
    // Overwrite at cap: no eviction.
    notes.set("run-1", "a2");
    expect(notes.get("run-2")).toBe("b");
    // New key at cap: evicts the oldest (run-1).
    notes.set("run-3", "c");
    expect(notes.get("run-1")).toBeUndefined();
    expect(notes.get("run-3")).toBe("c");
  });

  it("a missing diag degrades to keeping the note until the first event", () => {
    const { notes, diags } = harness();
    notes.set("run-9", "在吗", 0);
    expect(notes.get("run-9")).toBe("在吗");
    diags["run-9"] = { lastEventAt: 1, lastEventType: "turn_start" };
    expect(notes.get("run-9")).toBeUndefined();
  });
});
