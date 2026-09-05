import { describe, expect, it } from "vitest";
import type { OutboxStore } from "../../src/core/store.js";
import { MemoryOutboxStore } from "../../src/core/store.js";
import type { FabricRecord } from "../../src/core/message.js";
import { createDeliveryEngine } from "../../src/delivery/engine.js";
import { FabricTree } from "../../src/fabric/tree.js";
import { FabricThrottle } from "../../src/fabric/throttle.js";
import { FabricRouter } from "../../src/fabric/router.js";

const config = {
  maxPerRun: 2,
  findingQuota: 2,
  directiveQuota: 2,
  deadLetterQuota: 1,
  maxChars: 100,
  progressTtlMs: 100,
  reconcileTtlMs: 100,
  rootInboxCap: 1,
  progressChannel: "display" as const,
};
function setup() {
  const store = new MemoryOutboxStore<FabricRecord>();
  const engine = createDeliveryEngine<FabricRecord, FabricRecord["state"]>({
    store,
    allowed: {
      pending: ["claimed", "consumed", "dropped", "abandoned"],
      claimed: ["pending", "delivered", "consumed", "dropped"],
      delivered: [],
      consumed: [],
      dropped: [],
      abandoned: [],
    },
    memoryOnly: new Set(["claimed"]),
    memoryOnlyFields: ["claimToken"],
    now: () => 1,
  });
  const tree = new FabricTree();
  tree.append("root", "r_ABCDEFGH");
  tree.append("root", "r_12345678");
  tree.markRunning("r_ABCDEFGH");
  tree.markRunning("r_12345678");
  const throttle = new FabricThrottle({ minIntervalMs: 0, rootMinIntervalMs: 0, backoffMs: 0 });
  const router = new FabricRouter(engine, tree, throttle, config, () => 1);
  return { store, engine, router };
}

const original = (patch: Partial<FabricRecord> = {}): FabricRecord => ({
  key: "r_ABCDEFGH:r_12345678:1:1" as FabricRecord["key"],
  from: "r_ABCDEFGH",
  to: "r_12345678",
  kind: "finding",
  seq: 1,
  generation: 1,
  payload: { text: "failure" },
  ttlMs: 100,
  createdAt: 0,
  updatedAt: 1,
  state: "pending",
  attempts: 0,
  ...patch,
});

class FailingUpdateStore implements OutboxStore<FabricRecord> {
  constructor(
    private readonly records: FabricRecord[],
    private failUpdates = false,
  ) {}
  put(record: FabricRecord): void {
    this.records.push(record);
  }
  update(key: string, patch: Partial<FabricRecord>): void {
    if (this.failUpdates) throw new Error("update failed");
    const index = this.records.findIndex((record) => record.key === key);
    if (index >= 0) this.records[index] = { ...this.records[index]!, ...patch };
  }
  list(): readonly FabricRecord[] {
    return this.records;
  }
  setFailUpdates(value: boolean): void {
    this.failUpdates = value;
  }
}

function makeRouter(store: OutboxStore<FabricRecord>, now = 1, deadLetterQuota = 1) {
  const engine = createDeliveryEngine<FabricRecord, FabricRecord["state"]>({
    store,
    allowed: {
      pending: ["claimed", "consumed", "dropped", "abandoned"],
      claimed: ["pending", "delivered", "consumed", "dropped"],
      delivered: [],
      consumed: [],
      dropped: [],
      abandoned: [],
    },
    memoryOnly: new Set(["claimed"]),
    memoryOnlyFields: ["claimToken"],
    now: () => now,
  });
  const tree = new FabricTree();
  tree.append("root", "r_ABCDEFGH");
  tree.append("root", "r_12345678");
  tree.markRunning("r_ABCDEFGH");
  tree.markRunning("r_12345678");
  const router = new FabricRouter(
    engine,
    tree,
    new FabricThrottle({ minIntervalMs: 0, rootMinIntervalMs: 0, backoffMs: 0 }),
    { ...config, deadLetterQuota },
    () => now,
  );
  return { engine, tree, router };
}

describe("fabric router", () => {
  it("consumes seq for root backpressure and does not consume quota", () => {
    const { router, engine } = setup();
    const first = router.admit("r_ABCDEFGH", {
      to: "root",
      kind: "finding",
      text: "one",
      generation: 1,
      canMessage: ["child"],
    });
    const second = router.admit("r_12345678", {
      to: "root",
      kind: "finding",
      text: "two",
      generation: 1,
      canMessage: ["child"],
    });
    expect(first.ok).toBe(true);
    expect(second).toMatchObject({ ok: false, status: "target_backpressure", seq: 1 });
    expect(engine.select((r) => r.rejected !== undefined)).toHaveLength(1);
  });
  it("repairs issued and suppressed dead-letter references without new puts or quota checks", () => {
    for (const [status, reason, key] of [
      ["issued", "target_gone", "system:r_ABCDEFGH:0:1"],
      ["suppressed_quota", "attempts_exhausted", undefined],
      ["suppressed_sender_gone", "target_gone", undefined],
    ] as const) {
      const record = original();
      const store = new MemoryOutboxStore<FabricRecord>();
      store.put(record);
      const { engine, router } = makeRouter(store, 1, 0);
      const outcome = status === "issued" ? { status, key: key as FabricRecord["key"] } : { status };
      router.hydrate([
        {
          ...record,
          state: "dropped",
          deadLetter: { reason, status, ...(key ? { key: key as FabricRecord["key"] } : {}) },
        },
        ...(key
          ? [
              {
                ...original({
                  key: key as FabricRecord["key"],
                  from: "system",
                  to: "r_ABCDEFGH",
                  kind: "dead_letter",
                  generation: 0 as never,
                  seq: 1,
                }),
              },
            ]
          : []),
      ]);
      const before = store.list().length;
      router.issueDeadLetter(record, "target_gone");
      expect(engine.get(record.key)).toMatchObject({ state: "dropped", deadLetter: { reason: "target_gone", status } });
      expect(engine.get(record.key)?.deadLetter).toEqual({ reason: "target_gone", ...outcome });
      expect(store.list()).toHaveLength(before);
    }
  });

  it("retries a repair after transition persistence failure without duplicating the dead letter", () => {
    const orig = original();
    const deadKey = "system:r_ABCDEFGH:0:1" as FabricRecord["key"];
    const records = [orig];
    const store = new FailingUpdateStore(records, true);
    const first = makeRouter(store);
    first.router.issueDeadLetter(orig, "target_gone");
    expect(first.engine.get(orig.key)?.state).toBe("dropped");
    expect(store.list().find((r) => r.key === orig.key)?.state).toBe("pending");
    expect(store.list().filter((r) => r.kind === "dead_letter")).toHaveLength(1);

    const secondEngine = createDeliveryEngine<FabricRecord, FabricRecord["state"]>({
      store,
      allowed: {
        pending: ["claimed", "consumed", "dropped", "abandoned"],
        claimed: ["pending", "delivered", "consumed", "dropped"],
        delivered: [],
        consumed: [],
        dropped: [],
        abandoned: [],
      },
      memoryOnly: new Set(["claimed"]),
      memoryOnlyFields: ["claimToken"],
      now: () => 2,
    });
    const secondTree = first.tree;
    const second = new FabricRouter(
      secondEngine,
      secondTree,
      new FabricThrottle({ minIntervalMs: 0, rootMinIntervalMs: 0, backoffMs: 0 }),
      { ...config },
      () => 2,
    );
    second.hydrate([...secondEngine.select(() => true)]);
    store.setFailUpdates(false);
    second.issueDeadLetter(secondEngine.get(orig.key)!, "target_gone");
    expect(secondEngine.get(orig.key)).toMatchObject({
      state: "dropped",
      deadLetter: { status: "issued", key: deadKey },
    });
    expect(store.list().filter((r) => r.kind === "dead_letter")).toHaveLength(1);
  });

  it("enforces dead-letter quota across separate reap calls", () => {
    const first = original();
    const second = original({ key: "r_ABCDEFGH:r_12345678:1:2", seq: 2 });
    const store = new MemoryOutboxStore<FabricRecord>();
    store.put(first);
    store.put(second);
    const { engine, router } = makeRouter(store, 1, 1);
    router.issueDeadLetter(first, "target_gone");
    router.issueDeadLetter(second, "target_gone");
    expect(store.list().filter((r) => r.kind === "dead_letter")).toHaveLength(1);
    expect(engine.get(second.key)?.deadLetter).toMatchObject({ status: "suppressed_quota" });
    expect(engine.get(second.key)?.deadLetter).not.toHaveProperty("key");
  });

  it("rolls back the placeholder after dead-letter put failure so a later call can retry", () => {
    const orig = original();
    const records = [orig];
    const store = new FailingUpdateStore(records);
    const originalPut = store.put.bind(store);
    let fail = true;
    store.put = (record) => {
      if (fail) {
        fail = false;
        throw new Error("put failed");
      }
      originalPut(record);
    };
    const { engine, router } = makeRouter(store);
    expect(() => router.issueDeadLetter(orig, "target_gone")).toThrow("put failed");
    expect(engine.get(orig.key)?.state).toBe("pending");
    router.issueDeadLetter(orig, "target_gone");
    expect(store.list().filter((r) => r.kind === "dead_letter")).toHaveLength(1);
    expect(engine.get(orig.key)?.state).toBe("dropped");
  });

  it("supersedes only pending progress", () => {
    const { router, engine } = setup();
    const a = router.admit("r_ABCDEFGH", {
      to: "root",
      kind: "progress",
      text: "a",
      generation: 1,
      canMessage: ["child"],
    });
    const b = router.admit("r_ABCDEFGH", {
      to: "root",
      kind: "progress",
      text: "b",
      generation: 1,
      canMessage: ["child"],
    });
    expect(a.ok && engine.get(a.key)?.state).toBe("consumed");
    expect(b.ok).toBe(true);
  });
});
