/** Phone-facing links for ALL Feishu surfaces. Selection never widens LAN host admission. */
import { canonicalHostKey, canonicalOrigin, classifyHostToken, parseOrigin } from "../../protocol/lan.js";
import type { HostSnapshot, HubLanConfig, RequestContext } from "../ports.js";

export function createFeishuLinks(deps: {
  loopbackPort(): number;
  lan?: HubLanConfig;
  snapshot(): HostSnapshot | undefined;
}) {
  let lastHost: string | undefined; // successful authenticated direct-LAN requests only; never persisted
  // A loopback Host on the LAN listener (the desktop browser on the hub machine) is never a
  // phone-reachable origin — never record it, never pick it as the fallback.
  const loopback = (key: string) => /^(?:localhost|127(?:\.\d+){3}|\[::1\]):/.test(key);
  const allowed = (key: string, snapshot: HostSnapshot) =>
    canonicalHostKey(key, "http") === key &&
    snapshot.hostKeys.has(key) &&
    classifyHostToken(key.slice(0, key.lastIndexOf(":"))).ok;
  return {
    authenticated(ctx: RequestContext) {
      const snapshot = deps.snapshot();
      if (
        ctx.kind === "lan" &&
        !ctx.viaTrustedProxy &&
        snapshot &&
        allowed(ctx.hostKey, snapshot) &&
        !loopback(ctx.hostKey)
      )
        lastHost = ctx.hostKey;
    },
    link(agentKey: string): string {
      let origin: string | undefined;
      if (deps.lan) {
        const external = deps.lan.externalOrigins[0];
        const parsed = external && !/[\p{Cc}\s]/u.test(external) ? parseOrigin(external) : undefined;
        if (parsed && classifyHostToken(parsed.hostKey.slice(0, parsed.hostKey.lastIndexOf(":"))).ok)
          origin = canonicalOrigin(parsed.scheme, parsed.hostKey);
        const snapshot = deps.snapshot();
        if (!origin && snapshot) {
          const key =
            lastHost && allowed(lastHost, snapshot)
              ? lastHost
              : [...snapshot.hostKeys].find((key) => allowed(key, snapshot) && !loopback(key));
          if (key) origin = canonicalOrigin("http", key);
        }
      }
      if (!origin) {
        const port = deps.loopbackPort();
        if (!Number.isInteger(port) || port <= 0 || port > 65535) return "";
        origin = `http://127.0.0.1:${port}`;
      }
      return `${origin}/#/agent/${encodeURIComponent(agentKey)}`;
    },
  };
}
/** Last defensive boundary for injected/invalid links; no credentials, controls or malformed URLs. */
export function safeFeishuLink(value: string | undefined): string {
  try {
    if (!value || /[\p{Cc}\s\\]/u.test(value) || !/^https?:\/\/[^/?#]/i.test(value)) return "web 会话页面";
    const url = new URL(value);
    return ["http:", "https:"].includes(url.protocol) && !url.username && !url.password && !url.search
      ? value
      : "web 会话页面";
  } catch {
    return "web 会话页面";
  }
}
