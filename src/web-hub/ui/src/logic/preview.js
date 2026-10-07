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
 *   (U1) BOTH caps are declared, so password mode gets a scope too.
 * - `scopeKeyOf(scope)` — `agentKey|sessionId|cwd` (v3-2 双保险: the same-sessionId-cwd-never-
 *   changes invariant PLUS the key carrying cwd, so a cwd change invalidates the scope).
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
import { PREVIEW_HUB_CAP, PREVIEW_LAN_HUB_CAP } from "@protocol/version.ts";

/**
 * @typedef {{ agentKey: string, sessionId: string, cwd: string | null, uploads: boolean }} PathScope
 * @typedef {{ kind: "text", text: string }
 *   | { kind: "ref", text: string, path: string, line?: number, col?: number }} PathSegment
 * @typedef {{ w: number, h: number }} PreviewDimsT
 */

/** §4.6 rule 6: at most this many refs are recognized per text node (the rest stays text). */
export const PREVIEW_MAX_REFS_PER_NODE = 100;

/** §4.6 rule 1: a candidate `/` may immediately follow one of these (besides line start / whitespace). */
const START_CHARS = new Set(["(", "[", "{", "<", '"', "'", "=", "（", "「", "『", "【", "《", "："]);

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
 * Rule 1b's backward-scan stop condition: a word boundary is a terminator OR a START_CHARS
 * opener. The latter addition matters because some START_CHARS (`=`, `(`, …) are NOT
 * terminators (an absolute candidate's forward scan must keep going past them when they
 * appear mid-path), so using `isTerminator` alone here would let the backward scan walk PAST
 * an opener like `=` into whatever precedes it — e.g. `foo=/home/...` would wrongly compute
 * `foo=` as part of the leading identifier instead of stopping right at the `/` (correctly
 * yielding an empty leading segment, since that slash's candidate is already `=`'s absolute
 * territory).
 * @param {string | undefined} ch
 */
function isWordBoundary(ch) {
  return isTerminator(ch) || (ch !== undefined && START_CHARS.has(ch));
}

/**
 * §4.6 rule 1: the candidate's leading `/` must sit at line start (string start counts) or
 * right after whitespace / a START_CHARS opener.
 * @param {string} text @param {number} slash
 */
function isStartContext(text, slash) {
  if (slash === 0) return true;
  const prev = text[slash - 1];
  return prev !== undefined && (WS_RE.test(prev) || START_CHARS.has(prev));
}

/**
 * §4.6 rule 1b (relative paths): same whitespace/START_CHARS test as `isStartContext`, but
 * deliberately WITHOUT its `position === 0 ⇒ true` shortcut — a bare text-node boundary is
 * not, by itself, good enough evidence that a leading identifier (`x`, `1`, `src`, …) is the
 * start of a path rather than the middle of a sentence this call only sees a fragment of.
 * This is what keeps the already-frozen absolute "not clickable" fixtures `"x/home/..."` /
 * `"1/home/..."` from picking up a brand-new relative match. Tool-call args (the feature's
 * main target) are always quote-delimited (`"path": "src/foo.ts"`), so they hit the
 * `START_CHARS.has('"')` branch regardless.
 * @param {string} text @param {number} wordStart
 */
function relativeStartContext(text, wordStart) {
  if (wordStart <= 0) return false;
  const prev = text[wordStart - 1];
  return prev !== undefined && (WS_RE.test(prev) || START_CHARS.has(prev));
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
 * carrying the upload-store marker when the scope allows uploads).
 * @param {string} path @param {PathScope} scope
 */
function isClickable(path, scope) {
  if (!validatePreviewPath(path)) return false;
  if (scope.uploads === true && path.includes(PREVIEW_UPLOADS_MARKER)) return true;
  const cwd = scope.cwd;
  if (typeof cwd !== "string" || cwd === "" || cwd === "/") return false;
  const base = cwd.endsWith("/") ? cwd.slice(0, -1) : cwd;
  return base !== "" && base !== "/" && path.startsWith(`${base}/`);
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
 * **Linear-scan design (verifier P1 fix, 2026-10):** every candidate starting inside the same
 * terminator-free run ends at the SAME end index, so the end-scan, the trailing-punct strip
 * and the `:line[:col]` tail parse are memoized ONCE per run instead of being redone per
 * start position — the old `i = slash + 1` rescan made `"=/".repeat(n)` O(n²) (a remote
 * main-thread-freeze DoS over the transcript, U3). Per candidate the results are computed
 * from the memo with two O(1) adjustments (the strip's `> 1 char` guard and the line:col
 * split's `path must precede the suffix` guard are both start-relative — see the derivation
 * in `docs/dev/web-hub-preview/plan.md` §4.6; no start position can ever fall INSIDE a
 * `:line[:col]` match because the match contains no `/`). Two cheap rejections keep the
 * per-candidate cost O(1) whenever the full check would fail anyway (it is a pure AND, so
 * short-circuiting it changes no outcome):
 * - path longer than `PREVIEW_PATH_MAX_BYTES` UTF-16 units (units ≤ UTF-8 bytes ⇒
 *   `validatePreviewPath` would reject);
 * - no scope route possible: the cwd prefix misses on the raw text AND the uploads marker
 *   (tracked with an amortized forward cursor) does not occur inside `[slash, pathEnd)`.
 * Only candidates passing both do the real slice + `isClickable` (≤4096 units of work, and
 * at most ~4096 such starts per run — the rest of a huge run is skipped in O(1) each).
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

  // Per-call scope pre-computation (the scope never changes mid-scan): the exact cwd-prefix
  // `isClickable` tests (`null` when the cwd route is impossible for every candidate), and a
  // forward cursor for the uploads marker so `includes()` is never re-run from scratch.
  const cwd = scope.cwd;
  const cwdPrefix =
    typeof cwd === "string" && cwd !== "" && cwd !== "/" ? `${cwd.endsWith("/") ? cwd.slice(0, -1) : cwd}/` : null;
  const uploads = scope.uploads === true;
  let markerNext = -2; // -2 = not computed yet; else first marker occurrence >= the last query

  // Per-run memo (see the header): valid only for start positions < `spanEnd`.
  let spanEnd = -1; // first terminator >= the run's first start (n when none)
  let spanStrippedEnd = -1; // spanEnd minus the trailing `. : ! ?` run (with the >1 guard)
  let spanLineColStart = -1; // absolute start of the `:line[:col]` tail match, -1 when none
  /** @type {number | undefined} */
  let spanLine;
  /** @type {number | undefined} */
  let spanCol;
  // Relative-path memo (rule 1b): computed once per run too (symmetric backward scan, same
  // amortized-O(n) argument as the forward scan above), and only when a relative route is even
  // possible (`cwdPrefix !== null`) — a disabled scope pays nothing extra for this.
  let spanFirstSlash = -1; // the slash that triggered this run's memo (relative is tried ONLY there)
  let spanWordStart = -1; // backward boundary of the leading identifier before `spanFirstSlash`

  while (i < n && refs < PREVIEW_MAX_REFS_PER_NODE) {
    const slash = text.indexOf("/", i);
    if (slash === -1) break;
    const startOk = isStartContext(text, slash);
    if (slash >= spanEnd) {
      // New terminator-free run: scan its end once, then analyze its tail once.
      let end = slash + 1;
      while (end < n && !isTerminator(text[end])) end++;
      spanEnd = end;
      let stripped = end;
      while (stripped > slash + 1 && TRAILING_PUNCT_RE.test(text[stripped - 1])) stripped--;
      spanStrippedEnd = Math.max(slash + 1, stripped);
      const m = LINE_COL_RE.exec(text.slice(slash, spanStrippedEnd));
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
        while (ws > 0 && !isWordBoundary(text[ws - 1])) ws--;
        spanWordStart = ws;
      } else {
        spanWordStart = slash;
      }
    }
    // Per-candidate results from the memo, exactly mirroring the original per-candidate
    // strip (its "> 1 char remains" guard is start-relative) and line:col split (its
    // "path must precede the suffix" guard; no start can sit inside the match — it has no `/`).
    const strippedEnd = Math.max(spanStrippedEnd, slash + 1);
    const hasLineCol = spanLineColStart !== -1 && slash < spanLineColStart;
    const pathEnd = hasLineCol ? spanLineColStart : strippedEnd;
    if (startOk && pathEnd - slash <= PREVIEW_PATH_MAX_BYTES) {
      let scopePossible = cwdPrefix !== null && text.startsWith(cwdPrefix, slash);
      if (!scopePossible && uploads) {
        if (markerNext === -2) markerNext = text.indexOf(PREVIEW_UPLOADS_MARKER, slash);
        while (markerNext !== -1 && markerNext < slash) {
          markerNext = text.indexOf(PREVIEW_UPLOADS_MARKER, markerNext + 1);
        }
        scopePossible = markerNext !== -1 && markerNext + PREVIEW_UPLOADS_MARKER.length <= pathEnd;
      }
      if (scopePossible) {
        const path = text.slice(slash, pathEnd);
        if (isClickable(path, scope)) {
          if (textStart < slash) segments.push({ kind: "text", text: text.slice(textStart, slash) });
          /** @type {PathSegment} */
          const seg = { kind: "ref", text: text.slice(slash, strippedEnd), path };
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
    // Rule 1b (relative paths): tried exactly once per run, at its first slash, using the
    // backward-scanned leading identifier (`spanWordStart`) instead of `slash` itself.
    if (
      cwdPrefix !== null &&
      slash === spanFirstSlash &&
      spanWordStart < slash &&
      relativeStartContext(text, spanWordStart) &&
      pathEnd - spanWordStart <= PREVIEW_PATH_MAX_BYTES
    ) {
      const resolved = resolveRelativePath(text.slice(spanWordStart, pathEnd), cwd);
      if (resolved !== null && isClickable(resolved, scope)) {
        if (textStart < spanWordStart) segments.push({ kind: "text", text: text.slice(textStart, spanWordStart) });
        /** @type {PathSegment} */
        const seg = { kind: "ref", text: text.slice(spanWordStart, strippedEnd), path: resolved };
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
 * @param {string} text @param {PathScope | null | undefined} scope
 * @returns {{ text: string, path: string, line?: number, col?: number } | null}
 */
export function pathRefOfCode(text, scope) {
  if (typeof text !== "string" || text === "" || scope === null || scope === undefined) return null;
  for (const ch of text) {
    if (isTerminator(ch)) return null;
  }
  const { path, line, col } = splitLineCol(text);
  const resolved = path.startsWith("/") ? path : resolveRelativePath(path, scope.cwd);
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
 * scope (closing any open preview) if that invariant ever breaks.
 * @param {PathScope | null | undefined} scope
 */
export function scopeKeyOf(scope) {
  if (scope === null || scope === undefined) return "";
  return `${scope.agentKey}|${scope.sessionId}|${scope.cwd ?? ""}`;
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
  return { agentKey, sessionId: s.sessionId, cwd, uploads: true };
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
 * @param {{ get(name: string): string | null } | null | undefined} headers
 * @param {{ maxPixels?: number, imageMaxBytes?: number }} [opts]
 * @returns {{ ok: true, kind: "image", mime: string, size: number, totalSize: number, dims: PreviewDimsT, truncated: false }
 *   | { ok: true, kind: "text", size: number, totalSize: number, truncated: boolean }
 *   | { ok: false, error: string, reason?: string, size?: number, max?: number, dims?: PreviewDimsT }}
 */
export function checkPreviewHeaders(headers, opts) {
  const get = (/** @type {string} */ name) =>
    headers !== null && typeof headers === "object" && typeof headers.get === "function" ? headers.get(name) : null;
  const kind = get(PREVIEW_HDR.kind);
  if (kind !== "image" && kind !== "text") return { ok: false, error: "E_BAD_RESPONSE" };
  const clRaw = get("Content-Length");
  const size = clRaw === null || clRaw === "" ? NaN : Number(clRaw);
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
