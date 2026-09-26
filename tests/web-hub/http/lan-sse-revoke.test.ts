/**
 * SSE open + revoke (plan §4.2 "SSE 撤销" http-layer parts, LC row: "sse.revoke
 * 与 auth 事件（§4.2 SSE 撤销中属于 http 层的部分，用假 store）").
 */
import { describe, expect, it } from "vitest";
import { lanPostJson, openSse, seedLanUser, startLan } from "./lan-helpers.js";

describe("LAN SSE open + revoke (plan §4.2)", () => {
  it("logout synchronously revokes the session's open SSE: event:auth{revoked} then stream ends", async () => {
    const h = await startLan();
    try {
      seedLanUser(h.store, { username: "alice", password: "correct-horse-battery" });
      const login = await lanPostJson(h.port, "/api/login", { username: "alice", password: "correct-horse-battery" });
      const cookie = (login.headers["set-cookie"]?.[0] ?? "").split(";")[0]!;
      const sse = await openSse(h.port, cookie);
      await sse.waitFor("hello");
      await lanPostJson(h.port, "/api/logout", {}, { Cookie: cookie });
      const authFrame = await sse.waitFor("auth");
      expect(authFrame.data).toEqual({ reason: "revoked" });
      sse.close();
    } finally {
      await h.cleanup();
    }
  });

  it("LanFacade.revoke({userId}) closes that user's SSE with event:auth{revoked}", async () => {
    const h = await startLan();
    try {
      seedLanUser(h.store, { username: "alice", password: "correct-horse-battery", id: 7 });
      const login = await lanPostJson(h.port, "/api/login", { username: "alice", password: "correct-horse-battery" });
      const cookie = (login.headers["set-cookie"]?.[0] ?? "").split(";")[0]!;
      const sse = await openSse(h.port, cookie);
      await sse.waitFor("hello");
      const n = h.fe.lan!.revoke({ userId: 7 });
      expect(n).toBe(1);
      const authFrame = await sse.waitFor("auth");
      expect(authFrame.data).toEqual({ reason: "revoked" });
      sse.close();
    } finally {
      await h.cleanup();
    }
  });

  it("LanFacade.revoke({sidHash}) only closes the matching session, not other users'", async () => {
    const h = await startLan();
    try {
      seedLanUser(h.store, { username: "alice", password: "correct-horse-battery", id: 1 });
      seedLanUser(h.store, { username: "bob", password: "another-battery-1", id: 2 });
      const aliceLogin = await lanPostJson(h.port, "/api/login", {
        username: "alice",
        password: "correct-horse-battery",
      });
      const bobLogin = await lanPostJson(h.port, "/api/login", { username: "bob", password: "another-battery-1" });
      const aliceCookie = (aliceLogin.headers["set-cookie"]?.[0] ?? "").split(";")[0]!;
      const bobCookie = (bobLogin.headers["set-cookie"]?.[0] ?? "").split(";")[0]!;
      const aliceSse = await openSse(h.port, aliceCookie);
      const bobSse = await openSse(h.port, bobCookie);
      await aliceSse.waitFor("hello");
      await bobSse.waitFor("hello");
      const n = h.fe.lan!.revoke({ userId: 1 });
      expect(n).toBe(1);
      await aliceSse.waitFor("auth");
      // bob's stream should stay open — give it a moment then assert no auth frame arrived.
      await new Promise((r) => setTimeout(r, 100));
      expect(bobSse.events.some((e) => e.event === "auth")).toBe(false);
      aliceSse.close();
      bobSse.close();
    } finally {
      await h.cleanup();
    }
  });

  it("fe.close() closes LAN SSE clients as part of shutdown", async () => {
    const h = await startLan();
    try {
      seedLanUser(h.store, { username: "alice", password: "correct-horse-battery" });
      const login = await lanPostJson(h.port, "/api/login", { username: "alice", password: "correct-horse-battery" });
      const cookie = (login.headers["set-cookie"]?.[0] ?? "").split(";")[0]!;
      const sse = await openSse(h.port, cookie);
      await sse.waitFor("hello");
      expect(h.fe.clientCount()).toBe(1);
      await h.fe.close();
      expect(h.fe.clientCount()).toBe(0);
    } finally {
      await h.cleanup();
    }
  });
});
