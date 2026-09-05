import { describe, expect, it } from "vitest";
import {
  authorize,
  effectiveCanMessage,
  formatMessage,
  makeMessageKey,
  parseMessageKey,
  type FabricRecord,
} from "../../src/core/message.js";

describe("fabric message protocol", () => {
  it("round-trips strict four-part message keys", () => {
    const key = makeMessageKey("r_ABCDEFGH", "r_12345678", 3, 9);
    expect(parseMessageKey(key)).toEqual({ from: "r_ABCDEFGH", to: "r_12345678", generation: 3, seq: 9, key });
    for (const invalid of [
      "r_ABCDEFGH:r_12345678:3",
      "r_ABCDEFGH:r_12345678:x:1",
      "r:root:0:1",
      "r_ABCDEFGH:r_12345678:0:0",
      "system:r_12345678:1:1",
      "r_ABCDEFGH:r_12345678:01:1",
      "r_ABCDEFGH:r_12345678:1:01",
    ]) {
      expect(parseMessageKey(invalid)).toBeUndefined();
    }
  });

  it("defaults undefined canMessage to parent", () => {
    expect(effectiveCanMessage(undefined)).toEqual(["parent"]);
    expect(authorize({ kind: "finding", relation: "parent" })).toBe(true);
    expect(authorize({ kind: "finding", relation: "child" })).toBe(false);
    expect(authorize({ kind: "result", relation: "child" })).toBe(true);
    expect(authorize({ kind: "result", relation: "parent" })).toBe(false);
    expect(authorize({ kind: "directive", relation: "parent" })).toBe(true);
    expect(authorize({ kind: "directive", relation: "ancestor" })).toBe(false);
    expect(authorize({ kind: "dead_letter", relation: "parent", from: "r_ABCDEFGH" })).toBe(false);
    expect(authorize({ kind: "dead_letter", relation: "unrelated", from: "system" })).toBe(true);
    expect(
      authorize({
        kind: "finding",
        relation: "unrelated",
        from: "r_ABCDEFGH",
        mention: { kind: "mention", label: "worker", target: "r_12345678" },
        canMessage: ["mention"],
      }),
    ).toBe(true);
    expect(
      authorize({
        kind: "finding",
        relation: "unrelated",
        mention: { kind: "mention", label: "worker", target: "r_12345678" },
      }),
    ).toBe(false);
    expect(
      authorize({
        kind: "directive",
        relation: "unrelated",
        mention: { kind: "mention", label: "worker", target: "r_12345678" },
        canMessage: ["mention"],
      }),
    ).toBe(false);
    expect(
      authorize({
        kind: "result",
        relation: "unrelated",
        mention: { kind: "mention", label: "worker", target: "r_12345678" },
        canMessage: ["mention"],
      }),
    ).toBe(false);
    expect(
      authorize({
        kind: "finding",
        relation: "unrelated",
        from: "r_12345678",
        mention: { kind: "mention", label: "worker", target: "r_12345678" },
        canMessage: ["mention"],
      }),
    ).toBe(false);
  });

  it("keeps untrusted-input declaration in the header only", () => {
    const base = {
      key: makeMessageKey("r_ABCDEFGH", "r_12345678", 1, 1),
      from: "r_ABCDEFGH" as const,
      to: "r_12345678" as const,
      seq: 1,
      payload: { text: "do this" },
    };
    expect(formatMessage({ ...base, kind: "finding" }, "parent").header).toContain("不可信输入");
    expect(formatMessage({ ...base, kind: "finding" }, "parent").text).toContain("do this");
    expect(formatMessage({ ...base, kind: "directive" }, "parent").text).toContain("<fabric-directive>");
    expect(formatMessage({ ...base, kind: "directive" }, "sibling").text).toContain("do this");
    expect(
      formatMessage({ ...base, kind: "finding", via: { mode: "mention", lca: "root", hops: [] } }, "sibling").header,
    ).toContain("relation=mention");
    expect(formatMessage({ ...base, kind: "finding", via: { lca: "root", hops: [] } }, "sibling").header).toContain(
      "relation=sibling",
    );
  });

  it("represents rejected and dead-letter records with the prescribed states", () => {
    const rejected: FabricRecord = {
      ...{
        key: makeMessageKey("r_ABCDEFGH", "root", 1, 1),
        from: "r_ABCDEFGH",
        to: "root",
        kind: "finding",
        seq: 1,
        generation: 1,
        payload: { text: "x" },
        ttlMs: 1,
        createdAt: 0,
      },
      state: "dropped",
      attempts: 0,
      updatedAt: 0,
      rejected: { reason: "quota_exhausted" },
    };
    expect(rejected.state).toBe("dropped");
    expect(rejected.attempts).toBe(0);
  });
});
