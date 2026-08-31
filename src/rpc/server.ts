import { Type } from "@sinclair/typebox";
import type { DeadlineBudget, ErrorInfo, SpawnRequest, StopCause } from "../core/types.js";
import type { QueryService } from "../service/query-service.js";
import type { SpawnService } from "../service/spawn-service.js";
import {
  RPC_REQUEST_CHANNEL,
  RPC_VERSION,
  ResultParamsSchema,
  RPCReplySchema,
  RPCRequestSchema,
  SpawnParamsSchema,
  StopParamsSchema,
  isSchema,
  isValidRequestId,
  internalError,
  replyChannel,
  type RPCEventBus,
  type RPCReply,
  type RPCRequest,
  type ResultParams,
  type SpawnParams,
  type StopParams,
} from "./protocol.js";

export interface RPCServerDeps {
  events: RPCEventBus;
  spawn: Pick<SpawnService, "spawn">;
  query: Pick<QueryService, "get" | "stop">;
  version?: string;
  warn?: (message: string) => void;
  budgetCaps?: Partial<DeadlineBudget>;
}

const DEFAULT_CAPS: Partial<DeadlineBudget> = {
  queueWaitMs: 10 * 60_000,
  startupMs: 5 * 60_000,
  bindMs: 5 * 60_000,
  firstEventMs: 10 * 60_000,
  idleMs: 10 * 60_000,
  toolMs: 10 * 60_000,
  compactionMs: 10 * 60_000,
  totalMs: 60 * 60_000,
  abortGraceMs: 60_000,
  steerMs: 60_000,
  reapMs: 60_000,
  startupRetries: 10,
  retrySlackMs: 60_000,
};

const error = (message: string, retryable = false): ErrorInfo => ({
  kind: "internal",
  message,
  retryable,
});

export interface RPCServer {
  close(): void;
}

export function createRPCServer(deps: RPCServerDeps): RPCServer {
  const inFlight = new Set<string>();
  const version = deps.version ?? RPC_VERSION;
  const warn = deps.warn ?? ((message) => console.warn(`[pi-subagent] ${message}`));
  const caps = { ...DEFAULT_CAPS, ...deps.budgetCaps };

  const send = (requestId: string, payload: Omit<RPCReply, "version" | "requestId">) => {
    const reply: RPCReply = { version: RPC_VERSION, requestId, ...payload };
    if (isSchema<RPCReply>(RPCReplySchema, reply)) deps.events.emit(replyChannel(requestId), reply);
  };
  const clampBudget = (input: SpawnParams["budgetOverride"]): SpawnRequest["budgetOverride"] => {
    if (!input) return undefined;
    const result: Record<string, number> = {};
    for (const [key, raw] of Object.entries(input)) {
      const cap = caps[key as keyof DeadlineBudget];
      if (typeof raw !== "number" || !Number.isFinite(raw)) continue;
      const bounded = Math.min(Math.max(0, raw), typeof cap === "number" ? cap : Number.MAX_SAFE_INTEGER);
      // totalMs=0 disables the core deadline; RPC callers must not be able to
      // turn a remotely-created run into an unbounded run.
      result[key] = key === "totalMs" ? Math.max(1, bounded) : bounded;
    }
    return result as SpawnRequest["budgetOverride"];
  };
  const onRequest = (raw: unknown) => {
    if (!isSchema<RPCRequest>(RPCRequestSchema, raw)) {
      warn("RPC request rejected: invalid envelope");
      return;
    }
    if (!isValidRequestId(raw.requestId)) {
      warn("RPC request rejected: invalid requestId");
      return;
    }
    if (inFlight.has(raw.requestId)) {
      warn(`RPC request rejected: duplicate requestId ${raw.requestId}`);
      return;
    }
    inFlight.add(raw.requestId);
    void (async () => {
      try {
        if (raw.method === "ping") {
          if (!isSchema(TypeEmpty, raw.params)) throw new Error("ping params must be an empty object");
          send(raw.requestId, { ok: true, result: { version, ready: true } });
        } else if (raw.method === "spawn") {
          if (!isSchema<SpawnParams>(SpawnParamsSchema, raw.params)) throw new Error("invalid spawn params");
          const params = raw.params;
          const budgetOverride = clampBudget(params.budgetOverride);
          const request: SpawnRequest = { ...params, ...(budgetOverride === undefined ? {} : { budgetOverride }) };
          const result = await deps.spawn.spawn(request);
          if ("error" in result) send(raw.requestId, { ok: false, error: result.error });
          else send(raw.requestId, { ok: true, result });
        } else if (raw.method === "stop") {
          if (!isSchema<StopParams>(StopParamsSchema, raw.params)) throw new Error("invalid stop params");
          const params = raw.params;
          send(raw.requestId, {
            ok: true,
            result: await deps.query.stop(params.runId, params.cause as StopCause | undefined),
          });
        } else {
          if (!isSchema<ResultParams>(ResultParamsSchema, raw.params)) throw new Error("invalid result params");
          const params = raw.params;
          const snapshot = deps.query.get(params.runId);
          if (!snapshot) send(raw.requestId, { ok: false, error: error("run not found") });
          else send(raw.requestId, { ok: true, result: snapshot });
        }
      } catch (cause) {
        warn(`RPC ${raw.method} failed: ${cause instanceof Error ? cause.message : "unknown error"}`);
        send(raw.requestId, { ok: false, error: internalError(cause) });
      } finally {
        inFlight.delete(raw.requestId);
      }
    })();
  };
  const unsubscribe = deps.events.on(RPC_REQUEST_CHANNEL, onRequest);
  return {
    close: () => {
      if (typeof unsubscribe === "function") unsubscribe();
    },
  };
}

const TypeEmpty = Type.Object({}, { additionalProperties: false });
