import { describe, expect, it } from "vitest";

import {
  AnswerValueSchema,
  HEADER_MAX_CHARS,
  InputSchema,
  OTHER_LABEL,
  QuestionSchema,
  ResultSchema,
  SPLIT_PANE_MIN_WIDTH,
  SPLIT_PANE_SEPARATOR,
  createQuestionState,
  isHighSurrogate,
} from "../../src/ask-user/types.js";

describe("types", () => {
  it("defines the input schema with a questions property", () => {
    expect(InputSchema).toBeDefined();
    expect(InputSchema.properties.questions).toBeDefined();
  });

  it("uses a relaxed union for input option elements", () => {
    const options = InputSchema.properties.questions.items.properties.options as unknown as {
      minItems: number;
      maxItems: number;
      items: { anyOf: Array<{ type?: string }> };
    };

    expect(options.minItems).toBe(2);
    expect(options.maxItems).toBe(4);
    expect(options.items.anyOf).toHaveLength(2);
    expect(options.items.anyOf[1]?.type).toBe("string");
  });

  it("keeps strict option objects in QuestionSchema", () => {
    const options = QuestionSchema.properties.options as unknown as {
      minItems: number;
      maxItems: number;
      items: { properties: { label: { type?: string } } };
    };

    expect(options.minItems).toBe(2);
    expect(options.maxItems).toBe(4);
    expect(options.items.properties.label.type).toBe("string");
  });

  it("defines the result and answer schemas", () => {
    expect(AnswerValueSchema.properties.selected.type).toBe("array");
    expect(ResultSchema.properties.questions).toBeDefined();
    expect(ResultSchema.properties.answers).toBeDefined();
    expect(ResultSchema.properties.cancelled.type).toBe("boolean");
  });

  it("exports the frozen layout constants", () => {
    expect(OTHER_LABEL).toBe("Other");
    expect(HEADER_MAX_CHARS).toBe(12);
    expect(SPLIT_PANE_MIN_WIDTH).toBe(84);
    expect(SPLIT_PANE_SEPARATOR).toBe(" │ ");
  });

  it("creates an independent initial question state", () => {
    const first = createQuestionState();
    const second = createQuestionState();

    expect(first).toMatchObject({
      cursorIndex: 0,
      selectedIndex: null,
      confirmed: false,
      freeTextValue: null,
      freeDraft: null,
      mode: "options",
      draftText: "",
      savedOptionsCursorIndex: 0,
    });
    expect(first.selectedIndices).toBeInstanceOf(Set);
    first.selectedIndices.add(0);
    expect(second.selectedIndices.has(0)).toBe(false);
    expect(first.selectedIndices).not.toBe(second.selectedIndices);
  });

  it("detects UTF-16 high surrogates", () => {
    const text = "A😀B";

    expect(isHighSurrogate(text, 0)).toBe(false);
    expect(isHighSurrogate(text, 1)).toBe(true);
    expect(isHighSurrogate(text, 2)).toBe(false);
    expect(isHighSurrogate(text, 3)).toBe(false);
  });
});
