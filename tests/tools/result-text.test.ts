import { describe, expect, it } from "vitest";
import { truncateResultText } from "../../src/tools/result-text.js";

describe("truncateResultText", () => {
  it("keeps head and tail, eliding the middle, and adds a transcript guide", () => {
    expect(truncateResultText("abcdefghij", 10)).toEqual({ text: "abcdefghij", truncated: false, totalChars: 10 });
    // maxChars 4 → head 70% = 2, tail 2; middle 6 elided.
    const result = truncateResultText("abcdefghij", 4, "/tmp/session.jsonl");
    expect(result.truncated).toBe(true);
    expect(result.totalChars).toBe(10);
    expect(result.text).toBe(
      "ab\n\n… [middle 6 of 10 chars omitted — showing first 2 + last 2]" +
        "; full session transcript: /tmp/session.jsonl — use the read tool to inspect it\n\nij",
    );
    expect(truncateResultText("abcdef", 0).text).toBe("abcdef");
    expect(truncateResultText("abcdef", -1).text).toBe("abcdef");
  });

  it("backs up the head cut when it would split a surrogate pair", () => {
    // "ab😀cd" = 6 UTF-16 units; maxChars 3 → head floor(2.1)=2 ("ab"), tail 1 ("d").
    const result = truncateResultText("ab😀cd", 3);
    expect(result.totalChars).toBe(6);
    expect(result.text.startsWith("ab")).toBe(true);
    expect(result.text.endsWith("d")).toBe(true);
    expect(result.text).not.toContain("\ud83d");
    expect(result.text).toContain("middle 3 of 6 chars omitted — showing first 2 + last 1");
  });

  it("advances the tail cut when it would split a surrogate pair", () => {
    // 70 x's + "😀" + 28 y's = 100 units; maxChars 96 → head 67, tail budget 29
    // → tailStart lands on the emoji's low surrogate and must advance past it.
    const text = "x".repeat(70) + "😀" + "y".repeat(28);
    const result = truncateResultText(text, 96);
    expect(result.truncated).toBe(true);
    expect(result.text).toContain("middle 5 of 100 chars omitted — showing first 67 + last 28");
    expect(result.text.startsWith("x".repeat(67))).toBe(true);
    expect(result.text.endsWith("y".repeat(28))).toBe(true);
    expect(result.text).not.toContain("😀");
    expect(result.text).not.toContain("\ude00");
  });
});
