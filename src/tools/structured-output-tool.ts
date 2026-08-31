import { Type } from "@sinclair/typebox";
import type { JsonSchema, ValidationResult } from "../core/json-schema.js";

/**
 * X10: the tool injected into a subagent session (via SessionSpec.customTools,
 * see service/runtime-adapter.ts) when the caller supplied a `schema`. This
 * is the *first* of the two mandatory validations (architecture §7.2 X10
 * "双重校验"): `onSubmit` runs the same core/json-schema.ts validator the
 * host re-runs independently afterward. A rejected submission never touches
 * the captured value — the model sees the concrete errors and can retry.
 */
export function createStructuredOutputTool(deps: {
  schema: JsonSchema;
  onSubmit: (value: unknown) => ValidationResult;
}) {
  return {
    name: "StructuredOutput",
    label: "Structured Output",
    description:
      "Submit the final structured result for this task. The payload must conform to the JSON Schema the caller " +
      "requested. Call this exactly once, when you have the complete result — if it is rejected you will see the " +
      "concrete validation errors and can fix and resubmit. The host independently re-validates the payload " +
      "against the same schema before the run is considered completed; a submission that only looks accepted here " +
      "is not sufficient on its own.",
    promptSnippet: "StructuredOutput(<schema-shaped payload>) - submit the final structured result",
    parameters: Type.Unsafe<unknown>(deps.schema),
    async execute(_toolCallId: string, params: unknown) {
      const result = deps.onSubmit(params);
      if (!result.ok) {
        return {
          content: [
            {
              type: "text" as const,
              text: `Structured output rejected: ${result.errors.join("; ")}. Fix the payload and call StructuredOutput again.`,
            },
          ],
          details: { ok: false, errors: result.errors },
        };
      }
      return {
        content: [{ type: "text" as const, text: "Structured output accepted." }],
        details: { ok: true },
      };
    },
  };
}
