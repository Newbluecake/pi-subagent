import { homedir } from "node:os";
import { readFile, readdir } from "node:fs/promises";
import { join, resolve } from "node:path";
import type { AgentTypeConfig, AgentTypeName } from "../core/types.js";

export interface AgentTypeRegistry {
  reload(): Promise<{ types: AgentTypeConfig[]; errors: Array<{ path: string; error: string }> }>;
  get(name: AgentTypeName): AgentTypeConfig | undefined;
  list(): AgentTypeConfig[];
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
  const model =
    typeof fields.model === "string" && fields.model.includes("/")
      ? (() => {
          const [provider, id] = fields.model.split("/", 2);
          return provider && id ? { provider, id } : undefined;
        })()
      : undefined;
  const promptMode = fields.prompt_mode === "replace" ? "replace" : "append";
  const config: AgentTypeConfig = { name, description, systemPrompt: body, promptMode, sourcePath: path };
  if (typeof fields.display_name === "string") config.displayName = fields.display_name;
  if (tools?.length) config.tools = tools;
  if (canSpawn?.length) config.canSpawn = canSpawn;
  if (model) config.model = model;
  if (
    fields.thinking === "off" ||
    fields.thinking === "low" ||
    fields.thinking === "medium" ||
    fields.thinking === "high"
  )
    config.thinkingLevel = fields.thinking;
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
  };
}
export { parseFile as parseAgentType };
