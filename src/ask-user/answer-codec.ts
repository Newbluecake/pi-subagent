import type { AnswerValue } from "./types.js";

function hasOwn(record: Record<string, string>, key: string): boolean {
  return Object.prototype.hasOwnProperty.call(record, key);
}

function put(record: Record<string, string>, key: string, value: string): void {
  Object.defineProperty(record, key, {
    configurable: true,
    enumerable: true,
    value,
    writable: true,
  });
}

/** Encode the internal structured value at the RPC protocol boundary. */
export function encodeAnswer(value: AnswerValue, opts: { key: string; multiSelect: boolean }): Record<string, string> {
  const result: Record<string, string> = {};

  if (value.selected.length > 0) {
    const first = value.selected[0];
    if (first !== undefined) {
      put(result, opts.key, opts.multiSelect ? JSON.stringify(value.selected) : first);
    }
  }

  if (value.other !== null && value.other !== "") {
    put(result, `${opts.key}__other`, value.other);
  }

  return result;
}

/**
 * Decode a value from the RPC answers record.
 *
 * Multi-select values are JSON strings, but malformed or legacy values are
 * preserved as one label rather than escaping the protocol boundary.
 */
export function decodeAnswer(
  answers: Record<string, string>,
  key: string,
  multiSelect: boolean,
): string | string[] | undefined {
  if (!hasOwn(answers, key)) return undefined;

  const raw = answers[key];
  if (!multiSelect || raw === undefined) return raw;

  try {
    const parsed: unknown = JSON.parse(raw);
    if (Array.isArray(parsed) && parsed.every((item) => typeof item === "string")) {
      return parsed;
    }
  } catch {
    // Fall through to the lossless single-label fallback below.
  }

  return [raw];
}

export function decodeOther(answers: Record<string, string>, key: string): string | undefined {
  const otherKey = `${key}__other`;
  return hasOwn(answers, otherKey) ? answers[otherKey] : undefined;
}
