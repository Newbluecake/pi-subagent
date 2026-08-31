import type { Clock, TimerHandle } from "../core/clock.js";
import type { Millis, RunId } from "../core/types.js";
import type { CallCancelEffect, CallId, CallPhase, CallState } from "./types.js";

/**
 * M3.2 (workflow design §3.6 `CallRegistry`): the five-phase call state
 * machine for `agent()` calls, plus the A2 bounded-retry cancel loop that
 * makes cancellation honest instead of silently ineffective (the core
 * defect §3.6 documents: `SpawnService.abort(runId)` can return `false` for
 * up to `startupMs` right after `spawn()` handed back a `runId`, because
 * `RuntimeRunner` hasn't registered a cancel handle yet).
 *
 * M3.2 scope note (CallPhase, §3.6): `runner_startup` and `running` are
 * collapsed (see types.ts's `CallPhase` doc) — this registry does not listen
 * to `QueryService`/H1 lifecycle events (that plumbing, and hooking it up to
 * a shared `SpawnService`, is M3.3's abort-propagation milestone). The
 * bounded retry loop below only needs "is `abort()` succeeding yet, or has
 * the call settled" — both are already observable without per-phase
 * granularity.
 */

export interface CallRegistryDeps {
  readonly clock: Clock;
  /** `SpawnService.abort` (or an equivalent). Returns whether cancellation is *known to have taken effect*. */
  abort(runId: RunId, cause: string): Promise<boolean>;
  /** WT18: `startupMs + slack` in the real design; kept as an explicit input so tests can compress it (no orchestrator hook needed — see call-registry.test.ts). */
  cancelRetryWindowMs: Millis;
  cancelRetryMs?: Millis; // default 250ms (§3.6)
  /** Fired once per retry attempt (observability hook for W16b-style assertions). */
  onCancelRetryGivenUp?(callId: CallId, runId: RunId): void;
}

export interface CallRegistry {
  submit(callId: CallId, at: Millis): void;
  /** A1 -> A2. Returns `cancelNow` when a CancelIntent was already registered against this callId before `bind` ran (CR2/CR4). */
  bind(callId: CallId, runId: RunId): { cancelNow: boolean; cause?: string };
  /** A2/A3/A4 -> A5 (or A1 -> "withheld", modeled as settled with no runId). */
  settle(callId: CallId, at: Millis): void;
  resolve(callId: CallId): CallState | undefined;
  /** CR3/CR6/CR7: never lies about `retrying` vs `stopped`; never blocks on the retry loop. */
  cancel(callId: CallId, cause: string): CallCancelEffect;
  /** CR5: cancelAll + close registry to further `submit()` (paired with `close_gate`, WR7). */
  cancelAll(cause: string): { withheld: CallId[]; retrying: CallId[]; stopped: CallId[]; alreadySettled: CallId[] };
  /**
   * M3.3 §4.3.1.1: snapshot of every call not yet in phase `settled`, for
   * building the ① `outcomeAt1()` view (RC1's exception — only legal on a
   * `pendingReconcile:true` snapshot) and for WL4's `reconcile_children`
   * bounded sweep.
   */
  listActive(): Array<{ callId: CallId; runId?: RunId; phase: CallPhase }>;
  readonly closed: boolean;
  readonly stats: Record<CallPhase, number> & { retryingCancels: number };
}

export function createCallRegistry(deps: CallRegistryDeps): CallRegistry {
  const cancelRetryMs = deps.cancelRetryMs ?? 250;
  const calls = new Map<CallId, CallState>();
  /** CR4: "cancel arrived before submit" — cancel causes recorded here, consulted by `submit`/`bind`. */
  const preIntents = new Map<CallId, string>();
  /**
   * M3.3 hygiene fix (found while adding real abort-pipeline tests, WR4/WP9
   * class): the retry loop's next-attempt timer must be cancelled the
   * instant a call settles independently (its real outcome arrived via
   * `handleAgent`'s own `waitAll().then()`, not via this loop succeeding) —
   * otherwise a harmless-but-armed `Clock.setTimer` outlives the call,
   * violating "no armed timers survive a terminal decision" the moment the
   * *workflow* itself settles too (`FakeClock.pendingTimers` would be
   * nonzero even though nothing is actually still trying to do anything).
   */
  const retryTimers = new Map<CallId, TimerHandle>();
  let closed = false;

  function countByPhase(): Record<CallPhase, number> {
    const out: Record<CallPhase, number> = { admission: 0, pre_runner: 0, running: 0, settled: 0 };
    for (const c of calls.values()) out[c.phase] += 1;
    return out;
  }

  function retryLoop(callId: CallId, runId: RunId, cause: string): void {
    const state = calls.get(callId);
    if (!state) return;
    const startedAt = deps.clock.now();
    const attempt = (): void => {
      retryTimers.delete(callId); // the timer that fired to invoke this attempt is now spent.
      const current = calls.get(callId);
      if (!current || current.phase === "settled") return; // settled independently — no need to keep retrying (CR7).
      void deps.abort(runId, cause).then((ok) => {
        const c = calls.get(callId);
        if (!c || c.phase === "settled") return;
        if (c.cancelIntent) {
          c.cancelIntent.attempts += 1;
          c.cancelIntent.lastAttemptAt = deps.clock.now();
        }
        if (ok) return; // effect achieved; nothing further to do (the eventual settle() call closes it out).
        if (deps.clock.now() - startedAt >= deps.cancelRetryWindowMs) {
          deps.onCancelRetryGivenUp?.(callId, runId); // CR7: give up boundedly, never blocks workflow settle.
          return;
        }
        retryTimers.set(callId, deps.clock.setTimer(cancelRetryMs, attempt));
      });
    };
    // §3.6 step 2: try once immediately, then fall back to the cancelRetryMs cadence (step 3).
    attempt();
  }

  /**
   * CR2/§7.1 A2 fix: the `bind()`-after-cancel race (a `cancel()` landed
   * while this call's `spawner.spawn()` was still in flight, so the
   * `CallRegistry` state is *already* terminally "settled" as withheld by
   * the time the real `runId` shows up). A single `abort()` attempt is not
   * enough here — the newly-discovered child can be just as deep in the
   * real core's A2 pre_runner window (`activeCancels` not yet registered) as
   * an ordinarily-tracked call would be, so it needs the exact same bounded
   * retry cadence (WT18/CR7), just detached from `calls`/`cancelIntent`
   * bookkeeping (that state is already final and must not be reopened —
   * WR1-equivalent for calls). Bounded by the same `cancelRetryWindowMs`;
   * best-effort, never reported back to the caller (CR7: must never block
   * the workflow's own settlement on this).
   */
  function retryOrphanAbort(callId: CallId, runId: RunId, cause: string): void {
    const startedAt = deps.clock.now();
    const attempt = (): void => {
      retryTimers.delete(callId);
      void deps.abort(runId, cause).then((ok) => {
        if (ok) return;
        if (deps.clock.now() - startedAt >= deps.cancelRetryWindowMs) {
          deps.onCancelRetryGivenUp?.(callId, runId);
          return;
        }
        retryTimers.set(callId, deps.clock.setTimer(cancelRetryMs, attempt));
      });
    };
    attempt();
  }

  const registry: CallRegistry = {
    submit(callId, at) {
      if (closed) return; // CR5
      calls.set(callId, { callId, submittedAt: at, phase: "admission" });
      const cause = preIntents.get(callId);
      if (cause !== undefined) {
        // CR4: cancel arrived first — the call never gets to spawn.
        preIntents.delete(callId);
        const state = calls.get(callId)!;
        state.phase = "settled";
        state.settledAt = at;
        state.cancelIntent = { cause, at, attempts: 0, lastAttemptAt: at };
      }
    },
    bind(callId, runId) {
      const state = calls.get(callId);
      if (!state) return { cancelNow: false };
      if (state.phase === "settled") {
        // Already withheld — either via CR4 (cancel() arrived before submit())
        // or via cancel() landing in the A1 admission window *while this
        // call's `SpawnService.spawn()` was still in flight* (submit() runs
        // before the `await spawner.spawn(...)`, so admission legitimately
        // spans that whole window — cancel() treats it as "never spawns" and
        // settles it immediately). If a `cancelIntent` is recorded, `runId`
        // here is real: the async spawn actually resolved with a live child
        // *after* the call had already been marked withheld. Report
        // `cancelNow` so the caller (`handleAgent`) aborts that real child
        // immediately instead of leaking it — the alternative backstop,
        // `stopChildrenOf`'s `parentRunId`-keyed sweep, never fires when no
        // `parentRunId` is configured and may already have finished its one
        // grace-window pass by the time this late `bind()` runs.
        if (state.cancelIntent) {
          // Kick off the same bounded retry cadence CR2 uses for the ordinary
          // A2 case, detached from `calls`/`cancelIntent` bookkeeping since
          // this call's own state is already final. The caller does not need
          // to (and must not) also call `abort()` itself — `cancelNow` here
          // is purely informational ("skip the normal settle path, this
          // callId is already recorded").
          retryOrphanAbort(callId, runId, state.cancelIntent.cause);
          return { cancelNow: true, cause: state.cancelIntent.cause };
        }
        return { cancelNow: false };
      }
      state.phase = "pre_runner";
      state.runId = runId;
      if (state.cancelIntent) {
        // CR2: bind checks CancelIntent in the same synchronous block it writes runId.
        retryLoop(callId, runId, state.cancelIntent.cause);
        return { cancelNow: true, cause: state.cancelIntent.cause };
      }
      // M3.2 simplification (see module doc): no lifecycle feed to observe
      // runner_startup vs running, so bind() advances straight to "running".
      state.phase = "running";
      return { cancelNow: false };
    },
    settle(callId, at) {
      const state = calls.get(callId);
      if (!state) return;
      state.phase = "settled";
      state.settledAt = at;
      const timer = retryTimers.get(callId);
      if (timer) {
        deps.clock.clearTimer(timer);
        retryTimers.delete(callId);
      }
    },
    resolve(callId) {
      return calls.get(callId);
    },
    cancel(callId, cause) {
      const state = calls.get(callId);
      if (!state) {
        // CR4: "cancel first, submit later" — record the intent for submit() to honor.
        preIntents.set(callId, cause);
        return "unknown";
      }
      if (state.phase === "settled") return "already_settled";
      if (state.phase === "admission") {
        // A1: never spawned — withhold it permanently.
        state.phase = "settled";
        state.settledAt = deps.clock.now();
        state.cancelIntent = { cause, at: deps.clock.now(), attempts: 0, lastAttemptAt: deps.clock.now() };
        return "withheld";
      }
      // A2/A3/A4 (pre_runner/running): write CancelIntent (CR3, never cleared) and start the bounded retry loop.
      if (!state.cancelIntent) {
        state.cancelIntent = { cause, at: deps.clock.now(), attempts: 0, lastAttemptAt: deps.clock.now() };
      }
      if (state.runId !== undefined) retryLoop(callId, state.runId, cause);
      return "retrying";
    },
    cancelAll(cause) {
      closed = true; // CR5
      const withheld: CallId[] = [];
      const retrying: CallId[] = [];
      const stopped: CallId[] = [];
      const alreadySettled: CallId[] = [];
      for (const callId of [...calls.keys()]) {
        const effect = registry.cancel(callId, cause);
        if (effect === "withheld") withheld.push(callId);
        else if (effect === "retrying") retrying.push(callId);
        else if (effect === "already_settled") alreadySettled.push(callId);
        else if (effect === "stopped") stopped.push(callId);
      }
      return { withheld, retrying, stopped, alreadySettled };
    },
    listActive() {
      const out: Array<{ callId: CallId; runId?: RunId; phase: CallPhase }> = [];
      for (const c of calls.values()) {
        if (c.phase === "settled") continue;
        out.push({ callId: c.callId, phase: c.phase, ...(c.runId !== undefined ? { runId: c.runId } : {}) });
      }
      return out;
    },
    get closed() {
      return closed;
    },
    get stats() {
      const byPhase = countByPhase();
      let retryingCancels = 0;
      for (const c of calls.values()) if (c.cancelIntent && c.phase !== "settled") retryingCancels += 1;
      return { ...byPhase, retryingCancels };
    },
  };
  return registry;
}
