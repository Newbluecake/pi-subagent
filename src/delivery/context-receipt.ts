import type { Millis, Generation, RunId } from "../core/types.js";
import type { DeliveryState } from "./notifier.js";

export type ContextReceiptKind = "untracked" | "pending" | "entered" | "undeliverable";

export interface ContextReceipt {
  kind: ContextReceiptKind;
  at?: Millis;
}

export interface ContextReceiptTracker {
  noteDelivery(runId: RunId, generation: Generation, state: DeliveryState, at: Millis): void;
  noteEntered(runIds: readonly RunId[], at: Millis): void;
  receiptOf(runId: RunId): ContextReceipt;
  prune(keepRunIds: ReadonlySet<RunId>, now: Millis, opts: { lingerMs: Millis; awaitMs: Millis }): void;
}

interface ReceiptRecord {
  seenAt: Millis;
  enteredAt?: Millis;
  undeliverable?: boolean;
}

/** Tracks whether a terminal notification has reached the host context. */
export function createContextReceiptTracker(): ContextReceiptTracker {
  const records = new Map<RunId, ReceiptRecord>();

  const noteDelivery = (runId: RunId, _generation: Generation, state: DeliveryState, at: Millis): void => {
    const record = records.get(runId);
    if (!record) {
      records.set(runId, {
        seenAt: at,
        ...(state === "consumed" ? { enteredAt: at } : {}),
        ...(state === "dropped" || state === "abandoned" ? { undeliverable: true } : {}),
      });
      return;
    }
    if (state === "consumed" && record.enteredAt === undefined) record.enteredAt = at;
    if ((state === "dropped" || state === "abandoned") && record.enteredAt === undefined) record.undeliverable = true;
  };

  const noteEntered = (runIds: readonly RunId[], at: Millis): void => {
    for (const runId of runIds) {
      const record = records.get(runId) ?? { seenAt: at };
      if (record.enteredAt === undefined) record.enteredAt = at;
      delete record.undeliverable;
      records.set(runId, record);
    }
  };

  const receiptOf = (runId: RunId): ContextReceipt => {
    const record = records.get(runId);
    if (!record) return { kind: "untracked" };
    if (record.enteredAt !== undefined) return { kind: "entered", at: record.enteredAt };
    if (record.undeliverable) return { kind: "undeliverable" };
    return { kind: "pending", at: record.seenAt };
  };

  const prune = (keepRunIds: ReadonlySet<RunId>, now: Millis, opts: { lingerMs: Millis; awaitMs: Millis }): void => {
    for (const [runId, record] of records) {
      const expired =
        record.enteredAt !== undefined
          ? now - record.enteredAt > opts.lingerMs
          : now - record.seenAt > opts.awaitMs + opts.lingerMs;
      if (!keepRunIds.has(runId) || expired) records.delete(runId);
    }
  };

  return { noteDelivery, noteEntered, receiptOf, prune };
}

export function runIdsFromNotificationDetails(details: unknown): RunId[] {
  if (typeof details !== "object" || details === null) return [];
  const value = details as { kind?: unknown; items?: unknown; runId?: unknown };
  if (value.kind === "digest" && Array.isArray(value.items)) {
    return value.items
      .map((item) => (typeof item === "object" && item !== null ? (item as { runId?: unknown }).runId : undefined))
      .filter((runId): runId is RunId => typeof runId === "string");
  }
  return typeof value.runId === "string" ? [value.runId] : [];
}
