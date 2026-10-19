import { afterEach, describe, expect, it, vi } from "vitest";
import { engine, identity, waitFor } from "./engine-helpers.js";
import * as sessionStores from "../../../../src/web-hub/hub/proxy/sessions.js";
import { CSP } from "../../../../src/web-hub/hub/http.js";
import { PROXY_STRICT_CSP_BASE, PROXY_TOMBSTONE_RING } from "../../../../src/web-hub/protocol/proxy.js";
import type { HostSnapshot } from "../../../../src/web-hub/hub/ports.js";

let env: Awaited<ReturnType<typeof engine>>;
afterEach(async () => {
  await env?.close();
  vi.restoreAllMocks();
});
describe("T-H1/H2/H5/H6 isolated listener", () => {
  it("open → enter → safe 303 + Lax browser-session cookie → filtered echo; code is one-time", async () => {
    env = await engine();
    const opened = await env.open(`http://127.0.0.1:${env.up.port}/日本?q=é`);
    const { cookie, res } = await env.enter(opened);
    expect(res.headers.location).toBe("/%E6%97%A5%E6%9C%AC?q=%C3%A9");
    expect(res.headers["set-cookie"]![0]).toMatch(/; HttpOnly; SameSite=Lax; Path=\/$/);
    expect(res.headers["set-cookie"]![0]).not.toMatch(/Max-Age|Expires/);
    expect(res.headers["referrer-policy"]).toBe("no-referrer");
    expect(res.headers["cache-control"]).toBe("no-store");
    expect((await env.http(opened.enterUrl)).status).toBe(410);
    const echoed = await env.http(opened.origin + "/echo?private=1", {
      headers: {
        Cookie: `a=1; pwh_sid=SECRET; ${cookie}; PWH_LAN=SECRET; b=2`,
        "X-PWH": "SECRET",
        Forwarded: "spoof",
        "X-Forwarded-For": "spoof",
        Origin: opened.origin,
      },
    });
    expect(echoed.status).toBe(200);
    const record = JSON.parse(echoed.body);
    expect(record.path).toBe("/echo?private=1");
    expect(record.headers.host).toBe(`127.0.0.1:${env.up.port}`);
    expect(record.headers.cookie).toBe("a=1; b=2");
    expect(record.headers.origin).toBe(`http://127.0.0.1:${env.up.port}`);
    expect(record.headers["x-forwarded-for"]).toBe("127.0.0.1");
    expect(record.headers["x-pwh"]).toBeUndefined();
    expect(record.headers.forwarded).toBeUndefined();
    const response = await env.http(opened.origin + "/headers", { headers: { Cookie: cookie } });
    expect(response.headers["clear-site-data"]).toBeUndefined();
    expect(response.headers["set-cookie"]).toEqual(["app=ok; Path=/"]);
    expect(response.headers["x-frame-options"]).toBeUndefined(); // upstream responses stay upstream
    const logs = JSON.stringify(env.logs);
    expect(logs).not.toContain(new URL(opened.enterUrl).searchParams.get("c"));
    expect(logs).not.toContain(cookie.split("=")[1]);
    expect(logs).not.toContain("private=1");
  });
  it("missing/foreign gate never dials, including a valid other instance sid and wrong origin", async () => {
    env = await engine();
    const a = await env.open();
    const auth = await env.enter(a);
    const b = await env.open(`localhost:${env.up.port}`);
    const bauth = await env.enter(b);
    for (const cookie of [
      undefined,
      "pwh_sid=valid-hub; pwh_lan=valid-hub",
      bauth.cookie,
      auth.cookie.replace(/pwh_px_\d+/, bauth.cookie.split("=")[0]!),
    ]) {
      const r = await env.http(a.origin + "/echo", { headers: cookie ? { Cookie: cookie } : {} });
      expect(r.status).toBe(401);
      expect(r.body).toContain("Link expired");
    }
    const wrongHost = await env.http(a.origin + "/echo", {
      headers: { Host: `localhost:${new URL(a.origin).port}`, Cookie: auth.cookie },
    });
    expect(wrongHost.status).toBe(401);
    expect(env.up.connections).toBe(0);
  });
  it("duplicate cookies: ignore junk, refuse two valid identities/overflow and clear best-effort", async () => {
    env = await engine();
    const opened = await env.open();
    const a = await env.enter(opened);
    const b = await env.enter(await env.open());
    const name = a.cookie.split("=")[0];
    expect((await env.http(opened.origin, { headers: { Cookie: `${name}=junk; ${a.cookie}` } })).status).toBe(200);
    const r = await env.http(opened.origin + "/a/b", { headers: { Cookie: `${a.cookie}; ${b.cookie}` } });
    expect(r.status).toBe(401);
    expect(r.body).toContain("cookie-conflict");
    expect(r.headers["set-cookie"]).toHaveLength(6);
    expect(
      (await env.http(opened.origin, { headers: { Cookie: [1, 2, 3, 4, 5].map((n) => `${name}=${n}`).join("; ") } }))
        .status,
    ).toBe(401);
  });
  it("Host allow-list is live; LAN off really binds loopback, LAN on all interfaces", async () => {
    env = await engine();
    const opened = await env.open();
    expect(env.servers[0]!.address()).toMatchObject({ address: "127.0.0.1" });
    expect(
      (await env.http(opened.origin, { headers: { Host: `evil.com:${new URL(opened.origin).port}` } })).status,
    ).toBe(421);
    expect(
      (
        await env.http(opened.origin, {
          headers: { Host: `evil.com:${new URL(opened.origin).port}`, Forwarded: "host=127.0.0.1" },
        })
      ).status,
    ).toBe(421);
    await env.close();
    let snapshot: HostSnapshot | undefined = {
      gen: 1,
      hostKeys: new Set(["dev.local:7879"]),
      externalOrigins: new Set(),
      trustProxyFrom: new Set(),
      omitted: [],
      computedAt: 0,
    };
    env = await engine({ lan: true, lanHostSnapshot: () => snapshot });
    const lan = await env.open(undefined, identity(), "dev.local");
    const { cookie } = await env.enter(lan);
    expect(env.servers[0]!.address()).toMatchObject({ address: "0.0.0.0" });
    expect((await env.http(lan.origin, { headers: { Cookie: cookie } })).status).toBe(200);
    snapshot = undefined;
    expect((await env.http(lan.origin, { headers: { Cookie: cookie } })).status).toBe(421);
  });
  it.each([
    [undefined, undefined, 200],
    ["own", undefined, 200],
    ["http://foreign:7900", undefined, 403],
    ["null", undefined, 403],
    ["own", "same-site", 403],
    [undefined, "cross-site", 403],
    ["own", "same-origin", 200],
  ])("unsafe request Origin=%s fetch-site=%s ⇒ %s", async (origin, site, status) => {
    env = await engine();
    const opened = await env.open();
    const { cookie } = await env.enter(opened);
    const response = await env.http(opened.origin, {
      method: "POST",
      body: "hello",
      headers: {
        Cookie: cookie,
        ...(origin ? { Origin: origin === "own" ? opened.origin : origin } : {}),
        ...(site ? { "Sec-Fetch-Site": site } : {}),
      },
    });
    expect(response.status).toBe(status);
    expect(env.up.requests).toHaveLength(status === 200 ? 1 : 0);
  });
  it("absolute/network form, TRACE/TRACK, CONNECT and reserved paths cannot reach upstream; redirects never followed", async () => {
    env = await engine();
    const opened = await env.open();
    const { cookie } = await env.enter(opened);
    for (const path of ["http://8.8.8.8/", "//8.8.8.8/", "*"])
      expect((await env.http(opened.origin, { path, headers: { Cookie: cookie } })).status).toBe(400);
    for (const method of ["TRACE"]) {
      expect((await env.http(opened.origin, { method, headers: { Cookie: cookie } })).status).toBe(405);
    }
    expect((await env.http(opened.origin + "/__pwh_proxy__/other", { headers: { Cookie: cookie } })).status).toBe(404);
    // llhttp rejects TRACK before the request event; clientError must destroy it.
    await expect(env.http(opened.origin, { method: "TRACK" })).rejects.toThrow();
    const s = await env.raw(Number(new URL(opened.origin).port));
    const end = new Promise((resolve) => s.once("close", resolve));
    s.write("CONNECT 8.8.8.8:80 HTTP/1.1\r\nHost: 8.8.8.8\r\n\r\n");
    await end;
    expect(env.up.connections).toBe(0);
    const r = await env.http(opened.origin + "/redirect", { headers: { Cookie: cookie } });
    expect(r.status).toBe(302);
    expect(r.headers.location).toBe("http://10.0.0.9/private?secret=1");
    expect(env.up.requests).toHaveLength(1);
    expect(env.up.connections).toBe(1);
  });
  it("enter bad-code bucket counts double and resets, unsafe nextPath stays local", async () => {
    let now = 1000;
    env = await engine({ now: () => now });
    const opened = await env.open(`http://127.0.0.1:${env.up.port}//evil`);
    for (let i = 0; i < 10; i++)
      expect((await env.http(opened.origin + "/__pwh_proxy__/enter?c=BAD")).status).toBe(410);
    expect((await env.http(opened.enterUrl)).status).toBe(429);
    now += 60_000;
    const fresh = await env.open();
    expect((await env.enter(fresh)).res.status).toBe(303);
    const safe = await env.open(`http://127.0.0.1:${env.up.port}//evil`);
    expect((await env.enter(safe)).res.headers.location).toBe("/");
  });
  it("revocation immediately cuts HTTP sockets and future use (all selector paths use same store)", async () => {
    env = await engine();
    const id = identity();
    const opened = await env.open(undefined, id);
    const { cookie } = await env.enter(opened);
    const pending = env.http(opened.origin + "/hang", { headers: { Cookie: cookie } }).catch(() => "closed");
    await waitFor(() => env.up.held === 1);
    env.service.revoke({ sel: { sidTag: id.sidTag }, reason: "logout" });
    expect(await pending).toBe("closed");
    await waitFor(() => env.up.held === 0);
    expect((await env.http(opened.origin, { headers: { Cookie: cookie } })).status).toBe(401);
  });
});

describe("LP1 enter reuse and per-request framing policy", () => {
  it("20 re-opens/reloads/new-tab redeems reuse one live session and never cut its existing WS", async () => {
    const storeSpy = vi.spyOn(sessionStores, "createProxySessionStore"); // call-through: real engine/store
    let now = Date.now();
    env = await engine({ now: () => now });
    const opened = await env.open();
    const { cookie } = await env.enter(opened);
    const store = storeSpy.mock.results[0]!.value as sessionStores.ProxySessionStore;
    const rec = store.lookup(cookie.split("=")[1]!, opened.instanceId, opened.origin, { touch: false })!;
    const hardAt = rec.hardAt;
    const ws = await env.ws(opened, cookie);
    expect(ws.text()).toContain("101 Switching Protocols");
    for (let i = 0; i < 20; i++) {
      // Preserve the existing 20/min enter bucket: the 21st request is in a fresh window.
      now += i === 19 ? 60_000 : 1000;
      const fresh = await env.open();
      const res = await env.http(fresh.enterUrl, { headers: { Cookie: cookie } });
      expect(res.status).toBe(303);
      expect(res.headers["set-cookie"]).toBeUndefined();
      expect(res.headers.location).toBe("/");
      expect(store.counts()).toEqual({ codes: 0, sessions: 1 });
      expect(rec.lastUsedAt).toBe(now);
      expect(rec.hardAt).toBe(hardAt);
      expect(ws.socket.destroyed).toBe(false);
    }
    expect((await env.http(opened.origin + "/echo", { headers: { Cookie: cookie } })).status).toBe(200);
    const frame = Buffer.from([0x81, 4, 1, 2, 3, 4]);
    ws.socket.write(frame);
    await waitFor(() => Buffer.concat(ws.chunks).includes(frame));
    expect(env.up.upgraded.size).toBe(1);
  });

  it("none/conflict cookies and a different login all create a fresh session + Set-Cookie", async () => {
    const storeSpy = vi.spyOn(sessionStores, "createProxySessionStore");
    env = await engine();
    const opened = await env.open();
    const a = await env.enter(opened); // none
    const b = await env.enter(await env.open()); // none, same identity but no cookie
    const store = storeSpy.mock.results[0]!.value as sessionStores.ProxySessionStore;
    expect(store.counts().sessions).toBe(2);
    const conflict = await env.http((await env.open()).enterUrl, { headers: { Cookie: `${a.cookie}; ${b.cookie}` } });
    expect(conflict.status).toBe(303);
    expect(conflict.headers["set-cookie"]).toHaveLength(1);
    const replacement = conflict.headers["set-cookie"]![0]!.split(";")[0]!;
    expect([a.cookie, b.cookie]).not.toContain(replacement);
    const changedLogin = await env.http((await env.open(undefined, identity(2))).enterUrl, {
      headers: { Cookie: a.cookie },
    });
    expect(changedLogin.status).toBe(303);
    expect(changedLogin.headers["set-cookie"]).toHaveLength(1);
    expect(changedLogin.headers["set-cookie"]![0]).not.toContain(a.cookie);
    expect(store.counts()).toEqual({ codes: 0, sessions: 4 });
  });

  it.each([false, true])(
    "valid canonical Host policies on 303/400/401/403/404/405/410/429/503, LAN=%s",
    async (lan) => {
      const storeSpy = vi.spyOn(sessionStores, "createProxySessionStore");
      let now = Date.now();
      env = await engine({
        hubPort: 7878,
        ...(lan ? { lanPort: 7879 } : {}),
        lan,
        now: () => now,
        lanHostSnapshot: () => ({
          gen: 1,
          hostKeys: new Set(["dev.local:7879"]),
          externalOrigins: new Set(),
          trustProxyFrom: new Set(),
          omitted: [],
          computedAt: now,
        }),
      });
      const host = lan ? "dev.local" : "localhost";
      const opened = await env.open(undefined, identity(), host);
      // Raw mixed case is canonicalized before constructing the policy; Forwarded is never trusted.
      const entered = await env.http(opened.enterUrl, {
        headers: { Host: new URL(opened.origin).host.toUpperCase(), Forwarded: "host=evil.com" },
      });
      const cookie = entered.headers["set-cookie"]![0]!.split(";")[0]!;
      const second = await env.enter(await env.open(undefined, identity(), host));
      const responses: Array<[number, Awaited<ReturnType<typeof env.http>>]> = [
        [303, entered],
        [400, await env.http(opened.origin, { path: "http://evil/" })],
        [401, await env.http(opened.origin)],
        [401, await env.http(opened.origin, { headers: { Cookie: `${cookie}; ${second.cookie}` } })],
        [403, await env.http(opened.origin, { method: "POST", headers: { Cookie: cookie, Origin: "http://evil" } })],
        [404, await env.http(opened.origin + "/__pwh_proxy__/x")],
        [405, await env.http(opened.origin, { method: "TRACE" })],
        [410, await env.http(opened.enterUrl, { headers: { Cookie: cookie } })],
      ];
      for (let i = 0; i < 8; i++) await env.http(opened.enterUrl);
      responses.push([429, await env.http(opened.enterUrl)]);
      // A tombstone gap is a post-Host enter 503, still frameable (unlike closing 503).
      now += 60_000;
      const gapCode = await env.open(undefined, identity(), host);
      const store = storeSpy.mock.results[0]!.value as sessionStores.ProxySessionStore;
      for (let i = 0; i <= PROXY_TOMBSTONE_RING; i++)
        store.revoke({ sel: { sidTag: `unrelated-${i}` }, reason: "logout" });
      responses.push([503, await env.http(gapCode.enterUrl)]);
      for (const [status, response] of responses) {
        expect(response.status).toBe(status);
        expect(response.headers["content-security-policy"]).toBe(
          `${PROXY_STRICT_CSP_BASE}; frame-ancestors 'self' http://${host}:7878${lan ? ` http://${host}:7879` : ""}`,
        );
        expect(response.headers["x-frame-options"]).toBeUndefined();
        expect(response.headers["x-content-type-options"]).toBe("nosniff");
        expect(response.headers["referrer-policy"]).toBe("no-referrer");
        expect(response.headers["cache-control"]).toBe("no-store");
      }
      expect(env.up.connections).toBe(0);
    },
  );

  it("17 distinct non-reusing redeems still yield a frameable 429 sessions (no cap increase)", async () => {
    env = await engine({ hubPort: 7878 });
    let firstCookie = "";
    let opened = await env.open();
    for (let i = 0; i < 16; i++) {
      const { cookie } = await env.enter(opened);
      firstCookie ||= cookie;
      opened = await env.open();
    }
    const res = await env.http(opened.enterUrl);
    expect(res.status).toBe(429);
    expect(JSON.parse(res.body)).toEqual({ error: "E_RATE", reason: "sessions" });
    expect(res.headers["content-security-policy"]).toBe(
      `${PROXY_STRICT_CSP_BASE}; frame-ancestors 'self' http://127.0.0.1:7878`,
    );
    expect(res.headers["x-frame-options"]).toBeUndefined();
    expect((await env.http(opened.origin, { headers: { Cookie: firstCookie } })).status).toBe(200);
  });

  it("invalid Host 421, closing 503 and WS rejects keep exact strict headers", async () => {
    env = await engine({ hubPort: 7878, lanPort: 7879 });
    const opened = await env.open();
    const { cookie } = await env.enter(opened);
    const badHost = await env.http(opened.origin, { headers: { Host: "evil:7900" } });
    expect(badHost.status).toBe(421);
    expect(badHost.headers["content-security-policy"]).toBe(CSP);
    expect(badHost.headers["x-frame-options"]).toBe("DENY");
    for (const [cred, options, status] of [
      ["", {}, 401],
      [cookie, { origin: "http://evil" }, 403],
      [cookie, { upgrade: "h2c" }, 400],
      [cookie, { path: "/__pwh_proxy__/x" }, 404],
    ] as const) {
      const ws = await env.ws(opened, cred, options);
      expect(ws.text()).toContain(`HTTP/1.1 ${status}`);
      expect(ws.text()).toContain(`Content-Security-Policy: ${CSP}\r\n`);
      expect(ws.text()).toContain("X-Frame-Options: DENY\r\n");
    }
    // The real close fence destroys connections immediately; invoke its actual request handler
    // after disposal to cover a request already parsed/queued when close began.
    await env.service.dispose();
    const res = { destroyed: false, headersSent: false, writeHead: vi.fn(), end: vi.fn() };
    env.servers[0]!.emit("request", { headers: { host: new URL(opened.origin).host } }, res);
    expect(res.writeHead).toHaveBeenCalledWith(503, {
      "Content-Security-Policy": CSP,
      "X-Frame-Options": "DENY",
      "X-Content-Type-Options": "nosniff",
      "Referrer-Policy": "no-referrer",
      "Cache-Control": "no-store",
      "Content-Type": "text/plain; charset=utf-8",
    });
    expect(res.end).toHaveBeenCalledWith("Proxy request refused\n");
  });
});
