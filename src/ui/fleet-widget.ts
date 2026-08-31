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
 * count, live cost, overflow) followed by one line per run, children
 * indented under their parent (↳) via FleetRow.parentRunId, each row showing
 * label · type · model · phase · elapsed · tool trail.
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

/** M-C: default / hard cap on run rows (excluding the header line). */
export const WIDGET_DEFAULT_ROWS = 5;
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
  /** Run rows shown below the header line. Default WIDGET_DEFAULT_ROWS (5); hard cap WIDGET_MAX_ROWS (8). */
  maxRows?: number;
  /** Color injector, same tones as the panel (warn/crit/muted); default plain text. */
  color?: FleetColorize;
}

/** M-C: one run's tree-row detail: "重构用户模块 #223b8f1e architect kimi-k3 tool_exec 8m32s bash×3 ▸edit $1.05".
 *  The #shortRunId ties the row back to its Agent tool call / completion
 *  notification (which reference the run id) — label alone is ambiguous when
 *  the same description is reused. */
function widgetRowDetail(row: FleetRow): string {
  const parts = [row.label ? `${row.label} #${row.shortRunId}` : row.shortRunId, row.type ?? "·"];
  if (row.model) parts.push(row.model);
  parts.push(row.phase, formatDuration(row.elapsedMs));
  const trail = row.toolTrail ?? (row.currentTool ? `▸${row.currentTool}` : undefined);
  if (trail) parts.push(trail);
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

/**
 * Build the agent-tree widget lines from the (shared) fleet view model.
 *
 * - Returns undefined when no runs are active → the controller hides the
 *   widget (terminal-only history is panel material, not widget material).
 * - Line 1 (header): `<bullet> N active[ · $cost][ · +M more]` — the bullet
 *   is colored by the worst active highlight (rows arrive pre-sorted
 *   crit→warn→none from buildFleetViewModel).
 * - Lines 2..: one per run in tree order — mark (! warn / ✗ crit), depth
 *   indent, `↳` for nested rows, then label/type/model/phase/elapsed/trail.
 */
export function buildFleetWidgetLines(
  model: FleetViewModel,
  opts: FleetWidgetRenderOptions = {},
): string[] | undefined {
  if (model.activeCount === 0) return undefined;
  const color: FleetColorize = opts.color ?? ((_tone, text) => text);
  const maxRows = Math.min(WIDGET_MAX_ROWS, Math.max(1, opts.maxRows ?? WIDGET_DEFAULT_ROWS));
  const activeRows = model.rows.filter((r) => !r.terminal);
  if (activeRows.length === 0) return undefined; // defensive: activeCount/rows disagree
  const worst = activeRows[0]!.highlight;
  const ordered = treeOrder(activeRows).slice(0, maxRows);
  const hidden = model.activeCount - ordered.length;
  const activeCost = activeRows.reduce((sum, r) => sum + (r.usage?.costUsd ?? 0), 0);
  const header =
    `${color(worst, "●")} ${model.activeCount} active` +
    (activeCost > 0 ? ` · ${formatWidgetCost(activeCost)}` : "") +
    (hidden > 0 ? ` · +${hidden} more` : "");
  const lines = [header];
  for (const { row, depth } of ordered) {
    const indent = depth > 0 ? `${"  ".repeat(depth - 1)}↳ ` : row.nested ? "↳ " : "";
    lines.push(color(row.highlight, `${WIDGET_MARK[row.highlight]} ${indent}${widgetRowDetail(row)}`));
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
  /** Run rows below the header. Default WIDGET_DEFAULT_ROWS (5); hard cap WIDGET_MAX_ROWS (8). */
  maxRows?: number;
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
      recentTerminal: 0, // widget shows active runs only
      maxActiveRows: Math.min(WIDGET_MAX_ROWS, Math.max(1, this.deps.maxRows ?? WIDGET_DEFAULT_ROWS)),
      ...(this.deps.idleBudgetMs !== undefined ? { idleBudgetMs: this.deps.idleBudgetMs } : {}),
      ...(this.deps.typeOf ? { typeOf: this.deps.typeOf } : {}),
    });
    const lines = buildFleetWidgetLines(model, {
      ...(this.deps.maxRows !== undefined ? { maxRows: this.deps.maxRows } : {}),
      ...(this.deps.color ? { color: this.deps.color } : {}),
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
