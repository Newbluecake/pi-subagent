import type { Clock } from "../core/clock.js";
import { withDeadline } from "../core/deadline.js";
import {
  attachHostCallHandler,
  type ChildSpawner,
  type GateRunner,
  type HostCallHandler,
  type JournalRunConfig,
} from "./host.js";
import { createJournalStore } from "./journal.js";
import { buildReplayIndex } from "./replay.js";
import { assertHeartbeatBudgetInvariant, startRunawayWatchdog } from "./runaway.js";
import type {
  OrphanChildSummary,
  ReplayScope,
  SerializedError,
  WorkerHost,
  WorkflowChildSummary,
  WorkflowDiagnostics,
  WorkflowHeartbeatDiag,
  WorkflowId,
  WorkflowOutcome,
  WorkflowRunBudget,
  WorkflowStopCause,
  WorkflowTerminalStatus,
  WorkflowTimeoutReason,
} from "./types.js";

/**
 * M3.1/M3.2/M3.3 (workflow design §3.8, §7, §11): the orchestrator.
 *
 * M3.3 adds the abort-propagation pipeline (§7.2 WL0–WL4) on top of the
 * M3.1/M3.2 linear boot-run-settle slice, plus the `stop`/`outcomeAt1`/
 * `settled` API surface (§3.8) so a caller can reach a workflow that is
 * already `run()`-ing from outside (Esc / WT8 / parent cascade / shutdown
 * all funnel through the same `stop()` entry point — §7.1's eight trigger
 * sources).
 *
 * **Documented simplification versus the full §3.4 reduce/effect-interpreter
 * design** (kept narrow deliberately — see the task's own pacing note: "核心
 * abort 路径扎实，文档从简"): there is no `WorkflowState`/`reduceWorkflow`
 * pure state machine here. Instead, every path that can end a run (natural
 * completion, script error, worker death, deadline, runaway, external
 * `stop()`) converges on one function (`escalateAndSettle`) that performs
 * the WL0–WL4 *effects* in the same order the design specifies:
 *
 *   WL0 (sync)      — `decided` flips, `outcomeAt1` snapshot captured
 *   WL1  close_gate  — `HostCallHandler.stopOwned()`'s first synchronous step
 *   WL2  stop_owned  — same call: cascade-cancel + bounded wait for real settle
 *   WL3  terminate_worker — `WorkerHost.terminate()` (§2.3.1 S1–S8, unchanged)
 *   WL4  reconcile + resolve_settled — leftover actives force-settled inline
 *        by `stopOwned` (RC3/RC4), then this function resolves `settled()`
 *
 * What is *not* reproduced from the full design: a real `reconcile_children`
 * step distinct from the WL2 grace wait (§4.1 WT19 `reconcileMs` — here it is
 * folded into the same bounded wait host.ts's `stopOwned` performs), and a
 * type-level-unreachable four-layer TestHooks gate (§3.8.1) — the internal
 * hooks type below is exported from this production file so
 * `orchestrator.testing.ts` can consume it, rather than being physically
 * absent from `dist/` (L2). Both are called out in the M3.3 hand-off note
 * (see the PR/task write-up) as backlog items for a future milestone that
 * builds the full reduce pipeline.
 */

const MAX_SCRIPT_BYTES = 512 * 1024;

export interface OrchestratorRunRequest {
  readonly workflowId: WorkflowId;
  readonly script: string;
  readonly budget: WorkflowRunBudget;
  readonly signal?: AbortSignal;
  /** M3.4 §5.1/§5.2: the tool parameter surfaced to the script as its top-level `args` global. */
  readonly args?: unknown;
  /** M3.5 §6.5: the journal namespace (`<journalRootDir>/<sanitized journal>/journal.jsonl`). `undefined` (default) disables both replay and journal writes for this run — zero journal I/O, unchanged M3.1-M3.4 behavior. Requires `OrchestratorDeps.journalRootDir` to also be set; if either is missing the run proceeds journal-less rather than failing. */
  readonly journal?: string;
  /** M3.5 RP1: forces every `agent()` call live even when a journal is configured; journal writes still happen (§6.4: "noReplay 未设置" is the *only* RP a caller can opt out of on purpose). */
  readonly noReplay?: boolean;
  /** M3.5 §6.2: `content` vs `chain` lookup-key scope. Default `"chain"`. Resolved once at `enqueued` time, like `deadlineAt` — never re-read mid-run. */
  readonly replayScope?: ReplayScope;
}

/**
 * §3.8: `OrchestratorDeps` intentionally has no `__testHooks` field (L1 of
 * the four-layer gate, §3.8.1). `createWorkerHost` is plain constructor DI —
 * tests inject a `WorkerHost` built with a scripted/fake underlying worker
 * (see lifecycle.ts's `WorkerLike`) the same way production injects the real
 * `node:worker_threads`-backed one; that is not a fault-injection backdoor,
 * it is the same seam `workerHost: WorkerHost` occupies in the full design
 * (§3.8's `OrchestratorDeps.workerHost`).
 */
export interface OrchestratorDeps {
  readonly clock: Clock;
  createWorkerHost(): WorkerHost;
  emit?(channel: string, payload: unknown): void;
  /**
   * M3.2: structurally compatible with `SpawnService` (src/service/) without
   * importing it (WI2 — see host.ts's doc comment). Optional: scripts that
   * never call `agent()` keep working with no spawner configured (M3.1
   * behavior, unchanged); calling `agent()` without one rejects with a clear
   * configuration error instead of hanging.
   */
  spawner?: ChildSpawner;
  /** M3.2: required only if the script calls `gate()`; same "clear error, not a hang" default as `spawner`. */
  gateRunner?: GateRunner;
  /** M3.2 §3.7: threaded into every spawned child's `SpawnRequest.parentRunId` (CC1 `stopChildrenOf` anchor). */
  parentRunId?: string;
  /**
   * M3.5 §6.5: filesystem root a journal-enabled run's `<journalDir>` is
   * derived from (`join(journalRootDir, sanitize(request.journal))`). Plain
   * constructor DI, same seam as `parentRunId`/`spawner` — the real path
   * (state-dir-relative) is decided by whatever assembles this
   * `OrchestratorDeps` above `src/workflow/**` (WI1: this module never
   * reaches for it itself). Optional: absent (or `request.journal` absent)
   * disables the feature entirely, see `OrchestratorRunRequest.journal`.
   */
  journalRootDir?: string;
}

export interface Orchestrator {
  run(req: OrchestratorRunRequest): Promise<WorkflowOutcome>;
  /**
   * M3.3 §3.8/§7.1 trigger source ⑦ (`/agent stop <id>`) and the generic
   * entry point ①②⑥⑨ (Esc, WT8, shutdown, WT13) are expected to funnel
   * through: an above-`src/workflow/**` caller resolves *which* run to stop
   * and *why*, this just applies WL0–WL4 to it. TL1: idempotent — concurrent/
   * repeated calls against the same `workflowId` all await the one
   * `settled()` promise; the escalation itself only ever runs once.
   * Unknown/already-finished `workflowId` resolves `{ ok: false }` rather
   * than throwing (a caller racing its own bookkeeping is not a bug).
   */
  stop(workflowId: WorkflowId, cause: WorkflowStopCause): Promise<{ ok: boolean }>;
  /**
   * §3.8 `outcomeAt1`: the ① logical-terminal snapshot, readable as soon as
   * `run()` has decided to stop (`pendingReconcile: true`; `children[]` may
   * contain `"running"`/`"stopping"` entries). `undefined` before a decision
   * has been made, or once the run has been reaped (see `run()`'s finally).
   */
  outcomeAt1(workflowId: WorkflowId): WorkflowOutcome | undefined;
  /**
   * §3.8 `settled`: resolves at ②, once WL2's bounded wait + WL3's terminate
   * + WL4's inline reconcile have all completed (`pendingReconcile: false`).
   * This is the exact same promise `run()` itself returns for that
   * `workflowId` — exposed separately so a caller that only has the id (not
   * the original `run()` call's promise) can still reach it. Rejects only if
   * `workflowId` was never `run()` (never rejects once a run has started).
   */
  settled(workflowId: WorkflowId): Promise<WorkflowOutcome>;
}

function validateScriptSize(script: string): { ok: true } | { ok: false; message: string } {
  const bytes = Buffer.byteLength(script, "utf8");
  if (bytes > MAX_SCRIPT_BYTES) {
    return { ok: false, message: `script exceeds the ${MAX_SCRIPT_BYTES} byte limit (§5.1): got ${bytes} bytes` };
  }
  if (script.trim().length === 0) {
    return { ok: false, message: "script must not be empty" };
  }
  return { ok: true };
}

/** M3.5 §6.5: filename-safe journal namespace — whitelist characters, capped length, matching the design's "做文件名安全化" note. */
function sanitizeJournalName(name: string): string {
  const safe = name.replace(/[^a-zA-Z0-9_-]/g, "_").slice(0, 128);
  return safe.length > 0 ? safe : "_";
}

/**
 * M3.5 §6.2/§6.5/§6.6: loads this run's journal (if any) and builds the
 * scope-appropriate `ReplayIndex` once, ahead of `boot()`. Only called when
 * both `req.journal` and `deps.journalRootDir` are present (see the call
 * site) — `deterministic` starts `true` and is updated by the `onMeta`
 * listener the instant the worker's own `meta` message arrives (RP9).
 */
async function buildJournalConfig(deps: OrchestratorDeps, req: OrchestratorRunRequest): Promise<JournalRunConfig> {
  const store = createJournalStore({ clock: deps.clock });
  const dir = `${deps.journalRootDir}/${sanitizeJournalName(req.journal as string)}`;
  const { entries, corruptLines } = await store.load(dir);
  const scope: ReplayScope = req.replayScope ?? "chain";
  const index = buildReplayIndex(entries, corruptLines, scope);
  return {
    store,
    dir,
    index,
    scope,
    noReplay: req.noReplay ?? false,
    ...(req.budget.replayTtlMs !== undefined ? { replayTtlMs: req.budget.replayTtlMs } : {}),
    ...(req.budget.journalFlushMs !== undefined ? { journalFlushMs: req.budget.journalFlushMs } : {}),
    deterministic: { current: true },
  };
}

type InternalResolution =
  | { readonly kind: "completed"; readonly result: unknown }
  | { readonly kind: "failed"; readonly stopCause: WorkflowStopCause; readonly error: SerializedError }
  | { readonly kind: "timed_out"; readonly timeoutReason: WorkflowTimeoutReason }
  | { readonly kind: "aborted"; readonly stopCause: WorkflowStopCause };

function statusFor(r: InternalResolution): WorkflowTerminalStatus {
  return r.kind;
}

function causeFor(r: InternalResolution): string {
  switch (r.kind) {
    case "completed":
      return "workflow_completed";
    case "failed":
      return r.stopCause;
    case "timed_out":
      return "timeout";
    case "aborted":
      return r.stopCause;
  }
}

function sleep(clock: Clock, ms: number): Promise<void> {
  return new Promise((resolve) => clock.setTimer(Math.max(0, ms), resolve));
}

/**
 * M3.3 §3.8.1 (documented simplification, see the module doc above): the
 * hook surface `orchestrator.testing.ts` wires into the six named effects
 * WL0–WL4 actually apply. Not part of `OrchestratorDeps` (L1 still holds —
 * an assembler cannot smuggle this onto `OrchestratorDeps` through object
 * literal excess-property checking), but *is* a plain export of this
 * production file rather than being physically absent from `dist/` (the
 * full L2 guarantee is a backlog item — see module doc).
 */
export type WorkflowEffectKind =
  "close_gate" | "stop_owned" | "terminate_worker" | "commit_terminal" | "reconcile_children" | "resolve_settled";

export type EffectDecision = "proceed" | "skip" | "throw" | { readonly delayMs: number };

export interface OrchestratorInternalHooks {
  beforeEffect?(kind: WorkflowEffectKind, ctx: { readonly workflowId: WorkflowId }): EffectDecision;
  onEffectApplied?(kind: WorkflowEffectKind, workflowId: WorkflowId, at: number): void;
  /** W39/W39b: delay or permanently suppress the ② `resolve_settled` delivery. */
  settledDelivery?: "normal" | "suppress" | { readonly delayMs: number };
}

interface RunEntry {
  outcomeAt1(): WorkflowOutcome | undefined;
  readonly settled: Promise<WorkflowOutcome>;
  requestStop(cause: WorkflowStopCause): void;
}

/**
 * L3 of the four-layer test-hook gate (§3.8.1): even if a caller bypasses the
 * type system with `as any` to smuggle a `__testHooks` property onto
 * `OrchestratorDeps`, the production factory fails fast instead of silently
 * accepting it.
 */
function assertNoSmuggledTestHooks(deps: OrchestratorDeps): void {
  if (Object.prototype.hasOwnProperty.call(deps, "__testHooks")) {
    throw new Error("orchestrator: test hooks are not permitted in the production factory");
  }
}

export function createOrchestrator(deps: OrchestratorDeps): Orchestrator {
  assertNoSmuggledTestHooks(deps);
  return createOrchestratorImpl(deps, {});
}

/**
 * **Internal, test-only entry point.** Only `orchestrator.testing.ts`
 * imports this. See the module doc's "documented simplification" note for
 * why this is a named export of the production file rather than living
 * behind the full L1–L4 gate.
 */
export function createOrchestratorImpl(deps: OrchestratorDeps, hooks: OrchestratorInternalHooks): Orchestrator {
  const runs = new Map<WorkflowId, RunEntry>();

  async function applyBeforeEffect(kind: WorkflowEffectKind, workflowId: WorkflowId): Promise<"proceed" | "skip"> {
    const decision = hooks.beforeEffect?.(kind, { workflowId }) ?? "proceed";
    if (decision === "throw") throw new Error(`test-injected failure applying workflow effect '${kind}'`);
    if (decision === "skip") return "skip";
    if (typeof decision === "object") await sleep(deps.clock, decision.delayMs);
    return "proceed";
  }

  function markApplied(kind: WorkflowEffectKind, workflowId: WorkflowId): void {
    hooks.onEffectApplied?.(kind, workflowId, deps.clock.now());
  }

  async function run(req: OrchestratorRunRequest): Promise<WorkflowOutcome> {
    const createdAt = deps.clock.now();
    let heartbeat: WorkflowHeartbeatDiag = { seq: 0, observedAt: createdAt, stalledMs: 0 };
    let logLines = 0;
    let orphanWorker: WorkflowDiagnostics["orphanWorker"];
    let children: readonly WorkflowChildSummary[] = [];
    let hostHandlerRef: HostCallHandler | undefined;
    let outcomeAt1Snapshot: WorkflowOutcome | undefined;
    let retryingCancelsAtDecision = 0;

    let resolveSettledPromise!: (o: WorkflowOutcome) => void;
    const settledPromise = new Promise<WorkflowOutcome>((resolve) => {
      resolveSettledPromise = resolve;
    });
    let triggerAbort: ((cause: WorkflowStopCause) => void) | undefined;
    let pendingExternalStop: WorkflowStopCause | undefined;

    runs.set(req.workflowId, {
      outcomeAt1: () => outcomeAt1Snapshot,
      settled: settledPromise,
      requestStop: (cause) => {
        if (triggerAbort) triggerAbort(cause);
        else pendingExternalStop = cause; // WI6: stop() raced boot — honored the instant the executor is ready.
      },
    });

    const buildOutcome = (
      status: WorkflowTerminalStatus,
      pendingReconcile: boolean,
      extra: {
        result?: unknown;
        error?: SerializedError;
        timeoutReason?: WorkflowTimeoutReason;
        stopCause?: WorkflowStopCause;
      },
      orphanChildren: readonly OrphanChildSummary[],
    ): WorkflowOutcome => {
      const settledAt = deps.clock.now();
      const diag: WorkflowDiagnostics = {
        createdAt,
        startedAt: createdAt,
        settledAt,
        ...(req.budget.workflowTotalMs > 0 ? { deadlineAt: createdAt + req.budget.workflowTotalMs } : {}),
        heartbeat,
        logLines,
        ...(orphanWorker ? { orphanWorker } : {}),
        ...(pendingReconcile ? { retryingCancels: retryingCancelsAtDecision } : {}),
        ...(hostHandlerRef?.currentPhaseId !== undefined ? { currentPhaseId: hostHandlerRef.currentPhaseId } : {}),
      };
      return {
        workflowId: req.workflowId,
        status,
        pendingReconcile,
        durationMs: settledAt - createdAt,
        diag,
        children,
        ...(orphanChildren.length > 0 ? { orphanChildren } : {}),
        ...(hostHandlerRef?.replayStats !== undefined ? { replay: hostHandlerRef.replayStats } : {}),
        ...(extra.result !== undefined ? { result: extra.result } : {}),
        ...(extra.error ? { error: extra.error } : {}),
        ...(extra.timeoutReason ? { timeoutReason: extra.timeoutReason } : {}),
        ...(extra.stopCause ? { stopCause: extra.stopCause } : {}),
      };
    };

    const extraFor = (
      r: InternalResolution,
    ): {
      result?: unknown;
      error?: SerializedError;
      timeoutReason?: WorkflowTimeoutReason;
      stopCause?: WorkflowStopCause;
    } => {
      switch (r.kind) {
        case "completed":
          return { result: r.result };
        case "failed":
          return { stopCause: r.stopCause, error: r.error };
        case "timed_out":
          return { timeoutReason: r.timeoutReason };
        case "aborted":
          return { stopCause: r.stopCause };
      }
    };

    /** Pre-boot fast paths never had a worker/children to reconcile — settle immediately at ①=②. */
    const settleImmediately = (status: WorkflowTerminalStatus, extra: ReturnType<typeof extraFor>): WorkflowOutcome => {
      const outcome = buildOutcome(status, false, extra, []);
      outcomeAt1Snapshot = outcome;
      deps.emit?.(`subagent:workflow:${status}`, outcome);
      resolveSettledPromise(outcome);
      runs.delete(req.workflowId);
      return outcome;
    };

    // §5.1 tool-layer rule, mirrored defensively at the orchestrator boundary too: an already-aborted signal never boots a worker.
    if (req.signal?.aborted) {
      return settleImmediately("aborted", { stopCause: "user_stop" });
    }

    // HB1: a misconfigured budget is a startup-time programming error, not a
    // per-run runtime condition — fail loudly instead of folding it into a
    // workflow outcome the caller might not notice.
    if (req.budget.heartbeatMs > 0) {
      assertHeartbeatBudgetInvariant(req.budget.scriptSliceMs, req.budget.heartbeatStallMs, req.budget.heartbeatMs);
    }

    // WT1 (script_load): host-side validation only — meta parsing itself
    // happens inside the worker (worker-source.ts) and is reported back as a
    // `meta_error` message, handled below alongside script_threw.
    const loadCheck = await withDeadline(
      Promise.resolve(validateScriptSize(req.script)),
      req.budget.scriptLoadMs,
      deps.clock,
      "script_load",
    );
    if (!loadCheck.ok) {
      return settleImmediately("timed_out", { timeoutReason: "script_load" });
    }
    if (!loadCheck.value.ok) {
      return settleImmediately("failed", { stopCause: "script_error", error: { message: loadCheck.value.message } });
    }

    const deadlineAt = req.budget.workflowTotalMs > 0 ? createdAt + req.budget.workflowTotalMs : undefined;
    const workerHost = deps.createWorkerHost();

    // M3.5 §6.5/§6.6: load (once, before boot) whatever journal history exists
    // for this namespace and build the scope-appropriate `ReplayIndex` —
    // deliberately *not* bounded by a dedicated deadline (a small JSONL read
    // is not expected to be the long pole here; an FS that hangs on `readFile`
    // is an environment problem out of this milestone's scope, same
    // simplification class as §6.6's own "withDeadline(scriptLoadMs) 由调用方施加"
    // note for the *store*, just not exercised by this orchestrator slice).
    const journalConfig: JournalRunConfig | undefined =
      req.journal !== undefined && deps.journalRootDir !== undefined ? await buildJournalConfig(deps, req) : undefined;
    // M3.6 RP11 (§6.3 RW3'): `content` scope cannot see the implicit
    // filesystem causality between sibling `agent()` calls that `chain`
    // scope's causal-chain digest exists specifically to cover — an
    // opt-in, not a silent one, so every run using it gets a WARN once,
    // ahead of boot, alongside the corresponding `subagent:workflow:*` event
    // stream (best-effort, `deps.emit` may be absent in tests).
    if (journalConfig?.scope === "content") {
      console.warn(
        `[pi-subagent] workflow "${req.workflowId}" is using replayScope:"content" — replay can reuse a result even when a` +
          " prior sibling call in this run changed the workspace the prompt implicitly depends on. Prefer the default" +
          ' "chain" scope unless you have verified the tasks are truly independent (§6.3 RW3\').',
      );
      deps.emit?.("subagent:workflow:replay_scope_risk", { workflowId: req.workflowId, scope: "content" });
    }

    workerHost.events.onLog(() => {
      logLines += 1;
    });

    // M3.5 RP9: updates `journalConfig.deterministic.current` the instant the
    // worker's `meta` message arrives — always ahead of any `host_call` from
    // the same worker (types.ts's `WorkerHostEvents.onMeta` doc), and (like
    // `onLog` above) wired ahead of `boot()` so no race with the worker's own
    // first turn is possible.
    workerHost.events.onMeta((meta) => {
      if (journalConfig && meta.deterministic !== undefined) journalConfig.deterministic.current = meta.deterministic;
    });

    // M3.2 §3.3/§3.5: wired *before* `boot()` — the worker can start sending
    // `host_call` envelopes as soon as its script begins executing, which can
    // race `boot()`'s own resolution (it resolves on the native 'online'
    // event, not on "script finished its first turn"). `onHostCall` is a
    // plain listener registration (no dependency on boot), so attaching it
    // here means no `agent()`/`gate()` call can ever arrive before a listener
    // exists to answer it.
    const spawner: ChildSpawner = deps.spawner ?? {
      spawn: async () => ({
        error: {
          message: "workflow: agent() requires the orchestrator to be configured with a ChildSpawner (SpawnService)",
        },
      }),
      abort: async () => false,
      waitAll: async () => ({ settled: [], pending: [] }),
    };
    const gateRunner: GateRunner =
      deps.gateRunner ??
      (async () => {
        throw new Error("workflow: gate() requires the orchestrator to be configured with a gateRunner");
      });
    const hostHandler = attachHostCallHandler({
      clock: deps.clock,
      workerHost,
      spawner,
      gateRunner,
      budget: req.budget,
      ...(deadlineAt !== undefined ? { workflowDeadlineAt: deadlineAt } : {}),
      ...(deps.parentRunId !== undefined ? { parentRunId: deps.parentRunId } : {}),
      ...(req.args !== undefined ? { workflowArgs: req.args } : {}),
      ...(journalConfig !== undefined ? { journal: journalConfig } : {}),
      onChildSettled: () => {
        children = hostHandler.children;
      },
      // M10: relay the host handler's child-lifecycle feed onto the run's
      // event stream so above-`src/workflow/**` observers (the tool card's
      // live progress, the activity registry) can render per-child rows
      // without a live `Orchestrator` snapshot API.
      onChildEvent: (event) => {
        deps.emit?.("subagent:workflow:child", { workflowId: req.workflowId, ...event });
      },
      onPhaseChange: (event) => {
        deps.emit?.("subagent:workflow:phase", { workflowId: req.workflowId, ...event });
      },
    });
    hostHandlerRef = hostHandler;

    const bootOutcome = await workerHost.boot({
      scriptSource: req.script,
      scriptSliceMs: req.budget.scriptSliceMs,
      heartbeatMs: req.budget.heartbeatMs,
      workerBootMs: req.budget.workerBootMs,
      terminateConfirmMs: req.budget.terminateConfirmMs,
      ...(req.budget.maxOldGenerationSizeMb !== undefined
        ? { maxOldGenerationSizeMb: req.budget.maxOldGenerationSizeMb }
        : {}),
      ...(req.budget.maxYoungGenerationSizeMb !== undefined
        ? { maxYoungGenerationSizeMb: req.budget.maxYoungGenerationSizeMb }
        : {}),
      ...(req.budget.hostCallMs !== undefined ? { hostCallMs: req.budget.hostCallMs } : {}),
      ...(req.budget.gateMs !== undefined ? { gateMs: req.budget.gateMs } : {}),
      ...(req.budget.maxBatchItems !== undefined ? { maxBatchItems: req.budget.maxBatchItems } : {}),
      ...(req.args !== undefined ? { args: req.args } : {}),
    });

    if (!bootOutcome.ok) {
      await workerHost.terminate("boot_failed");
      return bootOutcome.reason === "boot_timeout"
        ? settleImmediately("timed_out", { timeoutReason: "worker_boot" })
        : settleImmediately("failed", {
            stopCause: "worker_died",
            error: { message: bootOutcome.detail ?? "worker boot failed" },
          });
    }

    const resolution = await new Promise<InternalResolution>((resolve) => {
      let done = false;
      let deadlineTimer: ReturnType<Clock["setTimer"]> | undefined;
      let watchdog: ReturnType<typeof startRunawayWatchdog> | undefined;
      let onAbort: (() => void) | undefined;

      const cleanup = (): void => {
        if (deadlineTimer !== undefined) deps.clock.clearTimer(deadlineTimer);
        watchdog?.stop();
        if (onAbort) req.signal?.removeEventListener("abort", onAbort);
      };
      const finish = (r: InternalResolution): void => {
        if (done) return; // WR1/WI6: terminal decision is made at most once.
        done = true;
        cleanup();
        resolve(r);
      };

      workerHost.events.onScriptReturned((result) => finish({ kind: "completed", result }));
      workerHost.events.onScriptThrew((error) => finish({ kind: "failed", stopCause: "script_error", error }));
      workerHost.events.onMetaError((message) =>
        finish({ kind: "failed", stopCause: "script_error", error: { message } }),
      );
      workerHost.events.onExit((code, expected) => {
        // WI5 reverse propagation: an unexpected worker exit is itself a
        // stop trigger — everything downstream (WL1–WL4) treats it exactly
        // like any other decision.
        if (!expected) {
          finish({
            kind: "failed",
            stopCause: "worker_died",
            error: { message: `worker exited unexpectedly with code ${code}` },
          });
        }
      });
      workerHost.events.onError((error) => finish({ kind: "failed", stopCause: "worker_died", error }));

      if (deadlineAt !== undefined) {
        // WT8: the sole hard-guarantee trigger (§4.1) — armed once at
        // `enqueued` time (`createdAt` above), never rearmed (WR2).
        deadlineTimer = deps.clock.setTimer(Math.max(0, deadlineAt - deps.clock.now()), () =>
          finish({ kind: "timed_out", timeoutReason: "workflow_total" }),
        );
      }

      watchdog = startRunawayWatchdog({
        clock: deps.clock,
        workerHost,
        heartbeatMs: req.budget.heartbeatMs,
        heartbeatStallMs: req.budget.heartbeatStallMs,
        policy: req.budget.runawayPolicy,
        onTick: (hb) => {
          heartbeat = hb;
        },
        onRunaway: (hb) =>
          finish({
            kind: "failed",
            stopCause: "runaway",
            error: { message: `heartbeat stalled for ${hb.stalledMs}ms (runawayPolicy=terminate_on_stall)` },
          }),
      });

      // §7.1 trigger source ①: user Esc / a `stop()` call arriving through
      // the `AbortSignal` the caller supplied to `run()`.
      onAbort = (): void => finish({ kind: "aborted", stopCause: "user_stop" });
      req.signal?.addEventListener("abort", onAbort, { once: true });

      // §3.8 `stop()`: a caller reaching this run by `workflowId` (parent
      // cascade / `/agent stop` / shutdown / WT13 all funnel here from above
      // `src/workflow/**`) rather than through the original `signal`.
      triggerAbort = (cause) => finish({ kind: "aborted", stopCause: cause });
      if (pendingExternalStop !== undefined) triggerAbort(pendingExternalStop);
    });

    // ① WL0: the terminal decision is made — capture the outcomeAt1 snapshot
    // (`pendingReconcile: true`) *synchronously*, before any of WL1–WL4's
    // bounded-but-asynchronous work runs. This is GW1a's actual point of
    // fulfillment; everything from here down is the ①→② async window
    // (§4.3.1).
    retryingCancelsAtDecision = hostHandler.registry.stats.retryingCancels;
    outcomeAt1Snapshot = buildOutcome(statusFor(resolution), true, extraFor(resolution), []);
    markApplied("commit_terminal", req.workflowId);

    const cause = causeFor(resolution);
    let orphanChildren: readonly OrphanChildSummary[] = [];

    // WL1 (close_gate) + WL2 (stop_owned): a single call into host.ts's
    // `stopOwned` — see that function's doc for why the two are combined
    // (WL1's gate-close is `stopOwned`'s first synchronous statement).
    try {
      if ((await applyBeforeEffect("close_gate", req.workflowId)) === "proceed") {
        markApplied("close_gate", req.workflowId);
        if ((await applyBeforeEffect("stop_owned", req.workflowId)) === "proceed") {
          const abortGraceMs = req.budget.abortGraceMs ?? 10_000;
          const r = await hostHandler.stopOwned(cause, abortGraceMs);
          orphanChildren = r.orphanChildren;
          markApplied("stop_owned", req.workflowId);
        }
      }
    } catch {
      // EI2: best-effort effect failed — degrade, do not hang the pipeline.
      // `hostHandler.stopOwned` itself is exception-safe in normal operation;
      // this branch only fires under test-injected `beforeEffect: "throw"`.
    }

    // M3.5 JS4: a single bounded best-effort flush, ahead of ②/`resolve_settled`
    // — gives buffered journal entries a real chance to land on disk before
    // the process might exit shortly after this run settles. Best-effort:
    // `flushJournal` itself never throws (journal.ts's `flush()` degrades to
    // reporting `pending`, never rejects), and a flush timeout never delays
    // the workflow's own terminal decision past `journalFlushMs`.
    try {
      await hostHandler.flushJournal(req.budget.journalFlushMs ?? 2_000);
    } catch {
      // JS3: a flush failure only costs this run's own newly-written entries
      // a chance to be replayed later — it never fails the workflow itself.
    }

    // WL3 (terminate_worker): §2.3.1 S1–S8, unchanged. `stopOwned` above
    // already guarantees no *call* is left pending; this reclaims the
    // worker thread itself. Its own S7 is independently bounded
    // (`terminateConfirmMs`) and best-effort (W35: even a `terminate()` that
    // never natively resolves does not block this pipeline past S6/`detached`).
    const terminateReason = `workflow_${resolution.kind}`;
    let terminateOutcome: Awaited<ReturnType<WorkerHost["terminate"]>>;
    try {
      if ((await applyBeforeEffect("terminate_worker", req.workflowId)) === "skip") {
        terminateOutcome = { detached: true, terminated: false, orphaned: false, ms: 0 };
      } else {
        terminateOutcome = await workerHost.terminate(terminateReason);
        markApplied("terminate_worker", req.workflowId);
      }
    } catch {
      terminateOutcome = { detached: true, terminated: false, orphaned: true, ms: 0 };
    }
    if (terminateOutcome.orphaned) {
      orphanWorker = { reason: terminateReason, at: deps.clock.now() };
    }
    children = hostHandler.children;

    // WL4 (reconcile_children): the leftover-active sweep already happened
    // inline inside `stopOwned` above (RC3/RC4); this is the effect
    // checkpoint W37/WP2-style tests observe to confirm it runs exactly once,
    // after `stop_owned`/`terminate_worker` and before `resolve_settled`.
    if ((await applyBeforeEffect("reconcile_children", req.workflowId)) !== "skip") {
      markApplied("reconcile_children", req.workflowId);
    }

    // ② resolve_settled: the one effect that actually publishes the outcome
    // through `settled()`/`run()`'s own return value. EI5: if applying it
    // itself fails (test-injected `beforeEffect: "throw"` only — this has no
    // legitimate production failure mode), fall back to resolving with the
    // outcomeAt1 snapshot (explicitly marked degraded) rather than leaving
    // the caller hanging forever.
    const finalOutcome = buildOutcome(statusFor(resolution), false, extraFor(resolution), orphanChildren);
    try {
      if ((await applyBeforeEffect("resolve_settled", req.workflowId)) === "skip") {
        runs.delete(req.workflowId);
        return finalOutcome; // not delivered through settled()/emit — test-only path.
      }
      const delivery = hooks.settledDelivery ?? "normal";
      if (delivery === "suppress") {
        // W39b: the ② signal never arrives through the normal path. A
        // tool-layer WT17 fallback (§4.3.2 step 6) would live above
        // `src/workflow/**` and is out of this milestone's scope — see the
        // module doc's backlog note. `outcomeAt1()` remains the only
        // avenue a caller has for a snapshot in this state.
        return await new Promise<WorkflowOutcome>(() => {
          /* deliberately never resolves */
        });
      }
      if (typeof delivery === "object") await sleep(deps.clock, delivery.delayMs);
      markApplied("resolve_settled", req.workflowId);
      deps.emit?.(`subagent:workflow:${finalOutcome.status}`, finalOutcome);
      resolveSettledPromise(finalOutcome);
      runs.delete(req.workflowId);
      return finalOutcome;
    } catch {
      const degraded: WorkflowOutcome = {
        ...outcomeAt1Snapshot,
        diag: { ...outcomeAt1Snapshot.diag, degraded: "settlement_apply_failed" },
      };
      resolveSettledPromise(degraded);
      // Deliberately *not* `runs.delete()`-ed here: EI5 is a defect-only path
      // (see this function's doc comment — `resolve_settled` has no
      // legitimate production failure mode), and `settled()`/`outcomeAt1()`
      // must remain queryable by `workflowId` for whoever is diagnosing the
      // defect. Documented backlog: this leaks the map entry for the
      // lifetime of the process on this path; a real reduce-based pipeline
      // would reap it on a timer instead.
      return degraded;
    }
  }

  return {
    run,
    async stop(workflowId, cause) {
      const entry = runs.get(workflowId);
      if (!entry) return { ok: false };
      entry.requestStop(cause);
      await entry.settled;
      return { ok: true };
    },
    outcomeAt1(workflowId) {
      return runs.get(workflowId)?.outcomeAt1();
    },
    settled(workflowId) {
      const entry = runs.get(workflowId);
      if (!entry) return Promise.reject(new Error(`workflow: no run found for workflowId '${workflowId}'`));
      return entry.settled;
    },
  };
}
