import { describe, expect, it } from "vitest";
import { FakeClock } from "../../src/core/clock.js";
import { DEFAULT_BUDGET } from "../../src/core/deadline.js";
import { MemoryOutboxStore, MemoryRunStore } from "../../src/core/store.js";
import type { AgentTypeConfig, DriverEvent } from "../../src/core/types.js";
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

function fastBudget(overrides: Partial<typeof DEFAULT_BUDGET> = {}) {
  return {
    ...DEFAULT_BUDGET,
    queueWaitMs: 200,
    startupMs: 200,
    bindMs: 200,
    firstEventMs: 200,
    idleMs: 200,
    modelTurnMs: 400,
    toolMs: 200,
    totalMs: 500,
    abortGraceMs: 20,
    steerMs: 10,
    reapMs: 20,
    retrySlackMs: 20,
    ...overrides,
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

function buildStack(clock: FakeClock, driver: SessionDriver, budgetOverrides: Partial<typeof DEFAULT_BUDGET> = {}) {
  const budget = fastBudget(budgetOverrides);
  const pool = new SingleSlotPool(clock, 1);
  const store = new MemoryRunStore();
  const reaper = new EscalatingReaper(clock);
  // M4: 与 stack.ts 同款的真实接线——watchdog 经 runnerRef 晚绑定到 runner，
  // 不再是 getState/dispatch 皆 no-op 的空壳。
  const runnerRef: { current?: ReturnType<typeof createRuntimeRunnerAdapter> } = {};
  const watchdog = new EventWatchdog({
    clock,
    budget,
    tickMs: 10,
    getState: (runId, gen) => runnerRef.current?.getRunState?.(runId, gen),
    dispatch: (runId, gen, input) => {
      if (input.kind === "deadline_fired") runnerRef.current?.fireDeadline?.(runId, gen, input);
    },
  });
  const outbox = new MemoryOutboxStore<PersistedDelivery>();
  const sent: PersistedDelivery[] = [];
  const notifier = createNotifier({
    store: outbox,
    clock,
    sender: (payload) => sent.push(payload as PersistedDelivery),
  });
  const runner = createRuntimeRunnerAdapter({ clock, driver, pool, store, watchdog, reaper, notifier });
  runnerRef.current = runner;
  const type: AgentTypeConfig = { name: "worker", description: "worker", systemPrompt: "", promptMode: "append" };
  const types = {
    get: (name: string) => (name === "worker" ? type : undefined),
    list: () => [type],
    reload: async () => ({ types: [type], errors: [] }),
  };
  const spawnService = createSpawnService({ types, pool, runner, now: () => clock.now(), budget });
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
    const completion = stack.sent.find((p) => p.runId === spawned.runId && p.status === "completed");
    expect(completion).toBeDefined();
    expect(completion?.key).toMatch(/^r_[0-9A-HJKMNP-TV-Z]{8}:\d+$/);
    expect(completion?.key.split(":")).toHaveLength(2);
    expect(completion?.storageKey).toBe(completion?.key);

    // QueryService.wait() must resolve with the same outcome via the shared registry.
    const waited = await stack.queryService.wait(spawned.runId, { waitMs: 1000 });
    expect(waited.ok).toBe(true);
    if (waited.ok) expect(waited.outcome.status).toBe("completed");

    // Slot must be fully released after settlement.
    expect(stack.pool.stats.inUse).toBe(0);
  });

  it("schema-flip sends exactly one finalized failed stable-key notification", async () => {
    const clock = new FakeClock();
    const driver: SessionDriver = {
      create: async () => handle({ prompt: async () => undefined }),
      bind: async () => undefined,
      onLateArrival: () => undefined,
    };
    const stack = buildStack(clock, driver);
    const spawned = await stack.spawnService.spawn({
      type: "worker",
      prompt: "validate",
      schema: { type: "object", required: ["answer"], properties: { answer: { type: "number" } } },
    });
    if ("error" in spawned) throw new Error(spawned.error.message);
    await drain(clock, 30);
    const snapshot = stack.registry.get(spawned.runId);
    const notifications = stack.sent.filter((p) => p.runId === spawned.runId);
    expect(snapshot?.outcome?.status).toBe("failed");
    expect(notifications).toHaveLength(1);
    expect(notifications[0]).toMatchObject({
      key: `${spawned.runId}:1`,
      status: "failed",
      finalized: true,
      failReason: snapshot?.outcome?.error?.message,
    });
    expect(notifications[0]!.key.split(":")).toHaveLength(2);
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
    // M4: 子阶段超时接线后，prompt() 无事件挂起由 firstEventMs 精确捕获
    // （no_first_event），不再一路拖到 total。
    expect(snapshot?.diag.timeoutReason).toBe("no_first_event");

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

  // ---------- M4: watchdog 真实接线后的子阶段超时 ----------

  /** 可注入 DriverEvent 的 driver：bind 时截获 onEvent 回调，prompt 默认永远挂起。 */
  function eventDrivenDriver(promptImpl: () => Promise<void> = () => never()) {
    let emitEvent: ((e: DriverEvent) => void) | undefined;
    const driver: SessionDriver = {
      create: async () => handle({ prompt: promptImpl }),
      bind: async (_h, onEvent) => {
        emitEvent = onEvent;
      },
      onLateArrival: () => undefined,
    };
    return { driver, emit: (e: DriverEvent) => emitEvent?.(e) };
  }

  it("M4: model_turn 静默卡死 → idle 超时击杀（远早于 total），保留具体 timeoutReason", async () => {
    const clock = new FakeClock();
    const { driver, emit } = eventDrivenDriver();
    const stack = buildStack(clock, driver);

    const spawned = await stack.spawnService.spawn({ type: "worker", prompt: "hang in model turn" });
    if ("error" in spawned) throw new Error(spawned.error.message);

    await drain(clock, 30); // bind 完成、watchdog armed、prompt 已 dispatch
    emit({ t: "turn_start" }); // → model_turn
    await drain(clock, 5);
    expect(stack.registry.get(spawned.runId)?.diag.phase).toBe("model_turn");

    // idleMs=200：t≈35 进 model_turn，due≈235，totalMs=500——若 settle 发生在 500 之前，
    // 证明 fireDeadline 的 cancel 确实解除了 guard 阻塞（否则会一路挂到 total）。
    await drain(clock, 300);
    const snap = stack.registry.get(spawned.runId);
    expect(snap?.status).toBe("timed_out");
    expect(snap?.diag.timeoutReason).toBe("idle"); // 不是 "total"、不是 aborted
    expect(stack.sent.some((p) => p.runId === spawned.runId && p.status === "timed_out")).toBe(true);
    expect(stack.pool.stats.inUse).toBe(0);
  });

  it("M4: 持续产出 delta 的活跃轮次不被 idle 误杀，但不得越过 modelTurnMs 硬上限", async () => {
    const clock = new FakeClock();
    const { driver, emit } = eventDrivenDriver();
    const stack = buildStack(clock, driver); // idleMs=200, modelTurnMs=400, totalMs=500

    const spawned = await stack.spawnService.spawn({ type: "worker", prompt: "slow but alive" });
    if ("error" in spawned) throw new Error(spawned.error.message);

    await drain(clock, 30);
    emit({ t: "turn_start" }); // t≈30 进 model_turn；cap due ≈ 430，total due = 500

    // 每 50ms 一个 delta，持续 300ms——远超 idleMs=200，活跃流不得被杀。
    for (let i = 0; i < 6; i++) {
      emit({ t: "thinking_delta", delta: "x" });
      await drain(clock, 50);
    }
    expect(stack.registry.get(spawned.runId)?.status).toBe("running");

    // 继续产出让总轮长越过 modelTurnMs=400 的硬上限 → 必须被杀。
    for (let i = 0; i < 3; i++) {
      emit({ t: "thinking_delta", delta: "y" });
      await drain(clock, 50);
    }
    const snap = stack.registry.get(spawned.runId);
    expect(snap?.status).toBe("timed_out");
    expect(snap?.diag.timeoutReason).toBe("idle"); // 硬上限与静默共用 idle 定时器
  });

  it("M4: pi 自动重试卡死（retry_backoff 无 retry_end）→ 超时击杀，不再无界挂起", async () => {
    const clock = new FakeClock();
    const { driver, emit } = eventDrivenDriver();
    const stack = buildStack(clock, driver); // idleMs=200, retrySlackMs=20, totalMs=500

    const spawned = await stack.spawnService.spawn({ type: "worker", prompt: "retry wedge" });
    if ("error" in spawned) throw new Error(spawned.error.message);

    await drain(clock, 30);
    emit({ t: "turn_start" });
    await drain(clock, 5);
    emit({ t: "retry_start", attempt: 1, maxAttempts: 3, delayMs: 50 }); // → retry_backoff
    await drain(clock, 5);
    expect(stack.registry.get(spawned.runId)?.diag.phase).toBe("retry_backoff");

    // idleDueAt ≈ lastEventAt(≈40) + idleMs(200) + delayMs(50) + slack(20) ≈ 310 < total 500
    await drain(clock, 300);
    const snap = stack.registry.get(spawned.runId);
    expect(snap?.status).toBe("timed_out");
    expect(snap?.diag.timeoutReason).toBe("idle");
  });
});
