/** Real startHub, BOTH real HTTP listeners/SQLite auth, current UDS metadata RPC,
 * real isolated Python PTY and independent NDJSON. The agent context responder is
 * explicitly simulated, NOT a real pi SDK context or an O/N maintenance rehearsal. */
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { request, type IncomingMessage } from "node:http";
import { afterEach, describe, expect, it, vi } from "vitest";
import { startHub, type RunningHub } from "../../src/web-hub/hub/hub.js";
import { createHttpFrontend } from "../../src/web-hub/hub/http.js";
import { createTerminalTestBackend } from "../../src/web-hub/hub/terminal/v2/backend.js";
import type { HubTerminalServiceV2 } from "../../src/web-hub/hub/terminal/v2/service.js";
import type { TerminalFrontendDepsV2 } from "../../src/web-hub/hub/terminal/v2/frontend.js";
import { webHubStateDir } from "../../src/web-hub/protocol/paths.js";
import { NdjsonDecoder } from "../../src/web-hub/protocol/ndjson.js";
import type { TerminalViewFrameV2 } from "../../src/web-hub/protocol/terminal-v2.js";
import { makeTerminalFixture } from "./terminal-v2-backend-fixture.js";
import { config, connectClient, hello, type TestClient } from "../web-hub/hub/helpers.js";
import { login, openSse, postJson, type SseConn } from "../web-hub/http/helpers.js";
import { lanPostJson } from "../web-hub/http/lan-helpers.js";
import { freePort } from "../helpers/free-port.js";
const closers: Array<() => void | Promise<void>> = [];
afterEach(async () => {
  for (const close of closers.splice(0).reverse()) await close();
  vi.unstubAllEnvs();
});
async function fixture(corrupt = false, terminalEnabled = true) {
  const privatePty = makeTerminalFixture();
  closers.push(privatePty.cleanup);
  const home = privatePty.fixture.home,
    state = webHubStateDir(home),
    socketDir = join(privatePty.fixture.root, "s");
  mkdirSync(state, { recursive: true, mode: 0o700 });
  mkdirSync(socketDir, { mode: 0o700 });
  writeFileSync(
    join(home, ".pi/agent/pi-toolkit.json"),
    JSON.stringify({ webHub: { terminal: { enabled: terminalEnabled } } }),
    { mode: 0o600 },
  );
  // Contract fixture initialization, NOT a trusted fresh maintenance history claim.
  const marker = { v: 2, storeId: "s".repeat(24), initialization: "fresh", checkpointId: "c".repeat(24) };
  mkdirSync(join(state, "terminal-v2"), { mode: 0o700 });
  const put = (path: string, value: unknown) => writeFileSync(path, JSON.stringify(value), { mode: 0o600 });
  put(join(state, ".terminal-initialized-v2"), marker);
  put(join(state, "terminal-v2/marker.json"), marker);
  put(
    join(state, "terminal-v2/ledger.json"),
    corrupt ? { broken: true } : { v: 2, storeId: marker.storeId, revision: 0, allocations: [] },
  );
  vi.stubEnv("HOME", home);
  vi.stubEnv("PI_CODING_AGENT_DIR", join(home, ".pi/agent"));
  vi.stubEnv("PI_WEBHUB_TERMINAL_SOURCE", "plain");
  const lanPort = await freePort();
  let initialized: Promise<void> | undefined, service: HubTerminalServiceV2 | undefined;
  let terminal: TerminalFrontendDepsV2["terminalV2"];
  let authStore: import("../../src/web-hub/hub/ports.js").LanStorePort | undefined;
  const started = await startHub(
    config({
      home,
      lan: { port: lanPort, extraHosts: [], trustProxyFrom: ["127.0.0.1"], externalOrigins: ["https://hub.test"] },
    }),
    (deps) => {
      terminal = (deps as typeof deps & TerminalFrontendDepsV2).terminalV2;
      authStore = deps.lan?.store;
      return createHttpFrontend(deps);
    },
    {
      xdgRuntimeDir: socketDir,
      terminalV2Test: {
        backend: (options) => createTerminalTestBackend(options, privatePty.fixture),
        ready: (work, owner) => {
          initialized = work;
          service = owner;
        },
      },
    },
  );
  if ("exists" in started || !("httpPort" in started)) throw new Error("private hub did not start");
  const hub: RunningHub = started;
  closers.push(() => hub.close("private-test"));
  await initialized;
  if (terminalEnabled) {
    expect(terminal).toBeDefined();
    expect(service).toBeDefined();
  } else {
    expect(terminal).toBeUndefined();
    expect(service).toBeUndefined();
  }
  const agent = await connectClient(hub.paths.socketPath);
  closers.push(() => {
    agent.sock.destroy();
  });
  agent.send(hello({ agentId: { pid: process.pid, nonce: "v2-private-metadata" }, cwd: privatePty.fixture.cwd }));
  const ack = await agent.waitFrame((f) => f.t === "hello_ack"),
    key = ack.agentKey as string;
  const scope = { agentKey: key, sessionId: "private-session", epoch: "epoch-1" };
  const contextDecoder = new NdjsonDecoder({
    onFrame(raw) {
      const frame = raw as Record<string, unknown>;
      if (frame.t === "terminal_context_req")
        agent.send({
          t: "terminal_context_res",
          v: 2,
          ok: true,
          rid: frame.rid,
          sessionId: scope.sessionId,
          epoch: scope.epoch,
          contextGeneration: frame.contextGeneration,
          cwd: privatePty.fixture.cwd,
        });
    },
    onError() {
      throw new Error("bad private request");
    },
  });
  agent.sock.on("data", (chunk: Buffer) => contextDecoder.push(chunk));
  agent.send({
    t: "session",
    sessionId: scope.sessionId,
    cwd: privatePty.fixture.cwd,
    reason: "startup",
    leafId: null,
    mode: "tui",
  });
  agent.send({
    t: "status",
    leafId: null,
    busy: false,
    pending: false,
    terminalSessionV2: {
      v: 2,
      enabled: true,
      sessionId: scope.sessionId,
      epoch: scope.epoch,
      contextGeneration: 1,
      limits: { maxPerSession: 2, inputIdleMs: 3600000, maxLifetimeMs: 28800000 },
    },
  });
  // Stream ordering fence: this reply follows both declarations on the same UDS.
  agent.send({ t: "ping", ts: 771 });
  await agent.waitFrame((f) => f.t === "pong" && f.ts === 771);
  const loopCookie = await login(hub.httpPort, hub.paths.tokenFile);
  const info = await admin(agent, { op: "info" });
  if (!info.ok || !info.info) throw new Error("private LAN info failed");
  const lanHeaders = {
    Host: "hub.test",
    Origin: "https://hub.test",
    "X-Forwarded-Proto": "https",
    "X-Forwarded-Host": "hub.test",
  };
  const lanLogin = await lanPostJson(
    lanPort,
    "/api/login",
    { username: info.info.username, password: info.info.initialPassword },
    lanHeaders,
  );
  expect(lanLogin.status).toBe(200);
  const lanCookie = lanLogin.headers["set-cookie"]?.[0]?.split(";")[0];
  expect(lanCookie).toBeDefined();
  const loop = async (op: string, body: unknown) => {
    const response = await postJson(hub.httpPort, `/api/terminal/v2/${op}`, body, {
      Cookie: loopCookie,
      Origin: `http://127.0.0.1:${hub.httpPort}`,
    });
    return { status: response.status, body: JSON.parse(response.body) as Record<string, any> };
  };
  const lan = async (op: string, body: unknown, cookie = lanCookie!) => {
    const response = await lanPostJson(lanPort, `/api/terminal/v2/${op}`, body, { ...lanHeaders, Cookie: cookie });
    return { status: response.status, body: JSON.parse(response.body) as Record<string, any> };
  };
  return {
    hub,
    state,
    agent,
    scope,
    loop,
    lan,
    authStore: authStore!,
    terminal: terminal!,
    service: service!,
    loopCookie,
    lanCookie: lanCookie!,
    lanHeaders,
    lanPort,
    username: info.info.username,
    privatePty,
  };
}
async function admin(client: TestClient, input: Record<string, unknown>) {
  const rid = Math.random().toString(36).slice(2);
  client.send({ t: "lan_req", rid, ...input });
  return (await client.waitFrame((frame) => frame.t === "lan_res" && frame.rid === rid, 10000)) as Record<string, any>;
}
async function view(port: number, cookie: string, body: unknown) {
  const response = await new Promise<IncomingMessage>((resolve, reject) => {
    const req = request(
      {
        host: "127.0.0.1",
        port,
        path: "/api/terminal/v2/view",
        method: "POST",
        agent: false,
        headers: {
          Cookie: cookie,
          Origin: `http://127.0.0.1:${port}`,
          "x-pwh": "1",
          "content-type": "application/json",
          "accept-encoding": "gzip",
        },
      },
      resolve,
    );
    req.once("error", reject);
    req.end(JSON.stringify(body));
  });
  closers.push(() => {
    response.destroy();
  });
  expect(response.statusCode).toBe(200);
  expect(response.headers["content-encoding"]).toBe("identity");
  const frames: TerminalViewFrameV2[] = [],
    listeners = new Set<() => void>();
  const streamDecoder = new NdjsonDecoder({
    onFrame(raw) {
      frames.push(raw as TerminalViewFrameV2);
      for (const listener of listeners) listener();
    },
    onError() {
      throw new Error("invalid private view");
    },
  });
  response.on("data", (chunk: Buffer) => streamDecoder.push(chunk));
  const next = (predicate: (frame: TerminalViewFrameV2) => boolean) =>
    new Promise<TerminalViewFrameV2>((resolve, reject) => {
      const timer = setTimeout(() => {
        listeners.delete(check);
        reject(new Error("private view frame deadline"));
      }, 5000);
      timer.unref();
      const check = () => {
        const found = frames.find(predicate);
        if (found) {
          clearTimeout(timer);
          listeners.delete(check);
          resolve(found);
        }
      };
      listeners.add(check);
      check();
    });
  return { response, frames, next };
}
describe("P6 real hub v2 composition (agent context simulated)", () => {
  it("both authenticated listeners share one real PTY, independent view echoes and exact durable prune; ordinary SSE untouched", async () => {
    const h = await fixture();
    expect(h.hub.info.caps).toContain("terminal.tabs.v2");
    expect(h.hub.info.caps).not.toContain("terminal.ui.v1");
    const publicSse: SseConn = await openSse(h.hub.httpPort, { cookie: h.loopCookie });
    closers.push(publicSse.close);
    const helloEvent = await publicSse.waitFor((e) => e.event === "hello");
    const clientId = helloEvent.data.clientId;
    const list = await h.loop("list", { scope: h.scope });
    expect(list.status).toBe(200);
    const envelope = { scope: h.scope, hubInstance: list.body.hubInstance };
    const created = await h.loop("create", {
      ...envelope,
      requestId: "r".repeat(24),
      mode: "ensure-empty",
      cols: 80,
      rows: 24,
    });
    expect(created.body.ok).toBe(true);
    const shared = await h.lan("list", { scope: h.scope });
    expect(shared.body.rows[0].termId).toBe(created.body.termId);
    const term = { ...envelope, termId: created.body.termId };
    const stream = await view(h.hub.httpPort, h.loopCookie, term);
    const attached = await stream.next((f) => f.t === "attached");
    if (attached.t !== "attached") throw new Error();
    expect(attached.metadata?.cwd).toBe(h.privatePty.fixture.cwd);
    const replay = await stream.next((f) => f.t === "replay-end");
    if (replay.t !== "replay-end") throw new Error();
    const writer = { ...term, viewId: attached.viewId };
    expect((await h.loop("ack", { ...writer, offset: replay.offset, replayComplete: true })).body.ok).toBe(true);
    await stream.next((f) => f.t === "ready");
    expect(
      (
        await h.loop("input", {
          ...writer,
          seq: 1,
          bytesB64: Buffer.from("printf 'T51_PRIVATE_PID=%s\\n' \"$$\"\n").toString("base64"),
          kind: "user",
        })
      ).body.ok,
    ).toBe(true);
    const output = await stream.next(
      (f) => f.t === "output" && /T51_PRIVATE_PID=\d+/.test(Buffer.from(f.bytesB64, "base64").toString()),
    );
    if (output.t !== "output") throw new Error();
    const pid = /T51_PRIVATE_PID=(\d+)/.exec(Buffer.from(output.bytesB64, "base64").toString())![1]!;
    expect(readFileSync(`/proc/${pid}/stat`, "utf8")).toContain("(");
    const renamed = await h.lan("rename", { ...term, name: "shared shell" });
    expect(renamed.body.ok).toBe(true);
    expect((await h.loop("list", { scope: h.scope })).body.rows[0].name).toBe("shared shell");
    const closed = await h.lan("close", term);
    expect(closed.body).toMatchObject({ ok: true, state: "closed" });
    const disk = JSON.parse(readFileSync(join(h.state, "terminal-v2/ledger.json"), "utf8"));
    expect(disk.revision).toBeGreaterThanOrEqual(2);
    expect(disk.allocations).toEqual([]);
    expect(() => readFileSync(`/proc/${pid}/stat`)).toThrow();
    expect(publicSse.ended).toBe(false);
    expect(JSON.stringify(publicSse.events)).not.toContain("T51_PRIVATE_PID");
    expect(JSON.stringify(publicSse.events)).not.toContain("terminal_context_");
    const sub = await postJson(
      h.hub.httpPort,
      "/api/subscribe",
      { clientId, agentKey: h.scope.agentKey },
      { Cookie: h.loopCookie },
    );
    expect(sub.status).toBe(202);
    expect((await h.service.dispose()).clean).toBe(true);
  }, 30000);
  it("bad terminal ledger does not block real token/LAN login, passwd commit fact convergence, or logout", async () => {
    const h = await fixture(true);
    expect((await h.loop("list", { scope: h.scope })).body.code).toBe("E_RESOURCE_UNAVAILABLE");
    const password = "Separate-Auth-Only-Password-873!";
    expect((await admin(h.agent, { op: "passwd", username: h.username, password })).ok).toBe(true);
    // Same-transaction fact completed the temporary block even though resources failed.
    expect(() =>
      h.terminal.auth.check(
        { listener: "lan", principal: "u1", userId: 1, sidTag: "a".repeat(43), parentExpiresAt: Date.now() + 10000 },
        h.terminal.auth.revision,
      ),
    ).not.toThrow();
    const relogin = await lanPostJson(h.lanPort, "/api/login", { username: h.username, password }, h.lanHeaders);
    expect(relogin.status).toBe(200);
    const cookie = relogin.headers["set-cookie"]![0]!.split(";")[0]!;
    const logout = await lanPostJson(h.lanPort, "/api/logout", {}, { ...h.lanHeaders, Cookie: cookie });
    expect(logout.status).toBe(200);
    expect(logout.body).toBe('{"ok":true}');
    const denied = await h.lan("list", { scope: h.scope }, cookie);
    expect(denied.body.code).toBe("E_AUTH");
    expect((await postJson(h.hub.httpPort, "/api/logout", {}, { Cookie: h.loopCookie })).status).toBe(200);
  }, 30000);
});

describe("P6 honest original-auth failure contract on/off", () => {
  it.each([true, false])(
    "DB failure cannot report successful logout (terminal=%s)",
    async (enabled) => {
      const h = await fixture(true, enabled);
      const originalDelete = h.authStore.deleteSession;
      let calls = 0;
      h.authStore.deleteSession = async () => {
        calls++;
        throw new Error("injected original auth DB failure");
      };
      const failed = await lanPostJson(h.lanPort, "/api/logout", {}, { ...h.lanHeaders, Cookie: h.lanCookie });
      expect(calls).toBe(1);
      expect(failed.status).toBe(503);
      expect(JSON.parse(failed.body)).toEqual({ error: "E_DB", effect: "unknown", localSignedOut: true });
      expect(failed.headers["set-cookie"]![0]).toContain("Max-Age=0");
      h.authStore.deleteSession = originalDelete;
      if (enabled) {
        const originalInvalidate = h.terminal.auth.invalidate;
        closers.push(() => {
          h.terminal.auth.invalidate = originalInvalidate;
        });
        h.terminal.auth.invalidate = () => {
          throw new Error("terminal callback only");
        };
      }
      const succeeded = await lanPostJson(h.lanPort, "/api/logout", {}, { ...h.lanHeaders, Cookie: h.lanCookie });
      expect(succeeded.status).toBe(200);
      expect(succeeded.body).toBe('{"ok":true}');
    },
    30000,
  );
});
