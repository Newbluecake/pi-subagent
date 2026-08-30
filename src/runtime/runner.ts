import { remainingFor } from "../core/deadline.js";
import type { Clock } from "../core/clock.js";
import { createInitialState, reduce } from "../core/state-machine.js";
import type {
  DeadlineBudget,
  DeliveryPayload,
  EffectEnvelope,
  ErrorInfo,
  LifecycleEvent,
  RunInput,
  RunOutcome,
  RunSnapshot,
  RunState,
  StampedInput,
} from "../core/types.js";
import type { SnapshotStore } from "../core/store.js";
import type { SessionDriver, SessionHandle, SessionSpec } from "./session-driver.js";
import type { SlotPool, SlotTicket } from "./slot-pool.js";
import type { Watchdog } from "./watchdog.js";
import type { Reaper, ReapInput } from "./reaper.js";

export interface ResolvedSpawnRequest extends SessionSpec {
  runId: string;
  prompt: string;
  signal?: AbortSignal;
  slotless?: boolean;
}
export interface CancelHandle {
  readonly runId: string;
  readonly generation: number;
  readonly signal: AbortSignal;
  cancel(reason: string): void;
  readonly whenCancelled: Promise<never>;
  detach(): void;
}
export function createCancelHandle(
  runId: string,
  generation: number,
  external: AbortSignal | undefined,
  onCancel: (reason: string) => void,
): CancelHandle {
  const controller = new AbortController();
  let reject!: (reason?: unknown) => void;
  const whenCancelled = new Promise<never>((_, r) => {
    reject = r;
  });
  whenCancelled.catch(() => undefined);
  let detached = false;
  const cancel = (reason: string) => {
    if (controller.signal.aborted) return;
    try {
      controller.abort(reason);
    } catch {
      /* listener failures do not block cancellation */
    }
    reject(new Error(reason));
    onCancel(reason);
  };
  const onExternal = () => cancel("external");
  if (external?.aborted) cancel("external");
  else if (external) external.addEventListener("abort", onExternal, { once: true });
  return {
    runId,
    generation,
    signal: controller.signal,
    cancel,
    whenCancelled,
    detach: () => {
      if (!detached) {
        detached = true;
        external?.removeEventListener("abort", onExternal);
      }
    },
  };
}
export interface CriticalResult {
  slotReleased: boolean;
  waitersSettled: boolean;
  snapshotPersisted: boolean;
}
export interface EffectInterpreter {
  apply(runId: string, generation: number, batch: readonly EffectEnvelope[]): void;
  applyCriticalSync(runId: string, generation: number, batch: readonly EffectEnvelope[]): CriticalResult;
  readonly audit: readonly EffectAuditRecord[];
}
export interface EffectAuditRecord {
  effectId: string;
  kind: string;
  ok: boolean;
  ms: number;
  error?: string;
}
export class BasicEffectInterpreter implements EffectInterpreter {
  private seen = new Set<string>();
  private records: EffectAuditRecord[] = [];
  constructor(
    private readonly handlers: Partial<Record<RunInput["kind"] | string, (e: EffectEnvelope["effect"]) => void>> = {},
  ) {}
  get audit() {
    return this.records;
  }
  apply(_runId: string, _generation: number, batch: readonly EffectEnvelope[]) {
    for (const e of batch) this.one(e);
  }
  applyCriticalSync(runId: string, generation: number, batch: readonly EffectEnvelope[]) {
    this.apply(
      runId,
      generation,
      batch.filter((e) => e.criticality === "critical"),
    );
    return {
      slotReleased: batch.some((e) => e.effect.kind === "release_slot"),
      waitersSettled: batch.some((e) => e.effect.kind === "settle_waiters"),
      snapshotPersisted: batch.some((e) => e.effect.kind === "persist_snapshot"),
    };
  }
  private one(e: EffectEnvelope) {
    if (this.seen.has(e.effectId)) return;
    this.seen.add(e.effectId);
    const at = Date.now();
    try {
      this.handlers[e.effect.kind]?.(e.effect);
      this.records.push({ effectId: e.effectId, kind: e.effect.kind, ok: true, ms: Date.now() - at });
    } catch (err) {
      this.records.push({
        effectId: e.effectId,
        kind: e.effect.kind,
        ok: false,
        ms: Date.now() - at,
        error: err instanceof Error ? err.message : String(err),
      });
    }
    if (this.seen.size > 1024) this.seen.delete(this.seen.values().next().value as string);
  }
}
export interface RunnerDeps {
  clock: Clock;
  driver: SessionDriver;
  pool: SlotPool;
  store: SnapshotStore;
  watchdog: Watchdog;
  reaper: Reaper;
  effects: EffectInterpreter;
  emit: (e: LifecycleEvent) => void;
  deliver: (p: DeliveryPayload) => void;
}
export interface Runner {
  run(req: ResolvedSpawnRequest, budget: DeadlineBudget): Promise<RunOutcome>;
}
const error = (e: unknown, kind: ErrorInfo["kind"] = "internal"): ErrorInfo => ({
  kind,
  message: e instanceof Error ? e.message : String(e),
  retryable: false,
});
export class RuntimeRunner implements Runner {
  private readonly states = new Map<string, RunState>();
  private generation = new Map<string, number>();
  constructor(private readonly d: RunnerDeps) {}
  async run(req: ResolvedSpawnRequest, budget: DeadlineBudget): Promise<RunOutcome> {
    const gen = (this.generation.get(req.runId) ?? 0) + 1;
    this.generation.set(req.runId, gen);
    let state = createInitialState(req.runId, gen, this.d.clock.now());
    this.states.set(req.runId, state);
    const cancel = createCancelHandle(req.runId, gen, req.signal, (reason) =>
      this.dispatch(req.runId, gen, {
        kind: "stop_requested",
        at: this.d.clock.now(),
        cause: reason === "external" ? "parent_abort" : "user_stop",
      }),
    );
    let ticket: SlotTicket | undefined;
    let handle: SessionHandle | undefined;
    let createP: Promise<SessionHandle> | undefined;
    const dispatch = (input: RunInput) => {
      const out = reduce(state, { generation: gen, input }, budget);
      state = out.state;
      this.states.set(req.runId, state);
      this.d.effects.apply(req.runId, gen, out.effects);
    };
    this.dispatch = (id, g, input) => {
      if (id === req.runId && g === gen) dispatch(input);
    };
    try {
      dispatch({ kind: "enqueued", at: this.d.clock.now(), budget });
      const acq = await this.guard(
        this.d.pool.acquire(req.runId, {
          ...(req.slotless === undefined ? {} : { slotless: req.slotless }),
          queueWaitMs: budget.queueWaitMs,
          signal: cancel.signal,
        }),
        budget.queueWaitMs,
        cancel,
        "queue",
      );
      if (acq.ok !== true) {
        dispatch({
          kind: "slot_denied",
          at: this.d.clock.now(),
          reason: acq.reason === "cancelled" ? "aborted" : "queue_timeout",
        });
        return state.outcome!;
      }
      if (!("ticket" in acq.value)) throw new Error("slot acquisition returned no ticket");
      ticket = acq.value.ticket;
      dispatch({ kind: "slot_acquired", at: this.d.clock.now() });
      dispatch({ kind: "phase_entered", at: this.d.clock.now(), phase: "session_create" });
      createP = this.d.driver.create(req);
      const created = await this.guard(createP, budget.startupMs, cancel, "create");
      if (!created.ok) {
        this.d.driver.onLateArrival(createP, (h) => this.d.reaper.disposeLate(req.runId, gen, h));
        createP = undefined;
        dispatch({
          kind: "startup_failed",
          at: this.d.clock.now(),
          phase: "session_create",
          error: error(created.reason, "timeout"),
        });
        return state.outcome!;
      }
      handle = created.value;
      createP = undefined;
      dispatch({ kind: "session_created", at: this.d.clock.now(), sessionId: handle.sessionId });
      dispatch({ kind: "phase_entered", at: this.d.clock.now(), phase: "extension_bind" });
      const bound = await this.guard(
        this.d.driver.bind(handle, (e) => dispatch({ kind: "session_event", at: this.d.clock.now(), event: e })),
        budget.bindMs,
        cancel,
        "bind",
      );
      if (!bound.ok) {
        dispatch({
          kind: "startup_failed",
          at: this.d.clock.now(),
          phase: "extension_bind",
          error: error(bound.reason, "timeout"),
        });
        return state.outcome!;
      }
      this.d.watchdog.arm(req.runId, gen);
      const prompted = await this.guard(handle.prompt(req.prompt), budget.totalMs, cancel, "prompt");
      dispatch({
        kind: "prompt_settled",
        at: this.d.clock.now(),
        ...(prompted.ok
          ? {}
          : { error: error(prompted.reason, prompted.reason === "cancelled" ? "aborted" : "timeout") }),
      });
      return state.outcome!;
    } catch (e) {
      dispatch({ kind: "prompt_settled", at: this.d.clock.now(), error: error(e) });
      return state.outcome!;
    } finally {
      cancel.detach();
      this.d.watchdog.disarm(req.runId, gen);
      ticket?.release();
      if (createP) this.d.driver.onLateArrival(createP, (h) => this.d.reaper.disposeLate(req.runId, gen, h));
      const reap: ReapInput = {
        runId: req.runId,
        generation: gen,
        cancel,
        ...(handle ? { handle, sessionId: handle.sessionId } : {}),
        ...(state.diag.stopCause ? { cause: state.diag.stopCause } : {}),
        phase: state.phase,
        budget,
      };
      void this.d.reaper.reap(reap).catch(() => undefined);
    }
  }
  private dispatch = (_id: string, _generation: number, _input: RunInput) => undefined;
  private async guard<T>(
    p: Promise<T>,
    ms: number,
    cancel: CancelHandle,
    label: string,
  ): Promise<{ ok: true; value: T } | { ok: false; reason: "timeout" | "cancelled" }> {
    let timer: ReturnType<Clock["setTimer"]> | undefined;
    return new Promise((resolve) => {
      let done = false;
      const finish = (r: { ok: true; value: T } | { ok: false; reason: "timeout" | "cancelled" }) => {
        if (done) return;
        done = true;
        if (timer) this.d.clock.clearTimer(timer);
        cancel.signal.removeEventListener("abort", onAbort);
        resolve(r);
      };
      const onAbort = () => finish({ ok: false, reason: "cancelled" });
      if (cancel.signal.aborted) return onAbort();
      timer = this.d.clock.setTimer(Math.max(0, ms), () => finish({ ok: false, reason: "timeout" }));
      cancel.signal.addEventListener("abort", onAbort, { once: true });
      p.then(
        (value) => finish({ ok: true, value }),
        () => finish({ ok: false, reason: "cancelled" }),
      ).catch(() => undefined);
    });
  }
}
