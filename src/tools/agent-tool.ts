import { Type, type Static } from "@sinclair/typebox";
import { Text } from "@earendil-works/pi-tui";
import type { ExtensionContext, ToolDefinition } from "@earendil-works/pi-coding-agent";
import type { ErrorInfo, RunId, RunOutcome, SpawnRequest } from "../core/types.js";

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
    description: "The type of specialized subagent to use, matching a registered agent type name.",
  }),
  model: Type.Optional(
    Type.String({
      description: "Optional model override as 'provider/id'. Defaults to the agent type's configured model.",
    }),
  ),
  resume: Type.Optional(
    Type.String({ description: "Agent label or run_id of a completed subagent session to continue." }),
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
        "before the run is considered completed (double validation — architecture §7.2 X10). If the run ends " +
        "without a schema-valid submission it is reported as failed, not completed with free text.",
    }),
  ),
});
export type AgentToolParams = Static<typeof AgentToolParams>;

function parseModel(model?: string): { provider: string; id: string } | undefined {
  if (!model) return undefined;
  const idx = model.indexOf("/");
  if (idx <= 0 || idx === model.length - 1) return undefined;
  return { provider: model.slice(0, idx), id: model.slice(idx + 1) };
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
      "(completed/failed/timed_out/aborted). Use get_subagent_result to check on or wait for a background run, and " +
      "steer_subagent to send a follow-up instruction to a still-running one. Set resume to a completed Agent label or run_id to continue its persisted session. " +
      "Set schema to require a structured (schema-validated) result instead of free text." +
      nestedNote,
    promptSnippet:
      "Agent(description, prompt, subagent_type, model?, resume?, schema?, run_in_background?) - spawn or resume a bounded subagent",
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
        args?.run_in_background ? "background" : undefined,
        args?.resume ? `resume: ${args.resume}` : undefined,
        args?.isolation ? `isolation: ${args.isolation}` : undefined,
      ]
        .filter(Boolean)
        .join(" · ");
      text.setText(meta ? `${title}\n${theme.fg("muted", meta)}` : title);
      return text;
    },
    async execute(_toolCallId, params, signal) {
      if (deps.allowedTypes && !deps.allowedTypes.includes(params.subagent_type)) {
        throw new Error(
          `nested delegation is not permitted: this agent may only spawn [${deps.allowedTypes.join(", ")}], not "${params.subagent_type}"`,
        );
      }
      const modelOverride = parseModel(params.model);
      const request = {
        type: params.subagent_type,
        prompt: params.prompt,
        label: params.description,
        ...(modelOverride ? { modelOverride } : {}),
        ...(deps.parentRunId ? { parentRunId: deps.parentRunId } : {}),
        ...(deps.forceSlotless ? { slotless: true } : {}),
        ...(params.resume ? { resumeFrom: params.resume } : {}),
        ...(typeof params.timeout_ms === "number" ? { budgetOverride: { totalMs: params.timeout_ms } } : {}),
        ...(params.isolation ? { isolation: params.isolation } : {}),
        ...(params.schema !== undefined ? { schema: params.schema as Record<string, unknown> } : {}),
        ...(signal ? { signal } : {}),
      };
      if (params.run_in_background) {
        const spawned = await deps.spawn.spawn(request);
        if ("error" in spawned) throw new Error(spawned.error.message);
        return {
          content: [
            {
              type: "text" as const,
              text: `Subagent "${params.description}" started in background (run_id: ${spawned.runId}). Use get_subagent_result(run_id: "${spawned.runId}") to check on it.`,
            },
          ],
          details: { runId: spawned.runId, background: true },
        };
      }
      const outcome = await deps.spawn.spawnAndWait(request);
      if (outcome.status !== "completed") {
        const reason = outcome.error?.message ?? outcome.timeoutReason ?? outcome.status;
        throw new Error(`Subagent "${params.description}" did not complete successfully: ${reason}`);
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
        details: {
          runId: outcome.runId,
          status: outcome.status,
          turns: outcome.turns,
          durationMs: outcome.durationMs,
          ...(outcome.structuredResult !== undefined ? { structuredResult: outcome.structuredResult } : {}),
        },
      };
    },
  } satisfies ToolDefinition<typeof AgentToolParams>;
}
export type { ExtensionContext };
