import { describe, expect, it } from "vitest";
import { canonicalizeDeliveryKey, deliveryKey, parseDeliveryKey } from "../../src/core/delivery-key.js";

describe("delivery keys", () => {
  it("uses the stable runId:generation form", () => {
    expect(deliveryKey("r_ABCDEFGH", 12)).toBe("r_ABCDEFGH:12");
  });

  it("canonicalizes only the four terminal legacy statuses", () => {
    for (const status of ["completed", "failed", "timed_out", "aborted"]) {
      expect(canonicalizeDeliveryKey(`r_ABCDEFGH:1:${status}`)).toBe("r_ABCDEFGH:1");
    }
    for (const status of ["queued", "running", "stopping", "starting", "other"]) {
      expect(canonicalizeDeliveryKey(`r_ABCDEFGH:1:${status}`)).toBe(`r_ABCDEFGH:1:${status}`);
    }
  });

  it("parses only valid stable keys", () => {
    expect(parseDeliveryKey("r_ABCDEFGH:1")).toEqual({ runId: "r_ABCDEFGH", generation: 1 });
    expect(parseDeliveryKey("r_ABCDEFGH:12:completed")).toEqual({ runId: "r_ABCDEFGH", generation: 12 });
    for (const key of ["r:1", "r_ABCDEFGH:0", "r_ABCDEFGH:abc", "a:1:extra:2", "", "r_ABCDEFGH:1:running"]) {
      expect(parseDeliveryKey(key)).toBeUndefined();
    }
  });
});
