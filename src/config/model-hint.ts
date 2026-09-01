/**
 * Model-hint resolution (parity with upstream @tintinweb/pi-subagents):
 * agent frontmatter `model:` and the Agent tool's `model` param accept
 * either a strict `provider/id` pair or a fuzzy hint — a bare model id
 * ("kimi-k3") or a case-insensitive substring alias ("sonnet", "haiku") —
 * resolved against pi's available models at spawn time.
 *
 * This module is pure: the candidate list is supplied by the caller
 * (stack.ts feeds `ctx.modelRegistry.getAvailable()`), so config parsing
 * and spawn admission stay free of any pi-registry import edge.
 */

export interface ModelRef {
  provider: string;
  id: string;
}

export interface ModelCandidate extends ModelRef {
  /** Human display name (pi's Model.name), e.g. "Claude Sonnet 5". */
  name?: string;
}

/**
 * Strict `provider/id` split — the only form that needs no registry lookup.
 * Returns undefined for bare ids, empty sides, or missing "/".
 */
export function parseStrictModelRef(value: string): ModelRef | undefined {
  const idx = value.indexOf("/");
  if (idx <= 0 || idx === value.length - 1) return undefined;
  const provider = value.slice(0, idx).trim();
  const id = value.slice(idx + 1).trim();
  return provider && id ? { provider, id } : undefined;
}

/**
 * Resolve a fuzzy hint to a concrete {provider, id}. Matching tiers, first
 * non-empty tier wins, ties broken by candidate order (the caller orders
 * candidates by preference — stack.ts passes pi's registry order):
 *
 *  1. strict `provider/id` exact match (case-insensitive both parts)
 *  2. exact id match ("kimi-k3" — even when several providers serve it)
 *  3. id prefix match ("claude-opus" → claude-opus-4-8, …)
 *  4. id substring match ("sonnet" → claude-sonnet-5)
 *  5. display-name substring match ("opus 5" → "Claude Opus 5")
 *
 * Returns undefined when no candidate matches — the caller turns that into
 * a self-correcting config error rather than silently inheriting the parent
 * model (a silently-ignored hint runs the task on the wrong model).
 */
export function resolveModelHint(hint: string, candidates: readonly ModelCandidate[]): ModelRef | undefined {
  const q = hint.trim().toLowerCase();
  if (!q) return undefined;
  const pick = (tier: (c: ModelCandidate) => boolean): ModelRef | undefined => {
    const hit = candidates.find(tier);
    return hit ? { provider: hit.provider, id: hit.id } : undefined;
  };
  const strict = parseStrictModelRef(hint);
  if (strict) {
    const p = strict.provider.toLowerCase();
    const i = strict.id.toLowerCase();
    return pick((c) => c.provider.toLowerCase() === p && c.id.toLowerCase() === i);
  }
  return (
    pick((c) => c.id.toLowerCase() === q) ??
    pick((c) => c.id.toLowerCase().startsWith(q)) ??
    pick((c) => c.id.toLowerCase().includes(q)) ??
    pick((c) => (c.name ?? "").toLowerCase().includes(q))
  );
}
