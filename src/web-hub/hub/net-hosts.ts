/**
 * `HostsPort` real implementation (plan §2.3, LC's file per §2.3's own
 * attribution: "`hub/net-hosts.ts` LC"). Pure, synchronous, no I/O beyond
 * `os.networkInterfaces()` / `os.hostname()` — no fs, no network — so it can
 * be called from a request-triggered throttled recompute (§2.3 "直连请求收到
 * 421 且 Host 的主机部分是 IPv4 语法 ⇒ 一次节流重算") without ever blocking
 * the event loop.
 *
 * §2.1's allow-list table, in the order applied here:
 *   ① every IPv4 interface address (`os.networkInterfaces()`, incl. internal
 *      / docker bridges — L8: we don't try to distinguish them)
 *   ② `127.0.0.1` / `localhost` (unconditional — LAN listener is reachable
 *      from the same host too)
 *   ③ `os.hostname()` itself, if `classifyHostToken` accepts it; otherwise
 *      recorded in `omitted` (status surfaces the exact rejection reason,
 *      e.g. a purely-numeric hostname classifies `numeric`)
 *   ④ `<hostname>.local`, whenever the hostname is a *syntactically* valid
 *      single label — independent of whether ③ accepted it. A numeric
 *      hostname like `202507220006` fails ③ (`numeric`) but still produces
 *      `202507220006.local` here, because `classifyHostToken`'s "numeric"
 *      rejection is about a bare token being *interpreted as an address* by
 *      the browser, not about DNS label syntax; `.local`-suffixed the token
 *      is definitely a name (mDNS), so it is safe to allow (§2.1 table).
 *   ⑤ `cfg.extraHosts`, already validated upstream (settings parsing /
 *      `parseHubLanConfig`, L16) — canonicalized here defensively; a token
 *      that still fails re-validation is skipped rather than crashing this
 *      synchronous, must-never-throw computation.
 *
 * `cfg.externalOrigins` never enters `hostKeys` (§2.4: it is a disjoint set,
 * checked only for requests arriving through a trusted reverse proxy) and
 * `cfg.trustProxyFrom` is carried through unchanged for `resolveProxy` (§2.4)
 * to consult per-request.
 */
import { hostname, networkInterfaces } from "node:os";
import { canonicalHostKey, classifyHostToken } from "../protocol/lan.js";
import type { HostSnapshot, HostsPort, HubLanConfig } from "./ports.js";

/** Syntax-only single-label check (§2.1's label regex), independent of `classifyHostToken`'s
 * `numeric` verdict — used only to decide whether `<hostname>.local` should be offered. */
const SINGLE_LABEL_SYNTAX_RE = /^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?$/;

function isSyntacticSingleLabel(host: string): boolean {
  return !host.includes(".") && host.length <= 63 && SINGLE_LABEL_SYNTAX_RE.test(host);
}

/** `HostSnapshot.gen` has no meaning to a stateless `compute()` — callers own generation
 * numbering across successive `swap()`s (§2.3); this always returns 0. */
export function createHostsPort(): HostsPort {
  return {
    compute(cfg: HubLanConfig): HostSnapshot {
      const hostKeys = new Set<string>();
      const omitted: { host: string; reason: import("../protocol/lan.js").HostTokenRejectReason }[] = [];

      function addHost(rawLower: string): void {
        const key = canonicalHostKey(`${rawLower}:${cfg.port}`, "http");
        if (key !== undefined) hostKeys.add(key);
      }

      // ① interface IPv4 addresses.
      for (const addrs of Object.values(networkInterfaces())) {
        if (addrs === undefined) continue;
        for (const addr of addrs) {
          if (addr.family === "IPv4") addHost(addr.address);
        }
      }

      // ② loopback names.
      addHost("127.0.0.1");
      addHost("localhost");

      // ③ / ④ system hostname and its `.local` sibling.
      const h = hostname().toLowerCase();
      const cls = classifyHostToken(h);
      if (cls.ok) addHost(h);
      else omitted.push({ host: h, reason: cls.reason });
      if (isSyntacticSingleLabel(h)) addHost(`${h}.local`);

      // ⑤ extraHosts (defensive re-check; already validated upstream).
      for (const raw of cfg.extraHosts) {
        const lower = raw.toLowerCase();
        const c = classifyHostToken(lower);
        if (c.ok) addHost(lower);
      }

      return {
        gen: 0,
        hostKeys,
        externalOrigins: new Set(cfg.externalOrigins),
        trustProxyFrom: new Set(cfg.trustProxyFrom),
        omitted,
        computedAt: Date.now(),
      };
    },
  };
}

/** Set-equality on `hostKeys` (§2.3 "提交": recompute results that don't change the allow-list
 * don't need a `swap()`). Only `hostKeys` is compared — `omitted`/`computedAt` always differ
 * trivially and `externalOrigins`/`trustProxyFrom` come straight from `cfg`, which is constant
 * between two `compute()` calls for the same running hub. */
export function sameHostKeys(a: HostSnapshot, b: HostSnapshot): boolean {
  if (a.hostKeys.size !== b.hostKeys.size) return false;
  for (const k of a.hostKeys) if (!b.hostKeys.has(k)) return false;
  return true;
}
