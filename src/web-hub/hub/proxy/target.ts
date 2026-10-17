/** TCP-only target grammar and the shared canonical-bytes SSRF/self-port fence (§3.1). */
import { isIP } from "node:net";
import { classifyHostToken } from "../../protocol/lan.js";
import {
  PROXY_NEXT_PATH_MAX_BYTES,
  proxyRangeContainsPort,
  type ProxyDenyReason,
  type ProxyTargetClass,
} from "../../protocol/proxy.js";

export interface CanonicalAddr {
  readonly v: 4 | 6;
  readonly bytes: Uint8Array;
  /** Canonical, unbracketed IP; also the dial address. Mapped IPv6 has an IPv4 key. */
  readonly key: string;
}
export type AddrVerdict = { ok: true; cls: ProxyTargetClass } | { ok: false; reason: ProxyDenyReason };
export interface ProxyTarget {
  readonly host: string;
  readonly lookupHost: string;
  readonly port: number;
  /** Host header authority, including brackets on IPv6 and a non-default port. */
  readonly hostHeader: string;
  readonly nextPath: string;
  readonly address?: CanonicalAddr;
}
export type TargetResult = { ok: true; target: ProxyTarget } | { ok: false; reason: ProxyDenyReason };

/** Defense in depth: legacy IPv4 numbers are canonicalized HERE, but rejected by the input grammar. */
export function canonicalAddr(text: string): CanonicalAddr | undefined {
  const bracketed = text.startsWith("[") && text.endsWith("]");
  const raw = bracketed ? text.slice(1, -1) : text;
  if (bracketed && !raw.includes(":")) return undefined;
  if (raw.length === 0 || /[%\s/@?#\\]/.test(raw)) return undefined;
  try {
    if (!raw.includes(":")) {
      if (!/^[0-9a-fx.]+$/i.test(raw)) return undefined;
      const ip = new URL(`http://${raw}/`).hostname;
      if (isIP(ip) !== 4) return undefined;
      return { v: 4, key: ip, bytes: Uint8Array.from(ip.split(".").map(Number)) };
    }
    if (isIP(raw) !== 6) return undefined;
    const ip = new URL(`http://[${raw}]/`).hostname.slice(1, -1);
    const [left = "", right = ""] = ip.split("::");
    const l = left === "" ? [] : left.split(":");
    const r = right === "" ? [] : right.split(":");
    const words = ip.includes("::") ? [...l, ...Array<string>(8 - l.length - r.length).fill("0"), ...r] : l;
    const bytes = new Uint8Array(16);
    words.forEach((w, i) => {
      const n = Number.parseInt(w, 16);
      bytes[i * 2] = n >>> 8;
      bytes[i * 2 + 1] = n & 255;
    });
    if (bytes.slice(0, 10).every((b) => b === 0) && bytes[10] === 255 && bytes[11] === 255) {
      const v4 = bytes.slice(12);
      return { v: 4, key: [...v4].join("."), bytes: v4 };
    }
    return { v: 6, key: ip, bytes };
  } catch {
    return undefined;
  }
}

export function classifyProxyAddr(a: CanonicalAddr): AddrVerdict {
  const b = a.bytes;
  const no = (reason: ProxyDenyReason): AddrVerdict => ({ ok: false, reason });
  const yes = (cls: ProxyTargetClass): AddrVerdict => ({ ok: true, cls });
  if (a.v === 4) {
    const [x = 0, y = 0, z = 0, w = 0] = b;
    if (x === 0) return no("unspecified");
    if ((x === 169 && y === 254 && z === 169 && w === 254) || (x === 100 && y === 100)) return no("metadata");
    if (x === 169 && y === 254) return no("link-local");
    if (x >= 224 && x <= 239) return no("multicast");
    if (
      x >= 240 ||
      (x === 192 && y === 0 && (z === 0 || z === 2)) ||
      (x === 198 && (y === 18 || y === 19 || (y === 51 && z === 100))) ||
      (x === 203 && y === 0 && z === 113)
    )
      return no("reserved");
    if (x === 127) return yes("loopback");
    if (x === 10 || (x === 172 && y >= 16 && y <= 31) || (x === 192 && y === 168)) return yes("private");
    if (x === 100 && y >= 64 && y <= 127) return yes("cgnat");
    return no("public");
  }
  if (b.every((v) => v === 0)) return no("unspecified");
  if (b.slice(0, 15).every((v) => v === 0) && b[15] === 1) return yes("loopback");
  if (b[0] === 0xfd && b[1] === 0 && b[2] === 0x0e && b[3] === 0xc2) return no("metadata");
  if (b[0] === 0xfe && (b[1]! & 0xc0) === 0x80) return no("link-local");
  if (b[0] === 0xff) return no("multicast");
  if (
    b.slice(0, 12).every((v) => v === 0) ||
    (b[0] === 0x20 && b[1] === 2) ||
    (b[0] === 0 &&
      b[1] === 0x64 &&
      b[2] === 0xff &&
      b[3] === 0x9b &&
      ((b[4] === 0 && b[5] === 1) || b.slice(4, 12).every((v) => v === 0)))
  )
    return no("translation");
  if ((b[0]! & 0xfe) === 0xfc) return yes("ula");
  return no("public");
}

/** No open redirect; reject dangerous raw/percent-encoded bytes, including encoded slash/backslash prefixes. */
export function safeOriginForm(path: string): string {
  const p = path.split("#", 1)[0] ?? "";
  if (Buffer.byteLength(p) > PROXY_NEXT_PATH_MAX_BYTES || !p.startsWith("/") || p.startsWith("//")) return "/";
  if (/[\\\x00-\x20\x7f]/.test(p) || /%(?:0[0-9a-f]|1[0-9a-f]|20|7f|5c)/i.test(p) || /%(?![0-9a-f]{2})/i.test(p))
    return "/";
  // A browser can normalize encoded leading slashes in redirects differently from an HTTP client.
  if (/^\/(?:%2f|%5c)/i.test(p)) return "/";
  // Node Location headers must not receive raw Unicode. Buffer's UTF-8 conversion replaces lone
  // surrogates with U+FFFD rather than throwing as encodeURIComponent would.
  const ascii = [...Buffer.from(p, "utf8")]
    .map((byte) => (byte >= 0x80 ? `%${byte.toString(16).toUpperCase().padStart(2, "0")}` : String.fromCharCode(byte)))
    .join("");
  return ascii.length <= PROXY_NEXT_PATH_MAX_BYTES ? ascii : "/";
}

/** Fence tables belong here, not in the frozen wire protocol (X0 contract). Exact lower-case matches. */
function metadataHost(host: string): boolean {
  return [
    "metadata",
    "metadata.google.internal",
    "metadata.goog",
    "instance-data",
    "instance-data.ec2.internal",
    "metadata.azure.internal",
  ].includes(host);
}

export function parseProxyTarget(input: string): TargetResult {
  const no = (reason: ProxyDenyReason): TargetResult => ({ ok: false, reason });
  const text = input;
  let rest = text;
  const scheme = /^([a-z][a-z\d+.-]*):\/\//i.exec(text);
  if (scheme !== null) {
    if (scheme[1]!.toLowerCase() !== "http") return no("scheme");
    rest = text.slice(scheme[0].length);
  } else if (/^(?:unix|file|https?|ws|wss):/i.test(text)) return no("scheme");
  const cut = rest.search(/[/?#]/);
  const authority = cut < 0 ? rest : rest.slice(0, cut);
  const suffix = cut < 0 ? "/" : rest.slice(cut);
  if (scheme === null && cut >= 0) return no("syntax");
  if (authority.includes("@")) return no("userinfo");
  if (/[\\\s\x00-\x1f\x7f%]/.test(authority)) return no("syntax");
  const m = /^(\[[^\]]+\]|[^:\[\]]+):([^:]*)$/.exec(authority);
  if (m === null) return no("syntax");
  const host = m[1]!;
  const portText = m[2]!;
  if (!/^[1-9]\d{0,4}$/.test(portText) || Number(portText) > 65535) return no("port");
  const port = Number(portText);
  const lower = host.toLowerCase();
  let address: CanonicalAddr | undefined;
  let lookupHost = lower;
  if (host.startsWith("[")) {
    if (isIP(host.slice(1, -1)) !== 6) return no("syntax");
    address = canonicalAddr(host);
    lookupHost = host.slice(1, -1).toLowerCase();
  } else {
    if (metadataHost(lower)) return no("metadata");
    const cls = classifyHostToken(lower);
    if (!cls.ok) return no("syntax");
    if (cls.kind === "ipv4") {
      // classifyHostToken allows zero-padded quads for LAN hosts; targets deliberately do not.
      if (isIP(host) !== 4) return no("syntax");
      address = canonicalAddr(host);
    } else if (cls.kind === "localhost") address = canonicalAddr("127.0.0.1");
  }
  if (address !== undefined) {
    const verdict = classifyProxyAddr(address);
    if (!verdict.ok) return verdict;
  }
  return {
    ok: true,
    target: {
      host,
      lookupHost,
      port,
      hostHeader: canonicalHostHeader(lower, port),
      nextPath: safeOriginForm(suffix.startsWith("?") ? `/${suffix}` : suffix),
      ...(address === undefined ? {} : { address }),
    },
  };
}

export interface ProxySelfPorts {
  /** Actual frontend.listen() port, NOT the configured port (may have fallen back). */
  readonly hubPort: number;
  readonly lanPort?: number;
  readonly proxyRange: readonly [number, number];
  /** Fresh os.networkInterfaces() addresses supplied by the caller at open. */
  readonly localAddresses: readonly string[];
}
export function isProxySelfPort(address: CanonicalAddr, port: number, self: ProxySelfPorts): boolean {
  const local = classifyProxyAddr(address);
  const onMachine =
    (local.ok && local.cls === "loopback") || self.localAddresses.some((ip) => canonicalAddr(ip)?.key === address.key);
  return onMachine && (port === self.hubPort || port === self.lanPort || proxyRangeContainsPort(self.proxyRange, port));
}

function canonicalHostHeader(host: string, port: number): string {
  const address = canonicalAddr(host);
  const canonicalHost = address === undefined ? host.toLowerCase() : address.v === 6 ? `[${address.key}]` : address.key;
  return `${canonicalHost}${port === 80 ? "" : `:${port}`}`;
}

export function proxyTargetKey(address: CanonicalAddr, target: Pick<ProxyTarget, "port" | "hostHeader">): string {
  const host = target.hostHeader.replace(/:\d+$/, "");
  return `${address.key}|${target.port}|${canonicalHostHeader(host, target.port)}`;
}
