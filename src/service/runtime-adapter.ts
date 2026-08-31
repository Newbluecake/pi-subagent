import type { Clock } from "../core/clock.js";
import { applyStructuredOutputPolicy, validateAgainstSchema } from "../core/json-schema.js";
import type { SnapshotStore } from "../core/store.js";
import type {
  ErrorInfo,
  LifecycleEvent,
  RunDiagnostics,
  RunEffect,
  RunId,
  RunOutcome,
  RunSnapshot,
  SessionSpec,
  StopCause,
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
import { buildToolScopePolicy, createToolScopeEnforcer } from "../runtime/tool-scope.js";
import type { Watchdog } from "../runtime/watchdog.js";
import { threadThroughRequestFields } from "./request-threading.js";
import { createAgentTool, type NestedSpawnPort } from "../tools/agent-tool.js";
import { createStructuredOutputTool } from "../tools/structured-output-tool.js";
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
  /**
   * X3: lazily-resolved narrow spawn port used to build the nested Agent
   * tool injected into a child session's own SessionSpec.customTools. A
   * getter (not a value) because createRuntimeRunnerAdapter is constructed
   * before createSpawnService exists in index.ts (SpawnService itself needs
   * the runner as one of its own deps) — the getter is called at spawn time,
   * by which point index.ts has filled in the ref.
   */
  nestedSpawn?: () => NestedSpawnPort | undefined;
  /** X3: forwarded to RunnerDeps.onChildAbort (see runtime/runner.ts) — called whenever this run's cancellation is triggered, so the caller can cascade-abort its children. */
  onChildAbort?: (runId: RunId, cause: StopCause) => void;
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
  // CC2: runs spawned with a parentRunId (i.e. workflow/nested children, X3)
  // must not enqueue a top-level completion notification (workflow design
  // §7.4 gap ① "child ownership" / §8.2 CC2). Tracked by runId, set at the
  // start of run() (before any await) and cleared in its `finally`, so the
  // shared enqueue_delivery interpreter below — which only sees the effect
  // payload, not the originating RunnerSpec — can still tell child runs
  // apart from top-level ones.
  const childRunIds = new Set<string>();
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
        // CC2: child runs are consumed exclusively by their owner (the parent
        // run / future workflow orchestrator), never by the top-level outbox
        // — otherwise every child of a busy parent would independently spam a
        // top-level completion notification (workflow design §8.2 CC2).
        if (childRunIds.has(e.payload.runId)) return;
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
    onStateChange: (runId, state) => {
      const cb = perRun.get(runId)?.onSnapshot;
      if (!cb) return;
      cb({
        runId,
        generation: state.generation,
        status: state.status,
        phase: state.phase,
        deadlines: state.deadlines,
        diag: state.diag,
        updatedAt: deps.clock.now(),
      });
    },
    onExtensionError: (hook, runId, error) =>
      console.warn(`[pi-subagent] extension hook ${hook} failed for run ${runId} (ignored): ${error}`),
    ...(deps.onChildAbort ? { onChildAbort: deps.onChildAbort } : {}), // X3 cascade
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
      if (spec.request.parentRunId !== undefined) childRunIds.add(spec.runId); // CC2
      // X10: captures the last StructuredOutput submission for this run, if
      // any. Populated (only) by the injected tool's onSubmit below; read
      // again, independently, after the run settles (host-side re-validation
      // — architecture §7.2 X10 "双重校验").
      const structured: { value?: unknown } = {};
      try {
        // CC4/CP2: re-check the absolute deadline cap as the first thing
        // inside this run's own execution, before any sessionSpec/customTools
        // construction or H2 invocation — catches drift accrued between
        // SpawnService's admission check (CP1) and this run actually
        // starting (e.g. queued behind other synchronous work). H2 is not
        // invoked on this path, so no worktree is created.
        if (spec.request.deadlineAt !== undefined && spec.request.deadlineAt <= deps.clock.now())
          return settleConfigFailure(spec.runId, {
            kind: "config",
            message: "deadlineAt already expired",
            retryable: false,
          });
        let sessionSpec: SessionSpec = {
          ...(spec.cwd === undefined ? {} : { cwd: spec.cwd }),
          ...(spec.model === undefined ? {} : { model: spec.model }),
          ...(spec.type.tools === undefined ? {} : { tools: spec.type.tools }),
          ...(spec.type.thinkingLevel === undefined ? {} : { thinkingLevel: spec.type.thinkingLevel }),
        };
        // X3/X10 built-in injected tools, always applied ahead of any H2
        // extension (so an extension's resolveSessionSpec still sees — and can
        // further extend — the full customTools list).
        const grantedReserved: string[] = [];
        const customTools: unknown[] = [];
        if (spec.type.canSpawn?.length && deps.nestedSpawn) {
          const port = deps.nestedSpawn();
          if (port) {
            customTools.push(
              createAgentTool({
                spawn: port,
                parentRunId: spec.runId,
                allowedTypes: spec.type.canSpawn,
                forceSlotless: true,
              }),
            );
            grantedReserved.push("Agent");
          }
        }
        if (spec.request.schema !== undefined) {
          const schema = spec.request.schema;
          customTools.push(
            createStructuredOutputTool({
              schema,
              onSubmit: (value) => {
                const result = validateAgainstSchema(schema, value);
                if (result.ok) structured.value = value;
                return result;
              },
            }),
          );
          grantedReserved.push("StructuredOutput");
        }
        if (customTools.length)
          sessionSpec = { ...sessionSpec, customTools: [...(sessionSpec.customTools ?? []), ...customTools] };
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
        // X11: re-applied at bind and every turn_end (runtime/runner.ts), not
        // just once here — this is what actually closes the MCP-late-registration
        // gap (architecture §7.5). `undefined` allow-list preserves the pre-X11
        // behavior for agent types without a `tools` field: no restriction
        // beyond the always-on reserved-name protection.
        const toolScope = {
          policy: buildToolScopePolicy({
            ...(spec.type.tools ? { tools: spec.type.tools } : {}),
            granted: grantedReserved,
          }),
          enforcer: createToolScopeEnforcer({
            // TS4: never silent. Note: §7.5's literal "WARN + diag.degraded"
            // is only half-met here — the enforcer is built before the run's
            // dispatch channel exists, so blocked/failed enforcement lands in
            // the log but not in diag.degraded (documented gap, P3).
            onBlocked: (names) =>
              console.warn(
                `[pi-subagent] tool scope: blocked late-registered/reserved tool(s) not in run ${spec.runId}'s whitelist: ${names.join(", ")}`,
              ),
            onError: (error) =>
              console.warn(
                `[pi-subagent] tool scope: setActiveTools failed for run ${spec.runId} (retried at next turn boundary): ${error instanceof Error ? error.message : String(error)}`,
              ),
          }),
        };
        const req: ResolvedSpawnRequest = {
          runId: spec.runId,
          ...sessionSpec,
          prompt: buildPrompt(spec),
          ...threadThroughRequestFields(spec.request), // F3/F4 (CC4 — also carries deadlineAt)
          toolScope,
          // M-A: display-only metadata for the presentation layer (diag.model/
          // label/agentType). spec.model is already the merged
          // modelOverride-or-type-default pair; undefined means "pi session
          // default", which the UI renders as such.
          displayMeta: {
            ...(spec.model === undefined ? {} : { model: spec.model }),
            ...(spec.request.label === undefined ? {} : { label: spec.request.label }),
            agentType: spec.type.name,
          },
        };
        let outcome = await runtime.run(req, spec.budget);
        // X10 host-side re-validation (second of the two mandatory checks).
        if (spec.request.schema !== undefined)
          outcome = applyStructuredOutputPolicy(outcome, spec.request.schema, structured.value);
        return outcome;
      } finally {
        perRun.delete(spec.runId);
        childRunIds.delete(spec.runId); // CC2
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
