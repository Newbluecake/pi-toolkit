/**
 * FROZEN REFERENCE COPY of `src/web-hub/ui/src/logic/preview.js`'s `findPathRefs` + its
 * private helpers as of the dir-plan v3.1 §2.5 P2 package (pre-linearization-of-the-
 * linearization: the memoized-run version of 2026-10's verifier P1 fix). The live module's
 * P2 rewrite replaced the per-candidate `pathEnd`/`isClickable` work with run-level constants
 * (`spanP`, `lastBad`, `lastNul`, `secondLastSlash`, `minStart` → `fastOk`) and added the
 * `abs`/`dirs` scope flags; `tests/web-hub/ui/logic-preview.test.ts` diffs the LIVE
 * `findPathRefs` against THIS copy on every frozen fixture input plus a fixed-seed random
 * corpus — in LEGACY scopes (no `abs`/`dirs` keys) the outputs must be deep-equal, which is
 * dir-plan §2.5.2's legacy-equivalence proof (the plan's lemma: `dirs === false` ⇒ the
 * run-level `spanP` IS the old per-candidate `pathEnd`).
 *
 * NEVER edit this file to "fix" a differential failure — a red diff means the live
 * implementation changed legacy behavior; re-freeze only by copying the exact released
 * implementation again. (One such intentional re-freeze happened 2026-10-09: the live
 * module's full-width/CJK punctuation terminator fix — see TERMINATOR_CHARS below — was
 * folded in here identically; it is the ONLY divergence from the original byte-for-byte
 * copy, and the live module carries the same change.)
 *
 * Original code follows, byte-for-byte (only the export of `findPathRefs` and the module
 * header above were added; the old header comments are kept inline).
 */
import { PREVIEW_PATH_MAX_BYTES, PREVIEW_UPLOADS_MARKER, validatePreviewPath } from "@protocol/preview.ts";

/** @typedef {{ agentKey: string, sessionId: string, cwd: string | null, uploads: boolean }} PathScope */
/** @typedef {{ kind: "text", text: string }
 *   | { kind: "ref", text: string, path: string, line?: number, col?: number }} PathSegment */

/** §4.6 rule 6: at most this many refs are recognized per text node (the rest stays text). */
const PREVIEW_MAX_REFS_PER_NODE = 100;

/** §4.6 rule 1: a candidate `/` may immediately follow one of these (besides line start / whitespace). */
const START_CHARS = new Set(["(", "[", "{", "<", '"', "'", "=", "（", "「", "『", "【", "《", "："]);

/** §4.6 rule 2: a candidate ends at the first of these (besides any whitespace).
 * 2026-10-09 RE-FREEZE (intentional rule change, not a differential "fix"): the live
 * module's full-width-punctuation terminator fix (user report 「预览图：/tmp/x.png（点开）」)
 * is folded in here identically — `（` `【` `「` `『` `《` (former start-only chars), `〈` `〉`
 * `…` (new) all terminate a candidate. Without this lockstep update the legacy differential
 * gate would pin the BUG (an opener absorbing following prose into the ref) once the fuzz
 * alphabet grew these chars. Non-punctuation CJK still never terminates. */
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
  "（",
  "）",
  "【",
  "】",
  "「",
  "」",
  "『",
  "』",
  "《",
  "》",
  "〈",
  "〉",
  "…",
]);

const WS_RE = /\s/;
const TRAILING_PUNCT_RE = /[.:!?]$/;
const LINE_COL_RE = /:(\d+)(?::(\d+))?$/;

/** @param {string | undefined} ch */
function isTerminator(ch) {
  return ch === undefined || WS_RE.test(ch) || TERMINATOR_CHARS.has(ch);
}

/** @param {string | undefined} ch */
function isWordBoundary(ch) {
  return isTerminator(ch) || (ch !== undefined && START_CHARS.has(ch));
}

/** @param {string} text @param {number} slash */
function isStartContext(text, slash) {
  if (slash === 0) return true;
  const prev = text[slash - 1];
  return prev !== undefined && (WS_RE.test(prev) || START_CHARS.has(prev));
}

/** @param {string} text @param {number} wordStart */
function relativeStartContext(text, wordStart) {
  if (wordStart <= 0) return false;
  const prev = text[wordStart - 1];
  return prev !== undefined && (WS_RE.test(prev) || START_CHARS.has(prev));
}

/** §4.6 rule 1b: last segment's extension shape — `.` + 1–10 "reasonable" chars, ≥1 char before it. */
const RELATIVE_EXT_RE = /\.[A-Za-z0-9_-]{1,10}$/;

/** @param {string} candidate */
function looksLikeRelativePath(candidate) {
  const slash = candidate.indexOf("/");
  if (slash <= 0) return false;
  const firstSeg = candidate.slice(0, slash);
  if (firstSeg.includes(":")) return false;
  const lastSeg = candidate.slice(candidate.lastIndexOf("/") + 1);
  const m = RELATIVE_EXT_RE.exec(lastSeg);
  return m !== null && lastSeg.length > m[0].length;
}

/** @param {string} candidate @param {string | null} cwd */
function resolveRelativePath(candidate, cwd) {
  if (typeof cwd !== "string" || cwd === "" || cwd === "/") return null;
  if (!looksLikeRelativePath(candidate)) return null;
  const base = cwd.endsWith("/") ? cwd.slice(0, -1) : cwd;
  return base === "" || base === "/" ? null : `${base}/${candidate}`;
}

/** @param {string} path @param {PathScope} scope */
function isClickable(path, scope) {
  if (!validatePreviewPath(path)) return false;
  if (scope.uploads === true && path.includes(PREVIEW_UPLOADS_MARKER)) return true;
  const cwd = scope.cwd;
  if (typeof cwd !== "string" || cwd === "" || cwd === "/") return false;
  const base = cwd.endsWith("/") ? cwd.slice(0, -1) : cwd;
  return base !== "" && base !== "/" && path.startsWith(`${base}/`);
}

/** @param {string} raw */
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
 * @param {string} text @param {PathScope | null | undefined} scope
 * @returns {PathSegment[]}
 */
export function findPathRefsRef(text, scope) {
  if (typeof text !== "string" || text === "" || scope === null || scope === undefined) {
    return [{ kind: "text", text: typeof text === "string" ? text : "" }];
  }
  /** @type {PathSegment[]} */
  const segments = [];
  let refs = 0;
  let textStart = 0;
  let i = 0;
  const n = text.length;

  const cwd = scope.cwd;
  const cwdPrefix =
    typeof cwd === "string" && cwd !== "" && cwd !== "/" ? `${cwd.endsWith("/") ? cwd.slice(0, -1) : cwd}/` : null;
  const uploads = scope.uploads === true;
  let markerNext = -2; // -2 = not computed yet; else first marker occurrence >= the last query

  let spanEnd = -1; // first terminator >= the run's first start (n when none)
  let spanStrippedEnd = -1; // spanEnd minus the trailing `. : ! ?` run (with the >1 guard)
  let spanLineColStart = -1; // absolute start of the `:line[:col]` tail match, -1 when none
  /** @type {number | undefined} */
  let spanLine;
  /** @type {number | undefined} */
  let spanCol;
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
