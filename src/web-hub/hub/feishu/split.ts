/**
 * Feishu reply splitting (bot plan §6.1 + R1 #13, package F7). Pure and pi-free: no I/O, no timers, no state.
 *
 * The platform limit is on the **serialized card JSON in UTF-8 bytes** (`FEISHU_REPLY_LIMITS.maxCardBytes`), not
 * on characters. A markdown body is embedded in the card as one JSON string, and JSON string escaping is
 * strictly per code unit, so the cost of a body is `chrome + Σ jsonBytes(piece)` — additive over concatenation
 * (a newline costs 2 bytes: `\n`). This module therefore works in "JSON-escaped body bytes" and the caller
 * (`render.ts`) subtracts the real serialized chrome (measured, not guessed) from the cap to get the budget.
 *
 * Splitting rules (frozen, pinned by tests):
 * 1. Prefer paragraph boundaries (blank line, heading, before/after a fenced block) once the part is ≥ 40 % full;
 *    otherwise break at a line boundary.
 * 2. A fenced code block that has to be cut is closed at the end of the part (same fence char/length) and RE-OPENED
 *    with its original opener line (info string kept) at the top of the next part. A part never consists of only
 *    an opener + closer.
 * 3. A single line longer than the budget is cut at a whitespace boundary when one lies in the last half of the
 *    piece, else at a grapheme-cluster boundary (`Intl.Segmenter`); a cluster larger than the whole budget is cut
 *    by code point. A surrogate pair is never cut.
 * 4. Leading blank lines of a part (outside a fence) are dropped; trailing blank lines (outside a fence) never
 *    end a part.
 * 5. At most `maxParts` parts are produced; if text remains, `complete:false` is returned (the caller decides
 *    between the attachment and the truncation policy).
 */

/** A part is ≥ this fraction full before a paragraph (soft) boundary is preferred over a plain line boundary. */
export const SOFT_BREAK_MIN_FILL = 0.4;

const utf8 = (s: string): number => Buffer.byteLength(s, "utf8");

/** UTF-8 bytes `s` occupies INSIDE a JSON string literal (quotes excluded; escapes counted). */
export function jsonBytes(s: string): number {
  return utf8(JSON.stringify(s)) - 2;
}

/** Title suffix for a multi-part reply (`" (2/3)"`); empty for a single part. */
export function partSuffix(index: number, total: number): string {
  return total > 1 ? ` (${index}/${total})` : "";
}

/** Worst-case suffix bytes for `maxParts` parts (ASCII only). */
export function partSuffixReserveBytes(maxParts: number): number {
  return utf8(partSuffix(maxParts, maxParts));
}

// ---------------------------------------------------------------------------
// fence analysis
// ---------------------------------------------------------------------------

interface Fence {
  char: "`" | "~";
  len: number;
  /** original opener line (re-emitted verbatim when a part starts inside this fence) */
  opener: string;
}

interface Ln {
  text: string;
  bytes: number;
  fenceBefore: Fence | undefined;
  fenceAfter: Fence | undefined;
  /** a part may end right before this line (paragraph boundary) */
  softBefore: boolean;
}

const FENCE_OPEN_RE = /^ {0,3}(`{3,}|~{3,})(.*)$/;
const HEADING_RE = /^ {0,3}#{1,6}(?:\s|$)/;
/** immutable; grapheme segmentation is locale independent */
const SEGMENTER = new Intl.Segmenter("en", { granularity: "grapheme" });

function closerText(f: Fence): string {
  return f.char.repeat(f.len);
}
function closerCost(f: Fence | undefined): number {
  return f === undefined ? 0 : 2 + f.len; // "\n" + fence chars
}
const isBlank = (s: string): boolean => s.trim() === "";

function analyze(text: string): Ln[] {
  const out: Ln[] = [];
  let fence: Fence | undefined;
  let prevClosed = false;
  for (const raw of text.split("\n")) {
    const before = fence;
    let after = fence;
    let opened = false;
    let closed = false;
    const m = FENCE_OPEN_RE.exec(raw);
    if (fence === undefined) {
      if (m !== null) {
        const marks = m[1]!;
        const info = m[2]!;
        const char = marks[0] as "`" | "~";
        // a backtick fence's info string may not contain a backtick (else it is inline code)
        if (!(char === "`" && info.includes("`"))) {
          after = { char, len: marks.length, opener: raw };
          opened = true;
        }
      }
    } else if (m !== null && m[1]![0] === fence.char && m[1]!.length >= fence.len && m[2]!.trim() === "") {
      after = undefined;
      closed = true;
    }
    const soft =
      before === undefined && out.length > 0 && (isBlank(raw) || opened || prevClosed || HEADING_RE.test(raw));
    out.push({ text: raw, bytes: jsonBytes(raw), fenceBefore: before, fenceAfter: after, softBefore: soft });
    prevClosed = closed;
    fence = after;
  }
  return out;
}

/** Per-line fence membership (`fenced` ⇔ the line is a fence opener/closer or inside a fenced block). */
export function classifyLines(text: string): Array<{ text: string; fenced: boolean }> {
  return analyze(text).map((l) => ({
    text: l.text,
    fenced: l.fenceBefore !== undefined || l.fenceAfter !== undefined,
  }));
}

// ---------------------------------------------------------------------------
// long-line cutting
// ---------------------------------------------------------------------------

function firstCodePointBytes(text: string): number {
  const cp = text.codePointAt(0);
  return cp === undefined ? 0 : jsonBytes(String.fromCodePoint(cp));
}

/**
 * Cut `text` so the first piece costs ≤ `avail` JSON bytes (at least one code point is always taken, so the
 * caller always makes progress). Returns `[piece, rest]`.
 */
function cutLine(text: string, avail: number): [string, string] {
  const firstCodePoint = (): [string, string] => {
    const cp = text.codePointAt(0);
    const n = cp !== undefined && cp > 0xffff ? 2 : 1;
    return [text.slice(0, n), text.slice(n)];
  };
  if (avail <= 0) return firstCodePoint();
  // every char costs ≥ 1 byte, so the cut lies within the first `avail` chars; +32 chars of slack keep the
  // last grapheme of the window honest.
  const window = text.length > avail + 32 ? text.slice(0, avail + 32) : text;
  let bytes = 0;
  let end = 0;
  let lastWs = 0;
  let exceeded = false;
  for (const { segment } of SEGMENTER.segment(window)) {
    const b = jsonBytes(segment);
    if (bytes + b > avail) {
      exceeded = true;
      if (end === 0) {
        // one grapheme cluster bigger than the whole budget: fall back to code points
        for (const ch of segment) {
          const cb = jsonBytes(ch);
          if (bytes + cb > avail) break;
          bytes += cb;
          end += ch.length;
        }
      }
      break;
    }
    bytes += b;
    end += segment.length;
    if (/^\s+$/u.test(segment)) lastWs = end;
  }
  if (!exceeded && end === text.length) return [text, ""];
  if (end === 0) return firstCodePoint();
  // word boundary when it keeps at least half of the piece
  if (exceeded && lastWs > 0 && lastWs >= end / 2) end = lastWs;
  return [text.slice(0, end), text.slice(end)];
}

// ---------------------------------------------------------------------------
// public API
// ---------------------------------------------------------------------------

export interface SplitOptions {
  /** JSON-escaped body bytes allowed in part `index` (0-based). Evaluated once per part. */
  budgetFor: (index: number) => number;
  /** produce at most this many parts (default 4); more text ⇒ `complete:false` */
  maxParts?: number;
}

export interface SplitResult {
  parts: string[];
  /** false ⇒ text remained after `maxParts` parts */
  complete: boolean;
}

/** Split markdown `text` into parts under the per-part JSON-escaped byte budgets. Never throws. */
export function splitMarkdown(text: string, options: SplitOptions): SplitResult {
  const maxParts = Math.max(1, Math.floor(options.maxParts ?? 4));
  const lines = analyze(text);
  const parts: string[] = [];
  let i = 0;
  while (i < lines.length) {
    // skip blank lines that would lead a part (outside a fence)
    while (i < lines.length && lines[i]!.fenceBefore === undefined && isBlank(lines[i]!.text)) i++;
    if (i >= lines.length) break;
    if (parts.length >= maxParts) return { parts, complete: false };

    const budget = Math.max(1, Math.floor(options.budgetFor(parts.length)));
    const fenceIn = lines[i]!.fenceBefore;
    const buf: string[] = [];
    let bytes = 0;
    if (fenceIn !== undefined) {
      // an opener (with its info string) that would eat more than a quarter of the part is re-opened bare
      const reopen = jsonBytes(fenceIn.opener) * 4 > budget ? closerText(fenceIn) : fenceIn.opener;
      buf.push(reopen);
      bytes = jsonBytes(reopen);
    }
    let endFence = fenceIn;
    let real = 0;
    const softs: Array<{ j: number; bufLen: number; bytes: number }> = [];
    let next = -1; // where the following part starts (−1 ⇒ ran off the end)
    let cutAt: number | undefined; // truncate buf to this many entries (soft break)
    let closeFence: Fence | undefined;

    for (let j = i; j < lines.length; j++) {
      const ln = lines[j]!;
      const add = (buf.length > 0 ? 2 : 0) + ln.bytes;
      if (bytes + add + closerCost(ln.fenceAfter) <= budget) {
        if (ln.softBefore && real > 0) softs.push({ j, bufLen: buf.length, bytes });
        buf.push(ln.text);
        bytes += add;
        // a bare fence opener is not content: a part never ends with an empty code block
        if (!(ln.fenceBefore === undefined && ln.fenceAfter !== undefined)) real++;
        endFence = ln.fenceAfter;
        continue;
      }
      if (real === 0) {
        // the line alone exceeds this part: cut it (progress ≥ 1 code point)
        let avail = budget - bytes - (buf.length > 0 ? 2 : 0) - closerCost(ln.fenceAfter);
        let reopened = fenceIn !== undefined;
        if (!reopened && j > i && buf.length > 0 && avail < firstCodePointBytes(ln.text)) {
          // only a bare opener sits in this part and not even one code point of the next line fits beside it:
          // close the part here (tiny budgets only) rather than overshoot the budget
          next = j;
          closeFence = endFence;
          break;
        }
        if (reopened && avail < firstCodePointBytes(ln.text)) {
          // the re-open line + closer leave no room for even one code point: emit this piece bare instead
          buf.length = 0;
          bytes = 0;
          reopened = false;
          avail = budget;
        }
        const [piece, rest] = cutLine(ln.text, avail);
        buf.push(piece);
        real++;
        const bare = fenceIn !== undefined && !reopened;
        endFence = bare ? undefined : ln.fenceAfter;
        if (rest === "") {
          next = j + 1; // a forced code point swallowed the whole line (tiny budgets only)
        } else {
          // the rest of a cut OPENER line is plain text (not fence interior): it must not re-emit the opener;
          // the fence itself stays open for the lines that follow
          const isOpener = ln.fenceBefore === undefined && ln.fenceAfter !== undefined;
          lines[j] = {
            ...ln,
            text: rest,
            bytes: jsonBytes(rest),
            fenceBefore: isOpener ? undefined : ln.fenceAfter,
            softBefore: false,
          };
          next = j;
        }
        closeFence = endFence;
        break;
      }
      // does not fit and the part has content. An opener that would end this part (empty code block) moves
      // to the next part together with its body.
      const prev = j > i ? lines[j - 1]! : undefined;
      if (prev !== undefined && prev.fenceBefore === undefined && prev.fenceAfter !== undefined && buf.length > 0) {
        buf.pop();
        next = j - 1;
        closeFence = undefined;
        break;
      }
      // prefer the last paragraph boundary in a ≥ 40 % full part
      const soft = [...softs].reverse().find((s) => s.bytes >= budget * SOFT_BREAK_MIN_FILL);
      if (soft !== undefined) {
        cutAt = soft.bufLen;
        next = soft.j;
        closeFence = undefined; // soft boundaries only exist outside fences
      } else {
        next = j;
        closeFence = endFence;
      }
      break;
    }

    const kept = cutAt === undefined ? buf : buf.slice(0, cutAt);
    const closing = next === -1 ? endFence : closeFence;
    if (closing === undefined) while (kept.length > 0 && isBlank(kept[kept.length - 1]!)) kept.pop();
    const body = kept.join("\n");
    parts.push(closing !== undefined ? `${body}\n${closerText(closing)}` : body);
    i = next === -1 ? lines.length : next;
  }
  return { parts: parts.length > 0 ? parts : [""], complete: true };
}
