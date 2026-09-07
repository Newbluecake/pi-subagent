import { HEADER_MAX_CHARS, type InputQuestion, QUESTION_MAX_CHARS } from "./types.js";

const CONTROL_CHAR_RE = /[\x00-\x1f\x7f]/;
const ERROR_PREVIEW_CHARS = 20;

/**
 * Validate semantic constraints that are intentionally left outside TypeBox.
 * The input schema keeps string options permissive so this layer can provide a
 * useful correction instead of exposing a generic "must be object" error.
 */
export function validateInput(questions: InputQuestion[]): string | null {
  const seenQuestions = new Set<string>();

  // Steps 1-6 are question-local and deliberately run before all header checks.
  for (const q of questions) {
    const question = q.question;

    if (question.length > QUESTION_MAX_CHARS) {
      return `Question text exceeds ${QUESTION_MAX_CHARS} chars: "${question.slice(0, ERROR_PREVIEW_CHARS)}...". Shorten it to a single concise decision; move extra context into the context field.`;
    }

    if (CONTROL_CHAR_RE.test(question)) {
      return `Question text must not contain control characters (incl. newlines): "${question.slice(0, ERROR_PREVIEW_CHARS)}...". Use plain single-line text; split multi-part questions into separate entries.`;
    }

    if (seenQuestions.has(question)) {
      return `Duplicate question: "${question}". Each question text must be unique; merge duplicates or rephrase one to differ.`;
    }
    seenQuestions.add(question);

    const seenLabels = new Set<string>();
    for (const option of q.options) {
      if (typeof option === "string") {
        return `Options for question "${question}" must be an array of {label, description} objects, not strings. Correct: "options":[{"label":"A","description":"..."},{"label":"B","description":"..."}]`;
      }

      if (option.label.trim().toLowerCase() === "other") {
        return `Do not include an "Other" option — it is added automatically. Remove it from "options".`;
      }

      if (option.label.trim() === "") {
        return `Option label must not be empty in question "${question}". Give every option a distinct, descriptive label.`;
      }

      if (seenLabels.has(option.label)) {
        return `Duplicate option label "${option.label}" in question "${question}". Options must be mutually exclusive — reword one so each label maps to a distinct choice.`;
      }
      seenLabels.add(option.label);
    }
  }

  // Step 7: required and unique headers are checked together, before length.
  if (questions.length > 1) {
    for (const q of questions) {
      if (q.header === undefined || q.header.trim() === "") {
        return `Question "${q.question}" requires a non-empty header in multi-question mode (it labels the tab). Provide a header of <=12 chars. Correct: {"header":"DB","question":"...","options":[{"label":"...","description":"..."}]}`;
      }
    }

    const seenHeaders = new Set<string>();
    for (const q of questions) {
      const header = q.header!.trim();
      if (seenHeaders.has(header)) {
        return `Duplicate header "${header}" in questions. Headers must be unique in multi-question mode — shared headers cause answer key collisions (one question's Other overwrites another's). Rephrase one header to differ.`;
      }
      seenHeaders.add(header);
    }
  }

  // Step 8: validate supplied headers in both single- and multi-question mode.
  for (const q of questions) {
    if (q.header !== undefined && q.header.length > HEADER_MAX_CHARS) {
      return `Header exceeds ${HEADER_MAX_CHARS} chars: "${q.header.slice(0, ERROR_PREVIEW_CHARS)}..." in question "${q.question}". Shorten it; longer headers are truncated in the tab bar.`;
    }
  }

  return null;
}
