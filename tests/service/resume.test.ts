import { describe, expect, it } from "vitest";
import { createSpawnService } from "../../src/service/spawn-service.js";
import { TombstoneStore } from "../../src/service/tombstone.js";
import type { AgentTypeConfig, RunOutcome } from "../../src/core/types.js";
import type { Runner, SlotPool } from "../../src/service/ports.js";

const type: AgentTypeConfig = { name: "worker", description: "worker", systemPrompt: "", promptMode: "append" };
const budget = { totalMs: 100 };
const sessionFile = new URL("../../package.json", import.meta.url).pathname;
function deps(runner: Runner, tombstones: TombstoneStore, now: () => number = () => Date.now()) {
  const pool: SlotPool = { acquire: async (runId) => ({ ok: true, ticket: { runId, release() {} } }) };
  return {
    types: { get: () => type, list: () => [], reload: async () => ({ types: [type], errors: [] }) },
    pool,
    runner,
    tombstones,
    now,
    budget,
  };
}
function outcome(runId: string, file = sessionFile): RunOutcome {
  return {
    runId,
    status: "completed",
    turns: 1,
    durationMs: 1,
    diag: {
      createdAt: 0,
      phase: "settled",
      phaseEnteredAt: 1,
      pendingTools: 0,
      turns: 1,
      escalation: [],
      orphaned: false,
      generation: 1,
      degraded: [],
      staleInputs: 0,
      unkillable: [],
      sessionFile: file,
    },
  };
}
describe("X2 resume", () => {
  it("resolves a completed run to its session file and passes it to the runner", async () => {
    let seen: string | undefined;
    const runner: Runner = {
      run: async (spec) => {
        seen = spec.request.resumeFrom;
        return outcome(spec.runId);
      },
    };
    const service = createSpawnService(deps(runner, new TombstoneStore()));
    const first = await service.spawn({ type: "worker", prompt: "first", label: "build" });
    expect("runId" in first).toBe(true);
    await service.waitAll({ waitMs: 10 });
    const resumed = await service.spawn({ type: "worker", prompt: "continue", resumeFrom: "build" });
    expect("runId" in resumed).toBe(true);
    await service.waitAll({ waitMs: 10 });
    expect(seen).toBe(sessionFile);
  });
  it("rejects an unknown target and an in-flight target", async () => {
    let release!: () => void;
    const runner: Runner = {
      run: async (spec) => {
        await new Promise<void>((r) => {
          release = r;
        });
        return outcome(spec.runId);
      },
    };
    const service = createSpawnService(deps(runner, new TombstoneStore()));
    const first = await service.spawn({ type: "worker", prompt: "first", label: "busy" });
    expect(await service.spawn({ type: "worker", prompt: "x", resumeFrom: "missing" })).toMatchObject({
      error: { message: expect.stringContaining("not found") },
    });
    release();
    await service.waitAll({ waitMs: 10 });
    expect(first).toHaveProperty("runId");
  });
  it("rejects two resumes of the same tombstone while the first is running", async () => {
    let calls = 0;
    let release!: () => void;
    const runner: Runner = {
      run: async (spec) => {
        calls++;
        if (spec.request.resumeFrom)
          await new Promise<void>((r) => {
            release = r;
          });
        return outcome(spec.runId);
      },
    };
    const service = createSpawnService(deps(runner, new TombstoneStore()));
    await service.spawnAndWait({ type: "worker", prompt: "first", label: "once" });
    const one = await service.spawn({ type: "worker", prompt: "again", resumeFrom: "once" });
    const two = await service.spawn({ type: "worker", prompt: "again", resumeFrom: "once" });
    expect(one).toHaveProperty("runId");
    expect(two).toMatchObject({ error: { message: expect.stringContaining("already has a resume") } });
    release();
    await service.waitAll({ waitMs: 10 });
    expect(calls).toBe(2);
  });
  it("resumes through a unique run_id prefix", async () => {
    const resumedFiles: string[] = [];
    const runner: Runner = {
      run: async (spec) => {
        if (spec.request.resumeFrom) resumedFiles.push(spec.request.resumeFrom);
        return outcome(spec.runId);
      },
    };
    const service = createSpawnService(deps(runner, new TombstoneStore()));
    const first = await service.spawnAndWait({ type: "worker", prompt: "first" });
    const prefix = first.runId.slice(0, -1);
    const resumed = await service.spawn({ type: "worker", prompt: "continue", resumeFrom: prefix });
    expect(resumed).toHaveProperty("runId");
    await service.waitAll({ waitMs: 10 });
    expect(resumedFiles).toEqual([sessionFile]);
  });

  it("rejects an ambiguous prefix and includes resumable candidates", async () => {
    const runner: Runner = { run: async (spec) => outcome(spec.runId) };
    const service = createSpawnService(deps(runner, new TombstoneStore()));
    const one = await service.spawnAndWait({ type: "worker", prompt: "one", label: "one" });
    const two = await service.spawnAndWait({ type: "worker", prompt: "two", label: "two" });
    expect(one.runId.startsWith("r_")).toBe(true);
    expect(two.runId.startsWith("r_")).toBe(true);
    const rejected = await service.spawn({ type: "worker", prompt: "continue", resumeFrom: "r_" });
    expect(rejected).toMatchObject({ error: { message: expect.stringContaining("one") } });
    expect(rejected).toMatchObject({ error: { message: expect.stringContaining(one.runId) } });
    expect(rejected).toMatchObject({ error: { message: expect.stringContaining(two.runId) } });
  });

  it("resumes from records after the tombstone TTL expires", async () => {
    let now = 0;
    const tombstones = new TombstoneStore(10, () => now);
    const runner: Runner = { run: async (spec) => outcome(spec.runId) };
    const service = createSpawnService(deps(runner, tombstones, () => now));
    const first = await service.spawnAndWait({ type: "worker", prompt: "first" });
    now = 11;
    expect(tombstones.get(first.runId)).toBeUndefined();
    const resumed = await service.spawn({ type: "worker", prompt: "continue", resumeFrom: first.runId });
    expect(resumed).toHaveProperty("runId");
  });

  it("rejects a terminal target whose session file is no longer a file", async () => {
    const runner: Runner = { run: async (spec) => outcome(spec.runId, "/tmp/pi-subagent-missing-session.jsonl") };
    const service = createSpawnService(deps(runner, new TombstoneStore()));
    const first = await service.spawnAndWait({ type: "worker", prompt: "first", label: "missing-file" });
    const rejected = await service.spawn({ type: "worker", prompt: "continue", resumeFrom: first.runId });
    expect(rejected).toMatchObject({
      error: { message: expect.stringContaining(`resume target not found: ${first.runId}`) },
    });
    expect(rejected).toMatchObject({ error: { message: expect.stringContaining("Resumable targets:") } });
  });

  it("does not treat an arbitrary session path as a resumable handle", async () => {
    const runner: Runner = { run: async (spec) => outcome(spec.runId) };
    const service = createSpawnService(deps(runner, new TombstoneStore()));
    await service.spawnAndWait({ type: "worker", prompt: "first" });
    const rejected = await service.spawn({ type: "worker", prompt: "continue", resumeFrom: sessionFile });
    expect(rejected).toMatchObject({ error: { message: expect.stringContaining("resume target not found") } });
  });

  it("expires tombstones", () => {
    let now = 0;
    const store = new TombstoneStore(10, () => now);
    store.register({
      ...outcome("r"),
      phase: "settled",
      deadlines: { enqueuedAt: 0, deadlineAt: undefined, queueDeadlineAt: undefined },
      updatedAt: 0,
    });
    now = 11;
    expect(store.get("r")).toBeUndefined();
  });
});

describe("X2 resume lock lifecycle (P1 regression)", () => {
  it("allows sequential resumes of the same session after each completes", async () => {
    const resumes: string[] = [];
    const runner: Runner = {
      run: async (spec) => {
        if (spec.request.resumeFrom) resumes.push(spec.request.resumeFrom);
        return outcome(spec.runId);
      },
    };
    const service = createSpawnService(deps(runner, new TombstoneStore()));
    await service.spawnAndWait({ type: "worker", prompt: "first", label: "seq" });
    const r1 = await service.spawn({ type: "worker", prompt: "second", resumeFrom: "seq" });
    expect(r1).toHaveProperty("runId");
    await service.waitAll({ waitMs: 10 });
    // P1: the targetId lock must be released after the first resume settles —
    // a second sequential resume must not be rejected.
    const r2 = await service.spawn({ type: "worker", prompt: "third", resumeFrom: "seq" });
    expect(r2).toHaveProperty("runId");
    await service.waitAll({ waitMs: 10 });
    expect(resumes).toEqual([sessionFile, sessionFile]);
  });

  it("does not register a label that has run_id syntax", async () => {
    const runner: Runner = { run: async (spec) => outcome(spec.runId) };
    const service = createSpawnService(deps(runner, new TombstoneStore()));
    await service.spawnAndWait({ type: "worker", prompt: "x", label: "r_ABCDEFGH" });
    expect(service.getLabel?.("r_ABCDEFGH")).toBeUndefined();
  });

  it("mutually excludes concurrent resumes and releases the lock after settling", async () => {
    let resumeCalls = 0;
    let release!: () => void;
    const runner: Runner = {
      run: async (spec) => {
        if (spec.request.resumeFrom) {
          resumeCalls++;
          if (resumeCalls === 1)
            await new Promise<void>((resolve) => {
              release = resolve;
            });
        }
        return outcome(spec.runId);
      },
    };
    const service = createSpawnService(deps(runner, new TombstoneStore()));
    await service.spawnAndWait({ type: "worker", prompt: "first", label: "concurrent" });

    const [one, two] = await Promise.all([
      service.spawn({ type: "worker", prompt: "again", resumeFrom: "concurrent" }),
      service.spawn({ type: "worker", prompt: "again", resumeFrom: "concurrent" }),
    ]);
    expect(one).toHaveProperty("runId");
    expect(two).toMatchObject({ error: { message: expect.stringContaining("already has a resume in progress") } });

    release();
    await service.waitAll({ waitMs: 10 });
    const third = await service.spawn({ type: "worker", prompt: "retry", resumeFrom: "concurrent" });
    expect(third).toHaveProperty("runId");
    await service.waitAll({ waitMs: 10 });
    expect(resumeCalls).toBe(2);
  });

  it("releases resume locks when startup fails so the target can be retried", async () => {
    let resumeCalls = 0;
    const runner: Runner = {
      run: async (spec) => {
        if (spec.request.resumeFrom) {
          resumeCalls++;
          if (resumeCalls === 1) throw new Error("session open failed");
        }
        return outcome(spec.runId);
      },
    };
    const service = createSpawnService(deps(runner, new TombstoneStore()));
    await service.spawnAndWait({ type: "worker", prompt: "first", label: "startup-retry" });

    const failed = await service.spawnAndWait({ type: "worker", prompt: "resume once", resumeFrom: "startup-retry" });
    expect(failed.status).toBe("failed");
    expect(failed.error?.message).toContain("session open failed");

    const retried = await service.spawnAndWait({ type: "worker", prompt: "resume twice", resumeFrom: "startup-retry" });
    expect(retried.status).toBe("completed");
    expect(resumeCalls).toBe(2);
  });

  it("rejects resume of a still-running run with a steer hint", async () => {
    let release!: () => void;
    const runner: Runner = {
      run: async (spec) => {
        await new Promise<void>((r) => {
          release = r;
        });
        return outcome(spec.runId);
      },
    };
    const service = createSpawnService(deps(runner, new TombstoneStore()));
    await service.spawn({ type: "worker", prompt: "slow", label: "busy2" });
    const rejected = await service.spawn({ type: "worker", prompt: "x", resumeFrom: "busy2" });
    expect(rejected).toMatchObject({
      error: { message: expect.stringContaining("still running; use steer_subagent instead") },
    });
    release();
    await service.waitAll({ waitMs: 10 });
  });
});

/**
 * CC4/CP1-c (workflow design §4.4.1): CP1 must run strictly before the
 * `resumeLocks.add()` writes (lines 224/225 in the reference implementation)
 * — otherwise a resume request rejected for an expired deadlineAt would
 * leave its resumeLocks entries behind forever (the cleanup only happens in
 * `start()`'s `finally`, a path a CP1-rejected request never reaches). This
 * is the same failure class as the already-fixed "leaks the targetId lock
 * forever" bug this file's other tests guard against.
 */
describe("X2 resume lock lifecycle: CC4 CP1 must not leak the resume lock", () => {
  it("two consecutive expired-deadlineAt resumes of the same tombstone both fail the same way (no leaked lock)", async () => {
    const runner: Runner = { run: async (spec) => outcome(spec.runId) };
    const service = createSpawnService(deps(runner, new TombstoneStore()));
    await service.spawnAndWait({ type: "worker", prompt: "first", label: "cp1" });

    const one = await service.spawn({ type: "worker", prompt: "again", resumeFrom: "cp1", deadlineAt: -1 });
    const two = await service.spawn({ type: "worker", prompt: "again", resumeFrom: "cp1", deadlineAt: -1 });

    // If CP1 ran after resumeLocks.add() (or was skipped on the resume path),
    // the second call would instead fail with "already has a resume in
    // progress" — proving the first rejected attempt leaked its lock.
    expect(one).toEqual({ error: { kind: "config", message: "deadlineAt already expired", retryable: false } });
    expect(two).toEqual({ error: { kind: "config", message: "deadlineAt already expired", retryable: false } });

    // A real (non-expired) resume of the same target must still succeed afterwards.
    const real = await service.spawn({ type: "worker", prompt: "again", resumeFrom: "cp1" });
    expect(real).toHaveProperty("runId");
  });
});
