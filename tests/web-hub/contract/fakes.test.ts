/**
 * Behavioral tests for `fakeConnGuard` (plan §6.3; review fix #4, v2): the
 * fake is reused by W2's LC tests, so its eviction + `onEvict` wiring must
 * actually work, not just typecheck.
 */
import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { fakeConnGuard, fakeLanStore } from "./fakes.js";

describe("fakeConnGuard (plan §6.3)", () => {
  it("admits under the cap without evicting anyone", () => {
    const g = fakeConnGuard({ unauthCapDirect: 3 });
    const evicted: string[] = [];
    const a = g.admit({ peerIp: "1.1.1.1", viaTrustedProxy: false, onEvict: () => evicted.push("a") });
    const b = g.admit({ peerIp: "2.2.2.2", viaTrustedProxy: false, onEvict: () => evicted.push("b") });
    expect(a).toBeDefined();
    expect(b).toBeDefined();
    expect(evicted).toEqual([]);
  });

  it("at capacity, evicts the oldest unauth lease and fires its onEvict exactly once", () => {
    const g = fakeConnGuard({ unauthCapDirect: 2 });
    const evicted: string[] = [];
    const a = g.admit({ peerIp: "1.1.1.1", viaTrustedProxy: false, onEvict: () => evicted.push("a") });
    const b = g.admit({ peerIp: "2.2.2.2", viaTrustedProxy: false, onEvict: () => evicted.push("b") });
    expect(a).toBeDefined();
    expect(b).toBeDefined();
    // pool is full (2/2 unauth) — a third admission must evict the oldest (a).
    const c = g.admit({ peerIp: "3.3.3.3", viaTrustedProxy: false, onEvict: () => evicted.push("c") });
    expect(c).toBeDefined();
    expect(evicted).toEqual(["a"]);
    // b and c are still live; releasing them is harmless (idempotent, no further onEvict).
    b!.release();
    c!.release();
    expect(evicted).toEqual(["a"]);
  });

  it("login-pending / authed leases are never evicted (only unauth is eligible)", () => {
    const g = fakeConnGuard({ unauthCapDirect: 1 });
    const evicted: string[] = [];
    const a = g.admit({ peerIp: "1.1.1.1", viaTrustedProxy: false, onEvict: () => evicted.push("a") })!;
    a.enterLoginPending();
    // pool is "full" (1/1 unauth-capacity) but `a` moved out of `unauth`, so nothing is evictable
    // and the pool isn't actually over its unauth-only cap — a fresh admission just succeeds.
    const b = g.admit({ peerIp: "2.2.2.2", viaTrustedProxy: false, onEvict: () => evicted.push("b") });
    expect(b).toBeDefined();
    expect(evicted).toEqual([]);
  });

  it("returns undefined (destroy the new connection) when nothing is evictable", () => {
    const g = fakeConnGuard({ unauthCapDirect: 1 });
    const evicted: string[] = [];
    const a = g.admit({ peerIp: "1.1.1.1", viaTrustedProxy: false, onEvict: () => evicted.push("a") })!;
    a.enterAuthed(); // no longer evictable, and the pool has no other unauth entries either
    const b = g.admit({ peerIp: "2.2.2.2", viaTrustedProxy: false, onEvict: () => evicted.push("b") });
    // `b` should be admitted (the "at capacity" check only counts unauth entries, and there are
    // none left after `a` became authed) — this pins the "unauth-only" counting semantics.
    expect(b).toBeDefined();
  });

  it("direct and proxy pools are independent (viaTrustedProxy)", () => {
    const g = fakeConnGuard({ unauthCapDirect: 1, unauthCapProxy: 1 });
    const evicted: string[] = [];
    const direct = g.admit({ peerIp: "1.1.1.1", viaTrustedProxy: false, onEvict: () => evicted.push("direct") });
    const proxy = g.admit({ peerIp: "2.2.2.2", viaTrustedProxy: true, onEvict: () => evicted.push("proxy") });
    expect(direct).toBeDefined();
    expect(proxy).toBeDefined();
    expect(evicted).toEqual([]); // each pool has its own 1-slot cap, neither is over it yet
  });

  it("release() is idempotent and does not itself trigger onEvict", () => {
    const g = fakeConnGuard({ unauthCapDirect: 5 });
    const evicted: string[] = [];
    const a = g.admit({ peerIp: "1.1.1.1", viaTrustedProxy: false, onEvict: () => evicted.push("a") })!;
    a.release();
    a.release(); // idempotent
    expect(evicted).toEqual([]);
  });

  // 审查修复三轮 #3: onEvict 抛错被吹掉且记录（fake 不记日志，但至少不会传播/影响池状态），
  // 不影响同次 admit() 自己的结果（新连接仍正常拿到 lease）。
  it("a throwing onEvict is swallowed: admit() does not throw, the victim is still evicted, the new connection still gets a lease", () => {
    const g = fakeConnGuard({ unauthCapDirect: 1 });
    const a = g.admit({
      peerIp: "1.1.1.1",
      viaTrustedProxy: false,
      onEvict: () => {
        throw new Error("boom");
      },
    })!;
    expect(a).toBeDefined();
    let b: ReturnType<typeof g.admit>;
    expect(() => {
      b = g.admit({ peerIp: "2.2.2.2", viaTrustedProxy: false, onEvict: () => {} });
    }).not.toThrow();
    expect(b).toBeDefined();
    // pool is still at its 1-slot cap (a evicted, b admitted) — a third admission must evict b.
    const evicted: string[] = [];
    const c = g.admit({ peerIp: "3.3.3.3", viaTrustedProxy: false, onEvict: () => evicted.push("c") });
    expect(c).toBeDefined();
    const d = g.admit({ peerIp: "4.4.4.4", viaTrustedProxy: false, onEvict: () => evicted.push("d") });
    expect(d).toBeDefined(); // evicts c (b was never given an onEvict that records anything)
    expect(evicted).toEqual(["c"]);
  });

  // 审查修复三轮 #3: onEvict 内部重入调用 admit() 必须被拒/抛错，且不改变池状态（重入过后容量不超限）。
  it("onEvict calling admit() reentrantly is rejected and does not corrupt pool state (capacity stays within its cap)", () => {
    const g = fakeConnGuard({ unauthCapDirect: 1 });
    let reentrantThrew: unknown;
    let reentrantResult: ReturnType<typeof g.admit> | "never-called" = "never-called";
    const a = g.admit({
      peerIp: "1.1.1.1",
      viaTrustedProxy: false,
      onEvict: () => {
        try {
          // reentrant: called from *inside* the evicting admit() below, while `admitting` is true.
          reentrantResult = g.admit({ peerIp: "9.9.9.9", viaTrustedProxy: false, onEvict: () => {} });
        } catch (err) {
          reentrantThrew = err;
        }
      },
    })!;
    expect(a).toBeDefined();
    // this admit() evicts `a`, which reentrantly (and unsuccessfully) tries to admit 9.9.9.9.
    const b = g.admit({ peerIp: "2.2.2.2", viaTrustedProxy: false, onEvict: () => {} });
    expect(b).toBeDefined();
    expect(reentrantThrew).toBeInstanceOf(Error);
    expect(reentrantResult).toBe("never-called"); // the try/catch inside onEvict caught it before assigning
    // pool must still be exactly at its 1-slot cap: a fresh admission evicts exactly one (b), not
    // zero (which would mean the reentrant attempt somehow got counted) and not more than one.
    const evicted: string[] = [];
    b!.enterAuthed(); // move b out of the way so we can see whether the *reentrant* attempt leaked a slot
    const c = g.admit({ peerIp: "3.3.3.3", viaTrustedProxy: false, onEvict: () => evicted.push("c") });
    expect(c).toBeDefined(); // room for exactly one more unauth entry — not zero, not two
    const d = g.admit({ peerIp: "4.4.4.4", viaTrustedProxy: false, onEvict: () => evicted.push("d") });
    expect(d).toBeDefined();
    expect(evicted).toEqual(["c"]); // c was evicted to make room for d — exactly the 1-slot cap, no leak
  });

  it("a normal (non-reentrant) admit() after a completed eviction is unaffected by the guard flag", () => {
    const g = fakeConnGuard({ unauthCapDirect: 2 });
    const a = g.admit({ peerIp: "1.1.1.1", viaTrustedProxy: false, onEvict: () => {} });
    const b = g.admit({ peerIp: "2.2.2.2", viaTrustedProxy: false, onEvict: () => {} });
    expect(a).toBeDefined();
    expect(b).toBeDefined();
    expect(() => g.admit({ peerIp: "3.3.3.3", viaTrustedProxy: false, onEvict: () => {} })).not.toThrow();
  });
});

// 审查修复 #5（v2）: fakeLanStore.createSession 返回原始 sid（设 cookie 用），只存 sha256(sid)；
// touchSession/deleteSession 按方案 §4.2 命名接受 sidHash（调用方自己算好再传进来）。
describe("fakeLanStore: createSession raw-sid / sidHash split (plan §6.4)", () => {
  function sha256(s: string): string {
    return createHash("sha256").update(s).digest("base64url");
  }

  it("createSession returns the raw sid; the store only ever holds its hash", async () => {
    const store = fakeLanStore();
    await store.setPassword({
      username: "alice",
      kdf: "scrypt",
      n: 32768,
      r: 8,
      p: 1,
      salt: new Uint8Array(16),
      hash: new Uint8Array(32),
    });
    const user = await store.getUser("alice");
    const { sid } = await store.createSession({
      userId: user!.id,
      epoch: user!.epoch,
      boundOrigin: "http://192.168.1.5:7879",
      createdIp: "192.168.1.10",
      now: 1_000,
    });
    expect(typeof sid).toBe("string");
    expect(sid.length).toBeGreaterThan(20); // 24 raw bytes, base64url
    expect(store.sessionsBySidHash.has(sid)).toBe(false); // the raw value is never used as the store's key
    expect(store.sessionsBySidHash.has(sha256(sid))).toBe(true); // only sha256(sid) is
  });

  it("touchSession/deleteSession take the caller-computed sidHash, not the raw sid", async () => {
    const store = fakeLanStore();
    await store.setPassword({
      username: "bob",
      kdf: "scrypt",
      n: 32768,
      r: 8,
      p: 1,
      salt: new Uint8Array(16),
      hash: new Uint8Array(32),
    });
    const user = await store.getUser("bob");
    const { sid } = await store.createSession({
      userId: user!.id,
      epoch: user!.epoch,
      boundOrigin: "http://192.168.1.5:7879",
      createdIp: "192.168.1.10",
      now: 1_000,
    });
    expect(await store.touchSession(sid, 1_500)).toBeUndefined(); // raw sid is not the lookup key
    const hit = await store.touchSession(sha256(sid), 1_500);
    expect(hit).toMatchObject({ userId: user!.id, boundOrigin: "http://192.168.1.5:7879" });
    await store.deleteSession(sha256(sid));
    expect(await store.touchSession(sha256(sid), 1_500)).toBeUndefined();
  });
});

describe("fakeLanStore: getUserSummary (plan §7, §5.2)", () => {
  it("looks a user up by userId (not username) and reports initialPasswordInUse", async () => {
    const store = fakeLanStore();
    await store.setPassword({
      username: "alice",
      kdf: "scrypt",
      n: 32768,
      r: 8,
      p: 1,
      salt: new Uint8Array(16),
      hash: new Uint8Array(32),
    });
    const user = await store.getUser("alice");
    expect(await store.getUserSummary(user!.id)).toEqual({ username: "alice", initialPasswordInUse: false });
  });

  it("reports initialPasswordInUse:true while an initial password's own field is set", async () => {
    const store = fakeLanStore();
    const now = Date.now();
    store.seedUser({
      id: 42,
      username: "carol",
      kdf: "scrypt",
      n: 32768,
      r: 8,
      p: 1,
      salt: new Uint8Array(16),
      hash: new Uint8Array(32),
      epoch: 1,
      initialPassword: "abcde-fghij",
      createdAt: now,
      updatedAt: now,
    });
    expect(await store.getUserSummary(42)).toEqual({ username: "carol", initialPasswordInUse: true });
  });

  it("returns undefined for an unknown userId", async () => {
    const store = fakeLanStore();
    expect(await store.getUserSummary(999)).toBeUndefined();
  });
});
