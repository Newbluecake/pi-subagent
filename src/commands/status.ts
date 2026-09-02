import type { ExtensionCommandContext, RegisteredCommand } from "@earendil-works/pi-coding-agent";
import { formatSize } from "@earendil-works/pi-coding-agent";
import type { RunSnapshot, UsageDelta } from "../core/types.js";
import {
  SETTING_SPECS,
  currentOf,
  defaultOf,
  formatSettingValue,
  isKnownSettingKey,
  isOverridden,
  parseSettingValue,
  resetSetting,
  settingKeys,
  writeSetting,
  type SettingsStore,
} from "../config/setting-specs.js";
import type { OrphanRegistry } from "../runtime/reaper.js";
import type { Notifier } from "../delivery/notifier.js";
import type { QueryService } from "../service/query-service.js";
import type { ResolveRunResult } from "../service/resolve-target.js";
import type { WorkflowActivitySnapshot } from "../workflow/activity.js";
import { formatDuration, formatModelRef } from "../ui/fleet-panel.js";
import { isTerminalJobStatus, previewCommand, type JobRecord } from "../bash/types.js";
import { describeJobStatus } from "../tools/bash-job-tool.js";
import { canOpenSettingsEditor, openSettingsEditor } from "../ui/settings-editor.js";

/** Live settings object + persistence port (see config/setting-specs.ts). */
export type SettingsCommandDeps = SettingsStore;

export interface StatusCommandDeps {
  query: QueryService;
  orphans: OrphanRegistry;
  notifier: Notifier;
  /** Model-facing exact/prefix/label matcher shared with the tools. */
  resolveRun?: (handle: string) => ResolveRunResult;
  /** M3.6: in-flight workflow rows for `/agent status`'s own WORKFLOWS section. */
  workflow?: { activity: { list(): readonly WorkflowActivitySnapshot[] }; now?: () => number };
  /**
   * bash auto-background §7: backgrounded bash jobs for the `bash jobs`
   * section and `/agent status <b_…>`. Absent (or empty) ⇒ nothing rendered,
   * so hosts without the feature see the previous output byte-for-byte.
   */
  bashJobs?: { list(): readonly JobRecord[] };
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
      "Show diagnostics for running and recently finished subagents (phase, last event, orphans). `/agent status <runId>` shows one run's tool timeline; `/agent costs` per-run spend; `/agent settings` opens an interactive settings editor (`settings list` / `set <key> <value>` / `reset <key>` stay available for scripts; budget.* applies to new runs immediately, the rest after /reload). Durations are configured in seconds. The live agent tree is pinned above the editor while runs are active.",
    getArgumentCompletions: (argumentPrefix: string) => {
      const settingsAction = argumentPrefix.trimStart().match(/^(settings|budget)\s+(set|reset)\s+(\S*)$/);
      if (settingsAction) {
        const [, scope, action, partial = ""] = settingsAction;
        return settingKeys(scope === "budget")
          .filter((k) => k.startsWith(scope === "budget" ? `budget.${partial}` : partial))
          .map((k) => ({
            value: scope === "budget" ? `budget ${action} ${k.slice("budget.".length)}` : `settings ${action} ${k}`,
            label: k,
            description: `default ${formatSettingValue(defaultOf(SETTING_SPECS[k]!))}`,
          }));
      }
      return [
        { value: "status", label: "status", description: "Text diagnostics (default)" },
        { value: "costs", label: "costs", description: "Per-run cost breakdown" },
        { value: "settings", label: "settings", description: "Interactive settings editor (or set/reset/list)" },
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
        // No arguments in an interactive session → the overlay editor. Every
        // other form (and every non-TUI mode) keeps the text behaviour, so
        // scripts and `pi -p` are unaffected — the capability probe is
        // synchronous so those paths never even yield a microtask.
        if (rest.length === 0 && deps.settings && canOpenSettingsEditor(ctx)) {
          const opened = await openSettingsEditor(ctx, deps.settings, { budgetOnly: sub === "budget" });
          if (opened) return;
        }
        ctx.ui.notify(handleSettings(deps.settings, rest, sub === "budget"), "info");
        return;
      }
      // M-C4: `/agent status <runId-or-prefix>` (or `/agent <runId>`) — one run's tool timeline.
      const idArg = sub === "status" ? tokens[1] : sub;
      if (idArg) {
        // §7: `b_` is the bash job namespace, `r_`/labels stay with the runs.
        if (idArg.startsWith("b_") && deps.bashJobs) {
          ctx.ui.notify(renderBashJobDetail(deps.bashJobs, idArg), "info");
          return;
        }
        ctx.ui.notify(renderRunDetail(deps.query, idArg, deps.resolveRun), "info");
        return;
      }
      ctx.ui.notify(renderStatus(deps), "info");
    },
  };
}

function renderSettings(store: SettingsStore, budgetOnly: boolean): string {
  const keys = settingKeys(budgetOnly);
  const width = Math.max(...keys.map((k) => k.length));
  const lines = keys.map((k) => {
    const spec = SETTING_SPECS[k]!;
    const mark = isOverridden(store.current, spec) ? ` (default ${formatSettingValue(defaultOf(spec))})` : "";
    return `  ${k.padEnd(width)}  ${formatSettingValue(currentOf(store.current, spec))}${mark}`;
  });
  const usage = budgetOnly
    ? "`/agent budget` opens the interactive editor; `/agent budget set <key> <value>` / `reset <key>` (budget.* keys) stay scriptable. Durations are seconds. Applies to new runs immediately; in-flight runs keep the budget armed at their start. 0 disables a phase timeout (budget.totalS: 0 = no overall cap)."
    : "`/agent settings` opens the interactive editor; `set <key> <value>` / `reset <key>` / `list` stay scriptable. Durations are seconds (keys end in `S`). budget.* applies to new runs immediately; every other key is persisted but takes effect after /reload. All changes persist to the settings file.";
  return [`Extension settings — ${store.path}:`, ...lines, "", usage].join("\n");
}

function handleSettings(store: SettingsStore | undefined, args: string[], budgetOnly: boolean): string {
  if (!store) return "Settings command unavailable: the extension host did not wire settings persistence.";
  const [action, key, ...restRaw] = args;
  const command = budgetOnly ? "budget" : "settings";
  if (!action || action === "list") return renderSettings(store, budgetOnly);
  if (action !== "set" && action !== "reset")
    return `Unknown ${command} action "${action}". Usage: /agent ${command} [set <key> <value>|reset <key>|list]`;
  if (!key || !isKnownSettingKey(key, budgetOnly))
    return (
      `Unknown ${command} key "${key ?? ""}". Valid keys: ` +
      settingKeys(budgetOnly)
        .map((k) => (budgetOnly ? k.slice("budget.".length) : k))
        .join(", ")
    );
  const spec = SETTING_SPECS[key]!;
  if (action === "reset") {
    const result = resetSetting(store, key);
    return (
      `${key} reset to default ${result.next} (${result.effect}). ` +
      (result.persistError ? `Persist failed: ${result.persistError}` : `Persisted to ${store.path}.`)
    );
  }
  const raw = restRaw.join(" ");
  const parsed = parseSettingValue(spec, raw);
  if (!parsed.ok) return `Invalid value "${raw}" for ${key}: ${parsed.error}.`;
  const result = writeSetting(store, key, parsed);
  return (
    `${key}: ${result.previous} → ${result.next} (${result.effect}). ` +
    (result.persistError ? `Persist failed: ${result.persistError}` : `Persisted to ${store.path}.`)
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

/** Rows shown per group in the `bash jobs` section (§7). */
const BASH_JOB_ROWS = 5;

function bashJobElapsed(record: JobRecord, now: number): number {
  return Math.max(0, (record.endedAt ?? now) - (record.spawnedAt ?? record.createdAt));
}

function bashJobRow(record: JobRecord, now: number, suffix: string): string {
  return (
    `  ${record.jobId}  ${describeJobStatus(record)}  ${formatDuration(bashJobElapsed(record, now))}  ` +
    `$ ${previewCommand(record.command, 40)}  (log ${formatSize(record.logBytes)}${suffix})`
  );
}

/**
 * §7: the `bash jobs` section of `/agent status`. Running jobs first (the
 * ones the user may still want to kill), then terminal jobs whose completion
 * notice has not gone out yet. The whole section disappears when there are no
 * jobs at all — users who never hit the auto-background threshold should not
 * see a new empty header.
 */
export function renderBashJobsSection(port: { list(): readonly JobRecord[] }, now: number): string[] {
  let jobs: readonly JobRecord[] = [];
  try {
    jobs = port.list();
  } catch {
    return [];
  }
  if (jobs.length === 0) return [];
  const running = jobs.filter((record) => !isTerminalJobStatus(record.status));
  const unread = jobs.filter((record) => isTerminalJobStatus(record.status) && record.notifiedAt === undefined);
  const lines = [`bash jobs (${running.length} running, ${unread.length} finished unread):`];
  for (const record of running.slice(0, BASH_JOB_ROWS)) lines.push(bashJobRow(record, now, ""));
  if (running.length > BASH_JOB_ROWS) lines.push(`  … ${running.length - BASH_JOB_ROWS} more running`);
  for (const record of unread.slice(0, BASH_JOB_ROWS)) lines.push(bashJobRow(record, now, ", unnotified"));
  if (unread.length > BASH_JOB_ROWS) lines.push(`  … ${unread.length - BASH_JOB_ROWS} more finished unread`);
  return lines;
}

/** §7: `/agent status <b_prefix>` — one bash job (exact id or unique prefix). */
export function renderBashJobDetail(
  port: { list(): readonly JobRecord[] },
  handle: string,
  now: number = Date.now(),
): string {
  const jobs = port.list();
  const matches = jobs.filter((record) => record.jobId === handle || record.jobId.startsWith(handle));
  const exact = jobs.find((record) => record.jobId === handle);
  const record = exact ?? (matches.length === 1 ? matches[0] : undefined);
  if (!record) {
    if (matches.length > 1) return `Ambiguous "${handle}" — matches: ${matches.map((m) => m.jobId).join(", ")}`;
    return `No bash job matches "${handle}".`;
  }
  const lines = [
    `Bash job ${record.jobId} · ${describeJobStatus(record)} · ${formatDuration(bashJobElapsed(record, now))}`,
    `  Command: $ ${previewCommand(record.command, 200)}`,
    `  Cwd: ${record.cwd || "(unknown)"}`,
    `  Log: ${record.logPath} (${formatSize(record.logBytes)}${record.outputTruncated ? ", size cap reached" : ""})`,
  ];
  if (record.pid !== undefined)
    lines.push(`  Pid: ${record.pid}${record.pgid !== undefined ? ` (pgid ${record.pgid})` : ""}`);
  lines.push(
    `  Flags: ${record.backgroundedAt !== undefined ? "backgrounded" : "foreground"}, ` +
      `${record.notifiedAt !== undefined ? "notified" : "not notified"}, read cursor ${record.readCursor}`,
  );
  if (record.finalText) lines.push(`  Final: ${record.finalText.slice(-300)}`);
  lines.push(`  Collect output with bash_job(action: "output", job_id: "${record.jobId}").`);
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
    `Delivery: staged=${delivery.staged} pending=${delivery.pending} batched=${delivery.batched} delivered=${delivery.delivered} consumed=${delivery.consumed} dropped=${delivery.dropped} abandoned=${delivery.abandoned} acked=${deps.notifier.ackedSuppressions}`,
  );
  if (deps.notifier.degraded.length) lines.push(`Degraded deliveries: ${deps.notifier.degraded.length}`);
  if (deps.bashJobs) lines.push(...renderBashJobsSection(deps.bashJobs, deps.workflow?.now?.() ?? Date.now()));
  return lines.join("\n");
}
