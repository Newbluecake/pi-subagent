/**
 * feishu-notify 纯逻辑模块。
 *
 * 只依赖 node 内置模块（`node:crypto`，纯函数）与 pi 类型，无 IO/计时器/网络。
 * `sendToFeishu` 的 fetch/sleep 通过依赖注入，便于测试驱动。
 */

import { createHmac } from "node:crypto";

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

export interface Config {
  webhookUrl?: string | undefined;
  secret?: string | undefined;
  /** 交互工具等待多少秒未响应后发提醒；<=0 关闭。默认 120。 */
  waitNotifyTimeoutSec?: number;
  /** 需要等待提醒的工具名列表。默认 ["ask_user"]。 */
  waitNotifyTools?: string[];
  /** 长任务心跳间隔（秒）。<=0 关闭。默认 600。 */
  heartbeatIntervalSec?: number;
  /** agent_settled 后用户多少秒无新输入发空闲提醒。<=0 关闭。默认 300。 */
  idleNotifyTimeoutSec?: number;
  /** subagent 全部结束时是否发汇总卡片。默认 true（布尔关闭）。 */
  subagentSummaryEnabled?: boolean;
  /** 汇总卡 flush 前的去抖毫秒数。<=0 立即 flush。默认 1500。 */
  subagentFlushDebounceMs?: number;
  /** 通道 A 终态到达后等待通道 B 投递的宽限毫秒数。<=0 不等。默认 6000。 */
  subagentDeliveryGraceMs?: number;
  /** 是否把纯前台（spawnAndWait，无通道 B 投递）run 也纳入汇总卡。默认 false。 */
  subagentForegroundSummary?: boolean;
}

export const DEFAULT_WAIT_NOTIFY_TIMEOUT_SEC = 120;
export const DEFAULT_WAIT_NOTIFY_TOOLS = ["ask_user"];
export const DEFAULT_HEARTBEAT_INTERVAL_SEC = 600;
export const DEFAULT_IDLE_NOTIFY_TIMEOUT_SEC = 300;
export const DEFAULT_SUBAGENT_FLUSH_DEBOUNCE_MS = 1500;
export const DEFAULT_SUBAGENT_DELIVERY_GRACE_MS = 6000;

/** 陈旧保护：started 超过此时长仍未 settle，不计入 runningCount，并可被 prune。 */
export const STALE_RUN_MS = 30 * 60 * 1000;

/**
 * 规范化数值配置字段：`Number.isFinite` 判定。
 * - 缺失（undefined）/非法（NaN、非 number）→ 回落默认值。
 * - 合法数字（含 0、负数）→ 原样返回，交给调用方按 `<=0` 语义处理（显式关闭）。
 */
function normalizeNumber(value: unknown, fallback: number): number {
  return typeof value === "number" && Number.isFinite(value) ? value : fallback;
}

/**
 * 集中规范化配置。数值字段用 `Number.isFinite` 判定，`0`/负数 = 显式关闭，
 * `undefined`/非法值 = 回落默认——两者严格区分。
 */
export function parseConfig(fileConfig: Config, env: NodeJS.ProcessEnv): Config {
  return {
    webhookUrl: fileConfig.webhookUrl ?? env.FEISHU_WEBHOOK_URL,
    secret: fileConfig.secret ?? env.FEISHU_WEBHOOK_SECRET,
    waitNotifyTimeoutSec: normalizeNumber(fileConfig.waitNotifyTimeoutSec, DEFAULT_WAIT_NOTIFY_TIMEOUT_SEC),
    waitNotifyTools: Array.isArray(fileConfig.waitNotifyTools) ? fileConfig.waitNotifyTools : DEFAULT_WAIT_NOTIFY_TOOLS,
    heartbeatIntervalSec: normalizeNumber(fileConfig.heartbeatIntervalSec, DEFAULT_HEARTBEAT_INTERVAL_SEC),
    idleNotifyTimeoutSec: normalizeNumber(fileConfig.idleNotifyTimeoutSec, DEFAULT_IDLE_NOTIFY_TIMEOUT_SEC),
    subagentSummaryEnabled: fileConfig.subagentSummaryEnabled === false ? false : true,
    subagentFlushDebounceMs: normalizeNumber(fileConfig.subagentFlushDebounceMs, DEFAULT_SUBAGENT_FLUSH_DEBOUNCE_MS),
    subagentDeliveryGraceMs: normalizeNumber(fileConfig.subagentDeliveryGraceMs, DEFAULT_SUBAGENT_DELIVERY_GRACE_MS),
    subagentForegroundSummary: fileConfig.subagentForegroundSummary === true,
  };
}

// ---------------------------------------------------------------------------
// Feishu signing / formatting helpers
// ---------------------------------------------------------------------------

/** 飞书签名：HMAC-SHA256，key 为 `${timestamp}\n${secret}`，内容为空串，base64 输出 */
export function feishuSign(timestamp: string, secret: string): string {
  return createHmac("sha256", `${timestamp}\n${secret}`).update("").digest("base64");
}

export function formatDuration(sec: number): string {
  if (sec < 60) return `${sec} 秒`;
  const min = Math.floor(sec / 60);
  const remainSec = sec % 60;
  if (min < 60) return remainSec > 0 ? `${min} 分 ${remainSec} 秒` : `${min} 分钟`;
  const hour = Math.floor(min / 60);
  return `${hour} 小时 ${min % 60} 分`;
}

export function truncate(text: string, max: number): string {
  const oneLine = text.replace(/\s+/g, " ").trim();
  return oneLine.length > max ? `${oneLine.slice(0, max)}…` : oneLine;
}

// ---------------------------------------------------------------------------
// Card building
// ---------------------------------------------------------------------------

interface CardField {
  is_short: boolean;
  text: { tag: string; content: string };
}

export type CardStatus = "success" | "error" | "waiting" | "test" | "heartbeat" | "idle" | "subagents";

export interface BuildCardOverrides {
  template?: string;
  title?: string;
  turnsLabel?: string;
  /** 第三格的展示值（默认渲染 input.turns 原始数字；如 "2 分 5 秒" 这类格式化文本用此覆盖） */
  turnsValue?: string;
  toolCallsLabel?: string;
  details?: string;
}

export interface BuildCardInput {
  status: CardStatus;
  project: string;
  prompt: string;
  durationSec: number;
  turns: number;
  toolCalls: number;
  toolErrors?: number;
  summary: string;
  errorMessage?: string | undefined;
  overrides?: BuildCardOverrides | undefined;
}

const HEADER_MAP: Record<CardStatus, { template: string; title: string }> = {
  success: { template: "green", title: "✅ 任务完成 · pi" },
  error: { template: "red", title: "🔴 任务出错 · pi" },
  waiting: { template: "orange", title: "⏰ 等待输入 · pi" },
  test: { template: "blue", title: "🔔 测试消息 · pi" },
  heartbeat: { template: "turquoise", title: "💓 仍在运行 · pi" },
  idle: { template: "grey", title: "💤 空闲提醒 · pi" },
  subagents: { template: "indigo", title: "🤖 Subagent 汇总 · pi" },
};

export function buildCard(input: BuildCardInput): unknown {
  const base = HEADER_MAP[input.status];
  const template = input.overrides?.template ?? base.template;
  const title = input.overrides?.title ?? base.title;
  const turnsLabel = input.overrides?.turnsLabel ?? "轮次";
  const toolCallsLabel = input.overrides?.toolCallsLabel ?? "工具调用";

  const fields: CardField[] = [
    { is_short: true, text: { tag: "lark_md", content: `**项目**\n${input.project}` } },
    { is_short: true, text: { tag: "lark_md", content: `**耗时**\n${formatDuration(input.durationSec)}` } },
    {
      is_short: true,
      text: { tag: "lark_md", content: `**${turnsLabel}**\n${input.overrides?.turnsValue ?? input.turns}` },
    },
    {
      is_short: true,
      text: {
        tag: "lark_md",
        content: `**${toolCallsLabel}**\n${input.toolCalls}${input.toolErrors ? `（失败 ${input.toolErrors}）` : ""}`,
      },
    },
  ];

  const elements: unknown[] = [
    { tag: "div", fields },
    { tag: "div", text: { tag: "lark_md", content: `**任务**\n${truncate(input.prompt, 200)}` } },
  ];

  if (input.status === "error" && input.errorMessage) {
    elements.push({
      tag: "div",
      text: { tag: "lark_md", content: `**错误信息**\n${truncate(input.errorMessage, 300)}` },
    });
  } else if (input.summary) {
    const label = input.status === "waiting" ? "等待内容" : "结果摘要";
    elements.push({
      tag: "div",
      text: { tag: "lark_md", content: `**${label}**\n${truncate(input.summary, 300)}` },
    });
  }

  if (input.overrides?.details) {
    elements.push({
      tag: "div",
      text: { tag: "lark_md", content: truncate(input.overrides.details, 800) },
    });
  }

  return {
    msg_type: "interactive",
    card: {
      config: { wide_screen_mode: true },
      header: { template, title: { tag: "plain_text", content: title } },
      elements,
    },
  };
}

// ---------------------------------------------------------------------------
// Sending
// ---------------------------------------------------------------------------

export const REQUEST_TIMEOUT_MS = 5000;
export const MAX_RETRIES = 2;

export interface SendDeps {
  fetchFn?: typeof fetch;
  sleep?: (ms: number) => Promise<void>;
}

export async function sendToFeishu(
  config: Config,
  card: unknown,
  deps: SendDeps = {},
): Promise<{ ok: boolean; error?: string }> {
  if (!config.webhookUrl) return { ok: false, error: "webhookUrl 未配置" };
  const fetchFn = deps.fetchFn ?? fetch;
  const sleep = deps.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));

  const body: Record<string, unknown> = { ...(card as Record<string, unknown>) };
  if (config.secret) {
    const timestamp = Math.floor(Date.now() / 1000).toString();
    body.timestamp = timestamp;
    body.sign = feishuSign(timestamp, config.secret);
  }

  let lastError = "";
  for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
    try {
      const res = await fetchFn(config.webhookUrl, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      });
      const text = await res.text();
      if (res.ok && /"(code|StatusCode)":\s*0/.test(text)) return { ok: true };
      lastError = `HTTP ${res.status}: ${truncate(text, 200)}`;
    } catch (err) {
      lastError = err instanceof Error ? err.message : String(err);
    }
    if (attempt < MAX_RETRIES) {
      await sleep(1000 * 2 ** attempt);
    }
  }
  return { ok: false, error: lastError };
}

// ---------------------------------------------------------------------------
// extractSummary (shared with baseline)
// ---------------------------------------------------------------------------

export interface SessionBranchLike {
  sessionManager: { getBranch(): unknown[] };
}

/** 从会话记录中提取最后一条 assistant 文本作为结果摘要 */
export function extractSummary(ctx: SessionBranchLike): string {
  const branch = ctx.sessionManager.getBranch();
  for (let i = branch.length - 1; i >= 0; i--) {
    const entry = branch[i] as { type?: string; message?: { role?: string; content?: unknown } };
    if (entry.type !== "message" || entry.message?.role !== "assistant") continue;
    const content = entry.message.content;
    if (!Array.isArray(content)) continue;
    const text = content
      .filter((c): c is { type: string; text: string } => c?.type === "text" && typeof c.text === "string")
      .map((c) => c.text)
      .join("\n")
      .trim();
    if (text) return text;
  }
  return "";
}

// ---------------------------------------------------------------------------
// Subagent lifecycle / delivery parsing + tracker
// ---------------------------------------------------------------------------

export interface SubagentRecord {
  runId: string;
  generation?: number;
  label?: string;
  status?: string;
  startedAt?: number;
  endedAt?: number;
  textPreview?: string;
  failReason?: string;
  hadDelivery?: boolean;
}

export interface ParsedLifecycle {
  runId: string;
  status?: string | undefined;
  generation?: number | undefined;
}

/** 解析通道 A 的 lifecycle payload：`{runId, at}` (started) 或 `{runId,generation,status,at}` (settled) */
export function parseSubagentLifecycle(data: unknown): ParsedLifecycle | undefined {
  if (!data || typeof data !== "object") return undefined;
  const runId = (data as Record<string, unknown>).runId;
  if (typeof runId !== "string" || !runId) return undefined;
  const statusRaw = (data as Record<string, unknown>).status;
  const status = typeof statusRaw === "string" ? statusRaw : undefined;
  const generationRaw = (data as Record<string, unknown>).generation;
  const generation = typeof generationRaw === "number" ? generationRaw : undefined;
  return { runId, status, generation };
}

interface DeliveryPayloadLike {
  runId?: unknown;
  generation?: unknown;
  status?: unknown;
  label?: unknown;
  textPreview?: unknown;
  failReason?: unknown;
}

function isDeliveryPayloadLike(v: unknown): v is DeliveryPayloadLike {
  return !!v && typeof v === "object" && typeof (v as Record<string, unknown>).runId === "string";
}

/** 解析通道 B 的 message_end details：单个 DeliveryPayload 或 digest `{...first, kind:"digest", items:[...]}` */
export function parseSubagentDelivery(details: unknown): DeliveryPayloadLike[] {
  if (!details || typeof details !== "object") return [];
  const obj = details as Record<string, unknown>;
  // 先判 digest（kind==="digest" && Array.isArray(items)），🟡-3
  if (obj.kind === "digest" && Array.isArray(obj.items)) {
    return obj.items.filter(isDeliveryPayloadLike);
  }
  if (isDeliveryPayloadLike(obj)) return [obj];
  return [];
}

export class SubagentTracker {
  private records = new Map<string, SubagentRecord>();

  markStarted(runId: string, at: number): void {
    const existing = this.records.get(runId);
    if (existing) {
      // 幂等：已有记录（可能已 settled）不因重复 started 覆盖
      if (existing.startedAt === undefined) existing.startedAt = at;
      return;
    }
    this.records.set(runId, { runId, startedAt: at });
  }

  /**
   * generation 优先级写死：
   * - generation 不同 → 先重置该记录（保留当次 startedAt，若无则用 at）再置终态。
   * - generation 相同或缺失 → 幂等，不覆盖 endedAt。
   */
  markSettled(runId: string, status: string, at: number, generation?: number): void {
    let rec = this.records.get(runId);
    if (!rec) {
      rec = { runId, startedAt: at };
      this.records.set(runId, rec);
    }
    if (generation !== undefined && rec.generation !== undefined && generation !== rec.generation) {
      const startedAt = rec.startedAt ?? at;
      rec = { runId, startedAt };
      this.records.set(runId, rec);
    }
    if (rec.status !== undefined && rec.endedAt !== undefined) {
      // 已终态：幂等，不覆盖 endedAt（同代或缺失 generation 的重复到达）
      if (generation !== undefined && rec.generation === undefined) rec.generation = generation;
      return;
    }
    rec.status = status;
    rec.endedAt = at;
    if (generation !== undefined) rec.generation = generation;
    if (rec.startedAt === undefined) rec.startedAt = at;
  }

  /**
   * 解析 single 或 digest，每条按 generation 规则走 markSettled；
   * 合并 label/textPreview/failReason，置 hadDelivery=true，并同时置终态。
   * 非法输入静默忽略。
   */
  ingestDelivery(details: unknown, at: number): void {
    const payloads = parseSubagentDelivery(details);
    for (const p of payloads) {
      const runId = p.runId as string;
      const generation = typeof p.generation === "number" ? p.generation : undefined;
      const status = typeof p.status === "string" ? p.status : undefined;
      if (status) this.markSettled(runId, status, at, generation);
      const rec = this.records.get(runId);
      if (!rec) continue;
      if (typeof p.label === "string" && p.label) rec.label = p.label;
      if (typeof p.textPreview === "string" && p.textPreview) rec.textPreview = p.textPreview;
      if (typeof p.failReason === "string" && p.failReason) rec.failReason = p.failReason;
      rec.hadDelivery = true;
    }
  }

  /** 🟢-c：discard 超过 STALE_RUN_MS 的 started-only 记录，防 Map 无界增长。 */
  pruneStale(now: number): void {
    for (const [runId, rec] of this.records) {
      if (rec.status === undefined && rec.startedAt !== undefined && now - rec.startedAt > STALE_RUN_MS) {
        this.records.delete(runId);
      }
    }
  }

  /** started 且未 settled、且未超过 STALE_RUN_MS 的数量（陈旧保护）。 */
  runningCount(now: number): number {
    this.pruneStale(now);
    let count = 0;
    for (const rec of this.records.values()) {
      if (rec.status === undefined) count++;
    }
    return count;
  }

  /**
   * 存在 finished 记录满足 `!hadDelivery && now-endedAt < graceMs` 时，
   * 返回最晚一条的剩余宽限毫秒（>0）；否则返回 0。
   */
  pendingDeliveryWaitMs(now: number, graceMs: number): number {
    if (graceMs <= 0) return 0;
    let maxRemaining = 0;
    for (const rec of this.records.values()) {
      if (rec.status === undefined || rec.hadDelivery) continue;
      if (rec.endedAt === undefined) continue;
      const remaining = graceMs - (now - rec.endedAt);
      if (remaining > 0 && remaining > maxRemaining) maxRemaining = remaining;
    }
    return maxRemaining;
  }

  hasFinished(): boolean {
    for (const rec of this.records.values()) {
      if (rec.status !== undefined) return true;
    }
    return false;
  }

  /** 仅在确认发卡时调用：取出全部带 status 的记录并删除。 */
  drainFinished(): SubagentRecord[] {
    this.pruneStale(Date.now());
    const finished: SubagentRecord[] = [];
    for (const [runId, rec] of this.records) {
      if (rec.status !== undefined) {
        finished.push(rec);
        this.records.delete(runId);
      }
    }
    return finished;
  }

  /** 门控关闭/纯前台批次的静默清理，不返回记录。 */
  discardFinished(): void {
    this.pruneStale(Date.now());
    for (const [runId, rec] of this.records) {
      if (rec.status !== undefined) this.records.delete(runId);
    }
  }

  clear(): void {
    this.records.clear();
  }
}

/** 降级规则：label ?? runId.slice(0,8)；失败原因 ?? status。每行 "✅/🔴 X · 耗时 · 摘要/原因"。 */
export function buildSubagentSummaryText(records: SubagentRecord[]): string {
  return records
    .map((r) => {
      const ok = r.status === "completed";
      const icon = ok ? "✅" : "🔴";
      const label = r.label ?? r.runId.slice(0, 8);
      const durationSec =
        r.startedAt !== undefined && r.endedAt !== undefined ? Math.round((r.endedAt - r.startedAt) / 1000) : 0;
      const duration = formatDuration(durationSec);
      const detail = ok ? (r.textPreview ?? "—") : (r.failReason ?? r.status ?? "—");
      return `${icon} ${label} · ${duration} · ${detail}`;
    })
    .join("\n");
}
