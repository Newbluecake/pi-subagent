import { describe, expect, it } from "vitest";
import { DEFAULT_BUDGET } from "../../src/core/deadline.js";
import { createInitialState, reduce, TOOL_HISTORY_CAP } from "../../src/core/state-machine.js";
import type { DriverEvent, RunInput, RunState } from "../../src/core/types.js";
import { previewToolArgs } from "../../src/runtime/session-driver.js";

const budget = { ...DEFAULT_BUDGET, totalMs: 60_000, queueWaitMs: 1_000 };

function apply(s: RunState, input: RunInput): RunState {
  return reduce(s, { generation: s.generation, input }, budget).state;
}
function sessionEvent(s: RunState, event: DriverEvent, at: number): RunState {
  return apply(s, { kind: "session_event", at, event });
}
/** Drive a fresh run into model_turn so tool events are legal. */
function runningState(meta?: Extract<RunInput, { kind: "enqueued" }>["meta"]): RunState {
  let s = createInitialState("r", 1, 0);
  s = apply(s, { kind: "enqueued", at: 0, budget, ...(meta ? { meta } : {}) });
  s = apply(s, { kind: "slot_acquired", at: 1 });
  s = apply(s, { kind: "phase_entered", at: 2, phase: "session_create" });
  s = apply(s, { kind: "session_created", at: 3, sessionId: "s1" });
  s = apply(s, { kind: "phase_entered", at: 4, phase: "extension_bind" });
  s = apply(s, { kind: "phase_entered", at: 5, phase: "prompt_dispatch" });
  s = sessionEvent(s, { t: "turn_start" }, 6); // prompt_dispatch → model_turn
  return s;
}

describe("M-A: display meta at enqueue", () => {
  it("folds model/label/agentType into diag exactly once", () => {
    const s = runningState({
      model: { provider: "copilot-completion", id: "kimi-k3" },
      label: "重构用户模块",
      agentType: "architect",
    });
    expect(s.diag.model).toEqual({ provider: "copilot-completion", id: "kimi-k3" });
    expect(s.diag.label).toBe("重构用户模块");
    expect(s.diag.agentType).toBe("architect");
  });

  it("leaves meta fields absent when not provided", () => {
    const s = runningState();
    expect(s.diag.model).toBeUndefined();
    expect(s.diag.label).toBeUndefined();
    expect(s.diag.agentType).toBeUndefined();
  });

  it("session_created carries the actual session model — fills the default case and overrides spawn-time meta", () => {
    // no spawn-time model → session_created fills it
    let s = createInitialState("r", 1, 0);
    s = apply(s, { kind: "enqueued", at: 0, budget });
    s = apply(s, { kind: "slot_acquired", at: 1 });
    s = apply(s, { kind: "phase_entered", at: 2, phase: "session_create" });
    s = apply(s, { kind: "session_created", at: 3, sessionId: "s1", model: { provider: "pi", id: "default-model" } });
    expect(s.diag.model).toEqual({ provider: "pi", id: "default-model" });
    // spawn-time meta present → actual session model still wins (ground truth)
    let t = createInitialState("r2", 1, 0);
    t = apply(t, { kind: "enqueued", at: 0, budget, meta: { model: { provider: "cfg", id: "configured" } } });
    t = apply(t, { kind: "slot_acquired", at: 1 });
    t = apply(t, { kind: "phase_entered", at: 2, phase: "session_create" });
    t = apply(t, { kind: "session_created", at: 3, sessionId: "s2", model: { provider: "pi", id: "actual" } });
    expect(t.diag.model).toEqual({ provider: "pi", id: "actual" });
    // session_created without model keeps the spawn-time value
    let u = createInitialState("r3", 1, 0);
    u = apply(u, { kind: "enqueued", at: 0, budget, meta: { model: { provider: "cfg", id: "configured" } } });
    u = apply(u, { kind: "slot_acquired", at: 1 });
    u = apply(u, { kind: "phase_entered", at: 2, phase: "session_create" });
    u = apply(u, { kind: "session_created", at: 3, sessionId: "s3" });
    expect(u.diag.model).toEqual({ provider: "cfg", id: "configured" });
  });
});

describe("M-A: tool trail (toolHistory / toolCounts)", () => {
  it("records start/end with argsPreview, duration ordering and error flag", () => {
    let s = runningState();
    s = sessionEvent(s, { t: "tool_start", toolCallId: "c1", toolName: "bash", argsPreview: "ls -la" }, 10);
    expect(s.phase).toBe("tool_exec");
    expect(s.diag.toolHistory).toEqual([
      { name: "bash", toolCallId: "c1", startedAt: 10, argsPreview: "ls -la" },
    ]);
    s = sessionEvent(s, { t: "tool_end", toolCallId: "c1", toolName: "bash", isError: true }, 22);
    expect(s.diag.toolHistory).toEqual([
      { name: "bash", toolCallId: "c1", startedAt: 10, endedAt: 22, isError: true, argsPreview: "ls -la" },
    ]);
    expect(s.diag.toolCounts).toEqual({ bash: 1 });
  });

  it("counts per tool name across multiple calls", () => {
    let s = runningState();
    for (const [i, name] of ["bash", "read", "bash"].entries()) {
      s = sessionEvent(s, { t: "tool_start", toolCallId: `c${i}`, toolName: name }, 10 + i * 10);
      s = sessionEvent(s, { t: "tool_end", toolCallId: `c${i}`, toolName: name, isError: false }, 15 + i * 10);
    }
    expect(s.diag.toolCounts).toEqual({ bash: 2, read: 1 });
    expect(s.diag.toolHistory).toHaveLength(3);
  });

  it("caps toolHistory at TOOL_HISTORY_CAP while toolCounts keeps the full total", () => {
    let s = runningState();
    const n = TOOL_HISTORY_CAP + 5;
    for (let i = 0; i < n; i++) {
      s = sessionEvent(s, { t: "tool_start", toolCallId: `c${i}`, toolName: "bash" }, 10 + i * 2);
      s = sessionEvent(s, { t: "tool_end", toolCallId: `c${i}`, toolName: "bash", isError: false }, 11 + i * 2);
    }
    expect(s.diag.toolHistory).toHaveLength(TOOL_HISTORY_CAP);
    expect(s.diag.toolHistory![0]!.toolCallId).toBe(`c${n - TOOL_HISTORY_CAP}`);
    expect(s.diag.toolCounts).toEqual({ bash: n });
  });

  it("tool_end for a ring-evicted record is a safe no-op", () => {
    let s = runningState();
    s = sessionEvent(s, { t: "tool_start", toolCallId: "gone", toolName: "bash" }, 10);
    // evict "gone" by flooding the ring
    for (let i = 0; i < TOOL_HISTORY_CAP; i++) {
      s = sessionEvent(s, { t: "tool_start", toolCallId: `c${i}`, toolName: "read" }, 20 + i);
    }
    const before = s.diag.toolHistory;
    s = sessionEvent(s, { t: "tool_end", toolCallId: "gone", toolName: "bash", isError: false }, 99);
    expect(s.diag.toolHistory).toEqual(before);
  });

  it("parallel tool_start while already in tool_exec is still recorded", () => {
    let s = runningState();
    s = sessionEvent(s, { t: "tool_start", toolCallId: "a", toolName: "bash" }, 10);
    expect(s.phase).toBe("tool_exec");
    s = sessionEvent(s, { t: "tool_start", toolCallId: "b", toolName: "read" }, 11);
    expect(s.diag.toolHistory?.map((r) => r.toolCallId)).toEqual(["a", "b"]);
    expect(s.diag.toolCounts).toEqual({ bash: 1, read: 1 });
  });
});

describe("M-A: previewToolArgs", () => {
  it("prefers the informative scalar field", () => {
    expect(previewToolArgs({ command: "npm test", timeout: 5 })).toBe("npm test");
    expect(previewToolArgs({ path: "/tmp/x.ts" })).toBe("/tmp/x.ts");
  });
  it("falls back to compact JSON and collapses whitespace", () => {
    expect(previewToolArgs({ n: 1 })).toBe('{"n":1}');
    expect(previewToolArgs("a\n  b")).toBe("a b");
  });
  it("truncates to the cap with an ellipsis", () => {
    const out = previewToolArgs({ command: "x".repeat(200) })!;
    expect(out.length).toBe(80);
    expect(out.endsWith("…")).toBe(true);
  });
  it("returns undefined for empty/unstringifiable input", () => {
    expect(previewToolArgs(undefined)).toBeUndefined();
    expect(previewToolArgs("   ")).toBeUndefined();
    const cyclic: Record<string, unknown> = {};
    cyclic["self"] = cyclic;
    expect(previewToolArgs(cyclic)).toBeUndefined();
  });
});
