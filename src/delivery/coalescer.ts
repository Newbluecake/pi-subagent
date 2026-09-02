import type { Clock } from "../core/clock.js";
import type { DeliveryKey } from "../core/delivery-key.js";
import type { DeliveryPayload, SendResult } from "../core/types.js";

export interface Coalescer {
  submit(payload: DeliveryPayload): SendResult;
  cancel(key: DeliveryKey): boolean;
  flush(): void;
  dispose(): void;
}

export function isCoalescible(payload: DeliveryPayload): boolean {
  return (
    payload.status === "completed" &&
    !payload.degradedReason &&
    (payload.reconcileRound ?? 0) === 0 &&
    (payload.attempts ?? 0) === 0
  );
}

export function createCoalescer(deps: {
  clock: Clock;
  windowMs: number;
  maxBatch: number;
  send(items: readonly DeliveryPayload[]): void;
  onSettled(keys: readonly DeliveryKey[], ok: boolean): void;
}): Coalescer {
  const buffered = new Map<DeliveryKey, DeliveryPayload>();
  let timer: ReturnType<Clock["setTimer"]> | undefined;
  let disposed = false;

  const flush = () => {
    if (timer) {
      deps.clock.clearTimer(timer);
      timer = undefined;
    }
    if (!buffered.size) return;
    const items = [...buffered.values()];
    buffered.clear();
    const keys = items.map((item) => item.key);
    try {
      deps.send(items);
    } catch {
      deps.onSettled(keys, false);
      return;
    }
    deps.onSettled(keys, true);
  };

  return {
    submit(payload) {
      if (disposed) {
        deps.send([payload]);
        return "sent";
      }
      if (!timer) timer = deps.clock.setTimer(deps.windowMs, flush);
      buffered.set(payload.key, payload);
      if (buffered.size >= Math.max(1, deps.maxBatch)) flush();
      return "buffered";
    },
    cancel(key) {
      return buffered.delete(key);
    },
    flush,
    dispose() {
      if (disposed) return;
      disposed = true;
      flush();
    },
  };
}
