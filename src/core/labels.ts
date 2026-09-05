/** Final label maximum length, measured in Unicode code points. */
export const MAX_LABEL_LENGTH = 40;
/** Base length leaves room for the largest defensive suffix (-999). */
export const MAX_LABEL_BASE_LENGTH = 36;
/** Maximum suffix attempt. */
export const MAX_LABEL_ATTEMPTS = 999;

/** Normalize human input into a whitespace-free label base suitable for @mentions. */
export function sanitizeLabelBase(raw: string): string | undefined {
  const normalized = raw
    .replace(/[\u0000-\u001f\u007f\s]+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-+|-+$/g, "");
  const codePoints = [...normalized].slice(0, MAX_LABEL_BASE_LENGTH).join("");
  return codePoints.length > 0 ? codePoints : undefined;
}

/** Return the first free label, using a stable linear numeric suffix. */
export function deriveUniqueLabel(base: string, isTaken: (label: string) => boolean): string | undefined {
  if (!isTaken(base)) return base;
  for (let attempt = 2; attempt <= MAX_LABEL_ATTEMPTS; attempt += 1) {
    const candidate = `${base}-${attempt}`;
    if (!isTaken(candidate)) return candidate;
  }
  return undefined;
}

/** First non-empty line, preserving its original contents for sanitization. */
export function firstNonEmptyLine(value: string): string | undefined {
  return value.split(/\r?\n/).find((line) => sanitizeLabelBase(line) !== undefined);
}
