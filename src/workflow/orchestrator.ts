import type { Clock } from "../core/clock.js";
import { withDeadline } from "../core/deadline.js";
import { assertHeartbeatBudgetInvariant, startRunawayWatchdog } from "./runaway.js";
import type {
  SerializedError,
  WorkerHost,
  WorkflowDiagnostics,
  WorkflowHeartbeatDiag,
  WorkflowId,
  WorkflowOutcome,
  WorkflowRunBudget,
  WorkflowStopCause,
  WorkflowTerminalStatus,
  WorkflowTimeoutReason,
} from "./types.js";

/**
 * M3.1 (workflow design §3.8, §11 M3.1 row): the orchestrator *skeleton*.
 * This is deliberately not yet the reduce-based effect-interpreter state
 * machine from §3.4/§3.8 — that lands with abort propagation in M3.3. What
 * M3.1 delivers is exactly the linear slice the milestone scopes: boot the
 * worker, parse the script's meta, run it to completion/failure, settle to a
 * bounded `WorkflowOutcome`. No host call surface exists yet (`agent()` is
 * M3.2), so a script can only `log()` and `return` a value.
 *
 * Even without the full state machine, the M3.1 exit criteria (§11) already
 * require the real isolation/termination guarantees to hold end-to-end:
 * `GW1a`/`GW1b`'s upper bounds (deadlineAt + terminateConfirmMs, no host RPC
 * to reconcile yet so `pendingReconcile` is always `false`) are enforced
 * here, not deferred to a later milestone.
 */

const MAX_SCRIPT_BYTES = 512 * 1024;

export interface OrchestratorRunRequest {
  readonly workflowId: WorkflowId;
  readonly script: string;
  readonly budget: WorkflowRunBudget;
  readonly signal?: AbortSignal;
}

/**
 * §3.8: `OrchestratorDeps` intentionally has no `__testHooks` field (L1 of
 * the four-layer gate, §3.8.1). `createWorkerHost` is plain constructor DI —
 * tests inject a `WorkerHost` built with a scripted/fake underlying worker
 * (see lifecycle.ts's `WorkerLike`) the same way production injects the real
 * `node:worker_threads`-backed one; that is not a fault-injection backdoor,
 * it is the same seam `workerHost: WorkerHost` occupies in the full design
 * (§3.8's `OrchestratorDeps.workerHost`).
 */
export interface OrchestratorDeps {
  readonly clock: Clock;
  createWorkerHost(): WorkerHost;
  emit?(channel: string, payload: unknown): void;
}

export interface Orchestrator {
  run(req: OrchestratorRunRequest): Promise<WorkflowOutcome>;
}

function validateScriptSize(script: string): { ok: true } | { ok: false; message: string } {
  const bytes = Buffer.byteLength(script, "utf8");
  if (bytes > MAX_SCRIPT_BYTES) {
    return { ok: false, message: `script exceeds the ${MAX_SCRIPT_BYTES} byte limit (§5.1): got ${bytes} bytes` };
  }
  if (script.trim().length === 0) {
    return { ok: false, message: "script must not be empty" };
  }
  return { ok: true };
}

type InternalResolution =
  | { readonly kind: "completed"; readonly result: unknown }
  | { readonly kind: "failed"; readonly stopCause: WorkflowStopCause; readonly error: SerializedError }
  | { readonly kind: "timed_out"; readonly timeoutReason: WorkflowTimeoutReason }
  | { readonly kind: "aborted"; readonly stopCause: WorkflowStopCause };

/**
 * L3 of the four-layer test-hook gate (§3.8.1): even if a caller bypasses the
 * type system with `as any` to smuggle a `__testHooks` property onto
 * `OrchestratorDeps`, the production factory fails fast instead of silently
 * accepting it. `createOrchestratorForTest` (orchestrator.testing.ts) never
 * goes through this function's excess-property path — it calls
 * `createOrchestrator` with a clean `deps` object, so this check never fires
 * in a legitimate test either.
 */
function assertNoSmuggledTestHooks(deps: OrchestratorDeps): void {
  if (Object.prototype.hasOwnProperty.call(deps, "__testHooks")) {
    throw new Error("orchestrator: test hooks are not permitted in the production factory");
  }
}

export function createOrchestrator(deps: OrchestratorDeps): Orchestrator {
  assertNoSmuggledTestHooks(deps);

  async function run(req: OrchestratorRunRequest): Promise<WorkflowOutcome> {
    const createdAt = deps.clock.now();
    let heartbeat: WorkflowHeartbeatDiag = { seq: 0, observedAt: createdAt, stalledMs: 0 };
    let logLines = 0;
    let orphanWorker: WorkflowDiagnostics["orphanWorker"];

    const settle = (
      status: WorkflowTerminalStatus,
      extra: {
        result?: unknown;
        error?: SerializedError;
        timeoutReason?: WorkflowTimeoutReason;
        stopCause?: WorkflowStopCause;
      } = {},
    ): WorkflowOutcome => {
      const settledAt = deps.clock.now();
      const diag: WorkflowDiagnostics = {
        createdAt,
        startedAt: createdAt,
        settledAt,
        ...(req.budget.workflowTotalMs > 0 ? { deadlineAt: createdAt + req.budget.workflowTotalMs } : {}),
        heartbeat,
        logLines,
        ...(orphanWorker ? { orphanWorker } : {}),
      };
      const outcome: WorkflowOutcome = {
        workflowId: req.workflowId,
        status,
        pendingReconcile: false, // M3.1: no children exist yet, nothing to reconcile.
        durationMs: settledAt - createdAt,
        diag,
        ...(extra.result !== undefined ? { result: extra.result } : {}),
        ...(extra.error ? { error: extra.error } : {}),
        ...(extra.timeoutReason ? { timeoutReason: extra.timeoutReason } : {}),
        ...(extra.stopCause ? { stopCause: extra.stopCause } : {}),
      };
      deps.emit?.(`subagent:workflow:${status}`, outcome);
      return outcome;
    };

    // §5.1 tool-layer rule, mirrored defensively at the orchestrator boundary too: an already-aborted signal never boots a worker.
    if (req.signal?.aborted) {
      return settle("aborted", { stopCause: "user_stop" });
    }

    // HB1: a misconfigured budget is a startup-time programming error, not a
    // per-run runtime condition — fail loudly instead of folding it into a
    // workflow outcome the caller might not notice.
    if (req.budget.heartbeatMs > 0) {
      assertHeartbeatBudgetInvariant(req.budget.scriptSliceMs, req.budget.heartbeatStallMs, req.budget.heartbeatMs);
    }

    // WT1 (script_load): host-side validation only in M3.1 — meta parsing
    // itself happens inside the worker (worker-source.ts) and is reported
    // back as a `meta_error` message, handled below alongside script_threw.
    const loadCheck = await withDeadline(
      Promise.resolve(validateScriptSize(req.script)),
      req.budget.scriptLoadMs,
      deps.clock,
      "script_load",
    );
    if (!loadCheck.ok) {
      return settle("timed_out", { timeoutReason: "script_load" });
    }
    if (!loadCheck.value.ok) {
      return settle("failed", { stopCause: "script_error", error: { message: loadCheck.value.message } });
    }

    const deadlineAt = req.budget.workflowTotalMs > 0 ? createdAt + req.budget.workflowTotalMs : undefined;
    const workerHost = deps.createWorkerHost();

    workerHost.events.onLog(() => {
      logLines += 1;
    });

    const bootOutcome = await workerHost.boot({
      scriptSource: req.script,
      scriptSliceMs: req.budget.scriptSliceMs,
      heartbeatMs: req.budget.heartbeatMs,
      workerBootMs: req.budget.workerBootMs,
      terminateConfirmMs: req.budget.terminateConfirmMs,
      ...(req.budget.maxOldGenerationSizeMb !== undefined
        ? { maxOldGenerationSizeMb: req.budget.maxOldGenerationSizeMb }
        : {}),
      ...(req.budget.maxYoungGenerationSizeMb !== undefined
        ? { maxYoungGenerationSizeMb: req.budget.maxYoungGenerationSizeMb }
        : {}),
    });

    if (!bootOutcome.ok) {
      await terminateAndRecordOrphan(workerHost, "boot_failed");
      return bootOutcome.reason === "boot_timeout"
        ? settle("timed_out", { timeoutReason: "worker_boot" })
        : settle("failed", {
            stopCause: "worker_died",
            error: { message: bootOutcome.detail ?? "worker boot failed" },
          });
    }

    const resolution = await new Promise<InternalResolution>((resolve) => {
      let done = false;
      let deadlineTimer: ReturnType<Clock["setTimer"]> | undefined;
      let watchdog: ReturnType<typeof startRunawayWatchdog> | undefined;
      let onAbort: (() => void) | undefined;

      const cleanup = (): void => {
        if (deadlineTimer !== undefined) deps.clock.clearTimer(deadlineTimer);
        watchdog?.stop();
        if (onAbort) req.signal?.removeEventListener("abort", onAbort);
      };
      const finish = (r: InternalResolution): void => {
        if (done) return;
        done = true;
        cleanup();
        resolve(r);
      };

      workerHost.events.onScriptReturned((result) => finish({ kind: "completed", result }));
      workerHost.events.onScriptThrew((error) => finish({ kind: "failed", stopCause: "script_error", error }));
      workerHost.events.onMetaError((message) =>
        finish({ kind: "failed", stopCause: "script_error", error: { message } }),
      );
      workerHost.events.onExit((code, expected) => {
        if (!expected) {
          finish({
            kind: "failed",
            stopCause: "worker_died",
            error: { message: `worker exited unexpectedly with code ${code}` },
          });
        }
      });
      workerHost.events.onError((error) => finish({ kind: "failed", stopCause: "worker_died", error }));

      if (deadlineAt !== undefined) {
        deadlineTimer = deps.clock.setTimer(Math.max(0, deadlineAt - deps.clock.now()), () =>
          finish({ kind: "timed_out", timeoutReason: "workflow_total" }),
        );
      }

      watchdog = startRunawayWatchdog({
        clock: deps.clock,
        workerHost,
        heartbeatMs: req.budget.heartbeatMs,
        heartbeatStallMs: req.budget.heartbeatStallMs,
        policy: req.budget.runawayPolicy,
        onTick: (hb) => {
          heartbeat = hb;
        },
        onRunaway: (hb) =>
          finish({
            kind: "failed",
            stopCause: "runaway",
            error: { message: `heartbeat stalled for ${hb.stalledMs}ms (runawayPolicy=terminate_on_stall)` },
          }),
      });

      onAbort = (): void => finish({ kind: "aborted", stopCause: "user_stop" });
      req.signal?.addEventListener("abort", onAbort, { once: true });
    });

    const terminateReason = resolution.kind === "completed" ? "workflow_completed" : `workflow_${resolution.kind}`;
    const terminateOutcome = await workerHost.terminate(terminateReason);
    if (terminateOutcome.orphaned) {
      orphanWorker = { reason: terminateReason, at: deps.clock.now() };
    }

    switch (resolution.kind) {
      case "completed":
        return settle("completed", { result: resolution.result });
      case "failed":
        return settle("failed", { stopCause: resolution.stopCause, error: resolution.error });
      case "timed_out":
        return settle("timed_out", { timeoutReason: resolution.timeoutReason });
      case "aborted":
        return settle("aborted", { stopCause: resolution.stopCause });
    }
  }

  async function terminateAndRecordOrphan(workerHost: WorkerHost, reason: string): Promise<void> {
    await workerHost.terminate(reason);
  }

  return { run };
}
