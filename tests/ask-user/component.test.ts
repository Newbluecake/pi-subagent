import { describe, expect, it } from "vitest";
import { AskUserComponent } from "../../src/ask-user/component.js";
import type { Question, Result } from "../../src/ask-user/types.js";
import {
  DOWN,
  ENTER,
  ESC,
  LEFT,
  RIGHT,
  TAB,
  BKSP,
  mockTui,
  multiQ,
  singleQ,
  singleQMulti,
  stubTheme,
} from "./fixtures.js";

function make(questions: Question[], onActivity?: () => void) {
  const calls: Array<Result | null> = [];
  const c = new AskUserComponent(questions, mockTui, stubTheme, (result) => calls.push(result), { onActivity });
  return { c, calls };
}

describe("AskUserComponent", () => {
  it("submits a single selection and has no tab bar", () => {
    const { c, calls } = make([singleQ]);
    expect(c.render(60).join("\n")).not.toContain("Submit");
    c.handleInput(ENTER);
    expect(calls).toHaveLength(1);
    expect(calls[0]?.answers["Which DB?"]).toEqual({ selected: ["Postgres"], other: null });
  });

  it("supports multi-select and auto-confirms answered tabs", () => {
    const { c, calls } = make(multiQ);
    c.handleInput(ENTER);
    c.handleInput(ENTER);
    c.handleInput(ENTER);
    c.handleInput(ENTER);
    c.handleInput(ENTER);
    expect(calls[0]?.cancelled).toBe(false);
    expect(calls[0]?.answers.Q1).toEqual({ selected: ["A"], other: null });
  });

  it("keeps freeDraft separate from the formal answer and blocks submit after discard", () => {
    const { c, calls } = make(multiQ);
    c.handleInput(DOWN);
    c.handleInput(DOWN);
    c.handleInput(ENTER);
    c.handleInput("draft");
    c.handleInput(ESC);
    c.handleInput(RIGHT);
    c.handleInput(RIGHT);
    c.handleInput(RIGHT);
    c.handleInput(ENTER);
    expect(calls).toHaveLength(0);
    const visible = c.render(80).join("\n");
    expect(visible).toContain("Unanswered questions");
  });

  it("Other Enter clears a single selection and submits the freeform answer", () => {
    const { c, calls } = make([singleQ]);
    c.handleInput(DOWN);
    c.handleInput(DOWN);
    c.handleInput(ENTER);
    c.handleInput("custom");
    c.handleInput(ENTER);
    expect(calls[0]?.answers["Which DB?"]).toEqual({ selected: [], other: "custom" });
  });

  it("allows multi-select options and Other to coexist", () => {
    const { c, calls } = make([singleQMulti]);
    c.handleInput(" ");
    c.handleInput(DOWN);
    c.handleInput(DOWN);
    c.handleInput(ENTER);
    c.handleInput("redis");
    c.handleInput(ENTER);
    expect(calls[0]?.answers["Which features?"]).toEqual({ selected: ["Auth"], other: "redis" });
  });

  it("uses an Esc confirmation overlay and resolves only once", () => {
    const { c, calls } = make([singleQ]);
    c.handleInput(ESC);
    expect(calls).toHaveLength(0);
    expect(c.render(60).join("\n")).toContain("Cancel all");
    c.handleInput(ESC);
    c.cancel();
    c.handleInput(ENTER);
    expect(calls).toEqual([null]);
  });

  it("caches render output and invalidates after input", () => {
    const { c } = make([singleQ]);
    const first = c.render(60);
    expect(c.render(60)).toBe(first);
    c.handleInput(DOWN);
    expect(c.render(60)).not.toBe(first);
  });

  it("navigates Submit focus with Tab and enforces a non-empty gate", () => {
    const { c, calls } = make(multiQ);
    c.handleInput(RIGHT);
    c.handleInput(RIGHT);
    c.handleInput(RIGHT);
    c.handleInput(ENTER);
    expect(calls).toHaveLength(0);
    c.handleInput(TAB);
    expect(c.render(80).join("\n")).toContain("Cancel");
    c.handleInput(ENTER);
    expect(calls).toEqual([null]);
  });

  it("emits activity for input and ignores input after resolution", () => {
    const activity = [] as number[];
    const { c } = make([singleQ], () => activity.push(1));
    c.handleInput(DOWN);
    c.handleInput(ENTER);
    c.handleInput(DOWN);
    expect(activity).toHaveLength(2);
  });

  it("deletes emoji safely in freeform", () => {
    const { c } = make([singleQ]);
    c.handleInput(DOWN);
    c.handleInput(DOWN);
    c.handleInput(ENTER);
    c.handleInput("a😀");
    c.handleInput(BKSP);
    expect(c.render(60).join("\n")).toContain("a");
    expect(c.render(60).join("\n")).not.toContain("😀");
  });
});
