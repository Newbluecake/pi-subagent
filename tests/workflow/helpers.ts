import type { WorkerLike, SpawnWorkerOptions } from "../../src/workflow/lifecycle.js";

/**
 * Shared fakes for the M3.1 isolation-shell tests. `FakeWorkerLike` is a
 * minimal in-process stand-in for `node:worker_threads.Worker` that still
 * uses the *real* `MessageChannel` `lifecycle.ts` builds (see
 * `createWorkerHost`'s doc comment on why the port, not the worker, is what
 * carries the "unreachable after terminate" guarantee) — only the OS thread
 * itself is faked, so these tests are fast and deterministic (drivable with
 * `FakeClock`) while still exercising the real S1–S8 sequencing and the real
 * port-close semantics (WC09).
 */
export interface FakeWorkerLikeOptions {
  /** Default true: fires 'online' on the next microtask so boot() resolves. */
  autoOnline?: boolean;
  /** If set, `.terminate()` never resolves (models S7 hanging — W35/WC10-adjacent). */
  hangOnTerminate?: boolean;
  /** If set, `.terminate()` resolves after this many *real* ms (only meaningful with systemClock-driven tests). */
  terminateDelayMs?: number;
  threadId?: number;
}

export class FakeWorkerLike implements WorkerLike {
  readonly threadId: number;
  private readonly listeners = new Map<string, Array<(...args: unknown[]) => void>>();
  private terminated = false;
  capturedWorkerData: unknown;

  constructor(private readonly opts: FakeWorkerLikeOptions = {}) {
    this.threadId = opts.threadId ?? 1;
  }

  on(event: string, cb: (...args: unknown[]) => void): void {
    const list = this.listeners.get(event) ?? [];
    list.push(cb);
    this.listeners.set(event, list);
    if (event === "online" && (this.opts.autoOnline ?? true)) {
      queueMicrotask(() => cb());
    }
  }

  emit(event: string, ...args: unknown[]): void {
    for (const cb of this.listeners.get(event) ?? []) cb(...args);
  }

  removeAllListeners(event?: string): void {
    if (event) this.listeners.delete(event);
    else this.listeners.clear();
  }

  terminate(): Promise<number> {
    this.terminated = true;
    if (this.opts.hangOnTerminate) return new Promise<number>(() => {});
    if (this.opts.terminateDelayMs) {
      return new Promise((resolve) => setTimeout(() => resolve(0), this.opts.terminateDelayMs));
    }
    return Promise.resolve(0);
  }

  unref(): void {}

  get wasTerminated(): boolean {
    return this.terminated;
  }
}

/** Builds a `spawnWorker` for `createWorkerHost` that hands back a `FakeWorkerLike` and captures the real `MessagePort`/`SharedArrayBuffer` the host constructed, so tests can act as "the worker side" directly. */
export function fakeSpawnWorkerFactory(opts: FakeWorkerLikeOptions = {}): {
  spawnWorker: (o: SpawnWorkerOptions) => WorkerLike;
  worker(): FakeWorkerLike;
  workerData(): { commPort: MessagePort; heartbeatSab?: SharedArrayBuffer };
} {
  let worker: FakeWorkerLike | undefined;
  let capturedData: { commPort: MessagePort; heartbeatSab?: SharedArrayBuffer } | undefined;
  return {
    spawnWorker(o: SpawnWorkerOptions): WorkerLike {
      worker = new FakeWorkerLike(opts);
      capturedData = o.workerData as { commPort: MessagePort; heartbeatSab?: SharedArrayBuffer };
      return worker;
    },
    worker(): FakeWorkerLike {
      if (!worker) throw new Error("spawnWorker was never called");
      return worker;
    },
    workerData() {
      if (!capturedData) throw new Error("spawnWorker was never called");
      return capturedData;
    },
  };
}
