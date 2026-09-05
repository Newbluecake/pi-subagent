import { DEFAULT_BUDGET } from "../core/deadline.js";
import {
  DEFAULT_SETTINGS,
  DEFAULT_WORKFLOW_BUDGET,
  isTimeSettingKey,
  type AgentSettings,
  type WorkflowBudget,
} from "./settings.js";
import type { DeadlineBudget } from "../core/types.js";
import { getPath, msKeyOf, msToSeconds, secondsKeyOf, secondsToMs, setPath } from "./time-units.js";

/**
 * The settable surface shared by `/agent settings` (text command) and the
 * `/agent settings` TUI editor (`src/ui/settings-editor.ts`).
 *
 * Keys are **storage/display keys**: durations use their integer-second `*S`
 * name (`budget.idleS`), while `spec.path` points at the internal
 * millisecond field in `AgentSettings` (`budget.idleMs`). That split is the
 * whole time-unit design — one table, two domains, conversion in exactly one
 * place (`toStored` / `toLive` below).
 *
 * Order = listing order in both surfaces.
 */
export interface SettingSpecBase {
  /** Dotted path inside `AgentSettings`; milliseconds when `time` is set. */
  path: string;
  /** The stored/displayed value is integer seconds while `path` holds milliseconds. */
  time?: true;
  /** Read at spawn time (`budget.*`) ⇒ applies to new runs immediately; everything else needs `/reload`. */
  live?: true;
  /** Effective default when `DEFAULT_SETTINGS` leaves the path unset (`workflow.budget.*`). */
  fallback?: number;
  /** One-line help shown by the editor. */
  hint?: string;
  /** What the knob does, shown in the editor's description column. */
  description?: string;
}
export type SettingSpec = SettingSpecBase &
  (
    | { kind: "number"; min?: number; max?: number; integer?: true }
    | { kind: "boolean" }
    | { kind: "enum"; values: readonly string[] }
    | { kind: "string" }
  );

/** Integer-second duration knob. `min` defaults to 0, where 0 disables the timeout. */
function seconds(
  path: string,
  options: { max?: number; live?: true; hint?: string; description?: string } = {},
): SettingSpec {
  return {
    kind: "number",
    path,
    time: true,
    integer: true,
    min: 0,
    ...(options.max === undefined ? {} : { max: options.max }),
    ...(options.live ? { live: options.live } : {}),
    ...(options.hint === undefined ? {} : { hint: options.hint }),
    ...(options.description === undefined ? {} : { description: options.description }),
  };
}
/** Integer-second duration knob whose effective default lives in DEFAULT_WORKFLOW_BUDGET. */
function workflowSeconds(leaf: keyof WorkflowBudget): SettingSpec {
  return {
    ...seconds(`workflow.budget.${leaf}`, { description: WORKFLOW_BUDGET_DESCRIPTIONS[leaf] }),
    fallback: msToSeconds(DEFAULT_WORKFLOW_BUDGET[leaf]),
  };
}
function count(path: string, min = 0, description?: string): SettingSpec {
  return { kind: "number", path, min, integer: true, ...(description === undefined ? {} : { description }) };
}
function bool(path: string, description?: string): SettingSpec {
  return { kind: "boolean", path, ...(description === undefined ? {} : { description }) };
}
function choice(path: string, values: readonly string[], description?: string): SettingSpec {
  return { kind: "enum", path, values, ...(description === undefined ? {} : { description }) };
}

/** One-line per-leaf descriptions for the run deadline budget. */
const BUDGET_DESCRIPTIONS: Record<keyof DeadlineBudget, string> = {
  queueWaitMs: "Max wait for a concurrency slot",
  startupMs: "Subagent process startup timeout",
  bindMs: "Session bind timeout after spawn",
  firstEventMs: "Wait for the first session event",
  idleMs: "Max silence between session events",
  modelTurnMs: "Hard cap on one model turn; 0 = unlimited",
  toolMs: "Single tool call timeout",
  compactionMs: "Context compaction timeout",
  totalMs: "Overall run cap; 0 = no cap",
  abortGraceMs: "Grace after abort before force-kill",
  steerMs: "Steer message delivery timeout",
  reapMs: "Reaper sweep timeout",
  retrySlackMs: "Extra idle slack per startup retry",
  startupRetries: "Startup retry attempts",
};

/** One-line per-leaf descriptions for the workflow engine budget. */
const WORKFLOW_BUDGET_DESCRIPTIONS: Record<keyof WorkflowBudget, string> = {
  scriptLoadMs: "Workflow script load timeout",
  scriptSliceMs: "Per-slice script execution budget",
  workerBootMs: "Workflow worker boot timeout",
  hostCallMs: "Host call (agent/tool) timeout",
  gateMs: "User gate wait timeout",
  phaseTotalMs: "Per-phase cap; 0 = unlimited",
  workflowTotalMs: "Overall workflow cap",
  heartbeatStallMs: "Heartbeat stall diagnostic threshold",
  abortGraceMs: "Abort grace before worker teardown",
  terminateConfirmMs: "Worker terminate confirm timeout",
};

const BUDGET_SPECS: Record<string, SettingSpec> = Object.fromEntries(
  (Object.keys(DEFAULT_BUDGET) as (keyof DeadlineBudget)[]).map((leaf) =>
    leaf === "startupRetries"
      ? ([`budget.${leaf}`, { ...count(`budget.${leaf}`, 0, BUDGET_DESCRIPTIONS[leaf]), live: true }] as [
          string,
          SettingSpec,
        ])
      : [
          secondsKeyOf(`budget.${leaf}`),
          seconds(`budget.${leaf}`, { live: true, description: BUDGET_DESCRIPTIONS[leaf] }),
        ],
  ),
);

const WORKFLOW_BUDGET_SPECS: Record<string, SettingSpec> = Object.fromEntries(
  (Object.keys(DEFAULT_WORKFLOW_BUDGET) as (keyof WorkflowBudget)[]).map((leaf) => [
    `workflow.budget.${secondsKeyOf(leaf)}`,
    workflowSeconds(leaf),
  ]),
);

export const SETTING_SPECS: Record<string, SettingSpec> = {
  ...BUDGET_SPECS,
  concurrencyLimit: count("concurrencyLimit", 0, "Max concurrent subagent runs"),
  maxNestedDepth: count("maxNestedDepth", 0, "Max nested delegation depth"),
  rememberAgents: bool("rememberAgents", "Remember the agent registry across sessions"),
  fleetWidget: bool("fleetWidget", "Pin the live agent tree above the editor"),
  resultMaxChars: {
    ...count("resultMaxChars", 0, "Max chars of subagent result text returned; 0 = no cap"),
    live: true,
  },
  deliveryAttempts: count("deliveryAttempts", 1, "Notification delivery attempts"),
  deliveryBackoffS: seconds("deliveryBackoffMs", { description: "Backoff between delivery attempts" }),
  reconcileTtlS: seconds("reconcileTtlMs", { description: "Retention of delivered records for reconcile" }),
  foregroundAutoBackgroundS: seconds("foregroundAutoBackgroundMs", {
    hint: "0 disables foreground auto-background",
    description: "Auto-background foreground Agent calls after this",
  }),
  maxReconcileRounds: count("maxReconcileRounds", 0, "Max reconcile rounds per flush"),
  maxReconcileBatch: count("maxReconcileBatch", 1, "Max deliveries reconciled per round"),
  coalesceWindowS: seconds("coalesceWindowMs", {
    max: 5,
    hint: "0 disables coalescing; max 5s",
    description: "Hold window to merge notifications",
  }),
  coalesceMaxBatch: count("coalesceMaxBatch", 1, "Max notifications per coalesced batch"),
  ackWindowS: seconds("ackWindowMs", {
    max: 5,
    hint: "0 disables the ack hold window; max 5s",
    description: "Hold window suppressing caller-acked deliveries",
  }),
  "worktree.enabled": bool("worktree.enabled", "Isolate subagents in git worktrees"),
  "worktree.gitTimeoutS": seconds("worktree.gitTimeoutMs", { description: "Git command timeout for worktree ops" }),
  "workflow.enabled": bool("workflow.enabled", "Master switch for SubagentWorkflow"),
  "workflow.replayTtlS": seconds("workflow.replayTtlMs", { description: "Journal replay retention; 0 = unlimited" }),
  "workflow.replayScope": choice("workflow.replayScope", ["chain", "content"], "Replay cache match scope"),
  "workflow.runawayPolicy": choice(
    "workflow.runawayPolicy",
    ["diagnose_only", "terminate_on_stall"],
    "Action when the workflow heartbeat stalls",
  ),
  "workflow.journalDir": { kind: "string", path: "workflow.journalDir", description: "Workflow journal directory" },
  ...WORKFLOW_BUDGET_SPECS,
  // bash auto-background (§6): v1 exposes the numeric knobs plus the shutdown
  // policy enum; bashJobs.dir / bashJobs.shellPath stay JSON-file-only.
  // bashJobs.dir is the root for per-session job directories.
  "bashJobs.autoBackgroundS": seconds("bashJobs.autoBackgroundMs", {
    hint: "0 turns the whole feature off",
    description: "Auto-background foreground bash after this",
  }),
  "bashJobs.maxLogBytes": {
    kind: "number",
    path: "bashJobs.maxLogBytes",
    min: 0,
    description: "Per-job log file cap in bytes",
  },
  "bashJobs.maxBackgroundJobs": count("bashJobs.maxBackgroundJobs", 0, "Max concurrent background jobs"),
  "bashJobs.drainTimeoutS": seconds("bashJobs.drainTimeoutMs", {
    max: 600,
    hint: "values under 1s fall back to the 30s default",
    description: "Bounded wait for post-exit log tail capture",
  }),
  "bashJobs.retentionS": seconds("bashJobs.retentionMs", {
    description: "Terminal job records pruned after this age",
  }),
  "bashJobs.shutdownPolicy": choice(
    "bashJobs.shutdownPolicy",
    ["keep", "kill"],
    "What to do with running jobs on shutdown",
  ),
};

/** Live settings object + persistence port, shared by the command and the editor. */
export interface SettingsStore {
  /** Live AgentSettings object — mutated in place. `budget.*` values are read
   *  at spawn time (spawn-service mergeBudget), so they apply to new runs
   *  immediately; all other settings are captured at activate/session build
   *  and take effect after `/reload`. */
  current: AgentSettings;
  /** Persist one override to the settings file (undefined = remove). Returns an error message or undefined. */
  persist: (dottedKey: string, value: unknown) => string | undefined;
  /** Settings file path, shown in messages. */
  path: string;
}

/** Listing order, optionally scoped to the `/agent budget` alias. */
export function settingKeys(budgetOnly = false): string[] {
  return Object.keys(SETTING_SPECS).filter((k) => !budgetOnly || k.startsWith("budget."));
}

export function isKnownSettingKey(key: string, budgetOnly = false): boolean {
  return Object.hasOwn(SETTING_SPECS, key) && (!budgetOnly || key.startsWith("budget."));
}

/** Effective default in the *stored* domain (seconds for duration keys). */
export function defaultOf(spec: SettingSpec): unknown {
  const internal = getPath(DEFAULT_SETTINGS, spec.path);
  if (internal === undefined) return spec.fallback;
  return spec.time && typeof internal === "number" ? msToSeconds(internal) : internal;
}

/** Current value in the *stored* domain; falls back to the effective default when unset. */
export function currentOf(current: AgentSettings, spec: SettingSpec): unknown {
  const internal = getPath(current, spec.path);
  if (internal === undefined) return defaultOf(spec);
  return spec.time && typeof internal === "number" ? msToSeconds(internal) : internal;
}

/** True when the live value differs from the effective default. */
export function isOverridden(current: AgentSettings, spec: SettingSpec): boolean {
  return formatSettingValue(currentOf(current, spec)) !== formatSettingValue(defaultOf(spec));
}

export function formatSettingValue(value: unknown): string {
  return value === undefined ? "(unset)" : String(value);
}

/** `applies to new runs immediately` (budget.*) vs `takes effect after /reload`. */
export function effectOf(spec: SettingSpec): string {
  return spec.live ? "applies to new runs immediately" : "takes effect after /reload";
}

export type ParsedSetting = { ok: true; stored: unknown; live: unknown } | { ok: false; error: string };

/**
 * Parse user input for one setting. Duration values are validated in the
 * **second** domain (integer, min/max in seconds) and only then converted, so
 * error messages match what the user typed and `coalesceWindowS`'s 5s ceiling
 * reads as `<= 5` rather than `<= 5000`.
 */
export function parseSettingValue(spec: SettingSpec, raw: string): ParsedSetting {
  switch (spec.kind) {
    case "number": {
      const min = spec.min ?? 0;
      const value = Number(raw.trim());
      const bad =
        raw.trim() === "" ||
        !Number.isFinite(value) ||
        value < min ||
        (spec.max !== undefined && value > spec.max) ||
        ((spec.integer ?? false) && !Number.isInteger(value));
      if (bad) {
        const bound = spec.max === undefined ? `>= ${min}` : `between ${min} and ${spec.max}`;
        const unit = spec.time ? " seconds" : "";
        return { ok: false, error: `expected ${spec.integer ? "an integer" : "a number"} ${bound}${unit}` };
      }
      return { ok: true, stored: value, live: spec.time ? secondsToMs(value) : value };
    }
    case "boolean": {
      const v = raw.trim().toLowerCase();
      if (["true", "1", "yes", "on"].includes(v)) return { ok: true, stored: true, live: true };
      if (["false", "0", "no", "off"].includes(v)) return { ok: true, stored: false, live: false };
      return { ok: false, error: "expected true/false" };
    }
    case "enum":
      return spec.values.includes(raw)
        ? { ok: true, stored: raw, live: raw }
        : { ok: false, error: `expected one of: ${spec.values.join(", ")}` };
    case "string":
      return raw ? { ok: true, stored: raw, live: raw } : { ok: false, error: "expected a non-empty string" };
  }
}

export interface SettingWriteResult {
  key: string;
  /** Stored-domain rendering of the value before the write. */
  previous: string;
  /** Stored-domain rendering of the value after the write. */
  next: string;
  effect: string;
  /** Message from the persistence port; the in-memory change is kept regardless. */
  persistError?: string;
}

/** Mutate the live settings object and persist the stored (second-domain) value. */
export function writeSetting(
  store: SettingsStore,
  key: string,
  parsed: { stored: unknown; live: unknown },
): SettingWriteResult {
  const spec = SETTING_SPECS[key]!;
  const previous = formatSettingValue(currentOf(store.current, spec));
  setPath(store.current as unknown as Record<string, unknown>, spec.path, parsed.live);
  const persistError = store.persist(key, parsed.stored);
  return {
    key,
    previous,
    next: formatSettingValue(parsed.stored),
    effect: effectOf(spec),
    ...(persistError === undefined ? {} : { persistError }),
  };
}

/** Restore the default in the live object and remove the file override. */
export function resetSetting(store: SettingsStore, key: string): SettingWriteResult {
  const spec = SETTING_SPECS[key]!;
  const previous = formatSettingValue(currentOf(store.current, spec));
  setPath(store.current as unknown as Record<string, unknown>, spec.path, getPath(DEFAULT_SETTINGS, spec.path));
  const persistError = store.persist(key, undefined);
  return {
    key,
    previous,
    next: formatSettingValue(defaultOf(spec)),
    effect: effectOf(spec),
    ...(persistError === undefined ? {} : { persistError }),
  };
}

/** Re-exported for callers that only need the storage-key rename. */
export { isTimeSettingKey, msKeyOf, secondsKeyOf };
