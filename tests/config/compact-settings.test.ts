import { describe, expect, it } from "vitest";
import { DEFAULT_SETTINGS, loadSettings, parseCompactSettings } from "../../src/config/settings.js";

const defaults = DEFAULT_SETTINGS.compact;

describe("compact settings", () => {
  it("pins the enabled-by-default value", () => {
    expect(defaults).toEqual({ enabled: true });
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
    expect(parseCompactSettings({ enabled: false })).toEqual({ enabled: false });
  });

  it("returns a fresh object and is wired into loadSettings", () => {
    const parsed = parseCompactSettings({});
    expect(parsed).not.toBe(defaults);
    parsed.enabled = false;
    expect(defaults.enabled).toBe(true);
    expect(loadSettings({ compact: { enabled: false } }).compact).toEqual({ enabled: false });
    expect(loadSettings({ compact: "invalid" }).compact).toEqual(defaults);
  });
});
