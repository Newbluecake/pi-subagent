export interface TruncatedResultText {
  /** The body, plus a truncation marker when the body exceeded maxChars. */
  text: string;
  truncated: boolean;
  /** Original body length in UTF-16 code units. */
  totalChars: number;
}

/**
 * Cap only the result body. Callers append duration/usage trailers after this
 * helper so the cap remains meaningful for the model-facing answer itself.
 */
export function truncateResultText(text: string, maxChars: number, sessionFile?: string): TruncatedResultText {
  const totalChars = text.length;
  if (maxChars <= 0 || totalChars <= maxChars) return { text, truncated: false, totalChars };

  let bodyLength = maxChars;
  if (bodyLength > 0 && bodyLength < totalChars) {
    const previous = text.charCodeAt(bodyLength - 1);
    if (previous >= 0xd800 && previous <= 0xdbff) bodyLength--;
  }
  const body = text.slice(0, bodyLength);
  const suffix = sessionFile ? `; full session transcript: ${sessionFile} — use the read tool to inspect it` : "";
  return {
    text: `${body}\n\n… [output truncated — showing first ${bodyLength} of ${totalChars} chars]${suffix}`,
    truncated: true,
    totalChars,
  };
}
