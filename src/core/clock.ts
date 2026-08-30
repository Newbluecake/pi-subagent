import type { Millis } from "./types.js";
export type TimerHandle = { readonly id: number };
export interface Clock {
  now(): Millis;
  setTimer(delayMs: Millis, fn: () => void): TimerHandle;
  clearTimer(h: TimerHandle): void;
}

/** The real wall-clock Clock implementation, backed by setTimeout (index.ts wiring; FakeClock is test-only). */
export const systemClock: Clock = {
  now: () => Date.now(),
  setTimer: (delayMs, fn) => ({ id: setTimeout(fn, Math.max(0, delayMs)) as unknown as number }),
  clearTimer: (h) => clearTimeout(h.id as unknown as ReturnType<typeof setTimeout>),
};

type Entry = { due: Millis; fn: () => void; cancelled: boolean };
export class FakeClock implements Clock {
  private time: Millis;
  private nextId = 1;
  private entries = new Map<number, Entry>();
  constructor(startAt = 0) {
    this.time = startAt;
  }
  now(): Millis {
    return this.time;
  }
  setTimer(delayMs: Millis, fn: () => void): TimerHandle {
    const id = this.nextId++;
    this.entries.set(id, { due: this.time + Math.max(0, delayMs), fn, cancelled: false });
    return { id };
  }
  clearTimer(h: TimerHandle): void {
    const e = this.entries.get(h.id);
    if (e) e.cancelled = true;
    this.entries.delete(h.id);
  }
  advance(ms: Millis): void {
    if (ms < 0) throw new RangeError("cannot move fake clock backwards");
    const target = this.time + ms;
    while (true) {
      const due = [...this.entries]
        .filter(([, e]) => !e.cancelled && e.due <= target)
        .sort((a, b) => a[1].due - b[1].due || a[0] - b[0])[0];
      if (!due) break;
      this.time = due[1].due;
      this.entries.delete(due[0]);
      due[1].fn();
    }
    this.time = target;
  }
  get pendingTimers(): number {
    return this.entries.size;
  }
}
