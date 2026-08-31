import { describe, expect, it } from "vitest";
import { DEFAULT_BUDGET } from "../../src/core/deadline.js";
import { createInitialState, reduce } from "../../src/core/state-machine.js";
import type { RunState, StampedInput, UsageDelta } from "../../src/core/types.js";

/**
 * X9: usage/cost aggregation is a lifetime accumulator over every
 * message_end event seen for a run (architecture §7.2), independent of
 * session-level stats (which pi resets across compaction). These tests drive
 * `reduce()` directly with a scripted sequence of session_event inputs and
 * assert the accumulator sums correctly, including across a compaction
 * window and after the run has already reached a terminal status.
 */
const budget = { ...DEFAULT_BUDGET, totalMs: 10_000, queueWaitMs: 1_000, startupMs: 1_000, bindMs: 1_000 };

function usage(input: number, output: number, costUsd = 0): UsageDelta {
  return { input, output, cacheRead: 0, cacheWrite: 0, costUsd };
}
function apply(state: RunState, input: StampedInput["input"], at: number): RunState {
  return reduce(state, { generation: state.generation, input: { ...input, at } as StampedInput["input"] }, budget)
    .state;
}
/** Drives a run from `created` through `slot_acquired` + `session_created` into `model_turn`, ready to receive message_end events. */
function runningState(): RunState {
  let s = createInitialState("r", 1, 0);
  s = apply(s, { kind: "enqueued", budget } as never, 0);
  s = apply(s, { kind: "slot_acquired" } as never, 1);
  s = apply(s, { kind: "phase_entered", phase: "session_create" } as never, 2);
  s = apply(s, { kind: "session_created", sessionId: "s" } as never, 3);
  s = apply(s, { kind: "phase_entered", phase: "extension_bind" } as never, 4);
  s = apply(s, { kind: "session_event", event: { t: "turn_start" } } as never, 5);
  return s;
}

describe("X9 usage accumulation", () => {
  it("sums a single message_end delta into diag.usage", () => {
    const s = apply(
      runningState(),
      { kind: "session_event", event: { t: "message_end", usage: usage(10, 5, 0.01) } } as never,
      6,
    );
    expect(s.diag.usage).toEqual(usage(10, 5, 0.01));
  });

  it("sums multiple message_end deltas across turns/tool calls", () => {
    let s = runningState();
    s = apply(s, { kind: "session_event", event: { t: "message_end", usage: usage(10, 5, 0.01) } } as never, 6);
    s = apply(s, { kind: "session_event", event: { t: "tool_start", toolCallId: "t1", toolName: "bash" } } as never, 7);
    s = apply(s, { kind: "session_event", event: { t: "tool_end", toolCallId: "t1", isError: false } } as never, 8);
    s = apply(s, { kind: "session_event", event: { t: "message_end", usage: usage(20, 8, 0.02) } } as never, 9);
    expect(s.diag.usage).toEqual(usage(30, 13, 0.03));
  });

  it("keeps summing across compaction (does not reset like session-level stats would)", () => {
    let s = runningState();
    s = apply(s, { kind: "session_event", event: { t: "message_end", usage: usage(100, 40, 0.1) } } as never, 6);
    s = apply(s, { kind: "session_event", event: { t: "compaction_start", reason: "context_limit" } } as never, 7);
    // A message_end that lands *during* compaction (e.g. the summarization
    // turn itself) must still be summed, not treated as a fresh baseline.
    s = apply(s, { kind: "session_event", event: { t: "message_end", usage: usage(5, 50, 0.05) } } as never, 8);
    s = apply(s, { kind: "session_event", event: { t: "compaction_end", aborted: false } } as never, 9);
    s = apply(s, { kind: "session_event", event: { t: "message_end", usage: usage(10, 4, 0.01) } } as never, 10);
    expect(s.diag.usage).toMatchObject({ input: 115, output: 94, cacheRead: 0, cacheWrite: 0 });
    expect(s.diag.usage?.costUsd).toBeCloseTo(0.16, 10);
  });

  it("carries the accumulated usage into RunOutcome.usage on finish()", () => {
    let s = runningState();
    s = apply(s, { kind: "session_event", event: { t: "message_end", usage: usage(7, 3, 0.007) } } as never, 6);
    s = apply(s, { kind: "prompt_settled" } as never, 7);
    expect(s.status).toBe("completed");
    expect(s.outcome?.usage).toEqual(usage(7, 3, 0.007));
  });

  it("keeps accumulating a late message_end that arrives after the run is already terminal", () => {
    let s = runningState();
    s = apply(s, { kind: "session_event", event: { t: "message_end", usage: usage(7, 3, 0.007) } } as never, 6);
    s = apply(s, { kind: "prompt_settled" } as never, 7);
    expect(s.outcome?.usage).toEqual(usage(7, 3, 0.007));
    // Trailing event during abort/reap teardown after settle.
    s = apply(s, { kind: "session_event", event: { t: "message_end", usage: usage(1, 1, 0.001) } } as never, 8);
    expect(s.diag.usage).toEqual(usage(8, 4, 0.008));
    expect(s.outcome?.usage).toEqual(usage(8, 4, 0.008));
  });

  it("does not fabricate a usage object when message_end carries no usage field", () => {
    const s = apply(runningState(), { kind: "session_event", event: { t: "message_end" } } as never, 6);
    expect(s.diag.usage).toBeUndefined();
  });

  it("leaves RunOutcome.usage absent (not present as an explicit undefined key) when no usage was ever observed", () => {
    let s = runningState();
    s = apply(s, { kind: "prompt_settled" } as never, 7);
    expect(s.outcome?.usage).toBeUndefined();
    expect(Object.prototype.hasOwnProperty.call(s.outcome ?? {}, "usage")).toBe(false);
  });
});
