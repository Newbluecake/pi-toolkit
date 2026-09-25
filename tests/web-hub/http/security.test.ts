import { chmodSync, mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { Server as NetServer, connect, createServer as createNetServer } from "node:net";
import { dirname } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// Delegate to the real implementation but observe calls: both a wrong and a
// right token must go through the constant-time comparison branch.
vi.mock("node:crypto", async (importOriginal) => {
  const real = await importOriginal<typeof import("node:crypto")>();
  return { ...real, timingSafeEqual: vi.fn(real.timingSafeEqual) };
});

import { timingSafeEqual } from "node:crypto";
import { createHttpFrontend, CSP } from "../../../src/web-hub/hub/http.js";
import type { HttpFrontend } from "../../../src/web-hub/hub/ports.js";
import { fakeDeps, login, makeAgent, makeTmp, openSse, postJson, rawRequest, type FakeDeps } from "./helpers.js";

let tmp: ReturnType<typeof makeTmp>;
let deps: FakeDeps;
let fe: HttpFrontend | undefined;
let port: number;

async function start(d: FakeDeps = deps): Promise<number> {
  fe = createHttpFrontend(d);
  return (await fe.listen()).port;
}

beforeEach(() => {
  tmp = makeTmp();
  deps = fakeDeps(tmp.dir);
});

afterEach(async () => {
  await fe?.close();
  fe = undefined;
  vi.restoreAllMocks();
  tmp.cleanup();
});

describe("host / auth / csrf gates", () => {
  beforeEach(async () => {
    port = await start();
    deps.agents.set("a1", makeAgent("a1"));
  });

  it("rejects a forged Host header with 421 before auth (DNS rebinding)", async () => {
    for (const host of [`evil:${port}`, "127.0.0.1", `127.0.0.1:${port + 1}`, `localhost.evil.com:${port}`]) {
      const res = await rawRequest(port, { path: "/", headers: { Host: host } });
      expect(res.status, host).toBe(421);
      expect(JSON.parse(res.body)).toEqual({ error: "E_HOST" });
    }
    const api = await rawRequest(port, { path: "/api/events", headers: { Host: `evil:${port}` } });
    expect(api.status).toBe(421);
  });

  it("accepts both 127.0.0.1:<port> and localhost:<port>", async () => {
    for (const host of [`127.0.0.1:${port}`, `localhost:${port}`, `LOCALHOST:${port}`]) {
      const res = await rawRequest(port, { path: "/healthz", headers: { Host: host } });
      expect(res.status, host).toBe(200);
      expect(JSON.parse(res.body)).toEqual({ ok: true, version: "9.9.9" });
    }
  });

  it("requires the session cookie on /api/* (401)", async () => {
    expect((await rawRequest(port, { path: "/api/events" })).status).toBe(401);
    expect((await rawRequest(port, { path: "/api/history?agent=a1&before=x" })).status).toBe(401);
    expect((await postJson(port, "/api/subscribe", { clientId: "c", agentKey: "a1" })).status).toBe(401);
    const bad = await rawRequest(port, { path: "/api/events", headers: { Cookie: "pwh_sid=forged" } });
    expect(bad.status).toBe(401);
    expect(JSON.parse(bad.body)).toEqual({ error: "E_AUTH" });
  });

  it("CSRF: missing X-PWH, wrong Content-Type or cross Origin ⇒ 403 E_CSRF", async () => {
    const cookie = await login(port, deps.paths.tokenFile);
    const body = JSON.stringify({ clientId: "c", agentKey: "a1" });
    const cases: Array<Record<string, string>> = [
      { "Content-Type": "application/json", Cookie: cookie },
      { "Content-Type": "text/plain", "X-PWH": "1", Cookie: cookie },
      { "Content-Type": "application/x-www-form-urlencoded", "X-PWH": "1", Cookie: cookie },
      { "Content-Type": "application/json", "X-PWH": "1", Origin: "http://evil.example", Cookie: cookie },
      { "Content-Type": "application/json", "X-PWH": "1", Origin: "null", Cookie: cookie },
      { "Content-Type": "application/json", "X-PWH": "0", Cookie: cookie },
    ];
    for (const headers of cases) {
      const res = await rawRequest(port, { method: "POST", path: "/api/subscribe", headers, body });
      expect(res.status, JSON.stringify(headers)).toBe(403);
      expect(JSON.parse(res.body)).toEqual({ error: "E_CSRF" });
    }
    // login itself is CSRF-gated too
    const lg = await rawRequest(port, {
      method: "POST",
      path: "/api/login",
      headers: { "Content-Type": "application/json" },
      body: "{}",
    });
    expect(lg.status).toBe(403);
    // same-origin Origin passes the gate (then 404: unknown clientId)
    const ok = await postJson(
      port,
      "/api/subscribe",
      { clientId: "nope", agentKey: "a1" },
      {
        Cookie: cookie,
        Origin: `http://127.0.0.1:${port}`,
      },
    );
    expect(ok.status).toBe(404);
  });

  it("login sets an HttpOnly SameSite=Strict cookie and logout invalidates it", async () => {
    const cookie = await login(port, deps.paths.tokenFile);
    expect(cookie).toMatch(/^pwh_sid=[A-Za-z0-9_-]{40,}$/);
    const sse = await openSse(port, { cookie });
    expect(sse.status).toBe(200);
    sse.close();
    const out = await postJson(port, "/api/logout", {}, { Cookie: cookie });
    expect(out.status).toBe(200);
    expect(out.headers["set-cookie"]?.[0]).toMatch(/Max-Age=0/);
    expect((await rawRequest(port, { path: "/api/events", headers: { Cookie: cookie } })).status).toBe(401);
  });

  it("login Set-Cookie attributes", async () => {
    const res = await postJson(port, "/api/login", { token: tokenOf(deps) });
    expect(res.status).toBe(200);
    const sc = res.headers["set-cookie"]?.[0] ?? "";
    expect(sc).toContain("HttpOnly");
    expect(sc).toContain("SameSite=Strict");
    expect(sc).toContain("Path=/");
  });

  it("login is rate limited: 5 failures then the 6th attempt ⇒ 429 (even with the right token)", async () => {
    for (let i = 0; i < 5; i++) {
      const res = await postJson(port, "/api/login", { token: `wrong-${i}` });
      expect(res.status).toBe(401);
    }
    const sixth = await postJson(port, "/api/login", { token: tokenOf(deps) });
    expect(sixth.status).toBe(429);
    expect(JSON.parse(sixth.body)).toEqual({ error: "E_RATE" });
    expect(sixth.headers["retry-after"]).toBe("60");
  });

  it("wrong and right tokens both take the timingSafeEqual branch", async () => {
    const spy = vi.mocked(timingSafeEqual);
    spy.mockClear();
    expect((await postJson(port, "/api/login", { token: "x".repeat(43) })).status).toBe(401);
    expect(spy).toHaveBeenCalledTimes(1);
    expect((await postJson(port, "/api/login", { token: 12345 })).status).toBe(401); // non-string too
    expect(spy).toHaveBeenCalledTimes(2);
    expect((await postJson(port, "/api/login", { token: tokenOf(deps) })).status).toBe(200);
    expect(spy).toHaveBeenCalledTimes(3);
    // digests are equal-length (sha256) ⇒ no length oracle
    for (const [a, b] of spy.mock.calls) expect((a as Buffer).length).toBe((b as Buffer).length);
  });

  it("body over 64 KiB ⇒ 413; malformed JSON ⇒ 400", async () => {
    const big = JSON.stringify({ token: "x".repeat(70 * 1024) });
    const res = await rawRequest(port, {
      method: "POST",
      path: "/api/login",
      headers: { "Content-Type": "application/json", "X-PWH": "1" },
      body: big,
    });
    expect(res.status).toBe(413);
    const bad = await rawRequest(port, {
      method: "POST",
      path: "/api/login",
      headers: { "Content-Type": "application/json", "X-PWH": "1" },
      body: "{not json",
    });
    expect(bad.status).toBe(400);
    expect(JSON.parse(bad.body)).toMatchObject({ error: "E_BAD_REQUEST" });
  });

  it("security headers on every response kind; /api adds Cache-Control: no-store", async () => {
    const cookie = await login(port, deps.paths.tokenFile);
    const responses = [
      await rawRequest(port, { path: "/" }), // static (may 404 if frontend not built yet)
      await rawRequest(port, { path: "/healthz" }),
      await rawRequest(port, { path: "/nope.png" }),
      await rawRequest(port, { path: "/", headers: { Host: "evil:1" } }),
      await rawRequest(port, { path: "/api/events" }),
      await rawRequest(port, { path: "/api/history?agent=a1", headers: { Cookie: cookie } }),
      await postJson(port, "/api/cmd", {}, { Cookie: cookie }),
    ];
    for (const res of responses) {
      expect(res.headers["content-security-policy"]).toBe(CSP);
      expect(res.headers["x-frame-options"]).toBe("DENY");
      expect(res.headers["x-content-type-options"]).toBe("nosniff");
      expect(res.headers["referrer-policy"]).toBe("no-referrer");
    }
    expect(CSP).toContain("frame-ancestors 'none'");
    expect(CSP).toContain("script-src 'self'");
    for (const res of responses.slice(4)) expect(res.headers["cache-control"]).toBe("no-store");
  });
});

describe("token file and bind address", () => {
  it("creates the token file 0600 with a 32-byte base64url token", async () => {
    port = await start();
    const st = statSync(deps.paths.tokenFile);
    expect(st.mode & 0o777).toBe(0o600);
    expect(tokenOf(deps)).toMatch(/^[A-Za-z0-9_-]{43}$/);
  });

  it("repairs a 0644 token file to 0600 (keeps the token) and warns", async () => {
    mkdirSync(dirname(deps.paths.tokenFile), { recursive: true });
    const existing = "A".repeat(43);
    writeFileSync(deps.paths.tokenFile, `${existing}\n`);
    chmodSync(deps.paths.tokenFile, 0o644);
    port = await start();
    expect(statSync(deps.paths.tokenFile).mode & 0o777).toBe(0o600);
    expect(tokenOf(deps)).toBe(existing);
    expect(deps.logLines.some((l) => l.level === "warn" && l.msg.includes("mode"))).toBe(true);
    expect((await postJson(port, "/api/login", { token: existing })).status).toBe(200);
  });

  it("listens on 127.0.0.1 only", async () => {
    const spy = vi.spyOn(NetServer.prototype, "listen");
    port = await start();
    const hosts = spy.mock.calls.map((c) => c[1]);
    expect(hosts).toEqual(["127.0.0.1"]);
    spy.mockRestore();
    // not reachable on other loopback-ish addresses (::1 may not exist ⇒ also an error)
    await expect(
      new Promise<void>((resolve, reject) => {
        const c = connect({ host: "::1", port });
        c.once("connect", () => {
          c.destroy();
          resolve();
        });
        c.once("error", reject);
      }),
    ).rejects.toBeTruthy();
  });

  it("falls back to a random port on EADDRINUSE; port 0 ⇒ random", async () => {
    const blocker = createNetServer();
    await new Promise<void>((r) => blocker.listen(0, "127.0.0.1", r));
    const busy = (blocker.address() as { port: number }).port;
    try {
      const d = fakeDeps(tmp.dir, { port: busy });
      fe = createHttpFrontend(d);
      const got = (await fe.listen()).port;
      expect(got).not.toBe(busy);
      expect(got).toBeGreaterThan(0);
      expect(d.logLines.some((l) => l.level === "warn" && l.msg.includes("port in use"))).toBe(true);
      expect((await rawRequest(got, { path: "/healthz" })).status).toBe(200);
    } finally {
      await new Promise<void>((r) => blocker.close(() => r()));
    }
  });

  it("close() is bounded even with an open SSE stream and drops clients", async () => {
    port = await start();
    const cookie = await login(port, deps.paths.tokenFile);
    const sse = await openSse(port, { cookie });
    await sse.waitFor((e) => e.event === "agents");
    expect(fe!.clientCount()).toBe(1);
    const t0 = Date.now();
    await fe!.close();
    expect(Date.now() - t0).toBeLessThan(2_500);
    expect(fe!.clientCount()).toBe(0);
    await sse.waitEnd();
    expect(deps.listeners()).toBe(0);
  });
});

function tokenOf(d: FakeDeps): string {
  return readFileSync(d.paths.tokenFile, "utf8").trim();
}
