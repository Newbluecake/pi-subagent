import { describe, expect, it, vi } from "vitest";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readPiCompactionReserveTokens, resolveReserveTokens } from "../../src/compact-hint/pi-settings.js";

function isolated() {
  const root = mkdtempSync(join(tmpdir(), "compact-settings-"));
  const agent = join(root, "agent");
  mkdirSync(agent);
  const previous = process.env.PI_CODING_AGENT_DIR;
  process.env.PI_CODING_AGENT_DIR = agent;
  return {
    root,
    agent,
    restore() {
      if (previous === undefined) delete process.env.PI_CODING_AGENT_DIR;
      else process.env.PI_CODING_AGENT_DIR = previous;
      rmSync(root, { recursive: true, force: true });
    },
  };
}
function writeSettings(dir: string, value: unknown) {
  mkdirSync(join(dir, ".pi"), { recursive: true });
  writeFileSync(join(dir, ".pi/settings.json"), JSON.stringify(value));
}

describe("pi compaction settings", () => {
  it("is hermetic and uses the conservative maximum in both directions", () => {
    const env = isolated();
    const project = join(env.root, "project");
    mkdirSync(project);
    try {
      writeSettings(project, { compaction: { reserveTokens: 8192 } });
      writeFileSync(join(env.agent, "settings.json"), JSON.stringify({ compaction: { reserveTokens: 32768 } }));
      expect(readPiCompactionReserveTokens(project)).toBe(8192);
      expect(resolveReserveTokens(undefined, project)).toBe(32768);
      writeSettings(project, { compaction: { reserveTokens: 65536 } });
      expect(resolveReserveTokens(undefined, project)).toBe(65536);
      expect(resolveReserveTokens(131072, project)).toBe(131072);
    } finally {
      env.restore();
    }
  });

  it("silently skips ENOENT and falls back when both layers fail", () => {
    const env = isolated();
    try {
      const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
      expect(readPiCompactionReserveTokens(join(env.root, "missing"))).toBeUndefined();
      expect(warn).not.toHaveBeenCalled();
      warn.mockRestore();
      expect(resolveReserveTokens(undefined, join(env.root, "missing"))).toBe(16384);
    } finally {
      env.restore();
    }
  });

  it("warns for malformed and unreadable layers while preserving the other layer", () => {
    const env = isolated();
    const project = join(env.root, "project");
    mkdirSync(project);
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    try {
      writeSettings(project, { compaction: { reserveTokens: 24576 } });
      mkdirSync(join(env.agent, "settings.json"));
      expect(resolveReserveTokens(undefined, project)).toBe(24576);
      expect(warn).toHaveBeenCalled();
      warn.mockClear();
      rmSync(join(env.agent, "settings.json"), { recursive: true, force: true });
      writeFileSync(join(env.agent, "settings.json"), "[");
      expect(resolveReserveTokens(undefined, project)).toBe(24576);
      expect(warn).toHaveBeenCalled();
    } finally {
      warn.mockRestore();
      env.restore();
    }
  });

  it("treats null, strings, zero, and negative reserves as missing", () => {
    const env = isolated();
    const project = join(env.root, "project");
    mkdirSync(project);
    try {
      for (const value of [null, "32768", 0, -1]) {
        writeSettings(project, { compaction: { reserveTokens: value } });
        expect(readPiCompactionReserveTokens(project)).toBeUndefined();
      }
    } finally {
      env.restore();
    }
  });
});
