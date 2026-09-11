import type { DeliveryPayload } from "../core/types.js";

/** Character budget for the result preview in a completion notification. */
export const PREVIEW_BUDGET_CHARS = 200;

/**
 * Line budget for the preview, matching the tool-card collapse budget
 * (ui/capped-body.ts): without it, 200 characters of short lines could still
 * stack into a wall of text in the notification.
 */
export const PREVIEW_BUDGET_LINES = 6;

export interface MarkdownPreviewTruncation {
  text: string;
  truncated: boolean;
}

/**
 * Markdown-aware truncation for notification previews. pi renders the
 * notification text through the assistant markdown pipeline, so a naive
 * slice can cut a line in half, split a ``` fence (turning everything after
 * it into a code block), or break a table row / link / bold marker. This
 * helper keeps the preview structurally valid:
 *
 *  - line-granular: only whole lines are kept; the budget is measured as the
 *    joined length of the kept lines (characters including the "\n"
 *    separators, so `text.length` is directly comparable);
 *  - single-line overflow degenerates to a plain character slice (the
 *    historical behavior — there is no whole line to keep);
 *  - an open code fence in the kept prefix is closed with a trailing ```
 *    line (a language-tagged opener like ```ts counts as an opener);
 *  - both a character budget and a line budget apply; exceeding either marks
 *    the result as truncated.
 *
 * A table prefix cut mid-block (header + separator + some rows) is left as
 * is: it is still a structurally valid table, and the full-output hint goes
 * on its own line (see formatSingle) so it cannot corrupt the separator row.
 *
 * The closing fence may itself push the output past the character budget —
 * structural validity takes priority over strict length.
 */
export function truncateMarkdownPreview(
  text: string,
  budget = PREVIEW_BUDGET_CHARS,
  maxLines = PREVIEW_BUDGET_LINES,
): MarkdownPreviewTruncation {
  const lines = text.split("\n");
  if (text.length <= budget && lines.length <= maxLines) return { text, truncated: false };
  const kept: string[] = [];
  let joined = 0;
  for (const line of lines) {
    const next = kept.length === 0 ? line.length : joined + 1 + line.length;
    if (kept.length >= maxLines || next > budget) break;
    kept.push(line);
    joined = next;
  }
  if (kept.length === 0) {
    return { text: text.slice(0, budget), truncated: true };
  }
  let out = kept.join("\n");
  const fences = kept.filter((l) => l.trimStart().startsWith("```")).length;
  if (fences % 2 === 1) out += "\n```";
  return { text: out, truncated: true };
}

/**
 * Digest details are discriminated by `kind`. Consumers must check
 * `details.kind === "digest"` first and read `items`; otherwise read the
 * single-delivery payload. Compatibility fields on a digest are not semantic.
 */
export function formatSingle(p: DeliveryPayload, ctx?: { stats?: string }): string {
  const stats = ctx?.stats;
  const tail = p.failReason ?? (p.textPreview || undefined);
  const preview = tail ? truncateMarkdownPreview(tail) : undefined;
  const multiline = preview?.text.includes("\n") ?? false;
  // Same paragraph rule as the hint below: glued onto the last line of a
  // multi-line preview, this note would corrupt that markdown construct.
  const degradedNote = 'pre-finalize snapshot; run get_subagent_result "' + p.runId.slice(0, 8) + '" to confirm';
  const degradedTail =
    p.degradedReason === "pre-finalize" ? (multiline ? `\n\n(${degradedNote})` : ` (${degradedNote})`) : "";
  const who = p.label ? `"${p.label}" (#${p.runId.slice(0, 8)})` : `#${p.runId.slice(0, 8)}`;
  // The hint must be its own paragraph when the preview is multi-line:
  // glued onto the last line it corrupts that markdown construct, and without
  // a separating blank line a trailing table would absorb it as a data row.
  // Single-line previews keep the historical inline " — hint" form
  // (byte-identical to the pre-markdown behavior).
  const hintText = `get_subagent_result "${p.runId.slice(0, 8)}" for full output`;
  const hint = preview?.truncated ? (multiline ? `\n\n— ${hintText}` : ` — ${hintText}`) : "";
  return (
    `Subagent ${who} ${p.status}` +
    (stats ? ` — ${stats}` : "") +
    (preview ? `: ${preview.text}` : "") +
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
