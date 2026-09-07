import { decodeAnswer, decodeOther } from "./answer-codec.js";
import type { AnswerValue, Question } from "./types.js";

export const ASK_USER_MARKER = "\0XYZ_ASK_USER";

export interface AskUserOption {
  label: string;
  description?: string;
}

export interface AskUserQuestion {
  question: string;
  header?: string;
  context?: string;
  options: AskUserOption[];
  multiSelect?: boolean;
  allowOther?: boolean;
}

export type AskUserAnswers = Record<string, string>;

export interface GuiContext {
  mode: string;
  hasUI: boolean;
  ui?: {
    select?: (title: string, options: string[], opts?: { signal?: AbortSignal }) => Promise<string | undefined>;
  };
}

function stripUndefined(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map((item) => stripUndefined(item));
  }
  if (value !== null && typeof value === "object") {
    const result: Record<string, unknown> = {};
    for (const [key, item] of Object.entries(value)) {
      if (item !== undefined) result[key] = stripUndefined(item);
    }
    return result;
  }
  return value;
}

/** Guard the JSON value at the RPC boundary before any answer decoding. */
export function isAskUserAnswers(value: unknown): value is AskUserAnswers {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    return false;
  }

  return Object.values(value).every((item) => typeof item === "string");
}

export async function askUserInteract(
  ctx: GuiContext,
  questions: AskUserQuestion[],
  opts: { signal?: AbortSignal | undefined; allowCancel?: boolean } = {},
): Promise<AskUserAnswers | null> {
  if (questions.length === 0) return {};

  const select = ctx.ui?.select;
  if (ctx.mode !== "rpc" || select === undefined) {
    throw new Error("askUserInteract() is only available in RPC mode with a select UI");
  }

  const payload = JSON.stringify(
    stripUndefined({
      questions,
      allowCancel: opts.allowCancel ?? true,
    }),
  );
  const raw = await select(ASK_USER_MARKER, [payload], opts.signal === undefined ? {} : { signal: opts.signal });
  if (raw === undefined) return null;

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }

  return isAskUserAnswers(parsed) ? parsed : null;
}

/** Convert internal questions to the stable ask_user RPC question shape. */
export function toProtoQuestions(questions: Question[]): AskUserQuestion[] {
  return questions.map((question) => ({
    ...(question.header !== undefined ? { header: question.header } : {}),
    question: question.question,
    ...(question.context !== undefined ? { context: question.context } : {}),
    options: question.options.map((option) => ({
      label: option.label,
      ...(option.description !== undefined ? { description: option.description } : {}),
    })),
    ...(question.multiSelect !== undefined ? { multiSelect: question.multiSelect } : {}),
    allowOther: true,
  }));
}

/**
 * Convert RPC answers back to the internal result answer map.
 * Multi-select labels are normalized to the order declared by the question;
 * unknown labels remain at the end so malformed-but-valid wire values are not
 * silently discarded.
 */
export function protoAnswersToResult(
  questions: Question[],
  protoQuestions: AskUserQuestion[],
  answers: AskUserAnswers,
): Record<string, AnswerValue> {
  const result: Record<string, AnswerValue> = {};

  for (let index = 0; index < questions.length; index += 1) {
    const question = questions[index];
    const protoQuestion = protoQuestions[index];
    if (question === undefined || protoQuestion === undefined) continue;

    const key = protoQuestion.header ?? protoQuestion.question;
    const decoded = decodeAnswer(answers, key, protoQuestion.multiSelect === true);
    const other = decodeOther(answers, key) ?? null;

    let selected: string[];
    if (Array.isArray(decoded)) {
      const order = new Map(question.options.map((option, optionIndex) => [option.label, optionIndex]));
      selected = decoded
        .map((label, responseIndex) => ({
          label,
          responseIndex,
          optionIndex: order.get(label) ?? question.options.length,
        }))
        .sort((left, right) => left.optionIndex - right.optionIndex || left.responseIndex - right.responseIndex)
        .map((item) => item.label);
    } else if (decoded !== undefined && decoded !== "") {
      selected = [decoded];
    } else {
      selected = [];
    }

    if (selected.length === 0 && other === null) continue;
    result[question.question] = { selected, other };
  }

  return result;
}
