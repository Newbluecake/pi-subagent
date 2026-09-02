import { Type, type Static } from "@sinclair/typebox";
import { Text } from "@earendil-works/pi-tui";
import type { ToolDefinition } from "@earendil-works/pi-coding-agent";
import type { QueryService } from "../service/query-service.js";
import type { ResolveRunResult } from "../service/resolve-target.js";

export const AbortToolParams = Type.Object({
  run_id: Type.String({
    description:
      "The run id of the subagent to abort; also accepts a unique run_id prefix or the Agent call's label (its description).",
  }),
  reason: Type.Optional(Type.String({ description: "Optional reason to include in the confirmation." })),
});
export type AbortToolParams = Static<typeof AbortToolParams>;

function previewReason(reason?: string): string | undefined {
  if (!reason) return undefined;
  const clean = reason
    .replace(/[\u0000-\u001f\u007f]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  return clean ? (clean.length > 80 ? `${clean.slice(0, 79)}…` : clean) : undefined;
}

export function createAbortTool(deps: {
  query: QueryService;
  resolveRun?: (handle: string) => ResolveRunResult;
}): ToolDefinition<typeof AbortToolParams> {
  return {
    name: "abort_subagent",
    label: "Abort Subagent",
    description:
      "Stop a still-running subagent started with the Agent tool (including one that was auto-backgrounded). Terminal runs are reported as already-finished instead of erroring, so repeated calls are safe.",
    promptSnippet: "abort_subagent(run_id, reason?) - stop a running subagent",
    parameters: AbortToolParams,
    renderCall(args, theme, context) {
      const text = (context.lastComponent as Text | undefined) ?? new Text("", 0, 0);
      const title = theme.fg("toolTitle", theme.bold(`Abort Subagent: ${args?.run_id ?? "…"}`));
      const reason = previewReason(args?.reason);
      text.setText(reason ? `${title}\n${theme.fg("muted", reason)}` : title);
      return text;
    },
    async execute(_toolCallId, params) {
      const resolved = deps.resolveRun?.(params.run_id);
      if (resolved && !resolved.ok) throw new Error(resolved.error);
      const runId = resolved?.ok ? resolved.runId : params.run_id;
      const result = await deps.query.stop(runId, "user_stop");
      if (result.ok) {
        return {
          content: [
            {
              type: "text" as const,
              text: `Abort requested for run ${runId} (escalation: ${result.escalatedTo}). Use get_subagent_result(run_id: "${runId}", wait: true) to wait for its terminal state.`,
            },
          ],
          details: {
            runId,
            ok: true,
            escalatedTo: result.escalatedTo,
            ...(previewReason(params.reason) ? { reason: previewReason(params.reason) } : {}),
          },
        };
      }
      if (result.reason === "already_terminal") {
        return {
          content: [
            {
              type: "text" as const,
              text: `run ${runId} has already reached a terminal state ("${result.status}"); nothing to abort`,
            },
          ],
          details: { runId, alreadyTerminal: true, status: result.status },
        };
      }
      if (result.reason === "unknown_run") throw new Error(`unknown run_id: ${params.run_id}`);
      throw new Error(`failed to abort run ${runId} (escalation: ${result.escalatedTo})`);
    },
  } satisfies ToolDefinition<typeof AbortToolParams>;
}
