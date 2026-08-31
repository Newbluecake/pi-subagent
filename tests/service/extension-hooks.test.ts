import { describe, expect, it, vi } from "vitest";
import { FakeClock } from "../../src/core/clock.js";
import { DEFAULT_BUDGET } from "../../src/core/deadline.js";
import { MemoryRunStore } from "../../src/core/store.js";
import type { AgentTypeConfig, SubagentExtensionPoints } from "../../src/core/types.js";
import { EscalatingReaper } from "../../src/runtime/reaper.js";
import type { SessionDriver, SessionHandle } from "../../src/runtime/session-driver.js";
import { SingleSlotPool } from "../../src/runtime/slot-pool.js";
import { EventWatchdog } from "../../src/runtime/watchdog.js";
import { createRuntimeRunnerAdapter } from "../../src/service/runtime-adapter.js";
import type { RunnerSpec } from "../../src/service/ports.js";

/**
 * H2 (resolveSessionSpec) and H3 (beforeReap) end-to-end through the real
 * wiring seam (createRuntimeRunnerAdapter), the same path index.ts assembles
 * — not just the isolated mergeExtensionPoints() unit tests.
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
function buildAdapter(clock: FakeClock, driver: SessionDriver, extensions: SubagentExtensionPoints[]) {
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
    enqueue: () => undefined,
    consume: () => false,
    reconcile: () => ({ redelivered: [], suppressed: [], abandoned: [] }),
    verifyPersisted: () => ({ missing: [] }),
    stats: { pending: 0, delivered: 0, consumed: 0, dropped: 0, abandoned: 0 },
    degraded: [],
  };
  const runner = createRuntimeRunnerAdapter({ clock, driver, pool, store, watchdog, reaper, notifier, extensions });
  return { runner, pool };
}
function spec(overrides: Partial<RunnerSpec> = {}): RunnerSpec {
  return { runId: "r1", type, request: { type: "worker", prompt: "hi" }, budget: fastBudget(), ...overrides };
}
async function drain(clock: FakeClock, ticks: number, stepMs = 1) {
  for (let i = 0; i < ticks; i++) {
    await Promise.resolve();
    clock.advance(stepMs);
    await Promise.resolve();
  }
}

describe("H2 resolveSessionSpec wiring", () => {
  it("lets an extension rewrite the SessionSpec seen by SessionDriver.create() (e.g. worktree cwd injection)", async () => {
    const clock = new FakeClock();
    let createdWith: unknown;
    const driver: SessionDriver = {
      create: async (s) => {
        createdWith = s;
        return handle();
      },
      bind: async () => undefined,
      onLateArrival: () => undefined,
    };
    const ext: SubagentExtensionPoints = { resolveSessionSpec: (s) => ({ ...s, cwd: "/worktrees/r1" }) };
    const { runner } = buildAdapter(clock, driver, [ext]);
    const p = runner.run(spec());
    await drain(clock, 30);
    const outcome = await p;
    expect(outcome.status).toBe("completed");
    expect((createdWith as { cwd?: string }).cwd).toBe("/worktrees/r1");
  });

  it("fails the run as failed(config) — not silently continuing with the original spec — when the hook times out", async () => {
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
    const ext: SubagentExtensionPoints = { resolveSessionSpec: () => never() };
    const { runner } = buildAdapter(clock, driver, [ext]);
    const p = runner.run(spec());
    await drain(clock, 60);
    const outcome = await p;
    expect(outcome.status).toBe("failed");
    expect(outcome.error?.kind).toBe("config");
    expect(outcome.error?.message).toMatch(/timed out/);
    expect(createCalled).toBe(false);
  });

  it("fails the run as failed(config) with the real thrown message when the hook throws synchronously", async () => {
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
    const ext: SubagentExtensionPoints = {
      resolveSessionSpec: () => {
        throw new Error("bad worktree config");
      },
    };
    const { runner } = buildAdapter(clock, driver, [ext]);
    const p = runner.run(spec());
    await drain(clock, 10);
    const outcome = await p;
    expect(outcome.status).toBe("failed");
    expect(outcome.error?.kind).toBe("config");
    expect(outcome.error?.message).toBe("bad worktree config");
    expect(createCalled).toBe(false);
  });
});

describe("H3 beforeReap wiring", () => {
  it("runs before the reaper's physical dispose, and does not block Runner.run() settling", async () => {
    const clock = new FakeClock();
    const order: string[] = [];
    const driver: SessionDriver = {
      create: async () =>
        handle({ dispose: () => (order.push("dispose"), { returned: true, killed: 0, unkillable: [] }) }),
      bind: async () => undefined,
      onLateArrival: () => undefined,
    };
    const ext: SubagentExtensionPoints = {
      beforeReap: async () => {
        order.push("beforeReap");
      },
    };
    const { runner, pool } = buildAdapter(clock, driver, [ext]);
    const p = runner.run(spec());
    await drain(clock, 30);
    const outcome = await p;
    expect(outcome.status).toBe("completed");
    // Give the fire-and-forget beforeReap -> reap chain (post-settle,
    // best-effort per invariant I4) a chance to run to completion.
    await drain(clock, 30);
    expect(order).toEqual(["beforeReap", "dispose"]);
    expect(pool.stats.inUse).toBe(0);
  });

  it("is bounded by reapMs: a hanging beforeReap does not prevent the reaper from eventually running, and is reported via onExtensionError", async () => {
    const clock = new FakeClock();
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    let disposed = false;
    const driver: SessionDriver = {
      create: async () => handle({ dispose: () => ((disposed = true), { returned: true, killed: 0, unkillable: [] }) }),
      bind: async () => undefined,
      onLateArrival: () => undefined,
    };
    const ext: SubagentExtensionPoints = { beforeReap: () => never() };
    const { runner } = buildAdapter(clock, driver, [ext]);
    const p = runner.run(spec());
    await drain(clock, 30);
    const outcome = await p;
    expect(outcome.status).toBe("completed"); // settle is not delayed by the hanging hook
    // Advance past reapMs so the bounded beforeReap wrapper times out and the
    // reaper's own dispose still runs afterwards (best-effort, but not stuck forever).
    await drain(clock, 60);
    expect(disposed).toBe(true);
    expect(warn.mock.calls.some((c) => String(c[0]).includes("beforeReap"))).toBe(true);
    warn.mockRestore();
  });
});
