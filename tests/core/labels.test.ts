import { describe, expect, it } from "vitest";
import {
  deriveUniqueLabel,
  firstNonEmptyLine,
  MAX_LABEL_BASE_LENGTH,
  MAX_LABEL_ATTEMPTS,
  sanitizeLabelBase,
} from "../../src/core/labels.js";

describe("labels", () => {
  it("sanitizes whitespace, controls, separators, and preserves symbols", () => {
    expect(sanitizeLabelBase("  sleep\t3  ")).toBe("sleep-3");
    expect(sanitizeLabelBase("a\u0000\u001fb")).toBe("a-b");
    expect(sanitizeLabelBase("---a---b---")).toBe("a-b");
    expect(sanitizeLabelBase("***")).toBe("***");
    expect(sanitizeLabelBase(" \n\t\r ")).toBeUndefined();
    expect(sanitizeLabelBase("中文 任务")).toBe("中文-任务");
  });

  it("truncates by code point without splitting emoji", () => {
    const value = "😀".repeat(MAX_LABEL_BASE_LENGTH);
    const result = sanitizeLabelBase(value);
    expect(result).toBe("😀".repeat(MAX_LABEL_BASE_LENGTH));
    expect([...result!]).toHaveLength(MAX_LABEL_BASE_LENGTH);
  });

  it("selects the first free suffix and handles exhaustion", () => {
    const taken = new Set(["x", "x-2"]);
    expect(deriveUniqueLabel("x", (label) => taken.has(label))).toBe("x-3");
    taken.add("x-3");
    expect(deriveUniqueLabel("x", (label) => taken.has(label))).toBe("x-4");
    expect(deriveUniqueLabel("x-2", (label) => label === "x-2")).toBe("x-2-2");
    expect(deriveUniqueLabel("x", () => true)).toBeUndefined();
    const base = "a".repeat(MAX_LABEL_BASE_LENGTH);
    expect(deriveUniqueLabel(base, (label) => label !== `${base}-999`)).toHaveLength(40);
    expect(MAX_LABEL_ATTEMPTS).toBe(999);
  });

  it("derives a prompt base from the first non-empty line", () => {
    expect(firstNonEmptyLine("\n\n  do this\nnext")).toBe("  do this");
    expect(firstNonEmptyLine("\u0000\u0001\nwork")).toBe("work");
    expect(firstNonEmptyLine("\n\t")).toBeUndefined();
  });
});
