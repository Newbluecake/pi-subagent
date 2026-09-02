import { Type, type Static } from "@sinclair/typebox";
import { Text } from "@earendil-works/pi-tui";
import type { ToolDefinition } from "@earendil-works/pi-coding-agent";
import type { QueryService } from "../service/query-service.js";
import type { ResolveRunResult } from "../service/resolve-target.js";

/**
 * "steer_subagent" — drop-in replacement for @tintinweb/pi-subagents' steer
 * tool. Unlike the original (report 5.7 / architecture D2 P1: steer()'s
 * rejection was swallowed and it had no timeout), this always reports a
 * concrete ok/failure reason instead of a bare success (architecture
 * QueryService.steer contract, service/query-service.ts).
 */
export const SteerToolParams = Type.Object({
  run_id: Type.String({
    description:
      "The run id of the subagent to steer; also accepts a unique run_id prefix or the Agent call's label (its description).",
  }),
  text: Type.String({ description: "The follow-up instruction to send to the running subagent." }),
});
export type SteerToolParams = Static<typeof SteerToolParams>;

export function createSteerTool(deps: {
  query: QueryService;
  resolveRun?: (handle: string) => ResolveRunResult;
}): ToolDefinition<typeof SteerToolParams> {
  return {
    name: "steer_subagent",
    label: "Steer Subagent",
    description: "Send a follow-up instruction to a currently running subagent started with the Agent tool.",
    promptSnippet: "steer_subagent(run_id, text) - send a follow-up instruction to a running subagent",
    parameters: SteerToolParams,
    /** Same rationale as get_subagent_result's renderCall: show *which* run is being steered and a preview of the instruction, not a bare tool name. */
    renderCall(args, theme, context) {
      const text = (context.lastComponent as Text | undefined) ?? new Text("", 0, 0);
      const title = theme.fg("toolTitle", theme.bold(`Steer Subagent: ${args?.run_id ?? "…"}`));
      const preview = args?.text?.replace(/\s+/g, " ").trim();
      const clipped = preview && preview.length > 80 ? `${preview.slice(0, 79)}…` : preview;
      text.setText(clipped ? `${title}\n${theme.fg("muted", clipped)}` : title);
      return text;
    },
    async execute(_toolCallId, params) {
      const resolved = deps.resolveRun?.(params.run_id);
      if (resolved && !resolved.ok) throw new Error(resolved.error);
      const runId = resolved?.ok ? resolved.runId : params.run_id;
      const result = await deps.query.steer(runId, params.text);
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
        content: [{ type: "text" as const, text: `Sent follow-up instruction to run ${runId}.` }],
        details: { ok: true, runId },
      };
    },
  } satisfies ToolDefinition<typeof SteerToolParams>;
}
