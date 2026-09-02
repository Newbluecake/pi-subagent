import type { Generation, RunId } from "./types.js";
import { isRunId } from "./ids.js";

export type DeliveryKey = string;

export function deliveryKey(runId: RunId, generation: Generation): DeliveryKey {
  return `${runId}:${generation}`;
}

const TERMINAL = new Set(["completed", "failed", "timed_out", "aborted"]);

export function canonicalizeDeliveryKey(key: string): DeliveryKey {
  const parts = key.split(":");
  return parts.length === 3 && TERMINAL.has(parts[2]!) ? `${parts[0]}:${parts[1]}` : key;
}

export function parseDeliveryKey(key: string): { runId: RunId; generation: Generation } | undefined {
  const parts = canonicalizeDeliveryKey(key).split(":");
  if (parts.length !== 2) return undefined;
  const generation = Number(parts[1]);
  if (!Number.isInteger(generation) || generation < 1 || !isRunId(parts[0]!)) return undefined;
  return { runId: parts[0]!, generation };
}
