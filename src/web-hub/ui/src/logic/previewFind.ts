/**
 * Preview in-window find (preview-perf plan r3 §4.6) — pure logic: the case fold, the
 * reference greedy search, and the incremental find engine P3 wires onto the virtual
 * source. No DOM, no Vue — same discipline as `./previewLines.ts`.
 *
 * Match semantics (frozen by §4.6 r3):
 *  - hits are the GREEDY NON-OVERLAPPING leftmost sequence: h₁ = indexOf(q, 0),
 *    hₖ₊₁ = indexOf(q, hₖ + |q|); collection stops at `FIND_MAX` (10 000) followed by exactly
 *    ONE "more" probe at h₁₀₀₀₀ + |q| (`more: true` ⇒ UI shows `10000+`). An empty query has
 *    no hits.
 *  - case-insensitive search runs on a LENGTH-PRESERVING per-code-point fold
 *    (`foldSameLength`): a code point folds only when its lowercase form has the same UTF-16
 *    length (`İ` stays as-is; `Σ`→`σ`; `ẞ`→`ß`), so folded offsets map 1:1 onto the raw text.
 *  - hits always end within the STABLE prefix `[0, stableLen)`; the fold's code-point carry
 *    (a trailing lone high surrogate is not folded yet, `stableLen = length − 1`) is flushed
 *    at stream terminal state via `flush()` (`stableLen = length`).
 *  - incremental append: keep old hits ending ≤ the new stableLen (normally all of them),
 *    then resume the greedy scan at `max(stableLen_old − |q| + 1, lastKept.end)` — the greedy
 *    prefix property (§4.6 correctness note + the `aaaa`+`a` / q=`aa` counter-example) makes
 *    that exact resume point miss nothing and overlap nothing. Once `FIND_MAX` hits are
 *    collected no resume happens; only the probe is redone over the extended stable range.
 *  - the current hit is anchored by START OFFSET: it survives appends unchanged; when its
 *    hit is (defensively) dropped by the carry filter, `currentIndex()` resolves to the
 *    first hit with start ≥ the anchor, falling back to the last hit.
 *
 * Dev builds throw on an `append` prefix violation; production rebuilds from the new text.
 */

import { FIND_MAX } from "@logic/previewVirtualTypes.js";

/** Dev assertion gate (production keeps running via a full rebuild). */
const DEV = import.meta.env?.DEV === true;

const isHighSurrogate = (code: number): boolean => code >= 0xd800 && code <= 0xdbff;

/** The text's stable length: a trailing lone high surrogate defers to the next append/flush. */
function stableLenOf(text: string, caseSensitive: boolean): number {
  if (caseSensitive) return text.length; // no fold ⇒ no carry (§4.6)
  const len = text.length;
  return len > 0 && isHighSurrogate(text.charCodeAt(len - 1)) ? len - 1 : len;
}

/**
 * Length-preserving per-code-point lowercase fold (§4.6): every code point maps through
 * `toLowerCase` and is adopted only when the folded form has the SAME UTF-16 length as the
 * original code point; otherwise the original code point is kept verbatim. Consequently
 * `foldSameLength(s).length === s.length` for every string — hit offsets computed on the
 * folded text are valid on the raw text unchanged. Lone surrogates pass through (they have
 * no case mapping); an astral pair folds as ONE code point.
 */
export function foldSameLength(s: string): string {
  const len = s.length;
  if (len === 0) return "";
  const units = new Uint16Array(len);
  const memo = new Map<number, string>();
  let i = 0;
  while (i < len) {
    const code = s.charCodeAt(i);
    if (code < 0x80) {
      units[i] = code >= 0x41 && code <= 0x5a ? code + 32 : code; // ASCII fast path
      i += 1;
      continue;
    }
    const cp = (code >= 0xd800 && code <= 0xdbff && isLowAt(s, i) ? s.codePointAt(i) : code) as number;
    const cpLen = cp > 0xffff ? 2 : 1;
    let folded = memo.get(cp);
    if (folded === undefined) {
      folded = String.fromCodePoint(cp).toLowerCase();
      memo.set(cp, folded);
    }
    if (folded.length === cpLen) {
      for (let k = 0; k < cpLen; k++) units[i + k] = folded.charCodeAt(k);
    } else {
      for (let k = 0; k < cpLen; k++) units[i + k] = s.charCodeAt(i + k); // İ-class: keep verbatim
    }
    i += cpLen;
  }
  let out = "";
  const CHUNK = 8192; // String.fromCharCode apply/arg-count safety
  for (let p = 0; p < len; p += CHUNK) {
    out += String.fromCharCode(...units.subarray(p, Math.min(p + CHUNK, len)));
  }
  return out;
}

const isLowAt = (s: string, i: number): boolean => {
  const next = s.charCodeAt(i + 1);
  return next >= 0xdc00 && next <= 0xdfff;
};

/** The find state exposed to the UI (a snapshot view of the engine's arrays). */
export interface FindResult {
  /** Greedy non-overlapping hit START offsets (raw-text == folded-text offsets). */
  readonly hits: readonly number[];
  /** true iff hits hit the 10 000 cap AND another hit exists past it within the stable range. */
  readonly more: boolean;
}

/**
 * Reference FULL greedy search over `haystack[0, end)` — the oracle the incremental engine
 * is differentially tested against (§6.3). `end` defaults to the whole haystack; hits that
 * would end past it are not collected.
 */
export function findAll(haystack: string, query: string, end?: number): FindResult {
  if (query === "") return { hits: [], more: false };
  const limit = end === undefined ? haystack.length : Math.max(0, Math.min(Math.floor(end), haystack.length));
  const qLen = query.length;
  const hits: number[] = [];
  let from = 0;
  for (;;) {
    const h = haystack.indexOf(query, from);
    if (h < 0 || h + qLen > limit) break;
    hits.push(h);
    if (hits.length >= FIND_MAX) {
      const probe = haystack.indexOf(query, h + qLen); // exactly ONE "more" probe (§4.6)
      return { hits, more: probe >= 0 && probe + qLen <= limit };
    }
    from = h + qLen;
  }
  return { hits, more: false };
}

/** Incremental find engine over one growing (stream or one-shot) text (§4.6 r3 protocol). */
export interface PreviewFinder {
  /** The raw query string as typed ("" before the first `search`). */
  readonly query: string;
  readonly caseSensitive: boolean;
  /** Current greedy hits (the engine's live array — treat as read-only). */
  readonly hits: readonly number[];
  readonly more: boolean;
  /** Hits always end within `[0, stableLen)`; `flush()` extends it to the full length. */
  readonly stableLen: number;
  /** Current-hit anchor (start offset, −1 = none). Kept verbatim across appends. */
  readonly currentStart: number;
  /** New query / case mode ⇒ full greedy re-search over the stable prefix. Re-folds only
   *  when the text or the case mode actually changed (same-text keystrokes stay cheap). */
  search(query: string, caseSensitive: boolean, fullText: string): FindResult;
  /** The text grew (new FULL text; must extend the old one) ⇒ carry-aware incremental fold
   *  + resume search over the newly stable range. */
  append(fullText: string): FindResult;
  /** Stream terminal state (`done`/`cap`/`changed`): fold the trailing carry, extend hits. */
  flush(): FindResult;
  /** Move the current-hit anchor (any offset; resolution happens lazily). */
  setCurrent(start: number): void;
  /** Resolved current index into `hits`: exact start, else first start > anchor, else the
   *  last hit; −1 when there are no hits (§4.6 当前项保持). */
  currentIndex(): number;
}

export function createPreviewFinder(): PreviewFinder {
  let text = "";
  let folded = "";
  let stableLen = 0;
  let caseSensitive = true;
  let query = "";
  let queryEff = "";
  let hits: number[] = [];
  let more = false;
  let currentStart = -1;

  const result = (): FindResult => ({ hits, more });

  /** Full fold rebuild (first search / case switch / prod contract violation). */
  const reFold = (fullText: string): void => {
    text = fullText;
    stableLen = stableLenOf(fullText, caseSensitive);
    folded = caseSensitive ? fullText : foldSameLength(fullText.slice(0, stableLen));
  };

  /** Greedy resume over `(oldStable, stableLen]` — the incremental protocol core. */
  const extendSearch = (oldStable: number): void => {
    const qLen = queryEff.length;
    if (qLen === 0) return;
    const limit = stableLen;
    if (hits.length >= FIND_MAX) {
      // Full: no re-search, just redo the one "more" probe over the extended range (§4.6).
      const last = hits[hits.length - 1] as number;
      const probe = folded.indexOf(queryEff, last + qLen);
      more = probe >= 0 && probe + qLen <= limit;
      return;
    }
    const kept: number[] = [];
    for (const h of hits) if (h + qLen <= limit) kept.push(h); // carry filter (normally all)
    let lastEnd = kept.length > 0 ? (kept[kept.length - 1] as number) + qLen : 0;
    let from = Math.max(0, oldStable - qLen + 1, lastEnd);
    let h = folded.indexOf(queryEff, from);
    while (h >= 0 && h + qLen <= limit) {
      if (h < lastEnd) {
        // Greedy non-overlap invariant (§4.6 断言 hᵢ ≥ hᵢ₋₁ + |q|) — structurally impossible.
        if (DEV) throw new Error(`previewFind: overlapping incremental hit ${h} < ${lastEnd}`);
        h = folded.indexOf(queryEff, h + 1);
        continue;
      }
      kept.push(h);
      lastEnd = h + qLen;
      if (kept.length >= FIND_MAX) {
        const probe = folded.indexOf(queryEff, lastEnd);
        more = probe >= 0 && probe + qLen <= limit;
        hits = kept;
        return;
      }
      h = folded.indexOf(queryEff, lastEnd);
    }
    more = false;
    hits = kept;
  };

  const fullSearch = (): void => {
    if (queryEff === "") {
      hits = [];
      more = false;
      return;
    }
    const r = findAll(folded, queryEff, stableLen);
    hits = [...r.hits];
    more = r.more;
  };

  return {
    get query() {
      return query;
    },
    get caseSensitive() {
      return caseSensitive;
    },
    get hits() {
      return hits;
    },
    get more() {
      return more;
    },
    get stableLen() {
      return stableLen;
    },
    get currentStart() {
      return currentStart;
    },
    search(q, cs, fullText): FindResult {
      const reuseFold = fullText === text && cs === caseSensitive;
      query = q;
      caseSensitive = cs;
      queryEff = cs ? q : foldSameLength(q);
      if (!reuseFold) reFold(fullText);
      fullSearch();
      return result();
    },
    append(fullText): FindResult {
      if (typeof fullText !== "string" || fullText === text) return result();
      if (fullText.length < text.length || !fullText.startsWith(text)) {
        if (DEV) throw new Error("previewFind.append: the old text must be a prefix of the new text");
        // prod recovery: rebuild the fold, re-run the full greedy search on the new text
        reFold(fullText);
        fullSearch();
        return result();
      }
      const oldStable = stableLen;
      if (caseSensitive) {
        folded = fullText; // reference, no copy
        stableLen = fullText.length;
      } else {
        stableLen = stableLenOf(fullText, false);
        // carry: re-fold from the OLD stable point — a surrogate pair split across the append
        // boundary folds as one code point there (§4.6 折叠的码点 carry)
        folded = folded.slice(0, oldStable) + foldSameLength(fullText.slice(oldStable, stableLen));
      }
      text = fullText;
      extendSearch(oldStable);
      return result();
    },
    flush(): FindResult {
      if (stableLen >= text.length) return result(); // nothing pending (case-sensitive too)
      const oldStable = stableLen;
      stableLen = text.length;
      if (!caseSensitive) folded += foldSameLength(text.slice(oldStable, stableLen));
      extendSearch(oldStable);
      return result();
    },
    setCurrent(start: number): void {
      currentStart = Math.floor(start);
    },
    currentIndex(): number {
      if (hits.length === 0) return -1;
      let a = 0;
      let b = hits.length;
      while (a < b) {
        const m = (a + b) >> 1;
        if ((hits[m] as number) < currentStart) a = m + 1;
        else b = m;
      }
      return a < hits.length ? a : hits.length - 1; // first ≥ anchor, else the last hit
    },
  };
}
