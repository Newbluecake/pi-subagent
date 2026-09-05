import { afterEach, describe, expect, it, vi } from "vitest";
import { chmodSync, existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadSettingsFromFile } from "../../src/config/settings.js";

describe("legacy cache TTL migration", () => {
  let dir: string | undefined;
  afterEach(() => vi.restoreAllMocks());
  function files(settings: unknown, legacy: unknown) {
    dir = mkdtempSync(join(tmpdir(), "pi-subagent-cache-ttl-"));
    const path = join(dir, "pi-subagent.json");
    writeFileSync(path, JSON.stringify(settings) + "\n");
    writeFileSync(join(dir, "cache-ttl-state.json"), JSON.stringify(legacy) + "\n");
    return { path, legacy: join(dir, "cache-ttl-state.json") };
  }

  it("moves a valid legacy mode into settings and removes the file", () => {
    const { path, legacy } = files({}, { mode: "on" });
    expect(loadSettingsFromFile(path).cacheTtl).toEqual({ mode: "on" });
    expect(JSON.parse(readFileSync(path, "utf8"))).toMatchObject({ cacheTtl: { mode: "on" } });
    expect(existsSync(legacy)).toBe(false);
  });

  it("does not overwrite an existing setting, including an invalid one", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const { path, legacy } = files({ cacheTtl: { mode: "off" } }, { mode: "on" });
    expect(loadSettingsFromFile(path).cacheTtl).toEqual({ mode: "off" });
    expect(existsSync(legacy)).toBe(false);
    const second = files({ cacheTtl: { mode: "bad" } }, { mode: "on" });
    expect(loadSettingsFromFile(second.path).cacheTtl).toEqual({ mode: "auto" });
    expect(warn).toHaveBeenCalled();
    expect(existsSync(second.legacy)).toBe(false);
  });

  it("keeps malformed legacy state for a later retry", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const { path, legacy } = files({}, { mode: "bad" });
    expect(loadSettingsFromFile(path).cacheTtl).toEqual({ mode: "auto" });
    expect(existsSync(legacy)).toBe(true);
    expect(warn).toHaveBeenCalled();
  });

  it("keeps syntactically broken legacy JSON for a later retry", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    dir = mkdtempSync(join(tmpdir(), "pi-subagent-cache-ttl-"));
    const path = join(dir, "pi-subagent.json");
    writeFileSync(path, "{}\n");
    const legacy = join(dir, "cache-ttl-state.json");
    writeFileSync(legacy, "{not json");
    expect(loadSettingsFromFile(path).cacheTtl).toEqual({ mode: "auto" });
    expect(existsSync(legacy)).toBe(true);
    expect(warn).toHaveBeenCalled();
  });

  // blocker-1 回归：settings 写回失败时 legacy 必须保留，内存仍用 legacy 值，下次启动可重试
  it("keeps the legacy file when the settings write-back fails", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const { path, legacy } = files({}, { mode: "on" });
    chmodSync(path, 0o444);
    try {
      expect(loadSettingsFromFile(path).cacheTtl).toEqual({ mode: "on" });
      expect(existsSync(legacy)).toBe(true);
      expect(readFileSync(path, "utf8")).not.toContain("cacheTtl");
      expect(warn).toHaveBeenCalled();
    } finally {
      chmodSync(path, 0o644);
    }
    // 恢复可写后重试成功并清理 legacy
    expect(loadSettingsFromFile(path).cacheTtl).toEqual({ mode: "on" });
    expect(existsSync(legacy)).toBe(false);
    expect(JSON.parse(readFileSync(path, "utf8"))).toMatchObject({ cacheTtl: { mode: "on" } });
  });
});
