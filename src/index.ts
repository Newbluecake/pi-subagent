import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { systemClock } from "./core/clock.js";
import { wireCacheTtl } from "./cache-ttl/cache-ttl.js";
import { MemoryOutboxStore, MemoryRunStore } from "./core/store.js";
import type { RunSnapshot, SubagentExtensionPoints, UsageDelta } from "./core/types.js";
import { assertCompatible, detectPiCapabilities, probeReadBackEntries } from "./adapters/pi-compat.js";
import { createPiOutboxStore } from "./adapters/pi-outbox-store.js";
import { FABRIC_ENTRY_CUSTOM_TYPE, createFabricEntryRenderer } from "./adapters/fabric-entry-renderer.js";
import { wrapWithRunLog } from "./adapters/pi-run-log.js";
import { appendAgentTypesToSystemPrompt, createAgentTypeRegistry } from "./config/agent-types.js";
import {
  defaultSettingsPath,
  loadSettingsFromFile,
  persistSettingOverride,
  type AgentSettings,
} from "./config/settings.js";
import { createNotifier, type Notifier, type PersistedDelivery } from "./delivery/notifier.js";
import { mergeExtensionPoints } from "./extensions/registry.js";
import { buildSessionStack, bashJobsEnabled, createNotificationReceiptHook, type Stack } from "./stack.js";
import { installMentionInput } from "./mention/mention.js";
import { createMentionAutocompleteProvider, type MentionAutocompleteEntry } from "./mention/autocomplete.js";
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
import { createAbortTool } from "./tools/abort-tool.js";
import { createCompactTool } from "./tools/compact-tool.js";
import { createBashTool } from "./tools/bash-tool.js";
import { createBashJobTool } from "./tools/bash-job-tool.js";
import type { BashJobManager } from "./bash/manager.js";
import { isTerminalJobStatus } from "./bash/types.js";
import { createStatusCommand } from "./commands/status.js";
import { createDisabledWorkflowToolStub, createWorkflowTool } from "./tools/workflow-tool.js";
import type { Orchestrator } from "./workflow/orchestrator.js";
import type { WorkflowActivityRegistry } from "./workflow/activity.js";
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
  wireCacheTtl(pi, settings);
  // Built FRESH per activate(): depending on pi's version, /reload either
  // re-runs activate on the cached module or re-imports a FRESH module (jiti
  // moduleCache:false). A module-level mutable array would accumulate
  // duplicate entries across same-module activations — the stale ones closing
  // over an invalidated pi (observed in the wild: H2 fan-out hit a dead
  // worktree extension and crashed the run).
  const extensionPoints: SubagentExtensionPoints[] = [wireWorktree(pi, settings)];
  const types = createAgentTypeRegistry();
  // Eager warm-up: session_start's awaited reload() is authoritative, but a
  // prompt injected before it completes (or a session flow that skips it)
  // would otherwise see an empty registry — no prompt section AND every
  // spawn rejected as "unknown agent type". Fire-and-forget is safe:
  // reload() never throws (per-file errors are collected) and a concurrent
  // session_start reload just re-assigns the same result.
  void types.reload();
  const caps = detectPiCapabilities(pi);
  const compat = assertCompatible(caps);
  const holder: { current?: Stack } = {};
  // Registered once per activate() (never inside buildSessionStack, which is
  // rebuilt per session_start and would accumulate duplicate handlers).
  // Handler lives in stack.ts so integration tests cover the real filter path.
  pi.on("message_start", createNotificationReceiptHook(holder));

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

  if (caps.canRenderEntries) {
    // Renderer lives in adapters/fabric-entry-renderer.ts and renders ONLY
    // delivered records: the fabric outbox store appends one entry per state
    // transition, and rendering each one duplicated every fabric message in
    // the chat (pending/claimed appends + delivered append).
    // Show the sender alongside kind: prefer the mention label (@name),
    // falling back to the raw runId when no label is registered.
    pi.registerEntryRenderer(
      FABRIC_ENTRY_CUSTOM_TYPE,
      createFabricEntryRenderer((runId) => {
        const mention = holder.current?.mention;
        if (!mention) return undefined;
        for (const label of mention.labels()) {
          if (mention.resolve(label)?.runId === runId) return label;
        }
        return undefined;
      }),
    );
  } else {
    console.warn("[pi-subagent] registerEntryRenderer unavailable; fabric display messages fall back to context");
  }
  pi.registerTool(
    createAgentTool({
      spawn: forwardSpawn(holder),
      // M-B: live foreground progress — snapshot reads from the query service,
      // terminal wait through the spawn service's own waiter (no unknown-run
      // race for a just-spawned id, unlike QueryService.wait).
      autoBackgroundMs: () => settings.foregroundAutoBackgroundMs,
      resultMaxChars: () => settings.resultMaxChars,
      progress: {
        getSnapshot: (runId) => holder.current?.query.get(runId),
        waitOutcome: (runId, waitMs) => requireStack(holder).spawn.waitOutcome(runId, waitMs),
        markAutoBackgrounded: (runId) => requireStack(holder).spawn.markAutoBackgrounded(runId),
      },
    }),
  );
  pi.registerTool(
    createResultTool({
      query: forwardQuery(holder),
      resolveRun: forwardResolveRun(holder),
      notifier: forwardNotifier(holder),
      resultMaxChars: () => settings.resultMaxChars,
    }),
  );
  pi.registerTool(createSteerTool({ query: forwardQuery(holder), resolveRun: forwardResolveRun(holder) }));
  pi.registerTool(createAbortTool({ query: forwardQuery(holder), resolveRun: forwardResolveRun(holder) }));
  // HOST_KEY guard above means this registration is visible only in the main session.
  if (settings.compact.enabled) {
    pi.registerTool(createCompactTool({ sendUserMessage: (text) => pi.sendUserMessage(text) }));
  }
  // bash auto-background (§2.6/R6): the same-name `bash` override and its
  // `bash_job` management tool exist only when the feature is on — off means
  // pi's built-in bash stays in place with zero behaviour change.
  if (bashJobsEnabled(settings)) {
    pi.registerTool(
      createBashTool({
        manager: forwardBashJobs(holder),
        autoBackgroundMs: () => settings.bashJobs.autoBackgroundMs,
      }),
    );
    pi.registerTool(createBashJobTool({ manager: forwardBashJobs(holder) }));
  }
  // Inject the registered agent types into the system prompt: the model has
  // no other way to learn valid `subagent_type` values and otherwise burns
  // turns on trial-and-error "unknown agent type" failures. `types` reloads
  // on every session_start; list() is read at event time so .md edits are
  // picked up on the next turn. Child sessions never see this hook — their
  // activate() returns early on the HOST_KEY guard above.
  pi.on("before_agent_start", (event) => {
    const systemPrompt = appendAgentTypesToSystemPrompt(event.systemPrompt, types.list(), {
      foregroundAutoBackgroundMs: settings.foregroundAutoBackgroundMs,
    });
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
      resolveRun: forwardResolveRun(holder),
      orphans: forwardOrphans(holder),
      notifier: forwardNotifier(holder),
      workflow: { activity: { list: () => forwardWorkflow(holder).activity.list() }, now: () => systemClock.now() },
      bashJobs: { list: () => holder.current?.bashJobs?.list() ?? [] },
      mention: {
        entries: () => mentionAutocompleteEntries(holder),
      },
      settings: {
        // settings.budget is passed by reference into every session stack
        // (stack.ts) and read at spawn time (spawn-service mergeBudget), so
        // in-place budget.* mutation takes effect for new runs without a
        // reload. Other keys are captured at activate/session build — the
        // command tells the user to /reload for those.
        current: settings,
        persist: (key, value) => persistSettingOverride(key, value),
        path: defaultSettingsPath(),
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
      reassign: () => undefined, // label re-pointing is driven by the stack's onLabel wiring
    },
    query: forwardQuery(holder),
    spawn: forwardSpawn(holder),
  });

  pi.on("session_start", async (_event, ctx) => {
    if (compat.warning) console.warn(`[pi-subagent] ${compat.warning}`);
    // Defensive: if pi ever fires session_start without a paired shutdown,
    // stop the previous stack's timer/RPC surfaces so they cannot double-fire.
    if (holder.current) {
      holder.current.fleetWidget?.dispose();
      holder.current.scheduler.stop();
      holder.current.rpc.close();
      holder.current.fabric?.dispose();
    }
    await types.reload();
    const stack = buildSessionStack(pi, ctx, settings, types, [mergeExtensionPoints(extensionPoints)]);
    holder.current = stack;
    if (ctx.hasUI && typeof ctx.ui.addAutocompleteProvider === "function") {
      ctx.ui.addAutocompleteProvider((current) =>
        createMentionAutocompleteProvider(current, {
          entries: () => mentionAutocompleteEntries(holder),
        }),
      );
    }
    stack.notifier.reconcile();
    stack.fabric?.pump(); // RC5: synchronous, never blocks startup
    await stack.scheduler.start(); // X5
  });

  pi.on("session_shutdown", async (event) => {
    const stack = holder.current;
    if (!stack) return;
    // X7b: kill the fleet widget FIRST and unconditionally. pi's /reload
    // re-imports this extension as a fresh module (jiti moduleCache:false), so
    // the module-level previousFleetWidget handoff in buildSessionStack never
    // sees the pre-reload controller — and because the stale ctx.ui closures
    // keep working (setWidget has no assertActive), its self-rescheduling 1Hz
    // tick would otherwise outlive the session forever, pushing
    // setWidget(undefined) over the new session's frames: the agent tree
    // blinks off/on at the combined tick rate, worse with every reload.
    stack.fleetWidget?.dispose();
    stack.scheduler.stop(); // X5
    stack.rpc.close(); // X8
    // Fabric must freeze before run shutdown so late verdicts from the old
    // stack cannot write into the shared outbox; the next stack owns pending records.
    stack.fabric?.dispose();
    const drainMs = Math.min(settings.budget.abortGraceMs * 3, 15_000);
    const pending = stack.query
      .list()
      .filter((s) => !["completed", "failed", "timed_out", "aborted"].includes(s.status));
    await Promise.all(pending.map((s) => stack.query.stop(s.runId, "shutdown")));
    await stack.query.waitAll({ runIds: pending.map((s) => s.runId), waitMs: drainMs });
    // bash auto-background §3.7: reload/new/resume/fork always keep the
    // processes (the next stack adopts them); only a real `quit` consults
    // shutdownPolicy, and even `kill` is bounded best-effort — a background
    // job that refuses to die must never delay pi's exit.
    if (stack.bashJobs && event.reason === "quit" && settings.bashJobs.shutdownPolicy === "kill") {
      await killBashJobsBounded(stack.bashJobs, settings.budget.abortGraceMs);
    }
  });
}

/** §3.7 `shutdownPolicy: "kill"` — signal every live job, wait at most `graceMs`. */
async function killBashJobsBounded(bashJobs: BashJobManager, graceMs: number): Promise<void> {
  const live = bashJobs
    .list()
    .filter((record) => !isTerminalJobStatus(record.status) || bashJobs.hasOpenLocalHandle(record.jobId));
  if (live.length === 0) return;
  const kills = Promise.allSettled(live.map((record) => bashJobs.kill(record.jobId).catch(() => undefined)));
  await Promise.race([kills, new Promise<void>((resolve) => systemClock.setTimer(Math.max(0, graceMs), resolve))]);
}

/**
 * Each session_start rebuilds the stack (ctx.sessionManager is only
 * available there); tools/command are registered once at activate() time,
 * so they forward every call through `holder.current` at call time rather
 * than closing over a specific instance. Explicit per-method forwarding
 * (not a Proxy) keeps `this` binding correct for methods like
 * QueryService.waitAll() that call other methods on `this` internally.
 */
/** D-M7: live root-child mention view shared by the @ autocomplete wrapper
 *  and `/agent status`. Reads through the holder at call time, so wrappers
 *  registered on an earlier session_start keep seeing the rebuilt stack. */
export function mentionAutocompleteEntries(holder: { current?: Stack }): readonly MentionAutocompleteEntry[] {
  const stack = holder.current;
  if (!stack) return [];
  const terminal = new Set(["completed", "failed", "timed_out", "aborted"]);
  return stack.mention.labels().flatMap((label) => {
    const target = stack.mention.resolve(label);
    // v2 hard constraint: only root-direct runs are mentionable (D-M7).
    if (!target || target.parent !== "root") return [];
    const status = stack.query.get(target.runId)?.status;
    return [
      {
        label,
        type: target.type,
        runId: target.runId,
        status: status === "running" ? "running" : status && terminal.has(status) ? "settled" : "other",
      } satisfies MentionAutocompleteEntry,
    ];
  });
}

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
    waitOutcome: (runId, waitMs) => requireStack(holder).spawn.waitOutcome(runId, waitMs),
    expectsAck: (runId) => requireStack(holder).spawn.expectsAck(runId),
    markAutoBackgrounded: (runId) => requireStack(holder).spawn.markAutoBackgrounded(runId),
    // CC1: forwarded for parity with the rest of SpawnService; no caller yet
    // (the workflow orchestrator that will use this lands in M3.1+).
    stopChildrenOf: (parentId, cause) => requireStack(holder).spawn.stopChildrenOf(parentId, cause),
    resolveRun: (handle) => requireStack(holder).spawn.resolveRun(handle),
    resolveResume: (handle) => requireStack(holder).spawn.resolveResume(handle),
  };
}
function forwardResolveRun(holder: { current?: Stack }) {
  return (handle: string) => {
    const result = requireStack(holder).spawn.resolveRun?.(handle);
    if (!result) throw new Error("pi-subagent: run resolver unavailable");
    return result;
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
  usageOf(runId: string): UsageDelta | undefined;
  snapshotOf(runId: string): RunSnapshot | undefined;
} {
  return {
    get defaultBudget() {
      return requireStack(holder).workflow.defaultBudget;
    },
    get activity() {
      return requireStack(holder).workflow.activity;
    },
    createOrchestrator: (workflowId) => requireStack(holder).workflow.createOrchestrator(workflowId),
    // M8: child spend lookup for the workflow tool's aggregate usage.
    usageOf: (runId) => holder.current?.query.get(runId)?.diag.usage,
    // M10: live child snapshots for the workflow tool card's per-child rows
    // (same QueryService the Agent tool's M-B progress port reads).
    snapshotOf: (runId) => holder.current?.query.get(runId),
  };
}
/** bash auto-background: the current session's job manager (absent before the
 *  first session_start, or when the feature is off) — both bash tools read it
 *  at call time so they survive session rebuilds. */
function forwardBashJobs(holder: { current?: Stack }): () => BashJobManager | undefined {
  return () => holder.current?.bashJobs;
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
    enqueue: (p, opts) => requireStack(holder).notifier.enqueue(p, opts),
    finalize: (runId, generation, patch) => requireStack(holder).notifier.finalize(runId, generation, patch),
    settleBatch: (keys, ok) => requireStack(holder).notifier.settleBatch(keys, ok),
    ack: (runId, generation, by) => requireStack(holder).notifier.ack(runId, generation, by),
    peek: (key) => requireStack(holder).notifier.peek(key),
    consume: (key, by) => requireStack(holder).notifier.consume(key, by),
    reconcile: (persisted) => requireStack(holder).notifier.reconcile(persisted),
    verifyPersisted: (keys) => requireStack(holder).notifier.verifyPersisted(keys),
    get stats() {
      return requireStack(holder).notifier.stats;
    },
    get degraded() {
      return requireStack(holder).notifier.degraded;
    },
    get ackedSuppressions() {
      return requireStack(holder).notifier.ackedSuppressions;
    },
  };
}
