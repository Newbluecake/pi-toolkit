import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { validateHeaderValue } from "node:http";
import { describe, expect, it, vi } from "vitest";
import type { AuthIdentity } from "../../../../src/web-hub/hub/ports.js";
import { createAuthRevokeBus } from "../../../../src/web-hub/hub/auth-revoke.js";
import {
  createProxySessionStore,
  type ProxyMintCodeResult,
  type ProxyExchangeResult,
  type ProxyRevokeSelector,
} from "../../../../src/web-hub/hub/proxy/sessions.js";
import {
  PROXY_CODE_TTL_MS,
  PROXY_CODES_GLOBAL,
  PROXY_CODES_PER_INSTANCE,
  PROXY_SECRET_BYTES,
  PROXY_SESSION_HARD_MS,
  PROXY_SESSION_IDLE_MS,
  PROXY_SESSIONS_GLOBAL,
  PROXY_SESSIONS_PER_INSTANCE,
  PROXY_TOMBSTONE_RING,
  PROXY_TOUCH_THROTTLE_MS,
} from "../../../../src/web-hub/protocol/proxy.js";
import { manualClock } from "./helpers.js";

function fixture(parent = Number.MAX_SAFE_INTEGER) {
  const clock = manualClock();
  const onEnd = vi.fn();
  let counter = 0;
  const random = vi.fn((n: number) => {
    const b = Buffer.alloc(n);
    b.writeUInt32BE(++counter);
    return b;
  });
  const store = createProxySessionStore({ now: clock.now, randomBytes: random, onEnd });
  const id: AuthIdentity = {
    listener: "lan",
    principal: "u1",
    userId: 1,
    sidTag: "parent-tag",
    parentExpiresAt: parent,
    sid: "MUST_NOT_COPY",
    lan: { userId: 1, epoch: 1, sidHash: "not copied", absoluteExpiresAt: parent },
  };
  const origin = "http://hub.local:7901";
  const mint = (inst = "instance-1", identity = id) =>
    store.mintCode(store.currentSeq(), identity, { instanceId: inst, origin, nextPath: "/app?x=1" });
  return { clock, store, id, mint, origin, random, onEnd };
}
function code(r: ProxyMintCodeResult) {
  if (!r.ok) throw new Error(`mint failed ${JSON.stringify(r)}`);
  return r;
}
function session(r: ProxyExchangeResult) {
  if (!r.ok) throw new Error(`exchange failed ${JSON.stringify(r)}`);
  return r;
}
function live(f: ReturnType<typeof fixture>, instance = "instance-1", id = f.id) {
  const c = code(f.mint(instance, id));
  return session(f.store.exchange(c.code, instance, f.origin));
}
const invalid = { ok: false, kind: "invalid" };

describe("T-F4 hashed one-time credentials and parent-bounded lifetime", () => {
  it("uses 32-byte secrets, only SHA256 in records, whitelists parent identity, code consumed ONCE", () => {
    const f = fixture();
    const c = code(f.mint());
    expect(c.code).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(c.rec.codeHash).toBe(createHash("sha256").update(c.code).digest("base64url"));
    expect(JSON.stringify(c.rec)).not.toContain(c.code);
    expect(JSON.stringify(c.rec)).not.toContain("MUST_NOT_COPY");
    expect(c.rec).not.toHaveProperty("sid");
    expect(c.rec).not.toHaveProperty("lan");
    const s = session(f.store.exchange(c.code, "instance-1", f.origin));
    expect(f.random).toHaveBeenCalledWith(PROXY_SECRET_BYTES);
    expect(s.rec.sidHash).toBe(createHash("sha256").update(s.sid).digest("base64url"));
    expect(JSON.stringify(s.rec)).not.toContain(s.sid);
    expect(s.rec).not.toHaveProperty("sid");
    expect(s.nextPath).toBe("/app?x=1");
    expect(f.store.exchange(c.code, "instance-1", f.origin)).toEqual(invalid);
    expect(f.store.counts()).toEqual({ codes: 0, sessions: 1 });
    expect(f.store.lookup(s.sid, "instance-1", f.origin)).toBe(s.rec);
    expect(f.store.lookup(s.sid, "other-instance", f.origin)).toBeUndefined();
    expect(f.store.lookup(s.sid, "instance-1", "http://hub.local:7902")).toBeUndefined();
    expect(f.store.lookup("junk", "instance-1", f.origin)).toBeUndefined();
  });
  it("Unicode nextPath survives mint/exchange as a header-safe Location after code consumption", () => {
    const f = fixture();
    const minted = code(
      f.store.mintCode(f.store.currentSeq(), f.id, {
        instanceId: "instance-1",
        origin: f.origin,
        nextPath: "/日本?q=é&lone=\ud800",
      }),
    );
    const exchanged = session(f.store.exchange(minted.code, "instance-1", f.origin));
    expect(exchanged.nextPath).toBe("/%E6%97%A5%E6%9C%AC?q=%C3%A9&lone=%EF%BF%BD");
    expect(exchanged.nextPath).toMatch(/^[\x21-\x7e]+$/);
    expect(validateHeaderValue("Location", exchanged.nextPath)).toBeUndefined();
    expect(f.store.counts()).toEqual({ codes: 0, sessions: 1 });
    expect(f.store.exchange(minted.code, "instance-1", f.origin)).toEqual(invalid);
  });
  it.each(["origin", "instance"])("wrong %s consumes even a failing first presentation", (wrong) => {
    const f = fixture();
    const c = code(f.mint());
    expect(
      f.store.exchange(
        c.code,
        wrong === "instance" ? "wrong" : "instance-1",
        wrong === "origin" ? "http://evil" : f.origin,
      ),
    ).toEqual(invalid);
    expect(f.store.exchange(c.code, "instance-1", f.origin)).toEqual(invalid);
    expect(f.store.counts()).toEqual({ codes: 0, sessions: 0 });
  });
  it("invalid shapes and unknown correctly shaped hashes never consume a different code", () => {
    const f = fixture();
    const c = code(f.mint());
    for (const v of ["", "a".repeat(42), "a".repeat(44), "=".repeat(43), "b".repeat(43)])
      expect(f.store.exchange(v, "instance-1", f.origin)).toEqual(invalid);
    expect(f.store.exchange(c.code, "instance-1", f.origin).ok).toBe(true);
  });
  it("code TTL at the exact boundary, lazy cleanup and safe next path", () => {
    const f = fixture();
    const a = code(f.mint());
    f.clock.advance(PROXY_CODE_TTL_MS - 1);
    expect(f.store.exchange(a.code, "instance-1", f.origin).ok).toBe(true);
    const b = code(f.mint());
    f.clock.advance(PROXY_CODE_TTL_MS);
    expect(f.store.exchange(b.code, "instance-1", f.origin)).toEqual(invalid);
    const c = code(
      f.store.mintCode(f.store.currentSeq(), f.id, { instanceId: "i", origin: f.origin, nextPath: "//evil" }),
    );
    expect(c.rec.nextPath).toBe("/");
  });
  it("hardAt uses mint time and min(12h,parent), rechecks parent at exchange", () => {
    const f = fixture();
    const a = code(f.mint());
    expect(a.rec.hardAt).toBe(f.clock.now() + PROXY_SESSION_HARD_MS);
    f.clock.advance(1_000);
    const s = session(f.store.exchange(a.code, "instance-1", f.origin));
    expect(s.rec.hardAt).toBe(a.rec.hardAt); // not now+12h at exchange
    const g = fixture(1_100);
    const b = code(g.mint());
    expect(b.rec.hardAt).toBe(1_100);
    g.clock.advance(100);
    expect(g.store.exchange(b.code, "instance-1", g.origin)).toEqual(invalid);
    expect(g.mint()).toEqual(invalid);
  });
  it("idle/HTTP refresh rules, response bytes never refresh, WS data throttled 60s, hard expiry destroys sockets", () => {
    const f = fixture();
    const s = live(f);
    const socket = { destroy: vi.fn() };
    expect(f.store.attach(s.rec, socket)).toBe(true);
    f.clock.advance(10);
    expect(f.store.lookup(s.sid, "instance-1", f.origin)).toBe(s.rec);
    expect(s.rec.lastUsedAt).toBe(1_010);
    f.clock.advance(PROXY_TOUCH_THROTTLE_MS - 1);
    expect(f.store.touch(s.rec, "ws")).toBe(true);
    expect(s.rec.lastUsedAt).toBe(1_010);
    f.clock.advance(1);
    f.store.touch(s.rec, "ws");
    expect(s.rec.lastUsedAt).toBe(f.clock.now());
    const last = s.rec.lastUsedAt;
    f.clock.advance(PROXY_SESSION_IDLE_MS - 1);
    expect(f.store.lookup(s.sid, "instance-1", f.origin, { touch: false })).toBe(s.rec);
    expect(s.rec.lastUsedAt).toBe(last); // no response-byte API and no-touch WS auth doesn't slide
    f.clock.advance(1);
    expect(f.store.isLive(s.rec)).toBe(false);
    expect(socket.destroy).toHaveBeenCalledOnce();
    expect(f.onEnd).toHaveBeenCalledWith(s.rec, "idle");
    expect(f.store.touch(s.rec, "http")).toBe(false);
    expect(f.store.attach(s.rec, { destroy() {} })).toBe(false);
    const g = fixture(1_200);
    const t = live(g);
    const sock = { destroy: vi.fn() };
    g.store.attach(t.rec, sock);
    g.clock.advance(199);
    expect(g.store.touch(t.rec, "http")).toBe(true);
    g.clock.advance(1);
    expect(g.store.lookup(t.sid, "instance-1", g.origin)).toBeUndefined();
    expect(sock.destroy).toHaveBeenCalledOnce();
    expect(g.onEnd).toHaveBeenCalledWith(t.rec, "hard");
  });
  it("continuous authenticated activity cannot extend the 12-hour hard limit", () => {
    const f = fixture();
    const s = live(f);
    const socket = { destroy: vi.fn() };
    f.store.attach(s.rec, socket);
    for (let hour = 1; hour < 12; hour++) {
      f.clock.advance(60 * 60_000);
      expect(f.store.lookup(s.sid, "instance-1", f.origin)).toBe(s.rec);
    }
    f.clock.advance(60 * 60_000);
    expect(f.store.lookup(s.sid, "instance-1", f.origin)).toBeUndefined();
    expect(socket.destroy).toHaveBeenCalledOnce();
    expect(f.onEnd).toHaveBeenCalledWith(s.rec, "hard");
  });
  it("detached closed sockets are not destroyed again; expiry observer failure cannot interrupt teardown", () => {
    const f = fixture();
    const s = live(f);
    const a = { destroy: vi.fn() };
    const b = {
      destroy: vi.fn(() => {
        throw new Error("x");
      }),
    };
    const c = { destroy: vi.fn() };
    for (const sock of [a, b, c]) f.store.attach(s.rec, sock);
    f.store.detach(s.rec, a);
    f.onEnd.mockImplementation(() => {
      throw new Error("x");
    });
    f.store.revoke({ sel: "all", reason: "close" });
    expect(a.destroy).not.toHaveBeenCalled();
    expect(b.destroy).toHaveBeenCalledOnce();
    expect(c.destroy).toHaveBeenCalledOnce();
    expect(s.rec.sockets.size).toBe(0);
    expect(f.store.counts()).toEqual({ codes: 0, sessions: 0 });
  });
  it("no timers or IO, including after creating credentials", () => {
    const source = readFileSync(new URL("../../../../src/web-hub/hub/proxy/sessions.ts", import.meta.url), "utf8");
    expect(source).not.toMatch(/\b(?:setTimeout|setInterval|node:fs|node:dns)\b/);
    const timer = vi.spyOn(globalThis, "setTimeout");
    const interval = vi.spyOn(globalThis, "setInterval");
    try {
      const f = fixture();
      live(f);
      f.store.sweep();
      expect(timer).not.toHaveBeenCalled();
      expect(interval).not.toHaveBeenCalled();
    } finally {
      timer.mockRestore();
      interval.mockRestore();
    }
  });
});

describe("T-F4 capacity refuses new credentials, never evicts", () => {
  it("16 codes per instance; first one remains usable", () => {
    const f = fixture();
    const all = Array.from({ length: PROXY_CODES_PER_INSTANCE }, () => code(f.mint()));
    expect(f.mint()).toEqual({ ok: false, status: 429, error: "E_RATE", reason: "codes" });
    expect(f.store.counts().codes).toBe(PROXY_CODES_PER_INSTANCE);
    expect(f.store.exchange(all[0]!.code, "instance-1", f.origin).ok).toBe(true);
  });
  it("128 global codes, independent of session capacity", () => {
    const f = fixture();
    let first = "";
    for (let i = 0; i < PROXY_CODES_GLOBAL; i++) {
      const c = code(f.mint(`i${Math.floor(i / PROXY_CODES_PER_INSTANCE)}`));
      if (i === 0) first = c.code;
    }
    expect(f.mint("another")).toEqual({ ok: false, status: 429, error: "E_RATE", reason: "codes" });
    expect(f.store.exchange(first, "i0", f.origin).ok).toBe(true);
  });
  it("16 sessions per instance; overflow consumes the new code, existing sessions remain live", () => {
    const f = fixture();
    const all = Array.from({ length: PROXY_SESSIONS_PER_INSTANCE }, () => live(f));
    const c = code(f.mint());
    expect(f.store.exchange(c.code, "instance-1", f.origin)).toEqual({
      ok: false,
      status: 429,
      error: "E_RATE",
      reason: "sessions",
    });
    expect(f.store.exchange(c.code, "instance-1", f.origin)).toEqual(invalid);
    for (const s of all) expect(f.store.lookup(s.sid, "instance-1", f.origin)).toBe(s.rec);
  });
  it("128 global sessions; new codes can still be minted; expired slots reclaim without eviction", () => {
    const f = fixture();
    let first: ReturnType<typeof live> | undefined;
    for (let i = 0; i < PROXY_SESSIONS_GLOBAL; i++) {
      const s = live(f, `i${Math.floor(i / PROXY_SESSIONS_PER_INSTANCE)}`);
      first ??= s;
    }
    const c = code(f.mint("another"));
    expect(f.store.exchange(c.code, "another", f.origin)).toEqual({
      ok: false,
      status: 429,
      error: "E_RATE",
      reason: "sessions",
    });
    expect(f.store.lookup(first!.sid, "i0", f.origin)).toBe(first!.rec);
    f.clock.advance(PROXY_SESSION_IDLE_MS);
    expect(f.store.counts()).toEqual({ codes: 0, sessions: 0 });
    expect(live(f).rec).toBeDefined();
  });
});

describe("T-F4 XA revocation selectors and tombstone gap", () => {
  it.each<ProxyRevokeSelector>([
    { sidTag: "parent-tag" },
    { userId: 1 },
    { listener: "lan" },
    { instanceId: "instance-1" },
    "all",
  ])("revokes codes, sessions, every socket for %j (not unrelated identities)", (sel) => {
    const f = fixture();
    const s = live(f);
    const c = code(f.mint());
    const sock = { destroy: vi.fn() };
    f.store.attach(s.rec, sock);
    const other: AuthIdentity = { listener: "loopback", principal: "p2", sidTag: "other", parentExpiresAt: 1e12 };
    const t = live(f, "instance-2", other);
    f.store.revoke({ sel, reason: "logout" });
    expect(f.store.currentSeq()).toBe(1);
    expect(f.store.lookup(s.sid, "instance-1", f.origin)).toBeUndefined();
    expect(f.store.exchange(c.code, "instance-1", f.origin)).toEqual(invalid);
    expect(sock.destroy).toHaveBeenCalledOnce();
    expect(f.store.lookup(t.sid, "instance-2", f.origin)).toBe(sel === "all" ? undefined : t.rec);
  });
  it("seq0-before-authorize prevents post-revoke mint; selector snapshot cannot be mutated", () => {
    const f = fixture();
    const seq0 = f.store.currentSeq();
    const sel = { sidTag: f.id.sidTag };
    f.store.revoke({ sel, reason: "logout" });
    sel.sidTag = "changed";
    expect(f.store.mintCode(seq0, f.id, { instanceId: "instance-1", origin: f.origin, nextPath: "/" })).toEqual(
      invalid,
    );
    expect(f.store.revokedSince(seq0, { ...f.id, sidTag: "unrelated" })).toBe(false);
  });
  it("a lost tombstone fails CLOSED 503 both at mint and exchange, current seq remains usable", () => {
    const f = fixture();
    const c = code(f.mint());
    const seq0 = f.store.currentSeq();
    for (let i = 0; i < PROXY_TOMBSTONE_RING; i++) f.store.revoke({ sel: { sidTag: `other-${i}` }, reason: "logout" });
    expect(f.store.revokedSince(seq0, f.id)).toBe(false); // full history still retained
    f.store.revoke({ sel: { sidTag: "last" }, reason: "logout" });
    expect(f.store.revokedSince(seq0, f.id)).toBe("gap");
    const gap = { ok: false, status: 503, error: "E_PROXY_UNAVAILABLE", reason: "revocation-gap", retryable: true };
    expect(f.store.mintCode(seq0, f.id, { instanceId: "instance-1", origin: f.origin, nextPath: "/" })).toEqual(gap);
    expect(f.store.exchange(c.code, "instance-1", f.origin)).toEqual(gap);
    expect(f.mint().ok).toBe(true);
    for (const bad of [NaN, -1, 0.5, f.store.currentSeq() + 1]) expect(f.store.revokedSince(bad, f.id)).toBe("gap");
  });
  it("R2 eventual revoke: mint between delete's two emits may succeed, but second emit kills every window credential", () => {
    const f = fixture();
    const bus = createAuthRevokeBus({ error: vi.fn() });
    const off = bus.subscribe((ev) => f.store.revoke(ev));
    const ev = { sel: { sidTag: f.id.sidTag }, reason: "logout" as const };
    bus.emit(ev);
    const s = live(f);
    const c = code(f.mint());
    expect(f.store.lookup(s.sid, "instance-1", f.origin)).toBe(s.rec);
    bus.emit(ev);
    expect(f.store.lookup(s.sid, "instance-1", f.origin)).toBeUndefined();
    expect(f.store.exchange(c.code, "instance-1", f.origin)).toEqual(invalid);
    off();
  });
});
