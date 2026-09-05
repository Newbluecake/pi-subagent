import { describe, expect, it, vi } from "vitest";
import { visibleWidth } from "@earendil-works/pi-tui";
import { FakeClock } from "../../src/core/clock.js";
import type { LifecycleEvent, RunDiagnostics, RunSnapshot, UsageDelta } from "../../src/core/types.js";
import type { QueryService } from "../../src/service/query-service.js";
import {
  buildFleetViewModel,
  formatContextTokens,
  formatContextUsage,
  type FleetTone,
} from "../../src/ui/fleet-panel.js";
import {
  buildFleetWidgetLines,
  compactPhaseLabel,
  FLEET_WIDGET_KEY,
  FleetWidgetController,
  formatWidgetCost,
  formatLogSize,
  bashJobHighlight,
  tailLine,
  treeOrder,
  WIDGET_MAX_ROWS,
} from "../../src/ui/fleet-widget.js";

function diag(overrides: Partial<RunDiagnostics> = {}): RunDiagnostics {
  const base: RunDiagnostics = {
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
  // Fixtures that only override createdAt mean "the run has been in this phase since
  // creation" — keep phaseEnteredAt aligned so rows display the expected duration.
  if (overrides.createdAt !== undefined && overrides.phaseEnteredAt === undefined) {
    base.phaseEnteredAt = overrides.createdAt;
  }
  return base;
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

describe("view-model: context usage formatting", () => {
  it("formats context windows at every compact-unit boundary", () => {
    expect(formatContextTokens(999)).toBe("999");
    expect(formatContextTokens(1000)).toBe("1.0k");
    expect(formatContextTokens(9999)).toBe("10.0k");
    expect(formatContextTokens(10_000)).toBe("10k");
    expect(formatContextTokens(999_999)).toBe("1000k");
    expect(formatContextTokens(1_000_000)).toBe("1.0M");
    expect(formatContextTokens(9_999_999)).toBe("10.0M");
    expect(formatContextTokens(10_000_000)).toBe("10M");
  });

  it("renders unknown post-compaction usage with a compact window", () => {
    expect(formatContextUsage({ tokens: null, contextWindow: 262_144, percent: null })).toBe("?/262k");
    expect(formatContextUsage({ tokens: 32_000, contextWindow: 262_144, percent: 12.34 })).toBe("12.3%/262k");
  });
});

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

  it("renders context usage before cost on active and terminal rows", () => {
    const contextUsage = { tokens: 32_000, contextWindow: 262_144, percent: 12.34 };
    const active = snapshot({ diag: diag({ usage: usage(0.0042), contextUsage }) });
    const done = snapshot({
      status: "completed",
      phase: "settled",
      updatedAt: NOW,
      diag: diag({ usage: usage(0.0042), contextUsage }),
    });
    const lines = buildFleetWidgetLines(buildFleetViewModel([active, done], { ...OPTS, recentTerminal: 1 }))!;
    expect(lines[1]).toContain("12.3%/262k $0.0042");
    expect(lines[2]).toContain("12.3%/262k $0.0042");
    expect(lines[1]!.indexOf("12.3%/262k")).toBeLessThan(lines[1]!.indexOf("$0.0042"));
  });

  it("single active run → header + one tree row with id-fallback, type, phase, elapsed, cost", () => {
    const run = snapshot({
      diag: diag({ createdAt: NOW - 8 * 60_000 - 32_000, lastEventAt: 9_900, usage: usage(1.05) }),
    });
    const model = buildFleetViewModel([run], { ...OPTS, typeOf: () => "architect" });
    expect(buildFleetWidgetLines(model)).toEqual([
      "● 1 active Agents · $1.05",
      "  aaaaaaaa architect 🤔 8m32s $1.05 Σ8m32s",
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
    expect(lines[1]).toBe("  重构用户模块 architect copilot-completion/kimi-k3 🤔 1s Σ1s");
  });

  it("model uses full name, basename, then omission as width tightens", () => {
    const run = snapshot({
      diag: diag({
        createdAt: 9_000,
        phaseEnteredAt: 9_000,
        lastEventAt: 9_900,
        model: { provider: "droid-completion", id: "very-long-model-name" },
      }),
    });
    const model = buildFleetViewModel([run], OPTS);
    const full = buildFleetWidgetLines(model, { width: 120 })![1]!;
    expect(full).toContain("droid-completion/very-long-model-name");

    const medium = buildFleetWidgetLines(model, { width: 45 })![1]!;
    expect(medium).toContain("very-long-model-name");
    expect(medium).not.toContain("droid-completion/very-long-model-name");

    const narrow = buildFleetWidgetLines(model, { width: 20 })![1]!;
    expect(narrow).not.toContain("very-long-model-name");
    expect(visibleWidth(narrow)).toBeLessThanOrEqual(20);
  });

  it("drops fields by priority while retaining label and phase", () => {
    const run = snapshot({
      diag: diag({
        createdAt: 9_000,
        phaseEnteredAt: 9_000,
        lastEventAt: 9_900,
        label: "任务标签",
        agentType: "architect",
        model: { provider: "droid-completion", id: "long-model-name" },
        contextUsage: { tokens: 32_000, contextWindow: 262_144, percent: 12.3 },
        usage: usage(1.05),
        autoBackgroundedAt: 9_000,
      }),
    });
    const model = buildFleetViewModel([run], OPTS);
    const at = (width: number) => buildFleetWidgetLines(model, { width })![1]!;
    expect(at(120)).toContain("任务标签 architect droid-completion/long-model-name");
    expect(at(120)).toContain("⇣后台");
    expect(at(70)).not.toContain("architect");
    expect(at(70)).toContain("long-model-name");
    expect(at(50)).not.toContain("long-model-name");
    expect(at(50)).toContain("12.3%/262k");
    expect(at(35)).not.toContain("12.3%/262k");
    expect(at(35)).toContain("$1.05");
    // Last drop tier: ⇣后台 goes before Σ (buildFleetWidgetLines clamps
    // width to >= 20, at which label+phase+Σ still fit, so the Σ-drop tier
    // is unreachable through this entry point).
    expect(at(26)).toContain("⇣后台");
    expect(at(26)).toContain("Σ1s");
    expect(at(24)).not.toContain("⇣后台");
    expect(at(24)).toContain("Σ1s");
    // The label is never truncated while droppable fields remain.
    expect(at(20)).toContain("任务标签");
    expect(at(20)).not.toContain("...");
    for (const width of [120, 70, 50, 35, 26, 24, 20]) {
      const line = at(width);
      expect(line).toContain("任务标签");
      expect(line).toMatch(/(?:🤔|💭|🧠|🤔) 1s/);
    }
  });

  it("truncates label only when label plus phase cannot fit", () => {
    const run = snapshot({ diag: diag({ label: "这是一个非常长的任务标签", lastEventAt: 9_900 }) });
    const model = buildFleetViewModel([run], OPTS);
    const wide = buildFleetWidgetLines(model, { width: 60 })![1]!;
    expect(wide).toContain("这是一个非常长的任务标签");
    const narrow = buildFleetWidgetLines(model, { width: 20 })![1]!;
    expect(narrow).toContain("...");
    expect(narrow).toMatch(/🤔 10s/);
  });

  it("compacts BMP and retry phase labels without leaving text fragments", () => {
    const cases = [
      ["queue_wait", "⏸ 1s"],
      ["resolve_config", "⚡ 1s"],
      ["retry_backoff", "♻2/3 1s"],
      ["reap", "⏹ 1s"],
    ] as const;
    for (const [phase, expected] of cases) {
      const run = snapshot({
        phase,
        diag: diag({
          createdAt: 9_000,
          phaseEnteredAt: 9_000,
          phase,

          ...(phase === "retry_backoff"
            ? { retry: { attempt: 2, maxAttempts: 3, delayMs: 100, startedAt: 9_000 } }
            : {}),
        }),
      });
      const line = buildFleetWidgetLines(buildFleetViewModel([run], OPTS), { width: 120 })![1]!;
      expect(line).toContain(expected);
      expect(line).not.toContain("排队");
      expect(line).not.toContain("启动");
      expect(line).not.toContain("重试");
      expect(line).not.toContain("停止");
    }
  });

  it("compactPhaseLabel: variation-selector (U+FE0F) inputs stay fragment-free", () => {
    // VS16-bearing emoji are unreachable via FleetRow (phase labels are
    // generated without it) but compactPhaseLabel must not leave the
    // selector or the text remnant behind if one ever shows up.
    expect(compactPhaseLabel("⏸️排队")).toBe("⏸️");
    expect(compactPhaseLabel("⚡️启动")).toBe("⚡️");
    expect(compactPhaseLabel("⏹️停止中")).toBe("⏹️");
    expect(compactPhaseLabel("♻️重试2/3")).toBe("♻️2/3");
    expect(compactPhaseLabel("♻重试1/5")).toBe("♻1/5");
    expect(compactPhaseLabel("🤔思考")).toBe("🤔");
    // Non-emoji phase labels pass through untouched.
    expect(compactPhaseLabel("等待中")).toBe("等待中");
  });

  it("shows the auto-background indicator on the main row", () => {
    const run = snapshot({ diag: diag({ autoBackgroundedAt: 9_000, lastEventAt: 9_900 }) });
    expect(buildFleetWidgetLines(buildFleetViewModel([run], OPTS), { width: 120 })![1]).toContain("⇣后台");
  });

  it("tool trail: own continuation line; prefers diag.toolHistory trail; falls back to ▸currentTool", () => {
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
    expect(buildFleetWidgetLines(buildFleetViewModel([withHistory], OPTS))!.slice(1)).toEqual([
      "  aaaaaaaa · 🤔 1s Σ1s",
      "  ╰ ✓ bash ×2 | ▸edit · 9s",
    ]);
    const withTool = snapshot({
      diag: diag({
        createdAt: 9_000,
        lastEventAt: 9_900,
        currentTool: { name: "bash", toolCallId: "t", startedAt: 9_900 },
      }),
    });
    expect(buildFleetWidgetLines(buildFleetViewModel([withTool], OPTS))!.slice(1)).toEqual([
      "  aaaaaaaa · 🤔 1s Σ1s",
      "  ╰ ▸bash · 100ms",
    ]);
  });

  it("tool trail: terminal run freezes the in-flight segment (no ever-growing duration)", () => {
    // A run killed mid-tool keeps its in-flight record in toolHistory — the
    // trail must NOT carry a live duration that keeps aging after the run ended.
    const killedMidTool = snapshot({
      status: "aborted",
      phase: "settled",
      updatedAt: NOW,
      diag: diag({
        createdAt: 1_000,
        toolHistory: [{ name: "bash", toolCallId: "a", startedAt: 5_000, argsPreview: "npm test" }],
        currentTool: { name: "bash", toolCallId: "a", startedAt: 5_000 },
      }),
    });
    const model = buildFleetViewModel([killedMidTool], { ...OPTS, recentTerminal: 3 });
    const row = model.rows[0]!;
    expect(row.terminal).toBe(true);
    expect(row.toolTrail).toBe("▸bash npm test"); // no " · Ns" suffix
    expect(row.currentTool).toBeUndefined();
    expect(row.currentToolMs).toBeUndefined();
  });

  it("thinking stream: last text line is shown (one line, truncated) only in model_turn", () => {
    const thinking = snapshot({
      diag: diag({
        createdAt: 9_000,
        lastEventAt: 9_900,
        text: "先分析需求\n然后看一下代码结构，重点关注调度模块",
      }),
    });
    expect(buildFleetWidgetLines(buildFleetViewModel([thinking], OPTS))!.slice(1)).toEqual([
      "  aaaaaaaa · 🤔 1s Σ1s",
      "  ╰ » 然后看一下代码结构，重点关注调度模块",
    ]);
    // a long line is truncated with an ellipsis
    const long = snapshot({
      diag: diag({ createdAt: 9_000, lastEventAt: 9_900, text: "x".repeat(100) }),
    });
    const line = buildFleetWidgetLines(buildFleetViewModel([long], OPTS))![2]!;
    expect(line).toContain("» " + "x".repeat(59) + "…");
    // tool_exec phase: stale pre-tool text is NOT shown (the ▸tool trail carries the live info)
    const tooling = snapshot({
      phase: "tool_exec",
      diag: diag({
        createdAt: 9_000,
        lastEventAt: 9_900,
        text: "调用工具前的思考",
        currentTool: { name: "bash", toolCallId: "t", startedAt: 9_900 },
      }),
    });
    expect(buildFleetWidgetLines(buildFleetViewModel([tooling], OPTS))!.slice(1)).toEqual([
      "  aaaaaaaa · 🔧 1s Σ1s",
      "  ╰ ▸bash · 100ms",
    ]);
    // terminal rows never stream
    const done = snapshot({
      status: "completed",
      phase: "settled",
      updatedAt: NOW,
      diag: diag({ text: "最后的输出" }),
    });
    const lines = buildFleetWidgetLines(buildFleetViewModel([thinking, done], OPTS))!;
    expect(lines.find((l) => l.includes("completed"))).not.toContain("»");
  });

  it("active row shows the current phase's age (phaseMs), not the run's cumulative age", () => {
    const run = snapshot({
      diag: diag({ createdAt: 0, phaseEnteredAt: 9_000, lastEventAt: 9_900 }),
    });
    const lines = buildFleetWidgetLines(buildFleetViewModel([run], OPTS))!;
    expect(lines[1]).toBe("  aaaaaaaa · 🤔 1s Σ10s"); // 1s in this model turn, Σ10s total run age
  });

  it("tool trail: in-flight edit shows which file is being edited (path preview)", () => {
    const editing = snapshot({
      diag: diag({
        createdAt: 9_000,
        lastEventAt: 9_900,
        toolHistory: [{ name: "edit", toolCallId: "a", startedAt: 9_900, argsPreview: "src/ui/fleet-panel.ts" }],
      }),
    });
    expect(buildFleetWidgetLines(buildFleetViewModel([editing], OPTS))![2]).toBe(
      "  ╰ ▸edit src/ui/fleet-panel.ts · 100ms",
    );
  });

  it("tool trail: in-flight call carries a truncated args preview", () => {
    const withPreview = snapshot({
      diag: diag({
        createdAt: 9_000,
        lastEventAt: 9_900,
        toolHistory: [{ name: "bash", toolCallId: "a", startedAt: 9_900, argsPreview: "npm test -- --runInBand" }],
      }),
    });
    expect(buildFleetWidgetLines(buildFleetViewModel([withPreview], OPTS))!.slice(1)).toEqual([
      "  aaaaaaaa · 🤔 1s Σ1s",
      "  ╰ ▸bash npm test -- --runInBand · 100ms",
    ]);
    const longPreview = snapshot({
      diag: diag({
        createdAt: 9_000,
        lastEventAt: 9_900,
        toolHistory: [{ name: "bash", toolCallId: "a", startedAt: 9_900, argsPreview: "y".repeat(80) }],
      }),
    });
    expect(buildFleetWidgetLines(buildFleetViewModel([longPreview], OPTS))![2]).toContain(
      "▸bash " + "y".repeat(59) + "…",
    );
  });

  it("line budget: a run with activity consumes 2 lines; a lone leftover line keeps the main row only", () => {
    const busy = (runId: string, at: number) =>
      snapshot({
        runId,
        diag: diag({
          createdAt: at,
          lastEventAt: 9_900,
          toolHistory: [{ name: "bash", toolCallId: "t", startedAt: 9_900 }],
        }),
      });
    // 3 busy runs with maxRows 5 → 3 main rows + activity for the first two
    const three = [busy("r1-000000", 1_000), busy("r2-000000", 2_000), busy("r3-000000", 3_000)];
    const lines = buildFleetWidgetLines(buildFleetViewModel(three, OPTS), { maxRows: 5 })!;
    expect(lines).toHaveLength(1 + 5);
    expect(lines.filter((l) => l.includes("▸bash"))).toHaveLength(2); // 3rd run's activity dropped
    expect(lines.some((l) => l.includes("r3-00000") && !l.includes("▸"))).toBe(true);
    expect(lines[0]).not.toContain("more"); // all 3 runs shown (as rows)
    // fair allocation: main rows are dealt first — maxRows 2 → two main rows,
    // no activity lines, only the third run hidden behind +1 more
    const tight = buildFleetWidgetLines(buildFleetViewModel(three, OPTS), { maxRows: 2 })!;
    expect(tight).toHaveLength(1 + 2);
    expect(tight.filter((l) => l.includes("▸bash"))).toHaveLength(0);
    expect(tight[0]).toContain("+1 more");
  });

  it("default budget: 3 busy runs all keep their activity lines (main rows first, then trails)", () => {
    const busy = (runId: string, at: number) =>
      snapshot({
        runId,
        diag: diag({
          createdAt: at,
          lastEventAt: 9_900,
          toolHistory: [{ name: "bash", toolCallId: "t", startedAt: 9_900 }],
        }),
      });
    const three = [busy("r1-000000", 1_000), busy("r2-000000", 2_000), busy("r3-000000", 3_000)];
    // default maxRows (6) = 3 main rows + 3 activity lines: the LAST run's
    // tool trail is no longer starved by an odd leftover line
    const lines = buildFleetWidgetLines(buildFleetViewModel(three, OPTS))!;
    expect(lines).toHaveLength(1 + 6);
    expect(lines.filter((l) => l.includes("▸bash"))).toHaveLength(3);
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
      "● 3 active Agents",
      "  parent-0 · 🤔 9s Σ9s",
      "  ↳ child-00 · 🤔 5s Σ5s",
      "  other-00 · 🤔 8s Σ8s",
    ]);
  });

  it("nested run whose parent is NOT shown still gets the ↳ marker at top level", () => {
    const nested = snapshot({ parentRunId: "p", diag: diag({ createdAt: 9_000, lastEventAt: 9_900 }) });
    const lines = buildFleetWidgetLines(buildFleetViewModel([nested], OPTS))!;
    expect(lines[1]).toBe("  ↳ aaaaaaaa · 🤔 1s Σ1s");
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
    expect(tones).toContainEqual(["crit", "●"]);
    expect(lines[1]).toContain("[crit]✗ stuck-00");
    // calm row: segment-colored (muted meta), never whole-line tone-wrapped
    expect(lines[2]).toContain("calm-000");
    expect(lines[2]).toContain("[muted]🤔");
    expect(lines[2]).not.toContain("[crit]");
  });

  it("boundary: a calm run's activity line is muted except the in-flight ▸ segment (main rows stay the anchors)", () => {
    const busy = snapshot({
      diag: diag({
        createdAt: 9_000,
        lastEventAt: 9_900,
        toolHistory: [
          { name: "read", toolCallId: "a", startedAt: 9_000, endedAt: 9_100 },
          { name: "bash", toolCallId: "b", startedAt: 9_900, argsPreview: "npm test" },
        ],
      }),
    });
    const lines = buildFleetWidgetLines(buildFleetViewModel([busy], OPTS), {
      color: (tone, text) => `[${tone}]${text}`,
    })!;
    // ╰ hook under the task name; green ✓ / muted name-and-count per the
    // collapsed-tally reference style, ▸ in-flight stays accent
    expect(lines[2]).toBe("  ╰ [success]✓[muted] read[muted] | [header]▸bash npm test · 100ms");
    expect(lines[1]).not.toContain("[muted]aaaa"); // main row label stays un-muted (bright anchor)
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
    const a = snapshot({
      runId: "a-0000000",
      diag: diag({ createdAt: 9_000, lastEventAt: 9_900, usage: usage(0.002) }),
    });
    const b = snapshot({
      runId: "b-0000000",
      diag: diag({ createdAt: 9_000, lastEventAt: 9_900, usage: usage(0.001) }),
    });
    expect(buildFleetWidgetLines(buildFleetViewModel([a, b], OPTS))![0]).toBe("● 2 active Agents · $0.0030");
    const free = snapshot({ diag: diag({ createdAt: 9_000, lastEventAt: 9_900 }) });
    expect(buildFleetWidgetLines(buildFleetViewModel([free], OPTS))![0]).toBe("● 1 active Agents");
  });

  it("truncation: default 6 rows + header, overflow reported on the header as +N more", () => {
    const runs = Array.from({ length: 7 }, (_, i) =>
      snapshot({ runId: `run-${i}00000`, diag: diag({ createdAt: i, lastEventAt: 9_900 }) }),
    );
    const model = buildFleetViewModel(runs, OPTS);
    const lines = buildFleetWidgetLines(model)!; // default maxRows = 6
    expect(lines).toHaveLength(7);
    expect(lines[0]).toContain("7 active Agents");
    expect(lines[0]).toContain("+1 more");
  });

  it("overflow boundary: exactly maxRows runs → no '+more'; maxRows 1 → header + 1 row", () => {
    const two = [0, 1].map((i) =>
      snapshot({ runId: `r${i}0000000`, diag: diag({ createdAt: i, lastEventAt: 9_900 }) }),
    );
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

  it("pending terminal notifications stay beyond old linger and show a folded prompt", () => {
    const done = snapshot({
      status: "completed",
      phase: "settled",
      updatedAt: 0,
      diag: diag({ taskPrompt: "do\n  this   carefully" }),
    });
    const model = buildFleetViewModel([done], { ...OPTS, recentTerminal: 1 });
    const lines = buildFleetWidgetLines(model, {
      terminalLingerMs: 5_000,
      awaitNotificationMs: 600_000,
      receiptOf: () => ({ kind: "pending", at: 0 }),
    });
    expect(lines?.join("\n")).toContain("· 待处理");
    expect(lines?.join("\n")).toContain("╰ » do this carefully");
  });

  it("pending terminal notifications disappear after the await hard bound", () => {
    const done = snapshot({ status: "completed", phase: "settled", updatedAt: 0 });
    const model = buildFleetViewModel([done], { ...OPTS, recentTerminal: 1 });
    expect(
      buildFleetWidgetLines(model, {
        awaitNotificationMs: 1_000,
        receiptOf: () => ({ kind: "pending", at: 0 }),
      }),
    ).toBeUndefined();
  });

  it("entered receipts linger from enteredAt, not from settle time", () => {
    const done = snapshot({ status: "completed", phase: "settled", updatedAt: 0 }); // settled 10s ago
    const model = buildFleetViewModel([done], { ...OPTS, recentTerminal: 1 });
    // Entered 1s ago → visible even though settledAgoMs (10s) is way past lingerMs.
    const recent = buildFleetWidgetLines(model, {
      terminalLingerMs: 5_000,
      receiptOf: () => ({ kind: "entered", at: NOW - 1_000 }),
    });
    expect(recent?.join("\n")).toContain("completed");
    expect(recent?.join("\n")).not.toContain("待处理");
    // Entered 9s ago → past linger from enteredAt → gone.
    expect(
      buildFleetWidgetLines(model, {
        terminalLingerMs: 5_000,
        receiptOf: () => ({ kind: "entered", at: NOW - 9_000 }),
      }),
    ).toBeUndefined();
  });

  it("undeliverable receipts fall back to the old settledAgoMs linger semantics", () => {
    const fresh = snapshot({ status: "failed", phase: "settled", updatedAt: NOW - 100 });
    const old = snapshot({ runId: "old-00000", status: "failed", phase: "settled", updatedAt: NOW - 9_000 });
    const receiptOf = () => ({ kind: "undeliverable" as const });
    const shown = buildFleetWidgetLines(buildFleetViewModel([fresh], { ...OPTS, recentTerminal: 1 }), {
      terminalLingerMs: 5_000,
      receiptOf,
    });
    expect(shown?.join("\n")).toContain("failed");
    expect(
      buildFleetWidgetLines(buildFleetViewModel([old], { ...OPTS, recentTerminal: 1 }), {
        terminalLingerMs: 5_000,
        receiptOf,
      }),
    ).toBeUndefined();
  });

  it("awaiting rows win budget over lingering rows; hidden awaiting still counted in header", () => {
    const active = snapshot({ runId: "live-0000", diag: diag({ lastEventAt: 9_900 }) });
    const awaiting = snapshot({ runId: "wait-0000", status: "completed", phase: "settled", updatedAt: 9_000 });
    const lingering = snapshot({
      runId: "ling-0000",
      status: "completed",
      phase: "settled",
      updatedAt: 9_999,
      diag: diag({ label: "旧完成" }),
    });
    const model = buildFleetViewModel([active, awaiting, lingering], { ...OPTS, recentTerminal: 3 });
    const lines = buildFleetWidgetLines(model, {
      maxRows: 2,
      receiptOf: (runId) => (runId === "wait-0000" ? { kind: "pending", at: 9_000 } : { kind: "untracked" }),
    })!;
    expect(lines.join("\n")).toContain("· 待处理");
    expect(lines.join("\n")).not.toContain("旧完成"); // lingering starved by budget
    expect(lines[0]).toContain("1 待处理");
  });

  it("header +N more counts awaiting rows hidden by the budget (no double-count)", () => {
    const runs = [
      ...[0, 1].map((i) => snapshot({ runId: `live-${i}000`, diag: diag({ createdAt: i, lastEventAt: 9_900 }) })),
      ...[0, 1].map((i) =>
        snapshot({ runId: `wait-${i}000`, status: "completed" as const, phase: "settled" as const, updatedAt: 9_000 }),
      ),
    ];
    const model = buildFleetViewModel(runs, { ...OPTS, recentTerminal: 3 });
    const lines = buildFleetWidgetLines(model, {
      maxRows: 3,
      receiptOf: (runId) =>
        runId.startsWith("wait-") ? { kind: "pending" as const, at: 9_000 } : { kind: "untracked" as const },
    })!;
    expect(lines[0]).toContain("2 待处理"); // total awaiting, shown or not
    expect(lines[0]).toContain("+1 more"); // 1 awaiting main hidden behind the budget
    expect(lines.filter((l) => l.includes("· 待处理"))).toHaveLength(1);
  });

  it("preview lines never render without their awaiting main row", () => {
    const actives = Array.from({ length: 6 }, (_, i) =>
      snapshot({ runId: `live-${i}000`, diag: diag({ createdAt: i, lastEventAt: 9_900 }) }),
    );
    const awaiting = snapshot({
      runId: "wait-0000",
      status: "completed",
      phase: "settled",
      updatedAt: 9_000,
      diag: diag({ taskPrompt: "some task prompt" }),
    });
    const model = buildFleetViewModel([...actives, awaiting], { ...OPTS, recentTerminal: 3 });
    const lines = buildFleetWidgetLines(model, {
      maxRows: 6,
      receiptOf: (runId) =>
        runId === "wait-0000" ? { kind: "pending" as const, at: 9_000 } : { kind: "untracked" as const },
    })!;
    expect(lines.join("\n")).not.toContain("· 待处理"); // main row hidden by budget
    expect(lines.join("\n")).not.toContain("╰ »"); // preview must not orphan
    expect(lines[0]).toContain("1 待处理");
    expect(lines[0]).toContain("+1 more");
  });

  it("elastic expansion wraps the newest awaiting preview to at most 4 lines", () => {
    const long = "word ".repeat(80).trim(); // wraps to many lines at width 40
    const awaiting = snapshot({
      runId: "wait-0000",
      status: "completed",
      phase: "settled",
      updatedAt: 9_000,
      diag: diag({ taskPrompt: long }),
    });
    const model = buildFleetViewModel([awaiting], { ...OPTS, recentTerminal: 1 });
    const lines = buildFleetWidgetLines(model, {
      width: 40,
      receiptOf: () => ({ kind: "pending" as const, at: 9_000 }),
    })!;
    expect(lines.filter((l) => l.includes("╰ »"))).toHaveLength(4); // capped, not 1 and not 5+
  });

  it("M6: just-finished runs linger dimmed (✓/✗) within terminalLingerMs, then vanish", () => {
    const active = snapshot({ runId: "live-0000", diag: diag({ lastEventAt: 9_900 }) });
    const done = snapshot({
      runId: "done-0000",
      status: "completed",
      phase: "settled",
      updatedAt: 9_999,
      diag: diag({ usage: usage(0.11), label: "刚完成" }),
    });
    const failed = snapshot({ runId: "fail-0000", status: "failed", phase: "settled", updatedAt: 9_998 });
    const old = snapshot({ runId: "old-00000", status: "completed", phase: "settled", updatedAt: 1_000 }); // 9s ago
    const model = buildFleetViewModel([active, done, failed, old], { ...OPTS, recentTerminal: 3 });
    const lines = buildFleetWidgetLines(model)!;
    expect(lines[0]).toContain("1 active Agents");
    expect(lines[1]).toContain("live-000");
    expect(
      lines.some(
        (l) => l.startsWith("✓ 刚完成 ") && !l.includes("#done-000") && l.includes("completed") && l.includes("$0.11"),
      ),
    ).toBe(true);
    expect(lines.some((l) => l.startsWith("✗ fail-000") && l.includes("failed"))).toBe(true);
    expect(lines.join("\n")).not.toContain("old-0000"); // 9s ago → expired
    // all-terminal fleet: still shown while lingering, hidden once expired
    const onlyDone = buildFleetViewModel([done], { ...OPTS, recentTerminal: 3 });
    expect(buildFleetWidgetLines(onlyDone)![0]).toContain("0 active Agents");
    expect(buildFleetWidgetLines(onlyDone, { terminalLingerMs: 0 })).toBeUndefined();
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

describe("view-model: background bash rows", () => {
  const bash = (overrides: Record<string, unknown> = {}) => ({
    jobId: "b_TEST0001",
    commandPreview: "npm run build",
    status: "running" as const,
    highlight: "none" as const,
    elapsedMs: 12_000,
    logBytes: 45 * 1024,
    ...overrides,
  });

  it("formats sizes, statuses, and the final meaningful folded tail line", () => {
    expect(formatLogSize(0)).toBe("0B");
    expect(formatLogSize(1023)).toBe("1023B");
    expect(formatLogSize(1024)).toBe("1.0KB");
    expect(formatLogSize(1.5 * 1024 * 1024)).toBe("1.5MB");
    expect(bashJobHighlight("running")).toBe("none");
    expect(bashJobHighlight("completed")).toBe("none");
    expect(bashJobHighlight("failed")).toBe("crit");
    expect(bashJobHighlight("timed_out")).toBe("crit");
    expect(bashJobHighlight("killed")).toBe("warn");
    expect(bashJobHighlight("exited_unknown")).toBe("warn");
    expect(bashJobHighlight("orphaned")).toBe("warn");
    expect(tailLine("first\n  last  line \n\n")).toBe("last line");
    expect(tailLine(" \n\t")).toBeUndefined();
    expect(tailLine("输出\n完成")).toBe("完成");
  });

  it("renders running bash main/activity rows and bash-only visibility", () => {
    const model = buildFleetViewModel([], OPTS);
    const lines = buildFleetWidgetLines(model, { bashJobs: [bash({ logTail: "added 42 files" })] })!;
    expect(lines).toEqual(["● 1 background bash", "  $ npm run build · running · 12s · 45KB", "  ╰ » added 42 files"]);
  });

  it("shares the main-row pool and counts hidden run/bash identities precisely", () => {
    const runs = Array.from({ length: 3 }, (_, i) => snapshot({ runId: `run-${i}00000` }));
    const lines = buildFleetWidgetLines(buildFleetViewModel(runs, OPTS), {
      maxRows: 4,
      bashJobs: [bash({ jobId: "b_1" }), bash({ jobId: "b_2" })],
    })!;
    expect(lines.filter((line) => line.includes("$ npm run build"))).toHaveLength(1);
    expect(lines[0]).toContain("3 active Agents · 2 bash · +1 more");
  });

  it("uses independent bash terminal markers and expires terminal rows", () => {
    const rows = [
      bash({ status: "completed", highlight: "none", settledAgoMs: 1000 }),
      bash({ jobId: "b_2", status: "failed", highlight: "crit", settledAgoMs: 1000 }),
      bash({ jobId: "b_3", status: "killed", highlight: "warn", settledAgoMs: 1000 }),
    ];
    const lines = buildFleetWidgetLines(buildFleetViewModel([], OPTS), { bashJobs: rows });
    expect(lines).toEqual([
      "● 0 active Agents",
      "✓ $ npm run build · completed · 12s · 45KB",
      "✗ $ npm run build · failed · 12s · 45KB",
      "! $ npm run build · killed · 12s · 45KB",
    ]);
    expect(
      buildFleetWidgetLines(buildFleetViewModel([], OPTS), {
        terminalLingerMs: 5000,
        bashJobs: [bash({ settledAgoMs: 5001, status: "completed" })],
      }),
    ).toBeUndefined();
  });

  it("keeps linger rows inside the shared maxRows budget", () => {
    const active = Array.from({ length: 4 }, (_, i) => snapshot({ runId: `active-${i}0000` }));
    const terminalRuns = Array.from({ length: 2 }, (_, i) =>
      snapshot({ runId: `done-${i}00000`, status: "failed", phase: "settled", updatedAt: NOW - 1000 }),
    );
    const terminalBash = [
      bash({ jobId: "b_done1", status: "failed", highlight: "crit", settledAgoMs: 1000, logTail: "tail" }),
      bash({ jobId: "b_done2", status: "failed", highlight: "crit", settledAgoMs: 1000, logTail: "tail" }),
    ];
    const lines = buildFleetWidgetLines(
      buildFleetViewModel([...active, ...terminalRuns], { ...OPTS, recentTerminal: 3 }),
      {
        maxRows: 6,
        bashJobs: terminalBash,
      },
    )!;
    expect(lines.length).toBeLessThanOrEqual(7);
  });

  it("reports overflow in the bash-only fallback header", () => {
    const lines = buildFleetWidgetLines(buildFleetViewModel([], OPTS), {
      maxRows: 6,
      bashJobs: Array.from({ length: 8 }, (_, i) => bash({ jobId: `b_${i}` })),
    })!;
    expect(lines[0]).toContain("8 background bash");
    expect(lines[0]).toContain("+2 more");
  });

  it("keeps the no-run/no-bash regression hidden", () => {
    expect(buildFleetWidgetLines(buildFleetViewModel([], OPTS))).toBeUndefined();
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
      stop: async () => ({ ok: false as const, reason: "stop_failed" as const, escalatedTo: "L4" as const }),
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
    expect(ui.calls[0]!.content).toEqual(["● 1 active Agents", "  live-000 · 🤔 1s Σ1s"]);
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
    expect(ui.calls[ui.calls.length - 1]!.content).toEqual(["● 1 active Agents", "  live-000 · 🤔 1s Σ1s"]);

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

  // The tick is a self-rescheduling one-shot, so a throw that skips the
  // re-arm is not a dropped frame but a permanently frozen agent tree; and the
  // constructor's initial refresh() runs inside buildSessionStack, so a throw
  // there takes the whole extension down with the session_start handler. (The
  // onLifecycle path below is defense in depth only — mergeExtensionPoints
  // already catches throws on the H1 fan-out.)
  it("a throwing view-model source drops the frame, warns once, and keeps the tick alive (recovers next frame)", () => {
    const clock = new FakeClock(NOW);
    const ui = fakeUi();
    const query = fakeQuery([snapshot({ runId: "live-0000", diag: diag({ createdAt: 9_000, lastEventAt: 9_900 }) })]);
    const healthy = query.list;
    let boom = true;
    query.list = () => {
      if (boom) throw new Error("registry exploded");
      return healthy();
    };
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      const widget = new FleetWidgetController({ ui, query, clock });
      expect(ui.calls).toHaveLength(0); // initial frame dropped, nothing pushed
      expect(clock.pendingTimers).toBe(1); // ...but the tick is armed anyway

      clock.advance(3_000); // three more failing frames
      expect(ui.calls).toHaveLength(0);
      expect(clock.pendingTimers).toBe(1); // clock never stopped
      expect(warn).toHaveBeenCalledTimes(1); // warn-once, not once per tick

      boom = false;
      clock.advance(1_000);
      const last = ui.calls[ui.calls.length - 1]!;
      expect(last.key).toBe(FLEET_WIDGET_KEY);
      expect(last.content![0]).toContain("1 active Agents"); // recovered on its own
      widget.dispose();
    } finally {
      warn.mockRestore();
    }
  });

  it("construction survives a throwing view model (a throw would escape buildSessionStack → session_start)", () => {
    const clock = new FakeClock(NOW);
    const ui = fakeUi();
    const query = fakeQuery([snapshot({ runId: "live-0000" })]);
    query.list = () => {
      throw new Error("registry exploded");
    };
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      let widget: FleetWidgetController | undefined;
      expect(() => {
        widget = new FleetWidgetController({ ui, query, clock });
      }).not.toThrow();
      expect(clock.pendingTimers).toBe(1); // still armed, so it can recover later
      widget!.dispose();
    } finally {
      warn.mockRestore();
    }
  });

  it("onLifecycle never propagates a refresh failure (warn-once shared with the tick path)", () => {
    const clock = new FakeClock(NOW);
    const ui = fakeUi();
    const query = fakeQuery([snapshot({ runId: "live-0000" })]);
    query.list = () => {
      throw new Error("registry exploded");
    };
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      const widget = new FleetWidgetController({ ui, query, clock });
      expect(() => widget.lifecycle.onLifecycle!(lifecycleEvent("live-0000"))).not.toThrow();
      expect(() => widget.refresh()).not.toThrow();
      expect(() => clock.advance(2_000)).not.toThrow();
      expect(warn).toHaveBeenCalledTimes(1);
      expect(clock.pendingTimers).toBe(1);
      widget.dispose();
      expect(clock.pendingTimers).toBe(0);
    } finally {
      warn.mockRestore();
    }
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

describe("M9: workflow group headers in the tree", () => {
  it("children with parentRunId === workflowId are grouped under a ⚙ header; others stay in the general tree", () => {
    const wfChild1 = snapshot({
      runId: "child-a00",
      parentRunId: "wf-1",
      diag: diag({ createdAt: 8_000, lastEventAt: 9_900, label: "评审A" }),
    });
    const wfChild2 = snapshot({
      runId: "child-b00",
      parentRunId: "wf-1",
      diag: diag({ createdAt: 8_500, lastEventAt: 9_900, label: "评审B" }),
    });
    const loner = snapshot({ runId: "loner-000", diag: diag({ createdAt: 7_000, lastEventAt: 9_900 }) });
    const model = buildFleetViewModel([wfChild1, wfChild2, loner], OPTS);
    const lines = buildFleetWidgetLines(model, {
      workflows: [{ workflowId: "wf-1", name: "plan-review", phase: "review", elapsedMs: 121_000 }],
    })!;
    expect(lines[0]).toContain("3 active Agents");
    expect(lines[1]).toBe("⚙ plan-review · review · 2m01s");
    expect(lines[2]).toContain("↳ 评审A");
    expect(lines[3]).toContain("↳ 评审B");
    expect(lines[4]).toContain("loner-00");
    expect(lines[4]).not.toContain("↳");
  });

  it("a workflow with no visible children still shows its header; widget visible even with 0 active runs", () => {
    const model = buildFleetViewModel([], OPTS);
    const lines = buildFleetWidgetLines(model, {
      workflows: [{ workflowId: "wf-2", name: "nightly", elapsedMs: 5_000 }],
    })!;
    expect(lines[0]).toContain("0 active Agents");
    expect(lines[1]).toBe("⚙ nightly · - · 5s");
  });

  it("without workflows opt, workflow-orphaned children keep the plain ↳ top-level rendering", () => {
    const child = snapshot({
      runId: "child-a00",
      parentRunId: "wf-1",
      diag: diag({ createdAt: 8_000, lastEventAt: 9_900 }),
    });
    const lines = buildFleetWidgetLines(buildFleetViewModel([child], OPTS))!;
    expect(lines[1]).toContain("↳ child-a0");
  });
});
