/**
 * web-hub HTML preview — strict `/pv/<cap>/<rel>` path handling (web-hub-html-preview plan v2
 * §2.3-②/§2.6, P1a). PURE: no fs, no pi, no clock.
 *
 * `splitPvRest` separates the capability from the raw (percent-encoded) rel remainder the
 * dispatch hands `servePv`; `parsePvRelPath` turns the raw rel into a decoded, joined relative
 * path — or a precise rejection (⇒ 400). The parser is deliberately STRICTER than any URL
 * normalizer: it never "fixes" anything, it only accepts canonical, traversal-free spellings.
 * `redactLogUrl`/`errCode` are the §2.6 log-redaction helpers (a `/pv/<cap>/…` URL must never
 * reach a log line — the cap is the credential).
 */

import { PV_CAP_RE, PV_REL_MAX_BYTES, PV_REL_MAX_SEGMENTS, PV_SEGMENT_MAX_BYTES } from "../../protocol/preview-html.js";

export type PvPathReject =
  | "empty"
  | "raw-control"
  | "encoded-separator"
  | "backslash"
  | "empty-segment"
  | "too-many-segments"
  | "bad-encoding"
  | "dot-segment"
  | "segment-char"
  | "segment-too-long"
  | "path-too-long";

export type PvRelResult =
  | { readonly ok: true; readonly rel: string; readonly segments: readonly string[] }
  | { readonly ok: false; readonly reason: PvPathReject };

/** `%2f`/`%5c`/`%00` in ANY case: an encoded separator or NUL is never legitimate in a
 * relative asset URL (browsers keep `/` literal as the separator). */
const ENCODED_FORBIDDEN_RE = /%(?:2f|5c|00)/i;

function hasRawControl(s: string): boolean {
  for (let i = 0; i < s.length; i += 1) {
    const c = s.charCodeAt(i);
    if (c <= 0x20 || c === 0x7f) return true;
  }
  return false;
}

function hasForbiddenDecodedChar(s: string): boolean {
  for (let i = 0; i < s.length; i += 1) {
    const c = s.charCodeAt(i);
    if (c < 0x20 || c === 0x7f || c === 0x2f /* / */ || c === 0x5c /* \ */) return true;
  }
  return false;
}

/**
 * §2.3-②. `rawRel` is the percent-encoded remainder AFTER the cap (no leading slash). Never
 * throws. On success `rel` is the decoded segments joined with `/` (never starts with `/`,
 * never contains `..`/empty segments/backslash/NUL/control bytes).
 */
export function parsePvRelPath(rawRel: string): PvRelResult {
  if (typeof rawRel !== "string" || rawRel.length === 0) return { ok: false, reason: "empty" };
  if (hasRawControl(rawRel)) return { ok: false, reason: "raw-control" };
  if (rawRel.includes("\\")) return { ok: false, reason: "backslash" };
  if (ENCODED_FORBIDDEN_RE.test(rawRel)) return { ok: false, reason: "encoded-separator" };
  const rawSegments = rawRel.split("/");
  if (rawSegments.some((s) => s.length === 0)) return { ok: false, reason: "empty-segment" };
  if (rawSegments.length > PV_REL_MAX_SEGMENTS) return { ok: false, reason: "too-many-segments" };
  const segments: string[] = [];
  for (const raw of rawSegments) {
    let seg: string;
    try {
      seg = decodeURIComponent(raw); // `%c0%ae`, `%zz`, lone `%` ⇒ URIError
    } catch {
      return { ok: false, reason: "bad-encoding" };
    }
    if (seg === "." || seg === "..") return { ok: false, reason: "dot-segment" };
    if (hasForbiddenDecodedChar(seg)) return { ok: false, reason: "segment-char" };
    if (Buffer.byteLength(seg, "utf8") > PV_SEGMENT_MAX_BYTES) return { ok: false, reason: "segment-too-long" };
    segments.push(seg);
  }
  const rel = segments.join("/");
  if (Buffer.byteLength(rel, "utf8") > PV_REL_MAX_BYTES) return { ok: false, reason: "path-too-long" };
  return { ok: true, rel, segments };
}

/**
 * Split `servePv`'s raw `rest` (`"<cap>/<rel>"`) into the cap and the raw rel. `undefined` ⇒
 * the cap fails `PV_CAP_RE` (⇒ constant 404, no oracle). `rawRel` is `""` when there is no
 * slash at all (a bare `/pv/<cap>`), which `parsePvRelPath` then rejects as `empty`.
 */
export function splitPvRest(rest: string): { cap: string; rawRel: string } | undefined {
  if (typeof rest !== "string") return undefined;
  const slash = rest.indexOf("/");
  const cap = slash === -1 ? rest : rest.slice(0, slash);
  if (!PV_CAP_RE.test(cap)) return undefined;
  return { cap, rawRel: slash === -1 ? "" : rest.slice(slash + 1) };
}

/** `/pvw/<cap>` carries ONLY a cap: undefined unless the whole remainder is exactly one. */
export function parsePvwRest(rest: string): string | undefined {
  return typeof rest === "string" && PV_CAP_RE.test(rest) ? rest : undefined;
}

// ---------------------------------------------------------------------------
// §2.6 log redaction
// ---------------------------------------------------------------------------

const ABSOLUTE_FORM_RE = /^[A-Za-z][A-Za-z0-9+.-]*:\/\/[^/]*/;

function pvPrefixOf(url: string): "/pv/" | "/pvw/" | undefined {
  const path = url.replace(ABSOLUTE_FORM_RE, "");
  if (path.startsWith("/pvw/") || path === "/pvw") return "/pvw/";
  if (path.startsWith("/pv/") || path === "/pv") return "/pv/";
  return undefined;
}

/** True for any URL that addresses `/pv…` / `/pvw…` (the cap is in it). */
export function isPvLogUrl(url: string): boolean {
  return typeof url === "string" && pvPrefixOf(url) !== undefined;
}

/** `/pv/…` ⇒ `/pv/[redacted]`, `/pvw/…` ⇒ `/pvw/[redacted]`; every other URL verbatim. */
export function redactLogUrl(url: string): string {
  if (typeof url !== "string") return String(url);
  const p = pvPrefixOf(url);
  return p === undefined ? url : `${p}[redacted]`;
}

/** `code ?? name` — fs error MESSAGES carry paths, so `/pv` fallback logs carry this instead. */
export function errCode(err: unknown): string {
  if (typeof err === "object" && err !== null) {
    const code = (err as { code?: unknown }).code;
    if (typeof code === "string" && code.length > 0) return code;
    const name = (err as { name?: unknown }).name;
    if (typeof name === "string" && name.length > 0) return name;
  }
  return typeof err;
}
