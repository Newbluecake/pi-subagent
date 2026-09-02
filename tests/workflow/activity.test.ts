import { describe, expect, it } from "vitest";
import { createWorkflowActivityRegistry } from "../../src/workflow/activity.js";

/**
 * M3.6 phase tracking + M10 per-child lifecycle tracking for the live
 * workflow tool card. The registry is a pure event-reducer over the
 * `subagent:workflow:*` stream — these tests feed it the exact payloads
 * orchestrator.ts relays (`{ workflowId, ...event }`) and read the
 * resulting snapshots.
 */

const WF = "wf_test";

function registered() {
  const reg = createWorkflowActivityRegistry();
  reg.register(WF, "demo-flow", 1_000, 61_000);
  return reg;
}

function spawned(callId: string, extra: Record<string, unknown> = {}) {
  return { workflowId: WF, kind: "spawned", callId, runId: `run-${callId}`, at: 2_000, ...extra };
}

function settled(callId: string, extra: Record<string, unknown> = {}) {
  return {
    workflowId: WF,
    kind: "settled",
    callId,
    runId: `run-${callId}`,
    status: "completed",
    source: "live",
    durationMs: 500,
    at: 3_000,
    ...extra,
  };
}

describe("workflow activity registry (M3.6): workflow-level fields", () => {
  it("register/list/unregister round-trips name, startedAt, deadlineAt", () => {
    const reg = registered();
    expect(reg.list()).toHaveLength(1);
    const snap = reg.list()[0]!;
    expect(snap.name).toBe("demo-flow");
    expect(snap.startedAt).toBe(1_000);
    expect(snap.deadlineAt).toBe(61_000);
    reg.unregister(WF);
    expect(reg.list()).toHaveLength(0);
  });

  it("a phase enter event updates currentPhaseId; unknown workflows and malformed payloads are ignored", () => {
    const reg = registered();
    reg.onEvent("subagent:workflow:phase", { workflowId: WF, phaseId: "Implement", kind: "enter" });
    expect(reg.list()[0]!.currentPhaseId).toBe("Implement");
    reg.onEvent("subagent:workflow:phase", { workflowId: "wf_other", phaseId: "X", kind: "enter" });
    reg.onEvent("subagent:workflow:phase", { workflowId: WF, kind: "enter" }); // no phaseId
    reg.onEvent("unrelated:channel", { workflowId: WF, phaseId: "Y", kind: "enter" });
    expect(reg.list()[0]!.currentPhaseId).toBe("Implement");
  });
});

describe("workflow activity registry (M10): child lifecycle tracking", () => {
  it("a spawned event adds an active row with label/agentType/runId", () => {
    const reg = registered();
    reg.onEvent("subagent:workflow:child", spawned("c1", { label: "dev:a", agentType: "general-purpose" }));
    const snap = reg.list()[0]!;
    expect(snap.activeChildren).toHaveLength(1);
    expect(snap.activeChildren[0]).toMatchObject({
      callId: "c1",
      runId: "run-c1",
      label: "dev:a",
      agentType: "general-purpose",
      enteredAt: 2_000,
    });
    expect(snap.settledTotal).toBe(0);
  });

  it("a settled event removes the active row and bumps the totals + recent-settled trail", () => {
    const reg = registered();
    reg.onEvent("subagent:workflow:child", spawned("c1", { label: "dev:a" }));
    reg.onEvent("subagent:workflow:child", spawned("c2"));
    reg.onEvent("subagent:workflow:child", settled("c1", { label: "dev:a", durationMs: 1_200 }));
    const snap = reg.list()[0]!;
    expect(snap.activeChildren.map((c) => c.callId)).toEqual(["c2"]);
    expect(snap.settledTotal).toBe(1);
    expect(snap.completedTotal).toBe(1);
    expect(snap.replayTotal).toBe(0);
    expect(snap.settledChildren).toHaveLength(1);
    expect(snap.settledChildren[0]).toMatchObject({ callId: "c1", label: "dev:a", status: "completed" });
  });

  it("a settled without a preceding spawned (replay hit / withheld) counts but has no active row to remove", () => {
    const reg = registered();
    reg.onEvent(
      "subagent:workflow:child",
      settled("c1", { runId: undefined, source: "replay", status: "completed", durationMs: 0 }),
    );
    const snap = reg.list()[0]!;
    expect(snap.activeChildren).toHaveLength(0);
    expect(snap.settledTotal).toBe(1);
    expect(snap.completedTotal).toBe(1);
    expect(snap.replayTotal).toBe(1);
  });

  it("failed/withheld settles do not count as completed", () => {
    const reg = registered();
    reg.onEvent("subagent:workflow:child", settled("c1", { status: "failed" }));
    reg.onEvent("subagent:workflow:child", settled("c2", { status: "withheld", runId: undefined }));
    const snap = reg.list()[0]!;
    expect(snap.settledTotal).toBe(2);
    expect(snap.completedTotal).toBe(0);
  });

  it("a duplicate settle of the same callId counts only once", () => {
    const reg = registered();
    reg.onEvent("subagent:workflow:child", settled("c1"));
    reg.onEvent("subagent:workflow:child", settled("c1"));
    expect(reg.list()[0]!.settledTotal).toBe(1);
    expect(reg.list()[0]!.settledChildren).toHaveLength(1);
  });

  it("the recent-settled trail is capped (totals stay exact)", () => {
    const reg = registered();
    for (let i = 0; i < 12; i += 1) reg.onEvent("subagent:workflow:child", settled(`c${i}`));
    const snap = reg.list()[0]!;
    expect(snap.settledTotal).toBe(12);
    expect(snap.settledChildren).toHaveLength(8);
    expect(snap.settledChildren[0]!.callId).toBe("c4"); // oldest dropped
    expect(snap.settledChildren[7]!.callId).toBe("c11");
  });

  it("malformed child payloads are ignored, never fatal", () => {
    const reg = registered();
    reg.onEvent("subagent:workflow:child", null);
    reg.onEvent("subagent:workflow:child", { workflowId: WF, kind: "spawned" }); // no callId
    reg.onEvent("subagent:workflow:child", { workflowId: WF, kind: "mystery", callId: "c1", at: 1 });
    reg.onEvent("subagent:workflow:child", { workflowId: WF, kind: "spawned", callId: "c1" }); // no at
    const snap = reg.list()[0]!;
    expect(snap.activeChildren).toHaveLength(0);
    expect(snap.settledTotal).toBe(0);
  });

  it("child events for unknown/unregistered workflows are dropped", () => {
    const reg = registered();
    reg.onEvent("subagent:workflow:child", { ...spawned("c1"), workflowId: "wf_gone" });
    expect(reg.list()[0]!.activeChildren).toHaveLength(0);
  });
});
