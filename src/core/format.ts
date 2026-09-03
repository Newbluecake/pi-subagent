import type { Millis } from "./types.js";

/**
 * Compact human-readable duration ("500ms" / "59s" / "1m05s" / "1h02m"),
 * clamped so negative inputs render as "0ms".
 *
 * Lives in core (zero outward deps) so lower layers — e.g. the bash job
 * manager — can format durations without importing the UI view-model
 * (`ui/fleet-panel`), which would be a reverse layering dependency.
 */
export function formatDuration(ms: Millis): string {
  const clamped = Math.max(0, Math.round(ms));
  if (clamped < 1000) return `${clamped}ms`;
  const s = Math.floor(clamped / 1000);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m${String(s % 60).padStart(2, "0")}s`;
  const h = Math.floor(m / 60);
  return `${h}h${String(m % 60).padStart(2, "0")}m`;
}
