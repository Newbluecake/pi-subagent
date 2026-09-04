import { describe, expect, it, vi } from "vitest";
import { createResultTool } from "../../src/tools/result-tool.js";
import type { QueryService } from "../../src/service/query-service.js";
import type { RunSnapshot, UsageDelta } from "../../src/core/types.js";

const usage: UsageDelta = { input: 42, output: 17, cacheRead: 3, cacheWrite: 0, costUsd: 0.0055 };

function completedSnapshot(): RunSnapshot {
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
      usage,
    },
    outcome: {
      runId: "r1",
      status: "completed",
      text: "done",
      turns: 1,
      durationMs: 10,
      usage,
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
        usage,
      },
    },
    updatedAt: 10,
  };
}

describe("result consumption", () => {
  it("consumes completed outcomes on get and wait with their generation", async () => {
    const calls: string[] = [];
    const notifier = { ack: (runId: string, generation: number) => (calls.push(`${runId}:${generation}`), true) };
    const snap = completedSnapshot();
    const getTool = createResultTool({ query: queryForSnapshot(snap), notifier });
    await getTool.execute("tc1", { run_id: "r1" }, undefined, () => undefined, {} as never);
    const waitTool = createResultTool({ query: queryForSnapshot(snap), notifier });
    await waitTool.execute("tc2", { run_id: "r1", wait: true }, undefined, () => undefined, {} as never);
    expect(calls).toEqual(["r1:1", "r1:1"]);
  });

  it("uses the stable key for schema-flipped failures", async () => {
    const snap = completedSnapshot();
    snap.status = "failed";
    snap.outcome = { ...snap.outcome!, status: "failed", error: { kind: "schema", message: "invalid" } };
    const calls: string[] = [];
    const notifier = { ack: (runId: string, generation: number) => (calls.push(`${runId}:${generation}`), true) };
    const tool = createResultTool({ query: queryForSnapshot(snap), notifier });
    await tool.execute("tc1", { run_id: "r1" }, undefined, () => undefined, {} as never);
    expect(calls).toEqual(["r1:1"]);
  });

  it.each([
    ["timed_out", undefined],
    ["aborted", undefined],
    ["failed", { kind: "runtime", message: "broken" }],
  ] as const)("does not use completed fallback for %s outcomes", async (status, error) => {
    const snap = completedSnapshot();
    snap.status = status;
    snap.outcome = { ...snap.outcome!, status, ...(error ? { error } : {}) };
    const calls: string[] = [];
    const tool = createResultTool({
      query: queryForSnapshot(snap),
      notifier: { ack: (runId: string, generation: number) => (calls.push(`${runId}:${generation}`), false) },
    });
    await tool.execute("tc1", { run_id: "r1" }, undefined, () => undefined, {} as never);
    expect(calls).toEqual(["r1:1"]);
  });

  it("does not consume while a snapshot has no outcome", async () => {
    const snap = completedSnapshot();
    snap.status = "running";
    snap.outcome = undefined;
    const ack = vi.fn(() => false);
    const tool = createResultTool({ query: queryForSnapshot(snap), notifier: { ack } });
    await tool.execute("tc1", { run_id: "r1" }, undefined, () => undefined, {} as never);
    expect(ack).not.toHaveBeenCalled();
  });

  it("returns normally when no notifier is provided", async () => {
    const result = await createResultTool({ query: queryForSnapshot(completedSnapshot()) }).execute(
      "tc1",
      { run_id: "r1" },
      undefined,
      () => undefined,
      {} as never,
    );
    expect((result.content[0] as { text: string }).text).toContain("done");
  });

  it("includes wall-clock duration in terminal text and details (get path)", async () => {
    const snap = completedSnapshot();
    snap.outcome = { ...snap.outcome!, durationMs: 21_000 };
    const result = await createResultTool({ query: queryForSnapshot(snap) }).execute(
      "tc1",
      { run_id: "r1" },
      undefined,
      () => undefined,
      {} as never,
    );
    const text = (result.content[0] as { text: string }).text;
    expect(text).toContain("(duration: 21s · usage: in:42");
    expect((result.details as { durationMs: number }).durationMs).toBe(21_000);
  });

  it("includes wall-clock duration in terminal text and details (wait path)", async () => {
    const snap = completedSnapshot();
    snap.outcome = { ...snap.outcome!, durationMs: 65_000 };
    const result = await createResultTool({ query: queryForSnapshot(snap) }).execute(
      "tc1",
      { run_id: "r1", wait: true },
      undefined,
      () => undefined,
      {} as never,
    );
    const text = (result.content[0] as { text: string }).text;
    expect(text).toContain("(duration: 1m05s · usage: in:42");
    expect((result.details as { durationMs: number }).durationMs).toBe(65_000);
  });

  it("still shows duration when the outcome has no usage", async () => {
    const snap = completedSnapshot();
    snap.outcome = { ...snap.outcome!, durationMs: 900, usage: undefined };
    const result = await createResultTool({ query: queryForSnapshot(snap) }).execute(
      "tc1",
      { run_id: "r1" },
      undefined,
      () => undefined,
      {} as never,
    );
    expect((result.content[0] as { text: string }).text).toContain("(duration: 900ms)");
  });

  it("appends duration to failed outcomes too", async () => {
    const snap = completedSnapshot();
    snap.status = "failed";
    snap.outcome = {
      ...snap.outcome!,
      status: "failed",
      durationMs: 3_200,
      error: { kind: "runtime", message: "broken" },
    };
    const result = await createResultTool({ query: queryForSnapshot(snap) }).execute(
      "tc1",
      { run_id: "r1" },
      undefined,
      () => undefined,
      {} as never,
    );
    const text = (result.content[0] as { text: string }).text;
    expect(text).toContain("Subagent run failed: broken");
    expect(text).toContain("(duration: 3s · usage: in:42");
  });
});

function queryForSnapshot(snapshot: RunSnapshot): QueryService {
  return {
    get: () => snapshot,
    list: () => [],
    wait: async () => ({ ok: true, outcome: snapshot.outcome! }),
    waitAll: async () => ({ settled: [], pending: [] }),
    steer: async () => undefined,
    stop: async () => false,
  };
}

describe("X9 get_subagent_result usage output", () => {
  it("includes usage in both the details payload and the rendered text for a non-waiting lookup", async () => {
    const query: QueryService = {
      get: () => completedSnapshot(),
      list: () => [],
      wait: async () => ({ ok: false, reason: "unknown_run" }),
      waitAll: async () => ({ settled: [], pending: [] }),
      steer: async () => undefined,
      stop: async () => false,
    };
    const tool = createResultTool({ query });
    const result = await tool.execute("tc1", { run_id: "r1" }, undefined, () => undefined, {} as never);
    expect((result.details as { usage?: UsageDelta }).usage).toEqual(usage);
    expect((result.content[0] as { text: string }).text).toContain("cost:$0.0055");
  });

  it("includes usage when the caller waits for completion", async () => {
    const query: QueryService = {
      get: () => undefined,
      list: () => [],
      wait: async () => ({ ok: true, outcome: completedSnapshot().outcome! }),
      waitAll: async () => ({ settled: [], pending: [] }),
      steer: async () => undefined,
      stop: async () => false,
    };
    const tool = createResultTool({ query });
    const result = await tool.execute("tc1", { run_id: "r1", wait: true }, undefined, () => undefined, {} as never);
    expect((result.details as { usage?: UsageDelta }).usage).toEqual(usage);
  });
});

describe("structured result + progress", () => {
  const queryFor = (snapshot: RunSnapshot): QueryService => ({
    get: () => snapshot,
    list: () => [],
    wait: async () => ({ ok: true, outcome: snapshot.outcome! }),
    waitAll: async () => ({ settled: [], pending: [] }),
    steer: async () => undefined,
    stop: async () => false,
  });

  it("serializes structuredResult and preserves the usage tail", async () => {
    const snap = completedSnapshot();
    snap.outcome = { ...snap.outcome!, text: undefined, structuredResult: { ok: true } };
    const tool = createResultTool({ query: queryFor(snap) });
    const result = await tool.execute("tc1", { run_id: "r1" }, undefined, () => undefined, {} as never);
    const text = (result.content[0] as { text: string }).text;
    expect(text.startsWith(JSON.stringify({ ok: true }))).toBe(true);
    expect(text).toContain("cost:$0.0055");
  });

  it("serializes structuredResult on the wait path and prefers it over text", async () => {
    const snap = completedSnapshot();
    snap.outcome = { ...snap.outcome!, text: "stale text", structuredResult: null };
    const tool = createResultTool({ query: queryFor(snap) });
    const result = await tool.execute("tc1", { run_id: "r1", wait: true }, undefined, () => undefined, {} as never);
    const text = (result.content[0] as { text: string }).text;
    expect(text.startsWith("null")).toBe(true);
    expect(text).not.toContain("stale text");
  });

  it("appends the full progress situation for a non-terminal lookup", async () => {
    const snap = completedSnapshot();
    snap.status = "running";
    snap.outcome = undefined;
    snap.phase = "model_turn";
    snap.diag.model = { provider: "p", id: "kimi-k3" };
    snap.diag.toolHistory = [
      { name: "bash", toolCallId: "a", startedAt: 0, endedAt: 1_000, isError: false, argsPreview: "ls" },
      { name: "edit", toolCallId: "b", startedAt: 2_000, argsPreview: "x.ts" },
    ];
    snap.diag.text = "working on the result";
    const tool = createResultTool({ query: queryFor(snap) });
    const text = (
      (await tool.execute("tc1", { run_id: "r1" }, undefined, () => undefined, {} as never)).content[0] as {
        text: string;
      }
    ).text;
    expect(text).toContain("still running");
    expect(text).toContain("⏳ p/kimi-k3");
    expect(text).toContain("✓ bash ls");
    expect(text).toContain("▸ edit x.ts");
    expect(text).toContain("💬 working on the result");
  });
});

describe("pi usage accounting: tool-result usage attach + first-terminal dedupe", () => {
  const query = (): QueryService => ({
    get: () => completedSnapshot(),
    list: () => [],
    wait: async () => ({ ok: true, outcome: completedSnapshot().outcome! }),
    waitAll: async () => ({ settled: [], pending: [] }),
    steer: async () => undefined,
    stop: async () => false,
  });
  type WithUsage = { usage?: { totalTokens: number; cost: { total: number } } };

  it("attaches pi-shaped usage to the FIRST terminal retrieval only (no double counting)", async () => {
    const tool = createResultTool({ query: query() });
    const first = (await tool.execute("tc1", { run_id: "r1" }, undefined, () => undefined, {} as never)) as WithUsage;
    expect(first.usage).toBeDefined();
    expect(first.usage!.cost.total).toBeCloseTo(0.0055);
    expect(first.usage!.totalTokens).toBe(42 + 17 + 3);
    const second = (await tool.execute("tc2", { run_id: "r1" }, undefined, () => undefined, {} as never)) as WithUsage;
    expect(second.usage).toBeUndefined();
    // a different run is still reported
    const other = (await tool.execute(
      "tc3",
      { run_id: "r2", wait: true },
      undefined,
      () => undefined,
      {} as never,
    )) as WithUsage;
    expect(other.usage).toBeDefined();
  });

  it("resolves prefix/label aliases to one canonical usage key", async () => {
    const requested: string[] = [];
    const q: QueryService = {
      ...query(),
      get: (runId) => (requested.push(runId), completedSnapshot()),
      wait: async (runId) => (requested.push(runId), { ok: true, outcome: completedSnapshot().outcome! }),
    };
    const tool = createResultTool({
      query: q,
      resolveRun: (handle) => ({ ok: true, runId: handle === "build" ? "r1" : "r1" }),
    });
    const first = (await tool.execute(
      "tc1",
      { run_id: "build" },
      undefined,
      () => undefined,
      {} as never,
    )) as WithUsage;
    const second = (await tool.execute(
      "tc2",
      { run_id: "r1", wait: true },
      undefined,
      () => undefined,
      {} as never,
    )) as WithUsage;
    expect(first.usage).toBeDefined();
    expect(second.usage).toBeUndefined();
    // Count-agnostic: the wait path's live-progress push may query.get() extra
    // times; the invariant is that every lookup uses the *canonical* id.
    expect(requested.length).toBeGreaterThanOrEqual(2);
    expect(requested.every((id) => id === "r1")).toBe(true);
  });

  it("does not attach usage while the run is still active", async () => {
    const running = completedSnapshot();
    running.status = "running";
    delete (running as { outcome?: unknown }).outcome;
    const q: QueryService = { ...query(), get: () => running };
    const tool = createResultTool({ query: q });
    const result = (await tool.execute("tc1", { run_id: "r1" }, undefined, () => undefined, {} as never)) as WithUsage;
    expect(result.usage).toBeUndefined();
  });
});

describe("TUI visibility: renderCall + wait-path partial updates", () => {
  // Bare-minimum Theme stand-in (same convention as agent-tool.test.ts).
  const theme = { fg: (_color: string, t: string) => t, bold: (t: string) => t };
  const ctx = (lastComponent?: unknown) => ({ lastComponent, state: {} });
  const idleQuery = (): QueryService => ({
    get: () => undefined,
    list: () => [],
    wait: async () => ({ ok: false, reason: "unknown_run" }),
    waitAll: async () => ({ settled: [], pending: [] }),
    steer: async () => undefined,
    stop: async () => false,
  });

  it("renders the awaited run_id and wait budget instead of a bare tool name", () => {
    const tool = createResultTool({ query: idleQuery() });
    const comp = tool.renderCall!({ run_id: "r1", wait: true, wait_ms: 60_000 }, theme as never, ctx() as never);
    const out = (comp as Text).render(120).join("\n");
    expect(out).toContain("Get Subagent Result: r1");
    expect(out).toContain("wait (budget: 1m00s)");
  });

  it("renders a plain poll without a wait line and tolerates partial streaming args", () => {
    const tool = createResultTool({ query: idleQuery() });
    const polled = (tool.renderCall!({ run_id: "r2" }, theme as never, ctx() as never) as Text).render(120).join("\n");
    expect(polled).toContain("Get Subagent Result: r2");
    expect(polled).not.toContain("wait (budget");
    const streaming = (tool.renderCall!({}, theme as never, ctx() as never) as Text).render(120).join("\n");
    expect(streaming).toContain("Get Subagent Result:");
  });

  it("streams a waiting header (elapsed/budget) plus the run's progress lines while wait blocks", async () => {
    const running = completedSnapshot();
    running.status = "running";
    running.phase = "streaming";
    delete (running as { outcome?: unknown }).outcome;
    const q: QueryService = {
      ...idleQuery(),
      get: () => running,
      wait: async () => ({ ok: true, outcome: completedSnapshot().outcome! }),
    };
    const tool = createResultTool({ query: q });
    const updates: string[] = [];
    const onUpdate = (u: { content: Array<{ type: string; text?: string }> }) => {
      updates.push(u.content.map((c) => c.text ?? "").join("\n"));
    };
    await tool.execute("tc1", { run_id: "r1", wait: true, wait_ms: 5_000 }, undefined, onUpdate as never, {} as never);
    expect(updates.length).toBeGreaterThan(0);
    expect(updates[0]).toContain("waiting for r1");
    expect(updates[0]).toContain("/ 5s");
    // buildProgressLines header for the awaited run rides along.
    expect(updates[0]).toContain("turn 2");
  });

  it("does not stream partial updates without an onUpdate channel (non-interactive parity)", async () => {
    const q: QueryService = { ...idleQuery(), wait: async () => ({ ok: true, outcome: completedSnapshot().outcome! }) };
    const tool = createResultTool({ query: q });
    const result = await tool.execute("tc1", { run_id: "r1", wait: true }, undefined, undefined as never, {} as never);
    expect((result.content[0] as { text: string }).text).toContain("done");
  });

  it("clears the progress interval even when query.wait throws synchronously", async () => {
    vi.useFakeTimers();
    try {
      const q: QueryService = {
        ...idleQuery(),
        get: () => undefined,
        wait: (() => {
          throw new Error("boom");
        }) as never,
      };
      const tool = createResultTool({ query: q });
      await expect(
        tool.execute("tc1", { run_id: "r1", wait: true }, undefined, (() => undefined) as never, {} as never),
      ).rejects.toThrow("boom");
      expect(vi.getTimerCount()).toBe(0); // no leaked 1Hz interval
    } finally {
      vi.useRealTimers();
    }
  });
});

describe("poll guard (anti-loop frequency warning)", () => {
  const toolWithGuard = (pollGuard?: { windowMs?: number; maxCalls?: number; now?: () => number }) =>
    createResultTool({ query: queryForSnapshot(completedSnapshot()), ...(pollGuard ? { pollGuard } : {}) });
  const call = (tool: ReturnType<typeof createResultTool>, runId = "r1") =>
    tool.execute("tc", { run_id: runId }, undefined, () => undefined, {} as never);
  const textOf = (r: Awaited<ReturnType<typeof call>>) => (r.content[0] as { text: string }).text;

  it("does not warn at or below the default threshold (3 calls per run within 10s)", async () => {
    const tool = toolWithGuard();
    for (let i = 0; i < 3; i++) {
      expect(textOf(await call(tool))).not.toContain("Polling too frequently");
    }
  });

  it("warns once a run is polled a 4th time within the window", async () => {
    const tool = toolWithGuard();
    for (let i = 0; i < 3; i++) await call(tool);
    const text = textOf(await call(tool));
    expect(text).toContain("Polling too frequently");
    expect(text).toContain('"r1"');
    expect(text).toContain("wait: true");
    // The actual result payload survives the prepended warning.
    expect(text).toContain("done");
  });

  it("tracks frequency per run_id, so fan-in collection of parallel runs does not warn", async () => {
    const tool = toolWithGuard();
    for (const runId of ["r1", "r2", "r3", "r4", "r5"]) {
      expect(textOf(await call(tool, runId))).not.toContain("Polling too frequently");
    }
  });

  it("stops warning after the window slides past the burst", async () => {
    let now = 1_000;
    const tool = toolWithGuard({ now: () => now });
    for (let i = 0; i < 3; i++) await call(tool);
    expect(textOf(await call(tool))).toContain("Polling too frequently");
    now += 11_000; // beyond the default 10s window
    expect(textOf(await call(tool))).not.toContain("Polling too frequently");
  });

  it("honours custom windowMs/maxCalls", async () => {
    let now = 0;
    const tool = toolWithGuard({ windowMs: 60_000, maxCalls: 1, now: () => now });
    expect(textOf(await call(tool))).not.toContain("Polling too frequently");
    now = 30_000; // inside the 60s window -> 2nd call exceeds maxCalls: 1
    expect(textOf(await call(tool))).toContain("Polling too frequently");
  });

  it("warns on the wait path too", async () => {
    const tool = toolWithGuard();
    for (let i = 0; i < 3; i++) {
      await tool.execute("tc", { run_id: "r1", wait: true }, undefined, () => undefined, {} as never);
    }
    const result = await tool.execute("tc", { run_id: "r1", wait: true }, undefined, () => undefined, {} as never);
    expect(textOf(result)).toContain("Polling too frequently");
  });
});
