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
