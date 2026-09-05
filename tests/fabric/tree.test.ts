import { describe, expect, it } from "vitest";
import { FabricTree } from "../../src/fabric/tree.js";

describe("fabric tree", () => {
  it("computes relations, LCA, and route hops", () => {
    const tree = new FabricTree();
    tree.append("root", "r_ABCDEFGH");
    tree.append("r_ABCDEFGH", "r_12345678");
    tree.append("r_ABCDEFGH", "r_87654321");
    expect(tree.relation("r_ABCDEFGH", "r_12345678")).toBe("parent");
    expect(tree.relation("r_12345678", "r_ABCDEFGH")).toBe("child");
    expect(tree.relation("r_12345678", "r_87654321")).toBe("sibling");
    expect(tree.relation("root", "r_12345678")).toBe("ancestor");
    expect(tree.lca("r_12345678", "r_87654321")).toBe("r_ABCDEFGH");
    expect(tree.hops("r_12345678", "r_87654321")).toEqual(["r_12345678", "r_ABCDEFGH", "r_87654321"]);
  });

  it("keeps sibling authorization after one node is tombstoned", () => {
    const tree = new FabricTree();
    tree.append("root", "r_ABCDEFGH");
    tree.append("r_ABCDEFGH", "r_12345678");
    tree.append("r_ABCDEFGH", "r_87654321");
    tree.tombstone("r_12345678", 10, 100);
    expect(tree.targetState("r_12345678", 20)).toBe("gone");
    expect(tree.relation("r_12345678", "r_87654321", 20)).toBe("sibling");
    expect(tree.lca("r_12345678", "r_87654321")).toBe("r_ABCDEFGH");
  });
});
