/**
 * jev-reflex · input normalization (plan R1 step 2; arch §3.1 S0/S1 both operate on the
 * normalized form). Pure function, no module state (I4).
 *
 * Pipeline (order pinned by tests): NFKC → lowercase → collapse whitespace runs to a single
 * space → trim → strip trailing punctuation (`?？。.!！~`, stacked). `chars` counts CODE POINTS
 * of the final `norm`; `lines` counts the RAW text's physical lines (gate #10).
 */

export interface NormalizedInput {
  norm: string;
  /** Code points of `norm`. */
  chars: number;
  /** Physical line count of the raw input (`"\n"` count + 1). */
  lines: number;
}

const TRAILING_PUNCT = new Set(["?", "？", "。", ".", "!", "！", "~"]);

/** Normalize a raw input line for gate/match/digest (see header for the pinned order). */
export function normalizeInput(text: string): NormalizedInput {
  const lines = (text.match(/\n/g)?.length ?? 0) + 1;
  let norm = text.normalize("NFKC").toLowerCase().replace(/\s+/g, " ").trim();
  // Strip stacked trailing punctuation; nothing can follow it, so one backward walk suffices
  // (whitespace is already collapsed and trimmed).
  let end = norm.length;
  while (end > 0) {
    const ch = norm[end - 1];
    if (ch === undefined || !TRAILING_PUNCT.has(ch)) break;
    end -= 1;
  }
  norm = norm.slice(0, end);
  let chars = 0;
  for (const _ of norm) chars += 1;
  return { norm, chars, lines };
}
