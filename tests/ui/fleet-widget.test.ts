import { describe, expect, it } from "vitest";
import { FakeClock } from "../../src/core/clock.js";
import type { LifecycleEvent, RunDiagnostics, RunSnapshot, UsageDelta } from "../../src/core/types.js";
import type { QueryService } from "../../src/service/query-service.js";
import { buildFleetViewModel, type FleetTone } from "../../src/ui/fleet-panel.js";
import {
  buildFleetWidgetLines,
  FLEET_WIDGET_KEY,
  FleetWidgetController,
  formatWidgetCost,
  treeOrder,
  WIDGET_MAX_ROWS,
} from "../../src/ui/fleet-widget.js";

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

const NOW = 10_000;
const OPTS = { now: NOW, idleBudgetMs: 1000 };

describe("view-model: formatWidgetCost boundaries", () => {
  it("4 decimals below half a cent, 2 decimals at/above", () => {
    expect(formatWidgetCost(0)).toBe("$0.0000");
    expect(formatWidgetCost(0.000312)).toBe("$0.0003");
    expect(formatWidgetCost(0.0049)).toBe("$0.0049");
    expect(formatWidgetCost(0.005)).toBe("$0.01"); // boundary: rounds up at 2dp
    expect(formatWidgetCost(1.05)).toBe("$1.05");
    expect(formatWidgetCost(12.5)).toBe("$12.50");
  });
});

describe("view-model: buildFleetWidgetLines (agent tree)", () => {
  it("returns undefined when nothing is active (empty fleet → widget hidden)", () => {
    expect(buildFleetWidgetLines(buildFleetViewModel([], OPTS))).toBeUndefined();
  });

  it("returns undefined when only terminal runs exist (history is panel material)", () => {
    const done = snapshot({ status: "completed", phase: "settled" });
    expect(buildFleetWidgetLines(buildFleetViewModel([done], OPTS))).toBeUndefined();
  });

  it("single active run → header + one tree row with id-fallback, type, phase, elapsed, cost", () => {
    const run = snapshot({
      diag: diag({ createdAt: NOW - 8 * 60_000 - 32_000, lastEventAt: 9_900, usage: usage(1.05) }),
    });
    const model = buildFleetViewModel([run], { ...OPTS, typeOf: () => "architect" });
    expect(buildFleetWidgetLines(model)).toEqual([
      "● 1 active · $1.05",
      "  aaaaaaaa architect model_turn 8m32s $1.05",
    ]);
  });

  it("M-A meta: label, agentType and model from diag are rendered on the row", () => {
    const run = snapshot({
      diag: diag({
        createdAt: 9_000,
        lastEventAt: 9_900,
        label: "重构用户模块",
        agentType: "architect",
        model: { provider: "copilot-completion", id: "kimi-k3" },
      }),
    });
    const lines = buildFleetWidgetLines(buildFleetViewModel([run], OPTS))!;
    expect(lines[1]).toBe("  重构用户模块 architect kimi-k3 model_turn 1s");
  });

  it("tool trail: prefers diag.toolHistory trail; falls back to ▸currentTool", () => {
    const withHistory = snapshot({
      diag: diag({
        createdAt: 9_000,
        lastEventAt: 9_900,
        toolHistory: [
          { name: "bash", toolCallId: "a", startedAt: 1, endedAt: 2, isError: false },
          { name: "bash", toolCallId: "b", startedAt: 3, endedAt: 4, isError: false },
          { name: "edit", toolCallId: "c", startedAt: 5 },
        ],
      }),
    });
    expect(buildFleetWidgetLines(buildFleetViewModel([withHistory], OPTS))![1]).toBe(
      "  aaaaaaaa · model_turn 1s bash×2 ▸edit",
    );
    const withTool = snapshot({
      diag: diag({
        createdAt: 9_000,
        lastEventAt: 9_900,
        currentTool: { name: "bash", toolCallId: "t", startedAt: 9_900 },
      }),
    });
    expect(buildFleetWidgetLines(buildFleetViewModel([withTool], OPTS))![1]).toBe("  aaaaaaaa · model_turn 1s ▸bash");
  });

  it("tree: a child whose parent is shown is indented under it (↳), not severity-sorted away", () => {
    const parent = snapshot({ runId: "parent-00", diag: diag({ createdAt: 1_000, lastEventAt: 9_900 }) });
    const child = snapshot({
      runId: "child-000",
      parentRunId: "parent-00",
      diag: diag({ createdAt: 5_000, lastEventAt: 9_900 }),
    });
    const other = snapshot({ runId: "other-000", diag: diag({ createdAt: 2_000, lastEventAt: 9_900 }) });
    // severity equal → elapsed order: parent(9s), other(8s), child(5s); tree pulls child up under parent
    const lines = buildFleetWidgetLines(buildFleetViewModel([parent, child, other], OPTS))!;
    expect(lines).toEqual([
      "● 3 active",
      "  parent-0 · model_turn 9s",
      "  ↳ child-00 · model_turn 5s",
      "  other-00 · model_turn 8s",
    ]);
  });

  it("nested run whose parent is NOT shown still gets the ↳ marker at top level", () => {
    const nested = snapshot({ parentRunId: "p", diag: diag({ createdAt: 9_000, lastEventAt: 9_900 }) });
    const lines = buildFleetWidgetLines(buildFleetViewModel([nested], OPTS))!;
    expect(lines[1]).toBe("  ↳ aaaaaaaa · model_turn 1s");
  });

  it("highlight-priority: crit run's row is first among roots and the bullet takes the worst tone", () => {
    const calmOld = snapshot({ runId: "calm-0000", diag: diag({ createdAt: 0, lastEventAt: 9_900 }) });
    const stuck = snapshot({
      runId: "stuck-0000",
      status: "stopping",
      diag: diag({ createdAt: 9_500, lastEventAt: 9_900 }),
    });
    const tones: Array<[FleetTone, string]> = [];
    const lines = buildFleetWidgetLines(buildFleetViewModel([calmOld, stuck], OPTS), {
      color: (tone, text) => {
        tones.push([tone, text]);
        return `[${tone}]${text}`;
      },
    })!;
    expect(tones[0]).toEqual(["crit", "●"]);
    expect(lines[1]).toContain("[crit]✗ stuck-00");
    expect(lines[2]).toContain("[none]  calm-000");
  });

  it("marks: ✗ crit, ! warn, space otherwise", () => {
    const stuck = snapshot({
      runId: "stuck-0000",
      status: "stopping",
      diag: diag({ createdAt: 9_000, lastEventAt: 9_900 }),
    });
    const idle = snapshot({ runId: "idle-0000", diag: diag({ createdAt: 8_000, lastEventAt: 9_000 }) }); // idle 1000 > 500 = warn
    const calm = snapshot({ runId: "calm-0000", diag: diag({ createdAt: 7_000, lastEventAt: 9_900 }) });
    const lines = buildFleetWidgetLines(buildFleetViewModel([calm, idle, stuck], OPTS))!;
    expect(lines).toHaveLength(4);
    expect(lines[1]!.startsWith("✗ ")).toBe(true);
    expect(lines[2]!.startsWith("! ")).toBe(true);
    expect(lines[3]!.startsWith("  ")).toBe(true);
  });

  it("header cost sums active rows only and is omitted at $0", () => {
    const a = snapshot({ runId: "a-0000000", diag: diag({ createdAt: 9_000, lastEventAt: 9_900, usage: usage(0.002) }) });
    const b = snapshot({ runId: "b-0000000", diag: diag({ createdAt: 9_000, lastEventAt: 9_900, usage: usage(0.001) }) });
    expect(buildFleetWidgetLines(buildFleetViewModel([a, b], OPTS))![0]).toBe("● 2 active · $0.0030");
    const free = snapshot({ diag: diag({ createdAt: 9_000, lastEventAt: 9_900 }) });
    expect(buildFleetWidgetLines(buildFleetViewModel([free], OPTS))![0]).toBe("● 1 active");
  });

  it("truncation: default 5 rows + header, overflow reported on the header as +N more", () => {
    const runs = Array.from({ length: 7 }, (_, i) =>
      snapshot({ runId: `run-${i}00000`, diag: diag({ createdAt: i, lastEventAt: 9_900 }) }),
    );
    const model = buildFleetViewModel(runs, OPTS);
    const lines = buildFleetWidgetLines(model)!; // default maxRows = 5
    expect(lines).toHaveLength(6);
    expect(lines[0]).toContain("7 active");
    expect(lines[0]).toContain("+2 more");
  });

  it("overflow boundary: exactly maxRows runs → no '+more'; maxRows 1 → header + 1 row", () => {
    const two = [0, 1].map((i) => snapshot({ runId: `r${i}0000000`, diag: diag({ createdAt: i, lastEventAt: 9_900 }) }));
    const exact = buildFleetWidgetLines(buildFleetViewModel(two, OPTS))!;
    expect(exact).toHaveLength(3);
    expect(exact[0]).not.toContain("more");

    const one = buildFleetWidgetLines(buildFleetViewModel(two, OPTS), { maxRows: 1 })!;
    expect(one).toHaveLength(2);
    expect(one[0]).toContain("+1 more");
  });

  it(`maxRows is hard-capped at ${WIDGET_MAX_ROWS}`, () => {
    const runs = Array.from({ length: 12 }, (_, i) =>
      snapshot({ runId: `run-${i}0000`, diag: diag({ createdAt: i, lastEventAt: 9_900 }) }),
    );
    const model = buildFleetViewModel(runs, { ...OPTS, maxActiveRows: 12 });
    const lines = buildFleetWidgetLines(model, { maxRows: 99 })!;
    expect(lines).toHaveLength(1 + WIDGET_MAX_ROWS);
    expect(lines[0]).toContain(`+${12 - WIDGET_MAX_ROWS} more`);
  });

  it("terminal rows in a mixed model are ignored (active-only tree)", () => {
    const active = snapshot({ runId: "live-0000", diag: diag({ lastEventAt: 9_900 }) });
    const done = snapshot({ runId: "done-0000", status: "completed", phase: "settled", updatedAt: 9_999 });
    const model = buildFleetViewModel([active, done], { ...OPTS, recentTerminal: 3 });
    const lines = buildFleetWidgetLines(model)!;
    expect(lines).toHaveLength(2);
    expect(lines[0]).toContain("1 active");
  });
});

describe("view-model: treeOrder", () => {
  const row = (runId: string, parentRunId?: string) => ({
    ...buildFleetViewModel([snapshot({ runId, ...(parentRunId ? { parentRunId } : {}) })], OPTS).rows[0]!,
  });
  it("orders depth-first with correct depths; unknown parents stay top-level", () => {
    const rows = [row("a"), row("c", "b"), row("b", "a"), row("x", "missing")];
    const ordered = treeOrder(rows);
    expect(ordered.map((o) => [o.row.runId, o.depth])).toEqual([
      ["a", 0],
      ["b", 1],
      ["c", 2],
      ["x", 0],
    ]);
  });
});

describe("FleetWidgetController (fake ui)", () => {
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

  interface WidgetCall {
    key: string;
    content: string[] | undefined;
    options?: { placement?: string };
  }
  function fakeUi() {
    const calls: WidgetCall[] = [];
    return {
      calls,
      setWidget(key: string, content: string[] | undefined, options?: { placement?: string }) {
        calls.push({ key, content, options });
      },
    };
  }

  const lifecycleEvent = (runId: string): LifecycleEvent => ({ runId, generation: 1, status: "running", at: NOW });

  it("mounts above the editor on construction when runs are active", () => {
    const clock = new FakeClock(NOW);
    const ui = fakeUi();
    const query = fakeQuery([snapshot({ runId: "live-0000", diag: diag({ createdAt: 9_000, lastEventAt: 9_900 }) })]);
    new FleetWidgetController({ ui, query, clock, idleBudgetMs: 1000 });
    expect(ui.calls).toHaveLength(1);
    expect(ui.calls[0]!.key).toBe(FLEET_WIDGET_KEY);
    expect(ui.calls[0]!.options?.placement).toBe("aboveEditor");
    expect(ui.calls[0]!.content).toEqual(["● 1 active", "  live-000 · model_turn 1s"]);
    expect(clock.pendingTimers).toBe(1); // 1s tick armed
  });

  it("hides the widget (setWidget undefined) when no runs are active", () => {
    const clock = new FakeClock(NOW);
    const ui = fakeUi();
    new FleetWidgetController({ ui, query: fakeQuery([]), clock });
    expect(ui.calls).toHaveLength(1);
    expect(ui.calls[0]!.content).toBeUndefined();
  });

  it("refreshes on the clock tick with updated elapsed times", () => {
    const clock = new FakeClock(NOW);
    const ui = fakeUi();
    const query = fakeQuery([snapshot({ runId: "live-0000", diag: diag({ createdAt: 9_000, lastEventAt: 9_900 }) })]);
    new FleetWidgetController({ ui, query, clock });
    clock.advance(61_000);
    const last = ui.calls[ui.calls.length - 1]!;
    expect(last.content![1]).toContain("1m02s"); // now=71_000, createdAt=9_000
    expect(ui.calls.length).toBeGreaterThan(10); // one push per 1s tick
  });

  it("H1 onLifecycle triggers an immediate refresh (start → shown, finish → hidden)", () => {
    const clock = new FakeClock(NOW);
    const ui = fakeUi();
    const query = fakeQuery([]);
    const widget = new FleetWidgetController({ ui, query, clock });
    expect(ui.calls[0]!.content).toBeUndefined();

    query.runs.push(snapshot({ runId: "live-0000", diag: diag({ createdAt: 9_000, lastEventAt: 9_900 }) }));
    widget.lifecycle.onLifecycle!(lifecycleEvent("live-0000"));
    expect(ui.calls[ui.calls.length - 1]!.content).toEqual(["● 1 active", "  live-000 · model_turn 1s"]);

    query.runs.length = 0;
    widget.lifecycle.onLifecycle!({ ...lifecycleEvent("live-0000"), status: "completed" });
    expect(ui.calls[ui.calls.length - 1]!.content).toBeUndefined();
  });

  it("dispose stops the tick and clears the widget; double dispose is a no-op", () => {
    const clock = new FakeClock(NOW);
    const ui = fakeUi();
    const query = fakeQuery([snapshot({ runId: "live-0000" })]);
    const widget = new FleetWidgetController({ ui, query, clock });
    widget.dispose();
    expect(clock.pendingTimers).toBe(0);
    expect(ui.calls[ui.calls.length - 1]).toEqual({ key: FLEET_WIDGET_KEY, content: undefined, options: undefined });
    const callCount = ui.calls.length;
    clock.advance(5_000);
    widget.dispose();
    expect(ui.calls).toHaveLength(callCount); // nothing after dispose
  });

  it("non-interactive host without setWidget → inert: no throw, no timer, refresh is a no-op", () => {
    const clock = new FakeClock(NOW);
    const query = fakeQuery([snapshot({ runId: "live-0000" })]);
    const widget = new FleetWidgetController({ ui: {}, query, clock });
    expect(clock.pendingTimers).toBe(0);
    expect(() => {
      widget.refresh();
      widget.lifecycle.onLifecycle!(lifecycleEvent("live-0000"));
      widget.dispose();
    }).not.toThrow();
    const noUi = new FleetWidgetController({ query, clock });
    expect(clock.pendingTimers).toBe(0);
    expect(() => noUi.dispose()).not.toThrow();
  });

  it("a throwing setWidget disables the widget silently (sticky), never propagates", () => {
    const clock = new FakeClock(NOW);
    const query = fakeQuery([snapshot({ runId: "live-0000" })]);
    const ui = {
      calls: 0,
      setWidget() {
        this.calls++;
        throw new Error("no TUI in rpc mode");
      },
    };
    const widget = new FleetWidgetController({ ui, query, clock });
    expect(ui.calls).toBe(1); // initial refresh attempted once
    expect(clock.pendingTimers).toBe(0); // tick stopped after the throw
    expect(() => {
      widget.refresh();
      widget.lifecycle.onLifecycle!(lifecycleEvent("live-0000"));
      widget.dispose();
    }).not.toThrow();
    expect(ui.calls).toBe(1); // sticky dead: no further attempts
  });

  it("settings off (enabled: false) → inert: no setWidget call, no timer", () => {
    const clock = new FakeClock(NOW);
    const ui = fakeUi();
    const query = fakeQuery([snapshot({ runId: "live-0000" })]);
    const widget = new FleetWidgetController({ ui, query, clock, enabled: false });
    expect(ui.calls).toHaveLength(0);
    expect(clock.pendingTimers).toBe(0);
    expect(() => widget.dispose()).not.toThrow();
  });
});
