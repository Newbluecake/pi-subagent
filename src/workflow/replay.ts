import { nextChainDigest } from "./journal.js";
import type { Millis } from "../core/types.js";
import type { JournalEntry, ReplayScope, TaskKey } from "./types.js";

/**
 * M3.5 (workflow design §6.2/§6.3/§6.4): the replay *decision* layer —
 * builds an in-memory lookup index from a `JournalStore.load()` result and
 * decides, per `agent()` submission, whether an entry may be reused
 * (§6.4 RP1–RP9, narrowed to the RPs this milestone's `agent()` surface can
 * actually violate — see the module doc below for which are structurally
 * always-true here and why).
 *
 * RP scope note: RP2 (no `resume`) and RP5 (schema re-validation) are
 * vacuously satisfied — the current `agent()` host-call surface
 * (host.ts's `handleAgent`) has no `resume`/`schema` option at all, so no
 * journaled entry could ever have come from one. RP8 (`v` supported) is
 * enforced by `journal.ts#parseEntry` itself (an unsupported `v` fails the
 * shape guard and is counted as a corrupt line, never reaches the index).
 * RP10/RP11 (MCP tool-set hashing / content-scope warning banner) are
 * genuine gaps — this milestone's `agent()` surface has no MCP-awareness to
 * hash, and the content-scope risk banner is a UI/tool-layer concern above
 * `src/workflow/**`.
 */

export interface ReplayIndexStats {
  readonly loadedEntries: number;
  readonly corruptLines: number;
  /** Entries dropped because they were written under the *other* scope (see journal.ts's `JournalEntry.scope` doc) — not corrupt, just not addressable under the scope this run is using. */
  readonly scopeMismatch: number;
}

export interface ReplayIndex {
  readonly scope: ReplayScope;
  /** `chainDigestBefore` is the *live* run's current chain digest (before this submission) — only consulted when `scope==="chain"`. */
  lookup(taskKey: TaskKey, chainDigestBefore: string, occurrence: number): JournalEntry | undefined;
  readonly stats: ReplayIndexStats;
}

/**
 * §6.2 step 7 / §6.5 "同 (K, occurrence) 多条 → 取 completedAt 最大者": builds
 * the one map this run's scope actually needs. Both scopes are keyed by
 * `${lookupKey}:${occurrence}` — for `content` scope `lookupKey` is the
 * entry's own `key` (its `taskKey`); for `chain` scope it is
 * `nextChainDigest(entry.chainDigestBefore, entry.key)`, i.e. the *chain*
 * key that entry's own submission-time chain digest would have produced —
 * reconstructible purely from what got journaled, independent of anything
 * about the *current* run's chain state.
 */
export function buildReplayIndex(
  entries: readonly JournalEntry[],
  corruptLines: number,
  scope: ReplayScope,
): ReplayIndex {
  const map = new Map<string, JournalEntry>();
  let scopeMismatch = 0;
  for (const entry of entries) {
    if (entry.scope !== scope) {
      scopeMismatch += 1;
      continue;
    }
    const lookupKey = scope === "content" ? entry.key : nextChainDigest(entry.chainDigestBefore, entry.key);
    const mapKey = `${lookupKey}:${entry.occurrence}`;
    const existing = map.get(mapKey);
    if (!existing || entry.completedAt >= existing.completedAt) map.set(mapKey, entry);
  }
  return {
    scope,
    lookup(taskKey, chainDigestBefore, occurrence) {
      const lookupKey = scope === "content" ? taskKey : nextChainDigest(chainDigestBefore, taskKey);
      return map.get(`${lookupKey}:${occurrence}`);
    },
    stats: { loadedEntries: entries.length, corruptLines, scopeMismatch },
  };
}

export type ReplayDecision =
  | { readonly kind: "hit"; readonly entry: JournalEntry }
  | { readonly kind: "miss" }
  | { readonly kind: "skip"; readonly reason: "no_replay" | "non_deterministic" | "isolation_worktree" | "expired" };

export interface DecideReplayInput {
  readonly index: ReplayIndex;
  readonly taskKey: TaskKey;
  readonly chainDigestBefore: string;
  readonly occurrence: number;
  /** RP1. */
  readonly noReplay: boolean;
  /** RP9 (run-scoped: `meta.deterministic !== false`). */
  readonly deterministic: boolean;
  readonly now: Millis;
  /** RP6, `0`/undefined = unlimited. */
  readonly replayTtlMs?: Millis;
}

export const DEFAULT_REPLAY_TTL_MS: Millis = 7 * 24 * 60 * 60 * 1000;

/**
 * §6.2's per-call matching algorithm (steps 6–7), plus §6.4's RP gate. Never
 * throws, never returns a "partially trusted" hit — every branch resolves to
 * exactly one of hit/miss/skip (GW4: any doubt at all routes to live).
 */
export function decideReplay(input: DecideReplayInput): ReplayDecision {
  if (input.noReplay) return { kind: "skip", reason: "no_replay" };
  if (!input.deterministic) return { kind: "skip", reason: "non_deterministic" };
  const entry = input.index.lookup(input.taskKey, input.chainDigestBefore, input.occurrence);
  if (!entry) return { kind: "miss" };
  // RP7: isolation:"worktree" entries are never replayed, regardless of TTL.
  if (entry.isolation === "worktree") return { kind: "skip", reason: "isolation_worktree" };
  const ttl = input.replayTtlMs ?? DEFAULT_REPLAY_TTL_MS;
  if (ttl > 0 && input.now - entry.completedAt > ttl) return { kind: "skip", reason: "expired" };
  // RP3/RP4/RP8 are already enforced upstream (journal.ts only ever produces
  // `status:"completed"`, digest-verified, `v:1` entries into the index) —
  // reaching here means every remaining precondition holds.
  return { kind: "hit", entry };
}
