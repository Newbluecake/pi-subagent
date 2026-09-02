import { randomUUID } from "node:crypto";
import { Type, type Static } from "@sinclair/typebox";
import { Text } from "@earendil-works/pi-tui";
import type { ToolDefinition } from "@earendil-works/pi-coding-agent";
import { systemClock } from "../core/clock.js";
import { withDeadline } from "../core/deadline.js";
import type { Orchestrator, OrchestratorRunRequest } from "../workflow/orchestrator.js";
import type { WorkflowActivityRegistry, WorkflowActivitySnapshot } from "../workflow/activity.js";
import type { WorkflowId, WorkflowOutcome, WorkflowRunBudget } from "../workflow/types.js";
import type { RunSnapshot, UsageDelta } from "../core/types.js";
import { buildProgressLines } from "./agent-tool.js";
import { formatDuration } from "../ui/fleet-panel.js";
import { formatWidgetCost } from "../ui/fleet-widget.js";
import { toPiToolUsage } from "./usage.js";

/**
 * M3.6 (workflow design \u00a75.1/\u00a74.3/\u00a74.3.2): the `SubagentWorkflow` tool \u2014
 * the model-facing entry point into the engine `src/workflow/**` has built
 * up through M3.1\u2013M3.5 (isolation shell, host calls, abort propagation,
 * script API, journal/replay). This file is the *only* place `toolCallMs`/
 * `settlementGraceMs` (WT13/WT17) are enforced \u2014 `Orchestrator.run()` itself
 * has no notion of a tool-call deadline, it only knows its own
 * `budget.workflowTotalMs`.
 *
 * Narrow port (mirrors `agent-tool.ts`'s `NestedSpawnPort`): this file has
 * zero imports from `src/stack.ts` / `src/service/**`, only from
 * `src/workflow/**`'s own public types \u2014 `index.ts` is the only place that
 * has to know both this tool's shape and `Stack`'s.
 */
export interface WorkflowToolDeps {
  readonly defaultBudget: WorkflowRunBudget;
  readonly activity: WorkflowActivityRegistry;
  createOrchestrator(workflowId: WorkflowId): Orchestrator;
  /** M8: resolve a live child run's lifetime usage so the workflow tool result can carry the aggregate spend (pi usage accounting). */
  usageOf?(runId: string): UsageDelta | undefined;
  /**
   * M10: live per-run snapshots (the same `QueryService.get` the Agent
   * tool's M-B progress port reads) — powers the tool card's per-child live
   * rows while `run()` is still blocking. Optional: without it the card
   * degrades to workflow-level progress (name/phase/elapsed + child labels
   * from the activity registry), never to a blank card.
   */
  snapshotOf?(runId: string): RunSnapshot | undefined;
}

/** M10: partial-update / final-result details consumed by renderResult (mirrors agent-tool.ts's `AgentToolDetails`). */
export interface WorkflowToolDetails {
  workflowId?: string;
  status?: string;
  durationMs?: number;
  /** Partial (isPartial) updates: preformatted live progress lines. */
  progress?: string[];
  /** Final result: one-line stats summary (status · duration · children tally · cost). */
  summary?: string;
  costUsd?: number;
  children?: WorkflowOutcome["children"];
  runIds?: string[];
  replay?: WorkflowOutcome["replay"];
}

/**
 * \u00a74.3.2 WT17: how long the tool waits for `settled()` (\u2461) after it has
 * already given up on `run()` itself settling within `toolCallMs -
 * settlementGraceMs` and fired an (un-awaited, TL6) `stop()`. Design default.
 */
const SETTLEMENT_GRACE_MS = 3_000;
/** \u00a74.1 WT8's own tick granularity \u2014 folded into the `toolCallMs` upper-bound演算 (\u00a74.3.1) alongside the abort/terminate/reconcile windows the budget itself may leave unset. */
const TICK_MS = 250;

export const WorkflowToolParams = Type.Object({
  script: Type.String({
    description:
      "The workflow script source. Must start with `export const meta = { name, description }` (a plain object " +
      "literal). The sandboxed script body may call agent(prompt, opts?), parallel(thunks), pipeline(items, " +
      "...stages), phase(title), log(message), and read the top-level `args`/`budget` globals; it may not use " +
      "Date.now()/Math.random()/eval (all disabled \u2014 they would silently break replay). Max 512 KiB.",
  }),
  args: Type.Optional(
    Type.Unknown({ description: "JSON-shaped value surfaced to the script as its top-level `args` global." }),
  ),
  journal: Type.Optional(
    Type.String({
      description:
        "Journal namespace for replay/caching across runs. Omit to disable both replay and journal writes " +
        "(every agent() call runs live, nothing is recorded).",
    }),
  ),
  noReplay: Type.Optional(
    Type.Boolean({
      description: "Force every agent() call live even if a journal is configured; journal writes still happen.",
    }),
  ),
  replayScope: Type.Optional(
    Type.Union([Type.Literal("chain"), Type.Literal("content")], {
      description:
        'Replay lookup-key scope. "chain" (default) only reuses a result when every prior call in submission ' +
        'order also still matches (safe against implicit filesystem causality between sibling calls). "content" ' +
        "matches each call independently \u2014 higher hit rate, but can reuse a result even when an earlier sibling " +
        "call changed the workspace the prompt implicitly depends on. A WARN is logged whenever content scope is used.",
    }),
  ),
  timeout_ms: Type.Optional(
    Type.Number({
      description: "Total wall-clock budget for the whole workflow run, in milliseconds (overrides the default).",
    }),
  ),
});
export type WorkflowToolParams = Static<typeof WorkflowToolParams>;

function computeToolCallMs(budget: WorkflowRunBudget): number {
  // \u00a74.3.1: toolCallMs := workflowTotalMs + tickMs + abortGraceMs + terminateConfirmMs + reconcileMs + settlementGraceMs
  return (
    budget.workflowTotalMs +
    TICK_MS +
    (budget.abortGraceMs ?? 10_000) +
    budget.terminateConfirmMs +
    (budget.reconcileMs ?? 1_000) +
    SETTLEMENT_GRACE_MS
  );
}

function mergeBudget(base: WorkflowRunBudget, timeoutMs?: number): WorkflowRunBudget {
  if (timeoutMs === undefined) return base;
  return { ...base, workflowTotalMs: Math.max(0, timeoutMs) };
}

function scriptDisplayName(script: string): string {
  const m = /export\s+const\s+meta\s*=\s*\{[^}]*name\s*:\s*["'`]([^"'`]+)["'`]/.exec(script);
  return m?.[1] ?? "(unnamed workflow)";
}

/** M10: at most this many per-child live rows on the tool card; the rest collapse into a "+N more" line. */
const MAX_PROGRESS_CHILD_ROWS = 6;
/** M10: how many recently-settled children the card's ✓/✗ trail shows. */
const MAX_SETTLED_TRAIL = 3;

function settledMark(status: string, source: "live" | "replay"): string {
  if (status === "completed") return source === "replay" ? "\u21a9" : "\u2713"; // ↩ replay hit, ✓ live
  if (status === "withheld") return "\u2298"; // ⊘ never ran (admission/budget)
  return "\u2717"; // ✗
}

/**
 * M10: live progress lines for the blocking workflow tool card — the
 * workflow-level counterpart of agent-tool.ts's `buildProgressLines`.
 * Line 1 is a status header (name · phase · elapsed · budget left); line 2
 * is a settled/running tally; then one live row per active child (the
 * child's own M-B progress lines, re-prefixed with its label), falling back
 * to a plain "spawned … ago" row while the child's session snapshot has not
 * landed in the query service yet.
 */
export function buildWorkflowProgressLines(
  activity: WorkflowActivitySnapshot,
  now: number,
  snapshotOf?: (runId: string) => RunSnapshot | undefined,
): string[] {
  const header = [
    `\u23f3 ${activity.name}`,
    activity.currentPhaseId !== undefined ? `phase: ${activity.currentPhaseId}` : undefined,
    formatDuration(Math.max(0, now - activity.startedAt)),
    activity.deadlineAt !== undefined ? `${formatDuration(Math.max(0, activity.deadlineAt - now))} left` : undefined,
  ]
    .filter(Boolean)
    .join(" · ");
  const lines = [header];

  const failed = activity.settledTotal - activity.completedTotal;
  const tally = [
    activity.settledTotal > 0
      ? `\u2713 ${activity.completedTotal}${activity.replayTotal > 0 ? ` (${activity.replayTotal} replay)` : ""}`
      : undefined,
    failed > 0 ? `\u2717 ${failed}` : undefined,
    activity.activeChildren.length > 0 ? `\u25b8 ${activity.activeChildren.length} running` : undefined,
  ]
    .filter(Boolean)
    .join(" · ");
  if (tally) lines.push(tally);

  const recent = activity.settledChildren.slice(-MAX_SETTLED_TRAIL);
  if (recent.length > 0) {
    lines.push(
      recent
        .map((c) => `${settledMark(c.status, c.source)} ${c.label ?? c.callId} (${formatDuration(c.durationMs)})`)
        .join(" · "),
    );
  }

  const shown = activity.activeChildren.slice(0, MAX_PROGRESS_CHILD_ROWS);
  for (const child of shown) {
    const name = child.label ?? child.callId;
    const snap = child.runId !== undefined ? snapshotOf?.(child.runId) : undefined;
    if (!snap) {
      lines.push(`\u25b8 ${name} · spawned ${formatDuration(Math.max(0, now - child.enteredAt))} ago`);
      continue;
    }
    const childLines = buildProgressLines(snap, now, 1);
    const first = childLines[0] ?? "";
    childLines[0] = `\u25b8 ${name} · ${first.replace(/^\u23f3 /, "")}`;
    lines.push(...childLines);
  }
  const hidden = activity.activeChildren.length - shown.length;
  if (hidden > 0) lines.push(`\u2026 +${hidden} more running`);
  return lines;
}

/** M10: final stats line, e.g. "completed · 2m10s · 5 children (\u27133 \u21a91 \u27171) · $0.42". */
export function formatWorkflowSummary(outcome: WorkflowOutcome, totalUsage?: UsageDelta): string {
  const parts: string[] = [outcome.status, formatDuration(outcome.durationMs)];
  if (outcome.children.length > 0) {
    const completed = outcome.children.filter((c) => c.status === "completed").length;
    const replay = outcome.children.filter((c) => c.source === "replay").length;
    const failed = outcome.children.length - completed;
    const tally = [
      completed > 0 ? `\u2713${completed}` : undefined,
      replay > 0 ? `\u21a9${replay}` : undefined,
      failed > 0 ? `\u2717${failed}` : undefined,
    ]
      .filter(Boolean)
      .join(" ");
    parts.push(`${outcome.children.length} children${tally ? ` (${tally})` : ""}`);
  }
  if (totalUsage) parts.push(formatWidgetCost(totalUsage.costUsd));
  return parts.join(" · ");
}

const MAX_CHILD_PREVIEW = 2_048;
const MAX_TOTAL_PREVIEW = 32_768;

function renderChildren(children: WorkflowOutcome["children"]): string {
  let budget = MAX_TOTAL_PREVIEW;
  const lines: string[] = [];
  for (const c of children) {
    const preview = c.textPreview ? c.textPreview.slice(0, MAX_CHILD_PREVIEW) : "";
    let line = `  - [${c.status}${c.source === "replay" ? "/replay" : ""}] ${c.label ?? c.callId}${preview ? `: ${preview}` : ""}`;
    if (line.length > budget) {
      line = `${line.slice(0, Math.max(0, budget))}\u2026(truncated, see get_subagent_result for the full run)`;
    }
    lines.push(line);
    budget -= line.length;
    if (budget <= 0) {
      lines.push("  \u2026(further child output truncated)");
      break;
    }
  }
  return lines.join("\n");
}

function renderOutcomeText(outcome: WorkflowOutcome): string {
  const parts: string[] = [];
  if (outcome.diag.degraded === "settlement_timeout") {
    parts.push(
      "WARNING: the tool's own settlement grace window elapsed before the orchestrator confirmed a fully " +
        "reconciled outcome. The status/children below are a best-effort snapshot (pendingReconcile may still be " +
        "true) and MUST NOT be treated as a confirmed final state \u2014 some children may still be `running`/`stopping`.",
    );
  }
  parts.push(`workflow ${outcome.workflowId}: ${outcome.status}${outcome.stopCause ? ` (${outcome.stopCause})` : ""}`);
  if (outcome.result !== undefined) {
    parts.push(`result: ${typeof outcome.result === "string" ? outcome.result : JSON.stringify(outcome.result)}`);
  }
  if (outcome.error) parts.push(`error: ${outcome.error.message}`);
  if (outcome.children.length)
    parts.push(`children (${outcome.children.length}):\n${renderChildren(outcome.children)}`);
  if (outcome.orphanChildren?.length) parts.push(`orphaned children: ${outcome.orphanChildren.length} (see diag)`);
  if (outcome.replay) {
    parts.push(
      `replay: ${outcome.replay.hits} hit, ${outcome.replay.misses} miss, ${outcome.replay.skipped} skipped, ${outcome.replay.corruptLines} corrupt`,
    );
  }
  return parts.join("\n");
}

/**
 * \u00a74.3.2's exact WT13/WT17 sequence, reproduced here (not delegated to
 * `Orchestrator` \u2014 it has no notion of a tool-call deadline):
 *   1. race `run()` against `toolCallMs - settlementGraceMs`
 *   2. on timeout: fire-and-forget (TL6: never `await`) an idempotent `stop()`
 *   3. race `settled()` against `settlementGraceMs`
 *   4. on *that* timeout: fall back to `outcomeAt1()` (or a bare skeleton if
 *      even that is gone), explicitly marked `degraded:"settlement_timeout"`
 *      \u2014 never rendered as if it were a confirmed terminal outcome (\u00a74.3.1.1).
 */
async function runWithBoundedToolCall(
  orchestrator: Orchestrator,
  req: OrchestratorRunRequest,
  toolCallMs: number,
): Promise<WorkflowOutcome> {
  const first = await withDeadline(
    orchestrator.run(req),
    Math.max(0, toolCallMs - SETTLEMENT_GRACE_MS),
    systemClock,
    "workflow_tool_run",
  );
  if (first.ok) return first.value;
  void orchestrator.stop(req.workflowId, "timeout"); // TL6: not awaited \u2014 settled() below carries the wait.
  const second = await withDeadline(
    orchestrator.settled(req.workflowId),
    SETTLEMENT_GRACE_MS,
    systemClock,
    "workflow_tool_settle",
  );
  if (second.ok) return second.value;
  const skeleton = orchestrator.outcomeAt1(req.workflowId);
  if (skeleton) return { ...skeleton, diag: { ...skeleton.diag, degraded: "settlement_timeout" } };
  // EI5 also failed to leave a snapshot behind \u2014 the tool still returns
  // (GW1b's promise never hangs), just with the barest honest skeleton.
  return {
    workflowId: req.workflowId,
    status: "timed_out",
    pendingReconcile: true,
    timeoutReason: "workflow_total",
    durationMs: toolCallMs,
    children: [],
    diag: {
      createdAt: systemClock.now(),
      heartbeat: { seq: 0, observedAt: systemClock.now(), stalledMs: 0 },
      logLines: 0,
      degraded: "settlement_timeout",
    },
  };
}

/**
 * "SubagentWorkflow" \u2014 M3.6's model-facing entry point.
 *
 * Honest capability declaration (\u00a75.3 compat matrix, \u00a71.2 non-goals):
 *  - NW3: no pause/step/skip/retry from the calling model. The only control
 *    surface once a run has started is the tool call's own cancellation
 *    (Esc/`signal`), which stops the *whole* run.
 *  - NW5: `workflow(nameOrRef)` (nested workflow calls) is not implemented;
 *    a script that calls it gets a clear rejection, not a silent no-op.
 *  - \u00a75.5: unlike the upstream plugin (which returns a task id immediately
 *    and runs in the background), this call BLOCKS until the workflow
 *    reaches a terminal state (bounded by its own timeout_ms plus a fixed
 *    grace window) \u2014 a long workflow occupies this tool call for its
 *    whole duration.
 */
export function createWorkflowTool(deps: WorkflowToolDeps): ToolDefinition<typeof WorkflowToolParams> {
  return {
    name: "SubagentWorkflow",
    label: "Subagent Workflow",
    description:
      "Run a multi-agent orchestration script: a sandboxed JS program that calls agent(prompt, opts?) (and " +
      "parallel()/pipeline()/phase()/log()) to coordinate several bounded subagent runs, with its own absolute " +
      "wall-clock budget, deadline-capped children, and (optionally) cross-run result caching via a journal. " +
      "Every run reaches a terminal state (completed/failed/timed_out/aborted) \u2014 it never hangs. " +
      "Differences from a general multi-agent orchestrator you may have used before: (1) this call BLOCKS until " +
      "the workflow finishes (no background task-id + notification model); (2) there is no pause/step/skip/retry " +
      "control once started \u2014 only stop; (3) nested workflow(...) calls are not supported (inline the referenced " +
      "logic directly). Use this only when a single Agent call's own multi-step reasoning is not enough and you " +
      "specifically need several independently-prompted subagents coordinated by real control flow.",
    promptSnippet:
      "SubagentWorkflow(script, args?, journal?, noReplay?, replayScope?, timeout_ms?) - run a multi-agent orchestration script",
    parameters: WorkflowToolParams,
    /**
     * M10: without a renderCall the TUI falls back to the bare tool name for
     * what is typically the longest-blocking call in the toolbox. Show the
     * workflow's declared name + the knobs that matter (journal / timeout),
     * like the Agent card shows its description.
     */
    renderCall(args, theme, context) {
      const text = (context.lastComponent as Text | undefined) ?? new Text("", 0, 0);
      const name = typeof args?.script === "string" ? scriptDisplayName(args.script) : "…";
      const title = theme.fg("toolTitle", theme.bold(`Subagent Workflow: ${name}`));
      const meta = [
        args?.journal ? `journal: ${args.journal}` : undefined,
        args?.replayScope ? `replay: ${args.replayScope}` : undefined,
        args?.noReplay ? "no-replay" : undefined,
        typeof args?.timeout_ms === "number" ? `timeout: ${formatDuration(args.timeout_ms)}` : undefined,
      ]
        .filter(Boolean)
        .join(" · ");
      text.setText(meta ? `${title}\n${theme.fg("muted", meta)}` : title);
      return text;
    },
    async execute(_toolCallId, params, signal, onUpdate) {
      // \u00a75.1 rule 1: check signal?.aborted before anything else \u2014 never boot a worker for an already-cancelled call.
      if (signal?.aborted) {
        return {
          content: [{ type: "text" as const, text: "workflow run aborted before starting (signal already aborted)." }],
          details: { status: "aborted" as const },
        };
      }
      const workflowId: WorkflowId = `wf_${randomUUID().replace(/-/g, "").slice(0, 20)}`;
      const budget = mergeBudget(deps.defaultBudget, params.timeout_ms);
      const toolCallMs = computeToolCallMs(budget);
      const startedAt = systemClock.now();
      deps.activity.register(
        workflowId,
        scriptDisplayName(params.script),
        startedAt,
        startedAt + budget.workflowTotalMs,
      );
      const orchestrator = deps.createOrchestrator(workflowId);
      // M10: live tool-card progress while `run()` blocks — the same 1 Hz
      // read-only onUpdate side channel the Agent tool's M-B path uses
      // (read: activity registry + per-child run snapshots; it never touches
      // engine state, and the timer is unref'd so it cannot wedge `pi -p`).
      let progressTimer: ReturnType<typeof setInterval> | undefined;
      if (onUpdate) {
        const push = () => {
          const snap = deps.activity.list().find((w) => w.workflowId === workflowId);
          if (!snap) return;
          const lines = buildWorkflowProgressLines(snap, systemClock.now(), deps.snapshotOf);
          onUpdate({
            content: [{ type: "text" as const, text: lines.join("\n") }],
            details: { workflowId, progress: lines } satisfies WorkflowToolDetails,
          });
        };
        progressTimer = setInterval(push, 1000);
        (progressTimer as { unref?: () => void }).unref?.();
        push();
      }
      try {
        const req: OrchestratorRunRequest = {
          workflowId,
          script: params.script,
          budget,
          ...(params.args !== undefined ? { args: params.args } : {}),
          ...(params.journal !== undefined ? { journal: params.journal } : {}),
          ...(params.noReplay !== undefined ? { noReplay: params.noReplay } : {}),
          ...(params.replayScope !== undefined ? { replayScope: params.replayScope } : {}),
          ...(signal ? { signal } : {}),
        };
        const outcome = await runWithBoundedToolCall(orchestrator, req, toolCallMs);
        if (outcome.status !== "completed") {
          const reason = outcome.error?.message ?? outcome.timeoutReason ?? outcome.stopCause ?? outcome.status;
          throw new Error(
            `workflow "${workflowId}" did not complete successfully: ${reason}\n${renderOutcomeText(outcome)}`,
          );
        }
        // M8: aggregate the LIVE children's spend onto this tool result (pi
        // usage accounting — same mechanism as the Agent tool). Replay hits
        // cost nothing and carry no fresh runId; withheld/running children
        // without a runId contribute nothing. runIds ride along in details so
        // an external HUD (pi-hud) can dedupe its event-reported live costs.
        const liveRunIds = outcome.children
          .filter((c) => c.source === "live" && c.runId !== undefined)
          .map((c) => c.runId!);
        const childUsages = deps.usageOf ? liveRunIds.map((id) => deps.usageOf!(id)).filter(Boolean) : [];
        const totalUsage = (childUsages as UsageDelta[]).reduce<UsageDelta | undefined>(
          (acc, u) =>
            acc
              ? {
                  input: acc.input + u.input,
                  output: acc.output + u.output,
                  cacheRead: acc.cacheRead + u.cacheRead,
                  cacheWrite: acc.cacheWrite + u.cacheWrite,
                  costUsd: acc.costUsd + u.costUsd,
                }
              : u,
          undefined,
        );
        return {
          content: [{ type: "text" as const, text: renderOutcomeText(outcome) }],
          ...(totalUsage ? { usage: toPiToolUsage(totalUsage) } : {}),
          details: {
            workflowId: outcome.workflowId,
            status: outcome.status,
            durationMs: outcome.durationMs,
            // M10: presentation stats (renderResult summary line + history replay).
            summary: formatWorkflowSummary(outcome, totalUsage),
            ...(totalUsage ? { costUsd: totalUsage.costUsd } : {}),
            children: outcome.children,
            runIds: liveRunIds,
            ...(outcome.replay ? { replay: outcome.replay } : {}),
          } satisfies WorkflowToolDetails,
        };
      } finally {
        if (progressTimer !== undefined) clearInterval(progressTimer);
        deps.activity.unregister(workflowId);
      }
    },
    /**
     * M10: renders both partial (streaming) updates and the final result —
     * same contract as the Agent tool's renderResult:
     *  - partial: the live progress lines (⏳ header + tally + per-child
     *    rows), tone-mapped per mark (✗ error / ▸ accent / ✓·↩·⊘ muted);
     *  - final: a muted stats summary line, then the outcome text (collapsed
     *    to a handful of lines unless the entry is expanded).
     */
    renderResult(result, options, theme, context) {
      const text = (context.lastComponent as Text | undefined) ?? new Text("", 0, 0);
      const details = (result.details ?? {}) as WorkflowToolDetails;
      const body = result.content
        .map((c) => (c.type === "text" ? c.text : ""))
        .filter(Boolean)
        .join("\n");
      if (options.isPartial && details.progress) {
        const rendered = details.progress
          .map((line) => {
            const t = line.trimStart();
            if (t.startsWith("\u2717")) return theme.fg("error", line);
            if (t.startsWith("\u25b8")) return theme.fg("accent", line);
            if (t.startsWith("\u2713") || t.startsWith("\u21a9") || t.startsWith("\u2298"))
              return theme.fg("muted", line);
            return line;
          })
          .join("\n");
        text.setText(rendered);
        return text;
      }
      const parts: string[] = [];
      if (details.summary) parts.push(theme.fg("muted", `\u2713 ${details.summary}`));
      if (body) {
        const lines = body.split("\n");
        const cap = 6;
        if (!options.expanded && lines.length > cap) {
          parts.push(lines.slice(0, cap).join("\n"));
          parts.push(theme.fg("muted", `\u2026 +${lines.length - cap} more lines`));
        } else {
          parts.push(body);
        }
      }
      text.setText(parts.join("\n"));
      return text;
    },
  } satisfies ToolDefinition<typeof WorkflowToolParams>;
}

/** M3.6 \u00a711 hand-off: registered instead of the real tool when `settings.workflow.enabled` is false (index.ts) \u2014 gives the model (and a curious user reading tool descriptions) a clear, honest reason rather than the tool silently not existing. Mirrors index.ts's existing `compat.ok===false` "Agent (unavailable)" stub. */
export function createDisabledWorkflowToolStub(): ToolDefinition<typeof WorkflowToolParams> {
  return {
    name: "SubagentWorkflow",
    label: "Subagent Workflow (disabled)",
    description:
      "Multi-agent orchestration scripts are disabled on this instance (settings.workflow.enabled is false). " +
      "Use the Agent tool for single-subagent delegation instead.",
    parameters: WorkflowToolParams,
    async execute() {
      throw new Error("SubagentWorkflow is disabled (settings.workflow.enabled is false)");
    },
  } satisfies ToolDefinition<typeof WorkflowToolParams>;
}
