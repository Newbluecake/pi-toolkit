/**
 * W1 fake implementations of the LAN ports frozen in `hub/ports.ts` (plan
 * §11 落地清单 C: "LanStorePort / KdfPort / LoginLimiterPort / KdfAdmissionPort
 * / HostsPort 的 W1 假件只存在于 tests/web-hub/contract/fakes.ts（供 W2 各包的
 * 测试复用），不进 src/"). None of these are wired into any `src/` code in W1
 * (`lan-assembly.ts`'s stub throws before ever constructing a `LanFrontendDeps`);
 * they exist purely so W2's LS/LC/LD packages can write tests against the
 * frozen port shapes before their real implementations land.
 */
import { createHash, randomBytes, scryptSync } from "node:crypto";
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
  LanUserSummary,
  LoginLimiterPort,
} from "../../../src/web-hub/hub/ports.js";
import { canonicalHostKey } from "../../../src/web-hub/protocol/lan.js";

export interface FakeLanStore extends LanStorePort {
  /** Test-only introspection (not part of `LanStorePort`). */
  readonly usersByUsername: ReadonlyMap<string, LanUserRecord>;
  readonly sessionsBySidHash: ReadonlyMap<string, LanSessionRecord>;
  /** Test-only seed hook (not part of `LanStorePort`) — the port itself has no "set an initial
   * password" op (that is the hub's own bootstrap concern, outside W1's frozen surface). */
  seedUser(user: LanUserRecord): void;
}

export function fakeLanStore(): FakeLanStore {
  const users = new Map<string, LanUserRecord>();
  const sessions = new Map<string, LanSessionRecord>();
  let nextUserId = 1;

  function userById(userId: number): LanUserRecord | undefined {
    for (const u of users.values()) if (u.id === userId) return u;
    return undefined;
  }

  return {
    usersByUsername: users,
    sessionsBySidHash: sessions,
    seedUser: (user) => {
      users.set(user.username, user);
      nextUserId = Math.max(nextUserId, user.id + 1);
    },

    async getUser(username) {
      return users.get(username);
    },

    async getUserSummary(userId): Promise<LanUserSummary | undefined> {
      const u = userById(userId);
      if (u === undefined) return undefined;
      return { username: u.username, initialPasswordInUse: u.initialPassword !== undefined };
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
      // §6.4: only the hash is ever persisted; the *raw* id is generated here and returned once
      // (for the caller to set as the `pwh_lan` cookie) — the store itself never sees it again.
      const sid = randomBytes(24).toString("base64url");
      const sidHash = createHash("sha256").update(sid).digest("base64url");
      sessions.set(sidHash, {
        userId: input.userId,
        epoch: input.epoch,
        boundOrigin: input.boundOrigin,
        expiresAt: input.now + 12 * 3_600_000,
        absoluteExpiresAt: input.now + 7 * 24 * 3_600_000,
      });
      return { sid };
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
  // 审查修复三轮 #3: 重入护卫——只在一个顶层 admit() 的同步执行期间为 true（包含它同步触发的
  // evictOldestUnauth → onEvict 链路）；任何在这期间对 admit() 的再进入都拒。
  let admitting = false;

  interface Entry {
    seq: number;
    category: "unauth" | "login-pending" | "authed";
    onEvict: () => void;
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

  /**
   * 审查修复 #4（二轮）/ #3（三轮）: 淡汰时先从池中移除该条目（无论 onEvict 结果如何，条目都得移除），
   * 再调用它自己登记的 onEvict（一次）。onEvict 抛错或在内部重入调用 admit() 而抛错（本函数自己的
   * 重入护卫会抛）都在这里吹掉，不会继续传播到 admit()、不会重新池入池、也不会阻止同次
   * admit() 给新连接发 lease 或拒。
   */
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
    if (victimKey === undefined || victim === undefined) return false;
    pool.delete(victimKey);
    try {
      victim.onEvict();
    } catch {
      // Swallowed (a real implementation logs this) — must never propagate out of admit(),
      // must never affect pool state (the victim is already removed above either way), and
      // must never prevent the new connection that triggered this eviction from getting its
      // own lease-or-rejection per §6.3's normal rules.
    }
    return true;
  }

  return {
    admit(args): ConnLease | undefined {
      if (admitting) {
        // Non-reentrant (review fix round 3 #3): onEvict must never call admit() itself, directly
        // or indirectly, while still inside the evicting admit() call. Throwing here (rather than
        // silently succeeding) is itself what "rejected" means for this port — the caller's own
        // onEvict is expected to let this propagate, which the evicting admit()'s own
        // evictOldestUnauth try/catch above swallows, leaving pool state untouched by the
        // reentrant attempt.
        throw new Error("fakeConnGuard: admit() called reentrantly from within onEvict()");
      }
      admitting = true;
      try {
        const { peerIp, viaTrustedProxy, onEvict } = args;
        const pool = poolFor(viaTrustedProxy);
        const cap = viaTrustedProxy ? capProxy : capDirect;
        if (unauthCount(pool) >= cap && !evictOldestUnauth(pool)) return undefined;
        const mySeq = nextSeq++;
        const entry: Entry = { seq: mySeq, category: "unauth", onEvict };
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
      } finally {
        admitting = false;
      }
    },
  };
}
