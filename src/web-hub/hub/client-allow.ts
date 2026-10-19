/**
 * LAN security r2 §2.2 — `ClientAllowGuard` (package A).
 *
 * Pure-ish decision core: no timers, no I/O besides the injected audit sink, all bookkeeping bounded.
 *
 * Activation (P0 addendum 1): `entries === undefined` ⇒ inactive (every admit is `true`, nothing is
 * recorded); `entries` present — even `[]` — ⇒ ACTIVE. `[]` is explicit deny-all: only the implicit
 * loopback (`IMPLICIT_ALLOWED`) is admitted. Entries are canonicalized/deduped/capped defensively
 * (the hub already re-validates in `lan-config.ts`); anything unusable is DROPPED, never widened —
 * the failure direction is always "fewer clients admitted".
 *
 * Bounds (plan §7): per-IP deny map ≤1024 (expired pruned first, then FIFO), burst deque ≤512,
 * ≤1 audit line per IP per 10 min (carrying a `suppressed` count), ≤60 lines per 10 min globally and
 * then exactly one overflow line per window.
 */
import { auditClientDeny, type ClientDenyAuditRecord } from "./audit.js";
import type { ClientAllowBurst, ClientAllowGuard, HubLog } from "./ports.js";
import type { ClientAllowSnapshot } from "../protocol/lan.js";
import {
  CLIENT_ALLOW_MAX,
  IMPLICIT_ALLOWED,
  createClientMatcher,
  normalizeClientIp,
  parseClientCidr,
} from "../protocol/client-allow.js";

export type { ClientAllowGuard } from "./ports.js";

export interface ClientAllowGuardDeps {
  /** undefined ⇒ inactive; present (even `[]`) ⇒ active (`[]` = deny-all except implicit loopback). */
  entries?: string[];
  now?: () => number;
  log?: Pick<HubLog, "info">;
  /** Test seam only, never config. */
  implicitLoopback?: false;
}

export type ClientAllowListener = ClientDenyAuditRecord["listener"];

/**
 * The concrete guard. `forListener` returns a VIEW over the same state (same deny map, same burst
 * deque, same counters) whose audit lines carry the given `listener` tag — the frozen
 * `ClientAllowGuard` port has no way to say which listener a denial came from.
 */
export interface ClientAllowGuardImpl extends ClientAllowGuard {
  forListener(listener: ClientAllowListener): ClientAllowGuard;
  /** Diagnostics/tests: current sizes of the bounded bookkeeping (never exceed the exported caps). */
  bookkeeping(): { ips: number; burst: number };
}

/** Tag `guard` for `listener` if it supports it (our implementation); any other port is returned as-is. */
export function tagClientAllowGuard(guard: ClientAllowGuard, listener: ClientAllowListener): ClientAllowGuard {
  const f = (guard as Partial<ClientAllowGuardImpl>).forListener;
  return typeof f === "function" ? f.call(guard, listener) : guard;
}

export const CLIENT_DENY_WINDOW_MS = 10 * 60_000;
export const CLIENT_DENY_MAP_MAX = 1024;
export const CLIENT_DENY_BURST_DEQUE_MAX = 512;
export const CLIENT_DENY_LINES_PER_WINDOW = 60;
export const CLIENT_DENY_BURST_THRESHOLD = 20;
export const CLIENT_DENY_BURST_REARM_MS = 60 * 60_000;
export const CLIENT_DENY_BURST_IPS_MAX = 10;
/** What the audit/snapshot carry instead of an unparseable address string. */
export const CLIENT_DENY_INVALID_IP = "(invalid)";

interface IpEntry {
  lastLogAt: number;
  suppressed: number;
}

export function createClientAllowGuard(deps: ClientAllowGuardDeps): ClientAllowGuardImpl {
  const now = deps.now ?? Date.now;
  const active = deps.entries !== undefined;
  const entries: string[] = [];
  if (deps.entries !== undefined) {
    const seen = new Set<string>();
    for (const raw of deps.entries) {
      if (entries.length >= CLIENT_ALLOW_MAX) break;
      const canonical = typeof raw === "string" ? parseClientCidr(raw) : undefined;
      if (canonical === undefined || seen.has(canonical)) continue;
      seen.add(canonical);
      entries.push(canonical);
    }
  }
  const explicit = entries.length > 0 ? createClientMatcher(entries) : () => false;
  const implicit = deps.implicitLoopback === false ? () => false : createClientMatcher(IMPLICIT_ALLOWED);

  // --- bounded bookkeeping -------------------------------------------------
  const perIp = new Map<string, IpEntry>();
  const deque: { at: number; ip: string }[] = [];
  const bursts = new Set<(b: ClientAllowBurst) => void>();
  let total = 0;
  let lastAt = 0;
  let lastIp = "";
  let burstRearmAt = 0;
  let lineWindowStart = Number.NEGATIVE_INFINITY;
  let lines = 0;
  let overflowed = false;

  const emit = (record: ClientDenyAuditRecord): void => {
    if (deps.log === undefined) return;
    try {
      auditClientDeny(deps.log, record);
    } catch {
      /* an audit sink failure never changes an admission decision */
    }
  };

  const fireBurst = (t: number, ip: string): void => {
    const ips: string[] = [];
    for (let i = deque.length - 1; i >= 0 && ips.length < CLIENT_DENY_BURST_IPS_MAX; i--) {
      const candidate = deque[i]!.ip;
      if (!ips.includes(candidate)) ips.push(candidate);
    }
    const burst: ClientAllowBurst = { count: deque.length, ips, lastIp: ip };
    burstRearmAt = t + CLIENT_DENY_BURST_REARM_MS;
    for (const fn of [...bursts]) {
      try {
        fn(burst);
      } catch {
        /* subscribers are isolated */
      }
    }
  };

  const entryFor = (ip: string, t: number): IpEntry => {
    const existing = perIp.get(ip);
    if (existing !== undefined) return existing;
    if (perIp.size >= CLIENT_DENY_MAP_MAX) {
      // Expired entries first (Map order ≈ last-log order, so they sit at the front), then plain FIFO.
      for (const [k, v] of perIp) {
        if (t - v.lastLogAt < CLIENT_DENY_WINDOW_MS) break;
        perIp.delete(k);
        if (perIp.size < CLIENT_DENY_MAP_MAX) break;
      }
      if (perIp.size >= CLIENT_DENY_MAP_MAX) {
        const oldest = perIp.keys().next();
        if (!oldest.done) perIp.delete(oldest.value);
      }
    }
    const fresh: IpEntry = { lastLogAt: Number.NEGATIVE_INFINITY, suppressed: 0 };
    perIp.set(ip, fresh);
    return fresh;
  };

  const deny = (
    listener: ClientAllowListener,
    via: ClientDenyAuditRecord["via"],
    reason: Exclude<ClientDenyAuditRecord["reason"], "overflow">,
    ip: string,
  ): false => {
    const t = now();
    total++;
    lastAt = t;
    lastIp = ip;
    // burst deque
    deque.push({ at: t, ip });
    while (
      deque.length > CLIENT_DENY_BURST_DEQUE_MAX ||
      (deque.length > 0 && deque[0]!.at <= t - CLIENT_DENY_WINDOW_MS)
    )
      deque.shift();
    if (deque.length >= CLIENT_DENY_BURST_THRESHOLD && t >= burstRearmAt) fireBurst(t, ip);
    // audit throttle
    const e = entryFor(ip, t);
    if (t - e.lastLogAt >= CLIENT_DENY_WINDOW_MS) {
      if (t - lineWindowStart >= CLIENT_DENY_WINDOW_MS || t < lineWindowStart) {
        lineWindowStart = t;
        lines = 0;
        overflowed = false;
      }
      if (lines < CLIENT_DENY_LINES_PER_WINDOW) {
        lines++;
        emit({ listener, ip, via, reason, suppressed: e.suppressed });
        e.suppressed = 0;
        e.lastLogAt = t;
        perIp.delete(ip); // refresh FIFO position
        perIp.set(ip, e);
      } else {
        e.suppressed++;
        if (!overflowed) {
          overflowed = true;
          emit({ listener, ip: "-", via, reason: "overflow", suppressed: 1 });
        }
      }
    } else {
      e.suppressed++;
    }
    return false;
  };

  const view = (listener: ClientAllowListener): ClientAllowGuard => ({
    get active() {
      return active;
    },
    admitPeer(peerIp, trustedProxyPeer) {
      if (!active) return true;
      if (trustedProxyPeer) return true; // the request-level admitForwarded check follows
      const ip = typeof peerIp === "string" ? normalizeClientIp(peerIp) : undefined;
      if (ip === undefined) return deny(listener, "peer", "invalid-ip", CLIENT_DENY_INVALID_IP);
      if (implicit(ip) || explicit(ip)) return true;
      return deny(listener, "peer", "not-allowed", ip);
    },
    admitForwarded(input) {
      if (!active) return true;
      const ip = typeof input.clientIp === "string" ? normalizeClientIp(input.clientIp) : undefined;
      // Fail closed: an unusable XFF (absent flag is the caller's job to map to false) never admits.
      if (input.xffUsable !== true) return deny(listener, "forwarded", "xff-unusable", ip ?? CLIENT_DENY_INVALID_IP);
      if (ip === undefined) return deny(listener, "forwarded", "invalid-ip", CLIENT_DENY_INVALID_IP);
      if (implicit(ip) || explicit(ip)) return true;
      return deny(listener, "forwarded", "not-allowed", ip);
    },
    snapshot(): ClientAllowSnapshot {
      return {
        entries: [...entries],
        ...(active && entries.length === 0 ? { denyAll: true as const } : {}),
        ...(total > 0 ? { denied: { total, lastAt, lastIp } } : {}),
      };
    },
    onBurst(fn) {
      bursts.add(fn);
      return () => {
        bursts.delete(fn);
      };
    },
  });

  const base = view("lan");
  return Object.assign(base, {
    forListener: (listener: ClientAllowListener) => view(listener),
    bookkeeping: () => ({ ips: perIp.size, burst: deque.length }),
  });
}
