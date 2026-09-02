import type { DeliveryPayload } from "../core/types.js";

/**
 * Digest details are discriminated by `kind`. Consumers must check
 * `details.kind === "digest"` first and read `items`; otherwise read the
 * single-delivery payload. Compatibility fields on a digest are not semantic.
 */
export function formatSingle(p: DeliveryPayload, ctx?: { stats?: string }): string {
  const stats = ctx?.stats;
  const degradedTail =
    p.degradedReason === "pre-finalize"
      ? ' (pre-finalize snapshot; run get_subagent_result "' + p.runId.slice(0, 8) + '" to confirm)'
      : "";
  const tail = p.failReason ?? (p.textPreview || undefined);
  const who = p.label ? `"${p.label}" (#${p.runId.slice(0, 8)})` : `#${p.runId.slice(0, 8)}`;
  const truncated = tail !== undefined && tail.length > 200;
  const hint = truncated ? ` — get_subagent_result "${p.runId.slice(0, 8)}" for full output` : "";
  return (
    `Subagent ${who} ${p.status}` +
    (stats ? ` — ${stats}` : "") +
    (tail ? `: ${tail.slice(0, 200)}` : "") +
    degradedTail +
    hint
  );
}

export function formatDigest(items: readonly DeliveryPayload[], ctx?: { stats?: Record<string, string> }): string {
  const lines = [`${items.length} subagents settled:`];
  for (const item of items) {
    const who = item.label ? `"${item.label}" (#${item.runId.slice(0, 8)})` : `#${item.runId.slice(0, 8)}`;
    const stats = ctx?.stats?.[item.key];
    lines.push(`✓ ${who}${stats ? ` — ${stats}` : ""}`);
  }
  return lines.join("\n");
}
