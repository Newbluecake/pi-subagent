export interface TruncatedResultText {
  /** The body, plus a truncation marker when the body exceeded maxChars. */
  text: string;
  truncated: boolean;
  /** Original body length in UTF-16 code units. */
  totalChars: number;
}

/**
 * Fraction of the budget given to the head; the rest goes to the tail.
 * Reports typically front-load context and back-load conclusions, so a
 * head-only cut loses the densest section — keep both ends, elide the middle.
 */
const HEAD_RATIO = 0.7;

/**
 * Cap only the result body. Callers append duration/usage trailers after this
 * helper so the cap remains meaningful for the model-facing answer itself.
 */
export function truncateResultText(text: string, maxChars: number, sessionFile?: string): TruncatedResultText {
  const totalChars = text.length;
  if (maxChars <= 0 || totalChars <= maxChars) return { text, truncated: false, totalChars };

  // totalChars > maxChars guarantees tailStart > headLength below.
  let headLength = Math.floor(maxChars * HEAD_RATIO);
  if (headLength > 0) {
    const previous = text.charCodeAt(headLength - 1);
    if (previous >= 0xd800 && previous <= 0xdbff) headLength--;
  }
  let tailStart = totalChars - (maxChars - headLength);
  if (tailStart > headLength) {
    const first = text.charCodeAt(tailStart);
    if (first >= 0xdc00 && first <= 0xdfff) tailStart++;
  }
  const head = text.slice(0, headLength);
  const tail = text.slice(tailStart);
  const omitted = tailStart - headLength;
  const suffix = sessionFile ? `; full session transcript: ${sessionFile} — use the read tool to inspect it` : "";
  return {
    text:
      `${head}\n\n… [middle ${omitted} of ${totalChars} chars omitted ` +
      `— showing first ${headLength} + last ${tail.length}]${suffix}\n\n${tail}`,
    truncated: true,
    totalChars,
  };
}
