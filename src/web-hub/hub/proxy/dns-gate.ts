/** Single physical DNS slot: caller timeout never releases an outstanding lookup (§3.1). */
import { PROXY_DNS_TIMEOUT_MS, type ProxyDenyReason, type ProxyTargetClass } from "../../protocol/proxy.js";
import {
  canonicalAddr,
  classifyProxyAddr,
  isProxySelfPort,
  parseProxyTarget,
  proxyTargetKey,
  type CanonicalAddr,
  type ProxySelfPorts,
  type ProxyTarget,
} from "./target.js";

/** Injected scheduler returns an idempotent cancellation function; production timers never keep pi alive. */
export interface ProxyTimerPort {
  after(ms: number, fn: () => void): () => void;
}
export const systemProxyTimer: ProxyTimerPort = Object.freeze({
  after(ms: number, fn: () => void): () => void {
    const timer = setTimeout(fn, ms);
    timer.unref();
    return () => clearTimeout(timer);
  },
});
export interface ProxyDnsAnswer {
  readonly address: string;
  readonly family: number;
}
export interface ProxyDnsGateDeps {
  lookup(host: string, opts: { all: true; verbatim: true }): Promise<readonly ProxyDnsAnswer[]>;
  readonly timer?: ProxyTimerPort;
}
export type ProxyDnsResult =
  { ok: true; answers: readonly ProxyDnsAnswer[] } | { ok: false; reason: "dns-failed" | "dns-timeout" };
export interface ProxyDnsGate {
  readonly inflight: boolean;
  /** No waiting queue: an occupied (possibly zombie) slot refuses immediately. */
  resolve(host: string): Promise<ProxyDnsResult>;
}
export function createProxyDnsGate(deps: ProxyDnsGateDeps): ProxyDnsGate {
  let inflight = false;
  const timer = deps.timer ?? systemProxyTimer;
  return {
    get inflight() {
      return inflight;
    },
    resolve(host) {
      if (inflight) return Promise.resolve({ ok: false, reason: "dns-timeout" });
      inflight = true;
      return new Promise<ProxyDnsResult>((resolve) => {
        let done = false;
        const finish = (r: ProxyDnsResult): void => {
          if (done) return;
          done = true;
          cancel();
          resolve(r);
        };
        const cancel = timer.after(PROXY_DNS_TIMEOUT_MS, () => finish({ ok: false, reason: "dns-timeout" }));
        Promise.resolve()
          .then(() => deps.lookup(host, { all: true, verbatim: true }))
          .then(
            (answers) => {
              inflight = false;
              finish(answers.length === 0 ? { ok: false, reason: "dns-failed" } : { ok: true, answers });
            },
            () => {
              inflight = false;
              finish({ ok: false, reason: "dns-failed" });
            },
          );
      });
    },
  };
}

export interface PinnedProxyTarget {
  readonly target: ProxyTarget;
  readonly address: CanonicalAddr;
  readonly pinnedIp: string;
  readonly cls: ProxyTargetClass;
  readonly key: string;
}
export type PinnedTargetResult = { ok: true; pinned: PinnedProxyTarget } | { ok: false; reason: ProxyDenyReason };
/** Resolve ONCE, check ALL answers, and return only literal dial coordinates (never a lookup callback). */
export async function resolveProxyTarget(
  input: string,
  dns: ProxyDnsGate,
  self: ProxySelfPorts,
): Promise<PinnedTargetResult> {
  const parsed = parseProxyTarget(input);
  if (!parsed.ok) return parsed;
  const target = parsed.target;
  let addresses: Array<CanonicalAddr | undefined>;
  if (target.address !== undefined) addresses = [target.address];
  else {
    const result = await dns.resolve(target.lookupHost);
    if (!result.ok) return result;
    addresses = result.answers.map((a) => canonicalAddr(a.address));
  }
  const allowed: Array<{ address: CanonicalAddr; cls: ProxyTargetClass }> = [];
  const denied: ProxyDenyReason[] = [];
  for (const address of addresses) {
    if (address === undefined) {
      denied.push("dns-failed");
      continue;
    }
    const verdict = classifyProxyAddr(address);
    if (verdict.ok) allowed.push({ address, cls: verdict.cls });
    else denied.push(verdict.reason);
  }
  if (denied.length > 0) return { ok: false, reason: allowed.length > 0 ? "mixed-answer" : denied[0]! };
  const chosen = allowed.find((a) => a.address.v === 4) ?? allowed[0];
  if (chosen === undefined) return { ok: false, reason: "dns-failed" };
  if (isProxySelfPort(chosen.address, target.port, self)) return { ok: false, reason: "self-port" };
  return {
    ok: true,
    pinned: {
      target,
      address: chosen.address,
      pinnedIp: chosen.address.key,
      cls: chosen.cls,
      key: proxyTargetKey(chosen.address, target),
    },
  };
}
