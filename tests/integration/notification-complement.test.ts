import { describe, expect, it, vi } from "vitest";
import { buildSessionStack } from "../../src/stack.js";
import { DEFAULT_SETTINGS } from "../../src/config/settings.js";
import type { AgentTypeRegistry } from "../../src/config/agent-types.js";
import type { DeliveryPayload } from "../../src/core/types.js";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";

function buildStackForSender() {
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
  const settings = { ...DEFAULT_SETTINGS, fleetWidget: false };
  return { stack: buildSessionStack(pi, ctx, settings, types, []), sendMessage };
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
});
