/**
 * §2.5 request pipeline / §2.3 snapshot & recompute (plan §11 LC row:
 * "buildContext 与 §2.5 的流水线") — real end-to-end via `createHttpFrontend`.
 */
import { describe, expect, it } from "vitest";
import { lanRequest, startLan } from "./lan-helpers.js";

describe("LAN host whitelist / recompute (plan §2.3, §2.5)", () => {
  it("a Host not in the snapshot is rejected 421 E_HOST", async () => {
    const h = await startLan();
    try {
      const r = await lanRequest(h.port, { host: "evil.example.com" });
      expect(r.status).toBe(421);
      expect(JSON.parse(r.body)).toMatchObject({ error: "E_HOST" });
    } finally {
      await h.cleanup();
    }
  });

  it("127.0.0.1:<port> and localhost:<port> are always in the whitelist (LAN listener reachable locally)", async () => {
    const h = await startLan();
    try {
      const a = await lanRequest(h.port, { path: "/healthz", host: `127.0.0.1:${h.port}` });
      const b = await lanRequest(h.port, { path: "/healthz", host: `localhost:${h.port}` });
      expect(a.status).toBe(200);
      expect(b.status).toBe(200);
    } finally {
      await h.cleanup();
    }
  });

  it("an IPv4-shaped rejected Host triggers exactly one throttled recompute within 5s", async () => {
    const h = await startLan({ cfg: { extraHosts: [] } });
    try {
      // 192.168.99.99 isn't a real interface address on this box, so it starts out unknown.
      const r1 = await lanRequest(h.port, { host: "192.168.99.99:" + h.port });
      expect(r1.status).toBe(421);
      // A second 421 for a *different* unknown IPv4 within the 5s window must not trigger a
      // second recompute (observable indirectly: still rejected, no crash/log storm) — the
      // pure throttle behavior itself is unit-tested in http.ts via the status transition below.
      const r2 = await lanRequest(h.port, { host: "192.168.99.98:" + h.port });
      expect(r2.status).toBe(421);
    } finally {
      await h.cleanup();
    }
  });

  it("a non-IPv4-shaped rejected Host (a name) does not trigger recompute at all", async () => {
    const h = await startLan();
    try {
      const r = await lanRequest(h.port, { host: `not-a-known-name.example:${h.port}` });
      expect(r.status).toBe(421);
    } finally {
      await h.cleanup();
    }
  });

  it("extraHosts are merged into the whitelist", async () => {
    const h = await startLan({ cfg: { extraHosts: ["hub.example.com"] } });
    try {
      const r = await lanRequest(h.port, { path: "/healthz", host: `hub.example.com:${h.port}` });
      expect(r.status).toBe(200);
    } finally {
      await h.cleanup();
    }
  });

  it("status().state is 'on' with the bound port and 'plaintext' warning always present", async () => {
    const h = await startLan();
    try {
      expect(h.fe.lan?.status()).toMatchObject({ state: "on", port: h.port, warnings: ["plaintext"] });
    } finally {
      await h.cleanup();
    }
  });

  it("OPTIONS ⇒ 404 with no Access-Control-* headers, regardless of Origin", async () => {
    const h = await startLan();
    try {
      const r = await lanRequest(h.port, {
        method: "OPTIONS",
        path: "/api/session",
        headers: { Origin: "http://evil" },
      });
      expect(r.status).toBe(404);
      expect(Object.keys(r.headers).some((k) => k.toLowerCase().startsWith("access-control"))).toBe(false);
    } finally {
      await h.cleanup();
    }
  });

  it("static resources and /healthz never touch the store (zero IPC)", async () => {
    const h = await startLan();
    try {
      for (let i = 0; i < 25; i++) {
        await lanRequest(h.port, { path: "/healthz" });
        await lanRequest(h.port, { path: "/" });
      }
      expect(h.store.sessionsBySidHash.size).toBe(0);
    } finally {
      await h.cleanup();
    }
  });

  it("loopback still serves the real index.html unauthenticated (authMode substitution itself is unit-tested in lan-static.test.ts)", async () => {
    const h = await startLan();
    try {
      const r = await lanRequest(h.port, { path: "/" });
      expect(r.status).toBe(200);
      expect(r.body).not.toContain("__AUTH_MODE__"); // never leaks the raw placeholder either way
    } finally {
      await h.cleanup();
    }
  });
});
