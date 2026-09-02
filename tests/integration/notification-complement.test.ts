import { describe, expect, it, vi } from "vitest";
import { buildSessionStack } from "../../src/stack.js";
import { DEFAULT_SETTINGS } from "../../src/config/settings.js";
import type { AgentTypeRegistry } from "../../src/config/agent-types.js";
import type { DeliveryPayload } from "../../src/core/types.js";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";

function buildStackForSender(
  options: { coalesce?: boolean; onDelivery?: (p: DeliveryPayload, state: string) => void } = {},
) {
  const sendMessage = vi.fn();
  const pi = {
    appendEntry: vi.fn(),
    sendMessage,
    events: { emit: vi.fn(), on: vi.fn(() => () => undefined) },
  } as unknown as ExtensionAPI;
  const ctx = {
    sessionManager: { getEntries: () => [] },
    modelRegistry: { getAvailable: () => [], find: () => undefined },
    ui: {},
  } as unknown as ExtensionContext;
  const types = {
    get: () => undefined,
    list: () => [],
    reload: async () => ({ types: [], errors: [] }),
  } as unknown as AgentTypeRegistry;
  const settings = {
    ...DEFAULT_SETTINGS,
    fleetWidget: false,
    ...(options.coalesce ? { coalesceWindowMs: 100, coalesceMaxBatch: 3 } : {}),
  };
  const extensions = options.onDelivery ? [{ onDelivery: options.onDelivery }] : [];
  return { stack: buildSessionStack(pi, ctx, settings, types, extensions), sendMessage };
}

function payload(textPreview: string): DeliveryPayload {
  return {
    key: "r_123456:1",
    runId: "r_123456789",
    generation: 1,
    status: "completed",
    textPreview,
    diag: { phase: "settled", status: "completed", pendingTools: 0, staleInputs: 0, degraded: 0 },
    createdAt: 0,
    reconcileRound: 0,
  };
}

describe("notification sender output guidance", () => {
  it("does not append a retrieval hint when the output tail is at most 200 characters", () => {
    const { stack, sendMessage } = buildStackForSender();
    stack.notifier.enqueue(payload("x".repeat(200)));
    const content = sendMessage.mock.calls[0][0].content as string;
    expect(content).not.toContain("get_subagent_result");
  });

  it("appends a retrieval hint with a bare eight-character prefix when the output tail is truncated", () => {
    const { stack, sendMessage } = buildStackForSender();
    stack.notifier.enqueue(payload("x".repeat(201)));
    const content = sendMessage.mock.calls[0][0].content as string;
    expect(content).toContain('get_subagent_result "r_123456"');
    expect(content).not.toContain('get_subagent_result "#r_123456"');
  });

  it("19: keeps the windowMs=0 sender path immediate and P1-compatible", () => {
    const { stack, sendMessage } = buildStackForSender();
    stack.notifier.enqueue(payload("done"));
    expect(sendMessage).toHaveBeenCalledOnce();
    expect(sendMessage.mock.calls[0]![0]).toMatchObject({
      customType: "subagent:notification",
      display: true,
      details: payload("done"),
    });
    expect(sendMessage.mock.calls[0]![1]).toEqual({ triggerTurn: true });
  });

  it("20: emits one digest for three completed deliveries and fires onDelivery per item", () => {
    const seen: string[] = [];
    const { stack, sendMessage } = buildStackForSender({
      coalesce: true,
      onDelivery: (_payload, state) => seen.push(state),
    });
    const items = ["one", "two", "three"].map((key) => ({ ...payload(key), key: `${key}:1`, runId: `${key}-run` }));
    for (const item of items) stack.notifier.enqueue(item);
    expect(sendMessage).toHaveBeenCalledOnce();
    const message = sendMessage.mock.calls[0]![0];
    expect(message.details.kind).toBe("digest");
    expect(message.details.items).toHaveLength(3);
    expect(message.details.items.map((item: DeliveryPayload) => item.key)).toEqual(items.map((item) => item.key));
    expect(message.details.items).toEqual(
      expect.arrayContaining(
        items.map((item) => expect.objectContaining({ key: item.key, textPreview: item.textPreview })),
      ),
    );
    expect(message.details.runId).toBe(items[0]!.runId);
    expect(seen.filter((state) => state === "batched")).toHaveLength(3);
    expect(seen.filter((state) => state === "delivered")).toHaveLength(3);
    expect(sendMessage.mock.calls[0]![1]).toEqual({ triggerTurn: true });
  });
});
