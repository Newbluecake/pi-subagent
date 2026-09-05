import { describe, expect, it } from "vitest";
import { FakeClock } from "../../src/core/clock.js";
import { MemoryOutboxStore } from "../../src/core/store.js";
import type { FabricRecord } from "../../src/core/message.js";
import { createDeliveryEngine } from "../../src/delivery/engine.js";
import { FabricTree } from "../../src/fabric/tree.js";
import { FabricThrottle } from "../../src/fabric/throttle.js";
import { FabricRouter } from "../../src/fabric/router.js";
import { FabricMailbox, type Verdict } from "../../src/fabric/mailbox.js";

const rec = (kind: FabricRecord["kind"] = "finding"): FabricRecord => ({
  key: "r_ABCDEFGH:root:1:1" as FabricRecord["key"],
  from: "r_ABCDEFGH",
  to: "root",
  kind,
  seq: 1,
  generation: 1,
  payload: { text: "x" },
  ttlMs: 1000,
  createdAt: 0,
  state: "pending",
  attempts: 0,
  updatedAt: 0,
});
function setup(inject: (r: FabricRecord) => Promise<Verdict>) {
  const clock = new FakeClock();
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
    now: () => clock.now(),
  });
  engine.put(rec());
  const tree = new FabricTree();
  tree.append("root", "r_ABCDEFGH");
  const throttle = new FabricThrottle({ minIntervalMs: 0, rootMinIntervalMs: 0, backoffMs: 20 });
  const router = new FabricRouter(
    engine,
    tree,
    throttle,
    {
      maxPerRun: 5,
      findingQuota: 5,
      directiveQuota: 5,
      deadLetterQuota: 5,
      maxChars: 100,
      progressTtlMs: 1000,
      reconcileTtlMs: 1000,
      rootInboxCap: 5,
    },
    clock.now.bind(clock),
  );
  const mailbox = new FabricMailbox({
    engine,
    router,
    throttle,
    clock,
    ports: { inject, sendRootContext: inject, sendRootDisplay: inject },
    fabricSteerTimeoutMs: 10,
    maxAttempts: 3,
  });
  return { clock, store, engine, mailbox };
}

describe("fabric mailbox", () => {
  it("claims once when pump is called twice in one tick", () => {
    let sends = 0;
    const { mailbox, engine } = setup(() => {
      sends++;
      return new Promise(() => undefined);
    });
    mailbox.pump();
    mailbox.pump();
    expect(sends).toBe(1);
    expect(engine.get(rec().key)?.state).toBe("claimed");
  });
  it("turns a hung send into one retryable attempt and clears its timer", async () => {
    let sends = 0;
    const { mailbox, engine, clock } = setup(() => {
      sends++;
      return new Promise(() => undefined);
    });
    mailbox.pump();
    clock.advance(10);
    await Promise.resolve();
    expect(sends).toBe(1);
    expect(engine.get(rec().key)).toMatchObject({ state: "pending", attempts: 1 });
    expect(mailbox.pendingRaceTimers).toBe(0);
  });
  it("settles claimed progress as consumed on a retryable verdict", async () => {
    let resolve!: (v: Verdict) => void;
    const { mailbox, engine } = setup(
      () =>
        new Promise<Verdict>((r) => {
          resolve = r;
        }),
    );
    const progress = { ...rec("progress"), key: "r_ABCDEFGH:root:1:2" as FabricRecord["key"] };
    engine.put(progress);
    mailbox.pump();
    mailbox.onRunSettled("r_ABCDEFGH");
    resolve({ ok: false, retryable: true, reason: "temporary" });
    await Promise.resolve();
    expect(engine.get(progress.key)?.state).toBe("consumed");
  });
  it("drops late verdicts after dispose", async () => {
    let resolve!: (v: Verdict) => void;
    const { mailbox, engine } = setup(
      () =>
        new Promise<Verdict>((r) => {
          resolve = r;
        }),
    );
    mailbox.pump();
    mailbox.dispose();
    resolve({ ok: true });
    await Promise.resolve();
    expect(engine.get(rec().key)?.state).toBe("claimed");
  });
});
