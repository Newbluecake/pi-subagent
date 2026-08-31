import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { systemClock } from "./core/clock.js";
import { MemoryOutboxStore, MemoryRunStore } from "./core/store.js";
import type { SubagentExtensionPoints } from "./core/types.js";
import { probeReadBackEntries } from "./adapters/pi-compat.js";
import { mergeExtensionPoints } from "./extensions/registry.js";
import { createPiOutboxStore } from "./adapters/pi-outbox-store.js";
import { wrapWithRunLog } from "./adapters/pi-run-log.js";
import type { AgentTypeRegistry } from "./config/agent-types.js";
import type { AgentSettings } from "./config/settings.js";
import { createNotifier, type Notifier, type PersistedDelivery } from "./delivery/notifier.js";
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

/** X7b: the previous session's fleet widget, disposed at the top of buildSessionStack (index.ts rebuilds the stack on every session_start and never calls a stack dispose hook). */
let previousFleetWidget: FleetWidgetController | undefined;

export interface Stack {
  spawn: SpawnService;
  query: QueryService;
  orphans: OrphanRegistry;
  notifier: Notifier;
  mention: MentionRegistry;
  scheduler: Scheduler;
  rpc: RPCServer;
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

  // The widget controller is created after QueryService exists (below), but
  // its H1 onLifecycle must be part of the merged extension points *before*
  // the runner is built — hence a late-bound ref (same pattern as spawnRef).
  const widgetRef: { current?: FleetWidgetController } = {};
  const widgetPoints: SubagentExtensionPoints = { onLifecycle: () => widgetRef.current?.refresh() };
  const merged = mergeExtensionPoints([...mergedExtensions, widgetPoints]);

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
  const watchdog = new EventWatchdog({
    clock: systemClock,
    budget: settings.budget,
    // The runner enforces its one hard deadline (total) itself via a real
    // setTimeout race (runtime/runner.ts guard()); sub-phase watchdog
    // ticks are not wired to a cross-run dispatch loop in M1 - documented
    // limitation, not a fake pass.
    getState: () => undefined,
    dispatch: () => undefined,
  });
  const outbox = readBack
    ? createPiOutboxStore({ appendEntry: pi.appendEntry, sessionManager: ctx.sessionManager })
    : new MemoryOutboxStore<PersistedDelivery>();
  const notifier = createNotifier({
    store: outbox,
    clock: systemClock,
    maxAttempts: settings.deliveryAttempts,
    backoffMs: settings.deliveryBackoffMs,
    reconcileTtlMs: settings.reconcileTtlMs,
    maxReconcileRounds: settings.maxReconcileRounds,
    maxBatch: settings.maxReconcileBatch,
    ...(merged.onDelivery ? { onDelivery: merged.onDelivery } : {}), // H4
    sender: (payload) => {
      // G5b: sendMessage has no ack (arch. §2.5); failures stay inside
      // Notifier's own retry/backoff loop, never surfaced to run status.
      pi.sendMessage({
        customType: "subagent:notification",
        content: `Subagent run ${payload.runId} ${payload.status}${payload.textPreview ? `: ${payload.textPreview.slice(0, 200)}` : ""}`,
        display: true,
        details: payload,
      });
    },
  });
  // X3: lazy ref — nested Agent tool + abort-cascade need SpawnService, built just below.
  const spawnRef: { current?: SpawnService } = {};
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
  const mention = createMentionRegistry();
  const mentionRef = { current: mention };
  const spawn = createSpawnService({
    types,
    pool,
    runner,
    budget: settings.budget,
    maxNestedDepth: settings.maxNestedDepth,
    onLabel: (label, target) => mentionRef.current?.register(label, target),
    onSnapshot: (snapshot) => {
      if (snapshot.diag.startedAt !== undefined && snapshot.diag.startedAt === snapshot.diag.enqueuedAt)
        pi.events.emit("subagent:started", { runId: snapshot.runId, at: snapshot.updatedAt });
    },
  });
  spawnRef.current = spawn;
  const query = createQueryService({ registry: createLiveRunRegistry(spawn, store), runner, clock: systemClock });
  // X7b: always-on fleet widget above the editor. The controller self-probes
  // ctx.ui.setWidget and goes inert (no timer, no throw) in non-interactive
  // modes; settings.fleetWidget=false skips it entirely.
  if (settings.fleetWidget) {
    const widget = new FleetWidgetController({
      ui: ctx.ui,
      query,
      clock: systemClock,
      idleBudgetMs: settings.budget.idleMs,
    });
    widgetRef.current = widget;
    previousFleetWidget = widget;
  }
  const scheduler = createScheduler({ spawn });
  const rpc = createRPCServer({ events: pi.events, spawn, query });
  return { spawn, query, orphans: reaper.registry, notifier, mention, scheduler, rpc };
}
