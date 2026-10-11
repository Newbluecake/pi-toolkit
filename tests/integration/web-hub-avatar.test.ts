import { createHash } from "node:crypto";
import { request as httpRequest, type IncomingMessage } from "node:http";
import { appendFileSync, existsSync, readFileSync, rmSync, statSync, symlinkSync } from "node:fs";
import { mkdtempSync } from "node:fs";
import { createServer as createNetServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { hasNodeSqlite } from "../../src/web-hub/hub/db.js";
import { createHttpFrontend } from "../../src/web-hub/hub/http.js";
import { startHub, type RunningHub } from "../../src/web-hub/hub/hub.js";
import type { HubConfig } from "../../src/web-hub/hub/ports.js";
import { AVATAR_DELETE_PATH, AVATAR_PATH } from "../../src/web-hub/protocol/avatar.js";
import { config as hubConfig, connectClient, hello, type TestClient } from "../web-hub/hub/helpers.js";
import { login, openSse, type SseConn } from "../web-hub/http/helpers.js";
import { lanPostJson } from "../web-hub/http/lan-helpers.js";

const PNG = readFileSync(new URL("../fixtures/web-hub-avatar/chrome-canvas.png", import.meta.url));
const PNG_V = createHash("sha256").update(PNG).digest("hex");
const NO_NODE_SQLITE = !(await hasNodeSqlite());

interface LiveHub {
  home: string;
  hub: RunningHub;
  cookie: string;
  sse: Set<SseConn>;
  admin?: TestClient;
  closed: boolean;
}

const lives = new Set<LiveHub>();
const homes = new Set<string>();

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, ms);
    timer.unref();
  });
}

async function until(check: () => boolean, label: string, timeoutMs = 5_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!check()) {
    if (Date.now() >= deadline) throw new Error(`timeout: ${label}`);
    await delay(10);
  }
}

async function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = createNetServer();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      const port = address !== null && typeof address === "object" ? address.port : 0;
      server.close((err) => (err === undefined ? resolve(port) : reject(err)));
    });
  });
}

async function boot(opts: { home?: string; lan?: boolean } = {}): Promise<LiveHub> {
  const home = opts.home ?? mkdtempSync(join(tmpdir(), "pwh-avatar-integration-"));
  homes.add(home);
  const config: HubConfig = hubConfig({
    home,
    port: 0,
    avatar: true,
    ...(opts.lan
      ? {
          lan: {
            port: await freePort(),
            extraHosts: [],
            trustProxyFrom: [],
            externalOrigins: [],
          },
        }
      : {}),
  });
  const started = await startHub(config, createHttpFrontend);
  if ("exists" in started) throw new Error("unexpected hub singleton collision");
  const live: LiveHub = { home, hub: started, cookie: "", sse: new Set(), closed: false };
  lives.add(live);
  try {
    live.cookie = await login(started.httpPort, started.paths.tokenFile);
    return live;
  } catch (error) {
    await started.close("avatar-boot-failed").catch(() => undefined);
    lives.delete(live);
    throw error;
  }
}

async function stop(live: LiveHub): Promise<void> {
  if (live.closed) return;
  for (const sse of live.sse) sse.close();
  live.admin?.sock.destroy();
  await live.hub.close("avatar-test").catch(() => undefined);
  live.closed = true;
}

function avatarRequest(
  port: number,
  opts: {
    method?: "GET" | "POST";
    path?: string;
    cookie: string;
    body?: Buffer;
    headers?: Record<string, string>;
  },
): Promise<{ status: number; headers: IncomingMessage["headers"]; body: Buffer }> {
  return new Promise((resolve, reject) => {
    const body = opts.body;
    const path = opts.path ?? AVATAR_PATH;
    const headers: Record<string, string> = {
      Host: `127.0.0.1:${port}`,
      Cookie: opts.cookie,
      "X-PWH": "1",
      Origin: `http://127.0.0.1:${port}`,
      ...(path === AVATAR_DELETE_PATH ? { "Content-Type": "application/json" } : {}),
      ...(body === undefined ? {} : { "Content-Length": String(body.length) }),
      ...(opts.headers ?? {}),
    };
    if (opts.method === "POST" && path === AVATAR_PATH && headers["Content-Type"] === undefined)
      headers["Content-Type"] = "application/octet-stream";
    const req = httpRequest(
      { host: "127.0.0.1", port, method: opts.method ?? "GET", path, headers, agent: false },
      (res) => {
        const chunks: Buffer[] = [];
        res.on("data", (chunk: Buffer) => chunks.push(chunk));
        res.on("end", () =>
          resolve({ status: res.statusCode ?? 0, headers: res.headers, body: Buffer.concat(chunks) }),
        );
        res.on("error", reject);
      },
    );
    req.setTimeout(15_000, () => req.destroy(new Error("avatar request timeout")));
    req.on("error", reject);
    if (body !== undefined) req.end(body);
    else req.end();
  });
}

function jsonBody(response: { body: Buffer }): Record<string, unknown> {
  return JSON.parse(response.body.toString("utf8")) as Record<string, unknown>;
}

function avatarOf(data: unknown): { gen: number; v?: string } | undefined {
  if (typeof data !== "object" || data === null) return undefined;
  const avatar = (data as { avatar?: unknown }).avatar;
  if (typeof avatar !== "object" || avatar === null || typeof (avatar as { gen?: unknown }).gen !== "number")
    return undefined;
  const v = (avatar as { v?: unknown }).v;
  return typeof v === "string" ? { gen: (avatar as { gen: number }).gen, v } : { gen: (avatar as { gen: number }).gen };
}

async function loadedFrame(sse: SseConn, withVersion: boolean): Promise<Record<string, unknown>> {
  const frame = await sse.waitFor((event) => {
    if (event.event !== "hub") return false;
    const avatar = avatarOf(event.data);
    return avatar !== undefined && (withVersion ? avatar.v !== undefined : avatar.v === undefined);
  }, 5_000);
  return frame.data as Record<string, unknown>;
}

async function openTrackedSse(live: LiveHub): Promise<SseConn> {
  const sse = await openSse(live.hub.httpPort, { cookie: live.cookie });
  live.sse.add(sse);
  expect(sse.status).toBe(200);
  return sse;
}

async function waitLanOn(live: LiveHub): Promise<number> {
  await until(() => live.hub.lanStatus()?.state === "on", "LAN listener");
  const status = live.hub.lanStatus();
  if (status === undefined || status.state !== "on") throw new Error("LAN listener did not start");
  return status.port;
}

async function lanCookie(live: LiveHub, port: number): Promise<string> {
  const admin = await connectClient(live.hub.paths.socketPath);
  live.admin = admin;
  admin.send(
    hello({
      agentId: { pid: process.pid, nonce: `avatar-lan-${Date.now()}-${Math.random().toString(16).slice(2)}` },
      epoch: "avatar-lan-test",
    }),
  );
  await admin.waitFrame((frame) => frame["t"] === "hello_ack");
  admin.send({ t: "lan_req", rid: "avatar-info", op: "info" });
  const infoFrame = await admin.waitFrame((frame) => frame["t"] === "lan_res" && frame["rid"] === "avatar-info");
  const info = infoFrame as unknown as { ok: boolean; info?: { username: string; initialPassword?: string } };
  if (!info.ok || info.info?.initialPassword === undefined) throw new Error("LAN initial password unavailable");
  const response = await lanPostJson(
    port,
    "/api/login",
    { username: info.info.username, password: info.info.initialPassword },
    { Host: `127.0.0.1:${port}` },
  );
  expect(response.status, response.body).toBe(200);
  const cookie = response.headers["set-cookie"]?.[0]?.split(";")[0];
  if (cookie === undefined) throw new Error("LAN login did not set a cookie");
  return cookie;
}

interface SlowUpload {
  finish(rest: Buffer): void;
  result: Promise<{ status: number; body: Buffer }>;
}

function slowUpload(port: number, cookie: string): SlowUpload {
  let finish!: (rest: Buffer) => void;
  let rejectResult!: (error: unknown) => void;
  const result = new Promise<{ status: number; body: Buffer }>((resolve, reject) => {
    rejectResult = reject;
    const req = httpRequest(
      {
        host: "127.0.0.1",
        port,
        method: "POST",
        path: AVATAR_PATH,
        agent: false,
        headers: {
          Host: `127.0.0.1:${port}`,
          Cookie: cookie,
          "X-PWH": "1",
          Origin: `http://127.0.0.1:${port}`,
          "Content-Type": "application/octet-stream",
          "Content-Length": String(PNG.length),
        },
      },
      (res) => {
        const chunks: Buffer[] = [];
        res.on("data", (chunk: Buffer) => chunks.push(chunk));
        res.on("end", () => resolve({ status: res.statusCode ?? 0, body: Buffer.concat(chunks) }));
        res.on("error", reject);
      },
    );
    req.setTimeout(15_000, () => req.destroy(new Error("slow avatar request timeout")));
    req.on("error", rejectResult);
    const split = Math.max(1, Math.floor(PNG.length / 2));
    req.write(PNG.subarray(0, split));
    finish = (rest) => req.end(rest);
  });
  return { finish, result };
}

afterEach(async () => {
  for (const live of lives) await stop(live);
  lives.clear();
  for (const home of homes) rmSync(home, { recursive: true, force: true });
  homes.clear();
});

describe("web-hub avatar integration", () => {
  it("loopback upload publishes gen/v, GET returns the exact PNG, and storage is private and atomic", async () => {
    const live = await boot();
    const sse = await openTrackedSse(live);
    const upload = await avatarRequest(live.hub.httpPort, { method: "POST", cookie: live.cookie, body: PNG });
    expect(upload.status, upload.body.toString()).toBe(200);
    const response = jsonBody(upload);
    const returned = response.avatar as { gen: number; v: string };
    const avatar = { gen: returned.gen, v: returned.v };
    expect(returned).toEqual(expect.objectContaining({ gen: 2, v: PNG_V }));

    const frame = await sse.waitFor(
      (event) => event.event === "hub" && avatarOf(event.data)?.gen === avatar.gen,
      5_000,
    );
    expect(avatarOf(frame.data)).toEqual(avatar);

    const fetched = await avatarRequest(live.hub.httpPort, { cookie: live.cookie });
    expect(fetched.status).toBe(200);
    expect(fetched.body).toEqual(PNG);
    expect(fetched.headers.etag).toBe(`"${PNG_V}"`);

    const avatarDir = join(live.hub.paths.stateDir, "avatar");
    expect(statSync(avatarDir).mode & 0o777).toBe(0o700);
    expect(statSync(join(avatarDir, "avatar.png")).mode & 0o777).toBe(0o600);
    expect(existsSync(join(avatarDir, "avatar.png.tmp"))).toBe(false);
  });

  it("restarts on the same HOME, reloads the image at gen 1, and the identity change wins ordering", async () => {
    const first = await boot();
    const firstSse = await openTrackedSse(first);
    const put = await avatarRequest(first.hub.httpPort, { method: "POST", cookie: first.cookie, body: PNG });
    expect(put.status).toBe(200);
    const putAvatar = jsonBody(put).avatar as { gen: number; v: string };
    const firstFrame = await firstSse.waitFor(
      (event) => event.event === "hub" && avatarOf(event.data)?.gen === putAvatar.gen,
      5_000,
    );
    const firstData = firstFrame.data as { pid: number; startedAt: number; avatar: { gen: number; v: string } };
    await stop(first);
    await delay(10);

    const second = await boot({ home: first.home });
    const secondSse = await openTrackedSse(second);
    const loaded = await loadedFrame(secondSse, true);
    const secondData = loaded as { pid: number; startedAt: number; avatar: { gen: number; v: string } };
    expect(secondData.avatar).toEqual({ gen: 1, v: putAvatar.v });
    expect(secondData.avatar.v).toBe(PNG_V);
    expect(`${secondData.pid}:${secondData.startedAt}`).not.toBe(`${firstData.pid}:${firstData.startedAt}`);

    // The browser's R1 rule: a different hub identity is adopted even when its gen is lower.
    const best = { id: `${firstData.pid}:${firstData.startedAt}`, gen: firstData.avatar.gen, v: firstData.avatar.v };
    const observed = {
      id: `${secondData.pid}:${secondData.startedAt}`,
      gen: secondData.avatar.gen,
      v: secondData.avatar.v,
    };
    const adopted = observed.id !== best.id || observed.gen > best.gen ? observed : best;
    expect(adopted).toEqual({ id: observed.id, gen: 1, v: PNG_V });

    const fetched = await avatarRequest(second.hub.httpPort, { cookie: second.cookie });
    expect(fetched.status).toBe(200);
    expect(fetched.body).toEqual(PNG);
  });

  it("a LAN password session fetches the same hub-stored image as loopback", async () => {
    if (NO_NODE_SQLITE) return;
    const live = await boot({ lan: true });
    const lanPort = await waitLanOn(live);
    const lan = await lanCookie(live, lanPort);
    const put = await avatarRequest(live.hub.httpPort, { method: "POST", cookie: live.cookie, body: PNG });
    expect(put.status).toBe(200);

    const fetched = await avatarRequest(lanPort, { cookie: lan });
    expect(fetched.status).toBe(200);
    expect(fetched.body).toEqual(PNG);
    expect(fetched.headers.etag).toBe(`"${PNG_V}"`);
  });

  it("serializes concurrent writes: one request owns the body slot and the other is inflight", async () => {
    const live = await boot();
    const slow = slowUpload(live.hub.httpPort, live.cookie);
    await delay(75);
    const concurrent = await avatarRequest(live.hub.httpPort, { method: "POST", cookie: live.cookie, body: PNG });
    expect(concurrent.status).toBe(503);
    expect(jsonBody(concurrent)).toMatchObject({ error: "E_BUSY", reason: "inflight" });
    slow.finish(PNG.subarray(Math.floor(PNG.length / 2)));
    const first = await slow.result;
    expect(first.status).toBe(200);
  });

  it("delete reaches 404 and remains empty after a same-HOME restart", async () => {
    const first = await boot();
    const put = await avatarRequest(first.hub.httpPort, { method: "POST", cookie: first.cookie, body: PNG });
    expect(put.status).toBe(200);
    const deleted = await avatarRequest(first.hub.httpPort, {
      method: "POST",
      path: AVATAR_DELETE_PATH,
      cookie: first.cookie,
      body: Buffer.from("{}"),
    });
    expect(deleted.status).toBe(200);
    expect((jsonBody(deleted).avatar as { gen: number }).gen).toBe(3);
    expect((await avatarRequest(first.hub.httpPort, { cookie: first.cookie })).status).toBe(404);
    await stop(first);

    const second = await boot({ home: first.home });
    const sse = await openTrackedSse(second);
    const loaded = await loadedFrame(sse, false);
    expect(avatarOf(loaded)).toEqual({ gen: 1 });
    expect((await avatarRequest(second.hub.httpPort, { cookie: second.cookie })).status).toBe(404);
    expect(existsSync(join(second.hub.paths.stateDir, "avatar", "avatar.png"))).toBe(false);
  });

  it.each(["symlink", "trailing-byte"])(
    "rejects a hand-corrupted %s file on restart but keeps other endpoints healthy",
    async (corruption) => {
      const first = await boot();
      const put = await avatarRequest(first.hub.httpPort, { method: "POST", cookie: first.cookie, body: PNG });
      expect(put.status).toBe(200);
      const avatarPath = join(first.hub.paths.stateDir, "avatar", "avatar.png");
      if (corruption === "symlink") {
        const target = join(first.home, "outside.png");
        appendFileSync(target, PNG);
        rmSync(avatarPath);
        symlinkSync(target, avatarPath);
      } else {
        appendFileSync(avatarPath, Buffer.from([0]));
      }
      await stop(first);

      const second = await boot({ home: first.home });
      const sse = await openTrackedSse(second);
      expect(avatarOf(await loadedFrame(sse, false))).toEqual({ gen: 1 });
      expect((await avatarRequest(second.hub.httpPort, { cookie: second.cookie })).status).toBe(404);
      // The regular authenticated SSE endpoint remains healthy while the avatar is rejected.
      expect(sse.status).toBe(200);
      const log = readFileSync(second.hub.paths.logFile, "utf8");
      expect(log).toContain('"msg":"avatar load rejected"');
    },
  );
});
