import { describe, expect, it } from "vitest";
import {
  budgetBrakeReason,
  createGoalRecord,
  maxEvalsOf,
  sanitizeGoalRecord,
  transition,
  type GoalEvent,
  type GoalPhase,
  type GoalStopReason,
} from "../../src/goal/state.js";

/**
 * 四状态迁移矩阵（goal-plan v4 状态机）。仓库铁律：状态机变更必须同步
 * 迁移矩阵测试。非法迁移一律期望 undefined。
 */
describe("goal state machine transition matrix", () => {
  const brakeReasons = ["budget", "max-evals", "delivery-failed", "eval-failures"] as const;
  const cases: Array<{
    from: GoalPhase;
    stop?: GoalStopReason;
    event: GoalEvent;
    to: GoalPhase | undefined;
    stopAfter?: GoalStopReason;
  }> = [
    // none
    { from: "none", event: { type: "set" }, to: "active" },
    { from: "none", event: { type: "clear" }, to: "none" },
    { from: "none", event: { type: "pause" }, to: undefined },
    { from: "none", event: { type: "resume" }, to: undefined },
    { from: "none", event: { type: "achieved" }, to: undefined },
    { from: "none", event: { type: "brake", reason: "budget" }, to: undefined },
    { from: "none", event: { type: "abort" }, to: undefined },
    { from: "none", event: { type: "rehydrate" }, to: "none" },
    // active
    { from: "active", event: { type: "set" }, to: "active" },
    { from: "active", event: { type: "pause" }, to: "paused" },
    { from: "active", event: { type: "clear" }, to: "none" },
    { from: "active", event: { type: "resume" }, to: undefined },
    { from: "active", event: { type: "achieved" }, to: "stopped", stopAfter: "achieved" },
    ...brakeReasons.map(
      (reason) => ({ from: "active", event: { type: "brake", reason }, to: "stopped", stopAfter: reason }) as const,
    ),
    // v4 条件 1（BLK-1）：abort → 自动 paused
    { from: "active", event: { type: "abort" }, to: "paused" },
    // v4 条件 2（BLK-2）：rehydrate 强制降级 paused
    { from: "active", event: { type: "rehydrate" }, to: "paused" },
    // paused
    { from: "paused", event: { type: "resume" }, to: "active" },
    { from: "paused", event: { type: "clear" }, to: "none" },
    { from: "paused", event: { type: "set" }, to: "active" },
    { from: "paused", event: { type: "rehydrate" }, to: "paused" },
    { from: "paused", event: { type: "pause" }, to: undefined },
    { from: "paused", event: { type: "achieved" }, to: undefined },
    { from: "paused", event: { type: "brake", reason: "budget" }, to: undefined },
    { from: "paused", event: { type: "abort" }, to: undefined },
    // stopped(achieved)：终态，不可 resume
    { from: "stopped", stop: "achieved", event: { type: "resume" }, to: undefined },
    { from: "stopped", stop: "achieved", event: { type: "clear" }, to: "none" },
    { from: "stopped", stop: "achieved", event: { type: "set" }, to: "active" },
    { from: "stopped", stop: "achieved", event: { type: "rehydrate" }, to: "stopped" },
    // stopped(其他 reason)：可 resume（--reset-budget 门槛在命令层）
    { from: "stopped", stop: "budget", event: { type: "resume" }, to: "active" },
    { from: "stopped", stop: "max-evals", event: { type: "resume" }, to: "active" },
    { from: "stopped", stop: "delivery-failed", event: { type: "resume" }, to: "active" },
    { from: "stopped", stop: "eval-failures", event: { type: "resume" }, to: "active" },
    { from: "stopped", stop: "budget", event: { type: "pause" }, to: undefined },
    { from: "stopped", stop: "budget", event: { type: "abort" }, to: undefined },
  ];
  for (const { from, stop, event, to, stopAfter } of cases) {
    it(`${from}${stop ? `(${stop})` : ""} --${event.type}${event.type === "brake" ? `(${event.reason})` : ""}--> ${to ?? "✗"}`, () => {
      const result = transition(from, event, stop);
      if (to === undefined) {
        expect(result).toBeUndefined();
      } else {
        expect(result?.phase).toBe(to);
        expect(result?.stopReason).toBe(stopAfter);
      }
    });
  }
});

describe("goal record helpers", () => {
  it("createGoalRecord initializes counters and epoch", () => {
    const record = createGoalRecord({
      objective: "obj",
      untilCmd: "npm test",
      maxTurns: 10,
      maxMinutes: 30,
      budgetTokens: 1000,
      budgetCostUsd: 1.5,
      now: 123,
      previousEpoch: 7,
    });
    expect(record).toMatchObject({
      objective: "obj",
      untilCmd: "npm test",
      state: "active",
      epoch: 8,
      iteration: 0,
      evalCount: 0,
      consecutiveEvalFailures: 0,
      tokensUsed: 0,
      costUsdUsed: 0,
      createdAt: 123,
    });
    expect(record.untilText).toBeUndefined();
  });

  it("maxEvalsOf is maxTurns×2 with a floor of 1 (BLK-3)", () => {
    expect(maxEvalsOf({ maxTurns: 20 })).toBe(40);
    expect(maxEvalsOf({ maxTurns: 0 })).toBe(1);
  });

  it("budgetBrakeReason checks tokens, cost and wall-clock; 0 means unlimited", () => {
    const base = { budgetTokens: 0, budgetCostUsd: 0, maxMinutes: 0, tokensUsed: 0, costUsdUsed: 0, createdAt: 0 };
    expect(budgetBrakeReason(base, 10_000_000)).toBeUndefined();
    expect(budgetBrakeReason({ ...base, budgetTokens: 100, tokensUsed: 100 }, 0)).toBe("budget");
    expect(budgetBrakeReason({ ...base, budgetTokens: 100, tokensUsed: 99 }, 0)).toBeUndefined();
    expect(budgetBrakeReason({ ...base, budgetCostUsd: 1, costUsdUsed: 1.01 }, 0)).toBe("budget");
    expect(budgetBrakeReason({ ...base, maxMinutes: 1, createdAt: 0 }, 60_000)).toBe("budget");
    expect(budgetBrakeReason({ ...base, maxMinutes: 1, createdAt: 0 }, 59_999)).toBeUndefined();
  });

  it("sanitizeGoalRecord tolerates garbage and keeps valid records", () => {
    for (const raw of [undefined, null, 0, "x", [], {}, { objective: "" }, { objective: "o", state: "weird" }]) {
      expect(sanitizeGoalRecord(raw)).toBeUndefined();
    }
    const clean = sanitizeGoalRecord({
      objective: "o",
      state: "active",
      epoch: 3,
      untilCmd: "npm test",
      stopReason: "bogus",
      evalCount: 2.9,
      costUsdUsed: -5,
      lastEvalNote: 42,
    });
    expect(clean).toMatchObject({
      objective: "o",
      state: "active",
      epoch: 3,
      untilCmd: "npm test",
      evalCount: 2,
      costUsdUsed: 0,
      maxTurns: 20,
      maxMinutes: 120,
    });
    expect(clean?.stopReason).toBeUndefined();
    expect(clean?.lastEvalNote).toBeUndefined();
    expect(clean?.untilText).toBeUndefined();
  });
});
