import type { ExtensionCommandContext, RegisteredCommand } from "@earendil-works/pi-coding-agent";
import type { UsageDelta } from "../core/types.js";
import type { OrphanRegistry } from "../runtime/reaper.js";
import type { Notifier } from "../delivery/notifier.js";
import type { QueryService } from "../service/query-service.js";
import { createFleetCommand, type FleetCommandDeps } from "../ui/fleet-command.js";

export interface StatusCommandDeps {
  query: QueryService;
  orphans: OrphanRegistry;
  notifier: Notifier;
  /**
   * X7: optional extras for the `/agent fleet` subcommand (idleBudgetMs from
   * settings enables the half-idle yellow highlight). The panel works without
   * it — only QueryService is mandatory.
   */
  fleet?: Partial<FleetCommandDeps>;
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
      "Show diagnostics for running and recently finished subagents (phase, last event, orphans). `/agent fleet` opens the live panel.",
    getArgumentCompletions: (argumentPrefix: string) =>
      [
        { value: "status", label: "status", description: "Text diagnostics (default)" },
        { value: "fleet", label: "fleet", description: "Live fleet panel (X7)" },
      ].filter((item) => item.value.startsWith(argumentPrefix.trim())),
    handler: async (args: string, ctx: ExtensionCommandContext) => {
      const sub = args.trim().split(/\s+/, 1)[0];
      if (sub === "fleet") {
        const command = createFleetCommand({ query: deps.query, ...deps.fleet });
        return command.handler(args.trim().slice(sub.length).trim(), ctx);
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

export function renderStatus(deps: StatusCommandDeps): string {
  const runs = deps.query.list();
  const active = runs.filter((s) => !["completed", "failed", "timed_out", "aborted"].includes(s.status));
  const lines: string[] = [];
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
