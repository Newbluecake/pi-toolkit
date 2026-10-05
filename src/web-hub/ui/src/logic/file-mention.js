/**
 * Web composer @文件补全 pure helpers (file-mention — the TUI's `@` cwd-file completion, web
 * edition). No DOM, no I/O: every function here runs unchanged under vitest (node) and in the
 * browser, same discipline as `./mention.js`/`./control.js`.
 *
 * Two halves:
 * - COMPLETION helpers — `buildFileSearchUrl` (the `GET /api/files/search` query string) and
 *   `parseFileSearchResults` (wire → panel rows, defensively). The fetch itself lives in
 *   `Composer.vue` (silent-degrade on any failure: the panel falls back to the sub-agent zone).
 * - SEND-TIME EXPANSION — `findFileMentionTokens` detects `@<absolute path>` tokens (line
 *   start or after whitespace, segment-aligned under the session cwd — the same scope rule
 *   `@logic/preview.js`'s `isClickable` uses), `expandPromptWithFiles` appends an
 *   attachment-style block quoting each file's fetched TEXT under the shared 48 KiB prompt cap
 *   (`./upload.js`'s `PROMPT_MAX_UTF8_BYTES` — the same cap the upload attachment block obeys;
 *   the hub's `/api/cmd` rejects anything larger). A token whose content was NOT fetched (or
 *   does not fit the remaining budget) stays as plain text in the body and never blocks the
 *   send — the path itself is already model-readable.
 *
 * Token syntax (round-trip contract, mirrored by the hub's search-side skip rule): `@` + an
 * absolute path, starting at line start or after whitespace, ending at the first whitespace /
 * quote / bracket / backtick, with trailing sentence punctuation (`.,;:!?` — also swallowing a
 * `:line[:col]` suffix, exactly like preview's display/path split) stripped while at least one
 * path character remains. Paths containing whitespace/quotes/brackets can never round-trip and
 * are simply not detected.
 *
 * @typedef {{ path: string, rel: string }} FileSearchRow
 * @typedef {{ path: string, text: string }} FileContent
 */

import { PROMPT_MAX_UTF8_BYTES, utf8Len } from "./upload.js";
import { formatAttachmentSize } from "@protocol/upload.ts";

/** Image extensions never fetch content at send (the path text itself is model-readable; the
 * bytes would only burn the preview budget for a blob the prompt cannot use). */
const IMAGE_EXT_RE = /\.(png|jpe?g|gif|webp|bmp|avif|ico)$/i;

export function isImagePath(path) {
  return IMAGE_EXT_RE.test(path);
}

// ---------------------------------------------------------------------------
// completion helpers
// ---------------------------------------------------------------------------

/**
 * The `GET /api/files/search` URL (agentKey/q/limit all `encodeURIComponent`d; `limit` clamped
 * to the hub's 1..50 window).
 * @param {string} base @param {string} agentKey @param {string} q @param {number} limit
 */
export function buildFileSearchUrl(base, agentKey, q, limit) {
  const l = Math.max(1, Math.min(50, Math.floor(limit)));
  return `${base}?agentKey=${encodeURIComponent(agentKey)}&q=${encodeURIComponent(q)}&limit=${l}`;
}

/**
 * Wire body → panel rows: `{ ok: true, results: [{path, rel}] }` (anything else ⇒ `[]` —
 * silent degrade, never a throw). Duplicates and non-`/`-rooted paths are dropped.
 * @param {unknown} body @returns {FileSearchRow[]}
 */
export function parseFileSearchResults(body) {
  if (!body || typeof body !== "object" || body.ok !== true || !Array.isArray(body.results)) return [];
  /** @type {FileSearchRow[]} */
  const out = [];
  const seen = new Set();
  for (const r of body.results) {
    if (!r || typeof r !== "object") continue;
    const path = /** @type {{ path?: unknown }} */ (r).path;
    const rel = /** @type {{ rel?: unknown }} */ (r).rel;
    if (typeof path !== "string" || !path.startsWith("/") || path.includes("\n")) continue;
    if (typeof rel !== "string") continue;
    if (seen.has(path)) continue;
    seen.add(path);
    out.push({ path, rel });
  }
  return out;
}

// ---------------------------------------------------------------------------
// send-time token detection
// ---------------------------------------------------------------------------

const TERMINATOR_RE = /[\s"'`()[\]{}<>]/;
const TRAILING_PUNCT_RE = /[.,;:!?]+$/;
const LINE_COL_RE = /:\d+(?::\d+)?$/;

/**
 * Detect every `@<absolute path>` token in `text` (line start or after whitespace; must be
 * segment-aligned under `cwd` — never `/`). Duplicates collapse to the first occurrence.
 * `text` is never modified by detection.
 * @param {unknown} text @param {unknown} cwd
 * @returns {{ path: string, start: number, end: number }[]}
 */
export function findFileMentionTokens(text, cwd) {
  if (typeof text !== "string" || text === "") return [];
  if (typeof cwd !== "string" || cwd === "" || cwd === "/") return [];
  const base = cwd.endsWith("/") ? cwd.slice(0, -1) : cwd;
  if (base === "" || base === "/") return [];
  const prefix = `${base}/`;
  /** @type {{ path: string, start: number, end: number }[]} */
  const out = [];
  const seen = new Set();
  for (let i = 0; i < text.length; i++) {
    if (text[i] !== "@") continue;
    if (i > 0 && !/\s/.test(text[i - 1] ?? "")) continue; // line start or after whitespace
    if (text[i + 1] !== "/") continue; // absolute paths only
    let end = i + 2;
    while (end < text.length && !TERMINATOR_RE.test(text[end] ?? "")) end++;
    const stripped = text.slice(i + 1, end).replace(TRAILING_PUNCT_RE, "");
    if (stripped === "") continue;
    // a `:line[:col]` suffix is display-only (same split as preview's findPathRefs)
    const withoutLine = stripped.replace(LINE_COL_RE, "");
    const path = withoutLine === "" ? stripped : withoutLine;
    if (!path.startsWith(prefix)) continue; // segment-aligned under the session cwd
    if (seen.has(path)) continue;
    seen.add(path);
    out.push({ path, start: i + 1, end });
  }
  return out;
}

// ---------------------------------------------------------------------------
// send-time expansion (the attachment-style block)
// ---------------------------------------------------------------------------

/** A truncated slice smaller than this is useless noise — such a file is skipped entirely. */
const INLINE_FLOOR_BYTES = 256;

/** At most this many files inline per message (each ≤ the shared 48 KiB cap anyway). */
export const FILE_MENTION_MAX_FILES = 8;

/**
 * Truncate `s` to at most `maxBytes` UTF-8 bytes on a code-point boundary (lone surrogates
 * count as 3 bytes per WHATWG, same as `utf8Len`).
 * @param {string} s @param {number} maxBytes
 */
export function utf8Truncate(s, maxBytes) {
  if (utf8Len(s) <= maxBytes) return s;
  const bytes = new TextEncoder().encode(s);
  if (bytes.length <= maxBytes) return s;
  // Walk back from the cut to a safe boundary: a split code point would decode as U+FFFD.
  let cut = maxBytes;
  while (cut > 0 && (bytes[cut] & 0xc0) === 0x80) cut--;
  return new TextDecoder().decode(bytes.subarray(0, cut));
}

/** `--- <path> (<label>) ---\n` — the per-file section head, bytes precomputed for budgeting. */
function sepBytesOf(path, label) {
  return utf8Len(`--- ${path} (${label}) ---\n`);
}

const HEADER_PREFIX = "[web-hub file references] The user referenced ";
const HEADER_SUFFIX =
  " local file(s) from the session working directory; their contents are quoted verbatim below (paths are readable as-is):";

/**
 * Append the file-reference block (the upload attachment block's fixed-English sibling — a
 * DISTINCT header so the transcript's upload-block parser `parseAttachmentBlock` never
 * misreads it) quoting each file's fetched text verbatim under the shared 48 KiB prompt cap.
 *
 * Budget: body bytes first, then the header, then per-file separator+content (a file that fits
 * whole is included regardless of size; a file needing truncation keeps a slice only if it is
 * at least `INLINE_FLOOR_BYTES`, minus the bytes the longer truncated label costs — the label
 * delta is shaved off the content so the total is exact). A file that no longer fits is
 * skipped: its token stays in the body untouched and `skipped` reports it (the caller
 * console-warns; no hint text ever enters the prompt). `fetched` is consumed in first-occurrence
 * order, deduped, capped at `FILE_MENTION_MAX_FILES`; a path containing a newline is skipped
 * (block-shape defense, the same rule as upload's `formatAttachmentBlock`).
 *
 * @param {string} text the prompt body (left verbatim)
 * @param {string} cwd the session cwd (token scope)
 * @param {ReadonlyArray<{ path: string, text: string }>} fetched successfully fetched contents
 * @returns {{ text: string, attached: string[], skipped: string[] }}
 */
export function expandPromptWithFiles(text, cwd, fetched) {
  const tokens = findFileMentionTokens(text, cwd);
  if (tokens.length === 0) return { text, attached: [], skipped: [] };
  const byPath = new Map();
  for (const f of Array.isArray(fetched) ? fetched : []) {
    if (f && typeof f.path === "string" && typeof f.text === "string" && !byPath.has(f.path)) byPath.set(f.path, f);
  }
  /** @type {string[]} */
  const attached = [];
  /** @type {string[]} */
  const skipped = [];
  /** @type {{ path: string, label: string, content: string }[]} */
  const sections = [];
  // Exact byte ledger of the composed prompt: body + "\n\n" + header + "\n\n" + sections
  // joined by "\n" (the header is reserved with the widest count — one digit, ≤ 9 sections).
  let budget = PROMPT_MAX_UTF8_BYTES - utf8Len(text) - 2 - (utf8Len(HEADER_PREFIX) + 1 + utf8Len(HEADER_SUFFIX)) - 2;

  for (const t of tokens) {
    const f = byPath.get(t.path);
    if (f === undefined) {
      skipped.push(t.path); // never fetched (failed/image/binary/over-count) — token stays
      continue;
    }
    if (sections.length >= FILE_MENTION_MAX_FILES || t.path.includes("\n")) {
      skipped.push(t.path);
      continue;
    }
    const join = sections.length > 0 ? 1 : 0; // the "\n" before every section after the first
    const sizeFull = formatAttachmentSize(utf8Len(f.text));
    const sepFull = sepBytesOf(t.path, sizeFull);
    const wholeCost = sepFull + utf8Len(f.text) + join;
    if (wholeCost <= budget) {
      // fits whole — always included, no floor applies
      sections.push({ path: t.path, label: sizeFull, content: f.text });
      budget -= wholeCost;
      attached.push(t.path);
      continue;
    }
    // needs truncation: settle (label, content) EXACTLY inside the budget — the truncated
    // label ("X of Y") is longer than `sizeFull`, and a unit flip can shift it again, so the
    // loop shaves the overshoot (bounded: content shrinks monotonically).
    let content = utf8Truncate(f.text, budget - sepFull - join);
    let label = `${formatAttachmentSize(utf8Len(content))} of ${sizeFull}`;
    let cost = sepBytesOf(t.path, label) + utf8Len(content) + join;
    while (cost > budget && utf8Len(content) > INLINE_FLOOR_BYTES) {
      content = utf8Truncate(content, utf8Len(content) - (cost - budget));
      label = `${formatAttachmentSize(utf8Len(content))} of ${sizeFull}`;
      cost = sepBytesOf(t.path, label) + utf8Len(content) + join;
    }
    if (cost > budget || utf8Len(content) < INLINE_FLOOR_BYTES) {
      skipped.push(t.path); // a slice this small is noise — the path alone is more useful
      continue;
    }
    sections.push({ path: t.path, label, content });
    budget -= cost;
    attached.push(t.path);
  }

  if (sections.length === 0) return { text, attached: [], skipped };
  const header = `${HEADER_PREFIX}${sections.length}${HEADER_SUFFIX}`;
  const block = `${header}\n\n${sections.map((s) => `--- ${s.path} (${s.label}) ---\n${s.content}`).join("\n")}`;
  return { text: `${text}\n\n${block}`, attached, skipped };
}
