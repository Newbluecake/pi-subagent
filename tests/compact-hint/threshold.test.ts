import { describe, expect, it } from "vitest";
import {
  buildCompactHintText,
  buildUsageTickText,
  effectiveThresholdPercent,
  maxThresholdPercent,
  usageTickStep,
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

  it("computes usage tick steps from the first step up to the ceiling", () => {
    expect(usageTickStep(5, 10, 75)).toBe(0); // below the first step
    expect(usageTickStep(25, 10, 75)).toBe(20); // no floor: ticks start at 10%
    expect(usageTickStep(30, 10, 75)).toBe(30);
    expect(usageTickStep(39.9, 10, 75)).toBe(30);
    expect(usageTickStep(70, 10, 75)).toBe(70);
    expect(usageTickStep(75, 10, 75)).toBe(0); // at/above the ceiling (force zone)
    expect(usageTickStep(45, 15, 75)).toBe(45); // custom step grid
    expect(usageTickStep(50, 0, 75)).toBe(0); // disabled
  });

  it("builds the usage tick text below, at/above the hint ceiling, and without one", () => {
    expect(buildUsageTickText(42, 75)).toContain("42%");
    expect(buildUsageTickText(42, 75)).toContain("75%");
    expect(buildUsageTickText(42, 75)).toContain("无需操作");
    expect(buildUsageTickText(80, 75)).toContain("已超过提醒阈值 75%");
    expect(buildUsageTickText(80, 75)).toContain("compact_context");
    expect(buildUsageTickText(42, 0)).not.toContain("compact_context");
  });
});
