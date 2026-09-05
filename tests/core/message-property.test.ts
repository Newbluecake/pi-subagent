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
  it("preserves fabric invariants across seeded admit, claim, settle, and freeze sequences", () => {
    for (const seed of [3, 19, 77, 4096, 0xc0ffee]) {
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
      const sender = "r_ABCDEFGH" as const;
      tree.append("root", sender);
      tree.markRunning(sender);
      const router = new FabricRouter(
        engine,
        tree,
        new FabricThrottle({ minIntervalMs: 0, rootMinIntervalMs: 0, backoffMs: 0 }),
        {
          maxPerRun: 100,
          findingQuota: 100,
          directiveQuota: 100,
          deadLetterQuota: 100,
          maxChars: 100,
          progressTtlMs: 100,
          reconcileTtlMs: 100,
          rootInboxCap: 3,
          progressChannel: "context",
        },
        () => 0,
      );
      for (let i = 0; i < 30; i++) {
        try {
          const result = router.admit(sender, {
            to: "root",
            kind: next() < 0.25 ? "progress" : "finding",
            text: `seed-${seed}-${i}`,
            generation: 1,
            canMessage: ["child"],
          });
          if (result.ok && next() < 0.35) engine.claim(result.key, `${seed}:${i}`);
        } catch (error) {
          expect(String(error)).toMatch(/sender is not running|shutting down/);
        }
        if (next() < 0.2) router.onRunSettled(sender);
        if (next() < 0.1) router.freeze();
      }
      const rootInbox = router.rootInbox();
      expect(rootInbox).toBeLessThanOrEqual(3);
      const claimed = engine.select((record) => record.state === "claimed");
      expect(new Set(claimed.map((record) => record.key)).size).toBe(claimed.length);
      const deadRefs = engine
        .select((record) => record.kind === "dead_letter")
        .flatMap((record) => record.ref?.keys ?? []);
      expect(new Set(deadRefs).size).toBe(deadRefs.length);
      for (const record of engine.select(
        (r) => (r.kind === "finding" || r.kind === "directive") && ["dropped", "abandoned"].includes(r.state),
      )) {
        if (record.rejected === undefined && record.terminalReason !== "policy")
          expect(record.deadLetter).toBeDefined();
      }
    }
  });
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
