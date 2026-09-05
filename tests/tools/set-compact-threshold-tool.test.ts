import { describe, expect, it } from "vitest";
import { createSetCompactThresholdTool } from "../../src/tools/set-compact-threshold-tool.js";
import type { CompactHintState } from "../../src/stack.js";

function state(): CompactHintState {
  return {
    thresholdPercent: 75,
    forceAtPercent: 88,
    reserveTokens: 16384,
    lastHintAt: 123,
    hintedAt: { effectivePercent: 75, contextWindow: 200000 },
  };
}
function ctx(overrides: Record<string, unknown> = {}) {
  return {
    mode: "interactive",
    getContextUsage: () => ({ percent: 80, contextWindow: 200000, tokens: 1 }),
    ...overrides,
  } as never;
}

describe("set_compact_threshold", () => {
  it("queries and writes with reset semantics", async () => {
    const current = state();
    const tool = createSetCompactThresholdTool({ getState: () => current, compactToolEnabled: () => true });
    expect((await tool.execute("1", {}, undefined, undefined, ctx())).details).toMatchObject({
      ok: true,
      action: "query",
    });
    await tool.execute("2", { percent: 70 }, undefined, undefined, ctx());
    expect(current).toMatchObject({ thresholdPercent: 70, lastHintAt: 0, hintedAt: undefined });
  });
  it("disables with zero and resets all state", async () => {
    const current = state();
    const tool = createSetCompactThresholdTool({ getState: () => current, compactToolEnabled: () => true });
    const response = await tool.execute("1", { percent: 0 }, undefined, undefined, ctx());
    expect(response.details).toMatchObject({ ok: true, action: "off", thresholdPercent: 0 });
    expect(current).toMatchObject({ thresholdPercent: 0, lastHintAt: 0, hintedAt: undefined });
  });
  it("sets, queries, and rejects invalid force thresholds", async () => {
    const current = state();
    const tool = createSetCompactThresholdTool({ getState: () => current, compactToolEnabled: () => true });
    const set = await tool.execute("1", { force: 90 }, undefined, undefined, ctx());
    expect(set.details).toMatchObject({ ok: true, forceAtPercent: 90 });
    expect(current.forceAtPercent).toBe(90);
    const query = await tool.execute("2", {}, undefined, undefined, ctx());
    expect(query.details).toMatchObject({ ok: true, forceAtPercent: 90, effectiveForcePercent: 90 });
    const bad = await tool.execute("3", { force: 75 }, undefined, undefined, ctx());
    expect(bad.details).toMatchObject({ ok: false, reason: "invalid" });
    expect(current.forceAtPercent).toBe(90);
  });

  it("allows percent-only updates below a 128k dynamic cap despite the default force", async () => {
    const current = state();
    const tool = createSetCompactThresholdTool({ getState: () => current, compactToolEnabled: () => true });
    const response = await tool.execute(
      "1",
      { percent: 60 },
      undefined,
      undefined,
      ctx({ getContextUsage: () => ({ percent: 50, contextWindow: 128000, tokens: 1 }) }),
    );
    expect(response.details).toMatchObject({ ok: true, thresholdPercent: 60 });
    expect(current).toMatchObject({ thresholdPercent: 60, forceAtPercent: 88 });
  });

  it("rejects combinations that would make warning meet or exceed force", async () => {
    const current = state();
    const tool = createSetCompactThresholdTool({ getState: () => current, compactToolEnabled: () => true });
    const percentOnly = await tool.execute("1", { percent: 90 }, undefined, undefined, ctx());
    expect(percentOnly.details).toMatchObject({ ok: false, reason: "invalid" });
    const combined = await tool.execute("2", { percent: 80, force: 80 }, undefined, undefined, ctx());
    expect(combined.details).toMatchObject({ ok: false, reason: "invalid" });
    expect(current).toMatchObject({ thresholdPercent: 75, forceAtPercent: 88 });
  });

  it("rejects invalid and above-cap values without writing", async () => {
    const current = state();
    current.forceAtPercent = 100;
    const tool = createSetCompactThresholdTool({ getState: () => current, compactToolEnabled: () => true });
    for (const percent of [0.5, 101, -1, Number.NaN])
      expect((await tool.execute("1", { percent }, undefined, undefined, ctx())).details).toMatchObject({
        ok: false,
        reason: "invalid",
      });
    expect((await tool.execute("1", { percent: 92 }, undefined, undefined, ctx())).details).toMatchObject({
      ok: false,
      reason: "above_cap",
    });
    expect(current.thresholdPercent).toBe(75);
  });
  it("accepts integer-floor values and usage without a context window", async () => {
    const current = state();
    const tool = createSetCompactThresholdTool({ getState: () => current, compactToolEnabled: () => true });
    const usageMissing = ctx({ getContextUsage: () => undefined });
    const response = await tool.execute("1", { percent: 75.9 }, undefined, undefined, usageMissing);
    expect(response.details).toMatchObject({ ok: true, thresholdPercent: 75 });
    expect(response.content[0]?.text).toContain("读侧钳制可能生效");
    expect((await tool.execute("2", { percent: 1 }, undefined, undefined, ctx())).details).toMatchObject({
      ok: true,
      thresholdPercent: 1,
    });
  });
  it("returns disabled and no-session reasons", async () => {
    const disabled = createSetCompactThresholdTool({ getState: () => state(), compactToolEnabled: () => false });
    expect((await disabled.execute("1", { percent: 50 }, undefined, undefined, ctx())).details).toMatchObject({
      ok: false,
      reason: "compact_tool_disabled",
    });
    const absent = createSetCompactThresholdTool({ getState: () => undefined, compactToolEnabled: () => true });
    expect((await absent.execute("2", { percent: 50 }, undefined, undefined, ctx())).details).toMatchObject({
      ok: false,
      reason: "no_session",
    });
  });
  it("rejects noninteractive mode", async () => {
    const tool = createSetCompactThresholdTool({ getState: () => state(), compactToolEnabled: () => true });
    expect(
      (await tool.execute("1", { percent: 50 }, undefined, undefined, ctx({ mode: "json" }))).details,
    ).toMatchObject({ reason: "non_interactive_mode" });
  });
});
