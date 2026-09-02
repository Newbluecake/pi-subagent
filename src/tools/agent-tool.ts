import { Type, type Static } from "@sinclair/typebox";
import { Text } from "@earendil-works/pi-tui";
import type { ExtensionContext, ToolDefinition } from "@earendil-works/pi-coding-agent";
import type { ErrorInfo, RunId, RunOutcome, RunSnapshot, SpawnRequest } from "../core/types.js";
import type { BoundedWaitResult } from "../service/spawn-service.js";
import { formatDuration, formatModelRef, phaseLabel } from "../ui/fleet-panel.js";
import { parseStrictModelRef } from "../config/model-hint.js";
import { formatWidgetCost } from "../ui/fleet-widget.js";
import { toPiToolUsage } from "./usage.js";

/**
 * Narrow port the Agent tool needs from SpawnService (X3: also the shape the
 * *nested* Agent tool injected into a child session is given — it never
 * gets the full SpawnService, only spawn/spawnAndWait, so it structurally
 * cannot call abort()/waitAll() on unrelated runs).
 */
export interface NestedSpawnPort {
  spawn(req: SpawnRequest): Promise<{ runId: RunId } | { error: ErrorInfo }>;
  spawnAndWait(req: SpawnRequest): Promise<RunOutcome>;
}

/**
 * M-B: read-only progress port for the *top-level* Agent tool's foreground
 * path (live tool-card updates while spawnAndWait would otherwise block
 * silently). Deliberately not handed to nested delegation tools (X3 minimal
 * privilege — same reasoning as NestedSpawnPort above).
 */
export interface ForegroundProgressPort {
  getSnapshot(runId: RunId): RunSnapshot | undefined;
  waitOutcome(runId: RunId, waitMs?: number): Promise<BoundedWaitResult>;
  markAutoBackgrounded?(runId: RunId): void;
}

/** M-B: partial-update / final-result details consumed by renderResult. */
export interface AgentToolDetails {
  runId?: string;
  status?: string;
  turns?: number;
  durationMs?: number;
  background?: boolean;
  autoBackgrounded?: boolean;
  structuredResult?: unknown;
  /** Partial (isPartial) updates: preformatted live progress lines. */
  progress?: string[];
  /** Final result: one-line stats summary (model · turns · tools · cost · duration). */
  summary?: string;
  model?: string;
  toolCounts?: Record<string, number>;
  costUsd?: number;
}

/**
 * M-B: live progress lines for the foreground tool card. Line 1 is a status
 * header (model · phase · turn · elapsed · cost); lines 2..N are the most
 * recent tool calls (✓ done, ✗ failed, ▸ running) with args preview and
 * per-call duration.
 */
export function buildProgressLines(snap: RunSnapshot, now: number, maxTools = 3): string[] {
  const d = snap.diag;
  const header = `⏳ ${[
    formatModelRef(d.model) ?? d.agentType ?? snap.status,
    phaseLabel(snap.phase, d),
    `turn ${d.turns + 1}`,
    formatDuration(Math.max(0, now - d.createdAt)),
    ...(d.usage ? [formatWidgetCost(d.usage.costUsd)] : []),
  ].join(" · ")}`;
  const lines = [header];
  for (const r of (d.toolHistory ?? []).slice(-maxTools)) {
    const mark = r.endedAt === undefined ? "▸" : r.isError ? "✗" : "✓";
    const dur = r.endedAt === undefined ? "running…" : formatDuration(r.endedAt - r.startedAt);
    lines.push(`${mark} ${r.name}${r.argsPreview ? ` ${r.argsPreview}` : ""} (${dur})`);
  }
  // M5: the subagent's own streaming text tail (diag.text accumulates via
  // text_delta) — the "what is it saying right now" line.
  const tail = d.text?.trimEnd().split("\n").filter(Boolean).pop();
  if (tail) {
    const compact = tail.replace(/\s+/g, " ").trim();
    lines.push(`💬 ${compact.length > 76 ? `…${compact.slice(-75)}` : compact}`);
  }
  return lines;
}

/** M-B/M-D: final stats line, e.g. "kimi-k3 · 5 turns · 6 tools (bash×3 read×2 edit) · $0.156 · 1m18s". */
export function formatOutcomeSummary(outcome: RunOutcome): string {
  const d = outcome.diag;
  const parts: string[] = [];
  const model = formatModelRef(d.model);
  if (model) parts.push(model);
  parts.push(`${outcome.turns} turn${outcome.turns === 1 ? "" : "s"}`);
  const counts = Object.entries(d.toolCounts ?? {});
  if (counts.length) {
    const total = counts.reduce((sum, [, n]) => sum + n, 0);
    const breakdown = counts
      .sort((a, b) => b[1] - a[1])
      .map(([name, n]) => (n > 1 ? `${name}×${n}` : name))
      .join(" ");
    parts.push(`${total} tool${total === 1 ? "" : "s"} (${breakdown})`);
  }
  if (outcome.usage) parts.push(formatWidgetCost(outcome.usage.costUsd));
  parts.push(formatDuration(outcome.durationMs));
  return parts.join(" · ");
}

/**
 * "Agent" tool — drop-in replacement for @tintinweb/pi-subagents' Agent tool
 * (see package.json description). Parameter surface intentionally mirrors
 * the fields the original plugin's model-facing contract relies on
 * (description / prompt / subagent_type / model / run_in_background) so
 * existing agent .md files and calling conventions keep working; steering
 * and result retrieval are separate tools (steer_subagent /
 * get_subagent_result) rather than crammed into this one, and supports X2 resume by label or run id.
 */
export const AgentToolParams = Type.Object({
  description: Type.String({ description: "Short (3-5 word) description of the task, shown while it runs." }),
  prompt: Type.String({ description: "The task for the subagent to perform, described in detail." }),
  subagent_type: Type.String({
    description:
      "The type of specialized subagent to use, matching a registered agent type name. " +
      "Registered types are listed in the system prompt under 'Available subagent types' — pass one of those exact names; an unknown name is rejected with a config error.",
  }),
  model: Type.Optional(
    Type.String({
      description:
        "Optional model override: a strict 'provider/id', or a fuzzy hint — bare model id ('kimi-k3') or " +
        "case-insensitive substring alias ('sonnet', 'haiku') — resolved against pi's available models. " +
        "Defaults to the agent type's configured model (frontmatter 'model').",
    }),
  ),
  thinking: Type.Optional(
    Type.Union([Type.Literal("off"), Type.Literal("low"), Type.Literal("medium"), Type.Literal("high")], {
      description:
        "Optional thinking-level override for this run ('off' | 'low' | 'medium' | 'high'). Defaults to the agent type's configured level (frontmatter 'thinking'), or the global defaultThinkingLevel when the type defines none.",
    }),
  ),
  resume: Type.Optional(
    Type.String({
      description:
        "Agent label or run_id of a terminal subagent session (completed, failed, timed_out or aborted) with an existing persisted session to continue.",
    }),
  ),
  isolation: Type.Optional(
    Type.Literal("worktree", {
      description:
        "Run in an isolated git worktree; changes are committed to a pi-agent-<runId> branch afterwards. Requires worktree.enabled in settings.",
    }),
  ),
  timeout_ms: Type.Optional(
    Type.Number({
      description:
        "Optional total wall-clock budget for this run in milliseconds (overrides the default 30min). The run always settles within this budget.",
    }),
  ),
  run_in_background: Type.Optional(
    Type.Boolean({
      description:
        "If true, returns immediately with a run id instead of waiting for completion. Retrieve the result later with get_subagent_result.",
    }),
  ),
  schema: Type.Optional(
    Type.Unknown({
      description:
        "Optional JSON Schema object. When set, the subagent must submit its final result through an injected " +
        "StructuredOutput tool matching this schema; the host independently re-validates the submitted payload " +
        "before the run is considered completed (validated twice — by the injected tool at submission and independently by the host before completion). If the run ends " +
        "without a schema-valid submission it is reported as failed, not completed with free text.",
    }),
  ),
});
export type AgentToolParams = Static<typeof AgentToolParams>;

function parseModel(model?: string): { provider: string; id: string } | undefined {
  return model ? parseStrictModelRef(model) : undefined;
}

export function createAgentTool(deps: {
  spawn: NestedSpawnPort;
  parentRunId?: string;
  /**
   * X3: when set, this factory produces the *nested* delegation tool
   * injected into a child session (service/runtime-adapter.ts, gated by the
   * parent agent type's `canSpawn`). `subagent_type` is rejected outright
   * (never silently clamped) when it is not in this list — the
   * spawn-service-level check (spawn-service.ts) re-validates the same
   * whitelist plus the nesting-depth cap independently, so this check is
   * defense-in-depth, not the sole enforcement point.
   */
  allowedTypes?: readonly string[];
  /** X3: nested runs are always slotless (do not consume the concurrency pool) — forced here so a nested delegation tool can never be constructed without it. */
  forceSlotless?: boolean;
  /** M-B: live foreground progress (top-level tool only; never handed to nested tools). */
  progress?: ForegroundProgressPort;
  autoBackgroundMs?: () => number;
}): ToolDefinition<typeof AgentToolParams> {
  const nestedNote = deps.allowedTypes
    ? ` This is a nested delegation tool: subagent_type is restricted to [${deps.allowedTypes.join(", ")}], every spawned run is slotless (does not consume the concurrency pool), and nesting depth is capped by the host (further attempts beyond the cap are rejected, not silently allowed).`
    : "";
  return {
    name: "Agent",
    label: "Agent",
    description:
      "Launch an autonomous subagent to handle a complex, multi-step task. The subagent runs in its own bounded session " +
      "and cannot hang indefinitely: every run has a total wall-clock budget and always reaches a terminal state " +
      "(completed/failed/timed_out/aborted). A background run pushes a completion notification to you when it " +
      "reaches a terminal state: prefer continuing other work (or ending your turn) and collecting the result " +
      "with get_subagent_result after that notification arrives, rather than blocking with wait: true. Use " +
      "steer_subagent to send a follow-up instruction to a still-running one. A foreground call that exceeds the configured auto-background threshold returns early with a run_id (the run keeps going; you will be notified on completion). abort_subagent stops a running subagent. Set resume to the Agent label or run_id of a terminal run to continue its persisted session. " +
      "Set schema to require a structured (schema-validated) result instead of free text." +
      nestedNote,
    promptSnippet:
      "Agent(description, prompt, subagent_type, model?, thinking?, resume?, schema?, run_in_background?) - spawn or resume a bounded subagent",
    parameters: AgentToolParams,
    /**
     * Without a renderCall the TUI falls back to the bare tool name while a
     * run executes — an Agent card with zero context about *what* is running.
     * Show the label + type (and background/resume markers) like the built-in
     * tools show their key argument (e.g. bash renders `$ <command>`).
     */
    renderCall(args, theme, context) {
      const text = (context.lastComponent as Text | undefined) ?? new Text("", 0, 0);
      const title = theme.fg("toolTitle", theme.bold(`Agent: ${args?.description ?? "…"}`));
      const meta = [
        args?.subagent_type ? `type: ${args.subagent_type}` : undefined,
        args?.model ? `model: ${args.model}` : undefined,
        args?.thinking ? `thinking: ${args.thinking}` : undefined,
        args?.run_in_background ? "background" : undefined,
        args?.resume ? `resume: ${args.resume}` : undefined,
        args?.isolation ? `isolation: ${args.isolation}` : undefined,
      ]
        .filter(Boolean)
        .join(" · ");
      text.setText(meta ? `${title}\n${theme.fg("muted", meta)}` : title);
      return text;
    },
    async execute(_toolCallId, params, signal, onUpdate) {
      if (deps.allowedTypes && !deps.allowedTypes.includes(params.subagent_type)) {
        throw new Error(
          `nested delegation is not permitted: this agent may only spawn [${deps.allowedTypes.join(", ")}], not "${params.subagent_type}"`,
        );
      }
      const modelOverride = parseModel(params.model);
      const baseRequest = {
        type: params.subagent_type,
        prompt: params.prompt,
        label: params.description,
        ...(modelOverride ? { modelOverride } : {}),
        // Non-pair values are fuzzy hints ("sonnet", "kimi-k3") — resolved
        // against pi's available models at spawn admission; unresolvable
        // hints come back as a self-correcting config error.
        ...(!modelOverride && params.model ? { modelHintOverride: params.model } : {}),
        ...(params.thinking ? { thinkingOverride: params.thinking } : {}),
        ...(deps.parentRunId ? { parentRunId: deps.parentRunId } : {}),
        ...(deps.forceSlotless ? { slotless: true } : {}),
        ...(params.resume ? { resumeFrom: params.resume } : {}),
        ...(typeof params.timeout_ms === "number" ? { budgetOverride: { totalMs: params.timeout_ms } } : {}),
        ...(params.isolation ? { isolation: params.isolation } : {}),
        ...(params.schema !== undefined ? { schema: params.schema as Record<string, unknown> } : {}),
      };
      if (params.run_in_background) {
        const spawned = await deps.spawn.spawn({ ...baseRequest, ...(signal ? { signal } : {}) });
        if ("error" in spawned) throw new Error(spawned.error.message);
        return {
          content: [
            {
              type: "text" as const,
              text: `Subagent "${params.description}" started in background (run_id: ${spawned.runId}). You will receive a completion notification when it finishes — do not block or poll for it now; collect the result with get_subagent_result(run_id: "${spawned.runId}") after the notification arrives.`,
            },
          ],
          details: { runId: spawned.runId, background: true },
        };
      }
      const outcome = await (async (): Promise<
        RunOutcome | { content: [{ type: "text"; text: string }]; details: AgentToolDetails }
      > => {
        // M-B: when a progress port is wired (top-level tool), spawn first to
        // learn the runId, stream 1 Hz partial updates from the live snapshot
        // store, and wait for the terminal outcome. Semantically identical to
        // spawnAndWait (same waiter, same abort threading via request.signal)
        // — the only addition is the read-only onUpdate side channel.
        if (deps.progress && onUpdate && !deps.parentRunId) {
          const progress = deps.progress;
          const relay = new AbortController();
          let forwardAbort = true;
          let relayListenerAttached = false;
          const onAbort = () => {
            if (forwardAbort) relay.abort();
          };
          if (signal?.aborted) relay.abort();
          else if (signal) {
            signal.addEventListener("abort", onAbort, { once: true });
            relayListenerAttached = true;
          }
          const stopForwarding = () => {
            forwardAbort = false;
            if (relayListenerAttached) signal!.removeEventListener("abort", onAbort);
          };
          let spawned: { runId: RunId } | { error: ErrorInfo };
          try {
            spawned = await deps.spawn.spawn({ ...baseRequest, expectAck: true, signal: relay.signal });
          } catch (error) {
            stopForwarding();
            throw error;
          }
          if ("error" in spawned) {
            stopForwarding();
            throw new Error(spawned.error.message);
          }
          const push = () => {
            const snap = progress.getSnapshot(spawned.runId);
            if (!snap) return;
            const lines = buildProgressLines(snap, Date.now());
            onUpdate({
              content: [{ type: "text", text: lines.join("\n") }],
              details: { runId: spawned.runId, progress: lines } satisfies AgentToolDetails,
            });
          };
          const timer = setInterval(push, 1000);
          (timer as { unref?: () => void }).unref?.();
          push();
          try {
            const autoMs = deps.autoBackgroundMs?.() ?? 0;
            const waited = await progress.waitOutcome(spawned.runId, autoMs > 0 ? autoMs : undefined);
            if (waited.kind === "pending") {
              progress.markAutoBackgrounded?.(spawned.runId);
              stopForwarding();
              return {
                content: [
                  {
                    type: "text" as const,
                    text: `Subagent "${params.description}" is still running after ${formatDuration(autoMs)} and has been moved to the background (run_id: ${spawned.runId}). The run was NOT stopped — it keeps running under its normal time budget, and you will receive a completion notification when it finishes; collect it then with get_subagent_result(run_id: "${spawned.runId}"). Meanwhile you can use steer_subagent to send a follow-up instruction, or abort_subagent to stop it.`,
                  },
                ],
                details: { runId: spawned.runId, background: true, autoBackgrounded: true },
              };
            }
            stopForwarding();
            return waited.outcome;
          } catch (error) {
            stopForwarding();
            throw error;
          } finally {
            clearInterval(timer);
          }
        }
        return deps.spawn.spawnAndWait({ ...baseRequest, ...(signal ? { signal } : {}) });
      })();
      if ("content" in outcome) return outcome;
      if (outcome.status !== "completed") {
        const reason = outcome.error?.message ?? outcome.timeoutReason ?? outcome.status;
        const tail = outcome.text?.trim();
        const excerpt = tail ? (tail.length > 500 ? `…${tail.slice(-500)}` : tail) : undefined;
        const parts = [
          `Subagent "${params.description}" did not complete successfully: ${reason} (run_id: ${outcome.runId}).`,
        ];
        if (outcome.diag.sessionFile) {
          parts.push(`A persisted session may be resumable — retry with resume: "${outcome.runId}".`);
        } else {
          parts.push("The run failed before a session was created; there is nothing to resume.");
        }
        if (excerpt) parts.push(`Partial output (tail): ${excerpt}`);
        throw new Error(parts.join(" "));
      }
      return {
        content: [
          {
            type: "text" as const,
            text:
              outcome.structuredResult !== undefined
                ? JSON.stringify(outcome.structuredResult)
                : (outcome.text ?? "(subagent completed with no text output)"),
          },
        ],
        // pi usage accounting: the child session's spend rides on this tool
        // result so pi's own totals (footer, /session, RPC) include it.
        ...(outcome.usage ? { usage: toPiToolUsage(outcome.usage) } : {}),
        details: {
          runId: outcome.runId,
          status: outcome.status,
          turns: outcome.turns,
          durationMs: outcome.durationMs,
          // M-B/M-D: presentation stats (renderResult summary line + history replay).
          summary: formatOutcomeSummary(outcome),
          ...(outcome.diag.model ? { model: formatModelRef(outcome.diag.model)! } : {}),
          ...(outcome.diag.toolCounts ? { toolCounts: outcome.diag.toolCounts } : {}),
          ...(outcome.usage ? { costUsd: outcome.usage.costUsd } : {}),
          ...(outcome.structuredResult !== undefined ? { structuredResult: outcome.structuredResult } : {}),
        } satisfies AgentToolDetails,
      };
    },
    /**
     * M-B: renders both partial (streaming) updates and the final result.
     *  - partial: the live progress lines (⏳ header + recent tool trail),
     *    tone-mapped per mark (✗ error / ▸ accent / ✓ muted);
     *  - final: a muted stats summary line, then the result text (collapsed
     *    to a handful of lines unless the entry is expanded).
     */
    renderResult(result, options, theme, context) {
      const text = (context.lastComponent as Text | undefined) ?? new Text("", 0, 0);
      const details = (result.details ?? {}) as AgentToolDetails;
      const body = result.content
        .map((c) => (c.type === "text" ? c.text : ""))
        .filter(Boolean)
        .join("\n");
      if (options.isPartial && details.progress) {
        const rendered = details.progress
          .map((line) => {
            if (line.startsWith("✗")) return theme.fg("error", line);
            if (line.startsWith("▸")) return theme.fg("accent", line);
            if (line.startsWith("✓")) return theme.fg("muted", line);
            return line;
          })
          .join("\n");
        text.setText(rendered);
        return text;
      }
      const parts: string[] = [];
      if (details.summary) parts.push(theme.fg("muted", `✓ ${details.summary}`));
      if (body) {
        const lines = body.split("\n");
        const cap = 6;
        if (!options.expanded && lines.length > cap) {
          parts.push(lines.slice(0, cap).join("\n"));
          parts.push(theme.fg("muted", `… +${lines.length - cap} more lines`));
        } else {
          parts.push(body);
        }
      }
      text.setText(parts.join("\n"));
      return text;
    },
  } satisfies ToolDefinition<typeof AgentToolParams>;
}
export type { ExtensionContext };
