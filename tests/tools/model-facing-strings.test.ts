import { describe, expect, it } from "vitest";
import { createAgentTool, type NestedSpawnPort } from "../../src/tools/agent-tool.js";
import { createResultTool } from "../../src/tools/result-tool.js";
import { createSteerTool } from "../../src/tools/steer-tool.js";
import { createAbortTool } from "../../src/tools/abort-tool.js";
import { createWorkflowTool } from "../../src/tools/workflow-tool.js";
import { createStructuredOutputTool } from "../../src/tools/structured-output-tool.js";
import { createBashTool } from "../../src/tools/bash-tool.js";
import { createBashJobTool } from "../../src/tools/bash-job-tool.js";

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
    createAbortTool({ query: {} as never }),
    createWorkflowTool({} as never),
    createStructuredOutputTool({ schema: { type: "object" }, onSubmit: () => ({ ok: true }) }),
    // bash auto-background surfaces: both are model-facing, so they are held
    // to the same no-internal-vocabulary bar (the threshold paragraph and the
    // job wording are generated, so drift here is easy to miss).
    createBashTool({ manager: () => undefined, autoBackgroundMs: () => 120_000 }),
    createBashJobTool({ manager: () => undefined }),
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
    const [agent, result, steer, abort] = tools();
    expect(collectDescriptions(result.parameters).join(" ")).toContain("label");
    expect(collectDescriptions(steer.parameters).join(" ")).toContain("label");
    expect(collectDescriptions(abort.parameters).join(" ")).toContain("label");
    expect(agent.description).toContain("terminal run");
  });

  it("documents terminal-run semantics for resume", () => {
    const agent = tools()[0]!;
    const descriptions = collectDescriptions(agent.parameters);
    const resume = descriptions.find((text) => text.includes("terminal subagent session"));
    expect(resume).toContain("terminal");
    expect(resume).not.toContain("completed subagent session");
  });

  /**
   * A blocking wait (get_subagent_result wait:true, bash_job wait) occupies
   * the agent loop for its whole duration — the user cannot type a new
   * message or command until it returns. The descriptions must state that
   * consequence, or models treat wait as a free default instead of the
   * last-resort fallback it is.
   */
  it("states that a blocking wait prevents new user input", () => {
    const [agent, result] = tools();
    const bashJob = tools().find((tool) => tool.name === "bash_job")!;
    expect(result.description).toMatch(/user cannot send new input/);
    expect(collectDescriptions(result.parameters).join(" ")).toMatch(/user\s+cannot type a new message/);
    expect(agent.description).toMatch(/monopolizes the agent loop/);
    expect(bashJob.description).toMatch(/user cannot send new input/);
  });

  /**
   * The bash pair is generated from pi's own bash definition plus our own
   * wording; these guards cover what the T1 drift test in
   * `tests/tools/bash-tool.test.ts` does not: that the *model-visible*
   * vocabulary stays free of plugin-internal terms (job status enum values,
   * settings paths, file-layout details) and that the shared job/threshold
   * contract is actually stated where the model can read it.
   */
  describe("bash auto-background tools", () => {
    const bash = () => tools().find((tool) => tool.name === "bash")!;
    const bashJob = () => tools().find((tool) => tool.name === "bash_job")!;

    it("uses no internal vocabulary in the bash pair's descriptions", () => {
      for (const tool of [bash(), bashJob()]) {
        const strings = [tool.description, tool.promptSnippet, ...collectDescriptions(tool.parameters)].filter(
          (value): value is string => typeof value === "string",
        );
        for (const value of strings) {
          // Internal identifiers that must never leak into a prompt.
          expect(value).not.toMatch(/exited_unknown|orphaned|BashJobManager|readCursor|bashJobs\./);
          expect(value).not.toMatch(/plan-fable|autoBackgroundMs|maxLogBytes/);
        }
      }
    });

    it("states the job contract the two tools share", () => {
      const description = bash().description;
      expect(description).toContain("job_id");
      expect(description).toContain("NOT killed");
      expect(description).toContain("bash_job");
      expect(description).toContain("run_in_background: true");
      // The threshold is rendered as a duration, never as a raw ms number.
      expect(description).toMatch(/runs longer than ~\d+m/);

      const params = collectDescriptions(bashJob().parameters).join(" ");
      expect(params).toContain("unique prefix is accepted");
      expect(params).toContain("Required for every action except list");
      // Four actions since change C: `output` was merged into `status`.
      for (const action of ["status", "wait", "kill", "list"]) {
        expect(bashJob().description).toContain(action);
        expect(params).toContain(action);
      }
      expect(params).not.toContain("offset");
      expect(bashJob().description).not.toContain('"output"');
    });

    /**
     * Change A: the job log is an ordinary file. Both tools must say so, or the
     * wording alone would confine the model to this tool's parameters when
     * read/tail/grep/awk are strictly more capable.
     */
    it("tells the model the log is a plain file it may read directly", () => {
      for (const tool of [bash(), bashJob()]) {
        expect(tool.description).toMatch(/plain file/);
        expect(tool.description).toMatch(/read tool|tail\/grep\/awk/);
      }
      expect(bashJob().description).toMatch(/grep a large log/);
    });
  });
});
