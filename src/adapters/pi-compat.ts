/**
 * L4 compatibility gate (architecture §2.10): the only file allowed to read
 * pi's version string or branch on it (I14). Capability checks themselves
 * are structural (typeof / "in" probes on the live ExtensionAPI object)
 * rather than version comparisons — a version string is only ever used for
 * the WARN text, never for a gating decision.
 *
 * Honesty note: some documented behaviors (2.4's per-event AgentEvent
 * contract: tool_execution_start/end, auto_retry_start, compaction_start/end,
 * agent_settled) cannot be structurally verified before any session exists —
 * doing so would require actually running a session (the "contract
 * conformance" C-class tests in the architecture doc, not implemented here).
 * `eventsPresent` is therefore a documented, conservative assumption, not a
 * verified fact; it is kept as its own field precisely so a future C-class
 * test suite has a single place to plug real verification into.
 */
export interface PiCapabilities {
  version: string;
  canSendMessage: boolean;
  canAppendEntry: boolean;
  canRenderEntries: boolean;
  canReadBackEntries: boolean;
  canUseEvents: boolean;
  canRetargetTools: boolean;
  eventsPresent: Record<
    | "tool_execution_start"
    | "tool_execution_end"
    | "auto_retry_start"
    | "compaction_start"
    | "compaction_end"
    | "agent_settled",
    boolean
  >;
}

export interface MinimalPiHost {
  sendMessage?: unknown;
  appendEntry?: unknown;
  registerEntryRenderer?: unknown;
  setActiveTools?: unknown;
  getActiveTools?: unknown;
  events?: { on?: unknown; emit?: unknown };
  sessionManager?: { getEntries?: unknown };
}

/**
 * Session-time probe (NOT load-time): `sessionManager` only exists on the
 * ExtensionContext passed to session_start handlers — the module-load-time
 * ExtensionAPI has no such field (pi-coding-agent extensions/loader.js:
 * createExtensionAPI never defines it; types.d.ts:219 puts it on the event
 * ctx). Gating on it at load time would disable the extension on every real
 * pi. Probe it once per session_start instead.
 */
export function probeReadBackEntries(host: { sessionManager?: { getEntries?: unknown } } | undefined): boolean {
  return typeof host?.sessionManager?.getEntries === "function";
}

const ASSUMED_EVENTS_PRESENT = {
  tool_execution_start: true,
  tool_execution_end: true,
  auto_retry_start: true,
  compaction_start: true,
  compaction_end: true,
  agent_settled: true,
} as const;

export function detectPiCapabilities(pi: MinimalPiHost, version = "unknown"): PiCapabilities {
  return {
    version,
    canSendMessage: typeof pi.sendMessage === "function",
    canAppendEntry: typeof pi.appendEntry === "function",
    canRenderEntries: typeof pi.registerEntryRenderer === "function",
    canReadBackEntries: typeof pi.sessionManager?.getEntries === "function",
    canUseEvents: typeof pi.events?.on === "function" && typeof pi.events?.emit === "function",
    canRetargetTools: typeof pi.setActiveTools === "function" && typeof pi.getActiveTools === "function",
    eventsPresent: { ...ASSUMED_EVENTS_PRESENT },
  };
}

export const TESTED_PI_RANGE = "0.84.1 - 0.84.4";

export type CompatResult = { ok: true; warning?: string } | { ok: false; reason: string };

/**
 * Three-tier gate (architecture §2.10):
 *  - all critical capabilities present -> ok (with a WARN string, not a hard
 *    failure, when the runtime version string falls outside the tested range)
 *  - any critical capability missing -> reject (caller must register a
 *    stub-only tool set instead of the real ones, see index.ts)
 *
 * Critical = required for G5b (notification delivery) plus the pi.events
 * lifecycle contract (§6.2). G5a's read-back (`sessionManager.getEntries`)
 * is NOT load-time critical: it is only available on the session_start ctx
 * (see probeReadBackEntries), and its absence degrades G5a to in-memory +
 * best-effort appendEntry with a WARN instead of disabling the extension.
 */
export function assertCompatible(caps: PiCapabilities): CompatResult {
  const missing: string[] = [];
  if (!caps.canSendMessage) missing.push("sendMessage");
  if (!caps.canAppendEntry) missing.push("appendEntry");
  if (!caps.canUseEvents) missing.push("events.on/emit");
  if (missing.length > 0) {
    return {
      ok: false,
      reason: `pi ${caps.version} is missing required capabilities: ${missing.join(", ")}. Upgrade pi (tested range ${TESTED_PI_RANGE}).`,
    };
  }
  // Only warn when we actually know the version; "unknown" means the host
  // did not expose one, and warning every session_start would be pure noise.
  const outsideTestedRange = caps.version !== "unknown" && !isWithinTestedRange(caps.version);
  return outsideTestedRange
    ? {
        ok: true,
        warning: `pi-subagent has not been validated against pi ${caps.version} (tested range ${TESTED_PI_RANGE}); all required capabilities were detected, proceeding.`,
      }
    : { ok: true };
}

function isWithinTestedRange(version: string): boolean {
  const parts = version.split(".").map((n) => Number.parseInt(n, 10));
  if (parts.length < 2 || parts.some((n) => Number.isNaN(n))) return false;
  const [major, minor] = parts as [number, number];
  return major === 0 && minor === 84;
}
