import { describe, expect, it } from "vitest";
import { renderWorkflowFleetSection } from "../../src/ui/workflow-fleet-section.js";
import type { WorkflowActivitySnapshot } from "../../src/workflow/activity.js";

describe("renderWorkflowFleetSection (M3.6 CC5 workflow fleet section)", () => {
  it("renders nothing (empty lines) when no workflow is in flight", () => {
    const section = renderWorkflowFleetSection([], 1_000);
    expect(section.lines).toEqual([]);
  });

  it("renders one row per in-flight workflow with name, phase and remaining budget", () => {
    const snapshots: WorkflowActivitySnapshot[] = [
      { workflowId: "wf_a", name: "refactor-api", startedAt: 0, deadlineAt: 60_000, currentPhaseId: "implement" },
      { workflowId: "wf_b", name: "no-phase-yet", startedAt: 5_000 },
    ];
    const section = renderWorkflowFleetSection(snapshots, 10_000);
    expect(section.lines[0]).toBe("WORKFLOWS (2)");
    expect(section.lines[1]).toContain("wf_a");
    expect(section.lines[1]).toContain("refactor-api");
    expect(section.lines[1]).toContain("phase=implement");
    expect(section.lines[1]).toContain("dl="); // deadline remaining shown when known
    expect(section.lines[2]).toContain("wf_b");
    expect(section.lines[2]).toContain("phase=-"); // no phase entered yet
    expect(section.lines[2]).not.toContain("dl="); // no deadlineAt known
  });
});
