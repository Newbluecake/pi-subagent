import { createAgentSession } from "@earendil-works/pi-coding-agent";
import type { AgentSession } from "@earendil-works/pi-coding-agent";
import type { DriverEvent, KillableHandle, RunOutcome, SessionSpec } from "../core/types.js";

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
  getUsage(): RunOutcome["usage"];
}
export interface SessionDriver {
  create(spec: SessionSpec): Promise<SessionHandle>;
  bind(h: SessionHandle, onEvent: (e: DriverEvent) => void): Promise<void>;
  onLateArrival(p: Promise<SessionHandle>, cb: (h: SessionHandle) => void): void;
}

function errorInfo(error: unknown): NonNullable<RunOutcome["error"]> {
  const e = error instanceof Error ? error : new Error(String(error));
  return { kind: "internal", message: e.message, ...(e.stack ? { stack: e.stack } : {}), retryable: false };
}
function mapEvent(e: any): DriverEvent | undefined {
  if (!e || typeof e.type !== "string") return undefined;
  const t = e.type;
  if (t === "turn_start") return { t: "turn_start" };
  if (t === "turn_end") return { t: "turn_end", toolResults: Array.isArray(e.toolResults) ? e.toolResults.length : 0 };
  if (t === "message_end") return { t: "message_end", usage: e.message?.usage };
  if (t === "tool_execution_start")
    return { t: "tool_start", toolCallId: String(e.toolCallId), toolName: String(e.toolName) };
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
  if (t === "message_update" && typeof e.message?.content === "string")
    return { t: "text_delta", delta: e.message.content };
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
  getUsage() {
    return undefined;
  }
}

export class PiSessionDriver implements SessionDriver {
  create(spec: SessionSpec) {
    return createAgentSession(spec as Parameters<typeof createAgentSession>[0]).then(
      ({ session }) => new PiSessionHandle(session),
    );
  }
  bind(h: SessionHandle, onEvent: (e: DriverEvent) => void) {
    const session = (h as PiSessionHandle)["session"];
    if (!session) return Promise.reject(new Error("invalid pi session handle"));
    session.subscribe((event: unknown) => {
      const mapped = mapEvent(event);
      if (mapped) onEvent(mapped);
    });
    return Promise.resolve();
  }
  onLateArrival(p: Promise<SessionHandle>, cb: (h: SessionHandle) => void) {
    p.then(cb, () => undefined).catch(() => undefined);
  }
}
export { mapEvent };
