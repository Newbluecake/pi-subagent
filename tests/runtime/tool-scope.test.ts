import { describe, expect, it } from "vitest";
import {
  RESERVED_TOOL_NAMES,
  buildToolScopePolicy,
  createToolScopeEnforcer,
  type ScopeSessionHandle,
} from "../../src/runtime/tool-scope.js";

function fakeHandle(initial: string[]): ScopeSessionHandle & { calls: string[][] } {
  let active = [...initial];
  const calls: string[][] = [];
  return {
    calls,
    getActiveTools: () => [...active],
    setActiveTools: (names) => {
      calls.push([...names]);
      active = [...names];
    },
  };
}

describe("runtime/tool-scope: buildToolScopePolicy", () => {
  it("denies every reserved name by default", () => {
    const policy = buildToolScopePolicy({});
    for (const n of RESERVED_TOOL_NAMES) expect(policy.deny.has(n)).toBe(true);
  });
  it("excludes explicitly granted reserved names from deny (the X3/X10 carve-out)", () => {
    const policy = buildToolScopePolicy({ granted: ["Agent"] });
    expect(policy.deny.has("Agent")).toBe(false);
    expect(policy.deny.has("get_subagent_result")).toBe(true);
  });
  it("undefined tools means no allow-list restriction (legacy behavior preserved)", () => {
    const policy = buildToolScopePolicy({});
    expect(policy.allow).toBeUndefined();
  });
  it("an explicit tools list becomes the allow-list, plus any granted names", () => {
    const policy = buildToolScopePolicy({ tools: ["Read", "Bash"], granted: ["StructuredOutput"] });
    expect(policy.allow).toEqual(new Set(["Read", "Bash", "StructuredOutput"]));
  });
});

describe("runtime/tool-scope: createToolScopeEnforcer (X11 late-registration guard)", () => {
  it("TS1: deny always wins, even without an explicit allow-list", () => {
    const handle = fakeHandle(["Read", "Bash", "Agent"]);
    const enforcer = createToolScopeEnforcer();
    const policy = buildToolScopePolicy({}); // no allow-list, Agent stays reserved/denied
    const decision = enforcer.onBind(handle, policy);
    expect(decision.applied).toEqual(["Bash", "Read"]);
    expect(decision.blockedNewcomers).toEqual(["Agent"]);
    expect(handle.calls).toEqual([["Bash", "Read"]]);
  });

  it("TS2: a tool that appears only at a later turn boundary (simulated MCP late registration) is still filtered by the allow-list, not just at bind time", () => {
    const handle = fakeHandle(["Read", "Bash"]);
    const enforcer = createToolScopeEnforcer();
    const policy = buildToolScopePolicy({ tools: ["Read", "Bash"] });
    const bindDecision = enforcer.onBind(handle, policy);
    expect(bindDecision.changed).toBe(false); // already exactly the allow-list, no churn
    expect(handle.calls).toEqual([]);

    // Simulate an MCP tool registering itself into the session's active set
    // after bind — the one-shot `tools` allowlist passed to createAgentSession
    // cannot see this; only the turn-boundary re-check can.
    (handle as unknown as { getActiveTools: () => string[] }).getActiveTools = () => ["Read", "Bash", "mcp_evil_tool"];
    const turnDecision = enforcer.onTurnBoundary(handle, policy);
    expect(turnDecision.applied).toEqual(["Bash", "Read"]);
    expect(turnDecision.blockedNewcomers).toEqual(["mcp_evil_tool"]);
    expect(turnDecision.changed).toBe(true);
    expect(handle.calls).toEqual([["Bash", "Read"]]); // setActiveTools actually called to strip it back out
  });

  it("TS4: blockedNewcomers are never silent — onBlocked fires with the exact names", () => {
    const handle = fakeHandle(["Read", "steer_subagent"]);
    const blocked: string[][] = [];
    const enforcer = createToolScopeEnforcer({ onBlocked: (names) => blocked.push([...names]) });
    enforcer.onBind(handle, buildToolScopePolicy({}));
    expect(blocked).toEqual([["steer_subagent"]]);
  });

  it("does not call setActiveTools again when the computed set is unchanged across turns (no per-turn churn)", () => {
    const handle = fakeHandle(["Read"]);
    const enforcer = createToolScopeEnforcer();
    const policy = buildToolScopePolicy({ tools: ["Read", "Bash"] }); // Bash simply never shows up, that's fine
    enforcer.onBind(handle, policy);
    enforcer.onTurnBoundary(handle, policy);
    enforcer.onTurnBoundary(handle, policy);
    expect(handle.calls.length).toBe(0); // ["Read"] was already the correct filtered set from turn 0
  });

  it("a granted reserved name (X3 nested Agent tool) survives the deny filter", () => {
    const handle = fakeHandle(["Read", "Agent"]);
    const enforcer = createToolScopeEnforcer();
    const policy = buildToolScopePolicy({ granted: ["Agent"] });
    const decision = enforcer.onBind(handle, policy);
    expect(decision.applied).toEqual(["Agent", "Read"]);
    expect(decision.blockedNewcomers).toEqual([]);
  });
});
