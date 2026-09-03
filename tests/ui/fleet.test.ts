import { describe, expect, it } from "vitest";
import type { RunDiagnostics, RunSnapshot, UsageDelta } from "../../src/core/types.js";
import {
  buildFleetViewModel,
  escalationSummary,
  formatDuration,
  formatUsage,
  highlightOf,
  idleOf,
  phaseLabel,
  THINKING_SPINNER_FRAMES,
  thinkingSpinnerFrame,
} from "../../src/ui/fleet-panel.js";

function diag(overrides: Partial<RunDiagnostics> = {}): RunDiagnostics {
  return {
    createdAt: 0,
    phase: "model_turn",
    phaseEnteredAt: 0,
    pendingTools: 0,
    turns: 1,
    escalation: [],
    orphaned: false,
    generation: 1,
    degraded: [],
    staleInputs: 0,
    unkillable: [],
    ...overrides,
  };
}

function snapshot(overrides: Partial<RunSnapshot> = {}): RunSnapshot {
  return {
    runId: "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee",
    generation: 1,
    status: "running",
    phase: "model_turn",
    deadlines: { enqueuedAt: 0, deadlineAt: undefined, queueDeadlineAt: undefined },
    diag: diag(),
    updatedAt: 0,
    ...overrides,
  };
}

const usage = (costUsd: number): UsageDelta => ({ input: 10, output: 2, cacheRead: 0, cacheWrite: 0, costUsd });

describe("view-model: formatDuration / formatUsage / escalationSummary / idleOf", () => {
  it("formats durations across the ms/s/m/h boundaries", () => {
    expect(formatDuration(0)).toBe("0ms");
    expect(formatDuration(500)).toBe("500ms");
    expect(formatDuration(999)).toBe("999ms");
    expect(formatDuration(1000)).toBe("1s");
    expect(formatDuration(59_000)).toBe("59s");
    expect(formatDuration(60_000)).toBe("1m00s");
    expect(formatDuration(65_000)).toBe("1m05s");
    expect(formatDuration(3_600_000)).toBe("1h00m");
    expect(formatDuration(3_720_000)).toBe("1h02m");
    expect(formatDuration(-5)).toBe("0ms"); // clamped, never negative
  });

  it("formats usage with 4-decimal cost (sub-cent runs)", () => {
    expect(formatUsage(usage(0.000312))).toBe("in:10 out:2 $0.0003");
  });

  it("summarizes the escalation trail with ok/fail markers and max level", () => {
    expect(escalationSummary(diag())).toEqual({ text: undefined, max: undefined });
    const d = diag({
      escalation: [
        { level: "L2", at: 1, ok: true },
        { level: "L3", at: 2, ok: false },
      ],
    });
    expect(escalationSummary(d)).toEqual({ text: "L2✓→L3✗", max: "L3" });
  });

  it("idleOf falls back to phaseEnteredAt when no driver event has landed yet", () => {
    const s = snapshot({ diag: diag({ phaseEnteredAt: 100 }) });
    expect(idleOf(s, 400)).toBe(300);
    const withEvent = snapshot({ diag: diag({ phaseEnteredAt: 100, lastEventAt: 250 }) });
    expect(idleOf(withEvent, 400)).toBe(150);
    expect(idleOf(snapshot({ diag: diag({ lastEventAt: 500 }) }), 400)).toBe(0); // clamped
  });
});

describe("view-model: highlightOf boundary rules", () => {
  const opts = { now: 10_000, idleBudgetMs: 1000 };

  it("terminal runs are never highlighted, even when absurdly idle", () => {
    const s = snapshot({ status: "failed", diag: diag({ lastEventAt: 0 }) });
    expect(highlightOf(s, { now: 9_999_999, idleBudgetMs: 1 })).toBe("none");
  });

  it("idle at exactly half the budget is NOT warn; one ms past it is", () => {
    const atHalf = snapshot({ diag: diag({ lastEventAt: 9_500 }) }); // idle = 500 = 1000/2
    expect(highlightOf(atHalf, opts)).toBe("none");
    const pastHalf = snapshot({ diag: diag({ lastEventAt: 9_499 }) }); // idle = 501
    expect(highlightOf(pastHalf, opts)).toBe("warn");
  });

  it("stopping is crit regardless of idle", () => {
    const s = snapshot({ status: "stopping", diag: diag({ lastEventAt: 10_000 }) });
    expect(highlightOf(s, opts)).toBe("crit");
  });

  it("past the total deadline is crit; before it is not", () => {
    const overdue = snapshot({ deadlines: { enqueuedAt: 0, deadlineAt: 9_999, queueDeadlineAt: undefined } });
    expect(highlightOf(overdue, { now: 10_000 })).toBe("crit");
    const inTime = snapshot({ deadlines: { enqueuedAt: 0, deadlineAt: 10_000, queueDeadlineAt: undefined } });
    expect(highlightOf(inTime, { now: 10_000 })).toBe("none");
  });

  it("without an idleBudgetMs there is no idle-based warn (wiring degrades gracefully)", () => {
    const s = snapshot({ diag: diag({ lastEventAt: 0 }) });
    expect(highlightOf(s, { now: 10_000 })).toBe("none");
  });
});

describe("view-model: animated thinking label (braille spinner)", () => {
  it("thinking phases render the spinner frame for the current wall second", () => {
    expect(phaseLabel("model_turn", undefined, 10_000)).toBe("⠋思考"); // floor(10s/1s) % 10 = 0
    expect(phaseLabel("model_turn", undefined, 11_000)).toBe("⠙思考");
    expect(phaseLabel("prompt_dispatch", undefined, 42_000)).toBe("⠹思考"); // 42 % 10 = 2
    // consecutive 1Hz ticks advance exactly one frame
    const frames = [0, 1, 2, 3].map((s) => phaseLabel("model_turn", undefined, s * 1000));
    expect(frames).toEqual(THINKING_SPINNER_FRAMES.slice(0, 4).map((f) => `${f}思考`));
  });

  it("without a wall clock the label stays the static 🧠思考 (backward compatible)", () => {
    expect(phaseLabel("model_turn")).toBe("🧠思考");
    expect(phaseLabel("prompt_dispatch", undefined)).toBe("🧠思考");
  });

  it("non-thinking phases never animate; negative now clamps to frame 0", () => {
    expect(phaseLabel("tool_exec", undefined, 11_000)).toBe("🔧工具");
    expect(thinkingSpinnerFrame(-5)).toBe("⠋");
  });

  it("buildFleetViewModel rows carry the animated label for the view's now", () => {
    const model = buildFleetViewModel([snapshot()], { now: 13_000 });
    expect(model.rows[0]!.phaseLabel).toBe("⠸思考"); // 13 % 10 = 3
  });
});

describe("view-model: buildFleetViewModel", () => {
  const opts = { now: 10_000, idleBudgetMs: 1000 };

  it("empty list → no rows, zero counts", () => {
    const model = buildFleetViewModel([], opts);
    expect(model.rows).toEqual([]);
    expect(model.activeCount).toBe(0);
    expect(model.totalCount).toBe(0);
    expect(model.usageTotal).toBeUndefined();
  });

  it("orders active rows crit → warn → none, then longest-elapsed first", () => {
    const calm = snapshot({ runId: "calm-0000", diag: diag({ createdAt: 1_000, lastEventAt: 9_900 }) });
    const idle = snapshot({ runId: "idle-0000", diag: diag({ createdAt: 2_000, lastEventAt: 9_000 }) });
    const stuck = snapshot({ runId: "stuck-0000", status: "stopping", diag: diag({ createdAt: 3_000 }) });
    const model = buildFleetViewModel([calm, idle, stuck], opts);
    expect(model.rows.map((r) => r.runId)).toEqual(["stuck-0000", "idle-0000", "calm-0000"]);
    expect(model.rows.map((r) => r.highlight)).toEqual(["crit", "warn", "none"]);
    expect(model.activeCount).toBe(3);
  });

  it("caps active rows and reports the overflow in the counts", () => {
    const runs = Array.from({ length: 5 }, (_, i) =>
      snapshot({ runId: `run-${i}`, diag: diag({ createdAt: i, lastEventAt: 9_900 }) }),
    );
    const model = buildFleetViewModel(runs, { ...opts, maxActiveRows: 2 });
    expect(model.rows).toHaveLength(2);
    expect(model.activeCount).toBe(5);
    expect(model.shownActiveCount).toBe(2);
  });

  it("appends only the N most recent terminal runs, dimmed and never highlighted", () => {
    const terms = [1, 2, 3, 4].map((i) =>
      snapshot({ runId: `done-${i}`, status: "completed", phase: "settled", updatedAt: i * 100 }),
    );
    const model = buildFleetViewModel(terms, { ...opts, recentTerminal: 2 });
    expect(model.rows.map((r) => r.runId)).toEqual(["done-4", "done-3"]); // updatedAt desc
    expect(model.rows.every((r) => r.terminal && r.highlight === "none")).toBe(true);
    expect(model.activeCount).toBe(0);
    expect(model.totalCount).toBe(4);
  });

  it("carries tool / escalation / usage / nested / type into the row", () => {
    const s = snapshot({
      parentRunId: "parent-1",
      diag: diag({
        createdAt: 9_000,
        lastEventAt: 9_900,
        currentTool: { name: "bash", toolCallId: "t1", startedAt: 9_900 },
        escalation: [{ level: "L1", at: 9_100, ok: true }],
        usage: usage(0.001),
      }),
    });
    const model = buildFleetViewModel([s], { ...opts, typeOf: (id) => (id === s.runId ? "worker" : undefined) });
    const row = model.rows[0]!;
    expect(row.currentTool).toBe("bash");
    expect(row.escalation).toBe("L1✓");
    expect(row.maxEscalation).toBe("L1");
    expect(row.usage?.costUsd).toBe(0.001);
    expect(row.nested).toBe(true);
    expect(row.type).toBe("worker");
    expect(row.elapsedMs).toBe(1_000);
    expect(row.idleMs).toBe(100);
  });

  it("sums usage across ALL runs (active + terminal) for the footer total", () => {
    const a = snapshot({ runId: "a", diag: diag({ usage: usage(0.001) }) });
    const b = snapshot({ runId: "b", status: "completed", diag: diag({ usage: usage(0.002) }) });
    const c = snapshot({ runId: "c" }); // no usage
    const model = buildFleetViewModel([a, b, c], opts);
    expect(model.usageTotal?.input).toBe(20);
    expect(model.usageTotal?.costUsd).toBeCloseTo(0.003, 10);
  });
});

describe("view-model: streamLine (» thinking/answer preview)", () => {
  const opts = { now: 10_000, idleBudgetMs: 1000 };

  it("prefers the live thinking stream during model_turn", () => {
    const s = snapshot({ diag: diag({ thinkingText: "planning\nlet me check the code", text: "stale answer" }) });
    const row = buildFleetViewModel([s], opts).rows[0]!;
    expect(row.streamLine).toBe("let me check the code");
  });

  it("falls back to the answer text when no thinking is buffered", () => {
    const s = snapshot({ diag: diag({ text: "the answer is 42" }) });
    const row = buildFleetViewModel([s], opts).rows[0]!;
    expect(row.streamLine).toBe("the answer is 42");
  });

  it("is suppressed outside model_turn and for terminal runs", () => {
    const toolExec = snapshot({
      runId: "tool-0000",
      phase: "tool_exec",
      diag: diag({ thinkingText: "hmm" }),
    });
    const done = snapshot({
      runId: "done-0000",
      status: "completed",
      phase: "settled",
      diag: diag({ thinkingText: "hmm" }),
    });
    const model = buildFleetViewModel([toolExec, done], { ...opts, recentTerminal: 1 });
    expect(model.rows.every((r) => r.streamLine === undefined)).toBe(true);
  });

  it("collapses whitespace and truncates long lines", () => {
    const s = snapshot({ diag: diag({ thinkingText: `  a   b\n${"z".repeat(100)}  ` }) });
    const row = buildFleetViewModel([s], opts).rows[0]!;
    expect(row.streamLine).toBe(`${"z".repeat(59)}…`);
  });
});
