import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { systemClock } from "../../src/core/clock.js";
import { DEFAULT_BUDGET } from "../../src/core/deadline.js";
import { MemoryRunStore } from "../../src/core/store.js";
import type { AgentTypeConfig, DriverEvent, RunSnapshot } from "../../src/core/types.js";
import { EscalatingReaper } from "../../src/runtime/reaper.js";
import type { SessionDriver, SessionHandle } from "../../src/runtime/session-driver.js";
import { SingleSlotPool } from "../../src/runtime/slot-pool.js";
import { EventWatchdog } from "../../src/runtime/watchdog.js";
import { createRuntimeRunnerAdapter } from "../../src/service/runtime-adapter.js";
import { createSpawnService, type SpawnService } from "../../src/service/spawn-service.js";
import { createWorkerHost } from "../../src/workflow/lifecycle.js";
import { createOrchestrator } from "../../src/workflow/orchestrator.js";
import type { WorkflowOutcome, WorkflowRunBudget } from "../../src/workflow/types.js";

const type: AgentTypeConfig = { name: "worker", description: "worker", systemPrompt: "", promptMode: "append" };
const finalText = "Final conclusion: use the last assistant message in full.";
const REAL_BUDGET: Partial<WorkflowRunBudget> = {
  scriptLoadMs: 2_000,
  scriptSliceMs: 2_000,
  workerBootMs: 5_000,
  heartbeatMs: 0,
  heartbeatStallMs: 60_000,
  terminateConfirmMs: 2_000,
  workflowTotalMs: 20_000,
  hostCallMs: 5_000,
  gateMs: 5_000,
  maxParallel: 8,
  maxChildren: 50,
  maxBatchItems: 50,
};

function buildStack(driver: SessionDriver) {
  const clock = systemClock;
  const pool = new SingleSlotPool(clock, 1);
  const store = new MemoryRunStore();
  const reaper = new EscalatingReaper(clock);
  const watchdog = new EventWatchdog({
    clock,
    budget: { ...DEFAULT_BUDGET, totalMs: 30_000 },
    getState: () => undefined,
    dispatch: () => undefined,
  });
  const runner = createRuntimeRunnerAdapter({
    clock,
    driver,
    pool,
    store,
    watchdog,
    reaper,
    notifier: {
      enqueue: () => undefined,
      consume: () => false,
      reconcile: () => ({ redelivered: [], suppressed: [], abandoned: [] }),
      verifyPersisted: () => ({ missing: [] }),
      stats: { pending: 0, delivered: 0, consumed: 0, dropped: 0, abandoned: 0 },
      degraded: [],
    },
  });
  const types = {
    get: (name: string) => (name === "worker" ? type : undefined),
    list: () => [type],
    reload: async () => ({ types: [type], errors: [] }),
  };
  const svc: SpawnService & { snapshots(): readonly RunSnapshot[] } = createSpawnService({
    types,
    pool,
    runner,
    now: () => clock.now(),
  });
  return { svc };
}

function realSpawner(svc: SpawnService): ChildSpawner {
  return {
    spawn: async (req) => {
      const result = await svc.spawn({ type: req.type, prompt: req.prompt, ...(req.opts ?? {}) });
      if ("error" in result) throw result.error;
      return result;
    },
    abort: (runId, cause) => svc.abort(runId, cause),
    waitAll: (opts) => svc.waitAll(opts),
  };
}

let journalRoot: string | undefined;
afterEach(async () => {
  if (journalRoot) await rm(journalRoot, { recursive: true, force: true });
  journalRoot = undefined;
});

describe("T14 result text semantics (real spawn/runner + workflow host)", () => {
  it("keeps only the final assistant message and preserves it through host settle and journal", async () => {
    let emit!: (event: DriverEvent) => void;
    const driver: SessionDriver = {
      create: async () => {
        const handle: SessionHandle = {
          sessionId: "s1",
          sessionFile: undefined,
          prompt: async () => {
            emit({ t: "turn_start" });
            emit({ t: "text_delta", delta: "First round narration. " });
            emit({ t: "text_delta", delta: "Second round narration. " });
          },
          steer: () => Promise.resolve(),
          requestAbort: () => Promise.resolve(),
          dispose: () => ({ returned: true, killed: 0, unkillable: [] }),
          killableHandles: new Set(),
          setActiveTools: () => undefined,
          getActiveTools: () => [],
          getLastAssistantText: () => finalText,
          getUsage: () => undefined,
        };
        return handle;
      },
      bind: async (_handle, onEvent: (event: DriverEvent) => void) => {
        emit = onEvent;
      },
      onLateArrival: () => undefined,
    };
    const { svc } = buildStack(driver);
    const spawned = await svc.spawn({ type: "worker", prompt: "solve the task" });
    if ("error" in spawned) throw new Error(spawned.error.message);
    const waited = await svc.waitAll({ runIds: [spawned.runId], waitMs: 5_000 });
    expect(waited.settled).toHaveLength(1);
    expect(waited.settled[0]?.text).toBe(finalText);

    journalRoot = await mkdtemp(join(tmpdir(), "wf-result-text-e2e-"));
    const orchestrator = createOrchestrator({
      clock: systemClock,
      createWorkerHost: () => createWorkerHost({ clock: systemClock }),
      spawner: realSpawner(svc),
      gateRunner: async () => ({ ok: true, code: 0, stdout: "", stderr: "" }),
      journalRootDir: journalRoot,
    });
    const outcome = await orchestrator.run({
      workflowId: "wf-result-text",
      script:
        'export const meta = { name: "t", description: "t" }; return await agent("solve the task", { agentType: "worker" });',
      budget: REAL_BUDGET,
      journal: "j1",
    });
    expect(outcome.status, JSON.stringify(outcome)).toBe("completed");
    expect(outcome.result).toBe(finalText);

    const journalPath = join(journalRoot, "j1", "journal.jsonl");
    const entries = (await readFile(journalPath, "utf8"))
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line) as { value: unknown });
    expect(entries).toHaveLength(1);
    expect(entries[0]?.value).toBe(finalText);
  });
});
