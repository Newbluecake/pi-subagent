import { describe, expect, it, vi } from "vitest";
import { FakeClock } from "../../src/core/clock.js";
import { MemoryRunStore } from "../../src/core/store.js";
import type { DeadlineNotice, EffectEnvelope } from "../../src/core/types.js";
import type { SessionDriver, SessionHandle } from "../../src/runtime/session-driver.js";
import { BasicEffectInterpreter } from "../../src/runtime/runner.js";
import { EscalatingReaper } from "../../src/runtime/reaper.js";
import { SingleSlotPool } from "../../src/runtime/slot-pool.js";
import { EventWatchdog } from "../../src/runtime/watchdog.js";
import { DEFAULT_BUDGET } from "../../src/core/deadline.js";
import { createRuntimeRunnerAdapter, deadlineNoticeHandler } from "../../src/service/runtime-adapter.js";

function notice(runId: string, kind: DeadlineNotice["kind"] = "grace"): DeadlineNotice {
  return {
    kind,
    runId,
    generation: 1,
    at: 1_000,
    phase: "tool_exec",
    deadlineAt: 2_000,
    ...(kind === "grace"
      ? { graceUntil: 2_090, suggestedExtendMs: 60_000 }
      : { requestedMs: 60_000, grantedMs: 60_000 }),
    hardDeadlineAt: 4_000,
    extensionsUsed: 0,
    maxExtensions: 3,
  };
}

function envelope(runId: string, n: DeadlineNotice): EffectEnvelope {
  return { effectId: `e-${runId}`, effect: { kind: "notify_deadline", notice: n }, criticality: "best_effort" };
}

/**
 * RK-10: the notify_deadline handler is exercised by feeding hand-built
 * EffectEnvelopes into a BasicEffectInterpreter that registers ONLY that
 * handler — no reducer involvement, no it.skip; green regardless of Pkg A.
 */
describe("service/runtime-adapter: deadlineNoticeHandler (notify_deadline effect)", () => {
  it("drops notices for child runs (CC2 / D-8): children are owned by their parent run", () => {
    const sink = vi.fn();
    const interpreter = new BasicEffectInterpreter(
      { notify_deadline: deadlineNoticeHandler(new Set(["child-1"]), sink) },
      () => undefined,
    );
    interpreter.apply("child-1", 1, [envelope("child-1", notice("child-1"))]);
    expect(sink).not.toHaveBeenCalled();
  });

  it("forwards top-level run notices to the sink", () => {
    const sink = vi.fn();
    const interpreter = new BasicEffectInterpreter(
      { notify_deadline: deadlineNoticeHandler(new Set(), sink) },
      () => undefined,
    );
    const n = notice("top-1");
    interpreter.apply("top-1", 1, [envelope("top-1", n)]);
    expect(sink).toHaveBeenCalledTimes(1);
    expect(sink).toHaveBeenCalledWith(n);
  });

  it("ignores non-notify_deadline effects entirely", () => {
    const sink = vi.fn();
    const interpreter = new BasicEffectInterpreter(
      { notify_deadline: deadlineNoticeHandler(new Set(), sink) },
      () => undefined,
    );
    interpreter.apply("r1", 1, [
      { effectId: "e1", effect: { kind: "clear_timer", timer: "total" }, criticality: "critical" },
    ]);
    expect(sink).not.toHaveBeenCalled();
  });

  it("a missing sink is a silent no-op (notice loss degrades to pre-feature behavior, D-4)", () => {
    const interpreter = new BasicEffectInterpreter(
      { notify_deadline: deadlineNoticeHandler(new Set()) },
      () => undefined,
    );
    expect(() => interpreter.apply("r1", 1, [envelope("r1", notice("r1"))])).not.toThrow();
  });
});

describe("service/runtime-adapter: Runner.extendDeadline passthrough", () => {
  it("exposes extendDeadline and returns the runtime's verdict untouched (sync, D-9)", () => {
    const clock = new FakeClock();
    const adapter = createRuntimeRunnerAdapter({
      clock,
      pool: new SingleSlotPool(clock, 1),
      store: new MemoryRunStore(),
      watchdog: new EventWatchdog({
        clock,
        budget: DEFAULT_BUDGET,
        getState: () => undefined,
        dispatch: () => undefined,
      }),
      reaper: new EscalatingReaper(clock),
      notifier: {
        enqueue: vi.fn(),
        finalize: vi.fn(),
        settleBatch: vi.fn(),
        peek: vi.fn(),
        consume: vi.fn(),
        reconcile: vi.fn(),
        verifyPersisted: vi.fn(),
        stats: { staged: 0, pending: 0, batched: 0, delivered: 0, consumed: 0, dropped: 0, abandoned: 0 },
        degraded: [],
      },
      driver: {
        create: async (): Promise<SessionHandle> => ({
          sessionId: "s1",
          sessionFile: undefined,
          prompt: async () => undefined,
          steer: async () => undefined,
          requestAbort: async () => undefined,
          dispose: () => ({ returned: true, killed: 0, unkillable: [] }),
          killableHandles: new Set(),
          setActiveTools: () => undefined,
          getActiveTools: () => [],
          getLastAssistantText: () => "",
          getUsage: () => undefined,
        }),
        bind: async () => undefined,
        onLateArrival: () => undefined,
      } satisfies SessionDriver,
    });
    expect(typeof adapter.extendDeadline).toBe("function");
    const result = adapter.extendDeadline!("no-such-run", 60_000, { source: "tool", reason: "test" });
    // The verdict comes from RuntimeRunner itself: "unsupported" while the P0
    // stub is in place, "unknown_run" once Pkg A fills in the real method —
    // either way the adapter must pass it through unmodified.
    expect(result.ok).toBe(false);
    if (!result.ok) expect(["unsupported", "unknown_run"]).toContain(result.reason);
  });
});
