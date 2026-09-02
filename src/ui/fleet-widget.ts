import { systemClock, type Clock, type TimerHandle } from "../core/clock.js";
import { truncateToWidth } from "@earendil-works/pi-tui";
import type { Millis, RunId, SubagentExtensionPoints } from "../core/types.js";
import type { QueryService } from "../service/query-service.js";
import {
  buildFleetViewModel,
  formatDuration,
  type FleetColorize,
  type FleetHighlight,
  type FleetRow,
  type FleetViewModel,
} from "./fleet-panel.js";

/**
 * X7b fleet widget: the always-on compact counterpart to the `/agent fleet`
 * full-screen panel (fleet-panel.ts). Pinned above the editor via
 * ctx.ui.setWidget(placement: "aboveEditor") whenever subagent runs are
 * active; hidden (setWidget(key, undefined)) when the fleet is idle.
 *
 * M-C upgrade: the widget is now the primary background presentation — a
 * compact *agent tree*. One header line (worst-highlight bullet, active
 * count, live cost, overflow) followed by 1–2 lines per run: the main row
 * (label · type · model · phase · phase age · Σ total elapsed · cost),
 * children indented under their parent (↳) via FleetRow.parentRunId, plus an
 * activity line hung on a ╰ hook (muted tool trail with an accent in-flight
 * ▸tool + args preview + live tool duration, » thinking stream) when the run
 * is mid-tool or mid-thought — long tool calls render in full on their own
 * line instead of being truncated off the row. The ╰ + muting keep per-agent
 * boundaries legible: bright main rows are the anchors, dim hooked lines
 * read as belonging to the row above.
 *
 * Same two-layer split as the panel:
 *  1. Pure line builders (`buildFleetWidgetLines`, `formatWidgetCost`) —
 *     FleetViewModel in, plain-text lines (or undefined) out. Coloring is
 *     injected, so the layer is fully unit-testable without a terminal.
 *  2. `FleetWidgetController` — owns the 1s refresh timer (injected Clock),
 *     the ui capability probe (non-interactive print/rpc modes may lack
 *     setWidget → the controller goes inert silently), and the H1
 *     `onLifecycle` immediate-refresh hook exposed as
 *     SubagentExtensionPoints so stack.ts can merge it into the existing
 *     extension-point fan-out (no new hook surface).
 *
 * The data source is always QueryService.list() → buildFleetViewModel (the
 * same view-model the panel renders); lifecycle events only trigger an early
 * refresh, they never carry display state.
 */

/** Widget registry key (setWidget). Stable across session rebuilds so a new session's widget replaces the old one's content. */
export const FLEET_WIDGET_KEY = "pi-subagent:fleet";

const WIDGET_MARK: Record<FleetHighlight, string> = { none: " ", warn: "!", crit: "✗" };

/** M-C: default / hard cap on run LINES below the header (a run uses 1–2: main row + activity line).
 *  Default 6 fully covers the common ≤3-busy-agent fleet (3 main + 3 activity lines). */
export const WIDGET_DEFAULT_ROWS = 6;
export const WIDGET_MAX_ROWS = 8;

/**
 * Compact cost for the widget: 4 decimals below half a cent (subagent runs
 * are typically sub-cent — same concern as formatUsage), 2 decimals at/above
 * (e.g. "$1.05"). Boundary: exactly $0.005 renders as "$0.01".
 */
export function formatWidgetCost(costUsd: number): string {
  return `$${costUsd < 0.005 ? costUsd.toFixed(4) : costUsd.toFixed(2)}`;
}

export interface FleetWidgetRenderOptions {
  /** Line budget for run lines below the header (a run with live activity uses 2). Default WIDGET_DEFAULT_ROWS (6); hard cap WIDGET_MAX_ROWS (8). */
  maxRows?: number;
  /** M6: keep just-finished runs visible (dimmed, ✓/✗) for this long. Default 5000ms; 0 disables. */
  terminalLingerMs?: number;
  /** M9: in-flight workflows — rendered as ⚙ group headers with their children (rows whose parentRunId === workflowId) indented beneath. */
  workflows?: readonly WorkflowGroupInput[];
  /** Color injector, same tones as the panel (warn/crit/muted); default plain text. */
  color?: FleetColorize;
}

/** M9: one in-flight workflow's header data (from WorkflowActivityRegistry, elapsed precomputed by the controller). */
export interface WorkflowGroupInput {
  workflowId: string;
  name: string;
  phase?: string;
  elapsedMs: number;
}

/** M-C: one run's main tree-row line. M10: segment-colored when a colorizer is
 *  provided — label plain (the eye-catcher), #id/type/model/phase/phase-age/Σ-total/cost
 *  muted — so rows have visual depth instead of a uniform white line.
 *  warn/crit rows pass the identity colorizer here and get whole-line tone
 *  coloring from the caller instead (nesting SGR sequences would reset the
 *  outer color mid-line). Live activity (tool trail / thinking stream) is NOT
 *  on this line — see widgetRowActivity. */
function widgetRowMain(row: FleetRow, color: FleetColorize = (_t, s) => s): string {
  const name = row.label ? `${row.label} ${color("muted", `#${row.shortRunId}`)}` : row.shortRunId;
  const meta: string[] = [row.type ?? "·"];
  if (row.model) meta.push(row.model);
  // Active rows show the current phase's age (phaseMs) AND the run's total
  // elapsed (Σ): 🧠思考 12s Σ1m05s reads as "this model turn has been
  // generating for 12s; the whole run is 1m05s old". Tool-call timing lives
  // on the activity line's ▸ segment (see toolTrailOf / widgetRowActivity).
  meta.push(row.phaseLabel, formatDuration(row.phaseMs), `Σ${formatDuration(row.elapsedMs)}`);
  const parts = [name, color("muted", meta.join(" "))];
  if (row.usage) parts.push(color("muted", formatWidgetCost(row.usage.costUsd)));
  return parts.join(" ");
}

/** The run's live-activity line (rendered on its own indented continuation
 *  line so long tool calls are never truncated off the row): the tool trail
 *  with the in-flight `▸tool` segment (accent-colored) and/or the one-line
 *  thinking stream (`» …`, muted). undefined when the run is quiet.
 *  Boundary cue: the whole line is muted except the in-flight ▸ segment, so
 *  bright main rows stay the visual anchors and dim activity reads as
 *  belonging to the row above it (see also the ╰ hook in renderRunLines). */
function widgetRowActivity(row: FleetRow, color: FleetColorize = (_t, s) => s): string | undefined {
  const parts: string[] = [];
  const fallbackTool =
    row.currentTool === undefined
      ? undefined
      : `▸${row.currentTool}${row.currentToolMs === undefined ? "" : ` · ${formatDuration(row.currentToolMs)}`}`;
  const trail = row.toolTrail ?? fallbackTool;
  if (trail) {
    const idx = trail.indexOf("▸");
    parts.push(
      idx >= 0 ? color("muted", trail.slice(0, idx)) + color("header", trail.slice(idx)) : color("muted", trail),
    );
  }
  if (row.streamLine) parts.push(color("muted", `» ${row.streamLine}`));
  return parts.length ? parts.join(" ") : undefined;
}

/** M6: a just-finished run's dimmed row: "✓ 任务名 #id type model completed 39s $0.11". */
function widgetTerminalDetail(row: FleetRow): string {
  const parts = [row.label ? `${row.label} #${row.shortRunId}` : row.shortRunId, row.type ?? "·"];
  if (row.model) parts.push(row.model);
  parts.push(row.status, formatDuration(row.elapsedMs));
  if (row.usage) parts.push(formatWidgetCost(row.usage.costUsd));
  return parts.join(" ");
}

/** M-C: order active rows as a forest — severity-ordered roots, each followed by its children (depth-first). */
export function treeOrder(rows: readonly FleetRow[]): Array<{ row: FleetRow; depth: number }> {
  const present = new Set(rows.map((r) => r.runId));
  const children = new Map<string, FleetRow[]>();
  const roots: FleetRow[] = [];
  for (const row of rows) {
    if (row.parentRunId !== undefined && present.has(row.parentRunId)) {
      const list = children.get(row.parentRunId) ?? [];
      list.push(row);
      children.set(row.parentRunId, list);
    } else roots.push(row);
  }
  const out: Array<{ row: FleetRow; depth: number }> = [];
  const visit = (row: FleetRow, depth: number) => {
    out.push({ row, depth });
    for (const child of children.get(row.runId) ?? []) visit(child, depth + 1);
  };
  for (const root of roots) visit(root, 0);
  return out;
}

/** M10: warn/crit rows → whole-line tone color (visibility beats prettiness); calm rows → segment colors.
 *  Returns 1–2 lines: the main row plus, when the run is mid-tool / mid-thought, an indented
 *  activity continuation hung on a ╰ hook under the mark column (↳ replaced by space). */
function renderRunLines(row: FleetRow, indent: string, color: FleetColorize): string[] {
  // ╰ hook under the (blank) mark column ties the activity line to the row
  // above it — without it a bright trail line reads as the next agent's row.
  const pad = ` ╰ ${indent.replace(/↳/g, " ")}`;
  if (row.highlight !== "none") {
    const main = color(row.highlight, `${WIDGET_MARK[row.highlight]} ${indent}${widgetRowMain(row)}`);
    const activity = widgetRowActivity(row);
    return activity ? [main, color(row.highlight, `${pad}${activity}`)] : [main];
  }
  const main = `${WIDGET_MARK.none} ${indent}${widgetRowMain(row, color)}`;
  const activity = widgetRowActivity(row, color);
  return activity ? [main, `${pad}${activity}`] : [main];
}

/**
 * Build the agent-tree widget lines from the (shared) fleet view model.
 *
 * - Returns undefined when no runs are active → the controller hides the
 *   widget (terminal-only history is panel material, not widget material).
 * - Line 1 (header): `<bullet> N active Agents[ · $cost][ · +M more]` — the bullet
 *   is colored by the worst active highlight (rows arrive pre-sorted
 *   crit→warn→none from buildFleetViewModel).
 * - Lines 2..: runs in tree order — mark (! warn / ✗ crit), depth indent,
 *   `↳` for nested rows. Each run takes 1–2 lines: the main row (label /
 *   type / model / phase / phase age / Σ total elapsed / cost) plus, when mid-tool or
 *   mid-thought, an indented activity line (tool trail with in-flight
 *   ▸tool + args preview, and/or the » thinking stream) so long tool calls
 *   render in full instead of being truncated off the row. maxRows is a
 *   LINE budget: main rows are dealt out first (every visible run keeps its
 *   identity line), then the leftover lines go to activity continuations in
 *   display order — greedy 2-lines-per-run allocation starved the LAST
 *   visible run of its tool trail whenever N busy runs didn't fit an even
 *   budget.
 */
export function buildFleetWidgetLines(
  model: FleetViewModel,
  opts: FleetWidgetRenderOptions = {},
): string[] | undefined {
  const color: FleetColorize = opts.color ?? ((_tone, text) => text);
  const maxRows = Math.min(WIDGET_MAX_ROWS, Math.max(1, opts.maxRows ?? WIDGET_DEFAULT_ROWS));
  const lingerMs = opts.terminalLingerMs ?? 5000;
  const workflows = (opts.workflows ?? []).slice(0, 3);
  const activeRows = model.rows.filter((r) => !r.terminal);
  // M6: just-finished runs linger dimmed for a few seconds so a completion is
  // perceivable instead of vanishing between two ticks.
  const recentTerminal = model.rows.filter(
    (r) => r.terminal && r.settledAgoMs !== undefined && r.settledAgoMs <= lingerMs,
  );
  if (model.activeCount === 0 && recentTerminal.length === 0 && workflows.length === 0) return undefined;
  const worst = activeRows[0]?.highlight ?? "none";
  // M9: workflow children (parentRunId === workflowId) are claimed by their
  // workflow's ⚙ group; everything else goes through the regular run tree.
  const workflowIds = new Set(workflows.map((w) => w.workflowId));
  const grouped = new Map<string, FleetRow[]>();
  const general: FleetRow[] = [];
  for (const row of activeRows) {
    if (row.parentRunId !== undefined && workflowIds.has(row.parentRunId)) {
      const list = grouped.get(row.parentRunId) ?? [];
      list.push(row);
      grouped.set(row.parentRunId, list);
    } else general.push(row);
  }
  const activeCost = activeRows.reduce((sum, r) => sum + (r.usage?.costUsd ?? 0), 0);
  // Ordered entries: workflow ⚙ group headers interleaved with their claimed
  // runs, then the general run forest. ⚙ headers don't consume the line budget.
  type Entry = { header: string } | { row: FleetRow; indent: string };
  const entries: Entry[] = [];
  for (const wf of workflows) {
    entries.push({ header: color("header", `⚙ ${wf.name} · ${wf.phase ?? "-"} · ${formatDuration(wf.elapsedMs)}`) });
    for (const row of grouped.get(wf.workflowId) ?? []) entries.push({ row, indent: "↳ " });
  }
  for (const { row, depth } of treeOrder(general)) {
    const indent = depth > 0 ? `${"  ".repeat(depth - 1)}↳ ` : row.nested ? "↳ " : "";
    entries.push({ row, indent });
  }
  // Fair line budget: deal every run its main row first, then hand the
  // leftover lines to activity continuations in display order. (Greedy
  // 2-lines-per-run allocation starved the LAST visible run of its tool
  // trail whenever N busy runs didn't fit an even budget.)
  let budget = maxRows;
  let shownRuns = 0;
  const rendered = entries.map((entry) => {
    if ("header" in entry) return { main: entry.header, activity: undefined as string | undefined, show: false };
    if (budget <= 0) return undefined; // run hidden behind "+N more"
    const [main, activity] = renderRunLines(entry.row, entry.indent, color);
    budget -= 1;
    shownRuns++;
    return { main: main!, activity, show: false };
  });
  for (const r of rendered) {
    if (budget <= 0) break;
    if (r?.activity !== undefined && !r.show) {
      r.show = true;
      budget -= 1;
    }
  }
  const lines: string[] = [];
  for (const r of rendered) {
    if (!r) continue;
    lines.push(r.main);
    if (r.show && r.activity !== undefined) lines.push(r.activity);
  }
  const hidden = model.activeCount - shownRuns;
  const header =
    `${color(worst, "●")} ${model.activeCount} active Agents` +
    (activeCost > 0 ? ` · ${formatWidgetCost(activeCost)}` : "") +
    (hidden > 0 ? ` · +${hidden} more` : "");
  lines.unshift(header);
  for (const row of recentTerminal.slice(0, Math.max(0, budget))) {
    const mark = row.status === "completed" ? "✓" : "✗";
    lines.push(color("muted", `${mark} ${widgetTerminalDetail(row)}`));
  }
  return lines;
}

// ── Controller ──

/** Minimal probed slice of ExtensionUIContext; setWidget is `unknown` because non-interactive modes may drop it. */
export interface FleetWidgetHost {
  setWidget?: unknown;
}
type SetWidgetFn = (
  key: string,
  content: string[] | undefined,
  options?: { placement?: "aboveEditor" | "belowEditor" },
) => void;

export interface FleetWidgetDeps {
  query: QueryService;
  /** ctx.ui (probed, never trusted): missing setWidget → inert controller, no timer, no throw. */
  ui?: FleetWidgetHost;
  /** Master switch (settings.fleetWidget). Default true. */
  enabled?: boolean;
  clock?: Clock;
  /** Refresh tick. Default 1000ms, same cadence as the panel. */
  refreshMs?: Millis;
  /** settings.budget.idleMs — same half-idle warn semantics as the panel. */
  idleBudgetMs?: Millis;
  /** Line budget for run lines below the header. Default WIDGET_DEFAULT_ROWS (6); hard cap WIDGET_MAX_ROWS (8). */
  maxRows?: number;
  /** M9: in-flight workflow snapshots (WorkflowActivityRegistry.list) for ⚙ group headers. */
  workflows?: () => readonly { workflowId: string; name: string; startedAt: number; currentPhaseId?: string }[];
  typeOf?: (runId: RunId) => string | undefined;
  color?: FleetColorize;
}

export class FleetWidgetController {
  private readonly clock: Clock;
  private readonly setWidget: SetWidgetFn | undefined;
  private timer: TimerHandle | undefined;
  private disposed = false;
  /** Sticky: one setWidget throw (degenerate non-interactive host) disables the widget silently. */
  private uiDead = false;
  /** H1 observer; merge into the session's SubagentExtensionPoints fan-out. */
  readonly lifecycle: SubagentExtensionPoints;

  constructor(private readonly deps: FleetWidgetDeps) {
    this.clock = deps.clock ?? systemClock;
    const candidate = deps.ui?.setWidget;
    this.setWidget = typeof candidate === "function" ? (candidate as SetWidgetFn).bind(deps.ui) : undefined;
    this.lifecycle = { onLifecycle: () => this.refresh() };
    if (!this.live) return; // inert: disabled or no setWidget capability
    this.refresh();
    if (!this.live) return; // initial push already hit a degenerate host — stay inert, no tick
    const refreshMs = deps.refreshMs ?? 1000;
    const tick = () => {
      if (this.disposed) return;
      this.refresh();
      this.timer = this.clock.setTimer(refreshMs, tick);
    };
    this.timer = this.clock.setTimer(refreshMs, tick);
  }

  private get live(): boolean {
    return !this.disposed && !this.uiDead && this.setWidget !== undefined && this.deps.enabled !== false;
  }

  /** Re-pull the view model and push lines (or hide). Safe to call from H1 lifecycle sinks. */
  refresh(): void {
    if (!this.live) return;
    const model = buildFleetViewModel(this.deps.query.list(), {
      now: this.clock.now(),
      recentTerminal: 3, // M6: feed just-finished runs so the builder can linger them briefly
      maxActiveRows: Math.min(WIDGET_MAX_ROWS, Math.max(1, this.deps.maxRows ?? WIDGET_DEFAULT_ROWS)),
      ...(this.deps.idleBudgetMs !== undefined ? { idleBudgetMs: this.deps.idleBudgetMs } : {}),
      ...(this.deps.typeOf ? { typeOf: this.deps.typeOf } : {}),
    });
    const lines = buildFleetWidgetLines(model, {
      ...(this.deps.maxRows !== undefined ? { maxRows: this.deps.maxRows } : {}),
      ...(this.deps.color ? { color: this.deps.color } : {}),
      ...(this.deps.workflows
        ? {
            workflows: this.deps.workflows().map((w) => ({
              workflowId: w.workflowId,
              name: w.name,
              ...(w.currentPhaseId === undefined ? {} : { phase: w.currentPhaseId }),
              elapsedMs: Math.max(0, this.clock.now() - w.startedAt),
            })),
          }
        : {}),
    });
    this.push(lines);
  }

  private push(lines: string[] | undefined): void {
    try {
      // M-C fix: setWidget lines are plain strings — a long label + tool trail
      // would wrap and grow the widget by extra lines. Truncate to the live
      // terminal width (ANSI-safe), falling back to a conservative 120 cols.
      const width = Math.max(20, (process.stdout?.columns ?? 120) - 1);
      const truncated = lines?.map((line) => truncateToWidth(line, width));
      this.setWidget!(FLEET_WIDGET_KEY, truncated, { placement: "aboveEditor" });
    } catch {
      // Non-interactive/degenerate host: go inert silently (never throw out of a UI observer).
      this.uiDead = true;
      this.stopTimer();
    }
  }

  private stopTimer(): void {
    if (this.timer) this.clock.clearTimer(this.timer);
    this.timer = undefined;
  }

  /** Stop the tick and clear the widget. Idempotent; called on session rebuild before the new stack's widget mounts. */
  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.stopTimer();
    if (this.setWidget && !this.uiDead) {
      try {
        this.setWidget(FLEET_WIDGET_KEY, undefined);
      } catch {
        /* host already gone — nothing to clear */
      }
    }
  }
}
