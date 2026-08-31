import type { ExtensionCommandContext, RegisteredCommand } from "@earendil-works/pi-coding-agent";
import type { RunSnapshot, UsageDelta } from "../core/types.js";
import type { OrphanRegistry } from "../runtime/reaper.js";
import type { Notifier } from "../delivery/notifier.js";
import type { QueryService } from "../service/query-service.js";
import type { WorkflowActivitySnapshot } from "../workflow/activity.js";
import { formatDuration } from "../ui/fleet-panel.js";

export interface StatusCommandDeps {
  query: QueryService;
  orphans: OrphanRegistry;
  notifier: Notifier;
  /** M3.6: in-flight workflow rows for `/agent status`'s own WORKFLOWS section. */
  workflow?: { activity: { list(): readonly WorkflowActivitySnapshot[] }; now?: () => number };
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
      "Show diagnostics for running and recently finished subagents (phase, last event, orphans). `/agent status <runId>` shows one run's tool timeline; `/agent costs` per-run spend. The live agent tree is pinned above the editor while runs are active.",
    getArgumentCompletions: (argumentPrefix: string) =>
      [
        { value: "status", label: "status", description: "Text diagnostics (default)" },
        { value: "costs", label: "costs", description: "Per-run cost breakdown" },
      ].filter((item) => item.value.startsWith(argumentPrefix.trim())),
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
      // M-C4: `/agent status <runId-or-prefix>` (or `/agent <runId>`) — one run's tool timeline.
      const idArg = sub === "status" ? tokens[1] : sub;
      if (idArg) {
        ctx.ui.notify(renderRunDetail(deps.query, idArg), "info");
        return;
      }
      ctx.ui.notify(renderStatus(deps), "info");
    },
  };
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
export function renderRunDetail(query: QueryService, idArg: string): string {
  const runs = query.list();
  const matches = runs.filter((s) => s.runId === idArg || s.runId.startsWith(idArg) || s.diag.label === idArg);
  if (matches.length === 0) return `No run matches "${idArg}".`;
  if (matches.length > 1)
    return `Ambiguous "${idArg}" — matches: ${matches.map((s) => s.runId.slice(0, 8)).join(", ")}`;
  const s: RunSnapshot = matches[0]!;
  const d = s.diag;
  const elapsed = (d.settledAt ?? Date.now()) - d.createdAt;
  const head = [
    `Run ${s.runId.slice(0, 8)}${d.label ? ` (${d.label})` : ""}`,
    d.agentType ?? undefined,
    d.model?.id ?? undefined,
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
      (d.model?.id ?? "·").padEnd(14),
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
    `Delivery: pending=${delivery.pending} delivered=${delivery.delivered} consumed=${delivery.consumed} dropped=${delivery.dropped} abandoned=${delivery.abandoned}`,
  );
  if (deps.notifier.degraded.length) lines.push(`Degraded deliveries: ${deps.notifier.degraded.length}`);
  return lines.join("\n");
}
