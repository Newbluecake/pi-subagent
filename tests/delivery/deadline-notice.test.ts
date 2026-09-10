import { describe, expect, it } from "vitest";
import {
  TIMEOUT_NOTICE_TYPE,
  deliveryOptionsFor,
  formatDeadlineNotice,
  overtimeTail,
  shouldDeliverDeadlineNotice,
} from "../../src/delivery/deadline-notice.js";
import type { DeadlineNotice, RunDiagnostics, RunSnapshot } from "../../src/core/types.js";

const NOW = 1_802_000;

function graceNotice(overrides: Partial<DeadlineNotice> = {}): DeadlineNotice {
  return {
    kind: "grace",
    runId: "a1b2c3d4e5f6",
    generation: 1,
    at: 1_800_000,
    phase: "tool_exec",
    label: "reviewer",
    agentType: "worker",
    taskPreview: "审查 src/delivery 的投递生命周期并给出风险清单",
    deadlineAt: 1_800_000,
    graceUntil: 1_888_000,
    hardDeadlineAt: 3_600_000,
    extensionsUsed: 0,
    maxExtensions: 3,
    suggestedExtendMs: 600_000,
    ...overrides,
  };
}

function extendedNotice(overrides: Partial<DeadlineNotice> = {}): DeadlineNotice {
  return {
    kind: "extended",
    runId: "a1b2c3d4e5f6",
    generation: 1,
    at: 1_800_100,
    phase: "tool_exec",
    label: "reviewer",
    deadlineAt: 2_400_000,
    hardDeadlineAt: 3_600_000,
    extensionsUsed: 2,
    maxExtensions: 3,
    requestedMs: 600_000,
    grantedMs: 600_000,
    source: "tool",
    ...overrides,
  };
}

function snapshot(overtime?: RunDiagnostics["overtime"]): RunSnapshot {
  return {
    runId: "a1b2c3d4e5f6",
    generation: 1,
    status: "running",
    phase: "tool_exec",
    deadlines: { enqueuedAt: 0, deadlineAt: 1_800_000, queueDeadlineAt: undefined, hardDeadlineAt: 3_600_000 },
    diag: {
      createdAt: 0,
      phase: "tool_exec",
      phaseEnteredAt: 1_790_000,
      currentTool: { name: "bash", toolCallId: "tc1", startedAt: 1_800_000 },
      pendingTools: 1,
      turns: 7,
      usage: { input: 100, output: 50, cacheRead: 0, cacheWrite: 0, costUsd: 0.41 },
      lastEventAt: 1_799_000, // idle 3s at NOW
      escalation: [],
      orphaned: false,
      generation: 1,
      degraded: [],
      staleInputs: 0,
      unkillable: [],
      ...(overtime === undefined ? {} : { overtime }),
    },
    updatedAt: NOW,
  };
}

describe("delivery/deadline-notice: formatDeadlineNotice — grace (arch §5.3)", () => {
  it("renders the full seven-line template: who, grace left, Now, copyable call, budget, opt-out, task", () => {
    const text = formatDeadlineNotice(graceNotice(), { now: NOW, snapshot: snapshot() });
    const lines = text.split("\n");
    expect(lines[0]).toBe('⏳ Subagent "reviewer" (#a1b2c3d4) hit its 30m00s time budget and is STILL RUNNING.');
    expect(lines[1]).toBe(
      "Grace: 1m26s left — after that it is killed as timed_out and you only get its partial output.",
    );
    expect(lines[2]).toBe("Now: tool_exec (bash) · 7 turns · $0.41 · idle 3s");
    // A complete, directly copyable call — with the suggestion in SECONDS (D-12), never raw ms.
    expect(lines[3]).toBe('Give it more time:  extend_subagent_timeout(run_id: "a1b2c3d4", extend_s: 600)');
    expect(lines[4]).toBe("Budget left: 3 of 3 extensions, at most 29m58s more.");
    expect(lines[5]).toBe("Doing nothing lets it expire — that is a valid choice if its partial result is enough.");
    expect(lines[6]).toBe("Task: 审查 src/delivery 的投递生命周期并给出风险清单");
    expect(text).not.toContain("600000"); // no millisecond leakage into the suggestion
  });

  it("omits the Now: line and the budget duration when no snapshot is available", () => {
    const text = formatDeadlineNotice(graceNotice(), { now: NOW });
    expect(text).not.toContain("Now:");
    expect(text).toContain("hit its time budget and is STILL RUNNING.");
    expect(text).toContain('extend_subagent_timeout(run_id: "a1b2c3d4", extend_s: 600)');
  });

  it("floors the suggested extend_s at 1 and rounds to whole seconds", () => {
    const text = formatDeadlineNotice(graceNotice({ suggestedExtendMs: 400 }), { now: NOW });
    expect(text).toContain("extend_s: 1");
    const rounded = formatDeadlineNotice(graceNotice({ suggestedExtendMs: 90_500 }), { now: NOW });
    expect(rounded).toContain("extend_s: 91"); // Math.round(90.5)
  });

  it("renders without a label (bare short id) and without a task preview", () => {
    const text = formatDeadlineNotice(graceNotice({ label: undefined, taskPreview: undefined }), {
      now: NOW,
      snapshot: snapshot(),
    });
    expect(text).toContain("⏳ Subagent #a1b2c3d4 hit its");
    expect(text).not.toContain("Task:");
  });
});

describe("delivery/deadline-notice: formatDeadlineNotice — extended (arch §5.4)", () => {
  it("renders the one-line receipt with usage count and headroom", () => {
    const text = formatDeadlineNotice(extendedNotice(), { now: NOW, snapshot: snapshot() });
    expect(text).toBe(
      '⏳ Run "reviewer" (#a1b2c3d4) deadline extended by 10m00s (2 of 3 extensions used, 20m00s headroom left).',
    );
  });

  it("appends the reason from the live snapshot's overtime audit when present", () => {
    const snap = snapshot({ graces: 1, extensions: 2, grantedMs: 1_200_000, lastReason: "需要跑完全量测试" });
    const text = formatDeadlineNotice(extendedNotice(), { now: NOW, snapshot: snap });
    expect(text).toContain("Reason: 需要跑完全量测试");
  });
});

describe("delivery/deadline-notice: shouldDeliverDeadlineNotice (arch §5.5 truth table)", () => {
  const ack = { expectsAck: () => true, autoBackgrounded: () => false };
  const ackBg = { expectsAck: () => true, autoBackgrounded: () => true };
  const noAck = { expectsAck: () => false, autoBackgrounded: () => false };

  it('policy "off" delivers nothing (grace still applies — only the notice is silenced)', () => {
    expect(shouldDeliverDeadlineNotice(graceNotice(), { policy: "off", ...noAck })).toBe(false);
    expect(shouldDeliverDeadlineNotice(extendedNotice(), { policy: "off", ...noAck })).toBe(false);
  });

  it('policy "background" skips a run whose foreground caller-ack still blocks the host', () => {
    expect(shouldDeliverDeadlineNotice(graceNotice(), { policy: "background", ...ack })).toBe(false);
  });

  it('policy "background" delivers once the run auto-backgrounded (host unblocked)', () => {
    expect(shouldDeliverDeadlineNotice(graceNotice(), { policy: "background", ...ackBg })).toBe(true);
  });

  it('policy "background" delivers runs nobody is synchronously waiting on', () => {
    expect(shouldDeliverDeadlineNotice(graceNotice(), { policy: "background", ...noAck })).toBe(true);
  });

  it('policy "always" (debug only, D-17) ignores the caller-ack rule', () => {
    expect(shouldDeliverDeadlineNotice(graceNotice(), { policy: "always", ...ack })).toBe(true);
  });

  it("an extended receipt is deliverable but display-only for the model (deliveryOptionsFor owns that boundary)", () => {
    expect(shouldDeliverDeadlineNotice(extendedNotice(), { policy: "background", ...noAck })).toBe(true);
    expect(deliveryOptionsFor(extendedNotice())).toEqual({ triggerTurn: false });
  });
});

describe("delivery/deadline-notice: deliveryOptionsFor / channel type", () => {
  it("grace wakes the model into a decision turn; extended never does", () => {
    expect(deliveryOptionsFor(graceNotice())).toEqual({ triggerTurn: true });
    expect(deliveryOptionsFor(extendedNotice())).toEqual({ triggerTurn: false });
  });

  it("the channel is distinct from subagent:notification (receipt hook must not count it)", () => {
    expect(TIMEOUT_NOTICE_TYPE).toBe("subagent:timeout");
    expect(TIMEOUT_NOTICE_TYPE).not.toBe("subagent:notification");
  });
});

describe("delivery/deadline-notice: overtimeTail (arch §5.6)", () => {
  it("empty without a snapshot or without any overtime", () => {
    expect(overtimeTail(undefined)).toBe("");
    expect(overtimeTail(snapshot().diag)).toBe("");
    expect(overtimeTail(snapshot({ graces: 0, extensions: 0, grantedMs: 0 }).diag)).toBe("");
  });

  it("singular and plural extension counts", () => {
    expect(overtimeTail(snapshot({ graces: 1, extensions: 1, grantedMs: 600_000 }).diag)).toBe(
      " (finished in overtime; 1 extension used)",
    );
    expect(overtimeTail(snapshot({ graces: 1, extensions: 2, grantedMs: 1_200_000 }).diag)).toBe(
      " (finished in overtime; 2 extensions used)",
    );
    // A grace without any extension still counts as overtime.
    expect(overtimeTail(snapshot({ graces: 1, extensions: 0, grantedMs: 0 }).diag)).toBe(
      " (finished in overtime; 0 extensions used)",
    );
  });
});
