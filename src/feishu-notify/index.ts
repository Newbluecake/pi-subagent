/**
 * Feishu Notify Extension (v2)
 *
 * 任务结束时发送飞书机器人通知（显式开启，无时间阈值），
 * 并新增三个触发场景：长任务心跳、subagent 完成汇总、会话空闲提醒。
 *
 * 详见 docs/dev/feishu-notify/feishu-notify-v2-plan.md（唯一权威规格）与
 * docs/dev/feishu-notify/feishu-notify-extension.md（用户文档）。
 *
 * 三种开启方式（任选）：
 *   1. 任务描述里带 @notify 关键词
 *   2. /skill:notify（AI 主动调用 feishu_notify 工具）
 *   3. /watch 命令（会话级关注）
 *
 * 配置（二选一）：
 *   1. 配置文件 ~/.pi/agent/feishu-notify.json
 *   2. 环境变量 FEISHU_WEBHOOK_URL / FEISHU_WEBHOOK_SECRET
 */

import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Type } from "@sinclair/typebox";
import { appendFileSync, existsSync, mkdirSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { basename, join } from "node:path";
import {
  type BuildCardOverrides,
  type CardStatus,
  type Config,
  SubagentTracker,
  buildCard,
  buildSubagentSummaryText,
  extractSummary,
  formatDuration,
  parseConfig,
  parseSubagentLifecycle,
  sendToFeishu,
  truncate,
  isBackgroundIdle,
  type FrozenCardInput,
  type PendingNotification,
} from "./core.js";
import { readBackgroundStatus } from "../service/background-status.js";

const CONFIG_DIR = join(homedir(), ".pi", "agent");
const LOG_PATH = join(CONFIG_DIR, "feishu-notify.log");

/** 配置文件路径：默认 ~/.pi/agent/feishu-notify.json；可用 FEISHU_NOTIFY_CONFIG_PATH 覆盖（测试隔离用） */
function configPath(): string {
  return process.env.FEISHU_NOTIFY_CONFIG_PATH ?? join(CONFIG_DIR, "feishu-notify.json");
}

/** 任务描述中的通知触发词 */
const NOTIFY_KEYWORDS = ["@notify", "#notify"];

function loadConfig(): Config {
  let fileConfig: Config = {};
  if (existsSync(configPath())) {
    try {
      fileConfig = JSON.parse(readFileSync(configPath(), "utf-8"));
    } catch (err) {
      log(`config parse error: ${err}`);
    }
  }
  return parseConfig(fileConfig, process.env);
}

function log(message: string): void {
  try {
    mkdirSync(CONFIG_DIR, { recursive: true });
    appendFileSync(LOG_PATH, `[${new Date().toISOString()}] ${message}\n`);
  } catch {
    // 日志失败不影响主流程
  }
}

export default function (pi: ExtensionAPI) {
  const hostKey = Symbol.for("pi-subagent:feishu-notify:host");
  const global = globalThis as Record<symbol, unknown>;
  if (global[hostKey]) return;
  const claim = { activatedAt: Date.now() };
  global[hostKey] = claim;
  let conflictInert = false;
  let config = loadConfig();

  // ---- 任务级状态（一个「用户任务」生命周期，可跨多次 agent_start/settled 中的 run 内续跑） ----
  let taskPrompt = "";
  let taskStartedAt = 0;
  let turns = 0;
  let toolCalls = 0;
  let toolErrors = 0;
  let hadError = false;
  let errorMessage = "";
  let taskGate = false; // 任务通知门闩
  let notifiedThisRun = false; // feishu_notify 工具抢发标记（任务级）

  // ---- run 级状态 ----
  let running = false; // 基线已有
  let isUserRun = false; // 本 run 是否为「用户发起的首个 run」

  // ---- 接力 ----
  let userInputPending = false; // input 事件置位，下一次 agent_start / agent_settled 消费

  // ---- 通知开关：@notify 关键词（单次）或 /watch（会话级） ----
  let notifyRequested = false;
  let watched = false;

  // ---- 心跳 ----
  let heartbeatTimer: ReturnType<typeof setTimeout> | undefined;
  let lastCtx: ExtensionContext | undefined;
  let lastProject = "";

  // ---- 空闲提醒 ----
  let idleTimer: ReturnType<typeof setTimeout> | undefined;

  // ---- subagent 汇总 ----
  const subagents = new SubagentTracker();
  let flushTimer: ReturnType<typeof setTimeout> | undefined;
  let backgroundTimer: ReturnType<typeof setTimeout> | undefined;
  const pendings = new Map<string, PendingNotification>();
  let missingStatusWarned = false;

  // ---- 等待输入提醒：交互工具打开后长时间未结束 → 飞书提醒（按 toolCallId 跟踪） ----
  interface WaitTimerEntry {
    timer: ReturnType<typeof setTimeout>;
    toolName: string;
    args: unknown;
    ctx: ExtensionContext;
  }
  const waitTimers = new Map<string, WaitTimerEntry>();

  function clearWaitTimers(): void {
    for (const entry of waitTimers.values()) clearTimeout(entry.timer);
    waitTimers.clear();
  }

  /** gateOpen() = watched || taskGate || notifyRequested （并集） */
  function gateOpen(): boolean {
    return watched || taskGate || notifyRequested;
  }

  function backgroundIdle(): boolean {
    if (config.requireBackgroundIdle === false) return true;
    const status = readBackgroundStatus();
    if (!status && !missingStatusWarned) {
      missingStatusWarned = true;
      log("background status provider missing; gated notification held");
      if (lastCtx?.hasUI) lastCtx.ui.notify("后台任务状态不可用，已暂缓完成类飞书通知", "warning");
    }
    return isBackgroundIdle(status);
  }

  function scheduleBackgroundCheck(): void {
    if (backgroundTimer || pendings.size === 0) return;
    const delay = config.backgroundIdleRecheckMs ?? 5000;
    if (delay <= 0) return;
    backgroundTimer = setTimeout(() => {
      backgroundTimer = undefined;
      void drainPending();
    }, delay);
    backgroundTimer.unref?.();
  }

  function queuePending(entry: PendingNotification): void {
    pendings.set(entry.key, entry);
    scheduleBackgroundCheck();
  }

  async function drainPending(): Promise<void> {
    const now = Date.now();
    for (const [key, entry] of pendings) {
      if (entry.state !== "pending") continue;
      if (!backgroundIdle() && now < entry.deadlineAt) continue;
      entry.state = "sending";
      if (entry.kind === "subagents") {
        if (lastCtx) doFlushSubagentSummary(lastCtx, true);
        entry.state = "sent";
        pendings.delete(key);
        continue;
      }
      const card = entry.card;
      const result = card
        ? await sendCard(
            lastCtx,
            card.status,
            card.summary,
            card.errorMessage,
            card.overrides,
            card.statsOverride as Partial<ReturnType<typeof currentStats>>,
            false,
            now >= entry.deadlineAt,
          )
        : { ok: false, error: "pending card unavailable" };
      entry.state = result.ok ? "sent" : "failed";
      pendings.delete(key);
    }
    if (pendings.size > 0) scheduleBackgroundCheck();
  }

  // ------------------------------------------------------------------
  // 心跳 💓
  // ------------------------------------------------------------------

  function clearHeartbeat(): void {
    if (heartbeatTimer) {
      clearTimeout(heartbeatTimer);
      heartbeatTimer = undefined;
    }
  }

  /** 幂等：已 arm 直接 return。 */
  function armHeartbeat(): void {
    if (heartbeatTimer) return;
    const intervalSec = config.heartbeatIntervalSec ?? 600;
    if (intervalSec <= 0) return;
    const intervalMs = intervalSec * 1000;

    const tick = () => {
      heartbeatTimer = undefined;
      if (!running || !lastCtx) return; // 🟢-1：不崩在计时器里
      if (gateOpen()) {
        const status = readBackgroundStatus();
        const details = status
          ? `后台任务：subagent ${status.runningSubagents} 个，bash ${status.runningBashJobs ?? 0} 个`
          : undefined;
        void sendCard(lastCtx, "heartbeat", extractSummary(lastCtx), undefined, details ? { details } : undefined, {
          project: lastProject,
        });
      }
      heartbeatTimer = setTimeout(tick, intervalMs); // 门控未开也续排，支持中途 /watch
      heartbeatTimer.unref?.();
    };
    heartbeatTimer = setTimeout(tick, intervalMs);
    heartbeatTimer.unref?.();
  }

  // ------------------------------------------------------------------
  // 空闲提醒 💤
  // ------------------------------------------------------------------

  function clearIdleTimer(): void {
    if (idleTimer) {
      clearTimeout(idleTimer);
      idleTimer = undefined;
    }
  }

  function armIdleTimer(ctx: ExtensionContext): void {
    clearIdleTimer();
    const timeoutSec = config.idleNotifyTimeoutSec ?? 300;
    if (timeoutSec <= 0) return;
    // 快照上一轮统计用于 💤 卡的「上轮耗时/上轮工具调用/上轮结果摘要」
    const snapshotDurationSec = taskStartedAt > 0 ? Math.round((Date.now() - taskStartedAt) / 1000) : 0;
    const snapshotToolCalls = toolCalls;
    const snapshotToolErrors = toolErrors;
    const snapshotSummary = extractSummary(ctx);
    const snapshotPrompt = taskPrompt;

    idleTimer = setTimeout(() => {
      idleTimer = undefined;
      if (config.requireBackgroundIdle !== false && !backgroundIdle()) return;
      void sendCard(
        ctx,
        "idle",
        snapshotSummary,
        undefined,
        {
          turnsLabel: "上轮耗时",
          turnsValue: formatDuration(snapshotDurationSec),
          toolCallsLabel: "工具调用",
        },
        {
          project: basename(ctx.cwd),
          prompt: snapshotPrompt,
          durationSec: timeoutSec, // 耗时格 = 空闲时长
          turns: snapshotDurationSec, // 第三格数值兜底；展示文本由 turnsValue（formatDuration）提供
          toolCalls: snapshotToolCalls,
          toolErrors: snapshotToolErrors,
        },
      );
    }, timeoutSec * 1000);
    idleTimer.unref?.();
  }

  // ------------------------------------------------------------------
  // subagent 汇总 🤖
  // ------------------------------------------------------------------

  /** 四处统一调用：通道 A settled、通道 B 投递、agent_settled、agent_start（补偿） */
  function maybeFlushSubagentSummary(ctx: ExtensionContext): void {
    if (config.subagentSummaryEnabled === false) {
      subagents.discardFinished();
      return;
    }
    if (subagents.runningCount(Date.now()) > 0) return; // 还有在跑的 → 不发
    if (!subagents.hasFinished()) return;
    scheduleFlush(ctx, Math.max(0, config.subagentFlushDebounceMs ?? 1500));
  }

  function scheduleFlush(ctx: ExtensionContext, waitMs: number): void {
    if (flushTimer) clearTimeout(flushTimer);
    flushTimer = setTimeout(() => {
      flushTimer = undefined;
      doFlushSubagentSummary(ctx);
    }, waitMs);
    flushTimer.unref?.();
  }

  function doFlushSubagentSummary(ctx: ExtensionContext, fromDeadline = false): void {
    const now = Date.now();
    if (subagents.runningCount(now) > 0 || !subagents.hasFinished()) return; // 复检

    // 🟡-A「等 B」：仍有 finished 记录在宽限内等投递 → 重排，不组卡
    const waitMs = subagents.pendingDeliveryWaitMs(now, Math.max(0, config.subagentDeliveryGraceMs ?? 6000));
    if (waitMs > 0) {
      scheduleFlush(ctx, waitMs);
      return;
    }

    if (!gateOpen()) {
      subagents.discardFinished();
      return;
    }
    if (!fromDeadline && config.requireBackgroundIdle !== false && !backgroundIdle()) {
      queuePending({
        key: "subagents:batch",
        kind: "subagents",
        createdAt: now,
        deadlineAt: now + Math.max(0, config.backgroundDeferCapMs ?? 600000),
        state: "pending",
      });
      return;
    }

    const recs = subagents.drainFinished();
    // 🟡-C 混合批次规则：批次内只要存在 hadDelivery 记录 → 整批入卡；
    // 仅整批都无 B 投递（纯前台批次）才静默丢弃。
    if (config.subagentForegroundSummary !== true && !recs.some((r) => r.hadDelivery)) return;

    const allOk = recs.every((r) => r.status === "completed");
    const earliestStart = recs.reduce<number | undefined>((min, r) => {
      if (r.startedAt === undefined) return min;
      return min === undefined ? r.startedAt : Math.min(min, r.startedAt);
    }, undefined);
    const latestEnd = recs.reduce<number | undefined>((max, r) => {
      if (r.endedAt === undefined) return max;
      return max === undefined ? r.endedAt : Math.max(max, r.endedAt);
    }, undefined);
    const totalDurationSec =
      earliestStart !== undefined && latestEnd !== undefined ? Math.round((latestEnd - earliestStart) / 1000) : 0;
    const okCount = recs.filter((r) => r.status === "completed").length;
    const failCount = recs.length - okCount;

    void sendCard(
      ctx,
      "subagents",
      buildSubagentSummaryText(recs),
      undefined,
      {
        template: allOk ? "green" : "red",
        turnsLabel: "Run 数",
        toolCallsLabel: "成功/失败",
        details: buildSubagentSummaryText(recs),
      },
      {
        project: basename(ctx.cwd),
        prompt: taskPrompt || "(无任务描述)",
        durationSec: totalDurationSec,
        turns: recs.length,
        toolCalls: okCount,
        toolErrors: failCount,
        // 汇总卡的 "成功/失败" 用 toolCalls/toolErrors 承载：toolCalls=成功数，toolErrors=失败数
        // buildCard 里会显示 "toolCalls（失败 toolErrors）"
      },
    );
  }

  const onSubStarted = (data: unknown) => {
    const p = parseSubagentLifecycle(data);
    if (!p) return;
    subagents.markStarted(p.runId, Date.now());
    clearIdleTimer(); // 后台 agent 在跑，不算空闲
  };
  const onSubSettled = (data: unknown) => {
    const p = parseSubagentLifecycle(data);
    if (!p || !p.status) return;
    subagents.markSettled(p.runId, p.status, Date.now(), p.generation);
    if (lastCtx) maybeFlushSubagentSummary(lastCtx); // 自持触发点 ①
  };
  for (const ch of ["subagent:started", "subagents:started"]) pi.events.on(ch, onSubStarted);
  for (const ch of ["subagent:completed", "subagent:failed", "subagents:completed", "subagents:failed"])
    pi.events.on(ch, onSubSettled);

  // ------------------------------------------------------------------
  // 等待输入提醒（既有）
  // ------------------------------------------------------------------

  /** 启动/重置某个工具调用的等待计时 */
  function armWaitTimer(toolCallId: string, toolName: string, args: unknown, ctx: ExtensionContext): void {
    const timeoutSec = config.waitNotifyTimeoutSec ?? 120;
    const existing = waitTimers.get(toolCallId);
    if (existing) clearTimeout(existing.timer);

    const timer = setTimeout(() => {
      waitTimers.delete(toolCallId);
      if (!gateOpen()) return;
      const detail = describeWaitTarget(toolName, args);
      const summary = detail
        ? `工具 **${toolName}** 已等待超过 ${formatDuration(timeoutSec)}\n${truncate(detail, 200)}`
        : `工具 **${toolName}** 已等待超过 ${formatDuration(timeoutSec)}`;
      void sendCard(ctx, "waiting", summary);
    }, timeoutSec * 1000);
    timer.unref?.();
    waitTimers.set(toolCallId, { timer, toolName, args, ctx });
  }

  /** 从工具参数中提取可读的等待内容（目前特化 ask_user，其余工具退化为工具名） */
  function describeWaitTarget(toolName: string, args: unknown): string {
    if (toolName === "ask_user" && args && typeof args === "object") {
      const qs = (args as { questions?: { question?: string }[] }).questions;
      if (Array.isArray(qs)) {
        const texts = qs.map((q) => q?.question).filter((t): t is string => typeof t === "string" && !!t);
        if (texts.length > 0) return texts.join("；");
      }
    }
    return "";
  }

  // ------------------------------------------------------------------
  // 卡片发送
  // ------------------------------------------------------------------

  function currentStats(ctx: ExtensionContext) {
    return {
      project: basename(ctx.cwd),
      prompt: taskPrompt || "(无任务描述)",
      durationSec: taskStartedAt > 0 ? Math.round((Date.now() - taskStartedAt) / 1000) : 0,
      turns,
      toolCalls,
      toolErrors,
    };
  }

  async function sendCard(
    ctx: ExtensionContext | undefined,
    status: CardStatus,
    summary: string,
    errMsg?: string,
    overrides?: BuildCardOverrides,
    statsOverride?: Partial<ReturnType<typeof currentStats>>,
    gated = false,
    deferredNote = false,
  ): Promise<{ ok: boolean; error?: string }> {
    if (!ctx) return { ok: false, error: "no active context" };
    if (conflictInert) return { ok: false, error: "feishu-notify conflict detected" };
    if (gated && config.requireBackgroundIdle !== false && !backgroundIdle()) {
      return { ok: false, error: "background tasks still running" };
    }
    if (deferredNote) overrides = { ...overrides, details: `${overrides?.details ?? ""}\n后台任务超时未结束` };
    if (!config.webhookUrl) return { ok: false, error: "webhookUrl 未配置" };
    const stats = { ...currentStats(ctx), ...statsOverride };
    const card = buildCard({ status, summary, errorMessage: errMsg, overrides, ...stats });
    const result = await sendToFeishu(config, card);
    if (!result.ok) {
      log(`send failed: ${result.error}`);
      if (ctx.hasUI) ctx.ui.notify(`飞书通知发送失败: ${result.error}`, "warning");
    }
    return result;
  }

  // ------------------------------------------------------------------
  // 事件订阅
  // ------------------------------------------------------------------

  pi.on("session_start", async (_event, ctx) => {
    config = loadConfig();
    const tools =
      typeof (pi as ExtensionAPI & { getAllTools?: () => unknown[] }).getAllTools === "function"
        ? (pi as ExtensionAPI & { getAllTools: () => unknown[] }).getAllTools()
        : [];
    const ownPath = "/pi-subagent/";
    conflictInert = tools.some((tool) => {
      if (!tool || typeof tool !== "object") return false;
      const info = (tool as { sourceInfo?: unknown }).sourceInfo;
      const source = typeof info === "string" ? info : JSON.stringify(info ?? "");
      const name = (tool as { name?: unknown }).name;
      return (name === "feishu_notify" || name === "ask_user") && source.length > 0 && !source.includes(ownPath);
    });
    if (conflictInert) {
      log("旧 pi-ask-user/feishu-notify detected; notifications disabled");
      if (ctx.hasUI) ctx.ui.notify("检测到旧版 pi-ask-user，请卸载旧包后再使用合并版", "warning");
    }
    watched = false;
    notifyRequested = false;
    running = false;
    taskGate = false;
    userInputPending = false;
    isUserRun = false;
    taskStartedAt = 0;
    subagents.clear();
    clearHeartbeat();
    clearIdleTimer();
    if (flushTimer) {
      clearTimeout(flushTimer);
      flushTimer = undefined;
    }
    if (!config.webhookUrl && ctx.hasUI) {
      ctx.ui.setStatus("feishu-notify", "飞书通知: 未配置 webhook");
    }
  });

  pi.on("session_shutdown", async () => {
    clearHeartbeat();
    clearIdleTimer();
    clearWaitTimers();
    if (flushTimer) {
      clearTimeout(flushTimer);
      flushTimer = undefined;
    }
    if (backgroundTimer) {
      clearTimeout(backgroundTimer);
      backgroundTimer = undefined;
    }
    pendings.clear();
    subagents.clear();
    if (global[hostKey] === claim) delete global[hostKey];
  });

  // 检测 @notify / #notify 关键词，命中则开启本次通知并从 prompt 中移除
  pi.on("input", async (event, ctx) => {
    clearIdleTimer();
    userInputPending = true;
    const keyword = NOTIFY_KEYWORDS.find((k) => event.text.includes(k));
    if (!keyword) return;
    notifyRequested = true;
    if (ctx.hasUI) ctx.ui.notify("已开启本次任务的飞书通知", "info");
    return { action: "transform" as const, text: event.text.replace(keyword, "").trim() };
  });

  pi.on("before_agent_start", async (event) => {
    if (event.prompt) taskPrompt = event.prompt;
  });

  pi.on("agent_start", async (_event, ctx) => {
    lastCtx = ctx;
    lastProject = basename(ctx.cwd);
    clearIdleTimer();

    const userInitiated = userInputPending;
    userInputPending = false;
    if (!running) {
      // 只有「新 run 的开端」才重新判定 isUserRun（🔴-A）；
      // running===true 的 agent_start 是 run 内续跑，一律保持原值，只刷 lastCtx。
      isUserRun = userInitiated || taskStartedAt === 0; // 首 run 无任务上下文时兜底
      if (isUserRun) {
        // 全新用户任务：重置任务级统计与门闩
        taskStartedAt = Date.now();
        turns = 0;
        toolCalls = 0;
        toolErrors = 0;
        hadError = false;
        errorMessage = "";
        notifiedThisRun = false;
        taskGate = watched || notifyRequested;
        clearWaitTimers();
      }
      // else：扩展触发的续跑（subagent triggerTurn 等）——保留统计与 taskGate，结果卡被抑制
    }
    running = true;
    armHeartbeat(); // 幂等
    maybeFlushSubagentSummary(ctx); // 🟢-b：补偿 lastCtx 为空时入库但未 flush 的记录
  });

  // 交互工具打开：启动等待计时，超时未结束则发“等待输入”提醒
  pi.on("tool_execution_start", async (event, ctx) => {
    lastCtx = ctx;
    const timeoutSec = config.waitNotifyTimeoutSec ?? 120;
    const tools = config.waitNotifyTools ?? ["ask_user"];
    if (timeoutSec <= 0 || !tools.includes(event.toolName)) return;
    armWaitTimer(event.toolCallId, event.toolName, event.args, ctx);
  });

  // 用户一旦开始按键操作 → 直接取消等待提醒（而不是重置计时）
  pi.events.on("ask-user:activity", () => {
    clearWaitTimers();
  });

  pi.on("turn_end", async () => {
    turns++;
  });

  pi.on("tool_execution_end", async (event) => {
    toolCalls++;
    if (event.isError) toolErrors++;
    const entry = waitTimers.get(event.toolCallId);
    if (entry) {
      clearTimeout(entry.timer);
      waitTimers.delete(event.toolCallId);
    }
  });

  pi.on("message_end", async (event, ctx) => {
    const m = event.message as {
      role?: string;
      customType?: string;
      details?: unknown;
      stopReason?: string;
      errorMessage?: string;
    };
    if (m.role === "custom" && m.customType === "subagent:notification") {
      subagents.ingestDelivery(m.details, Date.now());
      maybeFlushSubagentSummary(ctx); // 自持触发点 ②
      return;
    }
    if (m.role !== "assistant") return;
    hadError = m.stopReason === "error";
    errorMessage = hadError ? (m.errorMessage ?? "") : "";
  });

  pi.on("agent_settled", async (_event, ctx) => {
    // 边界情况：prompt 在 agent_start 前失败（未曾进入 running=true）也要消费掉 userInputPending，
    // 否则该残留标记会被下一次非用户发起的 agent_start 误判为 userInitiated（🔴-1 兜底的对称修复）。
    userInputPending = false;
    if (!running) return;
    running = false;
    clearHeartbeat();
    clearWaitTimers();
    lastCtx = ctx;

    maybeFlushSubagentSummary(ctx); // 触发点 ③

    const shouldNotify = gateOpen(); // 🔴-3：统一门控
    // 结果卡：仅用户发起的 run；续跑 run 抑制（/watch 不再刷屏）
    if (isUserRun && !notifiedThisRun && shouldNotify) {
      const status = hadError ? "error" : "success";
      const summary = extractSummary(ctx);
      if (config.requireBackgroundIdle !== false && !backgroundIdle()) {
        const now = Date.now();
        const card: FrozenCardInput = { status, summary, errorMessage };
        queuePending({
          key: `result:${taskStartedAt}`,
          kind: "result",
          card,
          createdAt: now,
          deadlineAt: now + Math.max(0, config.backgroundDeferCapMs ?? 600000),
          state: "pending",
        });
      } else {
        await sendCard(ctx, status, summary, errorMessage);
      }
    }
    notifyRequested = false; // 单次关键词消费掉；/watch 与 taskGate 保持
    isUserRun = false;

    // 空闲 arm：统一 gateOpen()；notifiedThisRun 路径不再提前 return
    if (
      shouldNotify &&
      (config.idleNotifyTimeoutSec ?? 300) > 0 &&
      subagents.runningCount(Date.now()) === 0 &&
      (config.requireBackgroundIdle === false || backgroundIdle())
    ) {
      armIdleTimer(ctx);
    }
  });

  // AI 主动通知工具（配合 notify skill 使用，摘要由 AI 撰写）
  pi.registerTool({
    name: "feishu_notify",
    label: "Feishu Notify",
    description:
      "Send a Feishu (Lark) webhook notification about the final result of the current task. " +
      "Call this ONCE when the task is fully complete (or has failed unrecoverably), with a concise summary of what was done.",
    parameters: Type.Object({
      status: Type.Union([Type.Literal("success"), Type.Literal("error")], {
        description: "Final status of the task",
      }),
      summary: Type.String({
        description: "Concise result summary in Chinese (1-3 sentences), will be sent to Feishu",
      }),
    }),
    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      const result = await sendCard(
        ctx,
        params.status,
        params.summary,
        params.status === "error" ? params.summary : undefined,
      );
      if (result.ok) {
        notifiedThisRun = true;
        pendings.delete(`result:${taskStartedAt}`);
        return { content: [{ type: "text" as const, text: "飞书通知已发送。" }], details: {} };
      }
      const errorText = conflictInert
        ? "飞书通知不可用：检测到旧版 pi-ask-user，请先卸载旧包。"
        : `飞书通知发送失败: ${result.error}`;
      return {
        content: [{ type: "text" as const, text: errorText }],
        details: {},
        isError: true,
      };
    },
  });

  pi.registerCommand("watch", {
    description: "标记/取消标记当前会话为关注任务（每次任务结束都通知飞书）",
    handler: async (_args, ctx) => {
      watched = !watched;
      ctx.ui.notify(watched ? "已关注本会话，每次任务结束都将通知飞书" : "已取消关注", "info");
      ctx.ui.setStatus("feishu-notify", watched ? "👁 已关注" : "");
    },
  });

  pi.registerCommand("feishu-test", {
    description: "发送飞书测试卡片，验证 webhook 配置",
    handler: async (_args, ctx) => {
      if (conflictInert) {
        ctx.ui.notify("检测到旧版 pi-ask-user，请先卸载旧包后再发送飞书通知", "error");
        return;
      }
      config = loadConfig();
      if (!config.webhookUrl) {
        ctx.ui.notify(`未配置 webhook，请编辑 ${configPath()} 或设置 FEISHU_WEBHOOK_URL`, "error");
        return;
      }
      const card = buildCard({
        status: "test",
        project: basename(ctx.cwd),
        prompt: "这是一条测试消息",
        durationSec: 0,
        turns: 0,
        toolCalls: 0,
        summary: "如果你看到这张卡片，说明配置成功 🎉",
      });
      const result = await sendToFeishu(config, card);
      if (result.ok) {
        ctx.ui.notify("飞书测试消息发送成功", "info");
      } else {
        log(`test send failed: ${result.error}`);
        ctx.ui.notify(`发送失败: ${result.error}`, "error");
      }
    },
  });
}
