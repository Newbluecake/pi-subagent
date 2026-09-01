import { existsSync, statSync } from "node:fs";
import type { RunId, RunSnapshot, RunStatus } from "../core/types.js";
import type { Tombstone, TombstoneStore } from "./tombstone.js";

// RPC intentionally keeps exact-string semantics. This resolver is only for
// the model-facing tools and status/resume paths; src/rpc/* must not use it.

export interface TargetLabel {
  readonly runId: RunId;
}
export interface ResumeCandidate {
  readonly label: string;
  readonly runId: RunId;
  readonly status: RunStatus | "terminal";
  readonly ageMinutes: number;
}
export interface ResolveTargetDeps {
  labels: ReadonlyMap<string, TargetLabel>;
  liveSnapshots: readonly RunSnapshot[] | (() => readonly RunSnapshot[]);
  records: readonly RunSnapshot[] | (() => readonly RunSnapshot[]);
  tombstones: Pick<TombstoneStore, "list" | "get">;
  now?: () => number;
}
export type ResolveRunResult =
  | { readonly ok: true; readonly runId: RunId }
  | { readonly ok: false; readonly error: string; readonly candidates: readonly ResumeCandidate[] };
export type ResolveResumeResult =
  | { readonly ok: true; readonly runId: RunId; readonly sessionFile: string }
  | { readonly ok: false; readonly error: string; readonly candidates: readonly ResumeCandidate[] };

const TERMINAL = new Set<RunStatus>(["completed", "failed", "timed_out", "aborted"]);

function values<T>(source: readonly T[] | (() => readonly T[])): readonly T[] {
  return typeof source === "function" ? source() : source;
}
function oneLine(value: string): string {
  return value
    .replace(/[\u0000-\u001f\u007f]/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 40);
}
function sourceSnapshots(deps: ResolveTargetDeps): RunSnapshot[] {
  const merged = new Map<RunId, RunSnapshot>();
  // Records are the durable, long-lived view. Live snapshots win when both
  // views contain an id because they are the freshest view of that run.
  for (const snapshot of values(deps.records)) merged.set(snapshot.runId, snapshot);
  for (const snapshot of values(deps.liveSnapshots)) merged.set(snapshot.runId, snapshot);
  return [...merged.values()];
}
function snapshotWithSessionFile(deps: ResolveTargetDeps, runId: RunId): RunSnapshot | undefined {
  // Keep the source ordering explicit: a live terminal snapshot is preferred,
  // then the long-lived terminal record, then the TTL-bounded tombstone.
  const live = values(deps.liveSnapshots)
    .filter((snapshot) => snapshot.runId === runId && TERMINAL.has(snapshot.status) && snapshot.diag.sessionFile)
    .sort((a, b) => b.updatedAt - a.updatedAt)[0];
  if (live) return live;
  return values(deps.records)
    .filter((snapshot) => snapshot.runId === runId && TERMINAL.has(snapshot.status) && snapshot.diag.sessionFile)
    .sort((a, b) => b.updatedAt - a.updatedAt)[0];
}
function tombstoneList(deps: ResolveTargetDeps): readonly Tombstone[] {
  return deps.tombstones.list();
}
function knownIds(deps: ResolveTargetDeps): Set<RunId> {
  const ids = new Set<RunId>(sourceSnapshots(deps).map((snapshot) => snapshot.runId));
  for (const tombstone of tombstoneList(deps)) ids.add(tombstone.runId);
  return ids;
}
function labelsByRunId(deps: ResolveTargetDeps): Map<RunId, string> {
  const labels = new Map<RunId, string>();
  for (const [label, target] of deps.labels) if (!labels.has(target.runId)) labels.set(target.runId, label);
  return labels;
}
function candidateList(deps: ResolveTargetDeps): readonly ResumeCandidate[] {
  const now = deps.now?.() ?? Date.now();
  const byId = new Map<RunId, ResumeCandidate>();
  const labels = labelsByRunId(deps);
  for (const runId of knownIds(deps)) {
    const snapshot = snapshotWithSessionFile(deps, runId);
    if (!snapshot) continue;
    byId.set(runId, {
      label: oneLine(snapshot.diag.label ?? labels.get(runId) ?? runId),
      runId,
      status: snapshot.status,
      ageMinutes: Math.floor(Math.max(0, now - snapshot.updatedAt) / 60_000),
    });
  }
  for (const tombstone of tombstoneList(deps)) {
    if (byId.has(tombstone.runId)) continue;
    byId.set(tombstone.runId, {
      label: oneLine(labels.get(tombstone.runId) ?? tombstone.runId),
      runId: tombstone.runId,
      status: "terminal",
      ageMinutes: Math.floor(Math.max(0, now - tombstone.createdAt) / 60_000),
    });
  }
  return [...byId.values()].slice(0, 10);
}
function formatCandidates(candidates: readonly ResumeCandidate[]): string {
  return candidates.length
    ? candidates
        .map(
          (candidate) => `${candidate.label} → ${candidate.runId} (${candidate.status}, ${candidate.ageMinutes}m ago)`,
        )
        .join(", ")
    : "none";
}
function resumeError(handle: string, candidates: readonly ResumeCandidate[]): string {
  return `resume target not found: ${oneLine(handle)}. Resumable targets: [${formatCandidates(candidates)}]`;
}
function matchRunId(handle: string, deps: ResolveTargetDeps): { runId?: RunId; ambiguous: boolean } {
  const ids = knownIds(deps);
  if (ids.has(handle)) return { runId: handle, ambiguous: false };
  const prefixes = [...ids].filter((runId) => runId.startsWith(handle));
  if (prefixes.length === 1) {
    const runId = prefixes[0];
    if (runId) return { runId, ambiguous: false };
  }
  return { ambiguous: prefixes.length > 1 };
}

/** Resolve an id, its unique prefix, or finally an exact registered label. */
export function resolveRunId(handle: string, deps: ResolveTargetDeps): ResolveRunResult {
  const candidates = candidateList(deps);
  const matched = matchRunId(handle, deps);
  if (matched.runId) return { ok: true, runId: matched.runId };
  if (matched.ambiguous)
    return {
      ok: false,
      error: `ambiguous run target: ${oneLine(handle)}. Candidates: [${formatCandidates(candidates)}]`,
      candidates,
    };
  const labelTarget = deps.labels.get(handle);
  // A just-started run may not have emitted its first live snapshot yet, but
  // its label registration is already authoritative for the running hint.
  if (labelTarget) return { ok: true, runId: labelTarget.runId };
  return {
    ok: false,
    error: `run target not found: ${oneLine(handle)}. Candidates: [${formatCandidates(candidates)}]`,
    candidates,
  };
}

/**
 * Resolve a resumable terminal run and validate its canonical session file.
 * A caller-provided path is never accepted: only a run id/prefix/label can
 * reach a session file obtained from a live/terminal snapshot or tombstone.
 */
export function resolveResumeTarget(handle: string, deps: ResolveTargetDeps): ResolveResumeResult {
  const candidates = candidateList(deps);
  const matched = matchRunId(handle, deps);
  let runId = matched.runId;
  if (!runId && !matched.ambiguous) runId = deps.labels.get(handle)?.runId;
  if (!runId || matched.ambiguous) return { ok: false, error: resumeError(handle, candidates), candidates };

  const sessionFile = snapshotWithSessionFile(deps, runId)?.diag.sessionFile ?? deps.tombstones.get(runId)?.sessionFile;
  if (!sessionFile || !existsSync(sessionFile) || !statIsFile(sessionFile))
    return { ok: false, error: resumeError(handle, candidates), candidates };
  return { ok: true, runId, sessionFile };
}
function statIsFile(path: string): boolean {
  try {
    return statSync(path).isFile();
  } catch {
    return false;
  }
}
