import type { Millis } from "../core/types.js";
import type { WorkflowId } from "./types.js";

/**
 * M3.6 (workflow design §9.3 Fleet UI / §9.4 `/agent status --workflow`):
 * the minimal live-activity view this milestone can honestly provide.
 *
 * Documented simplification (in the same spirit as every other M3.x
 * narrowing in this codebase): `Orchestrator` (orchestrator.ts) exposes
 * `outcomeAt1()`/`settled()` snapshots only *after* it has decided to stop
 * — there is no live "still running" snapshot API (no `WorkflowState`/
 * `reduceWorkflow` pure state machine backs it, see orchestrator.ts's own
 * module doc on what is and is not reproduced from the full §3.4 design).
 * So this registry never polls the engine; it tracks exactly what the tool
 * layer (the only caller of `Orchestrator.run()`) and the
 * `subagent:workflow:*` event stream already know: which workflows are
 * currently in flight, their declared name, when they started, their
 * absolute deadline, and their most recently entered `phase(title)` label.
 *
 * M10 (live workflow tool card) extends that bar with a per-child view —
 * still without touching `Orchestrator` internals: the data comes from
 * host.ts's `WorkflowChildEvent` feed (`subagent:workflow:child` events,
 * relayed by orchestrator.ts), i.e. the exact same chokepoint that records
 * `WorkflowOutcome.children`. "spawned" adds an active row (keyed by
 * callId), "settled" removes it and appends to a capped recent-settled
 * list with running totals. A "settled" with no preceding "spawned" (replay
 * hits, withheld calls, spawn-error paths — none of which ever announce a
 * spawn) is counted but has no active row to remove; duplicate settles of
 * the same callId count once (the map delete is idempotent, the totals are
 * guarded by a settled-callId set).
 */

/** M10: one in-flight child of a workflow run, as announced by host.ts's `"spawned"` event. */
export interface WorkflowChildActivity {
  readonly callId: string;
  readonly runId?: string;
  readonly label?: string;
  readonly agentType?: string;
  readonly phaseId?: string;
  readonly enteredAt: Millis;
}

/** M10: one recently settled child (capped list, most recent last) — feeds the tool card's ✓/✗ trail. */
export interface WorkflowSettledChild {
  readonly callId: string;
  readonly label?: string;
  readonly status: string;
  readonly source: "live" | "replay";
  readonly durationMs: Millis;
}

export interface WorkflowActivitySnapshot {
  readonly workflowId: WorkflowId;
  readonly name: string;
  readonly startedAt: Millis;
  readonly deadlineAt?: Millis;
  readonly currentPhaseId?: string;
  /** M10: children announced as spawned and not yet settled, in announcement order. */
  readonly activeChildren: readonly WorkflowChildActivity[];
  /** M10: most recent settled children (oldest dropped past `MAX_SETTLED_KEPT`). */
  readonly settledChildren: readonly WorkflowSettledChild[];
  /** M10: totals since run start (settledChildren is capped; these are not). */
  readonly settledTotal: number;
  readonly completedTotal: number;
  readonly replayTotal: number;
}

export interface WorkflowActivityRegistry {
  register(workflowId: WorkflowId, name: string, startedAt: Millis, deadlineAt?: Millis): void;
  /** Wired as (part of) the `Orchestrator`'s `emit` so `subagent:workflow:phase`/"child" events update the row without the tool needing to poll anything. */
  onEvent(channel: string, payload: unknown): void;
  unregister(workflowId: WorkflowId): void;
  list(): readonly WorkflowActivitySnapshot[];
}

/** M10: how many settled rows the snapshot keeps for display; `settledTotal` & friends stay exact regardless. */
const MAX_SETTLED_KEPT = 8;

interface MutableEntry {
  name: string;
  startedAt: Millis;
  deadlineAt?: Millis;
  currentPhaseId?: string;
  activeChildren: Map<string, WorkflowChildActivity>;
  settledChildren: WorkflowSettledChild[];
  settledCallIds: Set<string>;
  settledTotal: number;
  completedTotal: number;
  replayTotal: number;
}

function isPhaseEnterEvent(
  channel: string,
  payload: unknown,
): payload is { workflowId: WorkflowId; phaseId: string; kind: "enter" } {
  if (channel !== "subagent:workflow:phase" || payload === null || typeof payload !== "object") return false;
  const p = payload as Record<string, unknown>;
  return typeof p.workflowId === "string" && typeof p.phaseId === "string" && p.kind === "enter";
}

/** M10: the relayed `WorkflowChildEvent` plus the orchestrator-added `workflowId`. */
type ChildEventPayload = {
  workflowId: WorkflowId;
  callId: string;
  at: Millis;
  kind: "spawned" | "settled";
  runId?: string;
  label?: string;
  agentType?: string;
  phaseId?: string;
  status?: string;
  source?: "live" | "replay";
  durationMs?: Millis;
};

/** M10: structural validation for the relayed `WorkflowChildEvent` — unknown/malformed payloads are ignored, never fatal. */
function asChildEvent(channel: string, payload: unknown): ChildEventPayload | undefined {
  if (channel !== "subagent:workflow:child" || payload === null || typeof payload !== "object") return undefined;
  const p = payload as Record<string, unknown>;
  if (typeof p.workflowId !== "string" || typeof p.callId !== "string") return undefined;
  if (p.kind !== "spawned" && p.kind !== "settled") return undefined;
  if (typeof p.at !== "number") return undefined;
  return p as unknown as ChildEventPayload;
}

export function createWorkflowActivityRegistry(): WorkflowActivityRegistry {
  const entries = new Map<WorkflowId, MutableEntry>();
  return {
    register(workflowId, name, startedAt, deadlineAt) {
      entries.set(workflowId, {
        name,
        startedAt,
        ...(deadlineAt !== undefined ? { deadlineAt } : {}),
        activeChildren: new Map(),
        settledChildren: [],
        settledCallIds: new Set(),
        settledTotal: 0,
        completedTotal: 0,
        replayTotal: 0,
      });
    },
    onEvent(channel, payload) {
      const phase = isPhaseEnterEvent(channel, payload) ? payload : undefined;
      if (phase !== undefined) {
        const entry = entries.get(phase.workflowId);
        if (entry) entry.currentPhaseId = phase.phaseId;
        return;
      }
      const child = asChildEvent(channel, payload);
      if (child === undefined) return;
      const entry = entries.get(child.workflowId);
      if (!entry) return;
      if (child.kind === "spawned") {
        entry.activeChildren.set(child.callId, {
          callId: child.callId,
          ...(child.runId !== undefined ? { runId: child.runId } : {}),
          ...(child.label !== undefined ? { label: child.label } : {}),
          ...(child.agentType !== undefined ? { agentType: child.agentType } : {}),
          ...(child.phaseId !== undefined ? { phaseId: child.phaseId } : {}),
          enteredAt: child.at,
        });
        return;
      }
      // kind === "settled"
      entry.activeChildren.delete(child.callId);
      if (entry.settledCallIds.has(child.callId)) return; // defensive: count each call exactly once.
      entry.settledCallIds.add(child.callId);
      entry.settledTotal += 1;
      if (child.status === "completed") entry.completedTotal += 1;
      if (child.source === "replay") entry.replayTotal += 1;
      entry.settledChildren.push({
        callId: child.callId,
        ...(child.label !== undefined ? { label: child.label } : {}),
        status: child.status ?? "unknown",
        source: child.source ?? "live",
        durationMs: child.durationMs ?? 0,
      });
      if (entry.settledChildren.length > MAX_SETTLED_KEPT) {
        entry.settledChildren.splice(0, entry.settledChildren.length - MAX_SETTLED_KEPT);
      }
    },
    unregister(workflowId) {
      entries.delete(workflowId);
    },
    list() {
      return [...entries.entries()].map(([workflowId, e]) => ({
        workflowId,
        name: e.name,
        startedAt: e.startedAt,
        ...(e.deadlineAt !== undefined ? { deadlineAt: e.deadlineAt } : {}),
        ...(e.currentPhaseId !== undefined ? { currentPhaseId: e.currentPhaseId } : {}),
        activeChildren: [...e.activeChildren.values()],
        settledChildren: [...e.settledChildren],
        settledTotal: e.settledTotal,
        completedTotal: e.completedTotal,
        replayTotal: e.replayTotal,
      }));
    },
  };
}
