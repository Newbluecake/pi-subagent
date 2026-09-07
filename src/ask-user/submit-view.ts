import { truncateToWidth } from "@earendil-works/pi-tui";
import {
  HEADER_MAX_CHARS,
  type AnswerValue,
  type Question,
  type QuestionState,
  type Result,
  type ThemeLike,
} from "./types.js";

export function renderButtonBar(theme: ThemeLike, allDone: boolean, focus: "submit" | "cancel" | null): string {
  const submit =
    focus === "submit"
      ? allDone
        ? theme.fg("success", theme.bold(" Submit "))
        : theme.fg("accent", theme.bold(" Submit "))
      : allDone
        ? theme.fg("success", " Submit ")
        : theme.fg("dim", " Submit ");
  const cancel = focus === "cancel" ? theme.fg("accent", theme.bold(" Cancel ")) : theme.fg("muted", " Cancel ");
  return `${theme.fg("dim", "[")}${submit}${theme.fg("dim", "]")}   ${theme.fg("dim", "[")}${cancel}${theme.fg("dim", "]")}`;
}

export function answerValueText(value: AnswerValue): string {
  const parts = [...value.selected];
  if (value.other !== null && value.other !== "") parts.push(value.other);
  return parts.join(", ");
}

export function getAnswerText(q: Question, state: QuestionState): AnswerValue | null {
  if (!state.confirmed) return null;
  const selected: string[] = [];
  if (q.multiSelect) {
    [...state.selectedIndices]
      .sort((a, b) => a - b)
      .map((index) => q.options[index]?.label)
      .filter((label): label is string => label !== undefined)
      .forEach((label) => selected.push(label));
  } else if (state.selectedIndex !== null) {
    const label = q.options[state.selectedIndex]?.label;
    if (label !== undefined) selected.push(label);
  }
  if (selected.length === 0 && (state.freeTextValue === null || state.freeTextValue === "")) return null;
  return { selected, other: state.freeTextValue };
}

export function renderSubmitView(
  questions: Question[],
  states: QuestionState[],
  theme: ThemeLike,
  width: number,
  focus: "submit" | "cancel" = "submit",
): string[] {
  const allDone = questions.every((question, index) => getAnswerText(question, states[index]!) !== null);
  const lines: string[] = [];
  const add = (line: string): void => {
    lines.push(truncateToWidth(line, width));
  };

  add(
    allDone
      ? theme.fg("success", theme.bold(" Ready to submit"))
      : theme.fg("warning", theme.bold(" Unanswered questions")),
  );
  add("");
  questions.forEach((question, index): void => {
    const answer = getAnswerText(question, states[index]!);
    const header = truncateToWidth(question.header ?? "", HEADER_MAX_CHARS);
    add(
      answer
        ? ` ${theme.fg("muted", `${header}: `)}${theme.fg("text", answerValueText(answer))}`
        : ` ${theme.fg("dim", `${header}: `)}${theme.fg("warning", "—")}`,
    );
  });
  add("");
  if (allDone) add(theme.fg("success", " All questions answered"));
  else {
    const missing = questions
      .filter((question, index) => getAnswerText(question, states[index]!) === null)
      .map((question) => truncateToWidth(question.header ?? "", HEADER_MAX_CHARS))
      .join(", ");
    add(theme.fg("warning", ` Still needed: ${missing}`));
  }
  add("");
  add(renderButtonBar(theme, allDone, focus));
  add("");
  add(theme.fg("dim", " ←/→ navigate · Tab toggle Submit/Cancel · Enter confirm · Esc back"));
  return lines;
}

export function buildResult(questions: Question[], states: QuestionState[]): Result {
  const answers: Record<string, AnswerValue> = {};
  questions.forEach((question, index): void => {
    const answer = getAnswerText(question, states[index]!);
    if (answer !== null) answers[question.question] = answer;
  });
  return { questions, answers, cancelled: false };
}
