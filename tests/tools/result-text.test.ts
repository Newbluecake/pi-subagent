import { describe, expect, it } from "vitest";
import { truncateResultText } from "../../src/tools/result-text.js";

describe("truncateResultText", () => {
  it("caps only the body and adds a transcript guide", () => {
    expect(truncateResultText("abcdefghij", 10)).toEqual({ text: "abcdefghij", truncated: false, totalChars: 10 });
    const result = truncateResultText("abcdefghij", 4, "/tmp/session.jsonl");
    expect(result.truncated).toBe(true);
    expect(result.totalChars).toBe(10);
    expect(result.text).toContain("abcd\n\n… [output truncated — showing first 4 of 10 chars]");
    expect(result.text).toContain("full session transcript: /tmp/session.jsonl");
    expect(truncateResultText("abcdef", 0).text).toBe("abcdef");
    expect(truncateResultText("abcdef", -1).text).toBe("abcdef");
  });

  it("backs up when the UTF-16 boundary would split a surrogate pair", () => {
    const result = truncateResultText("ab😀cd", 3);
    expect(result.totalChars).toBe(6);
    expect(result.text.startsWith("ab")).toBe(true);
    expect(result.text).not.toContain("\ud83d");
    expect(result.text).toContain("showing first 2 of 6 chars");
  });
});
