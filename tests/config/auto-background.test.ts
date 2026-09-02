import { describe, expect, it } from "vitest";
import { DEFAULT_SETTINGS, loadSettings } from "../../src/config/settings.js";
import { formatAgentTypesForPrompt } from "../../src/config/agent-types.js";
import type { AgentTypeConfig } from "../../src/core/types.js";

const type: AgentTypeConfig = { name: "worker", description: "Does work.", systemPrompt: "", promptMode: "append" };

describe("foreground auto-background settings and prompt", () => {
  it("defaults to ten minutes and validates finite non-negative values", () => {
    expect(DEFAULT_SETTINGS.foregroundAutoBackgroundMs).toBe(600_000);
    expect(loadSettings({}).foregroundAutoBackgroundMs).toBe(600_000);
    expect(loadSettings({ foregroundAutoBackgroundMs: 0 }).foregroundAutoBackgroundMs).toBe(0);
    for (const value of [Number.NaN, Number.POSITIVE_INFINITY, -1, "1000"]) {
      expect(loadSettings({ foregroundAutoBackgroundMs: value }).foregroundAutoBackgroundMs).toBe(600_000);
    }
  });

  it("explains enabled and disabled foreground behavior and abort control", () => {
    const enabled = formatAgentTypesForPrompt([type], { foregroundAutoBackgroundMs: 600_000 });
    expect(enabled).toContain("~10m");
    expect(enabled).toContain("NOT stopped");
    expect(enabled).toContain("abort_subagent");
    const disabled = formatAgentTypesForPrompt([type], { foregroundAutoBackgroundMs: 0 });
    expect(disabled).toContain("blocks until");
    expect(disabled).toContain("abort_subagent");
  });
});
