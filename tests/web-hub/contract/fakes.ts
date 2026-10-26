/**
 * W1 fake implementations of the LAN ports frozen in `hub/ports.ts` (plan
 * §11 落地清单 C: "LanStorePort / KdfPort / LoginLimiterPort / KdfAdmissionPort
 * / HostsPort 的 W1 假件只存在于 tests/web-hub/contract/fakes.ts（供 W2 各包的
 * 测试复用），不进 src/"). None of these are wired into any `src/` code in W1
 * (`lan-assembly.ts`'s stub throws before ever constructing a `LanFrontendDeps`);
 * they exist purely so W2's LS/LC/LD packages can write tests against the
 * frozen port shapes before their real implementations land.
 *
 * web-hub-spawn plan §SP1 adds the spawn ports' fakes here under the same rule:
 * SP8 develops against `fakeFirstPromptRouter` (and SP7 against
 * `fakeSpawnRegistry`) before the real hub assembly (SP10) exists.
 */
import { createHash, randomBytes, scryptSync } from "node:crypto";
import type {
  AgentView,
  ConnGuard,
  ConnLease,
  HostSnapshot,
  HostsPort,
  HubEvent,
  HubLanConfig,
  KdfAdmissionPort,
  KdfPort,
  LanSessionRecord,
  LanSessionListRecord,
  Lan2faState,
  PortOptions,
  LanStorePort,
  LanUserRecord,
  LanUserSummary,
  LoginLimiterPort,
} from "../../../src/web-hub/hub/ports.js";
import type { FirstPromptRouterPort, SpawnRegistryPort } from "../../../src/web-hub/hub/spawn/ports.js";
import type { CmdFrame, CmdResultBody, CmdResultFrame } from "../../../src/web-hub/protocol/messages.js";
import { LAN_2FA_LIMITS, NEW_IP_WINDOW_MS, normalizeRecoveryCode } from "../../../src/web-hub/protocol/lan-2fa.js";
import { hashSid } from "../../../src/web-hub/hub/sid-hash.js";
import { canonicalHostKey } from "../../../src/web-hub/protocol/lan.js";

export interface FakeLanStore extends LanStorePort {
  /** Test-only introspection (not part of `LanStorePort`). */
  readonly usersByUsername: ReadonlyMap<string, LanUserRecord>;
  readonly sessionsBySidHash: ReadonlyMap<string, LanSessionRecord>;
  /** Test-only seed hook (not part of `LanStorePort`) — the port itself has no "set an initial
   * password" op (that is the hub's own bootstrap concern, outside W1's frozen surface). */
  seedUser(user: LanUserRecord): void;
  /**
   * Mirrors the concrete `LanStore`'s `onUnavailable`/`unavailable` (plan §4.2's db-client.ts,
   * not part of the frozen `LanStorePort`) so `hub/http.ts`'s duck-typed fail-closed subscription
   * (LC review-fix P1, §4.1) can be exercised against this fake without a real SQLite backend —
   * `simulateUnavailable()` is the test-only trigger a real db-client.ts would reach only after
   * its own 1s→5s→30s backoff exhausts 4 restarts in a rolling 10-minute window.
   */
  onUnavailable(cb: (reason: "db-unavailable") => void): () => void;
  simulateUnavailable(): void;
}

export interface FakeLanStoreOptions {
  idleMs?: number;
  /** Deterministic verifier seam; absent => rejects every TOTP (never an always-pass stub). */
  totpStep?: (secretB32: string, code: string, now: number) => number | undefined;
  /** Before the atomic op, for races/deadlines. An abort AFTER dispatch does not cancel the op. */
  beforeOp?: (op: keyof LanStorePort) => Promise<void>;
}
export function fakeLanStore(options: FakeLanStoreOptions = {}): FakeLanStore {
  const users = new Map<string, LanUserRecord>();
  const sessions = new Map<string, LanSessionListRecord>();
  const ipsByUser = new Map<number, Map<string, { firstAt: number; lastAt: number }>>();
  interface Factor {
    gen: number;
    totpSecret?: string;
    lastStep?: number;
    feishu: boolean;
    salt: string;
    codes: Map<string, number | undefined>;
  }
  const factors = new Map<number, Factor>();
  const pending = new Map<number, { secret: string; expiresAt: number; gen: number }>();
  const idleMs = options.idleMs ?? 12 * 3_600_000;
  function digest(s: string): string {
    return createHash("sha256").update(s).digest("hex");
  }
  function freshFactor(): Factor {
    return { gen: 0, feishu: false, salt: randomBytes(16).toString("hex"), codes: new Map() };
  }
  function enrolled(f: Factor | undefined): boolean {
    return !!f && (!!f.totpSecret || f.feishu);
  }
  function recovery(f: Factor): string[] {
    f.salt = randomBytes(16).toString("hex");
    f.codes.clear();
    const alphabet = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";
    const codes = new Set<string>();
    while (codes.size < 10) codes.add([...randomBytes(12)].map((b) => alphabet[b & 31]!).join(""));
    for (const code of codes) f.codes.set(digest(f.salt + code), undefined);
    return [...codes];
  }
  function addSession(input: {
    userId: number;
    epoch: number;
    boundOrigin: string;
    createdIp: string;
    now: number;
    ua?: string;
    method?: "password" | "totp" | "feishu" | "recovery";
  }) {
    const sid = randomBytes(24).toString("base64url");
    const sidHash = hashSid(sid);
    sessions.set(sidHash, {
      userId: input.userId,
      epoch: input.epoch,
      boundOrigin: input.boundOrigin,
      sidHash,
      createdAt: input.now,
      lastSeenAt: input.now,
      createdIp: input.createdIp,
      method: input.method ?? "password",
      expiresAt: input.now + idleMs,
      absoluteExpiresAt: input.now + 7 * 24 * 3_600_000,
      ...(input.ua === undefined ? {} : { ua: input.ua.slice(0, 512) }),
    });
    return { sid };
  }
  let nextUserId = 1;
  const unavailableListeners = new Set<(reason: "db-unavailable") => void>();

  function userById(userId: number): LanUserRecord | undefined {
    for (const u of users.values()) if (u.id === userId) return u;
    return undefined;
  }

  function untrustIps(userId: number, ips: string[], keepIp: string): boolean {
    if (ips.length > 128) throw new Error("E_BAD_REQUEST");
    for (const ip of ips) if (ip !== keepIp) ipsByUser.get(userId)?.delete(ip);
    return ips.includes(keepIp);
  }
  const store: FakeLanStore = {
    usersByUsername: users,
    sessionsBySidHash: sessions,
    seedUser: (user) => {
      users.set(user.username, user);
      nextUserId = Math.max(nextUserId, user.id + 1);
    },
    onUnavailable: (cb) => {
      unavailableListeners.add(cb);
      return () => unavailableListeners.delete(cb);
    },
    simulateUnavailable: () => {
      for (const cb of unavailableListeners) cb("db-unavailable");
    },

    async listUsers(now) {
      const rows = [...users.values()].sort((a, b) => a.id - b.id);
      if (rows.length > 256) throw new Error("E_LIMIT: too many LAN accounts");
      return rows.map((u, i) => ({
        username: u.username,
        primary: i === 0,
        twofa: enrolled(factors.get(u.id)),
        liveSessions: [...sessions.values()].filter(
          (s) =>
            s.userId === u.id &&
            s.epoch === u.epoch &&
            s.expiresAt > now &&
            s.absoluteExpiresAt > now &&
            s.lastSeenAt > now - idleMs,
        ).length,
      }));
    },
    async deleteUser(username) {
      const user = users.get(username);
      if (!user) return { ok: false, reason: "not-found" };
      if (users.size <= 1) return { ok: false, reason: "last-user" };
      if (user.id === Math.min(...[...users.values()].map((u) => u.id))) return { ok: false, reason: "primary" };
      users.delete(username);
      for (const [hash, s] of sessions) if (s.userId === user.id) sessions.delete(hash);
      factors.delete(user.id);
      pending.delete(user.id);
      ipsByUser.delete(user.id);
      return { ok: true, userId: user.id };
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
      for (const u of [...users.values()].sort((a, b) => a.id - b.id)) {
        const initialLogin =
          u.initialLoginIp !== undefined && u.initialLoginAt !== undefined
            ? { ip: u.initialLoginIp, at: u.initialLoginAt }
            : undefined;
        return {
          username: u.username,
          ...(u.initialPassword === undefined ? {} : { initialPassword: u.initialPassword }),
          ...(initialLogin === undefined ? {} : { initialLogin }),
        };
      }
      return undefined;
    },

    async createSession(input) {
      return addSession(input);
    },
    async createSessionChecked(input) {
      const user = userById(input.userId);
      if (
        !user ||
        user.epoch !== input.expectedEpoch ||
        (factors.get(input.userId)?.gen ?? 0) !== input.expectedFactorGen
      )
        return { ok: false, reason: "stale" };
      const { sid } = addSession({ ...input, epoch: input.expectedEpoch });
      const live = [...sessions.values()]
        .filter(
          (s) =>
            s.userId === input.userId &&
            s.expiresAt > input.now &&
            s.absoluteExpiresAt > input.now &&
            s.lastSeenAt > input.now - idleMs,
        )
        .sort((a, b) => a.lastSeenAt - b.lastSeenAt);
      const evicted = live.slice(0, Math.max(0, live.length - 32)).map((s) => s.sidHash);
      for (const hash of evicted) sessions.delete(hash);
      return { ok: true, sid, evicted };
    },
    async listSessions(userId, now) {
      return [...sessions.values()]
        .filter(
          (s) => s.userId === userId && s.expiresAt > now && s.absoluteExpiresAt > now && s.lastSeenAt > now - idleMs,
        )
        .map((s) => ({ ...s }));
    },
    async deleteSessionsExcept(userId, keepSidHash, opts) {
      const hashes = [...sessions]
        .filter(([hash, s]) => s.userId === userId && hash !== keepSidHash)
        .map(([hash]) => hash);
      const deleted = hashes.slice(0, 64);
      const ips = deleted.flatMap((hash) => {
        const s = sessions.get(hash)!;
        return [s.createdIp, ...(s.lastIp === undefined ? [] : [s.lastIp])];
      });
      const sharedIpKept = opts?.keepIp === undefined ? undefined : untrustIps(userId, ips, opts.keepIp);
      for (const hash of deleted) sessions.delete(hash);
      return { deleted, more: hashes.length > 64, ...(sharedIpKept === undefined ? {} : { sharedIpKept }) };
    },
    async noteLoginIp(userId, ip, now, opts) {
      const session = opts?.sidHash === undefined ? undefined : sessions.get(opts.sidHash);
      if (
        opts?.sidHash !== undefined &&
        (!session || session.userId !== userId || session.epoch !== userById(userId)?.epoch)
      )
        return { wasKnown: false };
      if (!userById(userId)) throw new Error("unknown user");
      const ips = ipsByUser.get(userId) ?? new Map<string, { firstAt: number; lastAt: number }>();
      ipsByUser.set(userId, ips);
      const old = ips.get(ip);
      const wasKnown = old !== undefined && old.lastAt > now - NEW_IP_WINDOW_MS;
      ips.delete(ip);
      ips.set(ip, { firstAt: old?.firstAt ?? now, lastAt: now });
      if (ips.size > 256) {
        const oldest = [...ips].sort((a, b) => a[1].lastAt - b[1].lastAt)[0]!;
        ips.delete(oldest[0]);
      }
      return { wasKnown };
    },
    async isKnownIp(userId, ip, now, windowMs) {
      const row = ipsByUser.get(userId)?.get(ip);
      return row !== undefined && row.lastAt > now - windowMs;
    },
    async knownIpCount(userId, now, windowMs) {
      return [...(ipsByUser.get(userId)?.values() ?? [])].filter((v) => v.lastAt > now - windowMs).length;
    },
    async forgetLoginIps() {
      ipsByUser.clear();
      for (const factor of factors.values()) factor.gen++;
    },
    async get2faState(userId): Promise<Lan2faState> {
      const f = factors.get(userId);
      return {
        state: enrolled(f) ? "enrolled" : "none",
        totp: !!f?.totpSecret,
        feishu: f?.feishu ?? false,
        recoveryLeft: f ? [...f.codes.values()].filter((v) => v === undefined).length : 0,
        factorGen: f?.gen ?? 0,
      };
    },
    async beginTotp(input) {
      const f = factors.get(input.userId);
      if (f?.totpSecret && !input.replace) throw new Error("E_2FA_ENROLLED");
      const alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";
      const secret = [...randomBytes(32)].map((b) => alphabet[b & 31]!).join("");
      pending.set(input.userId, { secret, expiresAt: input.now + LAN_2FA_LIMITS.challengeMs, gen: f?.gen ?? 0 });
      return { secretB32: secret, otpauthUri: `otpauth://totp/pi-webhub?secret=${secret}&issuer=pi-webhub` };
    },
    async commitTotp(input) {
      const p = pending.get(input.userId),
        f = factors.get(input.userId) ?? freshFactor();
      if (!p || p.expiresAt <= input.now) return { ok: false, reason: "none" };
      if (input.expectedGen !== f.gen || p.gen !== f.gen) return { ok: false, reason: "stale" };
      const step = options.totpStep?.(p.secret, input.code, input.now);
      if (step === undefined || !/^[0-9]{6}$/.test(input.code)) return { ok: false, reason: "bad" };
      const first = !enrolled(f);
      f.totpSecret = p.secret;
      f.lastStep = step;
      f.gen++;
      factors.set(input.userId, f);
      pending.delete(input.userId);
      if (first) ipsByUser.delete(input.userId);
      return { ok: true, recoveryCodes: f.codes.size === 0 ? recovery(f) : [] };
    },
    async verifyTotp(input) {
      const f = factors.get(input.userId);
      if ((f?.gen ?? 0) !== input.expectedGen) return { ok: false, reason: "stale" };
      if (!f?.totpSecret) return { ok: false, reason: "none" };
      const step = options.totpStep?.(f.totpSecret, input.code, input.now);
      if (step === undefined || !/^[0-9]{6}$/.test(input.code)) return { ok: false, reason: "bad" };
      if (step <= (f.lastStep ?? -1)) return { ok: false, reason: "replay" };
      f.lastStep = step;
      return { ok: true };
    },
    async consumeRecovery(input) {
      const f = factors.get(input.userId);
      if ((f?.gen ?? 0) !== input.expectedGen) return { ok: false, reason: "stale" };
      if (!enrolled(f) || !f) return { ok: false, reason: "none" };
      const code = normalizeRecoveryCode(input.code),
        hash = code === undefined ? "" : digest(f.salt + code);
      if (!f.codes.has(hash)) return { ok: false, reason: "bad" };
      if (f.codes.get(hash) !== undefined) return { ok: false, reason: "replay" };
      f.codes.set(hash, input.now);
      return { ok: true, recoveryLeft: [...f.codes.values()].filter((v) => v === undefined).length };
    },
    async setFeishu2fa(input) {
      const f = factors.get(input.userId) ?? freshFactor(),
        first = !enrolled(f) && input.on;
      f.feishu = input.on;
      f.gen++;
      if (!enrolled(f)) f.codes.clear();
      factors.set(input.userId, f);
      if (first) {
        ipsByUser.delete(input.userId);
        return { recoveryCodes: recovery(f) };
      }
      return {};
    },
    async regenRecovery(userId) {
      const f = factors.get(userId);
      if (!f || !enrolled(f)) throw new Error("E_2FA_NONE");
      f.gen++;
      return { recoveryCodes: recovery(f) };
    },
    async reset2fa(userId) {
      const f = freshFactor();
      f.gen = (factors.get(userId)?.gen ?? 0) + 1;
      factors.set(userId, f);
      pending.delete(userId);
    },
    async touchSession(sidHash, now, opts) {
      const s = sessions.get(sidHash),
        u = s ? userById(s.userId) : undefined;
      if (
        !s ||
        !u ||
        s.epoch !== u.epoch ||
        s.expiresAt <= now ||
        s.absoluteExpiresAt <= now ||
        s.lastSeenAt <= now - idleMs
      )
        return undefined;
      if (now - s.lastSeenAt >= 60_000) {
        s.lastSeenAt = now;
        s.expiresAt = Math.min(now + idleMs, s.absoluteExpiresAt);
        if (opts?.ip !== undefined) s.lastIp = opts.ip;
      }
      return {
        userId: s.userId,
        epoch: s.epoch,
        boundOrigin: s.boundOrigin,
        expiresAt: s.expiresAt,
        absoluteExpiresAt: s.absoluteExpiresAt,
      };
    },

    async deleteSession(sidHash) {
      sessions.delete(sidHash);
    },

    async revokeSession(userId, sidHash, keepIp) {
      const s = sessions.get(sidHash);
      if (!s || s.userId !== userId) return { sharedIpKept: false };
      const sharedIpKept = untrustIps(userId, [s.createdIp, ...(s.lastIp === undefined ? [] : [s.lastIp])], keepIp);
      sessions.delete(sidHash);
      return { sharedIpKept };
    },
    async untrustLoginIps(userId, ips, keepIp) {
      untrustIps(userId, ips, keepIp);
    },
    async deleteAllSessions(userId) {
      for (const [sidHash, s] of sessions) if (s.userId === userId) sessions.delete(sidHash);
    },

    async setPassword(input) {
      const existing = users.get(input.username);
      const now = Date.now();
      if (existing) for (const [hash, s] of sessions) if (s.userId === existing.id) sessions.delete(hash);
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
  if (options.beforeOp) {
    const before = options.beforeOp;
    // Test-only proxy preserves all typed signatures and gives C deadline/race latches.
    return new Proxy(store, {
      get(target, key, receiver) {
        const value = Reflect.get(target, key, receiver) as unknown;
        if (
          typeof key !== "string" ||
          typeof value !== "function" ||
          !securityFakeOps.includes(key as keyof LanStorePort)
        )
          return value;
        return async (...args: unknown[]) => {
          const opts = args.at(-1) as PortOptions | undefined;
          if (opts?.signal?.aborted) throw new Error("E_ABORTED");
          await before(key as keyof LanStorePort);
          return Reflect.apply(value, target, args);
        };
      },
    });
  }
  return store;
}
const securityFakeOps: readonly (keyof LanStorePort)[] = [
  "listUsers",
  "deleteUser",
  "getUser",
  "getUserSummary",
  "initialInfo",
  "createSession",
  "touchSession",
  "deleteSession",
  "revokeSession",
  "untrustLoginIps",
  "deleteAllSessions",
  "setPassword",
  "markInitialLogin",
  "purgeExpired",
  "createSessionChecked",
  "listSessions",
  "deleteSessionsExcept",
  "noteLoginIp",
  "isKnownIp",
  "knownIpCount",
  "get2faState",
  "verifyTotp",
  "consumeRecovery",
  "beginTotp",
  "commitTotp",
  "setFeishu2fa",
  "regenRecovery",
  "reset2fa",
  "forgetLoginIps",
];

/** Real scrypt under the hood (fast test params are the caller's job via `KdfParams`). */
export function fakeKdf(): KdfPort {
  const derive = (password: string, params: Parameters<KdfPort["run"]>[1]): Uint8Array =>
    scryptSync(password, Buffer.from(params.salt), params.keyLen, {
      N: params.n,
      r: params.r,
      p: params.p,
      maxmem: 128 * params.n * params.r + 1024 * 1024,
    });
  return {
    async run(password, params) {
      return derive(password, params);
    },
    // #66: same contract as the real pool — the REAL result is returned after the compensation ran.
    async runPadded(password, params, pad) {
      const real = derive(password, params);
      derive(password, pad);
      return real;
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
          leaveLoginPending: () => {
            if (pool.get(mySeq) === entry && entry.category === "login-pending") entry.category = "unauth";
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

// ---------------------------------------------------------------------------
// web-hub-spawn plan §SP1: spawn port fakes (same rule as the LAN fakes above —
// SP7/SP8 tests develop against these before SP10's real assembly exists).
// ---------------------------------------------------------------------------

export interface FakeSpawnRegistry extends SpawnRegistryPort {
  /** Test-only seed hook (not part of `SpawnRegistryPort`): registers an agent view + its caps. */
  seedAgent(
    key: string,
    over?: { pid?: number; cwd?: string; state?: "live" | "stale"; caps?: readonly string[] },
  ): void;
  /** Test-only: remove a seeded agent (view AND caps). */
  dropAgent(key: string): void;
  /** Test-only: set/replace/clear an agent's caps (`getCaps` reads this). */
  setCaps(key: string, caps: readonly string[] | undefined): void;
  /** Every event `publish()` ever saw (bus subscribers included) — test introspection. */
  readonly events: readonly HubEvent[];
}

function spawnAgentView(key: string, over: { pid?: number; cwd?: string; state?: "live" | "stale" }): AgentView {
  const pid = over.pid ?? 5151;
  return {
    agentKey: key,
    kind: "rpc",
    pid,
    cwd: over.cwd ?? "/tmp/work",
    state: over.state ?? "live",
    pluginVersion: "1.2.3",
    outdated: false,
    prompts: [],
    agentId: { pid, nonce: "nonceAAAAAAAAAAAAAAA" },
    connectedAt: 0,
    lastFrameAt: 0,
    seq: 0,
  };
}

/** Minimal but real: views + caps maps, a synchronous fan-out bus, publish recorded in `events`. */
export function fakeSpawnRegistry(): FakeSpawnRegistry {
  const views = new Map<string, AgentView>();
  const caps = new Map<string, readonly string[]>();
  const events: HubEvent[] = [];
  const listeners = new Set<(e: HubEvent) => void>();

  const port = {
    list: () => [...views.values()],
    get: (agentKey: string) => views.get(agentKey),
    bus: {
      subscribe: (fn: (e: HubEvent) => void) => {
        listeners.add(fn);
        return () => listeners.delete(fn);
      },
    },
    publish: (e: HubEvent) => {
      events.push(e);
      for (const fn of listeners) fn(e);
    },
    getCaps: (agentKey: string) => caps.get(agentKey),
  } satisfies SpawnRegistryPort;

  return {
    ...port,
    events,
    seedAgent: (key, over = {}) => {
      views.set(key, spawnAgentView(key, over));
      if (over.caps !== undefined) caps.set(key, over.caps);
    },
    dropAgent: (key) => {
      views.delete(key);
      caps.delete(key);
    },
    setCaps: (key, next) => {
      if (next === undefined) caps.delete(key);
      else caps.set(key, next);
    },
  };
}

export interface FakeFirstPromptRouter extends FirstPromptRouterPort {
  /** Every EXECUTED request (a same-id replay never lands here — it answers `dup`). */
  readonly requests: ReadonlyArray<{ frame: CmdFrame; agentKey: string }>;
  /** Queue a result body for the NEXT new id (FIFO); an empty queue answers the ok default. */
  queueResult(body: CmdResultBody): void;
}

/**
 * Minimal but real §4.6 semantics: an idempotency ledger keyed `agentKey|id` — the first request
 * for a key EXECUTES (recorded in `requests`, answered from the queued-result FIFO or the ok
 * default), any replay of the same key answers `{ ok: true, dup: true, data: <same> }` without
 * executing again. This is the "agent 台账同 id 只执行一次" property SP8's tests lean on;
 * `rid` is echoed back from the frame like the real router does.
 */
export function fakeFirstPromptRouter(): FakeFirstPromptRouter {
  const requests: Array<{ frame: CmdFrame; agentKey: string }> = [];
  const queued: CmdResultBody[] = [];
  const ledger = new Map<string, CmdResultBody>();

  const port = {
    request: async (frame: CmdFrame, agentKey: string): Promise<CmdResultFrame> => {
      const key = `${agentKey}|${frame.id}`;
      const done = ledger.get(key);
      if (done !== undefined && done.ok) {
        return { t: "cmd_result", rid: frame.rid, id: frame.id, ok: true, dup: true, data: done.data };
      }
      const body = queued.shift() ?? { ok: true, data: { op: "prompt" as const, delivery: "observed" as const } };
      ledger.set(key, body);
      requests.push({ frame, agentKey });
      return { t: "cmd_result", rid: frame.rid, id: frame.id, ...body };
    },
  } satisfies FirstPromptRouterPort;

  return { ...port, requests, queueResult: (body) => void queued.push(body) };
}
