import { describe, expect, it, vi } from "vitest";
import { createGoalRecord, type GoalRecord } from "../../src/goal/state.js";
import { GOAL_ENTRY_TYPE, persistGoalRecord, readBackGoalRecord } from "../../src/goal/store.js";

function record(overrides: Partial<GoalRecord> = {}): GoalRecord {
  return {
    ...createGoalRecord({
      objective: "obj",
      untilCmd: "npm test",
      maxTurns: 10,
      maxMinutes: 30,
      budgetTokens: 0,
      budgetCostUsd: 0,
      now: 1000,
    }),
    ...overrides,
  };
}
function entry(customType: string, data: unknown) {
  return { type: "custom", customType, data };
}

describe("goal store persistence", () => {
  it("persistGoalRecord appends a subagent:goal entry and never throws", () => {
    const appended: unknown[] = [];
    persistGoalRecord({ appendEntry: (type, data) => appended.push({ type, data }) }, record());
    expect(appended).toEqual([{ type: GOAL_ENTRY_TYPE, data: expect.objectContaining({ objective: "obj" }) }]);
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    persistGoalRecord(
      {
        appendEntry: () => {
          throw new Error("disk full");
        },
      },
      record(),
    );
    expect(warn).toHaveBeenCalled();
    warn.mockRestore();
  });

  it("reads back the LAST goal entry from the branch and downgrades active to paused (epoch+1)", () => {
    const older = entry(GOAL_ENTRY_TYPE, record({ objective: "old", epoch: 1 }));
    const newer = entry(GOAL_ENTRY_TYPE, record({ objective: "new", epoch: 5, state: "active" }));
    const other = entry("subagent:outbox", { key: "x" });
    const result = readBackGoalRecord([older, other, newer], "resume");
    expect(result.record).toMatchObject({ objective: "new", state: "paused", epoch: 6 });
    expect(result.notify).toBe(true);
  });

  it("reason branches: new never inherits; reload is silent; startup is silent; resume/fork notify", () => {
    const branch = [entry(GOAL_ENTRY_TYPE, record({ state: "active" }))];
    expect(readBackGoalRecord(branch, "new")).toEqual({ record: undefined, notify: false });
    expect(readBackGoalRecord(branch, "reload")).toMatchObject({ notify: false, record: { state: "paused" } });
    expect(readBackGoalRecord(branch, "startup")).toMatchObject({ notify: false, record: { state: "paused" } });
    expect(readBackGoalRecord(branch, "resume")).toMatchObject({ notify: true });
    expect(readBackGoalRecord(branch, "fork")).toMatchObject({ notify: true });
  });

  it("does not inherit terminal (stopped/none) records and does not prompt", () => {
    for (const state of ["stopped", "none"] as const) {
      const branch = [
        entry(GOAL_ENTRY_TYPE, record({ state, stopReason: state === "stopped" ? "achieved" : undefined })),
      ];
      expect(readBackGoalRecord(branch, "resume")).toEqual({ record: undefined, notify: false });
    }
  });

  it("keeps paused records paused on rehydrate (double-resume is a no-op downgrade)", () => {
    const branch = [entry(GOAL_ENTRY_TYPE, record({ state: "paused", epoch: 2 }))];
    const result = readBackGoalRecord(branch, "fork");
    expect(result.record).toMatchObject({ state: "paused", epoch: 3 });
  });

  it("tolerates empty branches, missing entries and malformed data", () => {
    expect(readBackGoalRecord([], "resume")).toEqual({ record: undefined, notify: false });
    expect(readBackGoalRecord([entry(GOAL_ENTRY_TYPE, "garbage"), { type: "message" }, null], "resume")).toEqual({
      record: undefined,
      notify: false,
    });
  });
});
