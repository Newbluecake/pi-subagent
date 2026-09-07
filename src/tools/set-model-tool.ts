import { Type, type Static } from "@sinclair/typebox";
import { Text } from "@earendil-works/pi-tui";
import type { ToolDefinition } from "@earendil-works/pi-coding-agent";
import { SET_MODEL_TIMEOUT_MS, withDeadline } from "../core/deadline.js";
import { systemClock, type Clock } from "../core/clock.js";
import { THINKING_LEVELS, type SetModelOutcome } from "../core/types.js";
import { parseStrictModelRef } from "../config/model-hint.js";
import type { ResolveRunResult } from "../service/resolve-target.js";

/**
 * "set_model" — switch the model used from the next LLM call onward, either
 * for the caller's own session (default) or for a currently running subagent
 * run (host form only). One factory, two forms (docs/dev/set-model
 * plan §4.9):
 *
 * - Host form (registered in src/index.ts): deps.host drives the main
 *   session through pi.setModel; deps.runs/resolveRun reach running
 *   subagents through QueryService.
 * - Run form (injected per-run by service/runtime-adapter.ts): deps.selfRunId
 *   pins "self" to the calling run; foreign run_ids are rejected (D-2).
 *
 * Semantics that are easy to get wrong (plan §5):
 * - pi's setModel recomputes the thinking level (per-model override → global
 *   defaultThinkingLevel → current), so "keep the current level" requires an
 *   explicit write-back after the switch; clamping itself stays with pi core.
 *   This deliberately overrides pi's per-model thinking preference (documented
 *   deviation; requirement 3 says "unspecified = keep current").
 * - Both paths are bounded by SET_MODEL_TIMEOUT_MS (the runner wraps its own
 *   call; here we wrap the host call — pi's auth check reads credential
 *   storage and is not provably bounded).
 * - Failures throw (pi hands the full message to the model; the details
 *   channel is always empty on the error path).
 */

export const SetModelParams = Type.Object({
  model: Type.String({
    description:
      "Target model: a strict 'provider/id' from the 'Available models' section of the system prompt, or a " +
      "fuzzy hint — a bare model id ('kimi-k3') or a case-insensitive substring alias ('sonnet', 'haiku') — " +
      "resolved against the same list. The resolved provider/id is reported back in the result.",
  }),
  run_id: Type.Optional(
    Type.String({
      description:
        "Which session to switch. Omit (or pass 'self') for your own session. Otherwise the run id of a " +
        "currently running subagent; a unique run_id prefix or the Agent call's label (its description) also works.",
    }),
  ),
  thinking: Type.Optional(
    Type.Union([Type.Literal("off"), Type.Literal("low"), Type.Literal("medium"), Type.Literal("high")], {
      description:
        "Optional thinking level to apply together with the switch ('off' | 'low' | 'medium' | 'high'). " +
        "Omit to keep the current level; the level is clamped to what the new model supports and the " +
        "effective value is reported back.",
    }),
  ),
});
export type SetModelParams = Static<typeof SetModelParams>;

export interface SetModelToolDeps {
  /** Host form: main-session self-switch (index.ts injects the ExtensionAPI in a closure). Absent in the run form. */
  host?: {
    /** pi.setModel: false = auth missing for the provider (model unchanged). */
    setModel: (model: unknown) => Promise<boolean>;
    getThinkingLevel: () => string | undefined;
    setThinkingLevel: (level: string) => void;
    /** {provider,id} → opaque pi Model (ctx.modelRegistry.find). */
    findModel: (provider: string, id: string) => unknown | undefined;
  };
  /** Run form: this run's id (where "self" lands). */
  selfRunId?: string;
  /** Switch some run's model (host form = query.setModel; run form = direct runner). */
  runs?: {
    setModel: (
      runId: string,
      model: { provider: string; id: string },
      opts?: { thinking?: string },
    ) => Promise<SetModelOutcome>;
  };
  /** Fuzzy hint resolution (same implementation spawn admission uses). */
  resolveHint?: (hint: string) => { provider: string; id: string } | undefined;
  /** Optional: candidate list for self-correcting error text (E2). */
  available?: () => readonly { provider: string; id: string; name?: string }[];
  /** run_id / unique prefix / label resolution (host form). */
  resolveRun?: (handle: string) => ResolveRunResult;
  /** Clock for the host-path deadline (m2); defaults to systemClock, tests inject FakeClock. */
  clock?: Clock;
}

const HOST_DESCRIPTION =
  "Switch the model used from the next LLM call onward — either your own session (omit run_id) or a " +
  "currently running subagent (run_id). Does not interrupt the current turn: the switch applies to the " +
  "next model call. Optionally set the thinking level at the same time; otherwise the current level is " +
  "kept (clamped to the new model's capabilities). The switch is remembered in the session transcript " +
  "(a resumed session keeps it) and never changes global defaults.";
const RUN_FORM_SUFFIX =
  " This instance can only switch YOUR OWN session's model; run_id must be omitted, 'self', or your own run id.";
const HOST_SNIPPET =
  "set_model(model, run_id?, thinking?) - switch the model for the next LLM call (self or a running subagent)";
// m5: the run form is self-only — its snippet must not mention "a running subagent".
const RUN_SNIPPET = "set_model(model, thinking?) - switch your own session's model for the next LLM call";

function availableSuffix(deps: SetModelToolDeps): string {
  const list = deps.available?.().slice(0, 8) ?? [];
  return list.length
    ? ` Available: ${list.map((m) => `${m.provider}/${m.id}`).join(", ")} (live list — the system-prompt section may be stale)`
    : "";
}

function thinkingText(effective: string | undefined, desired: string | undefined): string {
  if (effective === undefined) return "";
  return desired !== undefined && desired !== effective
    ? ` (thinking: ${effective} — clamped from ${desired})`
    : ` (thinking: ${effective})`;
}

function successResult(
  textTarget: string,
  detailsTarget: string,
  model: { provider: string; id: string },
  effectiveThinking: string | undefined,
  desired: string | undefined,
) {
  return {
    content: [
      {
        type: "text" as const,
        text:
          `Model for ${textTarget} set to ${model.provider}/${model.id}${thinkingText(effectiveThinking, desired)}. ` +
          "Takes effect on the next model call; the current turn continues unchanged.",
      },
    ],
    details: {
      ok: true,
      target: detailsTarget,
      model,
      ...(effectiveThinking === undefined ? {} : { thinking: effectiveThinking }),
    },
  };
}

/** Map a runs.setModel outcome to either a success result or a thrown, self-correcting error (plan §6).
 *  textTarget is the caller-facing handle (what the model typed); detailsTarget is the resolved runId. */
function mapRunOutcome(
  textTarget: string,
  detailsTarget: string,
  outcome: SetModelOutcome,
  requestedThinking: string | undefined,
) {
  if (outcome.ok)
    return successResult(
      textTarget,
      detailsTarget,
      outcome.model,
      outcome.thinking,
      requestedThinking ?? outcome.thinking,
    );
  switch (outcome.reason) {
    case "not_running":
      throw new Error(
        `run ${textTarget} is not currently running; a terminal run's model can only be chosen when you spawn ` +
          "(Agent(model: …)) or resume it",
      );
    case "unknown_model":
      throw new Error(
        `unknown model: ${outcome.detail} (not available in this installation — check the provider auth)`,
      );
    case "rejected":
      throw new Error(`run ${textTarget} refused the model switch: ${outcome.detail}`);
    case "timeout":
      throw new Error(
        `model switch for run ${textTarget} timed out after ${SET_MODEL_TIMEOUT_MS / 1000}s; the session may still be on the previous model`,
      );
    case "unsupported":
      throw new Error("this session cannot switch models mid-run");
  }
}

export function createSetModelTool(deps: SetModelToolDeps): ToolDefinition<typeof SetModelParams> {
  const runForm = deps.selfRunId !== undefined;
  const clock = deps.clock ?? systemClock;
  return {
    name: "set_model",
    label: "Set Model",
    description: runForm ? HOST_DESCRIPTION + RUN_FORM_SUFFIX : HOST_DESCRIPTION,
    promptSnippet: runForm ? RUN_SNIPPET : HOST_SNIPPET,
    ...(runForm
      ? {}
      : {
          promptGuidelines: [
            "Use set_model when the remaining work clearly needs a different capability/cost point (e.g. drop to a cheap model for mechanical edits, escalate for hard reasoning).",
            "The switch takes effect on your NEXT model call — finish the current tool sequence normally, do not re-plan around it.",
            "Report/act on the resolved provider/id in the result: a fuzzy hint may resolve to a different model than you expected.",
          ],
        }),
    parameters: SetModelParams,
    /** Same convention as steer/compact: title + one muted meta line. */
    renderCall(args, theme, context) {
      const text = (context.lastComponent as Text | undefined) ?? new Text("", 0, 0);
      const title = theme.fg("toolTitle", theme.bold(`Set Model: ${args?.model ?? "…"}`));
      const meta = [
        `target: ${args?.run_id === undefined || args.run_id === "self" ? "self" : args.run_id}`,
        ...(args?.thinking ? [`thinking: ${args.thinking}`] : []),
      ].join("  ·  ");
      text.setText(`${title}\n${theme.fg("muted", meta)}`);
      return text;
    },
    async execute(_toolCallId, params) {
      // E1: defensive re-validation beyond the schema (never rely on the host validating).
      const thinking = params.thinking as string | undefined;
      if (thinking !== undefined && !(THINKING_LEVELS as readonly string[]).includes(thinking))
        throw new Error(`invalid thinking level "${thinking}"; use one of ${THINKING_LEVELS.join(", ")}`);
      // D-1/D-2: target classification.
      const rawTarget = params.run_id;
      const isSelf = rawTarget === undefined || rawTarget === "self" || rawTarget === deps.selfRunId;
      if (!isSelf && runForm)
        throw new Error('set_model here can only switch your own model; omit run_id or pass "self"');
      // Resolve first, act second (same discipline as spawn admission).
      const ref = parseStrictModelRef(params.model) ?? deps.resolveHint?.(params.model);
      if (!ref)
        throw new Error(
          `unknown model: "${params.model}" — pass a strict provider/id from the 'Available models' section, or a bare id/substring of an available model.` +
            availableSuffix(deps),
        );
      const opts = thinking === undefined ? {} : { thinking };
      if (isSelf && runForm) {
        const outcome = await deps.runs!.setModel(deps.selfRunId!, ref, opts);
        return mapRunOutcome("this session", "self", outcome, thinking);
      }
      if (isSelf) {
        // Host form self-switch.
        const host = deps.host;
        if (!host)
          throw new Error(
            "this pi build cannot switch the host session's model; target a running subagent instead (pass its run_id)",
          );
        const found = host.findModel(ref.provider, ref.id);
        if (found === undefined || found === null)
          throw new Error(
            `unknown model: ${ref.provider}/${ref.id} (not available in this installation — check the provider auth)`,
          );
        const previous = host.getThinkingLevel();
        const applied = await withDeadline(
          Promise.resolve().then(() => host.setModel(found)),
          SET_MODEL_TIMEOUT_MS,
          clock,
          "set_model",
        );
        if (!applied.ok) {
          if (applied.reason === "timeout")
            throw new Error(
              `model switch timed out after ${SET_MODEL_TIMEOUT_MS / 1000}s; the session may still be on the previous model`,
            );
          // E11 (compact-tool sendUserMessage precedent): a stale post-/reload host binding.
          throw new Error(
            `the host session is no longer bound (session was reloaded); retry the switch (${applied.error.message})`,
          );
        }
        if (applied.value === false)
          throw new Error(
            `no auth configured for provider "${ref.provider}"; the session model is unchanged (run /login or set the provider key)`,
          );
        // Plan §5: write the desired level back over pi's recompute; pi clamps.
        const desired = thinking ?? previous;
        if (desired !== undefined) {
          try {
            host.setThinkingLevel(desired);
          } catch {
            /* non-fatal: pi already clamped to what the model supports */
          }
        }
        return successResult("this session", "self", ref, host.getThinkingLevel(), desired);
      }
      // Foreign target (host form only).
      const resolved = deps.resolveRun?.(rawTarget!);
      if (resolved && !resolved.ok) throw new Error(resolved.error);
      const runId = resolved?.ok ? resolved.runId : rawTarget!;
      const outcome = await deps.runs!.setModel(runId, ref, opts);
      return mapRunOutcome(rawTarget!, runId, outcome, thinking);
    },
  } satisfies ToolDefinition<typeof SetModelParams>;
}
