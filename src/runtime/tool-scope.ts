/**
 * X11: dynamic tool-scope re-enforcement (architecture \u00a77.5). Zero
 * `@earendil-works/*` import (I1) \u2014 operates purely on the narrow
 * `getActiveTools()/setActiveTools()` shape (structurally satisfied by
 * runtime/session-driver.ts's SessionHandle) so this module stays testable
 * with a plain object, no pi runtime required.
 *
 * Why this exists (not redundant with the one-shot `tools` allowlist passed
 * to createAgentSession): that allowlist is applied once, before the first
 * turn. An MCP server that registers a tool after the session has started
 * would then sit inside the session's active tool set forever, silently
 * bypassing the agent type's whitelist (architecture \u00a75.5 / \u00a77.5 TS2). This
 * enforcer re-applies the policy at every turn boundary, using
 * `getActiveTools()` (never a locally cached idea of "what should be
 * active") as the sole source of truth for what actually needs filtering.
 */

/** Tool names this package itself registers; a late-registered tool that
 *  collides with one of these must never be silently trusted (TS1). Only
 *  reflects tools actually deployed by this package's own tools/ modules. */
export const RESERVED_TOOL_NAMES: readonly string[] = [
  "Agent",
  "get_subagent_result",
  "steer_subagent",
  "StructuredOutput",
];

export interface ToolScopePolicy {
  /** Allow-list (agent type `tools` field, plus any explicitly granted reserved names). `undefined` = no allow-list restriction (only `deny` applies). */
  readonly allow?: ReadonlySet<string>;
  /** Always wins over `allow` (TS1). Reserved names not explicitly granted for this session. */
  readonly deny: ReadonlySet<string>;
}
export interface ScopeDecision {
  /** The tool names actually left active after this recompute, sorted. */
  readonly applied: readonly string[];
  /** Names present in `getActiveTools()` this call that got filtered out (deny hit, or not in an explicit allow-list). Never silently dropped (TS4). */
  readonly blockedNewcomers: readonly string[];
  /** Whether `setActiveTools` was actually called (it is skipped when the computed set is unchanged \u2014 avoids per-turn churn/log noise). */
  readonly changed: boolean;
}
export interface ScopeSessionHandle {
  getActiveTools(): string[];
  setActiveTools(names: string[]): void;
}
export interface ToolScopeEnforcer {
  /** First application, right after bind() succeeds and before prompt() dispatch. */
  onBind(h: ScopeSessionHandle, policy: ToolScopePolicy): ScopeDecision;
  /** Re-application at every `turn_end` (TS2/TS3: never at any other point). */
  onTurnBoundary(h: ScopeSessionHandle, policy: ToolScopePolicy): ScopeDecision;
}

/**
 * Build a policy from an agent type's `tools` field plus any tool names this
 * run deliberately grants beyond the base allow-list (the injected nested
 * Agent tool for X3, the injected StructuredOutput tool for X10). Granted
 * reserved names are excluded from `deny` \u2014 this is the "except X3
 * explicitly enabled" carve-out in TS1, expressed structurally rather than
 * by letting `allow` override `deny` at decision time.
 */
export function buildToolScopePolicy(opts: {
  tools?: readonly string[];
  granted?: readonly string[];
}): ToolScopePolicy {
  const grantedSet = new Set(opts.granted ?? []);
  const deny = new Set(RESERVED_TOOL_NAMES.filter((n) => !grantedSet.has(n)));
  return opts.tools ? { allow: new Set([...opts.tools, ...grantedSet]), deny } : { deny };
}

export function createToolScopeEnforcer(
  deps: { onBlocked?: (names: readonly string[]) => void } = {},
): ToolScopeEnforcer {
  const recompute = (h: ScopeSessionHandle, policy: ToolScopePolicy): ScopeDecision => {
    const current = h.getActiveTools(); // TS2: sole source of truth, never a locally cached idea of "what should be active"
    const isBlocked = (n: string) => policy.deny.has(n) || (policy.allow !== undefined && !policy.allow.has(n));
    const blockedNewcomers = [...new Set(current.filter(isBlocked))].sort();
    const applied = [...current.filter((n) => !isBlocked(n))].sort();
    const currentSorted = [...current].sort();
    // Compare against the *current* live set (not a remembered "last applied"
    // value) so a session that already matches the policy — on the very
    // first bind, or because nothing new registered since the previous turn
    // — never gets a redundant setActiveTools call.
    const changed = applied.length !== currentSorted.length || applied.some((n, i) => n !== currentSorted[i]);
    if (blockedNewcomers.length) deps.onBlocked?.(blockedNewcomers); // TS4: never silent
    if (changed) h.setActiveTools(applied); // TS3: caller guarantees this only runs at bind/turn_end boundaries
    return { applied, blockedNewcomers, changed };
  };
  return { onBind: recompute, onTurnBoundary: recompute };
}
