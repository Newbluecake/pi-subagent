import type { Clock } from "../core/clock.js";
import { withDeadline } from "../core/deadline.js";
import type { Millis, RunId } from "../core/types.js";
import { deriveChildBudget } from "./budget.js";
import { createCallRegistry, type CallRegistry } from "./call-registry.js";
import type {
  CallId,
  HostAckEnvelope,
  HostCallEnvelope,
  HostSettleEnvelope,
  OrphanChildSummary,
  WorkerHost,
  WorkflowChildSummary,
  WorkflowRunBudget,
} from "./types.js";

/**
 * M3.2 (workflow design §3.3/§3.5/§4.4): the host-side call handler —
 * `agent()`/`gate()` land here as `HostCallEnvelope`s, get answered with the
 * ack segment (HR3: `agent`'s ack never waits for the child), and (for
 * `agent`) get a second, asynchronous `settle` push once the spawned child
 * reaches a terminal state.
 *
 * Deliberately **not** importing `SpawnService` from `src/service/` (WI2,
 * carried forward from M3.1: the isolation shell stays decoupled from the
 * core/service layer's concrete types). `ChildSpawner` below is a
 * structural subset `SpawnService` already satisfies — the orchestrator's
 * caller passes a real `SpawnService` instance, TypeScript accepts it
 * because the shapes match, and `src/workflow/**` still has zero import
 * edges into `src/service/**`.
 */

export interface ChildSpawnResult {
  readonly runId: RunId;
}
export interface ChildSpawnError {
  readonly error: { readonly message: string };
}
export interface ChildOutcome {
  readonly runId: RunId;
  readonly status: "completed" | "failed" | "timed_out" | "aborted";
  readonly text?: string;
  readonly error?: { readonly message: string };
}
export interface ChildSpawner {
  spawn(req: {
    type: string;
    prompt: string;
    label?: string;
    deadlineAt?: Millis;
    parentRunId?: string;
    /**
     * M3.3 Minor fix (§4.4.3 BW1/BW3): the relative budget `deriveChildBudget`
     * computed, threaded all the way to `SpawnRequest.budgetOverride` —
     * previously only the absolute `deadlineAt` cap was forwarded, so a
     * `SpawnService` that (like the real one) resolves relative
     * `totalMs`/`queueWaitMs` at the child's own enqueue time had no relative
     * signal at all, only the CC4 ceiling.
     */
    budgetOverride?: { totalMs?: Millis; queueWaitMs?: Millis };
  }): Promise<ChildSpawnResult | ChildSpawnError>;
  abort(runId: RunId, cause?: string): Promise<boolean>;
  waitAll(opts: { runIds: RunId[] }): Promise<{ settled: ChildOutcome[]; pending: RunId[] }>;
  /**
   * M3.3 §3.7 OS1/OS4: workflow-scoped bulk stop — structurally compatible
   * with `SpawnService.stopChildrenOf` (CC1). Optional: when absent, WL2
   * falls back to per-call `abort()` via `CallRegistry.cancelAll` alone
   * (still correct, just without the OS4 sweep's extra safety net for
   * children the registry never learned about).
   */
  stopChildrenOf?(parentRunId: string, cause: string): Promise<{ stopped: RunId[]; pending: RunId[] }>;
}

export type GateRunner = (
  cmd: string,
  opts: { cwd?: string; timeoutMs: Millis },
) => Promise<{ ok: boolean; code: number; stdout: string; stderr: string }>;

export interface HostCallHandlerDeps {
  readonly clock: Clock;
  readonly workerHost: WorkerHost;
  readonly spawner: ChildSpawner;
  readonly gateRunner: GateRunner;
  readonly budget: Pick<
    WorkflowRunBudget,
    | "hostCallMs"
    | "gateMs"
    | "maxParallel"
    | "maxChildren"
    | "maxBatchItems"
    | "childBudgetPolicy"
    | "childBudgetFraction"
    | "childTotalMs"
    | "cancelRetryWindowMs"
  >;
  /** WR2-equivalent: the workflow's own absolute deadline, computed once at enqueue and never recomputed here. */
  readonly workflowDeadlineAt?: Millis;
  readonly defaultAgentType?: string;
  readonly parentRunId?: string;
  /** Fired once per settled/withheld child, in settlement order (feeds `WorkflowOutcome.children`). */
  onChildSettled?(summary: WorkflowChildSummary): void;
}

export interface HostCallHandler {
  readonly registry: CallRegistry;
  readonly children: readonly WorkflowChildSummary[];
  /** Best-effort: attempts to stop every still-active child (used ahead of a future M3.3 abort pipeline; harmless no-op today if nothing is running). */
  cancelAllChildren(cause: string): void;
  /**
   * M3.3 §7.2 WL1/WL2/WL4 (inline): closes the gate, cascade-cancels every
   * still-active call, waits up to `graceMs` (WT10 `abortGraceMs`) for real
   * settlement, then force-settles and reports whatever is left as
   * orphaned. Idempotent (WI6) — a second call (or a subsequent
   * `WorkerHost.terminate()`'s `onTerminating`) is a no-op once this has run.
   */
  stopOwned(cause: string, graceMs: Millis): Promise<{ orphanChildren: readonly OrphanChildSummary[] }>;
}

const DEFAULT_AGENT_TYPE = "general-purpose";

function errMsg(e: unknown): string {
  if (e instanceof Error) return e.message;
  return String(e);
}

/**
 * Wires `deps.workerHost.events.onHostCall`/`onTerminating` and returns a
 * handle exposing the registry + accumulated child summaries. Call once per
 * workflow run (mirrors `createWorkerHost` — one instance per run, no
 * reuse).
 */
export function attachHostCallHandler(deps: HostCallHandlerDeps): HostCallHandler {
  const budget = {
    hostCallMs: deps.budget.hostCallMs ?? 60_000,
    gateMs: deps.budget.gateMs ?? 600_000,
    maxParallel: deps.budget.maxParallel ?? 4,
    maxChildren: deps.budget.maxChildren ?? 500,
    maxBatchItems: deps.budget.maxBatchItems ?? 1024,
    childBudgetPolicy: deps.budget.childBudgetPolicy ?? "inherit_remaining",
    ...(deps.budget.childBudgetFraction !== undefined ? { childBudgetFraction: deps.budget.childBudgetFraction } : {}),
    ...(deps.budget.childTotalMs !== undefined ? { childTotalMs: deps.budget.childTotalMs } : {}),
  };
  const children: WorkflowChildSummary[] = [];
  const startedAt = new Map<CallId, Millis>();
  let terminated = false;

  const registry = createCallRegistry({
    clock: deps.clock,
    abort: (runId, cause) => deps.spawner.abort(runId, cause),
    // WT18: `startupMs`(core default 30s) + slack by default, but honors an
    // explicit budget override so a real assembler (or a test, via
    // `OrchestratorTestHooks.cancelRetryWindowMsOverride`) can thread the
    // *actual* configured window through instead of this fixed fallback.
    cancelRetryWindowMs: deps.budget.cancelRetryWindowMs ?? 35_000,
  });

  function recordSettled(summary: WorkflowChildSummary): void {
    children.push(summary);
    deps.onChildSettled?.(summary);
    if (registry.listActive().length === 0) {
      const waiters = drainWaiters.splice(0, drainWaiters.length);
      for (const cb of waiters) cb();
    }
  }

  // M3.3 §7.2 WL2: event-driven (not polled) wait for "every still-active
  // call has really settled" — `recordSettled` above notifies every waiter
  // the instant the registry drains, so `stopOwned`'s bounded wait resolves
  // as soon as children finish for real instead of only on a fixed poll
  // cadence (also makes it exactly one `Clock.setTimer` per `stopOwned` call,
  // which plays correctly with `FakeClock`-driven tests — a single
  // `clock.advance(graceMs)` is enough to force the timeout branch).
  const drainWaiters: Array<() => void> = [];

  /** A1 (withheld): `cancel()` already synchronously settled these — they never spawned, so there is no runId to report. */
  function settleWithheld(callId: CallId, cause: string): void {
    const durationMs = deps.clock.now() - (startedAt.get(callId) ?? deps.clock.now());
    recordSettled({ callId, source: "live", status: "withheld", durationMs });
    deps.workerHost.send({
      kind: "host_settle",
      callId,
      ok: false,
      error: { message: `workflow terminating (${cause})` },
    } satisfies HostSettleEnvelope);
  }

  /**
   * A2/A3/A4: still active when the workflow decided to stop. Force-settles
   * it as `aborted` rather than waiting for the (now-moot) A2 retry loop to
   * eventually give up on its own `cancelRetryWindowMs` clock — HR8/WL4:
   * nothing may stay pending once the workflow itself has ended.
   */
  function forceSettleActive(callId: CallId, cause: string): void {
    const state = registry.resolve(callId);
    registry.settle(callId, deps.clock.now());
    const durationMs = deps.clock.now() - (startedAt.get(callId) ?? deps.clock.now());
    recordSettled({
      callId,
      ...(state?.runId !== undefined ? { runId: state.runId } : {}),
      source: "live",
      status: "aborted",
      durationMs,
    });
    // Best-effort: the port may already be closing (S5), but a send racing
    // that close is harmless (WorkerHost.send is a no-throw best-effort primitive).
    deps.workerHost.send({
      kind: "host_settle",
      callId,
      ok: false,
      error: { message: `workflow terminating (${cause})` },
    } satisfies HostSettleEnvelope);
  }

  function remainingWorkflowMs(): Millis {
    if (deps.workflowDeadlineAt === undefined) return Number.POSITIVE_INFINITY;
    return Math.max(0, deps.workflowDeadlineAt - deps.clock.now());
  }

  async function handleAgent(callId: CallId, args: unknown): Promise<HostAckEnvelope> {
    const a = args as { prompt?: unknown; opts?: { label?: unknown; agentType?: unknown } | null };
    if (typeof a.prompt !== "string") {
      return {
        kind: "host_ack",
        id: callId,
        ok: false,
        error: { message: "agent(prompt, opts?): prompt must be a string" },
      };
    }
    const opts = a.opts ?? {};
    const label = typeof opts.label === "string" ? opts.label : undefined;
    const agentType =
      typeof opts.agentType === "string" ? opts.agentType : (deps.defaultAgentType ?? DEFAULT_AGENT_TYPE);

    // §5.3 D-W… "narrowed": M3.2 does not have the agent-type registry
    // reachable at this layer (it lives in `AgentTypeRegistry`, service
    // layer) — unknown-type rejection is enforced by `ChildSpawner.spawn`
    // itself returning `{ error }`, which this handler already threads
    // through to an ack failure below. No separate check needed here.

    const activeCount = ["admission", "pre_runner", "running"].reduce(
      (n, phase) => n + registry.stats[phase as "admission" | "pre_runner" | "running"],
      0,
    );
    if (activeCount >= budget.maxParallel) {
      return {
        kind: "host_ack",
        id: callId,
        ok: false,
        error: { message: `agent(): maxParallel (${budget.maxParallel}) concurrent children already active` },
      };
    }
    const totalEverSubmitted =
      registry.stats.admission + registry.stats.pre_runner + registry.stats.running + registry.stats.settled;
    if (totalEverSubmitted >= budget.maxChildren) {
      return {
        kind: "host_ack",
        id: callId,
        ok: false,
        error: { message: `agent(): maxChildren (${budget.maxChildren}) exceeded for this workflow run` },
      };
    }

    const derived = deriveChildBudget(
      {
        now: deps.clock.now(),
        policy: budget.childBudgetPolicy,
        ...(deps.workflowDeadlineAt !== undefined ? { workflowDeadlineAt: deps.workflowDeadlineAt } : {}),
        // M3.2: no phase tracking yet (see budget.ts doc) — `phaseDeadlineAt` deliberately omitted.
        ...(budget.childBudgetFraction !== undefined ? { fraction: budget.childBudgetFraction } : {}),
        ...(budget.childTotalMs !== undefined ? { fixedTotalMs: budget.childTotalMs } : {}),
      },
      undefined,
    );
    if (derived.capped === "expired") {
      return {
        kind: "host_ack",
        id: callId,
        ok: false,
        error: { message: "WorkflowBudgetExhausted: no remaining budget to spawn a child (BW2)" },
      };
    }

    registry.submit(callId, deps.clock.now());
    startedAt.set(callId, deps.clock.now());

    const spawned = await deps.spawner.spawn({
      type: agentType,
      prompt: a.prompt,
      ...(label !== undefined ? { label } : {}),
      ...(derived.deadlineAt !== undefined ? { deadlineAt: derived.deadlineAt } : {}),
      ...(deps.parentRunId !== undefined ? { parentRunId: deps.parentRunId } : {}),
      budgetOverride: { totalMs: derived.totalMs, queueWaitMs: derived.queueWaitMs },
    });
    if ("error" in spawned) {
      registry.settle(callId, deps.clock.now());
      recordSettled({
        callId,
        source: "live",
        status: "withheld",
        durationMs: deps.clock.now() - (startedAt.get(callId) ?? deps.clock.now()),
      });
      return { kind: "host_ack", id: callId, ok: false, error: spawned.error };
    }

    registry.bind(callId, spawned.runId);

    // HR3: fire the settle wait in the background — the ack below returns
    // immediately, independent of how long the child itself takes.
    void deps.spawner.waitAll({ runIds: [spawned.runId] }).then(({ settled }) => {
      const outcome = settled[0];
      registry.settle(callId, deps.clock.now());
      const durationMs = deps.clock.now() - (startedAt.get(callId) ?? deps.clock.now());
      if (!outcome) {
        // The spawner never settled this run (e.g. it was already gone by
        // the time waitAll looked it up) — report it honestly rather than hang.
        const settleMsg: HostSettleEnvelope = {
          kind: "host_settle",
          callId,
          ok: false,
          error: { message: "child run did not settle" },
        };
        recordSettled({ callId, runId: spawned.runId, source: "live", status: "aborted", durationMs });
        deps.workerHost.send(settleMsg);
        return;
      }
      recordSettled({
        callId,
        runId: outcome.runId,
        source: "live",
        status: outcome.status,
        durationMs,
        ...(outcome.text !== undefined ? { textPreview: outcome.text.slice(0, 2048) } : {}),
      });
      const settleMsg: HostSettleEnvelope =
        outcome.status === "completed"
          ? { kind: "host_settle", callId, ok: true, value: outcome.text ?? null }
          : { kind: "host_settle", callId, ok: false, error: outcome.error ?? { message: `child ${outcome.status}` } };
      deps.workerHost.send(settleMsg);
    });

    return { kind: "host_ack", id: callId, ok: true, value: { callId, deadlineAt: derived.deadlineAt } };
  }

  async function handleGate(callId: CallId, args: unknown): Promise<HostAckEnvelope> {
    const a = args as { cmd?: unknown; cwd?: unknown };
    if (typeof a.cmd !== "string") {
      return { kind: "host_ack", id: callId, ok: false, error: { message: "gate(cmd, opts?): cmd must be a string" } };
    }
    const timeoutMs = Math.min(budget.gateMs, remainingWorkflowMs());
    if (timeoutMs <= 0) {
      return {
        kind: "host_ack",
        id: callId,
        ok: false,
        error: { message: "WorkflowBudgetExhausted: no remaining workflow budget for gate()" },
      };
    }
    try {
      const result = await deps.gateRunner(a.cmd, {
        ...(typeof a.cwd === "string" ? { cwd: a.cwd } : {}),
        timeoutMs,
      });
      return { kind: "host_ack", id: callId, ok: true, value: result };
    } catch (e) {
      return { kind: "host_ack", id: callId, ok: false, error: { message: errMsg(e) } };
    }
  }

  deps.workerHost.events.onHostCall((envelope: HostCallEnvelope) => {
    if (terminated) {
      // Defense-in-depth, not the primary mechanism: once `terminate()`'s S5
      // has actually closed the host's end of the port (§2.3.1/WC09), a
      // message like this one can never be delivered here at all — this
      // branch only matters for the vanishingly narrow synchronous window
      // between `onTerminating` firing (S2) and S5 running, during which no
      // message delivery can happen anyway (JS has no preemption). Kept
      // anyway so a future refactor that widens that window fails safe
      // instead of silently answering a call from a workflow that already
      // decided to stop.
      deps.workerHost.send({
        kind: "host_ack",
        id: envelope.id,
        ok: false,
        cancelled: true,
        cause: "workflow_terminating",
      } satisfies HostAckEnvelope);
      return;
    }
    // HR2: every handler is double-sided-bounded — `hostCallMs` for `agent`'s
    // admission-only ack, `gateMs` for `gate`'s single-segment RPC — capped
    // by whatever workflow budget remains (never lets a handler outlive WT8).
    const opBudgetMs = envelope.op === "gate" ? budget.gateMs : budget.hostCallMs;
    const boundMs = Math.min(opBudgetMs, remainingWorkflowMs());
    // BW2: a workflow with zero (or negative) remaining budget is a distinct,
    // more specific condition than "the handler ran out of time" — report it
    // as such instead of letting `withDeadline(work, 0, ...)`'s ms<=0 fast
    // path win the race against `work` before it ever gets to run its own
    // BW2 check (core/deadline.ts's `withDeadline` resolves synchronously for
    // ms<=0 and only fires `p.catch()` on the real promise, discarding
    // whatever answer it would have produced).
    if (boundMs <= 0) {
      deps.workerHost.send({
        kind: "host_ack",
        id: envelope.id,
        ok: false,
        error: { message: "WorkflowBudgetExhausted: no remaining workflow budget to service this host call (BW2)" },
      } satisfies HostAckEnvelope);
      return;
    }
    const work =
      envelope.op === "agent" ? handleAgent(envelope.id, envelope.args) : handleGate(envelope.id, envelope.args);
    void withDeadline(work, boundMs, deps.clock, `host_call:${envelope.op}`).then((r) => {
      if (terminated) return; // avoid a duplicate ack racing the terminate()-driven one below.
      if (r.ok) {
        deps.workerHost.send(r.value);
      } else {
        deps.workerHost.send({
          kind: "host_ack",
          id: envelope.id,
          ok: false,
          error: { message: `host call '${envelope.op}' did not complete within ${boundMs}ms (HR2)` },
        } satisfies HostAckEnvelope);
      }
    });
  });

  // HR8: on terminate() (S2, before S5/S6 physically cut the port), reject
  // every call this host still has pending — both "ack never sent" (still in
  // admission, e.g. `spawner.spawn` hung) and "ack sent, settle never
  // pushed" (child still running when the workflow ended). `registry.cancel()`
  // on an active (pre_runner/running) call only *starts* the A2 bounded
  // retry loop — it deliberately does not settle the call synchronously
  // (CR7: that loop must not be forced to resolve instantly in the general
  // case). HR8 is a stronger requirement than CR7: once the *workflow itself*
  // is terminating, nothing may be left pending — so this handler explicitly
  // force-settles every still-active call the instant `terminate()` fires,
  // instead of waiting for the (now-moot, since the workflow is over) retry
  // loop to eventually give up on its own on the `cancelRetryWindowMs` clock.
  deps.workerHost.events.onTerminating((reason) => {
    if (terminated) return; // WL3 after WL1/WL2 already ran via stopOwned() — everything is settled, avoid double-recording.
    terminated = true;
    const cancelled = registry.cancelAll(reason);
    for (const callId of cancelled.withheld) settleWithheld(callId, reason);
    for (const callId of cancelled.retrying) forceSettleActive(callId, reason);
  });

  return {
    registry,
    get children() {
      return children;
    },
    cancelAllChildren(cause) {
      registry.cancelAll(cause);
    },
    async stopOwned(cause, graceMs) {
      if (terminated) return { orphanChildren: [] }; // idempotent (WI6): a prior stopOwned()/terminate() already ran.
      // WL1: close the gate *synchronously*, before anything else — no new
      // agent()/gate() admission can land after this point (onHostCall checks
      // the same `terminated` flag).
      terminated = true;
      // WL2: cascade-cancel every still-active call (CallRegistry's bounded
      // retry loop +, if the caller supplied one, the core's own owner-stop
      // sweep — OS4).
      const cancelled = registry.cancelAll(cause);
      for (const callId of cancelled.withheld) settleWithheld(callId, cause);
      if (deps.spawner.stopChildrenOf && deps.parentRunId !== undefined) {
        try {
          await deps.spawner.stopChildrenOf(deps.parentRunId, cause);
        } catch {
          // Best-effort sweep (OS4) — CallRegistry's own per-call retry loop
          // (already started by cancelAll above) is the real safety net.
        }
      }
      // WT10 abortGraceMs: give still-active children a real chance to
      // settle for real (their own `handleAgent().then()` callback calls
      // `registry.settle`/`recordSettled` with the true outcome, which wakes
      // this wait immediately via `drainWaiters`) before WL4 gives up on
      // them. Bounded by a single timer — not polled.
      if (registry.listActive().length > 0) {
        await new Promise<void>((resolve) => {
          let settled = false;
          const timer = deps.clock.setTimer(Math.max(0, graceMs), () => {
            if (settled) return;
            settled = true;
            resolve();
          });
          drainWaiters.push(() => {
            if (settled) return;
            settled = true;
            deps.clock.clearTimer(timer);
            resolve();
          });
        });
      }
      // WL4 (reconcile, inline): anything still active after the grace window
      // is force-settled and reported as orphaned (RC3) rather than left
      // dangling in `children[]` with a non-terminal status (RC1).
      const orphanChildren: OrphanChildSummary[] = [];
      for (const active of registry.listActive()) {
        forceSettleActive(active.callId, cause);
        orphanChildren.push({
          callId: active.callId,
          ...(active.runId !== undefined ? { runId: active.runId } : {}),
          reason: "cancel_retry_exhausted",
          at: deps.clock.now(),
        });
      }
      return { orphanChildren };
    },
  };
}
