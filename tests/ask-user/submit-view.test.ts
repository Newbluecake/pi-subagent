import { describe, expect, it } from "vitest";
import {
  answerValueText,
  buildResult,
  getAnswerText,
  renderButtonBar,
  renderSubmitView,
} from "../../src/ask-user/submit-view.js";
import { createQuestionState, type Question, type QuestionState } from "../../src/ask-user/types.js";
import { stubTheme } from "./fixtures.js";

const questions: Question[] = [
  { question: "Q1", header: "First", options: [{ label: "A" }, { label: "B" }] },
  { question: "Q2", header: "Second", multiSelect: true, options: [{ label: "X" }, { label: "Y" }] },
];
const state = (over: Partial<QuestionState> = {}): QuestionState => ({ ...createQuestionState(), ...over });

describe("submit view", () => {
  it("formats selected and Other values", () => {
    expect(answerValueText({ selected: ["A", "B"], other: "custom" })).toBe("A, B, custom");
    expect(answerValueText({ selected: [], other: null })).toBe("");
  });

  it("gets answers in option order and rejects confirmed empty states", () => {
    expect(getAnswerText(questions[1]!, state({ confirmed: true, selectedIndices: new Set([1, 0]) }))).toEqual({
      selected: ["X", "Y"],
      other: null,
    });
    expect(getAnswerText(questions[0]!, state({ confirmed: true }))).toBeNull();
    expect(getAnswerText(questions[0]!, state({ confirmed: true, freeTextValue: "custom" }))).toEqual({
      selected: [],
      other: "custom",
    });
  });

  it("shows readiness, missing headers, and focusable buttons", () => {
    const incomplete = renderSubmitView(
      questions,
      [state({ confirmed: true, selectedIndex: 0 }), state()],
      stubTheme,
      70,
    ).join("\n");
    expect(incomplete).toContain("Unanswered questions");
    expect(incomplete).toContain("Still needed: Second");
    expect(incomplete).toContain("Cancel");

    const complete = renderSubmitView(
      questions,
      [state({ confirmed: true, selectedIndex: 0 }), state({ confirmed: true, selectedIndices: new Set([0]) })],
      stubTheme,
      70,
      "cancel",
    ).join("\n");
    expect(complete).toContain("Ready to submit");
    expect(complete).toContain("All questions answered");
  });

  it("builds internal results keyed by full question text", () => {
    const result = buildResult(questions, [state({ confirmed: true, selectedIndex: 1 }), state()]);
    expect(result.cancelled).toBe(false);
    expect(result.answers.Q1).toEqual({ selected: ["B"], other: null });
    expect(result.answers.Q2).toBeUndefined();
  });

  it("renders a button bar in every focus state", () => {
    expect(renderButtonBar(stubTheme, false, "submit")).toContain("Submit");
    expect(renderButtonBar(stubTheme, true, "cancel")).toContain("Cancel");
  });
});
