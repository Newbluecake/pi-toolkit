/**
 * `ConnGuard` implementation (plan §6.3, LC): two independent pools — a flat
 * "direct" pool and a per-trusted-proxy-address "proxy" pool (§6.3 "一个代理
 * 后面的恶意客户端最多耗尽代理池，直连用户不受影响" — each distinct trusted
 * peer address gets its *own* 48-unauth/128-total budget, pools never share
 * capacity across trusted addresses). Selection/eviction is entirely
 * synchronous (no `await` anywhere in `admit()`), matching `onEvict`'s frozen
 * contract in `hub/ports.ts` (synchronous-in-turn, non-reentrant,
 * exception-safe — enforced here with the same `admitting` reentrancy guard
 * `tests/web-hub/contract/fakes.ts`'s `fakeConnGuard` uses).
 *
 * §6.3's three per-scope caps, all checked before any eviction is attempted:
 *   - "总连接" (any category, incl. `authed`): 32/direct-IP, 128/proxy-address
 *     — hard reject (destroy the *new* connection), never evicts anything
 *     (an `authed` connection is never evictable regardless).
 *   - "未认证连接" (`unauth` + `login-pending` combined) per-IP: 8 for the
 *     direct pool only (the proxy pool has no address-internal subdivision,
 *     since the pool key already *is* one address) — hard reject, no evict.
 *   - "未认证连接" pool-wide: 64 direct / 48 per proxy address — this is the
 *     one case that runs the §6.3 eviction algorithm (destroy the evicted
 *     lease's own connection via its `onEvict`, then admit the new one).
 * A global cap (`maxConnections`, the sum across both pools incl. `authed`)
 * is a hard reject too — never evicts.
 */
import type { ConnGuard, ConnLease } from "./ports.js";

export const CONN_GUARD = {
  directTotalPerIp: 32,
  directUnauthPoolCap: 64,
  directUnauthPerIpCap: 8,
  proxyTotalPerAddr: 128,
  proxyUnauthPoolCap: 48,
  maxConnections: 256,
} as const;

type Category = "unauth" | "login-pending" | "authed";

interface Rec {
  seq: number;
  peerIp: string;
  viaTrustedProxy: boolean;
  category: Category;
  onEvict: () => void;
}

export function createConnGuard(
  opts: {
    directTotalPerIp?: number;
    directUnauthPoolCap?: number;
    directUnauthPerIpCap?: number;
    proxyTotalPerAddr?: number;
    proxyUnauthPoolCap?: number;
    maxConnections?: number;
    onEvictError?: (err: unknown) => void;
  } = {},
): ConnGuard {
  const directTotalPerIp = opts.directTotalPerIp ?? CONN_GUARD.directTotalPerIp;
  const directUnauthPoolCap = opts.directUnauthPoolCap ?? CONN_GUARD.directUnauthPoolCap;
  const directUnauthPerIpCap = opts.directUnauthPerIpCap ?? CONN_GUARD.directUnauthPerIpCap;
  const proxyTotalPerAddr = opts.proxyTotalPerAddr ?? CONN_GUARD.proxyTotalPerAddr;
  const proxyUnauthPoolCap = opts.proxyUnauthPoolCap ?? CONN_GUARD.proxyUnauthPoolCap;
  const maxConnections = opts.maxConnections ?? CONN_GUARD.maxConnections;

  const records = new Map<number, Rec>();
  let nextSeq = 0;
  let admitting = false;

  function directRecords(): Rec[] {
    const out: Rec[] = [];
    for (const r of records.values()) if (!r.viaTrustedProxy) out.push(r);
    return out;
  }

  function proxyRecordsFor(addr: string): Rec[] {
    const out: Rec[] = [];
    for (const r of records.values()) if (r.viaTrustedProxy && r.peerIp === addr) out.push(r);
    return out;
  }

  function destroyVictim(victim: Rec): void {
    records.delete(victim.seq);
    try {
      victim.onEvict();
    } catch (err) {
      opts.onEvictError?.(err);
    }
  }

  /** §6.3 selection rule ①②③, scoped to one pool's `unauth`-category records. `oneIpPool` is
   * true for the proxy pool (skips rule ① — there is only ever one address in that pool). */
  function evictOldestUnauth(unauthRecs: Rec[], oneIpPool: boolean): boolean {
    if (unauthRecs.length === 0) return false; // rule ③ (theoretically unreachable per §6.3)
    if (!oneIpPool) {
      const byIp = new Map<string, Rec[]>();
      for (const r of unauthRecs) {
        const arr = byIp.get(r.peerIp);
        if (arr === undefined) byIp.set(r.peerIp, [r]);
        else arr.push(r);
      }
      let bestIp: string | undefined;
      let bestArr: Rec[] | undefined;
      let bestMinSeq = Infinity;
      for (const [ip, arr] of byIp) {
        if (arr.length < 2) continue;
        const minSeq = Math.min(...arr.map((r) => r.seq));
        if (
          bestArr === undefined ||
          arr.length > bestArr.length ||
          (arr.length === bestArr.length && minSeq < bestMinSeq)
        ) {
          bestIp = ip;
          bestArr = arr;
          bestMinSeq = minSeq;
        }
      }
      if (bestIp !== undefined && bestArr !== undefined) {
        destroyVictim(bestArr.reduce((a, b) => (a.seq < b.seq ? a : b)));
        return true;
      }
    }
    destroyVictim(unauthRecs.reduce((a, b) => (a.seq < b.seq ? a : b)));
    return true;
  }

  function admit(args: { peerIp: string; viaTrustedProxy: boolean; onEvict: () => void }): ConnLease | undefined {
    if (admitting) {
      throw new Error("conn-guard: admit() called reentrantly from within onEvict()");
    }
    admitting = true;
    try {
      if (records.size >= maxConnections) return undefined;

      const { peerIp, viaTrustedProxy, onEvict } = args;
      if (!viaTrustedProxy) {
        const ipRecs = directRecords().filter((r) => r.peerIp === peerIp);
        if (ipRecs.length >= directTotalPerIp) return undefined;
        const ipUnauthPending = ipRecs.filter((r) => r.category !== "authed").length;
        if (ipUnauthPending >= directUnauthPerIpCap) return undefined;
        const poolUnauthPending = directRecords().filter((r) => r.category !== "authed").length;
        if (poolUnauthPending >= directUnauthPoolCap) {
          const unauthOnly = directRecords().filter((r) => r.category === "unauth");
          if (!evictOldestUnauth(unauthOnly, false)) return undefined;
        }
      } else {
        const addrRecs = proxyRecordsFor(peerIp);
        if (addrRecs.length >= proxyTotalPerAddr) return undefined;
        const addrUnauthPending = addrRecs.filter((r) => r.category !== "authed").length;
        if (addrUnauthPending >= proxyUnauthPoolCap) {
          const unauthOnly = addrRecs.filter((r) => r.category === "unauth");
          if (!evictOldestUnauth(unauthOnly, true)) return undefined;
        }
      }

      const seq = nextSeq++;
      const rec: Rec = { seq, peerIp, viaTrustedProxy, category: "unauth", onEvict };
      records.set(seq, rec);
      let released = false;
      return {
        peerIp,
        viaTrustedProxy,
        enterLoginPending: () => {
          if (records.get(seq) === rec) rec.category = "login-pending";
        },
        enterAuthed: () => {
          if (records.get(seq) === rec) rec.category = "authed";
        },
        leaveLoginPending: () => {
          if (records.get(seq) === rec && rec.category === "login-pending") rec.category = "unauth";
        },
        release: () => {
          if (released) return;
          released = true;
          records.delete(seq);
        },
      };
    } finally {
      admitting = false;
    }
  }

  return { admit };
}
