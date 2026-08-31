import type { Theme } from "@earendil-works/pi-coding-agent";
import { truncateToWidth } from "@earendil-works/pi-tui";
import { systemClock, type Clock, type TimerHandle } from "../core/clock.js";
import type { Millis, RunDiagnostics, RunId, RunPhase, RunSnapshot, RunStatus, UsageDelta } from "../core/types.js";
import type { QueryService } from "../service/query-service.js";

/**
 * X7 Fleet UI (architecture §7.2): live subagent status panel. This file is
 * split in two layers, per the milestone discipline:
 *
 *  1. View-model pure functions (snapshot list → row model, highlight levels,
 *     formatting, plain-text line rendering). No pi imports beyond type-only
 *     Theme, no I/O, fully unit-testable.
 *  2. `FleetPanel` — the pi-tui Component wrapper: owns the refresh timer
 *     (injected Clock), key handling (q/esc close, r refresh) and theme
 *     coloring. Data always comes from QueryService.list() (H1 lifecycle
 *     events may trigger a refresh via wiring, but are never the data source).
 *
 * Note: RunSnapshot does not carry the agent type name (adding it would
 * require threading AgentTypeName through the core state machine — out of
 * scope here). The TYPE column is populated through the optional `typeOf`
 * resolver so wiring can supply it without a core change.
 */

export type FleetHighlight = "none" | "warn" | "crit";
export type FleetTone = FleetHighlight | "header" | "muted";
export type FleetColorize = (tone: FleetTone, text: string) => string;
type EscalationLevel = RunDiagnostics["escalation"][number]["level"];

const TERMINAL: readonly RunStatus[] = ["completed", "failed", "timed_out", "aborted"];

export function isTerminalStatus(status: RunStatus): boolean {
  return TERMINAL.includes(status);
}

export interface FleetRow {
  runId: RunId;
  shortRunId: string;
  type: string | undefined;
  /** M-C: SpawnRequest.label (the Agent tool's `description`), from diag.label. */
  label: string | undefined;
  /** M-C: model id from diag.model (display only; undefined = session default). */
  model: string | undefined;
  /** M-C: compact recent-tool trail from diag.toolHistory, e.g. "bash×3→read ▸edit". */
  toolTrail: string | undefined;
  /** M-C: parent link for tree grouping in the widget (undefined = top-level). */
  parentRunId: RunId | undefined;
  status: RunStatus;
  phase: RunPhase;
  /** now - diag.createdAt, clamped ≥ 0. */
  elapsedMs: Millis;
  /** now - (diag.lastEventAt ?? diag.phaseEnteredAt), clamped ≥ 0 — the hang signal. */
  idleMs: Millis;
  currentTool: string | undefined;
  /** e.g. "L2✓→L3✗"; undefined when no escalation has happened. */
  escalation: string | undefined;
  maxEscalation: EscalationLevel | undefined;
  usage: UsageDelta | undefined;
  /** X3 nested run (spawned with parentRunId). */
  nested: boolean;
  terminal: boolean;
  highlight: FleetHighlight;
}

export interface FleetViewModel {
  /** Active rows first (crit → warn → none, then longest-elapsed), then recent terminal rows. */
  rows: FleetRow[];
  activeCount: number;
  shownActiveCount: number;
  totalCount: number;
  usageTotal: UsageDelta | undefined;
}

export interface FleetViewOptions {
  now: Millis;
  /** Idle budget (settings.budget.idleMs): an active run idling past HALF of it is warn-highlighted. */
  idleBudgetMs?: Millis;
  /** Cap on active rows shown (overflow is reported as "+N more"). Default 12. */
  maxActiveRows?: number;
  /** How many recently-finished runs to list below the active ones (dimmed). Default 3. */
  recentTerminal?: number;
  /** Optional runId → agent-type resolver (RunSnapshot doesn't carry the type; see file header). */
  typeOf?: (runId: RunId) => string | undefined;
}

/** Milliseconds since the last observed driver event (or since the current phase started). */
export function idleOf(snapshot: RunSnapshot, now: Millis): Millis {
  const since = snapshot.diag.lastEventAt ?? snapshot.diag.phaseEnteredAt;
  return Math.max(0, now - since);
}

/**
 * Highlight rules (the anti-"stuck and invisible" core of the panel):
 *  - terminal runs are never highlighted (they're history, shown dimmed);
 *  - "stopping" is crit (red): an escalation is in flight, the run may be hanging on teardown;
 *  - past the total deadline (deadlines.deadlineAt) is crit: the watchdog should have fired already;
 *  - idle past HALF the idle budget is warn (yellow): the run is suspiciously quiet but not yet doomed.
 */
export function highlightOf(snapshot: RunSnapshot, opts: { now: Millis; idleBudgetMs?: Millis }): FleetHighlight {
  if (isTerminalStatus(snapshot.status)) return "none";
  if (snapshot.status === "stopping") return "crit";
  if (snapshot.deadlines.deadlineAt !== undefined && opts.now > snapshot.deadlines.deadlineAt) return "crit";
  if (opts.idleBudgetMs !== undefined && idleOf(snapshot, opts.now) * 2 > opts.idleBudgetMs) return "warn";
  return "none";
}

/** Compact escalation trail, e.g. "L2✓→L3✗"; undefined when the run never escalated. */
export function escalationSummary(diag: RunDiagnostics): {
  text: string | undefined;
  max: EscalationLevel | undefined;
} {
  if (!diag.escalation.length) return { text: undefined, max: undefined };
  return {
    text: diag.escalation.map((e) => `${e.level}${e.ok ? "✓" : "✗"}`).join("→"),
    max: diag.escalation[diag.escalation.length - 1]!.level,
  };
}

export function formatDuration(ms: Millis): string {
  const clamped = Math.max(0, Math.round(ms));
  if (clamped < 1000) return `${clamped}ms`;
  const s = Math.floor(clamped / 1000);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m${String(s % 60).padStart(2, "0")}s`;
  const h = Math.floor(m / 60);
  return `${h}h${String(m % 60).padStart(2, "0")}m`;
}

/** X9 usage, 4-decimal cost (same convention as /agent status: subagent runs are sub-cent). */
export function formatUsage(u: UsageDelta): string {
  return `in:${u.input} out:${u.output} $${u.costUsd.toFixed(4)}`;
}

/**
 * M-C: compact trail of a run's recent tool calls for the agent-tree widget
 * and the Agent tool card. Adjacent completed calls of the same tool collapse
 * into `name×k` (failed ones render `name✗`), only the last `maxTokens`
 * tokens are kept, and an in-flight call is appended as `▸name`.
 */
export function toolTrailOf(
  diag: Pick<RunDiagnostics, "toolHistory">,
  maxTokens = 4,
): string | undefined {
  const history = diag.toolHistory;
  if (!history?.length) return undefined;
  const tokens: Array<{ key: string; name: string; failed: boolean; count: number }> = [];
  let running: string | undefined;
  for (const r of history) {
    if (r.endedAt === undefined) {
      running = r.name; // keep the latest in-flight call
      continue;
    }
    const failed = r.isError === true;
    const key = `${r.name}${failed ? "!" : ""}`;
    const last = tokens[tokens.length - 1];
    if (last && last.key === key) last.count++;
    else tokens.push({ key, name: r.name, failed, count: 1 });
  }
  const shown = tokens
    .slice(-maxTokens)
    .map((t) => `${t.name}${t.failed ? "✗" : ""}${t.count > 1 ? `×${t.count}` : ""}`);
  const done = shown.join("→");
  if (running === undefined) return done || undefined;
  return done ? `${done} ▸${running}` : `▸${running}`;
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

function toRow(snapshot: RunSnapshot, opts: FleetViewOptions): FleetRow {
  const esc = escalationSummary(snapshot.diag);
  const terminal = isTerminalStatus(snapshot.status);
  return {
    runId: snapshot.runId,
    shortRunId: snapshot.runId.slice(0, 8),
    type: opts.typeOf?.(snapshot.runId) ?? snapshot.diag.agentType,
    label: snapshot.diag.label,
    model: snapshot.diag.model?.id,
    toolTrail: toolTrailOf(snapshot.diag),
    parentRunId: snapshot.parentRunId,
    status: snapshot.status,
    phase: snapshot.phase,
    elapsedMs: Math.max(0, opts.now - snapshot.diag.createdAt),
    idleMs: idleOf(snapshot, opts.now),
    currentTool: terminal ? undefined : snapshot.diag.currentTool?.name,
    escalation: esc.text,
    maxEscalation: esc.max,
    usage: snapshot.diag.usage,
    nested: snapshot.parentRunId !== undefined,
    terminal,
    highlight: highlightOf(snapshot, opts),
  };
}

const SEVERITY: Record<FleetHighlight, number> = { crit: 0, warn: 1, none: 2 };

export function buildFleetViewModel(snapshots: readonly RunSnapshot[], opts: FleetViewOptions): FleetViewModel {
  const maxActiveRows = opts.maxActiveRows ?? 12;
  const recentTerminal = opts.recentTerminal ?? 3;
  const active = snapshots.filter((s) => !isTerminalStatus(s.status));
  const activeRows = active
    .map((s) => toRow(s, opts))
    .sort((a, b) => SEVERITY[a.highlight] - SEVERITY[b.highlight] || b.elapsedMs - a.elapsedMs)
    .slice(0, Math.max(0, maxActiveRows));
  const terminalRows = snapshots
    .filter((s) => isTerminalStatus(s.status))
    .sort((a, b) => b.updatedAt - a.updatedAt)
    .slice(0, Math.max(0, recentTerminal))
    .map((s) => toRow(s, opts));
  return {
    rows: [...activeRows, ...terminalRows],
    activeCount: active.length,
    shownActiveCount: activeRows.length,
    totalCount: snapshots.length,
    usageTotal: sumUsage(snapshots.map((s) => s.diag.usage)),
  };
}

// ── Plain-text rendering (view model → lines). Coloring is injected so the
// pure layer stays testable without a terminal theme. ──

const HIGHLIGHT_MARK: Record<FleetHighlight, string> = { none: " ", warn: "!", crit: "✗" };

function rowLine(row: FleetRow): string {
  const cols = [
    `${HIGHLIGHT_MARK[row.highlight]} ${row.nested ? "↳" : " "}${row.shortRunId}`,
    (row.type ?? "·").padEnd(10).slice(0, 10),
    row.status.padEnd(9),
    row.phase.padEnd(15),
    formatDuration(row.elapsedMs).padStart(7),
    row.terminal ? "      -" : formatDuration(row.idleMs).padStart(7),
    row.currentTool ?? "-",
  ];
  let line = cols.join(" ");
  if (row.escalation) line += `  esc:${row.escalation}`;
  if (row.usage) line += `  ${formatUsage(row.usage)}`;
  return line;
}

export interface FleetRenderOptions {
  color?: FleetColorize;
  /** Append the key-hint footer (panel chrome; off for the one-shot text fallback). */
  hints?: boolean;
  /**
   * CC5 (workflow design §8.2 / §9.3): pre-rendered lines for external
   * (non-`RunSnapshot`) sections — e.g. a future workflow engine's own
   * fleet rows — spliced in *before* the AGENTS section. Kept as opaque
   * pre-rendered lines rather than a new row shape so this file (and
   * `buildFleetViewModel`, which only ever consumes `RunSnapshot[]`) never
   * has to know what a workflow row looks like.
   */
  extraSections?: readonly FleetSection[];
}
/** CC5: one external section's already-rendered, already-colored lines. */
export interface FleetSection {
  readonly lines: readonly string[];
}

export function renderFleetLines(model: FleetViewModel, opts: FleetRenderOptions = {}): string[] {
  const color: FleetColorize = opts.color ?? ((_tone, text) => text);
  const lines: string[] = [];
  for (const section of opts.extraSections ?? []) lines.push(...section.lines);
  lines.push(color("header", `Subagent fleet — ${model.activeCount} active / ${model.totalCount} total`));
  if (model.rows.length === 0) {
    lines.push(color("muted", "  No subagent runs recorded this session."));
  } else {
    lines.push(
      color(
        "muted",
        `    ${"ID".padEnd(9)}${"TYPE".padEnd(11)}${"STATUS".padEnd(10)}${"PHASE".padEnd(16)}${"ELAPSED".padStart(7)} ${"IDLE".padStart(7)} TOOL`,
      ),
    );
    let terminalStarted = false;
    for (const row of model.rows) {
      if (row.terminal && !terminalStarted) {
        terminalStarted = true;
        lines.push(color("muted", "  recently finished:"));
      }
      const line = `  ${rowLine(row)}`;
      lines.push(row.terminal ? color("muted", line) : color(row.highlight, line));
    }
    const hidden = model.activeCount - model.shownActiveCount;
    if (hidden > 0) lines.push(color("muted", `  … +${hidden} more active run(s) not shown`));
  }
  if (model.usageTotal) lines.push(color("muted", `Usage (all runs): ${formatUsage(model.usageTotal)}`));
  if (opts.hints) lines.push(color("muted", "[q/esc] close  [r] refresh  ! = idle>½budget  ✗ = stopping/overdue"));
  return lines;
}

// ── pi-tui component wrapper ──

export interface FleetPanelDeps {
  query: QueryService;
  /** Called exactly once when the user closes the panel (from ctx.ui.custom's done). */
  done: () => void;
  clock?: Clock;
  /** Interactive-mode Theme for highlight colors; omit in tests for plain output. */
  theme?: Pick<Theme, "fg">;
  /** TUI handle for repainting after timer refreshes. */
  tui?: { requestRender(force?: boolean): void };
  /** Auto-refresh interval. Default 1000ms. */
  refreshMs?: Millis;
  idleBudgetMs?: Millis;
  maxActiveRows?: number;
  recentTerminal?: number;
  typeOf?: (runId: RunId) => string | undefined;
  /** CC5: called fresh on every render so external sections (e.g. a future workflow panel) stay live. */
  extraSections?: () => readonly FleetSection[];
}

/**
 * The live panel component mounted via ctx.ui.custom. Re-pulls
 * QueryService.list() on every refresh tick — the snapshot store is the data
 * source of truth; H1 lifecycle events (when wired) only trigger an early
 * refresh via refresh().
 */
export class FleetPanel {
  private model: FleetViewModel;
  private readonly clock: Clock;
  private timer: TimerHandle | undefined;
  private closed = false;

  constructor(private readonly deps: FleetPanelDeps) {
    this.clock = deps.clock ?? systemClock;
    this.model = this.build();
    const refreshMs = deps.refreshMs ?? 1000;
    const tick = () => {
      if (this.closed) return;
      this.refresh();
      this.timer = this.clock.setTimer(refreshMs, tick);
    };
    this.timer = this.clock.setTimer(refreshMs, tick);
  }

  private build(): FleetViewModel {
    return buildFleetViewModel(this.deps.query.list(), {
      now: this.clock.now(),
      ...(this.deps.idleBudgetMs !== undefined ? { idleBudgetMs: this.deps.idleBudgetMs } : {}),
      ...(this.deps.maxActiveRows !== undefined ? { maxActiveRows: this.deps.maxActiveRows } : {}),
      ...(this.deps.recentTerminal !== undefined ? { recentTerminal: this.deps.recentTerminal } : {}),
      ...(this.deps.typeOf ? { typeOf: this.deps.typeOf } : {}),
    });
  }

  private colorize: FleetColorize = (tone, text) => {
    const theme = this.deps.theme;
    if (!theme) return text;
    switch (tone) {
      case "warn":
        return theme.fg("warning", text);
      case "crit":
        return theme.fg("error", text);
      case "muted":
        return theme.fg("muted", text);
      case "header":
        return theme.fg("accent", text);
      default:
        return text;
    }
  };

  /** Re-pull the snapshot list and request a repaint. Safe to call from H1 lifecycle sinks. */
  refresh(): void {
    if (this.closed) return;
    this.model = this.build();
    this.deps.tui?.requestRender();
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    if (this.timer) this.clock.clearTimer(this.timer);
    this.timer = undefined;
    this.deps.done();
  }

  handleInput(data: string): void {
    if (data === "\x1b" || data === "q" || data === "\x03") {
      this.close();
      return;
    }
    if (data === "r") this.refresh();
  }

  invalidate(): void {
    if (!this.closed) this.model = this.build();
  }

  render(width: number): string[] {
    return renderFleetLines(this.model, {
      color: this.colorize,
      hints: true,
      ...(this.deps.extraSections ? { extraSections: this.deps.extraSections() } : {}),
    }).map((line) => truncateToWidth(line, width));
  }

  dispose(): void {
    this.closed = true;
    if (this.timer) this.clock.clearTimer(this.timer);
    this.timer = undefined;
  }
}
