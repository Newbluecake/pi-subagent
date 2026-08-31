import { remainingFor } from "../core/deadline.js";
import type { Clock } from "../core/clock.js";
import { createInitialState, reduce } from "../core/state-machine.js";
import type {
  DeadlineBudget,
  DeliveryPayload,
  EffectEnvelope,
  ErrorInfo,
  LifecycleEvent,
  Millis,
  RunEffect,
  RunInput,
  RunOutcome,
  RunSnapshot,
  RunState,
  StampedInput,
  StopCause,
} from "../core/types.js";
import type { SnapshotStore } from "../core/store.js";
import type { SessionDriver, SessionHandle, SessionSpec } from "./session-driver.js";
import type { SlotPool, SlotTicket } from "./slot-pool.js";
import type { ToolScopeEnforcer, ToolScopePolicy } from "./tool-scope.js";
import type { Watchdog } from "./watchdog.js";
import type { Reaper, ReapInput } from "./reaper.js";

export interface ResolvedSpawnRequest extends SessionSpec {
  runId: string;
  prompt: string;
  signal?: AbortSignal;
  slotless?: boolean;
  /** X3: propagated through so RunState/RunSnapshot.parentRunId (core §5.1) is actually populated for nested runs — previously always undefined because nothing threaded it past RunnerSpec.request. */
  parentRunId?: string;
  /**
   * CC4: absolute deadline cap threaded from SpawnRequest.deadlineAt. Must be
   * explicitly propagated by the adapter (service/runtime-adapter.ts) into the
   * object literal it builds here — same failure mode as parentRunId above:
   * silently dropped if a hop forgets to spread it. See service/request-threading.ts
   * for the compile-time guard against exactly that.
   */
  deadlineAt?: Millis;
  /** X11: per-run tool-scope policy + a fresh (per-run) enforcer instance; undefined = no dynamic re-enforcement (legacy behavior). */
  toolScope?: { policy: ToolScopePolicy; enforcer: ToolScopeEnforcer };
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
export type EffectFailureHandler = (runId: string, generation: number, kind: RunEffect["kind"], error: Error) => void;
export class BasicEffectInterpreter implements EffectInterpreter {
  private seen = new Set<string>();
  private records: EffectAuditRecord[] = [];
  constructor(
    private readonly handlers: Partial<Record<RunInput["kind"] | string, (e: EffectEnvelope["effect"]) => void>> = {},
    private readonly onFailure?: EffectFailureHandler,
  ) {}
  get audit() {
    return this.records;
  }
  apply(runId: string, generation: number, batch: readonly EffectEnvelope[]) {
    for (const e of batch) this.one(runId, generation, e);
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
  private one(runId: string, generation: number, e: EffectEnvelope) {
    if (this.seen.has(e.effectId)) return;
    this.seen.add(e.effectId);
    const at = Date.now();
    try {
      this.handlers[e.effect.kind]?.(e.effect);
      this.records.push({ effectId: e.effectId, kind: e.effect.kind, ok: true, ms: Date.now() - at });
    } catch (err) {
      const error = err instanceof Error ? err : new Error(String(err));
      this.records.push({
        effectId: e.effectId,
        kind: e.effect.kind,
        ok: false,
        ms: Date.now() - at,
        error: error.message,
      });
      // Major 4 (5.6.1): a failed effect must be fed back into the state
      // machine as `effect_failed` so critical effects get compensated and
      // persist_snapshot gets its bounded durable-retry loop (R9). Without
      // this callback the audit record would be the only trace and the run
      // would never see diag.degraded / outcome.persistFailed.
      try {
        this.onFailure?.(runId, generation, e.effect.kind, error);
      } catch {
        /* onFailure must never break the interpreter's own error isolation */
      }
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
  /**
   * H3 (architecture §7.1): bounded, post-terminal, pre-physical-reclaim hook
   * (worktree commit/gate is the intended M2 consumer). Wired here — not at
   * the L3 service seam — because reap() is fire-and-forget from the
   * runner's own `finally` block; by the time `Runner.run()`'s promise
   * resolves back up at L3, physical reclaim may already be in flight or
   * finished. This is the only point in the call graph that is reliably
   * "after logical settle, before dispose".
   */
  beforeReap?: (outcome: RunOutcome, ctx: { cwd: string; deadlineMs: Millis }) => Promise<void> | void;
  /** Diagnostics-only sink for extension hook failures/timeouts (H3); never affects run outcome or settle timing beyond reapMs bound. */
  onExtensionError?: (hook: "beforeReap", runId: string, error: string) => void;
  /** Fired after every accepted dispatch with the fresh state — the live
   *  read-model feed for in-flight runs (persist_snapshot is terminal-only). */
  onStateChange?: (runId: string, state: RunState) => void;
  /**
   * X3: invoked whenever this run's cancellation is triggered (explicit
   * abortRun() call or the external SpawnRequest.signal firing), from
   * whichever path first reaches it — the single funnel point inside
   * createCancelHandle's onCancel callback below. Always called with cause
   * "parent_abort" (semantically "your parent is going away"), regardless of
   * *why* the parent itself stopped. The caller (service/runtime-adapter.ts,
   * wired from index.ts) is expected to look up and abort this run's own
   * children; RuntimeRunner itself has no notion of a run tree.
   */
  onChildAbort?: (runId: string, cause: StopCause) => void;
}
export interface Runner {
  run(req: ResolvedSpawnRequest, budget: DeadlineBudget): Promise<RunOutcome>;
}
const error = (e: unknown, kind: ErrorInfo["kind"] = "internal"): ErrorInfo => ({
  kind,
  message: e instanceof Error ? e.message : String(e),
  retryable: false,
});
const TERMINAL_STATUSES = new Set(["completed", "failed", "timed_out", "aborted"]);
function isTerminalStatus(status: string): boolean {
  return TERMINAL_STATUSES.has(status);
}
export class RuntimeRunner implements Runner {
  private readonly states = new Map<string, RunState>();
  private generation = new Map<string, number>();
  private readonly dispatchers = new Map<string, { gen: number; fn: (input: RunInput) => void }>();
  private readonly activeCancels = new Map<string, { gen: number; cancel: CancelHandle }>();
  private readonly activeHandles = new Map<string, { gen: number; handle: SessionHandle }>();
  constructor(private readonly d: RunnerDeps) {}
  /** Public dispatch entry so external drivers (watchdog ticks, effect-failure feedback) can feed inputs into a specific, still-running (runId, generation) without touching another concurrent run (fixes the single-field-clobber hazard when limit > 1). */
  dispatchExternal(runId: string, generation: number, input: RunInput): void {
    const entry = this.dispatchers.get(runId);
    if (entry && entry.gen === generation) entry.fn(input);
  }
  /** Read-only snapshot of a run's internal RunState, for watchdog tick() / diagnostics. */
  getRunState(runId: string, generation?: number): RunState | undefined {
    const s = this.states.get(runId);
    return generation === undefined || s?.generation === generation ? s : undefined;
  }
  /** Feed a failed effect back into the state machine (5.6.1 R9 compensation / persist retry loop). */
  notifyEffectFailed(runId: string, generation: number, effect: RunEffect["kind"], err: Error): void {
    this.dispatchExternal(runId, generation, {
      kind: "effect_failed",
      at: this.d.clock.now(),
      effect,
      error: error(err),
    });
  }
  /** L2 escalation trigger for QueryService.stop(): request cooperative + bounded abort of an active run. */
  async abortRun(
    runId: string,
    cause: StopCause = "user_stop",
  ): Promise<{ ok: boolean; escalatedTo: "L2" | "L3" | "L4" }> {
    const entry = this.activeCancels.get(runId);
    if (!entry) return { ok: false, escalatedTo: "L4" };
    entry.cancel.cancel(cause);
    return { ok: true, escalatedTo: "L2" };
  }
  /** Best-effort steer of an active run's session (QueryService.steer()); rejects if none is running. */
  async steerRun(runId: string, text: string): Promise<void> {
    const entry = this.activeHandles.get(runId);
    if (!entry) throw new Error(`no active session for run ${runId}`);
    await entry.handle.steer(text);
  }
  async run(req: ResolvedSpawnRequest, budget: DeadlineBudget): Promise<RunOutcome> {
    const gen = (this.generation.get(req.runId) ?? 0) + 1;
    this.generation.set(req.runId, gen);
    let state = createInitialState(req.runId, gen, this.d.clock.now(), req.parentRunId);
    this.states.set(req.runId, state);
    const cancel = createCancelHandle(req.runId, gen, req.signal, (reason) => {
      const selfCause: StopCause = reason === "external" ? "parent_abort" : "user_stop";
      this.dispatchExternal(req.runId, gen, {
        kind: "stop_requested",
        at: this.d.clock.now(),
        cause: selfCause,
      });
      // X3: cascade regardless of *why* this run stopped — a child's parent
      // going away is always "parent_abort" from the child's point of view.
      this.d.onChildAbort?.(req.runId, "parent_abort");
    });
    this.activeCancels.set(req.runId, { gen, cancel });
    let ticket: SlotTicket | undefined;
    let handle: SessionHandle | undefined;
    let createP: Promise<SessionHandle> | undefined;
    const dispatch = (input: RunInput) => {
      const out = reduce(state, { generation: gen, input }, budget);
      state = out.state;
      this.states.set(req.runId, state);
      try {
        this.d.onStateChange?.(req.runId, state);
      } catch {
        /* observer must never break the dispatch loop */
      }
      this.d.effects.apply(req.runId, gen, out.effects);
    };
    this.dispatchers.set(req.runId, { gen, fn: dispatch });
    try {
      dispatch({
        kind: "enqueued",
        at: this.d.clock.now(),
        budget,
        ...(req.deadlineAt === undefined ? {} : { deadlineCapAt: req.deadlineAt }),
      });
      // CC4/CP3: an already-expired deadlineAt cap settles the run as
      // failed(config) directly inside the `enqueued` reducer branch, before
      // any timer is armed. Must be checked here — before pool.acquire — or
      // this run would still occupy a slot despite already being terminal.
      if (state.outcome) return state.outcome;
      const acq = await this.guard(
        this.d.pool.acquire(req.runId, {
          ...(req.slotless === undefined ? {} : { slotless: req.slotless }),
          queueWaitMs: budget.queueWaitMs,
          signal: cancel.signal,
        }),
        remainingFor(budget.queueWaitMs, this.d.clock.now(), state.deadlines).ms,
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
      createP = req.resumeFrom
        ? this.d.driver.resume
          ? this.d.driver.resume(req.resumeFrom, req)
          : Promise.reject(new Error("session driver does not support resume"))
        : this.d.driver.create(req);
      const createBudget = remainingFor(budget.startupMs, this.d.clock.now(), state.deadlines);
      const created = await this.guard(createP, createBudget.ms, cancel, "create");
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
      this.activeHandles.set(req.runId, { gen, handle });
      createP = undefined;
      dispatch({
        kind: "session_created",
        at: this.d.clock.now(),
        sessionId: handle.sessionId,
        ...(handle.sessionFile === undefined ? {} : { sessionFile: handle.sessionFile }),
      });
      dispatch({ kind: "phase_entered", at: this.d.clock.now(), phase: "extension_bind" });
      const bindBudget = remainingFor(budget.bindMs, this.d.clock.now(), state.deadlines);
      const bound = await this.guard(
        this.d.driver.bind(handle, (e) => {
          dispatch({ kind: "session_event", at: this.d.clock.now(), event: e });
          // X11 TS3: setActiveTools only ever happens at a turn boundary, never
          // mid tool_exec. TS-race guard: re-check terminality *after*
          // dispatch() above has already folded this same event into the
          // state machine, so a deadline_fired arriving in the same tick is
          // reflected in state.status before we decide whether to enforce.
          if (e.t === "turn_end" && req.toolScope && !isTerminalStatus(state.status)) {
            req.toolScope.enforcer.onTurnBoundary(handle!, req.toolScope.policy);
          }
        }),
        bindBudget.ms,
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
      // X11: first application, right after bind and before prompt dispatch
      // (architecture §7.5 onBind). Guarded the same way as onTurnBoundary.
      if (req.toolScope && !isTerminalStatus(state.status)) req.toolScope.enforcer.onBind(handle, req.toolScope.policy);
      this.d.watchdog.arm(req.runId, gen);
      const promptBudget = remainingFor(budget.totalMs, this.d.clock.now(), state.deadlines);
      const prompted = await this.guard(handle.prompt(req.prompt), promptBudget.ms, cancel, "prompt");
      const finalText = prompted.ok ? handle.getLastAssistantText() : undefined;
      // pi resolves prompt() even when the final turn errored (stopReason
      // "error" surfaces only on the message). Without this, a provider
      // crash looks like "completed with empty text".
      const turnError = prompted.ok ? handle.getTurnError?.() : undefined;
      dispatch({
        kind: "prompt_settled",
        at: this.d.clock.now(),
        ...(prompted.ok
          ? turnError === undefined
            ? {}
            : { error: error(turnError, "model") }
          : { error: error(prompted.reason, prompted.reason === "cancelled" ? "aborted" : "timeout") }),
        ...(finalText === undefined ? {} : { text: finalText }),
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
      const beforeReap = this.d.beforeReap;
      const outcomeForHook = state.outcome;
      const runReap = async () => {
        if (beforeReap && outcomeForHook) {
          try {
            await this.withTimeout(
              Promise.resolve().then(() =>
                beforeReap(outcomeForHook, { cwd: req.cwd ?? "", deadlineMs: budget.reapMs }),
              ),
              budget.reapMs,
            );
          } catch (e) {
            this.d.onExtensionError?.("beforeReap", req.runId, e instanceof Error ? e.message : String(e));
          }
        }
        return this.d.reaper.reap(reap);
      };
      void runReap().catch(() => undefined);
      const dEntry = this.dispatchers.get(req.runId);
      if (dEntry && dEntry.gen === gen) this.dispatchers.delete(req.runId);
      const cEntry = this.activeCancels.get(req.runId);
      if (cEntry && cEntry.gen === gen) this.activeCancels.delete(req.runId);
      const hEntry = this.activeHandles.get(req.runId);
      if (hEntry && hEntry.gen === gen) this.activeHandles.delete(req.runId);
    }
  }
  /** Bounded generic await, no cancel signal (H3 beforeReap only needs a timeout, not abort-linkage). */
  private withTimeout<T>(p: Promise<T>, ms: number): Promise<T> {
    return new Promise((resolve, reject) => {
      let done = false;
      const timer = this.d.clock.setTimer(Math.max(0, ms), () => {
        if (done) return;
        done = true;
        reject(new Error(`timed out after ${ms}ms`));
      });
      p.then(
        (v) => {
          if (done) return;
          done = true;
          this.d.clock.clearTimer(timer);
          resolve(v);
        },
        (e) => {
          if (done) return;
          done = true;
          this.d.clock.clearTimer(timer);
          reject(e instanceof Error ? e : new Error(String(e)));
        },
      );
    });
  }
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
