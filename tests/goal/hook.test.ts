import { describe, expect, it, vi } from "vitest";
import type { AgentEndEvent, AgentSettledEvent, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { createGoalLoopHook } from "../../src/goal/hook.js";
import { createGoalRecord, maxEvalsOf, type GoalRecord, type GoalSession } from "../../src/goal/state.js";
import { DEFAULT_SETTINGS, type GoalSettings } from "../../src/config/settings.js";
import type { RunOutcome, SpawnRequest } from "../../src/core/types.js";

/** flush microtasks: evaluate() 是 fire-and-forget，链上每个 await 都是 microtask。 */
const flush = async () => {
  for (let i = 0; i < 40; i++) await Promise.resolve();
};

interface FakeTimer {
  ms: number;
  fn: () => void;
  cancelled: boolean;
}

function makeOutcome(overrides: Partial<RunOutcome> = {}): RunOutcome {
  return {
    runId: "goal-eval-run",
    status: "completed",
    structuredResult: { goal_met: true, gap: "" },
    usage: { input: 10, output: 5, cacheRead: 999, cacheWrite: 0, costUsd: 0.01 },
    turns: 1,
    durationMs: 1,
    diag: {},
    ...overrides,
  } as unknown as RunOutcome;
}

function harness(
  init: {
    record?: Partial<GoalRecord> | null;
    settings?: Partial<GoalSettings>;
    execResult?: { code: number; killed: boolean };
    spawnAndWait?: (req: SpawnRequest) => Promise<RunOutcome>;
  } = {},
) {
  const settings: GoalSettings = { ...DEFAULT_SETTINGS.goal, ...init.settings };
  const record: GoalRecord | undefined =
    init.record === null
      ? undefined
      : Object.assign(
          createGoalRecord({
            objective: "修复全部测试",
            untilCmd: "npm test",
            maxTurns: 10,
            maxMinutes: 60,
            budgetTokens: 0,
            budgetCostUsd: 0,
            now: 0,
          }),
          init.record,
        );
  const goal: GoalSession = { settings, record };
  const spawn = {
    spawnAndWait: vi.fn((req: SpawnRequest) =>
      init.spawnAndWait ? init.spawnAndWait(req) : Promise.resolve(makeOutcome()),
    ),
  };
  const holder = { current: { goal, spawn } };
  const sent: string[] = [];
  const persisted: GoalRecord[] = [];
  const execCalls: string[] = [];
  const warnings: string[] = [];
  const notifications: Array<{ message: string; level: string }> = [];
  const statuses: Array<[string, string | undefined]> = [];
  const timers: FakeTimer[] = [];
  let execResult = init.execResult ?? { code: 0, killed: false };
  let clock = 1_000;
  const hook = createGoalLoopHook(holder, {
    exec: (cmd) => {
      execCalls.push(cmd);
      return Promise.resolve(execResult);
    },
    sendUserMessage: (text) => sent.push(text),
    persist: (r) => persisted.push({ ...r }),
    now: () => clock,
    warn: (m) => warnings.push(m),
    startTimer: (ms, fn) => {
      const timer: FakeTimer = { ms, fn, cancelled: false };
      timers.push(timer);
      return {
        cancel: () => {
          timer.cancelled = true;
        },
      };
    },
  });
  const env = { idle: true, pending: false, branchLength: 3, mode: "tui" };
  const ctx = () =>
    ({
      mode: env.mode,
      hasUI: true,
      cwd: "/tmp/goal-test",
      ui: {
        notify: (message: string, level: string) => notifications.push({ message, level }),
        setStatus: (key: string, value: string | undefined) => statuses.push([key, value]),
      },
      isIdle: () => env.idle,
      hasPendingMessages: () => env.pending,
      sessionManager: { getBranch: () => new Array(env.branchLength) },
    }) as unknown as ExtensionContext;
  const settled = {} as AgentSettledEvent;
  const agentEnd = (messages: unknown[]) => ({ type: "agent_end", messages }) as unknown as AgentEndEvent;
  return {
    hook,
    goal,
    record,
    spawn,
    sent,
    persisted,
    execCalls,
    warnings,
    notifications,
    statuses,
    timers,
    env,
    ctx,
    settled,
    agentEnd,
    setExecResult: (r: { code: number; killed: boolean }) => {
      execResult = r;
    },
  };
}

describe("goal loop hook gates", () => {
  it("skips non-tui modes entirely (v2 C8: literal 'tui')", async () => {
    const h = harness();
    for (const mode of ["print", "json", "rpc"]) {
      h.env.mode = mode;
      h.hook.onAgentSettled(h.settled, h.ctx());
    }
    await flush();
    expect(h.execCalls).toHaveLength(0);
    expect(h.record?.evalCount).toBe(0);
  });

  it("does nothing without a record, when paused, or when disabled", async () => {
    const noRecord = harness({ record: null });
    noRecord.hook.onAgentSettled(noRecord.settled, noRecord.ctx());
    const paused = harness({ record: { state: "paused" } });
    paused.hook.onAgentSettled(paused.settled, paused.ctx());
    const disabled = harness({ settings: { enabled: false } });
    disabled.hook.onAgentSettled(disabled.settled, disabled.ctx());
    await flush();
    for (const h of [noRecord, paused, disabled]) {
      expect(h.execCalls).toHaveLength(0);
      expect(h.sent).toHaveLength(0);
    }
  });

  it("skips while an evaluation is in flight, while not idle, or with pending messages", async () => {
    const inFlight = harness({
      spawnAndWait: () => new Promise<RunOutcome>(() => undefined),
      record: { untilCmd: undefined, untilText: "done" },
    });
    inFlight.hook.onAgentSettled(inFlight.settled, inFlight.ctx());
    await flush();
    inFlight.hook.onAgentSettled(inFlight.settled, inFlight.ctx());
    await flush();
    expect(inFlight.spawn.spawnAndWait).toHaveBeenCalledTimes(1);

    const busy = harness();
    busy.env.idle = false;
    busy.hook.onAgentSettled(busy.settled, busy.ctx());
    const pending = harness();
    pending.env.pending = true;
    pending.hook.onAgentSettled(pending.settled, pending.ctx());
    await flush();
    expect(busy.execCalls).toHaveLength(0);
    expect(pending.execCalls).toHaveLength(0);
  });
});

describe("goal loop abort detection (v4 condition 1)", () => {
  it("auto-pauses on abort and accounts usage (token = input+output only)", async () => {
    const h = harness();
    h.hook.onAgentEnd(
      h.agentEnd([
        { role: "user", content: [] },
        {
          role: "assistant",
          stopReason: "aborted",
          usage: { input: 3, output: 2, cacheRead: 500, cost: { total: 0.5 } },
        },
      ]),
    );
    expect(h.record?.tokensUsed).toBe(5); // cacheRead 不计（v4 条件 6）
    expect(h.record?.costUsdUsed).toBe(0.5);
    h.hook.onAgentSettled(h.settled, h.ctx());
    await flush();
    expect(h.record?.state).toBe("paused");
    expect(h.execCalls).toHaveLength(0);
    expect(h.sent).toHaveLength(0);
    expect(h.notifications.some((n) => n.message.includes("自动暂停"))).toBe(true);
    expect(h.statuses.at(-1)).toEqual(["goal", "🎯 goal ⏸ 0/10"]);
  });

  it("does not auto-pause for non-abort stop reasons", async () => {
    const h = harness();
    h.hook.onAgentEnd(h.agentEnd([{ role: "assistant", stopReason: "stop" }]));
    h.hook.onAgentSettled(h.settled, h.ctx());
    await flush();
    expect(h.record?.state).not.toBe("paused");
    expect(h.execCalls).toHaveLength(1); // 正常评估
  });
});

describe("goal loop brakes", () => {
  it("stops with max-evals when evalCount hits the hard cap (BLK-3)", async () => {
    const h = harness();
    h.record!.evalCount = maxEvalsOf(h.record!);
    h.hook.onAgentSettled(h.settled, h.ctx());
    await flush();
    expect(h.execCalls).toHaveLength(0);
    expect(h.record?.state).toBe("stopped");
    expect(h.record?.stopReason).toBe("max-evals");
    expect(h.sent.some((t) => t.includes("评估次数上限"))).toBe(true);
  });

  it("stops with budget when tokens/cost/minutes are blown before evaluation", async () => {
    const byTokens = harness({ record: { budgetTokens: 100, tokensUsed: 100 } });
    byTokens.hook.onAgentSettled(byTokens.settled, byTokens.ctx());
    await flush();
    expect(byTokens.record?.stopReason).toBe("budget");
    expect(byTokens.execCalls).toHaveLength(0);

    const byCost = harness({ record: { budgetCostUsd: 1, costUsdUsed: 1.2 } });
    byCost.hook.onAgentSettled(byCost.settled, byCost.ctx());
    await flush();
    expect(byCost.record?.stopReason).toBe("budget");

    const byTime = harness({ record: { maxMinutes: 1, createdAt: 0 } });
    byTime.hook.onAgentSettled(byTime.settled, byTime.ctx()); // now=1000 < 60_000：不刹车
    await flush();
    expect(byTime.record?.stopReason).toBe("achieved"); // until-cmd 通过 → achieved，证明未触发 budget
  });
});

describe("goal loop until-cmd evaluation (D4)", () => {
  it("exit 0 without until-text achieves the goal", async () => {
    const h = harness();
    h.hook.onAgentSettled(h.settled, h.ctx());
    await flush();
    expect(h.execCalls).toEqual(["npm test"]);
    expect(h.spawn.spawnAndWait).not.toHaveBeenCalled();
    expect(h.record?.state).toBe("stopped");
    expect(h.record?.stopReason).toBe("achieved");
    expect(h.record?.evalCount).toBe(1);
    expect(h.sent).toHaveLength(1);
    expect(h.sent[0]).toContain("/goal 达成");
    expect(h.statuses.at(-1)).toEqual(["goal", undefined]); // 徽标清除
  });

  it("exit non-zero continues the loop with the gap and arms the delivery watchdog", async () => {
    const h = harness({ execResult: { code: 3, killed: false } });
    h.hook.onAgentSettled(h.settled, h.ctx());
    await flush();
    expect(h.record?.state).toBe("active");
    expect(h.record?.iteration).toBe(1);
    expect(h.record?.evalCount).toBe(1);
    expect(h.sent).toHaveLength(1);
    expect(h.sent[0]).toContain("续跑");
    expect(h.sent[0]).toContain("exit 3");
    expect(h.sent[0]).toContain("ask_user"); // M-b：明令禁止
    const watchdog = h.timers.at(-1)!;
    expect(watchdog.ms).toBe(h.goal.settings.deliveryWatchdogMs);
    // 观察到新 run（agent 忙）→ 看门狗静默
    h.env.idle = false;
    watchdog.fn();
    expect(h.sent).toHaveLength(1);
    expect(h.record?.state).toBe("active");
  });

  it("killed until-cmd reports the timeout phrase", async () => {
    const h = harness({ execResult: { code: -1, killed: true } });
    h.hook.onAgentSettled(h.settled, h.ctx());
    await flush();
    expect(h.sent[0]).toContain("超时被终止");
  });

  it("delivery watchdog retries once then stops with delivery-failed (v4 condition 4)", async () => {
    const h = harness({ execResult: { code: 1, killed: false } });
    h.hook.onAgentSettled(h.settled, h.ctx());
    await flush();
    expect(h.sent).toHaveLength(1);
    // 第一次看门狗：未观察到新 run（仍 idle、分支无增长）→ 重试一次
    h.timers.at(-1)!.fn();
    expect(h.sent).toHaveLength(2);
    expect(h.record?.state).toBe("active");
    // 第二次：仍无新 run → stopped("delivery-failed") + 终止报告
    h.timers.at(-1)!.fn();
    expect(h.record?.state).toBe("stopped");
    expect(h.record?.stopReason).toBe("delivery-failed");
    expect(h.sent.at(-1)).toContain("续跑投递失败");
  });

  it("delivery watchdog is invalidated by pause (epoch bump) mid-window", async () => {
    const h = harness({ execResult: { code: 1, killed: false } });
    h.hook.onAgentSettled(h.settled, h.ctx());
    await flush();
    // 模拟 /goal pause（命令层：状态迁移 + epoch++）
    h.record!.state = "paused";
    h.record!.epoch += 1;
    h.timers.at(-1)!.fn();
    expect(h.sent).toHaveLength(1); // 不重试
    expect(h.record?.state).toBe("paused");
  });
});

describe("goal loop verifier evaluation (D1-D4, v4 condition 10)", () => {
  const textOnly = { untilCmd: undefined, untilText: "构建通过且文档更新" };

  it("spawns the verifier with schema/low thinking/budget/model overrides and continues on gap", async () => {
    const h = harness({
      record: { ...textOnly },
      spawnAndWait: () => Promise.resolve(makeOutcome({ structuredResult: { goal_met: false, gap: "还差 README" } })),
    });
    h.hook.onAgentSettled(h.settled, h.ctx());
    await flush();
    expect(h.execCalls).toHaveLength(0); // 无 until-cmd
    const req = h.spawn.spawnAndWait.mock.calls[0]![0];
    expect(req.type).toBe("verifier");
    expect(req.thinkingOverride).toBe("low");
    expect(req.modelHintOverride).toBe("cloudrouter-anthropic/claude-sonnet-5");
    expect(req.budgetOverride).toMatchObject({ totalMs: 300_000 });
    expect(req.schema).toMatchObject({ required: ["goal_met", "gap"] });
    expect(req.label).toMatch(/^goal-eval-/);
    expect(req.prompt).toContain("修复全部测试");
    expect(h.record?.tokensUsed).toBe(15); // verifier input+output 计入
    expect(h.record?.costUsdUsed).toBe(0.01);
    expect(h.sent[0]).toContain("还差 README");
    expect(h.record?.iteration).toBe(1);
  });

  it("achieves when the verifier reports goal_met", async () => {
    const h = harness({ record: { ...textOnly } });
    h.hook.onAgentSettled(h.settled, h.ctx());
    await flush();
    expect(h.record?.stopReason).toBe("achieved");
    expect(h.sent[0]).toContain("/goal 达成");
  });

  it("AND semantics: until-cmd pass + verifier gap continues the loop", async () => {
    const h = harness({
      record: { untilText: "文档已更新" },
      spawnAndWait: () => Promise.resolve(makeOutcome({ structuredResult: { goal_met: false, gap: "文档未动" } })),
    });
    h.hook.onAgentSettled(h.settled, h.ctx());
    await flush();
    expect(h.execCalls).toEqual(["npm test"]); // cmd 先跑且通过
    expect(h.spawn.spawnAndWait).toHaveBeenCalledTimes(1); // 然后才 verifier
    expect(h.sent[0]).toContain("文档未动");
  });

  it("until-cmd failure short-circuits the verifier (D4)", async () => {
    const h = harness({ record: { untilText: "文档已更新" }, execResult: { code: 1, killed: false } });
    h.hook.onAgentSettled(h.settled, h.ctx());
    await flush();
    expect(h.spawn.spawnAndWait).not.toHaveBeenCalled();
    expect(h.sent[0]).toContain("exit 1");
  });

  it("falls back to the general type with a built-in prompt on unknown agent type (M-a), warning once", async () => {
    let calls = 0;
    const h = harness({
      record: { ...textOnly },
      spawnAndWait: (req) => {
        calls += 1;
        if (req.type === "verifier") return Promise.reject(new Error("unknown agent type: verifier. …"));
        return Promise.resolve(makeOutcome());
      },
    });
    h.hook.onAgentSettled(h.settled, h.ctx());
    await flush();
    expect(calls).toBe(2);
    const fallbackReq = h.spawn.spawnAndWait.mock.calls[1]![0];
    expect(fallbackReq.type).toBe("general");
    expect(fallbackReq.prompt).toContain("独立评估器");
    expect(h.warnings.some((w) => w.includes("falling back"))).toBe(true);
    expect(h.record?.stopReason).toBe("achieved");
  });

  it("eval timeout counts as a failure; two consecutive failures stop the goal (v4 condition 10)", async () => {
    const h = harness({
      record: { ...textOnly },
      spawnAndWait: () => new Promise<RunOutcome>(() => undefined),
    });
    h.hook.onAgentSettled(h.settled, h.ctx());
    await flush();
    // 评估超时闩锁看门狗：fire eval timeout
    const evalTimer = h.timers.find((t) => t.ms === h.goal.settings.evalTimeoutMs)!;
    evalTimer.fn();
    await flush();
    expect(h.record?.state).toBe("active"); // 第一次失败不停止
    expect(h.record?.consecutiveEvalFailures).toBe(1);
    expect(h.sent[0]).toContain("评估器出错");
    // 第二轮：再次超时 → stopped("eval-failures")
    h.env.idle = true;
    h.hook.onAgentSettled(h.settled, h.ctx());
    await flush();
    const evalTimer2 = h.timers.filter((t) => t.ms === h.goal.settings.evalTimeoutMs).at(-1)!;
    evalTimer2.fn();
    await flush();
    expect(h.record?.state).toBe("stopped");
    expect(h.record?.stopReason).toBe("eval-failures");
    expect(h.sent.at(-1)).toContain("评估器连续失败");
  });

  it("verifier run failure (non-completed status) counts toward eval failures", async () => {
    const h = harness({
      record: { ...textOnly },
      spawnAndWait: () =>
        Promise.resolve(makeOutcome({ status: "timed_out", timeoutReason: "total", structuredResult: undefined })),
    });
    h.hook.onAgentSettled(h.settled, h.ctx());
    await flush();
    expect(h.record?.consecutiveEvalFailures).toBe(1);
    expect(h.sent[0]).toContain("评估器出错");
  });

  it("discards evaluation results after an epoch change (v4 condition 7)", async () => {
    let resolveSpawn: (outcome: RunOutcome) => void = () => undefined;
    const h = harness({
      record: { ...textOnly },
      spawnAndWait: () => new Promise<RunOutcome>((resolve) => (resolveSpawn = resolve)),
    });
    h.hook.onAgentSettled(h.settled, h.ctx());
    await flush();
    // 评估 in-flight 期间用户 /goal pause（命令层：paused + epoch++）
    h.record!.state = "paused";
    h.record!.epoch += 1;
    resolveSpawn(makeOutcome());
    await flush();
    expect(h.sent).toHaveLength(0); // 结果丢弃，不续跑
    expect(h.record?.state).toBe("paused");
    // 闩锁已释放但状态非 active：再 settled 也不评估
    h.hook.onAgentSettled(h.settled, h.ctx());
    await flush();
    expect(h.sent).toHaveLength(0);
  });
});
