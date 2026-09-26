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
