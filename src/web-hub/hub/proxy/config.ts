/**
 * `HubConfig.proxy` re-validation inside the hub process (web-hub-proxy plan v2 §5, X1c).
 *
 * `hub/main.ts` calls {@link normalizeHubProxyConfig} on the JSON it parsed out of
 * `PI_WEBHUB_CONFIG` (hand-edited env, an old/newer launcher) and DROPS the whole key on anything
 * malformed — the proxy is one feature gate (service, routes, caps, `/api` cross-site gate and
 * disk all follow the key), so a partial config is never half-applied. It also owns the SECOND
 * line of the port-collision veto (X0 hand-off): the settings parser only sees the configured
 * ports, so a default range that overlaps the hub/LAN port is vetoed here.
 *
 * Pure, no I/O, no pi imports (hub-side; `tests/web-hub/boundary.test.ts`).
 */
import {
  PROXY_DEFAULT_MAX_PROXIES,
  PROXY_MAX_PROXIES_MAX,
  PROXY_MAX_PROXIES_MIN,
  PROXY_PORT_RANGE_MAX_PORT,
  PROXY_PORT_RANGE_MAX_SPAN,
  PROXY_PORT_RANGE_MIN_PORT,
  proxyRangeContainsPort,
} from "../../protocol/proxy.js";
import type { HubProxyConfig } from "../ports.js";

export type NormalizedHubProxy = { ok: true; proxy: HubProxyConfig } | { ok: false; detail: string };

function isPort(n: unknown): n is number {
  return (
    typeof n === "number" && Number.isInteger(n) && n >= PROXY_PORT_RANGE_MIN_PORT && n <= PROXY_PORT_RANGE_MAX_PORT
  );
}

/**
 * @param value the raw `config.proxy`
 * @param ports the hub's configured loopback port and (when LAN survived normalization) LAN port.
 *   A port of 0 (ephemeral) never overlaps — the real bound port is the engine's runtime
 *   `self-port` rule.
 */
export function normalizeHubProxyConfig(
  value: unknown,
  ports: { readonly hubPort: number; readonly lanPort?: number },
): NormalizedHubProxy {
  if (value === null || typeof value !== "object" || Array.isArray(value))
    return { ok: false, detail: "not an object" };
  const raw = value as Record<string, unknown>;
  const range = raw.portRange;
  if (!Array.isArray(range) || range.length !== 2 || !isPort(range[0]) || !isPort(range[1])) {
    return { ok: false, detail: "portRange must be [lo, hi] within 1024..65535" };
  }
  const lo = range[0];
  const hi = range[1];
  if (lo > hi) return { ok: false, detail: "portRange lo > hi" };
  if (hi - lo + 1 > PROXY_PORT_RANGE_MAX_SPAN) return { ok: false, detail: "portRange span too large" };
  const max = raw.maxProxies;
  const maxProxies = max === undefined ? PROXY_DEFAULT_MAX_PROXIES : max;
  if (
    typeof maxProxies !== "number" ||
    !Number.isInteger(maxProxies) ||
    maxProxies < PROXY_MAX_PROXIES_MIN ||
    maxProxies > PROXY_MAX_PROXIES_MAX
  ) {
    return { ok: false, detail: "maxProxies must be an integer in 1..16" };
  }
  const tuple: [number, number] = [lo, hi];
  for (const [label, port] of [
    ["webHub.port", ports.hubPort],
    ["webHub.lan.port", ports.lanPort],
  ] as const) {
    if (port !== undefined && port > 0 && proxyRangeContainsPort(tuple, port)) {
      return { ok: false, detail: `portRange overlaps ${label} (${String(port)})` };
    }
  }
  return { ok: true, proxy: { portRange: tuple, maxProxies } };
}
