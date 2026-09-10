import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  DEFAULT_SETTINGS,
  loadSettings,
  loadSettingsFromFile,
  parseExtendSettings,
} from "../../src/config/settings.js";
import { SETTING_SPECS } from "../../src/config/setting-specs.js";

describe("config/extend-settings: parseExtendSettings", () => {
  it("returns defaults for non-object input", () => {
    for (const bad of [undefined, null, 42, "x", []]) {
      expect(parseExtendSettings(bad)).toEqual(DEFAULT_SETTINGS.extend);
    }
  });
  it("parses valid fields and tolerates junk field-by-field", () => {
    expect(parseExtendSettings({ enabled: false, notify: "always" })).toEqual({ enabled: false, notify: "always" });
    expect(parseExtendSettings({ enabled: "no", notify: "sometimes" })).toEqual(DEFAULT_SETTINGS.extend);
    expect(parseExtendSettings({ notify: "off" })).toEqual({ enabled: true, notify: "off" });
  });
  it("loadSettings wires the extend block", () => {
    expect(loadSettings({ extend: { enabled: false } }).extend).toEqual({ enabled: false, notify: "background" });
    expect(loadSettings({}).extend).toEqual(DEFAULT_SETTINGS.extend);
  });
});

describe("config/extend-settings: new budget keys (arch §7.1)", () => {
  it("converts budget.totalGraceS seconds to internal milliseconds", () => {
    expect(loadSettings({ budget: { totalGraceS: 30 } }).budget.totalGraceMs).toBe(30_000);
  });
  it("keeps maxTotalFactor non-integer (it is a factor, not a time field)", () => {
    expect(loadSettings({ budget: { maxTotalFactor: 1.5 } }).budget.maxTotalFactor).toBe(1.5);
    expect(loadSettings({ budget: { maxExtensions: 5 } }).budget.maxExtensions).toBe(5);
  });
  it("budget.totalS: 0 is illegal and falls back to the default (D-11)", () => {
    expect(loadSettings({ budget: { totalS: 0 } }).budget.totalMs).toBe(1_800_000);
    expect(loadSettings({ budget: { totalS: -3 } }).budget.totalMs).toBe(1_800_000);
    expect(loadSettings({ budget: { totalS: 60 } }).budget.totalMs).toBe(60_000);
  });
});

describe("config/extend-settings: SETTING_SPECS surface", () => {
  it("exposes the new keys with the right kinds", () => {
    expect(SETTING_SPECS["extend.enabled"]).toMatchObject({ kind: "boolean", path: "extend.enabled" });
    expect(SETTING_SPECS["extend.notify"]).toMatchObject({
      kind: "enum",
      path: "extend.notify",
      values: ["background", "always", "off"],
    });
    expect(SETTING_SPECS["fleetDeadlineWarnS"]).toMatchObject({
      kind: "number",
      path: "fleetDeadlineWarnMs",
      time: true,
    });
    expect(SETTING_SPECS["budget.totalS"]).toMatchObject({ kind: "number", path: "budget.totalMs", min: 1 });
    expect(SETTING_SPECS["budget.totalGraceS"]).toMatchObject({
      kind: "number",
      path: "budget.totalGraceMs",
      time: true,
    });
    // maxExtensions / maxTotalFactor are counts/factors, not time specs
    expect(SETTING_SPECS["budget.maxExtensions"]).toMatchObject({ kind: "number", path: "budget.maxExtensions" });
    expect(SETTING_SPECS["budget.maxExtensions"]?.time).toBeUndefined();
    expect(SETTING_SPECS["budget.maxTotalFactor"]).toMatchObject({
      kind: "number",
      path: "budget.maxTotalFactor",
      min: 1,
    });
    expect(SETTING_SPECS["budget.maxTotalFactor"]?.time).toBeUndefined();
  });
});

describe("config/extend-settings: loadSettingsFromFile totalS WARN (D-11)", () => {
  let dir: string;
  let path: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "pi-subagent-extend-settings-"));
    path = join(dir, "settings.json");
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it("warns exactly once and does not rewrite the file for budget.totalS: 0", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    try {
      const content = JSON.stringify({ budget: { totalS: 0 } }, null, 2);
      writeFileSync(path, content, "utf8");
      const s = loadSettingsFromFile(path);
      expect(s.budget.totalMs).toBe(1_800_000);
      expect(warn).toHaveBeenCalledTimes(1);
      expect(warn.mock.calls[0]?.[0]).toContain("budget.totalS must be > 0");
      expect(readFileSync(path, "utf8")).toBe(content);
    } finally {
      warn.mockRestore();
    }
  });

  it("does not warn for a legal totalS", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    try {
      writeFileSync(path, JSON.stringify({ budget: { totalS: 120 } }), "utf8");
      expect(loadSettingsFromFile(path).budget.totalMs).toBe(120_000);
      expect(warn).not.toHaveBeenCalled();
    } finally {
      warn.mockRestore();
    }
  });
});
