import { describe, expect, it } from "vitest";
import {
  createChunkSanitizer,
  deleteCharBeforeCursor,
  insertAtCursor,
  moveCursorLeft,
  moveCursorRight,
} from "../../src/ask-user/editor-ops.js";
import { createQuestionState, type QuestionState } from "../../src/ask-user/types.js";

function stateWith(text: string, cursor = text.length): QuestionState {
  const state = createQuestionState();
  state.draftText = text;
  state.cursorIndex = cursor;
  return state;
}

describe("editor operations", () => {
  it("moves and deletes surrogate pairs as one code point", () => {
    const state = stateWith("a😀b");
    moveCursorLeft(state);
    expect(state.cursorIndex).toBe(3);
    moveCursorLeft(state);
    expect(state.cursorIndex).toBe(1);
    moveCursorRight(state);
    expect(state.cursorIndex).toBe(3);
    expect(deleteCharBeforeCursor(state)).toBe(true);
    expect(state.draftText).toBe("ab");
  });

  it("inserts at the UTF-16 cursor offset", () => {
    const state = stateWith("abc", 1);
    insertAtCursor(state, "X");
    expect(state.draftText).toBe("aXbc");
    expect(state.cursorIndex).toBe(2);
  });

  it("keeps ordinary printable chunks and filters controls", () => {
    const sanitize = createChunkSanitizer();
    expect(sanitize("a\tb\n😀")).toBe("ab😀");
  });

  it("removes bracketed paste markers and embedded CSI payload", () => {
    const sanitize = createChunkSanitizer();
    expect(sanitize("\x1b[200~a\x1b[31mRED\x1b[0mb\x1b[201~")).toBe("aREDb");
  });

  it("removes OSC hyperlinks but keeps visible text", () => {
    const sanitize = createChunkSanitizer();
    expect(sanitize("\x1b]8;;https://example.test\x07Visible\x1b]8;;\x07")).toBe("Visible");
  });

  it("removes Kitty CSI-u and string command sequences", () => {
    const sanitize = createChunkSanitizer();
    expect(sanitize("before\x1b[97;5uafter\x1bPsecret\x1b\\ok\x1b_Graphics\x1b\\!")).toBe("beforeafterok!");
  });

  it("retains an incomplete escape sequence for the next chunk", () => {
    const sanitize = createChunkSanitizer();
    expect(sanitize("\x1b")).toBe("");
    expect(sanitize("[31mRED")).toBe("RED");
  });

  it("does not let an unclosed sequence grow without bound", () => {
    const sanitize = createChunkSanitizer();
    expect(sanitize("\x1b[" + "1".repeat(100))).toBe("");
    expect(sanitize("visible")).toBe("visible");
  });
});
