import { describe, expect, it } from "vitest";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { DEFAULT_SETTINGS, type AgentSettings } from "../../src/config/settings.js";
import type { AgentTypeRegistry } from "../../src/config/agent-types.js";
import { buildSessionStack } from "../../src/stack.js";
import { makeMessageKey, type FabricRecord } from "../../src/core/message.js";

const run = "r_ABCDEFGH" as const;
const target = "r_12345678" as const;

type Entry = { type: string; customType?: string; data?: unknown };
function harness(entries: Entry[] = []) {
  const appended: Entry[] = [];
  const sent: unknown[] = [];
  const pi = {
    appendEntry(customType: string, data?: unknown) {
      const entry = { type: "custom", customType, data };
      entries.push(entry);
      appended.push(entry);
    },
    sendMessage(message: unknown) {
      sent.push(message);
    },
    registerEntryRenderer() {},
    exec: async () => ({ code: 0, stdout: "", stderr: "", killed: false }),
    events: { on: () => () => undefined, emit: () => undefined },
  } as unknown as ExtensionAPI;
  const ctx = {
    sessionManager: { getEntries: () => entries, getSessionId: () => "fabric-integration" },
    modelRegistry: { getAvailable: () => [], find: () => undefined },
    ui: {},
    cwd: process.cwd(),
  } as unknown as ExtensionContext;
  return { pi, ctx, appended, sent };
}

const types = {
  get: () => undefined,
  list: () => [],
  reload: async () => ({ types: [], errors: [] }),
} as unknown as AgentTypeRegistry;
function settings(enabled: boolean): AgentSettings {
  return {
    ...DEFAULT_SETTINGS,
    fleetWidget: false,
    fabric: { ...DEFAULT_SETTINGS.fabric, enabled, progressChannel: "display", minIntervalMs: 0, rootMinIntervalMs: 0 },
    bashJobs: { ...DEFAULT_SETTINGS.bashJobs, autoBackgroundMs: 0 },
  };
}
function record(patch: Partial<FabricRecord> = {}): FabricRecord {
  return {
    key: makeMessageKey(run, "root", 1, 1),
    from: run,
    to: "root",
    kind: "progress",
    seq: 1,
    generation: 1,
    payload: { text: "repeatable" },
    ttlMs: 100_000,
    createdAt: Date.now(),
    updatedAt: Date.now(),
    state: "pending",
    attempts: 0,
    ...patch,
  };
}
function runEntry(status: string): Entry {
  return { type: "custom", customType: "subagent:run", data: { runId: run, parentRunId: "root", status } };
}

// These tests exercise the stack assembly, while using appendEntry as the real
// durable boundary that reloads read back through sessionManager.getEntries().
describe("fabric stack wiring", () => {
  it("T17 reloads a claimed record as pending and permits exactly one at-least-once repeat", async () => {
    const entries: Entry[] = [runEntry("running"), { type: "custom", customType: "subagent:fabric", data: record() }];
    const first = harness(entries);
    const stack1 = buildSessionStack(first.pi, first.ctx, settings(true), types, []);
    stack1.fabric!.pump();
    expect(first.appended.filter((entry) => entry.customType === "subagent:fabric")).toHaveLength(1);
    stack1.fabric!.dispose();
    const second = harness(entries);
    const stack2 = buildSessionStack(second.pi, second.ctx, settings(true), types, []);
    stack2.fabric!.pump();
    expect(second.appended.filter((entry) => entry.customType === "subagent:fabric")).toHaveLength(1);
    await Promise.resolve();
    await Promise.resolve();
    const latest = entries.filter((entry) => entry.customType === "subagent:fabric").at(-1)?.data as FabricRecord;
    expect(latest.state).toBe("delivered");
    stack2.fabric!.dispose();
  });

  it("T18' repairs an issued dead-letter reference after reload without another put", () => {
    const orig = record({ kind: "finding", to: target, key: makeMessageKey(run, target, 1, 1) });
    const deadKey = makeMessageKey("system", run, 0, 1);
    const dead = {
      ...record({ key: deadKey, from: "system", to: run, kind: "dead_letter", generation: 0 as never, seq: 1 }),
      ref: { keys: [orig.key], omittedCount: 0 },
    };
    const entries: Entry[] = [
      runEntry("completed"),
      { type: "custom", customType: "subagent:fabric", data: orig },
      { type: "custom", customType: "subagent:fabric", data: dead },
    ];
    const h = harness(entries);
    const stack = buildSessionStack(h.pi, h.ctx, settings(true), types, []);
    const beforeDeadKeys = entries
      .filter((entry) => entry.customType === "subagent:fabric" && (entry.data as FabricRecord).kind === "dead_letter")
      .map((entry) => (entry.data as FabricRecord).key);
    stack.fabric!.pump();
    const fabricEntries = entries
      .filter((entry) => entry.customType === "subagent:fabric")
      .map((entry) => entry.data as FabricRecord);
    const repaired = fabricEntries.filter((entry) => entry.key === orig.key).at(-1)!;
    expect(repaired.state).toBe("dropped");
    expect(repaired.deadLetter).toEqual({ reason: "target_gone", status: "issued", key: deadKey });
    const deadKeys = entries
      .filter((entry) => entry.customType === "subagent:fabric" && (entry.data as FabricRecord).kind === "dead_letter")
      .map((entry) => (entry.data as FabricRecord).key);
    expect(new Set(deadKeys)).toEqual(new Set(beforeDeadKeys));
    stack.fabric!.dispose();
  });

  it("T19 fabric.enabled=false creates no fabric, mailbox, or fabric outbox writes", () => {
    const h = harness();
    const stack = buildSessionStack(h.pi, h.ctx, settings(false), types, []);
    expect(stack.fabric).toBeUndefined();
    expect(h.appended.filter((entry) => entry.customType === "subagent:fabric")).toHaveLength(0);
  });
});
