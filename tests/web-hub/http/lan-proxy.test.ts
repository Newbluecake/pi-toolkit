/**
 * Trusted reverse-proxy integration through `buildContext`'s LAN branch
 * (plan §2.4 — `tests/web-hub/http/lan-proxy.test.ts` + the pure-function
 * `proxy.test.ts`).
 */
import { describe, expect, it } from "vitest";
import { lanRequest, startLan } from "./lan-helpers.js";

describe("LAN proxy resolution end-to-end (plan §2.4)", () => {
  it("non-trusted peer's X-Forwarded-* are entirely ignored: Host must be in hostKeys, not externalOrigins", async () => {
    const h = await startLan({
      cfg: { trustProxyFrom: ["192.168.31.10"], externalOrigins: ["https://hub.example.com"] },
    });
    try {
      // Request arrives directly (peer = 127.0.0.1, which is not the trusted 192.168.31.10), so
      // XFH is ignored — Host itself (hub.example.com, not in hostKeys) is checked ⇒ 421.
      const r = await lanRequest(h.port, {
        headers: { "X-Forwarded-For": "1.2.3.4", "X-Forwarded-Proto": "https", "X-Forwarded-Host": "hub.example.com" },
        host: "hub.example.com",
      });
      expect(r.status).toBe(421);
    } finally {
      await h.cleanup();
    }
  });

  it("trusted peer + XFP missing/non-https ⇒ 400 proxy-proto (not the client's fault, but hard-rejected)", async () => {
    const h = await startLan({ cfg: { trustProxyFrom: ["127.0.0.1"], externalOrigins: ["https://hub.example.com"] } });
    try {
      const r1 = await lanRequest(h.port, { headers: { "X-Forwarded-Host": "hub.example.com" } });
      expect(r1.status).toBe(400);
      const r2 = await lanRequest(h.port, {
        headers: { "X-Forwarded-Proto": "http", "X-Forwarded-Host": "hub.example.com" },
      });
      expect(r2.status).toBe(400);
    } finally {
      await h.cleanup();
    }
  });

  it("trusted peer + valid https + XFH matching externalOrigins ⇒ passes through to healthz", async () => {
    const h = await startLan({ cfg: { trustProxyFrom: ["127.0.0.1"], externalOrigins: ["https://hub.example.com"] } });
    try {
      const r = await lanRequest(h.port, {
        path: "/healthz",
        headers: { "X-Forwarded-Proto": "HTTPS", "X-Forwarded-Host": "hub.example.com" },
      });
      expect(r.status).toBe(200);
      expect(JSON.parse(r.body)).toMatchObject({ plaintext: false }); // scheme is https via the proxy
    } finally {
      await h.cleanup();
    }
  });

  it("XFH not in externalOrigins ⇒ 421 (proxy entry never consults hostKeys)", async () => {
    const h = await startLan({ cfg: { trustProxyFrom: ["127.0.0.1"], externalOrigins: ["https://hub.example.com"] } });
    try {
      const r = await lanRequest(h.port, {
        headers: { "X-Forwarded-Proto": "https", "X-Forwarded-Host": "evil.example.com" },
      });
      expect(r.status).toBe(421);
    } finally {
      await h.cleanup();
    }
  });

  it("XFH missing falls back to Host, still checked against externalOrigins (not hostKeys)", async () => {
    const h = await startLan({ cfg: { trustProxyFrom: ["127.0.0.1"], externalOrigins: ["https://hub.example.com"] } });
    try {
      const okViaHost = await lanRequest(h.port, {
        path: "/healthz",
        headers: { "X-Forwarded-Proto": "https" },
        host: "hub.example.com",
      });
      expect(okViaHost.status).toBe(200);
      // The LAN IP form is a valid *direct* host, but the proxy entry never checks hostKeys.
      const failsViaIp = await lanRequest(h.port, {
        headers: { "X-Forwarded-Proto": "https" },
        host: `127.0.0.1:${h.port}`,
      });
      expect(failsViaIp.status).toBe(421);
    } finally {
      await h.cleanup();
    }
  });

  it("X-Forwarded-Host with two values (multi) ⇒ 400", async () => {
    const h = await startLan({ cfg: { trustProxyFrom: ["127.0.0.1"], externalOrigins: ["https://hub.example.com"] } });
    try {
      const r = await lanRequest(h.port, {
        headers: { "X-Forwarded-Proto": "https", "X-Forwarded-Host": "a, b" },
      });
      expect(r.status).toBe(400);
    } finally {
      await h.cleanup();
    }
  });
});
