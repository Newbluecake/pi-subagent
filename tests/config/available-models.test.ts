import { describe, expect, it } from "vitest";
import {
  appendAvailableModelsToSystemPrompt,
  formatAvailableModelsForPrompt,
  type AvailableModelEntry,
} from "../../src/config/available-models.js";

const model = (entry: Partial<AvailableModelEntry> = {}): AvailableModelEntry => ({
  provider: "anthropic",
  id: "claude-sonnet",
  ...entry,
});

describe("available models prompt", () => {
  it("deduplicates provider/id entries while preserving the first entry", () => {
    const output = formatAvailableModelsForPrompt([
      model({ name: "First" }),
      model({ name: "Second", reasoning: true }),
      model({ provider: "openai", id: "gpt-5" }),
    ]);

    expect(output.match(/^- /gm)).toHaveLength(2);
    expect(output).toContain("- anthropic/claude-sonnet — First");
    expect(output).not.toContain("Second");
    expect(output).toContain("- openai/gpt-5");
  });

  it("renders context windows compactly and keeps ctx before reasoning", () => {
    const output = formatAvailableModelsForPrompt([
      model({ id: "one-million", contextWindow: 1_000_000, reasoning: true }),
      model({ id: "fractional-million", contextWindow: 1_050_000 }),
      model({ id: "two-hundred-k", contextWindow: 200_000 }),
      model({ id: "small", contextWindow: 999 }),
      model({ id: "none" }),
    ]);

    expect(output).toContain("- anthropic/one-million (ctx 1M, reasoning)");
    expect(output).toContain("- anthropic/fractional-million (ctx 1.05M)");
    expect(output).toContain("- anthropic/two-hundred-k (ctx 200k)");
    expect(output).toContain("- anthropic/small (ctx 999)");
    expect(output).toContain("- anthropic/none");
    expect(output).not.toContain("anthropic/none (");
  });

  it("renders names and reasoning only when present", () => {
    const output = formatAvailableModelsForPrompt([
      model({ id: "named", name: "Named model", reasoning: true }),
      model({ id: "unnamed", reasoning: false }),
      model({ id: "plain" }),
    ]);

    expect(output).toContain("- anthropic/named — Named model (reasoning)");
    expect(output).toContain("- anthropic/unnamed");
    expect(output).not.toContain("anthropic/unnamed (");
    expect(output).toContain("- anthropic/plain");
  });

  it("limits the list to 30 unique models and reports the remainder", () => {
    const models = Array.from({ length: 31 }, (_, index) => model({ id: `model-${index}` }));
    const output = formatAvailableModelsForPrompt(models);

    expect(output.match(/^- /gm)).toHaveLength(31);
    expect(output).toContain("- anthropic/model-29");
    expect(output).not.toContain("- anthropic/model-30");
    expect(output).toContain("- ... and 1 more");
  });

  it("returns an empty section for an empty list", () => {
    expect(formatAvailableModelsForPrompt([])).toBe("");
  });

  it("appends the section and preserves identity when there is nothing to append", () => {
    const prompt = "base system prompt";
    expect(appendAvailableModelsToSystemPrompt(prompt, [])).toBe(prompt);
    expect(appendAvailableModelsToSystemPrompt(prompt, [model()])).toBe(
      `${prompt}\n\n${formatAvailableModelsForPrompt([model()])}`,
    );
  });
});
