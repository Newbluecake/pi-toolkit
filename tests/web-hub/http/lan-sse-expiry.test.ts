/**
 * §4.2 "SSE 到期复核" (LC review fix, lan-plan.md §15.9 #3): a 55s tick, independent of
 * `sse.ts`'s ping-only keepalive, that re-validates every LAN SSE connection's session against
 * the store. `lan-sse-revoke.test.ts` covers the explicit logout/passwd revoke paths (0
 * latency); these cover the *implicit* paths (a session gone or rotated out from under an open
 * connection without a matching revoke call) that only this tick catches.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { lanPostJson, openSse, seedLanUser, startLan } from "./lan-helpers.js";
import { hashSid } from "../../../src/web-hub/hub/sid-hash.js";

function sidHashFromCookie(cookie: string): string {
  const raw = cookie.split(";")[0]!.split("=")[1]!;
  return hashSid(raw);
}

describe("LAN SSE 55s expiry recheck tick (plan §4.2; LC review fix, lan-plan.md §15.9 #3)", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("a session deleted out from under an open SSE (no logout, no passwd — e.g. the 7d absolute-expiry sweep) gets auth{expired} within one tick", async () => {
    const h = await startLan();
    try {
      seedLanUser(h.store, { username: "alice", password: "correct-horse-battery" });
      const login = await lanPostJson(h.port, "/api/login", { username: "alice", password: "correct-horse-battery" });
      const cookie = (login.headers["set-cookie"]?.[0] ?? "").split(";")[0]!;
      const sse = await openSse(h.port, cookie);
      await sse.waitFor("hello");

      // Simulate the session having gone away without going through logout/passwd (which already
      // revoke synchronously, plan §4.2's "0 延迟" row) — only the periodic recheck notices this.
      await h.store.deleteSession(sidHashFromCookie(cookie));

      await vi.advanceTimersByTimeAsync(55_000);
      const authFrame = await sse.waitFor("auth");
      expect(authFrame.data).toEqual({ reason: "expired" });
      sse.close();
    } finally {
      await h.cleanup();
    }
  });

  it("a session whose epoch changed (e.g. a concurrent password change) out from under an open SSE also gets auth{expired}", async () => {
    const h = await startLan();
    try {
      seedLanUser(h.store, { username: "alice", password: "correct-horse-battery" });
      const login = await lanPostJson(h.port, "/api/login", { username: "alice", password: "correct-horse-battery" });
      const cookie = (login.headers["set-cookie"]?.[0] ?? "").split(";")[0]!;
      const sse = await openSse(h.port, cookie);
      await sse.waitFor("hello");

      const sidHash = sidHashFromCookie(cookie);
      const rec = await h.store.touchSession(sidHash, h.clock.now());
      expect(rec).not.toBeUndefined();
      // Directly bump the epoch in the store's session record (bypassing the http-layer
      // setPassword/revoke path entirely) to isolate the tick's own epoch check.
      (h.store.sessionsBySidHash as Map<string, { epoch: number }>).get(sidHash)!.epoch = rec!.epoch + 1;

      await vi.advanceTimersByTimeAsync(55_000);
      const authFrame = await sse.waitFor("auth");
      expect(authFrame.data).toEqual({ reason: "expired" });
      sse.close();
    } finally {
      await h.cleanup();
    }
  });

  it("a still-valid session is left alone across a tick (no spurious revoke)", async () => {
    const h = await startLan();
    try {
      seedLanUser(h.store, { username: "alice", password: "correct-horse-battery" });
      const login = await lanPostJson(h.port, "/api/login", { username: "alice", password: "correct-horse-battery" });
      const cookie = (login.headers["set-cookie"]?.[0] ?? "").split(";")[0]!;
      const sse = await openSse(h.port, cookie);
      await sse.waitFor("hello");

      await vi.advanceTimersByTimeAsync(55_000);
      await vi.advanceTimersByTimeAsync(55_000);
      expect(sse.events.some((e) => e.event === "auth")).toBe(false);
      sse.close();
    } finally {
      await h.cleanup();
    }
  });

  it("a store rejection during the recheck keeps the connection open (never treats 'can't verify' as revoked)", async () => {
    const h = await startLan();
    try {
      seedLanUser(h.store, { username: "alice", password: "correct-horse-battery" });
      const login = await lanPostJson(h.port, "/api/login", { username: "alice", password: "correct-horse-battery" });
      const cookie = (login.headers["set-cookie"]?.[0] ?? "").split(";")[0]!;
      const sse = await openSse(h.port, cookie);
      await sse.waitFor("hello");

      const original = h.store.touchSession;
      h.store.touchSession = async () => {
        throw new Error("boom: db unavailable");
      };
      await vi.advanceTimersByTimeAsync(55_000);
      expect(sse.events.some((e) => e.event === "auth")).toBe(false);
      h.store.touchSession = original;
      sse.close();
    } finally {
      await h.cleanup();
    }
  });
});

describe('LAN SSE absolute-expiry local timer (plan §4.2 "另有本地硬计时"; LC review fix, task #1)', () => {
  it("DB unavailable for the connection's whole remaining lifetime still force-closes it at its own absoluteExpiresAt", async () => {
    vi.useFakeTimers();
    const h = await startLan();
    try {
      seedLanUser(h.store, { username: "alice", password: "correct-horse-battery" });
      const login = await lanPostJson(h.port, "/api/login", { username: "alice", password: "correct-horse-battery" });
      const cookie = (login.headers["set-cookie"]?.[0] ?? "").split(";")[0]!;
      const sidHash = sidHashFromCookie(cookie);

      // Shrink this session's absolute ceiling so the test doesn't need to fast-forward through
      // 7 real days' worth of 55s/60s ticks — the local timer only cares about the delta between
      // `absoluteExpiresAt` and `now` at the instant the SSE connection opens.
      (h.store.sessionsBySidHash as Map<string, { absoluteExpiresAt: number }>).get(sidHash)!.absoluteExpiresAt =
        h.clock.now() + 5_000;

      const sse = await openSse(h.port, cookie);
      await sse.waitFor("hello");

      // The db goes down *after* the connection opened (so the open itself still saw the 7d/
      // shrunk ceiling) and stays down for the rest of the test — the 55s recheck tick can never
      // revoke it; only the local absolute-expiry timer can.
      h.store.touchSession = async () => {
        throw new Error("boom: db unavailable");
      };

      h.clock.advance(6_000);
      await vi.advanceTimersByTimeAsync(6_000);

      const authFrame = await sse.waitFor("auth");
      expect(authFrame.data).toEqual({ reason: "expired" });
      sse.close();
    } finally {
      await h.cleanup();
      vi.useRealTimers();
    }
  });

  it("closing an SSE connection normally clears its absolute-expiry timer (no leaked unref timer)", async () => {
    const h = await startLan();
    try {
      seedLanUser(h.store, { username: "alice", password: "correct-horse-battery" });
      const login = await lanPostJson(h.port, "/api/login", { username: "alice", password: "correct-horse-battery" });
      const cookie = (login.headers["set-cookie"]?.[0] ?? "").split(";")[0]!;

      const setSpy = vi.spyOn(global, "setTimeout");
      const sse = await openSse(h.port, cookie);
      await sse.waitFor("hello");

      const sevenDaysMs = 7 * 24 * 3_600_000;
      const absExpiryCallIndex = setSpy.mock.calls.findIndex((args) => {
        const delay = args[1];
        return typeof delay === "number" && Math.abs(delay - sevenDaysMs) < 1_000;
      });
      expect(absExpiryCallIndex).toBeGreaterThanOrEqual(0);
      const timerHandle = setSpy.mock.results[absExpiryCallIndex]!.value;

      const clearSpy = vi.spyOn(global, "clearTimeout");
      sse.close();
      // Let the real socket 'close' event (driven by the actual OS/libuv event loop, independent
      // of any fake timers) propagate to the server side.
      await new Promise((resolve) => setTimeout(resolve, 200));
      expect(clearSpy.mock.calls.some((call) => call[0] === timerHandle)).toBe(true);

      setSpy.mockRestore();
      clearSpy.mockRestore();
    } finally {
      await h.cleanup();
    }
  });
});
