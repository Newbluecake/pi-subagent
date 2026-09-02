import { describe, expect, it, vi } from "vitest";
import { createSpawnService } from "../../src/service/spawn-service.js";
import type { AgentTypeConfig, RunOutcome } from "../../src/core/types.js";
import type { Runner, SlotPool } from "../../src/service/ports.js";

const type: AgentTypeConfig = { name: "worker", description: "worker", systemPrompt: "", promptMode: "append" };
const outcome: RunOutcome = {
  runId: "x",
  status: "completed",
  turns: 1,
  durationMs: 2,
  diag: {
    createdAt: 0,
    phase: "settled",
    phaseEnteredAt: 2,
    settledAt: 2,
    pendingTools: 0,
    turns: 1,
    escalation: [],
    orphaned: false,
    generation: 1,
    degraded: [],
    staleInputs: 0,
    unkillable: [],
  },
};
function deps(runner: Runner) {
  const pool: SlotPool = { acquire: async (runId) => ({ ok: true, ticket: { runId, release() {} } }) };
  return {
    types: { get: () => type, list: () => [], reload: async () => ({ types: [type], errors: [] }) },
    pool,
    runner,
    now: () => 0,
  };
}
describe("SpawnService", () => {
  it("retries when runIdTaken rejects the first generated id", async () => {
    let first: string | undefined;
    const service = createSpawnService({
      ...deps({ run: async (spec) => ({ ...outcome, runId: spec.runId }) }),
      runIdTaken: (id) => {
        if (first === undefined) {
          first = id;
          return true;
        }
        return false;
      },
    });
    const started = await service.spawn({ type: "worker", prompt: "x" });
    if ("error" in started) throw new Error(started.error.message);
    expect(first).toBeDefined();
    expect(started.runId).not.toBe(first);
  });

  it("does not create a timer for an unbounded wait", async () => {
    vi.useFakeTimers();
    try {
      let finish!: (value: RunOutcome) => void;
      const service = createSpawnService({
        ...deps({ run: () => new Promise<RunOutcome>((resolve) => (finish = resolve)) }),
      });
      const started = await service.spawn({ type: "worker", prompt: "x" });
      const waiting = service.waitOutcome(started.runId);
      expect(vi.getTimerCount()).toBe(0);
      finish({ ...outcome, runId: started.runId });
      await expect(waiting).resolves.toMatchObject({ kind: "settled" });
    } finally {
      vi.useRealTimers();
    }
  });

  it("waitOutcome settles and cleans up its waiter", async () => {
    let finish!: (value: RunOutcome) => void;
    const service = createSpawnService({
      ...deps({ run: () => new Promise<RunOutcome>((resolve) => (finish = resolve)) }),
    });
    const started = await service.spawn({ type: "worker", prompt: "x" });
    const waiting = service.waitOutcome(started.runId, 1000);
    finish({ ...outcome, runId: started.runId });
    await expect(waiting).resolves.toMatchObject({ kind: "settled", outcome: { runId: started.runId } });
    await expect(service.waitOutcome(started.runId)).resolves.toMatchObject({ kind: "settled" });
  });

  it("returns pending at the deadline and preserves a later terminal outcome", async () => {
    vi.useFakeTimers();
    try {
      let finish!: (value: RunOutcome) => void;
      const service = createSpawnService({
        ...deps({ run: () => new Promise<RunOutcome>((resolve) => (finish = resolve)) }),
      });
      const started = await service.spawn({ type: "worker", prompt: "x" });
      const waiting = service.waitOutcome(started.runId, 10);
      await vi.advanceTimersByTimeAsync(10);
      await expect(waiting).resolves.toEqual({ kind: "pending" });
      finish({ ...outcome, runId: started.runId });
      await vi.waitFor(() => expect(service.snapshots().find((s) => s.runId === started.runId)?.outcome).toBeDefined());
    } finally {
      vi.useRealTimers();
    }
  });

  it("retains auto-background metadata when marked before the first snapshot", async () => {
    let finish!: (value: RunOutcome) => void;
    let snapshotCallback!: (snapshot: any) => void;
    const service = createSpawnService({
      ...deps({
        run: async (spec, callbacks) => {
          snapshotCallback = callbacks.onSnapshot!;
          await new Promise<void>((resolve) => setTimeout(resolve, 0));
          snapshotCallback({
            runId: spec.runId,
            generation: 1,
            status: "running",
            phase: "model_turn",
            deadlines: { enqueuedAt: 0, deadlineAt: undefined, queueDeadlineAt: undefined },
            diag: { ...outcome.diag, createdAt: 0, phase: "model_turn" },
            updatedAt: 0,
          });
          return new Promise<RunOutcome>((resolve) => (finish = resolve));
        },
      }),
      now: () => 42,
    });
    const started = await service.spawn({ type: "worker", prompt: "x" });
    service.markAutoBackgrounded(started.runId);
    await new Promise((resolve) => setTimeout(resolve, 5));
    finish({ ...outcome, runId: started.runId });
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(service.snapshots().find((s) => s.runId === started.runId)?.diag.autoBackgroundedAt).toBe(42);
  });

  it("re-emits a live auto-background marker and ignores terminal marks", async () => {
    let finish!: (value: RunOutcome) => void;
    const snapshots: unknown[] = [];
    const service = createSpawnService({
      ...deps({ run: () => new Promise<RunOutcome>((resolve) => (finish = resolve)) }),
      now: () => 99,
      onSnapshot: (s) => snapshots.push(s),
    });
    const started = await service.spawn({ type: "worker", prompt: "x" });
    const live = {
      runId: started.runId,
      generation: 1,
      status: "running" as const,
      phase: "model_turn" as const,
      deadlines: { enqueuedAt: 0, deadlineAt: undefined, queueDeadlineAt: undefined },
      diag: { ...outcome.diag, phase: "model_turn" as const },
      updatedAt: 0,
    };
    // The service's runner callback is the normal live snapshot path; use a
    // runner callback capture here to verify marking causes a second emit.
    const markService = createSpawnService({
      ...deps({
        run: async (_spec, callbacks) => {
          callbacks.onSnapshot?.(live);
          return new Promise<RunOutcome>((resolve) => (finish = resolve));
        },
      }),
      now: () => 99,
      onSnapshot: (s) => snapshots.push(s),
    });
    const markStarted = await markService.spawn({ type: "worker", prompt: "x" });
    markService.markAutoBackgrounded(markStarted.runId);
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(snapshots.length).toBeGreaterThanOrEqual(2);
    expect((snapshots[snapshots.length - 1] as any).diag.autoBackgroundedAt).toBe(99);
    finish({ ...outcome, runId: markStarted.runId });
    await new Promise((resolve) => setTimeout(resolve, 0));
    const count = snapshots.length;
    markService.markAutoBackgrounded(markStarted.runId);
    expect(snapshots).toHaveLength(count);
  });

  it("rejects unknown types without invoking runtime", async () => {
    let called = false;
    const result = await createSpawnService({
      ...deps({
        run: async () => {
          called = true;
          return outcome;
        },
      }),
      types: { get: () => undefined, list: () => [], reload: async () => ({ types: [], errors: [] }) },
    }).spawn({ type: "missing", prompt: "x" });
    expect(result).toEqual({
      error: {
        kind: "config",
        message: "unknown agent type: missing. No agent types are registered.",
        retryable: false,
      },
    });
    expect(called).toBe(false);
  });
  it("calls onOutcomeConsumed after spawnAndWait resolves", async () => {
    const seen: RunOutcome[] = [];
    const runner: Runner = {
      run: async (spec) => ({ ...outcome, runId: spec.runId }),
    };
    const result = await createSpawnService({ ...deps(runner), onOutcomeConsumed: (o) => seen.push(o) }).spawnAndWait({
      type: "worker",
      prompt: "x",
    });
    expect(seen).toEqual([result]);
  });

  it("notifies after finish when the runner rejects", async () => {
    let notified: RunOutcome | undefined;
    const service = createSpawnService({
      ...deps({
        run: async () => {
          throw new Error("boom");
        },
      }),
      notifyTerminalFailure: (o) => {
        notified = o;
      },
    });
    const started = await service.spawn({ type: "worker", prompt: "x" });
    expect("runId" in started).toBe(true);
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(notified?.error?.message).toBe("boom");
    expect(service.snapshots().find((s) => s.runId === notified?.runId)?.outcome?.error?.message).toBe("boom");
  });

  it("passes slotless nested requests and returns the runner outcome", async () => {
    let seen: { slotless?: boolean; parentRunId?: string } | undefined;
    const result = await createSpawnService(
      deps({
        run: async (spec) => {
          seen = { slotless: spec.request.slotless, parentRunId: spec.request.parentRunId };
          return { ...outcome, runId: spec.runId };
        },
      }),
    ).spawnAndWait({ type: "worker", prompt: "x", slotless: true, parentRunId: "parent" });
    expect(result.status).toBe("completed");
    expect(seen).toEqual({ slotless: true, parentRunId: "parent" });
  });
});

describe("SpawnService: model hints", () => {
  const hintedType: AgentTypeConfig = { ...type, name: "hinted", modelHint: "sonnet" };
  const hintedDeps = (
    runner: Runner,
    resolveModelHint?: (hint: string) => { provider: string; id: string } | undefined,
  ) => ({
    ...deps(runner),
    types: {
      get: (n: string) => (n === "hinted" ? hintedType : type),
      list: () => [hintedType],
      reload: async () => ({ types: [hintedType], errors: [] }),
    },
    ...(resolveModelHint ? { resolveModelHint } : {}),
  });
  it("resolves a request-level fuzzy hint via the injected resolver", async () => {
    let seenModel: unknown;
    const result = await createSpawnService(
      hintedDeps(
        {
          run: async (spec) => {
            seenModel = (spec as { model?: unknown }).model;
            return { ...outcome, runId: spec.runId };
          },
        },
        (hint) => (hint === "kimi" ? { provider: "moonshot", id: "kimi-k3" } : undefined),
      ),
    ).spawnAndWait({ type: "worker", prompt: "x", modelHintOverride: "kimi" });
    expect(result.status).toBe("completed");
    expect(seenModel).toEqual({ provider: "moonshot", id: "kimi-k3" });
  });
  it("resolves the agent type's frontmatter modelHint when the request carries none", async () => {
    let seenModel: unknown;
    await createSpawnService(
      hintedDeps(
        {
          run: async (spec) => {
            seenModel = (spec as { model?: unknown }).model;
            return { ...outcome, runId: spec.runId };
          },
        },
        () => ({ provider: "cloudrouter-anthropic", id: "claude-sonnet-5" }),
      ),
    ).spawnAndWait({ type: "hinted", prompt: "x" });
    expect(seenModel).toEqual({ provider: "cloudrouter-anthropic", id: "claude-sonnet-5" });
  });
  it("rejects an unresolvable hint at admission without invoking the runner", async () => {
    let called = false;
    const result = await createSpawnService(
      hintedDeps(
        {
          run: async () => {
            called = true;
            return outcome;
          },
        },
        () => undefined,
      ),
    ).spawn({ type: "hinted", prompt: "x" });
    expect(called).toBe(false);
    expect("error" in result && result.error.kind).toBe("config");
    expect("error" in result && result.error.message).toContain('unknown model hint: "sonnet"');
  });
  it("fails closed when no resolver is wired", async () => {
    const result = await createSpawnService(hintedDeps({ run: async () => outcome })).spawn({
      type: "hinted",
      prompt: "x",
    });
    expect("error" in result && result.error.message).toContain('unknown model hint: "sonnet"');
  });
  it("a strict modelOverride pair wins over hints and skips resolution", async () => {
    let seenModel: unknown;
    let resolverCalled = false;
    await createSpawnService(
      hintedDeps(
        {
          run: async (spec) => {
            seenModel = (spec as { model?: unknown }).model;
            return { ...outcome, runId: spec.runId };
          },
        },
        () => {
          resolverCalled = true;
          return undefined;
        },
      ),
    ).spawnAndWait({ type: "hinted", prompt: "x", modelOverride: { provider: "deepseek", id: "deepseek-v4-pro" } });
    expect(seenModel).toEqual({ provider: "deepseek", id: "deepseek-v4-pro" });
    expect(resolverCalled).toBe(false);
  });
});

/**
 * CC4/CP1 (workflow design §4.4.1 F2 / CP1-a/b/c): the deadlineAt admission
 * check must be the very first statement of spawn() — strictly before any
 * mutable bookkeeping (labels/nesting/parentOf/childrenOf/running/resumeLocks).
 */
describe("SpawnService: CC4 CP1 (deadlineAt admission check)", () => {
  it("returns config error and never invokes the runner when deadlineAt is already expired", async () => {
    let called = false;
    const svc = createSpawnService(
      deps({
        run: async () => {
          called = true;
          return outcome;
        },
      }),
    );
    const result = await svc.spawn({ type: "worker", prompt: "x", deadlineAt: -1 });
    expect(result).toEqual({
      error: { kind: "config", message: "deadlineAt already expired", retryable: false },
    });
    expect(called).toBe(false);
  });

  it("CP1-c: a rejected expired-deadline spawn leaves the label index untouched", async () => {
    const svc = createSpawnService(
      deps({
        run: async (spec) => ({ ...outcome, runId: spec.runId }),
      }),
    );
    // If CP1 ran after the labels.set() write (or not at all), this would
    // have registered "x" -> a runId that never actually started.
    const rejected = await svc.spawn({ type: "worker", prompt: "x", label: "x", deadlineAt: -1 });
    expect("error" in rejected).toBe(true);
    expect(svc.getLabel?.("x")).toBeUndefined();

    const real = await svc.spawn({ type: "worker", prompt: "x", label: "x" });
    if ("error" in real) throw new Error(real.error.message);
    expect(svc.getLabel?.("x")).toEqual({ runId: real.runId, type: "worker" });
  });
});
