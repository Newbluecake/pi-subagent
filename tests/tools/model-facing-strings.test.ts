import { describe, expect, it } from "vitest";
import { createAgentTool, type NestedSpawnPort } from "../../src/tools/agent-tool.js";
import { createResultTool } from "../../src/tools/result-tool.js";
import { createSteerTool } from "../../src/tools/steer-tool.js";
import { createWorkflowTool } from "../../src/tools/workflow-tool.js";
import { createStructuredOutputTool } from "../../src/tools/structured-output-tool.js";

function collectDescriptions(schema: unknown, out: string[] = []): string[] {
  if (!schema || typeof schema !== "object") return out;
  const value = schema as Record<string, unknown>;
  if (typeof value.description === "string") out.push(value.description);
  for (const child of Object.values(value)) {
    if (Array.isArray(child)) {
      for (const item of child) collectDescriptions(item, out);
    } else {
      collectDescriptions(child, out);
    }
  }
  return out;
}

function tools() {
  const spawn = {} as NestedSpawnPort;
  return [
    createAgentTool({ spawn }),
    createResultTool({ query: {} as never }),
    createSteerTool({ query: {} as never }),
    createWorkflowTool({} as never),
    createStructuredOutputTool({ schema: { type: "object" }, onSubmit: () => ({ ok: true }) }),
  ];
}

describe("model-facing tool strings", () => {
  it("contain no internal architecture references", () => {
    for (const tool of tools()) {
      const strings = [tool.description, tool.promptSnippet, ...collectDescriptions(tool.parameters)];
      for (const value of strings) expect(value).not.toMatch(/[§]|architecture/);
    }
  });

  it("documents Agent label acceptance for run_id parameters", () => {
    const [agent, result, steer] = tools();
    expect(collectDescriptions(result.parameters).join(" ")).toContain("label");
    expect(collectDescriptions(steer.parameters).join(" ")).toContain("label");
    expect(agent.description).toContain("terminal run");
  });

  it("documents terminal-run semantics for resume", () => {
    const agent = tools()[0]!;
    const descriptions = collectDescriptions(agent.parameters);
    const resume = descriptions.find((text) => text.includes("terminal subagent session"));
    expect(resume).toContain("terminal");
    expect(resume).not.toContain("completed subagent session");
  });
});
