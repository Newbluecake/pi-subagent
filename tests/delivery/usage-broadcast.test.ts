import { describe, expect, it } from "vitest";
import { FakeClock } from "../../src/core/clock.js";
import type { RunDiagnostics, RunSnapshot } from "../../src/core/types.js";
import { buildUsageEvent, UsageBroadcaster, type SubagentUsageEvent } from "../../src/delivery/usage-broadcast.js";

function diag(overrides: Partial<RunDiagnostics> = {}): RunDiagnostics {
  return {
    createdAt: 0,
    phase: "model_turn",
    phaseEnteredAt: 0,
    pendingTools: 0,
    turns: 1,
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
    runId: "r1",
    generation: 1,
    status: "running",
    phase: "model_turn",
    deadlines: { enqueuedAt: 0, deadlineAt: undefined, queueDeadlineAt: undefined },
    diag: diag(),
    updatedAt: 0,
    ...overrides,
  };
}
const usage = (costUsd: number) => ({ input: 1, output: 1, cacheRead: 0, cacheWrite: 0, costUsd });

describe("M-E: buildUsageEvent", () => {
  it("lists every run with lifetime cost, label and terminal flag; sums active cost only", () => {
    const event = buildUsageEvent(
      [
        snapshot({ runId: "a", diag: diag({ usage: usage(0.1), label: "任务A" }) }),
        snapshot({ runId: "b", status: "completed", phase: "settled", diag: diag({ usage: usage(0.2) }) }),
        snapshot({ runId: "c" }), // no usage yet
      ],
      5_000,
    );
    expect(event.at).toBe(5_000);
    expect(event.runs).toEqual([
      { runId: "a", label: "任务A", costUsd: 0.1, terminal: false },
      { runId: "b", costUsd: 0.2, terminal: true },
      { runId: "c", costUsd: 0, terminal: false },
    ]);
    expect(event.activeCostUsd).toBeCloseTo(0.1);
  });
});

describe("M-E: UsageBroadcaster ticker", () => {
  function harness(initial: RunSnapshot[]) {
    const clock = new FakeClock(0);
    const runs = { list: initial };
    const events: SubagentUsageEvent[] = [];
    const broadcaster = new UsageBroadcaster({
      list: () => [...runs.list],
      emit: (e) => events.push(e),
      clock,
    });
    return { clock, runs, events, broadcaster };
  }

  it("poke emits immediately and ticks at 1Hz while a run is active", () => {
    const { clock, events, broadcaster } = harness([snapshot()]);
    broadcaster.poke();
    expect(events).toHaveLength(1);
    clock.advance(3_000);
    expect(events).toHaveLength(4);
    broadcaster.dispose();
  });

  it("stops itself after emitting the final all-terminal frame", () => {
    const { clock, runs, events, broadcaster } = harness([snapshot()]);
    broadcaster.poke();
    clock.advance(1_000);
    runs.list = [snapshot({ status: "completed", phase: "settled", diag: diag({ usage: usage(0.3) }) })];
    clock.advance(1_000); // emits the terminal frame, does not re-arm
    const frames = events.length;
    expect(events[events.length - 1]!.runs[0]).toMatchObject({ terminal: true, costUsd: 0.3 });
    expect(clock.pendingTimers).toBe(0);
    clock.advance(10_000);
    expect(events).toHaveLength(frames);
  });

  it("poke on an idle fleet emits one frame and does not arm a timer", () => {
    const { clock, events, broadcaster } = harness([snapshot({ status: "completed", phase: "settled" })]);
    broadcaster.poke();
    expect(events).toHaveLength(1);
    expect(clock.pendingTimers).toBe(0);
    broadcaster.dispose();
  });

  it("dispose stops the tick; a throwing emit goes silent instead of propagating", () => {
    const clock = new FakeClock(0);
    const broadcaster = new UsageBroadcaster({
      list: () => [snapshot()],
      emit: () => {
        throw new Error("bus gone");
      },
      clock,
    });
    expect(() => broadcaster.poke()).not.toThrow();
    expect(clock.pendingTimers).toBe(0); // emit threw → treated as inactive, no tick armed
    broadcaster.dispose();
    expect(() => broadcaster.poke()).not.toThrow();
  });
});
