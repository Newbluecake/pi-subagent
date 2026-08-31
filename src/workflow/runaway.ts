import type { Clock, TimerHandle } from "../core/clock.js";
import type { Millis } from "../core/types.js";
import type { RunawayPolicy } from "../config/settings.js";
import type { WorkerHost, WorkflowHeartbeatDiag } from "./types.js";

/**
 * M3.1 (workflow design §2.3, P2): the heartbeat watchdog. This is
 * deliberately *not* the termination hard guarantee (HB5) — it only
 * diagnoses ("is this script suspiciously stalled?") and, when the operator
 * opts into `runawayPolicy: "terminate_on_stall"`, escalates. The one hard
 * guarantee (`workflowTotalMs`, WT8/P4) lives in orchestrator.ts and does not
 * depend on this module at all.
 *
 * HB3 (§2.3): `terminate_on_stall` is supposed to require "stalled AND no
 * host RPC arrived in the meantime" before it fires. M3.1 has no host RPC
 * concept yet (that's M3.2's `agent()`), so that second condition is
 * vacuously true for the whole milestone — heartbeat stall alone is the only
 * signal available. This is a known, intentional M3.1 simplification; M3.2
 * must thread an "any RPC observed since last check" flag into this
 * watchdog before `terminate_on_stall` is safe to recommend in a build that
 * has host calls.
 */

/**
 * HB1 (§2.3): `heartbeatStallMs` must exceed `scriptSliceMs + 2*heartbeatMs`,
 * or the vm slice wall (P1) could never fire before the watchdog would have
 * already stalled-out on a *legitimate* first synchronous slice. Violating
 * this is a startup-time configuration error, not a runtime condition.
 */
export function assertHeartbeatBudgetInvariant(
  scriptSliceMs: Millis,
  heartbeatStallMs: Millis,
  heartbeatMs: Millis,
): void {
  if (!(heartbeatStallMs > scriptSliceMs + heartbeatMs * 2)) {
    throw new Error(
      `HB1 violated: heartbeatStallMs (${heartbeatStallMs}) must exceed scriptSliceMs (${scriptSliceMs}) + 2*heartbeatMs (${heartbeatMs}); ` +
        "otherwise the heartbeat watchdog could fire before the vm slice wall ever gets a chance to (workflow design §2.3 HB1).",
    );
  }
}

export interface RunawayWatchdogDeps {
  readonly clock: Clock;
  readonly workerHost: WorkerHost;
  readonly heartbeatMs: Millis;
  readonly heartbeatStallMs: Millis;
  readonly policy: RunawayPolicy;
  /** HB2: fired on every poll while diag-worthy (stalled or not) — purely observational, never itself a decision. */
  onTick?(hb: WorkflowHeartbeatDiag): void;
  /**
   * Edge-triggered, fires at most once per watchdog instance: the stall
   * threshold was crossed *and* `policy === "terminate_on_stall"`. The
   * caller (orchestrator.ts) is responsible for actually stopping the
   * workflow — this module never terminates anything itself.
   */
  onRunaway(hb: WorkflowHeartbeatDiag): void;
}

export interface RunawayWatchdogHandle {
  stop(): void;
}

export function startRunawayWatchdog(deps: RunawayWatchdogDeps): RunawayWatchdogHandle {
  if (deps.heartbeatMs <= 0) return { stop() {} };
  let fired = false;
  let timer: TimerHandle | undefined;
  const tick = (): void => {
    const hb = deps.workerHost.readHeartbeat();
    deps.onTick?.(hb);
    if (!fired && hb.stalledMs >= deps.heartbeatStallMs && deps.policy === "terminate_on_stall") {
      fired = true;
      deps.onRunaway(hb);
      return; // HB2: once escalated, stop polling — the caller is tearing the workflow down.
    }
    timer = deps.clock.setTimer(deps.heartbeatMs, tick);
  };
  timer = deps.clock.setTimer(deps.heartbeatMs, tick);
  return {
    stop() {
      if (timer) deps.clock.clearTimer(timer);
    },
  };
}
