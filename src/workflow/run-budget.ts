import type { AgentSettings, WorkflowBudget as SettingsWorkflowBudget } from "../config/settings.js";
import { DEFAULT_WORKFLOW_BUDGET } from "../config/settings.js";
import type { WorkflowRunBudget } from "./types.js";

/**
 * M3.6 (workflow design §11 M3.6, §4.1/§4.4.3): the one place that turns
 * `AgentSettings.workflow` (the user-facing, partial, CC3 settings surface)
 * into a fully-populated `WorkflowRunBudget` `Orchestrator.run()` actually
 * needs. Kept out of `stack.ts` (assembly-only per D7/I7) so it is
 * independently unit-testable without booting a whole session stack.
 *
 * Fields with no `settings.workflow.budget` surface yet (`heartbeatMs`,
 * `maxParallel`, `maxChildren`, `maxBatchItems`, `reconcileMs`,
 * `cancelRetryWindowMs`, `journalFlushMs`, `childBudgetPolicy`) fall back to
 * the design's own defaults (§4.1/§5.3/§12 RW5) rather than being exposed as
 * new settings keys \u2014 CC3's settings-surface discipline ("非必要不新增...
 * 运行时参数优先通过 Dashboard + PersistenceStore 配置") applies to the
 * *tool/CLI* layer, not to every internal timeout; a future milestone can
 * promote any of these to a real setting without a `WorkflowRunBudget`
 * shape change.
 */
export function buildWorkflowRunBudget(settings: AgentSettings): WorkflowRunBudget {
  const merged: SettingsWorkflowBudget = { ...DEFAULT_WORKFLOW_BUDGET, ...settings.workflow.budget };
  // RW5: always leave >=1 slot in the core SlotPool for ordinary (non-workflow)
  // Agent runs — a workflow's own local concurrency gate is *on top of*,
  // never a replacement for, T1's queue-timeout protection.
  const maxParallel = Math.max(1, Math.min(4, settings.concurrencyLimit - 1));
  return {
    scriptLoadMs: merged.scriptLoadMs,
    scriptSliceMs: merged.scriptSliceMs,
    workerBootMs: merged.workerBootMs,
    heartbeatMs: 250,
    heartbeatStallMs: merged.heartbeatStallMs,
    terminateConfirmMs: merged.terminateConfirmMs,
    workflowTotalMs: merged.workflowTotalMs,
    runawayPolicy: settings.workflow.runawayPolicy,
    hostCallMs: merged.hostCallMs,
    gateMs: merged.gateMs,
    maxParallel,
    maxChildren: 500,
    maxBatchItems: 1024,
    childBudgetPolicy: "inherit_remaining",
    abortGraceMs: merged.abortGraceMs,
    reconcileMs: 1_000,
    replayTtlMs: settings.workflow.replayTtlMs,
    journalFlushMs: 2_000,
    ...(merged.phaseTotalMs > 0 ? { phaseTotalMs: merged.phaseTotalMs } : {}),
  };
}
