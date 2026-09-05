import { describe, expect, it } from "vitest";
import { DEFAULT_SETTINGS, loadSettings, parseCompactSettings } from "../../src/config/settings.js";

const defaults = DEFAULT_SETTINGS.compact;

describe("compact settings", () => {
  it("pins the enabled-by-default value", () => {
    expect(defaults).toEqual({ enabled: true, hintThresholdPercent: 75, forceAtPercent: 88 });
  });

  it("falls back for missing and non-object blocks", () => {
    for (const input of [undefined, null, 0, "nope", true, [], [1, 2]]) {
      expect(parseCompactSettings(input)).toEqual(defaults);
    }
    expect(parseCompactSettings({})).toEqual(defaults);
  });

  it("falls back when enabled is not boolean", () => {
    for (const enabled of [undefined, null, 0, "true", [], {}, () => true]) {
      expect(parseCompactSettings({ enabled })).toEqual(defaults);
    }
    expect(parseCompactSettings({ enabled: false })).toEqual({
      enabled: false,
      hintThresholdPercent: 75,
      forceAtPercent: 88,
    });
  });

  it("returns a fresh object and is wired into loadSettings", () => {
    const parsed = parseCompactSettings({});
    expect(parsed).not.toBe(defaults);
    parsed.enabled = false;
    expect(defaults.enabled).toBe(true);
    expect(loadSettings({ compact: { enabled: false } }).compact).toEqual({
      enabled: false,
      hintThresholdPercent: 75,
      forceAtPercent: 88,
    });
    expect(loadSettings({ compact: "invalid" }).compact).toEqual(defaults);
    expect(parseCompactSettings({ hintThresholdPercent: 60, assumedReserveTokens: 32768 })).toEqual({
      enabled: true,
      hintThresholdPercent: 60,
      forceAtPercent: 88,
      assumedReserveTokens: 32768,
    });
    expect(parseCompactSettings({ hintThresholdPercent: 0 })).toEqual({
      enabled: true,
      hintThresholdPercent: 0,
      forceAtPercent: 88,
    });
    expect(parseCompactSettings({ hintThresholdPercent: 0.5 })).toEqual(defaults);
    expect(parseCompactSettings({ hintThresholdPercent: 75, forceAtPercent: 0 })).toMatchObject({ forceAtPercent: 0 });
    expect(parseCompactSettings({ hintThresholdPercent: 75, forceAtPercent: 88 })).toMatchObject({
      forceAtPercent: 88,
    });
    expect(parseCompactSettings({ hintThresholdPercent: 75, forceAtPercent: 75 })).toMatchObject({
      forceAtPercent: 88,
    });
    expect(parseCompactSettings({ hintThresholdPercent: 75, forceAtPercent: "88" })).toMatchObject({
      forceAtPercent: 88,
    });
    expect(parseCompactSettings({ hintThresholdPercent: 101, assumedReserveTokens: -1 })).toEqual(defaults);
  });
});
