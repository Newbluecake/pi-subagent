import { describe, expect, it } from "vitest";
import { createDeliveryEngine } from "../../src/delivery/engine.js";
import { MemoryOutboxStore } from "../../src/core/store.js";
import type { FabricRecord } from "../../src/core/message.js";

const base = (state: FabricRecord["state"] = "pending"): FabricRecord => ({
  key: "r_ABCDEFGH:root:1:1" as FabricRecord["key"],
  from: "r_ABCDEFGH",
  to: "root",
  kind: "finding",
  seq: 1,
  generation: 1,
  payload: { text: "hello" },
  ttlMs: 100,
  createdAt: 0,
  state,
  attempts: 0,
  updatedAt: 0,
});

function setup(store = new MemoryOutboxStore<FabricRecord>()) {
  let now = 10;
  const degraded: string[] = [];
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
    now: () => now++,
    onDegraded: (key) => degraded.push(key),
  });
  return { engine, store, degraded };
}

describe("DeliveryEngine", () => {
  it("claims without writing, rejects a second claim, and strips memory fields", () => {
    const { engine, store } = setup();
    expect(engine.put(base())).toBe(true);
    expect(engine.claim(base().key, "mailbox:0")?.claimToken).toBe("mailbox:0");
    expect(engine.claim(base().key, "other:0")).toBeUndefined();
    expect(store.list()[0]?.claimToken).toBeUndefined();
    expect(engine.get(base().key)?.state).toBe("claimed");
  });

  it("applies transitions in memory first when persistence fails", () => {
    const store = new MemoryOutboxStore<FabricRecord>();
    const original = store.update.bind(store);
    store.update = (key, patch) => {
      if (patch.state === "delivered") throw new Error("disk full");
      original(key, patch);
    };
    const { engine, degraded } = setup(store);
    engine.put(base());
    expect(engine.claim(base().key, "mailbox:0")).toBeDefined();
    expect(engine.transition(base().key, "claimed", "delivered")?.state).toBe("delivered");
    expect(engine.get(base().key)?.state).toBe("delivered");
    expect(store.list()[0]?.state).toBe("pending");
    expect(degraded).toEqual([base().key]);
  });

  it("does not retain a put that throws and freezes all mutators", () => {
    const store = new MemoryOutboxStore<FabricRecord>();
    store.put = () => {
      throw new Error("disk full");
    };
    const { engine } = setup(store);
    expect(() => engine.put(base())).toThrow("disk full");
    expect(engine.get(base().key)).toBeUndefined();
    const healthy = setup();
    healthy.engine.put(base());
    healthy.engine.freeze();
    expect(healthy.engine.claim(base().key, "x")).toBeUndefined();
    expect(healthy.engine.transition(base().key, "pending", "dropped")).toBeUndefined();
    expect(healthy.engine.annotate(base().key, { terminalReason: "x" })).toBe(false);
    expect(healthy.engine.get(base().key)?.state).toBe("pending");
  });

  it("folds the latest record and normalizes claimed to pending", () => {
    const { engine } = setup();
    const old = base("pending");
    const latest = { ...base("claimed"), updatedAt: 20, attempts: 2, claimToken: "old:2" };
    const folded = engine.fold([old, latest]);
    expect(folded.get(old.key)).toMatchObject({ state: "pending", attempts: 2 });
    expect(folded.get(old.key)).not.toHaveProperty("claimToken");
  });

  it("annotates without changing state", () => {
    const { engine } = setup();
    engine.put(base());
    expect(engine.annotate(base().key, { terminalReason: "audit" })).toBe(true);
    expect(engine.get(base().key)).toMatchObject({ state: "pending", terminalReason: "audit" });
  });
});
