/**
 * `HubLanConfig` field-level revalidation performed by `hub/main.ts` after
 * receiving `PI_WEBHUB_CONFIG` over the environment (plan §1.4.3, §9.1: the
 * settings layer already validated once — this is hub.ts's own second,
 * independent check since hub does not read pi's settings file, arch §13.3).
 *
 * Factored into its own side-effect-free module (rather than living directly
 * in `hub/main.ts`, which it is still re-exported from) so it is unit
 * testable without loading `hub/main.ts` — that module's top-level
 * `void main();` would call `process.exit()` on a plain `import` outside a
 * spawned hub process.
 */
import { canonicalOrigin, classifyHostToken, parseOrigin } from "../protocol/lan.js";
import type { HubLanConfig } from "./ports.js";

function stringArray(v: unknown): string[] | undefined {
  return Array.isArray(v) && v.every((x) => typeof x === "string") ? (v as string[]) : undefined;
}

export function parseHubLanConfig(raw: unknown): { ok: true; lan: HubLanConfig } | { ok: false; detail: string } {
  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) {
    return { ok: false, detail: "lan: not an object" };
  }
  const obj = raw as Record<string, unknown>;

  const portRaw = obj["port"];
  if (typeof portRaw !== "number" || !Number.isInteger(portRaw) || portRaw < 1 || portRaw > 65535) {
    return { ok: false, detail: `port=${String(portRaw)}: out of range` };
  }
  const port = portRaw;

  const extraHostsRaw = stringArray(obj["extraHosts"]);
  if (extraHostsRaw === undefined) return { ok: false, detail: "extraHosts: must be a string array" };
  const extraHosts: string[] = [];
  for (let i = 0; i < extraHostsRaw.length; i++) {
    const token = extraHostsRaw[i]!;
    const cls = classifyHostToken(token);
    if (!cls.ok) return { ok: false, detail: `extraHosts[${i}]=${token}: ${cls.reason}` };
    extraHosts.push(cls.host);
  }

  const trustProxyFromRaw = stringArray(obj["trustProxyFrom"]);
  if (trustProxyFromRaw === undefined) return { ok: false, detail: "trustProxyFrom: must be a string array" };
  const trustProxyFrom: string[] = [];
  for (let i = 0; i < trustProxyFromRaw.length; i++) {
    const token = trustProxyFromRaw[i]!;
    const cls = classifyHostToken(token);
    if (!cls.ok || cls.kind !== "ipv4") return { ok: false, detail: `trustProxyFrom[${i}]=${token}: not-ipv4` };
    trustProxyFrom.push(cls.host);
  }

  const externalOriginsRaw = stringArray(obj["externalOrigins"]);
  if (externalOriginsRaw === undefined) return { ok: false, detail: "externalOrigins: must be a string array" };
  const externalOrigins: string[] = [];
  for (let i = 0; i < externalOriginsRaw.length; i++) {
    const origin = externalOriginsRaw[i]!;
    const parsed = parseOrigin(origin);
    if (parsed === undefined) return { ok: false, detail: `externalOrigins[${i}]=${origin}: origin-syntax` };
    if (parsed.scheme !== "https") return { ok: false, detail: `externalOrigins[${i}]=${origin}: origin-not-https` };
    // §2.4: the *host* part of an externalOrigins entry must independently clear
    // classifyHostToken's allow-list (fqdn/single-label/ipv4/dot-local/localhost) --
    // canonicalHostKey/parseOrigin deliberately let numeric/denylisted hosts through
    // (canonicalization ≠ allow-listing). In practice a bare numeric single-label host
    // never reaches this check: WHATWG's URL parser already rejects it one step earlier
    // (parseOrigin's `new URL()` call fails outright once the last label is all-digits
    // and overflows a uint32, matching real-browser navigation behavior) -- but the
    // classifyHostToken call stays here for defense in depth / consistency with every
    // other host-classification call site, and it is what actually rejects denylisted
    // hosts ("https://dev"), which do survive `new URL()` unchanged.
    const hostOnly = parsed.hostKey.slice(0, parsed.hostKey.lastIndexOf(":"));
    const hostCls = classifyHostToken(hostOnly);
    if (!hostCls.ok) return { ok: false, detail: `externalOrigins[${i}]=${origin}: ${hostCls.reason}` };
    externalOrigins.push(canonicalOrigin(parsed.scheme, parsed.hostKey));
  }

  if ((trustProxyFrom.length === 0) !== (externalOrigins.length === 0)) {
    return { ok: false, detail: "trustProxyFrom/externalOrigins: proxy-config-mismatch" };
  }

  return { ok: true, lan: { port, extraHosts, trustProxyFrom, externalOrigins } };
}

/**
 * Cross-field check main.ts runs after a successful `parseHubLanConfig`
 * (plan §9.1: "webHub.lan.port ... 且不等于 webHub.port"). Kept out of
 * `parseHubLanConfig` itself since that function's frozen signature
 * (§1.4.3) takes only the raw LAN config, not the loopback port.
 */
export function checkLanPortConflict(
  lan: HubLanConfig,
  loopbackPort: number,
): { ok: true } | { ok: false; detail: string } {
  if (lan.port === loopbackPort) {
    return { ok: false, detail: `port=${lan.port}: must not equal webHub.port` };
  }
  return { ok: true };
}
