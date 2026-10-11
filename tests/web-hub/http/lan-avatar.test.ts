import { mkdirSync, readFileSync } from "node:fs";
import { request as httpRequest } from "node:http";
import { createServer as createNetServer } from "node:net";
import { afterEach, describe, expect, it } from "vitest";
import { AVATAR_DELETE_PATH, AVATAR_PATH } from "../../../src/web-hub/protocol/avatar.js";
import { createAvatarRoutes } from "../../../src/web-hub/hub/avatar/routes.js";
import { createAvatarStore, type AvatarStore } from "../../../src/web-hub/hub/avatar/store.js";
import { createHttpFrontend, readBody } from "../../../src/web-hub/hub/http.js";
import { createKdfAdmission } from "../../../src/web-hub/hub/kdf-admission.js";
import { createScope } from "../../../src/web-hub/hub/lifecycle.js";
import { createHostsPort } from "../../../src/web-hub/hub/net-hosts.js";
import { createLoginLimiter } from "../../../src/web-hub/hub/ratelimit.js";
import type { HubInfo, HubLanConfig, HttpFrontend, LanStatus } from "../../../src/web-hub/hub/ports.js";
import { fakeKdf, fakeLanStore } from "../contract/fakes.js";
import { fakeDeps, login, makeTmp, openSse as openLoopbackSse } from "./helpers.js";
import { lanPostJson, lanRequest, openSse, seedLanUser } from "./lan-helpers.js";

const PNG = readFileSync(new URL("../../fixtures/web-hub-avatar/chrome-canvas.png", import.meta.url));

async function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = createNetServer();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      const port = address !== null && typeof address === "object" ? address.port : 0;
      server.close(() => resolve(port));
    });
  });
}

function lanBinaryRequest(
  port: number,
  cookie: string,
  path: string,
  body: Buffer,
  headers: Record<string, string> = {},
): Promise<{ status: number; body: Buffer }> {
  return new Promise((resolve, reject) => {
    const req = httpRequest(
      {
        host: "127.0.0.1",
        port,
        method: "POST",
        path,
        agent: false,
        headers: {
          Host: `127.0.0.1:${port}`,
          Cookie: cookie,
          "X-PWH": "1",
          Origin: `http://127.0.0.1:${port}`,
          "Content-Type": path === AVATAR_DELETE_PATH ? "application/json" : "application/octet-stream",
          "Content-Length": String(body.length),
          ...headers,
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

interface Harness {
  tmp: ReturnType<typeof makeTmp>;
  fe: HttpFrontend;
  lanPort: number;
  loopbackPort: number;
  lanCookie: string;
  loopbackCookie: string;
  scope: ReturnType<typeof createScope>;
  avatarClose(): Promise<void>;
}

async function setup(cfgOverrides: Partial<HubLanConfig> = {}, withAvatar = true): Promise<Harness> {
  const tmp = makeTmp("pwh-lan-avatar-");
  const deps = fakeDeps(tmp.dir);
  mkdirSync(deps.paths.stateDir, { recursive: true });
  const info: HubInfo = {
    version: "9.9.9-test",
    buildId: "b1",
    pid: process.pid,
    startedAt: 1,
    proto: deps.info().proto,
    caps: [],
  };
  deps.info = () => ({ ...info });
  let avatarStore: AvatarStore | undefined;
  let avatar: ReturnType<typeof createAvatarRoutes> | undefined;
  if (withAvatar) {
    avatarStore = createAvatarStore({
      stateDir: deps.paths.stateDir,
      now: deps.now,
      log: deps.log,
      onChange: (change) => {
        info.avatar = change.info;
        deps.emit({ type: "hub" });
      },
    });
    await avatarStore.load();
    avatar = createAvatarRoutes({
      store: avatarStore,
      hub: () => ({ pid: process.pid, startedAt: 1 }),
      readBody,
      log: deps.log,
      now: deps.now,
    });
  }
  const store = fakeLanStore();
  seedLanUser(store, { username: "alice", password: "correct-horse-battery" });
  const kdf = fakeKdf();
  const limiter = createLoginLimiter({ now: deps.now });
  const admission = createKdfAdmission({ now: deps.now, isTightened: limiter.isTightened });
  const hosts = createHostsPort();
  const scope = createScope({ log: deps.log, now: deps.now });
  const cfg: HubLanConfig = {
    port: await freePort(),
    extraHosts: [],
    trustProxyFrom: [],
    externalOrigins: [],
    ...cfgOverrides,
  };
  let status: LanStatus = { state: "starting" };
  const fe = createHttpFrontend({
    ...deps,
    ...(avatar === undefined ? {} : { avatar }),
    lan: { cfg, store, kdf, limiter, admission, hosts, scope, onStatus: (next) => (status = next) },
  });
  const loopbackPort = (await fe.listen()).port;
  if (fe.lan === undefined) throw new Error("LAN facade missing");
  status = await fe.lan.start();
  if (status.state !== "on") throw new Error(`LAN failed to start: ${JSON.stringify(status)}`);
  const proxyLoginHeaders = cfg.trustProxyFrom.includes("127.0.0.1")
    ? {
        Host: "hub.example.com",
        Origin: "https://hub.example.com",
        "X-Forwarded-Proto": "https",
        "X-Forwarded-Host": "hub.example.com",
      }
    : {};
  const lanLogin = await lanPostJson(
    status.port,
    "/api/login",
    {
      username: "alice",
      password: "correct-horse-battery",
    },
    proxyLoginHeaders,
  );
  if (lanLogin.status !== 200) throw new Error(`LAN login failed: ${lanLogin.status} ${lanLogin.body}`);
  const lanCookie = (lanLogin.headers["set-cookie"]?.[0] ?? "").split(";")[0]!;
  const loopbackCookie = await login(loopbackPort, deps.paths.tokenFile);
  return {
    tmp,
    fe,
    lanPort: status.port,
    loopbackPort,
    lanCookie,
    loopbackCookie,
    scope,
    avatarClose: () => avatarStore?.close() ?? Promise.resolve(),
  };
}

const harnesses: Harness[] = [];
afterEach(async () => {
  for (const h of harnesses.splice(0)) {
    await h.fe.close();
    await h.avatarClose();
    await h.scope.dispose();
    h.tmp.cleanup();
  }
});

async function harness(cfg?: Partial<HubLanConfig>, withAvatar = true): Promise<Harness> {
  const h = await setup(cfg, withAvatar);
  harnesses.push(h);
  return h;
}

describe("LAN avatar HTTP assembly", () => {
  it.each(["avatar:false", "control:false"])(
    "feature-off %s keeps LAN avatar paths byte-identical to an unknown path",
    async () => {
      const h = await harness(undefined, false);
      const getUnknown = await lanRequest(h.lanPort, {
        path: "/api/not-an-avatar",
        headers: { "X-PWH": "1", Cookie: h.lanCookie },
      });
      for (const path of [AVATAR_PATH, AVATAR_DELETE_PATH]) {
        const response = await lanRequest(h.lanPort, {
          path,
          headers: { "X-PWH": "1", Cookie: h.lanCookie },
        });
        expect(response.status).toBe(getUnknown.status);
        expect(response.body).toBe(getUnknown.body);
        expect(response.headers["content-type"]).toBe(getUnknown.headers["content-type"]);
        expect(response.headers["cache-control"]).toBe(getUnknown.headers["cache-control"]);
      }
      const postUnknown = await lanBinaryRequest(h.lanPort, h.lanCookie, "/api/not-an-avatar", PNG);
      const uploadOff = await lanBinaryRequest(h.lanPort, h.lanCookie, AVATAR_PATH, PNG);
      expect(uploadOff.status).toBe(postUnknown.status);
      expect(uploadOff.body).toEqual(postUnknown.body);
      const jsonUnknown = await lanBinaryRequest(h.lanPort, h.lanCookie, "/api/not-an-avatar-delete", PNG, {
        "Content-Type": "application/json",
      });
      const deleteOff = await lanBinaryRequest(h.lanPort, h.lanCookie, AVATAR_DELETE_PATH, PNG, {
        "Content-Type": "application/json",
      });
      expect(deleteOff.status).toBe(jsonUnknown.status);
      expect(deleteOff.body).toEqual(jsonUnknown.body);
    },
  );

  it("mounts the same endpoint with LAN CSRF/auth gates", async () => {
    const h = await harness();
    const csrf = await lanRequest(h.lanPort, { path: AVATAR_PATH });
    expect(csrf.status).toBe(403);
    const auth = await lanRequest(h.lanPort, { path: AVATAR_PATH, headers: { "X-PWH": "1" } });
    expect(auth.status).toBe(401);
  });

  it("publishes upload and delete hub frames on both listeners; dedup publishes none", async () => {
    const h = await harness();
    const loopbackSse = await openLoopbackSse(h.loopbackPort, { cookie: h.loopbackCookie });
    const lanSse = await openSse(h.lanPort, h.lanCookie);
    expect(loopbackSse.status).toBe(200);
    expect(lanSse.events).toBeDefined();
    const put = await lanBinaryRequest(h.lanPort, h.lanCookie, AVATAR_PATH, PNG);
    expect(put.status).toBe(200);
    const putData = JSON.parse(put.body.toString("utf8")) as { avatar: { gen: number; v: string } };
    expect(putData.avatar.v).toMatch(/^[0-9a-f]{64}$/);
    const waitHub = async (events: typeof loopbackSse.events): Promise<Record<string, unknown>> => {
      const deadline = Date.now() + 3_000;
      while (Date.now() < deadline) {
        const found = events.find(
          (event) =>
            event.event === "hub" && (event.data as { avatar?: { gen?: number } }).avatar?.gen === putData.avatar.gen,
        );
        if (found !== undefined) return found.data as Record<string, unknown>;
        await new Promise((resolve) => setTimeout(resolve, 10));
      }
      throw new Error("hub frame timeout");
    };
    expect((await waitHub(loopbackSse.events)).avatar).toMatchObject({ gen: putData.avatar.gen, v: putData.avatar.v });
    expect((await waitHub(lanSse.events)).avatar).toMatchObject({ gen: putData.avatar.gen, v: putData.avatar.v });
    const loopbackBefore = loopbackSse.events.length;
    const lanBefore = lanSse.events.length;
    const dedup = await lanBinaryRequest(h.lanPort, h.lanCookie, AVATAR_PATH, PNG);
    expect(dedup.status).toBe(200);
    await new Promise((resolve) => setTimeout(resolve, 100));
    expect(loopbackSse.events.length).toBe(loopbackBefore);
    expect(lanSse.events.length).toBe(lanBefore);
    const del = await lanBinaryRequest(h.lanPort, h.lanCookie, AVATAR_DELETE_PATH, Buffer.from("{}"));
    expect(del.status).toBe(200);
    const delData = JSON.parse(del.body.toString("utf8")) as { avatar: { gen: number } };
    const deadline = Date.now() + 3_000;
    while (
      Date.now() < deadline &&
      !loopbackSse.events.some(
        (event) =>
          event.event === "hub" && (event.data as { avatar?: { gen?: number } }).avatar?.gen === delData.avatar.gen,
      )
    ) {
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    expect(
      loopbackSse.events.some(
        (event) =>
          event.event === "hub" && (event.data as { avatar?: { gen?: number } }).avatar?.gen === delData.avatar.gen,
      ),
    ).toBe(true);
    expect(
      lanSse.events.some(
        (event) =>
          event.event === "hub" && (event.data as { avatar?: { gen?: number } }).avatar?.gen === delData.avatar.gen,
      ),
    ).toBe(true);
    loopbackSse.close();
    lanSse.close();
  });

  it("direct HTTP Origin is accepted without Sec-Fetch-Site", async () => {
    const h = await harness();
    const response = await lanBinaryRequest(h.lanPort, h.lanCookie, AVATAR_PATH, PNG);
    expect(response.status).toBe(200);
  });

  it("trusted proxy requires an allowlisted external Origin, while untrusted forwarding is ignored", async () => {
    const trusted = await harness({ trustProxyFrom: ["127.0.0.1"], externalOrigins: ["https://hub.example.com"] });
    const wrong = await lanBinaryRequest(trusted.lanPort, trusted.lanCookie, AVATAR_PATH, PNG, {
      Host: "evil.example",
      Origin: "https://evil.example",
      "X-Forwarded-Proto": "https",
      "X-Forwarded-Host": "evil.example",
    });
    expect(wrong.status).toBe(421);
    const allowed = await lanBinaryRequest(trusted.lanPort, trusted.lanCookie, AVATAR_PATH, PNG, {
      Host: "hub.example.com",
      Origin: "https://hub.example.com",
      "X-Forwarded-Proto": "https",
      "X-Forwarded-Host": "hub.example.com",
    });
    expect(allowed.status).toBe(200);
    const untrusted = await harness();
    const forged = await lanBinaryRequest(untrusted.lanPort, untrusted.lanCookie, AVATAR_PATH, PNG, {
      Origin: "https://hub.example.com",
      "X-Forwarded-Proto": "https",
      "X-Forwarded-Host": "hub.example.com",
    });
    expect(forged.status).toBe(403);
  });

  it("does not read or validate an unauthenticated upload body", async () => {
    const h = await harness();
    const response = await lanRequest(h.lanPort, {
      method: "POST",
      path: AVATAR_PATH,
      headers: {
        "X-PWH": "1",
        Origin: `http://127.0.0.1:${h.lanPort}`,
        "Content-Type": "application/octet-stream",
      },
      body: PNG.toString("latin1"),
    });
    expect(response.status).toBe(401);
  });
});
