/**
 * LAN host-name classification, canonicalization and status types (plan §2.1,
 * §2.2, §9.2 — frozen interface, S1-W1 接口包).
 *
 * `classifyHostToken` / `canonicalHostKey` / `canonicalOrigin` / `parseOrigin`
 * are pure functions with no I/O: every caller (settings validation, `hub/
 * main.ts`'s `parseHubLanConfig`, the request pipeline's `buildContext`, the
 * `/webhub status` text) shares the same classification so a host can never be
 * accepted by one layer and rejected by another.
 *
 * `LanStatus` / `LanOffReason` live here (not `hub/ports.ts`) so that
 * `protocol/messages.ts`'s `lan_res` payload (`{ info: { lan: LanStatus } }`)
 * can reference them without a `hub/ports.ts` → `protocol/messages.ts` →
 * `hub/ports.ts` import cycle (`hub/ports.ts` already imports several
 * `protocol/messages.ts` types); `hub/ports.ts` re-exports both names so W1's
 * frozen surface (§11 落地清单 A) is still reachable from `hub/ports.ts`.
 */

// ---------------------------------------------------------------------------
// §2.1 host token classification
// ---------------------------------------------------------------------------

/** Single-label names that collide with common TLDs / reserved names (v7: excludes `localhost`, L27). */
export const SINGLE_LABEL_DENYLIST = [
  "local",
  "lan",
  "home",
  "internal",
  "intranet",
  "corp",
  "localdomain",
  "arpa",
  "test",
  "example",
  "invalid",
  "onion",
  "dev",
  "app",
  "io",
  "com",
  "net",
  "org",
] as const;

export type HostTokenKind = "ipv4" | "fqdn" | "single-label" | "dot-local" | "localhost";
export type HostTokenRejectReason = "syntax" | "denylisted" | "ipv6" | "too-long" | "numeric";

export type HostTokenResult =
  { ok: true; kind: HostTokenKind; host: string } | { ok: false; reason: HostTokenRejectReason };

export interface InvalidHostToken {
  token: string;
  reason: HostTokenRejectReason;
}

const LABEL_RE = /^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?$/;
const MAX_HOST_LENGTH = 253;
const MAX_LABEL_LENGTH = 63;

function isIPv4Literal(host: string): boolean {
  const parts = host.split(".");
  if (parts.length !== 4) return false;
  return parts.every((p) => /^\d{1,3}$/.test(p) && Number(p) <= 255);
}

/**
 * Classify a (already-received, not yet lower-cased) host token per §2.1's
 * priority-ordered rules; the first matching rule wins.
 */
export function classifyHostToken(token: string): HostTokenResult {
  const host = token.toLowerCase();
  // ① IPv6 literal (bare, no brackets support here — canonicalHostKey rejects bracket forms outright).
  if (host.includes(":")) return { ok: false, reason: "ipv6" };
  // ② IPv4.
  if (isIPv4Literal(host)) return { ok: true, kind: "ipv4", host };
  const labels = host.split(".");
  // ③ length caps.
  if (host.length > MAX_HOST_LENGTH || labels.some((l) => l.length > MAX_LABEL_LENGTH)) {
    return { ok: false, reason: "too-long" };
  }
  // ④ label syntax.
  if (labels.some((l) => !LABEL_RE.test(l))) return { ok: false, reason: "syntax" };
  // ⑤ localhost (before the denylist / numeric checks — never denylisted, v6 #6).
  if (host === "localhost") return { ok: true, kind: "localhost", host };
  // ⑥ numeric last label (WHATWG URL parses it as a numeric IPv4-like host; Chromium rejects it
  //    before the request ever reaches the server — lan-spike-results.md §5). Cross-checked
  //    against WHATWG's "IPv4 number parser" (URL spec) per-part rules, in the priority WHATWG
  //    itself applies:
  //      1. "0x"/"0X" prefix → hex, R=16. Critically the spec then re-checks "if input
  //         (post-prefix) is empty, return (0, true)" — a BARE "0x"/"0X" with *zero* hex digits
  //         after it is still a valid number (value 0; confirmed empirically:
  //         `new URL("https://0x").host` → "0.0.0.0") — so the hex tail is `[0-9a-f]*`, not `+`.
  //      2. Otherwise a leading "0" → octal, R=8 (numerically only 0-7 digits are valid, but any
  //         all-decimal-digit string like "089" is already caught by rule 3 below as a
  //         conservative superset — over-rejecting a string WHATWG wouldn't actually rewrite is
  //         the safe direction here, not a security gap).
  //      3. Otherwise decimal, R=10 ("123", and octal-looking "017" since it's all digit chars).
  //    A *trailing dot* on any of these ("1.", "0x7f.", "0.") does turn WHATWG's "ends in a
  //    number" check on too, but `String.split(".")` already produces a trailing empty label for
  //    those, which rule ④ (label syntax) above already rejects as `syntax` — no separate
  //    handling needed here (verified: "1."/"0."/"0x." all classify `syntax`, never fall through
  //    to this rule at all). This check must run on the *raw* token (see `parseOrigin`'s header
  //    comment for why feeding it a WHATWG-already-rewritten host would defeat the whole point).
  const lastLabel = labels[labels.length - 1]!;
  if (/^[0-9]+$/.test(lastLabel) || /^0x[0-9a-f]*$/i.test(lastLabel)) return { ok: false, reason: "numeric" };
  // ⑦ single-label denylist.
  if (labels.length === 1 && (SINGLE_LABEL_DENYLIST as readonly string[]).includes(host)) {
    return { ok: false, reason: "denylisted" };
  }
  // ⑧ `<single-label>.local`.
  if (labels.length === 2 && labels[1] === "local") return { ok: true, kind: "dot-local", host };
  // ⑨ other multi-label ⇒ fqdn.
  if (labels.length >= 2) return { ok: true, kind: "fqdn", host };
  // ⑩ other single-label.
  return { ok: true, kind: "single-label", host };
}

// ---------------------------------------------------------------------------
// §2.2 host / origin canonicalization
// ---------------------------------------------------------------------------

function parsePortDecimal(s: string): number | undefined {
  if (!/^[1-9]\d{0,4}$/.test(s)) return undefined; // no leading zero, 1..65535
  const n = Number(s);
  return n >= 1 && n <= 65535 ? n : undefined;
}

function defaultPortFor(scheme: "http" | "https"): number {
  return scheme === "https" ? 443 : 80;
}

/**
 * `"host:port"`, lower-cased, explicit port (default 80/443 filled in per
 * `scheme`). Accepts hosts whose `classifyHostToken` verdict is `ok:true` or
 * `numeric` / `denylisted` (canonicalization is not the allow-list check —
 * those hosts can still be *named*, just not *trusted* elsewhere); rejects
 * `syntax` / `too-long` / `ipv6`, malformed ports (non-decimal, leading zero,
 * out of range) and bracketed IPv6 literals.
 */
export function canonicalHostKey(hostHeader: string | undefined, scheme: "http" | "https"): string | undefined {
  if (hostHeader === undefined) return undefined;
  const raw = hostHeader.trim();
  if (raw === "" || raw.includes("[") || raw.includes("]")) return undefined;
  const firstColon = raw.indexOf(":");
  const lastColon = raw.lastIndexOf(":");
  if (firstColon !== lastColon) return undefined; // bracket-less IPv6-shaped literal
  let hostPart: string;
  let port: number;
  if (firstColon < 0) {
    hostPart = raw;
    port = defaultPortFor(scheme);
  } else {
    hostPart = raw.slice(0, firstColon);
    const parsed = parsePortDecimal(raw.slice(firstColon + 1));
    if (parsed === undefined) return undefined;
    port = parsed;
  }
  if (hostPart === "") return undefined;
  const lower = hostPart.toLowerCase();
  const cls = classifyHostToken(lower);
  if (!cls.ok && cls.reason !== "numeric" && cls.reason !== "denylisted") return undefined;
  return `${lower}:${port}`;
}

/** Browser-form origin: the default port for `scheme` is omitted. */
export function canonicalOrigin(scheme: "http" | "https", hostKey: string): string {
  const idx = hostKey.lastIndexOf(":");
  const host = idx < 0 ? hostKey : hostKey.slice(0, idx);
  const port = idx < 0 ? undefined : Number(hostKey.slice(idx + 1));
  return port === undefined || port === defaultPortFor(scheme) ? `${scheme}://${host}` : `${scheme}://${host}:${port}`;
}

/**
 * Parse an `Origin` header value. Rejects non-http(s) schemes, embedded
 * userinfo, and a non-root path/search/hash (a bare origin's pathname is `""`
 * or `"/"`, both accepted).
 *
 * Deliberately does **not** use `new URL(origin).host` for the host part
 * (review fix, W1 v2): WHATWG's URL parser silently rewrites a numeric-
 * looking authority into a dotted-quad IPv4 address before we ever see it
 * (`new URL("https://123").host === "0.0.0.123"`, `"https://0x7f".host ===
 * "0.0.0.127"`, `"https://1.2".host === "1.0.0.2"`) — classifying *that*
 * output would let a config author write `https://123` and have it
 * silently accepted as a real IPv4 literal instead of being rejected as
 * `numeric` (§2.1 rule ⑥). Instead this parses the `scheme://[user@]host[/]`
 * shape directly with a regex, so `classifyHostToken`/`canonicalHostKey`
 * always see the *raw* authority the caller actually wrote.
 */
const ORIGIN_RE = /^(https?):\/\/(?:([^/?#]*)@)?([^/?#]*)(\/)?$/i;

export function parseOrigin(origin: string): { scheme: "http" | "https"; hostKey: string } | undefined {
  const m = ORIGIN_RE.exec(origin);
  if (m === null) return undefined;
  const [, schemeRaw, userinfo, hostPort] = m;
  if (userinfo !== undefined) return undefined; // embedded userinfo rejected
  const scheme = schemeRaw!.toLowerCase() === "https" ? "https" : "http";
  const hostKey = canonicalHostKey(hostPort, scheme);
  if (hostKey === undefined) return undefined;
  return { scheme, hostKey };
}

// ---------------------------------------------------------------------------
// §9.2 LanStatus / LanOffReason
// ---------------------------------------------------------------------------

export type LanOffReason =
  | "sqlite-unavailable"
  | "db-too-large"
  | "db-timeout"
  | "db-invalid"
  | "db-unavailable"
  | "listen-failed"
  | "bad-config"
  | "timeout";

export type LanStatus =
  | { state: "starting" }
  | {
      state: "on";
      port: number;
      hosts: string[]; // allow-listed host parts (no port), IPv4 first then names
      omitted: { host: string; reason: HostTokenRejectReason }[];
      proxy?: { trustedFrom: string[]; externalOrigins: string[] };
      warnings: string[];
    }
  | { state: "off"; reason: LanOffReason; detail?: string };
