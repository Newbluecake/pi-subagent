import { describe, expect, it } from "vitest";
import { createStatusCommand, renderStatus } from "../../src/commands/status.js";
import { DEFAULT_BUDGET } from "../../src/core/deadline.js";
import { DEFAULT_SETTINGS } from "../../src/config/settings.js";
import type { RunSnapshot } from "../../src/core/types.js";
import type { JobRecord } from "../../src/bash/types.js";

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
    void cmd.handler(args, { mode: "print", ui: { notify: (m: string) => (seen = m) } } as never);
    return seen;
  }

  it("lists all settings in seconds and marks overrides", () => {
    const { d, current } = settingsDeps();
    current.budget.idleMs = 600_000;
    const out = run(d, "settings");
    expect(out).toContain("budget.idleS");
    expect(out).not.toContain("budget.idleMs");
    expect(out).toContain("600 (default 240)");
    expect(out).toContain("concurrencyLimit");
    expect(out).toContain("worktree.enabled");
    expect(out).toContain("workflow.runawayPolicy");
    // workflow.budget.* is now editable and shows its effective default
    expect(out).toContain("workflow.budget.gateS");
    expect(out).toContain("Durations are seconds");
  });

  it("18: exposes both coalescing settings through the whitelist and validates values", () => {
    const { d, current } = settingsDeps();
    const listing = run(d, "settings");
    expect(listing).toContain("coalesceWindowS");
    expect(listing).toContain("coalesceMaxBatch");
    expect(listing).toContain("ackWindowS");
    expect(run(d, "settings set coalesceWindowS 2")).toContain("coalesceWindowS");
    expect(current.coalesceWindowMs).toBe(2_000);
    // the 5000ms ceiling is a 5-second ceiling in the input domain
    expect(run(d, "settings set coalesceWindowS 6")).toContain("between 0 and 5 seconds");
    expect(current.coalesceWindowMs).toBe(2_000);
    expect(run(d, "settings set coalesceMaxBatch 0")).toContain("Invalid value");
    expect(current.coalesceMaxBatch).toBe(DEFAULT_SETTINGS.coalesceMaxBatch);
  });

  it("budget.* set takes seconds, mutates live ms settings, persists seconds, and reports immediate effect", () => {
    const { d, persisted, current } = settingsDeps();
    const out = run(d, "settings set budget.idleS 600");
    expect(current.budget.idleMs).toBe(600_000);
    expect(persisted).toEqual([["budget.idleS", 600]]);
    expect(out).toContain("240 → 600");
    expect(out).toContain("applies to new runs immediately");
  });

  it("rejects fractional seconds for duration keys", () => {
    const { d, persisted, current } = settingsDeps();
    expect(run(d, "settings set budget.idleS 1.5")).toContain("expected an integer >= 0 seconds");
    expect(current.budget.idleMs).toBe(DEFAULT_BUDGET.idleMs);
    expect(persisted).toEqual([]);
  });

  it("non-budget set persists but reports /reload", () => {
    const { d, persisted, current } = settingsDeps();
    const out = run(d, "settings set fleetWidget false");
    expect(current.fleetWidget).toBe(false);
    expect(persisted).toEqual([["fleetWidget", false]]);
    expect(out).toContain("takes effect after /reload");
  });

  it("supports nested booleans, enums, strings, and nested workflow budgets", () => {
    const { d, persisted, current } = settingsDeps();
    run(d, "settings set worktree.enabled on");
    expect(current.worktree.enabled).toBe(true);
    run(d, "settings set worktree.gitTimeoutS 45");
    expect(current.worktree.gitTimeoutMs).toBe(45_000);
    run(d, "settings set workflow.replayScope content");
    expect(current.workflow.replayScope).toBe("content");
    expect(run(d, "settings set workflow.replayScope bogus")).toContain("expected one of: chain, content");
    run(d, "settings set workflow.journalDir /tmp/journal");
    expect(current.workflow.journalDir).toBe("/tmp/journal");
    run(d, "settings set workflow.budget.gateS 120");
    expect(current.workflow.budget.gateMs).toBe(120_000);
    expect(persisted).toContainEqual(["workflow.budget.gateS", 120]);
  });

  it("reset restores the default and removes the override", () => {
    const { d, persisted, current } = settingsDeps();
    current.budget.idleMs = 600_000;
    const out = run(d, "settings reset budget.idleS");
    expect(current.budget.idleMs).toBe(DEFAULT_BUDGET.idleMs);
    expect(persisted).toEqual([["budget.idleS", undefined]]);
    expect(out).toContain("reset to default 240");
  });

  it("rejects unknown keys and bad values without touching state", () => {
    const { d, persisted, current } = settingsDeps();
    expect(run(d, "settings set nope 1")).toContain("Unknown settings key");
    // the old millisecond key names are gone from the CLI surface
    expect(run(d, "settings set budget.idleMs 600000")).toContain("Unknown settings key");
    expect(run(d, "settings set budget.idleS -5")).toContain("Invalid value");
    expect(run(d, "settings set budget.startupRetries 1.5")).toContain("Invalid value");
    expect(run(d, "settings set fleetWidget maybe")).toContain("expected true/false");
    expect(run(d, "settings frobnicate")).toContain("Unknown settings action");
    expect(persisted).toEqual([]);
    expect(current.budget.idleMs).toBe(DEFAULT_BUDGET.idleMs);
  });

  it("reports persist failures but keeps the in-memory change", () => {
    const { d, current } = settingsDeps();
    d.settings.persist = () => "disk full";
    const out = run(d, "settings set budget.idleS 1");
    expect(current.budget.idleMs).toBe(1_000);
    expect(out).toContain("Persist failed: disk full");
  });

  it("/agent budget alias scopes keys to budget.*", () => {
    const { d, persisted, current } = settingsDeps();
    const out = run(d, "budget set idleS 600");
    expect(current.budget.idleMs).toBe(600_000);
    expect(persisted).toEqual([["budget.idleS", 600]]);
    expect(out).toContain("applies to new runs immediately");
    // alias 下非 budget key 被拒绝
    expect(run(d, "budget set fleetWidget false")).toContain("Unknown budget key");
    // 列出时只显示 budget 行
    const list = run(d, "budget");
    expect(list).toContain("budget.idleS");
    expect(list).not.toContain("fleetWidget");
  });

  it("S1: exposes and persists bashJobs.* settings in seconds, rejecting illegal values", () => {
    const { d, persisted, current } = settingsDeps();
    const listing = run(d, "settings");
    for (const key of [
      "bashJobs.autoBackgroundS",
      "bashJobs.maxLogBytes",
      "bashJobs.maxBackgroundJobs",
      "bashJobs.retentionS",
      "bashJobs.shutdownPolicy",
    ]) {
      expect(listing).toContain(key);
    }
    // defaults are shown in seconds, and dir/shellPath stay JSON-file-only in v1
    expect(listing).toContain("120");
    expect(listing).not.toContain("120000");
    expect(listing).not.toContain("bashJobs.dir");
    expect(listing).not.toContain("bashJobs.shellPath");

    const out = run(d, "settings set bashJobs.autoBackgroundS 30");
    expect(current.bashJobs.autoBackgroundMs).toBe(30_000);
    expect(persisted).toEqual([["bashJobs.autoBackgroundS", 30]]);
    expect(out).toContain("takes effect after /reload");

    // 0 disables the whole feature and must be accepted
    expect(run(d, "settings set bashJobs.autoBackgroundS 0")).toContain("Persisted to");
    expect(current.bashJobs.autoBackgroundMs).toBe(0);

    run(d, "settings set bashJobs.shutdownPolicy kill");
    expect(current.bashJobs.shutdownPolicy).toBe("kill");
    run(d, "settings reset bashJobs.autoBackgroundS");
    expect(current.bashJobs.autoBackgroundMs).toBe(DEFAULT_SETTINGS.bashJobs.autoBackgroundMs);
  });

  it("S1: rejects illegal bashJobs.* values without touching state", () => {
    const { d, persisted, current } = settingsDeps();
    expect(run(d, "settings set bashJobs.autoBackgroundS -1")).toContain("Invalid value");
    expect(run(d, "settings set bashJobs.autoBackgroundS abc")).toContain("Invalid value");
    expect(run(d, "settings set bashJobs.maxLogBytes -5")).toContain("Invalid value");
    expect(run(d, "settings set bashJobs.maxBackgroundJobs 1.5")).toContain("expected an integer >= 0");
    expect(run(d, "settings set bashJobs.retentionS Infinity")).toContain("Invalid value");
    expect(run(d, "settings set bashJobs.shutdownPolicy terminate")).toContain("expected one of: keep, kill");
    expect(run(d, "settings set bashJobs.dir /tmp/x")).toContain("Unknown settings key");
    expect(persisted).toEqual([]);
    expect(current.bashJobs).toEqual(DEFAULT_SETTINGS.bashJobs);
  });

  it("tab completion offers second-valued keys with their second defaults", () => {
    const cmd = createStatusCommand(settingsDeps().d as never);
    const items = cmd.getArgumentCompletions?.("settings set budget.idle", 0) as
      Array<{ value: string; label: string; description: string }> | undefined;
    expect(items?.map((i) => i.label)).toEqual(["budget.idleS"]);
    expect(items?.[0]?.description).toBe("default 240");
  });
});

/**
 * Requirement 1: `/agent settings` with no arguments opens the interactive
 * overlay editor in TUI mode, and degrades to the text listing everywhere
 * else (print/rpc/json, or a pi without `ui.custom`).
 */
describe("/agent settings interactive editor wiring", () => {
  function editorDeps() {
    const current = JSON.parse(JSON.stringify(DEFAULT_SETTINGS));
    return {
      ...deps([]),
      settings: { current, persist: () => undefined, path: "/tmp/test-pi-subagent.json" },
    };
  }

  it("opens the overlay editor in TUI mode and notifies nothing", async () => {
    const notified: string[] = [];
    let factory: unknown;
    const ctx = {
      mode: "tui",
      ui: {
        notify: (m: string) => notified.push(m),
        custom: async (f: unknown) => {
          factory = f;
          return undefined;
        },
      },
    };
    await createStatusCommand(editorDeps() as never).handler("settings", ctx as never);
    expect(typeof factory).toBe("function");
    expect(notified).toEqual([]);
  });

  it("keeps the text listing for `settings list`, even in TUI mode", async () => {
    const notified: string[] = [];
    let opened = false;
    const ctx = {
      mode: "tui",
      ui: {
        notify: (m: string) => notified.push(m),
        custom: async () => {
          opened = true;
        },
      },
    };
    await createStatusCommand(editorDeps() as never).handler("settings list", ctx as never);
    expect(opened).toBe(false);
    expect(notified[0]).toContain("Extension settings");
  });

  it("falls back to the text listing outside TUI mode (print/rpc) and without ui.custom", async () => {
    const notified: string[] = [];
    const print = { mode: "print", ui: { notify: (m: string) => notified.push(m), custom: async () => undefined } };
    await createStatusCommand(editorDeps() as never).handler("settings", print as never);
    expect(notified[0]).toContain("Extension settings");
    const old = { mode: "tui", ui: { notify: (m: string) => notified.push(m) } };
    await createStatusCommand(editorDeps() as never).handler("settings", old as never);
    expect(notified[1]).toContain("Extension settings");
  });

  it("`/agent budget` with no arguments opens the editor scoped to budget.*", async () => {
    let budgetOnly: boolean | undefined;
    const ctx = {
      mode: "tui",
      ui: {
        notify: () => undefined,
        custom: async (factory: (tui: unknown, theme: unknown, kb: unknown, done: () => void) => unknown) => {
          const component = factory({ requestRender: () => undefined }, undefined, undefined, () => undefined) as {
            render(width: number): string[];
          };
          budgetOnly = component.render(80).join("\n").includes("Run budget");
          return undefined;
        },
      },
    };
    await createStatusCommand(editorDeps() as never).handler("budget", ctx as never);
    expect(budgetOnly).toBe(true);
  });
});

// ── S7: bash jobs section (`/agent status`) ────────────────────────────────

function jobRecord(overrides: Partial<JobRecord> = {}): JobRecord {
  return {
    v: 1,
    jobId: "b_3F7K2M9P",
    command: "npm run build:all",
    cwd: "/repo",
    sessionId: "s1",
    hostPid: 1000,
    status: "running",
    createdAt: 0,
    spawnedAt: 0,
    exitCode: null,
    logPath: "/tmp/bash-jobs/b_3F7K2M9P.log",
    logBytes: 3_500_000,
    outputTruncated: false,
    readCursor: 0,
    pid: 23456,
    ...overrides,
  } as JobRecord;
}

function bashDeps(jobs: JobRecord[]) {
  return { ...deps([]), bashJobs: { list: () => jobs }, workflow: undefined };
}

describe("S7 /agent status bash jobs section", () => {
  it("hides the whole section when there are no jobs (and when the port is absent)", () => {
    expect(renderStatus(bashDeps([]) as never)).not.toContain("bash jobs");
    expect(renderStatus(deps([]) as never)).not.toContain("bash jobs");
  });

  it("counts running vs finished-unread jobs and renders one row per job", () => {
    const running = jobRecord({ spawnedAt: Date.now() - 12 * 60_000 });
    const unread = jobRecord({
      jobId: "b_8Q1RN4ZC",
      command: "pytest -x",
      status: "completed",
      exitCode: 0,
      spawnedAt: Date.now() - 2 * 60_000,
      endedAt: Date.now(),
      logBytes: 2048,
    });
    const notified = jobRecord({
      jobId: "b_NOTIFIED",
      status: "failed",
      exitCode: 1,
      endedAt: Date.now(),
      notifiedAt: Date.now(),
    });
    const text = renderStatus(bashDeps([running, unread, notified]) as never);
    expect(text).toContain("bash jobs (1 running, 1 finished unread):");
    expect(text).toContain("b_3F7K2M9P  running  12m");
    expect(text).toContain("$ npm run build:all");
    expect(text).toContain("b_8Q1RN4ZC  completed (exit 0)");
    expect(text).toContain("unnotified");
    // an already-notified terminal job is counted nowhere and printed nowhere
    expect(text).not.toContain("b_NOTIFIED");
  });

  it("caps the running rows at 5 and reports the remainder", () => {
    const jobs = Array.from({ length: 7 }, (_, i) => jobRecord({ jobId: `b_RUN0000${i}` }));
    const text = renderStatus(bashDeps(jobs) as never);
    expect(text).toContain("bash jobs (7 running, 0 finished unread):");
    expect(text).toContain("b_RUN00004");
    expect(text).not.toContain("b_RUN00005");
    expect(text).toContain("… 2 more running");
  });

  it("never lets a failing job port break the rest of the diagnostics", () => {
    const broken = {
      ...deps([]),
      bashJobs: {
        list: () => {
          throw new Error("no active session yet");
        },
      },
    };
    const text = renderStatus(broken as never);
    expect(text).toContain("Subagent runs:");
    expect(text).not.toContain("bash jobs");
  });

  it("`/agent status <b_prefix>` renders one job's detail, resolving unique prefixes", () => {
    const job = jobRecord({ status: "failed", exitCode: 1, endedAt: 60_000, finalText: "Command exited with code 1" });
    const notified: string[] = [];
    const cmd = createStatusCommand({
      ...bashDeps([job]),
      resolveRun: () => {
        throw new Error("bash ids must not reach the run resolver");
      },
    } as never);
    const ctx = { ui: { notify: (text: string) => notified.push(text) } };
    void cmd.handler("status b_3F7", ctx as never);
    void cmd.handler("b_3F7K2M9P", ctx as never);
    void cmd.handler("b_NOPE", ctx as never);
    expect(notified[0]).toContain("Bash job b_3F7K2M9P · failed (exit 1)");
    expect(notified[0]).toContain("Command: $ npm run build:all");
    expect(notified[0]).toContain('bash_job(action: "output", job_id: "b_3F7K2M9P")');
    expect(notified[1]).toBe(notified[0]);
    expect(notified[2]).toBe('No bash job matches "b_NOPE".');
  });

  it("`/agent status <b_prefix>` reports ambiguity instead of guessing", () => {
    const notified: string[] = [];
    const cmd = createStatusCommand(bashDeps([jobRecord({ jobId: "b_AA1" }), jobRecord({ jobId: "b_AA2" })]) as never);
    void cmd.handler("status b_AA", { ui: { notify: (t: string) => notified.push(t) } } as never);
    expect(notified[0]).toContain('Ambiguous "b_AA" — matches: b_AA1, b_AA2');
  });
});
