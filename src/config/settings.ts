import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { DEFAULT_BUDGET } from "../core/deadline.js";
import type { AgentTypeConfig, DeadlineBudget, Millis } from "../core/types.js";
import { migrateTimeUnitsToSeconds, normalizeTimeUnits, secondsKeyOf } from "./time-units.js";

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

/**
 * bash auto-background (§6): the `bashJobs` settings block backing the bash
 * tool override and its BashJobManager. Every field is validated field-by-field
 * by `parseBashJobsSettings` (never throws, illegal values fall back to the
 * default) exactly like `parseWorkflowSettings`.
 */
export interface BashJobsSettings {
  /** Foreground bash calls auto-background after this duration; 0 = whole feature off (no tool override registered). Default 290_000 — 4m50s, just under the 5-minute prompt-cache TTL, so the early return rarely triggers a cache-miss price jump (R2). */
  autoBackgroundMs: number;
  /** Per-job log file cap in bytes; older output is truncated past this. Default 10 MiB. */
  maxLogBytes: number;
  /** Hard cap on concurrently running background jobs (§3.8). Default 8. */
  maxBackgroundJobs: number;
  /** Terminal job records/log files are pruned after this age. Default 24h; <= 0 disables pruning. */
  retentionMs: number;
  /** Post-exit log drain cap. Invalid values fall back to the 30s default. */
  drainTimeoutMs: number;
  /** What to do with still-running jobs on session shutdown (§3.7). Default "keep". */
  shutdownPolicy: "keep" | "kill";
  /** Job state/log root; each session uses a sanitized child directory. */
  dir?: string;
  /** Shell used to run job commands; defaults to the $SHELL whitelist → bash (§3.3) when unset. */
  shellPath?: string;
}

export interface AgentSettings {
  concurrencyLimit: number;
  budget: DeadlineBudget;
  deliveryAttempts: number;
  deliveryBackoffMs: number;
  /** Foreground Agent calls auto-background after this duration; 0 disables. */
  foregroundAutoBackgroundMs: number;
  reconcileTtlMs: number;
  maxReconcileRounds: number;
  maxReconcileBatch: number;
  coalesceWindowMs: number;
  coalesceMaxBatch: number;
  ackWindowMs: number;
  rememberAgents: boolean;
  worktree: { enabled: boolean; gitTimeoutMs: number };
  /** X3: hard cap on nested-delegation depth (top-level run = depth 0). Exceeding this is rejected at spawn time as a config error, never silently truncated. */
  maxNestedDepth: number;
  /** X7b: always-on agent-tree widget pinned above the editor while subagent runs are active. Default true. */
  fleetWidget: boolean;
  /** CC3: workflow engine settings (M3.1+ feature surface). Default disabled. */
  workflow: WorkflowSettings;
  /** bash auto-background settings (§6). Enabled by default (R4). */
  bashJobs: BashJobsSettings;
}
export const DEFAULT_SETTINGS: AgentSettings = {
  concurrencyLimit: 6,
  budget: DEFAULT_BUDGET,
  deliveryAttempts: 3,
  deliveryBackoffMs: 1_000,
  foregroundAutoBackgroundMs: 600_000,
  reconcileTtlMs: 24 * 60 * 60 * 1_000,
  maxReconcileRounds: 3,
  maxReconcileBatch: 10,
  coalesceWindowMs: 0,
  coalesceMaxBatch: 8,
  ackWindowMs: 0,
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
  bashJobs: {
    autoBackgroundMs: 290_000,
    maxLogBytes: 10_485_760,
    maxBackgroundJobs: 8,
    retentionMs: 24 * 60 * 60 * 1_000,
    drainTimeoutMs: 30_000,
    shutdownPolicy: "keep",
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
/**
 * Every dotted path in `AgentSettings` that holds a **duration**, named in the
 * internal millisecond form. The settings *file* stores each of these under
 * `secondsKeyOf(path)` (`budget.idleMs` → `budget.idleS`) as integer seconds;
 * see `config/time-units.ts` for the boundary rules.
 *
 * Derived from the two budget defaults so a new timeout field cannot be added
 * without also being unit-converted (the only hand-written entries are the
 * flat ones). `budget.startupRetries` is a retry *count*, not a duration, and
 * is excluded by the `Ms` suffix test.
 */
export const TIME_SETTING_MS_PATHS: readonly string[] = [
  ...Object.keys(DEFAULT_BUDGET)
    .filter((k) => k.endsWith("Ms"))
    .map((k) => `budget.${k}`),
  "deliveryBackoffMs",
  "foregroundAutoBackgroundMs",
  "reconcileTtlMs",
  "coalesceWindowMs",
  "ackWindowMs",
  "worktree.gitTimeoutMs",
  "workflow.replayTtlMs",
  ...Object.keys(DEFAULT_WORKFLOW_BUDGET)
    .filter((k) => k.endsWith("Ms"))
    .map((k) => `workflow.budget.${k}`),
  "bashJobs.autoBackgroundMs",
  "bashJobs.drainTimeoutMs",
  "bashJobs.retentionMs",
];

const TIME_SETTING_SECONDS_PATHS: ReadonlySet<string> = new Set(TIME_SETTING_MS_PATHS.map(secondsKeyOf));

/** True for the *storage/display* key of a duration field (`budget.idleS`, `ackWindowS`, …). */
export function isTimeSettingKey(secondsKey: string): boolean {
  return TIME_SETTING_SECONDS_PATHS.has(secondsKey);
}

/**
 * Parse a settings-file object into the internal (millisecond) `AgentSettings`.
 *
 * Time fields arrive as integer seconds under `*S` keys and are converted to
 * milliseconds up front by `normalizeTimeUnits`, so every field validator
 * below still reasons in milliseconds. Legacy `*Ms` keys are tolerated
 * silently here; `loadSettingsFromFile` is the one that WARNs and rewrites.
 */
export function loadSettings(source: unknown): AgentSettings {
  if (source === null || typeof source !== "object") return { ...DEFAULT_SETTINGS, budget: { ...DEFAULT_BUDGET } };
  const value = normalizeTimeUnits(source as Record<string, unknown>, TIME_SETTING_MS_PATHS);
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
    foregroundAutoBackgroundMs:
      typeof value.foregroundAutoBackgroundMs === "number" &&
      Number.isFinite(value.foregroundAutoBackgroundMs) &&
      value.foregroundAutoBackgroundMs >= 0
        ? value.foregroundAutoBackgroundMs
        : DEFAULT_SETTINGS.foregroundAutoBackgroundMs,
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
    coalesceWindowMs:
      typeof value.coalesceWindowMs === "number" && Number.isFinite(value.coalesceWindowMs)
        ? Math.min(5_000, Math.max(0, value.coalesceWindowMs))
        : DEFAULT_SETTINGS.coalesceWindowMs,
    coalesceMaxBatch:
      typeof value.coalesceMaxBatch === "number" && Number.isFinite(value.coalesceMaxBatch)
        ? Math.max(1, Math.floor(value.coalesceMaxBatch))
        : DEFAULT_SETTINGS.coalesceMaxBatch,
    ackWindowMs:
      typeof value.ackWindowMs === "number" && Number.isFinite(value.ackWindowMs)
        ? Math.min(5_000, Math.max(0, value.ackWindowMs))
        : DEFAULT_SETTINGS.ackWindowMs,
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
    bashJobs: parseBashJobsSettings(value.bashJobs),
  });
}

/**
 * §6: parse the optional `bashJobs` settings block. Malformed/missing input
 * falls back field-by-field to DEFAULT_SETTINGS.bashJobs; never throws.
 * Numbers must be finite and >= 0, `shutdownPolicy` is whitelisted, and the
 * optional string fields are dropped unless they are non-empty strings
 * (exactOptionalPropertyTypes: absent, not `undefined`).
 */
export function parseBashJobsSettings(input: unknown): BashJobsSettings {
  const defaults = DEFAULT_SETTINGS.bashJobs;
  if (!input || typeof input !== "object" || Array.isArray(input)) return { ...defaults };
  const value = input as Record<string, unknown>;
  const num = (raw: unknown, fallback: number): number =>
    typeof raw === "number" && Number.isFinite(raw) && raw >= 0 ? raw : fallback;
  const str = (raw: unknown): string | undefined => (typeof raw === "string" && raw.length > 0 ? raw : undefined);
  const dir = str(value.dir);
  const shellPath = str(value.shellPath);
  return {
    autoBackgroundMs: num(value.autoBackgroundMs, defaults.autoBackgroundMs),
    maxLogBytes: num(value.maxLogBytes, defaults.maxLogBytes),
    maxBackgroundJobs: num(value.maxBackgroundJobs, defaults.maxBackgroundJobs),
    retentionMs: num(value.retentionMs, defaults.retentionMs),
    drainTimeoutMs:
      typeof value.drainTimeoutMs === "number" &&
      Number.isFinite(value.drainTimeoutMs) &&
      value.drainTimeoutMs > 0 &&
      Number.isInteger(value.drainTimeoutMs)
        ? value.drainTimeoutMs
        : defaults.drainTimeoutMs,
    shutdownPolicy:
      value.shutdownPolicy === "keep" || value.shutdownPolicy === "kill"
        ? value.shutdownPolicy
        : defaults.shutdownPolicy,
    ...(dir === undefined ? {} : { dir }),
    ...(shellPath === undefined ? {} : { shellPath }),
  };
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
 *
 * This is also the single migration point for the millisecond → second storage
 * rename (requirement 2): it is the only place that holds the raw JSON, the
 * file path, write access and a console at the same time. Legacy `*Ms` keys
 * are rewritten to integer-second `*S` keys, the user is told what happened,
 * and the file is written back so the migration runs once. A failed write-back
 * is only a WARN — the in-memory settings are already migrated.
 */
export function loadSettingsFromFile(path: string = defaultSettingsPath()): AgentSettings {
  try {
    if (!existsSync(path)) return loadSettings(undefined);
    const parsed: unknown = JSON.parse(readFileSync(path, "utf8"));
    if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) return loadSettings(parsed);
    return loadSettings(migrateSettingsFileTimeUnits(parsed as Record<string, unknown>, path));
  } catch (error) {
    console.warn(
      `[pi-subagent] failed to parse ${path}: ${error instanceof Error ? error.message : String(error)}; using defaults.`,
    );
    return loadSettings(undefined);
  }
}

/**
 * Rewrite legacy millisecond keys in a just-read settings file to the new
 * integer-second keys, WARN about every conversion/drop, and persist the
 * result. Returns the migrated object (used even when the write fails).
 * Never throws — same field-level tolerance as the rest of the loader.
 */
function migrateSettingsFileTimeUnits(raw: Record<string, unknown>, path: string): Record<string, unknown> {
  const migration = migrateTimeUnitsToSeconds(raw, TIME_SETTING_MS_PATHS);
  if (!migration.changed) return raw;
  if (migration.converted.length)
    console.warn(
      `[pi-subagent] ${path}: time settings are now stored in seconds; migrated ${migration.converted.length} key(s): ${migration.converted.join(", ")}`,
    );
  for (const warning of migration.warnings) console.warn(`[pi-subagent] ${path}: ${warning}`);
  try {
    writeFileSync(path, JSON.stringify(migration.value, null, 2) + "\n", "utf8");
  } catch (error) {
    console.warn(
      `[pi-subagent] failed to write the migrated ${path}: ${error instanceof Error ? error.message : String(error)}; the migration will be retried next time.`,
    );
  }
  return migration.value;
}

/**
 * Persist a single settings override to the user settings file (backs
 * `/agent settings set|reset` and the TUI editor). `dottedKey` is a *storage*
 * path like "budget.idleS" or "worktree.enabled" — duration keys use their
 * second-valued `*S` name; value === undefined removes the override (and
 * prunes parent objects left empty). Other fields are preserved. Returns an
 * error message on failure, undefined on success; never throws — a
 * malformed existing file is reported rather than silently clobbered.
 */
export function persistSettingOverride(
  dottedKey: string,
  value: unknown,
  path: string = defaultSettingsPath(),
): string | undefined {
  let raw: Record<string, unknown> = {};
  try {
    if (existsSync(path)) {
      const parsed: unknown = JSON.parse(readFileSync(path, "utf8"));
      if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed))
        return `${path}: top-level value is not an object; not modifying it`;
      raw = parsed as Record<string, unknown>;
    }
  } catch (error) {
    return `${path}: ${error instanceof Error ? error.message : String(error)}`;
  }
  const segments = dottedKey.split(".");
  let node: Record<string, unknown> = raw;
  for (const segment of segments.slice(0, -1)) {
    const child = node[segment];
    const next =
      child !== null && typeof child === "object" && !Array.isArray(child)
        ? { ...(child as Record<string, unknown>) }
        : {};
    node[segment] = next;
    node = next;
  }
  const leaf = segments[segments.length - 1]!;
  if (value === undefined) delete node[leaf];
  else node[leaf] = value;
  try {
    writeFileSync(path, JSON.stringify(raw, null, 2) + "\n", "utf8");
    return undefined;
  } catch (error) {
    return `${path}: ${error instanceof Error ? error.message : String(error)}`;
  }
}
