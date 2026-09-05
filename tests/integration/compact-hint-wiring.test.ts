import { describe, expect, it, vi } from "vitest";
import { createCompactHintHook, buildSessionStack, type CompactHintState, type Stack } from "../../src/stack.js";
import { DEFAULT_SETTINGS, type AgentSettings } from "../../src/config/settings.js";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { createSetCompactThresholdTool } from "../../src/tools/set-compact-threshold-tool.js";

function holder(state: CompactHintState) {
  return { current: { compactHint: state } as Stack };
}
function ctx(percent: number | null, mode = "interactive", hasUI = false, contextWindow = 200000, notify = vi.fn()) {
  return {
    mode,
    hasUI,
    getContextUsage: () => ({ percent, contextWindow, tokens: null }),
    ui: { notify },
  } as never;
}
function harness(initial: Partial<CompactHintState> = {}) {
  const state: CompactHintState = {
    thresholdPercent: 75,
    forceAtPercent: 88,
    reserveTokens: 16384,
    lastHintAt: 0,
    hintedAt: undefined,
    ...initial,
  };
  const sent: Array<{ message: Record<string, unknown>; options: Record<string, unknown> }> = [];
  let clock = 1;
  const hook = createCompactHintHook(
    { current: { compactHint: state } as Stack },
    {
      sendMessage: (message, options) => sent.push({ message, options }),
      now: () => clock,
    },
  );
  return {
    state,
    sent,
    hook,
    setNow: (value: number) => {
      clock = value;
    },
  };
}
function fakePi() {
  const sent: unknown[] = [];
  return {
    sent,
    pi: {
      sendMessage: (message: unknown) => sent.push(message),
      appendEntry: () => undefined,
      events: { emit: () => undefined, on: () => () => undefined },
      exec: async () => ({ code: 0, stdout: "", stderr: "", killed: false }),
    } as unknown as ExtensionAPI,
  };
}
function stackContext(cwd: string): ExtensionContext {
  return {
    cwd,
    sessionManager: { getEntries: () => [], getSessionId: () => "compact-test", getBranch: () => [] },
    modelRegistry: { getAvailable: () => [], find: () => undefined },
    ui: { notify: vi.fn() },
    hasUI: false,
    mode: "interactive",
  } as unknown as ExtensionContext;
}
const emptyTypes = { get: () => undefined, list: () => [], reload: async () => ({ types: [], errors: [] }) } as never;

describe("compact hint turn_end wiring", () => {
  it("sends once at the boundary and clears after falling below", () => {
    const state: CompactHintState = {
      thresholdPercent: 75,
      forceAtPercent: 88,
      reserveTokens: 16384,
      lastHintAt: 0,
      hintedAt: undefined,
    };
    const sent: unknown[] = [];
    let clock = 1;
    const hook = createCompactHintHook(holder(state), {
      sendMessage: (message) => sent.push(message),
      now: () => clock,
    });
    hook({}, ctx(75));
    hook({}, ctx(80));
    expect(sent).toHaveLength(1);
    hook({}, ctx(74));
    clock = 600_002;
    hook({}, ctx(80));
    expect(sent).toHaveLength(2);
  });
  it("does not send below threshold and exposes the exact message contract", () => {
    const h = harness();
    h.hook({}, ctx(40));
    expect(h.sent).toHaveLength(0);
    h.hook({}, ctx(75));
    expect(h.sent[0]).toMatchObject({
      message: { customType: "subagent:compact-hint", display: false, details: { thresholdPercent: 75 } },
      options: { triggerTurn: false },
    });
  });
  it("suppresses within cooldown and sends after the window", () => {
    const h = harness();
    h.hook({}, ctx(80));
    h.hook({}, ctx(74));
    h.setNow(599_999);
    h.hook({}, ctx(80));
    expect(h.sent).toHaveLength(1);
    h.setNow(600_001);
    h.hook({}, ctx(80));
    expect(h.sent).toHaveLength(2);
  });
  it("resets on zero, threshold changes, and the 82 -> 75 sequence", () => {
    const h = harness();
    h.hook({}, ctx(80));
    h.state.thresholdPercent = 0;
    h.state.hintedAt = undefined;
    h.state.lastHintAt = 0;
    h.setNow(600_001);
    h.state.thresholdPercent = 75;
    h.hook({}, ctx(80));
    expect(h.sent).toHaveLength(2);
    h.state.thresholdPercent = 82;
    h.state.hintedAt = undefined;
    h.state.lastHintAt = 0;
    h.hook({}, ctx(80));
    expect(h.sent).toHaveLength(2);
    h.hook({}, ctx(80));
    expect(h.sent).toHaveLength(2);
    h.state.thresholdPercent = 75;
    h.state.hintedAt = undefined;
    h.state.lastHintAt = 0;
    h.hook({}, ctx(80));
    expect(h.sent).toHaveLength(3);
  });
  it("handles window switching and effective-zero windows", () => {
    const h = harness({ forceAtPercent: 0 });
    h.hook({}, ctx(75, "interactive", false, 200000));
    h.setNow(600_001);
    h.hook({}, ctx(76, "interactive", false, 64000));
    expect(h.sent).toHaveLength(2);
    h.hook({}, ctx(76, "interactive", false, 64000));
    expect(h.sent).toHaveLength(2);
    h.hook({}, ctx(80, "interactive", false, 8000));
    expect(h.state.hintedAt).toBeUndefined();
    h.setNow(1_200_001);
    h.hook({}, ctx(80, "interactive", false, 200000));
    expect(h.sent).toHaveLength(3);
  });
  it("clears a placed latch on unknown usage and retries after send failure", () => {
    const h = harness();
    h.hook({}, ctx(80));
    expect(h.state.hintedAt).toBeDefined();
    h.hook({}, ctx(null));
    expect(h.state.hintedAt).toBeUndefined();
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const failed = harness();
    let fail = true;
    const retryHook = createCompactHintHook(
      { current: { compactHint: failed.state } as Stack },
      {
        sendMessage: () => {
          if (fail) throw new Error("offline");
        },
        now: () => 1,
      },
    );
    retryHook({}, ctx(80));
    expect(failed.state.hintedAt).toBeUndefined();
    expect(failed.state.lastHintAt).toBe(0);
    expect(warn).toHaveBeenCalled();
    fail = false;
    retryHook({}, ctx(80));
    expect(failed.state.hintedAt).toEqual({ effectivePercent: 75, contextWindow: 200000 });
    warn.mockRestore();
  });
  it("swallows notify errors after state is successfully placed", () => {
    const h = harness();
    const notify = vi.fn(() => {
      throw new Error("toast unavailable");
    });
    expect(() => h.hook({}, ctx(80, "interactive", true, 200000, notify))).not.toThrow();
    expect(h.state.hintedAt).toEqual({ effectivePercent: 75, contextWindow: 200000 });
    expect(h.state.lastHintAt).toBe(1);
  });
  it("respects mode, null usage, dynamic windows, and failed sends", () => {
    const state: CompactHintState = {
      thresholdPercent: 75,
      forceAtPercent: 88,
      reserveTokens: 16384,
      lastHintAt: 0,
      hintedAt: undefined,
    };
    const sendMessage = vi.fn(() => {
      throw new Error("offline");
    });
    const hook = createCompactHintHook(holder(state), { sendMessage, now: () => 100 });
    hook({}, ctx(80, "json"));
    hook({}, ctx(null));
    expect(sendMessage).not.toHaveBeenCalled();
    hook({}, ctx(80));
    expect(sendMessage).toHaveBeenCalledTimes(1);
    expect(state.hintedAt).toBeUndefined();
  });
  it("rebuilds the real stack and retargets the threshold tool", async () => {
    const cwd = "/tmp/pi-subagent-compact-test";
    const host = fakePi();
    const settings: AgentSettings = {
      ...DEFAULT_SETTINGS,
      fleetWidget: false,
      bashJobs: { ...DEFAULT_SETTINGS.bashJobs, autoBackgroundMs: 0 },
      compact: { enabled: true, hintThresholdPercent: 75, assumedReserveTokens: 16384 },
    };
    const holder: { current?: Stack } = {};
    const first = buildSessionStack(host.pi, stackContext(cwd), settings, emptyTypes, []);
    holder.current = first;
    expect(first.compactHint.thresholdPercent).toBe(75);
    expect(first.compactHint.reserveTokens).toBe(16384);
    const tool = createSetCompactThresholdTool({
      getState: () => holder.current?.compactHint,
      compactToolEnabled: () => true,
    });
    await tool.execute("1", { percent: 60 }, undefined, undefined, ctx(80));
    expect(first.compactHint.thresholdPercent).toBe(60);
    first.scheduler.stop();
    first.rpc.close();
    settings.compact = { enabled: true, hintThresholdPercent: 75, assumedReserveTokens: 32768 };
    const second = buildSessionStack(host.pi, stackContext(cwd), settings, emptyTypes, []);
    holder.current = second;
    expect(second.compactHint.thresholdPercent).toBe(75);
    expect(second.compactHint.reserveTokens).toBe(32768);
    await tool.execute("2", { percent: 50 }, undefined, undefined, ctx(80));
    expect(second.compactHint.thresholdPercent).toBe(50);
    expect(first.compactHint.thresholdPercent).toBe(60);
    second.scheduler.stop();
    second.rpc.close();
  });
  it("disabled compact settings start with a closed threshold", () => {
    const settings: AgentSettings = {
      ...DEFAULT_SETTINGS,
      fleetWidget: false,
      bashJobs: { ...DEFAULT_SETTINGS.bashJobs, autoBackgroundMs: 0 },
      compact: { enabled: false, hintThresholdPercent: 75, assumedReserveTokens: 16384 },
    };
    const stack = buildSessionStack(
      fakePi().pi,
      stackContext("/tmp/pi-subagent-compact-off"),
      settings,
      emptyTypes,
      [],
    );
    expect(stack.compactHint.thresholdPercent).toBe(0);
    stack.scheduler.stop();
    stack.rpc.close();
  });
  it("keeps the L1 latch independent from L2 force and rearms after fallback", () => {
    const state: CompactHintState = {
      thresholdPercent: 75,
      forceAtPercent: 88,
      reserveTokens: 16384,
      lastHintAt: 0,
      hintedAt: undefined,
    };
    const sent: unknown[] = [];
    const compact = vi.fn((options: { onComplete: () => void }) => options.onComplete());
    const resume = vi.fn();
    let clock = 1;
    const hook = createCompactHintHook(holder(state), {
      sendMessage: (message) => sent.push(message),
      sendUserMessage: resume,
      now: () => clock,
    });
    hook({}, { ...ctx(75), compact } as never);
    expect(sent).toHaveLength(1);
    hook({}, { ...ctx(88), compact } as never);
    expect(compact).toHaveBeenCalledOnce();
    hook({}, ctx(74));
    clock = 600_001;
    hook({}, ctx(75));
    expect(sent).toHaveLength(2);
    expect(resume).toHaveBeenCalledOnce();
  });

  it("keeps 87% below force, disables force at zero, and clamps force to the window cap", () => {
    const compact = vi.fn((options: { onComplete: () => void }) => options.onComplete());
    const make = (forceAtPercent: number) => {
      const state: CompactHintState = {
        thresholdPercent: 75,
        forceAtPercent,
        reserveTokens: 16384,
        lastHintAt: 0,
        hintedAt: undefined,
      };
      const hook = createCompactHintHook(
        { current: { compactHint: state } as Stack },
        { sendMessage: () => undefined, now: () => 1 },
      );
      return { state, hook };
    };
    const below = make(88);
    below.hook({}, { ...ctx(87), compact } as never);
    expect(compact).not.toHaveBeenCalled();
    const disabled = make(0);
    disabled.hook({}, { ...ctx(95), compact } as never);
    expect(compact).not.toHaveBeenCalled();
    const clamped = make(88);
    clamped.hook({}, { ...ctx(75, "interactive", false, 64000), compact } as never);
    expect(compact).toHaveBeenCalledOnce();
  });

  it("forces at 88%, resumes, and suppresses repeats during cooldown", () => {
    const state: CompactHintState = {
      thresholdPercent: 75,
      forceAtPercent: 88,
      reserveTokens: 16384,
      lastHintAt: 0,
      hintedAt: undefined,
    };
    const compact = vi.fn((options: { onComplete: () => void }) => options.onComplete());
    const resume = vi.fn();
    const forceContext = { ...ctx(88, "interactive", true), compact } as never;
    const hook = createCompactHintHook(
      { current: { compactHint: state } as Stack },
      {
        sendMessage: () => undefined,
        sendUserMessage: resume,
        now: () => 1,
      },
    );
    hook({}, forceContext);
    expect(compact).toHaveBeenCalledOnce();
    expect(resume).toHaveBeenCalledWith(expect.stringContaining("Context compaction completed successfully"));
    hook({}, forceContext);
    expect(compact).toHaveBeenCalledOnce();
  });

  it("does not toast when UI is unavailable and swallows toast errors", () => {
    const state: CompactHintState = {
      thresholdPercent: 75,
      forceAtPercent: 88,
      reserveTokens: 16384,
      lastHintAt: 0,
      hintedAt: undefined,
    };
    const hook = createCompactHintHook(holder(state), { sendMessage: () => undefined, now: () => 0 });
    expect(() => hook({}, ctx(80, "interactive", false))).not.toThrow();
    expect(state.hintedAt).toEqual({ effectivePercent: 75, contextWindow: 200000 });
  });
});
