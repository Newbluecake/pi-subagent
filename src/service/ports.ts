import type { DeadlineBudget } from "../core/types.js";
import type {
  AgentTypeConfig,
  DriverEvent,
  LifecycleEvent,
  RunDeadlines,
  RunId,
  RunOutcome,
  RunPhase,
  RunSnapshot,
  SpawnRequest,
  StopCause,
} from "../core/types.js";

export interface SlotTicket {
  readonly runId: RunId;
  release(): void;
}
export interface SlotPool {
  acquire(
    runId: RunId,
    opts: { slotless?: boolean; queueWaitMs: number; signal?: AbortSignal },
  ): Promise<{ ok: true; ticket: SlotTicket } | { ok: false; reason: "queue_timeout" | "aborted" }>;
  release?(runId: RunId): void;
  drain?(): void;
  setLimit?(n: number): void;
  readonly stats?: { limit: number; inUse: number; queued: number; slotless: number };
}

export interface SessionSpec {
  readonly runId: RunId;
  readonly type: AgentTypeConfig;
  readonly request: SpawnRequest;
  readonly cwd?: string;
  readonly model?: { provider: string; id: string };
  readonly budget: DeadlineBudget;
}
export interface RunnerCallbacks {
  onLifecycle?(event: LifecycleEvent): void;
  onEvent?(event: DriverEvent): void;
  onSnapshot?(snapshot: RunSnapshot): void;
}
export interface Runner {
  run(spec: SessionSpec, callbacks?: RunnerCallbacks): Promise<RunOutcome>;
  abort?(runId: RunId, cause?: StopCause): Promise<{ ok: boolean; escalatedTo: "L2" | "L3" | "L4" }>;
  steer?(runId: RunId, text: string): Promise<void>;
}
export interface RunRegistry {
  get(runId: RunId): RunSnapshot | undefined;
  list(filter?: { status?: RunSnapshot["status"][]; parentRunId?: RunId }): RunSnapshot[];
  put?(snapshot: RunSnapshot): void;
}
export interface ResolvedSpawnRequest extends SpawnRequest {
  readonly runId: RunId;
  readonly typeConfig: AgentTypeConfig;
  readonly budget: DeadlineBudget;
  readonly deadlines: RunDeadlines;
}
export interface LifecycleSink {
  (event: LifecycleEvent): void;
}
