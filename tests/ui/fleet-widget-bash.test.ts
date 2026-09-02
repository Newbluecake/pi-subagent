import { describe, expect, it } from "vitest";
import { FakeClock } from "../../src/core/clock.js";
import type { JobRecord } from "../../src/bash/types.js";
import type { QueryService } from "../../src/service/query-service.js";
import { FleetWidgetController } from "../../src/ui/fleet-widget.js";
import type { RunSnapshot } from "../../src/core/types.js";

const flush = () => new Promise<void>((resolve) => setTimeout(resolve, 0));

const baseJob: JobRecord = {
  v: 1,
  jobId: "b_TEST0001",
  command: "printf output",
  cwd: "/tmp",
  sessionId: "s",
  hostPid: 1,
  status: "running",
  createdAt: 0,
  spawnedAt: 0,
  backgroundedAt: 1,
  exitCode: null,
  logPath: "/tmp/job.log",
  logBytes: 10,
  outputTruncated: false,
  readCursor: 0,
};

function query(): QueryService & { runs: RunSnapshot[] } {
  const holder = { runs: [] as RunSnapshot[] };
  return {
    ...holder,
    get: () => undefined,
    list: () => holder.runs,
    wait: async () => ({ ok: false as const, reason: "unknown_run" as const }),
    waitAll: async () => ({ settled: [], pending: [] }),
    steer: async () => ({ ok: false as const, reason: "not_running" as const }),
    stop: async () => ({ ok: false as const, reason: "stop_failed" as const, escalatedTo: "L4" as const }),
  } as QueryService & { runs: RunSnapshot[] };
}

function ui() {
  const calls: Array<string[] | undefined> = [];
  return { calls, setWidget: (_key: string, content: string[] | undefined) => calls.push(content) };
}

describe("FleetWidgetController background bash tails", () => {
  it("shows the tail on the next tick and rereads running jobs without duplicate inflight reads", async () => {
    const clock = new FakeClock(1000);
    const host = ui();
    const jobs = [baseJob];
    let resolve!: (value: { text: string | undefined; logBytes: number } | undefined) => void;
    const reads: number[] = [];
    const widget = new FleetWidgetController({
      ui: host,
      query: query(),
      clock,
      bashJobs: () => jobs,
      readBashTail: (_record, hint) => {
        reads.push(hint ?? -1);
        return new Promise((r) => (resolve = r));
      },
    });
    expect(reads).toEqual([10]);
    // A pending read must suppress the next tick's duplicate request.
    clock.advance(1000);
    expect(reads).toHaveLength(1);
    resolve({ text: "first\nlatest", logBytes: 20 });
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();
    clock.advance(1000);
    expect(host.calls.at(-1)?.join("\n")).toContain("» latest");
    resolve({ text: "new\nlatest two", logBytes: 30 });
    await Promise.resolve();
    await Promise.resolve();
    clock.advance(1000);
    expect(reads).toHaveLength(2);
    widget.dispose();
  });

  it("freezes terminal tails and falls back to finalText when the tail is absent", async () => {
    const clock = new FakeClock(1000);
    const host = ui();
    const job: JobRecord = { ...baseJob, status: "failed", endedAt: 900, exitCode: 1, finalText: "error\nfailed" };
    let calls = 0;
    const widget = new FleetWidgetController({
      ui: host,
      query: query(),
      clock,
      bashJobs: () => [job],
      readBashTail: async () => {
        calls++;
        return { text: undefined, logBytes: 10 };
      },
    });
    await flush();
    widget.refresh();
    expect(calls).toBe(1);
    expect(host.calls.at(-1)?.join("\n")).toContain("» failed");
    clock.advance(1000);
    clock.advance(1000);
    expect(calls).toBe(1);
    widget.dispose();
  });

  it("backs off rejected reads and prunes vanished jobs", async () => {
    const clock = new FakeClock(1000);
    const host = ui();
    const jobs = [baseJob];
    let calls = 0;
    const widget = new FleetWidgetController({
      ui: host,
      query: query(),
      clock,
      bashJobs: () => jobs,
      readBashTail: async () => {
        calls++;
        throw new Error("swept");
      },
    });
    await flush();
    clock.advance(4000);
    expect(calls).toBe(1);
    clock.advance(1000);
    expect(calls).toBe(2);
    jobs.length = 0;
    clock.advance(1000);
    expect(host.calls.at(-1)).toBeUndefined();
    const readsBeforeDispose = calls;
    widget.dispose();
    clock.advance(5000);
    expect(calls).toBe(readsBeforeDispose);
  });
});
