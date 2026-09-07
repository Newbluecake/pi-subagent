import { describe, expect, it } from "vitest";
import factory from "../../src/ask-user/index.js";
import { HEADER_MAX_CHARS, QUESTION_MAX_CHARS } from "../../src/ask-user/types.js";

const EXPECTED_SNIPPET =
  "Ask the user structured clarifying questions with options — only when you cannot resolve the ambiguity yourself";
const EXPECTED_DESCRIPTION = `Ask the user to resolve ambiguity you cannot resolve yourself. Use ONLY when ALL hold: (1) the request has ≥2 reasonable approaches, (2) you have already gathered context (read/grep) and the answer is still genuinely ambiguous, and (3) picking wrong means redoing real work. One question = one decision with mutually exclusive options.

Do NOT use this tool to outsource judgment you should make — if you can form a defensible recommendation from the codebase, proceed and state your choice. Do NOT use for trivia answerable by reading code/docs, or for simple confirmations ("I'll delete X") where plain text suffices. You cannot use this tool to collect free-form requirements, long-form feedback, or multi-paragraph input — it returns short selections only.

If you recommend an option, prefix its label with "(Recommended)" and list it first. For structured multi-option decisions, prefer this tool over plain-text questions; for everything else, reply in plain text.

Examples:
{"questions":[{"question":"Which DB?","context":"Need ACID + JSON columns.","options":[{"label":"(Recommended) Postgres","description":"Mature, strong consistency."},{"label":"SQLite","description":"Zero-ops, embedded."}]}]}

{"questions":[{"header":"DB","question":"Which database?","options":[{"label":"Postgres","description":"..."},{"label":"SQLite","description":"..."}]},{"header":"Region","question":"Which region?","options":[{"label":"us-east-1","description":"..."},{"label":"eu-west-1","description":"..."}]}]}

Don't:
- Passing options as a string array ("options":["A","B"]) — each option must be {"label","description"}.
- Forgetting header in multi-question mode (questions.length > 1).
- Flattening question/header/options to the top level — wrap them in questions:[...].
- Including an "Other" option — it is added automatically.`;
const EXPECTED_GUIDELINES = [
  "Use ask_user only when the request has ≥2 reasonable approaches you cannot resolve from context. Models over-ask because asking feels safer than deciding — resist this: if context makes the answer clear, proceed without asking.",
  "Gather context first (read/grep) and pass a short summary via the context field — don't ask blind. If the answer becomes clear after gathering context, proceed and state your choice.",
  "Ask focused questions; each question = one decision with mutually exclusive options. Batch related decisions into one call (1-4 questions).",
  "Do NOT use ask_user for trivia answerable by reading code/docs, or to confirm simple actions ('I'll delete X') — plain text suffices there.",
  "Do NOT outsource judgment you can make yourself: if you can form a defensible recommendation from the codebase, proceed and state it instead of asking.",
  "Do NOT include an 'Other' option yourself — it is always available automatically.",
];

function registeredTool(): any {
  let value: any;
  factory({
    registerTool: (tool: any) => {
      value = tool;
    },
  } as never);
  return value;
}

describe("registered prompt quality", () => {
  it("locks the prompt metadata values rather than source spelling", () => {
    const tool = registeredTool();
    expect(tool.promptSnippet).toBe(EXPECTED_SNIPPET);
    expect(tool.promptGuidelines).toEqual(EXPECTED_GUIDELINES);
    expect(tool.description).toBe(EXPECTED_DESCRIPTION);
    expect(tool.description).toContain('"options":[{"label"');
    expect(tool.description).toContain("Don't:");
    expect(tool.description).toContain('Passing options as a string array ("options":["A","B"])');
    expect(tool.description).toContain("Forgetting header in multi-question mode");
    expect(tool.description).toContain("Flattening question/header/options to the top level");
    expect(tool.description).toContain('Including an "Other" option');
  });

  it("keeps schema descriptions consistent with runtime validation thresholds", () => {
    const tool = registeredTool();
    const question = tool.parameters.properties.questions.items;
    expect(question.properties.question.description).toContain(`<=${QUESTION_MAX_CHARS} chars`);
    expect(question.properties.header.description).toContain(`<=${HEADER_MAX_CHARS} chars`);
    expect(question.properties.options.minItems).toBe(2);
    expect(question.properties.options.maxItems).toBe(4);
    expect(tool.parameters.properties.questions.minItems).toBe(1);
    expect(tool.parameters.properties.questions.maxItems).toBe(4);
  });
});
