import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { getAgentDir } from "@earendil-works/pi-coding-agent";
import { homedir } from "node:os";
import { join } from "node:path";
import { systemClock } from "./core/clock.js";
import { createBashJobManager, type BashJobManager } from "./bash/manager.js";
import { createJobStore } from "./bash/job-store.js";
import { createProcessPort } from "./bash/process.js";
import { previewCommand, type JobRecord } from "./bash/types.js";
import { describeJobStatus } from "./tools/bash-job-tool.js";
import { formatDuration } from "./ui/fleet-panel.js";
import { MemoryOutboxStore, MemoryRunStore } from "./core/store.js";
import type { DeliveryPayload, SubagentExtensionPoints } from "./core/types.js";
import { probeReadBackEntries } from "./adapters/pi-compat.js";
import { mergeExtensionPoints } from "./extensions/registry.js";
import { createPiOutboxStore } from "./adapters/pi-outbox-store.js";
import { wrapWithRunLog } from "./adapters/pi-run-log.js";
import type { AgentTypeRegistry } from "./config/agent-types.js";
import { resolveModelHint } from "./config/model-hint.js";
import type { AgentSettings } from "./config/settings.js";
import type { Runner } from "./service/ports.js";
import { createNotifier, deliveryKey, type Notifier, type PersistedDelivery } from "./delivery/notifier.js";
import { createCoalescer, isCoalescible, type Coalescer } from "./delivery/coalescer.js";
import { formatDigest, formatSingle } from "./delivery/format.js";
import { parseDeliveryKey } from "./core/delivery-key.js";
import { UsageBroadcaster } from "./delivery/usage-broadcast.js";
import { formatOutcomeSummary } from "./tools/agent-tool.js";
import { createMentionRegistry, type MentionRegistry } from "./mention/registry.js";
import { EscalatingReaper, type OrphanRegistry } from "./runtime/reaper.js";
import { PiSessionDriver } from "./runtime/session-driver.js";
import { SingleSlotPool } from "./runtime/slot-pool.js";
import { EventWatchdog } from "./runtime/watchdog.js";
import { createRPCServer, type RPCServer } from "./rpc/server.js";
import { createScheduler, type Scheduler } from "./schedule/scheduler.js";
import { createQueryService, type QueryService } from "./service/query-service.js";
import { createLiveRunRegistry } from "./service/run-registry.js";
import { createRuntimeRunnerAdapter } from "./service/runtime-adapter.js";
import { createSpawnService, type SpawnService } from "./service/spawn-service.js";
import { FleetWidgetController } from "./ui/fleet-widget.js";
import { createWorkflowActivityRegistry, type WorkflowActivityRegistry } from "./workflow/activity.js";
import { createWorkerHost } from "./workflow/lifecycle.js";
import { createOrchestrator, type Orchestrator } from "./workflow/orchestrator.js";
import { buildWorkflowRunBudget } from "./workflow/run-budget.js";
import { createWorkflowChildSpawner } from "./workflow/spawner-adapter.js";
import type { WorkflowId, WorkflowRunBudget } from "./workflow/types.js";

/** X7b: the previous session's fleet widget, disposed at the top of buildSessionStack (index.ts rebuilds the stack on every session_start and never calls a stack dispose hook). */
let previousFleetWidget: FleetWidgetController | undefined;
/** M-E: the previous session's usage broadcaster — same rebuild-dispose pattern as the fleet widget. */
let previousUsageBroadcaster: UsageBroadcaster | undefined;
let previousCoalescer: Coalescer | undefined;
let previousAckHold: Coalescer | undefined;
/**
 * bash auto-background §3.6: the previous session's job manager, disposed at
 * the top of the next build. `dispose()` only clears timers — it never kills a
 * process and never notifies afterwards, so the next stack's `recover()` can
 * adopt the still-running jobs and own the single notification channel.
 */
let previousBashJobs: BashJobManager | undefined;

/** customType of the bash job completion notice (§5) — distinct from `subagent:notification`. */
export const BASH_JOB_NOTIFICATION_TYPE = "bash-job:notification";
/** Output tail attached to a completion notice (§5). */
export const BASH_JOB_TAIL_BYTES = 1024;
export const BASH_JOB_TAIL_LINES = 10;

/**
 * §2.5/§2.6 (R6): the whole bash-job subsystem is off on win32 (no process
 * groups) and off when the threshold is 0. Read by `index.ts` to decide
 * whether the `bash` override and `bash_job` are registered at all, and here
 * to decide whether a manager (directory scan + poll timer) exists.
 */
export function bashJobsEnabled(settings: AgentSettings): boolean {
  return process.platform !== "win32" && settings.bashJobs.autoBackgroundMs > 0;
}

/** Wall-clock life of a job (spawn → exit, or → now while it runs). */
export function bashJobElapsedMs(record: JobRecord, now: number): number {
  return Math.max(0, (record.endedAt ?? now) - (record.spawnedAt ?? record.createdAt));
}

/** `exit N` when the code is known, otherwise the tool layer's own phrase. */
function bashJobOutcomePhrase(record: JobRecord): string {
  if ((record.status === "completed" || record.status === "failed") && record.exitCode !== null) {
    return `exit ${record.exitCode}`;
  }
  return describeJobStatus(record);
}

/**
 * §5 completion notice. Deliberately prefixed "Bash job" (vs. the
 * "Subagent …" wording of `delivery/format.ts`) so a downstream hook, the
 * user and the model can all tell the two notification channels apart.
 */
export function formatBashJobNotification(record: JobRecord, tail?: string, now: number = Date.now()): string {
  const head =
    `Bash job ${record.jobId} ($ ${previewCommand(record.command, 60)}) finished: ` +
    `${bashJobOutcomePhrase(record)} after ${formatDuration(bashJobElapsedMs(record, now))}.`;
  const body = tail !== undefined && tail.length > 0 ? ["--- output tail ---", tail, "---"] : [];
  return [
    head,
    ...body,
    `Collect full output with bash_job(action: "output", job_id: "${record.jobId}").`,
    ...(record.outputTruncated ? ["(the job's log hit its size cap; some output was dropped)"] : []),
  ].join("\n");
}

function tailOffset(size: number): number {
  return Math.max(0, size - BASH_JOB_TAIL_BYTES);
}

function lastLines(content: string, max: number): string | undefined {
  const lines = content.replace(/\n+$/, "").split("\n");
  const tail = lines.slice(Math.max(0, lines.length - max)).join("\n");
  return tail.trim().length > 0 ? tail : undefined;
}

/**
 * Best-effort log tail for the notice. Never advances the model-facing read
 * cursor (`bash_job output` must still see everything) and never rejects — a
 * missing/unreadable log only costs the tail, not the notification.
 *
 * Two passes: a terminal record's `logBytes` is usually exact, but an adopted
 * or `exited_unknown` job's counter can lag behind the file, so the first read
 * (which reports the real size) is repeated from the true tail offset.
 */
async function readBashJobTail(manager: BashJobManager, record: JobRecord): Promise<string | undefined> {
  try {
    const options = { advanceCursor: false, maxBytes: BASH_JOB_TAIL_BYTES } as const;
    let read = await manager.readOutput(record.jobId, { ...options, offset: tailOffset(record.logBytes) });
    if (read.logBytes > record.logBytes) {
      read = await manager.readOutput(record.jobId, { ...options, offset: tailOffset(read.logBytes) });
    }
    return lastLines(read.content, BASH_JOB_TAIL_LINES);
  } catch {
    return undefined;
  }
}

function currentSessionId(ctx: ExtensionContext): string {
  try {
    return (ctx.sessionManager as { getSessionId?: () => string } | undefined)?.getSessionId?.() ?? "";
  } catch {
    return "";
  }
}

/**
 * bash auto-background §3/§5 assembly: store + process port + manager, with
 * the completion notice bound to `pi.sendMessage` (the manager itself has no
 * pi imports). A rejecting `notify` means "retry on the next poll", so
 * `notifiedAt` is only stamped once the message actually went out.
 */
function buildBashJobManager(pi: ExtensionAPI, ctx: ExtensionContext, settings: AgentSettings): BashJobManager {
  const config = settings.bashJobs;
  const store = createJobStore({
    dir: config.dir ?? join(getAgentDir(), "bash-jobs"),
    retentionMs: config.retentionMs,
    clock: systemClock,
  });
  const processPort = createProcessPort(config.shellPath !== undefined ? { shellPath: config.shellPath } : {});
  // Late-bound: `notify` needs the manager it is being constructed with (to
  // read the log tail) — same pattern as widgetRef/spawnRef above.
  const managerRef: { current?: BashJobManager } = {};
  const manager = createBashJobManager({
    store,
    processPort,
    clock: systemClock,
    sessionId: currentSessionId(ctx),
    hostPid: process.pid,
    maxLogBytes: config.maxLogBytes,
    maxBackgroundJobs: config.maxBackgroundJobs,
    notify: async (record) => {
      const tail = managerRef.current ? await readBashJobTail(managerRef.current, record) : undefined;
      pi.sendMessage(
        {
          customType: BASH_JOB_NOTIFICATION_TYPE,
          content: formatBashJobNotification(record, tail),
          display: true,
          details: {
            kind: "bash-job",
            jobId: record.jobId,
            status: record.status,
            exitCode: record.exitCode,
            durationMs: bashJobElapsedMs(record, systemClock.now()),
            logPath: record.logPath,
          },
        },
        { triggerTurn: true },
      );
    },
  });
  managerRef.current = manager;
  return manager;
}

export interface WorkflowSupport {
  readonly enabled: boolean;
  readonly defaultBudget: WorkflowRunBudget;
  readonly activity: WorkflowActivityRegistry;
  readonly journalRootDir: string;
  /**
   * M3.6 (hand-off note, orchestrator.ts): one `Orchestrator` per workflow
   * run, not one per session — matching every `createOrchestrator(deps)`
   * call site in `tests/workflow/**` and the design's `OrchestratorDeps.
   * parentRunId` field (a single fixed value threaded into *every* spawned
   * child's `SpawnRequest.parentRunId` for that instance's whole lifetime,
   * §3.7's CC1 `stopChildrenOf` anchor). A shared session-lifetime instance
   * would have to pick one `parentRunId` for every workflow invocation in
   * the session, which breaks CC1's per-run cascade-stop anchoring the
   * instant two workflow runs are in flight at once. `workflowId` doubles as
   * that anchor (the same X3 pattern nested `Agent` delegation already uses).
   */
  createOrchestrator(workflowId: WorkflowId): Orchestrator;
}

export interface Stack {
  spawn: SpawnService;
  query: QueryService;
  orphans: OrphanRegistry;
  notifier: Notifier;
  mention: MentionRegistry;
  scheduler: Scheduler;
  rpc: RPCServer;
  workflow: WorkflowSupport;
  /** bash auto-background job manager; absent when the feature is off (§2.6/R6). */
  bashJobs?: BashJobManager;
}

/** Build the per-session L2/L3 stack (extracted from index.ts to keep it
 *  assembly-only, D7). Rebuilt on every session_start: ctx.sessionManager is
 *  only available there. */
export function buildSessionStack(
  pi: ExtensionAPI,
  ctx: ExtensionContext,
  settings: AgentSettings,
  types: AgentTypeRegistry,
  mergedExtensions: readonly SubagentExtensionPoints[],
): Stack {
  // X7b: session rebuild — dispose the previous session's fleet widget
  // (stop its tick + setWidget(key, undefined)) before the new one mounts.
  previousFleetWidget?.dispose();
  previousFleetWidget = undefined;
  previousUsageBroadcaster?.dispose();
  previousUsageBroadcaster = undefined;
  previousCoalescer?.dispose();
  previousCoalescer = undefined;
  previousAckHold?.dispose();
  previousAckHold = undefined;
  // §3.6/§3.7: timers only — the processes keep running and are re-adopted by
  // the new manager's recover() below.
  previousBashJobs?.dispose();
  previousBashJobs = undefined;

  // The widget controller is created after QueryService exists (below), but
  // its H1 onLifecycle must be part of the merged extension points *before*
  // the runner is built — hence a late-bound ref (same pattern as spawnRef).
  const widgetRef: { current?: FleetWidgetController } = {};
  const widgetPoints: SubagentExtensionPoints = { onLifecycle: () => widgetRef.current?.refresh() };
  // M-E: real-time cost broadcast — poked on run start (onSnapshot below) and
  // every lifecycle event so the final terminal frame is always emitted.
  const usageRef: { current?: UsageBroadcaster } = {};
  const usagePoints: SubagentExtensionPoints = { onLifecycle: () => usageRef.current?.poke() };
  const merged = mergeExtensionPoints([...mergedExtensions, widgetPoints, usagePoints]);

  // G5a degradation: ctx.sessionManager is part of pi's session ctx contract
  // (types.d.ts:219), but if a future pi drops it we degrade to in-memory
  // stores + WARN instead of throwing inside the session_start handler.
  const readBack = probeReadBackEntries(ctx);
  if (!readBack)
    console.warn(
      "[pi-subagent] ctx.sessionManager.getEntries unavailable; run-log/outbox degrade to in-memory (G5a read-back verification off).",
    );
  const runLogHost = { appendEntry: pi.appendEntry, sessionManager: ctx.sessionManager };
  const store = readBack ? wrapWithRunLog(new MemoryRunStore(), runLogHost) : new MemoryRunStore();
  const pool = new SingleSlotPool(systemClock, settings.concurrencyLimit);
  const reaper = new EscalatingReaper(systemClock);
  // M4: watchdog 不再是空壳——通过 runnerRef 晚绑定到真实 runner（watchdog 先于
  // runner 构造，与 spawnRef 同一模式）。此前 getState/dispatch 都是 no-op，
  // 所有子阶段超时（idle/firstEvent/tool/…）从不触发，唯一生效的只有 runner
  // 内部 guard 的 totalMs——上游慢速涓流时 run 会一路挂到总预算（事故复盘见
  // CHANGELOG）。tick 只派发 deadline_fired，其他 input 类型不会出现。
  const runnerRef: { current?: Runner } = {};
  const watchdog = new EventWatchdog({
    clock: systemClock,
    budget: settings.budget,
    getState: (runId, gen) => runnerRef.current?.getRunState?.(runId, gen),
    dispatch: (runId, gen, input) => {
      if (input.kind === "deadline_fired") runnerRef.current?.fireDeadline?.(runId, gen, input);
    },
  });
  const outbox = readBack
    ? createPiOutboxStore({ appendEntry: pi.appendEntry, sessionManager: ctx.sessionManager })
    : new MemoryOutboxStore<PersistedDelivery>();
  let taken = new Set<string>();
  try {
    taken = new Set(
      outbox
        .list()
        .map((r) => parseDeliveryKey(r.key)?.runId)
        .filter((id): id is string => id !== undefined),
    );
  } catch {
    console.warn("[pi-subagent] outbox list failed; runId uniqueness degrades to process-local (M17)");
  }
  const spawnRef: { current?: SpawnService } = {};
  const sendFormatted = (items: readonly DeliveryPayload[]) => {
    const stats = Object.fromEntries(
      items.flatMap((item) => {
        const outcome = store.get(item.runId)?.outcome;
        return outcome ? [[item.key, formatOutcomeSummary(outcome)]] : [];
      }),
    );
    if (items.length === 1) {
      const payload = items[0]!;
      const snapshot = store.get(payload.runId);
      const outcome = snapshot?.outcome;
      const fallbackReason =
        payload.status !== "completed"
          ? (outcome?.error?.message ?? outcome?.timeoutReason ?? snapshot?.diag.error?.message)
          : undefined;
      const presented = {
        ...payload,
        ...(payload.label === undefined && snapshot?.diag.label !== undefined ? { label: snapshot.diag.label } : {}),
        ...(payload.failReason === undefined && fallbackReason !== undefined ? { failReason: fallbackReason } : {}),
      };
      const singleStats = stats[payload.key];
      pi.sendMessage(
        {
          customType: "subagent:notification",
          content: formatSingle(presented, singleStats !== undefined ? { stats: singleStats } : undefined),
          display: true,
          details: payload,
        },
        { triggerTurn: true },
      );
      return;
    }
    // Digest details are discriminated by kind. Consumers must inspect kind first and read items.
    const first = items[0]!;
    pi.sendMessage(
      {
        customType: "subagent:notification",
        content: formatDigest(items, { stats }),
        display: true,
        details: { ...first, kind: "digest", items },
      },
      { triggerTurn: true },
    );
  };
  let notifier: Notifier;
  const coalescer =
    settings.coalesceWindowMs > 0
      ? createCoalescer({
          clock: systemClock,
          windowMs: settings.coalesceWindowMs,
          maxBatch: settings.coalesceMaxBatch,
          send: sendFormatted,
          onSettled: (keys, ok) => notifier.settleBatch(keys, ok),
        })
      : undefined;
  const isAckHoldable = (payload: DeliveryPayload) =>
    isCoalescible(payload) && spawnRef.current?.expectsAck(payload.runId) === true;
  const ackHold =
    settings.ackWindowMs > 0
      ? createCoalescer({
          clock: systemClock,
          windowMs: settings.ackWindowMs,
          maxBatch: settings.coalesceMaxBatch,
          send: (items) => items.forEach((item) => sendFormatted([item])),
          onSettled: (keys, ok) => notifier.settleBatch(keys, ok),
        })
      : undefined;
  notifier = createNotifier({
    store: outbox,
    clock: systemClock,
    maxAttempts: settings.deliveryAttempts,
    backoffMs: settings.deliveryBackoffMs,
    reconcileTtlMs: settings.reconcileTtlMs,
    maxReconcileRounds: settings.maxReconcileRounds,
    maxBatch: settings.maxReconcileBatch,
    ...(merged.onDelivery ? { onDelivery: merged.onDelivery } : {}),
    cancelBuffered: (key) => {
      coalescer?.cancel(key);
      ackHold?.cancel(key);
    },
    sender: {
      willBuffer: (payload) =>
        (coalescer !== undefined && isCoalescible(payload)) || (ackHold !== undefined && isAckHoldable(payload)),
      sendMessage: (payload) => {
        if (coalescer && isCoalescible(payload)) return coalescer.submit(payload);
        if (ackHold && isAckHoldable(payload)) return ackHold.submit(payload);
        sendFormatted([payload]);
      },
    },
  });
  previousCoalescer = coalescer;
  previousAckHold = ackHold;
  // X3: lazy ref — nested Agent tool + abort-cascade need SpawnService, built just below.
  // M-D: runIds whose "subagent:started" event has already been emitted (once per run).
  const announcedStarts = new Set<string>();
  const runner = createRuntimeRunnerAdapter({
    clock: systemClock,
    driver: new PiSessionDriver(settings.rememberAgents, (p, id) => ctx.modelRegistry.find(p, id)),
    pool,
    store,
    watchdog,
    reaper,
    notifier,
    extensions: [merged],
    onLifecycle: (event) =>
      pi.events.emit(event.status === "completed" ? "subagent:completed" : "subagent:failed", event),
    nestedSpawn: () => spawnRef.current,
    onChildAbort: (parentRunId, cause) => void spawnRef.current?.abort(parentRunId, cause),
  });
  runnerRef.current = runner; // M4: 接通 watchdog 的晚绑定
  const mention = createMentionRegistry();
  const mentionRef = { current: mention };
  const spawn = createSpawnService({
    types,
    pool,
    runner,
    budget: settings.budget,
    maxNestedDepth: settings.maxNestedDepth,
    runIdTaken: (id) => taken.has(id),
    // Fuzzy model hints (frontmatter `model: sonnet`, Agent tool
    // `model: "kimi-k3"`) resolve against pi's available models —
    // getAvailable() already filters to authenticated/usable entries, so a
    // hint can never land on a model the session couldn't actually run.
    resolveModelHint: (hint) =>
      resolveModelHint(
        hint,
        ctx.modelRegistry.getAvailable().map((m) => ({ provider: m.provider, id: m.id, name: m.name })),
      ),
    onLabel: (label, target) => mentionRef.current?.register(label, target),
    onOutcomeAcked: (outcome) => {
      try {
        notifier.ack(outcome.runId, outcome.diag.generation, { extensionOwner: "spawnAndWait" });
      } catch {
        // Best effort only.
      }
    },
    notifyTerminalFailure: (outcome) => {
      const payload = {
        key: deliveryKey(outcome.runId, outcome.diag.generation),
        runId: outcome.runId,
        generation: outcome.diag.generation,
        status: outcome.status,
        textPreview: outcome.text ?? "",
        ...(outcome.diag.label === undefined ? {} : { label: outcome.diag.label }),
        ...((outcome.error?.message ?? outcome.timeoutReason)
          ? { failReason: outcome.error?.message ?? outcome.timeoutReason }
          : {}),
        diag: {
          phase: outcome.diag.phase,
          status: outcome.status,
          pendingTools: outcome.diag.pendingTools,
          staleInputs: outcome.diag.staleInputs,
          degraded: outcome.diag.degraded.length,
        },
        createdAt: outcome.diag.createdAt,
        reconcileRound: 0,
      } satisfies DeliveryPayload;
      let existing: ReturnType<Notifier["peek"]>;
      try {
        existing = notifier.peek(payload.key);
      } catch {
        existing = undefined;
      }
      if (existing === "delivered" || existing === "consumed" || existing === "pending" || existing === "batched")
        return;
      if (existing === "staged") {
        notifier.finalize(outcome.runId, outcome.diag.generation, payload);
        return;
      }
      notifier.enqueue(payload);
    },
    onSnapshot: (snapshot) => {
      // M-D: announce a run exactly once, as soon as it has actually started
      // (diag.startedAt set on slot_acquired). The previous heuristic
      // (startedAt === enqueuedAt) silently never fired for any run that
      // waited ≥1ms in the queue — consumers like pi-hud saw zero events.
      if (snapshot.diag.startedAt !== undefined && !announcedStarts.has(snapshot.runId)) {
        announcedStarts.add(snapshot.runId);
        pi.events.emit("subagent:started", { runId: snapshot.runId, at: snapshot.updatedAt });
      }
      usageRef.current?.poke(); // M-E: start/refresh the 1Hz cost broadcast
    },
  });
  spawnRef.current = spawn;
  // Static fallback for the dynamic per-run wait default (only reached when a
  // snapshot has no deadlineAt yet): the configured run budget + abort grace +
  // settlement headroom, so it tracks `/agent settings` budget changes.
  const query = createQueryService({
    registry: createLiveRunRegistry(spawn, store),
    runner,
    clock: systemClock,
    defaultWaitMs: settings.budget.totalMs + settings.budget.abortGraceMs + 30_000,
  });
  // M9: created early — the fleet widget below lists in-flight workflows.
  const workflowActivity = createWorkflowActivityRegistry();
  // M-E: live usage broadcaster (channel "subagent:usage", 1Hz while active).
  const usageBroadcaster = new UsageBroadcaster({
    list: () => query.list(),
    emit: (event) => pi.events.emit("subagent:usage", event),
    clock: systemClock,
  });
  usageRef.current = usageBroadcaster;
  previousUsageBroadcaster = usageBroadcaster;
  // X7b: always-on fleet widget above the editor. The controller self-probes
  // ctx.ui.setWidget and goes inert (no timer, no throw) in non-interactive
  // modes; settings.fleetWidget=false skips it entirely.
  if (settings.fleetWidget) {
    // M10: theme-color injector — ctx.ui.theme is pi's live Theme (falls back
    // to plain text on older pi builds without it).
    const uiTheme = (ctx.ui as { theme?: { fg(color: string, text: string): string } } | undefined)?.theme;
    const widget = new FleetWidgetController({
      ui: ctx.ui,
      query,
      clock: systemClock,
      idleBudgetMs: settings.budget.idleMs,
      ...(uiTheme
        ? {
            color: (tone, text) => {
              switch (tone) {
                case "warn":
                  return uiTheme.fg("warning", text);
                case "crit":
                  return uiTheme.fg("error", text);
                case "muted":
                  return uiTheme.fg("muted", text);
                case "success":
                  return uiTheme.fg("success", text);
                case "header":
                  return uiTheme.fg("accent", text);
                default:
                  return text;
              }
            },
          }
        : {}),
      // M9: ⚙ workflow group headers in the agent tree — children (parentRunId
      // === workflowId) are indented under their workflow instead of floating
      // as orphan ↳ rows.
      workflows: () => workflowActivity.list(),
    });
    widgetRef.current = widget;
    previousFleetWidget = widget;
  }
  const scheduler = createScheduler({ spawn });
  const rpc = createRPCServer({ events: pi.events, spawn, query });
  const bashJobs = bashJobsEnabled(settings) ? buildBashJobManager(pi, ctx, settings) : undefined;
  previousBashJobs = bashJobs;
  // §3.6: adopt still-running jobs and re-arm pending notices. Fire-and-forget
  // like notifier.reconcile() — a directory scan must never delay session start,
  // and a failure only means "no adoption this session", not a broken session.
  if (bashJobs) {
    void bashJobs.recover().catch((error: unknown) => {
      console.warn(`[pi-subagent] bash job recovery failed (jobs stay unadopted): ${String(error)}`);
    });
  }

  // M3.6 (CC3, §11 M3.6): the workflow engine's session-lifetime pieces —
  // built unconditionally (cheap: a spawner adapter closure + a budget
  // object + an empty activity map), but `workflow.enabled` gates whether
  // `index.ts` ever registers the `SubagentWorkflow` tool that would
  // actually call `createOrchestrator()` (settings.workflow.enabled default
  // `false` — the engine stays entirely inert until then).
  // (M9: created above the fleet widget, which lists in-flight workflows.)
  const workflowChildSpawner = createWorkflowChildSpawner(spawn, types);
  const workflowJournalRootDir = settings.workflow.journalDir ?? join(homedir(), ".pi", "agent", "workflows");
  const workflow: WorkflowSupport = {
    enabled: settings.workflow.enabled,
    defaultBudget: buildWorkflowRunBudget(settings),
    activity: workflowActivity,
    journalRootDir: workflowJournalRootDir,
    createOrchestrator(workflowId) {
      return createOrchestrator({
        clock: systemClock,
        createWorkerHost: () => createWorkerHost({ clock: systemClock }),
        spawner: workflowChildSpawner,
        gateRunner: async (cmd, opts) => {
          const result = await pi.exec("bash", ["-c", cmd], {
            timeout: opts.timeoutMs,
            ...(opts.cwd !== undefined ? { cwd: opts.cwd } : {}),
          });
          return {
            ok: result.code === 0 && !result.killed,
            code: result.code,
            stdout: result.stdout,
            stderr: result.stderr,
          };
        },
        parentRunId: workflowId,
        journalRootDir: workflowJournalRootDir,
        emit: (channel, payload) => {
          pi.events.emit(channel, payload);
          workflowActivity.onEvent(channel, payload);
        },
      });
    },
  };
  return {
    spawn,
    query,
    orphans: reaper.registry,
    notifier,
    mention,
    scheduler,
    rpc,
    workflow,
    ...(bashJobs ? { bashJobs } : {}),
  };
}
