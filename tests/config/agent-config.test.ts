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
    expect(result.types.map((x) => x.name)).toEqual(["good"]);
    expect(result.errors).toHaveLength(1);
    expect(result.errors[0]?.path).toContain("bad.md");
    expect(registry.get("good")?.tools).toEqual(["one", "two"]);
  });
  it("merges request budget over agent and defaults", () => {
    expect(mergeBudget({ totalMs: 10 }, { idleMs: 20 })).toMatchObject({ totalMs: 10, idleMs: 20, startupMs: 30_000 });
    expect(loadSettings({ concurrencyLimit: -1 }).concurrencyLimit).toBe(6);
  });
});
