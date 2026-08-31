import type { Clock, TimerHandle } from "../core/clock.js";
import { systemClock } from "../core/clock.js";
import type { SpawnService } from "../service/spawn-service.js";
import { nextCronOccurrence, parseCron } from "./cron.js";
import { createScheduleStore, type ScheduleDefinition, type ScheduleStore, type ScheduleTask } from "./store.js";

export interface SchedulerDeps {
  spawn: Pick<SpawnService, "spawn">;
  store?: ScheduleStore;
  clock?: Clock;
  warn?: (message: string) => void;
}

export interface Scheduler {
  start(): Promise<void>;
  stop(): void;
  register(task: ScheduleTask): Promise<void>;
  unregister(id: string): Promise<boolean>;
  list(): readonly ScheduleTask[];
}

function validateDefinition(definition: ScheduleDefinition): void {
  if (definition.kind === "cron") parseCron(definition.expression);
  else if (definition.kind === "interval") {
    if (!Number.isFinite(definition.intervalMs) || definition.intervalMs <= 0)
      throw new Error("intervalMs must be positive");
  } else if (Number.isNaN(Date.parse(definition.at))) throw new Error(`invalid one-shot date: ${definition.at}`);
}

export function createScheduler(deps: SchedulerDeps): Scheduler {
  const clock = deps.clock ?? systemClock;
  const store = deps.store ?? createScheduleStore();
  const warn = deps.warn ?? ((message: string) => console.warn(`[pi-subagent] ${message}`));
  const tasks = new Map<string, ScheduleTask>();
  const timers = new Map<string, TimerHandle>();
  let stopped = true;
  let started = false;
  let persist = Promise.resolve();

  const save = () => {
    persist = persist
      .then(() => store.save([...tasks.values()]))
      .catch((error) => {
        warn(`schedule store save failed: ${String(error)}`);
      });
    return persist;
  };
  const nextAt = (task: ScheduleTask, after: number): number | undefined => {
    if (task.schedule.kind === "cron") return nextCronOccurrence(task.schedule.expression, after);
    if (task.schedule.kind === "interval") return after + task.schedule.intervalMs;
    const at = Date.parse(task.schedule.at);
    return at > after ? at : undefined;
  };
  const arm = (task: ScheduleTask) => {
    if (stopped) return;
    const due = task.nextAt;
    if (due === undefined) return;
    const delay = Math.max(0, due - clock.now());
    const handle = clock.setTimer(delay, () => void fire(task.id));
    timers.set(task.id, handle);
  };
  const fire = async (id: string) => {
    timers.delete(id);
    if (stopped) return;
    const task = tasks.get(id);
    if (!task || task.nextAt === undefined) return;
    const due = task.nextAt;
    const now = clock.now();
    task.nextAt = nextAt(task, Math.max(now, due));
    if (task.schedule.kind === "once") tasks.delete(id);
    await save();
    try {
      // Deliberately use the public spawn entry point: it owns the normal slot queue.
      await deps.spawn.spawn({ ...task.request });
    } catch (error) {
      warn(`scheduled task ${id} failed to spawn: ${String(error)}`);
    }
    const current = tasks.get(id);
    if (current) arm(current);
  };
  const prepare = (task: ScheduleTask) => {
    validateDefinition(task.schedule);
    const now = clock.now();
    if (task.nextAt === undefined) task.nextAt = nextAt(task, now);
    if (task.nextAt !== undefined && task.nextAt <= now) {
      warn(`scheduled task ${task.id} missed its window; skipping without catch-up`);
      task.nextAt = nextAt(task, now);
    }
  };

  return {
    async start() {
      if (started) return;
      started = true;
      stopped = false;
      try {
        for (const task of await store.load()) {
          try {
            prepare(task);
            if (!tasks.has(task.id)) tasks.set(task.id, task);
          } catch (error) {
            warn(`invalid schedule ${task.id}: ${String(error)}`);
          }
        }
        await save();
        for (const task of tasks.values()) arm(task);
      } catch (error) {
        warn(`scheduler startup failed: ${String(error)}`);
      }
    },
    stop() {
      stopped = true;
      for (const timer of timers.values()) clock.clearTimer(timer);
      timers.clear();
    },
    async register(task) {
      validateDefinition(task.schedule);
      prepare(task);
      tasks.set(task.id, task);
      await save();
      if (!stopped) arm(task);
    },
    async unregister(id) {
      const existed = tasks.delete(id);
      const timer = timers.get(id);
      if (timer) clock.clearTimer(timer);
      timers.delete(id);
      if (existed) await save();
      return existed;
    },
    list() {
      return [...tasks.values()].map((task) => ({ ...task, request: { ...task.request } }));
    },
  };
}
