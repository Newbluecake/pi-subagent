import { describe, expect, it, vi } from "vitest";
import { Text } from "@earendil-works/pi-tui";
import {
  buildProgressLines,
  createAgentTool,
  formatOutcomeSummary,
  type AgentToolDetails,
  type ForegroundProgressPort,
  type NestedSpawnPort,
} from "../../src/tools/agent-tool.js";
import type { RunDiagnostics, RunOutcome, RunSnapshot } from "../../src/core/types.js";

function diag(overrides: Partial<RunDiagnostics> = {}): RunDiagnostics {
  return {
    createdAt: 0,
    phase: "model_turn",
    phaseEnteredAt: 0,
    pendingTools: 0,
    turns: 2,
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
    runId: "run-1",
    generation: 1,
    status: "running",
    phase: "model_turn",
    deadlines: { enqueuedAt: 0, deadlineAt: undefined, queueDeadlineAt: undefined },
    diag: diag(),
    updatedAt: 0,
    ...overrides,
  };
}
function completed(overrides: Partial<RunOutcome> = {}): RunOutcome {
  return {
    runId: "run-1",
    status: "completed",
    text: "done",
    turns: 5,
    durationMs: 78_000,
    usage: { input: 4204, output: 590, cacheRead: 0, cacheWrite: 0, costUsd: 0.156 },
    diag: diag({
      model: { provider: "copilot-completion", id: "kimi-k3" },
      toolCounts: { bash: 3, read: 2, edit: 1 },
    }),
    ...overrides,
  };
}

describe("result text presentation", () => {
  it("caps foreground completed text with the shared result helper", async () => {
    const spawn: NestedSpawnPort = {
      spawn: async () => ({ runId: "child" }),
      spawnAndWait: async () => completed({ text: "y".repeat(120), diag: diag({ sessionFile: "/tmp/session.jsonl" }) }),
    };
    const result = await createAgentTool({ spawn, resultMaxChars: () => 100 }).execute(
      "tc1",
      { description: "demo", prompt: "p", subagent_type: "general" },
      undefined,
      undefined,
    );
    expect((result.content[0] as { text: string }).text).toContain("showing first 100 of 120 chars");
    expect((result.content[0] as { text: string }).text).toContain("full session transcript: /tmp/session.jsonl");
  });
});

describe("M-B: buildProgressLines", () => {
  it("renders the status header with model, phase, turn, elapsed and cost", () => {
    const snap = snapshot({
      diag: diag({
        model: { provider: "p", id: "kimi-k3" },
        usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, costUsd: 0.0412 },
      }),
    });
    expect(buildProgressLines(snap, 42_000)[0]).toBe("⏳ p/kimi-k3 · 🤔思考 · turn 3 · 42s · $0.04");
  });

  it("falls back to agentType then status when no model is known", () => {
    expect(buildProgressLines(snapshot({ diag: diag({ agentType: "architect" }) }), 1_000)[0]).toContain("architect");
    expect(buildProgressLines(snapshot(), 1_000)[0]).toContain("running");
  });

  it("shows the last N tool calls with ✓/✗/▸ marks, args preview and durations", () => {
    const snap = snapshot({
      diag: diag({
        toolHistory: [
          { name: "bash", toolCallId: "a", startedAt: 0, endedAt: 1_200, isError: false, argsPreview: "ls -la" },
          { name: "bash", toolCallId: "b", startedAt: 2_000, endedAt: 10_100, isError: true, argsPreview: "npm test" },
          { name: "edit", toolCallId: "c", startedAt: 11_000, argsPreview: "src/x.ts" },
        ],
      }),
    });
    const lines = buildProgressLines(snap, 12_000);
    expect(lines.slice(1)).toEqual(["✓ bash ls -la (1s)", "✗ bash npm test (8s)", "▸ edit src/x.ts (running…)"]);
  });

  it("caps the trail at maxTools (most recent kept)", () => {
    const history = Array.from({ length: 6 }, (_, i) => ({
      name: `t${i}`,
      toolCallId: `c${i}`,
      startedAt: i,
      endedAt: i + 1,
      isError: false,
    }));
    const lines = buildProgressLines(snapshot({ diag: diag({ toolHistory: history }) }), 100, 3);
    expect(lines).toHaveLength(4);
    expect(lines[1]).toContain("t3");
    expect(lines[3]).toContain("t5");
  });
});

describe("M-B/M-D: formatOutcomeSummary", () => {
  it("renders model · turns · tools breakdown · cost · duration", () => {
    expect(formatOutcomeSummary(completed())).toBe(
      "copilot-completion/kimi-k3 · 5 turns · 6 tools (bash×3 read×2 edit) · $0.16 · 1m18s",
    );
  });
  it("omits absent parts and uses singular forms", () => {
    const bare = completed({
      turns: 1,
      durationMs: 900,
      diag: diag({ toolCounts: { bash: 1 } }),
    });
    delete (bare as { usage?: unknown }).usage;
    expect(formatOutcomeSummary(bare)).toBe("1 turn · 1 tool (bash) · 900ms");
  });
});

describe("M-B: foreground progress path (spawn + onUpdate + waitOutcome)", () => {
  function ports(snap: RunSnapshot, settled: RunOutcome) {
    let request: Parameters<NestedSpawnPort["spawn"]>[0] | undefined;
    const spawn: NestedSpawnPort = {
      async spawn(req) {
        request = req;
        return { runId: settled.runId };
      },
      async spawnAndWait() {
        throw new Error("progress path must not call spawnAndWait");
      },
    };
    let release!: (o: RunOutcome) => void;
    const gate = new Promise<RunOutcome>((r) => {
      release = r;
    });
    const progress: ForegroundProgressPort = {
      getSnapshot: () => snap,
      waitOutcome: async () => ({ kind: "settled" as const, outcome: await gate }),
    };
    return {
      spawn,
      progress,
      release,
      get request() {
        return request;
      },
    };
  }

  it("streams partial updates while waiting, then returns the enriched final result", async () => {
    vi.useFakeTimers();
    try {
      const snap = snapshot({
        diag: diag({
          model: { provider: "p", id: "kimi-k3" },
          toolHistory: [{ name: "bash", toolCallId: "a", startedAt: 0, argsPreview: "ls" }],
        }),
      });
      const final = completed();
      const testPorts = ports(snap, final);
      const { spawn, progress, release } = testPorts;
      const tool = createAgentTool({ spawn, progress });
      const updates: AgentToolDetails[] = [];
      const onUpdate = (u: { details?: unknown }) => updates.push((u.details ?? {}) as AgentToolDetails);
      const pending = tool.execute(
        "tc1",
        { description: "demo", prompt: "p", subagent_type: "general" },
        undefined,
        onUpdate as never,
        {} as never,
      );
      await vi.advanceTimersByTimeAsync(2_100); // immediate push + 2 ticks
      expect(updates.length).toBeGreaterThanOrEqual(3);
      expect(updates[0]!.runId).toBe("run-1");
      expect(updates[0]!.progress![0]).toContain("p/kimi-k3");
      expect(updates[0]!.progress![1]).toContain("▸ bash ls");
      release(final);
      const result = await pending;
      expect(testPorts.request?.expectAck).toBe(true);
      const details = result.details as AgentToolDetails;
      expect(details.summary).toBe(formatOutcomeSummary(final));
      expect(details.model).toBe("copilot-completion/kimi-k3");
      expect(details.toolCounts).toEqual({ bash: 3, read: 2, edit: 1 });
      expect(details.costUsd).toBeCloseTo(0.156);
      expect(result.content[0]).toEqual({ type: "text", text: "done" });
      // pi usage accounting: the child session's spend rides on the tool result
      const usage = (result as { usage?: { totalTokens: number; cost: { total: number } } }).usage;
      expect(usage).toBeDefined();
      expect(usage!.cost.total).toBeCloseTo(0.156);
      expect(usage!.totalTokens).toBe(4204 + 590);
    } finally {
      vi.useRealTimers();
    }
  });

  it("throws (not silently completes) when the waited outcome is non-completed", async () => {
    const snap = snapshot();
    const final = completed({ status: "timed_out", timeoutReason: "total" });
    const { spawn, progress, release } = ports(snap, final);
    release(final);
    const tool = createAgentTool({ spawn, progress });
    await expect(
      tool.execute(
        "tc1",
        { description: "demo", prompt: "p", subagent_type: "general" },
        undefined,
        (() => undefined) as never,
        {} as never,
      ),
    ).rejects.toThrow(/did not complete successfully: total/);
  });

  it("without onUpdate the tool falls back to spawnAndWait (non-interactive parity)", async () => {
    const calls: string[] = [];
    const spawn: NestedSpawnPort = {
      async spawn() {
        calls.push("spawn");
        return { runId: "x" };
      },
      async spawnAndWait() {
        calls.push("spawnAndWait");
        return completed();
      },
    };
    const progress: ForegroundProgressPort = {
      getSnapshot: () => undefined,
      waitOutcome: async () => ({ kind: "settled" as const, outcome: completed() }),
    };
    const tool = createAgentTool({ spawn, progress });
    const result = await tool.execute(
      "tc1",
      { description: "demo", prompt: "p", subagent_type: "general" },
      undefined,
      undefined,
      {} as never,
    );
    expect(calls).toEqual(["spawnAndWait"]);
    expect((result.details as AgentToolDetails).summary).toBeDefined();
  });
});

describe("auto-background behavior", () => {
  const params = { description: "demo", prompt: "p", subagent_type: "general" } as const;

  it("returns a background result after the configured threshold", async () => {
    const requestSignals: AbortSignal[] = [];
    const spawn: NestedSpawnPort = {
      async spawn(request) {
        requestSignals.push(request.signal!);
        return { runId: "run-bg" };
      },
      async spawnAndWait() {
        throw new Error("unexpected spawnAndWait");
      },
    };
    const progress: ForegroundProgressPort = {
      getSnapshot: () => undefined,
      waitOutcome: async (_runId, waitMs) => {
        expect(waitMs).toBe(1000);
        return { kind: "pending" };
      },
    };
    const controller = new AbortController();
    const result = await createAgentTool({ spawn, progress, autoBackgroundMs: () => 1000 }).execute(
      "tc",
      params,
      controller.signal,
      (() => {}) as never,
      {} as never,
    );
    expect(result.details).toEqual({ runId: "run-bg", background: true, autoBackgrounded: true });
    expect(result.content[0]!.text).toContain("get_subagent_result");
    expect(result.content[0]!.text).toContain("NOT stopped");
    expect(requestSignals[0]).not.toBe(controller.signal);
    controller.abort();
    expect(requestSignals[0]!.aborted).toBe(false);
  });

  it("passes undefined waitMs when auto-backgrounding is disabled", async () => {
    let receivedWaitMs: number | undefined = 123;
    const final = completed();
    const spawn: NestedSpawnPort = {
      async spawn() {
        return { runId: final.runId };
      },
      async spawnAndWait() {
        throw new Error("unexpected spawnAndWait");
      },
    };
    const progress: ForegroundProgressPort = {
      getSnapshot: () => undefined,
      waitOutcome: async (_runId, waitMs) => {
        receivedWaitMs = waitMs;
        return { kind: "settled", outcome: final };
      },
    };
    await createAgentTool({ spawn, progress, autoBackgroundMs: () => 0 }).execute(
      "tc",
      params,
      undefined,
      (() => {}) as never,
      {} as never,
    );
    expect(receivedWaitMs).toBeUndefined();
  });

  it("keeps the caller signal for explicit background runs", async () => {
    const controller = new AbortController();
    let requestSignal: AbortSignal | undefined;
    const spawn: NestedSpawnPort = {
      async spawn(request) {
        requestSignal = request.signal;
        return { runId: "run-explicit" };
      },
      async spawnAndWait() {
        throw new Error("unexpected spawnAndWait");
      },
    };
    await createAgentTool({ spawn }).execute(
      "tc",
      { ...params, run_in_background: true },
      controller.signal,
      undefined,
      {} as never,
    );
    expect(requestSignal).toBe(controller.signal);
  });

  it("cleans the relay listener after normal completion and spawn failure", async () => {
    const controller = new AbortController();
    let completedSignal!: AbortSignal;
    const final = completed();
    const progress: ForegroundProgressPort = {
      getSnapshot: () => undefined,
      waitOutcome: async () => ({ kind: "settled", outcome: final }),
    };
    const spawn: NestedSpawnPort = {
      async spawn(request) {
        completedSignal = request.signal!;
        return { runId: final.runId };
      },
      async spawnAndWait() {
        throw new Error("unexpected");
      },
    };
    await createAgentTool({ spawn, progress }).execute(
      "tc",
      params,
      controller.signal,
      (() => {}) as never,
      {} as never,
    );
    controller.abort();
    expect(completedSignal.aborted).toBe(false);

    const failedController = new AbortController();
    let failedSignal!: AbortSignal;
    const failed = {
      async spawn(request: any) {
        failedSignal = request.signal;
        return { error: { kind: "internal", message: "no", retryable: false } };
      },
      async spawnAndWait() {
        throw new Error("unexpected");
      },
    } as NestedSpawnPort;
    await expect(
      createAgentTool({ spawn: failed, progress }).execute(
        "tc",
        params,
        failedController.signal,
        (() => {}) as never,
        {} as never,
      ),
    ).rejects.toThrow("no");
    failedController.abort();
    expect(failedSignal.aborted).toBe(false);
  });
});

describe("M-B: renderResult", () => {
  const theme = { fg: (tone: string, text: string) => `[${tone}]${text}`, bold: (t: string) => t } as never;
  const ctx = { lastComponent: undefined } as never;

  it("partial: colors the trail by mark (✗ error, ▸ accent, ✓ muted)", () => {
    const tool = createAgentTool({ spawn: {} as NestedSpawnPort });
    const component = tool.renderResult!(
      {
        content: [{ type: "text", text: "ignored for partials" }],
        details: { progress: ["⏳ kimi-k3 · model_turn", "✓ bash ls (1s)", "✗ bash x (2s)", "▸ edit y (running…)"] },
      } as never,
      { expanded: false, isPartial: true },
      theme,
      ctx,
    ) as Text;
    const rendered = component.text;
    expect(rendered).toContain("⏳ kimi-k3");
    expect(rendered).toContain("[muted]✓ bash ls (1s)");
    expect(rendered).toContain("[error]✗ bash x (2s)");
    expect(rendered).toContain("[accent]▸ edit y (running…)");
  });

  it("final: muted summary line + body, collapsed past 6 lines unless expanded", () => {
    const tool = createAgentTool({ spawn: {} as NestedSpawnPort });
    const body = Array.from({ length: 9 }, (_, i) => `line${i}`).join("\n");
    const result = {
      content: [{ type: "text", text: body }],
      details: { summary: "kimi-k3 · 5 turns · $0.16 · 1m18s" },
    } as never;
    const collapsed = (tool.renderResult!(result, { expanded: false, isPartial: false }, theme, ctx) as Text).text;
    expect(collapsed).toContain("[muted]✓ kimi-k3 · 5 turns");
    expect(collapsed).toContain("line5");
    expect(collapsed).not.toContain("line6");
    expect(collapsed).toContain("[muted]… +3 more lines");
    const expanded = (tool.renderResult!(result, { expanded: true, isPartial: false }, theme, ctx) as Text).text;
    expect(expanded).toContain("line8");
  });
});

describe("M5: streaming text tail in progress lines", () => {
  it("appends the last non-empty line of diag.text, whitespace-collapsed and tail-truncated", () => {
    const snap = snapshot({ diag: diag({ text: "第一段\n\n正在分析 src/core 的  状态机\n" }) });
    const lines = buildProgressLines(snap, 1_000);
    expect(lines[lines.length - 1]).toBe("💬 正在分析 src/core 的 状态机");
    const long = snapshot({ diag: diag({ text: `x\n${"很".repeat(100)}` }) });
    const tail = buildProgressLines(long, 1_000).pop()!;
    expect(tail.startsWith("💬 …")).toBe(true);
    expect(tail.length).toBeLessThanOrEqual(80);
  });
  it("omits the tail line when no text has streamed yet", () => {
    expect(buildProgressLines(snapshot(), 1_000).some((l) => l.startsWith("💬"))).toBe(false);
  });
});
