import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { createScheduleStore, type ScheduleTask } from "../../src/schedule/store.js";

const task: ScheduleTask = {
  id: "persisted",
  schedule: { kind: "interval", intervalMs: 1_000 },
  request: { type: "worker", prompt: "run" },
};

describe("schedule store", () => {
  it("atomically saves and loads schedules", async () => {
    const dir = await mkdtemp(join(tmpdir(), "pi-schedule-"));
    const path = join(dir, "nested", "schedules.json");
    const store = createScheduleStore(path);
    await store.save([task]);
    expect(await store.load()).toEqual([task]);
    expect(await readFile(path, "utf8")).toContain('"persisted"');
  });

  it("warns and recovers from malformed JSON", async () => {
    const dir = await mkdtemp(join(tmpdir(), "pi-schedule-bad-"));
    const path = join(dir, "schedules.json");
    const { writeFile } = await import("node:fs/promises");
    await writeFile(path, "not-json");
    const warnings: string[] = [];
    const original = console.warn;
    console.warn = (message: string) => warnings.push(message);
    try {
      expect(await createScheduleStore(path).load()).toEqual([]);
    } finally {
      console.warn = original;
    }
    expect(warnings.some((warning) => warning.includes("failed to load schedule store"))).toBe(true);
  });
});
