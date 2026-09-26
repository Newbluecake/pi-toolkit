/**
 * Trusted reverse-proxy header resolution (plan §2.4, LC). Pure function:
 * reads only `peerIp` / `headers` / the configured `trust` set, does no I/O
 * and never throws. `buildContext`'s `"lan"` branch (`hub/http.ts`) is the
 * only caller; it owns the *hard* 400/421 decisions (§2.4's "必须..." /
 * "否则 400/421" rows) — this function only classifies what it saw so that
 * decision stays table-driven and testable on its own (`tests/web-hub/http/
 * proxy.test.ts`).
 */
import type { IncomingHttpHeaders } from "node:http";
import { classifyHostToken } from "../protocol/lan.js";

export interface ProxyResolution {
  viaTrustedProxy: boolean;
  clientIp: string;
  scheme: "http" | "https";
  /** `X-Forwarded-Host` (trusted) or `Host` (untrusted, or trusted-but-XFH-missing) — raw, not
   * yet validated for cardinality/syntax; the caller re-parses it (§2.4's own multi-value /
   * syntax rules produce 400, which this pure function has no channel to signal on its own). */
  hostHeader: string | undefined;
  warnings: ("xff-missing" | "xff-all-trusted" | "xff-malformed" | "proto-invalid")[];
}

function lastHeaderValue(v: string | string[] | undefined): string | undefined {
  if (v === undefined) return undefined;
  return Array.isArray(v) ? v[v.length - 1] : v;
}

export function resolveProxy(
  peerIp: string,
  headers: IncomingHttpHeaders,
  trust: ReadonlySet<string>,
): ProxyResolution {
  if (!trust.has(peerIp)) {
    return { viaTrustedProxy: false, clientIp: peerIp, scheme: "http", hostHeader: headers.host, warnings: [] };
  }

  const warnings: ProxyResolution["warnings"] = [];

  // X-Forwarded-For: read right-to-left (closest hop first), skip trusted addresses, first
  // untrusted entry must be a literal IPv4 (§2.4).
  const xffRaw = lastHeaderValue(headers["x-forwarded-for"]);
  let clientIp = peerIp;
  if (xffRaw === undefined) {
    warnings.push("xff-missing");
  } else {
    const parts = xffRaw
      .split(",")
      .map((s) => s.trim())
      .filter((s) => s.length > 0);
    let candidate: string | undefined;
    for (let i = parts.length - 1; i >= 0; i--) {
      if (trust.has(parts[i]!)) continue;
      candidate = parts[i];
      break;
    }
    if (candidate === undefined) {
      warnings.push("xff-all-trusted");
    } else {
      const cls = classifyHostToken(candidate);
      if (cls.ok && cls.kind === "ipv4") clientIp = candidate;
      else warnings.push("xff-malformed");
    }
  }

  // X-Forwarded-Proto: must be present, exactly one value, case-insensitively "https".
  const xfpRaw = headers["x-forwarded-proto"];
  const xfpValues = Array.isArray(xfpRaw) ? xfpRaw : xfpRaw === undefined ? [] : [xfpRaw];
  const xfpSingle = xfpValues.length === 1 ? xfpValues[0]!.split(",") : xfpValues.length === 0 ? [] : ["__multi__"];
  const xfpOk = xfpSingle.length === 1 && xfpSingle[0]!.trim().toLowerCase() === "https";
  if (!xfpOk) warnings.push("proto-invalid");

  // X-Forwarded-Host: trusted ⇒ use it (raw, incl. any comma so the caller can reject multi-value);
  // missing ⇒ fall back to Host (§2.4 "XFH 缺失 ⇒ 用 Host 做同样的判定").
  const xfhRaw = lastHeaderValue(headers["x-forwarded-host"]);
  const hostHeader = xfhRaw ?? headers.host;

  return { viaTrustedProxy: true, clientIp, scheme: xfpOk ? "https" : "http", hostHeader, warnings };
}
