import { systemClock, type Clock, type TimerHandle } from "../core/clock.js";
import type { Millis, RunSnapshot, RunStatus } from "../core/types.js";

/**
 * M-E (real-time cost): 1 Hz broadcast of every tracked run's lifetime cost
 * over the shared extension event bus (channel "subagent:usage"), so an
 * external HUD (pi-hud) can show in-flight subagent spend *live* instead of
 * waiting for the tool-result usage to land at completion.
 *
 * Consumer contract (pi-hud):
 *  - `runs` lists ALL tracked runs (active and terminal) with their lifetime
 *    costUsd — terminal entries let a consumer that missed ticks reconcile;
 *  - dedupe against pi's session-accounted usage by runId: a toolResult
 *    message carrying usage also carries details.runId (Agent /
 *    get_subagent_result), so a consumer counts an event run only until its
 *    runId shows up on an usage-bearing toolResult.
 */
export interface SubagentUsageEvent {
  at: Millis;
  runs: Array<{ runId: string; label?: string; costUsd: number; terminal: boolean }>;
  /** Sum over non-terminal runs — the "currently burning" number. */
  activeCostUsd: number;
}

const TERMINAL: readonly RunStatus[] = ["completed", "failed", "timed_out", "aborted"];

/** Pure event builder (unit-tested without timers). */
export function buildUsageEvent(snapshots: readonly RunSnapshot[], at: Millis): SubagentUsageEvent {
  const runs = snapshots.map((s) => ({
    runId: s.runId,
    ...(s.diag.label === undefined ? {} : { label: s.diag.label }),
    costUsd: s.diag.usage?.costUsd ?? 0,
    terminal: TERMINAL.includes(s.status),
  }));
  return {
    at,
    runs,
    activeCostUsd: runs.reduce((sum, r) => sum + (r.terminal ? 0 : r.costUsd), 0),
  };
}

export interface UsageBroadcasterDeps {
  list(): RunSnapshot[];
  emit(event: SubagentUsageEvent): void;
  clock?: Clock;
  /** Tick cadence while any run is active. Default 1000ms (same as the fleet widget). */
  intervalMs?: Millis;
}

/**
 * Self-stopping ticker: `poke()` (called on run start / lifecycle events)
 * emits immediately and arms the 1s tick; the tick keeps re-arming only
 * while at least one non-terminal run exists, then emits a final frame and
 * stops. Emit failures are swallowed (an observer must never break a run).
 */
export class UsageBroadcaster {
  private readonly clock: Clock;
  private timer: TimerHandle | undefined;
  private disposed = false;

  constructor(private readonly deps: UsageBroadcasterDeps) {
    this.clock = deps.clock ?? systemClock;
  }

  poke(): void {
    if (this.disposed) return;
    const active = this.emitFrame();
    if (active && !this.timer) this.arm();
  }

  /** @returns whether any non-terminal run remains. */
  private emitFrame(): boolean {
    let event: SubagentUsageEvent;
    try {
      event = buildUsageEvent(this.deps.list(), this.clock.now());
      this.deps.emit(event);
    } catch {
      return false; // degenerate host — stop ticking silently
    }
    return event.runs.some((r) => !r.terminal);
  }

  private arm(): void {
    this.timer = this.clock.setTimer(this.deps.intervalMs ?? 1000, () => {
      this.timer = undefined;
      if (this.disposed) return;
      if (this.emitFrame()) this.arm();
    });
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    if (this.timer) this.clock.clearTimer(this.timer);
    this.timer = undefined;
  }
}
