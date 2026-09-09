import { describe, expect, it, vi } from "vitest";
import type { ExtensionAPI, ExtensionCommandContext, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { buildSessionStack, type Stack } from "../../src/stack.js";
import { DEFAULT_SETTINGS, type AgentSettings } from "../../src/config/settings.js";
import { createGoalCommand } from "../../src/goal/command.js";
import { createGoalLoopHook } from "../../src/goal/hook.js";
import { GOAL_ENTRY_TYPE, persistGoalRecord } from "../../src/goal/store.js";
import { createGoalRecord } from "../../src/goal/state.js";

const flush = async () => {
  for (let i = 0; i < 40; i++) await Promise.resolve();
};

function fakePi(execResult: { code: number; killed: boolean }) {
  const appended: Array<{ type: string; data: unknown }> = [];
  const userMessages: Array<{ text: string; options: unknown }> = [];
  const pi = {
    sendMessage: () => undefined,
    sendUserMessage: (text: string, options: unknown) => userMessages.push({ text, options }),
    appendEntry: (type: string, data: unknown) => appended.push({ type, data }),
    exec: async () => execResult,
    events: { emit: () => undefined, on: () => () => undefined },
  } as unknown as ExtensionAPI;
  return { pi, appended, userMessages };
}

function makeCtx(cwd: string, branch: unknown[] = []) {
  const notifications: Array<{ message: string; level: string }> = [];
  const statuses: Array<[string, string | undefined]> = [];
  const ctx = {
    cwd,
    hasUI: true,
    mode: "tui", // v2-A8：字面值必须是 "tui"
    isIdle: () => true,
    hasPendingMessages: () => false,
    sessionManager: {
      getEntries: () => [],
      getBranch: () => branch,
      getSessionId: () => "goal-wiring-test",
    },
    modelRegistry: { getAvailable: () => [], find: () => undefined },
    ui: {
      notify: (message: string, level: string) => notifications.push({ message, level }),
      setStatus: (key: string, value: string | undefined) => statuses.push([key, value]),
    },
  } as unknown as ExtensionContext;
  return { ctx, notifications, statuses };
}

const emptyTypes = { get: () => undefined, list: () => [], reload: async () => ({ types: [], errors: [] }) } as never;

function testSettings(): AgentSettings {
  return {
    ...DEFAULT_SETTINGS,
    fleetWidget: false,
    bashJobs: { ...DEFAULT_SETTINGS.bashJobs, autoBackgroundMs: 0 },
  };
}

async function runGoalCommand(
  cmd: ReturnType<typeof createGoalCommand>,
  args: string,
  ctx: ExtensionContext,
): Promise<void> {
  await cmd.handler(args, ctx as unknown as ExtensionCommandContext);
}

describe("goal wiring (fake pi + ctx end-to-end)", () => {
  it("set → settled → until-cmd exit 0 → achieved, with badge and persisted entries", async () => {
    const host = fakePi({ code: 0, killed: false });
    const env = makeCtx("/tmp/goal-wiring-1");
    const settings = testSettings();
    const holder: { current?: Stack } = {};
    const stack = buildSessionStack(host.pi, env.ctx, settings, emptyTypes, []);
    holder.current = stack;
    expect(stack.goal.record).toBeUndefined();

    const command = createGoalCommand({
      goal: () => holder.current?.goal,
      persist: (record) => persistGoalRecord(host.pi, record),
    });
    await runGoalCommand(command, '修复全部测试 --until-cmd "npm test" --max-turns 5', env.ctx);
    const record = stack.goal.record!;
    expect(record.state).toBe("active");
    expect(record.objective).toBe("修复全部测试");
    expect(record.untilCmd).toBe("npm test");
    expect(record.maxTurns).toBe(5);
    expect(host.appended.at(-1)).toMatchObject({ type: GOAL_ENTRY_TYPE });
    expect(env.statuses.at(-1)).toEqual(["goal", "🎯 goal 0/5"]);

    const hook = createGoalLoopHook(holder, {
      exec: (cmd, opts) =>
        host.pi.exec("bash", ["-c", cmd], { timeout: opts.timeoutMs, cwd: opts.cwd }) as Promise<{
          code: number;
          killed: boolean;
        }>,
      sendUserMessage: (text) => host.pi.sendUserMessage(text, { deliverAs: "followUp" }),
      persist: (r) => persistGoalRecord(host.pi, r),
    });
    hook.onAgentEnd({
      type: "agent_end",
      messages: [
        {
          role: "assistant",
          stopReason: "stop",
          usage: { input: 100, output: 50, cacheRead: 0, cost: { total: 0.02 } },
        },
      ],
    } as never);
    hook.onAgentSettled({ type: "agent_settled" } as never, env.ctx);
    await flush();

    expect(record.tokensUsed).toBe(150);
    expect(record.costUsdUsed).toBe(0.02);
    expect(record.state).toBe("stopped");
    expect(record.stopReason).toBe("achieved");
    expect(host.userMessages).toHaveLength(1);
    expect(host.userMessages[0]!.text).toContain("/goal 达成");
    expect(host.userMessages[0]!.options).toEqual({ deliverAs: "followUp" });
    expect(env.statuses.at(-1)).toEqual(["goal", undefined]);
    stack.scheduler.stop();
    stack.rpc.close();
  });

  it("rehydrates by session reason: resume notifies, reload is silent, new never inherits", async () => {
    const goalEntry = {
      type: "custom",
      customType: GOAL_ENTRY_TYPE,
      data: createGoalRecord({
        objective: "遗留目标",
        untilCmd: "npm test",
        maxTurns: 10,
        maxMinutes: 60,
        budgetTokens: 0,
        budgetCostUsd: 0,
        now: 1,
      }),
    };
    const host = fakePi({ code: 0, killed: false });

    const resumed = makeCtx("/tmp/goal-wiring-2", [goalEntry]);
    const stackResume = buildSessionStack(host.pi, resumed.ctx, testSettings(), emptyTypes, [], "resume");
    expect(stackResume.goal.record).toMatchObject({ state: "paused", objective: "遗留目标", epoch: 2 });
    expect(resumed.notifications.some((n) => n.message.includes("/goal resume"))).toBe(true);
    expect(resumed.statuses.at(-1)?.[0]).toBe("goal");
    stackResume.scheduler.stop();
    stackResume.rpc.close();

    const reloaded = makeCtx("/tmp/goal-wiring-3", [goalEntry]);
    const stackReload = buildSessionStack(host.pi, reloaded.ctx, testSettings(), emptyTypes, [], "reload");
    expect(stackReload.goal.record?.state).toBe("paused");
    expect(reloaded.notifications).toHaveLength(0);
    stackReload.scheduler.stop();
    stackReload.rpc.close();

    const fresh = makeCtx("/tmp/goal-wiring-4", [goalEntry]);
    const stackNew = buildSessionStack(host.pi, fresh.ctx, testSettings(), emptyTypes, [], "new");
    expect(stackNew.goal.record).toBeUndefined();
    expect(fresh.notifications).toHaveLength(0);
    stackNew.scheduler.stop();
    stackNew.rpc.close();
  });

  it("subcommand disambiguation (v4 Nit): single-token only; 'pause the deploy' is an objective", async () => {
    const host = fakePi({ code: 0, killed: false });
    const env = makeCtx("/tmp/goal-wiring-5");
    const holder: { current?: Stack } = {};
    holder.current = buildSessionStack(host.pi, env.ctx, testSettings(), emptyTypes, []);
    const command = createGoalCommand({
      goal: () => holder.current?.goal,
      persist: (record) => persistGoalRecord(host.pi, record),
    });
    // 多 token 以子命令词开头 → 仍是目标文本
    await runGoalCommand(command, 'pause the deploy pipeline --until-cmd "true"', env.ctx);
    expect(holder.current.goal.record?.state).toBe("active");
    expect(holder.current.goal.record?.objective).toBe("pause the deploy pipeline");
    // 单 token pause → 真子命令
    await runGoalCommand(command, "pause", env.ctx);
    expect(holder.current.goal.record?.state).toBe("paused");
    // resume --reset-budget 尾巴被容忍（唯一多 token 子命令形态）
    await runGoalCommand(command, "resume --reset-budget", env.ctx);
    expect(holder.current.goal.record?.state).toBe("active");
    // status / clear
    await runGoalCommand(command, "status", env.ctx);
    expect(env.notifications.at(-1)!.message).toContain("goal 状态");
    await runGoalCommand(command, "clear", env.ctx);
    expect(holder.current.goal.record?.state).toBe("none");
    expect(env.statuses.at(-1)).toEqual(["goal", undefined]);
    holder.current.scheduler.stop();
    holder.current.rpc.close();
  });

  it("stopped(budget) resume requires --reset-budget and resets the counters", async () => {
    const host = fakePi({ code: 0, killed: false });
    const env = makeCtx("/tmp/goal-wiring-6");
    const holder: { current?: Stack } = {};
    holder.current = buildSessionStack(host.pi, env.ctx, testSettings(), emptyTypes, []);
    const command = createGoalCommand({
      goal: () => holder.current?.goal,
      persist: (record) => persistGoalRecord(host.pi, record),
    });
    await runGoalCommand(command, 'x --until-cmd "true" --budget-tokens 10', env.ctx);
    const record = holder.current.goal.record!;
    record.state = "stopped";
    record.stopReason = "budget";
    record.tokensUsed = 500;
    record.evalCount = 3;
    await runGoalCommand(command, "resume", env.ctx);
    expect(record.state).toBe("stopped"); // 拒绝，需要 --reset-budget
    expect(env.notifications.at(-1)!.message).toContain("--reset-budget");
    await runGoalCommand(command, "resume --reset-budget", env.ctx);
    expect(record.state).toBe("active");
    expect(record.tokensUsed).toBe(0);
    expect(record.evalCount).toBe(0);
    holder.current.scheduler.stop();
    holder.current.rpc.close();
  });
});
