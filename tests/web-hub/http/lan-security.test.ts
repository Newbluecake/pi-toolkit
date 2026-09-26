/**
 * LAN cross-origin/security header hardening (plan §11.1 "跨源（自动化）" row →
 * `tests/web-hub/http/lan-security.test.ts`).
 */
import { describe, expect, it } from "vitest";
import { lanPostJson, lanRequest, seedLanUser, startLan } from "./lan-helpers.js";

describe("LAN cross-origin / security headers (plan §2.4, §7)", () => {
  it("cross-origin form-style POST (no X-PWH, no JSON content-type) is rejected — the classic CSRF vector", async () => {
    const h = await startLan();
    try {
      seedLanUser(h.store, { username: "alice", password: "correct-horse-battery" });
      const r = await lanRequest(h.port, {
        method: "POST",
        path: "/api/login",
        headers: { "Content-Type": "application/x-www-form-urlencoded", Origin: `http://127.0.0.1:${h.port}` },
        body: "username=alice&password=correct-horse-battery",
      });
      expect(r.status).toBe(403);
    } finally {
      await h.cleanup();
    }
  });

  it("cross-origin XHR/fetch with a mismatched Origin ⇒ 403 even with correct Content-Type/X-PWH", async () => {
    const h = await startLan();
    try {
      seedLanUser(h.store, { username: "alice", password: "correct-horse-battery" });
      const r = await lanPostJson(
        h.port,
        "/api/login",
        { username: "alice", password: "correct-horse-battery" },
        { Origin: "http://evil.example.com" },
      );
      expect(r.status).toBe(403);
    } finally {
      await h.cleanup();
    }
  });

  it("token field sent to /api/login always 401s (LAN never accepts token auth)", async () => {
    const h = await startLan();
    try {
      seedLanUser(h.store, { username: "alice", password: "correct-horse-battery" });
      const r = await lanPostJson(h.port, "/api/login", { token: "anything" });
      expect(r.status).toBe(401);
    } finally {
      await h.cleanup();
    }
  });

  it("every response carries the security headers and never HSTS", async () => {
    const h = await startLan();
    try {
      const r = await lanRequest(h.port, { path: "/healthz" });
      expect(r.headers["content-security-policy"]).toBeDefined();
      expect(r.headers["x-frame-options"]).toBe("DENY");
      expect(r.headers["x-content-type-options"]).toBe("nosniff");
      expect(r.headers["referrer-policy"]).toBe("no-referrer");
      expect(r.headers["strict-transport-security"]).toBeUndefined();
    } finally {
      await h.cleanup();
    }
  });

  it("/api/* responses carry Cache-Control: no-store", async () => {
    const h = await startLan();
    try {
      const r = await lanRequest(h.port, { path: "/api/session" });
      expect(r.headers["cache-control"]).toBe("no-store");
    } finally {
      await h.cleanup();
    }
  });

  it("unauthenticated /api/session ⇒ 401, unauthenticated /api/history ⇒ 401 (no session bypass)", async () => {
    const h = await startLan();
    try {
      const a = await lanRequest(h.port, { path: "/api/session" });
      const b = await lanRequest(h.port, { path: "/api/history?agent=x&before=y" });
      expect(a.status).toBe(401);
      expect(b.status).toBe(401);
    } finally {
      await h.cleanup();
    }
  });

  it("unknown /api/* route ⇒ 404 (not 501/500)", async () => {
    const h = await startLan();
    try {
      const r = await lanRequest(h.port, { path: "/api/does-not-exist" });
      expect(r.status).toBe(404);
    } finally {
      await h.cleanup();
    }
  });
});
