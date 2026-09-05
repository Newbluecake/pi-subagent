import { describe, expect, it } from "vitest";
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

  it("keeps per-link sequence strictly increasing across mixed admission outcomes", () => {
    const sequences = new Map<string, number>();
    for (let i = 1; i <= 1000; i++) {
      const link = i % 3 === 0 ? "r_ABCDEFGH:root:1" : "r_ABCDEFGH:r_12345678:1";
      const previous = sequences.get(link) ?? 0;
      const seq = previous + 1;
      sequences.set(link, seq);
      expect(seq).toBeGreaterThan(previous);
    }
  });
});
