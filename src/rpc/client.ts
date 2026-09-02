import { randomUUID } from "node:crypto";
import type { ErrorInfo, StopCause } from "../core/types.js";
import type { StopResult } from "../service/query-service.js";
import {
  DEFAULT_RPC_TIMEOUT_MS,
  RPC_REQUEST_CHANNEL,
  RPCReplySchema,
  RPC_VERSION,
  isSchema,
  replyChannel,
  type RPCEventBus,
  type RPCReply,
} from "./protocol.js";

export class RPCError extends Error {
  readonly info: ErrorInfo;
  constructor(info: ErrorInfo) {
    super(info.message);
    this.name = "RPCError";
    this.info = info;
  }
}
export interface RPCClientOptions {
  events: RPCEventBus;
  timeoutMs?: number;
  requestId?: () => string;
}
export type RPCMethod = "ping" | "spawn" | "stop" | "result";
export interface RPCClient {
  call<T = unknown>(method: RPCMethod, params: unknown): Promise<T>;
  ping(): Promise<{ version: string; ready: boolean }>;
  stop(runId: string, cause?: Extract<StopCause, "user_stop" | "shutdown">): Promise<StopResult>;
}

export function createRPCClient(options: RPCClientOptions): RPCClient {
  const timeoutMs = options.timeoutMs ?? DEFAULT_RPC_TIMEOUT_MS;
  const makeId = options.requestId ?? (() => randomUUID());
  return {
    call<T>(method: RPCMethod, params: unknown) {
      const requestId = makeId();
      if (typeof requestId !== "string" || requestId.length === 0)
        return Promise.reject(new Error("invalid request id"));
      return new Promise<T>((resolve, reject) => {
        let settled = false;
        const channel = replyChannel(requestId);
        const finish = (fn: () => void) => {
          if (settled) return;
          settled = true;
          if (unsubscribe) unsubscribe();
          clearTimeout(timer);
          fn();
        };
        const listener = (raw: unknown) => {
          if (!isSchema<RPCReply>(RPCReplySchema, raw) || raw.requestId !== requestId) return;
          finish(() => {
            if (raw.ok) resolve(raw.result as T);
            else {
              const info: ErrorInfo = (raw.error as ErrorInfo | undefined) ?? {
                kind: "internal",
                message: "RPC failed",
                retryable: false,
              };
              reject(new RPCError(info));
            }
          });
        };
        const unsubscribeResult = options.events.on(channel, listener);
        const unsubscribe = typeof unsubscribeResult === "function" ? unsubscribeResult : undefined;
        const timer = setTimeout(
          () => finish(() => reject(new Error(`RPC ${method} timed out after ${timeoutMs}ms`))),
          timeoutMs,
        );
        options.events.emit(RPC_REQUEST_CHANNEL, { version: RPC_VERSION, requestId, method, params });
      });
    },
    ping() {
      return this.call("ping", {}) as Promise<{ version: string; ready: boolean }>;
    },
    stop(runId, cause) {
      return this.call("stop", { runId, ...(cause ? { cause } : {}) }) as Promise<StopResult>;
    },
  };
}
