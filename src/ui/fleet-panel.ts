import type { Millis, RunDiagnostics, RunId, RunPhase, RunSnapshot, RunStatus, UsageDelta } from "../core/types.js";

/**
 * Fleet view-model (X7 origin): pure functions turning RunSnapshot lists into
 * display rows — highlight levels, tool trails, durations, usage sums. No pi
 * imports, no I/O, fully unit-testable. Consumed by the agent-tree widget
 * (fleet-widget.ts) and the /agent status command.
 *
 * History: the `/agent fleet` full-screen overlay panel (FleetPanel +
 * renderFleetLines) lived here until it was removed — the always-on widget
 * above the editor plus `/agent status <runId>` / `/agent costs` cover every
 * use it had, with none of the modal-overlay interaction cost.
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
  /** M-C: compact recent-tool trail from diag.toolHistory, e.g. "bash×3→read ▸edit · 3s" — the in-flight ▸ segment carries its live duration when the view is built with `now`. */
  toolTrail: string | undefined;
  /** Live one-line stream of the model's in-progress thinking (last non-empty
   *  line of diag.text), only while the run is actually in a model turn — the
   *  "思考过程" line in the agent tree. Truncated; full text stays in diag. */
  streamLine: string | undefined;
  /** M-C: parent link for tree grouping in the widget (undefined = top-level). */
  parentRunId: RunId | undefined;
  /** M11: human-friendly phase label (🧠思考 / 🔧工具 / ♻重试2/3 …) for presentation surfaces. */
  phaseLabel: string;
  status: RunStatus;
  phase: RunPhase;
  /** Total run age: now - diag.createdAt, clamped ≥ 0. Used for sorting and terminal rows. */
  elapsedMs: Millis;
  /** Current-phase age: now - diag.phaseEnteredAt, clamped ≥ 0. Active rows display this
   *  next to the phase label, so 🧠思考 shows how long THIS model turn has been running
   *  (resets on every phase transition) instead of the run's cumulative age. */
  phaseMs: Millis;
  /** now - (diag.lastEventAt ?? diag.phaseEnteredAt), clamped ≥ 0 — the hang signal. */
  idleMs: Millis;
  currentTool: string | undefined;
  /** In-flight tool call's age (now - diag.currentTool.startedAt); undefined for terminal runs / no tool in flight. */
  currentToolMs: Millis | undefined;
  /** e.g. "L2✓→L3✗"; undefined when no escalation has happened. */
  escalation: string | undefined;
  maxEscalation: EscalationLevel | undefined;
  usage: UsageDelta | undefined;
  /** X3 nested run (spawned with parentRunId). */
  nested: boolean;
  terminal: boolean;
  /** M6: for terminal rows, how long ago the run settled (now - updatedAt); undefined for active rows. */
  settledAgoMs: Millis | undefined;
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

/** M12: canonical display form for a model reference — always `provider/id` (the id alone is ambiguous: the same model is often served by several providers with different pricing/quota). */
export function formatModelRef(model: { provider: string; id: string } | undefined): string | undefined {
  return model ? `${model.provider}/${model.id}` : undefined;
}

/**
 * M11: human-friendly phase label for the presentation surfaces (tree rows,
 * foreground card). Diagnostic surfaces (/agent status) keep the raw
 * RunPhase. retry shows its attempt counter when known.
 */
export function phaseLabel(phase: RunPhase, diag?: Pick<RunDiagnostics, "retry">): string {
  switch (phase) {
    case "queue_wait":
      return "⏸排队";
    case "resolve_config":
    case "session_create":
    case "extension_bind":
      return "⚡启动";
    case "prompt_dispatch":
    case "model_turn":
      return "🧠思考";
    case "tool_exec":
      return "🔧工具";
    case "retry_backoff":
      return diag?.retry ? `♻重试${diag.retry.attempt}/${diag.retry.maxAttempts}` : "♻重试";
    case "compaction":
      return "🗜压缩";
    case "abort_grace":
    case "reap":
      return "⏹停止中";
    case "settled":
      return "已结束";
  }
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
 * Last non-empty line of the run's streamed text, whitespace-collapsed and
 * truncated — the agent tree's one-line "thinking" preview. The accumulated
 * diag.text can be many lines; only the freshest line is signal.
 */
export function lastTextLine(text: string | undefined, max = 60): string | undefined {
  if (!text) return undefined;
  const lines = text.split("\n");
  for (let i = lines.length - 1; i >= 0; i--) {
    const line = lines[i]!.replace(/\s+/g, " ").trim();
    if (line) return line.length > max ? `${line.slice(0, max - 1)}…` : line;
  }
  return undefined;
}

/**
 * M-C: compact trail of a run's recent tool calls for the agent-tree widget
 * and the Agent tool card. Adjacent completed calls of the same tool collapse
 * into `name×k` (failed ones render `name✗`), only the last `maxTokens`
 * tokens are kept, and an in-flight call is appended as `▸name` (with a
 * truncated args preview when known — the tool phase's one-line "中间过程").
 * When `now` is given, the in-flight segment also carries its live duration
 * (`▸bash npm test · 3s`) so the tool call's timing is visible next to the
 * model-turn timing on the main row; pass undefined for terminal runs so a
 * killed mid-tool call doesn't keep aging.
 */
export function toolTrailOf(
  diag: Pick<RunDiagnostics, "toolHistory">,
  maxTokens = 4,
  now?: Millis,
): string | undefined {
  const history = diag.toolHistory;
  if (!history?.length) return undefined;
  const tokens: Array<{ key: string; name: string; failed: boolean; count: number }> = [];
  let running: string | undefined;
  for (const r of history) {
    if (r.endedAt === undefined) {
      // keep the latest in-flight call, with an args preview when present.
      // 60 chars: long enough to identify the file in `edit/write <path>` or the
      // command in `bash <cmd>` — the preview's whole point — without wrapping.
      const preview = r.argsPreview
        ? r.argsPreview.length > 60
          ? `${r.argsPreview.slice(0, 59)}…`
          : r.argsPreview
        : undefined;
      const base = preview ? `${r.name} ${preview}` : r.name;
      running = now === undefined ? base : `${base} · ${formatDuration(Math.max(0, now - r.startedAt))}`;
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
    model: formatModelRef(snapshot.diag.model),
    // Terminal rows freeze the trail (no live duration): a run killed mid-tool
    // would otherwise show an ever-growing ▸ duration.
    toolTrail: toolTrailOf(snapshot.diag, 4, terminal ? undefined : opts.now),
    // The `»` preview prefers the live thinking stream; state-machine clears
    // thinkingText the moment the turn's answer text starts streaming, so
    // the fallback to diag.text covers the answer phase of the same turn.
    streamLine:
      !isTerminalStatus(snapshot.status) && snapshot.phase === "model_turn"
        ? (lastTextLine(snapshot.diag.thinkingText) ?? lastTextLine(snapshot.diag.text))
        : undefined,
    parentRunId: snapshot.parentRunId,
    phaseLabel: phaseLabel(snapshot.phase, snapshot.diag),
    status: snapshot.status,
    phase: snapshot.phase,
    elapsedMs: Math.max(0, opts.now - snapshot.diag.createdAt),
    phaseMs: Math.max(0, opts.now - snapshot.diag.phaseEnteredAt),
    idleMs: idleOf(snapshot, opts.now),
    currentTool: terminal ? undefined : snapshot.diag.currentTool?.name,
    currentToolMs:
      terminal || snapshot.diag.currentTool === undefined
        ? undefined
        : Math.max(0, opts.now - snapshot.diag.currentTool.startedAt),
    escalation: esc.text,
    maxEscalation: esc.max,
    usage: snapshot.diag.usage,
    nested: snapshot.parentRunId !== undefined,
    terminal,
    settledAgoMs: terminal ? Math.max(0, opts.now - snapshot.updatedAt) : undefined,
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
