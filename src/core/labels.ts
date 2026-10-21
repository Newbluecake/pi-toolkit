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

/** Display-title maximum length, measured in Unicode code points. */
export const MAX_DISPLAY_TITLE_LENGTH = 120;

/**
 * Capture a human description as a display-only title: the first non-empty
 * line with control characters stripped, outer whitespace trimmed (inner
 * whitespace preserved — unlike the label, nothing is dasherized), capped at
 * MAX_DISPLAY_TITLE_LENGTH code points. Undefined when nothing usable remains.
 */
export function captureDisplayTitle(raw: string): string | undefined {
  const line = firstNonEmptyLine(raw);
  if (line === undefined) return undefined;
  const cleaned = line.replace(/[\u0000-\u001f\u007f]+/g, "").trim();
  const codePoints = [...cleaned].slice(0, MAX_DISPLAY_TITLE_LENGTH).join("");
  return codePoints.length > 0 ? codePoints : undefined;
}
