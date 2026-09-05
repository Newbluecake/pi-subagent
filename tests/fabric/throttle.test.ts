import { describe, expect, it } from "vitest";
import type { FabricRecord } from "../../src/core/message.js";
import { FabricThrottle } from "../../src/fabric/throttle.js";

const record = (patch: Partial<FabricRecord>): FabricRecord => ({
  key: "r_ABCDEFGH:root:1:1" as FabricRecord["key"],
  from: "r_ABCDEFGH",
  to: "root",
  kind: "finding",
  seq: 1,
  generation: 1,
  payload: { text: "x" },
  ttlMs: 100,
  createdAt: 0,
  state: "pending",
  attempts: 0,
  updatedAt: 0,
  ...patch,
});

describe("fabric throttle", () => {
  it("rebuilds link, root, and exponential backoff", () => {
    const t = new FabricThrottle({
      minIntervalMs: 10,
      rootMinIntervalMs: 50,
      backoffMs: 20,
      records: [
        record({ state: "delivered", deliveredAt: 100 }),
        record({
          key: "r_ABCDEFGH:r_12345678:1:2" as FabricRecord["key"],
          to: "r_12345678",
          state: "delivered",
          deliveredAt: 200,
        }),
      ],
    });
    expect(t.notBefore("r_ABCDEFGH", "root")).toBe(110);
    expect(t.rootNotBefore(record({ to: "root" }))).toBe(150);
    expect(t.backoffUntil(record({ attempts: 3, updatedAt: 10 }))).toBe(90);
    expect(t.eligibleAt(record({ to: "root", attempts: 3, updatedAt: 10 }))).toBe(150);
  });
  it("relaxes the rebuilt root deadline by one when display capability flips", () => {
    const delivered = record({ state: "delivered", deliveredAt: 100 });
    const before = new FabricThrottle({
      minIntervalMs: 10,
      rootMinIntervalMs: 50,
      backoffMs: 0,
      canRenderEntries: false,
      records: [delivered],
    });
    const after = new FabricThrottle({
      minIntervalMs: 10,
      rootMinIntervalMs: 50,
      backoffMs: 0,
      canRenderEntries: true,
      records: [delivered],
    });
    expect(before.rootNotBefore(record({ to: "root", kind: "progress" }))).toBe(150);
    expect(after.rootNotBefore(record({ to: "root", kind: "progress" }))).toBe(0);
    expect(after.eligibleAt(record({ to: "root", kind: "progress" }))).toBe(110);
  });

  it("rebuilds to the same root deadline when caps are unchanged and f=0", () => {
    const records = [record({ state: "delivered", deliveredAt: 100, kind: "finding" })];
    const throttle = new FabricThrottle({ minIntervalMs: 10, rootMinIntervalMs: 50, backoffMs: 0, records });
    const original = throttle.rootNotBefore(record({ to: "root", kind: "finding" }));
    throttle.rebuild(records);
    expect(throttle.rootNotBefore(record({ to: "root", kind: "finding" }))).toBe(original);
  });

  it("turns off the root interval at zero", () => {
    const t = new FabricThrottle({ minIntervalMs: 0, rootMinIntervalMs: 0, backoffMs: 0 });
    expect(t.rootNotBefore(record({ to: "root" }))).toBe(0);
    expect(t.eligibleAt(record({ to: "root" }))).toBe(0);
  });
});
