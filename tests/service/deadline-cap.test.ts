import { describe, expect, it } from "vitest";
import { FakeClock } from "../../src/core/clock.js";
import { DEFAULT_BUDGET } from "../../src/core/deadline.js";
import { MemoryRunStore } from "../../src/core/store.js";
import type { AgentTypeConfig, RunSnapshot, SubagentExtensionPoints } from "../../src/core/types.js";
import { EscalatingReaper } from "../../src/runtime/reaper.js";
import type { SessionDriver, SessionHandle } from "../../src/runtime/session-driver.js";
import { SingleSlotPool } from "../../src/runtime/slot-pool.js";
import { EventWatchdog } from "../../src/runtime/watchdog.js";
import { createRuntimeRunnerAdapter } from "../../src/service/runtime-adapter.js";
import { createSpawnService } from "../../src/service/spawn-service.js";
import type { RunnerSpec, SlotPool } from "../../src/service/ports.js";

/**
 * CC4 (workflow design §4.4.1 / §4.4.1.1): full-stack tests for the
 * `SpawnRequest.deadlineAt` absolute cap — WC12a (value assertion, not just
 * "was it passed"), WC12b (H2 delay makes the child die *earlier* than a
 * naive relative-only calculation would, and the test is sensitive to a
 * dropped field), WC12c (the three checkpoints occupy zero resources).
 *
 * Deliberately exercises the *real* seam (createSpawnService +
 * createRuntimeRunnerAdapter, or createRuntimeRunnerAdapter alone for the
 * adapter-only checkpoints) rather than calling core/state-machine.ts
 * directly — that's what makes this suite sensitive to a hop silently
 * dropping the field (the actual bug class CC4/FF4 exists to prevent).
 */
const type: AgentTypeConfig = { name: "worker", description: "worker", systemPrompt: "", promptMode: "append" };

function fastBudget(totalMs: number) {
  return {
    ...DEFAULT_BUDGET,
    queueWaitMs: 2_000,
    startupMs: 20_000,
    bindMs: 2_000,
    firstEventMs: 2_000,
    idleMs: 2_000,
    toolMs: 2_000,
    totalMs,
    abortGraceMs: 20,
    steerMs: 10,
    reapMs: 30,
  };
}
function handle(overrides: Partial<SessionHandle> = {}): SessionHandle {
  return {
    sessionId: "s1",
    sessionFile: undefined,
    prompt: () => Promise.resolve(),
    steer: () => Promise.resolve(),
    requestAbort: () => Promise.resolve(),
    dispose: () => ({ returned: true, killed: 0, unkillable: [] }),
    killableHandles: new Set(),
    setActiveTools: () => undefined,
    getActiveTools: () => [],
    getLastAssistantText: () => "hello",
    getUsage: () => undefined,
    ...overrides,
  };
}
const flatNotifier = {
  enqueue: () => undefined,
  consume: () => false,
  reconcile: () => ({ redelivered: [], suppressed: [], abandoned: [] }),
  verifyPersisted: () => ({ missing: [] }),
  stats: { pending: 0, delivered: 0, consumed: 0, dropped: 0, abandoned: 0 },
  degraded: [],
};
async function drain(clock: FakeClock, ticks: number, stepMs = 1) {
  for (let i = 0; i < ticks; i++) {
    await Promise.resolve();
    clock.advance(stepMs);
    await Promise.resolve();
  }
}
function buildFullStack(clock: FakeClock, driver: SessionDriver, extensions: SubagentExtensionPoints[] = []) {
  const pool = new SingleSlotPool(clock, 4);
  const store = new MemoryRunStore();
  const reaper = new EscalatingReaper(clock);
  const watchdog = new EventWatchdog({
    clock,
    budget: fastBudget(30_000),
    getState: () => undefined,
    dispatch: () => undefined,
  });
  const runner = createRuntimeRunnerAdapter({
    clock,
    driver,
    pool,
    store,
    watchdog,
    reaper,
    notifier: flatNotifier,
    extensions,
  });
  const types = {
    get: (name: string) => (name === "worker" ? type : undefined),
    list: () => [type],
    reload: async () => ({ types: [type], errors: [] }),
  };
  const snapshots: RunSnapshot[] = [];
  const svc = createSpawnService({
    types,
    pool,
    runner,
    now: () => clock.now(),
    onSnapshot: (s) => snapshots.push(s),
  });
  return { pool, store, svc, snapshots };
}

describe("CC4/WC12a: SpawnRequest.deadlineAt reaches the child's actual RunSnapshot.deadlines.deadlineAt", () => {
  it("a tighter deadlineAt wins over the relative budget (real value, not just 'was it passed')", async () => {
    const clock = new FakeClock();
    const driver: SessionDriver = {
      create: async () => handle(),
      bind: async () => undefined,
      onLateArrival: () => undefined,
    };
    const { svc, snapshots } = buildFullStack(clock, driver);

    const spawned = await svc.spawn({
      type: "worker",
      prompt: "x",
      budgetOverride: { totalMs: 10_000 },
      deadlineAt: 3_000,
    });
    if ("error" in spawned) throw new Error(spawned.error.message);
    await drain(clock, 40);

    const terminal = snapshots.filter((s) => s.runId === spawned.runId && s.status === "completed").at(-1);
    expect(terminal).toBeDefined();
    // raw = 0 + 10_000 = 10_000; cap = 3_000; min = 3_000 (FF5: real value, not a boolean).
    expect(terminal?.deadlines.deadlineAt).toBe(3_000);
  });

  it("omitting deadlineAt leaves the value bit-for-bit identical to the pre-CC4 relative-only calculation", async () => {
    const clock = new FakeClock();
    const driver: SessionDriver = {
      create: async () => handle(),
      bind: async () => undefined,
      onLateArrival: () => undefined,
    };
    const { svc, snapshots } = buildFullStack(clock, driver);

    const spawned = await svc.spawn({ type: "worker", prompt: "x", budgetOverride: { totalMs: 10_000 } });
    if ("error" in spawned) throw new Error(spawned.error.message);
    await drain(clock, 40);

    const terminal = snapshots.filter((s) => s.runId === spawned.runId && s.status === "completed").at(-1);
    expect(terminal?.deadlines.deadlineAt).toBe(10_000);
  });
});

describe("CC4/WC12b: an H2 delay cannot push the child's deadline past the absolute cap", () => {
  it("child dies no later than the absolute cap even though the H2-delayed relative deadline would be later", async () => {
    const clock = new FakeClock();
    const driver: SessionDriver = {
      create: async () => handle(),
      bind: async () => undefined,
      onLateArrival: () => undefined,
    };
    // H2 hook delays session-spec resolution by 3s of *simulated* wall time.
    const ext: SubagentExtensionPoints = {
      resolveSessionSpec: (s) => new Promise((resolve) => clock.setTimer(3_000, () => resolve(s))),
    };
    const { svc, snapshots } = buildFullStack(clock, driver, [ext]);

    clock.advance(1_000); // workflow derives this child at t=1000
    // "remaining budget" the (future) workflow would pass down: 4s relative.
    // Absolute workflow deadline (fixed, independent of derivation/H2 delay): t=5000.
    const spawned = await svc.spawn({
      type: "worker",
      prompt: "x",
      budgetOverride: { totalMs: 4_000 },
      deadlineAt: 5_000,
    });
    if ("error" in spawned) throw new Error(spawned.error.message);
    await drain(clock, 80, 100);

    const terminal = snapshots.filter((s) => s.runId === spawned.runId && s.status === "completed").at(-1);
    expect(terminal).toBeDefined();
    // Without the H2 delay this would already be 5000 (min(1000+4000, 5000)).
    // With the 3s delay, enqueue actually happens at t=4000, so the *naive*
    // relative-only deadline would be 4000+4000=8000 — this is exactly the
    // scenario CC4 exists for. The absolute cap must still win.
    expect(terminal?.deadlines.deadlineAt).toBe(5_000);
    expect(terminal?.deadlines.deadlineAt).not.toBe(8_000);
  });
});

describe("CC2: child runs (parentRunId set) are suppressed from the top-level notification outbox", () => {
  it("a top-level run still enqueues its completion notification", async () => {
    const clock = new FakeClock();
    const driver: SessionDriver = {
      create: async () => handle(),
      bind: async () => undefined,
      onLateArrival: () => undefined,
    };
    const enqueued: { runId: string }[] = [];
    const pool = new SingleSlotPool(clock, 4);
    const store = new MemoryRunStore();
    const reaper = new EscalatingReaper(clock);
    const watchdog = new EventWatchdog({
      clock,
      budget: fastBudget(30_000),
      getState: () => undefined,
      dispatch: () => undefined,
    });
    const runner = createRuntimeRunnerAdapter({
      clock,
      driver,
      pool,
      store,
      watchdog,
      reaper,
      notifier: { ...flatNotifier, enqueue: (p) => enqueued.push({ runId: p.runId }) },
    });
    const outcome = await runner.run({
      runId: "top-1",
      type,
      request: { type: "worker", prompt: "x" },
      budget: fastBudget(30_000),
    });
    expect(outcome.status).toBe("completed");
    expect(enqueued).toEqual([{ runId: "top-1" }]);
  });

  it("a child run (parentRunId set) does NOT enqueue a top-level completion notification (CC2 behavior change)", async () => {
    const clock = new FakeClock();
    const driver: SessionDriver = {
      create: async () => handle(),
      bind: async () => undefined,
      onLateArrival: () => undefined,
    };
    const enqueued: { runId: string }[] = [];
    const pool = new SingleSlotPool(clock, 4);
    const store = new MemoryRunStore();
    const reaper = new EscalatingReaper(clock);
    const watchdog = new EventWatchdog({
      clock,
      budget: fastBudget(30_000),
      getState: () => undefined,
      dispatch: () => undefined,
    });
    const runner = createRuntimeRunnerAdapter({
      clock,
      driver,
      pool,
      store,
      watchdog,
      reaper,
      notifier: { ...flatNotifier, enqueue: (p) => enqueued.push({ runId: p.runId }) },
    });
    const outcome = await runner.run({
      runId: "child-1",
      type,
      request: { type: "worker", prompt: "x", parentRunId: "top-1" },
      budget: fastBudget(30_000),
    });
    expect(outcome.status).toBe("completed");
    expect(enqueued).toEqual([]);
    // The terminal snapshot itself is unaffected — only the outbox is suppressed.
    expect(store.get("child-1")?.status).toBe("completed");
  });
});

describe("CC4/WC12c: an already-expired deadlineAt occupies zero resources at each of the three checkpoints", () => {
  it("① CP1 (SpawnService.spawn): no slot, no session, driver never touched", async () => {
    const clock = new FakeClock();
    let createCalled = false;
    const driver: SessionDriver = {
      create: async () => {
        createCalled = true;
        return handle();
      },
      bind: async () => undefined,
      onLateArrival: () => undefined,
    };
    const { svc, pool } = buildFullStack(clock, driver);

    const result = await svc.spawn({ type: "worker", prompt: "x", deadlineAt: -1 });
    expect(result).toEqual({ error: { kind: "config", message: "deadlineAt already expired", retryable: false } });
    expect(createCalled).toBe(false);
    expect(pool.stats.inUse).toBe(0);
  });

  it("② CP2 (runtime-adapter.run entry): H2 hook never invoked, terminal snapshot + lifecycle still emitted", async () => {
    const clock = new FakeClock();
    let h2Called = false;
    let createCalled = false;
    const driver: SessionDriver = {
      create: async () => {
        createCalled = true;
        return handle();
      },
      bind: async () => undefined,
      onLateArrival: () => undefined,
    };
    const ext: SubagentExtensionPoints = {
      resolveSessionSpec: (s) => {
        h2Called = true;
        return s;
      },
    };
    const pool = new SingleSlotPool(clock, 1);
    const store = new MemoryRunStore();
    const reaper = new EscalatingReaper(clock);
    const watchdog = new EventWatchdog({
      clock,
      budget: fastBudget(30_000),
      getState: () => undefined,
      dispatch: () => undefined,
    });
    let lifecycleEvent: unknown;
    const runner = createRuntimeRunnerAdapter({
      clock,
      driver,
      pool,
      store,
      watchdog,
      reaper,
      notifier: flatNotifier,
      extensions: [ext],
      onLifecycle: (e) => {
        lifecycleEvent = e;
      },
    });
    const spec: RunnerSpec = {
      runId: "r-cp2",
      type,
      request: { type: "worker", prompt: "x", deadlineAt: -1 },
      budget: fastBudget(30_000),
    };
    const outcome = await runner.run(spec);

    expect(outcome.status).toBe("failed");
    expect(outcome.error?.kind).toBe("config");
    expect(outcome.error?.message).toContain("already expired");
    expect(h2Called).toBe(false);
    expect(createCalled).toBe(false);
    expect(pool.stats.inUse).toBe(0);
    expect(store.get("r-cp2")?.status).toBe("failed"); // observability not lost (settleConfigFailure)
    expect(lifecycleEvent).toMatchObject({ runId: "r-cp2", status: "failed" });
  });

  it("③ CP3 (state-machine enqueued branch): an H2 delay that expires the cap itself never reaches pool.acquire", async () => {
    const clock = new FakeClock();
    let createCalled = false;
    const driver: SessionDriver = {
      create: async () => {
        createCalled = true;
        return handle();
      },
      bind: async () => undefined,
      onLateArrival: () => undefined,
    };
    // H2 delays 3s; the absolute cap (2s out) expires *during* the delay —
    // i.e. it was still valid at CP1/CP2 time (t=0), but not by the time the
    // state machine actually enqueues (t=3000 > cap=2000).
    const ext: SubagentExtensionPoints = {
      resolveSessionSpec: (s) => new Promise((resolve) => clock.setTimer(3_000, () => resolve(s))),
    };
    let acquireCalled = false;
    const pool: SlotPool = {
      acquire: async (runId) => {
        acquireCalled = true;
        return { ok: true, ticket: { runId, release() {} } };
      },
    };
    const store = new MemoryRunStore();
    const reaper = new EscalatingReaper(clock);
    const watchdog = new EventWatchdog({
      clock,
      budget: fastBudget(30_000),
      getState: () => undefined,
      dispatch: () => undefined,
    });
    const runner = createRuntimeRunnerAdapter({
      clock,
      driver,
      pool,
      store,
      watchdog,
      reaper,
      notifier: flatNotifier,
      extensions: [ext],
    });
    const spec: RunnerSpec = {
      runId: "r-cp3",
      type,
      request: { type: "worker", prompt: "x", deadlineAt: 2_000 },
      budget: fastBudget(30_000),
    };
    const p = runner.run(spec);
    await drain(clock, 80, 100);
    const outcome = await p;

    expect(outcome.status).toBe("failed");
    expect(outcome.error?.kind).toBe("config");
    expect(outcome.error?.message).toContain("already expired");
    expect(acquireCalled).toBe(false);
    expect(createCalled).toBe(false);
  });
});
