import { createAgentSession } from "@earendil-works/pi-coding-agent";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import type { AgentSession } from "@earendil-works/pi-coding-agent";
import type {
  ContextUsageInfo,
  DriverEvent,
  KillableHandle,
  RunOutcome,
  SessionSpec,
  UsageDelta,
} from "../core/types.js";

export type { KillableHandle, SessionSpec } from "../core/types.js";
export interface DisposeReport {
  returned: boolean;
  error?: RunOutcome["error"];
  killed: number;
  unkillable: ReadonlyArray<{ kind: string; id: string }>;
}
export interface SessionHandle {
  readonly sessionId: string;
  readonly sessionFile: string | undefined;
  prompt(text: string): Promise<void>;
  steer(text: string): Promise<void>;
  requestAbort(): Promise<void>;
  dispose(): DisposeReport;
  readonly killableHandles: ReadonlySet<KillableHandle>;
  setActiveTools(names: string[]): void;
  getActiveTools(): string[];
  getLastAssistantText(): string | undefined;
  getTurnError?(): string | undefined;
  /** M-B2: the session's *actual* model (ground truth — covers runs with no spawn-time override/type default). */
  getModelRef?(): { provider: string; id: string } | undefined;
  getUsage(): RunOutcome["usage"];
}
export interface SessionDriver {
  create(spec: SessionSpec): Promise<SessionHandle>;
  /** Optional X2 path; runners fall back to create only for fresh sessions. */
  resume?(sessionFile: string, spec: SessionSpec): Promise<SessionHandle>;
  bind(h: SessionHandle, onEvent: (e: DriverEvent) => void): Promise<void>;
  onLateArrival(p: Promise<SessionHandle>, cb: (h: SessionHandle) => void): void;
}

/**
 * Map pi's Usage (pi-ai) to our UsageDelta at this anti-corruption boundary.
 * pi carries cost as a nested `cost.total`; UsageDelta wants a flat `costUsd`.
 * Passing the raw object through leaves `costUsd` undefined, and
 * `base.costUsd + undefined` poisons the lifetime accumulator with NaN
 * (observed in the wild: the fleet widget rendered "$NaN"). Every field is
 * clamped to a finite number so a missing/NaN provider field can never
 * corrupt the sum.
 */
function mapUsage(u: unknown): UsageDelta | undefined {
  if (!u || typeof u !== "object") return undefined;
  const num = (v: unknown) => (typeof v === "number" && Number.isFinite(v) ? v : 0);
  const r = u as Record<string, unknown>;
  const cost = r["cost"] as { total?: unknown } | undefined;
  return {
    input: num(r["input"]),
    output: num(r["output"]),
    cacheRead: num(r["cacheRead"]),
    cacheWrite: num(r["cacheWrite"]),
    costUsd: num(cost?.total),
  };
}

export function mapContextUsage(u: unknown): ContextUsageInfo | undefined {
  if (!u || typeof u !== "object") return undefined;
  const r = u as Record<string, unknown>;
  const contextWindow = r["contextWindow"];
  if (typeof contextWindow !== "number" || !Number.isFinite(contextWindow) || contextWindow <= 0) return undefined;
  const nullableNumber = (value: unknown, predicate: (n: number) => boolean): number | null =>
    value === null || (typeof value === "number" && Number.isFinite(value) && predicate(value))
      ? (value as number | null)
      : null;
  const tokens = nullableNumber(r["tokens"], (n) => n >= 0);
  const rawPercent = nullableNumber(r["percent"], () => true);
  return {
    contextWindow,
    tokens,
    percent: rawPercent === null ? null : Math.min(100, Math.max(0, rawPercent)),
  };
}

function errorInfo(error: unknown): NonNullable<RunOutcome["error"]> {
  const e = error instanceof Error ? error : new Error(String(error));
  return { kind: "internal", message: e.message, ...(e.stack ? { stack: e.stack } : {}), retryable: false };
}
/**
 * M-A: single-line, truncated preview of a tool call's arguments for the
 * live trail UI. Picks the most informative scalar (bash command, file path,
 * pattern…) and falls back to compact JSON. Display-only — never fed back to
 * a model — and hard-capped so a huge prompt/file body cannot bloat diag.
 */
export function previewToolArgs(args: unknown, max = 80): string | undefined {
  if (args === null || args === undefined) return undefined;
  let text: string;
  if (typeof args === "string") text = args;
  else if (typeof args === "object") {
    const r = args as Record<string, unknown>;
    const preferred = ["command", "path", "file_path", "pattern", "query", "description", "prompt", "url"];
    const key = preferred.find((k) => typeof r[k] === "string" && (r[k] as string).length > 0);
    if (key) text = r[key] as string;
    else {
      try {
        text = JSON.stringify(r) ?? "";
      } catch {
        return undefined;
      }
    }
  } else text = String(args);
  text = text.replace(/\s+/g, " ").trim();
  if (!text) return undefined;
  return text.length > max ? `${text.slice(0, max - 1)}…` : text;
}

function mapEvent(e: any): DriverEvent | undefined {
  if (!e || typeof e.type !== "string") return undefined;
  const t = e.type;
  if (t === "turn_start") return { t: "turn_start" };
  if (t === "turn_end") return { t: "turn_end", toolResults: Array.isArray(e.toolResults) ? e.toolResults.length : 0 };
  if (t === "message_end") {
    // exactOptionalPropertyTypes: omit `usage` entirely when absent.
    const usage = mapUsage(e.message?.usage);
    return usage ? { t: "message_end", usage } : { t: "message_end" };
  }
  if (t === "tool_execution_start") {
    const argsPreview = previewToolArgs(e.args);
    return {
      t: "tool_start",
      toolCallId: String(e.toolCallId),
      toolName: String(e.toolName),
      ...(argsPreview === undefined ? {} : { argsPreview }),
    };
  }
  if (t === "tool_execution_end")
    return {
      t: "tool_end",
      toolCallId: String(e.toolCallId),
      toolName: String(e.toolName),
      isError: Boolean(e.isError),
    };
  if (t === "tool_execution_update") return { t: "tool_update", toolCallId: String(e.toolCallId) };
  if (t === "auto_retry_start")
    return {
      t: "retry_start",
      attempt: Number(e.attempt),
      maxAttempts: Number(e.maxAttempts),
      delayMs: Number(e.delayMs),
    };
  if (t === "auto_retry_end") return { t: "retry_end", success: Boolean(e.success) };
  if (t === "compaction_start") return { t: "compaction_start", reason: String(e.reason) };
  if (t === "compaction_end") return { t: "compaction_end", aborted: Boolean(e.aborted) };
  if (t === "agent_settled") return { t: "settled" };
  if (t === "message_update") {
    // pi streams token-by-token via assistantMessageEvent (pi-ai
    // AssistantMessageEvent): text_delta carries answer text, thinking_delta
    // carries the reasoning stream — the agent tree's `»` preview line feeds
    // on both. The assistant message's own `content` is a block array
    // (TextContent | ThinkingContent | ToolCall), never a string, so reading
    // deltas off `message` directly sees nothing.
    const ae = e.assistantMessageEvent;
    if (ae?.type === "thinking_delta" && typeof ae.delta === "string") return { t: "thinking_delta", delta: ae.delta };
    if (ae?.type === "text_delta" && typeof ae.delta === "string") return { t: "text_delta", delta: ae.delta };
    // Legacy fallback: non-assistant messages (e.g. user) can carry a plain
    // string content.
    if (typeof e.message?.content === "string") return { t: "text_delta", delta: e.message.content };
    return undefined;
  }
  return undefined;
}

class PiSessionHandle implements SessionHandle {
  readonly sessionId: string;
  readonly sessionFile: string | undefined;
  readonly killableHandles = new Set<KillableHandle>();
  constructor(public readonly session: AgentSession) {
    this.sessionId = session.sessionId;
    this.sessionFile = session.sessionFile;
  }
  prompt(text: string) {
    return this.session.prompt(text);
  }
  steer(text: string) {
    return this.session.steer(text);
  }
  requestAbort() {
    this.session.abort();
    return Promise.resolve();
  }
  dispose(): DisposeReport {
    try {
      this.session.dispose();
      return { returned: true, killed: 0, unkillable: [] };
    } catch (e) {
      return { returned: false, error: errorInfo(e), killed: 0, unkillable: [] };
    }
  }
  setActiveTools(names: string[]) {
    this.session.setActiveToolsByName(names);
  }
  getActiveTools() {
    return this.session.getActiveToolNames();
  }
  getLastAssistantText() {
    return this.session.getLastAssistantText();
  }
  /** M-B2: read the actual model off the live session (post-create, so pi's
   *  own default-model selection is reflected even when the spawn request
   *  carried no override and the agent type declared no model). */
  getModelRef(): { provider: string; id: string } | undefined {
    const m = this.session.model as { provider?: unknown; id?: unknown } | undefined;
    return typeof m?.provider === "string" && typeof m?.id === "string"
      ? { provider: m.provider, id: m.id }
      : undefined;
  }
  /** pi resolves prompt() even when the final turn died (stopReason
   *  "error", e.g. provider crash) — without this check a dead turn looks
   *  like an empty success. Surface it so the run becomes failed(model). */
  getTurnError(): string | undefined {
    for (let i = this.session.messages.length - 1; i >= 0; i--) {
      const m = this.session.messages[i] as { role?: string; stopReason?: string; errorMessage?: string };
      if (m?.role === "assistant")
        return m.stopReason === "error" ? (m.errorMessage ?? "unknown model error") : undefined;
    }
    return undefined;
  }
  getUsage() {
    return undefined;
  }
}

export type ModelResolver = (provider: string, id: string) => unknown | undefined;

export class PiSessionDriver implements SessionDriver {
  constructor(
    private readonly rememberAgents = true,
    private readonly resolveModel?: ModelResolver,
  ) {}

  /** SessionSpec.model arrives as a {provider, id} pair; createAgentSession
   *  needs a real Model object from the registry. Passing the pair through
   *  crashes pi's provider call site (reading properties of undefined) and —
   *  worse — the session then settles with stopReason "error" and zero
   *  turns, looking like an empty success. Resolve eagerly and fail fast. */
  private withResolvedModel(spec: SessionSpec): SessionSpec {
    const m = spec.model as { provider?: unknown; id?: unknown } | undefined;
    if (m === undefined) return spec;
    if (typeof m.provider !== "string" || typeof m.id !== "string")
      throw new Error("model must be a {provider, id} pair");
    if (!this.resolveModel)
      throw new Error(`model override ${m.provider}/${m.id} requested but no model registry is wired`);
    const resolved = this.resolveModel(m.provider, m.id);
    if (!resolved)
      throw new Error(`unknown model: ${m.provider}/${m.id} (not in pi's model registry — check provider/auth)`);
    return { ...spec, model: resolved };
  }

  create(spec: SessionSpec) {
    const resolved = this.withResolvedModel(spec);
    const cwd = resolved.cwd ?? process.cwd();
    const persist = resolved.persist ?? this.rememberAgents;
    const sessionManager = persist ? SessionManager.create(cwd) : SessionManager.inMemory(cwd);
    return createAgentSession({
      ...resolved,
      sessionManager,
      ...(persist ? {} : { persist: false }),
    } as Parameters<typeof createAgentSession>[0]).then(({ session }) => new PiSessionHandle(session));
  }
  resume(sessionFile: string, spec: SessionSpec) {
    const resolved = this.withResolvedModel(spec);
    const sessionManager = SessionManager.open(sessionFile, undefined, resolved.cwd);
    return createAgentSession({ ...resolved, sessionManager } as Parameters<typeof createAgentSession>[0]).then(
      ({ session }) => new PiSessionHandle(session),
    );
  }
  bind(h: SessionHandle, onEvent: (e: DriverEvent) => void) {
    const session = (h as PiSessionHandle)["session"];
    if (!session) return Promise.reject(new Error("invalid pi session handle"));
    let contextSamplingDisabled = false;
    session.subscribe((event: unknown) => {
      const mapped = mapEvent(event);
      if (!mapped) return;
      onEvent(mapped);
      if ((mapped.t !== "message_end" && mapped.t !== "compaction_end") || contextSamplingDisabled) return;
      const getContextUsage = (session as { getContextUsage?: unknown }).getContextUsage;
      if (typeof getContextUsage !== "function") {
        contextSamplingDisabled = true;
        return;
      }
      try {
        const usage = mapContextUsage(getContextUsage.call(session));
        if (usage) onEvent({ t: "context_usage", usage });
      } catch {
        contextSamplingDisabled = true;
      }
    });
    return Promise.resolve();
  }
  onLateArrival(p: Promise<SessionHandle>, cb: (h: SessionHandle) => void) {
    p.then(cb, () => undefined).catch(() => undefined);
  }
}
export { mapEvent };
