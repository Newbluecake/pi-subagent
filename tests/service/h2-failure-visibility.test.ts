import { describe, expect, it, vi } from "vitest";
import { FakeClock } from "../../src/core/clock.js";
import { DEFAULT_BUDGET } from "../../src/core/deadline.js";
import { MemoryRunStore } from "../../src/core/store.js";
import type { AgentTypeConfig, LifecycleEvent, RunSnapshot, SubagentExtensionPoints } from "../../src/core/types.js";
import { EscalatingReaper } from "../../src/runtime/reaper.js";
import type { SessionDriver } from "../../src/runtime/session-driver.js";
import { SingleSlotPool } from "../../src/runtime/slot-pool.js";
import { EventWatchdog } from "../../src/runtime/watchdog.js";
import type { RunnerCallbacks, RunnerSpec } from "../../src/service/ports.js";
import { createRunRegistry } from "../../src/service/run-registry.js";
import { createRuntimeRunnerAdapter } from "../../src/service/runtime-adapter.js";

/**
 * M1 验收 Minor fix: an H2 (resolveSessionSpec) failure used to return a
 * failed(config) outcome while bypassing every observability channel — no
 * terminal snapshot in the SnapshotStore (so QueryService.list, /agent
 * status and the X7 fleet panel could not see the run) and no lifecycle
 * event. These tests pin the fixed behavior through the real wiring seam
 * (createRuntimeRunnerAdapter), the same path index.ts assembles.
 */
const never = <T>() => new Promise<T>(() => undefined);
const type: AgentTypeConfig = { name: "worker", description: "worker", systemPrompt: "", promptMode: "append" };

function fastBudget() {
  return {
    ...DEFAULT_BUDGET,
    queueWaitMs: 200,
    startupMs: 50,
    bindMs: 200,
    firstEventMs: 200,
    idleMs: 200,
    toolMs: 200,
    totalMs: 500,
    abortGraceMs: 20,
    steerMs: 10,
    reapMs: 30,
  };
}

function buildAdapter(
  clock: FakeClock,
  extensions: SubagentExtensionPoints[],
  enqueue = (_payload: unknown) => undefined,
) {
  const pool = new SingleSlotPool(clock, 1);
  const store = new MemoryRunStore();
  const reaper = new EscalatingReaper(clock);
  const watchdog = new EventWatchdog({
    clock,
    budget: fastBudget(),
    getState: () => undefined,
    dispatch: () => undefined,
  });
  const notifier = {
    enqueue,
    consume: () => false,
    reconcile: () => ({ redelivered: [], suppressed: [], abandoned: [] }),
    verifyPersisted: () => ({ missing: [] }),
    stats: { pending: 0, delivered: 0, consumed: 0, dropped: 0, abandoned: 0 },
    degraded: [],
  };
  const driver: SessionDriver = {
    create: () => {
      throw new Error("driver.create must not run when H2 fails");
    },
    bind: async () => undefined,
    onLateArrival: () => undefined,
  };
  const lifecycle: LifecycleEvent[] = [];
  const runner = createRuntimeRunnerAdapter({
    clock,
    driver,
    pool,
    store,
    watchdog,
    reaper,
    notifier,
    extensions,
    onLifecycle: (e) => lifecycle.push(e),
  });
  return { runner, store, lifecycle };
}

function spec(agentType = type, request: Partial<RunnerSpec["request"]> = {}): RunnerSpec {
  return {
    runId: "r1",
    type: agentType,
    request: { type: agentType.name, prompt: "hi", ...request },
    budget: fastBudget(),
  };
}

async function drain(clock: FakeClock, ticks: number, stepMs = 1) {
  for (let i = 0; i < ticks; i++) {
    await Promise.resolve();
    clock.advance(stepMs);
    await Promise.resolve();
  }
}

describe("H2 failure visibility (store snapshot + lifecycle)", () => {
  it("persists a terminal failed snapshot visible through RunRegistry/QueryService.list when the hook throws", async () => {
    const clock = new FakeClock();
    const ext: SubagentExtensionPoints = {
      resolveSessionSpec: () => {
        throw new Error("bad worktree config");
      },
    };
    const { runner, store } = buildAdapter(clock, [ext]);
    const p = runner.run(spec());
    await drain(clock, 10);
    const outcome = await p;
    expect(outcome.status).toBe("failed");

    const stored = store.get("r1");
    expect(stored).toBeDefined();
    expect(stored?.status).toBe("failed");
    expect(stored?.phase).toBe("settled"); // terminal-snapshot convention
    expect(stored?.diag.phase).toBe("resolve_config"); // real failure phase kept in diag
    expect(stored?.diag.error?.kind).toBe("config");
    expect(stored?.diag.error?.message).toBe("bad worktree config");
    expect(stored?.outcome).toBe(outcome);

    // The exact read path /agent status and the fleet panel use:
    const listed = createRunRegistry(store).list();
    expect(listed.map((s: RunSnapshot) => s.runId)).toEqual(["r1"]);
  });

  it("emits lifecycle to the global sink, per-run callbacks AND the H1 extension observer", async () => {
    const clock = new FakeClock();
    const extLifecycle: LifecycleEvent[] = [];
    const ext: SubagentExtensionPoints = {
      resolveSessionSpec: () => {
        throw new Error("boom");
      },
      onLifecycle: (e) => extLifecycle.push(e),
    };
    const { runner, store, lifecycle } = buildAdapter(clock, [ext]);
    const callbacks: Required<Pick<RunnerCallbacks, "onLifecycle" | "onSnapshot">> = {
      onLifecycle: vi.fn(),
      onSnapshot: vi.fn(),
    };
    const p = runner.run(spec(), callbacks);
    await drain(clock, 10);
    await p;

    const expected = { runId: "r1", generation: 1, status: "failed" };
    expect(lifecycle).toEqual([expect.objectContaining(expected)]);
    expect(extLifecycle).toEqual([expect.objectContaining(expected)]);
    expect(callbacks.onLifecycle).toHaveBeenCalledWith(expect.objectContaining(expected));
    expect(callbacks.onSnapshot).toHaveBeenCalledWith(expect.objectContaining({ runId: "r1", status: "failed" }));
    expect(store.get("r1")?.status).toBe("failed");
  });

  it("enqueues a notification for a background config failure", async () => {
    const clock = new FakeClock();
    const notifications: unknown[] = [];
    const ext: SubagentExtensionPoints = {
      resolveSessionSpec: () => {
        throw new Error("bad config");
      },
    };
    const { runner } = buildAdapter(clock, [ext], (payload) => notifications.push(payload));
    const outcome = await runner.run(spec());
    expect(outcome.status).toBe("failed");
    expect(notifications).toHaveLength(1);
    expect(notifications[0]).toMatchObject({ runId: "r1", status: "failed", generation: 1, textPreview: "" });
  });

  it("does not enqueue a notification for a nested config failure", async () => {
    const clock = new FakeClock();
    const notifications: unknown[] = [];
    const ext: SubagentExtensionPoints = {
      resolveSessionSpec: () => {
        throw new Error("bad child config");
      },
    };
    const { runner } = buildAdapter(clock, [ext], (payload) => notifications.push(payload));
    const outcome = await runner.run(spec(type, { parentRunId: "parent" }));
    expect(outcome.status).toBe("failed");
    expect(notifications).toEqual([]);
  });

  it("enqueues a foreground config failure even when a waiter is attached", async () => {
    const clock = new FakeClock();
    const notifications: unknown[] = [];
    const ext: SubagentExtensionPoints = {
      resolveSessionSpec: () => {
        throw new Error("bad foreground config");
      },
    };
    const { runner } = buildAdapter(clock, [ext], (payload) => notifications.push(payload));
    const callback = vi.fn();
    const outcome = await runner.run(spec(), { onSnapshot: callback });
    expect(outcome.status).toBe("failed");
    expect(callback).toHaveBeenCalled();
    expect(notifications).toHaveLength(1);
  });

  it("also persists + emits when the hook times out (startupMs bound)", async () => {
    const clock = new FakeClock();
    const ext: SubagentExtensionPoints = { resolveSessionSpec: () => never() };
    const { runner, store, lifecycle } = buildAdapter(clock, [ext]);
    const p = runner.run(spec());
    await drain(clock, 60); // advance past startupMs=50
    const outcome = await p;
    expect(outcome.status).toBe("failed");
    expect(outcome.error?.message).toMatch(/timed out/);

    const stored = store.get("r1");
    expect(stored?.status).toBe("failed");
    expect(stored?.diag.error?.message).toMatch(/timed out/);
    expect(lifecycle).toEqual([expect.objectContaining({ runId: "r1", status: "failed" })]);
  });
});
