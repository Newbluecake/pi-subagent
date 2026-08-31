import type { Clock } from "../core/clock.js";
import type { SnapshotStore } from "../core/store.js";
import type {
  ErrorInfo,
  LifecycleEvent,
  RunDiagnostics,
  RunEffect,
  RunOutcome,
  RunSnapshot,
  SessionSpec,
  SubagentExtensionPoints,
} from "../core/types.js";
import type { Notifier } from "../delivery/notifier.js";
import { mergeExtensionPoints } from "../extensions/registry.js";
import {
  BasicEffectInterpreter,
  RuntimeRunner,
  type ResolvedSpawnRequest,
  type RunnerDeps,
} from "../runtime/runner.js";
import type { Reaper } from "../runtime/reaper.js";
import type { SessionDriver } from "../runtime/session-driver.js";
import type { SlotPool } from "../runtime/slot-pool.js";
import type { Watchdog } from "../runtime/watchdog.js";
import type { LifecycleSink, Runner, RunnerCallbacks, RunnerSpec } from "./ports.js";

export interface RuntimeAdapterDeps {
  clock: Clock;
  driver: SessionDriver;
  pool: SlotPool;
  store: SnapshotStore;
  watchdog: Watchdog;
  reaper: Reaper;
  notifier: Notifier;
  /** Global lifecycle sink (e.g. forwarded to pi.events); per-run callbacks are additionally invoked. */
  onLifecycle?: LifecycleSink;
  /** M2 Wave 1: the four documented extension hooks (architecture §7.1), pre-merged or raw — mergeExtensionPoints() is idempotent over a single already-merged entry. */
  extensions?: readonly SubagentExtensionPoints[];
}

/**
 * Bounded await for H2 (resolveSessionSpec): distinct from RuntimeRunner's
 * internal `guard()` (which races an AbortSignal too) because this hook has
 * no cancel-linkage requirement in the architecture, only a startupMs-scale
 * timeout ("调用方施加 startupMs 超时") — and because a thrown/timed-out hook
 * must surface its *real* message (used for G4 diagnosability), which
 * guard()'s generic "cancelled" reason would otherwise erase.
 */
function withStartupTimeout<T>(
  p: Promise<T>,
  ms: number,
  clock: Clock,
): Promise<{ ok: true; value: T } | { ok: false; error: ErrorInfo }> {
  return new Promise((resolve) => {
    let done = false;
    const timer = clock.setTimer(Math.max(0, ms), () => {
      if (done) return;
      done = true;
      resolve({
        ok: false,
        error: { kind: "config", message: `resolveSessionSpec timed out after ${ms}ms`, retryable: false },
      });
    });
    p.then(
      (value) => {
        if (done) return;
        done = true;
        clock.clearTimer(timer);
        resolve({ ok: true, value });
      },
      (err) => {
        if (done) return;
        done = true;
        clock.clearTimer(timer);
        resolve({
          ok: false,
          error: { kind: "config", message: err instanceof Error ? err.message : String(err), retryable: false },
        });
      },
    );
  });
}

/**
 * H2 failure path ("钩子抛错/超时 → run failed(config)，不得静默继续"): the hook
 * runs before any slot is acquired or session created, so there is no
 * RuntimeRunner state to finish through — build the terminal RunOutcome
 * directly instead of faking a state-machine run.
 */
function failedConfigOutcome(runId: string, error: ErrorInfo, now: number): RunOutcome {
  const diag: RunDiagnostics = {
    createdAt: now,
    phase: "resolve_config",
    phaseEnteredAt: now,
    pendingTools: 0,
    turns: 0,
    escalation: [],
    orphaned: false,
    generation: 1,
    degraded: [],
    staleInputs: 0,
    unkillable: [],
    error,
  };
  return { runId, status: "failed", error, turns: 0, durationMs: 0, diag };
}

/**
 * Assembles the prompt actually sent to the model turn from the agent type's
 * systemPrompt + promptMode and the caller's request prompt (architecture
 * §5.12 / agent .md frontmatter semantics: "replace" vs "append").
 */
function buildPrompt(spec: RunnerSpec): string {
  const { type, request } = spec;
  if (!type.systemPrompt || type.promptMode === "replace") return request.prompt;
  return `${type.systemPrompt}\n\n${request.prompt}`;
}

/**
 * The real cross-layer seam: bridges the L2 execution engine (RuntimeRunner,
 * hang-proof but call-shaped as `run(req, budget)`) to the L3 service
 * contract (ports.Runner, call-shaped as `run(spec, callbacks)`), and wires
 * the state machine's effects (persist_snapshot / enqueue_delivery /
 * emit_lifecycle) to the actual SnapshotStore / Notifier / lifecycle sinks —
 * none of which RuntimeRunner touches directly (by design, see RunnerDeps).
 *
 * Also closes the effect-failure feedback loop: BasicEffectInterpreter's
 * onFailure callback re-dispatches `effect_failed` into the still-running
 * (runId, generation), which is what actually drives the persist_snapshot
 * durable-retry state machine (core/state-machine.ts handleEffectFailed) and
 * makes `outcome.persistFailed` observable (G5a).
 */
export function createRuntimeRunnerAdapter(deps: RuntimeAdapterDeps): Runner {
  const merged = mergeExtensionPoints(deps.extensions ?? []);
  const perRun = new Map<string, RunnerCallbacks>();
  let runtime!: RuntimeRunner;
  const effects = new BasicEffectInterpreter(
    {
      persist_snapshot: (e) => {
        if (e.kind !== "persist_snapshot") return;
        deps.store.put(e.snapshot);
        perRun.get(e.snapshot.runId)?.onSnapshot?.(e.snapshot);
      },
      enqueue_delivery: (e) => {
        if (e.kind !== "enqueue_delivery") return;
        deps.notifier.enqueue(e.payload);
      },
      emit_lifecycle: (e) => {
        if (e.kind !== "emit_lifecycle") return;
        perRun.get(e.event.runId)?.onLifecycle?.(e.event);
        deps.onLifecycle?.(e.event);
        merged.onLifecycle?.(e.event); // H1: run lifecycle bypass observer
      },
    },
    (runId, generation, kind, err) => runtime.notifyEffectFailed(runId, generation, kind as RunEffect["kind"], err),
  );
  const runnerDeps: RunnerDeps = {
    clock: deps.clock,
    driver: deps.driver,
    pool: deps.pool,
    store: deps.store,
    watchdog: deps.watchdog,
    reaper: deps.reaper,
    effects,
    // RuntimeRunner never calls these directly (all real side effects flow
    // through `effects` above); kept as inert no-ops to satisfy RunnerDeps.
    emit: () => undefined,
    deliver: () => undefined,
    ...(merged.beforeReap ? { beforeReap: merged.beforeReap } : {}), // H3
    onExtensionError: (hook, runId, error) =>
      console.warn(`[pi-subagent] extension hook ${hook} failed for run ${runId} (ignored): ${error}`),
  };
  runtime = new RuntimeRunner(runnerDeps);
  /**
   * M1 验收 Minor fix (X7 前置): the H2 failure path runs before
   * RuntimeRunner exists for this run, so it used to bypass every
   * observability channel — no terminal snapshot in the store (QueryService,
   * /agent status and the fleet panel couldn't see the run at all) and no
   * lifecycle event. Persist + emit here through the same channels the
   * effect interpreter uses for state-machine-driven outcomes.
   */
  const settleConfigFailure = (runId: string, error: ErrorInfo): RunOutcome => {
    const now = deps.clock.now();
    const outcome = failedConfigOutcome(runId, error, now);
    const snapshot: RunSnapshot = {
      runId,
      generation: outcome.diag.generation,
      status: "failed",
      phase: "settled", // terminal-snapshot convention (state-machine.ts finish): diag.phase keeps the real phase
      deadlines: { enqueuedAt: outcome.diag.createdAt, deadlineAt: undefined, queueDeadlineAt: undefined },
      diag: outcome.diag,
      outcome,
      updatedAt: now,
    };
    deps.store.put(snapshot);
    perRun.get(runId)?.onSnapshot?.(snapshot);
    const event: LifecycleEvent = { runId, generation: outcome.diag.generation, status: "failed", at: now };
    perRun.get(runId)?.onLifecycle?.(event);
    deps.onLifecycle?.(event);
    merged.onLifecycle?.(event); // H1: run lifecycle bypass observer
    return outcome;
  };
  return {
    async run(spec, callbacks) {
      if (callbacks) perRun.set(spec.runId, callbacks);
      try {
        let sessionSpec: SessionSpec = {
          ...(spec.cwd === undefined ? {} : { cwd: spec.cwd }),
          ...(spec.model === undefined ? {} : { model: spec.model }),
          ...(spec.type.tools === undefined ? {} : { tools: spec.type.tools }),
          ...(spec.type.thinkingLevel === undefined ? {} : { thinkingLevel: spec.type.thinkingLevel }),
        };
        // H2: resolveSessionSpec runs before any slot/session resource is
        // acquired and is bounded by startupMs; a throw or timeout fails the
        // run outright ("failed(config)", not a silent fallback to the
        // unmodified spec).
        if (merged.resolveSessionSpec) {
          const hook = merged.resolveSessionSpec;
          const resolved = await withStartupTimeout(
            Promise.resolve().then(() => hook(sessionSpec, spec.request)),
            spec.budget.startupMs,
            deps.clock,
          );
          if (!resolved.ok) return settleConfigFailure(spec.runId, resolved.error);
          sessionSpec = resolved.value;
        }
        const req: ResolvedSpawnRequest = {
          runId: spec.runId,
          ...sessionSpec,
          prompt: buildPrompt(spec),
          ...(spec.request.signal === undefined ? {} : { signal: spec.request.signal }),
          ...(spec.request.slotless === undefined ? {} : { slotless: spec.request.slotless }),
          ...(spec.request.resumeFrom === undefined ? {} : { resumeFrom: spec.request.resumeFrom }),
        };
        return await runtime.run(req, spec.budget);
      } finally {
        perRun.delete(spec.runId);
      }
    },
    abort(runId, cause) {
      return runtime.abortRun(runId, cause);
    },
    steer(runId, text) {
      return runtime.steerRun(runId, text);
    },
  };
}
