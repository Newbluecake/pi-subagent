import { describe, expect, it } from "vitest";
import { allOptions, getSplitPaneWidths, renderQuestionView } from "../../src/ask-user/question-view.js";
import { createQuestionState, type Question, type QuestionState } from "../../src/ask-user/types.js";
import { singleQ, stubTheme } from "./fixtures.js";

const makeState = (over: Partial<QuestionState> = {}): QuestionState => ({ ...createQuestionState(), ...over });
const joined = (lines: string[]): string => lines.join("\n");

describe("question view", () => {
  it("adds Other and renders single-column options with descriptions", () => {
    expect(allOptions(singleQ).at(-1)).toEqual({ label: "Other", isOther: true });
    const output = joined(
      renderQuestionView({ question: singleQ, state: makeState(), theme: stubTheme, width: 60, isSingle: true }),
    );
    expect(output).toContain("Which DB?");
    expect(output).toContain("Postgres");
    expect(output).toContain("Battle-tested");
    expect(output).toContain("Other");
    expect(output).toContain("Enter select");
  });

  it("uses split pane at 84 columns and shows only focused detail", () => {
    expect(getSplitPaneWidths(83)).toBeNull();
    const widths = getSplitPaneWidths(84);
    expect(widths).not.toBeNull();
    expect(widths!.left).toBeGreaterThanOrEqual(32);
    expect(widths!.right).toBeGreaterThanOrEqual(28);
    const output = joined(
      renderQuestionView({ question: singleQ, state: makeState(), theme: stubTheme, width: 100, isSingle: true }),
    );
    expect(output).toContain("Battle-tested");
    expect(output).not.toContain("Embedded");
    expect(output).toContain(" │ ");
  });

  it("renders focused Other as an in-place editor with a surrogate-safe cursor", () => {
    const question: Question = { ...singleQ, multiSelect: true };
    const state = makeState({ mode: "freeform", savedOptionsCursorIndex: 2, draftText: "😀draft", cursorIndex: 0 });
    const output = joined(renderQuestionView({ question, state, theme: stubTheme, width: 60, isSingle: true }));
    expect(output).toContain("[ ]");
    expect(output).toContain("3. ");
    expect(output).toContain("\x1b[7m😀\x1b[27m");
    expect(output).toContain("Backspace deletes");
  });

  it("renders a saved Other preview and keeps narrow widths safe", () => {
    const state = makeState({ cursorIndex: 2, freeTextValue: "custom answer" });
    const output = joined(
      renderQuestionView({ question: singleQ, state, theme: stubTheme, width: 20, isSingle: true }),
    );
    expect(output).toContain("custom");
    expect(output).toContain("answer");
    expect(
      renderQuestionView({ question: singleQ, state: makeState(), theme: stubTheme, width: 1, isSingle: true }).length,
    ).toBeGreaterThan(0);
  });
});
