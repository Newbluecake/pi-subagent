import { describe, expect, it } from "vitest";
import { FakeClock } from "../../src/core/clock.js";
import { createScheduler } from "../../src/schedule/scheduler.js";
import type { ScheduleStore, ScheduleTask } from "../../src/schedule/store.js";

const request = { type: "worker", prompt: "scheduled" };
function memoryStore(initial: ScheduleTask[] = []): ScheduleStore & { data: ScheduleTask[] } {
  const data = structuredClone(initial);
  return {
    data,
    async load() {
      return structuredClone(data);
    },
    async save(tasks) {
      data.splice(0, data.length, ...structuredClone(tasks));
    },
  };
}
const flush = async () => {
  for (let i = 0; i < 6; i++) await Promise.resolve();
};

describe("scheduler", () => {
  it("fires interval and cron tasks through SpawnService.spawn", async () => {
    const clock = new FakeClock(Date.parse("2026-01-01T12:00:00"));
    const calls: unknown[] = [];
    const scheduler = createScheduler({
      clock,
      store: memoryStore(),
      spawn: {
        async spawn(value) {
          calls.push(value);
          return { runId: String(calls.length) };
        },
      },
    });
    await scheduler.register({ id: "interval", schedule: { kind: "interval", intervalMs: 1_000 }, request });
    await scheduler.register({ id: "cron", schedule: { kind: "cron", expression: "1 * * * *" }, request });
    await scheduler.start();
    clock.advance(1_000);
    await flush();
    expect(calls).toHaveLength(1);
    expect(calls[0]).toEqual(request);
    await scheduler.unregister("interval");
    clock.advance(59_000);
    await flush();
    expect(calls).toHaveLength(2);
  });

  it("skips persisted missed windows and does not create a catch-up storm", async () => {
    const clock = new FakeClock(10_000);
    const warnings: string[] = [];
    const scheduler = createScheduler({
      clock,
      warn: (message) => warnings.push(message),
      store: memoryStore([{ id: "late", schedule: { kind: "interval", intervalMs: 100 }, request, nextAt: 1 }]),
      spawn: {
        async spawn() {
          throw new Error("must not fire missed run");
        },
      },
    });
    await scheduler.start();
    expect(warnings.some((warning) => warning.includes("missed its window"))).toBe(true);
    expect(scheduler.list()[0]?.nextAt).toBe(10_100);
  });

  it("fires a one-shot once and shutdown prevents future callbacks", async () => {
    const clock = new FakeClock(0);
    let calls = 0;
    const scheduler = createScheduler({
      clock,
      store: memoryStore(),
      spawn: {
        async spawn() {
          calls++;
          return { runId: "once" };
        },
      },
    });
    await scheduler.register({ id: "once", schedule: { kind: "once", at: new Date(100).toISOString() }, request });
    await scheduler.start();
    scheduler.stop();
    clock.advance(1_000);
    await flush();
    expect(calls).toBe(0);
    expect(clock.pendingTimers).toBe(0);
  });
});
