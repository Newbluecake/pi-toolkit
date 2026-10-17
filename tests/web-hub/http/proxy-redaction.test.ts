/**
 * T-A2 (web-hub-proxy plan v2 §9): log redaction across the whole wired surface — the real
 * hub.log written by a REAL hub while open / enter / HTTP / WebSocket / denials / stop /
 * logout / reverse-proxy refusal / rate-limit / parse failures all run. Not one code, hub or
 * gate session id, hub token, path, query, cookie or header value may reach the log; the audit
 * lines that ARE expected must be present (so the scan is not vacuous).
 */
import { readFileSync } from "node:fs";
import { connect } from "node:net";
import { afterEach, describe, expect, it } from "vitest";
import { cleanupProxyHubs, startProxyHub, type ProxyHub } from "./proxy-kit.js";
import { lanRequest } from "./lan-helpers.js";

afterEach(cleanupProxyHubs);

const portOf = (origin: string): number => Number(new URL(origin).port);

function wsUpgrade(origin: string, cookie: string, path: string, wsOrigin: string = origin): Promise<string> {
  return new Promise((resolve) => {
    const s = connect(portOf(origin), "127.0.0.1");
    let got = "";
    s.on("data", (b) => {
      got += b.toString();
      if (got.includes("\r\n\r\n")) s.destroy();
    });
    s.on("close", () => resolve(got));
    s.on("error", () => resolve(got));
    s.on("connect", () =>
      s.write(
        `GET ${path} HTTP/1.1\r\nHost: ${new URL(origin).host}\r\nCookie: ${cookie}\r\nConnection: Upgrade\r\nUpgrade: websocket\r\nSec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==\r\nOrigin: ${wsOrigin}\r\n\r\n`,
      ),
    );
    setTimeout(() => s.destroy(), 3_000).unref();
  });
}

const M = {
  path: "secret-path-AAAA",
  query: "secret-query-BBBB",
  req: "req-path-CCCC",
  reqQuery: "req-query-DDDD",
  cookie: "app-cookie-secret-EEEE",
  ws: "ws-path-FFFF",
  host: "secret-host-GGGG",
  header: "x-secret-header-HHHH",
  nextPath: "next-path-IIII",
};

describe("T-A2 hub.log carries no secret from any proxied flow", () => {
  it("loopback + LAN flows: only whitelisted proxy-open/proxy-end fields reach the log", async () => {
    const h = await startProxyHub({ lan: true });
    const token = readFileSync(h.hub.paths.tokenFile, "utf8").trim();
    const hubSid = h.cookie.split("=")[1]!;
    const secrets: string[] = [token, hubSid, ...Object.values(M)];

    // open with secret path+query in the target; enter (the code rides the URL)
    const opened = await h.open(`http://127.0.0.1:${h.up.port}/${M.path}?t=${M.query}`);
    const code = new URL(opened.enterUrl).searchParams.get("c")!;
    secrets.push(code);
    const enter = await h.http(opened.enterUrl);
    expect(enter.status).toBe(303);
    expect(enter.headers.location).toContain(M.path); // the redirect carries it, the LOG must not
    const gate = enter.headers["set-cookie"]![0]!.split(";")[0]!;
    secrets.push(gate.split("=")[1]!);

    // HTTP traffic with secret path / query / cookie / header, a redirecting upstream, a body
    const r1 = await h.http(`${opened.origin}/${M.req}?q=${M.reqQuery}`, {
      method: "POST",
      headers: {
        Cookie: `${gate}; app=${M.cookie}`,
        [M.header]: "1",
        Origin: opened.origin,
        "Content-Type": "text/plain",
      },
      body: "payload-secret-JJJJ",
    });
    expect(r1.status).toBe(200);
    secrets.push("payload-secret-JJJJ");
    await h.http(`${opened.origin}/redirect`, { headers: { Cookie: gate } });
    await h.http(`${opened.origin}/headers`, { headers: { Cookie: gate } });
    // denials: replayed code, no cookie, wrong host, unsafe cross-origin POST, absolute-form
    expect((await h.http(opened.enterUrl)).status).toBe(410);
    expect((await h.http(`${opened.origin}/${M.req}?q=${M.reqQuery}`)).status).toBe(401);
    expect(
      (await h.http(`${opened.origin}/x`, { headers: { Host: `${M.host}:${portOf(opened.origin)}` } })).status,
    ).toBe(421);
    expect(
      (
        await h.http(`${opened.origin}/${M.req}`, {
          method: "POST",
          headers: { Cookie: gate, Origin: `http://${M.host}`, "Content-Type": "text/plain" },
          body: "x",
        })
      ).status,
    ).toBe(403);
    // WebSocket (success + origin refusal)
    const ok = await wsUpgrade(opened.origin, gate, `/${M.ws}?k=${M.query}`);
    expect(ok.startsWith("HTTP/1.1 101")).toBe(true);
    const bad = await wsUpgrade(opened.origin, gate, `/${M.ws}`, `http://${M.host}`);
    expect(bad.startsWith("HTTP/1.1 403")).toBe(true);
    // refused opens: syntax with secret host, userinfo, public, dns failure
    for (const t of [`user:pass@${M.host}:1`, `http://${M.host}.invalid:9/${M.nextPath}?x=${M.query}`, "8.8.8.8:80"]) {
      await h.api("POST", "/api/proxy/open", { body: { target: t } });
    }
    expect((await h.api("POST", "/api/proxy/stop", { body: { instanceId: opened.instanceId } })).status).toBe(200);
    // rate limit: burn the bucket
    for (let i = 0; i < 12; i++) await h.api("POST", "/api/proxy/open", { body: { target: "8.8.8.8:80" } });

    // LAN: open (browser host from the LAN request), reverse-proxy-style refusal on a second hub is
    // covered in T-H8; here the LAN principal's own open + logout.
    const lan = await h.lanLogin();
    const lp = await h.lanPort();
    const lanHdrs = { "Content-Type": "application/json", "X-PWH": "1", Cookie: lan.cookie, ...lan.headers };
    secrets.push(lan.cookie.split("=")[1]!);
    const lopen = await lanRequest(lp, {
      method: "POST",
      path: "/api/proxy/open",
      headers: lanHdrs,
      body: JSON.stringify({ target: `http://127.0.0.1:${h.up.port}/${M.nextPath}` }),
    });
    expect(lopen.status).toBe(200);
    secrets.push(new URL(JSON.parse(lopen.body).enterUrl).searchParams.get("c")!);

    // logout (revocation), then close the hub so every end-of-life line is flushed
    await lanRequest(lp, { method: "POST", path: "/api/logout", headers: lanHdrs, body: "{}" });
    await h.api("POST", "/api/logout", { body: {} });
    await h.hub.close("test");

    const log = h.logText();
    const lines = log.split("\n").filter(Boolean);
    // non-vacuous: the whitelisted audit lines exist
    const opens = lines.map((l) => JSON.parse(l) as Record<string, unknown>).filter((l) => l.msg === "proxy-open");
    const ends = lines.map((l) => JSON.parse(l) as Record<string, unknown>).filter((l) => l.msg === "proxy-end");
    expect(opens.some((l) => l.ok === true && l.listener === "loopback")).toBe(true);
    expect(opens.some((l) => l.ok === true && l.listener === "lan")).toBe(true);
    expect(opens.some((l) => l.ok === false && typeof l.reason === "string")).toBe(true);
    expect(ends.length).toBeGreaterThan(0);
    // the redaction scan
    for (const secret of secrets) {
      expect(log.includes(secret), `log leaked ${secret.slice(0, 12)}…`).toBe(false);
    }
    for (const marker of ["Cookie", "cookie", "Set-Cookie", "pwh_sid", "pwh_lan", "pwh_px_", "Authorization"]) {
      expect(log.includes(marker), `log mentions ${marker}`).toBe(false);
    }
    // every proxy audit line carries only whitelisted keys
    const allowed = new Set([
      "t",
      "level",
      "pid",
      "msg",
      "ok",
      "reason",
      "principal",
      "listener",
      "cls",
      "target",
      "host",
      "port",
      "instTag",
      "end",
      "reqs",
      "bytesUp",
      "bytesDown",
      "ws",
    ]);
    for (const l of [...opens, ...ends]) {
      for (const k of Object.keys(l)) expect(allowed.has(k), `unexpected audit key ${k}`).toBe(true);
    }
  });
});

describe("T-A2 the frontend-level log (captureLog shape) stays clean on route failures", () => {
  it("a throwing/refused open never logs the target, the error text or the request", async () => {
    const h: ProxyHub = await startProxyHub();
    await h.api("POST", "/api/proxy/open", { body: { target: `http://${M.host}:abc/${M.path}` } });
    await h.api("POST", "/api/proxy/open", { body: { target: 123 } });
    await h.api("POST", "/api/proxy/open", {
      headers: { "Content-Type": "application/json" },
      cookie: h.cookie,
      body: undefined,
    });
    await h.hub.close("test");
    const log = h.logText();
    for (const s of [M.host, M.path, h.cookie.split("=")[1]!]) expect(log.includes(s)).toBe(false);
  });
});
