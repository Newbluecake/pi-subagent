import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { chmodSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DEFAULT_BUDGET } from "../../src/core/deadline.js";
import {
  DEFAULT_SETTINGS,
  TIME_SETTING_MS_PATHS,
  isTimeSettingKey,
  loadSettings,
  loadSettingsFromFile,
} from "../../src/config/settings.js";
import { secondsKeyOf } from "../../src/config/time-units.js";
import { SETTING_SPECS } from "../../src/config/setting-specs.js";

/**
 * Requirement 2 (auto-migration): `loadSettingsFromFile` is the single point
 * that owns the legacy `*Ms` → `*S` rewrite — it is the only place holding the
 * raw JSON, the path, write access and a console at once. Everything here also
 * asserts the tolerance contract: the loader never throws, and a field it
 * cannot migrate falls back to its default instead of poisoning the settings.
 */
describe("settings file time-unit migration", () => {
  let dir: string;
  let path: string;
  let warn: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "pi-subagent-settings-"));
    path = join(dir, "pi-subagent.json");
    warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
  });
  afterEach(() => {
    warn.mockRestore();
  });

  const write = (value: unknown): void => writeFileSync(path, JSON.stringify(value, null, 2) + "\n", "utf8");
  const readBack = (): Record<string, unknown> => JSON.parse(readFileSync(path, "utf8")) as Record<string, unknown>;
  const warnings = (): string => warn.mock.calls.map((c) => String(c[0])).join("\n");

  it("loads and exposes resultMaxChars with the v3 validation rules", () => {
    expect(loadSettings({ resultMaxChars: 100 }).resultMaxChars).toBe(100);
    expect(loadSettings({ resultMaxChars: Number.NaN }).resultMaxChars).toBe(8_000);
    expect(loadSettings({ resultMaxChars: Number.POSITIVE_INFINITY }).resultMaxChars).toBe(8_000);
    expect(loadSettings({ resultMaxChars: -5 }).resultMaxChars).toBe(8_000);
    expect(loadSettings({ resultMaxChars: "100" }).resultMaxChars).toBe(8_000);
    expect(loadSettings({ resultMaxChars: 3.9 }).resultMaxChars).toBe(3);
    expect(SETTING_SPECS.resultMaxChars).toMatchObject({ path: "resultMaxChars", live: true });
    expect(loadSettings({}).resultMaxChars).toBe(8_000);
  });

  it("every duration key is covered by the path list, and only durations", () => {
    // budget.startupRetries is a count, not a duration
    expect(TIME_SETTING_MS_PATHS).toContain("budget.idleMs");
    expect(TIME_SETTING_MS_PATHS).not.toContain("budget.startupRetries");
    expect(TIME_SETTING_MS_PATHS).toContain("workflow.budget.terminateConfirmMs");
    expect(TIME_SETTING_MS_PATHS).toContain("bashJobs.retentionMs");
    expect(TIME_SETTING_MS_PATHS).toContain("bashJobs.drainTimeoutMs");
    expect(TIME_SETTING_MS_PATHS).not.toContain("bashJobs.maxLogBytes");
    expect(TIME_SETTING_MS_PATHS.every((p) => p.endsWith("Ms"))).toBe(true);
    expect(isTimeSettingKey("budget.idleS")).toBe(true);
    expect(isTimeSettingKey("bashJobs.maxLogBytes")).toBe(false);
    expect(isTimeSettingKey("bashJobs.drainTimeoutS")).toBe(true);
    expect(SETTING_SPECS["bashJobs.drainTimeoutS"]).toMatchObject({ path: "bashJobs.drainTimeoutMs", time: true });
  });

  it("reads the new second-valued keys and converts them to internal milliseconds", () => {
    write({
      budget: { idleS: 600, totalS: 0, startupRetries: 4 },
      foregroundAutoBackgroundS: 120,
      worktree: { enabled: true, gitTimeoutS: 45 },
      workflow: { enabled: true, replayTtlS: 60, budget: { gateS: 30 } },
      bashJobs: { autoBackgroundS: 30, retentionS: 3_600, maxLogBytes: 1_024 },
    });
    const s = loadSettingsFromFile(path);
    expect(s.budget.idleMs).toBe(600_000);
    expect(s.budget.totalMs).toBe(0);
    expect(s.budget.startupRetries).toBe(4);
    expect(s.foregroundAutoBackgroundMs).toBe(120_000);
    expect(s.worktree).toEqual({ enabled: true, gitTimeoutMs: 45_000 });
    expect(s.workflow.replayTtlMs).toBe(60_000);
    expect(s.workflow.budget.gateMs).toBe(30_000);
    expect(s.bashJobs.autoBackgroundMs).toBe(30_000);
    expect(s.bashJobs.retentionMs).toBe(3_600_000);
    expect(s.bashJobs.maxLogBytes).toBe(1_024);
    // nothing to migrate ⇒ file untouched, no WARN
    expect(readBack()).toEqual({
      budget: { idleS: 600, totalS: 0, startupRetries: 4 },
      foregroundAutoBackgroundS: 120,
      worktree: { enabled: true, gitTimeoutS: 45 },
      workflow: { enabled: true, replayTtlS: 60, budget: { gateS: 30 } },
      bashJobs: { autoBackgroundS: 30, retentionS: 3_600, maxLogBytes: 1_024 },
    });
    expect(warn).not.toHaveBeenCalled();
  });

  it("migrates legacy *Ms keys (including nested blocks), warns, and rewrites the file", () => {
    write({
      budget: { idleMs: 600_000, startupRetries: 3 },
      deliveryBackoffMs: 1_000,
      reconcileTtlMs: 86_400_000,
      coalesceWindowMs: 2_000,
      ackWindowMs: 1_000,
      worktree: { enabled: true, gitTimeoutMs: 30_000 },
      workflow: { replayTtlMs: 604_800_000, budget: { scriptLoadMs: 5_000, workflowTotalMs: 3_600_000 } },
      bashJobs: { autoBackgroundMs: 120_000, retentionMs: 86_400_000 },
      concurrencyLimit: 4,
    });
    const s = loadSettingsFromFile(path);
    // the file is now entirely in seconds
    expect(readBack()).toEqual({
      budget: { idleS: 600, startupRetries: 3 },
      deliveryBackoffS: 1,
      reconcileTtlS: 86_400,
      coalesceWindowS: 2,
      ackWindowS: 1,
      worktree: { enabled: true, gitTimeoutS: 30 },
      workflow: { replayTtlS: 604_800, budget: { scriptLoadS: 5, workflowTotalS: 3_600 } },
      bashJobs: { autoBackgroundS: 120, retentionS: 86_400 },
      concurrencyLimit: 4,
    });
    // and the in-memory settings are unchanged in meaning
    expect(s.budget.idleMs).toBe(600_000);
    expect(s.coalesceWindowMs).toBe(2_000);
    expect(s.workflow.budget.workflowTotalMs).toBe(3_600_000);
    expect(s.bashJobs.retentionMs).toBe(86_400_000);
    expect(s.concurrencyLimit).toBe(4);
    expect(warnings()).toContain("time settings are now stored in seconds");
    expect(warnings()).toContain("budget.idleMs → budget.idleS (600)");
  });

  it("is idempotent: a second load neither warns nor rewrites", () => {
    write({ budget: { idleMs: 600_000 } });
    loadSettingsFromFile(path);
    const migrated = readBack();
    warn.mockClear();
    const second = loadSettingsFromFile(path);
    expect(readBack()).toEqual(migrated);
    expect(warn).not.toHaveBeenCalled();
    expect(second.budget.idleMs).toBe(600_000);
  });

  it("WARNs and drops a legacy value that is not a whole second (default is used)", () => {
    write({ budget: { idleMs: 1_500, totalMs: 90_000 }, coalesceWindowMs: 250 });
    const s = loadSettingsFromFile(path);
    expect(s.budget.idleMs).toBe(DEFAULT_BUDGET.idleMs);
    expect(s.budget.totalMs).toBe(90_000);
    expect(s.coalesceWindowMs).toBe(DEFAULT_SETTINGS.coalesceWindowMs);
    expect(readBack()).toEqual({ budget: { totalS: 90 } });
    expect(warnings()).toContain("budget.idleMs=1500 is not a whole number of seconds");
    expect(warnings()).toContain("coalesceWindowMs=250 is not a whole number of seconds");
  });

  it("prefers the new key when a file carries both, and drops the legacy one", () => {
    write({ budget: { idleS: 30, idleMs: 999_000 } });
    const s = loadSettingsFromFile(path);
    expect(s.budget.idleMs).toBe(30_000);
    expect(readBack()).toEqual({ budget: { idleS: 30 } });
    expect(warnings()).toContain("budget.idleMs and budget.idleS are both set");
  });

  it("still applies the migration in memory when the file cannot be rewritten", () => {
    write({ budget: { idleMs: 600_000 } });
    chmodSync(path, 0o444);
    try {
      const s = loadSettingsFromFile(path);
      expect(s.budget.idleMs).toBe(600_000);
      expect(warnings()).toContain("failed to write the migrated");
      // untouched on disk — the migration is retried on the next load
      expect(readBack()).toEqual({ budget: { idleMs: 600_000 } });
    } finally {
      chmodSync(path, 0o644);
    }
  });

  it("never throws: missing file, malformed JSON and non-object roots all fall back to defaults", () => {
    expect(loadSettingsFromFile(join(dir, "missing.json")).budget).toEqual(DEFAULT_BUDGET);
    writeFileSync(path, "{ not json", "utf8");
    expect(loadSettingsFromFile(path).budget).toEqual(DEFAULT_BUDGET);
    expect(warnings()).toContain("failed to parse");
    write([1, 2, 3]);
    expect(loadSettingsFromFile(path).concurrencyLimit).toBe(DEFAULT_SETTINGS.concurrencyLimit);
    write("nope");
    expect(loadSettingsFromFile(path).concurrencyLimit).toBe(DEFAULT_SETTINGS.concurrencyLimit);
  });

  it("keeps `/agent settings set` round-trippable: persisted second keys reload identically", () => {
    // this is what persistSettingOverride writes for `settings set budget.idleS 600`
    write({ [secondsKeyOf("foregroundAutoBackgroundMs")]: 90, budget: { [secondsKeyOf("idleMs")]: 600 } });
    const s = loadSettingsFromFile(path);
    expect(s.foregroundAutoBackgroundMs).toBe(90_000);
    expect(s.budget.idleMs).toBe(600_000);
    expect(warn).not.toHaveBeenCalled();
  });
});
