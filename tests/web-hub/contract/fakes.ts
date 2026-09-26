/**
 * W1 fake implementations of the LAN ports frozen in `hub/ports.ts` (plan
 * §11 落地清单 C: "LanStorePort / KdfPort / LoginLimiterPort / KdfAdmissionPort
 * / HostsPort 的 W1 假件只存在于 tests/web-hub/contract/fakes.ts（供 W2 各包的
 * 测试复用），不进 src/"). None of these are wired into any `src/` code in W1
 * (`lan-assembly.ts`'s stub throws before ever constructing a `LanFrontendDeps`);
 * they exist purely so W2's LS/LC/LD packages can write tests against the
 * frozen port shapes before their real implementations land.
 */
import { scryptSync } from "node:crypto";
import type {
  ConnGuard,
  ConnLease,
  HostSnapshot,
  HostsPort,
  HubLanConfig,
  KdfAdmissionPort,
  KdfPort,
  LanSessionRecord,
  LanStorePort,
  LanUserRecord,
  LoginLimiterPort,
} from "../../../src/web-hub/hub/ports.js";
import { canonicalHostKey } from "../../../src/web-hub/protocol/lan.js";

export interface FakeLanStore extends LanStorePort {
  /** Test-only introspection (not part of `LanStorePort`). */
  readonly usersByUsername: ReadonlyMap<string, LanUserRecord>;
  readonly sessionsBySidHash: ReadonlyMap<string, LanSessionRecord>;
}

export function fakeLanStore(): FakeLanStore {
  const users = new Map<string, LanUserRecord>();
  const sessions = new Map<string, LanSessionRecord>();
  let nextUserId = 1;
  let nextSid = 1;

  return {
    usersByUsername: users,
    sessionsBySidHash: sessions,

    async getUser(username) {
      return users.get(username);
    },

    async initialInfo() {
      for (const u of users.values()) {
        if (u.initialPassword === undefined) continue;
        const initialLogin =
          u.initialLoginIp !== undefined && u.initialLoginAt !== undefined
            ? { ip: u.initialLoginIp, at: u.initialLoginAt }
            : undefined;
        return {
          username: u.username,
          initialPassword: u.initialPassword,
          ...(initialLogin === undefined ? {} : { initialLogin }),
        };
      }
      return undefined;
    },

    async createSession(input) {
      const sidHash = `fake-sid-${nextSid++}`;
      sessions.set(sidHash, {
        userId: input.userId,
        epoch: input.epoch,
        boundOrigin: input.boundOrigin,
        expiresAt: input.now + 12 * 3_600_000,
        absoluteExpiresAt: input.now + 7 * 24 * 3_600_000,
      });
      return { sidHash };
    },

    async touchSession(sidHash) {
      return sessions.get(sidHash);
    },

    async deleteSession(sidHash) {
      sessions.delete(sidHash);
    },

    async deleteAllSessions(userId) {
      for (const [sidHash, s] of sessions) if (s.userId === userId) sessions.delete(sidHash);
    },

    async setPassword(input) {
      const existing = users.get(input.username);
      const now = Date.now();
      users.set(input.username, {
        id: existing?.id ?? nextUserId++,
        username: input.username,
        kdf: input.kdf,
        n: input.n,
        r: input.r,
        p: input.p,
        salt: input.salt,
        hash: input.hash,
        epoch: (existing?.epoch ?? 0) + 1,
        createdAt: existing?.createdAt ?? now,
        updatedAt: now,
      });
    },

    async markInitialLogin(username, ip, at) {
      const u = users.get(username);
      if (u !== undefined) users.set(username, { ...u, initialLoginIp: ip, initialLoginAt: at });
    },

    async purgeExpired(now) {
      let n = 0;
      for (const [sidHash, s] of sessions) {
        if (s.expiresAt <= now || s.absoluteExpiresAt <= now) {
          sessions.delete(sidHash);
          n++;
        }
      }
      return n;
    },
  };
}

/** Real scrypt under the hood (fast test params are the caller's job via `KdfParams`). */
export function fakeKdf(): KdfPort {
  return {
    async run(password, params) {
      return scryptSync(password, Buffer.from(params.salt), params.keyLen, {
        N: params.n,
        r: params.r,
        p: params.p,
        maxmem: 128 * params.n * params.r + 1024 * 1024,
      });
    },
  };
}

/** Always admits; W2's `ratelimit.ts` tests bring their own stricter fake/real implementation. */
export function fakeLoginLimiter(): LoginLimiterPort {
  return {
    admit: () => ({ ok: true }),
    fail: () => {},
    succeed: () => {},
    unlock: () => {},
  };
}

/** Always grants a no-op release; W2's `kdf-admission.ts` tests bring their own fair-scheduling fake. */
export function fakeKdfAdmission(): KdfAdmissionPort {
  return {
    async acquire() {
      return { ok: true, release: () => {} };
    },
  };
}

/** Computes a snapshot from `extraHosts`/`externalOrigins`/`trustProxyFrom` only (no `os.networkInterfaces()`). */
export function fakeHosts(overrides: Partial<HostSnapshot> = {}): HostsPort {
  return {
    compute(cfg: HubLanConfig): HostSnapshot {
      const hostKeys = new Set<string>();
      const omitted: { host: string; reason: import("../../../src/web-hub/protocol/lan.js").HostTokenRejectReason }[] =
        [];
      for (const h of cfg.extraHosts) {
        const key = canonicalHostKey(`${h}:${cfg.port}`, "http");
        if (key !== undefined) hostKeys.add(key);
      }
      return {
        gen: 1,
        hostKeys,
        externalOrigins: new Set(cfg.externalOrigins),
        trustProxyFrom: new Set(cfg.trustProxyFrom),
        omitted,
        computedAt: Date.now(),
        ...overrides,
      };
    },
  };
}

/**
 * Minimal but real §6.3 pool/eviction fake: two pools (direct / “proxy”, keyed
 * by `viaTrustedProxy`), an unauth-only eviction cap per pool, and a
 * monotonic `seq` tie-breaker (oldest `unauth` lease evicted first). Every
 * lease tracks its own category, so `enterLoginPending()`/`enterAuthed()`
 * make it ineligible for eviction and `release()` always decrements the
 * right pool regardless of how many other leases share the same `peerIp`.
 * LC's real `conn-guard.ts` (W2) adds the finer per-IP/per-proxy-address caps
 * and the two-level §6.3 selection rule; this fake only needs to satisfy the
 * frozen `ConnGuard` contract for other packages' tests.
 */
export function fakeConnGuard(opts: { unauthCapDirect?: number; unauthCapProxy?: number } = {}): ConnGuard {
  const capDirect = opts.unauthCapDirect ?? 64;
  const capProxy = opts.unauthCapProxy ?? 48;
  let nextSeq = 0;

  interface Entry {
    seq: number;
    category: "unauth" | "login-pending" | "authed";
  }
  const direct = new Map<number, Entry>();
  const proxy = new Map<number, Entry>();

  function poolFor(viaTrustedProxy: boolean): Map<number, Entry> {
    return viaTrustedProxy ? proxy : direct;
  }

  function unauthCount(pool: Map<number, Entry>): number {
    let n = 0;
    for (const e of pool.values()) if (e.category === "unauth") n++;
    return n;
  }

  function evictOldestUnauth(pool: Map<number, Entry>): boolean {
    let victimKey: number | undefined;
    let victim: Entry | undefined;
    for (const [key, e] of pool) {
      if (e.category !== "unauth") continue;
      if (victim === undefined || e.seq < victim.seq) {
        victimKey = key;
        victim = e;
      }
    }
    if (victimKey === undefined) return false;
    pool.delete(victimKey);
    return true;
  }

  return {
    admit({ peerIp, viaTrustedProxy }): ConnLease | undefined {
      const pool = poolFor(viaTrustedProxy);
      const cap = viaTrustedProxy ? capProxy : capDirect;
      if (unauthCount(pool) >= cap && !evictOldestUnauth(pool)) return undefined;
      const mySeq = nextSeq++;
      const entry: Entry = { seq: mySeq, category: "unauth" };
      pool.set(mySeq, entry);
      let released = false;
      return {
        peerIp,
        viaTrustedProxy,
        enterLoginPending: () => {
          if (pool.get(mySeq) === entry) entry.category = "login-pending";
        },
        enterAuthed: () => {
          if (pool.get(mySeq) === entry) entry.category = "authed";
        },
        release: () => {
          if (released) return;
          released = true;
          pool.delete(mySeq);
        },
      };
    },
  };
}
