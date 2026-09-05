import { describe, expect, it } from "vitest";
import {
  buildCompactHintText,
  effectiveThresholdPercent,
  maxThresholdPercent,
} from "../../src/compact-hint/threshold.js";

describe("compact hint thresholds", () => {
  it("matches the exact reserve matrix", () => {
    for (const [window, expected] of [
      [32000, 48],
      [32768, 50],
      [64000, 74],
      [65536, 75],
      [128000, 87],
      [131072, 87],
      [200000, 91],
      [262144, 93],
    ] as const)
      expect(maxThresholdPercent(window, 16384)).toBe(expected);
  });
  it("handles reserve overrides and invalid windows", () => {
    expect(maxThresholdPercent(128000, 32768)).toBe(74);
    expect(maxThresholdPercent(200000, 32768)).toBe(83);
    expect(maxThresholdPercent(262144, 32768)).toBe(87);
    expect(maxThresholdPercent(0, 1)).toBe(0);
    expect(maxThresholdPercent(Number.NaN, 1)).toBe(0);
    expect(effectiveThresholdPercent(0, 100000, 1)).toBe(0);
    expect(effectiveThresholdPercent(60, 100000, 1)).toBe(60);
  });
  it("builds the bilingual hint", () => {
    expect(buildCompactHintText(80, 75)).toContain("80%");
    expect(buildCompactHintText(80, 75)).toContain("compact_context");
    expect(buildCompactHintText(80, 75)).toContain("压缩不是终止");
    expect(buildCompactHintText(80, 75, 88)).toContain("\n\n建议");
    expect(buildCompactHintText(80, 75, 88)).toContain("- 若用量继续涨至 88%");
    expect(buildCompactHintText(80, 75, 88)).toContain("- 压缩不是终止");
    expect(buildCompactHintText(80, 75, 0)).not.toContain("强制压缩");
  });
});
