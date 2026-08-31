import { describe, expect, it } from "vitest";
import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createAgentTypeRegistry } from "../../src/config/agent-types.js";
import { loadSettings, mergeBudget } from "../../src/config/settings.js";

describe("agent config", () => {
  it("loads BOM files from precedence order and skips malformed files", async () => {
    const root = await mkdtemp(join(tmpdir(), "pi-subagent-"));
    await mkdir(join(root, ".pi/agents"), { recursive: true });
    await writeFile(
      join(root, ".pi/agents/good.md"),
      "\uFEFF---\nname: good\ndescription: test\ntools: one, two\nthinking: low\n---\nSystem prompt\n",
    );
    await writeFile(join(root, ".pi/agents/bad.md"), "---\nname: bad\n---\n");
    const registry = createAgentTypeRegistry(root, join(root, "home"));
    const result = await registry.reload();
    expect(result.types.map((x) => x.name)).toEqual(["good", "general-purpose", "Plan"]); // built-ins appended after file types
    expect(result.errors).toHaveLength(1);
    expect(result.errors[0]?.path).toContain("bad.md");
    expect(registry.get("good")?.tools).toEqual(["one", "two"]);
  });
  it("merges request budget over agent and defaults", () => {
    expect(mergeBudget({ totalMs: 10 }, { idleMs: 20 })).toMatchObject({ totalMs: 10, idleMs: 20, startupMs: 30_000 });
    expect(loadSettings({ concurrencyLimit: -1 }).concurrencyLimit).toBe(6);
  });
});

describe("built-in agent types", () => {
  it("provides general-purpose and Plan when no agent files define them", async () => {
    const registry = createAgentTypeRegistry("/nonexistent-cwd", "/nonexistent-home");
    await registry.reload();
    expect(registry.get("general-purpose")).toBeDefined();
    expect(registry.get("Plan")).toBeDefined();
  });
  it("file-defined types shadow built-ins", async () => {
    const { mkdtemp, writeFile, mkdir } = await import("node:fs/promises");
    const { tmpdir } = await import("node:os");
    const { join } = await import("node:path");
    const root = await mkdtemp(join(tmpdir(), "pi-subagent-cfg-"));
    const home = join(root, "home");
    await mkdir(join(home, ".pi/agent/agents"), { recursive: true });
    await writeFile(
      join(home, ".pi/agent/agents/general-purpose.md"),
      "---\nname: general-purpose\ndescription: custom override\n---\ncustom prompt\n",
    );
    const registry = createAgentTypeRegistry(root, home);
    await registry.reload();
    const gp = registry.get("general-purpose");
    expect(gp?.description).toBe("custom override"); // file wins
    expect(gp?.sourcePath).toBeDefined();
    expect(registry.get("Plan")?.sourcePath).toBeUndefined(); // still built-in
  });
});
