import { systemClock, type Clock, type TimerHandle } from "../core/clock.js";
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
 * Same two-layer split as the panel:
 *  1. Pure line builders (`buildFleetWidgetLines`, `formatWidgetCost`) —
 *     FleetViewModel in, ≤3 plain-text lines (or undefined) out. Coloring is
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

/**
 * Compact cost for the widget: 4 decimals below half a cent (subagent runs
 * are typically sub-cent — same concern as formatUsage), 2 decimals at/above
 * (e.g. "$1.05"). Boundary: exactly $0.005 renders as "$0.01".
 */
export function formatWidgetCost(costUsd: number): string {
  return `$${costUsd < 0.005 ? costUsd.toFixed(4) : costUsd.toFixed(2)}`;
}

export interface FleetWidgetRenderOptions {
  /** Runs shown (one inline in the summary line + one per extra line). Default 2 → ≤2 lines; hard cap 3 keeps the widget ≤3 lines. */
  maxRows?: number;
  /** Color injector, same tones as the panel (warn/crit/muted); default plain text. */
  color?: FleetColorize;
}

/** One run's compact detail: "8m32s architect model_turn bash $1.05" (nested runs get a ↳ prefix). */
function widgetRowDetail(row: FleetRow): string {
  const parts = [formatDuration(row.elapsedMs), row.type ?? "·", row.phase];
  if (row.currentTool) parts.push(row.currentTool);
  if (row.usage) parts.push(formatWidgetCost(row.usage.costUsd));
  const detail = parts.join(" ");
  return row.nested ? `↳ ${detail}` : detail;
}

/**
 * Build the widget lines from the (shared) fleet view model.
 *
 * - Returns undefined when no runs are active → the controller hides the
 *   widget (terminal-only history is panel material, not widget material).
 * - Line 1: `<bullet> N active · <top run detail>[ · +M more]` — the bullet
 *   is colored by the worst active highlight (rows arrive pre-sorted
 *   crit→warn→none from buildFleetViewModel, so the top run IS the worst).
 * - Lines 2..maxRows: remaining runs in the same highlight-priority order,
 *   each prefixed with the panel's mark (! warn / ✗ crit) and colored with
 *   the same tone semantics as the panel rows.
 */
export function buildFleetWidgetLines(
  model: FleetViewModel,
  opts: FleetWidgetRenderOptions = {},
): string[] | undefined {
  if (model.activeCount === 0) return undefined;
  const color: FleetColorize = opts.color ?? ((_tone, text) => text);
  const maxRows = Math.min(3, Math.max(1, opts.maxRows ?? 2));
  const activeRows = model.rows.filter((r) => !r.terminal);
  if (activeRows.length === 0) return undefined; // defensive: activeCount/rows disagree
  const shown = activeRows.slice(0, maxRows);
  const worst = shown[0]!.highlight;
  const hidden = model.activeCount - shown.length;
  const summary = `${color(worst, "●")} ${model.activeCount} active · ${widgetRowDetail(shown[0]!)}`;
  const lines = [hidden > 0 ? `${summary} · +${hidden} more` : summary];
  for (const row of shown.slice(1)) {
    lines.push(color(row.highlight, `${WIDGET_MARK[row.highlight]} ${widgetRowDetail(row)}`));
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
      maxActiveRows: Math.min(3, Math.max(1, this.deps.maxRows ?? 2)),
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
      this.setWidget!(FLEET_WIDGET_KEY, lines, { placement: "aboveEditor" });
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
