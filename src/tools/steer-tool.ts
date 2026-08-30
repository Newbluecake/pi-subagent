import { Type, type Static } from "@sinclair/typebox";
import type { ToolDefinition } from "@earendil-works/pi-coding-agent";
import type { QueryService } from "../service/query-service.js";

/**
 * "steer_subagent" — drop-in replacement for @tintinweb/pi-subagents' steer
 * tool. Unlike the original (report 5.7 / architecture D2 P1: steer()'s
 * rejection was swallowed and it had no timeout), this always reports a
 * concrete ok/failure reason instead of a bare success (architecture
 * QueryService.steer contract, service/query-service.ts).
 */
export const SteerToolParams = Type.Object({
  run_id: Type.String({ description: "The run id of the subagent to steer." }),
  text: Type.String({ description: "The follow-up instruction to send to the running subagent." }),
});
export type SteerToolParams = Static<typeof SteerToolParams>;

export function createSteerTool(deps: { query: QueryService }): ToolDefinition<typeof SteerToolParams> {
  return {
    name: "steer_subagent",
    label: "Steer Subagent",
    description: "Send a follow-up instruction to a currently running subagent started with the Agent tool.",
    promptSnippet: "steer_subagent(run_id, text) - send a follow-up instruction to a running subagent",
    parameters: SteerToolParams,
    async execute(_toolCallId, params) {
      const result = await deps.query.steer(params.run_id, params.text);
      if (!result.ok) {
        const reason =
          result.reason === "not_running"
            ? `run ${params.run_id} is not currently running`
            : result.reason === "steer_timeout"
              ? `steer to run ${params.run_id} timed out`
              : `run ${params.run_id} rejected the steer: ${result.detail ?? "unknown reason"}`;
        throw new Error(reason);
      }
      return {
        content: [{ type: "text" as const, text: `Sent follow-up instruction to run ${params.run_id}.` }],
        details: { ok: true },
      };
    },
  } satisfies ToolDefinition<typeof SteerToolParams>;
}
