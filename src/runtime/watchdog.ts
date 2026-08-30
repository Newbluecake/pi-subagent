import { dueAtFor } from "../core/deadline.js";
import type { Clock, TimerHandle } from "../core/clock.js";
import type { DeadlineBudget, Generation, RunId, RunInput, RunPhase, RunState, TimerId } from "../core/types.js";

export interface Watchdog {
  arm(runId: RunId, generation?: Generation): void;
  disarm(runId: RunId, generation?: Generation): void;
  tick(now: number): void;
}
export interface WatchdogDeps {
  clock: Clock;
  budget: DeadlineBudget;
  getState: (runId: RunId, generation: Generation) => RunState | undefined;
  dispatch: (runId: RunId, generation: Generation, input: RunInput) => void;
  tickMs?: number;
}
const timerReason: Partial<Record<TimerId, Extract<RunInput, { kind: "deadline_fired" }>["reason"]>> = {
  queue: "queue_timeout",
  startup: "session_create",
  bind: "extension_bind",
  first_event: "no_first_event",
  idle: "idle",
  tool: "idle",
  compaction: "compaction",
  total: "total",
  abort_grace: "total",
  reap: "total",
};
export class EventWatchdog implements Watchdog {
  private readonly armed = new Map<RunId, Generation>();
  private timer: TimerHandle | undefined;
  private readonly tickMs: number;
  constructor(private readonly deps: WatchdogDeps) {
    this.tickMs = deps.tickMs ?? 1000;
  }
  arm(id: RunId, generation = 1) {
    this.armed.set(id, generation);
    this.ensureTimer();
  }
  disarm(id: RunId, generation?: Generation) {
    if (generation === undefined || this.armed.get(id) === generation) this.armed.delete(id);
    if (!this.armed.size && this.timer) {
      this.deps.clock.clearTimer(this.timer);
      this.timer = undefined;
    }
  }
  tick(now: number) {
    for (const [id, gen] of this.armed) {
      const state = this.deps.getState(id, gen);
      if (!state) continue;
      for (const timer of state.armedTimers) {
        const due =
          timer === "total" ? state.deadlines.deadlineAt : dueAtFor(state.phase, state.diag, this.deps.budget);
        if (due !== undefined && now >= due) {
          this.deps.dispatch(id, gen, {
            kind: "deadline_fired",
            at: now,
            timer,
            reason: timerReason[timer] ?? "total",
          });
          break;
        }
      }
    }
    if (this.armed.size) this.ensureTimer();
  }
  private ensureTimer() {
    if (!this.timer)
      this.timer = this.deps.clock.setTimer(this.tickMs, () => {
        this.timer = undefined;
        this.tick(this.deps.clock.now());
      });
  }
}
