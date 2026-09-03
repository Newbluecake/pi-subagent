import { Type, type Static } from "@sinclair/typebox";
import { Text } from "@earendil-works/pi-tui";
import type { ToolDefinition } from "@earendil-works/pi-coding-agent";
import type { QueryService } from "../service/query-service.js";
import type { ResolveRunResult } from "../service/resolve-target.js";
import { deliveryKey, type Notifier } from "../delivery/notifier.js";
import type { RunOutcome } from "../core/types.js";
import { formatDuration } from "../ui/fleet-panel.js";
import { buildProgressLines } from "./agent-tool.js";
import { toPiToolUsage } from "./usage.js";

/**
 * "get_subagent_result" — drop-in replacement for @tintinweb/pi-subagents'
 * result-retrieval tool. `wait` is bounded by `wait_ms` (architecture G1/G2:
 * QueryService.wait() never blocks unboundedly, see service/query-service.ts)
 * — this closes the original plugin's P2 defect (unbounded wait:true).
 */
export const ResultToolParams = Type.Object({
  run_id: Type.String({
    description:
      "The run id returned by the Agent tool; also accepts a unique run_id prefix or the Agent call's label (its description).",
  }),
  wait: Type.Optional(
    Type.Boolean({
      description:
        "If true, block until the run reaches a terminal state (bounded by wait_ms). Default false — and keep it " +
        "false in almost all cases: a blocking wait occupies the agent loop for its whole duration, so the user " +
        "cannot type a new message or command until it returns. Rely on the run's completion notification and " +
        "call this tool without wait once it arrives; use wait only as a fallback when an expected notification " +
        "never arrived and there is genuinely nothing else to do.",
    }),
  ),
  wait_ms: Type.Optional(
    Type.Number({
      description:
        "Maximum time to wait in milliseconds when wait is true. Defaults to the awaited run's remaining " +
        "time budget plus a short settlement grace, so a default wait normally outlives the run itself.",
    }),
  ),
});
export type ResultToolParams = Static<typeof ResultToolParams>;

export function createResultTool(deps: {
  query: QueryService;
  resolveRun?: (handle: string) => ResolveRunResult;
  notifier?: Pick<Notifier, "ack">;
}): ToolDefinition<typeof ResultToolParams> {
  // pi usage accounting dedupe: a background run's spend is attached to the
  // FIRST tool result that reports its terminal outcome — get_subagent_result
  // can be called repeatedly for the same run, and re-attaching usage each
  // time would double-count the cost in pi's session totals.
  const usageReported = new Set<string>();
  const usageOnce = (runId: string, usage?: Parameters<typeof toPiToolUsage>[0]) => {
    if (!usage || usageReported.has(runId)) return {};
    usageReported.add(runId);
    return { usage: toPiToolUsage(usage) };
  };
  const tryAck = (runId: string, generation: number, outcome: RunOutcome) => {
    if (!deps.notifier) return;
    try {
      deps.notifier.ack(runId, generation, {
        extensionOwner: "get_subagent_result",
      });
    } catch {
      // Defensive boundary for future notifier implementations.
    }
  };
  return {
    name: "get_subagent_result",
    label: "Get Subagent Result",
    description:
      "Check on, or collect the result of, a subagent run started with the Agent tool (run_in_background: true). " +
      "Background runs push a completion notification on terminal state, so the normal flow is: continue other " +
      "work (or end your turn), then call this tool without wait once the notification arrives. Set wait: true " +
      "to block until the run finishes (up to wait_ms) — while it blocks, the user cannot send new input, so " +
      "avoid it whenever anything else could proceed (ending your turn counts); it is a fallback for when an " +
      "expected notification never arrived. Terminal results include the run's wall-clock " +
      "duration (text trailer and details.durationMs), so post-completion reads still expose how long it ran.",
    promptSnippet: "get_subagent_result(run_id, wait?, wait_ms?) - check a background subagent's status/result",
    parameters: ResultToolParams,
    /**
     * Without a renderCall the TUI shows a bare "get_subagent_result ⠦" while
     * a wait blocks — no hint of *which* run is being awaited or under what
     * budget. Mirror the Agent tool: surface the key arguments on the card.
     */
    renderCall(args, theme, context) {
      const text = (context.lastComponent as Text | undefined) ?? new Text("", 0, 0);
      const title = theme.fg("toolTitle", theme.bold(`Get Subagent Result: ${args?.run_id ?? "…"}`));
      const meta = args?.wait
        ? `wait (budget: ${args.wait_ms !== undefined ? formatDuration(args.wait_ms) : "default"})`
        : undefined;
      text.setText(meta ? `${title}\n${theme.fg("muted", meta)}` : title);
      return text;
    },
    // §2.7: the pi harness may invoke execute() with signal === undefined; the
    // wait path below tolerates that (QueryService.wait's opts.signal is optional).
    async execute(_toolCallId, params, signal, onUpdate) {
      const resolved = deps.resolveRun?.(params.run_id);
      if (resolved && !resolved.ok) throw new Error(resolved.error);
      const runId = resolved?.ok ? resolved.runId : params.run_id;
      if (!params.wait) {
        const snapshot = deps.query.get(runId);
        if (!snapshot) throw new Error(`unknown run_id: ${params.run_id}`);
        const text = snapshot.outcome
          ? formatOutcome(snapshot.outcome)
          : [
              `Run ${runId} is still ${snapshot.status} (phase: ${snapshot.phase}).`,
              ...buildProgressLines(snapshot, Date.now()),
            ].join("\n");
        if (snapshot.outcome) tryAck(runId, snapshot.generation, snapshot.outcome);
        return {
          content: [{ type: "text" as const, text }],
          ...(snapshot.outcome ? usageOnce(runId, snapshot.outcome.usage) : {}),
          details: {
            runId,
            status: snapshot.status,
            usage: snapshot.diag.usage,
            ...(snapshot.outcome ? { durationMs: snapshot.outcome.durationMs } : {}),
            ...(snapshot.outcome?.structuredResult !== undefined
              ? { structuredResult: snapshot.outcome.structuredResult }
              : {}),
          },
        };
      }
      // Live visibility while the (bounded) wait blocks: same 1 Hz partial-
      // update side channel as the Agent tool's foreground path — header with
      // elapsed/budget plus the awaited run's own progress snapshot. Purely a
      // read-only display concern; the wait semantics are unchanged.
      const startedAt = Date.now();
      const push = () => {
        if (!onUpdate) return;
        const now = Date.now();
        const budget = params.wait_ms !== undefined ? formatDuration(params.wait_ms) : "default budget";
        const snap = deps.query.get(runId);
        const lines = [
          `⏳ waiting for ${runId} · ${formatDuration(now - startedAt)} / ${budget}`,
          ...(snap && !snap.outcome ? buildProgressLines(snap, now) : []),
        ];
        onUpdate({
          content: [{ type: "text", text: lines.join("\n") }],
          details: { runId, progress: lines },
        });
      };
      const timer = onUpdate ? setInterval(push, 1000) : undefined;
      (timer as { unref?: () => void } | undefined)?.unref?.();
      push();
      // try/finally rather than .finally(): a synchronous throw from a
      // non-async QueryService stub would otherwise skip cleanup entirely
      // (the rejection would surface before the .finally chain existed).
      let waited;
      try {
        waited = await deps.query.wait(runId, {
          ...(params.wait_ms === undefined ? {} : { waitMs: params.wait_ms }),
          ...(signal ? { signal } : {}),
        });
      } finally {
        if (timer) clearInterval(timer);
      }
      if (!waited.ok) {
        const reason =
          waited.reason === "unknown_run"
            ? `unknown run_id: ${params.run_id}`
            : waited.reason === "aborted"
              ? "wait was aborted"
              : params.wait_ms !== undefined
                ? `wait timed out after ${params.wait_ms}ms`
                : "wait timed out after the default budget (the run's remaining deadline + grace)";
        throw new Error(reason);
      }
      tryAck(runId, waited.outcome.diag.generation, waited.outcome);
      return {
        content: [{ type: "text" as const, text: formatOutcome(waited.outcome) }],
        ...usageOnce(runId, waited.outcome.usage),
        details: {
          runId,
          status: waited.outcome.status,
          durationMs: waited.outcome.durationMs,
          usage: waited.outcome.usage,
          ...(waited.outcome.structuredResult !== undefined
            ? { structuredResult: waited.outcome.structuredResult }
            : {}),
        },
      };
    },
  } satisfies ToolDefinition<typeof ResultToolParams>;
}

function formatOutcome(outcome: {
  status: string;
  text?: string;
  structuredResult?: unknown;
  error?: { message: string };
  timeoutReason?: string;
  durationMs: number;
  usage?: { input: number; output: number; cacheRead: number; cacheWrite: number; costUsd: number };
}): string {
  // durationMs is a first-class RunOutcome field, so the trailer always
  // carries it — unlike the completion notification (which shows `21s` once
  // and is gone), this makes wall-clock duration retrievable on every
  // post-terminal read of the result.
  const trailer = outcome.usage
    ? `\n\n(duration: ${formatDuration(outcome.durationMs)} · usage: in:${outcome.usage.input} out:${outcome.usage.output} cache_r:${outcome.usage.cacheRead} cache_w:${outcome.usage.cacheWrite} cost:$${outcome.usage.costUsd.toFixed(4)})`
    : `\n\n(duration: ${formatDuration(outcome.durationMs)})`;
  if (outcome.status === "completed") {
    const body =
      outcome.structuredResult !== undefined
        ? JSON.stringify(outcome.structuredResult)
        : (outcome.text ?? "(subagent completed with no text output)");
    return body + trailer;
  }
  const reason = outcome.error?.message ?? outcome.timeoutReason ?? outcome.status;
  return `Subagent run ${outcome.status}: ${reason}${trailer}`;
}
