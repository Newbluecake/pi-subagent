import { Box, Text, TruncatedText, truncateToWidth } from "@earendil-works/pi-tui";
import type {
  AgentToolResult,
  AgentToolUpdateCallback,
  ExtensionAPI,
  ExtensionContext,
  ToolRenderResultOptions,
} from "@earendil-works/pi-coding-agent";
import { type Static } from "@sinclair/typebox";

import { askUserInteract, protoAnswersToResult, toProtoQuestions } from "./channel-handler.js";
import type { AskUserDetails, AnswerValue, Option, Question, Result, ThemeLike } from "./types.js";
import { HEADER_MAX_CHARS, InputSchema } from "./types.js";
import { AskUserComponent } from "./component.js";
import { answerValueText } from "./submit-view.js";
import { validateInput } from "./validate.js";

/**
 * execute returns the SDK's normal tool result. Errors are thrown so Pi can
 * attach its error state; cancellation is a successful result with details.
 */
type ExecuteResult = AgentToolResult<AskUserDetails>;
type RenderContext = { isError: boolean };

const AGENT_ABORTED_TEXT =
  "Agent aborted (goal cancelled, context compacted, or session switched). Do not assume an answer; do not retry ask_user — propagate the abort, or wait for new instructions if the decision is still required.";
const USER_CANCELLED_TEXT =
  "User cancelled. Do not assume an answer or continue the task — wait for new instructions or re-ask with refined options if the decision is still required.";
const HEADLESS_TEXT =
  "Error: ask_user requires an interactive session. The tool has been disabled for this session. Do not retry — proceed without user input (make a defensible decision and state it) or wait for the user to reconnect.";

function disableAskUser(pi: ExtensionAPI): void {
  pi.setActiveTools(
    pi
      .getAllTools()
      .map((tool) => tool.name)
      .filter((name) => name !== "ask_user"),
  );
}

function cancelledResult(questions: Question[], text: string): ExecuteResult {
  return {
    content: [{ type: "text", text }],
    details: { questions, answers: {}, cancelled: true } satisfies Result,
  };
}

async function runTuiInteraction(
  questions: Question[],
  signal: AbortSignal | undefined,
  ctx: ExtensionContext,
): Promise<Result | null> {
  return ctx.ui.custom<Result | null>((tui, theme, _keybindings, done) => {
    const component = new AskUserComponent(questions, tui, theme as ThemeLike, done);
    if (signal) signal.addEventListener("abort", () => component.cancel(), { once: true });
    return component;
  });
}

async function runRpcInteraction(
  questions: Question[],
  signal: AbortSignal | undefined,
  ctx: ExtensionContext,
): Promise<Result> {
  const protoQuestions = toProtoQuestions(questions);
  const answers = await askUserInteract(
    {
      mode: ctx.mode,
      hasUI: ctx.hasUI,
      ui: { select: ctx.ui.select.bind(ctx.ui) },
    },
    protoQuestions,
    { signal, allowCancel: true },
  );
  if (answers === null) return { questions, answers: {}, cancelled: true };
  return { questions, answers: protoAnswersToResult(questions, protoQuestions, answers), cancelled: false };
}

type Outcome =
  | { kind: "completed"; result: Result }
  | { kind: "agent-aborted"; result: null }
  | { kind: "user-cancelled"; result: null };

/**
 * The only cancellation classification point. A submitted result wins a
 * submit/abort race; otherwise the signal distinguishes agent abort from Esc.
 */
function classifyOutcome(result: Result | null, signal: AbortSignal | undefined): Outcome {
  if (result !== null && !result.cancelled) return { kind: "completed", result };
  if (signal?.aborted) return { kind: "agent-aborted", result: null };
  return { kind: "user-cancelled", result: null };
}

function renderExpandedOptions(q: Question, answer: AnswerValue | undefined, theme: ThemeLike): TruncatedText[] {
  const selected = new Set(answer?.selected ?? []);
  return q.options.map(
    (option: Option) =>
      new TruncatedText(
        `${theme.fg("dim", "   ")}${selected.has(option.label) ? theme.fg("success", "●") : theme.fg("dim", "○")}${theme.fg("text", ` ${option.label}`)}`,
        0,
        0,
      ),
  );
}

const DESCRIPTION = `Ask the user to resolve ambiguity you cannot resolve yourself. Use ONLY when ALL hold: (1) the request has ≥2 reasonable approaches, (2) you have already gathered context (read/grep) and the answer is still genuinely ambiguous, and (3) picking wrong means redoing real work. One question = one decision with mutually exclusive options.

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

export default function (pi: ExtensionAPI): void {
  pi.registerTool({
    name: "ask_user",
    label: "Ask User",
    description: DESCRIPTION,
    promptSnippet:
      "Ask the user structured clarifying questions with options — only when you cannot resolve the ambiguity yourself",
    promptGuidelines: [
      "Use ask_user only when the request has ≥2 reasonable approaches you cannot resolve from context. Models over-ask because asking feels safer than deciding — resist this: if context makes the answer clear, proceed without asking.",
      "Gather context first (read/grep) and pass a short summary via the context field — don't ask blind. If the answer becomes clear after gathering context, proceed and state your choice.",
      "Ask focused questions; each question = one decision with mutually exclusive options. Batch related decisions into one call (1-4 questions).",
      "Do NOT use ask_user for trivia answerable by reading code/docs, or to confirm simple actions ('I'll delete X') — plain text suffices there.",
      "Do NOT outsource judgment you can make yourself: if you can form a defensible recommendation from the codebase, proceed and state it instead of asking.",
      "Do NOT include an 'Other' option yourself — it is always available automatically.",
    ],
    parameters: InputSchema,

    async execute(
      _toolCallId: string,
      params: Static<typeof InputSchema>,
      signal: AbortSignal | undefined,
      _onUpdate: AgentToolUpdateCallback<AskUserDetails> | undefined,
      ctx: ExtensionContext,
    ): Promise<ExecuteResult> {
      const questions = params.questions as Question[];
      const validationError = validateInput(params.questions);
      if (validationError) throw new Error(`Error: ${validationError}`);

      if (ctx.mode !== "tui" && ctx.mode !== "rpc") {
        disableAskUser(pi);
        throw new Error(HEADLESS_TEXT);
      }

      if (signal?.aborted) return cancelledResult(questions, AGENT_ABORTED_TEXT);

      let interactionResult: Result | null;
      try {
        interactionResult =
          ctx.mode === "rpc"
            ? await runRpcInteraction(questions, signal, ctx)
            : await runTuiInteraction(questions, signal, ctx);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        if (ctx.mode === "rpc") disableAskUser(pi);
        throw new Error(
          ctx.mode === "rpc"
            ? `ask_user failed: ${message}. The tool has been disabled for this session. Do not retry — proceed without user input (make a defensible decision and state it) or wait for the user to reconnect.`
            : `ask_user failed: ${message}. Treat as cancelled — do not assume an answer; retry the call with corrected parameters, or proceed with a defensible decision if the user cannot be reached.`,
        );
      }

      const outcome = classifyOutcome(interactionResult, signal);
      if (outcome.kind === "agent-aborted") return cancelledResult(questions, AGENT_ABORTED_TEXT);
      if (outcome.kind === "user-cancelled") return cancelledResult(questions, USER_CANCELLED_TEXT);

      const result = outcome.result;
      return {
        content: [
          {
            type: "text",
            text: result.questions
              .map((question) => {
                const answer = result.answers[question.question];
                return `"${question.question}" = "${answer ? answerValueText(answer) : "(no answer)"}"`;
              })
              .join("\n"),
          },
        ],
        details: result satisfies Result,
      };
    },

    renderCall(args: Static<typeof InputSchema>, theme: ThemeLike, _context: RenderContext): TruncatedText {
      const questions = (args.questions ?? []) as Question[];
      const topics = questions
        .map((question) => question.header ?? truncateToWidth(question.question, HEADER_MAX_CHARS))
        .join(", ");
      return new TruncatedText(theme.fg("toolTitle", theme.bold("ask_user ")) + theme.fg("muted", topics), 0, 0);
    },

    renderResult(
      result: AgentToolResult<AskUserDetails>,
      options: ToolRenderResultOptions,
      theme: ThemeLike,
      context: RenderContext,
    ) {
      if (context.isError) {
        const text = result.content.find((item) => item.type === "text")?.text ?? "ask_user failed";
        return new Text(theme.fg("error", `✗ ${text}`), 0, 0);
      }
      const details = result.details;
      if (!details || details.cancelled) return new Text(theme.fg("warning", "Cancelled"), 0, 0);

      const box = new Box(0, 0);
      for (const question of details.questions) {
        const header = question.header ?? truncateToWidth(question.question, HEADER_MAX_CHARS);
        const answer = details.answers[question.question];
        box.addChild(
          new TruncatedText(
            theme.fg("success", "✓ ") +
              theme.fg("accent", `${header}: `) +
              theme.fg("text", answer ? answerValueText(answer) : "(no answer)"),
            0,
            0,
          ),
        );
        if (options.expanded) for (const child of renderExpandedOptions(question, answer, theme)) box.addChild(child);
      }
      return box;
    },
  });
}
