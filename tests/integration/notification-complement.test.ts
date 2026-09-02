import { describe, expect, it, vi } from "vitest";
import { buildSessionStack } from "../../src/stack.js";
import { DEFAULT_SETTINGS } from "../../src/config/settings.js";
import type { AgentTypeRegistry } from "../../src/config/agent-types.js";
import type { DeliveryPayload } from "../../src/core/types.js";
import { FakeClock } from "../../src/core/clock.js";
import { MemoryOutboxStore } from "../../src/core/store.js";
import { createCoalescer, isCoalescible } from "../../src/delivery/coalescer.js";
import { createNotifier, type PersistedDelivery } from "../../src/delivery/notifier.js";
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
    // S7: never let a stack built in a test scan/mutate the developer's real
    // ~/.pi/agent/bash-jobs (buildSessionStack now constructs a BashJobManager).
    bashJobs: { ...DEFAULT_SETTINGS.bashJobs, autoBackgroundMs: 0 },
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

  it("11+16: ackWindow suppresses a claimed foreground result and sends an unacknowledged one after timeout", () => {
    const clock = new FakeClock();
    const store = new MemoryOutboxStore<PersistedDelivery>();
    const sent: DeliveryPayload[] = [];
    const claimed = new Set(["foreground"]);
    let notifier!: ReturnType<typeof createNotifier>;
    const ackHold = createCoalescer({
      clock,
      windowMs: 200,
      maxBatch: 8,
      send: (items) => sent.push(...items),
      onSettled: (keys, ok) => notifier.settleBatch(keys, ok),
    });
    const isAckHoldable = (item: DeliveryPayload) => isCoalescible(item) && claimed.has(item.runId);
    notifier = createNotifier({
      store,
      clock,
      cancelBuffered: (key) => ackHold.cancel(key),
      sender: {
        willBuffer: isAckHoldable,
        sendMessage: (item) => (isAckHoldable(item) ? ackHold.submit(item) : (sent.push(item), "sent")),
      },
    });
    const foreground = { ...payload("foreground"), key: "foreground:1", runId: "foreground" };
    notifier.enqueue(foreground);
    expect(store.list()[0]?.state).toBe("batched");
    expect(notifier.ack("foreground", 1)).toBe(true);
    clock.advance(200);
    expect(sent).toHaveLength(0);
    expect(store.list()[0]?.state).toBe("consumed");
    expect(notifier.ackedSuppressions).toBe(1);

    claimed.add("foreground-late");
    const unacknowledged = { ...payload("foreground-late"), key: "foreground-late:1", runId: "foreground-late" };
    notifier.enqueue(unacknowledged);
    expect(sent).toHaveLength(0);
    clock.advance(200);
    expect(sent).toHaveLength(1);
    expect(sent[0]!.key).toBe("foreground-late:1");
  });

  it("12: a background completed result bypasses ackHold and sends immediately", () => {
    const clock = new FakeClock();
    const store = new MemoryOutboxStore<PersistedDelivery>();
    const sent: DeliveryPayload[] = [];
    let notifier!: ReturnType<typeof createNotifier>;
    const ackHold = createCoalescer({
      clock,
      windowMs: 200,
      maxBatch: 8,
      send: (items) => sent.push(...items),
      onSettled: (keys, ok) => notifier.settleBatch(keys, ok),
    });
    notifier = createNotifier({
      store,
      clock,
      cancelBuffered: (key) => ackHold.cancel(key),
      sender: { willBuffer: () => false, sendMessage: (item) => (sent.push(item), "sent") },
    });
    notifier.enqueue({ ...payload("background-now"), key: "background-now:1", runId: "background-now" });
    expect(sent).toHaveLength(1);
    expect(clock.pendingTimers).toBe(0);
  });

  it("14: when both windows are enabled the main coalescer wins and ack cancels both", () => {
    const clock = new FakeClock();
    const store = new MemoryOutboxStore<PersistedDelivery>();
    const claimed = new Set(["dual"]);
    const sent: DeliveryPayload[][] = [];
    let notifier!: ReturnType<typeof createNotifier>;
    const main = createCoalescer({
      clock,
      windowMs: 200,
      maxBatch: 8,
      send: (items) => sent.push([...items]),
      onSettled: (keys, ok) => notifier.settleBatch(keys, ok),
    });
    const ackHold = createCoalescer({
      clock,
      windowMs: 200,
      maxBatch: 8,
      send: (items) => sent.push([...items]),
      onSettled: (keys, ok) => notifier.settleBatch(keys, ok),
    });
    const holdable = (item: DeliveryPayload) => isCoalescible(item) && claimed.has(item.runId);
    notifier = createNotifier({
      store,
      clock,
      cancelBuffered: (key) => {
        main.cancel(key);
        ackHold.cancel(key);
      },
      sender: {
        willBuffer: (item) => isCoalescible(item),
        sendMessage: (item) =>
          isCoalescible(item) ? main.submit(item) : holdable(item) ? ackHold.submit(item) : (sent.push([item]), "sent"),
      },
    });
    notifier.enqueue({ ...payload("dual"), key: "dual:1", runId: "dual" });
    expect(notifier.ack("dual", 1)).toBe(true);
    clock.advance(200);
    expect(sent).toHaveLength(0);
    expect(notifier.ackedSuppressions).toBe(1);
  });
});
