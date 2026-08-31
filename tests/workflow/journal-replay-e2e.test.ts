import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { systemClock } from "../../src/core/clock.js";
import { attachHostCallHandler, type ChildOutcome, type ChildSpawner } from "../../src/workflow/host.js";
import { buildReplayIndex } from "../../src/workflow/replay.js";
import { createWorkerHost } from "../../src/workflow/lifecycle.js";
import { createOrchestrator, type OrchestratorRunRequest } from "../../src/workflow/orchestrator.js";
import type { WorkflowOutcome, WorkflowRunBudget } from "../../src/workflow/types.js";

/**
 * M3.5 (workflow design §6): end-to-end replay coverage, driven through
 * **real** `node:worker_threads` workers (same harness style as
 * worker-host-call.test.ts/m34-script-api.test.ts) so the whole chain —
 * script -> `agent()` -> host.ts's replay short-circuit -> journal.jsonl on
 * a real temp directory -> a second run reading it back — is exercised for
 * real, not simulated.
 */

const REAL_BUDGET: Partial<WorkflowRunBudget> = {
  scriptLoadMs: 2_000,
  scriptSliceMs: 2_000,
  workerBootMs: 5_000,
  heartbeatMs: 0,
  heartbeatStallMs: 60_000,
  terminateConfirmMs: 2_000,
  workflowTotalMs: 20_000,
  runawayPolicy: "diagnose_only",
  hostCallMs: 5_000,
  gateMs: 5_000,
  maxParallel: 8,
  maxChildren: 50,
  maxBatchItems: 50,
};

/** A `ChildSpawner` that actually "executes" prompts (records calls, lets the test control per-prompt result/delay/configHash) — mirrors m34-script-api.test.ts's `completingSpawner`, extended with `configHashOf` (M3.5 E2). */
function makeSpawner(
  opts: {
    resultOf?(prompt: string): string;
    delayMsOf?(prompt: string): number;
    configHashOf?(type: string): string | undefined;
  } = {},
): { spawner: ChildSpawner; spawnedPrompts: string[] } {
  const spawnedPrompts: string[] = [];
  let n = 0;
  const promptByRunId = new Map<string, string>();
  const spawner: ChildSpawner = {
    spawn: async (req) => {
      spawnedPrompts.push(req.prompt);
      const runId = `r${++n}`;
      promptByRunId.set(runId, req.prompt);
      return { runId };
    },
    abort: async () => true,
    waitAll: async ({ runIds }) => {
      const settled: ChildOutcome[] = await Promise.all(
        runIds.map(async (runId) => {
          const prompt = promptByRunId.get(runId) ?? "";
          const delay = opts.delayMsOf?.(prompt) ?? 0;
          if (delay > 0) await new Promise((r) => setTimeout(r, delay));
          const text = opts.resultOf?.(prompt) ?? `done:${prompt}`;
          return { runId, status: "completed" as const, text };
        }),
      );
      return { settled, pending: [] };
    },
    ...(opts.configHashOf ? { configHashOf: opts.configHashOf } : {}),
  };
  return { spawner, spawnedPrompts };
}

function scriptWith(body: string, metaExtra = ""): string {
  return `export const meta = { name: "t", description: "t"${metaExtra} };\n${body}`;
}

let journalRootDir: string;

beforeEach(async () => {
  journalRootDir = await mkdtemp(join(tmpdir(), "wf-replay-e2e-"));
});
afterEach(async () => {
  await rm(journalRootDir, { recursive: true, force: true });
});

async function runOnce(
  script: string,
  spawner: ChildSpawner,
  overrides: Partial<OrchestratorRunRequest> = {},
): Promise<WorkflowOutcome> {
  const orch = createOrchestrator({
    clock: systemClock,
    createWorkerHost: () => createWorkerHost({ clock: systemClock }),
    spawner,
    gateRunner: async () => ({ ok: true, code: 0, stdout: "", stderr: "" }),
  });
  return orch.run({
    workflowId: `wf_${Math.random().toString(36).slice(2)}`,
    script,
    budget: REAL_BUDGET as WorkflowRunBudget,
    ...overrides,
  } as OrchestratorRunRequest);
}

/** `OrchestratorDeps.journalRootDir` has to be threaded per-run since `runOnce` builds a fresh orchestrator each call — a thin wrapper keeps call sites terse. */
async function runWithJournal(
  script: string,
  spawner: ChildSpawner,
  overrides: Partial<OrchestratorRunRequest> = {},
): Promise<WorkflowOutcome> {
  const orch = createOrchestrator({
    clock: systemClock,
    createWorkerHost: () => createWorkerHost({ clock: systemClock }),
    spawner,
    gateRunner: async () => ({ ok: true, code: 0, stdout: "", stderr: "" }),
    journalRootDir,
  });
  return orch.run({
    workflowId: `wf_${Math.random().toString(36).slice(2)}`,
    script,
    budget: REAL_BUDGET as WorkflowRunBudget,
    journal: "j1",
    ...overrides,
  });
}

describe("M3.5 §10.2: replay correctness matrix (real worker, real journal.jsonl)", () => {
  it("① deterministic script rerun hits everything — zero child spawns on the second run", async () => {
    const script = scriptWith('const a = await agent("task A"); const b = await agent("task B"); return a + "|" + b;');
    const run1 = makeSpawner();
    const outcome1 = await runWithJournal(script, run1.spawner);
    expect(outcome1.status).toBe("completed");
    expect(run1.spawnedPrompts).toEqual(["task A", "task B"]);
    expect(outcome1.replay).toEqual({ hits: 0, misses: 2, skipped: 0, corruptLines: 0 });

    const run2 = makeSpawner();
    const outcome2 = await runWithJournal(script, run2.spawner);
    expect(outcome2.status).toBe("completed");
    expect(run2.spawnedPrompts).toEqual([]); // zero live spawns — every call replayed.
    expect(outcome2.result).toBe(outcome1.result);
    expect(outcome2.replay).toEqual({ hits: 2, misses: 0, skipped: 0, corruptLines: 0 });
    expect(outcome2.children.every((c) => c.source === "replay")).toBe(true);
  });

  it("② out-of-order completion (parallel) does not change the hit set on rerun (推论 2.1)", async () => {
    const script = scriptWith(
      'const [a, b] = await parallel([() => agent("slow A"), () => agent("fast B")]); return a + "|" + b;',
    );
    // Run 1: make "slow A" (submitted first) settle *after* "fast B"
    // (submitted second) — completion order is reversed from submission
    // order.
    const run1 = makeSpawner({ delayMsOf: (p) => (p === "slow A" ? 120 : 10) });
    const outcome1 = await runWithJournal(script, run1.spawner);
    expect(outcome1.status).toBe("completed");
    expect(outcome1.replay?.misses).toBe(2);

    const run2 = makeSpawner();
    const outcome2 = await runWithJournal(script, run2.spawner);
    expect(outcome2.status).toBe("completed");
    expect(run2.spawnedPrompts).toEqual([]); // both hit despite the reversed completion order in run 1's journal.
    expect(outcome2.result).toBe(outcome1.result);
    expect(outcome2.replay).toEqual({ hits: 2, misses: 0, skipped: 0, corruptLines: 0 });
  });

  it("③ a hand-tampered journal entry (value edited, digest stale) falls back to live for that task — never returns the tampered value", async () => {
    const script = scriptWith('return await agent("tamper me");');
    const run1 = makeSpawner({ resultOf: () => "original answer" });
    const outcome1 = await runWithJournal(script, run1.spawner);
    expect(outcome1.result).toBe("original answer");

    // Hand-edit journal.jsonl: change `value` without recomputing `digest`.
    const journalPath = join(journalRootDir, "j1", "journal.jsonl");
    const original = (await readFile(journalPath, "utf8")).trim();
    const entry = JSON.parse(original) as Record<string, unknown>;
    const tampered = { ...entry, value: "a completely different (tampered) answer" };
    await writeFile(journalPath, JSON.stringify(tampered) + "\n", "utf8");

    const run2 = makeSpawner({ resultOf: () => "fresh live answer" });
    const outcome2 = await runWithJournal(script, run2.spawner);
    // GW4: never return the tampered value — falls back to a real, live run.
    expect(run2.spawnedPrompts).toEqual(["tamper me"]);
    expect(outcome2.result).toBe("fresh live answer");
    expect(outcome2.replay).toEqual({ hits: 0, misses: 1, skipped: 0, corruptLines: 1 });
  });

  it("④ meta.deterministic:false never replays, even on an identical rerun; journal is still written", async () => {
    const script = scriptWith('return await agent("nondeterministic task");', ", deterministic: false");
    const run1 = makeSpawner();
    const outcome1 = await runWithJournal(script, run1.spawner);
    expect(outcome1.status).toBe("completed");
    expect(outcome1.replay).toEqual({ hits: 0, misses: 0, skipped: 1, corruptLines: 0 });

    const run2 = makeSpawner();
    const outcome2 = await runWithJournal(script, run2.spawner);
    expect(run2.spawnedPrompts).toEqual(["nondeterministic task"]); // still spawned live — never replayed.
    expect(outcome2.replay).toEqual({ hits: 0, misses: 0, skipped: 1, corruptLines: 0 });

    // The journal file itself did grow (RP9 only gates *lookups*, not writes).
    const text = await readFile(join(journalRootDir, "j1", "journal.jsonl"), "utf8");
    expect(text.trim().split("\n")).toHaveLength(2);
  });

  it("⑤ a corrupt/garbage journal line is skipped (WARN + counted) while sibling entries still replay", async () => {
    const script = scriptWith('const a = await agent("A"); const b = await agent("B"); return a + b;');
    const run1 = makeSpawner();
    await runWithJournal(script, run1.spawner);

    const journalPath = join(journalRootDir, "j1", "journal.jsonl");
    const original = await readFile(journalPath, "utf8");
    await writeFile(journalPath, "not even json, just garbage\n" + original, "utf8");

    const run2 = makeSpawner();
    const outcome2 = await runWithJournal(script, run2.spawner);
    expect(run2.spawnedPrompts).toEqual([]); // both A and B still replay fine.
    expect(outcome2.replay).toEqual({ hits: 2, misses: 0, skipped: 0, corruptLines: 1 });
  });

  it("⑥ an agentType config-hash change (agent definition edited) misses, even with an identical prompt", async () => {
    const script = scriptWith('return await agent("same prompt", { agentType: "reviewer" });');
    const run1 = makeSpawner({ configHashOf: () => "config-v1" });
    const outcome1 = await runWithJournal(script, run1.spawner);
    expect(outcome1.replay?.misses).toBe(1);

    // Same prompt, same agentType *name*, but the resolved config changed
    // (e.g. the reviewer's .md systemPrompt was edited) — E2.
    const run2 = makeSpawner({ configHashOf: () => "config-v2-edited" });
    const outcome2 = await runWithJournal(script, run2.spawner);
    expect(run2.spawnedPrompts).toEqual(["same prompt"]); // miss: config-hash differs.
    expect(outcome2.replay).toEqual({ hits: 0, misses: 1, skipped: 0, corruptLines: 0 });

    // Control: an unchanged config hash on a third run does hit.
    const run3 = makeSpawner({ configHashOf: () => "config-v2-edited" });
    const outcome3 = await runWithJournal(script, run3.spawner);
    expect(run3.spawnedPrompts).toEqual([]);
    expect(outcome3.replay).toEqual({ hits: 1, misses: 0, skipped: 0, corruptLines: 0 });
  });

  it("⑦ chain scope: an upstream prompt change breaks the whole downstream chain (causal safety, 定理 4')", async () => {
    const script1 = scriptWith('const a = await agent("A v1"); const b = await agent("B"); return a + b;');
    const run1 = makeSpawner();
    await runWithJournal(script1, run1.spawner);

    // Run 2: A's prompt changed, B's did not — default `chain` scope must
    // still miss B (its chain digest now differs).
    const script2 = scriptWith('const a = await agent("A v2"); const b = await agent("B"); return a + b;');
    const run2 = makeSpawner();
    const outcome2 = await runWithJournal(script2, run2.spawner);
    expect(run2.spawnedPrompts).toEqual(["A v2", "B"]); // both live: causal break.
    expect(outcome2.replay).toEqual({ hits: 0, misses: 2, skipped: 0, corruptLines: 0 });
  });

  it("⑦b content scope: the same upstream change only misses the changed task, not its unrelated sibling", async () => {
    const script1 = scriptWith('const a = await agent("A v1"); const b = await agent("B"); return a + b;');
    const run1 = makeSpawner();
    await runWithJournal(script1, run1.spawner, { replayScope: "content" });

    const script2 = scriptWith('const a = await agent("A v2"); const b = await agent("B"); return a + b;');
    const run2 = makeSpawner();
    const outcome2 = await runWithJournal(script2, run2.spawner, { replayScope: "content" });
    expect(run2.spawnedPrompts).toEqual(["A v2"]); // only A is live; B still replays.
    expect(outcome2.replay).toEqual({ hits: 1, misses: 1, skipped: 0, corruptLines: 0 });
  });

  it("noReplay forces every call live even with a matching journal", async () => {
    const script = scriptWith('return await agent("x");');
    const run1 = makeSpawner();
    await runWithJournal(script, run1.spawner);
    const run2 = makeSpawner();
    const outcome2 = await runWithJournal(script, run2.spawner, { noReplay: true });
    expect(run2.spawnedPrompts).toEqual(["x"]);
    expect(outcome2.replay).toEqual({ hits: 0, misses: 0, skipped: 1, corruptLines: 0 });
  });

  it("no `journal` configured on the request: zero journal I/O, `replay` stats undefined", async () => {
    const script = scriptWith('return await agent("x");');
    const run1 = makeSpawner();
    const outcome1 = await runOnce(script, run1.spawner);
    expect(outcome1.replay).toBeUndefined();
  });
});

describe("M3.5 JS1: journal writes never block the host_settle round trip", () => {
  it("agent()'s settle resolves quickly even when the journal store's flush is artificially slow", async () => {
    const host = createWorkerHost({ clock: systemClock });
    const flushCalls: number[] = [];
    const appended: unknown[] = [];
    const slowStore = {
      load: async () => ({ entries: [], corruptLines: 0 }),
      append: (_dir: string, entry: unknown) => {
        appended.push(entry);
        // Deliberately never resolves within any reasonable test window —
        // JS1 says `append()` itself must not be awaited by the settle path,
        // so this must have zero effect on how fast the script's `await
        // agent()` resolves.
      },
      flush: async (_dir: string, deadlineMs: number) => {
        flushCalls.push(deadlineMs);
        return new Promise<{ written: number; pending: number }>(() => {
          /* never resolves */
        });
      },
    };
    const index = buildReplayIndex([], 0, "chain");
    const spawner: ChildSpawner = {
      spawn: async () => ({ runId: "r1" }),
      abort: async () => true,
      waitAll: async ({ runIds }) => ({
        settled: runIds.map((runId) => ({ runId, status: "completed" as const, text: "ok" })),
        pending: [],
      }),
    };
    attachHostCallHandler({
      clock: systemClock,
      workerHost: host,
      spawner,
      gateRunner: async () => ({ ok: true, code: 0, stdout: "", stderr: "" }),
      budget: { hostCallMs: 3_000, gateMs: 3_000, maxParallel: 4, maxChildren: 10, maxBatchItems: 10 },
      journal: {
        store: slowStore,
        dir: "/tmp/unused-js1-test-dir",
        index,
        scope: "chain",
        noReplay: false,
        deterministic: { current: true },
      },
    });
    const boot = await host.boot({
      scriptSource: scriptWith('return await agent("x");'),
      scriptSliceMs: 2_000,
      heartbeatMs: 0,
      workerBootMs: 5_000,
      terminateConfirmMs: 2_000,
      hostCallMs: 3_000,
      gateMs: 3_000,
      maxBatchItems: 10,
    });
    expect(boot.ok).toBe(true);

    const start = Date.now();
    const returned = await new Promise<unknown>((resolve) => {
      host.events.onScriptReturned(resolve);
      host.events.onScriptThrew((e) => resolve({ threw: e }));
    });
    const elapsedMs = Date.now() - start;
    expect(returned).toBe("ok"); // the fake spawner always resolves child text to "ok", independent of prompt.
    // Generous bound (well under the never-resolving flush) — the point is
    // "not tied to the flush", not a tight microbenchmark.
    expect(elapsedMs).toBeLessThan(2_000);
    expect(appended).toHaveLength(1); // append() *was* called (fire-and-forget), just never awaited.
    await host.terminate("test_done");
  });
});
