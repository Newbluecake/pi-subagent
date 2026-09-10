import { describe, expect, it } from "vitest";
import { FakeClock } from "../../src/core/clock.js";
import { DEFAULT_BUDGET } from "../../src/core/deadline.js";
import { MemoryOutboxStore, MemoryRunStore } from "../../src/core/store.js";
import type { AgentTypeConfig, DeadlineBudget, DeadlineNotice, DriverEvent } from "../../src/core/types.js";
import { deliveryOptionsFor, TIMEOUT_NOTICE_TYPE } from "../../src/delivery/deadline-notice.js";
import {
  createNotifier as createNotifierImpl,
  type NotifierOptions,
  type PersistedDelivery,
} from "../../src/delivery/notifier.js";
import { EscalatingReaper } from "../../src/runtime/reaper.js";
import type { SessionDriver, SessionHandle } from "../../src/runtime/session-driver.js";
import { SingleSlotPool } from "../../src/runtime/slot-pool.js";
import { EventWatchdog } from "../../src/runtime/watchdog.js";
import { createLiveRunRegistry } from "../../src/service/run-registry.js";
import { createRuntimeRunnerAdapter } from "../../src/service/runtime-adapter.js";
import { createQueryService } from "../../src/service/query-service.js";
import { createSpawnService } from "../../src/service/spawn-service.js";

/**
 * timeout-notify 全链路接线测试（plan §3.11 final / V1-V6、V19、V21）：
 * 真 SingleSlotPool + 真 RuntimeRunner（adapter）+ 真 watchdog（runnerRef 晚绑定，
 * stack.ts 同款）+ 真 SpawnService/QueryService，budget 用快档
 * （totalMs 2000 / totalGraceMs 1000 / maxExtensions 1 / maxTotalFactor 2）。
 * onDeadlineNotice 收集器验证 reducer → effect → interpreter → handler → sink
 * 整条链；stack.ts 的 sendMessage 闭包是薄壳，其策略谓词由
 * tests/delivery/deadline-notice.test.ts 单测覆盖。
 */

function createNotifier(
  options: Omit<NotifierOptions, "cancelBuffered"> & Partial<Pick<NotifierOptions, "cancelBuffered">>,
) {
  return createNotifierImpl({ ...options, cancelBuffered: options.cancelBuffered ?? (() => undefined) });
}

const never = <T>() => new Promise<T>(() => undefined);

function graceBudget(overrides: Partial<DeadlineBudget> = {}): DeadlineBudget {
  return {
    ...DEFAULT_BUDGET,
    queueWaitMs: 200,
    startupMs: 200,
    bindMs: 200,
    firstEventMs: 5_000, // 必须 > totalMs，否则 prompt_dispatch 的 no_first_event 会抢在 total 之前杀 run
    idleMs: 5_000,
    modelTurnMs: 60_000,
    toolMs: 5_000,
    totalMs: 2_000,
    totalGraceMs: 1_000,
    maxExtensions: 1,
    maxTotalFactor: 2,
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
    prompt: () => never(),
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

interface GraceStackOpts {
  extensionsEnabled?: boolean;
  typeBudgetOverride?: Partial<DeadlineBudget>;
  onEvent?: (event: DriverEvent) => void;
}

function buildGraceStack(clock: FakeClock, driver: SessionDriver, opts: GraceStackOpts = {}) {
  const budget = graceBudget();
  const pool = new SingleSlotPool(clock, 1);
  const store = new MemoryRunStore();
  const reaper = new EscalatingReaper(clock);
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
  const notices: DeadlineNotice[] = [];
  const runner = createRuntimeRunnerAdapter({
    clock,
    driver,
    pool,
    store,
    watchdog,
    reaper,
    notifier,
    onDeadlineNotice: (notice) => notices.push(notice),
  });
  runnerRef.current = runner;
  const type: AgentTypeConfig = {
    name: "worker",
    description: "worker",
    systemPrompt: "",
    promptMode: "append",
    ...(opts.typeBudgetOverride === undefined ? {} : { budgetOverride: opts.typeBudgetOverride }),
  };
  const types = {
    get: (name: string) => (name === "worker" ? type : undefined),
    list: () => [type],
    reload: async () => ({ types: [type], errors: [] }),
  };
  const spawnService = createSpawnService({
    types,
    pool,
    runner,
    now: () => clock.now(),
    budget,
    ...(opts.extensionsEnabled === undefined ? {} : { extensionsEnabled: opts.extensionsEnabled }),
  });
  const registry = createLiveRunRegistry(spawnService, store);
  const queryService = createQueryService({ registry, runner, clock });
  return { pool, store, reaper, notifier, runner, spawnService, registry, queryService, sent, notices, watchdog };
}

async function drain(clock: FakeClock, ticks: number, stepMs = 10) {
  for (let i = 0; i < ticks; i++) {
    await Promise.resolve();
    clock.advance(stepMs);
    await Promise.resolve();
  }
}

async function spawnOk(
  stack: ReturnType<typeof buildGraceStack>,
  req: { prompt: string; budgetOverride?: Partial<DeadlineBudget> },
) {
  const spawned = await stack.spawnService.spawn({ type: "worker", ...req });
  if ("error" in spawned) throw new Error(spawned.error.message);
  return spawned;
}

describe("timeout grace wiring (V1-V6)", () => {
  it("V1/V2: deadline fires a grace notice and the run keeps running; extend rescues it to completion", async () => {
    const clock = new FakeClock();
    let settlePrompt!: () => void;
    const driver: SessionDriver = {
      create: async () => handle({ prompt: () => new Promise<void>((resolve) => (settlePrompt = resolve)) }),
      bind: async () => undefined,
      onLateArrival: () => undefined,
    };
    const stack = buildGraceStack(clock, driver);
    const spawned = await spawnOk(stack, { prompt: "do the thing" });

    // t≈2000: 到点 → 进宽限（run 仍在跑），恰好一条 grace 通知。
    await drain(clock, 210);
    expect(stack.notices).toHaveLength(1);
    const notice = stack.notices[0]!;
    expect(notice.kind).toBe("grace");
    expect(notice.runId).toBe(spawned.runId);
    expect(notice.graceUntil).toBe(3_000);
    expect(notice.hardDeadlineAt).toBe(4_000);
    expect(deliveryOptionsFor(notice)).toEqual({ triggerTurn: true });
    expect(TIMEOUT_NOTICE_TYPE).toBe("subagent:timeout");
    // 无会话事件的 run 停在 prompt_dispatch（status "starting"）——宽限期间相位/状态不变，只是不死。
    expect(stack.registry.get(spawned.runId)?.status).not.toBe("timed_out");
    expect(stack.registry.get(spawned.runId)?.deadlines.graceUntil).toBe(3_000);

    // 宽限内延长 1500ms → 从宽限中救出，活过旧宽限截止。
    const extended = stack.queryService.extendTimeout(spawned.runId, 1_500, { source: "tool", reason: "needs more" });
    expect(extended.ok).toBe(true);
    if (extended.ok) {
      expect(extended.rescuedFromGrace).toBe(true);
      // base = max(at≈2100, prev=2000) = 2100；next = 2100 + 1500 = 3600（≤ H=4000）
      expect(extended.deadlineAt).toBe(3_600);
      expect(extended.hardDeadlineAt).toBe(4_000);
    }
    expect(stack.registry.get(spawned.runId)?.deadlines.graceUntil).toBeUndefined();
    // extended 回执：triggerTurn false（display-only，不抢主会话回合）。
    const receipt = stack.notices.find((n) => n.kind === "extended");
    expect(receipt).toBeDefined();
    expect(deliveryOptionsFor(receipt!)).toEqual({ triggerTurn: false });

    await drain(clock, 60); // t≈2700 → 越过 3000 旧宽限截止仍未死
    expect(stack.registry.get(spawned.runId)?.status).not.toBe("timed_out");

    // 正常完成：outbox 恰一条完成通知（D-4：宽限通知不占 outbox key）。
    settlePrompt();
    await drain(clock, 20);
    const terminal = stack.registry.get(spawned.runId);
    expect(terminal?.status).toBe("completed");
    expect(terminal?.diag.overtime).toMatchObject({ graces: 1, extensions: 1, grantedMs: 1_500 });
    expect(stack.sent.filter((p) => p.runId === spawned.runId)).toHaveLength(1);
    expect(stack.pool.stats.inUse).toBe(0);
  });

  it("V3: nobody extends — the grace expiry kills the run exactly like the old total path", async () => {
    const clock = new FakeClock();
    const driver: SessionDriver = {
      create: async () => handle(),
      bind: async () => undefined,
      onLateArrival: () => undefined,
    };
    const stack = buildGraceStack(clock, driver);
    const spawned = await spawnOk(stack, { prompt: "hang" });

    await drain(clock, 210); // t≈2000: grace notice, still alive
    expect(stack.notices).toHaveLength(1);
    expect(stack.registry.get(spawned.runId)?.status).not.toBe("timed_out");

    await drain(clock, 120); // t≈3200: graceUntil=3000 已过 → 终止
    const terminal = stack.registry.get(spawned.runId);
    expect(terminal?.status).toBe("timed_out");
    expect(terminal?.outcome?.timeoutReason ?? terminal?.diag.timeoutReason).toBe("total");
    expect(stack.sent.filter((p) => p.runId === spawned.runId)).toHaveLength(1);
    expect(stack.pool.stats.inUse).toBe(0);
  });

  it("V11: extend.enabled=false beats an agent-type maxExtensions override (D-16) — no grace, no notice", async () => {
    const clock = new FakeClock();
    const driver: SessionDriver = {
      create: async () => handle(),
      bind: async () => undefined,
      onLateArrival: () => undefined,
    };
    const stack = buildGraceStack(clock, driver, {
      extensionsEnabled: false,
      typeBudgetOverride: { maxExtensions: 3 },
    });
    const spawned = await spawnOk(stack, { prompt: "hang" });

    await drain(clock, 230); // 越过 totalMs=2000
    const terminal = stack.registry.get(spawned.runId);
    expect(terminal?.status).toBe("timed_out");
    expect(stack.notices).toHaveLength(0);
    expect(terminal?.deadlines.graceUntil).toBeUndefined();
  });

  it("V20: an explicit budgetOverride.totalMs is a hard cap — no grace, no extension (D-10)", async () => {
    const clock = new FakeClock();
    const driver: SessionDriver = {
      create: async () => handle(),
      bind: async () => undefined,
      onLateArrival: () => undefined,
    };
    const stack = buildGraceStack(clock, driver);
    const spawned = await spawnOk(stack, { prompt: "hang", budgetOverride: { totalMs: 2_000 } });

    await drain(clock, 50); // t≈500：run 进行中，但延长必被拒（H = deadlineAt）
    const refused = stack.queryService.extendTimeout(spawned.runId, 1_000, { source: "tool" });
    expect(refused).toMatchObject({ ok: false, reason: "no_headroom" });

    await drain(clock, 200); // t≈2500：到点直接终止，无宽限
    const terminal = stack.registry.get(spawned.runId);
    expect(terminal?.status).toBe("timed_out");
    expect(terminal?.deadlines.graceUntil).toBeUndefined();
    expect(stack.notices).toHaveLength(0);
  });

  it("V19: a run in grace still holds its slot — a queued run times out on queueWaitMs (RK-4)", async () => {
    const clock = new FakeClock();
    const driver: SessionDriver = {
      create: async () => handle(),
      bind: async () => undefined,
      onLateArrival: () => undefined,
    };
    const stack = buildGraceStack(clock, driver); // SingleSlotPool limit = 1
    const a = await spawnOk(stack, { prompt: "A hangs" });
    await drain(clock, 210); // t≈2000：A 进宽限，仍占槽
    expect(stack.registry.get(a.runId)?.status).not.toBe("timed_out");

    expect(stack.registry.get(a.runId)?.deadlines.graceUntil).toBe(3_000);
    const b = await stack.spawnService.spawn({ type: "worker", prompt: "B queues" });
    if ("error" in b) throw new Error(b.error.message);
    await drain(clock, 40); // t≈2400：B 的 queueWaitMs=200 已过
    const bSnap = stack.registry.get(b.runId);
    expect(bSnap?.status).toBe("failed");
    expect(bSnap?.diag.timeoutReason ?? bSnap?.outcome?.timeoutReason).toBe("queue_timeout");
    // A 没被挤掉：宽限继续到 graceUntil=3000 才死。
    expect(stack.registry.get(a.runId)?.status).not.toBe("timed_out");
    await drain(clock, 100); // t≈3400
    expect(stack.registry.get(a.runId)?.status).toBe("timed_out");
    expect(stack.pool.stats.inUse).toBe(0);
  });

  it("V21: a run in grace survives a stack rebuild — the old watchdog still kills it; the new stack cannot extend it", async () => {
    const clock = new FakeClock();
    const driver: SessionDriver = {
      create: async () => handle(),
      bind: async () => undefined,
      onLateArrival: () => undefined,
    };
    const stack1 = buildGraceStack(clock, driver);
    const spawned = await spawnOk(stack1, { prompt: "hang" });
    await drain(clock, 210); // t≈2000：宽限中
    expect(stack1.notices).toHaveLength(1);
    expect(stack1.registry.get(spawned.runId)?.status).not.toBe("timed_out");

    // 会话重建（/reload）：新 stack 的 registry 里没有旧 run。
    const stack2 = buildGraceStack(clock, driver);
    expect(stack2.queryService.extendTimeout(spawned.runId, 1_000, { source: "tool" })).toMatchObject({
      ok: false,
      reason: "unknown_run",
    });

    // 旧 stack 的 watchdog/guard 仍在跑：graceUntil=3000 到点照杀；通知全程恰一条。
    await drain(clock, 120); // t≈3200
    expect(stack1.registry.get(spawned.runId)?.status).toBe("timed_out");
    expect(stack1.notices).toHaveLength(1);
  });
});
