import { afterEach, describe, expect, it } from "vitest";
import { createHttpFrontend } from "../../../src/web-hub/hub/http.js";
import { createCommandCompleteRoutes } from "../../../src/web-hub/hub/command-complete.js";
import { createRegistry } from "../../../src/web-hub/hub/registry.js";
import { createScope } from "../../../src/web-hub/hub/lifecycle.js";
import { createClientAllowGuard } from "../../../src/web-hub/hub/client-allow.js";
import { createHostsPort } from "../../../src/web-hub/hub/net-hosts.js";
import { createKdfAdmission } from "../../../src/web-hub/hub/kdf-admission.js";
import { createLoginLimiter } from "../../../src/web-hub/hub/ratelimit.js";
import type { HttpFrontend } from "../../../src/web-hub/hub/ports.js";
import { COMMAND_COMPLETE_PATH } from "../../../src/web-hub/protocol/http-contract.js";
import { fakeDeps, login, makeTmp, postJson, rawRequest } from "./helpers.js";
import { fakeConn, hello } from "../hub/helpers.js";
import { fakeKdf, fakeLanStore } from "../contract/fakes.js";
import { lanPostJson, seedLanUser } from "./lan-helpers.js";
import { freePort } from "../../helpers/free-port.js";

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
  for (const close of cleanups.splice(0)) await close();
});
async function setup(enabled = true) {
  const tmp = makeTmp("command-complete-http-");
  const deps = fakeDeps(tmp.dir);
  const reg = createRegistry({ now: deps.now, log: deps.log, pidAlive: () => true });
  const conn = fakeConn();
  const send = conn.send.bind(conn);
  conn.send = (frame) => {
    send(frame);
    if (frame.t === "complete_req")
      queueMicrotask(() =>
        reg.onFrame(key, {
          t: "complete_reply",
          rid: frame.rid,
          ok: true,
          source: "own",
          items: [{ value: "keepalive on", label: "on" }],
        }),
      );
  };
  const key = reg.register(hello({ caps: ["cmd.v1", "command.v1", "cmd.args.v1"] }), conn).agentKey;
  reg.onFrame(key, {
    t: "commands",
    epoch: "e",
    items: [{ name: "cache-ttl", description: "cache", kind: "extension", policy: "allow" }],
  });
  const store = fakeLanStore();
  seedLanUser(store, { username: "alice", password: "correct-horse-battery" });
  const limiter = createLoginLimiter({ now: deps.now });
  const scope = createScope({ log: deps.log, now: deps.now });
  const fe: HttpFrontend = createHttpFrontend({
    ...deps,
    registry: reg,
    ...(enabled
      ? { commandComplete: createCommandCompleteRoutes({ registry: reg, now: deps.now, log: deps.log }) }
      : {}),
    lan: {
      cfg: { port: await freePort(), extraHosts: [], trustProxyFrom: [], externalOrigins: [] },
      clientAllow: createClientAllowGuard({}),
      store,
      kdf: fakeKdf(),
      limiter,
      admission: createKdfAdmission({ now: deps.now, isTightened: limiter.isTightened }),
      hosts: createHostsPort(),
      scope,
      onStatus: () => {},
    },
  });
  cleanups.push(async () => {
    await fe.close();
    await scope.dispose();
    tmp.cleanup();
  });
  const port = (await fe.listen()).port;
  const cookie = await login(port, deps.paths.tokenFile);
  const lan = await fe.lan!.start();
  if (lan.state !== "on") throw new Error(`LAN: ${lan.state}`);
  const auth = await lanPostJson(lan.port, "/api/login", { username: "alice", password: "correct-horse-battery" });
  expect(auth.status).toBe(200);
  const lanCookie = (auth.headers["set-cookie"]?.[0] ?? "").split(";")[0]!;
  return { port, cookie, lanPort: lan.port, lanCookie, key, conn, deps };
}

describe("POST /api/command/complete two listener wiring", () => {
  it("loopback and LAN both dispatch through strict CSRF + actual authentication", async () => {
    const h = await setup();
    for (const [port, cookie] of [
      [h.port, h.cookie],
      [h.lanPort, h.lanCookie],
    ] as const) {
      const body = { agentKey: h.key, name: "cache-ttl", prefix: "keepalive " };
      const origin = `http://127.0.0.1:${port}`;
      const bad = await postJson(port, COMMAND_COMPLETE_PATH, body, { Cookie: cookie, Origin: "http://evil.example" });
      expect(bad.status).toBe(403);
      expect(h.conn.sent.filter((f) => f.t === "complete_req")).toHaveLength(port === h.port ? 0 : 1);
      const noAuth = await postJson(port, COMMAND_COMPLETE_PATH, body, { Origin: origin });
      expect(noAuth.status).toBe(401);
      const good = await postJson(port, COMMAND_COMPLETE_PATH, body, { Cookie: cookie, Origin: origin });
      expect(good.status).toBe(200);
      expect(JSON.parse(good.body)).toEqual({ source: "own", items: [{ value: "keepalive on", label: "on" }] });
      expect(good.headers["cache-control"]).toBe("no-store");
    }
    const requests = h.conn.sent.filter((f) => f.t === "complete_req");
    expect(requests.map((f) => f.origin)).toEqual([{ listener: "loopback" }, { listener: "lan" }]);
  });
  it("absent route is 404 on both authenticated listeners", async () => {
    const h = await setup(false);
    for (const [port, cookie] of [
      [h.port, h.cookie],
      [h.lanPort, h.lanCookie],
    ] as const) {
      const res = await postJson(
        port,
        COMMAND_COMPLETE_PATH,
        { agentKey: h.key, name: "cache-ttl", prefix: "" },
        { Cookie: cookie, Origin: `http://127.0.0.1:${port}` },
      );
      expect(res.status).toBe(404);
    }
    expect(h.conn.sent).toHaveLength(0);
  });
  it("bounded body reader rejects malformed JSON, oversized bodies and missing CT/X-PWH", async () => {
    const h = await setup();
    const headers = {
      Cookie: h.cookie,
      Origin: `http://127.0.0.1:${h.port}`,
      "X-PWH": "1",
      "Content-Type": "application/json",
    };
    const bad = await rawRequest(h.port, { method: "POST", path: COMMAND_COMPLETE_PATH, headers, body: "{" });
    expect(bad.status).toBe(400);
    const big = await postJson(h.port, COMMAND_COMPLETE_PATH, { prefix: "x".repeat(9000) }, headers);
    expect(big.status).toBe(400);
    const csrf = await rawRequest(h.port, {
      method: "POST",
      path: COMMAND_COMPLETE_PATH,
      headers: { Cookie: h.cookie, Origin: headers.Origin },
      body: "{}",
    });
    expect(csrf.status).toBe(403);
    expect(h.conn.sent).toHaveLength(0);
  });
});
