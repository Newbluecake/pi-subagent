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
import { createSpawnService, type SpawnService } from "../../src/service/spawn-service.js";
import { createCallRegistry } from "../../src/workflow/call-registry.js";

/**
 * M3.4 mandatory item #2 ("A2 窗口加固"): this suite exercises
 * `src/workflow/call-registry.ts`'s A2 bounded-retry cancel loop against the
 * *real* `SpawnService`/`RuntimeRunner` stack (not a fake `abort()` double),
 * to verify the workflow side's retry semantics genuinely line up with the
 * real service's A2 contract documented in `src/service/spawn-service.ts`
 * (`abort()`'s `!running.has(runId)` guard) and
 * `src/runtime/runner.ts` (`abortRun()`'s `activeCancels` guard, which
 * returns `{ ok: false, escalatedTo: "L4" }` for as long as an H2
 * `resolveSessionSpec` extension hook is still pending).
 *
 * Reuses the exact full-stack harness pattern `tests/service/deadline-cap.test.ts`
 * already established for CC4 (real `createSpawnService` +
 * `createRuntimeRunnerAdapter` + `SingleSlotPool` + a fake `SessionDriver`) —
 * this file only *reads* those modules, it does not modify anything outside
 * `src/workflow/**`/`tests/workflow/**`.
 */

const type: AgentTypeConfig = { name: "worker", description: "worker", systemPrompt: "", promptMode: "append" };

function fastBudget(totalMs: number) {
  return {
    ...DEFAULT_BUDGET,
    queueWaitMs: 2_000,
    startupMs: 5_000,
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
  const svc: SpawnService & { snapshots(): readonly RunSnapshot[] } = createSpawnService({
    types,
    pool,
    runner,
    now: () => clock.now(),
  });
  return { pool, store, svc };
}

describe("A2 window alignment: workflow CallRegistry retry vs the real SpawnService/RuntimeRunner (§7.1)", () => {
  it("real abort() returns false throughout the H2 resolveSessionSpec delay (activeCancels not yet registered), then true once RuntimeRunner.run() begins — matches §7.1's A1-A5 model exactly", async () => {
    const clock = new FakeClock();
    let releaseH2!: () => void;
    const h2Gate = new Promise<void>((resolve) => (releaseH2 = resolve));
    const slowHook: SubagentExtensionPoints = {
      resolveSessionSpec: async (spec) => {
        await h2Gate; // holds the run in the real A2 window (activeCancels unregistered) indefinitely, until released
        return spec;
      },
    };
    const driver: SessionDriver = {
      create: async () => handle(),
      bind: async () => undefined,
      onLateArrival: () => undefined,
    };
    const { svc } = buildFullStack(clock, driver, [slowHook]);

    const spawned = await svc.spawn({ type: "worker", prompt: "x", budgetOverride: { totalMs: 60_000 } });
    if ("error" in spawned) throw new Error(spawned.error.message);
    const { runId } = spawned;

    // Real A2 window: the run is `running.has(runId) === true` (spawn()
    // already returned it), but RuntimeRunner.run() is still blocked inside
    // the H2 hook — abort() must return false, exactly as workflow design
    // §7.1's A2 row documents ("core abort 在此返回 ok:false（已验证）").
    await drain(clock, 3);
    let abortResult = await svc.abort(runId, "user_stop");
    expect(abortResult).toBe(false);
    await drain(clock, 3);
    abortResult = await svc.abort(runId, "user_stop");
    expect(abortResult).toBe(false); // still stuck — this is the window CallRegistry's retry loop exists to survive

    // Release H2 — RuntimeRunner.run() proceeds past the hook and registers
    // its cancel handle (A2 -> A3 transition). The very next abort() must
    // now succeed, either by cancelling the run before the driver's `bind()`
    // completes or by the run reaching a terminal state on its own.
    releaseH2();
    await drain(clock, 5);
    abortResult = await svc.abort(runId, "user_stop");
    expect(abortResult).toBe(true);
  });

  it("CallRegistry.cancel()'s bounded retry loop, wired to the real svc.abort(), converges exactly when the real A2 window closes (H2 delay < cancelRetryWindowMs)", async () => {
    const clock = new FakeClock();
    let releaseH2!: () => void;
    const h2Gate = new Promise<void>((resolve) => (releaseH2 = resolve));
    const slowHook: SubagentExtensionPoints = {
      resolveSessionSpec: async (spec) => {
        await h2Gate;
        return spec;
      },
    };
    const driver: SessionDriver = {
      create: async () => handle(),
      bind: async () => undefined,
      onLateArrival: () => undefined,
    };
    const { svc } = buildFullStack(clock, driver, [slowHook]);

    const registry = createCallRegistry({
      clock,
      // This is *exactly* how host.ts wires it (`abort: (runId, cause) =>
      // deps.spawner.abort(runId, cause)`), against the real SpawnService.
      abort: (runId, cause) => svc.abort(runId, cause),
      cancelRetryWindowMs: 30_000,
      cancelRetryMs: 250,
    });

    const spawned = await svc.spawn({ type: "worker", prompt: "x", budgetOverride: { totalMs: 60_000 } });
    if ("error" in spawned) throw new Error(spawned.error.message);
    registry.submit("c1", clock.now());
    registry.bind("c1", spawned.runId);

    const effect = registry.cancel("c1", "user_stop");
    expect(effect).toBe("retrying"); // CR6: honestly reports "still trying" — real abort() is genuinely false right now

    // While H2 is still gating the run, every retry attempt keeps failing —
    // the loop must not give up early nor falsely report success.
    for (let i = 0; i < 4; i += 1) {
      clock.advance(250);
      await drain(clock, 2);
    }
    expect(registry.resolve("c1")?.phase).not.toBe("settled"); // still retrying, not force-abandoned
    expect(registry.stats.retryingCancels).toBe(1);

    // Release H2 partway through the retry window — the very next scheduled
    // attempt (still well inside cancelRetryWindowMs=30s) must succeed.
    releaseH2();
    await drain(clock, 3);
    clock.advance(250);
    await drain(clock, 5);

    expect(registry.resolve("c1")?.cancelIntent?.attempts).toBeGreaterThan(0);
    // The loop only stops retrying once `deps.abort` reports true — confirm
    // no further attempts increment the call's outcome after this point by
    // advancing well past the window and observing stable state.
    const attemptsAtSuccess = registry.resolve("c1")?.cancelIntent?.attempts;
    clock.advance(30_000);
    await drain(clock, 5);
    expect(registry.resolve("c1")?.cancelIntent?.attempts).toBe(attemptsAtSuccess);
  });
});
