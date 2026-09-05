import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import {
  defaultSettingsPath,
  persistSettingOverride,
  type AgentSettings,
  type CacheTtlMode,
} from "../config/settings.js";

type RecordValue = Record<string, unknown>;
export interface CacheTtlDeps {
  persist?: (mode: CacheTtlMode) => string | undefined;
}

const MODE_LABEL: Record<CacheTtlMode, string> = {
  auto: "auto（跟随 PI_CACHE_RETENTION）",
  on: "on（强制 1h）",
  off: "off（provider 默认 5m）",
};

function isObjectRecord(value: unknown): value is RecordValue {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function updateStatus(ctx: ExtensionContext, mode: CacheTtlMode, dirty: boolean): void {
  if (!ctx?.ui || typeof ctx.ui.setStatus !== "function") return;
  ctx.ui.setStatus(
    "cache-ttl",
    mode === "auto" ? undefined : `⏱ cache: ${mode === "on" ? "1h" : "5m"}${dirty ? "*" : ""}`,
  );
}

function rewrite(node: unknown, mode: CacheTtlMode, seen: WeakSet<object>): void {
  if (node === null || typeof node !== "object" || seen.has(node)) return;
  seen.add(node);
  if (Array.isArray(node)) {
    for (const item of node) rewrite(item, mode, seen);
    return;
  }
  const object = node as RecordValue;
  const control = object.cache_control;
  if (isObjectRecord(control) && control.type === "ephemeral") {
    if (mode === "on") control.ttl = "1h";
    else delete control.ttl;
  }
  for (const value of Object.values(object)) rewrite(value, mode, seen);
}

export function wireCacheTtl(pi: ExtensionAPI, settings: AgentSettings, deps: CacheTtlDeps = {}): void {
  let mode = settings.cacheTtl.mode;
  let persisted = mode;
  let dirty = false;
  const persist = deps.persist ?? ((value) => persistSettingOverride("cacheTtl.mode", value, defaultSettingsPath()));

  pi.on("session_start", async (_event, ctx) => updateStatus(ctx, mode, dirty));
  pi.on("before_provider_request", (event) => {
    if (mode === "auto" || !isObjectRecord(event.payload) || !Array.isArray(event.payload.messages)) return undefined;
    let cloned: unknown;
    try {
      cloned = structuredClone(event.payload);
    } catch (error) {
      console.warn(
        `[pi-subagent] failed to clone provider payload for cache TTL: ${error instanceof Error ? error.message : String(error)}`,
      );
      return undefined;
    }
    rewrite(cloned, mode, new WeakSet<object>());
    return cloned as RecordValue;
  });
  const USAGE = "用法: /cache-ttl on | off | auto | save";
  pi.registerCommand("cache-ttl", {
    description: "切换 Anthropic 提示词缓存 TTL：/cache-ttl [on|off|auto|save]",
    handler: async (args, ctx) => {
      const arg = args.trim().toLowerCase();
      if (arg === "on" || arg === "off" || arg === "auto") {
        mode = arg;
        dirty = mode !== persisted;
        updateStatus(ctx, mode, dirty);
        ctx.ui.notify(`缓存 TTL 已切换为: ${MODE_LABEL[mode]}（仅当前进程生效，/cache-ttl save 持久化）`, "info");
      } else if (arg === "save") {
        if (!dirty) {
          ctx.ui.notify("没有未保存的更改", "info");
          return;
        }
        const error = persist(mode);
        if (error) {
          ctx.ui.notify(`cache TTL 持久化失败: ${error}`, "error");
          return;
        }
        persisted = mode;
        dirty = false;
        updateStatus(ctx, mode, false);
        ctx.ui.notify(`cache TTL 已持久化为 ${MODE_LABEL[mode]}`, "info");
      } else if (arg === "") {
        const saved = dirty ? `\n持久化模式: ${MODE_LABEL[persisted]}` : "";
        ctx.ui.notify(`当前缓存 TTL 模式: ${MODE_LABEL[mode]}${dirty ? "*" : ""}${saved}\n${USAGE}`, "info");
      } else {
        ctx.ui.notify(`无效参数 "${arg}"，${USAGE}`, "warning");
      }
    },
  });
}
