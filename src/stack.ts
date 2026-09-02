import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { homedir } from "node:os";
import { join } from "node:path";
import { systemClock } from "./core/clock.js";
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
  notifier = createNotifier({
    store: outbox,
    clock: systemClock,
    maxAttempts: settings.deliveryAttempts,
    backoffMs: settings.deliveryBackoffMs,
    reconcileTtlMs: settings.reconcileTtlMs,
    maxReconcileRounds: settings.maxReconcileRounds,
    maxBatch: settings.maxReconcileBatch,
    ...(merged.onDelivery ? { onDelivery: merged.onDelivery } : {}),
    sender: {
      willBuffer: (payload) => coalescer !== undefined && isCoalescible(payload),
      sendMessage: (payload) => {
        if (coalescer && isCoalescible(payload)) return coalescer.submit(payload);
        sendFormatted([payload]);
      },
    },
  });
  previousCoalescer = coalescer;
  // X3: lazy ref — nested Agent tool + abort-cascade need SpawnService, built just below.
  const spawnRef: { current?: SpawnService } = {};
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
    onOutcomeConsumed: (outcome) => {
      try {
        const by = { extensionOwner: "spawnAndWait" };
        notifier.consume(deliveryKey(outcome.runId, outcome.diag.generation), by);
      } catch {
        // Consumption is best effort only.
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
  return { spawn, query, orphans: reaper.registry, notifier, mention, scheduler, rpc, workflow };
}
