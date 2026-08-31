import type { Millis } from "../core/types.js";
import type { WorkflowId } from "./types.js";

/**
 * M3.6 (workflow design §9.3 Fleet UI / §9.4 `/agent status --workflow`):
 * the minimal live-activity view this milestone can honestly provide.
 *
 * Documented simplification (in the same spirit as every other M3.x
 * narrowing in this codebase): `Orchestrator` (orchestrator.ts) exposes
 * `outcomeAt1()`/`settled()` snapshots only *after* it has decided to stop
 * \u2014 there is no live "still running" snapshot API (no `WorkflowState`/
 * `reduceWorkflow` pure state machine backs it, see orchestrator.ts's own
 * module doc on what is and is not reproduced from the full \u00a73.4 design).
 * So this registry does not attempt to show live child rows or
 * per-call progress \u2014 it tracks exactly what the tool layer (the only
 * caller of `Orchestrator.run()`) and the `subagent:workflow:phase` event
 * already know: which workflows are currently in flight, their declared
 * name, when they started, their absolute deadline, and their most
 * recently entered `phase(title)` label. That is enough for GW8's "which
 * workflow, which phase, how long, how much budget is left" bar without
 * fabricating a per-child view this milestone's `Orchestrator` cannot back.
 */
export interface WorkflowActivitySnapshot {
  readonly workflowId: WorkflowId;
  readonly name: string;
  readonly startedAt: Millis;
  readonly deadlineAt?: Millis;
  readonly currentPhaseId?: string;
}

export interface WorkflowActivityRegistry {
  register(workflowId: WorkflowId, name: string, startedAt: Millis, deadlineAt?: Millis): void;
  /** Wired as (part of) the `Orchestrator`'s `emit` so a `subagent:workflow:phase` "enter" event updates the row without the tool needing to poll anything. */
  onEvent(channel: string, payload: unknown): void;
  unregister(workflowId: WorkflowId): void;
  list(): readonly WorkflowActivitySnapshot[];
}

interface MutableEntry {
  name: string;
  startedAt: Millis;
  deadlineAt?: Millis;
  currentPhaseId?: string;
}

function isPhaseEnterEvent(
  channel: string,
  payload: unknown,
): payload is { workflowId: WorkflowId; phaseId: string; kind: "enter" } {
  if (channel !== "subagent:workflow:phase" || payload === null || typeof payload !== "object") return false;
  const p = payload as Record<string, unknown>;
  return typeof p.workflowId === "string" && typeof p.phaseId === "string" && p.kind === "enter";
}

export function createWorkflowActivityRegistry(): WorkflowActivityRegistry {
  const entries = new Map<WorkflowId, MutableEntry>();
  return {
    register(workflowId, name, startedAt, deadlineAt) {
      entries.set(workflowId, { name, startedAt, ...(deadlineAt !== undefined ? { deadlineAt } : {}) });
    },
    onEvent(channel, payload) {
      if (!isPhaseEnterEvent(channel, payload)) return;
      const entry = entries.get(payload.workflowId);
      if (entry) entry.currentPhaseId = payload.phaseId;
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
      }));
    },
  };
}
