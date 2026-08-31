import { Type, type Static } from "@sinclair/typebox";
import type { ToolDefinition } from "@earendil-works/pi-coding-agent";
import type { QueryService } from "../service/query-service.js";

/**
 * "get_subagent_result" — drop-in replacement for @tintinweb/pi-subagents'
 * result-retrieval tool. `wait` is bounded by `wait_ms` (architecture G1/G2:
 * QueryService.wait() never blocks unboundedly, see service/query-service.ts)
 * — this closes the original plugin's P2 defect (unbounded wait:true).
 */
export const ResultToolParams = Type.Object({
  run_id: Type.String({ description: "The run id returned by the Agent tool." }),
  wait: Type.Optional(
    Type.Boolean({ description: "If true, block until the run reaches a terminal state (bounded by wait_ms)." }),
  ),
  wait_ms: Type.Optional(
    Type.Number({
      description: "Maximum time to wait in milliseconds when wait is true. Defaults to a generous but bounded value.",
    }),
  ),
});
export type ResultToolParams = Static<typeof ResultToolParams>;

export function createResultTool(deps: { query: QueryService }): ToolDefinition<typeof ResultToolParams> {
  return {
    name: "get_subagent_result",
    label: "Get Subagent Result",
    description:
      "Check on, or wait for, a subagent run started with the Agent tool (run_in_background: true). " +
      "Set wait: true to block until the run finishes, up to wait_ms.",
    promptSnippet: "get_subagent_result(run_id, wait?, wait_ms?) - check a background subagent's status/result",
    parameters: ResultToolParams,
    // §2.7: the pi harness may invoke execute() with signal === undefined; the
    // wait path below tolerates that (QueryService.wait's opts.signal is optional).
    async execute(_toolCallId, params, signal) {
      if (!params.wait) {
        const snapshot = deps.query.get(params.run_id);
        if (!snapshot) throw new Error(`unknown run_id: ${params.run_id}`);
        const text = snapshot.outcome
          ? formatOutcome(snapshot.outcome)
          : `Run ${params.run_id} is still ${snapshot.status} (phase: ${snapshot.phase}).`;
        return {
          content: [{ type: "text" as const, text }],
          details: { status: snapshot.status, usage: snapshot.diag.usage },
        };
      }
      const waited = await deps.query.wait(params.run_id, {
        ...(params.wait_ms === undefined ? {} : { waitMs: params.wait_ms }),
        ...(signal ? { signal } : {}),
      });
      if (!waited.ok) {
        const reason =
          waited.reason === "unknown_run"
            ? `unknown run_id: ${params.run_id}`
            : waited.reason === "aborted"
              ? "wait was aborted"
              : `wait timed out after ${params.wait_ms ?? "the default budget"}ms`;
        throw new Error(reason);
      }
      return {
        content: [{ type: "text" as const, text: formatOutcome(waited.outcome) }],
        details: { status: waited.outcome.status, usage: waited.outcome.usage },
      };
    },
  } satisfies ToolDefinition<typeof ResultToolParams>;
}

function formatOutcome(outcome: {
  status: string;
  text?: string;
  error?: { message: string };
  timeoutReason?: string;
  usage?: { input: number; output: number; cacheRead: number; cacheWrite: number; costUsd: number };
}): string {
  const usage = outcome.usage
    ? `\n\n(usage: in:${outcome.usage.input} out:${outcome.usage.output} cache_r:${outcome.usage.cacheRead} cache_w:${outcome.usage.cacheWrite} cost:$${outcome.usage.costUsd.toFixed(4)})`
    : "";
  if (outcome.status === "completed") return (outcome.text ?? "(subagent completed with no text output)") + usage;
  const reason = outcome.error?.message ?? outcome.timeoutReason ?? outcome.status;
  return `Subagent run ${outcome.status}: ${reason}${usage}`;
}
