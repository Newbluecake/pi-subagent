import { describe, expect, it } from "vitest";
import { MemoryOutboxStore } from "../../src/core/store.js";
import { createDeliveryEngine } from "../../src/delivery/engine.js";
import { FabricTree } from "../../src/fabric/tree.js";
import { FabricThrottle } from "../../src/fabric/throttle.js";
import { FabricRouter } from "../../src/fabric/router.js";
import { authorize, makeMessageKey, parseMessageKey, type MessageRelation } from "../../src/core/message.js";

function random(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
    return state / 0x1_0000_0000;
  };
}

describe("fabric seeded properties", () => {
  it("never authorizes a relation outside the matrix and keys always round-trip", () => {
    const next = random(0xfab1c);
    const relations: MessageRelation[] = ["self", "parent", "child", "ancestor", "descendant", "sibling", "unrelated"];
    const kinds = ["progress", "finding", "directive", "result", "dead_letter"] as const;
    for (let i = 0; i < 500; i++) {
      const relation = relations[Math.floor(next() * relations.length)]!;
      const kind = kinds[Math.floor(next() * kinds.length)]!;
      const key = makeMessageKey("r_ABCDEFGH", "r_12345678", (i % 4) + 1, i + 1);
      expect(parseMessageKey(key)?.key).toBe(key);
      if ((relation === "unrelated" || relation === "self") && kind !== "dead_letter") {
        expect(authorize({ kind, relation, from: "r_ABCDEFGH" })).toBe(false);
      }
    }
  });

  it("keeps router-issued sequence numbers increasing across admitted and rejected records", () => {
    for (const seed of [1, 7, 31, 101, 0xfab1c]) {
      const next = random(seed);
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
        now: () => 0,
      });
      const tree = new FabricTree();
      tree.append("root", "r_ABCDEFGH");
      tree.markRunning("r_ABCDEFGH");
      const router = new FabricRouter(
        engine,
        tree,
        new FabricThrottle({ minIntervalMs: 0, rootMinIntervalMs: 0, backoffMs: 0 }),
        {
          maxPerRun: 3,
          findingQuota: 3,
          directiveQuota: 3,
          deadLetterQuota: 3,
          maxChars: 100,
          progressTtlMs: 100,
          reconcileTtlMs: 100,
          rootInboxCap: 100,
        },
        () => 0,
      );
      let previous = 0;
      for (let i = 0; i < 20; i++) {
        const result = router.admit("r_ABCDEFGH", {
          to: "root",
          kind: "finding",
          text: String(next()),
          generation: 1,
          canMessage: ["child"],
        });
        expect(result.seq).toBe(previous + 1);
        previous = result.seq;
      }
    }
  });
});
