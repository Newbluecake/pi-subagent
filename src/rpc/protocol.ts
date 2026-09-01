import { Type, type Static } from "@sinclair/typebox";
import { Value } from "@sinclair/typebox/value";
import type { ErrorInfo } from "../core/types.js";

export const RPC_VERSION = "1";
export const RPC_REQUEST_CHANNEL = "subagent:rpc:request";
export const RPC_REPLY_PREFIX = "subagent:rpc:reply:";
export const DEFAULT_RPC_TIMEOUT_MS = 30_000;
export const MAX_REQUEST_ID_LENGTH = 128;

const requestId = Type.String({ minLength: 1, maxLength: MAX_REQUEST_ID_LENGTH });
const budgetNumber = Type.Number({ minimum: 0, maximum: Number.MAX_SAFE_INTEGER });
export const SpawnParamsSchema = Type.Object(
  {
    type: Type.String({ minLength: 1, maxLength: 256 }),
    prompt: Type.String({ minLength: 1 }),
    label: Type.Optional(Type.String({ maxLength: 256 })),
    cwd: Type.Optional(Type.String()),
    modelOverride: Type.Optional(Type.Object({ provider: Type.String(), id: Type.String() })),
    thinkingOverride: Type.Optional(
      Type.Union([Type.Literal("off"), Type.Literal("low"), Type.Literal("medium"), Type.Literal("high")]),
    ),
    budgetOverride: Type.Optional(
      Type.Object(
        {
          queueWaitMs: Type.Optional(budgetNumber),
          startupMs: Type.Optional(budgetNumber),
          bindMs: Type.Optional(budgetNumber),
          firstEventMs: Type.Optional(budgetNumber),
          idleMs: Type.Optional(budgetNumber),
          toolMs: Type.Optional(budgetNumber),
          compactionMs: Type.Optional(budgetNumber),
          totalMs: Type.Optional(budgetNumber),
          abortGraceMs: Type.Optional(budgetNumber),
          steerMs: Type.Optional(budgetNumber),
          reapMs: Type.Optional(budgetNumber),
          startupRetries: Type.Optional(Type.Integer({ minimum: 0, maximum: 100 })),
          retrySlackMs: Type.Optional(budgetNumber),
        },
        { additionalProperties: false },
      ),
    ),
    parentRunId: Type.Optional(Type.String()),
  },
  { additionalProperties: false },
);
export const StopParamsSchema = Type.Object(
  {
    runId: Type.String({ minLength: 1 }),
    cause: Type.Optional(Type.Union([Type.Literal("user_stop"), Type.Literal("shutdown")])),
  },
  { additionalProperties: false },
);
export const ResultParamsSchema = Type.Object(
  { runId: Type.String({ minLength: 1 }) },
  { additionalProperties: false },
);

export const RPCRequestSchema = Type.Object(
  {
    version: Type.Literal(RPC_VERSION),
    requestId,
    method: Type.Union([Type.Literal("ping"), Type.Literal("spawn"), Type.Literal("stop"), Type.Literal("result")]),
    params: Type.Unknown(),
  },
  { additionalProperties: false },
);
export const RPCReplySchema = Type.Object(
  {
    version: Type.Literal(RPC_VERSION),
    requestId,
    ok: Type.Boolean(),
    result: Type.Optional(Type.Unknown()),
    error: Type.Optional(Type.Object({ kind: Type.String(), message: Type.String(), retryable: Type.Boolean() })),
  },
  { additionalProperties: false },
);

export type SpawnParams = Static<typeof SpawnParamsSchema>;
export type StopParams = Static<typeof StopParamsSchema>;
export type ResultParams = Static<typeof ResultParamsSchema>;
export type RPCRequest = Static<typeof RPCRequestSchema>;
export type RPCReply = Static<typeof RPCReplySchema>;

export interface RPCEventBus {
  on(channel: string, listener: (payload: unknown) => void): void | (() => void);
  emit(channel: string, payload: unknown): void;
}

export function isSchema<T>(schema: Parameters<typeof Value.Check>[0], value: unknown): value is T {
  return Value.Check(schema, value);
}
export function replyChannel(id: string): string {
  return `${RPC_REPLY_PREFIX}${id}`;
}
export function isValidRequestId(value: unknown): value is string {
  return typeof value === "string" && value.length > 0 && value.length <= MAX_REQUEST_ID_LENGTH;
}
export function internalError(error: unknown): ErrorInfo {
  return {
    kind: "internal",
    message: error instanceof Error ? error.message : "RPC operation failed",
    retryable: true,
  };
}
