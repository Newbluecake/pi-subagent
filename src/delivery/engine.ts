import type { OutboxStore } from "../core/store.js";

export interface EngineOptions<
  R extends { key: string; state: S; attempts: number; updatedAt: number },
  S extends string,
> {
  store: OutboxStore<R>;
  allowed: Readonly<Record<S, readonly S[]>>;
  memoryOnly: ReadonlySet<S>;
  memoryOnlyFields: readonly (keyof R)[];
  now: () => number;
  onDegraded?: (key: string, reason: string) => void;
}

export interface DeliveryEngine<R, S extends string> {
  put(record: R): boolean;
  get(key: string): R | undefined;
  select(pred: (record: R) => boolean): R[];
  transition(
    key: string,
    from: S | readonly S[],
    to: S,
    patch?: Partial<R>,
    guard?: (record: R) => boolean,
  ): R | undefined;
  claim(key: string, token: string): R | undefined;
  annotate(key: string, patch: Partial<R>): boolean;
  freeze(): void;
  fold(list: readonly R[]): Map<string, R>;
  readonly stats: Record<S, number>;
}

function copy<T>(value: T): T {
  return { ...(value as object) } as T;
}

export function createDeliveryEngine<
  R extends { key: string; state: S; attempts: number; updatedAt: number },
  S extends string,
>(options: EngineOptions<R, S>): DeliveryEngine<R, S> {
  const records = new Map<string, R>();
  let frozen = false;
  for (const [key, record] of (() => {
    const folded = new Map<string, R>();
    for (const raw of options.store.list()) {
      const current = folded.get(raw.key);
      if (
        current !== undefined &&
        (current.updatedAt > raw.updatedAt || (current.updatedAt === raw.updatedAt && current.attempts >= raw.attempts))
      )
        continue;
      const normalized = copy(raw);
      if (options.memoryOnly.has(normalized.state)) {
        normalized.state = "pending" as S;
        for (const field of options.memoryOnlyFields) delete (normalized as Record<string, unknown>)[String(field)];
      }
      folded.set(raw.key, normalized);
    }
    return folded;
  })())
    records.set(key, record);

  const withoutMemoryOnly = (patch: Partial<R>): Partial<R> => {
    const result: Record<string, unknown> = { ...(patch as object) };
    for (const field of options.memoryOnlyFields) delete result[String(field)];
    return result as Partial<R>;
  };
  const withoutState = (patch: Partial<R>): Partial<R> => {
    const result: Record<string, unknown> = { ...(patch as object) };
    delete result.state;
    return result as Partial<R>;
  };

  const recordDegraded = (key: string, error: unknown): void => {
    options.onDegraded?.(key, error instanceof Error ? error.message : String(error));
  };

  const stats = (): Record<S, number> => {
    const result = {} as Record<S, number>;
    for (const record of records.values()) result[record.state] = (result[record.state] ?? 0) + 1;
    return result;
  };

  const engine: DeliveryEngine<R, S> = {
    put(record) {
      if (frozen || records.has(record.key)) return false;
      const persisted = withoutMemoryOnly(record);
      try {
        options.store.put(persisted as R);
      } catch (error) {
        throw error;
      }
      records.set(record.key, copy(record));
      return true;
    },
    get(key) {
      const record = records.get(key);
      return record === undefined ? undefined : copy(record);
    },
    select(pred) {
      return [...records.values()].filter(pred).map(copy);
    },
    transition(key, from, to, patch = {}, guard) {
      if (frozen) return undefined;
      const current = records.get(key);
      if (current === undefined) return undefined;
      const allowedFrom = Array.isArray(from) ? from : [from];
      if (
        !allowedFrom.includes(current.state) ||
        options.memoryOnly.has(to) ||
        !(options.allowed[current.state] ?? []).includes(to)
      )
        return undefined;
      if (guard !== undefined && !guard(current)) return undefined;
      const next = { ...current, ...patch, state: to, updatedAt: options.now() } as R;
      records.set(key, next);
      if (!options.memoryOnly.has(to)) {
        try {
          options.store.update(
            key,
            withoutMemoryOnly({ ...patch, state: to, updatedAt: next.updatedAt } as Partial<R>),
          );
        } catch (error) {
          recordDegraded(key, error);
        }
      }
      return copy(next);
    },
    claim(key, token) {
      if (frozen) return undefined;
      const current = records.get(key);
      if (current === undefined || current.state !== ("pending" as S)) return undefined;
      if (!(options.allowed[current.state] ?? []).includes("claimed" as S) || !options.memoryOnly.has("claimed" as S))
        return undefined;
      const next = { ...current, state: "claimed" as S, claimToken: token } as R;
      records.set(key, next);
      return copy(next);
    },
    annotate(key, patch) {
      if (frozen) return false;
      const current = records.get(key);
      if (current === undefined) return false;
      const next = { ...current, ...withoutState(patch), state: current.state, updatedAt: options.now() } as R;
      records.set(key, next);
      try {
        options.store.update(
          key,
          withoutMemoryOnly(withoutState({ ...patch, updatedAt: next.updatedAt } as Partial<R>)),
        );
      } catch (error) {
        recordDegraded(key, error);
      }
      return true;
    },
    freeze() {
      frozen = true;
    },
    fold(list) {
      const folded = new Map<string, R>();
      for (const raw of list) {
        const current = folded.get(raw.key);
        if (
          current !== undefined &&
          (current.updatedAt > raw.updatedAt ||
            (current.updatedAt === raw.updatedAt && current.attempts >= raw.attempts))
        )
          continue;
        const normalized = copy(raw);
        if (options.memoryOnly.has(normalized.state)) {
          normalized.state = "pending" as S;
          for (const field of options.memoryOnlyFields) delete (normalized as Record<string, unknown>)[String(field)];
        }
        folded.set(raw.key, normalized);
      }
      return folded;
    },
    get stats() {
      return stats();
    },
  };

  return engine;
}

export const createEngine = createDeliveryEngine;
