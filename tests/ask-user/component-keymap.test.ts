import { describe, expect, it } from "vitest";
import { AskUserComponent } from "../../src/ask-user/component.js";
import { DOWN, ENTER, LEFT, RIGHT, HOME, END, BKSP, singleQ, stubTheme, mockTui } from "./fixtures.js";

function openFreeform() {
  const c = new AskUserComponent([singleQ], mockTui, stubTheme, () => {});
  c.handleInput(DOWN);
  c.handleInput(DOWN);
  c.handleInput(ENTER);
  return c;
}
function editorText(c: AskUserComponent): string {
  const line = c.render(80).find((value) => value.includes("\x1b[7m")) ?? "";
  return line.replace(/\x1b\[[0-9;]*m/g, "");
}

describe("AskUserComponent key routing", () => {
  it("does not leak arrows or modifier CSI into freeform text", () => {
    const c = openFreeform();
    c.handleInput(RIGHT);
    c.handleInput(LEFT);
    c.handleInput("x");
    c.handleInput("\x1b[1;5D");
    c.handleInput("\x1b[97;5u");
    c.handleInput("y");
    expect(editorText(c)).toContain("xy");
    expect(editorText(c)).not.toContain("[1;5D");
    expect(editorText(c)).not.toContain("97;5u");
  });

  it("treats unrecognized paste as text only after sanitizing all control sequences", () => {
    const c = openFreeform();
    c.handleInput("\x1b[200~a\x1b[31mRED\x1b[0mb\x1b[201~");
    expect(editorText(c)).toContain("aREDb");
    expect(editorText(c)).not.toContain("[31m");
  });

  it("keeps standard editor keys and ignores other special keys", () => {
    const c = openFreeform();
    c.handleInput("abc");
    c.handleInput(HOME);
    c.handleInput("X");
    c.handleInput(END);
    c.handleInput(BKSP);
    expect(editorText(c)).toContain("Xab");
  });
});
