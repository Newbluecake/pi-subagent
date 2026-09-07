import { type Static, Type } from "@sinclair/typebox";

export const OTHER_LABEL = "Other";
export const HEADER_MAX_CHARS = 12;
export const QUESTION_MAX_CHARS = 1000;
export const SPLIT_PANE_MIN_WIDTH = 84;
export const SPLIT_PANE_SEPARATOR = " │ ";
export const SPLIT_PANE_LEFT_MIN = 32;
export const SPLIT_PANE_RIGHT_MIN = 28;

export const OptionSchema = Type.Object({
  label: Type.String({
    description:
      "Short, mutually exclusive option label (also the answer value returned to the LLM - keep it concise, <= ~40 chars). To recommend an option, prefix its label with '(Recommended)' and list it first.",
  }),
  description: Type.Optional(
    Type.String({
      description:
        "Short rationale shown under the label and in the split-pane preview. Helps the user decide; do not restate the label.",
    }),
  ),
});

export const QuestionSchema = Type.Object({
  question: Type.String({
    description:
      "Full question text. Must be one self-contained decision; avoid multi-part questions. <=1000 chars; plain single-line text only (no newlines or control characters).",
  }),
  header: Type.Optional(
    Type.String({
      description: "Tab label, <=12 chars, required when questions.length > 1. Omit for a single question.",
    }),
  ),
  context: Type.Optional(
    Type.String({
      description:
        "Short context summary shown above the question. Pass what you learned from read/grep so the user can answer without re-explaining.",
    }),
  ),
  options: Type.Array(OptionSchema, {
    minItems: 2,
    maxItems: 4,
    description:
      "2-4 mutually exclusive options. Each must be a defensible standalone answer; do NOT include an 'Other' option - it is added automatically.",
  }),
  multiSelect: Type.Optional(
    Type.Boolean({
      description:
        "Default false. Set true only when more than one option can validly apply simultaneously; otherwise leave it false for a single best answer.",
    }),
  ),
});

/**
 * The input schema deliberately accepts string option elements. This lets the
 * validation layer return a useful correction for a common model mistake.
 */
const InputOptionElementSchema = Type.Union([OptionSchema, Type.String()]);

export const InputSchema = Type.Object({
  questions: Type.Array(
    Type.Object({
      ...QuestionSchema.properties,
      options: Type.Array(InputOptionElementSchema, {
        minItems: 2,
        maxItems: 4,
        description:
          "2-4 mutually exclusive options. Each must be a {label, description} OBJECT, never a bare string; do NOT include an 'Other' option - it is added automatically.",
      }),
    }),
    {
      minItems: 1,
      maxItems: 4,
      description:
        "1-4 questions, each a single decision. Batch only related decisions that the user should resolve together; otherwise ask the most important one alone.",
    },
  ),
});

export type Option = Static<typeof OptionSchema>;
export type Question = Static<typeof QuestionSchema>;
export type InputQuestion = Static<typeof InputSchema>["questions"][number];

export const AnswerValueSchema = Type.Object({
  selected: Type.Array(Type.String()),
  other: Type.Union([Type.String(), Type.Null()]),
});

export type AnswerValue = Static<typeof AnswerValueSchema>;

export const ResultSchema = Type.Object({
  questions: Type.Array(QuestionSchema),
  answers: Type.Record(Type.String(), AnswerValueSchema),
  cancelled: Type.Boolean(),
});

export type Result = Static<typeof ResultSchema>;
export type AskUserDetails = Result;

export interface ThemeLike {
  fg(token: string, text: string): string;
  bg(token: string, text: string): string;
  bold(text: string): string;
}

export type QuestionMode = "options" | "freeform";

export interface QuestionState {
  cursorIndex: number;
  selectedIndex: number | null;
  selectedIndices: Set<number>;
  confirmed: boolean;
  freeTextValue: string | null;
  freeDraft: string | null;
  mode: QuestionMode;
  draftText: string;
  savedOptionsCursorIndex: number;
}

export function createQuestionState(): QuestionState {
  return {
    cursorIndex: 0,
    selectedIndex: null,
    selectedIndices: new Set<number>(),
    confirmed: false,
    freeTextValue: null,
    freeDraft: null,
    mode: "options",
    draftText: "",
    savedOptionsCursorIndex: 0,
  };
}

export const SURROGATE_HIGH_MASK = 0xfc00;
export const SURROGATE_HIGH_START = 0xd800;
export const SURROGATE_PAIR_LEN = 2;

export function isHighSurrogate(s: string, i: number): boolean {
  return (s.charCodeAt(i) & SURROGATE_HIGH_MASK) === SURROGATE_HIGH_START;
}
