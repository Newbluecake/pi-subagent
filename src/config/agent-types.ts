import { createHash } from "node:crypto";
import { homedir } from "node:os";
import { readFile, readdir } from "node:fs/promises";
import { join, resolve } from "node:path";
import { THINKING_LEVELS, type AgentTypeConfig, type AgentTypeName, type ThinkingLevel } from "../core/types.js";
import { parseStrictModelRef } from "./model-hint.js";
import type { CanMessage } from "../core/message.js";

export interface AgentTypeRegistry {
  reload(): Promise<{ types: AgentTypeConfig[]; errors: Array<{ path: string; error: string }> }>;
  get(name: AgentTypeName): AgentTypeConfig | undefined;
  list(): AgentTypeConfig[];
  /**
   * M3.6 (workflow design §6.3 E2 / `ChildSpawner.configHashOf`): a content
   * hash of `name`'s *resolved* configuration (system prompt, tools, model,
   * thinking level, etc — everything that changes an agent's behavior),
   * not just its name — so editing a `.md` definition changes the hash and
   * a workflow journal keyed on it correctly misses. `undefined` when the
   * type is unknown (mirrors `get()`); `src/workflow/host.ts`'s `handleAgent`
   * treats that identically to a registry-less spawner (fail-closed: no
   * replay for that call, see the M3.6 hand-off note there).
   */
  configHashOf(name: AgentTypeName): string | undefined;
}

/** Stable (sorted-key) JSON stringify so field-order churn in `AgentTypeConfig` never perturbs the hash — same technique as `src/workflow/journal.ts#canonicalize`, duplicated locally rather than imported to keep `src/config/**` free of a `src/workflow/**` import edge (the dependency should point the other way: workflow's `ChildSpawner` structurally consumes this registry, not vice versa). */
function stableStringify(value: unknown): string {
  if (value === undefined) return "null";
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map((v) => stableStringify(v)).join(",")}]`;
  const obj = value as Record<string, unknown>;
  const keys = Object.keys(obj)
    .filter((k) => obj[k] !== undefined)
    .sort();
  return `{${keys.map((k) => `${JSON.stringify(k)}:${stableStringify(obj[k])}`).join(",")}}`;
}

/** Everything that changes an agent type's *behavior* — deliberately excludes `sourcePath` (filesystem location, not behavior) so moving a `.md` file without editing it does not spuriously miss. */
function configHashInput(config: AgentTypeConfig): Record<string, unknown> {
  return {
    name: config.name,
    description: config.description,
    systemPrompt: config.systemPrompt,
    promptMode: config.promptMode,
    tools: config.tools,
    model: config.model,
    modelHint: config.modelHint,
    thinkingLevel: config.thinkingLevel,
    maxTurns: config.maxTurns,
    canSpawn: config.canSpawn,
    canMessage: config.canMessage,
  };
}

export function agentTypeConfigHash(config: AgentTypeConfig): string {
  return createHash("sha256")
    .update(stableStringify(configHashInput(config)), "utf8")
    .digest("hex")
    .slice(0, 32);
}
function scalar(value: string): string | boolean | number | undefined {
  const v = value.trim();
  if (!v) return undefined;
  if (v === "true" || v === "false") return v === "true";
  if (/^-?\d+(\.\d+)?$/.test(v)) return Number(v);
  return v.replace(/^['\"]|['\"]$/g, "");
}
function parseFile(text: string, path: string): AgentTypeConfig {
  const clean = text.replace(/^\uFEFF/, "");
  if (!clean.startsWith("---")) throw new Error("missing frontmatter");
  const end = clean.indexOf("\n---", 3);
  if (end < 0) throw new Error("unterminated frontmatter");
  const fields: Record<string, string | boolean | number | undefined> = {};
  for (const line of clean.slice(3, end).split(/\r?\n/)) {
    const colon = line.indexOf(":");
    if (colon < 1) continue;
    fields[line.slice(0, colon).trim()] = scalar(line.slice(colon + 1));
  }
  const name = typeof fields.name === "string" ? fields.name : undefined;
  const description = typeof fields.description === "string" ? fields.description : undefined;
  if (!name || !description) throw new Error("name and description are required");
  const body = clean
    .slice(end + 5)
    .replace(/^\r?\n/, "")
    .trim();
  const tools =
    typeof fields.tools === "string"
      ? fields.tools
          .split(",")
          .map((x) => x.trim())
          .filter(Boolean)
      : undefined;
  // X3: nested delegation whitelist ("canSpawn" in AgentTypeConfig —
  // frontmatter key is `can_spawn` to match the existing snake_case
  // convention of `prompt_mode` / `max_turns` / `display_name`).
  const canSpawn =
    typeof fields.can_spawn === "string"
      ? fields.can_spawn
          .split(",")
          .map((x) => x.trim())
          .filter(Boolean)
      : undefined;
  const canMessage =
    typeof fields.can_message === "string"
      ? fields.can_message
          .split(",")
          .map((x) => x.trim())
          .filter((x): x is CanMessage =>
            ["parent", "child", "ancestor", "descendant", "sibling", "self", "mention"].includes(x),
          )
      : undefined;
  // `model:` accepts a strict `provider/id` pair (used verbatim at spawn)
  // or a fuzzy hint ("sonnet", "kimi-k3") kept raw and resolved against
  // pi's available models at spawn admission (model-hint.ts) — same
  // contract as upstream @tintinweb/pi-subagents' frontmatter.
  const modelRaw = typeof fields.model === "string" ? fields.model.trim() : undefined;
  const modelPair = modelRaw ? parseStrictModelRef(modelRaw) : undefined;
  const promptMode = fields.prompt_mode === "replace" ? "replace" : "append";
  const config: AgentTypeConfig = { name, description, systemPrompt: body, promptMode, sourcePath: path };
  if (typeof fields.display_name === "string") config.displayName = fields.display_name;
  if (tools?.length) config.tools = tools;
  if (canSpawn?.length) config.canSpawn = canSpawn;
  if (canMessage?.length) config.canMessage = canMessage;
  if (modelPair) config.model = modelPair;
  else if (modelRaw) config.modelHint = modelRaw;
  if (typeof fields.thinking === "string" && (THINKING_LEVELS as readonly string[]).includes(fields.thinking))
    config.thinkingLevel = fields.thinking as ThinkingLevel;
  if (typeof fields.max_turns === "number") config.maxTurns = fields.max_turns;
  if (typeof fields.color === "string") config.color = fields.color;
  return config;
}
/**
 * Built-in fallbacks so a fresh install has usable types even with no agent
 * files on disk (the old @tintinweb/pi-subagents shipped equivalents —
 * dev-flow style workflows assume `general-purpose` and `Plan` exist).
 * Agent files always win: a file type with the same name shadows the
 * built-in, because built-ins are appended last and first-registered wins.
 */
const BUILTIN_AGENT_TYPES: AgentTypeConfig[] = [
  {
    name: "general-purpose",
    description: "Autonomous general-purpose agent for multi-step coding and research tasks.",
    systemPrompt:
      "You are an autonomous general-purpose subagent. Work the task end-to-end: gather what you need, make the change, verify it, and report concrete results (files, commands, outcomes). Do not claim completion without evidence.",
    promptMode: "append",
  },
  {
    name: "Plan",
    description: "Read-only planning agent: explores the codebase and produces an implementation plan.",
    systemPrompt:
      "You are a planning subagent. Investigate the codebase read-only and produce a concrete, step-by-step implementation plan with file-level precision. Do not modify files.",
    promptMode: "append",
    tools: ["read", "bash", "web_search", "memory"],
  },
];

export function createAgentTypeRegistry(cwd = process.cwd(), home = homedir()): AgentTypeRegistry {
  let types: AgentTypeConfig[] = [];
  return {
    async reload() {
      const errors: Array<{ path: string; error: string }> = [];
      const loaded: AgentTypeConfig[] = [];
      for (const dir of [join(cwd, ".pi/agents"), join(cwd, ".agents/agents"), join(home, ".pi/agent/agents")]) {
        let names: string[];
        try {
          names = (await readdir(dir)).filter((n) => n.endsWith(".md")).sort();
        } catch {
          continue;
        }
        for (const name of names) {
          const path = resolve(dir, name);
          try {
            const type = parseFile(await readFile(path, "utf8"), path);
            if (!loaded.some((x) => x.name === type.name)) loaded.push(type);
          } catch (error) {
            errors.push({ path, error: error instanceof Error ? error.message : String(error) });
          }
        }
      }
      for (const builtin of BUILTIN_AGENT_TYPES) if (!loaded.some((x) => x.name === builtin.name)) loaded.push(builtin);
      types = loaded;
      return { types: [...types], errors };
    },
    get: (name) => types.find((x) => x.name === name),
    list: () => [...types],
    configHashOf(name) {
      const config = types.find((x) => x.name === name);
      return config ? agentTypeConfigHash(config) : undefined;
    },
  };
}

/**
 * Render the registered agent types as a system-prompt section. Injected via
 * pi's before_agent_start hook (index.ts): the model has no other way to
 * learn valid `subagent_type` values and otherwise burns turns on
 * trial-and-error "unknown agent type" failures. Descriptions are flattened
 * to one line and clipped so a verbose .md description cannot blow up the
 * prompt. Returns "" when no types are registered (nothing to inject).
 */
/** Clip at the last sentence boundary within `limit`; hard `...` cut when none exists. */
function clipAtSentenceBoundary(text: string, limit: number): string {
  const window = text.slice(0, limit);
  const matches = [...window.matchAll(/[.!?;](?=\s|$)|[。！？；]/g)];
  const last = matches[matches.length - 1];
  if (last?.index !== undefined) return window.slice(0, last.index + 1);
  return `${text.slice(0, limit - 3)}...`;
}

export function formatAgentTypesForPrompt(
  types: readonly AgentTypeConfig[],
  opts: { foregroundAutoBackgroundMs?: number } = {},
): string {
  if (types.length === 0) return "";
  const DESC_LIMIT = 300;
  const lines = types.map((t) => {
    const desc = t.description.replace(/\s+/g, " ").trim();
    const clipped = desc.length > DESC_LIMIT ? clipAtSentenceBoundary(desc, DESC_LIMIT) : desc;
    // Surface a pinned model (strict pair or fuzzy hint) so the calling
    // model knows the type's default and only passes `model` to override.
    const pinned = t.model ? `${t.model.provider}/${t.model.id}` : t.modelHint;
    return `- ${t.name}: ${clipped}${pinned ? ` (model: ${pinned})` : ""}`;
  });
  return [
    "## Available subagent types (pi-subagent)",
    "When calling the Agent tool, pass one of these exact names as `subagent_type`:",
    ...lines,
    opts.foregroundAutoBackgroundMs !== undefined && opts.foregroundAutoBackgroundMs > 0
      ? `Tool protocol: a foreground Agent call blocks until the subagent finishes and returns its result directly; if it runs longer than ~${formatPromptDuration(opts.foregroundAutoBackgroundMs)} the call returns early with a run_id — the run is NOT stopped, it keeps running in the background and you must collect it with get_subagent_result(run_id, wait?), steer it with steer_subagent, or stop it with abort_subagent.`
      : "Tool protocol: a foreground Agent call blocks until the subagent finishes and returns its result directly; abort_subagent can stop a still-running subagent.",
    "With run_in_background: true the Agent call returns immediately with a run_id — poll or block with get_subagent_result(run_id, wait?), steer_subagent, or stop it with abort_subagent.",
    "steer_subagent works only on a run that is still running; abort_subagent stops a running run; the Agent tool's resume parameter works only on a terminal run with an existing persisted session (terminal includes completed, failed, timed_out and aborted).",
    "Anywhere a run_id is accepted (get_subagent_result, steer_subagent, abort_subagent, resume), the Agent call's label (its description) works too.",
  ].join("\n");
}

/**
 * before_agent_start body (kept here so index.ts stays assembly-only, D7/I7):
 * append the type section to pi's assembled system prompt. Returns the input
 * unchanged when there is nothing to inject, so the caller can detect "no
 * change" by identity and skip pi's systemPrompt-override path entirely.
 */
function formatPromptDuration(ms: number): string {
  if (ms >= 3_600_000) return `${Math.round(ms / 3_600_000)}h`;
  if (ms >= 60_000) return `${Math.round(ms / 60_000)}m`;
  return `${Math.round(ms / 1000)}s`;
}

export function appendAgentTypesToSystemPrompt(
  systemPrompt: string,
  types: readonly AgentTypeConfig[],
  opts?: { foregroundAutoBackgroundMs?: number },
): string {
  const section = formatAgentTypesForPrompt(types, opts);
  return section ? `${systemPrompt}\n\n${section}` : systemPrompt;
}
export { parseFile as parseAgentType };
