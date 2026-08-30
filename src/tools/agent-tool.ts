import { Type, type Static } from "@sinclair/typebox";
import type { ExtensionContext, ToolDefinition } from "@earendil-works/pi-coding-agent";
import type { SpawnService } from "../service/spawn-service.js";

/**
 * "Agent" tool — drop-in replacement for @tintinweb/pi-subagents' Agent tool
 * (see package.json description). Parameter surface intentionally mirrors
 * the fields the original plugin's model-facing contract relies on
 * (description / prompt / subagent_type / model / run_in_background) so
 * existing agent .md files and calling conventions keep working; steering
 * and result retrieval are separate tools (steer_subagent /
 * get_subagent_result) rather than crammed into this one, and resume is not
 * implemented in M1 (SessionDriver has no resume path yet) — advertised
 * honestly in the description rather than silently accepted.
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
  run_in_background: Type.Optional(
    Type.Boolean({
      description:
        "If true, returns immediately with a run id instead of waiting for completion. Retrieve the result later with get_subagent_result.",
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
  spawn: SpawnService;
  parentRunId?: string;
}): ToolDefinition<typeof AgentToolParams> {
  return {
    name: "Agent",
    label: "Agent",
    description:
      "Launch an autonomous subagent to handle a complex, multi-step task. The subagent runs in its own bounded session " +
      "and cannot hang indefinitely: every run has a total wall-clock budget and always reaches a terminal state " +
      "(completed/failed/timed_out/aborted). Use get_subagent_result to check on or wait for a background run, and " +
      "steer_subagent to send a follow-up instruction to a still-running one. Resuming a previous run is not supported.",
    promptSnippet: "Agent(description, prompt, subagent_type, model?, run_in_background?) - spawn a bounded subagent",
    parameters: AgentToolParams,
    async execute(_toolCallId, params, signal) {
      const modelOverride = parseModel(params.model);
      const request = {
        type: params.subagent_type,
        prompt: params.prompt,
        label: params.description,
        ...(modelOverride ? { modelOverride } : {}),
        ...(deps.parentRunId ? { parentRunId: deps.parentRunId } : {}),
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
        content: [{ type: "text" as const, text: outcome.text ?? "(subagent completed with no text output)" }],
        details: { runId: outcome.runId, status: outcome.status, turns: outcome.turns, durationMs: outcome.durationMs },
      };
    },
  } satisfies ToolDefinition<typeof AgentToolParams>;
}
export type { ExtensionContext };
