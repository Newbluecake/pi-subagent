import type { Clock } from "../core/clock.js";
import type { OutboxStore as CoreOutboxStore } from "../core/store.js";
import type { DeliveryPayload, SendResult } from "../core/types.js";
import { canonicalizeDeliveryKey, deliveryKey, type DeliveryKey } from "../core/delivery-key.js";

export { canonicalizeDeliveryKey, deliveryKey } from "../core/delivery-key.js";
export type { DeliveryKey } from "../core/delivery-key.js";
export type DeliveryState = "staged" | "pending" | "batched" | "delivered" | "consumed" | "dropped" | "abandoned";
export interface ConsumerIdentity {
  parentRunId?: string;
  extensionOwner?: string;
}
export interface PersistedDelivery extends DeliveryPayload {
  state?: DeliveryState;
  attempts?: number;
  storageKey?: string;
}
export interface ReconcileReport {
  redelivered: DeliveryKey[];
  suppressed: DeliveryKey[];
  abandoned: DeliveryKey[];
}
export type OutboxStore = CoreOutboxStore<PersistedDelivery>;
export interface MessageSender {
  sendMessage(payload: DeliveryPayload): SendResult | void;
  willBuffer?(payload: DeliveryPayload): boolean;
}
export interface NotifierOptions {
  store: OutboxStore;
  sender: MessageSender | ((payload: DeliveryPayload) => SendResult | void);
  cancelBuffered: (key: DeliveryKey) => void;
  clock?: Clock;
  maxAttempts?: number;
  backoffMs?: number;
  reconcileTtlMs?: number;
  maxReconcileRounds?: number;
  maxBatch?: number;
  audit?: (entry: { key: DeliveryKey; state: DeliveryState; error?: string }) => void;
  onDelivery?: (p: DeliveryPayload, state: DeliveryState) => void;
}
export interface Notifier {
  enqueue(payload: DeliveryPayload, opts?: { hold?: boolean }): void;
  finalize(runId: string, generation: number, patch: Partial<DeliveryPayload>): "sent" | "updated" | "late" | "missing";
  settleBatch(keys: readonly DeliveryKey[], ok: boolean): void;
  ack(runId: string, generation: number, by?: ConsumerIdentity): boolean;
  peek(key: DeliveryKey): DeliveryState | undefined;
  consume(key: DeliveryKey, by?: ConsumerIdentity): boolean;
  reconcile(persisted?: readonly PersistedDelivery[]): ReconcileReport;
  verifyPersisted(keys: readonly DeliveryKey[]): { missing: DeliveryKey[] };
  readonly stats: Record<DeliveryState, number>;
  readonly degraded: ReadonlyArray<{ key: DeliveryKey; reason: string; at: number }>;
  readonly ackedSuppressions: number;
}

export function createNotifier(options: NotifierOptions): Notifier {
  if (typeof options.cancelBuffered !== "function")
    throw new Error("createNotifier: cancelBuffered is required (delivery v2 P3)");
  const clock = options.clock ?? {
    now: () => Date.now(),
    setTimer: (ms, fn) => ({ id: setTimeout(fn, ms) as unknown as number }),
    clearTimer: (h) => clearTimeout(h.id),
  };
  const maxAttempts = Math.max(1, options.maxAttempts ?? 3);
  const backoffMs = Math.max(0, options.backoffMs ?? 1_000);
  const ttl = options.reconcileTtlMs ?? 24 * 60 * 60 * 1_000;
  const maxRounds = Math.max(0, options.maxReconcileRounds ?? 3);
  const maxBatch = Math.max(1, options.maxBatch ?? 10);
  const state = new Map<DeliveryKey, PersistedDelivery>();
  const degraded: Array<{ key: string; reason: string; at: number }> = [];
  let suppressed = 0;
  const send: (p: DeliveryPayload) => SendResult | void =
    typeof options.sender === "function" ? options.sender : (p) => (options.sender as MessageSender).sendMessage(p);
  const willBuffer = (p: DeliveryPayload) =>
    typeof options.sender === "object" && options.sender.willBuffer?.(p) === true;
  const audit = (key: string, s: DeliveryState, error?: string) =>
    options.audit?.({ key, state: s, ...(error ? { error } : {}) });
  const notify = (p: PersistedDelivery, s: DeliveryState) => {
    try {
      options.onDelivery?.(p, s);
    } catch (e) {
      console.warn(
        `[pi-subagent] extension hook onDelivery threw (ignored): ${e instanceof Error ? e.message : String(e)}`,
      );
    }
  };
  const fail = (key: string, reason: string) => {
    degraded.push({ key, reason, at: clock.now() });
  };
  const writeBack = (record: PersistedDelivery, patch: Partial<PersistedDelivery>) =>
    options.store.update(record.storageKey ?? record.key, patch);
  const normalize = (raw: PersistedDelivery): PersistedDelivery | undefined => {
    const key = canonicalizeDeliveryKey(raw.key);
    if (raw.key.split(":").length === 3 && key === raw.key) {
      audit(raw.key, "pending", "illegal legacy key");
      return undefined;
    }
    return { ...raw, key, storageKey: raw.storageKey ?? raw.key, state: raw.state ?? "pending" };
  };
  const fold = (items: readonly PersistedDelivery[]) => {
    const groups = new Map<string, PersistedDelivery[]>();
    for (const raw of items) {
      const r = normalize(raw);
      if (!r) continue;
      const a = groups.get(r.key) ?? [];
      a.push(r);
      groups.set(r.key, a);
    }
    const result = new Map<string, PersistedDelivery>();
    for (const [key, records] of groups) {
      const pending = records.filter((r) => ["staged", "pending", "batched", "dropped"].includes(r.state ?? "pending"));
      const candidates = pending.length ? pending : records;
      candidates.sort((a, b) => b.createdAt - a.createdAt || (b.attempts ?? 0) - (a.attempts ?? 0));
      result.set(key, candidates[0]!);
    }
    return result;
  };
  const load = () => {
    try {
      return fold(options.store.list());
    } catch (e) {
      console.warn(
        `[pi-subagent] outbox list failed; delivery lookup degraded: ${e instanceof Error ? e.message : String(e)}`,
      );
      return new Map<DeliveryKey, PersistedDelivery>();
    }
  };
  const persistPut = (record: PersistedDelivery) => {
    state.set(record.key, record);
    try {
      options.store.put(record);
    } catch (e) {
      fail(record.key, `outbox put failed: ${e instanceof Error ? e.message : String(e)}`);
      audit(record.key, "pending", String(e));
    }
  };
  const settleDelivered = (record: PersistedDelivery, round: number) => {
    const next = {
      ...record,
      state: "delivered" as const,
      attempts: (record.attempts ?? 0) + 1,
      reconcileRound: round,
    };
    state.set(next.key, next);
    try {
      writeBack(record, { state: next.state, attempts: next.attempts, reconcileRound: round });
    } catch (e) {
      fail(next.key, `outbox update failed: ${e instanceof Error ? e.message : String(e)}`);
    }
    audit(next.key, "delivered");
    notify(next, "delivered");
  };
  const settleFailed = (record: PersistedDelivery, round: number, error: unknown) => {
    const attempts = (record.attempts ?? 0) + 1;
    const nextState: DeliveryState = attempts >= maxAttempts ? "dropped" : "pending";
    const next = { ...record, state: nextState, attempts, reconcileRound: round };
    state.set(next.key, next);
    try {
      writeBack(record, { state: nextState, attempts, reconcileRound: round });
    } catch (e) {
      fail(next.key, `outbox update failed: ${e instanceof Error ? e.message : String(e)}`);
    }
    const msg = error instanceof Error ? error.message : String(error);
    audit(next.key, nextState, msg);
    notify(next, nextState);
    if (nextState === "pending") clock.setTimer(backoffMs * 2 ** Math.max(0, attempts - 1), () => attempt(next, round));
  };
  const markBatched = (record: PersistedDelivery, round: number) => {
    if (state.get(record.key)?.state === "batched") return;
    const next = { ...record, state: "batched" as const, reconcileRound: round };
    state.set(next.key, next);
    try {
      writeBack(record, { state: next.state, reconcileRound: round });
    } catch (e) {
      fail(next.key, `outbox update failed: ${e instanceof Error ? e.message : String(e)}`);
    }
    audit(next.key, "batched");
    notify(next, "batched");
  };
  const attempt = (record: PersistedDelivery, round: number) => {
    if (state.get(record.key)?.state === "consumed") return;
    const outbound = { ...record, reconcileRound: round };
    const preBuffer = willBuffer(outbound);
    if (preBuffer) markBatched(record, round);
    try {
      const result = send(outbound);
      if (result === "buffered") {
        if (!preBuffer) markBatched(record, round);
        return;
      }
      settleDelivered(record, round);
    } catch (e) {
      settleFailed(record, round, e);
    }
  };
  const releaseStale = (record: PersistedDelivery, round: number) => {
    const next = {
      ...record,
      state: "pending" as const,
      finalized: false,
      degradedReason: "pre-finalize" as const,
      reconcileRound: round + 1,
    };
    try {
      writeBack(record, {
        state: next.state,
        finalized: false,
        degradedReason: next.degradedReason,
        reconcileRound: next.reconcileRound,
      });
    } catch (e) {
      fail(next.key, `outbox update failed: ${e instanceof Error ? e.message : String(e)}`);
    }
    state.set(next.key, next);
    audit(next.key, "pending", "pre-finalize release");
    notify(next, "pending");
    attempt(next, next.reconcileRound);
  };
  return {
    enqueue(payload, opts) {
      const normalized = { ...payload, key: canonicalizeDeliveryKey(payload.key) };
      const current = state.get(normalized.key) ?? load().get(normalized.key);
      if (current && !["dropped", "abandoned"].includes(current.state ?? "pending")) return;
      const record: PersistedDelivery = {
        ...normalized,
        state: opts?.hold ? "staged" : "pending",
        attempts: 0,
        storageKey: current?.storageKey ?? normalized.key,
      };
      if (current && ["dropped", "abandoned"].includes(current.state ?? "pending")) {
        try {
          writeBack(current, { ...normalized, state: record.state!, attempts: 0 });
        } catch (e) {
          fail(record.key, `revive persist failed: ${e instanceof Error ? e.message : String(e)}`);
        }
        state.set(record.key, record);
      } else persistPut(record);
      notify(record, record.state!);
      if (!opts?.hold) attempt(record, normalized.reconcileRound);
    },
    finalize(runId, generation, patch) {
      const key = deliveryKey(runId, generation);
      const record = state.get(key) ?? load().get(key);
      if (!record) return "missing";
      const current = record.state ?? "pending";
      if (current === "staged") {
        const { degradedReason: _oldDegraded, ...withoutDegraded } = record;
        const next = { ...withoutDegraded, ...patch, state: "pending" as const, finalized: true };
        try {
          writeBack(record, {
            ...patch,
            state: next.state,
            finalized: true,
            degradedReason: undefined,
          } as unknown as Partial<PersistedDelivery>);
        } catch (e) {
          fail(key, `finalize persist failed: ${e instanceof Error ? e.message : String(e)}`);
        }
        state.set(key, next);
        notify(next, "pending");
        attempt(next, next.reconcileRound);
        return "sent";
      }
      try {
        writeBack(record, patch);
      } catch (e) {
        fail(key, `finalize persist failed: ${e instanceof Error ? e.message : String(e)}`);
      }
      state.set(key, { ...record, ...patch });
      return "late";
    },
    settleBatch(keys, ok) {
      for (const rawKey of keys) {
        const key = canonicalizeDeliveryKey(rawKey);
        const record = state.get(key) ?? load().get(key);
        if (!record) continue;
        if (ok) settleDelivered(record, record.reconcileRound ?? 0);
        else settleFailed(record, record.reconcileRound ?? 0, new Error("delivery batch failed"));
      }
    },
    ack(runId, generation, by) {
      const key = deliveryKey(runId, generation);
      const record = state.get(key) ?? load().get(key);
      const current = record?.state ?? "pending";
      if (!record || ["consumed", "abandoned", "dropped"].includes(current)) return false;
      try {
        writeBack(record, { state: "consumed" });
      } catch (e) {
        fail(key, `ack persist failed: ${e instanceof Error ? e.message : String(e)}`);
        return false;
      }
      state.set(key, { ...record, state: "consumed" });
      let cancelled = true;
      try {
        options.cancelBuffered(key);
      } catch (e) {
        cancelled = false;
        fail(key, `cancelBuffered failed: ${e instanceof Error ? e.message : String(e)}`);
      }
      if (cancelled && ["staged", "pending", "batched"].includes(current)) suppressed++;
      audit(key, "consumed", "acked");
      notify({ ...record, state: "consumed" }, "consumed");
      void by;
      return true;
    },
    peek(key) {
      return (state.get(canonicalizeDeliveryKey(key)) ?? load().get(canonicalizeDeliveryKey(key)))?.state;
    },
    consume(key) {
      const k = canonicalizeDeliveryKey(key);
      const record = state.get(k) ?? load().get(k);
      if (!record || ["consumed", "abandoned"].includes(record.state ?? "pending")) return false;
      try {
        writeBack(record, { state: "consumed" });
      } catch (e) {
        fail(k, `consume persist failed: ${e instanceof Error ? e.message : String(e)}`);
        return false;
      }
      const next = { ...record, state: "consumed" as const };
      state.set(k, next);
      audit(k, "consumed");
      notify(next, "consumed");
      return true;
    },
    reconcile(persisted = options.store.list()) {
      const report: ReconcileReport = { redelivered: [], suppressed: [], abandoned: [] };
      const folded = fold(persisted);
      const now = clock.now();
      for (const record of folded.values()) {
        const s = record.state ?? "pending";
        if (["consumed", "abandoned", "delivered"].includes(s)) continue;
        if (now - record.createdAt > ttl) {
          try {
            writeBack(record, { state: "abandoned" });
          } catch (e) {
            fail(record.key, `abandon persist failed: ${e instanceof Error ? e.message : String(e)}`);
          }
          state.set(record.key, { ...record, state: "abandoned" });
          audit(record.key, "abandoned", "reconcile ttl exceeded");
          notify(record, "abandoned");
          report.suppressed.push(record.key);
          continue;
        }
        if ((record.reconcileRound ?? 0) >= maxRounds) {
          try {
            writeBack(record, { state: "abandoned" });
          } catch (e) {
            fail(record.key, `abandon persist failed: ${e instanceof Error ? e.message : String(e)}`);
          }
          state.set(record.key, { ...record, state: "abandoned" });
          audit(record.key, "abandoned", "reconcile rounds exceeded");
          notify(record, "abandoned");
          report.abandoned.push(record.key);
          continue;
        }
        if (report.redelivered.length >= maxBatch) continue;
        if (s === "staged") releaseStale(record, record.reconcileRound ?? 0);
        else {
          const next = { ...record, state: "pending" as const };
          state.set(record.key, next);
          attempt(next, (record.reconcileRound ?? 0) + 1);
        }
        report.redelivered.push(record.key);
      }
      return report;
    },
    verifyPersisted(keys) {
      const present = fold(options.store.list());
      return { missing: keys.filter((k) => !present.has(canonicalizeDeliveryKey(k))) };
    },
    get stats() {
      const result: Record<DeliveryState, number> = {
        staged: 0,
        pending: 0,
        batched: 0,
        delivered: 0,
        consumed: 0,
        dropped: 0,
        abandoned: 0,
      };
      for (const r of state.values()) result[r.state ?? "pending"]++;
      return result;
    },
    degraded,
    get ackedSuppressions() {
      return suppressed;
    },
  };
}
