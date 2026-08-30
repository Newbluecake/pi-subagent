import type { ExtensionCommandContext, RegisteredCommand } from "@earendil-works/pi-coding-agent";
import type { OrphanRegistry } from "../runtime/reaper.js";
import type { Notifier } from "../delivery/notifier.js";
import type { QueryService } from "../service/query-service.js";

export interface StatusCommandDeps {
  query: QueryService;
  orphans: OrphanRegistry;
  notifier: Notifier;
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
    description: "Show diagnostics for running and recently finished subagents (phase, last event, orphans).",
    handler: async (_args: string, ctx: ExtensionCommandContext) => {
      ctx.ui.notify(renderStatus(deps), "info");
    },
  };
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
    lines.push(`  ${s.runId} status=${s.status} phase=${s.phase}${currentTool}${lastEvent}${escalation}`);
  }
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
