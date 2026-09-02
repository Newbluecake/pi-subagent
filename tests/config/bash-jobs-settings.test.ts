import { describe, expect, it } from "vitest";
import { DEFAULT_SETTINGS, loadSettings, parseBashJobsSettings } from "../../src/config/settings.js";

const defaults = DEFAULT_SETTINGS.bashJobs;

describe("bashJobs settings block (§6)", () => {
  it("pins the documented defaults (R2/R4/R5)", () => {
    expect(defaults).toEqual({
      autoBackgroundMs: 120_000,
      maxLogBytes: 10_485_760,
      maxBackgroundJobs: 8,
      retentionMs: 24 * 60 * 60 * 1_000,
      shutdownPolicy: "keep",
    });
    // optional fields are absent, not `undefined` (exactOptionalPropertyTypes)
    expect("dir" in defaults).toBe(false);
    expect("shellPath" in defaults).toBe(false);
  });

  it("falls back to defaults for missing / non-object blocks", () => {
    for (const input of [undefined, null, 0, "", "nope", true, [], [1, 2]]) {
      expect(parseBashJobsSettings(input)).toEqual(defaults);
    }
    expect(parseBashJobsSettings({})).toEqual(defaults);
  });

  it("returns a fresh object, never the shared default instance", () => {
    const parsed = parseBashJobsSettings({});
    expect(parsed).not.toBe(defaults);
    parsed.autoBackgroundMs = 1;
    expect(defaults.autoBackgroundMs).toBe(120_000);
  });

  it("accepts 0 for autoBackgroundMs (whole feature off)", () => {
    expect(parseBashJobsSettings({ autoBackgroundMs: 0 }).autoBackgroundMs).toBe(0);
    expect(loadSettings({ bashJobs: { autoBackgroundMs: 0 } }).bashJobs.autoBackgroundMs).toBe(0);
  });

  it("accepts finite non-negative numbers for every numeric field", () => {
    expect(
      parseBashJobsSettings({
        autoBackgroundMs: 30_000,
        maxLogBytes: 1_024,
        maxBackgroundJobs: 2,
        retentionMs: 0,
      }),
    ).toEqual({
      autoBackgroundMs: 30_000,
      maxLogBytes: 1_024,
      maxBackgroundJobs: 2,
      retentionMs: 0,
      shutdownPolicy: "keep",
    });
  });

  it("rejects NaN / Infinity / negative / non-number per numeric field", () => {
    const bad = [
      Number.NaN,
      Number.POSITIVE_INFINITY,
      Number.NEGATIVE_INFINITY,
      -1,
      -0.5,
      "1000",
      null,
      undefined,
      true,
      {},
      [],
    ];
    const numericKeys = ["autoBackgroundMs", "maxLogBytes", "maxBackgroundJobs", "retentionMs"] as const;
    for (const key of numericKeys) {
      for (const value of bad) {
        expect(parseBashJobsSettings({ [key]: value })[key], `${key} = ${String(value)}`).toBe(defaults[key]);
      }
    }
  });

  it("whitelists shutdownPolicy and falls back on anything else", () => {
    expect(parseBashJobsSettings({ shutdownPolicy: "keep" }).shutdownPolicy).toBe("keep");
    expect(parseBashJobsSettings({ shutdownPolicy: "kill" }).shutdownPolicy).toBe("kill");
    for (const value of ["KILL", "Keep", "terminate", "", 0, 1, null, undefined, true, {}, []]) {
      expect(parseBashJobsSettings({ shutdownPolicy: value }).shutdownPolicy).toBe("keep");
    }
  });

  it("keeps non-empty dir / shellPath strings and drops illegal ones", () => {
    const parsed = parseBashJobsSettings({ dir: "/tmp/jobs", shellPath: "/bin/bash" });
    expect(parsed.dir).toBe("/tmp/jobs");
    expect(parsed.shellPath).toBe("/bin/bash");
    for (const value of ["", 0, 1, null, undefined, true, {}, []]) {
      const out = parseBashJobsSettings({ dir: value, shellPath: value });
      expect("dir" in out, `dir = ${String(value)}`).toBe(false);
      expect("shellPath" in out, `shellPath = ${String(value)}`).toBe(false);
    }
  });

  it("mixes valid and invalid fields independently", () => {
    expect(
      parseBashJobsSettings({
        autoBackgroundMs: 5_000,
        maxLogBytes: Number.NaN,
        maxBackgroundJobs: -3,
        retentionMs: 1,
        shutdownPolicy: "nope",
        dir: 42,
      }),
    ).toEqual({
      autoBackgroundMs: 5_000,
      maxLogBytes: defaults.maxLogBytes,
      maxBackgroundJobs: defaults.maxBackgroundJobs,
      retentionMs: 1,
      shutdownPolicy: "keep",
    });
  });

  it("is wired into loadSettings", () => {
    expect(loadSettings(undefined).bashJobs).toEqual(defaults);
    expect(loadSettings({}).bashJobs).toEqual(defaults);
    expect(loadSettings({ bashJobs: "garbage" }).bashJobs).toEqual(defaults);
    expect(loadSettings({ bashJobs: { shutdownPolicy: "kill", maxBackgroundJobs: 1 } }).bashJobs).toEqual({
      ...defaults,
      shutdownPolicy: "kill",
      maxBackgroundJobs: 1,
    });
  });

  it("reads its two durations from the file as integer seconds (`*S`), byte/count keys unchanged", () => {
    expect(loadSettings({ bashJobs: { autoBackgroundS: 30, retentionS: 3_600, maxLogBytes: 2_048 } }).bashJobs).toEqual(
      {
        ...defaults,
        autoBackgroundMs: 30_000,
        retentionMs: 3_600_000,
        maxLogBytes: 2_048,
      },
    );
    // 0 (feature off / prune immediately) survives the conversion
    expect(loadSettings({ bashJobs: { autoBackgroundS: 0, retentionS: 0 } }).bashJobs).toEqual({
      ...defaults,
      autoBackgroundMs: 0,
      retentionMs: 0,
    });
    // illegal seconds fall back field-by-field
    expect(loadSettings({ bashJobs: { autoBackgroundS: "30", retentionS: -1 } }).bashJobs).toEqual(defaults);
  });
});
