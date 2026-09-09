import { Type, type Static } from "@sinclair/typebox";
import type { ExtensionContext, ToolDefinition } from "@earendil-works/pi-coding-agent";
import { effectiveThresholdPercent, maxThresholdPercent } from "../compact-hint/threshold.js";
import type { CompactHintState } from "../stack.js";

export const SetCompactThresholdParams = Type.Object({
  percent: Type.Optional(
    Type.Number({ description: "0 to disable, or an integer threshold from 1 to 100; omit to query." }),
  ),
  force: Type.Optional(
    Type.Number({
      description: "0 to disable forced compaction, or a force threshold from 1 to 100; omit to leave unchanged.",
    }),
  ),
});
export type SetCompactThresholdParams = Static<typeof SetCompactThresholdParams>;

export interface SetCompactThresholdToolDeps {
  getState: () => CompactHintState | undefined;
  compactToolEnabled: () => boolean;
}

function result(text: string, reason: string, extra: Record<string, unknown> = {}) {
  return { content: [{ type: "text" as const, text }], details: { ok: false as const, reason, ...extra } };
}

export function createSetCompactThresholdTool(
  deps: SetCompactThresholdToolDeps,
): ToolDefinition<typeof SetCompactThresholdParams> {
  return {
    name: "set_compact_threshold",
    label: "Set Compact Threshold",
    description:
      "Query, set, or disable the context-usage percentage at which pi-subagent reminds you to call compact_context. " +
      "Calling it with no arguments reports the current context usage and thresholds without changing anything.",
    promptSnippet: "set_compact_threshold(percent?) - query or set the model-triggered compaction reminder threshold",
    promptGuidelines: [
      "This is a reminder threshold, never forced compression; use compact_context when you decide to compact.",
      "Use 0 to disable, omit percent to query, or use a value of at least 1; the effective value stays below pi's automatic line.",
    ],
    parameters: SetCompactThresholdParams,
    async execute(_id, params, _signal, _update, ctx: ExtensionContext) {
      if (ctx.mode === "print" || ctx.mode === "json")
        return result(
          "set_compact_threshold is unavailable in non-interactive (print/json) mode.",
          "non_interactive_mode",
        );
      if (!deps.compactToolEnabled())
        return result("Compact threshold reminders are disabled by settings.", "compact_tool_disabled");
      const state = deps.getState();
      if (!state) return result("No active session is available.", "no_session");
      const usage = ctx.getContextUsage();
      const current = usage?.percent == null ? "unknown" : `${Math.round(usage.percent)}%`;
      const usageNote = usage?.contextWindow === undefined ? "; 读侧钳制可能生效" : "";
      const window = usage?.contextWindow;
      const effective =
        window === undefined
          ? state.thresholdPercent
          : effectiveThresholdPercent(state.thresholdPercent, window, state.reserveTokens);
      const effectiveForce =
        window === undefined
          ? state.forceAtPercent
          : effectiveThresholdPercent(state.forceAtPercent, window, state.reserveTokens);
      if (params.percent === undefined && params.force === undefined) {
        return {
          content: [
            {
              type: "text" as const,
              text: `Compact hint threshold: ${state.thresholdPercent}% (effective ${effective}%), force: ${state.forceAtPercent}% (effective ${effectiveForce}%), current usage ${current}${usageNote}.`,
            },
          ],
          details: {
            ok: true as const,
            action: "query",
            thresholdPercent: state.thresholdPercent,
            effectivePercent: effective,
            forceAtPercent: state.forceAtPercent,
            effectiveForcePercent: effectiveForce,
            usage: usage?.percent ?? null,
          },
        };
      }
      const value = params.percent;
      const force = params.force;
      if (value !== undefined && (!Number.isFinite(value) || value < 0 || value > 100 || (value > 0 && value < 1)))
        return result("Invalid threshold. Use 0 to disable or a number from 1 to 100.", "invalid");
      if (force !== undefined && (!Number.isFinite(force) || force < 0 || force > 100 || (force > 0 && force < 1)))
        return result("Invalid force threshold. Use 0 to disable or a number from 1 to 100.", "invalid");
      const nextPercent = value === undefined ? state.thresholdPercent : Math.floor(value);
      const nextForce = force === undefined ? state.forceAtPercent : Math.floor(force);
      if (nextForce > 0 && nextForce <= nextPercent)
        return result("Invalid force threshold. It must be greater than the warning threshold.", "invalid");
      if (
        value !== undefined &&
        window !== undefined &&
        Math.floor(nextPercent) > maxThresholdPercent(window, state.reserveTokens)
      )
        return result(
          `Threshold exceeds the current dynamic cap of ${maxThresholdPercent(window, state.reserveTokens)}%.`,
          "above_cap",
        );
      if (force !== undefined && window !== undefined && nextForce > maxThresholdPercent(window, state.reserveTokens))
        return result(
          `Force threshold exceeds the current dynamic cap of ${maxThresholdPercent(window, state.reserveTokens)}%.`,
          "above_cap",
        );
      state.thresholdPercent = nextPercent;
      state.forceAtPercent = nextForce;
      state.hintedAt = undefined;
      state.lastHintAt = 0;
      const action = state.thresholdPercent === 0 ? "off" : "set";
      const nextEffective =
        window === undefined
          ? state.thresholdPercent
          : effectiveThresholdPercent(state.thresholdPercent, window, state.reserveTokens);
      return {
        content: [
          {
            type: "text" as const,
            text: `Compact thresholds ${action === "off" ? "disabled" : `set to ${state.thresholdPercent}% (effective ${nextEffective}%), force ${state.forceAtPercent}% (effective ${window === undefined ? state.forceAtPercent : effectiveThresholdPercent(state.forceAtPercent, window, state.reserveTokens)}%)`}; current usage ${current}${usageNote}.`,
          },
        ],
        details: {
          ok: true as const,
          action,
          thresholdPercent: state.thresholdPercent,
          effectivePercent: nextEffective,
          forceAtPercent: state.forceAtPercent,
          effectiveForcePercent:
            window === undefined
              ? state.forceAtPercent
              : effectiveThresholdPercent(state.forceAtPercent, window, state.reserveTokens),
          usage: usage?.percent ?? null,
        },
      };
    },
  };
}
