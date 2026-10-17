/**
 * web-hub-proxy X1c — hub wiring against a REAL hub (plan v2 §9: T-H8, T-A1; T-A2 is in
 * `proxy-redaction.test.ts`). Real `startHub` + real `createHttpFrontend` + both listeners + the
 * real hub.log; only the LAN store/KDF and the upstream are fakes.
 */
import { existsSync, readFileSync, statSync } from "node:fs";
import { connect } from "node:net";
import { networkInterfaces } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { apiCrossSiteOk } from "../../../src/web-hub/hub/http.js";
import { PROXY_HUB_CAP, PROXY_LAN_HUB_CAP } from "../../../src/web-hub/protocol/version.js";
import { API_ERRORS } from "../../../src/web-hub/protocol/http-contract.js";
import type { IncomingMessage } from "node:http";
import { cleanupProxyHubs, startProxyHub, type ProxyHub } from "./proxy-kit.js";
import { lanRequest } from "./lan-helpers.js";

afterEach(cleanupProxyHubs);

const portOf = (origin: string): number => Number(new URL(origin).port);
function dial(port: number, host = "127.0.0.1"): Promise<"connected" | "refused"> {
  return new Promise((resolve) => {
    const s = connect(port, host);
    s.once("connect", () => {
      s.destroy();
      resolve("connected");
    });
    s.once("error", () => resolve("refused"));
  });
}
const lanIp = Object.values(networkInterfaces())
  .flatMap((a) => a ?? [])
  .find((i) => i.family === "IPv4" && !i.internal)?.address;

describe("wire contract: API_ERRORS tail", () => {
  it("E_PROXY_DENIED / E_PROXY_UNAVAILABLE are tail-appended (append-only)", () => {
    expect(API_ERRORS.slice(-2)).toEqual(["E_PROXY_DENIED", "E_PROXY_UNAVAILABLE"]);
  });
});

describe("T-H8 proxy OFF ⇒ the hub is byte-identical to a hub without the feature", () => {
  it("no cap, no routes (== any unknown /api path), no listeners, no disk, no hub.json key, P4 and cookie-candidate max unarmed", async () => {
    const h = await startProxyHub({ proxy: false });
    const caps = h.hub.info.caps ?? [];
    expect(caps).not.toContain(PROXY_HUB_CAP);
    expect(caps).not.toContain(PROXY_LAN_HUB_CAP);
    // the three routes answer EXACTLY like an unknown /api path (same status + body)
    const ghostPost = await h.api("POST", "/api/ghost-route", { body: { target: "x" } });
    const ghostGet = await h.api("GET", "/api/ghost-route");
    for (const [method, path] of [
      ["POST", "/api/proxy/open"],
      ["GET", "/api/proxy"],
      ["POST", "/api/proxy/stop"],
    ] as const) {
      const r = await h.api(method, path, method === "POST" ? { body: { target: "127.0.0.1:1" } } : {});
      const ghost = method === "POST" ? ghostPost : ghostGet;
      expect([r.status, r.body]).toEqual([ghost.status, ghost.body]);
    }
    // no listeners on the configured range, no disk
    for (const p of [h.range[0], h.range[1]]) expect(await dial(p)).toBe("refused");
    expect(existsSync(join(h.stateDir, "proxy"))).toBe(false);
    expect(JSON.parse(readFileSync(h.hub.paths.hubJson, "utf8"))).not.toHaveProperty("proxy");
    // P4 unarmed: a cross-site-looking request is judged exactly as before (200, not 403)
    const cross = await h.api("GET", "/api/version", {
      headers: { "Sec-Fetch-Site": "same-site", Origin: "http://127.0.0.1:7901" },
    });
    expect(cross.status).toBe(200);
    // max = 1: a junk first `pwh_sid` is NOT skipped (first-value, byte-identical 401, no Set-Cookie)
    const dup = await h.api("GET", "/api/version", { cookie: `pwh_sid=junk; ${h.cookie}` });
    expect(dup.status).toBe(401);
    expect(JSON.parse(dup.body)).toEqual({ error: "E_AUTH" });
    expect(dup.headers["set-cookie"]).toBeUndefined();
  });

  it("LAN on but proxy off: still no proxy.lan.v1 and the LAN face 404s the routes like any unknown path", async () => {
    const h = await startProxyHub({ proxy: false, lan: true });
    expect(h.hub.info.caps ?? []).not.toContain(PROXY_LAN_HUB_CAP);
    const lan = await h.lanLogin();
    const lp = await h.lanPort();
    const ghost = await lanRequest(lp, {
      method: "POST",
      path: "/api/ghost-route",
      headers: { "Content-Type": "application/json", "X-PWH": "1", Cookie: lan.cookie, ...lan.headers },
      body: "{}",
    });
    const real = await lanRequest(lp, {
      method: "POST",
      path: "/api/proxy/open",
      headers: { "Content-Type": "application/json", "X-PWH": "1", Cookie: lan.cookie, ...lan.headers },
      body: JSON.stringify({ target: "127.0.0.1:1" }),
    });
    expect([real.status, real.body]).toEqual([ghost.status, ghost.body]);
  });
});

describe("T-H8 proxy ON, LAN OFF", () => {
  it("advertises proxy.v1 only (both cap surfaces), binds loopback only, persists 0600 ports.json before the link, reports hub.json status", async () => {
    const h = await startProxyHub();
    expect(h.hub.info.caps).toContain(PROXY_HUB_CAP);
    expect(h.hub.info.caps).not.toContain(PROXY_LAN_HUB_CAP);
    const opened = await h.open();
    const pp = portOf(opened.origin);
    expect(pp).toBeGreaterThanOrEqual(h.range[0]);
    expect(pp).toBeLessThanOrEqual(h.range[1]);
    expect(opened.origin).toBe(`http://127.0.0.1:${pp}`);
    // loopback-only bind: 127.0.0.2 is loopback too, but only a 0.0.0.0 bind would accept it
    expect(await dial(pp, "127.0.0.1")).toBe("connected");
    expect(await dial(pp, "127.0.0.2")).toBe("refused");
    const file = join(h.stateDir, "proxy", "ports.json");
    expect(statSync(file).mode & 0o777).toBe(0o600);
    expect(JSON.parse(readFileSync(file, "utf8")).entries).toEqual([
      expect.objectContaining({ key: `127.0.0.1|${h.up.port}|127.0.0.1:${h.up.port}`, port: pp }),
    ]);
    expect(JSON.parse(readFileSync(h.hub.paths.hubJson, "utf8")).proxy).toEqual({ portsStore: "ok" });
    // GET /api/proxy policy: lan false
    const list = JSON.parse((await h.api("GET", "/api/proxy")).body);
    expect(list.policy).toEqual({ maxProxies: 8, portRange: h.range, lan: false });
    expect(list.items).toHaveLength(1);
  });

  it("open → enter(303, Lax cookie) → echo through the proxy; the upstream never sees a pwh_* cookie", async () => {
    const h = await startProxyHub();
    const opened = await h.open();
    const enter = await h.http(opened.enterUrl);
    expect(enter.status).toBe(303);
    const sc = enter.headers["set-cookie"]![0]!;
    expect(sc).toMatch(/SameSite=Lax/i);
    const gate = sc.split(";")[0]!;
    const echo = await h.http(`${opened.origin}/hello?x=1`, {
      headers: { Cookie: `${gate}; pwh_sid=${"z".repeat(43)}; a=1` },
    });
    expect(echo.status).toBe(200);
    const seen = h.up.requests.at(-1)!;
    expect(seen.path).toBe("/hello?x=1");
    expect(String(seen.headers.cookie ?? "")).toBe("a=1");
    // the hub cookie never works as a gate cookie
    const hubOnly = await h.http(`${opened.origin}/hello`, { headers: { Cookie: h.cookie } });
    expect(hubOnly.status).toBe(401);
  });

  it("real fallback port: the configured hub port is occupied ⇒ the hub binds a random one ⇒ a proxy to it is `self-port`", async () => {
    const h = await startProxyHub({ occupyHubPort: true });
    expect(h.port).not.toBe(h.configured.port);
    const r = await h.api("POST", "/api/proxy/open", { body: { target: `127.0.0.1:${h.port}` } });
    expect(r.status).toBe(403);
    expect(JSON.parse(r.body)).toEqual({ error: "E_PROXY_DENIED", reason: "self-port" });
    // the OCCUPIED (configured) port is a foreign service ⇒ allowed
    const foreign = await h.api("POST", "/api/proxy/open", { body: { target: `127.0.0.1:${h.configured.port}` } });
    expect(foreign.status).toBe(200);
    // and the whole proxy range is self-port too
    const inRange = await h.api("POST", "/api/proxy/open", { body: { target: `127.0.0.1:${h.range[0]}` } });
    expect(JSON.parse(inRange.body).reason).toBe("self-port");
  });

  it("route gate: strict CSRF + auth before anything; E_PROXY_DENIED body shape for a public target; list needs X-PWH", async () => {
    const h = await startProxyHub();
    // no cookie ⇒ 401 (no oracle about the service)
    expect((await h.api("POST", "/api/proxy/open", { cookie: null, body: { target: "127.0.0.1:1" } })).status).toBe(
      401,
    );
    // missing X-PWH ⇒ 403 E_CSRF
    const noPwh = await h.api("POST", "/api/proxy/open", {
      body: { target: "127.0.0.1:1" },
      headers: { "X-PWH": "" },
    });
    expect(noPwh.status).toBe(403);
    expect((await h.api("GET", "/api/proxy", { headers: { "X-PWH": "" } })).status).toBe(403);
    const pub = await h.api("POST", "/api/proxy/open", { body: { target: "8.8.8.8:80" } });
    expect([pub.status, JSON.parse(pub.body)]).toEqual([403, { error: "E_PROXY_DENIED", reason: "public" }]);
    const bad = await h.api("POST", "/api/proxy/open", { body: { target: "unix:/run/x.sock" } });
    expect(bad.status).toBe(400);
    const stop404 = await h.api("POST", "/api/proxy/stop", { body: { instanceId: "inst-doesnotexist" } });
    expect(stop404.status).toBe(404);
  });

  it("stop closes the listener (and its websockets); the port binding survives", async () => {
    const h = await startProxyHub();
    const opened = await h.open();
    const pp = portOf(opened.origin);
    const r = await h.api("POST", "/api/proxy/stop", { body: { instanceId: opened.instanceId } });
    expect(r.status).toBe(200);
    expect(JSON.parse(r.body)).toEqual({ ok: true });
    expect(await dial(pp)).toBe("refused");
    const again = await h.open();
    expect(portOf(again.origin)).toBe(pp); // sticky binding (§3.3)
  });

  it("revocation bus: hub logout kills the proxy session (next request ⇒ expired page, upstream untouched)", async () => {
    const h = await startProxyHub();
    const opened = await h.open();
    const enter = await h.http(opened.enterUrl);
    const gate = enter.headers["set-cookie"]![0]!.split(";")[0]!;
    expect((await h.http(`${opened.origin}/a`, { headers: { Cookie: gate } })).status).toBe(200);
    const before = h.up.requests.length;
    const out = await h.api("POST", "/api/logout", { body: {} });
    expect(out.status).toBeLessThan(400);
    const after = await h.http(`${opened.origin}/a`, { headers: { Cookie: gate } });
    expect(after.status).toBe(401);
    expect(h.up.requests.length).toBe(before);
  });

  it("hub restart on the same state dir: the same target gets the SAME port back, an old gate cookie is a 401", async () => {
    const first = await startProxyHub();
    const opened = await first.open();
    const gate = (await first.http(opened.enterUrl)).headers["set-cookie"]![0]!.split(";")[0]!;
    expect((await first.http(`${opened.origin}/x`, { headers: { Cookie: gate } })).status).toBe(200);
    await first.hub.close("test");
    expect(await dial(portOf(opened.origin))).toBe("refused");
    const { startHub } = await import("../../../src/web-hub/hub/hub.js");
    const { createHttpFrontend } = await import("../../../src/web-hub/hub/http.js");
    const again = await startHub(first.configured, (d) => createHttpFrontend(d), { uid: process.getuid?.() ?? 0 });
    if ("exists" in again) throw new Error("unexpected exists");
    try {
      const { login, rawRequest } = await import("./helpers.js");
      const cookie = await login(again.httpPort, again.paths.tokenFile);
      const r = await rawRequest(again.httpPort, {
        method: "POST",
        path: "/api/proxy/open",
        headers: {
          "Content-Type": "application/json",
          "X-PWH": "1",
          Origin: `http://127.0.0.1:${again.httpPort}`,
          Cookie: cookie,
        },
        body: JSON.stringify({ target: `127.0.0.1:${first.up.port}` }),
      });
      expect(r.status).toBe(200);
      const reopened = JSON.parse(r.body);
      expect(portOf(reopened.origin)).toBe(portOf(opened.origin));
      expect((await first.http(`${reopened.origin}/x`, { headers: { Cookie: gate } })).status).toBe(401);
    } finally {
      await again.close("test");
    }
  });

  it("hub.json reports ports-store `broken` at boot when ports.json is corrupt (never rewritten)", async () => {
    // pre-seed a corrupt store through the hub's own state dir, then boot a SECOND hub on the same home
    const first = await startProxyHub();
    await first.open();
    const file = join(first.stateDir, "proxy", "ports.json");
    await first.hub.close("test");
    const { writeFileSync } = await import("node:fs");
    writeFileSync(file, "{not json");
    const bytes = readFileSync(file);
    // restart on the same home: a fresh kit would use a fresh home, so re-open via the config
    const { startHub } = await import("../../../src/web-hub/hub/hub.js");
    const { createHttpFrontend } = await import("../../../src/web-hub/hub/http.js");
    const again = await startHub(first.configured, (d) => createHttpFrontend(d), { uid: process.getuid?.() ?? 0 });
    if ("exists" in again) throw new Error("unexpected exists");
    try {
      expect(JSON.parse(readFileSync(again.paths.hubJson, "utf8")).proxy).toEqual({ portsStore: "broken" });
      expect(readFileSync(file).equals(bytes)).toBe(true);
    } finally {
      await again.close("test");
    }
  });
});

describe("T-H8 proxy ON, LAN ON", () => {
  it("advertises proxy.lan.v1 too; binds 0.0.0.0; a LAN session opens with the browser host from the LAN request", async () => {
    const h = await startProxyHub({ lan: true });
    expect(h.hub.info.caps).toContain(PROXY_HUB_CAP);
    expect(h.hub.info.caps).toContain(PROXY_LAN_HUB_CAP);
    const lan = await h.lanLogin();
    const lp = await h.lanPort();
    const r = await lanRequest(lp, {
      method: "POST",
      path: "/api/proxy/open",
      headers: { "Content-Type": "application/json", "X-PWH": "1", Cookie: lan.cookie, ...lan.headers },
      body: JSON.stringify({ target: `127.0.0.1:${h.up.port}` }),
    });
    expect(r.status).toBe(200);
    const opened = JSON.parse(r.body);
    const pp = portOf(opened.origin);
    expect(opened.origin).toBe(`http://127.0.0.1:${pp}`);
    expect(await dial(pp, "127.0.0.2")).toBe("connected"); // 0.0.0.0 bind
    // loopback principal and LAN principal are distinct: the LAN user cannot stop... but a loopback one can
    const stop = await h.api("POST", "/api/proxy/stop", { body: { instanceId: opened.instanceId } });
    expect(stop.status).toBe(200);
  });

  it.skipIf(lanIp === undefined)(
    "Host allow-list follows the LIVE LAN snapshot: a LAN host ⇒ ok, after LAN teardown ⇒ 421",
    async () => {
      const h = await startProxyHub({ lan: true });
      await h.lanPort(); // the listener (and its snapshot) is up
      const opened = await h.open();
      const pp = portOf(opened.origin);
      const gate = (await h.http(opened.enterUrl)).headers["set-cookie"]![0]!.split(";")[0]!;
      const viaLan = () => h.http(`http://127.0.0.1:${pp}/x`, { headers: { Host: `${lanIp}:${pp}`, Cookie: gate } });
      // the gate cookie is origin-bound to the loopback origin ⇒ 401 (NOT 421): the Host passed
      expect((await viaLan()).status).toBe(401);
      expect((await h.http(`http://127.0.0.1:${pp}/x`, { headers: { Host: `evil.example:${pp}` } })).status).toBe(421);
      await h.hub.lan!.close();
      expect((await viaLan()).status).toBe(421);
      // loopback names keep working
      expect((await h.http(`${opened.origin}/x`, { headers: { Cookie: gate } })).status).toBe(200);
    },
  );

  it("LAN logout revokes the LAN-minted proxy session", async () => {
    const h = await startProxyHub({ lan: true });
    const lan = await h.lanLogin();
    const lp = await h.lanPort();
    const hdrs = { "Content-Type": "application/json", "X-PWH": "1", Cookie: lan.cookie, ...lan.headers };
    const open = JSON.parse(
      (
        await lanRequest(lp, {
          method: "POST",
          path: "/api/proxy/open",
          headers: hdrs,
          body: JSON.stringify({ target: `127.0.0.1:${h.up.port}` }),
        })
      ).body,
    );
    const gate = (await h.http(open.enterUrl)).headers["set-cookie"]![0]!.split(";")[0]!;
    expect((await h.http(`${open.origin}/ok`, { headers: { Cookie: gate } })).status).toBe(200);
    const out = await lanRequest(lp, { method: "POST", path: "/api/logout", headers: hdrs, body: "{}" });
    expect(out.status).toBeLessThan(400);
    expect((await h.http(`${open.origin}/ok`, { headers: { Cookie: gate } })).status).toBe(401);
  });
});

describe("T-H8 trusted reverse proxy", () => {
  it("open AND stop through the trusted reverse proxy are refused at the route gate (409 reverse-proxy); list still works", async () => {
    const h = await startProxyHub({
      lan: { trustProxyFrom: ["127.0.0.1"], externalOrigins: ["https://hub.example.com"] },
    });
    const lan = await h.lanLogin();
    const lp = await h.lanPort();
    const hdrs = { "Content-Type": "application/json", "X-PWH": "1", Cookie: lan.cookie, ...lan.headers };
    const open = await lanRequest(lp, {
      method: "POST",
      path: "/api/proxy/open",
      headers: hdrs,
      body: JSON.stringify({ target: `127.0.0.1:${h.up.port}` }),
    });
    expect([open.status, JSON.parse(open.body)]).toEqual([
      409,
      { error: "E_PROXY_UNAVAILABLE", reason: "reverse-proxy" },
    ]);
    const stop = await lanRequest(lp, {
      method: "POST",
      path: "/api/proxy/stop",
      headers: hdrs,
      body: JSON.stringify({ instanceId: "inst-12345678" }),
    });
    expect(stop.status).toBe(409);
    expect(JSON.parse(stop.body).reason).toBe("reverse-proxy");
    const list = await lanRequest(lp, {
      path: "/api/proxy",
      headers: { "X-PWH": "1", Cookie: lan.cookie, ...lan.headers },
    });
    expect(list.status).toBe(200);
    // nothing was ever created
    expect(existsSync(join(h.stateDir, "proxy", "ports.json"))).toBe(false);
  });
});

describe("T-A1 hub /api cross-site gate (P4), proxy ON, both listeners", () => {
  const hostile = (proxyPort: number): Array<[string, Record<string, string>]> => [
    ["Origin = a proxy origin", { Origin: `http://127.0.0.1:${proxyPort}` }],
    ["Sec-Fetch-Site same-site", { "Sec-Fetch-Site": "same-site" }],
    ["Sec-Fetch-Site cross-site", { "Sec-Fetch-Site": "cross-site" }],
    ["both", { Origin: `http://127.0.0.1:${proxyPort}`, "Sec-Fetch-Site": "same-site" }],
    ["Origin null", { Origin: "null" }],
  ];

  it("loopback: valid hub cookie + any hostile header combination ⇒ every /api GET and POST is 403 E_CSRF, never ACAO", async () => {
    const h = await startProxyHub();
    const pp = portOf((await h.open()).origin);
    const endpoints: Array<["GET" | "POST", string, unknown?]> = [
      ["GET", "/api/version"],
      ["GET", "/api/proxy"],
      ["GET", "/api/history?agentKey=x&before=y"],
      ["GET", "/api/events"],
      ["POST", "/api/cmd", {}],
      ["POST", "/api/proxy/open", { target: "127.0.0.1:1" }],
      ["POST", "/api/proxy/stop", { instanceId: "inst-12345678" }],
      ["POST", "/api/upload/begin", {}],
      ["POST", "/api/logout", {}],
      ["POST", "/api/agents/remove", {}],
    ];
    const before = h.up.requests.length;
    for (const [label, headers] of hostile(pp)) {
      for (const [method, path, body] of endpoints) {
        const r = await h.api(method, path, { ...(body === undefined ? {} : { body }), headers });
        expect(r.status, `${method} ${path} (${label})`).toBe(403);
        expect(JSON.parse(r.body)).toMatchObject({ error: "E_CSRF" });
        expect(r.headers["access-control-allow-origin"]).toBeUndefined();
      }
    }
    // ...and the hub session is untouched by the refused logouts
    expect((await h.api("GET", "/api/version")).status).toBe(200);
    expect(h.up.requests.length).toBe(before);
  });

  it("loopback: legitimate traffic keeps the legacy matrix (no headers / same-origin / none), still no ACAO", async () => {
    const h = await startProxyHub();
    const bare = await h.api("GET", "/api/proxy", { headers: { Origin: "" } });
    // an explicitly EMPTY Origin is "present but unparsable" ⇒ refused; truly absent passes:
    expect(bare.status).toBe(403);
    const absent = await rawRequestNoOrigin(h);
    expect(absent.status).toBe(200);
    expect(absent.headers["access-control-allow-origin"]).toBeUndefined();
    const same = await h.api("GET", "/api/proxy", {
      headers: { "Sec-Fetch-Site": "same-origin", Origin: `http://127.0.0.1:${h.port}` },
    });
    expect(same.status).toBe(200);
    const none = await h.api("GET", "/api/proxy", { headers: { "Sec-Fetch-Site": "none" } });
    expect(none.status).toBe(200);
    // localhost spelling of the SAME listener is the same origin
    const lh = await h.api("GET", "/api/proxy", {
      headers: { Host: `localhost:${h.port}`, Origin: `http://localhost:${h.port}`, "Sec-Fetch-Site": "same-origin" },
    });
    expect(lh.status).toBe(200);
  });

  it("OPTIONS keeps its exact legacy 404 with no ACAO on both listeners (precedence over the gate)", async () => {
    const h = await startProxyHub({ lan: true });
    const lp = await h.lanPort();
    for (const [port, host] of [
      [h.port, `127.0.0.1:${h.port}`],
      [lp, `127.0.0.1:${lp}`],
    ] as const) {
      const r = await lanRequest(port, {
        method: "OPTIONS",
        path: "/api/proxy/open",
        host,
        headers: {
          Origin: "http://evil.example",
          "Access-Control-Request-Method": "POST",
          "Sec-Fetch-Site": "cross-site",
        },
      });
      expect(r.status).toBe(404);
      expect(JSON.parse(r.body)).toEqual({ error: "E_NOT_FOUND" });
      expect(r.headers["access-control-allow-origin"]).toBeUndefined();
      expect(r.headers["access-control-allow-methods"]).toBeUndefined();
    }
  });

  it("LAN: valid LAN cookie + hostile headers ⇒ 403 on every /api GET and POST; legit same-origin passes", async () => {
    const h = await startProxyHub({ lan: true });
    const lan = await h.lanLogin();
    const lp = await h.lanPort();
    const pp = portOf((await h.open()).origin);
    const mk = (method: "GET" | "POST", path: string, extra: Record<string, string>, body?: unknown) =>
      lanRequest(lp, {
        method,
        path,
        headers: {
          "X-PWH": "1",
          Cookie: lan.cookie,
          Origin: lan.origin,
          ...(body === undefined ? {} : { "Content-Type": "application/json" }),
          ...extra,
        },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      });
    const endpoints: Array<["GET" | "POST", string, unknown?]> = [
      ["GET", "/api/version"],
      ["GET", "/api/proxy"],
      ["GET", "/api/events"],
      ["GET", "/api/session"],
      ["POST", "/api/cmd", {}],
      ["POST", "/api/proxy/open", { target: "127.0.0.1:1" }],
      ["POST", "/api/upload/begin", {}],
      ["POST", "/api/logout", {}],
    ];
    for (const [label, headers] of hostile(pp)) {
      for (const [method, path, body] of endpoints) {
        const r = await mk(method, path, headers, body);
        expect(r.status, `LAN ${method} ${path} (${label})`).toBe(403);
        expect(JSON.parse(r.body)).toMatchObject({ error: "E_CSRF" });
        expect(r.headers["access-control-allow-origin"]).toBeUndefined();
      }
    }
    expect((await mk("GET", "/api/version", { "Sec-Fetch-Site": "same-origin" })).status).toBe(200);
    expect((await mk("GET", "/api/session", {})).status).toBe(200); // the logout attempts did not end the session
  });

  it("WS to the hub port is closed (no upgrade handler): never a 101", async () => {
    const h = await startProxyHub({ lan: true });
    const lp = await h.lanPort();
    for (const port of [h.port, lp]) {
      const text = await new Promise<string>((resolve) => {
        const s = connect(port, "127.0.0.1");
        let got = "";
        s.on("data", (b) => {
          got += b.toString();
          if (got.includes("\r\n\r\n")) s.destroy(); // the status line is all we need
        });
        s.on("close", () => resolve(got));
        s.on("error", () => resolve(got));
        s.on("connect", () =>
          s.write(
            `GET /api/events HTTP/1.1\r\nHost: 127.0.0.1:${port}\r\nCookie: ${h.cookie}\r\nConnection: Upgrade\r\nUpgrade: websocket\r\nSec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==\r\nOrigin: http://127.0.0.1:${port}\r\n\r\n`,
          ),
        );
        setTimeout(() => s.destroy(), 3_000).unref();
      });
      // Node (no `upgrade` listener) either drops the socket (text === "") or answers the request
      // as a plain one — it NEVER switches protocols.
      expect(text.startsWith("HTTP/1.1 101")).toBe(false);
      expect(text.toLowerCase()).not.toContain("sec-websocket-accept");
    }
  });

  it("apiCrossSiteOk unit matrix (metadata × Origin × absent)", () => {
    const req = (headers: Record<string, string>) => ({ headers }) as unknown as IncomingMessage;
    const o = "http://127.0.0.1:7878";
    expect(apiCrossSiteOk(req({}), o)).toBe(true);
    expect(apiCrossSiteOk(req({ "sec-fetch-site": "same-origin" }), o)).toBe(true);
    expect(apiCrossSiteOk(req({ "sec-fetch-site": "none" }), o)).toBe(true);
    expect(apiCrossSiteOk(req({ "sec-fetch-site": "SAME-SITE" }), o)).toBe(false);
    expect(apiCrossSiteOk(req({ "sec-fetch-site": "cross-site" }), o)).toBe(false);
    expect(apiCrossSiteOk(req({ origin: o }), o)).toBe(true);
    expect(apiCrossSiteOk(req({ origin: "HTTP://127.0.0.1:7878" }), o)).toBe(true);
    expect(apiCrossSiteOk(req({ origin: "http://127.0.0.1:7901" }), o)).toBe(false);
    expect(apiCrossSiteOk(req({ origin: "null" }), o)).toBe(false);
    expect(apiCrossSiteOk(req({ origin: "http://evil.example" }), o)).toBe(false);
    expect(apiCrossSiteOk(req({ origin: o, "sec-fetch-site": "same-site" }), o)).toBe(false);
    expect(apiCrossSiteOk(req({ origin: "http://127.0.0.1:7901", "sec-fetch-site": "same-origin" }), o)).toBe(false);
  });
});

describe("§4.1 cookie candidates are armed with the proxy (max 8 loopback)", () => {
  it("a junk first pwh_sid is skipped (still logged in); a conflict ⇒ 401 cookie-conflict with clearing Set-Cookie", async () => {
    const h = await startProxyHub();
    const ok = await h.api("GET", "/api/version", { cookie: `pwh_sid=junk; ${h.cookie}` });
    expect(ok.status).toBe(200);
    const nine = Array.from({ length: 9 }, (_, i) => `pwh_sid=junk${i}`).join("; ");
    const overflow = await h.api("GET", "/api/version", { cookie: `${nine}; ${h.cookie}` });
    expect(overflow.status).toBe(401);
    expect(JSON.parse(overflow.body)).toEqual({ error: "E_AUTH", reason: "cookie-conflict" });
    expect(String(overflow.headers["set-cookie"] ?? "")).toContain("pwh_sid=");
    // the proxy route answers the conflict through the SAME resolver (one response, not two)
    const viaRoute = await h.api("POST", "/api/proxy/open", {
      cookie: `${nine}; ${h.cookie}`,
      body: { target: `127.0.0.1:${h.up.port}` },
    });
    expect(viaRoute.status).toBe(401);
    expect(JSON.parse(viaRoute.body)).toEqual({ error: "E_AUTH", reason: "cookie-conflict" });
  });
});

async function rawRequestNoOrigin(h: ProxyHub) {
  const { rawRequest } = await import("./helpers.js");
  return rawRequest(h.port, { path: "/api/version", headers: { "X-PWH": "1", Cookie: h.cookie } });
}
