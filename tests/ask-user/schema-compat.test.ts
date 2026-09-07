import { Value } from "@sinclair/typebox/value";
import { describe, expect, it } from "vitest";

import { InputSchema, ResultSchema } from "../../src/ask-user/types.js";

const validInput = {
  questions: [
    {
      question: "Which option?",
      options: [{ label: "A" }, { label: "B" }],
    },
  ],
};

describe("ask_user schema compatibility", () => {
  it("accepts the documented input shape and preserves cardinality keywords", () => {
    expect(Value.Check(InputSchema, validInput)).toBe(true);
    expect(InputSchema.properties.questions.minItems).toBe(1);
    expect(InputSchema.properties.questions.maxItems).toBe(4);
    expect(InputSchema.properties.questions.items.properties.options.minItems).toBe(2);
    expect(InputSchema.properties.questions.items.properties.options.maxItems).toBe(4);
  });

  it("rejects missing questions and too few options", () => {
    expect(Value.Check(InputSchema, {})).toBe(false);
    expect(
      Value.Check(InputSchema, {
        questions: [{ question: "Which option?", options: [{ label: "A" }] }],
      }),
    ).toBe(false);
  });

  it("accepts a valid result schema and rejects invalid cancellation values", () => {
    expect(
      Value.Check(ResultSchema, {
        questions: validInput.questions,
        answers: {},
        cancelled: false,
      }),
    ).toBe(true);
    expect(
      Value.Check(ResultSchema, {
        questions: validInput.questions,
        answers: {},
        cancelled: "no",
      }),
    ).toBe(false);
  });
});
