import { mkdirSync, readFileSync } from "node:fs";
import { request as httpRequest, type IncomingMessage } from "node:http";
import { describe, expect, it, afterEach } from "vitest";
import { AVATAR_DELETE_PATH, AVATAR_MAX_BYTES, AVATAR_PATH } from "../../../src/web-hub/protocol/avatar.js";
import { createAvatarRoutes } from "../../../src/web-hub/hub/avatar/routes.js";
import { createAvatarStore } from "../../../src/web-hub/hub/avatar/store.js";
import { createHttpFrontend } from "../../../src/web-hub/hub/http.js";
import { readBody } from "../../../src/web-hub/hub/http.js";
import type { HubInfo, HttpFrontend } from "../../../src/web-hub/hub/ports.js";
import { fakeDeps, login, makeTmp, openSse, rawRequest, type FakeDeps } from "./helpers.js";

const PNG = readFileSync(new URL("../../fixtures/web-hub-avatar/chrome-canvas.png", import.meta.url));
const AVATAR_SHA256_RE = /^[0-9a-f]{64}$/;

interface Harness {
  tmp: ReturnType<typeof makeTmp>;
  deps: FakeDeps;
  fe: HttpFrontend;
  port: number;
  cookie: string;
}

function binaryRequest(
  port: number,
  opts: {
    method: string;
    path: string;
    cookie?: string;
    body: Buffer;
    headers?: Record<string, string>;
    origin?: string | null;
  },
): Promise<{ status: number; headers: IncomingMessage["headers"]; body: Buffer }> {
  return new Promise((resolve, reject) => {
    const req = httpRequest(
      {
        host: "127.0.0.1",
        port,
        method: opts.method,
        path: opts.path,
        agent: false,
        headers: {
          Host: `127.0.0.1:${port}`,
          Cookie: opts.cookie ?? "",
          "X-PWH": "1",
          ...(opts.origin === null ? {} : { Origin: opts.origin ?? `http://127.0.0.1:${port}` }),
          "Content-Type": opts.path === AVATAR_DELETE_PATH ? "application/json" : "application/octet-stream",
          "Content-Length": String(opts.body.length),
          ...(opts.headers ?? {}),
        },
      },
      (res) => {
        const chunks: Buffer[] = [];
        res.on("data", (chunk: Buffer) => chunks.push(chunk));
        res.on("end", () =>
          resolve({ status: res.statusCode ?? 0, headers: res.headers, body: Buffer.concat(chunks) }),
        );
        res.on("error", reject);
      },
    );
    req.setTimeout(10_000, () => req.destroy(new Error("request timeout")));
    req.on("error", reject);
    req.end(opts.body);
  });
}

function chunkedAvatarRequest(port: number, cookie: string, body: Buffer): Promise<{ status: number; body: Buffer }> {
  return new Promise((resolve, reject) => {
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
        },
      },
      (res) => {
        const chunks: Buffer[] = [];
        res.on("data", (chunk: Buffer) => chunks.push(chunk));
        res.on("end", () => resolve({ status: res.statusCode ?? 0, body: Buffer.concat(chunks) }));
        res.on("error", reject);
      },
    );
    req.setTimeout(10_000, () => req.destroy(new Error("request timeout")));
    req.on("error", reject);
    req.end(body);
  });
}

async function setup(withAvatar = true): Promise<Harness> {
  const tmp = makeTmp("pwh-avatar-http-");
  const deps = fakeDeps(tmp.dir);
  mkdirSync(deps.paths.stateDir, { recursive: true });
  const info: HubInfo = {
    version: "9.9.9",
    buildId: "b1",
    pid: process.pid,
    startedAt: 1,
    proto: deps.info().proto,
    caps: [],
  };
  deps.info = () => ({ ...info });
  if (withAvatar) {
    const store = createAvatarStore({
      stateDir: deps.paths.stateDir,
      now: deps.now,
      log: deps.log,
      onChange: (change) => {
        info.avatar = change.info;
        deps.emit({ type: "hub" });
      },
    });
    deps.avatar = createAvatarRoutes({
      store,
      hub: () => ({ pid: process.pid, startedAt: 1 }),
      readBody,
      log: deps.log,
      now: deps.now,
    });
    await store.load();
  }
  const fe = createHttpFrontend(deps);
  const port = (await fe.listen()).port;
  const cookie = await login(port, deps.paths.tokenFile);
  return { tmp, deps, fe, port, cookie };
}

const harnesses: Harness[] = [];
afterEach(async () => {
  for (const h of harnesses.splice(0)) {
    await h.fe.close();
    h.tmp.cleanup();
  }
});

async function harness(withAvatar = true): Promise<Harness> {
  const h = await setup(withAvatar);
  harnesses.push(h);
  return h;
}

describe("loopback avatar HTTP assembly", () => {
  it("feature-off keeps all avatar paths on the unknown-path response", async () => {
    const h = await harness(false);
    const unknown = await rawRequest(h.port, {
      method: "GET",
      path: "/api/not-an-avatar",
      headers: { Cookie: h.cookie },
    });
    for (const path of [AVATAR_PATH, AVATAR_DELETE_PATH]) {
      const response = await rawRequest(h.port, { method: "GET", path, headers: { Cookie: h.cookie } });
      expect(response.status).toBe(unknown.status);
      expect(response.body).toBe(unknown.body);
    }
  });

  it("enforces X-PWH/auth, accepts PNG, returns full ETag headers and exact 304", async () => {
    const h = await harness();
    const csrf = await rawRequest(h.port, { method: "GET", path: AVATAR_PATH, headers: { Cookie: h.cookie } });
    expect(csrf.status).toBe(403);
    const unauth = await rawRequest(h.port, { method: "GET", path: AVATAR_PATH, headers: { "X-PWH": "1" } });
    expect(unauth.status).toBe(401);
    const wrongOrigin = await binaryRequest(h.port, {
      method: "POST",
      path: AVATAR_PATH,
      cookie: h.cookie,
      body: PNG,
      origin: "http://evil.example",
    });
    expect(wrongOrigin.status).toBe(403);
    const missingOrigin = await binaryRequest(h.port, {
      method: "POST",
      path: AVATAR_PATH,
      cookie: h.cookie,
      body: PNG,
      origin: null,
    });
    expect(missingOrigin.status).toBe(403);

    const put = await binaryRequest(h.port, { method: "POST", path: AVATAR_PATH, cookie: h.cookie, body: PNG });
    expect(put.status, put.body.toString()).toBe(200);
    const data = JSON.parse(put.body.toString("utf8")) as { avatar: { v: string } };
    expect(data.avatar.v).toMatch(/^[0-9a-f]{64}$/);

    const get = await rawRequest(h.port, {
      method: "GET",
      path: AVATAR_PATH,
      headers: { Cookie: h.cookie, "X-PWH": "1" },
    });
    expect(get.status).toBe(200);
    expect(get.headers["content-type"]).toContain("image/png");
    expect(get.headers.etag).toBe(`"${data.avatar.v}"`);
    expect(get.headers["x-content-type-options"]).toBe("nosniff");
    expect(get.headers["cross-origin-resource-policy"]).toBe("same-origin");
    expect(get.headers["cache-control"]).toBe("private, no-cache");
    const notModified = await rawRequest(h.port, {
      method: "GET",
      path: AVATAR_PATH,
      headers: { Cookie: h.cookie, "X-PWH": "1", "If-None-Match": get.headers.etag! },
    });
    expect(notModified.status).toBe(304);
    expect(notModified.body).toBe("");
  });

  it("maps SVG and over-limit bodies to the avatar-specific errors", async () => {
    const h = await harness();
    const svg = await binaryRequest(h.port, {
      method: "POST",
      path: AVATAR_PATH,
      cookie: h.cookie,
      body: Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"/>'),
    });
    expect(svg.status, svg.body.toString()).toBe(415);
    const tooLarge = await binaryRequest(h.port, {
      method: "POST",
      path: AVATAR_PATH,
      cookie: h.cookie,
      body: Buffer.alloc(AVATAR_MAX_BYTES + 1),
    });
    expect(tooLarge.status).toBe(413);
  });

  it("rejects chunked over-limit bodies and releases the write slot", async () => {
    const h = await harness();
    const oversized = await chunkedAvatarRequest(h.port, h.cookie, Buffer.alloc(AVATAR_MAX_BYTES + 1));
    expect(oversized.status).toBe(413);
    const followUp = await binaryRequest(h.port, { method: "POST", path: AVATAR_PATH, cookie: h.cookie, body: PNG });
    expect(followUp.status).toBe(200);
  });

  it("returns 429 on the 11th write and throttles the audit per principal", async () => {
    const h = await harness();
    for (let i = 0; i < 10; i++) {
      const response = await binaryRequest(h.port, { method: "POST", path: AVATAR_PATH, cookie: h.cookie, body: PNG });
      expect(response.status).toBe(200);
    }
    const rejected = await binaryRequest(h.port, { method: "POST", path: AVATAR_PATH, cookie: h.cookie, body: PNG });
    expect(rejected.status).toBe(429);
    expect(rejected.headers["retry-after"]).toBeDefined();
    const rateAudits = h.deps.logLines.filter(
      (line) => line.data?.["audit"] === "avatar" && line.data?.["code"] === "E_RATE",
    );
    expect(rateAudits.length).toBeLessThanOrEqual(1);
  });

  it("publishes upload/delete hub frames, but not a deduplicated upload", async () => {
    const h = await harness();
    const sse = await openSse(h.port, { cookie: h.cookie });
    expect(sse.status).toBe(200);
    const put = await binaryRequest(h.port, { method: "POST", path: AVATAR_PATH, cookie: h.cookie, body: PNG });
    expect(put.status).toBe(200);
    const putData = JSON.parse(put.body.toString("utf8")) as { avatar: { gen: number; v: string } };
    expect(putData.avatar.v).toMatch(AVATAR_SHA256_RE);
    const putFrame = await sse.waitFor(
      (event) =>
        event.event === "hub" && (event.data as { avatar?: { gen?: number } }).avatar?.gen === putData.avatar.gen,
    );
    expect((putFrame.data as { avatar: { v: string } }).avatar.v).toMatch(AVATAR_SHA256_RE);
    const beforeDedup = sse.events.length;
    const dedup = await binaryRequest(h.port, { method: "POST", path: AVATAR_PATH, cookie: h.cookie, body: PNG });
    expect(dedup.status).toBe(200);
    await new Promise((resolve) => setTimeout(resolve, 100));
    expect(sse.events.length).toBe(beforeDedup);
    const del = await binaryRequest(h.port, {
      method: "POST",
      path: AVATAR_DELETE_PATH,
      cookie: h.cookie,
      body: Buffer.from("{}"),
    });
    expect(del.status).toBe(200);
    const delData = JSON.parse(del.body.toString("utf8")) as { avatar: { gen: number } };
    const delFrame = await sse.waitFor(
      (event) =>
        event.event === "hub" && (event.data as { avatar?: { gen?: number } }).avatar?.gen === delData.avatar.gen,
    );
    expect((delFrame.data as { avatar: { gen: number } }).avatar.gen).toBeGreaterThan(putData.avatar.gen);
    sse.close();
  });

  it("deletes idempotently through the assembled endpoint", async () => {
    const h = await harness();
    const put = await binaryRequest(h.port, { method: "POST", path: AVATAR_PATH, cookie: h.cookie, body: PNG });
    expect(put.status, put.body.toString()).toBe(200);
    const del = await binaryRequest(h.port, {
      method: "POST",
      path: AVATAR_DELETE_PATH,
      cookie: h.cookie,
      body: Buffer.from("{}"),
    });
    expect(del.status).toBe(200);
    const get = await rawRequest(h.port, {
      method: "GET",
      path: AVATAR_PATH,
      headers: { Cookie: h.cookie, "X-PWH": "1" },
    });
    expect(get.status).toBe(404);
  });
});
