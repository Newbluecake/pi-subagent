import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { systemClock } from "./core/clock.js";
import { MemoryOutboxStore, MemoryRunStore } from "./core/store.js";
import type { SubagentExtensionPoints } from "./core/types.js";
import { assertCompatible, detectPiCapabilities, probeReadBackEntries } from "./adapters/pi-compat.js";
import { createPiOutboxStore } from "./adapters/pi-outbox-store.js";
import { wrapWithRunLog } from "./adapters/pi-run-log.js";
import { appendAgentTypesToSystemPrompt, createAgentTypeRegistry } from "./config/agent-types.js";
import { loadSettingsFromFile, type AgentSettings } from "./config/settings.js";
import { createNotifier, type Notifier, type PersistedDelivery } from "./delivery/notifier.js";
import { mergeExtensionPoints } from "./extensions/registry.js";
import { buildSessionStack, type Stack } from "./stack.js";
import { installMentionInput } from "./mention/mention.js";
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
import { createDisabledWorkflowToolStub, createWorkflowTool } from "./tools/workflow-tool.js";
import type { Orchestrator } from "./workflow/orchestrator.js";
import type { WorkflowActivityRegistry } from "./workflow/activity.js";
import { renderWorkflowFleetSection } from "./ui/workflow-fleet-section.js";
import type { WorkflowId, WorkflowRunBudget } from "./workflow/types.js";

/**
 * M2 Wave 1 (architecture §7.1): the single merge point for the four
 * documented extension hooks. Empty by default; future milestones (X1
 * worktree, X10 schema tools, etc.) push their SubagentExtensionPoints here
 * instead of inventing new mount points (I7: index.ts stays assembly-only).
 */
/** X1: worktree isolation (H2 rewrite cwd + H3 commit/remove). Default off; enable via settings worktree.enabled. Throws (→ failed(config)) when explicitly requested but unavailable — never silently falls back. */
function wireWorktree(pi: ExtensionAPI, settings: AgentSettings): SubagentExtensionPoints {
  return createPiWorktreeExtension(pi, settings.worktree);
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
  // Child subagent sessions bind extensions too (pi's bindExtensions), which
  // re-activates this extension inside every child. Without a guard, the
  // child instance registers its own Agent/SubagentWorkflow tools backed by
  // an empty stack — observed in the wild as "no active session yet" when a
  // subagent called SubagentWorkflow. The main-process instance is the host;
  // child instances stay inert (nested delegation uses X3's injected tool).
  //
  // The claim MUST be released on session_shutdown: pi's /reload clears the
  // extension cache and calls activate() again in the *same process*
  // (agent-session.ts reload() → emit session_shutdown(reason "reload") on the
  // old runner → resourceLoader.reload() → re-import → activate). A claim that
  // outlives its activation makes every post-reload instance inert — the whole
  // extension (Agent tool, /agent, hooks) silently disappears until pi is
  // restarted. Only the owning activation releases it, so a child session that
  // shuts down cannot hand the host role away.
  const HOST_KEY = Symbol.for("pi-subagent:host");
  const g = globalThis as Record<symbol, unknown>;
  if (g[HOST_KEY]) return;
  const claim = { activatedAt: Date.now() };
  g[HOST_KEY] = claim;
  // Registered before the compat gate below so even the disabled-stub path
  // releases its claim (otherwise a bad-compat activation would wedge every
  // later reload into the inert branch).
  pi.on("session_shutdown", () => {
    if (g[HOST_KEY] === claim) delete g[HOST_KEY];
  });

  const settings = loadSettingsFromFile();
  // Built FRESH per activate(): pi may re-run activate on the same cached
  // module (its /reload does not bust Node's module cache). A module-level
  // mutable array would accumulate duplicate entries across activations —
  // the stale ones closing over an invalidated pi (observed in the wild:
  // H2 fan-out hit a dead worktree extension and crashed the run).
  const extensionPoints: SubagentExtensionPoints[] = [wireWorktree(pi, settings)];
  const types = createAgentTypeRegistry();
  const caps = detectPiCapabilities(pi);
  const compat = assertCompatible(caps);
  const holder: { current?: Stack } = {};

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

  pi.registerTool(
    createAgentTool({
      spawn: forwardSpawn(holder),
      // M-B: live foreground progress — snapshot reads from the query service,
      // terminal wait through the spawn service's own waiter (no unknown-run
      // race for a just-spawned id, unlike QueryService.wait).
      progress: {
        getSnapshot: (runId) => holder.current?.query.get(runId),
        waitOutcome: async (runId) => (await requireStack(holder).spawn.waitAll({ runIds: [runId] })).settled[0],
      },
    }),
  );
  pi.registerTool(createResultTool({ query: forwardQuery(holder) }));
  pi.registerTool(createSteerTool({ query: forwardQuery(holder) }));
  // Inject the registered agent types into the system prompt: the model has
  // no other way to learn valid `subagent_type` values and otherwise burns
  // turns on trial-and-error "unknown agent type" failures. `types` reloads
  // on every session_start; list() is read at event time so .md edits are
  // picked up on the next turn. Child sessions never see this hook — their
  // activate() returns early on the HOST_KEY guard above.
  pi.on("before_agent_start", (event) => {
    const systemPrompt = appendAgentTypesToSystemPrompt(event.systemPrompt, types.list());
    return systemPrompt === event.systemPrompt ? undefined : { systemPrompt };
  });
  // CC3/M3.6: the workflow engine stays entirely inert (stub tool, clear
  // error message) unless settings.workflow.enabled — decided once here
  // rather than per-session, since `settings` itself is loaded once.
  pi.registerTool(
    settings.workflow.enabled ? createWorkflowTool(forwardWorkflow(holder)) : createDisabledWorkflowToolStub(),
  );
  pi.registerCommand(
    "agent",
    createStatusCommand({
      query: forwardQuery(holder),
      orphans: forwardOrphans(holder),
      notifier: forwardNotifier(holder),
      workflow: { activity: { list: () => forwardWorkflow(holder).activity.list() }, now: () => systemClock.now() },
      fleet: {
        idleBudgetMs: settings.budget.idleMs,
        clock: systemClock,
        extraSections: () => [renderWorkflowFleetSection(forwardWorkflow(holder).activity.list(), systemClock.now())],
      },
    }),
  );

  // X6: @handle mentions. Registered once; resolves through the current
  // session's stack like the tools above. Conservative by contract: unknown
  // labels and @file/paths fall through to pi untouched.
  installMentionInput(pi, {
    registry: {
      register: () => false, // registrations flow from spawn labels inside the stack
      resolve: (label) => holder.current?.mention.resolve(label),
      labels: () => holder.current?.mention.labels() ?? [],
    },
    query: forwardQuery(holder),
    spawn: forwardSpawn(holder),
  });

  pi.on("session_start", async (_event, ctx) => {
    if (compat.warning) console.warn(`[pi-subagent] ${compat.warning}`);
    // Defensive: if pi ever fires session_start without a paired shutdown,
    // stop the previous stack's timer/RPC surfaces so they cannot double-fire.
    if (holder.current) {
      holder.current.scheduler.stop();
      holder.current.rpc.close();
    }
    await types.reload();
    const stack = buildSessionStack(pi, ctx, settings, types, [mergeExtensionPoints(extensionPoints)]);
    holder.current = stack;
    stack.notifier.reconcile(); // RC5: synchronous, never blocks startup
    await stack.scheduler.start(); // X5
  });

  pi.on("session_shutdown", async () => {
    const stack = holder.current;
    if (!stack) return;
    stack.scheduler.stop(); // X5
    stack.rpc.close(); // X8
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
    // CC1: forwarded for parity with the rest of SpawnService; no caller yet
    // (the workflow orchestrator that will use this lands in M3.1+).
    stopChildrenOf: (parentId, cause) => requireStack(holder).spawn.stopChildrenOf(parentId, cause),
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
function forwardWorkflow(holder: { current?: Stack }): {
  defaultBudget: WorkflowRunBudget;
  activity: WorkflowActivityRegistry;
  createOrchestrator(workflowId: WorkflowId): Orchestrator;
} {
  return {
    get defaultBudget() {
      return requireStack(holder).workflow.defaultBudget;
    },
    get activity() {
      return requireStack(holder).workflow.activity;
    },
    createOrchestrator: (workflowId) => requireStack(holder).workflow.createOrchestrator(workflowId),
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
