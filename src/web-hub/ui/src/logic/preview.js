/**
 * web-hub content preview — pure UI logic (web-hub-preview plan v3 §3.2/§4.6, package PV4).
 * No DOM, no I/O (the one exception, `previewOutcomeFromResponse`, only READS an already-
 * fetched response object): every function here runs unchanged under vitest (node) and in the
 * browser, same discipline as `./control.js`/`./spawn.js`.
 *
 * - `findPathRefs(text, scope)` / `pathRefOfCode(text, scope)` — the FROZEN path-recognition
 *   rules (§4.6 识别规则 1–6): an absolute path is clickable only when it starts in a
 *   line-start / whitespace / open-bracket context, ends at the terminator set, passes the
 *   protocol's `validatePreviewPath`, and is segment-aligned under the session's `cwd` (never
 *   `/`) OR contains the upload-store marker. Segments returned by `findPathRefs` always
 *   concatenate back to the exact input (property-tested). A trailing `:line[:col]` is kept
 *   in the DISPLAY text but stripped from the request path (rule 3, display-only).
 * - **Relative paths (rule 1b, 2026-10-07 addition — tool-call args carry mostly relative
 *   paths, not absolute ones)**: a candidate that does NOT start with `/` is ALSO recognized
 *   when (a) its leading segment starts in a whitespace / START_CHARS context (deliberately
 *   NARROWER than the absolute rule's `/` — a bare text-node start does NOT count, only an
 *   actual preceding whitespace/opener/quote char does; this is what keeps `"x/home/..."` and
 *   `"1/home/..."`, both already-frozen "not clickable" absolute fixtures, from picking up a
 *   NEW relative match merely because they happen to sit at a text-node boundary — see
 *   `relativeWordStartContext`), (b) it contains at least one `/`, (c) its last segment has a
 *   plausible extension (`.` + 1–10 of `[A-Za-z0-9_-]`, with ≥1 char before the dot — so
 *   `"src/components/detail"` alone is never recognized: an accepted, documented trade-off),
 *   and (d) its leading segment is not a URI scheme (containing `:` — covers
 *   `http://`/`https://`/`mailto:`/any custom scheme uniformly, cheaper and more robust than
 *   an enumerated word list) nor empty (which also structurally rules out a `//`-prefixed candidate). A
 *   recognized relative candidate resolves to `scope.cwd + "/" + candidate` (never when
 *   `scope.cwd` is `null`/`""`/`"/"` — same disablement the absolute cwd rule already has) and
 *   the RESOLVED absolute path must still pass `isClickable` (rules 4–5) like any other
 *   candidate; only the resolved `path` differs from the displayed `text` — the `:line[:col]`
 *   suffix stays display-only exactly as for absolute candidates.
 * - `previewScopeOf(...)` — the §4.6 作用域推导 truth table: a scope exists only when the
 *   transport offers `preview`, the hub caps carry `preview.v1` (token) / `preview.lan.v1`
 *   (password), and the selected agent has a live session. Under the default `mode:"on"`
 *   (U1) BOTH caps are declared, so password mode gets a scope too. dir-plan §2.5.1 (P2):
 *   `preview.abs.v1` / `preview.dir.v1` add the optional `abs` / `dirs` keys — ONLY when the
 *   cap is present (absent ⇒ key absent, so every pre-dir-plan `toEqual` pin stays green).
 * - `scopeKeyOf(scope)` — `agentKey|sessionId|cwd` (v3-2 双保险: the same-sessionId-cwd-never-
 *   changes invariant PLUS the key carrying cwd, so a cwd change invalidates the scope).
 *   dir-plan §2.5.1: `|abs` / `|dir` are appended for the respective flags — a cap change
 *   invalidates the scope (and the probe LRU partitions naturally); the format is unchanged
 *   when the flags are absent.
 * - `clientImageBudget({ coarse })` — §0/P2-13: touch devices cap at 20MP, desktop at the
 *   server's 40MP; checked from the response HEADERS before the body is ever read.
 * - `parsePreviewDims` / `checkPreviewHeaders` — the §4.6 transport pre-body gate: Kind must
 *   be image|text, Content-Length must be present/integer/within the byte cap, an image's
 *   Content-Type must be one of the four protocol mimes and its `X-PWH-Preview-Dims` must
 *   parse and fit `maxPixels` — ANY failure means "abort without reading the body".
 * - `previewOutcomeFromResponse(r)` — the non-200 mapping (shared verbatim by BOTH logic
 *   clients so the two transports can never drift, 78dd76b's regression class).
 * - `classifyPreviewError(status, body)` — the §3.2 phase taxonomy `usePreview` hangs its
 *   view transitions off: unsupported / tooLarge / session-changed / error(+retryable).
 *
 * Runtime imports use the literal `.ts` extension (`@protocol/preview.ts`) — the same
 * `.js`-importer constraint `./contract.js` documents: Vite/esbuild only remap `./foo.js` →
 * `./foo.ts` for a `.ts`/`.vue` importer, so a plain `.js` module must spell `.ts` out.
 * `protocol/preview.ts` is deliberately `node:*`-free (PV1) precisely so this module can
 * pull its constants into the browser bundle.
 */
import {
  PREVIEW_CLIENT_PIXELS_COARSE,
  PREVIEW_HDR,
  PREVIEW_IMAGE_MAX_BYTES,
  PREVIEW_IMAGE_MAX_PIXELS,
  PREVIEW_PATH_MAX_BYTES,
  PREVIEW_TEXT_MAX_BYTES,
  PREVIEW_UPLOADS_MARKER,
  validatePreviewPath,
} from "@protocol/preview.ts";
import { PREVIEW_ABS_HUB_CAP, PREVIEW_DIR_HUB_CAP, PREVIEW_HUB_CAP, PREVIEW_LAN_HUB_CAP } from "@protocol/version.ts";

/**
 * @typedef {{ agentKey: string, sessionId: string, cwd: string | null, uploads: boolean,
 *   abs?: true, dirs?: true }} PathScope
 * @typedef {{ kind: "text", text: string }
 *   | { kind: "ref", text: string, path: string, line?: number, col?: number }} PathSegment
 * @typedef {{ w: number, h: number }} PreviewDimsT
 */

/** §4.6 rule 6: at most this many refs are recognized per text node (the rest stays text). */
export const PREVIEW_MAX_REFS_PER_NODE = 100;

/** dir-plan §2.5.2's machine-independent performance gate: `charScans` counts every character
 * the recognition layer examines (run forward/backward scans, `startsWith` calls, candidate
 * slice lengths). Tests assert `charScans ≤ 10·n + 10_000` and a linear growth ratio — never
 * absolute milliseconds. Test-only surface; production code paths never read it. */
export const __previewScanStats = { charScans: 0 };

/** Test-only: zero the §2.5.2 scan counter. */
export function __resetPreviewScanStats() {
  __previewScanStats.charScans = 0;
}

/** §4.6 rule 1: a candidate `/` may immediately follow one of these (besides line start / whitespace). */
const START_CHARS = new Set(["(", "[", "{", "<", '"', "'", "=", "（", "「", "『", "【", "《", "："]);

/** dir-plan §2.5.3: the EXTENDED start set, used only when the scope carries `abs`/`dirs` —
 * a backtick becomes a legal opener in NON-markdown contexts (in markdown the parser already
 * turns the span into a code node handled by `pathRefOfCode`). A backtick stays a TERMINATOR,
 * so the candidate still ends at its closing twin; the no-extension relative pairing rule (c)
 * is what actually requires the pair to close. */
const START_CHARS_EXT = new Set([...START_CHARS, "`"]);

/** §4.6 rule 2: a candidate ends at the first of these (besides any whitespace). */
const TERMINATOR_CHARS = new Set([
  '"',
  "'",
  "<",
  ">",
  "(",
  ")",
  "[",
  "]",
  "{",
  "}",
  "|",
  ",",
  ";",
  "`",
  "，",
  "。",
  "；",
  "：",
  "！",
  "？",
  "、",
  "）",
  "」",
  "』",
  "】",
  "》",
]);

const WS_RE = /\s/;
const TRAILING_PUNCT_RE = /[.:!?]$/;
const LINE_COL_RE = /:(\d+)(?::(\d+))?$/;

/** @param {string | undefined} ch */
function isTerminator(ch) {
  return ch === undefined || WS_RE.test(ch) || TERMINATOR_CHARS.has(ch);
}

/**
 * Rule 1b's backward-scan stop condition: a word boundary is a terminator OR a start-set
 * opener. The latter addition matters because some start chars (`=`, `(`, …) are NOT
 * terminators (an absolute candidate's forward scan must keep going past them when they
 * appear mid-path), so using `isTerminator` alone here would let the backward scan walk PAST
 * an opener like `=` into whatever precedes it — e.g. `foo=/home/...` would wrongly compute
 * `foo=` as part of the leading identifier instead of stopping right at the `/` (correctly
 * yielding an empty leading segment, since that slash's candidate is already `=`'s absolute
 * territory). dir-plan §2.5.3: the boundary set switches to `START_CHARS_EXT` together with
 * the forward start set (a backtick opener also ends the leading identifier).
 * @param {string | undefined} ch @param {Set<string>} startSet
 */
function isWordBoundary(ch, startSet) {
  return isTerminator(ch) || (ch !== undefined && startSet.has(ch));
}

/**
 * §4.6 rule 1: the candidate's leading `/` must sit at line start (string start counts) or
 * right after whitespace / a start-set opener (dir-plan §2.5.3: `startSet` is
 * `START_CHARS_EXT` when the scope carries `abs`/`dirs` — a backtick opener counts there).
 * @param {string} text @param {number} slash @param {Set<string>} startSet
 */
function isStartContext(text, slash, startSet) {
  if (slash === 0) return true;
  const prev = text[slash - 1];
  return prev !== undefined && (WS_RE.test(prev) || startSet.has(prev));
}

/**
 * §4.6 rule 1b (relative paths): same whitespace/start-set test as `isStartContext`, but
 * deliberately WITHOUT its `position === 0 ⇒ true` shortcut — a bare text-node boundary is
 * not, by itself, good enough evidence that a leading identifier (`x`, `1`, `src`, …) is the
 * start of a path rather than the middle of a sentence this call only sees a fragment of.
 * This is what keeps the already-frozen absolute "not clickable" fixtures `"x/home/..."` /
 * `"1/home/..."` from picking up a brand-new relative match. Tool-call args (the feature's
 * main target) are always quote-delimited (`"path": "src/foo.ts"`), so they hit the quote
 * branch regardless.
 * @param {string} text @param {number} wordStart @param {Set<string>} startSet
 */
function relativeStartContext(text, wordStart, startSet) {
  if (wordStart <= 0) return false;
  const prev = text[wordStart - 1];
  return prev !== undefined && (WS_RE.test(prev) || startSet.has(prev));
}

/** §4.6 rule 1b: last segment's extension shape — `.` + 1–10 "reasonable" chars, ≥1 char before it. */
const RELATIVE_EXT_RE = /\.[A-Za-z0-9_-]{1,10}$/;

/**
 * §4.6 rule 1b: pure shape check for a RELATIVE candidate (no scope/cwd yet) — at least one
 * `/` with a non-empty leading segment, a plausible extension on the last segment, and a
 * leading segment that is not a URI scheme (any segment containing `:` — covers `http://`,
 * `mailto:a@b`, custom schemes alike; cheaper and more robust than enumerating scheme words).
 * @param {string} candidate
 */
function looksLikeRelativePath(candidate) {
  const slash = candidate.indexOf("/");
  if (slash <= 0) return false;
  const firstSeg = candidate.slice(0, slash);
  if (firstSeg.includes(":")) return false;
  const lastSeg = candidate.slice(candidate.lastIndexOf("/") + 1);
  const m = RELATIVE_EXT_RE.exec(lastSeg);
  return m !== null && lastSeg.length > m[0].length;
}

/**
 * §4.6 rule 1b: resolve a relative candidate against `scope.cwd`. Returns `null` (never
 * clickable) when `cwd` is `null`/`""`/`"/"` (relative recognition is off the same way the
 * absolute cwd-prefix rule already disables itself for those cwds) or the shape check fails.
 * @param {string} candidate @param {string | null} cwd
 */
function resolveRelativePath(candidate, cwd) {
  if (typeof cwd !== "string" || cwd === "" || cwd === "/") return null;
  if (!looksLikeRelativePath(candidate)) return null;
  const base = cwd.endsWith("/") ? cwd.slice(0, -1) : cwd;
  return base === "" || base === "/" ? null : `${base}/${candidate}`;
}

/**
 * §4.6 rules 4–5: protocol-valid AND (segment-aligned under `scope.cwd` — never `/` — OR
 * carrying the upload-store marker when the scope allows uploads). dir-plan §2.5.1 (C4):
 * under `abs` the route is simply "protocol-valid" (`validatePreviewPath`, ≥2 segments —
 * `/help` `/reload` never become candidates); a `null` scope still never reaches here and a
 * `null` cwd keeps absolute paths clickable while relative recognition stays off.
 * @param {string} path @param {PathScope} scope
 */
function isClickable(path, scope) {
  if (!validatePreviewPath(path)) return false;
  if (scope.abs === true) return true;
  if (scope.uploads === true && path.includes(PREVIEW_UPLOADS_MARKER)) return true;
  const cwd = scope.cwd;
  if (typeof cwd !== "string" || cwd === "" || cwd === "/") return false;
  const base = cwd.endsWith("/") ? cwd.slice(0, -1) : cwd;
  return base !== "" && base !== "/" && path.startsWith(`${base}/`);
}

/**
 * dir-plan §2.5.2 ④: the smallest start position `j` in `[s0, P]` whose `text[j, P)` slice is
 * still ≤ 4096 UTF-8 bytes — scanning backward from `P` one CODEPOINT at a time (a surrogate
 * pair is 4 bytes; a lone surrogate counts 3, matching `TextEncoder`'s U+FFFD replacement;
 * BMP codepoints 1/2/3). Never looks past `s0`, and the byte budget caps the walk at ~4097
 * bytes, so it is O(1)-bounded per run and O(text) summed over all runs (the walk never
 * exceeds the run's own length). `bytes(s, P)` is non-increasing in `s`, hence
 * `slash >= minStart ⇔ bytes(slash, P) ≤ 4096` for every slash in `[s0, P)`.
 * @param {string} text @param {number} s0 @param {number} P
 */
function minStartOf(text, s0, P) {
  let minStart = P;
  let acc = 0;
  let j = P;
  while (j > s0) {
    let k = j - 1;
    const cu = text.charCodeAt(k);
    /** @type {number} */
    let size;
    if (cu >= 0xdc00 && cu <= 0xdfff && k > s0) {
      const hi = text.charCodeAt(k - 1);
      if (hi >= 0xd800 && hi <= 0xdbff) {
        k -= 1;
        size = 4;
      } else size = 3;
    } else if (cu < 0x80) size = 1;
    else if (cu < 0x800) size = 2;
    else size = 3;
    if (acc + size > PREVIEW_PATH_MAX_BYTES) break;
    __previewScanStats.charScans += 1;
    acc += size;
    j = k;
    minStart = j;
  }
  return minStart;
}

/**
 * Split the `:line[:col]` display suffix off a candidate (§4.6 rule 3). Only taken when at
 * least one path character precedes it, so `/:12` never degrades to an empty path.
 * @param {string} raw
 * @returns {{ path: string, line?: number, col?: number }}
 */
function splitLineCol(raw) {
  const m = LINE_COL_RE.exec(raw);
  if (m !== null && raw.length > m[0].length) {
    const path = raw.slice(0, -m[0].length);
    const line = Number(m[1]);
    const col = m[2] !== undefined ? Number(m[2]) : undefined;
    return col === undefined ? { path, line } : { path, line, col };
  }
  return { path: raw };
}

/**
 * §4.6 `findPathRefs(text, scope)` — segments whose `text` fields concatenate back to the
 * EXACT input (whitespace, unrecognized candidates and stripped trailing punctuation all
 * survive as `kind:"text"`). A `null`/`undefined` scope yields the input as one text segment
 * (PathText's no-ctx / no-scope DOM-equivalence rule). Recognition stops after
 * `PREVIEW_MAX_REFS_PER_NODE` refs; the remainder of the node stays plain text.
 *
 * **dir-plan §2.5.2 (P2) — provably linear, three-tier structure** (call-level → run-level →
 * candidate-level; the full pseudocode + equivalence proof live in the plan):
 *
 * - **Run-level constants**: every candidate starting inside the same terminator-free run
 *   ends at the SAME index — the unified end `spanP` (`hasLC ? spanLineColStart :
 *   spanStrippedEnd`, minus ONE trailing `/` under `dirs` when it is not the run-triggering
 *   slash — A5 (a)/(b)). `dirs === false` ⇒ `spanP` is byte-identical to the old per-candidate
 *   `pathEnd` (the lemma: a `:line[:col]` match and a stripped `[.:!?]` tail contain no `/`),
 *   which is what the legacy differential test pins. One forward pass over
 *   `[spanFirstSlash, spanP)` then derives four constants: `lastBad` (max start of an
 *   `""`/`"."`/`".."` segment), `lastNul`, `secondLastSlash` (≥2 segments ⇔ start ≤ it) and
 *   `minStart` (smallest start whose slice to `spanP` is ≤ 4096 UTF-8 bytes, `minStartOf`).
 * - **Candidate-level O(1)**: `fastOk(s) ⇔ validatePreviewPath(text.slice(s, spanP))` (minus
 *   the leading-`/` and CR/LF items, both structurally guaranteed inside a run) — so the
 *   main loop never slices+re-validates per start. Routing: `abs` ⇒ every `fastOk` candidate
 *   (C4: `isClickable` under `abs` IS `validatePreviewPath`); otherwise the frozen cwd-prefix
 *   `startsWith` fast path / the uploads-marker forward cursor, exactly as before. The
 *   public `isClickable`/`pathRefOfCode` bodies are unchanged consumers of the SLOW
 *   validation — only the main loop stopped repeating it.
 * - **Relative candidates (rule 1b + §2.5 A5)**: still tried exactly once per run, at its
 *   first slash, with the backward-scanned leading identifier. New under `dirs`: a trailing
 *   `/` (b) or a paired `"…"`/`'…'`/`` `…` `` wrapper (c) substitutes for the last-segment
 *   extension shape; the resolved path drops the trailing `/` while the DISPLAY text keeps
 *   it (and any `:line[:col]`) exactly as before. `seg0ok` pre-prunes an invalid leading
 *   segment (empty / `.` / `..` / `:`-scheme / NUL) — the final `isClickable(resolved)` call
 *   remains the real gate, once per run ⇒ total linear.
 * - **§2.5.3 backticks**: `abs`/`dirs` scopes widen the start set to `START_CHARS_EXT` (a
 *   backtick opener counts for BOTH the absolute and the relative start context); a backtick
 *   stays a terminator, so the candidate still ends at its closing twin.
 *
 * Two cheap rejections keep the per-candidate cost O(1) whenever the full check would fail
 * anyway (it is a pure AND, so short-circuiting changes no outcome): the UTF-16 length
 * pre-check (`spanP - slash ≤ 4096`) and `fastOk`.
 * @param {string} text @param {PathScope | null | undefined} scope
 * @returns {PathSegment[]}
 */
export function findPathRefs(text, scope) {
  if (typeof text !== "string" || text === "" || scope === null || scope === undefined) {
    return [{ kind: "text", text: typeof text === "string" ? text : "" }];
  }
  /** @type {PathSegment[]} */
  const segments = [];
  let refs = 0;
  let textStart = 0;
  let i = 0;
  const n = text.length;

  // Per-call scope pre-computation (the scope never changes mid-scan): §2.5.2 call level.
  const abs = scope.abs === true;
  const dirs = scope.dirs === true;
  const startSet = abs || dirs ? START_CHARS_EXT : START_CHARS;
  const cwd = scope.cwd;
  const cwdPrefix =
    typeof cwd === "string" && cwd !== "" && cwd !== "/" ? `${cwd.endsWith("/") ? cwd.slice(0, -1) : cwd}/` : null;
  const cwdBase = cwdPrefix !== null ? cwdPrefix.slice(0, -1) : null;
  const uploads = scope.uploads === true;
  let markerNext = -2; // -2 = not computed yet; else first marker occurrence >= the last query

  // Per-run memo (§2.5.2 run level): valid only for start positions < `spanEnd`.
  let spanEnd = -1; // first terminator >= the run's first start (n when none)
  let spanStrippedEnd = -1; // spanEnd minus the trailing `. : ! ?` run (with the >1 guard)
  let spanLineColStart = -1; // absolute start of the `:line[:col]` tail match, -1 when none
  /** @type {number | undefined} */
  let spanLine;
  /** @type {number | undefined} */
  let spanCol;
  let spanFirstSlash = -1; // the slash that triggered this run's memo (relative is tried ONLY there)
  let spanWordStart = -1; // backward boundary of the leading identifier before `spanFirstSlash`
  // §2.5.2 ② the unified end (run-level constant) + the pre-adjustment trailing-`/` flag.
  let spanP = -1;
  let spanTrailingSlash = false;
  // §2.5.2 ③ the four fastOk constants over [spanFirstSlash, spanP).
  let lastBad = -1; // max start of a ""/"."/".." segment (slice has no bad segment ⇔ start > it)
  let lastNul = -1; // last NUL in the window (slice is NUL-free ⇔ start > it)
  let secondLastSlash = -1; // slice has ≥2 segments ⇔ start ≤ it
  let minStart = -1; // smallest start with ≤4096 UTF-8 bytes to spanP (slice fits ⇔ start ≥ it)

  while (i < n && refs < PREVIEW_MAX_REFS_PER_NODE) {
    const slash = text.indexOf("/", i);
    if (slash === -1) break;
    if (slash >= spanEnd) {
      // ① New terminator-free run: scan its end once, then analyze its tail once (unchanged).
      let end = slash + 1;
      while (end < n && !isTerminator(text[end])) end++;
      __previewScanStats.charScans += end - (slash + 1);
      spanEnd = end;
      let stripped = end;
      while (stripped > slash + 1 && TRAILING_PUNCT_RE.test(text[stripped - 1])) stripped--;
      spanStrippedEnd = Math.max(slash + 1, stripped);
      const lcSlice = text.slice(slash, spanStrippedEnd);
      __previewScanStats.charScans += lcSlice.length;
      const m = LINE_COL_RE.exec(lcSlice);
      if (m !== null && m.index > 0) {
        spanLineColStart = slash + m.index;
        spanLine = Number(m[1]);
        spanCol = m[2] !== undefined ? Number(m[2]) : undefined;
      } else {
        spanLineColStart = -1;
        spanLine = undefined;
        spanCol = undefined;
      }
      spanFirstSlash = slash;
      if (cwdPrefix !== null) {
        let ws = slash;
        while (ws > 0 && !isWordBoundary(text[ws - 1], startSet)) ws--;
        __previewScanStats.charScans += slash - ws;
        spanWordStart = ws;
      } else {
        spanWordStart = slash;
      }
      // ② The unified end: `dirs === false` ⇒ identical to the old per-candidate pathEnd for
      //    every legal start in the run (the plan's lemma). Under `dirs`, ONE trailing `/` is
      //    folded out of the window (A5 (a)/(b)) — except when it IS the run's first slash
      //    (`p0 - 1 > slash` guard): the relative candidate then keeps its slash in the slice
      //    and strips it at resolve time instead (never producing an empty candidate).
      const hasLC = spanLineColStart !== -1 && slash < spanLineColStart;
      const p0 = hasLC ? spanLineColStart : spanStrippedEnd;
      spanTrailingSlash = text[p0 - 1] === "/";
      spanP = dirs && !hasLC && p0 - 1 > slash && spanTrailingSlash ? p0 - 1 : p0;
      // ③ One forward pass collects the window's slashes and NUL; a second O(#slashes) pass
      //    over the collected list marks the bad segments (their ends are just the NEXT slash).
      const slashes = [];
      lastNul = -1;
      for (let q = slash; q < spanP; q++) {
        const ch = text[q];
        if (ch === "/") slashes.push(q);
        else if (ch === "\0") lastNul = q;
      }
      __previewScanStats.charScans += spanP - slash;
      lastBad = -1;
      for (let k = 0; k < slashes.length; k++) {
        const q = slashes[k];
        const segEnd = k + 1 < slashes.length ? slashes[k + 1] : spanP;
        const segLen = segEnd - (q + 1);
        let bad = segLen === 0;
        if (!bad && segLen <= 2) {
          __previewScanStats.charScans += segLen;
          bad = text[q + 1] === "." && (segLen === 1 || text[q + 2] === ".");
        }
        if (bad) lastBad = q; // slashes ascend — the last assignment is the max
      }
      secondLastSlash = slashes.length >= 2 ? slashes[slashes.length - 2] : -1;
      // ④ The byte-cap lower bound — O(1)-bounded per run (≤ ~4097 bytes, never past s0).
      minStart = minStartOf(text, slash, spanP);
    }
    // Per-candidate results from the memo, mirroring the original per-candidate strip (its
    // "> 1 char remains" guard is start-relative) and line:col split (its "path must precede
    // the suffix" guard; no start can sit inside the match — it has no `/`).
    const strippedEnd = Math.max(spanStrippedEnd, slash + 1);
    const hasLineCol = spanLineColStart !== -1 && slash < spanLineColStart;
    const startOk = isStartContext(text, slash, startSet);
    // —— §2.5.2 route 1: absolute candidates (each '/' start costs O(1)) ——
    if (startOk && slash < spanP && spanP - slash <= PREVIEW_PATH_MAX_BYTES) {
      // fastOk ⇔ validatePreviewPath(text.slice(slash, spanP)) minus the structurally
      // guaranteed leading-`/` and CR/LF items — see the plan's item-by-item derivation.
      const fastOk = slash > lastBad && slash > lastNul && slash <= secondLastSlash && slash >= minStart;
      if (fastOk) {
        let route = false;
        if (abs) {
          route = true; // C4: under `abs`, isClickable(path) IS validatePreviewPath(path)
        } else {
          let cwdHit = false;
          if (cwdPrefix !== null) {
            __previewScanStats.charScans += cwdPrefix.length;
            cwdHit = text.startsWith(cwdPrefix, slash);
          }
          if (cwdHit) {
            route = true;
          } else if (uploads) {
            if (markerNext === -2) markerNext = text.indexOf(PREVIEW_UPLOADS_MARKER, slash);
            while (markerNext !== -1 && markerNext < slash) {
              markerNext = text.indexOf(PREVIEW_UPLOADS_MARKER, markerNext + 1);
            }
            route = markerNext !== -1 && markerNext + PREVIEW_UPLOADS_MARKER.length <= spanP;
          }
        }
        if (route) {
          const path = text.slice(slash, spanP);
          __previewScanStats.charScans += path.length;
          if (textStart < slash) segments.push({ kind: "text", text: text.slice(textStart, slash) });
          /** @type {PathSegment} */
          const seg = { kind: "ref", text: text.slice(slash, strippedEnd), path };
          __previewScanStats.charScans += seg.text.length;
          if (hasLineCol) {
            seg.line = spanLine;
            if (spanCol !== undefined) seg.col = spanCol;
          }
          segments.push(seg);
          refs++;
          textStart = strippedEnd;
          i = strippedEnd;
          continue;
        }
      }
    }
    // —— §2.5.2 route 2: relative candidates — exactly once per run, at its first slash, using
    // the backward-scanned leading identifier (`spanWordStart`) instead of `slash` itself.
    if (slash === spanFirstSlash && cwdPrefix !== null) {
      const ws = spanWordStart;
      if (ws < slash && relativeStartContext(text, ws, startSet) && spanP - ws <= PREVIEW_PATH_MAX_BYTES) {
        // seg0ok: the leading segment must be a legal segment on its own (non-empty, not
        // `.`/`..`, no `:` URI scheme, no NUL) AND the window's absolute part must carry no bad
        // segment. The prune is STRIP-AWARE (§2.5 (b)): when the candidate still carries its
        // trailing `/` into the window (`text[spanP-1] === "/"`), resolve strips that slash —
        // its P-cut empty segment is a window artifact, not part of the resolved path — so the
        // scan ends one char early. `lastBad` itself stays pure (route 1's slices DO include
        // the edge); this dedicated once-per-run scan keeps the prune exactly "resolved has a
        // bad segment". isClickable(resolved) remains the final gate either way.
        const seg0 = text.slice(ws, slash);
        __previewScanStats.charScans += seg0.length;
        const pruneEnd = dirs && text[spanP - 1] === "/" ? spanP - 1 : spanP;
        let absBad = false;
        for (let q = slash; q < pruneEnd && !absBad;) {
          if (text[q] !== "/") {
            q++;
            __previewScanStats.charScans += 1;
            continue;
          }
          let e = q + 1;
          while (e < pruneEnd && text[e] !== "/") e++;
          __previewScanStats.charScans += e - q;
          const segLen = e - (q + 1);
          if (segLen === 0 || (segLen <= 2 && text[q + 1] === "." && (segLen === 1 || text[q + 2] === ".")))
            absBad = true;
          q = e;
        }
        const seg0ok =
          !absBad && seg0 !== "" && seg0 !== "." && seg0 !== ".." && !seg0.includes(":") && !seg0.includes("\0");
        if (seg0ok) {
          const rel0 = text.slice(ws, spanP);
          __previewScanStats.charScans += rel0.length;
          const shape = looksLikeRelativePath(rel0);
          const opener = text[ws - 1];
          const dirsEx =
            dirs &&
            (spanTrailingSlash ||
              ((opener === '"' || opener === "'" || opener === "`") && text[strippedEnd] === opener));
          if (shape || dirsEx) {
            const rel = rel0.endsWith("/") ? rel0.slice(0, -1) : rel0; // §2.5 (b): drop the trailing /
            const resolved = `${cwdBase}/${rel}`;
            __previewScanStats.charScans += resolved.length;
            if (isClickable(resolved, scope)) {
              if (textStart < ws) segments.push({ kind: "text", text: text.slice(textStart, ws) });
              /** @type {PathSegment} */
              const seg = { kind: "ref", text: text.slice(ws, strippedEnd), path: resolved };
              __previewScanStats.charScans += seg.text.length;
              if (hasLineCol) {
                seg.line = spanLine;
                if (spanCol !== undefined) seg.col = spanCol;
              }
              segments.push(seg);
              refs++;
              textStart = strippedEnd;
              i = strippedEnd;
              continue;
            }
          }
        }
      }
    }
    i = slash + 1;
  }
  if (textStart < n) segments.push({ kind: "text", text: text.slice(textStart) });
  if (segments.length === 0) segments.push({ kind: "text", text });
  return segments;
}

/**
 * §4.6 `pathRefOfCode(text, scope)` — the inline-code twin of `findPathRefs`: the WHOLE code
 * span is the candidate (no start-context rule — the backticks already delimit it), held to
 * the same terminator/validation/scope rules so a path is never clickable in code but dead in
 * prose or vice versa. Trailing sentence punctuation is NOT stripped here (code content is
 * verbatim) — only the `:line[:col]` display suffix splits off. A relative candidate (rule
 * 1b) resolves against `scope.cwd` the same way `findPathRefs` does; the DISPLAYED `text` is
 * always the original (unresolved) code span. Returns `null` when the code span is not a
 * single clickable path.
 *
 * dir-plan §2.5.3 (markdown context): under `dirs` the span may be a no-extension relative
 * path containing `/` (the backticks are the pairing by construction — this is exactly the
 * (c) rule's markdown-context counterpart) and may carry ONE trailing `/` (the (a)/(b)
 * counterpart), which is dropped from the resolved path but kept in the displayed text.
 * `abs` alone (without `dirs`) changes nothing here — the trailing-slash/no-extension rules
 * are A5 additions gated on `dirs` only.
 * @param {string} text @param {PathScope | null | undefined} scope
 * @returns {{ text: string, path: string, line?: number, col?: number } | null}
 */
export function pathRefOfCode(text, scope) {
  if (typeof text !== "string" || text === "" || scope === null || scope === undefined) return null;
  for (const ch of text) {
    if (isTerminator(ch)) return null;
  }
  const { path, line, col } = splitLineCol(text);
  const dirs = scope.dirs === true;
  // §2.5.3: under `dirs` ONE trailing `/` is legal (dropped from the resolved path, kept in
  // the displayed text). The `/`-containment test uses the PRE-strip span so a bare `seg0/`
  // still qualifies (its stripped form has no slash left).
  const hadSlash = path.indexOf("/") > 0;
  let cand = path;
  if (dirs && cand.length > 1 && cand.endsWith("/")) cand = cand.slice(0, -1);
  /** @type {string | null} */
  let resolved;
  if (cand.startsWith("/")) {
    resolved = cand;
  } else if (dirs) {
    // §2.5.3: no-extension relative spans are acceptable under `dirs` — require ≥1 `/` with a
    // non-empty, scheme-free leading segment (mirroring `resolveRelativePath`'s cwd handling);
    // segment validity is isClickable's job, as always.
    const slash = path.indexOf("/");
    const firstSeg = slash > 0 ? path.slice(0, slash) : "";
    const base0 = typeof scope.cwd === "string" ? scope.cwd : "";
    const base = base0.endsWith("/") ? base0.slice(0, -1) : base0;
    resolved =
      hadSlash && firstSeg !== "" && !firstSeg.includes(":") && base !== "" && base !== "/" ? `${base}/${cand}` : null;
  } else {
    resolved = resolveRelativePath(cand, scope.cwd);
  }
  if (resolved === null || !isClickable(resolved, scope)) return null;
  /** @type {{ text: string, path: string, line?: number, col?: number }} */
  const out = { text, path: resolved };
  if (line !== undefined) out.line = line;
  if (col !== undefined) out.col = col;
  return out;
}

/**
 * v3-2 (§7-D13 双保险): the scope identity a watcher keys on — same sessionId is SUPPOSED to
 * imply same cwd, but carrying cwd in the key costs one string concat and invalidates the
 * scope (closing any open preview) if that invariant ever breaks. dir-plan §2.5.1: `|abs` /
 * `|dir` are appended when the respective flag is set — a hub cap change invalidates the
 * scope and the probe LRU partitions naturally; the format is byte-identical when neither
 * flag is set (every pre-dir-plan key pin stays green).
 * @param {PathScope | null | undefined} scope
 */
export function scopeKeyOf(scope) {
  if (scope === null || scope === undefined) return "";
  let key = `${scope.agentKey}|${scope.sessionId}|${scope.cwd ?? ""}`;
  if (scope.abs === true) key += "|abs";
  if (scope.dirs === true) key += "|dir";
  return key;
}

/**
 * §0/P2-13 client pixel budget (D: touch devices decode into tighter memory): checked against
 * the response's `X-PWH-Preview-Dims` BEFORE the body is read; an over-budget image aborts
 * the fetch and shows the tooLarge phase instead of a 21MiB base64 string.
 * @param {{ coarse?: boolean }} [p]
 */
export function clientImageBudget(p) {
  return p !== undefined && p.coarse === true ? PREVIEW_CLIENT_PIXELS_COARSE : PREVIEW_IMAGE_MAX_PIXELS;
}

/**
 * §4.6 作用域推导 (truth table): `hasTransport` = the transport exposes `preview`; capOk =
 * password mode requires `preview.lan.v1`, anything else requires `preview.v1` (under the
 * default mode "on" BOTH are declared, so a LAN browser gets a scope — U1). `session` is the
 * selected agent's live session (`AgentState.session` / `card.session`); its `cwd` is carried
 * nullable (uploads-marker paths stay clickable even with an unknown cwd).
 * @param {{ mode?: string, hubCaps?: unknown, hasTransport?: boolean, agentKey?: unknown,
 *   session?: unknown }} p
 * @returns {PathScope | null}
 */
export function previewScopeOf(p) {
  const { mode, hubCaps, hasTransport, agentKey, session } = p ?? {};
  if (hasTransport !== true) return null;
  const caps = Array.isArray(hubCaps) ? hubCaps : [];
  const needed = mode === "password" ? PREVIEW_LAN_HUB_CAP : PREVIEW_HUB_CAP;
  if (!caps.includes(needed)) return null;
  if (typeof agentKey !== "string" || agentKey === "") return null;
  if (session === null || typeof session !== "object") return null;
  const s = /** @type {{ sessionId?: unknown, cwd?: unknown }} */ (session);
  if (typeof s.sessionId !== "string" || s.sessionId === "") return null;
  const cwd = typeof s.cwd === "string" ? s.cwd : null;
  /** @type {PathScope} */
  const scope = { agentKey, sessionId: s.sessionId, cwd, uploads: true };
  // dir-plan §2.5.1: the abs/dir caps ADD their keys only when present — `preview.abs.v1`
  // unlocks absolute-path recognition outside cwd (C4), `preview.dir.v1` the directory
  // candidate rules (A5) + `dir=1`/`dirs:true` on the wire. Absent cap ⇒ absent key, so a
  // pre-dir-plan hub's scopes are deep-equal to before.
  if (caps.includes(PREVIEW_ABS_HUB_CAP)) scope.abs = true;
  if (caps.includes(PREVIEW_DIR_HUB_CAP)) scope.dirs = true;
  return scope;
}

/**
 * Parse an `X-PWH-Preview-Dims` header value (`"<w>x<h>"`, protocol/preview.ts `PreviewDims`).
 * @param {unknown} raw @returns {PreviewDimsT | null}
 */
export function parsePreviewDims(raw) {
  if (typeof raw !== "string") return null;
  const m = /^(\d{1,7})x(\d{1,7})$/.exec(raw.trim());
  if (m === null) return null;
  const w = Number(m[1]);
  const h = Number(m[2]);
  return w >= 1 && h >= 1 ? { w, h } : null;
}

const IMAGE_MIMES = new Set(["image/png", "image/jpeg", "image/gif", "image/webp"]);

/**
 * §4.6 transport pre-body gate ("图片先读头再决读不读 body"): everything the client can decide
 * from the response HEADERS alone. `Content-Length` is REQUIRED (it is also the body-
 * completeness oracle — a body that doesn't match it maps to `E_PREVIEW_CHANGED`);
 * `X-PWH-Preview-Size` is the display size (a truncated text body's total is LARGER than its
 * Content-Length, so the two are deliberately never cross-checked). Failure kinds:
 * - `E_BAD_RESPONSE` (client-local): Kind/Content-Length/Content-Type malformed or
 *   inconsistent — the server is out of contract;
 * - `E_PREVIEW_TOO_LARGE` `bytes` (client-local mirror of the server 413): Content-Length
 *   over the listener's image cap / the 256KiB text cap;
 * - `E_PREVIEW_UNSUPPORTED` `dims-unknown` (mirrors the server 415): image dims unparseable;
 * - `E_PREVIEW_TOO_LARGE` `pixels`: dims fine but over `maxPixels` (the client budget).
 *
 * dir-plan §1.3/§5 P2 — the dir gate: `Kind: dir` is a LEGAL kind only for a request that
 * opted in (`opts.dir === true`, the `&dir=1` GET). Without the opt-in it is a header-contract
 * violation of THIS response ⇒ `E_BAD_RESPONSE` (the caller aborts before reading the body).
 * With the opt-in the gate stops here: a dir body is capped-and-parsed JSON, not a
 * length-oracled byte stream, so none of the Content-Length/Content-Type machinery below
 * applies (`parsePreviewDirListing` is the real contract gate).
 * @param {{ get(name: string): string | null } | null | undefined} headers
 * @param {{ maxPixels?: number, imageMaxBytes?: number, dir?: boolean }} [opts]
 * @returns {{ ok: true, kind: "image", mime: string, size: number, totalSize: number, dims: PreviewDimsT, truncated: false }
 *   | { ok: true, kind: "text", size: number, totalSize: number, truncated: boolean }
 *   | { ok: true, kind: "dir" }
 *   | { ok: false, error: string, reason?: string, size?: number, max?: number, dims?: PreviewDimsT }}
 */
export function checkPreviewHeaders(headers, opts) {
  const get = (/** @type {string} */ name) =>
    headers !== null && typeof headers === "object" && typeof headers.get === "function" ? headers.get(name) : null;
  const kind = get(PREVIEW_HDR.kind);
  if (kind === "dir") {
    if (!(opts !== undefined && opts.dir === true)) return { ok: false, error: "E_BAD_RESPONSE" };
    return { ok: true, kind: "dir" };
  }
  if (kind !== "image" && kind !== "text") return { ok: false, error: "E_BAD_RESPONSE" };
  // Transport compression (dynamic preview-text gzip): `Content-Length` names the COMPRESSED
  // length and fetch transparently decompresses, so the completeness oracle must compare the
  // decoded body against `X-PWH-Preview-Bytes` (the original body length) instead. A short or
  // corrupt stream fails gzip decoding before this check ever runs, so the container itself
  // still guarantees integrity; this header restores the exact-length check on top.
  const encoding = (get("Content-Encoding") ?? "").toLowerCase();
  const compressed = encoding !== "" && encoding !== "identity";
  const sizeRaw = compressed ? get(PREVIEW_HDR.bytes) : get("Content-Length");
  const size = sizeRaw === null || sizeRaw === "" ? NaN : Number(sizeRaw);
  if (!Number.isInteger(size) || size < 0) return { ok: false, error: "E_BAD_RESPONSE" };
  const totalRaw = get(PREVIEW_HDR.size);
  const totalN = totalRaw === null || totalRaw === "" ? NaN : Number(totalRaw);
  const totalSize = Number.isInteger(totalN) && totalN >= size ? totalN : size;
  const ct = (get("Content-Type") ?? "").toLowerCase();
  if (kind === "text") {
    if (size > PREVIEW_TEXT_MAX_BYTES) {
      return { ok: false, error: "E_PREVIEW_TOO_LARGE", reason: "bytes", size, max: PREVIEW_TEXT_MAX_BYTES };
    }
    if (!ct.startsWith("text/plain")) return { ok: false, error: "E_BAD_RESPONSE" };
    const truncatedRaw = get(PREVIEW_HDR.truncated);
    return { ok: true, kind: "text", size, totalSize, truncated: truncatedRaw === "1" || truncatedRaw === "true" };
  }
  const imageMaxBytes =
    opts !== undefined && typeof opts.imageMaxBytes === "number"
      ? opts.imageMaxBytes
      : PREVIEW_IMAGE_MAX_BYTES.loopback;
  if (size > imageMaxBytes) {
    return { ok: false, error: "E_PREVIEW_TOO_LARGE", reason: "bytes", size, max: imageMaxBytes };
  }
  const mime = (ct.split(";")[0] ?? "").trim();
  if (!IMAGE_MIMES.has(mime)) return { ok: false, error: "E_BAD_RESPONSE" };
  const dims = parsePreviewDims(get(PREVIEW_HDR.dims));
  if (dims === null) return { ok: false, error: "E_PREVIEW_UNSUPPORTED", reason: "dims-unknown", size };
  const maxPixels =
    opts !== undefined && typeof opts.maxPixels === "number" ? opts.maxPixels : PREVIEW_IMAGE_MAX_PIXELS;
  if (dims.w * dims.h > maxPixels) {
    return { ok: false, error: "E_PREVIEW_TOO_LARGE", reason: "pixels", size, max: maxPixels, dims };
  }
  return { ok: true, kind: "image", mime, size, totalSize, dims, truncated: false };
}

/**
 * The non-200 mapping, shared verbatim by BOTH logic clients (token + password) so the two
 * transports can never drift. `r.json()` is read exactly once (a real `Response` body can
 * only be consumed once); the body's `reason`/`size`/`max`/`dims` ride through so
 * `usePreview`'s unsupported/tooLarge phases render the server's detail, and `Retry-After`
 * (header seconds, else body `retryAfterS`) folds like every other namespace.
 * @param {{ ok: boolean, status: number, headers?: { get(name: string): string | null }, json(): Promise<any> }} r
 * @returns {Promise<{ ok: false, status: number, error: string, reason?: string, size?: number,
 *   max?: number, dims?: PreviewDimsT, retryAfterS?: number }>}
 */
export async function previewOutcomeFromResponse(r) {
  /** @type {any} */
  let body;
  try {
    body = await r.json();
  } catch {
    body = undefined;
  }
  const b = body !== null && typeof body === "object" ? body : {};
  /** @type {any} */
  const out = {
    ok: false,
    status: r.status,
    error: typeof b.error === "string" ? b.error : r.status === 401 ? "E_AUTH" : `HTTP ${r.status}`,
  };
  if (typeof b.reason === "string") out.reason = b.reason;
  if (typeof b.size === "number" && Number.isFinite(b.size)) out.size = b.size;
  if (typeof b.max === "number" && Number.isFinite(b.max)) out.max = b.max;
  const dims = parsePreviewDims(typeof b.dims === "object" && b.dims !== null ? `${b.dims.w}x${b.dims.h}` : null);
  if (dims !== null) out.dims = dims;
  const raw = typeof r.headers?.get === "function" ? r.headers.get("Retry-After") : null;
  const hn = raw === null || raw === undefined ? NaN : Number(raw);
  const ra =
    Number.isFinite(hn) && hn >= 0
      ? hn
      : typeof b.retryAfterS === "number" && b.retryAfterS >= 0
        ? b.retryAfterS
        : undefined;
  if (ra !== undefined) out.retryAfterS = ra;
  return out;
}

/**
 * §3.2's phase taxonomy for a failed preview (`usePreview` maps `kind` to its view phase;
 * the transports hand their structured `PreviewOutcome` error straight back in as `body` —
 * it deliberately carries the same `error`/`reason`/`size`/`max`/`dims` field names as the
 * wire body). Client-local codes (`E_ABORT`/`E_DEADLINE`/`E_NETWORK`/`E_BAD_RESPONSE`, status
 * 0) classify exactly like their wire cousins: deadline/network are retryable, abort is not
 * (and is normally dropped by the seq guard before it ever renders).
 * @param {number} status @param {unknown} body
 * @returns {{ kind: "unsupported", error: string, status: number, reason?: string, size?: number }
 *   | { kind: "tooLarge", error: string, status: number, reason?: string, size?: number, max?: number, dims?: PreviewDimsT }
 *   | { kind: "session-changed", error: string, status: number }
 *   | { kind: "error", error: string, status: number, retryable: boolean, retryAfterS?: number }}
 */
export function classifyPreviewError(status, body) {
  const b = body !== null && typeof body === "object" ? /** @type {Record<string, unknown>} */ (body) : {};
  const error =
    typeof b.error === "string" ? b.error : status === 401 ? "E_AUTH" : status > 0 ? `HTTP ${status}` : "E_NETWORK";
  const reason = typeof b.reason === "string" ? b.reason : undefined;
  const size = typeof b.size === "number" && Number.isFinite(b.size) ? b.size : undefined;
  if (error === "E_PREVIEW_UNSUPPORTED") {
    /** @type {any} */
    const out = { kind: "unsupported", error, status };
    if (reason !== undefined) out.reason = reason;
    if (size !== undefined) out.size = size;
    return out;
  }
  if (error === "E_PREVIEW_TOO_LARGE") {
    /** @type {any} */
    const out = { kind: "tooLarge", error, status };
    if (reason !== undefined) out.reason = reason;
    if (size !== undefined) out.size = size;
    if (typeof b.max === "number" && Number.isFinite(b.max)) out.max = b.max;
    const dims = parsePreviewDims(
      typeof b.dims === "object" && b.dims !== null
        ? `${/** @type {{ w?: unknown, h?: unknown }} */ (b.dims).w}x${/** @type {{ w?: unknown, h?: unknown }} */ (b.dims).h}`
        : null,
    );
    if (dims !== null) out.dims = dims;
    return out;
  }
  if (error === "E_SESSION_CHANGED") return { kind: "session-changed", error, status };
  const retryable =
    error === "E_DEADLINE" ||
    error === "E_NETWORK" ||
    error === "E_RATE" ||
    error === "E_BUSY" ||
    error === "E_HUB_RESTARTING" ||
    status === 429 ||
    status >= 500;
  /** @type {any} */
  const out = { kind: "error", error, status, retryable };
  if (typeof b.retryAfterS === "number" && b.retryAfterS >= 0) out.retryAfterS = b.retryAfterS;
  return out;
}

/* -------------------------------------------------------------------------
 * Directory-preview navigation + sizing (dir-plan v3.1 §0.2 A3 + P2's `formatPreviewBytes`)
 * — pure path algebra for the P3 composable's in-dialog navigation. Both functions are
 * total (never throw) and validate through the protocol's own `validatePreviewPath` with
 * `minSegments: 1`: navigation legitimately reaches ONE-segment directories (`/home`),
 * while `/` itself is not listable (A3) and therefore never a navigation target.
 * ---------------------------------------------------------------------- */

/**
 * A3 “点子项”: join a listed entry name onto its directory path. `name` must be a single
 * legal segment (non-empty, no `/`, no NUL, not `.`/`..`); the joined path must still be
 * protocol-valid (≤4096 UTF-8 bytes, min 1 segment — the parent already guarantees ≥1, so
 * the child always has ≥2). A `dir` carrying a trailing `/` (a (a)-rule display form) is
 * normalized first. Returns `null` for anything else — the caller keeps the row inert.
 * @param {string} dir @param {string} name
 * @returns {string | null}
 */
export function childPreviewPath(dir, name) {
  if (typeof dir !== "string" || typeof name !== "string") return null;
  if (name === "" || name === "." || name === ".." || name.includes("/") || name.includes("\0")) return null;
  const base = dir.length > 1 && dir.endsWith("/") ? dir.slice(0, -1) : dir;
  if (!base.startsWith("/")) return null;
  const child = `${base}/${name}`;
  return validatePreviewPath(child, { minSegments: 1 }) ? child : null;
}

/**
 * A3 “上级”: the parent path of a previewed directory — `/a/b/c` → `/a/b`, `/a/b` → `/a`.
 * Stops at one segment: the parent of a one-segment path is `/`, which is NOT listable, so
 * `null` is returned there (the UI greys the 上级 button). A trailing `/` is normalized
 * first (`/a/b/` → parent `/a`, not `/a/b`). Returns `null` for non-strings and any result
 * that is not itself a protocol-valid (≥1 segment) path.
 * @param {string} path
 * @returns {string | null}
 */
export function parentPreviewPath(path) {
  if (typeof path !== "string") return null;
  const base = path.length > 1 && path.endsWith("/") ? path.slice(0, -1) : path;
  if (!base.startsWith("/")) return null;
  const cut = base.lastIndexOf("/");
  if (cut <= 0) return null; // "/a" → "/" is not listable; malformed → refuse
  const parent = base.slice(0, cut);
  return validatePreviewPath(parent, { minSegments: 1 }) ? parent : null;
}

/**
 * dir-plan P2: human-readable byte size for a directory listing's file rows (A1) — plain
 * ASCII units (`B`/`KiB`/`MiB`/`GiB`, binary 1024 steps, one fraction digit above 1 KiB),
 * matching the UI's compact-marker language split. Non-finite/negative input (a missing
 * `size` on a `statPartial` entry, a corrupt value) degrades to `""` so the caller renders
 * nothing rather than a wrong number.
 * @param {unknown} n
 * @returns {string}
 */
export function formatPreviewBytes(n) {
  if (typeof n !== "number" || !Number.isFinite(n) || n < 0) return "";
  if (n < 1024) return `${Math.floor(n)} B`;
  const units = ["KiB", "MiB", "GiB"];
  let v = n / 1024;
  let u = 0;
  while (v >= 1024 && u < units.length - 1) {
    v /= 1024;
    u++;
  }
  return `${v.toFixed(1)} ${units[u]}`;
}

/* -------------------------------------------------------------------------
 * Markdown preview (dir-plan v3.1 §4.1/§4.3, PM package — appended ONLY; every line above
 * this section is byte-frozen for this package). Client-side, protocol/hub-untouched: the
 * file is still fetched as `kind:"text"`; whether it renders as markdown is decided here
 * from the path alone (B1), and the render budget/降级 (B7/§4.3) bounds the DOM size.
 * ---------------------------------------------------------------------- */

/** B1: known markdown extensions, case-insensitive, on the LAST dot segment (no `.mdx`). */
const MD_PATH_RE = /\.(?:md|markdown)$/i;

/**
 * B1: does this (display) path refer to a markdown file? Client-side extension check on the
 * last segment — `.md` / `.markdown`, case-insensitive; `.mdx` deliberately NOT included
 * (the whitelist parser has no JSX escapes, so a `.mdx` would render misleadingly).
 * Everything else — plain text, JSON, source code — is untouched by the md features.
 * @param {unknown} path
 * @returns {boolean}
 */
export function isMarkdownPath(path) {
  return typeof path === "string" && path !== "" && MD_PATH_RE.test(path);
}

/**
 * B5/§4.1: a truncated body's last line may be cut MID-construct (half a fence, half an
 * emphasis span, half a multibyte char's rendering contract). Rendering still defaults to
 * rendered markdown — but the incomplete final line is dropped first: everything after the
 * last `\n` is removed. A body with NO `\n` at all is the one incomplete line itself and is
 * returned as-is (there is nothing complete to fall back to; the truncated note covers it).
 * Non-truncated bodies pass through byte-identical.
 * @param {unknown} text
 * @param {unknown} truncated
 * @returns {string}
 */
export function prepareMarkdownPreview(text, truncated) {
  if (typeof text !== "string") return "";
  if (truncated !== true) return text;
  const cut = text.lastIndexOf("\n");
  return cut === -1 ? text : text.slice(0, cut);
}

/** §4.3/B7: AST-node budget — roughly ≤ 2 DOM nodes per AST node ⇒ ≤ ~40k DOM nodes. */
export const PREVIEW_MD_NODE_MAX = 20_000;

/**
 * §4.3/B7: count the AST objects reachable from `parseMarkdown` output through array-valued
 * fields (`children`/`items`/`header`/`rows` — block and inline nodes alike; strings such as
 * `text`/`href`/`lang` are not nodes). Walks an explicit stack (no recursion — the budget
 * exists precisely for adversarial 256 KiB inputs) and stops EARLY once `cap` is reached, so
 * the answer is exact up to and including `cap` and "≥ cap" beyond it. The default cap is
 * `PREVIEW_MD_NODE_MAX + 1`, i.e. the boolean `countMdNodes(nodes) > PREVIEW_MD_NODE_MAX`
 * stays exact while a pathological document never finishes the walk.
 * @param {unknown} nodes @param {number} [cap]
 * @returns {number}
 */
export function countMdNodes(nodes, cap = PREVIEW_MD_NODE_MAX + 1) {
  if (!Array.isArray(nodes) || !(cap > 0)) return 0;
  let count = 0;
  const stack = [nodes];
  while (stack.length > 0) {
    const cur = stack.pop();
    if (Array.isArray(cur)) {
      for (const child of cur) stack.push(child);
      continue;
    }
    if (cur === null || typeof cur !== "object") continue;
    count++;
    if (count >= cap) return count;
    for (const key in cur) {
      const v = /** @type {Record<string, unknown>} */ (cur)[key];
      if (Array.isArray(v)) stack.push(v);
    }
  }
  return count;
}
