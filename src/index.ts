import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { systemClock } from "./core/clock.js";
import { MemoryOutboxStore, MemoryRunStore } from "./core/store.js";
import type { SubagentExtensionPoints } from "./core/types.js";
import { assertCompatible, detectPiCapabilities, probeReadBackEntries } from "./adapters/pi-compat.js";
import { createPiOutboxStore } from "./adapters/pi-outbox-store.js";
import { wrapWithRunLog } from "./adapters/pi-run-log.js";
import { createAgentTypeRegistry } from "./config/agent-types.js";
import { loadSettingsFromFile, type AgentSettings } from "./config/settings.js";
import { createNotifier, type Notifier, type PersistedDelivery } from "./delivery/notifier.js";
import { mergeExtensionPoints } from "./extensions/registry.js";
import { createPiWorktreeExtension } from "./extensions/worktree.js";
import { EscalatingReaper, type OrphanRegistry } from "./runtime/reaper.js";
import { PiSessionDriver } from "./runtime/session-driver.js";
import { SingleSlotPool } from "./runtime/slot-pool.js";
import { EventWatchdog } from "./runtime/watchdog.js";
import { createQueryService, type QueryService } from "./service/query-service.js";
import { createRunRegistry } from "./service/run-registry.js";
import { createRuntimeRunnerAdapter } from "./service/runtime-adapter.js";
import { createSpawnService, type SpawnService } from "./service/spawn-service.js";
import { createAgentTool } from "./tools/agent-tool.js";
import { createResultTool } from "./tools/result-tool.js";
import { createSteerTool } from "./tools/steer-tool.js";
import { createStatusCommand } from "./commands/status.js";

interface Stack {
  spawn: SpawnService;
  query: QueryService;
  orphans: OrphanRegistry;
  notifier: Notifier;
}

/**
 * M2 Wave 1 (architecture §7.1): the single merge point for the four
 * documented extension hooks. Empty by default; future milestones (X1
 * worktree, X10 schema tools, etc.) push their SubagentExtensionPoints here
 * instead of inventing new mount points (I7: index.ts stays assembly-only).
 */
const extensionPoints: SubagentExtensionPoints[] = [];

/** X1: worktree isolation (H2 rewrite cwd + H3 commit/remove). Default off;
 *  enable via settings worktree.enabled. Throws (→ failed(config)) when
 *  explicitly requested but unavailable — never silently falls back. */
function wireWorktree(pi: ExtensionAPI, settings: AgentSettings): void {
  extensionPoints.push(createPiWorktreeExtension(pi, settings.worktree));
}

/**
 * M1 assembly. Only wiring lives here (D7 / I7): register the three tools
 * and /agent status once, then (re)build the L2-L3 stack on every
 * session_start (ctx.sessionManager, needed for the G5a/G5b append-entry
 * read-back stores, is only available there — not on the module-load-time
 * ExtensionAPI). Tools close over a mutable holder so they always call
 * through to the current session's stack. session_shutdown drains bounded.
 */
export default function activate(pi: ExtensionAPI): void {
  const settings = loadSettingsFromFile();
  wireWorktree(pi, settings);
  const types = createAgentTypeRegistry();
  const caps = detectPiCapabilities(pi);
  const compat = assertCompatible(caps);
  const holder: { current?: Stack } = {};

  const buildStack = (ctx: ExtensionContext): Stack => {
    const merged = mergeExtensionPoints(extensionPoints);
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
    const runner = createRuntimeRunnerAdapter({
      clock: systemClock,
      driver: new PiSessionDriver(settings.rememberAgents),
      pool,
      store,
      watchdog,
      reaper,
      notifier,
      extensions: [merged],
      onLifecycle: (event) =>
        pi.events.emit(event.status === "completed" ? "subagent:completed" : "subagent:failed", event),
    });
    const spawn = createSpawnService({
      types,
      pool,
      runner,
      budget: settings.budget,
      onSnapshot: (snapshot) => {
        if (snapshot.diag.startedAt !== undefined && snapshot.diag.startedAt === snapshot.diag.enqueuedAt)
          pi.events.emit("subagent:started", { runId: snapshot.runId, at: snapshot.updatedAt });
      },
    });
    const query = createQueryService({ registry: createRunRegistry(store), runner, clock: systemClock });
    return { spawn, query, orphans: reaper.registry, notifier };
  };

  if (!compat.ok) {
    pi.registerTool({
      name: "Agent",
      label: "Agent (unavailable)",
      description: `pi-subagent is disabled: ${compat.reason}`,
      parameters: { type: "object", properties: {}, required: [] } as never,
      async execute() {
        throw new Error(compat.reason);
      },
    });
    return;
  }

  pi.registerTool(createAgentTool({ spawn: forwardSpawn(holder) }));
  pi.registerTool(createResultTool({ query: forwardQuery(holder) }));
  pi.registerTool(createSteerTool({ query: forwardQuery(holder) }));
  pi.registerCommand(
    "agent",
    createStatusCommand({
      query: forwardQuery(holder),
      orphans: forwardOrphans(holder),
      notifier: forwardNotifier(holder),
      fleet: { idleBudgetMs: settings.budget.idleMs, clock: systemClock },
    }),
  );

  pi.on("session_start", async (_event, ctx) => {
    if (compat.warning) console.warn(`[pi-subagent] ${compat.warning}`);
    await types.reload();
    holder.current = buildStack(ctx);
    holder.current.notifier.reconcile(); // RC5: reconcile() is synchronous, never blocks startup.
  });

  pi.on("session_shutdown", async () => {
    const stack = holder.current;
    if (!stack) return;
    const drainMs = Math.min(settings.budget.abortGraceMs * 3, 15_000);
    const pending = stack.query
      .list()
      .filter((s) => !["completed", "failed", "timed_out", "aborted"].includes(s.status));
    await Promise.all(pending.map((s) => stack.query.stop(s.runId, "shutdown")));
    await stack.query.waitAll({ runIds: pending.map((s) => s.runId), waitMs: drainMs });
  });
}

/**
 * Each session_start rebuilds the stack (ctx.sessionManager is only
 * available there); tools/command are registered once at activate() time,
 * so they forward every call through `holder.current` at call time rather
 * than closing over a specific instance. Explicit per-method forwarding
 * (not a Proxy) keeps `this` binding correct for methods like
 * QueryService.waitAll() that call other methods on `this` internally.
 */
function requireStack(holder: { current?: Stack }): Stack {
  if (!holder.current) throw new Error("pi-subagent: no active session yet");
  return holder.current;
}
function forwardSpawn(holder: { current?: Stack }): SpawnService {
  return {
    spawn: (req) => requireStack(holder).spawn.spawn(req),
    spawnAndWait: (req) => requireStack(holder).spawn.spawnAndWait(req),
    abort: (runId, cause) => requireStack(holder).spawn.abort(runId, cause),
    waitAll: (opts) => requireStack(holder).spawn.waitAll(opts),
  };
}
function forwardQuery(holder: { current?: Stack }): QueryService {
  return {
    get: (runId) => requireStack(holder).query.get(runId),
    list: (filter) => requireStack(holder).query.list(filter),
    wait: (runId, opts) => requireStack(holder).query.wait(runId, opts),
    waitAll: (opts) => requireStack(holder).query.waitAll(opts),
    steer: (runId, text) => requireStack(holder).query.steer(runId, text),
    stop: (runId, cause) => requireStack(holder).query.stop(runId, cause),
  };
}
function forwardOrphans(holder: { current?: Stack }): OrphanRegistry {
  return {
    register: (r) => requireStack(holder).orphans.register(r),
    recordLateRecovered: (runId, gen) => requireStack(holder).orphans.recordLateRecovered(runId, gen),
    get recent() {
      return requireStack(holder).orphans.recent;
    },
    get totalCount() {
      return requireStack(holder).orphans.totalCount;
    },
    get lateRecoveredCount() {
      return requireStack(holder).orphans.lateRecoveredCount;
    },
    countInWindow: (ms) => requireStack(holder).orphans.countInWindow(ms),
    get byReason() {
      return requireStack(holder).orphans.byReason;
    },
    resetCircuit: (op) => requireStack(holder).orphans.resetCircuit(op),
  };
}
function forwardNotifier(holder: { current?: Stack }): Notifier {
  return {
    enqueue: (p) => requireStack(holder).notifier.enqueue(p),
    consume: (key, by) => requireStack(holder).notifier.consume(key, by),
    reconcile: (persisted) => requireStack(holder).notifier.reconcile(persisted),
    verifyPersisted: (keys) => requireStack(holder).notifier.verifyPersisted(keys),
    get stats() {
      return requireStack(holder).notifier.stats;
    },
    get degraded() {
      return requireStack(holder).notifier.degraded;
    },
  };
}
