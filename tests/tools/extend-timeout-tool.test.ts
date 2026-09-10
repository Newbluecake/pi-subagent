import { describe, expect, it, vi } from "vitest";
import type { Text } from "@earendil-works/pi-tui";
import { createExtendTimeoutTool, ExtendTimeoutParams } from "../../src/tools/extend-timeout-tool.js";
import type { ExtendOutcome, RunSnapshot } from "../../src/core/types.js";
import type { QueryService } from "../../src/service/query-service.js";

const theme = { fg: (_tone: string, text: string) => text, bold: (text: string) => text } as never;
const ctx = (lastComponent?: unknown) => ({ lastComponent, state: {} }) as never;

function snapshot(overrides: {
  runId?: string;
  status?: RunSnapshot["status"];
  deadlineAt?: number;
  hardDeadlineAt?: number;
  enqueuedAt?: number;
  extensions?: number;
}): RunSnapshot {
  return {
    runId: overrides.runId ?? "r-abcdef123456",
    generation: 1,
    status: overrides.status ?? "running",
    phase: "tool_exec",
    deadlines: {
      enqueuedAt: overrides.enqueuedAt ?? 0,
      deadlineAt: overrides.deadlineAt,
      queueDeadlineAt: undefined,
      ...(overrides.hardDeadlineAt === undefined ? {} : { hardDeadlineAt: overrides.hardDeadlineAt }),
    },
    diag: {
      createdAt: 0,
      phase: "tool_exec",
      phaseEnteredAt: 0,
      pendingTools: 0,
      turns: 0,
      escalation: [],
      orphaned: false,
      generation: 1,
      degraded: [],
      staleInputs: 0,
      unkillable: [],
      ...(overrides.extensions === undefined
        ? {}
        : { overtime: { graces: 0, extensions: overrides.extensions, grantedMs: 0 } }),
    },
    updatedAt: 0,
  };
}

type FakeQuery = Pick<QueryService, "extendTimeout" | "get"> & {
  extendTimeout: ReturnType<typeof vi.fn>;
};

function setup(outcome: ExtendOutcome, snap?: RunSnapshot) {
  const query: FakeQuery = {
    extendTimeout: vi.fn(() => outcome),
    get: vi.fn(() => snap),
  };
  const tool = createExtendTimeoutTool({ query, now: () => NOW });
  return { query, tool };
}

const NOW = 10_000;
const RUN_ID = "r-abcdef123456";

function okOutcome(overrides: Partial<ExtendOutcome & { ok: true }> = {}): ExtendOutcome {
  return {
    ok: true,
    runId: RUN_ID,
    previousDeadlineAt: 600_000,
    deadlineAt: 610_000, // NOW + 600s → "New deadline in 10m00s"
    requestedMs: 600_000,
    grantedMs: 600_000,
    clamped: false,
    extensionsUsed: 1,
    extensionsRemaining: 2,
    hardDeadlineAt: 1_210_000, // 600s above the new deadline
    rescuedFromGrace: false,
    ...overrides,
  };
}

async function executeText(tool: ReturnType<typeof createExtendTimeoutTool>, params: Record<string, unknown>) {
  const result = await tool.execute("tc1", params as never);
  return (result.content[0] as { text: string }).text;
}

async function executeError(tool: ReturnType<typeof createExtendTimeoutTool>, params: Record<string, unknown>) {
  try {
    await tool.execute("tc1", params as never);
  } catch (error) {
    return (error as Error).message;
  }
  throw new Error("expected execute to throw");
}

describe("tools/extend-timeout-tool: schema", () => {
  it("extend_s is an integer in seconds with minimum 1; run_id documents label acceptance", () => {
    const props = ExtendTimeoutParams.properties;
    expect(props.extend_s.type).toBe("integer");
    expect(props.extend_s.minimum).toBe(1);
    expect(props.extend_s.description).toMatch(/seconds/);
    expect(props.run_id.description).toContain("label");
  });
});

describe("tools/extend-timeout-tool: execute happy path", () => {
  it("passes extend_s * 1000 (seconds → milliseconds) and the tool source to query.extendTimeout", async () => {
    const { query, tool } = setup(okOutcome());
    await executeText(tool, { run_id: RUN_ID, extend_s: 600, reason: "needs the full test suite" });
    expect(query.extendTimeout).toHaveBeenCalledWith(RUN_ID, 600_000, {
      source: "tool",
      reason: "needs the full test suite",
    });
  });

  it("success text reports granted/requested/remaining/ceiling with relative durations", async () => {
    const { tool } = setup(okOutcome());
    const text = await executeText(tool, { run_id: RUN_ID, extend_s: 600 });
    expect(text).toContain(`Extended run ${RUN_ID.slice(0, 8)} by 10m00s`);
    expect(text).toContain("requested 10m00s");
    expect(text).not.toContain("clamped");
    expect(text).toContain("New deadline in 10m00s");
    expect(text).toContain("2 of 3 extensions left");
    expect(text).toContain("at most 10m00s more available");
    expect(text).not.toContain("grace window");
  });

  it("a clamped grant says so explicitly", async () => {
    const { tool } = setup(
      okOutcome({ grantedMs: 120_000, clamped: true, deadlineAt: 130_000, hardDeadlineAt: 130_000 }),
    );
    const text = await executeText(tool, { run_id: RUN_ID, extend_s: 600 });
    expect(text).toContain("by 2m00s");
    expect(text).toContain("requested 10m00s, clamped by its hard ceiling");
    expect(text).toContain("at most 0ms more available");
  });

  it("a rescue from grace is called out", async () => {
    const { tool } = setup(okOutcome({ rescuedFromGrace: true }));
    const text = await executeText(tool, { run_id: RUN_ID, extend_s: 600 });
    expect(text).toContain("inside its timeout grace window and is now back to normal execution");
  });

  it("details carry the raw ExtendOutcome", async () => {
    const outcome = okOutcome();
    const { tool } = setup(outcome);
    const result = await tool.execute("tc1", { run_id: RUN_ID, extend_s: 600 } as never);
    expect(result.details).toBe(outcome);
  });

  it("defensive: a queued run that somehow succeeded is told its queue-wait timeout is unaffected", async () => {
    const { tool } = setup(okOutcome(), snapshot({ status: "queued" }));
    const text = await executeText(tool, { run_id: RUN_ID, extend_s: 600 });
    expect(text).toContain("this run has not started yet; its queue-wait timeout is unaffected.");
  });
});

describe("tools/extend-timeout-tool: resolveRun", () => {
  it("resolves prefixes/labels through resolveRun before calling the query", async () => {
    const { query, tool } = setup(okOutcome());
    const withResolver = createExtendTimeoutTool({
      query,
      resolveRun: (handle) =>
        handle === "reviewer" ? { ok: true, runId: RUN_ID } : { ok: false, error: "no such run", candidates: [] },
    });
    await executeText(withResolver, { run_id: "reviewer", extend_s: 60 });
    expect(query.extendTimeout).toHaveBeenCalledWith(RUN_ID, 60_000, { source: "tool" });
    void tool;
  });

  it("a failed resolution throws the resolver's error (with candidates) untouched", async () => {
    const { query } = setup(okOutcome());
    const tool = createExtendTimeoutTool({
      query,
      resolveRun: () => ({ ok: false, error: "ambiguous handle, candidates: a, b", candidates: [] }),
    });
    const message = await executeError(tool, { run_id: "rev", extend_s: 60 });
    expect(message).toBe("ambiguous handle, candidates: a, b");
  });
});

describe("tools/extend-timeout-tool: rejection matrix (arch §4.4 — every refusal says what to do next)", () => {
  const rejected = (reason: string): ExtendOutcome => ({ ok: false, reason: reason as never });

  it("unknown_run → list runs and retry", async () => {
    const { tool } = setup(rejected("unknown_run"));
    const message = await executeError(tool, { run_id: "nope", extend_s: 60 });
    expect(message).toContain("unknown run");
    expect(message).toContain("/agent status"); // next step
  });

  it("unsupported → this build cannot extend; fall back to respawn", async () => {
    const { tool } = setup(rejected("unsupported"), snapshot({}));
    const message = await executeError(tool, { run_id: RUN_ID, extend_s: 60 });
    expect(message).toContain("this build cannot extend run deadlines");
    expect(message).toContain("respawn"); // next step
  });

  it("not_started → extend only once executing; check with get_subagent_result", async () => {
    const { tool } = setup(rejected("not_started"), snapshot({ status: "queued" }));
    const message = await executeError(tool, { run_id: RUN_ID, extend_s: 60 });
    expect(message).toContain("has not started running yet (queued)");
    expect(message).toContain("extend after it starts"); // next step
    expect(message).toContain(`get_subagent_result(run_id: "${RUN_ID.slice(0, 8)}")`);
  });

  it("stopping → cannot bring it back; collect the terminal outcome", async () => {
    const { tool } = setup(rejected("stopping"), snapshot({ status: "stopping" }));
    const message = await executeError(tool, { run_id: RUN_ID, extend_s: 60 });
    expect(message).toContain("already shutting down");
    expect(message).toContain("would not bring it back");
    expect(message).toContain("get_subagent_result"); // next step
  });

  it("already_terminal → read the output instead", async () => {
    const { tool } = setup(rejected("already_terminal"), snapshot({ status: "completed" }));
    const message = await executeError(tool, { run_id: RUN_ID, extend_s: 60 });
    expect(message).toContain("already finished (completed)");
    expect(message).toContain("to read its output"); // next step
  });

  it("uncapped → nothing to extend", async () => {
    const { tool } = setup(rejected("uncapped"), snapshot({}));
    const message = await executeError(tool, { run_id: RUN_ID, extend_s: 60 });
    expect(message).toContain("has no time cap configured; there is nothing to extend");
  });

  it("limit_reached → remaining time + read-so-far / respawn exits", async () => {
    const { tool } = setup(
      rejected("limit_reached"),
      snapshot({ deadlineAt: NOW + 42_000, hardDeadlineAt: 600_000, extensions: 3 }),
    );
    const message = await executeError(tool, { run_id: RUN_ID, extend_s: 60 });
    expect(message).toContain("has already used all 3 deadline extensions");
    expect(message).toContain("It will stop at its current deadline (in 42s)");
    expect(message).toContain("get_subagent_result"); // next step ①
    expect(message).toContain("abort_subagent and respawn with a larger timeout_s"); // next step ②
  });

  it("no_headroom with an explicit timeout (hardDeadlineAt === deadlineAt, no extensions) → hard-cap variant", async () => {
    const { tool } = setup(
      rejected("no_headroom"),
      snapshot({ deadlineAt: NOW + 42_000, hardDeadlineAt: NOW + 42_000 }), // H === deadlineAt, extensions 0
    );
    const message = await executeError(tool, { run_id: RUN_ID, extend_s: 60 });
    expect(message).toContain("spawned with an explicit timeout, which is a hard cap");
    expect(message).toContain("it stops at its deadline (in 42s) and cannot be extended");
    expect(message).toContain("get_subagent_result"); // next step ①
    expect(message).toContain("respawn with a larger timeout_s"); // next step ②
  });

  it("no_headroom after extensions (at the ceiling) → ceiling variant", async () => {
    const { tool } = setup(
      rejected("no_headroom"),
      snapshot({ enqueuedAt: 0, deadlineAt: 3_600_000, hardDeadlineAt: 3_600_000, extensions: 2 }),
    );
    const message = await executeError(tool, { run_id: RUN_ID, extend_s: 60 });
    expect(message).toContain("is at its hard ceiling (1h00m from start); no further extension is possible");
    expect(message).toContain("get_subagent_result"); // next step
  });
});

describe("tools/extend-timeout-tool: renderCall (TUI call card)", () => {
  it("renders the title plus a gray +amount · reason preview", () => {
    const { tool } = setup(okOutcome());
    const comp = tool.renderCall!(
      { run_id: "r9", extend_s: 600, reason: "needs the full test suite" },
      theme,
      ctx(),
    ) as Text;
    const out = comp.render(120).join("\n");
    expect(out).toContain("Extend Subagent Timeout: r9");
    expect(out).toContain("+10m00s · needs the full test suite");
  });

  it("clips long reason previews and tolerates partial streaming args", () => {
    const { tool } = setup(okOutcome());
    const long = "x".repeat(200);
    const clipped = (tool.renderCall!({ run_id: "r9", extend_s: 30, reason: long }, theme, ctx()) as Text)
      .render(300)
      .join("\n");
    expect(clipped).toContain("+30s");
    expect(clipped).toContain("…");
    expect(clipped).not.toContain("x".repeat(100));
    const streaming = (tool.renderCall!({}, theme, ctx()) as Text).render(120).join("\n");
    expect(streaming).toContain("Extend Subagent Timeout:");
  });
});
