import { mkdtemp, readFile, readdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createJobStore, type JobStore } from "../../src/bash/job-store.js";
import { createJobRecord, transitionJob, type JobRecord } from "../../src/bash/types.js";
import { FakeClock } from "../../src/core/clock.js";

let dirs: string[] = [];
afterEach(() => {
  dirs = [];
});

interface Harness {
  dir: string;
  store: JobStore;
  clock: FakeClock;
  warnings: string[];
}

async function harness(retentionMs = 86_400_000): Promise<Harness> {
  const dir = await mkdtemp(join(tmpdir(), "pi-subagent-bash-jobs-"));
  dirs.push(dir);
  const clock = new FakeClock(1_000);
  const warnings: string[] = [];
  const store = createJobStore({
    dir: join(dir, "bash-jobs"),
    retentionMs,
    clock,
    warn: (m) => warnings.push(m),
  });
  return { dir, store, clock, warnings };
}

function record(jobId: string, store: JobStore, createdAt = 1_000): JobRecord {
  return createJobRecord({
    jobId,
    command: "npm test",
    cwd: "/repo",
    sessionId: "s1",
    hostPid: process.pid,
    logPath: store.logPath(jobId),
    createdAt,
  });
}

function terminal(base: JobRecord, endedAt: number): JobRecord {
  const running = transitionJob(base, "running", { at: base.createdAt + 1, pid: 4242, pgid: 4242 });
  if (!running.ok) throw new Error(running.reason);
  const done = transitionJob(running.record, "completed", { at: endedAt, exitCode: 0, finalText: "ok" });
  if (!done.ok) throw new Error(done.reason);
  return done.record;
}

describe("bash job store paths", () => {
  it("derives flat sibling json/log paths inside the injected dir", async () => {
    const { store } = await harness();
    expect(store.recordPath("b_3F7K2M9P")).toBe(join(store.dir, "b_3F7K2M9P.json"));
    expect(store.logPath("b_3F7K2M9P")).toBe(join(store.dir, "b_3F7K2M9P.log"));
  });
});

describe("bash job store persistence", () => {
  it("creates the dir on demand and round-trips a record", async () => {
    const { store, warnings } = await harness();
    const saved = terminal(record("b_3F7K2M9P", store), 5_000);
    await store.save(saved);
    expect(await store.load("b_3F7K2M9P")).toEqual(saved);
    expect(await store.loadAll()).toEqual([saved]);
    expect(warnings).toEqual([]);
    // Human-readable, newline-terminated JSON (matches schedule/store.ts).
    const text = await readFile(store.recordPath("b_3F7K2M9P"), "utf8");
    expect(text.endsWith("}\n")).toBe(true);
    expect(JSON.parse(text)).toEqual(saved);
  });

  it("returns undefined for a missing record without warning", async () => {
    const { store, warnings } = await harness();
    expect(await store.load("b_M5SS1NG1")).toBeUndefined();
    expect(await store.loadAll()).toEqual([]);
    expect(warnings).toEqual([]);
  });

  it("overwrites in place, leaving no tmp files and never a half-written record", async () => {
    const { store } = await harness();
    const base = record("b_3F7K2M9P", store);
    const bulky = { ...base, finalText: "y".repeat(200_000) };
    const reads: Promise<JobRecord | undefined>[] = [];
    const writes: Promise<void>[] = [];
    for (let i = 0; i < 20; i++) {
      writes.push(store.save({ ...bulky, logBytes: i }));
      reads.push(store.load("b_3F7K2M9P"));
    }
    await Promise.all(writes);
    const observed = (await Promise.all(reads)).filter((r): r is JobRecord => r !== undefined);
    // Every observation is a complete record (never a truncated tmp read).
    for (const r of observed) expect(r.finalText).toHaveLength(200_000);
    expect(await readdir(store.dir)).toEqual(["b_3F7K2M9P.json"]);
    expect((await store.load("b_3F7K2M9P"))?.logBytes).toBe(19);
  });

  it("serializes interleaved saves so the last write wins", async () => {
    const { store } = await harness();
    const base = record("b_3F7K2M9P", store);
    await Promise.all([1, 2, 3, 4, 5].map((logBytes) => store.save({ ...base, logBytes })));
    expect((await store.load("b_3F7K2M9P"))?.logBytes).toBe(5);
  });
});

describe("bash job store fault tolerance", () => {
  it("warns and skips corrupt JSON, invalid records and stray names", async () => {
    const { store, warnings } = await harness();
    const good = record("b_G00DG00D", store);
    await store.save(good);
    await writeFile(store.recordPath("b_BADJS0N1"), "{ not json", "utf8");
    await writeFile(store.recordPath("b_0DVER111"), JSON.stringify({ v: 0, jobId: "b_0DVER111" }), "utf8");
    await writeFile(store.recordPath("b_N5STAT5S"), JSON.stringify({ ...good, jobId: "b_N5STAT5S", status: "x" }));
    await writeFile(join(store.dir, "notes.json"), "{}", "utf8");
    await writeFile(join(store.dir, "b_3F7K2M9P.log"), "log body", "utf8");

    expect(await store.loadAll()).toEqual([good]);
    expect(warnings.join("\n")).toContain("corrupt bash job record b_BADJS0N1");
    expect(warnings.join("\n")).toContain("invalid bash job record b_0DVER111: unsupported schema version 0");
    expect(warnings.join("\n")).toContain("invalid bash job record b_N5STAT5S: unknown status");
    expect(warnings.join("\n")).toContain("unexpected name: notes.json");
    // A single bad file must not hide its neighbours, and .log files are not records.
    expect(warnings.filter((w) => w.includes("b_3F7K2M9P.log"))).toEqual([]);
  });

  it("rejects a record whose jobId disagrees with its file name", async () => {
    const { store, warnings } = await harness();
    const good = record("b_3F7K2M9P", store);
    await store.save(good); // also creates the dir
    await writeFile(store.recordPath("b_9Q1RN4ZC"), JSON.stringify(good), "utf8");
    expect(await store.load("b_9Q1RN4ZC")).toBeUndefined();
    expect(warnings.join("\n")).toContain("does not match jobId b_3F7K2M9P");
  });
});

describe("bash job store update / readCursor", () => {
  it("persists the read cursor monotonically", async () => {
    const { store } = await harness();
    await store.save(record("b_3F7K2M9P", store));
    expect((await store.setReadCursor("b_3F7K2M9P", 1_024))?.readCursor).toBe(1_024);
    // Explicit `offset: 0` replays must not rewind the persisted cursor.
    expect((await store.setReadCursor("b_3F7K2M9P", 0))?.readCursor).toBe(1_024);
    expect((await store.setReadCursor("b_3F7K2M9P", 512))?.readCursor).toBe(1_024);
    expect((await store.setReadCursor("b_3F7K2M9P", 4_096.7))?.readCursor).toBe(4_096);
    expect((await store.setReadCursor("b_3F7K2M9P", Number.NaN))?.readCursor).toBe(4_096);
    // Survives a fresh store over the same dir (restart / reload).
    const reopened = createJobStore({ dir: store.dir, retentionMs: 0, clock: new FakeClock() });
    expect((await reopened.load("b_3F7K2M9P"))?.readCursor).toBe(4_096);
  });

  it("read-modify-writes atomically and skips no-op mutations", async () => {
    const { store } = await harness();
    await store.save(record("b_3F7K2M9P", store));
    await Promise.all(
      Array.from({ length: 25 }, () => store.update("b_3F7K2M9P", (r) => ({ ...r, logBytes: r.logBytes + 1 }))),
    );
    expect((await store.load("b_3F7K2M9P"))?.logBytes).toBe(25);

    const before = await readFile(store.recordPath("b_3F7K2M9P"), "utf8");
    const unchanged = await store.update("b_3F7K2M9P", () => undefined);
    expect(unchanged?.logBytes).toBe(25);
    expect(await readFile(store.recordPath("b_3F7K2M9P"), "utf8")).toBe(before);
  });

  it("resolves undefined when the job is gone", async () => {
    const { store } = await harness();
    let called = false;
    expect(
      await store.update("b_M5SS1NG1", (r) => {
        called = true;
        return r;
      }),
    ).toBeUndefined();
    expect(called).toBe(false);
    expect(await store.setReadCursor("b_M5SS1NG1", 10)).toBeUndefined();
  });
});

describe("bash job store retention", () => {
  it("removes expired terminal jobs with their logs and keeps everything else", async () => {
    const { store, clock } = await harness(86_400_000);
    const expired = terminal(record("b_EXP1RED1", store), 1_000);
    const fresh = terminal(record("b_FRESH111", store), 86_000_000);
    const liveBase = record("b_R4NN1NG1", store);
    const live = transitionJob(liveBase, "running", { at: 1_001, pid: 4242 });
    if (!live.ok) throw new Error(live.reason);
    for (const r of [expired, fresh, live.record]) {
      await store.save(r);
      await writeFile(store.logPath(r.jobId), "output", "utf8");
    }

    clock.advance(86_400_000);
    expect(await store.pruneExpired()).toEqual(["b_EXP1RED1"]);
    expect((await store.loadAll()).map((r) => r.jobId)).toEqual(["b_FRESH111", "b_R4NN1NG1"]);
    expect((await readdir(store.dir)).sort()).toEqual(
      ["b_FRESH111.json", "b_FRESH111.log", "b_R4NN1NG1.json", "b_R4NN1NG1.log"].sort(),
    );
    // Idempotent: a second sweep at the same instant removes nothing new.
    expect(await store.pruneExpired()).toEqual([]);
  });

  it("falls back to createdAt for a terminal record that lost its endedAt", async () => {
    const { store, clock } = await harness(10_000);
    const orphan = { ...record("b_N0ENDED1", store, 500), status: "orphaned" as const };
    await store.save(orphan);
    clock.advance(9_000);
    expect(await store.pruneExpired()).toEqual([]);
    clock.advance(2_000);
    expect(await store.pruneExpired()).toEqual(["b_N0ENDED1"]);
  });

  it("prunes nothing when retention is disabled", async () => {
    const { store, clock } = await harness(0);
    await store.save(terminal(record("b_EXP1RED1", store), 1_000));
    clock.advance(10 * 86_400_000);
    expect(await store.pruneExpired()).toEqual([]);
    expect((await store.loadAll()).map((r) => r.jobId)).toEqual(["b_EXP1RED1"]);
  });

  it("removes records idempotently", async () => {
    const { store } = await harness();
    await store.save(record("b_3F7K2M9P", store));
    await writeFile(store.logPath("b_3F7K2M9P"), "output", "utf8");
    await store.remove("b_3F7K2M9P");
    await store.remove("b_3F7K2M9P");
    expect(await readdir(store.dir)).toEqual([]);
  });
});
