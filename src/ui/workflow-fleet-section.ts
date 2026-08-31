import type { Millis } from "../core/types.js";
import type { WorkflowActivitySnapshot } from "../workflow/activity.js";
import type { FleetSection } from "./fleet-panel.js";

/**
 * M3.6 (workflow design \u00a79.3 Fleet UI / CC5): pre-rendered lines for the
 * "WORKFLOWS" section spliced above the ordinary AGENTS fleet section (CC5's
 * `extraSections`). See `workflow/activity.ts`'s module doc for why this can
 * only show one row per in-flight workflow (name/phase/elapsed/remaining
 * budget) and not a live per-child breakdown \u2014 that would need a live
 * snapshot API `Orchestrator` does not expose in this milestone.
 */
export function renderWorkflowFleetSection(snapshots: readonly WorkflowActivitySnapshot[], now: Millis): FleetSection {
  if (snapshots.length === 0) return { lines: [] };
  const lines: string[] = [`WORKFLOWS (${snapshots.length})`];
  for (const s of snapshots) {
    const elapsedMs = Math.max(0, now - s.startedAt);
    const remaining = s.deadlineAt !== undefined ? Math.max(0, s.deadlineAt - now) : undefined;
    const phase = s.currentPhaseId ?? "-";
    lines.push(
      `  ${s.workflowId}  ${s.name.padEnd(20).slice(0, 20)} running  phase=${phase}  elapsed=${formatMs(elapsedMs)}` +
        (remaining !== undefined ? `  dl=${formatMs(remaining)}` : ""),
    );
  }
  return { lines };
}

function formatMs(ms: Millis): string {
  const totalSec = Math.floor(ms / 1000);
  const m = Math.floor(totalSec / 60);
  const s = totalSec % 60;
  return `${m}:${s.toString().padStart(2, "0")}`;
}
