import { describe, expect, it } from "vitest";
import { DEFAULT_SETTINGS, loadSettings, parseGoalSettings, TIME_SETTING_MS_PATHS } from "../../src/config/settings.js";
import { currentOf, defaultOf, isKnownSettingKey, SETTING_SPECS } from "../../src/config/setting-specs.js";

const defaults = DEFAULT_SETTINGS.goal;

describe("goal settings", () => {
  it("pins the defaults (goal-plan v4)", () => {
    expect(defaults).toEqual({
      enabled: true,
      maxTurns: 20,
      maxMinutes: 120,
      budgetTokens: 0,
      budgetCostUsd: 0,
      verifierType: "verifier",
      verifierModelHint: "cloudrouter-anthropic/claude-sonnet-5",
      evalTimeoutMs: 300_000,
      untilCmdTimeoutMs: 300_000,
      deliveryWatchdogMs: 30_000,
    });
  });

  it("falls back for missing and non-object blocks", () => {
    for (const input of [undefined, null, 0, "nope", true, [], [1, 2]]) {
      expect(parseGoalSettings(input)).toEqual(defaults);
    }
    expect(parseGoalSettings({})).toEqual(defaults);
  });

  it("tolerates garbage field-by-field and never throws", () => {
    expect(
      parseGoalSettings({
        enabled: "yes",
        maxTurns: -1,
        maxMinutes: 2.5,
        budgetTokens: Number.NaN,
        budgetCostUsd: 2.5,
        verifierType: "",
        verifierModelHint: 42,
        evalTimeoutMs: -5,
        untilCmdTimeoutMs: "fast",
        deliveryWatchdogMs: 5_000,
      }),
    ).toEqual({
      ...defaults,
      budgetCostUsd: 2.5,
      deliveryWatchdogMs: 5_000,
    });
    expect(parseGoalSettings({ enabled: false, maxTurns: 5 }).enabled).toBe(false);
    expect(parseGoalSettings({ enabled: false, maxTurns: 5 }).maxTurns).toBe(5);
  });

  it("is wired into loadSettings and normalizes *S time keys to milliseconds", () => {
    expect(loadSettings({ goal: "invalid" }).goal).toEqual(defaults);
    const loaded = loadSettings({
      goal: { evalTimeoutS: 10, untilCmdTimeoutS: 20, deliveryWatchdogS: 5, maxMinutes: 30 },
    });
    expect(loaded.goal.evalTimeoutMs).toBe(10_000);
    expect(loaded.goal.untilCmdTimeoutMs).toBe(20_000);
    expect(loaded.goal.deliveryWatchdogMs).toBe(5_000);
    expect(loaded.goal.maxMinutes).toBe(30); // 分钟字段，不在秒规约内
  });

  it("registers every duration field in TIME_SETTING_MS_PATHS", () => {
    for (const path of ["goal.evalTimeoutMs", "goal.untilCmdTimeoutMs", "goal.deliveryWatchdogMs"]) {
      expect(TIME_SETTING_MS_PATHS).toContain(path);
    }
    expect(TIME_SETTING_MS_PATHS).not.toContain("goal.maxMinutes");
  });

  it("exposes goal.* in SETTING_SPECS with resolvable defaults (v4 condition 9)", () => {
    const keys = [
      "goal.enabled",
      "goal.maxTurns",
      "goal.maxMinutes",
      "goal.budgetTokens",
      "goal.budgetCostUsd",
      "goal.verifierType",
      "goal.verifierModelHint",
      "goal.evalTimeoutS",
      "goal.untilCmdTimeoutS",
      "goal.deliveryWatchdogS",
    ];
    for (const key of keys) {
      expect(isKnownSettingKey(key), key).toBe(true);
      const spec = SETTING_SPECS[key]!;
      expect(defaultOf(spec), key).not.toBeUndefined();
      expect(currentOf(DEFAULT_SETTINGS, spec), key).not.toBe("(unset)");
    }
    // 秒域展示：defaultOf 把时间键换算成秒
    expect(defaultOf(SETTING_SPECS["goal.evalTimeoutS"]!)).toBe(300);
    expect(defaultOf(SETTING_SPECS["goal.deliveryWatchdogS"]!)).toBe(30);
  });
});
