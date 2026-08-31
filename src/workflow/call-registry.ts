import type { Clock } from "../core/clock.js";
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
  readonly closed: boolean;
  readonly stats: Record<CallPhase, number> & { retryingCancels: number };
}

export function createCallRegistry(deps: CallRegistryDeps): CallRegistry {
  const cancelRetryMs = deps.cancelRetryMs ?? 250;
  const calls = new Map<CallId, CallState>();
  /** CR4: "cancel arrived before submit" — cancel causes recorded here, consulted by `submit`/`bind`. */
  const preIntents = new Map<CallId, string>();
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
        deps.clock.setTimer(cancelRetryMs, attempt);
      });
    };
    // §3.6 step 2: try once immediately, then fall back to the cancelRetryMs cadence (step 3).
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
      if (state.phase === "settled") return { cancelNow: false }; // already withheld by a pre-intent (CR4)
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
