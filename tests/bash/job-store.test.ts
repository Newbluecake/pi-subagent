import { mkdir, mkdtemp, readFile, readdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createJobStore, TMP_RETENTION_MS, type JobStore } from "../../src/bash/job-store.js";
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

async function harness(retentionMs = 86_400_000, startAt = 1_000): Promise<Harness> {
  const dir = await mkdtemp(join(tmpdir(), "pi-subagent-bash-jobs-"));
  dirs.push(dir);
  const clock = new FakeClock(startAt);
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
    expect(await store.pruneExpired()).toEqual({ jobs: ["b_EXP1RED1"], files: [] });
    expect((await store.loadAll()).map((r) => r.jobId)).toEqual(["b_FRESH111", "b_R4NN1NG1"]);
    expect((await readdir(store.dir)).sort()).toEqual(
      ["b_FRESH111.json", "b_FRESH111.log", "b_R4NN1NG1.json", "b_R4NN1NG1.log"].sort(),
    );
    // Idempotent: a second sweep at the same instant removes nothing new.
    expect(await store.pruneExpired()).toEqual({ jobs: [], files: [] });
  });

  it("falls back to createdAt for a terminal record that lost its endedAt", async () => {
    const { store, clock } = await harness(10_000);
    const orphan = { ...record("b_N0ENDED1", store, 500), status: "orphaned" as const };
    await store.save(orphan);
    clock.advance(9_000);
    expect(await store.pruneExpired()).toEqual({ jobs: [], files: [] });
    clock.advance(2_000);
    expect(await store.pruneExpired()).toEqual({ jobs: ["b_N0ENDED1"], files: [] });
  });

  it("prunes nothing when retention is disabled", async () => {
    const { store, clock } = await harness(0);
    await store.save(terminal(record("b_EXP1RED1", store), 1_000));
    clock.advance(10 * 86_400_000);
    expect(await store.pruneExpired()).toEqual({ jobs: [], files: [] });
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

/**
 * §15 — the sweep must also reach files that never become records. These
 * cases are judged by *file mtime*, which is real wall-clock time, so the fake
 * clock is started at `Date.now()` and moved forward from there: a clock that
 * sits behind the mtime is (by design) an "incomparable" state where nothing
 * is deleted, and that case gets its own test below.
 */
describe("bash job store directory sweep", () => {
  async function sweepHarness(retentionMs = 10_000): Promise<Harness> {
    const h = await harness(retentionMs, Date.now());
    await mkdir(h.store.dir, { recursive: true });
    return h;
  }

  it("drops unreadable .json files (bad name, bad JSON, bad schema) with their logs once aged", async () => {
    const { store, clock, warnings } = await sweepHarness();
    await writeFile(join(store.dir, "b_BADJS0N1.json"), "{ not json", "utf8");
    await writeFile(join(store.dir, "b_BADJS0N1.log"), "body", "utf8");
    await writeFile(join(store.dir, "b_0DVER111.json"), JSON.stringify({ v: 0, jobId: "b_0DVER111" }), "utf8");
    // Illegal id (Crockford base32 excludes I/L/O/U) — `isJobId` rejects it.
    await writeFile(join(store.dir, "b_ILLOU111.json"), "{}", "utf8");

    // Not yet old enough: mtime is "now", so nothing goes.
    expect(await store.pruneExpired()).toEqual({ jobs: [], files: [] });
    expect((await readdir(store.dir)).length).toBe(4);

    clock.advance(60_000);
    const result = await store.pruneExpired();
    expect(result.jobs).toEqual([]);
    expect(result.files.sort()).toEqual(["b_0DVER111.json", "b_BADJS0N1.json", "b_BADJS0N1.log", "b_ILLOU111.json"]);
    expect(await readdir(store.dir)).toEqual([]);
    // Every non-record deletion is announced.
    expect(warnings.filter((w) => w.startsWith("removed stale bash job file"))).toHaveLength(4);
  });

  it("never touches a non-terminal record however old the file is", async () => {
    const { store, clock } = await sweepHarness();
    const live = transitionJob(record("b_R4NN1NG1", store, 0), "running", { at: 1, pid: 4242, pgid: 4242 });
    if (!live.ok) throw new Error(live.reason);
    await store.save(live.record);
    await writeFile(store.logPath("b_R4NN1NG1"), "output", "utf8");
    clock.advance(10 * 86_400_000);
    expect(await store.pruneExpired()).toEqual({ jobs: [], files: [] });
    expect((await readdir(store.dir)).sort()).toEqual(["b_R4NN1NG1.json", "b_R4NN1NG1.log"]);
  });

  it("leaves every other file name alone (safety boundary: .json/.log/.tmp only)", async () => {
    const { store, clock } = await sweepHarness();
    const strays = ["notes.txt", "README", "b_3F7K2M9P.jsonl", "archive.tar.gz", ".gitkeep"];
    for (const name of strays) await writeFile(join(store.dir, name), "x", "utf8");
    clock.advance(365 * 86_400_000);
    expect(await store.pruneExpired()).toEqual({ jobs: [], files: [] });
    expect((await readdir(store.dir)).sort()).toEqual([...strays].sort());
  });

  it("keeps a .log whose stem is not a job id (we only ever write <jobId>.log)", async () => {
    const { store, clock } = await sweepHarness();
    // A user's own file that happens to share our suffix, and a name that
    // looks like an id but uses letters Crockford base32 excludes (I/L/O/U).
    const mine = ["mynotes.log", "b_ILLOU111.log"];
    for (const name of mine) await writeFile(join(store.dir, name), "not ours", "utf8");
    clock.advance(365 * 86_400_000);

    expect(await store.pruneExpired()).toEqual({ jobs: [], files: [] });
    expect((await readdir(store.dir)).sort()).toEqual([...mine].sort());
  });

  it("drops an aged orphan log but keeps one whose job is tracked in memory", async () => {
    const { store, clock } = await sweepHarness();
    await writeFile(join(store.dir, "b_0RPHAN11.log"), "left behind", "utf8");
    await writeFile(join(store.dir, "b_TR4CKED1.log"), "live output", "utf8");
    clock.advance(60_000);

    const result = await store.pruneExpired({ isTracked: (id) => id === "b_TR4CKED1" });
    expect(result.files).toEqual(["b_0RPHAN11.log"]);
    expect(await readdir(store.dir)).toEqual(["b_TR4CKED1.log"]);
  });

  it("keeps a log that still has a record beside it", async () => {
    const { store, clock } = await sweepHarness(86_400_000);
    const live = transitionJob(record("b_R4NN1NG1", store, 0), "running", { at: 1, pid: 4242, pgid: 4242 });
    if (!live.ok) throw new Error(live.reason);
    await store.save(live.record);
    await writeFile(store.logPath("b_R4NN1NG1"), "output", "utf8");
    clock.advance(10 * 86_400_000);
    expect((await store.pruneExpired()).files).toEqual([]);
    expect((await readdir(store.dir)).sort()).toEqual(["b_R4NN1NG1.json", "b_R4NN1NG1.log"]);
  });

  it("sweeps stale .tmp debris on a fixed 1h TTL, even with retention disabled", async () => {
    const { store, clock } = await sweepHarness(0);
    const tmp = "b_3F7K2M9P.json.1234.5678.0.tmp";
    await writeFile(join(store.dir, tmp), "half written", "utf8");
    clock.advance(TMP_RETENTION_MS / 2);
    expect((await store.pruneExpired()).files).toEqual([]);
    // Generous margin: mtime is real wall-clock time and only *approximately*
    // the clock's start, so the boundary itself is not assertable.
    clock.advance(TMP_RETENTION_MS);
    expect((await store.pruneExpired()).files).toEqual([tmp]);
    expect(await readdir(store.dir)).toEqual([]);
  });

  it("deletes nothing when the clock sits behind the files' mtime", async () => {
    // Default harness clock = 1_000ms since the epoch; every real mtime is in
    // its future, so no age is computable and the sweep must be a no-op.
    const { store, clock } = await harness(1);
    await store.save(record("b_ANCH0R11", store));
    await writeFile(join(store.dir, "b_BADJS0N1.json"), "{ not json", "utf8");
    await writeFile(join(store.dir, "b_0RPHAN11.log"), "left behind", "utf8");
    await writeFile(join(store.dir, "b_3F7K2M9P.json.1.2.0.tmp"), "half", "utf8");
    clock.advance(10 * 86_400_000);
    expect((await store.pruneExpired()).files).toEqual([]);
    expect((await readdir(store.dir)).sort()).toEqual(
      ["b_0RPHAN11.log", "b_3F7K2M9P.json.1.2.0.tmp", "b_ANCH0R11.json", "b_BADJS0N1.json"].sort(),
    );
  });

  it("is a no-op on a directory that does not exist", async () => {
    const { store } = await harness();
    expect(await store.pruneExpired()).toEqual({ jobs: [], files: [] });
  });
});
