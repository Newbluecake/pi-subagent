import type { Clock, TimerHandle } from "../core/clock.js";
import type { Millis, RunId } from "../core/types.js";

export interface SlotTicket {
  readonly runId: RunId;
  release(): void;
}

export interface SlotPool {
  acquire(
    runId: RunId,
    opts: { slotless?: boolean; queueWaitMs: Millis; signal?: AbortSignal },
  ): Promise<{ ok: true; ticket: SlotTicket } | { ok: false; reason: "queue_timeout" | "aborted" }>;
  setLimit(n: number): void;
  readonly stats: { limit: number; inUse: number; queued: number; slotless: number };
  audit(liveRunIds: ReadonlySet<RunId>): { leaked: RunId[]; fixed: number };
}

type Waiter = {
  runId: RunId;
  resolve: (result: Awaited<ReturnType<SlotPool["acquire"]>>) => void;
  timer?: TimerHandle;
  done: boolean;
};

export class SingleSlotPool implements SlotPool {
  private limit: number;
  private inUse = 0;
  private slotless = 0;
  private readonly held = new Set<RunId>();
  private readonly queue: Waiter[] = [];
  constructor(
    private readonly clock: Clock,
    limit = 1,
  ) {
    if (!Number.isInteger(limit) || limit < 0) throw new RangeError("limit must be a non-negative integer");
    this.limit = limit;
  }
  get stats() {
    return {
      limit: this.limit,
      inUse: this.inUse,
      queued: this.queue.filter((w) => !w.done).length,
      slotless: this.slotless,
    };
  }
  acquire(runId: RunId, opts: { slotless?: boolean; queueWaitMs: Millis; signal?: AbortSignal }) {
    if (opts.signal?.aborted) return Promise.resolve({ ok: false as const, reason: "aborted" as const });
    if (opts.slotless) {
      this.slotless++;
      return Promise.resolve({ ok: true as const, ticket: this.ticket(runId, true) });
    }
    if (this.limit === 0 || this.inUse < this.limit) {
      this.inUse++;
      this.held.add(runId);
      return Promise.resolve({ ok: true as const, ticket: this.ticket(runId, false) });
    }
    return new Promise<Awaited<ReturnType<SlotPool["acquire"]>>>((resolve) => {
      const waiter: Waiter = { runId, resolve, done: false };
      const finish = (result: Awaited<ReturnType<SlotPool["acquire"]>>) => {
        if (waiter.done) return;
        waiter.done = true;
        if (waiter.timer) this.clock.clearTimer(waiter.timer);
        resolve(result);
      };
      waiter.resolve = finish;
      if (opts.queueWaitMs > 0)
        waiter.timer = this.clock.setTimer(opts.queueWaitMs, () => {
          finish({ ok: false, reason: "queue_timeout" });
          this.drain();
        });
      if (opts.signal) {
        const onAbort = () => {
          finish({ ok: false, reason: "aborted" });
          this.drain();
        };
        opts.signal.addEventListener("abort", onAbort, { once: true });
        const old = waiter.resolve;
        waiter.resolve = (result) => {
          opts.signal?.removeEventListener("abort", onAbort);
          old(result);
        };
      }
      this.queue.push(waiter);
      this.drain();
    });
  }
  setLimit(n: number) {
    if (!Number.isInteger(n) || n < 0) throw new RangeError("limit must be a non-negative integer");
    this.limit = n;
    queueMicrotask(() => this.drain());
  }
  audit(liveRunIds: ReadonlySet<RunId>) {
    const leaked = [...this.held].filter((id) => !liveRunIds.has(id));
    for (const id of leaked) {
      this.held.delete(id);
      this.inUse = Math.max(0, this.inUse - 1);
    }
    if (leaked.length) queueMicrotask(() => this.drain());
    return { leaked, fixed: leaked.length };
  }
  private ticket(runId: RunId, isSlotless: boolean): SlotTicket {
    let released = false;
    return Object.freeze({
      runId,
      release: () => {
        if (released) return;
        released = true;
        if (isSlotless) this.slotless = Math.max(0, this.slotless - 1);
        else {
          this.held.delete(runId);
          this.inUse = Math.max(0, this.inUse - 1);
        }
        queueMicrotask(() => this.drain());
      },
    });
  }
  private drain() {
    try {
      while ((this.limit === 0 || this.inUse < this.limit) && this.queue.length) {
        const w = this.queue.shift();
        if (!w || w.done) continue;
        this.inUse++;
        this.held.add(w.runId);
        w.resolve({ ok: true, ticket: this.ticket(w.runId, false) });
      }
    } catch {
      queueMicrotask(() => this.drain());
    }
  }
}
