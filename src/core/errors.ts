import type { ErrorInfo, ErrorKind } from "./types.js";

/**
 * Classify an unknown caught value into an ErrorInfo. Used by withDeadline
 * (N6-2) to turn a rejected Promise into a diagnosable, typed error instead of
 * silently mislabeling it as a timeout.
 */
export function toErrorInfo(error: unknown, fallback: ErrorKind = "internal"): ErrorInfo {
  const e = error instanceof Error ? error : new Error(String(error));
  return e.stack === undefined
    ? { kind: fallback, message: e.message, retryable: fallback === "startup_transient" }
    : { kind: fallback, message: e.message, stack: e.stack, retryable: fallback === "startup_transient" };
}
