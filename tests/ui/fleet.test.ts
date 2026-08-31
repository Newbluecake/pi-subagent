import { describe, expect, it } from "vitest";
import { visibleWidth } from "@earendil-works/pi-tui";
import { FakeClock } from "../../src/core/clock.js";
import type { RunDiagnostics, RunSnapshot, UsageDelta } from "../../src/core/types.js";
import type { QueryService } from "../../src/service/query-service.js";
import {
  buildFleetViewModel,
  escalationSummary,
  FleetPanel,
  formatDuration,
  formatUsage,
  highlightOf,
  idleOf,
  renderFleetLines,
  type FleetTone,
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

  it("caps active rows and reports the overflow", () => {
    const runs = Array.from({ length: 5 }, (_, i) =>
      snapshot({ runId: `run-${i}`, diag: diag({ createdAt: i, lastEventAt: 9_900 }) }),
    );
    const model = buildFleetViewModel(runs, { ...opts, maxActiveRows: 2 });
    expect(model.rows).toHaveLength(2);
    expect(model.activeCount).toBe(5);
    expect(model.shownActiveCount).toBe(2);
    const text = renderFleetLines(model).join("\n");
    expect(text).toContain("+3 more active run(s)");
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

describe("renderFleetLines (plain + injected color)", () => {
  const opts = { now: 10_000, idleBudgetMs: 1000 };

  it("renders the empty state", () => {
    const lines = renderFleetLines(buildFleetViewModel([], opts));
    expect(lines.join("\n")).toContain("No subagent runs recorded");
    expect(lines[0]).toContain("0 active / 0 total");
  });

  it("renders run id, status, phase, tool, escalation and usage in the row", () => {
    const s = snapshot({
      runId: "abcdef12-3456",
      diag: diag({
        currentTool: { name: "read", toolCallId: "t", startedAt: 1 },
        escalation: [{ level: "L2", at: 1, ok: false }],
        usage: usage(0.0001),
      }),
    });
    const text = renderFleetLines(buildFleetViewModel([s], opts)).join("\n");
    expect(text).toContain("abcdef12");
    expect(text).toContain("running");
    expect(text).toContain("model_turn");
    expect(text).toContain("read");
    expect(text).toContain("esc:L2✗");
    expect(text).toContain("$0.0001");
    expect(text).toContain("1 active / 1 total");
    expect(text).toContain("Usage (all runs):");
  });

  it("applies the injected color by highlight level — warn yellow, crit red, terminal muted", () => {
    const warn = snapshot({ runId: "warn-001", diag: diag({ lastEventAt: 9_000 }) });
    const crit = snapshot({ runId: "crit-001", status: "stopping" });
    const done = snapshot({ runId: "done-001", status: "completed", phase: "settled", updatedAt: 5 });
    const model = buildFleetViewModel([warn, crit, done], opts);
    const color = (tone: FleetTone, text: string) => `<${tone}>${text}</>`;
    const text = renderFleetLines(model, { color }).join("\n");
    expect(text).toMatch(/<warn>[^\n]*warn-001/);
    expect(text).toMatch(/<crit>[^\n]*crit-001/);
    expect(text).toMatch(/<muted>[^\n]*done-001/);
    expect(text).not.toMatch(/<warn>[^\n]*done-001/);
  });
});

describe("FleetPanel component", () => {
  function fakeQuery(runs: RunSnapshot[]): QueryService & { runs: RunSnapshot[] } {
    const holder = {
      runs,
      get: (id: string) => holder.runs.find((r) => r.runId === id),
      list: () => [...holder.runs],
      wait: async () => ({ ok: false as const, reason: "unknown_run" as const }),
      waitAll: async () => ({ settled: [], pending: [] }),
      steer: async () => ({ ok: false as const, reason: "not_running" as const }),
      stop: async () => ({ ok: false, escalatedTo: "L4" as const }),
    };
    return holder;
  }

  it("renders current runs and closes on q / esc / ctrl+c, calling done exactly once", () => {
    const clock = new FakeClock(10_000);
    const query = fakeQuery([snapshot({ runId: "live-001" })]);
    let doneCalls = 0;
    const panel = new FleetPanel({ query, clock, done: () => doneCalls++ });
    expect(panel.render(120).join("\n")).toContain("live-001");
    expect(clock.pendingTimers).toBe(1); // refresh timer armed

    panel.handleInput("q");
    expect(doneCalls).toBe(1);
    expect(clock.pendingTimers).toBe(0); // timer cleared on close
    panel.handleInput("q"); // double close is a no-op
    expect(doneCalls).toBe(1);

    const p2 = new FleetPanel({ query, clock, done: () => doneCalls++ });
    p2.handleInput("\x1b");
    const p3 = new FleetPanel({ query, clock, done: () => doneCalls++ });
    p3.handleInput("\x03");
    expect(doneCalls).toBe(3);
  });

  it("auto-refreshes from QueryService.list on the clock tick (data source, not pushed state)", () => {
    const clock = new FakeClock(10_000);
    const query = fakeQuery([]);
    let renders = 0;
    const panel = new FleetPanel({
      query,
      clock,
      refreshMs: 500,
      done: () => undefined,
      tui: { requestRender: () => renders++ },
    });
    expect(panel.render(120).join("\n")).toContain("No subagent runs");
    query.runs.push(snapshot({ runId: "late-run-1" }));
    clock.advance(500); // refresh tick fires
    expect(renders).toBeGreaterThan(0);
    expect(panel.render(120).join("\n")).toContain("late-run");
    panel.dispose();
    expect(clock.pendingTimers).toBe(0);
  });

  it("manual r refresh pulls new data without waiting for the tick", () => {
    const clock = new FakeClock(10_000);
    const query = fakeQuery([]);
    const panel = new FleetPanel({ query, clock, done: () => undefined });
    query.runs.push(snapshot({ runId: "manual-1" }));
    panel.handleInput("r");
    expect(panel.render(120).join("\n")).toContain("manual-1");
    panel.dispose();
  });

  it("truncates every rendered line to the viewport width", () => {
    const clock = new FakeClock(10_000);
    const query = fakeQuery([
      snapshot({
        diag: diag({ currentTool: { name: "a-very-long-tool-name", toolCallId: "t", startedAt: 1 }, usage: usage(1) }),
      }),
    ]);
    const panel = new FleetPanel({ query, clock, done: () => undefined });
    for (const line of panel.render(40)) expect(visibleWidth(line)).toBeLessThanOrEqual(40);
    panel.dispose();
  });
});
