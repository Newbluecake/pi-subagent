import { systemClock, type Clock, type TimerHandle } from "../core/clock.js";
import { truncateToWidth } from "@earendil-works/pi-tui";
import type { Millis, RunId, SubagentExtensionPoints } from "../core/types.js";
import type { JobRecord, JobStatus } from "../bash/types.js";
import { isTerminalJobStatus, previewCommand } from "../bash/types.js";
import type { QueryService } from "../service/query-service.js";
import {
  buildFleetViewModel,
  colorizeToolTrail,
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
 * activity line hung on a ╰ hook (collapsed tool tally `✓ bash ×9 | ✓ read
 * ×6` with green ✓ / red ✗ marks + an accent in-flight ▸tool + args preview
 * + live tool duration, » thinking stream) when the run is mid-tool or mid-thought — long tool calls render in full on their own
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
 *     extension-point fan-out (no new hook surface). Failure isolation is
 *     part of the contract, but note WHICH paths actually needed it: the H1
 *     fan-out is already guarded upstream (mergeExtensionPoints catches +
 *     WARNs every onLifecycle throw), so the two unprotected paths were the
 *     1Hz tick — a self-rescheduling one-shot whose skipped re-arm freezes
 *     the tree for the whole session, not just one frame — and the
 *     constructor's initial refresh(), which runs inside buildSessionStack
 *     and would therefore take the *entire extension* down with it (a throw
 *     escapes the session_start handler before `holder.current = stack`, so
 *     every later Agent call fails with "no active session yet").
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

/** Widget row log size; bytes remain explicit below 1KB because tiny logs are common. */
export function formatLogSize(bytes: number): string {
  if (bytes < 1024) return `${Math.max(0, bytes)}B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(bytes < 10 * 1024 ? 1 : 0)}KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)}MB`;
}

/** Bash terminal severity mirrors the widget's run tones without treating user kills as failures. */
export function bashJobHighlight(status: JobStatus): FleetHighlight {
  if (status === "failed" || status === "timed_out") return "crit";
  if (status === "killed" || status === "exited_unknown" || status === "orphaned") return "warn";
  return "none";
}

/** Extract the last meaningful log line before folding its whitespace into one activity row. */
export function tailLine(text: string | undefined): string | undefined {
  if (text === undefined) return undefined;
  const lines = text.split("\n");
  for (let i = lines.length - 1; i >= 0; i--) {
    const line = lines[i]!.trim();
    if (line.length > 0) return line.replace(/\s+/g, " ");
  }
  return undefined;
}

/** D1: controller-prepared bash data keeps the builder independent of manager state and clocks. */
export interface BashJobViewInput {
  jobId: string;
  commandPreview: string;
  status: JobStatus;
  highlight: FleetHighlight;
  elapsedMs: number;
  logBytes: number;
  logTail?: string;
  settledAgoMs?: number;
}

export interface FleetWidgetRenderOptions {
  /** Line budget for run lines below the header (a run with live activity uses 2). Default WIDGET_DEFAULT_ROWS (6); hard cap WIDGET_MAX_ROWS (8). */
  maxRows?: number;
  /** M6: keep just-finished runs visible (dimmed, ✓/✗) for this long. Default 5000ms; 0 disables. */
  terminalLingerMs?: number;
  /** M9: in-flight workflows — rendered as ⚙ group headers with their children (rows whose parentRunId === workflowId) indented beneath. */
  workflows?: readonly WorkflowGroupInput[];
  /** D1/M3: background bash jobs share the main-row budget with runs. */
  bashJobs?: readonly BashJobViewInput[];
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
  // elapsed (Σ): ⠋思考 12s Σ1m05s reads as "this model turn has been
  // generating for 12s; the whole run is 1m05s old". The thinking label's
  // braille frame is derived from wall time (see thinkingSpinnerFrame), so
  // the 1Hz tick animates it. Tool-call timing lives
  // on the activity line's ▸ segment (see toolTrailOf / widgetRowActivity).
  meta.push(row.phaseLabel, formatDuration(row.phaseMs), `Σ${formatDuration(row.elapsedMs)}`);
  const parts = [name, color("muted", meta.join(" "))];
  if (row.usage) parts.push(color("muted", formatWidgetCost(row.usage.costUsd)));
  if (row.autoBackgrounded) parts.push(color("muted", "⇣后台"));
  return parts.join(" ");
}

/** The run's live-activity line (rendered on its own indented continuation
 *  line so long tool calls are never truncated off the row): the collapsed
 *  tool tally (`✓ bash ×9 | ✓ read ×6` — green ✓ / red ✗ marks, muted names
 *  and counts) plus the in-flight `▸tool` segment (whole-segment accent) and/or
 *  the one-line thinking stream (`» …`, muted). undefined when the run is quiet.
 *  Boundary cue: names/counts stay muted and only the ✓/✗/▸ marks pop, so
 *  bright main rows stay the visual anchors and dim activity reads as
 *  belonging to the row above it (see also the ╰ hook in renderRunLines). */
function widgetRowActivity(row: FleetRow, color: FleetColorize = (_t, s) => s): string | undefined {
  const parts: string[] = [];
  const fallbackTool =
    row.currentTool === undefined
      ? undefined
      : `▸${row.currentTool}${row.currentToolMs === undefined ? "" : ` · ${formatDuration(row.currentToolMs)}`}`;
  const trail = row.toolTrail ?? fallbackTool;
  if (trail) parts.push(colorizeToolTrail(trail, color));
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
 *  activity continuation hung on a ╰ hook under the row's label (↳ replaced by space). */
function renderRunLines(row: FleetRow, indent: string, color: FleetColorize): string[] {
  // ╰ hook sits directly under the row's label (mark column + space + indent),
  // so the continuation reads as hanging from the task name itself — without
  // it a bright trail line reads as the next agent's row.
  const pad = `  ${indent.replace(/↳/g, " ")}╰ `;
  if (row.highlight !== "none") {
    const main = color(row.highlight, `${WIDGET_MARK[row.highlight]} ${indent}${widgetRowMain(row)}`);
    const activity = widgetRowActivity(row);
    return activity ? [main, color(row.highlight, `${pad}${activity}`)] : [main];
  }
  const main = `${WIDGET_MARK.none} ${indent}${widgetRowMain(row, color)}`;
  const activity = widgetRowActivity(row, color);
  return activity ? [main, `${pad}${activity}`] : [main];
}

function widgetBashRowMain(row: BashJobViewInput, color: FleetColorize): string {
  const meta = `$ ${row.commandPreview} · ${row.status} · ${formatDuration(row.elapsedMs)} · ${formatLogSize(row.logBytes)}`;
  return row.highlight === "none" ? `  ${meta}` : color(row.highlight, `${WIDGET_MARK[row.highlight]} ${meta}`);
}

function widgetBashRowActivity(row: BashJobViewInput, color: FleetColorize): string | undefined {
  return row.logTail === undefined ? undefined : `  ╰ ${color("muted", `» ${row.logTail}`)}`;
}

function widgetBashTerminalDetail(row: BashJobViewInput): string {
  return `$ ${row.commandPreview} · ${row.status} · ${formatDuration(row.elapsedMs)} · ${formatLogSize(row.logBytes)}`;
}

/**
 * Build the agent-tree widget lines from the (shared) fleet view model.
 *
 * - Returns undefined when no runs or background bash jobs are visible.
 * - Line 1 (header): `<bullet> N active Agents[ · M bash][ · $cost][ · +M more]` —
 *   the bullet remains the worst active run highlight; bash does not affect it.
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
  const bashJobs = opts.bashJobs ?? [];
  const activeRows = model.rows.filter((r) => !r.terminal);
  const activeBash = bashJobs.filter((job) => !isTerminalJobStatus(job.status));
  const recentBash = bashJobs.filter(
    (job) => isTerminalJobStatus(job.status) && job.settledAgoMs !== undefined && job.settledAgoMs <= lingerMs,
  );
  const visibleBash = [...activeBash, ...recentBash];
  // M6: just-finished runs linger dimmed for a few seconds so a completion is
  // perceivable instead of vanishing between two ticks.
  const recentTerminal = model.rows.filter(
    (r) => r.terminal && r.settledAgoMs !== undefined && r.settledAgoMs <= lingerMs,
  );
  if (model.activeCount === 0 && recentTerminal.length === 0 && workflows.length === 0 && visibleBash.length === 0)
    return undefined;
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
  type Entry = { header: string } | { row: FleetRow; indent: string } | { bash: BashJobViewInput };
  const entries: Entry[] = [];
  for (const wf of workflows) {
    entries.push({ header: color("header", `⚙ ${wf.name} · ${wf.phase ?? "-"} · ${formatDuration(wf.elapsedMs)}`) });
    for (const row of grouped.get(wf.workflowId) ?? []) entries.push({ row, indent: "↳ " });
  }
  for (const { row, depth } of treeOrder(general)) {
    const indent = depth > 0 ? `${"  ".repeat(depth - 1)}↳ ` : row.nested ? "↳ " : "";
    entries.push({ row, indent });
  }
  // M3: bash main rows join the same pool as run identities. This deliberately
  // lets bash be hidden only after the same maxRows worth of runs, preserving
  // one simple budget and truthful "+N more" accounting.
  for (const bash of activeBash) entries.push({ bash });
  // Fair line budget: deal every run its main row first, then hand the
  // leftover lines to activity continuations in display order. (Greedy
  // 2-lines-per-run allocation starved the LAST visible run of its tool
  // trail whenever N busy runs didn't fit an even budget.)
  let budget = maxRows;
  let shownRuns = 0;
  const rendered = entries.map((entry) => {
    if ("header" in entry) return { main: entry.header, activity: undefined as string | undefined, show: false };
    if (budget <= 0) return undefined; // identity hidden behind "+N more"
    const rendered =
      "bash" in entry
        ? { main: widgetBashRowMain(entry.bash, color), activity: widgetBashRowActivity(entry.bash, color) }
        : (() => {
            const [main, activity] = renderRunLines(entry.row, entry.indent, color);
            return { main: main!, activity };
          })();
    budget -= 1;
    shownRuns++;
    return { ...rendered, show: false };
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
  // M4: only active identities contribute to hidden; workflow headers and
  // terminal linger rows are transient and intentionally excluded.
  const hidden = model.activeCount + activeBash.length - shownRuns;
  const header =
    `${color(worst, "●")} ${model.activeCount} active Agents` +
    (activeBash.length > 0 ? ` · ${activeBash.length} bash` : "") +
    (activeCost > 0 ? ` · ${formatWidgetCost(activeCost)}` : "") +
    (hidden > 0 ? ` · +${hidden} more` : "");
  lines.unshift(
    model.activeCount === 0 && activeBash.length > 0
      ? `${color("none", "●")} ${activeBash.length} background bash${hidden > 0 ? ` · +${hidden} more` : ""}`
      : header,
  );
  // M6/F1: linger rows use the same remaining line budget as active rows;
  // retaining completion visibility must never grow the widget beyond maxRows.
  for (const row of recentTerminal) {
    if (budget <= 0) break;
    const mark = row.status === "completed" ? "✓" : "✗";
    lines.push(color("muted", `${mark} ${widgetTerminalDetail(row)}`));
    budget -= 1;
  }
  for (const row of recentBash) {
    if (budget <= 0) break;
    const tone = row.highlight;
    const mark = tone === "crit" ? "✗" : tone === "warn" ? "!" : "✓";
    lines.push(color(tone === "none" ? "muted" : tone, `${mark} ${widgetBashTerminalDetail(row)}`));
    budget -= 1;
    if (row.logTail !== undefined && budget > 0) {
      lines.push(color("muted", `  ╰ » ${row.logTail}`));
      budget -= 1;
    }
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
  /** D1: live in-memory bash job records; fs access remains in the stack adapter. */
  bashJobs?: () => readonly JobRecord[];
  /** D2: stack-bound two-pass tail reader, including the observed file size. */
  readBashTail?: (
    record: JobRecord,
    sizeHint?: number,
  ) => Promise<{ text: string | undefined; logBytes: number } | undefined>;
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
  /** Sticky: refresh() failures are reported once — the 1Hz tick keeps running. */
  private warnedRefreshFailure = false;
  /** H1 observer; merge into the session's SubagentExtensionPoints fan-out. */
  readonly lifecycle: SubagentExtensionPoints;
  /** D2: cache is controller-owned because renderFrame must stay synchronous. */
  private readonly bashTailCache = new Map<string, { text: string; observedSize: number; terminal: boolean }>();
  private readonly bashTailInflight = new Set<string>();
  private readonly tailFailures = new Map<string, Millis>();

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
      if (!this.live) return;
      try {
        this.refresh();
      } finally {
        // Unconditional re-arm. This is a self-rescheduling ONE-SHOT timer, not
        // a setInterval: a skipped setTimer is not a dropped frame but a
        // permanently stopped clock (the agent tree would freeze for the rest
        // of the session, recoverable only by a /reload-driven stack rebuild).
        // `live` — not `!disposed` — is the correct guard: push() sets uiDead +
        // stopTimer() as its deliberate give-up path for a degenerate host, and
        // re-arming there would resurrect a zombie 1Hz tick that only ever
        // early-returns out of refresh().
        if (this.live) this.timer = this.clock.setTimer(refreshMs, tick);
      }
    };
    this.timer = this.clock.setTimer(refreshMs, tick);
  }

  private get live(): boolean {
    return !this.disposed && !this.uiDead && this.setWidget !== undefined && this.deps.enabled !== false;
  }

  /**
   * Re-pull the view model and push lines (or hide). A view-model/render
   * failure is swallowed here (frame dropped, warned once) rather than
   * propagated, because refresh() has three callers with very different blast
   * radii:
   *  - the constructor, running inside buildSessionStack → a throw escapes the
   *    session_start handler before `holder.current = stack` is assigned and
   *    kills the whole extension for that session (every Agent call then fails
   *    with "no active session yet"). This is the worst one.
   *  - the 1Hz tick → see the re-arm note in the constructor.
   *  - the H1 onLifecycle sink wired in stack.ts → defense in depth only;
   *    mergeExtensionPoints already catches and WARNs throws on that path.
   * Dropping a frame is always safe: the widget holds no incremental state, so
   * the next tick rebuilds it from scratch.
   */
  refresh(): void {
    if (!this.live) return;
    try {
      this.renderFrame();
    } catch (error) {
      // Warn-once: a 1Hz tick would otherwise spam the TUI with the same line.
      if (!this.warnedRefreshFailure) {
        this.warnedRefreshFailure = true;
        const detail = error instanceof Error ? error.message : String(error);
        console.warn(`[pi-subagent] fleet widget refresh failed (frame dropped, tick continues): ${detail}`);
      }
    }
  }

  /** Unguarded refresh core — never call directly, always go through refresh(). */
  private renderFrame(): void {
    const now = this.clock.now();
    const bashRecords = this.deps.bashJobs?.() ?? [];
    const bashViews = this.bashJobViews(bashRecords, now);
    this.prefetchBashTails(bashRecords);
    const model = buildFleetViewModel(this.deps.query.list(), {
      now,
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
              elapsedMs: Math.max(0, now - w.startedAt),
            })),
          }
        : {}),
      ...(this.deps.bashJobs ? { bashJobs: bashViews } : {}),
    });
    this.push(lines);
  }

  private bashJobViews(records: readonly JobRecord[], now: number): BashJobViewInput[] {
    const visible = records.filter((record) => record.backgroundedAt !== undefined);
    const ids = new Set(visible.map((record) => record.jobId));
    // Each session rebuild owns this cache; pruning every frame also handles
    // retention sweeps without allowing job ids to accumulate indefinitely.
    for (const id of this.bashTailCache.keys()) if (!ids.has(id)) this.bashTailCache.delete(id);
    for (const id of this.bashTailInflight) if (!ids.has(id)) this.bashTailInflight.delete(id);
    for (const id of this.tailFailures.keys()) if (!ids.has(id)) this.tailFailures.delete(id);
    return visible.map((record) => {
      const terminal = isTerminalJobStatus(record.status);
      const cache = this.bashTailCache.get(record.jobId);
      const elapsedMs = Math.max(0, (record.endedAt ?? now) - (record.spawnedAt ?? record.createdAt));
      const view: BashJobViewInput = {
        jobId: record.jobId,
        commandPreview: previewCommand(record.command, 80),
        status: record.status,
        highlight: terminal ? bashJobHighlight(record.status) : "none",
        elapsedMs,
        logBytes: record.logBytes,
        ...(cache?.text !== undefined && tailLine(cache.text) !== undefined ? { logTail: tailLine(cache.text)! } : {}),
        ...(terminal && record.endedAt !== undefined ? { settledAgoMs: Math.max(0, now - record.endedAt) } : {}),
      };
      return view;
    });
  }

  private prefetchBashTails(records: readonly JobRecord[]): void {
    const readTail = this.deps.readBashTail;
    if (!readTail || this.disposed) return;
    for (const record of records) {
      if (record.backgroundedAt === undefined || this.bashTailInflight.has(record.jobId)) continue;
      const terminal = isTerminalJobStatus(record.status);
      const cache = this.bashTailCache.get(record.jobId);
      // Running jobs deliberately reread every tick: adopted records do not
      // refresh logBytes during liveness polling, so record-only invalidation
      // would freeze their activity forever. Terminal rows freeze after one read.
      if (terminal && cache?.terminal) continue;
      const failedAt = this.tailFailures.get(record.jobId);
      if (failedAt !== undefined && this.clock.now() - failedAt < 5000) continue;
      this.bashTailInflight.add(record.jobId);
      const hint = Math.max(record.logBytes, cache?.observedSize ?? 0);
      void readTail(record, hint)
        .then((result) => {
          const text = result?.text;
          const fallback = text === undefined ? record.finalText : undefined;
          const value = text ?? fallback;
          const observedSize = result?.logBytes ?? hint;
          if (value !== undefined) {
            this.bashTailCache.set(record.jobId, { text: value, observedSize, terminal });
          } else if (terminal) {
            this.bashTailCache.set(record.jobId, { text: "", observedSize, terminal: true });
          }
          this.tailFailures.delete(record.jobId);
        })
        .catch(() => {
          // Log retention races are expected; suppress them and back off so a
          // long-lived missing log cannot generate one rejected read per tick.
          this.tailFailures.set(record.jobId, this.clock.now());
          if (terminal) {
            const fallback = tailLine(record.finalText);
            this.bashTailCache.set(record.jobId, { text: fallback ?? "", observedSize: hint, terminal: true });
          }
        })
        .finally(() => this.bashTailInflight.delete(record.jobId));
    }
  }

  private push(lines: string[] | undefined): void {
    try {
      // M-C fix: setWidget lines are plain strings — a long label + tool trail
      // would wrap and grow the widget by extra lines. Truncate to the live
      // terminal width (ANSI-safe), falling back to a conservative 120 cols.
      //
      // Flicker fix: pi renders each widget string as `new Text(line, /*paddingX*/ 1, 0)`,
      // so the wrap threshold is terminal columns − 2 (1 col of padding each
      // side), NOT columns − 1. Truncating to columns − 1 left every max-width
      // line exactly 1 col past the threshold: it wrapped onto a dangling
      // second line, and as live durations/trails changed width each 1Hz tick
      // the wrap toggled on/off → widget height oscillated → every line below
      // (editor, footer) reflowed every second — the "agent tree flicker".
      const width = Math.max(20, (process.stdout?.columns ?? 120) - 2);
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
