/**
 * web-hub port proxy — pure UI logic (web-hub-proxy plan v2 §8, package X2). No DOM, no
 * timers; the one I/O-shaped helper (`proxyFetch`) only READS an already-issued response, same
 * discipline as `./preview.js`. Runs unchanged under vitest (node) and in the browser.
 *
 * - `proxyScopeOf(caps, transport, mode?)` — `null` (no cap / no transport method ⇒ the UI is
 *   byte-identical to a hub without the feature) or `{ lan }`.
 * - `findProxyUrlRefs(text)` / `normalizeProxyHref(href)` / `isProxyableHref(href)` — HTTP
 *   endpoints on loopback / private / cgnat / ULA IP literals or `localhost` (link-preview §5).
 *   Scheme-less needs a port; port-less HTTP gets :80. Hostnames are never auto-recognised.
 *   Segments always concatenate back to the exact input.
 * - `parseProxyOpen/List/Stop` — the contract gates for the three hub responses.
 * - `proxyErrorKey(err)` — i18n key of the user-facing copy for an error outcome.
 * - `proxyFetch(send, parse, maxBytes, signal)` — the shared response reader of both clients.
 *
 * Runtime imports use the literal `.ts` extension (see `./contract.js`).
 */
import {
  PROXY_ENTER_PATH,
  PROXY_INSTANCE_ID_RE,
  PROXY_LIMIT_REASONS,
  PROXY_TARGET_CLASSES,
  PROXY_UNAVAILABLE_EXTRA_REASONS,
} from "@protocol/proxy.ts";
import { PROXY_FRAME_HUB_CAP, PROXY_HUB_CAP, PROXY_LAN_HUB_CAP } from "@protocol/version.ts";
import { PROXY_COOKIE_CONFLICT, PROXY_DENY_REASON_SET } from "./contract.js";

/** Response body caps (the hub's bodies are far smaller; these bound a hostile/broken peer). */
export const PROXY_OPEN_BODY_MAX_BYTES = 8 * 1024;
export const PROXY_LIST_BODY_MAX_BYTES = 64 * 1024;

/**
 * §8: `proxy.v1` for token auth, `proxy.lan.v1` for password auth. Without `mode`, whichever cap
 * is present decides (`proxy.v1` wins).
 * @param {unknown} caps @param {unknown} transport @param {"token" | "password" | undefined} [mode]
 * @returns {{ lan: boolean } | null}
 */
export function proxyScopeOf(caps, transport, mode) {
  if (transport === null || typeof transport !== "object") return null;
  if (typeof (/** @type {{ proxy?: unknown }} */ (transport).proxy) !== "object") return null;
  if (/** @type {{ proxy?: unknown }} */ (transport).proxy === null) return null;
  const list = Array.isArray(caps) ? caps : [];
  const hasToken = list.includes(PROXY_HUB_CAP);
  const hasLan = list.includes(PROXY_LAN_HUB_CAP);
  if (mode === "password") return hasLan ? { lan: true } : null;
  if (mode === "token") return hasToken ? { lan: false } : null;
  if (hasToken) return { lan: false };
  return hasLan ? { lan: true } : null;
}

/**
 * link-preview §4.1: framing is additive to an already-admitted proxy scope. No scope stays
 * inert; old hubs keep the new-tab flow. Return the SAME scope (no mutation or widening).
 * @param {unknown} caps @param {{ lan: boolean } | null | undefined} scope
 * @returns {{ lan: boolean } | null}
 */
export function proxyFrameScopeOf(caps, scope) {
  return scope != null && Array.isArray(caps) && caps.includes(PROXY_FRAME_HUB_CAP) ? scope : null;
}

// ---------------------------------------------------------------------------
// URL recognition (link-preview plan §5)
// ---------------------------------------------------------------------------

const OCTET = String.raw`(?:0|[1-9]\d{0,2})`;
const IPV4 = String.raw`${OCTET}(?:\.${OCTET}){3}`;
// Bracketed candidates are deliberately broad: validation consumes an invalid IPv6 candidate
// as a whole, rather than re-matching a local IPv4 substring inside it.
const HOST = String.raw`(?:[Ll][Oo][Cc][Aa][Ll][Hh][Oo][Ss][Tt]|${IPV4}|\[[^\]\s<>"'\x60]*\])`;
const URL_SOURCE = String.raw`([Hh][Tt][Tt][Pp]://)?(${HOST})(?::(\d+))?([/?#][^\s<>"'\x60]*)?`;
/** Trailing ASCII/CJK sentence punctuation is never part of the ref. */
const TRAIL_RE = /[.,;:!?)\]}>*。，；：！？）」』】》、]+$/;
const SENTENCE_START_RE = /^[.,;:!?)\]}>*。，；：！？）」』】》、]/;
const NON_HTTP_PORTS = new Set([21, 22, 23, 25, 53, 110, 143, 443, 445, 993, 995, 3306, 5432, 6379, 11211, 27017]);

/** Strict dotted quad, including no leading zeros. @param {string} text @returns {number[] | null} */
function parseIPv4(text) {
  if (!new RegExp(`^${IPV4}$`).test(text)) return null;
  const octets = text.split(".").map(Number);
  return octets.every((n) => n <= 255) ? octets : null;
}

/**
 * Full RFC 4291 textual syntax (not an address-class test). At most one ::, exactly eight
 * words without compression or at least one omitted word with it. A trailing strict dotted
 * quad counts as two words. No brackets, zones, whitespace or non-hex words.
 * @param {string} text @returns {Uint8Array | null}
 */
export function parseIPv6(text) {
  if (typeof text !== "string" || text === "" || text.length > 45 || /[^0-9a-f:.]/i.test(text)) return null;
  let hex = text;
  if (hex.includes(".")) {
    const colon = hex.lastIndexOf(":");
    if (colon < 0) return null;
    const octets = parseIPv4(hex.slice(colon + 1));
    if (octets === null) return null;
    const [a, b, c, d] = /** @type {[number, number, number, number]} */ (octets);
    hex = `${hex.slice(0, colon + 1)}${((a << 8) | b).toString(16)}:${((c << 8) | d).toString(16)}`;
  }
  const halves = hex.split("::");
  if (halves.length > 2) return null;
  const left = halves[0] === "" ? [] : /** @type {string} */ (halves[0]).split(":");
  const right = halves.length === 1 || halves[1] === "" ? [] : /** @type {string} */ (halves[1]).split(":");
  if (![...left, ...right].every((word) => /^[0-9a-f]{1,4}$/i.test(word))) return null;
  const count = left.length + right.length;
  if (halves.length === 1 ? count !== 8 : count > 7) return null;
  const words = [...left, ...Array(8 - count).fill("0"), ...right];
  const bytes = new Uint8Array(16);
  words.forEach((word, i) => {
    const n = Number.parseInt(word, 16);
    bytes[i * 2] = n >>> 8;
    bytes[i * 2 + 1] = n & 255;
  });
  return bytes;
}

/**
 * Allowed-class test (no DNS): IP literals + localhost only. IPv4-mapped IPv6 is deliberately
 * NOT recognized, even when the hub would allow it. Classify canonical bytes, not spelling.
 * @param {string} host @returns {boolean}
 */
function hostProxyable(host) {
  if (host.toLowerCase() === "localhost") return true;
  if (host.startsWith("[")) {
    const b = parseIPv6(host.slice(1, -1));
    if (b === null) return false;
    if (b.slice(0, 15).every((n) => n === 0) && b[15] === 1) return true;
    if (/** @type {number} */ (b[0] & 0xfe) !== 0xfc) return false;
    return !(b[0] === 0xfd && b[1] === 0 && b[2] === 0x0e && b[3] === 0xc2);
  }
  const octets = parseIPv4(host);
  if (octets === null) return false;
  const [a, b] = /** @type {[number, number]} */ (octets);
  if (a === 127 || a === 10) return true;
  if (a === 172) return b >= 16 && b <= 31;
  if (a === 192) return b === 168;
  if (a === 100) return b >= 64 && b <= 127 && b !== 100; // cgnat minus Alibaba metadata 100.100/16
  return false;
}

/**
 * @typedef {{ kind: "text", text: string } | { kind: "ref", text: string, href: string }} ProxySegment
 */

/**
 * Split into plain / proxy refs (concatenation === input). `text` is always raw; `href` always
 * has a scheme and port. A rejected candidate consumes its match — no inner retry/degrade.
 * @param {string} text @returns {ProxySegment[]}
 */
export function findProxyUrlRefs(text) {
  if (typeof text !== "string" || text === "") return [];
  /** @type {ProxySegment[]} */
  const out = [];
  const re = new RegExp(URL_SOURCE, "g");
  let last = 0;
  for (let m = re.exec(text); m !== null; m = re.exec(text)) {
    const start = m.index;
    const prev = start === 0 ? "" : /** @type {string} */ (text[start - 1]);
    if (prev !== "" && /[A-Za-z0-9_/.:@\\-]/.test(prev)) continue;
    const scheme = m[1] ?? "";
    const host = /** @type {string} */ (m[2]);
    const port = m[3];
    const rawTail = m[4] ?? "";
    const authorityEnd = start + m[0].length - rawTail.length;
    const suffix = text.slice(authorityEnd);
    if (port === undefined) {
      // F2 only: a failed F1 must never degrade to port-less HTTP, even ': ok'.
      if (scheme === "" || suffix.startsWith(":")) continue;
    } else {
      if (!/^[1-9]\d{0,4}$/.test(port) || Number(port) > 65535) continue;
      if (scheme === "" && (Number(port) < 10 || NON_HTTP_PORTS.has(Number(port)))) continue;
    }
    if (suffix !== "" && !/^[\s/?#]/.test(suffix)) {
      if (!SENTENCE_START_RE.test(suffix) || /^[.:][A-Za-z0-9_]/.test(suffix)) continue;
    }
    if (!hostProxyable(host)) continue;
    const tail = rawTail.replace(TRAIL_RE, "");
    const raw = m[0].slice(0, m[0].length - rawTail.length) + tail;
    const href = `${scheme || "http://"}${host}:${port ?? "80"}${tail}`;
    if (start > last) out.push({ kind: "text", text: text.slice(last, start) });
    out.push({ kind: "ref", text: raw, href });
    last = start + raw.length;
    re.lastIndex = last;
  }
  if (out.length === 0) return [{ kind: "text", text }];
  if (last < text.length) out.push({ kind: "text", text: text.slice(last) });
  return out;
}

/**
 * The single whole-ref normalization gate (link-preview §4.2/§5). Preserve the existing
 * isProxyableHref input/length limits; do not trim or swallow surrounding sentence punctuation.
 * @param {unknown} href @returns {string | null}
 */
export function normalizeProxyHref(href) {
  if (typeof href !== "string" || href === "" || href.length > 2048) return null;
  const segs = findProxyUrlRefs(href);
  return segs.length === 1 && segs[0]?.kind === "ref" ? segs[0].href : null;
}

/** `true` iff the WHOLE string is one proxy ref. @param {unknown} href @returns {boolean} */
export function isProxyableHref(href) {
  return normalizeProxyHref(href) !== null;
}

// ---------------------------------------------------------------------------
// Response gates
// ---------------------------------------------------------------------------

/** @param {unknown} v @returns {v is Record<string, unknown>} */
function isObj(v) {
  return v !== null && typeof v === "object" && !Array.isArray(v);
}

/** @param {unknown} t */
function parseTarget(t) {
  if (!isObj(t)) return null;
  const { host, port, cls } = t;
  if (typeof host !== "string" || host === "" || host.length > 255) return null;
  if (typeof port !== "number" || !Number.isInteger(port) || port < 1 || port > 65535) return null;
  if (typeof cls !== "string" || !PROXY_TARGET_CLASSES.includes(/** @type {any} */ (cls))) return null;
  return { host, port, cls };
}

/** @param {unknown} origin */
function originOk(origin) {
  return typeof origin === "string" && /^http:\/\/[^/?#\s]+$/.test(origin) && origin.length <= 300;
}

/**
 * `POST /api/proxy/open` 200 body. The enter URL must be exactly `<origin>/__pwh_proxy__/enter?c=…`.
 * @param {unknown} raw @returns {any}
 */
export function parseProxyOpen(raw) {
  if (!isObj(raw)) return null;
  const { instanceId, origin, enterUrl } = raw;
  if (typeof instanceId !== "string" || !PROXY_INSTANCE_ID_RE.test(instanceId)) return null;
  if (!originOk(origin) || typeof enterUrl !== "string") return null;
  if (!enterUrl.startsWith(`${origin}${PROXY_ENTER_PATH}?c=`) || enterUrl.length > 600) return null;
  const target = parseTarget(raw.target);
  if (target === null) return null;
  return { instanceId, origin, enterUrl, target };
}

/**
 * `GET /api/proxy` 200 body.
 * @param {unknown} raw @returns {any}
 */
export function parseProxyList(raw) {
  if (!isObj(raw) || !Array.isArray(raw.items) || raw.items.length > 64) return null;
  const items = [];
  for (const it of raw.items) {
    if (!isObj(it)) return null;
    const target = parseTarget(it.target);
    if (target === null || typeof it.instanceId !== "string" || !PROXY_INSTANCE_ID_RE.test(it.instanceId)) return null;
    if (!originOk(it.origin) || typeof it.createdAt !== "number" || typeof it.mine !== "boolean") return null;
    items.push({ instanceId: it.instanceId, target, origin: it.origin, createdAt: it.createdAt, mine: it.mine });
  }
  const p = raw.policy;
  if (!isObj(p) || typeof p.maxProxies !== "number" || typeof p.lan !== "boolean") return null;
  const pr = p.portRange;
  if (!Array.isArray(pr) || pr.length !== 2 || typeof pr[0] !== "number" || typeof pr[1] !== "number") return null;
  return { items, policy: { maxProxies: p.maxProxies, portRange: [pr[0], pr[1]], lan: p.lan } };
}

/** `POST /api/proxy/stop` 200 body. @param {unknown} raw @returns {any} */
export function parseProxyStop(raw) {
  return isObj(raw) && raw.ok === true ? { ok: true } : null;
}

/**
 * Defence in depth before navigating a tab: only `http://` + the reserved enter path.
 * @param {unknown} url @returns {boolean}
 */
export function isSafeEnterUrl(url) {
  return typeof url === "string" && /^http:\/\/[^/?#\s]+\/__pwh_proxy__\/enter\?c=[A-Za-z0-9_-]{1,128}$/.test(url);
}

// ---------------------------------------------------------------------------
// error copy
// ---------------------------------------------------------------------------

const DENY = new Set(PROXY_DENY_REASON_SET);
const EXTRA = new Set(PROXY_UNAVAILABLE_EXTRA_REASONS);
const LIMITS = new Set(PROXY_LIMIT_REASONS);

/**
 * i18n key (`proxy.*`) for an error outcome `{ status, error, reason? }`.
 * @param {{ status?: number, error?: string, reason?: string } | null | undefined} e
 * @returns {string}
 */
export function proxyErrorKey(e) {
  const error = e?.error ?? "";
  const reason = e?.reason;
  if (error === "E_PROXY_DENIED" || error === "E_PROXY_UNAVAILABLE") {
    if (typeof reason === "string" && (DENY.has(/** @type {any} */ (reason)) || EXTRA.has(/** @type {any} */ (reason))))
      return `proxy.reason.${reason}`;
    return error === "E_PROXY_DENIED" ? "proxy.reason.denied" : "proxy.reason.unavailable";
  }
  if (error === "E_LIMIT") {
    return typeof reason === "string" && LIMITS.has(/** @type {any} */ (reason))
      ? `proxy.limit.${reason}`
      : "proxy.limit.proxies";
  }
  if (error === "E_RATE") return "proxy.rate";
  if (error === "E_AUTH") return reason === PROXY_COOKIE_CONFLICT ? "proxy.cookieConflict" : "proxy.auth";
  if (error === "E_NOT_FOUND" || e?.status === 404) return "proxy.notFound";
  if (error === "E_NETWORK" || error === "E_DEADLINE") return "proxy.network";
  if (error === "E_ABORT") return "proxy.aborted";
  return "proxy.error";
}

// ---------------------------------------------------------------------------
// shared response reader
// ---------------------------------------------------------------------------

/**
 * Await `send()` (a function that issues ONE request and resolves a fetch-like response) and
 * fold it into `{ ok: true, ...parsed } | { ok: false, status, error, reason?, retryAfterS? }`.
 * @param {() => Promise<any>} send @param {(raw: unknown) => any} parse @param {number} maxBytes
 * @param {any} [signal]
 * @returns {Promise<any>}
 */
export async function proxyFetch(send, parse, maxBytes, signal) {
  if (signal && signal.aborted === true) return { ok: false, status: 0, error: "E_ABORT" };
  /** @type {any} */
  let r;
  try {
    r = await send();
  } catch (e) {
    const msg = e instanceof Error ? e.message : "";
    if (signal && signal.aborted === true) return { ok: false, status: 0, error: "E_ABORT" };
    return { ok: false, status: 0, error: msg === "E_ABORT" || msg === "E_DEADLINE" ? msg : "E_NETWORK" };
  }
  /** @type {any} */
  let body;
  try {
    if (typeof r.arrayBuffer === "function") {
      const buf = await r.arrayBuffer();
      if (buf && typeof buf.byteLength === "number" && buf.byteLength > maxBytes)
        return { ok: false, status: r.ok ? 0 : r.status, error: "E_BAD_RESPONSE" };
      body = JSON.parse(new TextDecoder().decode(buf));
    } else {
      body = await r.json();
    }
  } catch {
    body = undefined;
  }
  if (!r.ok) {
    const b = isObj(body) ? body : {};
    /** @type {any} */
    const out = {
      ok: false,
      status: r.status,
      error: typeof b.error === "string" ? b.error : r.status === 401 ? "E_AUTH" : `HTTP ${r.status}`,
    };
    if (typeof b.reason === "string") out.reason = b.reason;
    const raw = typeof r.headers?.get === "function" ? r.headers.get("Retry-After") : null;
    const s = raw === null || raw === undefined ? NaN : Number(raw);
    if (Number.isFinite(s) && s >= 0) out.retryAfterS = s;
    return out;
  }
  const value = body === undefined ? null : parse(body);
  if (value === null) return { ok: false, status: 0, error: "E_BAD_RESPONSE" };
  return { ...value, ok: true };
}
