import { describe, expect, it } from "vitest";
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
