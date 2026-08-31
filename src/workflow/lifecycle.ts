import { Worker as NodeWorker } from "node:worker_threads";
import type { MessagePort, Transferable } from "node:worker_threads";
import type { Clock } from "../core/clock.js";
import { withDeadline } from "../core/deadline.js";
import type { Millis } from "../core/types.js";
import { buildWorkerSource } from "./worker-source.js";
import type {
  HostCallEnvelope,
  SerializedError,
  WorkerBootOutcome,
  WorkerHost,
  WorkerHostEvents,
  WorkerHostInit,
  WorkerHostStats,
  WorkerLifecycle,
  WorkerTerminateOutcome,
  WorkflowHeartbeatDiag,
} from "./types.js";

/**
 * M3.1 (workflow design §2.3.1/§3.5): the `WorkerHost` implementation — one
 * instance owns exactly one worker thread for exactly one workflow run (no
 * reboot, no reuse — WK4). The terminate() sequence below is S1–S8 verbatim.
 *
 * `MessagePort` design note (WC09, the M3.1 architectural gate): communication
 * uses a *dedicated* `MessageChannel` created and owned by this host, not the
 * Worker's implicit default channel. The reason is that `worker_threads.Worker`
 * exposes no public way to close its default channel from the host side —
 * only `worker.terminate()` (S7, best-effort/bounded, not a hard guarantee)
 * can stop it. A private `MessageChannel` gives the host a `.close()` it
 * fully controls (S5), so "no more worker messages are observable" (WK1) does
 * not depend on the native `terminate()` ever confirming.
 */

/** Minimal surface this module needs from a worker-thread handle; the real implementation is `node:worker_threads.Worker`. Kept as an explicit interface (not `NodeWorker` directly) so tests can substitute an in-process double without spinning a real OS thread — see lifecycle.test.ts for WC09/WC10/W35/W36. */
export interface WorkerLike {
  readonly threadId: number;
  on(event: "online", cb: () => void): void;
  on(event: "error", cb: (err: Error) => void): void;
  on(event: "exit", cb: (code: number) => void): void;
  removeAllListeners(event?: string): void;
  terminate(): Promise<number>;
  unref(): void;
}

export interface SpawnWorkerOptions {
  readonly workerData: unknown;
  readonly transferList: readonly Transferable[];
  readonly resourceLimits?: { readonly maxOldGenerationSizeMb?: number; readonly maxYoungGenerationSizeMb?: number };
}

export interface WorkerHostDeps {
  readonly clock: Clock;
  /** Defaults to a real `node:worker_threads.Worker` running the embedded scaffold; overridable for tests (never for production — this is plain constructor DI, not a fault-injection backdoor). */
  spawnWorker?(opts: SpawnWorkerOptions): WorkerLike;
  /** S8: how often (real ms, via `clock`) to retry reclaiming an orphaned worker in the background. Default 30s, capped at 10 attempts, matching §2.3.1. */
  orphanProbeMs?: Millis;
  orphanProbeMaxAttempts?: number;
}

function defaultSpawnWorker(opts: SpawnWorkerOptions): WorkerLike {
  const worker = new NodeWorker(buildWorkerSource(), {
    eval: true,
    workerData: opts.workerData,
    transferList: opts.transferList as unknown as Transferable[],
    resourceLimits: opts.resourceLimits,
  });
  return worker as unknown as WorkerLike;
}

function serializeError(err: unknown): SerializedError {
  if (err instanceof Error)
    return err.stack === undefined ? { message: err.message } : { message: err.message, stack: err.stack };
  return { message: String(err) };
}

export function createWorkerHost(deps: WorkerHostDeps): WorkerHost {
  const spawnWorker = deps.spawnWorker ?? defaultSpawnWorker;
  const orphanProbeMs = deps.orphanProbeMs ?? 30_000;
  const orphanProbeMaxAttempts = deps.orphanProbeMaxAttempts ?? 10;

  let lifecycle: WorkerLifecycle = "spawning";
  let epoch = 0;
  let booted = false;
  let worker: WorkerLike | undefined;
  let hostPort: MessagePort | undefined;
  let heartbeatView: Int32Array | undefined;
  let lastHeartbeatSeq = 0;
  let lastHeartbeatChangeAt = 0;
  let terminateConfirmMs: Millis = TERMINATE_CONFIRM_FALLBACK_MS;

  let cachedTerminate: WorkerTerminateOutcome | undefined;
  let terminateInFlight: Promise<WorkerTerminateOutcome> | undefined;

  const stats: WorkerHostStats = { lateMessages: 0, terminateForced: 0 };

  const onMetaError: Array<(message: string) => void> = [];
  const onLog: Array<(line: string) => void> = [];
  const onScriptReturned: Array<(result: unknown) => void> = [];
  const onScriptThrew: Array<(error: SerializedError) => void> = [];
  const onExit: Array<(code: number, expected: boolean) => void> = [];
  const onError: Array<(error: SerializedError) => void> = [];
  const onHostCall: Array<(envelope: HostCallEnvelope) => void> = [];
  const onTerminating: Array<(reason: string) => void> = [];

  const events: WorkerHostEvents = {
    onMetaError: (cb) => onMetaError.push(cb),
    onLog: (cb) => onLog.push(cb),
    onScriptReturned: (cb) => onScriptReturned.push(cb),
    onScriptThrew: (cb) => onScriptThrew.push(cb),
    onExit: (cb) => onExit.push(cb),
    onError: (cb) => onError.push(cb),
    onHostCall: (cb) => onHostCall.push(cb),
    onTerminating: (cb) => onTerminating.push(cb),
  };

  function isDetachedOrLater(): boolean {
    return lifecycle === "detached" || lifecycle === "terminated" || lifecycle === "orphaned";
  }

  function handlePortMessage(msg: unknown): void {
    // WK2: belt-and-suspenders logical guard on top of the physical port
    // close (S5) — a message that somehow arrives after detach produces zero
    // observable effects and is only counted, never dispatched.
    if (isDetachedOrLater()) {
      stats.lateMessages += 1;
      return;
    }
    if (!msg || typeof msg !== "object") return;
    const m = msg as { kind?: unknown };
    switch (m.kind) {
      case "meta_error": {
        const message = (msg as { message?: unknown }).message;
        for (const cb of onMetaError) cb(typeof message === "string" ? message : "invalid meta_error payload");
        return;
      }
      case "log": {
        const line = (msg as { line?: unknown }).line;
        for (const cb of onLog) cb(typeof line === "string" ? line : "");
        return;
      }
      case "script_returned": {
        const result = (msg as { result?: unknown }).result;
        for (const cb of onScriptReturned) cb(result);
        return;
      }
      case "script_threw": {
        const raw = msg as { message?: unknown; stack?: unknown };
        const error: SerializedError = {
          message: typeof raw.message === "string" ? raw.message : "unknown script error",
          ...(typeof raw.stack === "string" ? { stack: raw.stack } : {}),
        };
        for (const cb of onScriptThrew) cb(error);
        return;
      }
      case "host_call": {
        const raw = msg as { id?: unknown; op?: unknown; args?: unknown };
        if (typeof raw.id !== "string" || typeof raw.op !== "string") return; // HR7: malformed envelope, drop silently.
        for (const cb of onHostCall) cb({ id: raw.id, op: raw.op as HostCallEnvelope["op"], args: raw.args });
        return;
      }
      default:
        return; // HR7-equivalent: unrecognized payload shapes are ignored, not thrown on.
    }
  }

  async function boot(init: WorkerHostInit): Promise<WorkerBootOutcome> {
    if (booted) return { ok: false, reason: "boot_error", detail: "boot() called more than once" };
    booted = true;
    const channel = new MessageChannel();
    hostPort = channel.port1;
    hostPort.on("message", handlePortMessage);
    hostPort.on("messageerror", () => {
      /* structured-clone failure on an inbound message — never fatal to the host. */
    });

    const heartbeatSab = init.heartbeatMs > 0 ? new SharedArrayBuffer(4) : undefined;
    if (heartbeatSab) {
      heartbeatView = new Int32Array(heartbeatSab);
      lastHeartbeatChangeAt = deps.clock.now();
    }

    terminateConfirmMs = init.terminateConfirmMs;
    const workerData = {
      commPort: channel.port2,
      heartbeatSab,
      heartbeatMs: init.heartbeatMs,
      scriptSliceMs: init.scriptSliceMs,
      scriptSource: init.scriptSource,
      hostCallMs: init.hostCallMs ?? 60_000,
      gateMs: init.gateMs ?? 600_000,
      maxBatchItems: init.maxBatchItems ?? 1024,
    };

    try {
      worker = spawnWorker({
        workerData,
        transferList: [channel.port2],
        resourceLimits: {
          ...(init.maxOldGenerationSizeMb !== undefined ? { maxOldGenerationSizeMb: init.maxOldGenerationSizeMb } : {}),
          ...(init.maxYoungGenerationSizeMb !== undefined
            ? { maxYoungGenerationSizeMb: init.maxYoungGenerationSizeMb }
            : {}),
        },
      });
    } catch (err) {
      hostPort.close();
      lifecycle = "detached";
      return { ok: false, reason: "boot_error", detail: serializeError(err).message };
    }

    worker.on("exit", (code) => {
      const expected = isDetachedOrLater();
      for (const cb of onExit) cb(code, expected);
    });
    worker.on("error", (err) => {
      const info = serializeError(err);
      if (isDetachedOrLater()) {
        stats.lateMessages += 1;
        return;
      }
      for (const cb of onError) cb(info);
    });

    const ready = new Promise<void>((resolve) => worker?.on("online", () => resolve()));
    const outcome = await withDeadline(ready, init.workerBootMs, deps.clock, "worker_boot");
    if (!outcome.ok) {
      return { ok: false, reason: "boot_timeout", detail: `worker did not come online within ${init.workerBootMs}ms` };
    }
    lifecycle = "ready";
    return { ok: true, threadId: worker.threadId, epoch };
  }

  function readHeartbeat(): WorkflowHeartbeatDiag {
    const now = deps.clock.now();
    if (!heartbeatView) return { seq: 0, observedAt: now, stalledMs: 0 };
    const seq = Atomics.load(heartbeatView, 0);
    if (seq !== lastHeartbeatSeq) {
      lastHeartbeatSeq = seq;
      lastHeartbeatChangeAt = now;
    }
    return { seq, observedAt: now, stalledMs: Math.max(0, now - lastHeartbeatChangeAt) };
  }

  function postCancel(reason: string): void {
    try {
      hostPort?.postMessage({ kind: "cancel", reason });
    } catch {
      // S3: best-effort; the worker may already be gone.
    }
  }

  function send(msg: unknown): void {
    try {
      hostPort?.postMessage(msg);
    } catch {
      // Same best-effort contract as postCancel: the worker/port may already be gone.
    }
  }

  function scheduleOrphanProbe(w: WorkerLike, attempt: number): void {
    if (attempt >= orphanProbeMaxAttempts) return;
    deps.clock.setTimer(orphanProbeMs, () => {
      w.terminate().then(
        () => {
          if (lifecycle === "orphaned") lifecycle = "terminated";
        },
        () => {
          scheduleOrphanProbe(w, attempt + 1);
        },
      );
    });
  }

  async function terminate(reason: string): Promise<WorkerTerminateOutcome> {
    if (cachedTerminate) return cachedTerminate; // S1: idempotent no-op once settled.
    if (terminateInFlight) return terminateInFlight; // concurrent callers share the one in-flight sequence.
    terminateInFlight = (async () => {
      // S2: closing + epoch bump (post-S2, any message the physical close in
      // S5 somehow fails to block is also logically stale — see handlePortMessage).
      lifecycle = "closing";
      epoch += 1;

      // HR8: give host.ts (the owner of the host-call pending table) a chance
      // to reject every still-pending ack/settle *before* S5 physically closes
      // the port — synchronous, so there is no race with S5/S6 below.
      for (const cb of onTerminating) cb(reason);

      // S3: best-effort notice, not awaited.
      postCancel(reason);

      // S4 (M3.2): host-side pending-call rejection now happens above, via
      // `onTerminating` — host.ts is the actual owner of that table (HR8).

      // S5: physically cut off further inbound messages, independent of S7.
      try {
        hostPort?.close();
      } catch {
        /* already closed */
      }
      try {
        worker?.removeAllListeners();
      } catch {
        /* ignore */
      }
      try {
        worker?.unref();
      } catch {
        /* ignore */
      }

      // S6: detached — WK1's guarantee point. GW1a/GW1b do not need S7 to succeed from here on.
      lifecycle = "detached";

      const startedAt = deps.clock.now();
      const w = worker;
      const nativeTerminate = w
        ? w.terminate().then(
            () => undefined,
            () => undefined,
          )
        : Promise.resolve(undefined);
      // S7: bounded confirmation attempt.
      const confirmed = await withDeadline(nativeTerminate, terminateConfirmMs, deps.clock, "terminate_confirm");
      const ms = deps.clock.now() - startedAt;
      let result: WorkerTerminateOutcome;
      if (confirmed.ok) {
        lifecycle = "terminated";
        result = { detached: true, terminated: true, orphaned: false, ms };
      } else {
        lifecycle = "orphaned";
        stats.terminateForced += 1;
        result = { detached: true, terminated: false, orphaned: true, ms };
        if (w) scheduleOrphanProbe(w, 0);
      }
      cachedTerminate = result;
      return result;
    })();
    return terminateInFlight;
  }

  return {
    boot,
    get lifecycle() {
      return lifecycle;
    },
    get epoch() {
      return epoch;
    },
    readHeartbeat,
    postCancel,
    send,
    terminate,
    events,
    stats,
  };
}

/**
 * Fallback used only if `terminate()` is somehow invoked before `boot()`
 * completed (so `init.terminateConfirmMs` was never captured) — a defensive
 * default, not a production code path (`boot()` always runs first).
 */
const TERMINATE_CONFIRM_FALLBACK_MS: Millis = 2_000;
