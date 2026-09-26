// lan-plan.md §11 "S1-W3（LD ∥ LI）" row, LI's e2e: a *really* lifted hub (real
// `startHub` + real `createHttpFrontend`, real SQLite-backed `LanStorePort`
// via LD's `defaultLanAssembly`) driven purely at the wire level (unix-socket
// admin frames `lan_req`/`hub_ctl` + real `http.request`/SSE for the browser
// side) — no `activate()`/pi assembly needed for what this file covers (that
// side is already exercised by `tests/web-hub/agent/{lan-status,
// passwd-prompt,restart,wiring-lan}.test.ts`, LE's suite, all green).
//
// Gate: S1-W3-LD has merged on this branch (`defaultLanAssembly` is the real
// SQLite-backed assembly, not the W1 stub), so the only remaining gate is the
// environmental one every other SQLite-backed suite in this repo uses
// (`hasNodeSqlite()` — plan §4.3): skip on a Node build without `node:sqlite`
// rather than statically probing `defaultLanAssembly.build`'s source text (a
// regex on a function's `toString()` is not an environment check and stopped
// being one the moment LD landed).
//
// Scope note: "会话 jsonl 中没有初始密码" (the LI row's last clause) is
// exercised at the *agent/command* layer instead, where it actually lives —
// `formatInitialPasswordLines`/`ctx.ui.notify` never touch the session
// transcript, and `tests/commands/webhub-lan.test.ts` already asserts the
// TUI-only + rpc/print-hides-plaintext behavior end to end for the command
// handler. This file only lifts a real hub process image, so there is no pi
// session file in the picture at all.

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createServer as createNetServer, request as httpRequest, type Server as HttpServer } from "node:http";
import { mkdtempSync, rmSync } from "node:fs";
import { networkInterfaces } from "node:os";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { hasNodeSqlite } from "../../src/web-hub/hub/db.js";
import { createHttpFrontend } from "../../src/web-hub/hub/http.js";
import { startHub, type RunningHub } from "../../src/web-hub/hub/hub.js";
import type { HubConfig, HubLanConfig } from "../../src/web-hub/hub/ports.js";
import type { LanInfoPayload, LanReqFrame, LanResFrame, HubCtlAckFrame } from "../../src/web-hub/protocol/messages.js";
import { config as hubConfig, connectClient, hello, type TestClient } from "../web-hub/hub/helpers.js";
import { lanPostJson, lanRequest } from "../web-hub/http/lan-helpers.js";
import { openSse, type SseConn } from "../web-hub/http/helpers.js";
import { waitUntil } from "../web-hub/agent/helpers.js";
import { sandboxHome } from "./helpers/home-sandbox.js";

/** Environmental gate only (plan §4.3's own convention) — never a stand-in for "LD hasn't merged". */
const NO_NODE_SQLITE = !(await hasNodeSqlite());
if (NO_NODE_SQLITE) {
  // eslint-disable-next-line no-console
  console.warn("[web-hub-lan.test.ts] this Node build has no node:sqlite ⇒ skipping the LAN e2e suite.");
}

/** First non-loopback IPv4 this machine actually has (net-hosts.ts §2.1① auto-discovers every
 * interface address, so whatever we find here is already in the hub's host allow-list with zero
 * `extraHosts` configuration). `undefined` in a sandbox with no such interface (rare; guarded per-test). */
function firstLanIPv4(): string | undefined {
  for (const addrs of Object.values(networkInterfaces())) {
    for (const a of addrs ?? []) {
      if (a.family === "IPv4" && !a.internal) return a.address;
    }
  }
  return undefined;
}

async function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const srv = createNetServer();
    srv.once("error", reject);
    srv.listen(0, "0.0.0.0", () => {
      const addr = srv.address();
      const port = addr !== null && typeof addr === "object" ? addr.port : 0;
      srv.close(() => resolve(port));
    });
  });
}

/** A minimal `node:http` reverse proxy (plan §11 LI row: "用本机 node:http 起一个最小代理"):
 * forwards to `targetPort` on 127.0.0.1, injecting `X-Forwarded-{Proto,Host}` so the hub sees an
 * https-terminating proxy at `externalOrigin` — the proxy's own outbound connection to the hub is
 * from 127.0.0.1, matching `trustProxyFrom: ["127.0.0.1"]`. */
function startMiniProxy(targetPort: number, externalHost: string): Promise<{ port: number; close(): Promise<void> }> {
  return new Promise((resolve) => {
    const srv: HttpServer = createNetServer(
      (req: import("node:http").IncomingMessage, res: import("node:http").ServerResponse) => {
        const proxyReq = httpRequest(
          {
            host: "127.0.0.1",
            port: targetPort,
            method: req.method,
            path: req.url,
            headers: {
              ...req.headers,
              host: externalHost,
              "x-forwarded-proto": "https",
              "x-forwarded-host": externalHost,
            },
          },
          (proxyRes) => {
            res.writeHead(proxyRes.statusCode ?? 502, proxyRes.headers);
            proxyRes.pipe(res);
          },
        );
        proxyReq.on("error", () => res.destroy());
        req.pipe(proxyReq);
      },
    );
    srv.listen(0, "127.0.0.1", () => {
      const addr = srv.address();
      const port = addr !== null && typeof addr === "object" ? addr.port : 0;
      resolve({ port, close: () => new Promise((r) => srv.close(() => r())) });
    });
  });
}

type LanReqWithoutRid<T> = T extends { rid: string } ? Omit<T, "rid"> : never;

async function sendLanReq(admin: TestClient, frame: LanReqWithoutRid<LanReqFrame>): Promise<LanResFrame> {
  const rid = `t-${Math.random().toString(36).slice(2)}`;
  admin.send({ ...frame, rid });
  const f = await admin.waitFrame((x) => x["t"] === "lan_res" && x["rid"] === rid, 5_000);
  return f as unknown as LanResFrame;
}

async function connectAdmin(socketPath: string): Promise<TestClient> {
  const client = await connectClient(socketPath);
  client.send(hello({ agentId: { pid: process.pid, nonce: "e2e-lan-admin-nonce" }, epoch: "e-lan-e2e" }));
  await client.waitFrame((f) => f["t"] === "hello_ack");
  return client;
}

async function readInfo(admin: TestClient): Promise<LanInfoPayload> {
  const res = await sendLanReq(admin, { t: "lan_req", op: "info" });
  if (!res.ok) throw new Error(`lan_req info rejected: ${res.code} ${res.message}`);
  if (res.info === undefined) throw new Error("lan_req info: no info payload");
  return res.info;
}

async function waitLanOn(hub: RunningHub, ms = 10_000): Promise<{ port: number }> {
  await waitUntil(() => hub.lanStatus()?.state === "on", ms, "lan on");
  const status = hub.lanStatus();
  if (status === undefined || status.state !== "on") throw new Error("test bug: lan not on after waitLanOn");
  return { port: status.port };
}

describe.skipIf(NO_NODE_SQLITE)("web-hub LAN e2e (real hub, plan §11 LI row)", () => {
  let home: { home: string; restore: () => void } | undefined;
  let hub: RunningHub | undefined;
  let admin: TestClient | undefined;
  const sseConns: SseConn[] = [];
  const proxies: Array<{ close(): Promise<void> }> = [];

  async function bringUp(lanOverrides: Partial<HubLanConfig> = {}): Promise<{ hub: RunningHub; port: number }> {
    home = sandboxHome();
    const lan: HubLanConfig = {
      port: await freePort(),
      extraHosts: [],
      trustProxyFrom: ["127.0.0.1"],
      externalOrigins: ["https://hub.test"],
      ...lanOverrides,
    };
    const cfg: HubConfig = hubConfig({ home: home.home, port: 0, lan });
    const started = await startHub(cfg, createHttpFrontend, {});
    if ("exists" in started) throw new Error("unexpected singleton collision");
    hub = started;
    const { port } = await waitLanOn(hub);
    admin = await connectAdmin(hub.paths.socketPath);
    return { hub, port };
  }

  afterEach(async () => {
    for (const s of sseConns.splice(0)) s.close();
    for (const p of proxies.splice(0)) await p.close().catch(() => undefined);
    admin?.sock.destroy();
    admin = undefined;
    await hub?.close("test-teardown").catch(() => undefined);
    hub = undefined;
    home?.restore();
    if (home !== undefined) rmSync(home.home, { recursive: true, force: true });
    home = undefined;
  });

  it("direct LAN login on a non-loopback IP succeeds; the SSE stream sends hello", async () => {
    const ip = firstLanIPv4();
    if (ip === undefined) {
      console.warn("[web-hub-lan.test.ts] no non-loopback IPv4 interface on this machine; skipping this assertion");
      return;
    }
    const { port } = await bringUp();
    const { username, initialPassword } = await readInfo(admin!);
    expect(initialPassword).toBeDefined();

    const host = `${ip}:${port}`;
    const loginRes = await lanPostJson(
      port,
      "/api/login",
      { username, password: initialPassword },
      { Host: host },
      undefined,
      ip,
    );
    expect(loginRes.status).toBe(200);
    const cookie = (loginRes.headers["set-cookie"]?.[0] ?? "").split(";")[0]!;
    expect(cookie).toMatch(/^pwh_lan=/);

    const sse = await openSse(port, { host, cookie, destHost: ip });
    sseConns.push(sse);
    await sse.waitFor((e) => e.event === "hello");
  });

  it("trusted reverse proxy: cookie is Secure + bound to the https origin, rejected when replayed direct", async () => {
    const { port } = await bringUp();
    const { username, initialPassword } = await readInfo(admin!);

    const proxy = await startMiniProxy(port, "hub.test");
    proxies.push(proxy);

    const viaProxy = await lanRequest(proxy.port, {
      method: "POST",
      path: "/api/login",
      headers: { "Content-Type": "application/json", "X-PWH": "1", Origin: "https://hub.test" },
      body: JSON.stringify({ username, password: initialPassword }),
      host: "hub.test",
    });
    expect(viaProxy.status).toBe(200);
    const setCookie = viaProxy.headers["set-cookie"]?.[0] ?? "";
    expect(setCookie).toContain("Secure");
    const proxyCookie = setCookie.split(";")[0]!;

    // Replaying the proxy-bound cookie on the direct (http, loopback) origin must 401 (§2.4/§6.4:
    // the two entry kinds' origin sets are disjoint even though they share this host/hub).
    // `bringUp()`'s `trustProxyFrom: ["127.0.0.1"]` means *any* connection whose peer is
    // `127.0.0.1` is treated as arriving via that trusted proxy (plan §2.4/§6.3's `resolveProxy`:
    // membership in `trustProxyFrom` is peer-IP-keyed, not header-gated) — a "direct" probe must
    // therefore originate from a genuinely different peer, not just omit proxy headers while still
    // dialing 127.0.0.1 (that would 400 on missing `X-Forwarded-Proto`, never reaching the origin
    // check this test wants). `127.0.0.2` (a distinct loopback alias, same convention as
    // `tests/web-hub/http/lan-hostbind.test.ts`) is outside `trustProxyFrom` and always available,
    // unlike a real second interface.
    const direct = await lanRequest(port, {
      path: "/api/session",
      headers: { Cookie: proxyCookie },
      localAddress: "127.0.0.2",
    });
    expect(direct.status).toBe(401);
  });

  it("passwd: initial password stops being returned, old cookie 401s, live SSE gets auth{revoked}", async () => {
    const ip = firstLanIPv4() ?? "127.0.0.1";
    const { port } = await bringUp();
    const { username, initialPassword } = await readInfo(admin!);
    const host = `${ip}:${port}`;

    const loginRes = await lanPostJson(
      port,
      "/api/login",
      { username, password: initialPassword },
      { Host: host },
      undefined,
      ip,
    );
    expect(loginRes.status).toBe(200);
    const oldCookie = (loginRes.headers["set-cookie"]?.[0] ?? "").split(";")[0]!;

    const sse = await openSse(port, { host, cookie: oldCookie, destHost: ip });
    sseConns.push(sse);
    await sse.waitFor((e) => e.event === "hello");

    const passwdRes = await sendLanReq(admin!, {
      t: "lan_req",
      op: "passwd",
      username,
      password: "a-much-longer-new-password-1",
    });
    expect(passwdRes.ok).toBe(true);

    const infoAfter = await readInfo(admin!);
    expect(infoAfter.initialPassword).toBeUndefined();

    // §4.2: revoke happens synchronously before the passwd response returns, so this should
    // already be queued/flushed by the time we check — a short wait covers actual I/O scheduling.
    await sse.waitFor((e) => e.event === "auth", 5_000);
    const authEv = sse.events.find((e) => e.event === "auth")!;
    expect((authEv.data as { reason?: string }).reason).toBe("revoked");

    const stale = await lanRequest(port, { path: "/api/session", headers: { Cookie: oldCookie }, host, destHost: ip });
    expect(stale.status).toBe(401);
  });

  it("restart: session persists across a fresh RunningHub on the same home + lan.port", async () => {
    const ip = firstLanIPv4() ?? "127.0.0.1";
    const { port } = await bringUp();
    const { username, initialPassword } = await readInfo(admin!);
    const host = `${ip}:${port}`;

    const loginRes = await lanPostJson(
      port,
      "/api/login",
      { username, password: initialPassword },
      { Host: host },
      undefined,
      ip,
    );
    const cookie = (loginRes.headers["set-cookie"]?.[0] ?? "").split(";")[0]!;

    const ack = await sendCtlShutdown(admin!);
    expect(ack.t).toBe("hub_ctl_ack");
    await hub!.closed;

    // Simulate the respawn (plan §8.2: same home, same lan.port — a real restart's new OS pid,
    // reproduced here as a fresh in-process RunningHub since this suite never spawns `main.ts`).
    const cfg: HubConfig = hubConfig({
      home: home!.home,
      port: 0,
      lan: { port, extraHosts: [], trustProxyFrom: [], externalOrigins: [] },
    });
    const respawned = await startHub(cfg, createHttpFrontend, {});
    if ("exists" in respawned) throw new Error("unexpected singleton collision on respawn");
    hub = respawned;
    await waitLanOn(hub);

    const afterRestart = await lanRequest(port, {
      path: "/api/session",
      headers: { Cookie: cookie },
      host,
      destHost: ip,
    });
    expect(afterRestart.status).toBe(200); // L7: LAN sessions survive a hub restart (SQLite persists)
  });
});

async function sendCtlShutdown(admin: TestClient): Promise<HubCtlAckFrame> {
  const rid = `t-${Math.random().toString(36).slice(2)}`;
  admin.send({ t: "hub_ctl", rid, op: "shutdown", reason: "restart" });
  const f = await admin.waitFrame((x) => x["t"] === "hub_ctl_ack" && x["rid"] === rid, 5_000);
  return f as unknown as HubCtlAckFrame;
}
