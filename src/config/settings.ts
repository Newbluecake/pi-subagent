import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { DEFAULT_BUDGET } from "../core/deadline.js";
import type { AgentTypeConfig, DeadlineBudget, Millis } from "../core/types.js";

/**
 * CC3 (workflow design §3.2/§8.2): forward-declared budget shape for the
 * future workflow engine (M3.1+). Only the *type* and its settings-surface
 * defaults are introduced in this milestone — no orchestrator, no runner, no
 * scripts. Field defaults mirror the WT1–WT19 timeout matrix (§4.1).
 */
export interface WorkflowBudget {
  /** WT1 */ scriptLoadMs: Millis;
  /** WT2 */ scriptSliceMs: Millis;
  /** WT3 */ workerBootMs: Millis;
  /** WT4 */ hostCallMs: Millis;
  /** WT6 */ gateMs: Millis;
  /** WT7 (0 = unlimited, still bounded by workflowTotalMs) */ phaseTotalMs: Millis;
  /** WT8 */ workflowTotalMs: Millis;
  /** WT9 (diagnostic only, see RunawayPolicy) */ heartbeatStallMs: Millis;
  /** WT10 */ abortGraceMs: Millis;
  /** WT11 */ terminateConfirmMs: Millis;
}
export const DEFAULT_WORKFLOW_BUDGET: WorkflowBudget = {
  scriptLoadMs: 5_000,
  scriptSliceMs: 2_000,
  workerBootMs: 10_000,
  hostCallMs: 60_000,
  gateMs: 600_000,
  phaseTotalMs: 0,
  workflowTotalMs: 3_600_000,
  heartbeatStallMs: 10_000,
  abortGraceMs: 10_000,
  terminateConfirmMs: 2_000,
};
/**
 * CC3/§2.3 HB2–HB5: heartbeat stall is a diagnostic/fast-detection signal,
 * never the hard termination guarantee (that's the absolute workflowTotalMs
 * deadline, CC4). "diagnose_only" (default) never terminates on stall alone.
 */
export type RunawayPolicy = "diagnose_only" | "terminate_on_stall";
export interface WorkflowSettings {
  /** Master switch; the workflow engine (M3.1+) is entirely inert while false. */
  enabled: boolean;
  budget: Partial<WorkflowBudget>;
  journalDir?: string;
  /** Default 7 days (§6.4 RP6); 0 = unlimited. */
  replayTtlMs: number;
  replayScope: "chain" | "content";
  runawayPolicy: RunawayPolicy;
}

export interface AgentSettings {
  concurrencyLimit: number;
  budget: DeadlineBudget;
  startupMs?: number;
  deliveryAttempts: number;
  deliveryBackoffMs: number;
  reconcileTtlMs: number;
  maxReconcileRounds: number;
  maxReconcileBatch: number;
  rememberAgents: boolean;
  worktree: { enabled: boolean; gitTimeoutMs: number };
  /** X3: hard cap on nested-delegation depth (top-level run = depth 0). Exceeding this is rejected at spawn time as a config error, never silently truncated. */
  maxNestedDepth: number;
  /** X7b: always-on fleet widget pinned above the editor while subagent runs are active. The `/agent fleet` full-screen panel is unaffected by this switch. Default true. */
  fleetWidget: boolean;
  /** CC3: workflow engine settings (M3.1+ feature surface). Default disabled. */
  workflow: WorkflowSettings;
}
export const DEFAULT_SETTINGS: AgentSettings = {
  concurrencyLimit: 6,
  budget: DEFAULT_BUDGET,
  deliveryAttempts: 3,
  deliveryBackoffMs: 1_000,
  reconcileTtlMs: 24 * 60 * 60 * 1_000,
  maxReconcileRounds: 3,
  maxReconcileBatch: 10,
  rememberAgents: true,
  worktree: { enabled: false, gitTimeoutMs: 30_000 },
  maxNestedDepth: 3,
  fleetWidget: true,
  workflow: {
    enabled: false,
    budget: {},
    replayTtlMs: 7 * 24 * 60 * 60 * 1_000,
    replayScope: "chain",
    runawayPolicy: "diagnose_only",
  },
};
export function mergeBudget(...overrides: Array<Partial<DeadlineBudget> | undefined>): DeadlineBudget {
  return { ...DEFAULT_BUDGET, ...overrides.reduce((out, value) => ({ ...out, ...value }), {}) };
}
export function mergeSettings(base: Partial<AgentSettings> = {}, config?: AgentTypeConfig): AgentSettings {
  return {
    ...DEFAULT_SETTINGS,
    ...base,
    budget: mergeBudget(DEFAULT_SETTINGS.budget, base.budget, config?.budgetOverride),
  };
}
export function loadSettings(source: unknown): AgentSettings {
  if (source === null || typeof source !== "object") return { ...DEFAULT_SETTINGS, budget: { ...DEFAULT_BUDGET } };
  const value = source as Record<string, unknown>;
  const budget =
    value.budget && typeof value.budget === "object" ? (value.budget as Partial<DeadlineBudget>) : undefined;
  return mergeSettings({
    concurrencyLimit:
      typeof value.concurrencyLimit === "number" && value.concurrencyLimit >= 0
        ? value.concurrencyLimit
        : DEFAULT_SETTINGS.concurrencyLimit,
    budget: mergeBudget(budget),
    deliveryAttempts:
      typeof value.deliveryAttempts === "number"
        ? Math.max(1, value.deliveryAttempts)
        : DEFAULT_SETTINGS.deliveryAttempts,
    deliveryBackoffMs:
      typeof value.deliveryBackoffMs === "number"
        ? Math.max(0, value.deliveryBackoffMs)
        : DEFAULT_SETTINGS.deliveryBackoffMs,
    reconcileTtlMs:
      typeof value.reconcileTtlMs === "number" ? Math.max(0, value.reconcileTtlMs) : DEFAULT_SETTINGS.reconcileTtlMs,
    maxReconcileRounds:
      typeof value.maxReconcileRounds === "number"
        ? Math.max(0, value.maxReconcileRounds)
        : DEFAULT_SETTINGS.maxReconcileRounds,
    maxReconcileBatch:
      typeof value.maxReconcileBatch === "number"
        ? Math.max(1, value.maxReconcileBatch)
        : DEFAULT_SETTINGS.maxReconcileBatch,
    rememberAgents: typeof value.rememberAgents === "boolean" ? value.rememberAgents : DEFAULT_SETTINGS.rememberAgents,
    maxNestedDepth:
      typeof value.maxNestedDepth === "number" && value.maxNestedDepth >= 0
        ? Math.floor(value.maxNestedDepth)
        : DEFAULT_SETTINGS.maxNestedDepth,
    fleetWidget: typeof value.fleetWidget === "boolean" ? value.fleetWidget : DEFAULT_SETTINGS.fleetWidget,
    worktree:
      value.worktree && typeof value.worktree === "object"
        ? {
            enabled: (value.worktree as Record<string, unknown>).enabled === true,
            gitTimeoutMs:
              typeof (value.worktree as Record<string, unknown>).gitTimeoutMs === "number"
                ? ((value.worktree as Record<string, unknown>).gitTimeoutMs as number)
                : DEFAULT_SETTINGS.worktree.gitTimeoutMs,
          }
        : { ...DEFAULT_SETTINGS.worktree },
    workflow: parseWorkflowSettings(value.workflow),
  });
}

/** CC3: parse the optional `workflow` settings block; malformed/missing input falls back field-by-field to DEFAULT_SETTINGS.workflow (never throws, matches the rest of loadSettings' tolerance). */
function parseWorkflowSettings(input: unknown): WorkflowSettings {
  const defaults = DEFAULT_SETTINGS.workflow;
  if (!input || typeof input !== "object") return { ...defaults };
  const value = input as Record<string, unknown>;
  const budget = value.budget && typeof value.budget === "object" ? (value.budget as Partial<WorkflowBudget>) : {};
  const validBudgetKeys = Object.keys(DEFAULT_WORKFLOW_BUDGET) as (keyof WorkflowBudget)[];
  const cleanedBudget: Partial<WorkflowBudget> = {};
  for (const key of validBudgetKeys) {
    const v = budget[key];
    if (typeof v === "number" && v >= 0) cleanedBudget[key] = v;
  }
  return {
    enabled: typeof value.enabled === "boolean" ? value.enabled : defaults.enabled,
    budget: cleanedBudget,
    ...(typeof value.journalDir === "string" ? { journalDir: value.journalDir } : {}),
    replayTtlMs:
      typeof value.replayTtlMs === "number" && value.replayTtlMs >= 0 ? value.replayTtlMs : defaults.replayTtlMs,
    replayScope:
      value.replayScope === "chain" || value.replayScope === "content" ? value.replayScope : defaults.replayScope,
    runawayPolicy:
      value.runawayPolicy === "diagnose_only" || value.runawayPolicy === "terminate_on_stall"
        ? value.runawayPolicy
        : defaults.runawayPolicy,
  };
}

/** Default user-level settings file: ~/.pi/agent/pi-subagent.json */
export function defaultSettingsPath(): string {
  return join(homedir(), ".pi", "agent", "pi-subagent.json");
}

/**
 * Load user settings from a JSON file. Missing file → defaults; malformed
 * file → WARN + defaults. Never throws.
 */
export function loadSettingsFromFile(path: string = defaultSettingsPath()): AgentSettings {
  try {
    if (!existsSync(path)) return loadSettings(undefined);
    return loadSettings(JSON.parse(readFileSync(path, "utf8")));
  } catch (error) {
    console.warn(
      `[pi-subagent] failed to parse ${path}: ${error instanceof Error ? error.message : String(error)}; using defaults.`,
    );
    return loadSettings(undefined);
  }
}
