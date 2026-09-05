import { describe, expect, it } from "vitest";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { DEFAULT_SETTINGS } from "../../src/config/settings.js";
import type { AgentTypeRegistry } from "../../src/config/agent-types.js";
import type { DeliveryPayload } from "../../src/core/types.js";
import { buildSessionStack, createNotificationReceiptHook } from "../../src/stack.js";

function fakePi() {
  const handlers = new Map<string, Array<(event: unknown, ctx: unknown) => unknown>>();
  const sent: unknown[] = [];
  const pi = {
    registerTool: () => undefined,
    registerCommand: () => undefined,
    on: (event: string, handler: (event: unknown, ctx: unknown) => unknown) => {
      const list = handlers.get(event) ?? [];
      list.push(handler);
      handlers.set(event, list);
    },
    sendMessage: (message: unknown) => sent.push(message),
    appendEntry: () => undefined,
    events: { on: () => () => undefined, emit: () => undefined },
    exec: async () => ({ code: 0, stdout: "", stderr: "", killed: false }),
  };
  return {
    pi: pi as unknown as ExtensionAPI,
    sent,
    async trigger(event: string, payload: unknown) {
      for (const handler of handlers.get(event) ?? []) await handler(payload, {});
    },
  };
}

function fakeCtx(branch: readonly unknown[] = []): ExtensionContext {
  return {
    sessionManager: { getEntries: () => [], getBranch: () => branch, getSessionId: () => "receipt-test" },
    modelRegistry: { getAvailable: () => [], find: () => undefined },
    ui: {},
    cwd: process.cwd(),
  } as unknown as ExtensionContext;
}

const types = {
  get: () => undefined,
  list: () => [],
  reload: async () => ({ types: [], errors: [] }),
} as unknown as AgentTypeRegistry;
const payload = (runId: string): DeliveryPayload => ({
  key: `${runId}:1`,
  runId,
  generation: 1,
  status: "completed",
  textPreview: "done",
  diag: { phase: "settled", status: "completed", pendingTools: 0, staleInputs: 0, degraded: 0 },
  createdAt: 0,
  reconcileRound: 0,
});

function buildTestStack(branch: readonly unknown[] = []) {
  const harness = fakePi();
  const result = buildSessionStack(
    harness.pi,
    fakeCtx(branch),
    {
      ...DEFAULT_SETTINGS,
      fleetWidget: false,
      bashJobs: { ...DEFAULT_SETTINGS.bashJobs, autoBackgroundMs: 0 },
    },
    types,
    [],
  );
  return { ...harness, stack: result };
}

describe("context receipt stack wiring", () => {
  it("exposes a tracker and seeds entered notifications from the current branch", () => {
    const runId = "r_seed";
    const { stack } = buildTestStack([
      {
        type: "custom_message",
        customType: "subagent:notification",
        details: { runId },
        timestamp: new Date(1000).toISOString(),
      },
    ]);
    expect(stack.contextReceipt.receiptOf(runId)).toEqual({ kind: "entered", at: 1000 });
  });

  it("fans notifier delivery states into pending and consumed receipts", () => {
    const runId = "r_delivery";
    const { stack } = buildTestStack();
    stack.notifier.enqueue(payload(runId));
    expect(stack.contextReceipt.receiptOf(runId).kind).toBe("pending");
    expect(stack.notifier.consume(`${runId}:1`)).toBe(true);
    expect(stack.contextReceipt.receiptOf(runId).kind).toBe("entered");
  });

  it("routes message_start through the production hook (single + digest + filter negatives)", async () => {
    const harness = fakePi();
    const stack = buildSessionStack(
      harness.pi,
      fakeCtx(),
      { ...DEFAULT_SETTINGS, fleetWidget: false, bashJobs: { ...DEFAULT_SETTINGS.bashJobs, autoBackgroundMs: 0 } },
      types,
      [],
    );
    // The real handler index.ts registers in activate(): filter + parse + forward.
    harness.pi.on("message_start", createNotificationReceiptHook({ current: stack }));
    stack.contextReceipt.noteDelivery("r_single", 1, "pending", 0);
    stack.contextReceipt.noteDelivery("r_digest_a", 1, "pending", 0);
    stack.contextReceipt.noteDelivery("r_digest_b", 1, "pending", 0);
    await harness.trigger("message_start", {
      message: { role: "custom", customType: "subagent:notification", details: { runId: "r_single" } },
    });
    await harness.trigger("message_start", {
      message: {
        role: "custom",
        customType: "subagent:notification",
        details: { kind: "digest", items: [{ runId: "r_digest_a" }, { runId: "r_digest_b" }] },
      },
    });
    expect(stack.contextReceipt.receiptOf("r_single").kind).toBe("entered");
    expect(stack.contextReceipt.receiptOf("r_digest_a").kind).toBe("entered");
    expect(stack.contextReceipt.receiptOf("r_digest_b").kind).toBe("entered");
    // Filter negatives: other roles/customTypes must not touch the tracker.
    await harness.trigger("message_start", {
      message: { role: "user", customType: "subagent:notification", details: { runId: "r_other" } },
    });
    await harness.trigger("message_start", {
      message: { role: "custom", customType: "bash-job:notification", details: { runId: "r_other" } },
    });
    expect(stack.contextReceipt.receiptOf("r_other").kind).toBe("untracked");
    // A missing stack (pre-session_start) must be a no-op, not a throw.
    const orphanHook = createNotificationReceiptHook({});
    expect(() =>
      orphanHook({ message: { role: "custom", customType: "subagent:notification", details: { runId: "r_x" } } }),
    ).not.toThrow();
  });
});
