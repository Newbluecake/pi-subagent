import { describe, expect, it } from "vitest";

import {
  ASK_USER_MARKER,
  askUserInteract,
  isAskUserAnswers,
  protoAnswersToResult,
  toProtoQuestions,
  type AskUserQuestion,
  type GuiContext,
} from "../../src/ask-user/channel-handler.js";
import type { Question } from "../../src/ask-user/types.js";

const protoQuestion: AskUserQuestion = {
  question: "Which DB?",
  options: [{ label: "Postgres", description: "Server" }, { label: "SQLite" }],
};

function rpcContext(select: NonNullable<GuiContext["ui"]>["select"]): GuiContext {
  return { mode: "rpc", hasUI: true, ui: { select } };
}

describe("askUserInteract", () => {
  it("sends the marker and JSON payload through select", async () => {
    let call: { title: string; options: string[]; signal?: AbortSignal } | undefined;
    const signal = new AbortController().signal;
    const answers = { "Which DB?": "Postgres" };
    const result = await askUserInteract(
      rpcContext(async (title, options, optionsArg) => {
        call = { title, options, signal: optionsArg?.signal };
        return JSON.stringify(answers);
      }),
      [protoQuestion],
      { signal, allowCancel: false },
    );

    expect(result).toEqual(answers);
    expect(call).toEqual({
      title: ASK_USER_MARKER,
      options: [JSON.stringify({ questions: [protoQuestion], allowCancel: false })],
      signal,
    });
  });

  it("defaults allowCancel to true and returns an empty object for no questions", async () => {
    let payload = "";
    const result = await askUserInteract(
      rpcContext(async (_title, options) => {
        payload = options[0] ?? "";
        return JSON.stringify({});
      }),
      [protoQuestion],
    );
    expect(result).toEqual({});
    expect(JSON.parse(payload)).toMatchObject({ allowCancel: true });
    expect(await askUserInteract({ mode: "print", hasUI: false }, [])).toEqual({});
  });

  it("maps cancellation and parse failures to null", async () => {
    for (const value of [undefined, "not-json"]) {
      await expect(
        askUserInteract(
          rpcContext(async () => value),
          [protoQuestion],
        ),
      ).resolves.toBeNull();
    }
  });

  it.each(["null", '"str"', "[1,2]", '{"k":1}'])(
    "rejects an invalid top-level payload without throwing: %s",
    async (raw) => {
      await expect(
        askUserInteract(
          rpcContext(async () => raw),
          [protoQuestion],
        ),
      ).resolves.toBeNull();
    },
  );

  it("requires RPC mode and a select function for non-empty questions", async () => {
    await expect(askUserInteract({ mode: "tui", hasUI: true }, [protoQuestion])).rejects.toThrow(
      "only available in RPC mode",
    );
    await expect(askUserInteract({ mode: "rpc", hasUI: true }, [protoQuestion])).rejects.toThrow("select UI");
  });
});

describe("RPC question and answer conversion", () => {
  it("adds allowOther and preserves question fields", () => {
    const question: Question = {
      question: "Pick",
      header: "Mode",
      context: "Context",
      options: [{ label: "A", description: "first" }, { label: "B" }],
      multiSelect: true,
    };
    expect(toProtoQuestions([question])).toEqual([
      {
        question: "Pick",
        header: "Mode",
        context: "Context",
        options: [{ label: "A", description: "first" }, { label: "B" }],
        multiSelect: true,
        allowOther: true,
      },
    ]);
  });

  it("decodes single, reordered multi-select, Other, and skips unanswered questions", () => {
    const questions: Question[] = [
      { question: "Q1", options: [{ label: "A" }, { label: "B" }] },
      {
        question: "Q2",
        header: "Second",
        multiSelect: true,
        options: [{ label: "X" }, { label: "Y" }, { label: "Z" }],
      },
      { question: "Q3", header: "Third", options: [{ label: "M" }, { label: "N" }] },
      { question: "Q4", header: "Fourth", options: [{ label: "P" }, { label: "Q" }] },
    ];
    const protoQuestions = toProtoQuestions(questions);
    const result = protoAnswersToResult(questions, protoQuestions, {
      Q1: "A",
      Second: '["Z","X"]',
      Third__other: "custom",
      Fourth: "",
    });

    expect(result).toEqual({
      Q1: { selected: ["A"], other: null },
      Q2: { selected: ["X", "Z"], other: null },
      Q3: { selected: [], other: "custom" },
    });
  });

  it("guards the payload at runtime", () => {
    expect(isAskUserAnswers(null)).toBe(false);
    expect(isAskUserAnswers([])).toBe(false);
    expect(isAskUserAnswers({ answer: "A" })).toBe(true);
    expect(isAskUserAnswers({ answer: 1 })).toBe(false);
  });
});
