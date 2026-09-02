import { describe, expect, it } from "vitest";
import { createStatusCommand, renderStatus } from "../../src/commands/status.js";
import { DEFAULT_BUDGET } from "../../src/core/deadline.js";
import { DEFAULT_SETTINGS } from "../../src/config/settings.js";
import type { RunSnapshot } from "../../src/core/types.js";

function snapshot(overrides: Partial<RunSnapshot> = {}): RunSnapshot {
  return {
    runId: "r1",
    generation: 1,
    status: "completed",
    phase: "settled",
    deadlines: { enqueuedAt: 0, deadlineAt: undefined, queueDeadlineAt: undefined },
    diag: {
      createdAt: 0,
      phase: "settled",
      phaseEnteredAt: 0,
      pendingTools: 0,
      turns: 1,
      escalation: [],
      orphaned: false,
      generation: 1,
      degraded: [],
      staleInputs: 0,
      unkillable: [],
    },
    updatedAt: 0,
    ...overrides,
  };
}
function deps(runs: RunSnapshot[]) {
  return {
    query: {
      list: () => runs,
      get: () => undefined,
      wait: async () => ({ ok: false as const, reason: "unknown_run" as const }),
      waitAll: async () => ({ settled: [], pending: [] }),
      steer: async () => undefined,
      stop: async () => false,
    },
    orphans: {
      register: () => undefined,
      recordLateRecovered: () => undefined,
      recent: [],
      totalCount: 0,
      lateRecoveredCount: 0,
      countInWindow: () => 0,
      byReason: new Map(),
      resetCircuit: () => undefined,
    },
    notifier: {
      enqueue: () => undefined,
      consume: () => false,
      reconcile: () => ({ redelivered: [], suppressed: [], abandoned: [] }),
      verifyPersisted: () => ({ missing: [] }),
      stats: { pending: 0, delivered: 0, consumed: 0, dropped: 0, abandoned: 0 },
      degraded: [],
    },
  };
}

describe("X9 status usage rendering", () => {
  it("shows per-run usage for active runs", () => {
    const active = snapshot({
      status: "running",
      phase: "model_turn",
      diag: {
        ...snapshot().diag,
        phase: "model_turn",
        usage: { input: 100, output: 50, cacheRead: 10, cacheWrite: 0, costUsd: 0.0123 },
      },
    });
    const text = renderStatus(deps([active]) as never);
    expect(text).toContain("usage=in:100 out:50 cache_r:10 cache_w:0 cost:$0.0123");
  });

  it("shows an aggregate usage line summed across all runs when at least one has usage", () => {
    const a = snapshot({
      runId: "a",
      diag: { ...snapshot().diag, usage: { input: 10, output: 5, cacheRead: 0, cacheWrite: 0, costUsd: 0.01 } },
    });
    const b = snapshot({
      runId: "b",
      diag: { ...snapshot().diag, usage: { input: 20, output: 15, cacheRead: 1, cacheWrite: 0, costUsd: 0.02 } },
    });
    const text = renderStatus(deps([a, b]) as never);
    expect(text).toContain("Usage (all runs): usage=in:30 out:20 cache_r:1 cache_w:0 cost:$0.0300");
  });

  it("omits the aggregate usage line entirely when no run has usage data", () => {
    const text = renderStatus(deps([snapshot()]) as never);
    expect(text).not.toContain("Usage (all runs)");
  });
});

describe("M3.6 /agent status workflow section", () => {
  it("shows nothing extra when no workflow dep is supplied (default, workflow.enabled=false)", () => {
    const text = renderStatus(deps([snapshot()]) as never);
    expect(text).not.toContain("Workflows:");
  });

  it("shows an active workflow row with name, phase and elapsed time when a workflow dep is supplied", () => {
    const d = deps([snapshot()]) as Record<string, unknown>;
    d.workflow = {
      activity: {
        list: () => [
          { workflowId: "wf_x", name: "refactor-api", startedAt: 0, deadlineAt: 60_000, currentPhaseId: "implement" },
        ],
      },
      now: () => 10_000,
    };
    const text = renderStatus(d as never);
    expect(text).toContain("Workflows: 1 active");
    expect(text).toContain("wf_x");
    expect(text).toContain("name=refactor-api");
    expect(text).toContain("phase=implement");
    expect(text).toContain("elapsed_ms=10000");
    expect(text).toContain("deadline_remaining_ms=50000");
  });

  it("shows zero active workflows honestly (not omitted) when the dep is supplied but nothing is running", () => {
    const d = deps([snapshot()]) as Record<string, unknown>;
    d.workflow = { activity: { list: () => [] }, now: () => 0 };
    const text = renderStatus(d as never);
    expect(text).toContain("Workflows: 0 active");
  });
});

describe("M-C4 renderRunDetail (tool timeline)", () => {
  const detailed = (): RunSnapshot =>
    snapshot({
      runId: "223b8f1e-aaaa-bbbb-cccc-000000000000",
      status: "running",
      phase: "tool_exec",
      diag: {
        ...snapshot().diag,
        createdAt: 1_000,
        phase: "tool_exec",
        turns: 2,
        label: "重构用户模块",
        agentType: "architect",
        model: { provider: "p", id: "kimi-k3" },
        usage: { input: 10, output: 5, cacheRead: 0, cacheWrite: 0, costUsd: 0.05 },
        toolHistory: [
          { name: "bash", toolCallId: "a", startedAt: 2_200, endedAt: 3_400, isError: false, argsPreview: "ls -la" },
          { name: "bash", toolCallId: "b", startedAt: 5_000, endedAt: 13_100, isError: true, argsPreview: "npm test" },
          { name: "edit", toolCallId: "c", startedAt: 14_000, argsPreview: "src/x.ts" },
        ],
        toolCounts: { bash: 2, edit: 1 },
      },
    });

  it("renders header, timeline with offsets/marks/durations, tool counts and usage", async () => {
    const { renderRunDetail } = await import("../../src/commands/status.js");
    const text = renderRunDetail(deps([detailed()]).query as never, "223b8f1e");
    expect(text).toContain("Run 223b8f1e (重构用户模块) · architect · p/kimi-k3 · running/tool_exec");
    expect(text).toContain("2 turns");
    expect(text).toContain("✓ bash");
    expect(text).toContain("ls -la");
    expect(text).toContain("1s"); // 1.2s call rendered as 1s
    expect(text).toContain("✗ bash");
    expect(text).toContain("▸ edit");
    expect(text).toContain("running…");
    expect(text).toContain("Tools: bash×2 edit");
    expect(text).toContain("cost:$0.0500");
  });

  it("matches by unique prefix or exact label; reports unknown and ambiguous args", async () => {
    const { renderRunDetail } = await import("../../src/commands/status.js");
    const a = detailed();
    const q = deps([a]).query as never;
    expect(renderRunDetail(q, "重构用户模块")).toContain("Run 223b8f1e");
    expect(renderRunDetail(q, "nope")).toContain("No run matches");
    const twin = detailed();
    twin.runId = "223b8f1e-aaaa-bbbb-cccc-111111111111";
    const q2 = deps([a, twin]).query as never;
    expect(renderRunDetail(q2, "223b8f1e")).toContain("Ambiguous");
  });

  it("shows the error and timeout reason for failed runs", async () => {
    const { renderRunDetail } = await import("../../src/commands/status.js");
    const failed = detailed();
    failed.status = "failed";
    failed.diag.error = { kind: "model", message: "reasoning_effort medium not supported", retryable: false };
    failed.diag.timeoutReason = undefined as never;
    const text = renderRunDetail(deps([failed]).query as never, "223b8f1e");
    expect(text).toContain("Error: [model] reasoning_effort medium not supported");
  });
});

describe("M7 renderCosts", () => {
  it("lists runs cost-descending with status marks and a grand total", async () => {
    const { renderCosts } = await import("../../src/commands/status.js");
    const cheap = snapshot({
      runId: "cheap-000",
      diag: {
        ...snapshot().diag,
        label: "便宜任务",
        settledAt: 10_000,
        usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, costUsd: 0.01 },
      },
    });
    const pricey = snapshot({
      runId: "pricey-00",
      status: "running",
      phase: "model_turn",
      diag: {
        ...snapshot().diag,
        label: "贵任务",
        agentType: "architect",
        model: { provider: "p", id: "opus-5" },
        usage: { input: 9, output: 9, cacheRead: 0, cacheWrite: 0, costUsd: 1.5 },
      },
    });
    const text = renderCosts({ ...({} as object), list: () => [cheap, pricey] } as never);
    const lines = text.split("\n");
    expect(lines[0]).toContain("2 run(s)");
    expect(lines[1]).toContain("$1.5000");
    expect(lines[1]).toContain("▸ pricey-0");
    expect(lines[1]).toContain("opus-5");
    expect(lines[1]).toContain("running");
    expect(lines[2]).toContain("$0.0100");
    expect(lines[2]).toContain("✓ cheap-00");
    expect(text).toContain("Total: $1.5100");
  });
  it("handles an empty session", async () => {
    const { renderCosts } = await import("../../src/commands/status.js");
    expect(renderCosts({ list: () => [] } as never)).toContain("No subagent runs");
  });
});

describe("/agent settings subcommand", () => {
  function settingsDeps() {
    const persisted: Array<[string, unknown]> = [];
    const current = JSON.parse(JSON.stringify(DEFAULT_SETTINGS));
    const d = {
      ...deps([]),
      settings: {
        current,
        persist: (key: string, value: unknown) => {
          persisted.push([key, value]);
          return undefined;
        },
        path: "/tmp/test-pi-subagent.json",
      },
    };
    return { d, persisted, current };
  }
  function run(d: unknown, args: string): string {
    const cmd = createStatusCommand(d as never);
    let seen = "";
    void cmd.handler(args, { ui: { notify: (m: string) => (seen = m) } } as never);
    return seen;
  }

  it("lists all settings and marks overrides", () => {
    const { d, current } = settingsDeps();
    current.budget.idleMs = 600000;
    const out = run(d, "settings");
    expect(out).toContain("budget.idleMs");
    expect(out).toContain("600000 (default 240000)");
    expect(out).toContain("concurrencyLimit");
    expect(out).toContain("worktree.enabled");
    expect(out).toContain("workflow.runawayPolicy");
  });

  it("budget.* set mutates live settings, persists, and reports immediate effect", () => {
    const { d, persisted, current } = settingsDeps();
    const out = run(d, "settings set budget.idleMs 600000");
    expect(current.budget.idleMs).toBe(600000);
    expect(persisted).toEqual([["budget.idleMs", 600000]]);
    expect(out).toContain("240000 → 600000");
    expect(out).toContain("applies to new runs immediately");
  });

  it("non-budget set persists but reports /reload", () => {
    const { d, persisted, current } = settingsDeps();
    const out = run(d, "settings set fleetWidget false");
    expect(current.fleetWidget).toBe(false);
    expect(persisted).toEqual([["fleetWidget", false]]);
    expect(out).toContain("takes effect after /reload");
  });

  it("supports nested booleans, enums, and strings", () => {
    const { d, current } = settingsDeps();
    run(d, "settings set worktree.enabled on");
    expect(current.worktree.enabled).toBe(true);
    run(d, "settings set workflow.replayScope content");
    expect(current.workflow.replayScope).toBe("content");
    expect(run(d, "settings set workflow.replayScope bogus")).toContain("expected one of: chain, content");
    run(d, "settings set workflow.journalDir /tmp/journal");
    expect(current.workflow.journalDir).toBe("/tmp/journal");
  });

  it("reset restores the default and removes the override", () => {
    const { d, persisted, current } = settingsDeps();
    current.budget.idleMs = 600000;
    const out = run(d, "settings reset budget.idleMs");
    expect(current.budget.idleMs).toBe(DEFAULT_BUDGET.idleMs);
    expect(persisted).toEqual([["budget.idleMs", undefined]]);
    expect(out).toContain("reset to default");
  });

  it("rejects unknown keys and bad values without touching state", () => {
    const { d, persisted, current } = settingsDeps();
    expect(run(d, "settings set nope 1")).toContain("Unknown settings key");
    expect(run(d, "settings set budget.idleMs -5")).toContain("Invalid value");
    expect(run(d, "settings set budget.startupRetries 1.5")).toContain("Invalid value");
    expect(run(d, "settings set fleetWidget maybe")).toContain("expected true/false");
    expect(run(d, "settings frobnicate")).toContain("Unknown settings action");
    expect(persisted).toEqual([]);
    expect(current.budget.idleMs).toBe(DEFAULT_BUDGET.idleMs);
  });

  it("reports persist failures but keeps the in-memory change", () => {
    const { d, current } = settingsDeps();
    d.settings.persist = () => "disk full";
    const out = run(d, "settings set budget.idleMs 1");
    expect(current.budget.idleMs).toBe(1);
    expect(out).toContain("Persist failed: disk full");
  });

  it("/agent budget alias scopes keys to budget.*", () => {
    const { d, persisted, current } = settingsDeps();
    const out = run(d, "budget set idleMs 600000");
    expect(current.budget.idleMs).toBe(600000);
    expect(persisted).toEqual([["budget.idleMs", 600000]]);
    expect(out).toContain("applies to new runs immediately");
    // alias 下非 budget key 被拒绝
    expect(run(d, "budget set fleetWidget false")).toContain("Unknown budget key");
    // 列出时只显示 budget 行
    const list = run(d, "budget");
    expect(list).toContain("budget.idleMs");
    expect(list).not.toContain("fleetWidget");
  });
});
