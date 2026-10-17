/** Shared HTTP/101/non-101 header policy. No request URLs or headers ever reach audit (§3.6). */
import {
  PROXY_DROPPED_REQUEST_HEADERS,
  PROXY_DROPPED_REQUEST_HEADER_PREFIXES,
  PROXY_DROPPED_RESPONSE_HEADERS,
  PROXY_STRIPPED_COOKIE_PREFIX,
  type ProxyTargetClass,
} from "../../protocol/proxy.js";
import { canonicalAddr, type ProxyTarget } from "./target.js";

export type ProxyHeaders = Readonly<Record<string, string | readonly string[] | number | undefined>>;
export type FilteredProxyHeaders = Record<string, string | string[] | number>;
export interface ProxyHeaderContext {
  readonly origin: string;
  readonly target: Pick<ProxyTarget, "hostHeader" | "port">;
  readonly pinnedIp: string;
  readonly cls: ProxyTargetClass;
  readonly ws?: boolean;
}
export interface ProxyRequestHeaderContext extends ProxyHeaderContext {
  readonly peer: string;
  readonly browserHost: string;
}

/** RFC 9110 hop-by-hop names; arbitrary Connection-nominated headers are removed too. */
function hopNames(headers: ProxyHeaders): Set<string> {
  const names = new Set([
    "connection",
    "keep-alive",
    "proxy-authenticate",
    "proxy-authorization",
    "proxy-connection",
    "te",
    "trailer",
    "transfer-encoding",
    "upgrade",
  ]);
  for (const [name, value] of Object.entries(headers)) {
    if (name.toLowerCase() !== "connection" || value === undefined) continue;
    for (const token of String(value).split(",")) names.add(token.trim().toLowerCase());
  }
  return names;
}
function strings(value: string | readonly string[] | number): string[] {
  return Array.isArray(value) ? [...value] : [String(value)];
}
function copy(value: string | readonly string[] | number): string | string[] | number {
  return typeof value === "object" ? [...value] : value;
}

export function stripProxyCookies(value: string): string {
  return value
    .split(";")
    .map((s) => s.trim())
    .filter((pair) => {
      const eq = pair.indexOf("=");
      return eq > 0 && !pair.slice(0, eq).trim().toLowerCase().startsWith(PROXY_STRIPPED_COOKIE_PREFIX);
    })
    .join("; ");
}
export function filterProxySetCookie(line: string): string | undefined {
  const parts = line.split(";");
  const first = parts[0] ?? "";
  const eq = first.indexOf("=");
  if (eq <= 0 || first.slice(0, eq).trim().toLowerCase().startsWith(PROXY_STRIPPED_COOKIE_PREFIX)) return undefined;
  return parts.filter((part, i) => i === 0 || !/^\s*domain\s*=/i.test(part)).join(";");
}

export function filterRequestHeaders(headers: ProxyHeaders, ctx: ProxyRequestHeaderContext): FilteredProxyHeaders {
  const hops = hopNames(headers);
  const out: FilteredProxyHeaders = Object.create(null) as FilteredProxyHeaders;
  for (const [raw, value] of Object.entries(headers)) {
    const name = raw.toLowerCase();
    if (
      value === undefined ||
      hops.has(name) ||
      (PROXY_DROPPED_REQUEST_HEADERS as readonly string[]).includes(name) ||
      PROXY_DROPPED_REQUEST_HEADER_PREFIXES.some((p) => name.startsWith(p))
    )
      continue;
    if (name === "cookie") {
      const cleaned = stripProxyCookies(strings(value).join("; "));
      if (cleaned !== "") out[name] = cleaned;
    } else if (name === "origin") {
      out[name] = strings(value)
        .map((s) => (s === ctx.origin ? `http://${ctx.target.hostHeader}` : s))
        .join(", ");
    } else if (name === "referer") {
      out[name] = strings(value)
        .map((s) =>
          s === ctx.origin || s.startsWith(`${ctx.origin}/`)
            ? `http://${ctx.target.hostHeader}${s.slice(ctx.origin.length)}`
            : s,
        )
        .join(", ");
    } else out[name] = copy(value);
  }
  // Forced AFTER Connection filtering: client-supplied tokens cannot suppress or forge these.
  out.host = ctx.target.hostHeader;
  out["x-forwarded-for"] = ctx.peer;
  out["x-forwarded-proto"] = "http";
  out["x-forwarded-host"] = ctx.browserHost;
  if (ctx.ws) {
    out.connection = "Upgrade";
    out.upgrade = "websocket";
  }
  return out;
}

function authorityKey(authority: string): string | undefined {
  try {
    const u = new URL(`http://${authority}/`);
    if (u.username !== "" || u.password !== "" || u.pathname !== "/" || u.search !== "" || u.hash !== "")
      return undefined;
    const host = canonicalAddr(u.hostname)?.key ?? u.hostname.toLowerCase();
    return `${host}|${u.port === "" ? 80 : Number(u.port)}`;
  } catch {
    return undefined;
  }
}
function ipAuthority(ip: string, port: number): string {
  return `${ip.includes(":") ? `[${ip}]` : ip}:${port}`;
}
export function rewriteProxyLocation(value: string, ctx: ProxyHeaderContext): string {
  const m = /^(http:)?\/\/([^/?#]+)(.*)$/i.exec(value);
  if (m === null) return value; // relative, https, or any other foreign scheme
  const key = authorityKey(m[2]!);
  const authorities = [ctx.target.hostHeader, ipAuthority(ctx.pinnedIp, ctx.target.port)];
  if (ctx.cls === "loopback")
    authorities.push(`127.0.0.1:${ctx.target.port}`, `localhost:${ctx.target.port}`, `[::1]:${ctx.target.port}`);
  if (key === undefined || !authorities.some((a) => authorityKey(a) === key)) return value;
  const browser = new URL(ctx.origin);
  return `${m[1] === undefined ? "//" : "http://"}${browser.host}${m[3]}`;
}

/** Use on ALL upstream responses, including upgrade 101 and rejected WS handshakes. */
export function filterResponseHeaders(headers: ProxyHeaders, ctx: ProxyHeaderContext): FilteredProxyHeaders {
  const hops = hopNames(headers);
  const out: FilteredProxyHeaders = Object.create(null) as FilteredProxyHeaders;
  for (const [raw, value] of Object.entries(headers)) {
    const name = raw.toLowerCase();
    if (value === undefined || hops.has(name) || (PROXY_DROPPED_RESPONSE_HEADERS as readonly string[]).includes(name))
      continue;
    if (name === "set-cookie") {
      const cleaned = strings(value)
        .map(filterProxySetCookie)
        .filter((s): s is string => s !== undefined);
      if (cleaned.length > 0) out[name] = cleaned;
    } else if (name === "location" || name === "content-location") {
      out[name] = strings(value)
        .map((s) => rewriteProxyLocation(s, ctx))
        .join(", ");
    } else out[name] = copy(value);
  }
  if (ctx.ws) {
    out.connection = "Upgrade";
    out.upgrade = "websocket";
  }
  return out;
}
