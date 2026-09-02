import type { ExtensionCommandContext, RegisteredCommand } from "@earendil-works/pi-coding-agent";
import type { DeadlineBudget, RunSnapshot, UsageDelta } from "../core/types.js";
import { DEFAULT_BUDGET } from "../core/deadline.js";
import { DEFAULT_SETTINGS, type AgentSettings } from "../config/settings.js";
import type { OrphanRegistry } from "../runtime/reaper.js";
import type { Notifier } from "../delivery/notifier.js";
import type { QueryService } from "../service/query-service.js";
import type { ResolveRunResult } from "../service/resolve-target.js";
import type { WorkflowActivitySnapshot } from "../workflow/activity.js";
import { formatDuration, formatModelRef } from "../ui/fleet-panel.js";

export interface SettingsCommandDeps {
  /** Live AgentSettings object — mutated in place. `budget.*` values are
   *  read at spawn time (spawn-service mergeBudget), so they apply to new
   *  runs immediately; all other settings are captured at activate/session
   *  build and take effect after `/reload`. */
  current: AgentSettings;
  /** Persist one override to the settings file (undefined = remove). Returns an error message or undefined. */
  persist: (dottedKey: string, value: unknown) => string | undefined;
  /** Settings file path, shown in messages. */
  path: string;
}

export interface StatusCommandDeps {
  query: QueryService;
  orphans: OrphanRegistry;
  notifier: Notifier;
  /** Model-facing exact/prefix/label matcher shared with the tools. */
  resolveRun?: (handle: string) => ResolveRunResult;
  /** M3.6: in-flight workflow rows for `/agent status`'s own WORKFLOWS section. */
  workflow?: { activity: { list(): readonly WorkflowActivitySnapshot[] }; now?: () => number };
  /** `/agent settings` (+ `/agent budget` alias) — absent only in tests/minimal hosts. */
  settings?: SettingsCommandDeps;
}

/**
 * `/agent status` - G4 diagnosability surface: for every non-terminal run,
 * shows which phase it's stuck in, when the last driver event landed, what
 * tool (if any) is currently executing, and the escalation trail if it's
 * stopping; plus the orphan/delivery counters that back the zero-tolerance
 * monitors in architecture section 9.6.
 */
export function createStatusCommand(deps: StatusCommandDeps): Omit<RegisteredCommand, "name" | "sourceInfo"> {
  return {
    description:
      "Show diagnostics for running and recently finished subagents (phase, last event, orphans). `/agent status <runId>` shows one run's tool timeline; `/agent costs` per-run spend; `/agent settings [set <key> <value>|reset <key>]` views/tunes extension settings (budget.* applies to new runs immediately, the rest after /reload). The live agent tree is pinned above the editor while runs are active.",
    getArgumentCompletions: (argumentPrefix: string) => {
      const settingsAction = argumentPrefix.trimStart().match(/^(settings|budget)\s+(set|reset)\s+(\S*)$/);
      if (settingsAction) {
        const [, scope, action, partial = ""] = settingsAction;
        return Object.keys(SETTING_SPECS)
          .filter((k) => (scope === "budget" ? k.startsWith("budget.") : true))
          .filter((k) => k.startsWith(scope === "budget" ? `budget.${partial}` : partial))
          .map((k) => ({
            value: scope === "budget" ? `budget ${action} ${k.slice("budget.".length)}` : `settings ${action} ${k}`,
            label: k,
            description: `default ${formatSettingValue(defaultOf(k))}`,
          }));
      }
      return [
        { value: "status", label: "status", description: "Text diagnostics (default)" },
        { value: "costs", label: "costs", description: "Per-run cost breakdown" },
        { value: "settings", label: "settings", description: "View/tune extension settings (set/reset)" },
        { value: "budget", label: "budget", description: "Alias: settings scoped to budget.*" },
      ].filter((item) => item.value.startsWith(argumentPrefix.trim()));
    },
    handler: async (args: string, ctx: ExtensionCommandContext) => {
      const tokens = args.trim().split(/\s+/).filter(Boolean);
      const sub = tokens[0];
      if (sub === "fleet") {
        // Removed overlay panel — point old muscle memory at the replacements.
        ctx.ui.notify(
          "The `/agent fleet` overlay panel was removed. The live agent tree is always pinned above the editor while runs are active; use `/agent status`, `/agent status <runId>` or `/agent costs` for details.",
          "info",
        );
        return;
      }
      if (sub === "costs") {
        ctx.ui.notify(renderCosts(deps.query), "info");
        return;
      }
      if (sub === "settings" || sub === "budget") {
        // `/agent budget k...` is a scoped alias: keys are budget.* leaves.
        const rest = tokens.slice(1);
        if (sub === "budget" && rest[0] && rest[0] !== "list" && rest[1]) rest[1] = `budget.${rest[1]}`;
        ctx.ui.notify(handleSettings(deps.settings, rest, sub === "budget"), "info");
        return;
      }
      // M-C4: `/agent status <runId-or-prefix>` (or `/agent <runId>`) — one run's tool timeline.
      const idArg = sub === "status" ? tokens[1] : sub;
      if (idArg) {
        ctx.ui.notify(renderRunDetail(deps.query, idArg, deps.resolveRun), "info");
        return;
      }
      ctx.ui.notify(renderStatus(deps), "info");
    },
  };
}

type SettingSpec =
  | { kind: "number"; min?: number; integer?: boolean }
  | { kind: "boolean" }
  | { kind: "enum"; values: readonly string[] }
  | { kind: "string" };

const MS: SettingSpec = { kind: "number", min: 0 };
const COUNT: SettingSpec = { kind: "number", min: 0, integer: true };
const BOOL: SettingSpec = { kind: "boolean" };

/**
 * The settable surface of `/agent settings`. Order = listing order.
 * `budget.*` keys double as run-timeout knobs; everything else is captured
 * at activate/session build, so it only takes effect after `/reload`.
 * Deliberately excluded: workflow.budget (nested object, no flat syntax).
 */
const SETTING_SPECS: Record<string, SettingSpec> = {
  ...Object.fromEntries(
    (Object.keys(DEFAULT_BUDGET) as (keyof DeadlineBudget)[]).map((k) => [
      `budget.${k}`,
      k === "startupRetries" ? COUNT : MS,
    ]),
  ),
  concurrencyLimit: COUNT,
  maxNestedDepth: COUNT,
  rememberAgents: BOOL,
  fleetWidget: BOOL,
  deliveryAttempts: { kind: "number", min: 1, integer: true },
  deliveryBackoffMs: MS,
  reconcileTtlMs: MS,
  foregroundAutoBackgroundMs: MS,
  maxReconcileRounds: COUNT,
  maxReconcileBatch: { kind: "number", min: 1, integer: true },
  coalesceWindowMs: MS,
  coalesceMaxBatch: { kind: "number", min: 1, integer: true },
  "worktree.enabled": BOOL,
  "worktree.gitTimeoutMs": MS,
  "workflow.enabled": BOOL,
  "workflow.replayTtlMs": MS,
  "workflow.replayScope": { kind: "enum", values: ["chain", "content"] },
  "workflow.runawayPolicy": { kind: "enum", values: ["diagnose_only", "terminate_on_stall"] },
  "workflow.journalDir": { kind: "string" },
};

function getPath(root: unknown, dottedKey: string): unknown {
  let node = root;
  for (const segment of dottedKey.split(".")) {
    if (node === null || typeof node !== "object") return undefined;
    node = (node as Record<string, unknown>)[segment];
  }
  return node;
}

function setPath(root: Record<string, unknown>, dottedKey: string, value: unknown): void {
  const segments = dottedKey.split(".");
  let node = root;
  for (const segment of segments.slice(0, -1)) node = node[segment] as Record<string, unknown>;
  const leaf = segments[segments.length - 1]!;
  if (value === undefined) delete node[leaf];
  else node[leaf] = value;
}

function defaultOf(dottedKey: string): unknown {
  return getPath(DEFAULT_SETTINGS, dottedKey);
}

function formatSettingValue(value: unknown): string {
  return value === undefined ? "(unset)" : String(value);
}

function parseSettingValue(
  spec: SettingSpec,
  raw: string,
): { ok: true; value: unknown } | { ok: false; error: string } {
  switch (spec.kind) {
    case "number": {
      const value = Number(raw);
      if (!Number.isFinite(value) || value < (spec.min ?? 0) || (spec.integer && !Number.isInteger(value)))
        return {
          ok: false,
          error: `expected a ${spec.integer ? "integer" : "number"} >= ${spec.min ?? 0}`,
        };
      return { ok: true, value };
    }
    case "boolean": {
      const v = raw.toLowerCase();
      if (["true", "1", "yes", "on"].includes(v)) return { ok: true, value: true };
      if (["false", "0", "no", "off"].includes(v)) return { ok: true, value: false };
      return { ok: false, error: "expected true/false" };
    }
    case "enum":
      return spec.values.includes(raw)
        ? { ok: true, value: raw }
        : { ok: false, error: `expected one of: ${spec.values.join(", ")}` };
    case "string":
      return raw ? { ok: true, value: raw } : { ok: false, error: "expected a non-empty string" };
  }
}

function renderSettings(deps: SettingsCommandDeps, budgetOnly: boolean): string {
  const keys = Object.keys(SETTING_SPECS).filter((k) => !budgetOnly || k.startsWith("budget."));
  const width = Math.max(...keys.map((k) => k.length));
  const lines = keys.map((k) => {
    const cur = getPath(deps.current, k);
    const def = defaultOf(k);
    const mark = cur !== def ? ` (default ${formatSettingValue(def)})` : "";
    return `  ${k.padEnd(width)}  ${formatSettingValue(cur)}${mark}`;
  });
  const usage = budgetOnly
    ? "`/agent budget set <key> <value>` / `reset <key>` (budget.* keys). Applies to new runs immediately; in-flight runs keep the budget armed at their start. 0 disables a phase timeout (budget.totalMs: 0 = no overall cap)."
    : "`/agent settings set <key> <value>` / `reset <key>`. budget.* applies to new runs immediately; every other key is persisted but takes effect after /reload. All changes persist to the settings file.";
  return [`Extension settings — ${deps.path}:`, ...lines, "", usage].join("\n");
}

function handleSettings(deps: SettingsCommandDeps | undefined, args: string[], budgetOnly: boolean): string {
  if (!deps) return "Settings command unavailable: the extension host did not wire settings persistence.";
  const [action, key, ...restRaw] = args;
  const command = budgetOnly ? "budget" : "settings";
  if (!action || action === "list") return renderSettings(deps, budgetOnly);
  if (action !== "set" && action !== "reset")
    return `Unknown ${command} action "${action}". Usage: /agent ${command} [set <key> <value>|reset <key>]`;
  if (!key || !Object.hasOwn(SETTING_SPECS, key) || (budgetOnly && !key.startsWith("budget.")))
    return (
      `Unknown ${command} key "${key ?? ""}". Valid keys: ` +
      Object.keys(SETTING_SPECS)
        .filter((k) => !budgetOnly || k.startsWith("budget."))
        .map((k) => (budgetOnly ? k.slice("budget.".length) : k))
        .join(", ")
    );
  const spec = SETTING_SPECS[key]!;
  const live = key.startsWith("budget.");
  const effect = live ? "applies to new runs immediately" : "takes effect after /reload";
  if (action === "reset") {
    const def = defaultOf(key);
    setPath(deps.current as unknown as Record<string, unknown>, key, def);
    const err = deps.persist(key, undefined);
    return (
      `${key} reset to default ${formatSettingValue(def)} (${effect}). ` +
      (err ? `Persist failed: ${err}` : `Persisted to ${deps.path}.`)
    );
  }
  const raw = restRaw.join(" ");
  const parsed = parseSettingValue(spec, raw);
  if (!parsed.ok) return `Invalid value "${raw}" for ${key}: ${parsed.error}.`;
  const prev = getPath(deps.current, key);
  setPath(deps.current as unknown as Record<string, unknown>, key, parsed.value);
  const err = deps.persist(key, parsed.value);
  return (
    `${key}: ${formatSettingValue(prev)} → ${formatSettingValue(parsed.value)} (${effect}). ` +
    (err ? `Persist failed: ${err}` : `Persisted to ${deps.path}.`)
  );
}

/**
 * X9: render a lifetime usage accumulator (architecture §7.2). Costs are
 * formatted to 4 decimal places since subagent runs are typically cheap
 * (fractions of a cent) and truncating to 2 would print "$0.00" for most.
 */
function formatUsage(u: UsageDelta | undefined): string {
  if (!u) return "";
  return ` usage=in:${u.input} out:${u.output} cache_r:${u.cacheRead} cache_w:${u.cacheWrite} cost:$${u.costUsd.toFixed(4)}`;
}
function sumUsage(items: readonly (UsageDelta | undefined)[]): UsageDelta | undefined {
  const present = items.filter((u): u is UsageDelta => u !== undefined);
  if (!present.length) return undefined;
  return present.reduce(
    (acc, u) => ({
      input: acc.input + u.input,
      output: acc.output + u.output,
      cacheRead: acc.cacheRead + u.cacheRead,
      cacheWrite: acc.cacheWrite + u.cacheWrite,
      costUsd: acc.costUsd + u.costUsd,
    }),
    { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, costUsd: 0 },
  );
}

/**
 * M-C4: one run's detail view — header (label/type/model/status/elapsed) plus
 * a tool timeline from diag.toolHistory (start offsets relative to createdAt,
 * per-call durations, ✓/✗/▸ marks, args previews) and the error, if any.
 * Accepts a full runId, a unique prefix, or an exact label.
 */
export function renderRunDetail(
  query: QueryService,
  idArg: string,
  resolveRun?: (handle: string) => ResolveRunResult,
): string {
  const runs = query.list();
  const resolved = resolveRun?.(idArg);
  if (resolved && !resolved.ok) return resolved.error;
  const matches = resolved?.ok
    ? runs.filter((s) => s.runId === resolved.runId)
    : runs.filter((s) => s.runId === idArg || s.runId.startsWith(idArg) || s.diag.label === idArg);
  if (matches.length === 0) return `No run matches "${idArg}".`;
  if (matches.length > 1)
    return `Ambiguous "${idArg}" — matches: ${matches.map((s) => s.runId.slice(0, 8)).join(", ")}`;
  const s: RunSnapshot = matches[0]!;
  const d = s.diag;
  const elapsed = (d.settledAt ?? Date.now()) - d.createdAt;
  const head = [
    `Run ${s.runId.slice(0, 8)}${d.label ? ` (${d.label})` : ""}`,
    d.agentType ?? undefined,
    formatModelRef(d.model),
    `${s.status}/${s.phase}`,
    formatDuration(Math.max(0, elapsed)),
    `${d.turns} turn${d.turns === 1 ? "" : "s"}`,
  ]
    .filter(Boolean)
    .join(" · ");
  const lines = [head];
  if (d.toolHistory?.length) {
    lines.push("  Timeline:");
    for (const r of d.toolHistory) {
      const offset = formatDuration(Math.max(0, r.startedAt - d.createdAt)).padStart(7);
      const mark = r.endedAt === undefined ? "▸" : r.isError ? "✗" : "✓";
      const dur = r.endedAt === undefined ? "running…" : formatDuration(r.endedAt - r.startedAt);
      lines.push(`  +${offset}  ${mark} ${r.name.padEnd(10)} ${(r.argsPreview ?? "").slice(0, 60).padEnd(60)} ${dur}`);
    }
    const counts = Object.entries(d.toolCounts ?? {})
      .sort((a, b) => b[1] - a[1])
      .map(([name, n]) => (n > 1 ? `${name}×${n}` : name))
      .join(" ");
    if (counts) lines.push(`  Tools: ${counts}`);
  } else {
    lines.push("  Timeline: (no tool calls observed)");
  }
  if (d.usage) lines.push(`  Usage:${formatUsage(d.usage)}`);
  if (d.error) lines.push(`  Error: [${d.error.kind}] ${d.error.message.slice(0, 300)}`);
  if (d.timeoutReason) lines.push(`  Timeout: ${d.timeoutReason}`);
  if (d.sessionFile) lines.push(`  Session: ${d.sessionFile}`);
  return lines.join("\n");
}

/**
 * M7: `/agent costs` — per-run spend breakdown (cost-descending), separating
 * active from finished runs, with a grand total. Answers "钱花哪了" without
 * digging through notifications.
 */
export function renderCosts(query: QueryService): string {
  const runs = [...query.list()].sort((a, b) => (b.diag.usage?.costUsd ?? 0) - (a.diag.usage?.costUsd ?? 0));
  if (runs.length === 0) return "No subagent runs recorded this session.";
  const terminalStatuses = ["completed", "failed", "timed_out", "aborted"];
  const lines = [`Subagent costs — ${runs.length} run(s)`];
  for (const s of runs) {
    const d = s.diag;
    const active = !terminalStatuses.includes(s.status);
    const cost = d.usage ? `$${d.usage.costUsd.toFixed(4)}` : "$0.0000";
    const cols = [
      `  ${cost.padStart(8)}`,
      active ? "▸" : s.status === "completed" ? "✓" : "✗",
      s.runId.slice(0, 8),
      (d.label ?? "·").slice(0, 24).padEnd(24),
      (d.agentType ?? "·").padEnd(12),
      (formatModelRef(d.model) ?? "·").padEnd(24),
      `${d.turns}t`,
      d.settledAt !== undefined ? formatDuration(Math.max(0, d.settledAt - d.createdAt)) : "running",
    ];
    lines.push(cols.join(" "));
  }
  const total = sumUsage(runs.map((s) => s.diag.usage));
  if (total)
    lines.push(
      `  Total: $${total.costUsd.toFixed(4)} · in:${total.input} out:${total.output} cache_r:${total.cacheRead}`,
    );
  return lines.join("\n");
}

export function renderStatus(deps: StatusCommandDeps): string {
  const runs = deps.query.list();
  const active = runs.filter((s) => !["completed", "failed", "timed_out", "aborted"].includes(s.status));
  const lines: string[] = [];
  if (deps.workflow) {
    const now = deps.workflow.now?.() ?? Date.now();
    const snapshots = deps.workflow.activity.list();
    lines.push(`Workflows: ${snapshots.length} active`);
    for (const s of snapshots) {
      const elapsedMs = Math.max(0, now - s.startedAt);
      const remaining = s.deadlineAt !== undefined ? Math.max(0, s.deadlineAt - now) : undefined;
      lines.push(
        `  ${s.workflowId} name=${s.name} phase=${s.currentPhaseId ?? "-"} elapsed_ms=${elapsedMs}` +
          (remaining !== undefined ? ` deadline_remaining_ms=${remaining}` : ""),
      );
    }
  }
  lines.push(`Subagent runs: ${runs.length} total, ${active.length} active`);
  for (const s of active.slice(0, 10)) {
    const currentTool = s.diag.currentTool ? ` tool=${s.diag.currentTool.name}` : "";
    const lastEvent =
      s.diag.lastEventAt !== undefined ? ` last_event=${s.diag.lastEventType ?? "?"}@${s.diag.lastEventAt}` : "";
    const escalation = s.diag.escalation.length
      ? ` escalation=[${s.diag.escalation.map((e) => `${e.level}:${e.ok ? "ok" : "fail"}`).join(",")}]`
      : "";
    lines.push(
      `  ${s.runId} status=${s.status} phase=${s.phase}${currentTool}${lastEvent}${escalation}${formatUsage(s.diag.usage)}`,
    );
  }
  const totalUsage = sumUsage(runs.map((s) => s.diag.usage));
  if (totalUsage) lines.push(`Usage (all runs):${formatUsage(totalUsage)}`);
  const orphans = deps.orphans;
  lines.push(
    `Orphans: ${orphans.totalCount} total (retained ${orphans.recent.length}, late-recovered ${orphans.lateRecoveredCount})`,
  );
  const delivery = deps.notifier.stats;
  lines.push(
    `Delivery: staged=${delivery.staged} pending=${delivery.pending} batched=${delivery.batched} delivered=${delivery.delivered} consumed=${delivery.consumed} dropped=${delivery.dropped} abandoned=${delivery.abandoned}`,
  );
  if (deps.notifier.degraded.length) lines.push(`Degraded deliveries: ${deps.notifier.degraded.length}`);
  return lines.join("\n");
}
