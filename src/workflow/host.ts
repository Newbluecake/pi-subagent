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
  }): Promise<ChildSpawnResult | ChildSpawnError>;
  abort(runId: RunId, cause?: string): Promise<boolean>;
  waitAll(opts: { runIds: RunId[] }): Promise<{ settled: ChildOutcome[]; pending: RunId[] }>;
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
    // WT18: `startupMs`(core default 30s) + slack, kept explicit for tests. A
    // real assembler should thread the *actual* configured startupMs here;
    // M3.2 uses a fixed, documented default consistent with the core's own
    // `DEFAULT_BUDGET.startupMs` (see core/deadline.ts) + 5s slack (§4.1 WT18).
    cancelRetryWindowMs: 35_000,
  });

  function recordSettled(summary: WorkflowChildSummary): void {
    children.push(summary);
    deps.onChildSettled?.(summary);
  }

  function remainingWorkflowMs(): Millis {
    if (deps.workflowDeadlineAt === undefined) return Number.POSITIVE_INFINITY;
    return Math.max(0, deps.workflowDeadlineAt - deps.clock.now());
  }

  async function handleAgent(callId: CallId, args: unknown): Promise<HostAckEnvelope> {
    const a = args as { prompt?: unknown; opts?: { label?: unknown; agentType?: unknown } | null };
    if (typeof a.prompt !== "string") {
      return { id: callId, ok: false, error: { message: "agent(prompt, opts?): prompt must be a string" } };
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
        id: callId,
        ok: false,
        error: { message: `agent(): maxParallel (${budget.maxParallel}) concurrent children already active` },
      };
    }
    const totalEverSubmitted =
      registry.stats.admission + registry.stats.pre_runner + registry.stats.running + registry.stats.settled;
    if (totalEverSubmitted >= budget.maxChildren) {
      return {
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
    });
    if ("error" in spawned) {
      registry.settle(callId, deps.clock.now());
      recordSettled({
        callId,
        source: "live",
        status: "withheld",
        durationMs: deps.clock.now() - (startedAt.get(callId) ?? deps.clock.now()),
      });
      return { id: callId, ok: false, error: spawned.error };
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
        const settleMsg: HostSettleEnvelope = { callId, ok: false, error: { message: "child run did not settle" } };
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
          ? { callId, ok: true, value: outcome.text ?? null }
          : { callId, ok: false, error: outcome.error ?? { message: `child ${outcome.status}` } };
      deps.workerHost.send(settleMsg);
    });

    return { id: callId, ok: true, value: { callId, deadlineAt: derived.deadlineAt } };
  }

  async function handleGate(callId: CallId, args: unknown): Promise<HostAckEnvelope> {
    const a = args as { cmd?: unknown; cwd?: unknown };
    if (typeof a.cmd !== "string") {
      return { id: callId, ok: false, error: { message: "gate(cmd, opts?): cmd must be a string" } };
    }
    const timeoutMs = Math.min(budget.gateMs, remainingWorkflowMs());
    if (timeoutMs <= 0) {
      return {
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
      return { id: callId, ok: true, value: result };
    } catch (e) {
      return { id: callId, ok: false, error: { message: errMsg(e) } };
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
    terminated = true;
    const cancelled = registry.cancelAll(reason);
    for (const callId of cancelled.withheld) {
      // A1: `cancel()` already synchronously settled these (never spawned).
      const state = registry.resolve(callId);
      const durationMs = deps.clock.now() - (startedAt.get(callId) ?? deps.clock.now());
      recordSettled({ callId, source: "live", status: "withheld", durationMs });
      deps.workerHost.send({
        callId,
        ok: false,
        error: { message: `workflow terminating (${reason})` },
      } satisfies HostSettleEnvelope);
      void state; // (no runId to report — it never got one)
    }
    for (const callId of cancelled.retrying) {
      // A2/A3/A4: still active. HR8 force-settles it now rather than letting
      // the A2 retry loop (still running in the background, harmlessly) be
      // the thing that eventually calls settle() — that could be seconds away
      // (`cancelRetryWindowMs`), and nothing may stay pending once the
      // workflow itself has ended.
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
      // Best-effort: the port is about to close (S5), but a send racing that
      // close is harmless (WorkerHost.send is a no-throw best-effort primitive).
      deps.workerHost.send({
        callId,
        ok: false,
        error: { message: `workflow terminating (${reason})` },
      } satisfies HostSettleEnvelope);
    }
  });

  return {
    registry,
    get children() {
      return children;
    },
    cancelAllChildren(cause) {
      registry.cancelAll(cause);
    },
  };
}
