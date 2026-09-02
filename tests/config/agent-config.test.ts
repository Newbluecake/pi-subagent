import { describe, expect, it } from "vitest";
import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createAgentTypeRegistry, formatAgentTypesForPrompt } from "../../src/config/agent-types.js";
import { DEFAULT_SETTINGS, DEFAULT_WORKFLOW_BUDGET, loadSettings, mergeBudget } from "../../src/config/settings.js";

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
  it("18: validates coalescing and ack window settings, including non-finite values", () => {
    expect(loadSettings({ coalesceWindowMs: Number.NaN }).coalesceWindowMs).toBe(0);
    expect(loadSettings({ coalesceWindowMs: Number.POSITIVE_INFINITY }).coalesceWindowMs).toBe(0);
    expect(loadSettings({ coalesceWindowMs: "500" }).coalesceWindowMs).toBe(0);
    expect(loadSettings({ coalesceWindowMs: 99_999 }).coalesceWindowMs).toBe(5_000);
    expect(loadSettings({ coalesceWindowMs: -5 }).coalesceWindowMs).toBe(0);
    expect(loadSettings({ coalesceMaxBatch: Number.NaN }).coalesceMaxBatch).toBe(8);
    expect(loadSettings({ coalesceMaxBatch: Number.NEGATIVE_INFINITY }).coalesceMaxBatch).toBe(8);
    expect(loadSettings({ coalesceMaxBatch: "2" }).coalesceMaxBatch).toBe(8);
    expect(loadSettings({ coalesceMaxBatch: 0 }).coalesceMaxBatch).toBe(1);
    expect(loadSettings({ coalesceMaxBatch: 2.7 }).coalesceMaxBatch).toBe(2);
    expect(loadSettings({ ackWindowMs: Number.NaN }).ackWindowMs).toBe(0);
    expect(loadSettings({ ackWindowMs: Number.POSITIVE_INFINITY }).ackWindowMs).toBe(0);
    expect(loadSettings({ ackWindowMs: 99_999 }).ackWindowMs).toBe(5_000);
    expect(loadSettings({ ackWindowMs: -5 }).ackWindowMs).toBe(0);
  });
  it("parses frontmatter model: strict pairs into model, fuzzy values into modelHint", async () => {
    const root = await mkdtemp(join(tmpdir(), "pi-subagent-hint-"));
    await mkdir(join(root, ".pi/agents"), { recursive: true });
    await writeFile(
      join(root, ".pi/agents/strict.md"),
      "---\nname: strict\ndescription: d\nmodel: moonshot/kimi-k3\n---\nbody\n",
    );
    await writeFile(join(root, ".pi/agents/fuzzy.md"), "---\nname: fuzzy\ndescription: d\nmodel: sonnet\n---\nbody\n");
    const registry = createAgentTypeRegistry(root, join(root, "home"));
    await registry.reload();
    expect(registry.get("strict")?.model).toEqual({ provider: "moonshot", id: "kimi-k3" });
    expect(registry.get("strict")?.modelHint).toBeUndefined();
    expect(registry.get("fuzzy")?.modelHint).toBe("sonnet");
    expect(registry.get("fuzzy")?.model).toBeUndefined();
    // modelHint is part of the behavior hash — editing the hint must change it.
    expect(registry.configHashOf("fuzzy")).not.toBe(registry.configHashOf("strict"));
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

/**
 * CC3 (workflow design §8.2): the `workflow` settings block, default
 * disabled, with a `loadSettings` parser that tolerates missing/malformed
 * input the same way every other field in this file already does.
 */
describe("CC3: workflow settings", () => {
  it("defaults to disabled with the documented conservative defaults", () => {
    expect(DEFAULT_SETTINGS.workflow).toEqual({
      enabled: false,
      budget: {},
      replayTtlMs: 7 * 24 * 60 * 60 * 1_000,
      replayScope: "chain",
      runawayPolicy: "diagnose_only",
    });
  });

  it("loadSettings(undefined) (no config file at all) also yields the disabled default", () => {
    expect(loadSettings(undefined).workflow).toEqual(DEFAULT_SETTINGS.workflow);
  });

  it("parses a fully-specified workflow block, validating budget keys against DEFAULT_WORKFLOW_BUDGET", () => {
    const settings = loadSettings({
      workflow: {
        enabled: true,
        budget: { workflowTotalMs: 1_800_000, scriptSliceMs: 1_000, bogusKey: 999 },
        journalDir: "/tmp/wf-journal",
        replayTtlMs: 0,
        replayScope: "content",
        runawayPolicy: "terminate_on_stall",
      },
    });
    expect(settings.workflow).toEqual({
      enabled: true,
      budget: { workflowTotalMs: 1_800_000, scriptSliceMs: 1_000 }, // bogusKey silently dropped, not merged in
      journalDir: "/tmp/wf-journal",
      replayTtlMs: 0,
      replayScope: "content",
      runawayPolicy: "terminate_on_stall",
    });
  });

  it("falls back field-by-field on malformed values, without throwing", () => {
    const settings = loadSettings({
      workflow: { enabled: "yes", replayScope: "bogus", runawayPolicy: "bogus", replayTtlMs: -5, budget: "nope" },
    });
    expect(settings.workflow).toEqual(DEFAULT_SETTINGS.workflow);
  });

  it("a non-object workflow block falls back to the full default", () => {
    expect(loadSettings({ workflow: 42 }).workflow).toEqual(DEFAULT_SETTINGS.workflow);
  });

  it("DEFAULT_WORKFLOW_BUDGET matches the WT1-WT19 matrix defaults (§4.1)", () => {
    expect(DEFAULT_WORKFLOW_BUDGET).toEqual({
      scriptLoadMs: 5_000,
      scriptSliceMs: 2_000,
      workerBootMs: 10_000,
      hostCallMs: 60_000,
      gateMs: 600_000,
      phaseTotalMs: 0,
      workflowTotalMs: 3_600_000,
      heartbeatStallMs: 10_000,
      abortGraceMs: 10_000,
      terminateConfirmMs: 2_000,
    });
  });
});

describe("configHashOf sensitivity (X4 replay safety)", () => {
  it("changes when systemPrompt changes; stable for identical config; undefined for unknown type", async () => {
    const { mkdtemp, writeFile, mkdir } = await import("node:fs/promises");
    const { tmpdir } = await import("node:os");
    const { join } = await import("node:path");
    const root = await mkdtemp(join(tmpdir(), "pi-subagent-hash-"));
    const dir = join(root, ".pi", "agents");
    await mkdir(dir, { recursive: true });
    const file = join(dir, "worker.md");
    const write = (prompt: string) => writeFile(file, `---\nname: worker\ndescription: d\n---\n${prompt}\n`);

    await write("prompt A");
    const r1 = createAgentTypeRegistry(root, join(root, "nohome"));
    await r1.reload();
    const hashA = r1.configHashOf("worker");
    expect(hashA).toMatch(/^[0-9a-f]{16,}$/);

    // reload without changes -> stable
    const r2 = createAgentTypeRegistry(root, join(root, "nohome"));
    await r2.reload();
    expect(r2.configHashOf("worker")).toBe(hashA);

    // change systemPrompt -> hash MUST change (otherwise replay would reuse
    // results produced under a different agent definition)
    await write("prompt B");
    const r3 = createAgentTypeRegistry(root, join(root, "nohome"));
    await r3.reload();
    expect(r3.configHashOf("worker")).not.toBe(hashA);

    expect(r3.configHashOf("nonexistent")).toBeUndefined();
  });
});

describe("formatAgentTypesForPrompt (system-prompt injection)", () => {
  const type = (name: string, description: string) =>
    ({ name, description, systemPrompt: "x", promptMode: "append" }) as const;

  it("renders one '- name: description' line per type under a fixed header", () => {
    const out = formatAgentTypesForPrompt([
      type("general-purpose", "Autonomous general-purpose agent."),
      type("Explore", "Fast read-only search agent."),
    ]);
    expect(out).toContain("## Available subagent types (pi-subagent)");
    expect(out).toContain("pass one of these exact names as `subagent_type`");
    expect(out).toContain("- general-purpose: Autonomous general-purpose agent.");
    expect(out).toContain("- Explore: Fast read-only search agent.");
  });

  it("flattens multi-line descriptions and clips pathological lengths", () => {
    const out = formatAgentTypesForPrompt([type("verbose", `line one\nline two\t ${"x".repeat(300)}`)]);
    const lines = out.split("\n");
    const row = lines.find((l) => l.startsWith("- verbose:"))!;
    expect(row).toContain("line one line two"); // whitespace collapsed
    expect(row!.length).toBeLessThan(320); // "- verbose: " + ≤300 chars
    expect(row).toMatch(/\.\.\.$/);
  });

  it("clips at an English sentence boundary within the limit", () => {
    const out = formatAgentTypesForPrompt([type("verbose", `First sentence. ${"x".repeat(400)}`)]);
    const row = out.split("\n").find((l) => l.startsWith("- verbose:"))!;
    expect(row).toContain("First sentence.");
    expect(row).not.toMatch(/\.\.\.$/);
  });

  it("treats CJK sentence punctuation as a boundary without trailing whitespace", () => {
    const out = formatAgentTypesForPrompt([type("verbose", `句一。${"字".repeat(400)}`)]);
    const row = out.split("\n").find((l) => l.startsWith("- verbose:"))!;
    expect(row).toContain("句一。");
    expect(row).not.toMatch(/\.\.\.$/);
  });

  it("falls back to a hard cut when the window has no sentence boundary", () => {
    const out = formatAgentTypesForPrompt([type("verbose", "x".repeat(400))]);
    const row = out.split("\n").find((l) => l.startsWith("- verbose:"))!;
    expect(row.endsWith("...")).toBe(true);
    expect(row.slice("- verbose: ".length).length).toBe(300);
  });

  it("appends the tool-usage protocol lines", () => {
    const out = formatAgentTypesForPrompt([type("worker", "Does work.")]);
    expect(out).toContain("run_in_background");
    expect(out).toContain("get_subagent_result");
    expect(out).toContain("steer_subagent");
    expect(out).toContain("terminal run");
    expect(out).toContain("label");
  });

  it("returns an empty string when no types are registered (nothing to inject)", () => {
    expect(formatAgentTypesForPrompt([])).toBe("");
  });
});
