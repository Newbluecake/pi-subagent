import type { Clock } from "../core/clock.js";
import type { SnapshotStore } from "../core/store.js";
import type { RunEffect } from "../core/types.js";
import type { Notifier } from "../delivery/notifier.js";
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
  };
  runtime = new RuntimeRunner(runnerDeps);
  return {
    async run(spec, callbacks) {
      if (callbacks) perRun.set(spec.runId, callbacks);
      const req: ResolvedSpawnRequest = {
        runId: spec.runId,
        prompt: buildPrompt(spec),
        ...(spec.cwd === undefined ? {} : { cwd: spec.cwd }),
        ...(spec.model === undefined ? {} : { model: spec.model }),
        ...(spec.type.tools === undefined ? {} : { tools: spec.type.tools }),
        ...(spec.type.thinkingLevel === undefined ? {} : { thinkingLevel: spec.type.thinkingLevel }),
        ...(spec.request.signal === undefined ? {} : { signal: spec.request.signal }),
        ...(spec.request.slotless === undefined ? {} : { slotless: spec.request.slotless }),
      };
      try {
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
