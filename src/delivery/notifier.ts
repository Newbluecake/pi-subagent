import type { Clock } from "../core/clock.js";
import type { DeliveryPayload, RunOutcome } from "../core/types.js";

export type DeliveryKey = string;
export type DeliveryState = "pending" | "delivered" | "consumed" | "dropped" | "abandoned";
export interface ConsumerIdentity {
  parentRunId?: string;
  extensionOwner?: string;
}
export interface PersistedDelivery extends DeliveryPayload {
  state?: DeliveryState;
  attempts?: number;
}
export interface ReconcileReport {
  redelivered: DeliveryKey[];
  suppressed: DeliveryKey[];
  abandoned: DeliveryKey[];
}
export interface OutboxStore {
  put(record: PersistedDelivery): void;
  update(key: DeliveryKey, patch: Partial<PersistedDelivery>): void;
  list(): readonly PersistedDelivery[];
}
export interface MessageSender {
  sendMessage(payload: DeliveryPayload): void;
}
export interface NotifierOptions {
  store: OutboxStore;
  sender: MessageSender | ((payload: DeliveryPayload) => void);
  clock?: Clock;
  maxAttempts?: number;
  backoffMs?: number;
  reconcileTtlMs?: number;
  maxReconcileRounds?: number;
  maxBatch?: number;
  audit?: (entry: { key: DeliveryKey; state: DeliveryState; error?: string }) => void;
}
export interface Notifier {
  enqueue(payload: DeliveryPayload): void;
  consume(key: DeliveryKey, by?: ConsumerIdentity): boolean;
  reconcile(persisted?: readonly PersistedDelivery[]): ReconcileReport;
  verifyPersisted(keys: readonly DeliveryKey[]): { missing: DeliveryKey[] };
  readonly stats: Record<DeliveryState, number>;
  readonly degraded: ReadonlyArray<{ key: DeliveryKey; reason: string; at: number }>;
}
export function deliveryKey(runId: string, generation: number, status: RunOutcome["status"]): DeliveryKey {
  return `${runId}:${generation}:${status}`;
}
export function createNotifier(options: NotifierOptions): Notifier {
  const clock = options.clock ?? {
    now: () => Date.now(),
    setTimer: (ms: number, fn: () => void) => ({ id: setTimeout(fn, ms) as unknown as number }),
    clearTimer: (h: { id: number }) => clearTimeout(h.id),
  };
  const maxAttempts = Math.max(1, options.maxAttempts ?? 3);
  const backoffMs = Math.max(0, options.backoffMs ?? 1_000);
  const ttl = options.reconcileTtlMs ?? 24 * 60 * 60 * 1_000;
  const maxRounds = Math.max(0, options.maxReconcileRounds ?? 3);
  const maxBatch = Math.max(1, options.maxBatch ?? 10);
  const state = new Map<DeliveryKey, PersistedDelivery>();
  const degraded: Array<{ key: DeliveryKey; reason: string; at: number }> = [];
  const sender = options.sender;
  let send: (payload: DeliveryPayload) => void;
  if (typeof sender === "function") send = sender;
  else send = (payload) => sender.sendMessage(payload);
  const audit = (key: DeliveryKey, value: DeliveryState, error?: string) => {
    options.audit?.({ key, state: value, ...(error ? { error } : {}) });
  };
  const persist = (record: PersistedDelivery) => {
    state.set(record.key, record);
    options.store.put(record);
  };
  const attempt = (record: PersistedDelivery, round: number) => {
    if (state.get(record.key)?.state === "consumed") return;
    try {
      send(record);
      const next = {
        ...record,
        state: "delivered" as const,
        attempts: (record.attempts ?? 0) + 1,
        reconcileRound: round,
      };
      state.set(record.key, next);
      options.store.update(record.key, { state: next.state, attempts: next.attempts, reconcileRound: round });
      audit(record.key, "delivered");
    } catch (error) {
      const attempts = (record.attempts ?? 0) + 1;
      const nextState: DeliveryState = attempts >= maxAttempts ? "dropped" : "pending";
      const next = { ...record, state: nextState, attempts, reconcileRound: round };
      state.set(record.key, next);
      options.store.update(record.key, { state: nextState, attempts, reconcileRound: round });
      const message = error instanceof Error ? error.message : String(error);
      audit(record.key, nextState, message);
      if (nextState === "pending")
        clock.setTimer(backoffMs * 2 ** Math.max(0, attempts - 1), () => attempt(next, round));
    }
  };
  return {
    enqueue(payload) {
      if (state.has(payload.key)) return;
      const record: PersistedDelivery = { ...payload, state: "pending", attempts: 0 };
      persist(record);
      attempt(record, payload.reconcileRound);
    },
    consume(key) {
      const record = state.get(key) ?? options.store.list().find((x) => x.key === key);
      if (!record || record.state === "consumed" || record.state === "abandoned") return false;
      state.set(key, { ...record, state: "consumed" });
      options.store.update(key, { state: "consumed" });
      audit(key, "consumed");
      return true;
    },
    reconcile(persisted = options.store.list()) {
      const report: ReconcileReport = { redelivered: [], suppressed: [], abandoned: [] };
      const candidates = persisted
        .filter((p) => p.state !== "consumed" && p.state !== "abandoned")
        .filter((p) => !state.has(p.key) || state.get(p.key)?.state !== "consumed");
      const now = clock.now();
      const eligible = candidates.filter((p) => {
        if (now - p.createdAt > ttl) {
          options.store.update(p.key, { state: "abandoned" });
          audit(p.key, "abandoned", "reconcile ttl exceeded");
          report.suppressed.push(p.key);
          return false;
        }
        if ((p.reconcileRound ?? 0) >= maxRounds) {
          options.store.update(p.key, { state: "abandoned" });
          audit(p.key, "abandoned", "reconcile rounds exceeded");
          report.abandoned.push(p.key);
          return false;
        }
        return true;
      });
      eligible.slice(0, maxBatch).forEach((p) => {
        state.set(p.key, p);
        attempt(p, (p.reconcileRound ?? 0) + 1);
        report.redelivered.push(p.key);
      });
      if (eligible.length > maxBatch)
        audit(`summary:${now}`, "delivered", `${eligible.length - maxBatch} deliveries summarized`);
      return report;
    },
    verifyPersisted(keys) {
      const present = new Set(options.store.list().map((x) => x.key));
      return { missing: keys.filter((key) => !present.has(key)) };
    },
    get stats() {
      const result: Record<DeliveryState, number> = { pending: 0, delivered: 0, consumed: 0, dropped: 0, abandoned: 0 };
      for (const r of state.values()) result[r.state ?? "pending"]++;
      return result;
    },
    degraded,
  };
}
