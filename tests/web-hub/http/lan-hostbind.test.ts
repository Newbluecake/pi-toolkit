/**
 * Session origin binding (plan §2.4/§6.4 — `tests/web-hub/http/lan-hostbind.test.ts`).
 */
import { describe, expect, it } from "vitest";
import { lanPostJson, lanRequest, seedLanUser, startLan } from "./lan-helpers.js";

describe("LAN session origin binding (plan §6.4)", () => {
  it("a cookie created on one direct hostname 401s when replayed on another direct hostname", async () => {
    const h = await startLan({ cfg: { extraHosts: ["myhost.local"] } });
    try {
      seedLanUser(h.store, { username: "alice", password: "correct-horse-battery" });
      const login = await lanPostJson(
        h.port,
        "/api/login",
        { username: "alice", password: "correct-horse-battery" },
        { Host: `127.0.0.1:${h.port}`, Origin: `http://127.0.0.1:${h.port}` },
      );
      expect(login.status).toBe(200);
      const cookie = (login.headers["set-cookie"]?.[0] ?? "").split(";")[0]!;

      const sameOrigin = await lanRequest(h.port, {
        path: "/api/session",
        host: `127.0.0.1:${h.port}`,
        headers: { Cookie: cookie },
      });
      expect(sameOrigin.status).toBe(200);

      const otherOrigin = await lanRequest(h.port, {
        path: "/api/session",
        host: `myhost.local:${h.port}`,
        headers: { Cookie: cookie },
      });
      expect(otherOrigin.status).toBe(401);

      // 401 must not have deleted the session — the original origin still works.
      const again = await lanRequest(h.port, {
        path: "/api/session",
        host: `127.0.0.1:${h.port}`,
        headers: { Cookie: cookie },
      });
      expect(again.status).toBe(200);
    } finally {
      await h.cleanup();
    }
  });

  it("same host, different case ⇒ same origin (canonicalization lower-cases), session works", async () => {
    const h = await startLan({ cfg: { extraHosts: ["MyHost.Local"] } });
    try {
      seedLanUser(h.store, { username: "alice", password: "correct-horse-battery" });
      const login = await lanPostJson(
        h.port,
        "/api/login",
        { username: "alice", password: "correct-horse-battery" },
        { Host: `myhost.local:${h.port}`, Origin: `http://myhost.local:${h.port}` },
      );
      expect(login.status).toBe(200);
      const cookie = (login.headers["set-cookie"]?.[0] ?? "").split(";")[0]!;
      const r = await lanRequest(h.port, {
        path: "/api/session",
        host: `MYHOST.LOCAL:${h.port}`,
        headers: { Cookie: cookie },
      });
      expect(r.status).toBe(200);
    } finally {
      await h.cleanup();
    }
  });

  it("a session created directly 401s when replayed through the trusted proxy, and vice versa", async () => {
    const h = await startLan({
      cfg: {
        extraHosts: ["hub.example.com"],
        trustProxyFrom: ["127.0.0.2"], // a distinct loopback alias so "direct" (127.0.0.1) vs
        // "trusted proxy peer" (127.0.0.2) are genuinely different TCP peers, not just headers.
        externalOrigins: ["https://hub.example.com"],
      },
    });
    try {
      seedLanUser(h.store, { username: "alice", password: "correct-horse-battery" });
      const directLogin = await lanPostJson(
        h.port,
        "/api/login",
        { username: "alice", password: "correct-horse-battery" },
        { Host: `hub.example.com:${h.port}`, Origin: `http://hub.example.com:${h.port}` },
      );
      expect(directLogin.status).toBe(200);
      const directCookie = (directLogin.headers["set-cookie"]?.[0] ?? "").split(";")[0]!;

      const viaProxy = await lanRequest(h.port, {
        path: "/api/session",
        localAddress: "127.0.0.2",
        headers: {
          Cookie: directCookie,
          "X-Forwarded-Proto": "https",
          "X-Forwarded-Host": "hub.example.com",
        },
      });
      expect(viaProxy.status).toBe(401);

      const proxyLogin = await lanPostJson(
        h.port,
        "/api/login",
        { username: "alice", password: "correct-horse-battery" },
        { "X-Forwarded-Proto": "https", "X-Forwarded-Host": "hub.example.com", Origin: "https://hub.example.com" },
        "127.0.0.2",
      );
      expect(proxyLogin.status).toBe(200);
      const proxyCookie = (proxyLogin.headers["set-cookie"]?.[0] ?? "").split(";")[0]!;

      const direct = await lanRequest(h.port, {
        path: "/api/session",
        host: `hub.example.com:${h.port}`,
        headers: { Cookie: proxyCookie },
      });
      expect(direct.status).toBe(401);
    } finally {
      await h.cleanup();
    }
  });
});
