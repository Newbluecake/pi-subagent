import { Type, type Static } from "@sinclair/typebox";
import { Text } from "@earendil-works/pi-tui";
import type { ExtensionContext, ToolDefinition } from "@earendil-works/pi-coding-agent";

/**
 * "compact_context" — lets the MODEL proactively trigger context compaction
 * (equivalent to `/compact`) instead of waiting for the automatic threshold
 * or a manual user command.
 *
 * Registered only in the host session (src/index.ts registers it after the
 * HOST_KEY host-claim guard, and child subagent sessions stay inert), so
 * subagents never see this tool — their bounded runs rely on pi's automatic
 * threshold compaction.
 *
 * Mechanics (why the code looks the way it does):
 * - `ctx.compact()` aborts the current agent run first, then compacts with
 *   reason "manual", and never retries/resumes the aborted turn.
 * - `agent.abort()` runs synchronously inside `ctx.compact()`, so execute()
 *   MUST return immediately; awaiting compaction completion inside execute()
 *   would deadlock (abort waits for idle, idle waits for us).
 * - Because the turn dies with the compaction, the tool optionally sends a
 *   follow-up user message after completion so the model resumes its task
 *   with the fresh summarized context (`resume` param, default true).
 *
 * Loop safety: an in-flight guard plus a cooldown window refuse back-to-back
 * triggers, and the resume message tells the model not to compact again
 * unless the context grows large again.
 */

export const CompactToolParams = Type.Object({
  instructions: Type.Optional(
    Type.String({
      description:
        "Focus instructions for the summary: what must be preserved (goal, decisions, open tasks, key file paths, etc.).",
    }),
  ),
  resume: Type.Optional(
    Type.Boolean({
      description:
        "After compaction completes, automatically continue the current task with the summarized context. Default true.",
    }),
  ),
});
export type CompactToolParams = Static<typeof CompactToolParams>;

export interface CompactToolDeps {
  /** Injected from the activate()-time ExtensionAPI; a dep (not a closure over `pi`) keeps the tool unit-testable. */
  sendUserMessage: (text: string) => void;
  /** Minimum interval between two model-triggered compactions. Default 60s. */
  cooldownMs?: number;
  /** Clock override for tests. */
  now?: () => number;
}

const RESUME_TEXT =
  "[compact_context] Context compaction completed successfully. " +
  "The earlier conversation has been replaced by the summary above. " +
  "Continue your task based on the summary and the retained recent messages. " +
  "Do NOT call compact_context again unless the context grows large again.";

export function createCompactTool(deps: CompactToolDeps): ToolDefinition<typeof CompactToolParams> {
  const cooldownMs = deps.cooldownMs ?? 60_000;
  const now = deps.now ?? (() => Date.now());
  // Per-factory state (never module scope): pi's /reload re-activates the
  // extension in the same process, and a fresh tool instance must start with
  // a clean guard state.
  let compacting = false;
  let lastTriggeredAt = 0;

  return {
    name: "compact_context",
    label: "Compact Context",
    description:
      "Trigger context compaction NOW: summarize older conversation history into a compact summary " +
      "and keep only recent messages, freeing up context window space. " +
      "Calling this ends your current turn; after compaction completes, your task automatically " +
      "resumes with the summarized context (unless resume=false). " +
      "Only available in interactive sessions (not in print/json one-shot mode). " +
      "Use it when earlier conversation content is no longer needed in full (e.g. a phase of work " +
      "just completed, or context is cluttered with large outdated tool outputs). " +
      "Do NOT use it for small/short sessions, and do not call it again right after a compaction.",
    promptSnippet: "compact_context(instructions?, resume?) - summarize older history to free up context window space",
    promptGuidelines: [
      "Use compact_context when a distinct phase of work has completed and its detailed history is no longer needed, or when context is cluttered with large outdated tool outputs.",
      "Pass compact_context an `instructions` argument describing what the summary must preserve (current goal, key decisions, open tasks, important file paths).",
      "Never call compact_context twice in a row; after a compaction, continue working from the summary.",
    ],
    parameters: CompactToolParams,
    /** Same convention as steer_subagent's renderCall: show the focus instructions, not a bare tool name. */
    renderCall(args, theme, context) {
      const text = (context.lastComponent as Text | undefined) ?? new Text("", 0, 0);
      const title = theme.fg("toolTitle", theme.bold("Compact Context"));
      const preview = args?.instructions?.replace(/\s+/g, " ").trim();
      const clipped = preview && preview.length > 80 ? `${preview.slice(0, 79)}…` : preview;
      text.setText(clipped ? `${title}\n${theme.fg("muted", clipped)}` : title);
      return text;
    },
    async execute(_toolCallId, params, _signal, _onUpdate, ctx: ExtensionContext) {
      // In one-shot print/json mode the process disposes right after the
      // prompt completes: the fire-and-forget compaction and the resume
      // message have no lifecycle guarantee, and the abort would just kill
      // the only turn. Refuse and let pi's automatic threshold compaction
      // (which works fine mid-run) handle long sessions instead.
      if (ctx.mode === "print" || ctx.mode === "json") {
        return {
          content: [
            {
              type: "text" as const,
              text: "compact_context is not available in non-interactive (print/json) mode. Rely on pi's automatic compaction and continue your task with the current context.",
            },
          ],
          details: { ok: false as const, reason: "non_interactive_mode" },
        };
      }

      if (compacting) {
        return {
          content: [
            {
              type: "text" as const,
              text: "A compaction is already in progress. Do not call compact_context again; continue your task.",
            },
          ],
          details: { ok: false as const, reason: "in_flight" },
        };
      }

      if (now() - lastTriggeredAt < cooldownMs) {
        return {
          content: [
            {
              type: "text" as const,
              text: `Compaction was already triggered less than ${cooldownMs / 1000}s ago. Refusing to compact again. Continue your task with the current context.`,
            },
          ],
          details: { ok: false as const, reason: "cooldown" },
        };
      }

      const usage = ctx.getContextUsage();
      const usageText = usage?.tokens != null ? ` (~${Math.round(usage.tokens / 1000)}k tokens in context)` : "";
      const resume = params.resume !== false;

      compacting = true;
      lastTriggeredAt = now();
      ctx.ui.notify(`Model requested context compaction${usageText}…`, "info");

      try {
        ctx.compact({
          // exactOptionalPropertyTypes: never pass an explicit `undefined`.
          ...(params.instructions === undefined ? {} : { customInstructions: params.instructions }),
          onComplete: (result) => {
            compacting = false;
            ctx.ui.notify(`Compaction completed (${Math.round(result.tokensBefore / 1000)}k tokens before).`, "info");
            if (!resume) return;
            try {
              deps.sendUserMessage(RESUME_TEXT);
            } catch {
              // Session replaced / shutting down — nothing sensible to resume into.
            }
          },
          onError: (error) => {
            compacting = false;
            ctx.ui.notify(`Model-triggered compaction failed: ${error.message}`, "error");
            if (!resume) return;
            try {
              deps.sendUserMessage(
                `[compact_context] Context compaction FAILED (${error.message}). ` +
                  "The conversation was NOT compacted. Do NOT call compact_context again; " +
                  "just continue your task with the current context.",
              );
            } catch {
              // Session replaced / shutting down.
            }
          },
        });
      } catch (error) {
        // ctx.compact() can throw synchronously (e.g. stale extension
        // context). Reset the guard so later calls are not blocked forever.
        compacting = false;
        throw error;
      }

      // NOTE: ctx.compact() synchronously aborts the current run, so this
      // return value may never reach the model. Keep it short; the real
      // hand-off happens via the follow-up message in onComplete/onError.
      return {
        content: [
          {
            type: "text" as const,
            text: "Compaction triggered. This turn ends now; work will resume automatically with the compacted context.",
          },
        ],
        details: { ok: true as const },
        terminate: true,
      };
    },
  } satisfies ToolDefinition<typeof CompactToolParams>;
}
