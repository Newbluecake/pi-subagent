import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { DEFAULT_SETTINGS } from "../../src/config/settings.js";
import type { AgentTypeRegistry } from "../../src/config/agent-types.js";
import type { RunOutcome } from "../../src/core/types.js";
import type { PersistedDelivery } from "../../src/delivery/notifier.js";
import type { SpawnServiceDeps } from "../../src/service/spawn-service.js";

const harness = vi.hoisted(() => ({
  records: new Map<string, PersistedDelivery>(),
  listError: undefined as Error | undefined,
  spawnDeps: undefined as SpawnServiceDeps | undefined,
}));

vi.mock("../../src/adapters/pi-outbox-store.js", async (importOriginal) => {
  const original = await importOriginal<typeof import("../../src/adapters/pi-outbox-store.js")>();
  return {
    ...original,
    createPiOutboxStore: () => ({
      put: (record: PersistedDelivery) => harness.records.set(record.key, record),
      update: (key: string, patch: Partial<PersistedDelivery>) => {
        const current = harness.records.get(key);
        if (current) harness.records.set(key, { ...current, ...patch });
      },
      list: () => {
        if (harness.listError) throw harness.listError;
        return [...harness.records.values()];
      },
    }),
  };
});

vi.mock("../../src/service/spawn-service.js", async (importOriginal) => {
  const original = await importOriginal<typeof import("../../src/service/spawn-service.js")>();
  return {
    ...original,
    createSpawnService: (deps: SpawnServiceDeps) => {
      harness.spawnDeps = deps;
      return {
        spawn: async () => ({ error: { kind: "config" as const, message: "unused", retryable: false } }),
        spawnAndWait: async () => {
          throw new Error("unused");
        },
        abort: async () => false,
        waitAll: async () => ({ settled: [], pending: [] }),
        stopChildrenOf: async () => ({ stopped: [], pending: [] }),
        resolveRun: () => ({ ok: false as const, error: "unused" }),
        resolveResume: () => ({ ok: false as const, error: "unused" }),
        snapshots: () => [],
      };
    },
  };
});

function outcome(): RunOutcome {
  return {
    runId: "r_failure",
    status: "failed",
    turns: 0,
    durationMs: 0,
    error: { kind: "runtime", message: "boom" },
    diag: {
      createdAt: 0,
      phase: "settled",
      phaseEnteredAt: 0,
      pendingTools: 0,
      turns: 0,
      escalation: [],
      orphaned: false,
      generation: 1,
      degraded: [],
      staleInputs: 0,
      unkillable: [],
    },
  };
}

async function buildHarness() {
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
  const { buildSessionStack } = await import("../../src/stack.js");
  const stack = buildSessionStack(pi, ctx, { ...DEFAULT_SETTINGS, fleetWidget: false }, types, []);
  return { sendMessage, notify: harness.spawnDeps!.notifyTerminalFailure!, stack };
}

function existing(state?: PersistedDelivery["state"]): PersistedDelivery {
  return {
    key: "r_failure:1",
    runId: "r_failure",
    generation: 1,
    status: "completed",
    textPreview: "old",
    diag: { phase: "settled", status: "completed", pendingTools: 0, staleInputs: 0, degraded: 0 },
    createdAt: 0,
    reconcileRound: 0,
    ...(state === undefined ? {} : { state }),
  };
}

beforeEach(() => {
  harness.records.clear();
  harness.listError = undefined;
  harness.spawnDeps = undefined;
});

describe("terminal failure notification deduplication", () => {
  it.each(["pending", "delivered", "consumed"] as const)(
    "does not resend when an existing delivery is %s",
    async (state) => {
      harness.records.set(existing(state).key, existing(state));
      const { sendMessage, notify } = await buildHarness();
      notify(outcome());
      expect(sendMessage).not.toHaveBeenCalled();
    },
  );

  it("resends when the existing delivery was dropped", async () => {
    harness.records.set(existing("dropped").key, existing("dropped"));
    const { sendMessage, notify } = await buildHarness();
    notify(outcome());
    expect(sendMessage).toHaveBeenCalledOnce();
  });

  it("treats a legacy delivery without state as pending", async () => {
    harness.records.set(existing().key, existing());
    const { sendMessage, notify } = await buildHarness();
    notify(outcome());
    expect(sendMessage).not.toHaveBeenCalled();
  });

  it("sends when existing deliveries cannot be listed", async () => {
    harness.listError = new Error("outbox unavailable");
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const { sendMessage, notify } = await buildHarness();
    notify(outcome());
    expect(sendMessage).toHaveBeenCalledOnce();
    expect(sendMessage.mock.calls[0]![0].details.key).toBe("r_failure:1");
    expect(warn).toHaveBeenCalledWith(expect.stringContaining("runId uniqueness degrades"));
    warn.mockRestore();
  });

  it("merges a staged F1 failure through finalize without enqueueing a second record", async () => {
    harness.records.set(existing("staged").key, existing("staged"));
    const { sendMessage, notify } = await buildHarness();
    notify(outcome());
    expect(sendMessage).toHaveBeenCalledOnce();
    expect(harness.records.get("r_failure:1")?.state).toBe("delivered");
    expect(harness.records.get("r_failure:1")?.finalized).toBe(true);
    expect(harness.records.size).toBe(1);
    expect(sendMessage.mock.calls[0]![0].details.status).toBe("failed");
  });

  it("revives abandoned F1 deliveries and skips batched deliveries", async () => {
    harness.records.set(existing("abandoned").key, existing("abandoned"));
    const first = await buildHarness();
    first.notify(outcome());
    expect(first.sendMessage).toHaveBeenCalledOnce();

    harness.records.clear();
    harness.records.set(existing("batched").key, existing("batched"));
    const second = await buildHarness();
    second.notify(outcome());
    expect(second.sendMessage).not.toHaveBeenCalled();
  });

  it("marks pre-finalize delivery text as degraded and points to result retrieval", async () => {
    const { sendMessage, stack } = await buildHarness();
    stack.notifier.enqueue({ ...existing("pending"), degradedReason: "pre-finalize", finalized: false });
    expect(sendMessage.mock.calls[0]![0].content).toContain("pre-finalize snapshot");
    expect(sendMessage.mock.calls[0]![0].content).toContain('get_subagent_result "r_failur"');
  });
});
