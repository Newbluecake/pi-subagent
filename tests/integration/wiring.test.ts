import { describe, expect, it } from "vitest";
import { FakeClock } from "../../src/core/clock.js";
import { DEFAULT_BUDGET } from "../../src/core/deadline.js";
import { MemoryOutboxStore, MemoryRunStore } from "../../src/core/store.js";
import type { AgentTypeConfig } from "../../src/core/types.js";
import { createNotifier, type PersistedDelivery } from "../../src/delivery/notifier.js";
import { EscalatingReaper } from "../../src/runtime/reaper.js";
import type { SessionDriver, SessionHandle } from "../../src/runtime/session-driver.js";
import { SingleSlotPool } from "../../src/runtime/slot-pool.js";
import { EventWatchdog } from "../../src/runtime/watchdog.js";
import { createLiveRunRegistry } from "../../src/service/run-registry.js";
import { createRuntimeRunnerAdapter } from "../../src/service/runtime-adapter.js";
import { createQueryService } from "../../src/service/query-service.js";
import { createSpawnService } from "../../src/service/spawn-service.js";

/**
 * True cross-layer wiring: a real SingleSlotPool, a real RuntimeRunner (via
 * createRuntimeRunnerAdapter) driven by a scripted (not mocked-away)
 * SessionDriver, a real EscalatingReaper, a real MemoryRunStore-backed
 * RunRegistry, a real Notifier over a real MemoryOutboxStore, and the real
 * SpawnService/QueryService façades — assembled exactly the way index.ts
 * assembles them. This is the first point where the independently-built
 * runtime/ and service/ layers are actually plugged into each other; any
 * interface mismatch between them (SessionSpec vs RunnerSpec, dead
 * RunnerDeps.store/emit/deliver fields, the dispatch-clobber hazard, etc.)
 * surfaces here, not in a mock.
 */
const never = <T>() => new Promise<T>(() => undefined);

function fastBudget() {
  return {
    ...DEFAULT_BUDGET,
    queueWaitMs: 200,
    startupMs: 200,
    bindMs: 200,
    firstEventMs: 200,
    idleMs: 200,
    toolMs: 200,
    totalMs: 500,
    abortGraceMs: 20,
    steerMs: 10,
    reapMs: 20,
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
    getLastAssistantText: () => "hello from subagent",
    getUsage: () => undefined,
    ...overrides,
  };
}

function buildStack(clock: FakeClock, driver: SessionDriver) {
  const pool = new SingleSlotPool(clock, 1);
  const store = new MemoryRunStore();
  const reaper = new EscalatingReaper(clock);
  const watchdog = new EventWatchdog({
    clock,
    budget: fastBudget(),
    getState: () => undefined,
    dispatch: () => undefined,
  });
  const outbox = new MemoryOutboxStore<PersistedDelivery>();
  const sent: PersistedDelivery[] = [];
  const notifier = createNotifier({
    store: outbox,
    clock,
    sender: (payload) => sent.push(payload as PersistedDelivery),
  });
  const runner = createRuntimeRunnerAdapter({ clock, driver, pool, store, watchdog, reaper, notifier });
  const type: AgentTypeConfig = { name: "worker", description: "worker", systemPrompt: "", promptMode: "append" };
  const types = {
    get: (name: string) => (name === "worker" ? type : undefined),
    list: () => [type],
    reload: async () => ({ types: [type], errors: [] }),
  };
  const spawnService = createSpawnService({ types, pool, runner, now: () => clock.now(), budget: fastBudget() });
  const registry = createLiveRunRegistry(spawnService, store);
  const queryService = createQueryService({ registry, runner, clock });
  return { pool, store, reaper, notifier, runner, spawnService, registry, queryService, sent };
}

async function drain(clock: FakeClock, ticks: number, stepMs = 1) {
  for (let i = 0; i < ticks; i++) {
    await Promise.resolve();
    clock.advance(stepMs);
    await Promise.resolve();
  }
}

describe("wiring: cross-layer smoke", () => {
  it("spawn -> complete -> notification delivered -> query returns the result", async () => {
    const clock = new FakeClock();
    const driver: SessionDriver = {
      create: async () => handle(),
      bind: async () => undefined,
      onLateArrival: () => undefined,
    };
    const stack = buildStack(clock, driver);

    const spawned = await stack.spawnService.spawn({ type: "worker", prompt: "do the thing" });
    if ("error" in spawned) throw new Error(spawned.error.message);

    await drain(clock, 30);

    const snapshot = stack.registry.get(spawned.runId);
    expect(snapshot?.status).toBe("completed");
    expect(snapshot?.outcome?.text).toBe("hello from subagent");

    // G5a: the terminal record actually landed in the shared SnapshotStore
    // (not just held in-process by SpawnService).
    expect(stack.store.get(spawned.runId)?.status).toBe("completed");

    // G5b: the completion notification was actually handed to the sender.
    expect(stack.sent.some((p) => p.runId === spawned.runId && p.status === "completed")).toBe(true);

    // QueryService.wait() must resolve with the same outcome via the shared registry.
    const waited = await stack.queryService.wait(spawned.runId, { waitMs: 1000 });
    expect(waited.ok).toBe(true);
    if (waited.ok) expect(waited.outcome.status).toBe("completed");

    // Slot must be fully released after settlement.
    expect(stack.pool.stats.inUse).toBe(0);
  });

  it("spawn hang -> deadline settles -> slot released -> notification still delivered", async () => {
    const clock = new FakeClock();
    const driver: SessionDriver = {
      create: async () => handle({ prompt: () => never() }),
      bind: async () => undefined,
      onLateArrival: () => undefined,
    };
    const stack = buildStack(clock, driver);

    const spawned = await stack.spawnService.spawn({ type: "worker", prompt: "hang forever" });
    if ("error" in spawned) throw new Error(spawned.error.message);

    await drain(clock, 600);

    const snapshot = stack.registry.get(spawned.runId);
    expect(snapshot?.status).toBe("timed_out");
    expect(snapshot?.diag.timeoutReason).toBe("total");

    // Slot released even though the driver's prompt() never resolves.
    expect(stack.pool.stats.inUse).toBe(0);
    expect(stack.pool.audit(new Set()).leaked).toEqual([]);

    // Notification is still delivered for a timed-out run (G5b applies to all terminal statuses).
    expect(stack.sent.some((p) => p.runId === spawned.runId && p.status === "timed_out")).toBe(true);

    // A second run must be able to acquire the now-released slot without deadlock.
    const driver2: SessionDriver = {
      create: async () => handle(),
      bind: async () => undefined,
      onLateArrival: () => undefined,
    };
    const stack2 = {
      ...stack,
      runner: createRuntimeRunnerAdapter({
        clock,
        driver: driver2,
        pool: stack.pool,
        store: stack.store,
        watchdog: new EventWatchdog({
          clock,
          budget: fastBudget(),
          getState: () => undefined,
          dispatch: () => undefined,
        }),
        reaper: stack.reaper,
        notifier: stack.notifier,
      }),
    };
    const spawnService2 = createSpawnService({
      types: {
        get: () => ({ name: "worker", description: "worker", systemPrompt: "", promptMode: "append" as const }),
        list: () => [],
        reload: async () => ({ types: [], errors: [] }),
      },
      pool: stack.pool,
      runner: stack2.runner,
      now: () => clock.now(),
      budget: fastBudget(),
    });
    const second = await spawnService2.spawn({ type: "worker", prompt: "should not deadlock" });
    if ("error" in second) throw new Error(second.error.message);
    await drain(clock, 60);
    expect(stack.registry.get(second.runId)?.status).toBe("completed");
  });

  it("a still-running run is visible to the registry (in-flight visibility regression)", async () => {
    const clock = new FakeClock();
    const driver: SessionDriver = {
      create: async () => handle({ prompt: () => never() }),
      bind: async () => undefined,
      onLateArrival: () => undefined,
    };
    const stack = buildStack(clock, driver);

    const spawned = await stack.spawnService.spawn({ type: "worker", prompt: "hang" });
    if ("error" in spawned) throw new Error(spawned.error.message);

    // Before any deadline fires, the in-flight run MUST be queryable —
    // a registry backed only by the durable store (terminal-only snapshots)
    // returns undefined here, which is how "unknown run_id" shipped.
    await drain(clock, 1);
    const live = stack.registry.get(spawned.runId);
    expect(live).toBeDefined();
    expect(["starting", "running"]).toContain(live!.status);

    await drain(clock, 600); // let the total deadline settle it
    expect(stack.registry.get(spawned.runId)?.status).toBe("timed_out");
  });
});
