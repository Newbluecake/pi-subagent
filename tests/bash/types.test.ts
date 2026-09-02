import { describe, expect, it } from "vitest";
import {
  ALLOWED_JOB_TRANSITIONS,
  COMMAND_PREVIEW_MAX,
  FINAL_TEXT_MAX_BYTES,
  JOB_RECORD_VERSION,
  JOB_STATUSES,
  TERMINAL_JOB_STATUSES,
  canTransitionJob,
  createJobRecord,
  isJobStatus,
  isTerminalJobStatus,
  needsCompletionNotice,
  parseJobRecord,
  previewCommand,
  transitionJob,
  truncateFinalText,
  type JobRecord,
  type JobStatus,
} from "../../src/bash/types.js";

function staged(): JobRecord {
  return createJobRecord({
    jobId: "b_3F7K2M9P",
    command: "npm test",
    cwd: "/repo",
    sessionId: "s1",
    hostPid: 12345,
    logPath: "/tmp/bash-jobs/b_3F7K2M9P.log",
    createdAt: 1_000,
  });
}

function running(): JobRecord {
  const moved = transitionJob(staged(), "running", { at: 1_500, pid: 23456, pgid: 23456 });
  if (!moved.ok) throw new Error(moved.reason);
  return moved.record;
}

describe("bash job status taxonomy", () => {
  it("enumerates every status exactly once and splits live vs terminal", () => {
    expect(new Set(JOB_STATUSES).size).toBe(JOB_STATUSES.length);
    expect(JOB_STATUSES).toEqual([
      "staged",
      "running",
      "completed",
      "failed",
      "timed_out",
      "killed",
      "exited_unknown",
      "orphaned",
    ]);
    // §3.2 terminal set — the notification/retention machinery keys off this.
    expect([...TERMINAL_JOB_STATUSES].sort()).toEqual(
      ["completed", "exited_unknown", "failed", "killed", "orphaned", "timed_out"].sort(),
    );
    expect(JOB_STATUSES.filter((s) => !isTerminalJobStatus(s))).toEqual(["staged", "running"]);
  });

  it("guards the status enum at the JSON boundary", () => {
    for (const status of JOB_STATUSES) expect(isJobStatus(status)).toBe(true);
    for (const bogus of ["", "aborted", "queued", "RUNNING", 0, null, undefined, {}]) {
      expect(isJobStatus(bogus)).toBe(false);
    }
  });

  it("keeps the transition table total over every status", () => {
    expect(Object.keys(ALLOWED_JOB_TRANSITIONS).sort()).toEqual([...JOB_STATUSES].sort());
  });
});

/**
 * Executable transition matrix (§3.2): every (from, to) pair in the status
 * square is asserted, so adding a status without deciding its edges fails
 * here rather than in production.
 */
describe("bash job transition matrix", () => {
  const legal: ReadonlyArray<readonly [JobStatus, JobStatus]> = [
    ["staged", "running"],
    ["staged", "failed"],
    ["staged", "killed"],
    ["running", "completed"],
    ["running", "failed"],
    ["running", "timed_out"],
    ["running", "killed"],
    ["running", "exited_unknown"],
    ["running", "orphaned"],
  ];
  const legalKeys = new Set(legal.map(([from, to]) => `${from}->${to}`));

  for (const from of JOB_STATUSES) {
    for (const to of JOB_STATUSES) {
      const expected = legalKeys.has(`${from}->${to}`);
      it(`${expected ? "allows" : "rejects"} ${from} -> ${to}`, () => {
        expect(canTransitionJob(from, to)).toBe(expected);
      });
    }
  }

  it("makes every terminal status a sink, including self-transitions", () => {
    for (const from of TERMINAL_JOB_STATUSES) {
      expect(ALLOWED_JOB_TRANSITIONS[from]).toEqual([]);
      for (const to of JOB_STATUSES) expect(canTransitionJob(from, to)).toBe(false);
    }
  });

  it("rejects self-transitions for the live states too", () => {
    expect(canTransitionJob("staged", "staged")).toBe(false);
    expect(canTransitionJob("running", "running")).toBe(false);
  });
});

describe("transitionJob", () => {
  it("stamps spawnedAt and process identity on staged -> running", () => {
    const result = transitionJob(staged(), "running", {
      at: 1_500,
      pid: 23456,
      pgid: 23456,
      procStartTime: "428899",
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.record).toMatchObject({
      status: "running",
      spawnedAt: 1_500,
      pid: 23456,
      pgid: 23456,
      procStartTime: "428899",
      exitCode: null,
    });
    expect(result.record.endedAt).toBeUndefined();
  });

  it("keeps an existing spawnedAt when a job is re-marked running (adoption)", () => {
    const adopted = transitionJob(staged(), "running", { at: 1_500 });
    expect(adopted.ok).toBe(true);
    if (!adopted.ok) return;
    // Same record cannot go running -> running, but the guard itself is what
    // protects spawnedAt; assert the field is untouched by later patches.
    const terminal = transitionJob(adopted.record, "completed", { at: 9_000, exitCode: 0 });
    expect(terminal.ok).toBe(true);
    if (!terminal.ok) return;
    expect(terminal.record.spawnedAt).toBe(1_500);
  });

  it("stamps endedAt plus exit metadata on every terminal transition", () => {
    for (const to of ["completed", "failed", "timed_out", "killed", "exited_unknown", "orphaned"] as const) {
      const result = transitionJob(running(), to, {
        at: 9_000,
        exitCode: to === "completed" ? 0 : 1,
        finalText: "out\n\nCommand exited with code 1",
        logBytes: 4096,
        outputTruncated: true,
      });
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(result.record).toMatchObject({
        status: to,
        endedAt: 9_000,
        exitCode: to === "completed" ? 0 : 1,
        logBytes: 4096,
        outputTruncated: true,
      });
      expect(result.record.finalText).toContain("Command exited with code 1");
      expect(needsCompletionNotice(result.record)).toBe(true);
    }
  });

  it("accepts an explicitly unknown exit code", () => {
    const result = transitionJob(running(), "exited_unknown", { at: 9_000, exitCode: null });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.record.exitCode).toBeNull();
  });

  it("leaves untouched fields alone and never mutates the input", () => {
    const before = running();
    const snapshot = structuredClone(before);
    const result = transitionJob(before, "completed", { at: 9_000 });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(before).toEqual(snapshot);
    expect(result.record.exitCode).toBeNull();
    expect(result.record.logBytes).toBe(0);
    expect(result.record.outputTruncated).toBe(false);
  });

  it("rejects an illegal transition with a diagnosable reason and no state change", () => {
    const done = transitionJob(running(), "completed", { at: 9_000, exitCode: 0 });
    expect(done.ok).toBe(true);
    if (!done.ok) return;
    const again = transitionJob(done.record, "killed", { at: 9_500 });
    expect(again.ok).toBe(false);
    if (again.ok) return;
    expect(again.reason).toBe("illegal bash job transition completed -> killed (b_3F7K2M9P)");
  });

  it("truncates finalText to the tail so the exit status line survives", () => {
    const long = `${"x".repeat(FINAL_TEXT_MAX_BYTES)}\n\nCommand exited with code 2`;
    const result = transitionJob(running(), "failed", { at: 9_000, exitCode: 2, finalText: long });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.record.finalText).toHaveLength(FINAL_TEXT_MAX_BYTES);
    expect(result.record.finalText?.endsWith("Command exited with code 2")).toBe(true);
  });

  it("treats a delivered notification as satisfying the notice requirement", () => {
    const done = transitionJob(running(), "completed", { at: 9_000, exitCode: 0 });
    expect(done.ok).toBe(true);
    if (!done.ok) return;
    expect(needsCompletionNotice(done.record)).toBe(true);
    expect(needsCompletionNotice({ ...done.record, notifiedAt: 9_100 })).toBe(false);
    expect(needsCompletionNotice(running())).toBe(false);
  });
});

describe("record helpers", () => {
  it("creates a staged record at schema version 1 with zeroed counters", () => {
    expect(staged()).toEqual({
      v: 1,
      jobId: "b_3F7K2M9P",
      command: "npm test",
      cwd: "/repo",
      sessionId: "s1",
      hostPid: 12345,
      status: "staged",
      createdAt: 1_000,
      exitCode: null,
      logPath: "/tmp/bash-jobs/b_3F7K2M9P.log",
      logBytes: 0,
      outputTruncated: false,
      readCursor: 0,
    });
    expect(JOB_RECORD_VERSION).toBe(1);
  });

  it("collapses command previews to one capped line", () => {
    expect(previewCommand("  npm   run \n build:all ")).toBe("npm run build:all");
    const preview = previewCommand("x".repeat(400));
    expect(preview).toHaveLength(COMMAND_PREVIEW_MAX);
    expect(preview.endsWith("…")).toBe(true);
    expect(previewCommand("abcdef", 3)).toBe("ab…");
  });

  it("keeps short final texts verbatim", () => {
    expect(truncateFinalText("hi")).toBe("hi");
    expect(truncateFinalText("abcdef", 3)).toBe("def");
  });
});

describe("parseJobRecord", () => {
  const wire = {
    v: 1,
    jobId: "b_3F7K2M9P",
    command: "npm test",
    cwd: "/repo",
    sessionId: "s1",
    hostPid: 12345,
    pid: 23456,
    pgid: 23456,
    procStartTime: "428899",
    status: "running",
    createdAt: 1_000,
    spawnedAt: 1_500,
    backgroundedAt: 2_000,
    endedAt: 9_000,
    exitCode: 1,
    finalText: "boom",
    logPath: "/tmp/b_3F7K2M9P.log",
    logBytes: 4096,
    outputTruncated: true,
    notifiedAt: 9_100,
    readCursor: 512,
  };

  it("round-trips a full record", () => {
    const result = parseJobRecord(structuredClone(wire));
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.record).toEqual(wire);
  });

  it("rejects records that cannot be acted on", () => {
    const cases: ReadonlyArray<readonly [unknown, string]> = [
      [null, "not a JSON object"],
      [[wire], "not a JSON object"],
      ["{}", "not a JSON object"],
      [{ ...wire, v: 2 }, "unsupported schema version 2"],
      [{ ...wire, v: undefined }, "unsupported schema version undefined"],
      [{ ...wire, jobId: "" }, "missing jobId"],
      [{ ...wire, command: 7 }, "missing command"],
      [{ ...wire, status: "aborted" }, 'unknown status "aborted"'],
      [{ ...wire, createdAt: Number.NaN }, "missing createdAt"],
      [{ ...wire, logPath: undefined }, "missing logPath"],
    ];
    for (const [value, reason] of cases) {
      const result = parseJobRecord(value);
      expect(result.ok).toBe(false);
      if (result.ok) continue;
      expect(result.reason).toContain(reason);
    }
  });

  it("falls back field-by-field for tolerable garbage", () => {
    const result = parseJobRecord({
      v: 1,
      jobId: "b_3F7K2M9P",
      command: "npm test",
      status: "completed",
      createdAt: 1_000,
      logPath: "/tmp/x.log",
      cwd: 5,
      sessionId: null,
      hostPid: "nope",
      pid: "nope",
      exitCode: "0",
      logBytes: -5,
      readCursor: Number.POSITIVE_INFINITY,
      outputTruncated: "yes",
      notifiedAt: "later",
      procStartTime: "",
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.record).toEqual({
      v: 1,
      jobId: "b_3F7K2M9P",
      command: "npm test",
      cwd: "",
      sessionId: "",
      hostPid: 0,
      status: "completed",
      createdAt: 1_000,
      exitCode: null,
      logPath: "/tmp/x.log",
      logBytes: 0,
      outputTruncated: false,
      readCursor: 0,
    });
    // Absent (not `undefined`) — exactOptionalPropertyTypes + clean JSON.
    expect(Object.keys(result.record)).not.toContain("pid");
    expect(Object.keys(result.record)).not.toContain("notifiedAt");
    expect(Object.keys(result.record)).not.toContain("procStartTime");
  });
});
