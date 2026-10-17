import { afterEach, describe, expect, it } from "vitest";
import { engine, identity, waitFor } from "./engine-helpers.js";
import type { HostSnapshot } from "../../../../src/web-hub/hub/ports.js";

let env: Awaited<ReturnType<typeof engine>>;
afterEach(async () => {
  await env?.close();
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
