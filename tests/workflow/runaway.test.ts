import { describe, expect, it, vi } from "vitest";
import { FakeClock } from "../../src/core/clock.js";
import { assertHeartbeatBudgetInvariant, startRunawayWatchdog } from "../../src/workflow/runaway.js";
import type { WorkerHost, WorkflowHeartbeatDiag } from "../../src/workflow/types.js";

function fakeWorkerHost(readHeartbeat: () => WorkflowHeartbeatDiag): WorkerHost {
  return {
    boot: vi.fn(),
    lifecycle: "ready",
    epoch: 0,
    readHeartbeat,
    postCancel: vi.fn(),
    terminate: vi.fn(),
    events: {
      onMetaError: vi.fn(),
      onLog: vi.fn(),
      onScriptReturned: vi.fn(),
      onScriptThrew: vi.fn(),
      onExit: vi.fn(),
      onError: vi.fn(),
    },
    stats: { lateMessages: 0, terminateForced: 0 },
  };
}

describe("HB1: heartbeat budget invariant", () => {
  it("rejects a configuration where heartbeatStallMs does not exceed scriptSliceMs + 2*heartbeatMs", () => {
    expect(() => assertHeartbeatBudgetInvariant(2_000, 2_000, 250)).toThrow(/HB1 violated/);
  });
  it("accepts a configuration that respects the inequality", () => {
    expect(() => assertHeartbeatBudgetInvariant(2_000, 10_000, 250)).not.toThrow();
  });
});

describe("runaway watchdog (§2.3 P2 — diagnostic, not a termination guarantee)", () => {
  it("HB2: diagnose_only never calls onRunaway, no matter how stalled the heartbeat looks", () => {
    const clock = new FakeClock();
    let stalledMs = 0;
    const host = fakeWorkerHost(() => ({ seq: 1, observedAt: clock.now(), stalledMs }));
    const onRunaway = vi.fn();
    const onTick = vi.fn();
    startRunawayWatchdog({
      clock,
      workerHost: host,
      heartbeatMs: 100,
      heartbeatStallMs: 500,
      policy: "diagnose_only",
      onTick,
      onRunaway,
    });
    stalledMs = 10_000; // way past the threshold
    clock.advance(5_000);
    expect(onRunaway).not.toHaveBeenCalled();
    expect(onTick).toHaveBeenCalled();
  });

  it("terminate_on_stall fires onRunaway exactly once, edge-triggered, once stalledMs crosses heartbeatStallMs", () => {
    const clock = new FakeClock();
    let stalledMs = 0;
    const host = fakeWorkerHost(() => ({ seq: 1, observedAt: clock.now(), stalledMs }));
    const onRunaway = vi.fn();
    startRunawayWatchdog({
      clock,
      workerHost: host,
      heartbeatMs: 100,
      heartbeatStallMs: 500,
      policy: "terminate_on_stall",
      onRunaway,
    });
    // Not yet stalled enough.
    stalledMs = 100;
    clock.advance(300);
    expect(onRunaway).not.toHaveBeenCalled();
    // Now cross the threshold.
    stalledMs = 600;
    clock.advance(200);
    expect(onRunaway).toHaveBeenCalledTimes(1);
    // Keep advancing: must not fire again (edge-triggered, and polling stops after firing).
    clock.advance(10_000);
    expect(onRunaway).toHaveBeenCalledTimes(1);
  });

  it("stop() cancels the watchdog's timer (no dangling FakeClock timers)", () => {
    const clock = new FakeClock();
    const host = fakeWorkerHost(() => ({ seq: 1, observedAt: clock.now(), stalledMs: 0 }));
    const handle = startRunawayWatchdog({
      clock,
      workerHost: host,
      heartbeatMs: 100,
      heartbeatStallMs: 500,
      policy: "diagnose_only",
      onRunaway: vi.fn(),
    });
    expect(clock.pendingTimers).toBe(1);
    handle.stop();
    expect(clock.pendingTimers).toBe(0);
  });

  it("heartbeatMs<=0 disables the watchdog entirely (no timer armed, stop() is a no-op)", () => {
    const clock = new FakeClock();
    const host = fakeWorkerHost(() => ({ seq: 0, observedAt: clock.now(), stalledMs: 0 }));
    const handle = startRunawayWatchdog({
      clock,
      workerHost: host,
      heartbeatMs: 0,
      heartbeatStallMs: 500,
      policy: "terminate_on_stall",
      onRunaway: vi.fn(),
    });
    expect(clock.pendingTimers).toBe(0);
    expect(() => handle.stop()).not.toThrow();
  });
});
