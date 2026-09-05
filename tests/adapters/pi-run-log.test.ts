import { describe, expect, it } from "vitest";
import { MemoryRunStore } from "../../src/core/store.js";
import { RUN_CUSTOM_TYPE, wrapWithRunLog } from "../../src/adapters/pi-run-log.js";
import type { RunSnapshot } from "../../src/core/types.js";

function snapshot(textFinal?: true): RunSnapshot {
  const diag = {
    createdAt: 0,
    phase: "settled" as const,
    phaseEnteredAt: 1,
    pendingTools: 0,
    turns: 1,
    escalation: [],
    orphaned: false,
    generation: 1,
    degraded: [],
    staleInputs: 0,
    unkillable: [],
    text: "final answer",
    ...(textFinal ? { textFinal } : {}),
  };
  return {
    runId: "r1",
    generation: 1,
    status: "completed",
    phase: "settled",
    deadlines: { enqueuedAt: 0, deadlineAt: undefined, queueDeadlineAt: undefined },
    diag,
    outcome: { runId: "r1", status: "completed", text: "final answer", turns: 1, durationMs: 1, diag },
    updatedAt: 1,
  };
}

describe("pi run log diagnostics persistence", () => {
  it("retains textFinal through the append-entry JSON round trip", () => {
    const entries: Array<{ type: string; customType?: string; data?: unknown }> = [];
    const store = wrapWithRunLog(new MemoryRunStore(), {
      appendEntry: (customType, data) => entries.push({ type: "custom", customType, data }),
      sessionManager: { getEntries: () => entries },
    });
    store.put(snapshot(true));
    const persisted = JSON.parse(JSON.stringify(entries[0]!.data)) as RunSnapshot;
    expect(persisted.diag.text).toBe("final answer");
    expect(persisted.diag.textFinal).toBe(true);
    expect(entries[0]!.customType).toBe(RUN_CUSTOM_TYPE);

    const old = JSON.parse(JSON.stringify(snapshot().diag)) as { textFinal?: true };
    expect(old.textFinal).toBeUndefined();
  });
});
