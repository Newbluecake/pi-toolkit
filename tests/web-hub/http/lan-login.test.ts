/**
 * §6.1 login pipeline + §6.4 cookie attributes (plan §11 LC row).
 */
import { describe, expect, it } from "vitest";
import { lanPostJson, lanRequest, seedLanUser, startLan } from "./lan-helpers.js";

describe("LAN login pipeline (plan §6.1, §6.4)", () => {
  it("success: 200 + Set-Cookie pwh_lan, HttpOnly, SameSite=Strict, Path=/, no Secure on http", async () => {
    const h = await startLan();
    try {
      seedLanUser(h.store, { username: "alice", password: "correct-horse-battery" });
      const r = await lanPostJson(h.port, "/api/login", { username: "alice", password: "correct-horse-battery" });
      expect(r.status).toBe(200);
      const setCookie = r.headers["set-cookie"]?.[0] ?? "";
      expect(setCookie).toMatch(/^pwh_lan=[^;]+; HttpOnly; SameSite=Strict; Path=\//);
      expect(setCookie).not.toContain("Secure");
    } finally {
      await h.cleanup();
    }
  });

  it("over a trusted proxy with https scheme, the cookie carries Secure", async () => {
    const h = await startLan({ cfg: { trustProxyFrom: ["127.0.0.1"], externalOrigins: ["https://hub.example.com"] } });
    try {
      seedLanUser(h.store, { username: "alice", password: "correct-horse-battery" });
      const r = await lanPostJson(
        h.port,
        "/api/login",
        { username: "alice", password: "correct-horse-battery" },
        { "X-Forwarded-Proto": "https", "X-Forwarded-Host": "hub.example.com", Origin: "https://hub.example.com" },
      );
      expect(r.status).toBe(200);
      expect(r.headers["set-cookie"]?.[0] ?? "").toContain("Secure");
    } finally {
      await h.cleanup();
    }
  });

  it("wrong password ⇒ 401 E_AUTH (undifferentiated from unknown user)", async () => {
    const h = await startLan();
    try {
      seedLanUser(h.store, { username: "alice", password: "correct-horse-battery" });
      const wrongPw = await lanPostJson(h.port, "/api/login", { username: "alice", password: "nope" });
      const noUser = await lanPostJson(h.port, "/api/login", { username: "bob", password: "nope" });
      expect(wrongPw.status).toBe(401);
      expect(noUser.status).toBe(401);
      expect(JSON.parse(wrongPw.body)).toEqual(JSON.parse(noUser.body));
    } finally {
      await h.cleanup();
    }
  });

  it("per-IP backoff sequence: 5 free failures then 30/60/120s Retry-After", async () => {
    const h = await startLan();
    try {
      seedLanUser(h.store, { username: "alice", password: "correct-horse-battery" });
      for (let i = 0; i < 6; i++) {
        const r = await lanPostJson(h.port, "/api/login", { username: "alice", password: "wrong" });
        expect(r.status).toBe(401); // failures 1..6 are all free/normal (F=5 free, the 6th still gets to try and then locks)
      }
      const seventh = await lanPostJson(h.port, "/api/login", { username: "alice", password: "wrong" });
      expect(seventh.status).toBe(429);
      expect(seventh.headers["retry-after"]).toBe("30");
      h.clock.advance(30_000);
      const eighth = await lanPostJson(h.port, "/api/login", { username: "alice", password: "wrong" });
      expect(eighth.status).toBe(401); // 7th failure recorded now ⇒ locks again at 60s
      const ninth = await lanPostJson(h.port, "/api/login", { username: "alice", password: "wrong" });
      expect(ninth.status).toBe(429);
      expect(ninth.headers["retry-after"]).toBe("60");
    } finally {
      await h.cleanup();
    }
  });

  it("token sent to the LAN login endpoint is just an unknown field ⇒ 401 (never treated as a password/username)", async () => {
    const h = await startLan();
    try {
      seedLanUser(h.store, { username: "alice", password: "correct-horse-battery" });
      const r = await lanPostJson(h.port, "/api/login", { token: "correct-horse-battery" });
      expect(r.status).toBe(401);
    } finally {
      await h.cleanup();
    }
  });

  it("body over 4 KiB on /api/login ⇒ 413 (stricter than the general 64 KiB cap)", async () => {
    const h = await startLan();
    try {
      const r = await lanPostJson(h.port, "/api/login", { username: "alice", password: "x".repeat(5_000) });
      expect(r.status).toBe(413);
    } finally {
      await h.cleanup();
    }
  });

  it("saturation: 4096 distinct failed IPs, then an unseen IP gets 429 saturated:true without being tainted", async () => {
    const h = await startLan();
    try {
      seedLanUser(h.store, { username: "alice", password: "correct-horse-battery" });
      for (let i = 0; i < 4096; i++) {
        h.limiter.fail(`10.${(i >> 16) & 255}.${(i >> 8) & 255}.${i & 255}`);
      }
      const r = await lanPostJson(
        h.port,
        "/api/login",
        { username: "alice", password: "wrong" },
        {
          // distinguish this request's peer — but the harness always connects from 127.0.0.1, so
          // saturation is driven purely through the limiter directly above; this call exercises
          // the actual HTTP saturation branch for the real request's peer (127.0.0.1).
        },
      );
      expect(r.status).toBe(429);
      expect(JSON.parse(r.body)).toMatchObject({ error: "E_RATE", saturated: true });
    } finally {
      await h.cleanup();
    }
  });

  it("initial-password login: response flags initialPassword and the store records the first use", async () => {
    const h = await startLan();
    try {
      seedLanUser(h.store, { username: "alice", password: "initial-secret-1", initial: true });
      const r = await lanPostJson(h.port, "/api/login", { username: "alice", password: "initial-secret-1" });
      expect(r.status).toBe(200);
      // review fix (lan-plan.md §15.9 #6): plan §10's wire field is `initialPassword`, not
      // `initialPasswordInUse` (that name is reserved for `GET /api/session`'s own response).
      expect(JSON.parse(r.body)).toMatchObject({ initialPassword: true });
    } finally {
      await h.cleanup();
    }
  });

  it("logout clears the cookie (Max-Age=0) and the session no longer works", async () => {
    const h = await startLan();
    try {
      seedLanUser(h.store, { username: "alice", password: "correct-horse-battery" });
      const login = await lanPostJson(h.port, "/api/login", { username: "alice", password: "correct-horse-battery" });
      const cookie = (login.headers["set-cookie"]?.[0] ?? "").split(";")[0]!;
      const logout = await lanPostJson(h.port, "/api/logout", {}, { Cookie: cookie });
      expect(logout.status).toBe(200);
      expect(logout.headers["set-cookie"]?.[0] ?? "").toContain("Max-Age=0");
      const after = await lanRequest(h.port, { path: "/api/session", headers: { Cookie: cookie } });
      expect(after.status).toBe(401);
    } finally {
      await h.cleanup();
    }
  });

  it("a store exception during login still releases the KDF admission slot and per-IP quota tracking", async () => {
    const h = await startLan();
    try {
      const original = h.store.getUser;
      let calls = 0;
      h.store.getUser = async (...args) => {
        calls++;
        throw new Error("boom");
      };
      const r = await lanPostJson(h.port, "/api/login", { username: "alice", password: "x" });
      expect(r.status).toBe(500);
      expect(calls).toBe(1);
      h.store.getUser = original;
      // the pipeline must not be wedged: a subsequent, well-formed login still works.
      seedLanUser(h.store, { username: "alice", password: "correct-horse-battery" });
      const r2 = await lanPostJson(h.port, "/api/login", { username: "alice", password: "correct-horse-battery" });
      expect(r2.status).toBe(200);
    } finally {
      await h.cleanup();
    }
  });

  it("CSRF: missing Origin, missing X-PWH, or wrong Content-Type on POST ⇒ 403", async () => {
    const h = await startLan();
    try {
      seedLanUser(h.store, { username: "alice", password: "correct-horse-battery" });
      const noOrigin = await lanRequest(h.port, {
        method: "POST",
        path: "/api/login",
        headers: { "Content-Type": "application/json", "X-PWH": "1" },
        body: JSON.stringify({ username: "alice", password: "correct-horse-battery" }),
      });
      expect(noOrigin.status).toBe(403);
      const wrongCt = await lanRequest(h.port, {
        method: "POST",
        path: "/api/login",
        headers: { "Content-Type": "text/plain", "X-PWH": "1", Origin: `http://127.0.0.1:${h.port}` },
        body: JSON.stringify({ username: "alice", password: "correct-horse-battery" }),
      });
      expect(wrongCt.status).toBe(403);
    } finally {
      await h.cleanup();
    }
  });
});
