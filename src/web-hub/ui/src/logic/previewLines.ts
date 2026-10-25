/**
 * Preview line numbers (2026-10-23, L1) — the DOM-free half: splitting preview source text
 * (or an already-flattened Prism token list) into per-logical-line part lists, line counting
 * for the size cap, and the gutter-width digit helper. The renderer is
 * `components/shared/CodeLines.vue` (one block element per line, the number itself a CSS
 * counter in `::before` — never a DOM node, so selection/copy stay pure body text and the
 * per-line DOM cost is exactly one element, virtual-list-replaceable later).
 *
 * Line-shape contract (pinned by `tests/web-hub/ui/logic-preview-lines.test.ts`):
 *  - one `CodeLine` per LOGICAL line; each line's parts END with the line's own "\n"
 *    terminator (unselectable rendering detail: a block-final newline is swallowed by the
 *    browser, so it is invisible on screen) — this keeps `lines.flatMap(parts).text` and the
 *    rendered element's `textContent` BYTE-IDENTICAL to the legacy single-`<pre>` body;
 *  - a line that is empty between two terminators becomes the single part `"\n"` (a block
 *    whose only content is a newline still renders a full-height blank line);
 *  - a SOURCE-FINAL "\n" produces NO trailing phantom line (a `<pre>` swallows it too);
 *  - cross-line tokens (template strings, block comments) are CUT at the terminator, the
 *    `tok-*` class carried to both pieces, so highlighting survives the per-line split.
 *
 * Nothing here imports Vue or touches the DOM — the same discipline as `./preview.js`.
 */

/** One renderable fragment of a line: `cls` is "" (plain text node) or a `tok-*` class list. */
export interface CodeLinePart {
  readonly cls: string;
  readonly text: string;
}

/** One logical source line; concatenating all parts' texts yields the line incl. its "\n". */
export type CodeLine = readonly CodeLinePart[];

/**
 * Per-line rendering cap: past this many lines the numbered view degrades to the legacy
 * single-block body (the line-number toggle then has no effect and PreviewText shows a
 * note). The highlight engine's own 3000-line/100 KiB gates (`shouldHighlight`) stay the
 * TOKENIZING limit — this one only bounds the per-line element count ahead of the planned
 * virtual-scroll work.
 */
export const PREVIEW_NUMBERED_LINES_MAX = 8000;

/**
 * Plain text → code lines. The split keeps each line's terminator on the line (see the
 * header), drops exactly ONE source-final empty piece, and maps "" (empty input) to zero
 * lines. O(n), two allocations per line at most.
 */
export function splitTextIntoCodeLines(text: string): CodeLine[] {
  if (text === "") return [];
  const pieces = text.split("\n");
  const out: CodeLine[] = [];
  for (let i = 0; i < pieces.length; i++) {
    const piece = pieces[i]!;
    if (i === pieces.length - 1) {
      if (piece !== "") out.push([{ cls: "", text: piece }]);
      break; // a source-final "\n" is swallowed by the block — no phantom last line
    }
    out.push([{ cls: "", text: piece + "\n" }]);
  }
  return out;
}

/**
 * Flat token parts (`@logic/highlight.js`'s `flattenTokens` output — adjacent same-class
 * runs already merged, no empty texts) → code lines. Cross-line parts are cut at every
 * "\n", the class carried to both sides; the terminator rides the piece it ends. The same
 * trailing rules as `splitTextIntoCodeLines` apply (a part list is just a classed text).
 */
export function splitPartsIntoCodeLines(parts: readonly CodeLinePart[]): CodeLine[] {
  const out: CodeLinePart[][] = [];
  let cur: CodeLinePart[] = [];
  for (const part of parts) {
    if (part.text === "") continue;
    let rest = part.text;
    let idx = rest.indexOf("\n");
    while (idx >= 0) {
      cur.push({ cls: part.cls, text: rest.slice(0, idx + 1) }); // the terminator ends this line
      out.push(cur);
      cur = [];
      rest = rest.slice(idx + 1);
      idx = rest.indexOf("\n");
    }
    if (rest !== "") cur.push({ cls: part.cls, text: rest });
  }
  // cur empty ⇒ the text ended with "\n" (no phantom line); otherwise it is the last line.
  if (cur.length > 0) out.push(cur);
  return out;
}

/**
 * Number of rendered logical lines in `text` (what `splitTextIntoCodeLines(text).length`
 * would return) without allocating anything — the cap check runs this on every body.
 */
export function countCodeLines(text: string): number {
  if (text === "") return 0;
  let newlines = 0;
  for (let i = 0; i < text.length; i++) if (text.charCodeAt(i) === 10) newlines++;
  return text.endsWith("\n") ? newlines : newlines + 1;
}

/** Gutter width in `ch` for the largest line number shown — at least 2 (a single-digit
 *  gutter looks cramped), otherwise the decimal digit count. */
export function lineNumberDigits(maxLine: number): number {
  const n = Number.isFinite(maxLine) && maxLine >= 1 ? Math.floor(maxLine) : 1;
  return Math.max(2, String(n).length);
}
