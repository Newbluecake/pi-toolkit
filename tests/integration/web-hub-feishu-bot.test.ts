import { createHmac, timingSafeEqual } from "node:crypto";
import { totpCode } from "../../src/web-hub/hub/totp.js";
import { lanPostJson, lanRequest } from "../web-hub/http/lan-helpers.js";
import { freeTcpPort } from "../web-hub/http/proxy-kit.js";
import type { SecurityEvent } from "../../src/web-hub/hub/security-events.js";
import type { TfaResFrame } from "../../src/web-hub/protocol/lan-2fa.js";
/** F10: REAL child-process startHub + HTTP frontend, native WebSocket over the F3 local
 * RFC6455 fake, F2 HTTP fake, real Unix agent socket/router/stores/uploads/spawn supervisor.
 * Only the external Feishu transports and the agent are fake. main.ts intentionally has no
 * env/config test seam: this child invokes the same composition root with its existing DI.
 * No tenant credentials, external network, production seam or additional dependency. */
import { spawn, type ChildProcess } from "node:child_process";
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { callbackEnvelope, messageEnvelope } from "../fixtures/feishu/f6.js";
import { config, connectClient, hello, type TestClient } from "../web-hub/hub/helpers.js";
import { login, openSse } from "../web-hub/http/helpers.js";
import { parseAttachmentBlock } from "../../src/web-hub/protocol/upload.js";
import { resolveHubPaths } from "../../src/web-hub/protocol/paths.js";
import { FSB_HUB_CAP } from "../../src/web-hub/protocol/version.js";
import type { CmdFrame } from "../../src/web-hub/protocol/messages.js";

// Kept here (rather than a production-only environment flag or another fixture file) so the
// F10 file domain contains the entire integration harness. tsx executes actual source modules.
const CHILD = String.raw`
const root = process.cwd();
const load = (p) => import(root + "/" + p);
const { startHub } = await load("src/web-hub/hub/hub.ts");
const { createHttpFrontend } = await load("src/web-hub/hub/http.ts");
const { createCredentialStore } = await load("src/web-hub/hub/feishu/credentials.ts");
const { resolveHubPaths } = await load("src/web-hub/protocol/paths.ts");
const { normalizeFeishuBotHubConfig } = await load("src/web-hub/protocol/feishu.ts");
const { encodeFrame, decodeFrame, header } = await load("src/web-hub/hub/feishu/frame.ts");
const { createFakeFeishu } = await load("tests/fixtures/feishu/fake-http.ts");
const { createFakeWsServer } = await load("tests/fixtures/feishu/fake-ws-server.ts");
const cfg = JSON.parse(process.env.F10_CONFIG);
const paths = resolveHubPaths({home: cfg.home, uid: process.getuid?.() ?? 0});
const fake = createFakeFeishu({appId: "cli_test"});
// First reconnect jitter is disabled by the fake's nonce; subsequent retry policy is real.
fake.on("POST", "/callback/ws/endpoint", () => ({json: {code: 0, data: {
  URL: "wss://msg-frontier.feishu.cn/ws?service_id=33&device_id=f10-device", ClientConfig: {
    PingInterval: 90, ReconnectCount: -1, ReconnectInterval: 1, ReconnectNonce: 0
  }
}}}));
const ws = await createFakeWsServer();
if (cfg.feishuBot) {
  cfg.feishuBot = normalizeFeishuBotHubConfig(cfg.feishuBot);
  const store = createCredentialStore({dir: paths.stateDir + "/feishu-bot"});
  await store.load();
  if (!store.current()) {
    const saved = await store.commit({brand: "feishu", appId: fake.appId,
      appSecret: fake.appSecret, ownerOpenId: "ou_owner", botOpenId: "ou_bot"});
    if (!saved.ok) throw new Error("fixture credentials: " + saved.reason);
  }
}
const securityEvents = [];
const hub = await startHub(cfg, (deps) => {
  deps.lan?.security?.subscribe((e) => securityEvents.push(e));
  return createHttpFrontend(deps);
}, {feishuSeams: {
  fetch: fake.fetch,
  // Destination admission still validates the real wss URL before this transport seam.
  webSocket: () => new WebSocket(ws.url)
}});
if ("exists" in hub) throw new Error("unexpected existing hub");
let wireSeq = 0;
const reply = (id, value) => process.send?.({id, value});
process.on("message", async (m) => {
  try {
    if (m.op === "send") {
      const peer = ws.peers.at(-1);
      if (!peer || peer.closed) throw new Error("fake ws not connected");
      peer.send(encodeFrame({seqId: BigInt(++wireSeq), logId: 2n, service: 33, method: 1,
        headers: [{key:"type",value:"event"},{key:"message_id",value:"wire-"+wireSeq},
          {key:"sum",value:"1"},{key:"seq",value:"0"}],
        payloadEncoding:"", payload: Buffer.from(JSON.stringify(m.raw))}));
      reply(m.id, true);
    } else if (m.op === "inspect") {
      reply(m.id, {...(cfg.lan ? {securityEvents, lan: hub.lanStatus()} : {}), sent: fake.sent, calls: fake.calls.map(({signal, ...c}) => c),
        peers: ws.peers.length, livePeers: ws.peers.filter(p => !p.closed).length,
        acks: ws.peers.flatMap(p => p.received.map(decodeFrame)).filter(f => header(f,"biz_rt") !== undefined).length});
    } else if (m.op === "resource") {
      fake.resources.set(m.key, {bytes: Buffer.from(m.bytes), contentType: m.contentType});
      reply(m.id, true);
    } else if (m.op === "drop") {
      ws.peers.at(-1)?.drop(); reply(m.id, true);
    } else if (m.op === "stop") {
      await hub.close("test"); await ws.dispose(); reply(m.id, true); process.disconnect();
    } else throw new Error("unknown fixture op");
  } catch (e) { process.send?.({id: m.id, error: String(e)}); }
});
process.send?.({ready: true, port: hub.httpPort, caps: hub.info.caps, lanPort: cfg.lan?.port});
`;

interface Inspection {
  securityEvents?: SecurityEvent[];
  lan?: { state: string; port?: number };
  sent: Array<{ messageId: string; kind: string; body: Record<string, unknown> }>;
  calls: Array<{ method: string; path: string; json?: any; form?: any }>;
  peers: number;
  livePeers: number;
  acks: number;
}
const homes = new Set<string>();
const children = new Set<ChildProcess>();
function callback(nonce: string, options: Parameters<typeof callbackEnvelope>[1]) {
  const raw = callbackEnvelope(nonce, options);
  raw.header.create_time = String(Date.now());
  return raw;
}
const agents = new Set<TestClient>();
const closers = new Set<() => Promise<void>>();
async function bounded<T>(p: Promise<T>, label: string, ms = 12_000): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      p,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error(`timeout: ${label}`)), ms);
        timer.unref();
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}
async function until<T>(read: () => Promise<T>, accept: (value: T) => boolean, label: string, ms = 10_000): Promise<T> {
  const end = Date.now() + ms;
  do {
    const value = await read();
    if (accept(value)) return value;
    await new Promise<void>((r) => {
      const t = setTimeout(r, 20);
      t.unref();
    });
  } while (Date.now() < end);
  throw new Error(`timeout: ${label}`);
}
afterEach(async () => {
  for (const a of agents) a.sock.destroy();
  agents.clear();
  for (const close of closers) await close();
  closers.clear();
  for (const child of children) {
    const exited = new Promise<void>((done) => child.once("close", () => done()));
    child.kill("SIGKILL");
    await bounded(exited, "failed-start child cleanup");
  }
  children.clear();
  for (const home of homes) rmSync(home, { recursive: true, force: true });
  homes.clear();
}, 25_000);
function newHome() {
  const home = mkdtempSync(join(tmpdir(), "pwh-f10-"));
  homes.add(home);
  return home;
}
async function boot(options: { home?: string; enabled?: boolean; spawn?: boolean; lanSecurity?: boolean } = {}) {
  const home = options.home ?? newHome();
  const cwd = join(home, "project");
  mkdirSync(cwd, { recursive: true });
  let launcher: readonly [string, string] | undefined;
  if (options.spawn) {
    const pkg = join(home, "node_modules/@earendil-works/pi-coding-agent");
    mkdirSync(pkg, { recursive: true });
    writeFileSync(
      join(pkg, "package.json"),
      JSON.stringify({ name: "@earendil-works/pi-coding-agent", version: "1.2.0" }),
    );
    copyFileSync(resolve("tests/integration/fixtures/fake-rpc-pi.mjs"), join(pkg, "pi.mjs"));
    writeFileSync(join(cwd, ".fake-pi-switches"), "--cmd-echo\n");
    launcher = [process.execPath, join(pkg, "pi.mjs")];
  }
  const cfg = config({
    home,
    ...(launcher ? { launcher } : {}),
    ...(options.lanSecurity
      ? { lan: { port: await freeTcpPort(), extraHosts: [], trustProxyFrom: [], externalOrigins: [] } }
      : {}),
    ...(options.enabled === false
      ? {}
      : {
          feishuBot: {
            allowGroups: true,
            groupRootTopics: true,
            notify: "bound",
            ...(options.lanSecurity ? { securityAlerts: true } : {}),
            spawnScope: "known",
            debounceMs: 0,
            staleMessageS: 300,
            files: { outbound: "auto", inbound: true, maxInboundMiB: 30 },
          },
        }),
    ...(options.spawn
      ? {
          spawn: {
            roots: [],
            maxProcesses: 2,
            maxPerPrincipal: 2,
            ratePerMinute: 20,
            maxLifetimeMinutes: 10,
            registerTimeoutS: 10,
            lan: options.lanSecurity ? "known" : "off",
            restore: false,
            history: false,
          },
        }
      : {}),
  });
  const child = spawn(process.execPath, ["--import", "tsx", "--input-type=module", "-e", CHILD], {
    cwd: resolve("."),
    stdio: ["ignore", "ignore", "pipe", "ipc"],
    env: {
      ...process.env,
      HOME: home,
      XDG_RUNTIME_DIR: "",
      PI_CODING_AGENT_DIR: join(home, ".pi/agent"),
      F10_CONFIG: JSON.stringify(cfg),
    },
  });
  children.add(child);
  let stderr = "";
  child.stderr!.on("data", (b: Buffer) => {
    stderr += b.toString();
  });
  const exited = new Promise<void>((done) =>
    child.once("close", () => {
      children.delete(child);
      done();
    }),
  );
  let rid = 0;
  function rpc<T>(op: string, data: Record<string, unknown> = {}): Promise<T> {
    const id = ++rid;
    return bounded(
      new Promise<T>((res, rej) => {
        const onMessage = (m: any) => {
          if (m.id !== id) return;
          cleanup();
          m.error ? rej(new Error(m.error)) : res(m.value);
        };
        const onExit = () => {
          cleanup();
          rej(new Error(`fixture exited: ${stderr}`));
        };
        const cleanup = () => {
          child.off("message", onMessage);
          child.off("close", onExit);
        };
        child.on("message", onMessage);
        child.once("close", onExit);
        child.send({ id, op, ...data }, (e) => {
          if (e) {
            cleanup();
            rej(e);
          }
        });
      }),
      `child ${op}`,
    ).catch((e: unknown) => {
      throw new Error(`${String(e)}; stderr: ${stderr}`);
    });
  }
  const ready = await bounded(
    new Promise<{ port: number; caps: string[]; lanPort?: number }>((res, rej) => {
      child.on("message", (m: any) => {
        if (m.ready) res(m);
      });
      child.once("error", rej);
      child.once("close", () => rej(new Error(`startup: ${stderr}`)));
    }),
    "child ready",
    20_000,
  );
  let stopped = false;
  const stop = async () => {
    if (stopped) return;
    stopped = true;
    closers.delete(stop);
    try {
      if (child.connected) await rpc("stop");
      await bounded(exited, "hub exit", 12_000);
    } finally {
      if (children.has(child)) {
        child.kill("SIGKILL");
        await bounded(exited, "hub kill");
      }
    }
  };
  closers.add(stop);
  const crash = async () => {
    if (options.spawn) throw new Error("crash fixture is only for non-spawning hubs");
    stopped = true;
    closers.delete(stop);
    child.kill("SIGKILL");
    await bounded(exited, "hub crash");
  };
  const paths = resolveHubPaths({ home, uid: process.getuid?.() ?? 0, xdgRuntimeDir: undefined });
  const inspect = () => rpc<Inspection>("inspect");
  const sent = (needle: string) =>
    until(inspect, (s) => s.sent.some((m) => String(m.body.content).includes(needle)), `sent ${needle}`);
  if (options.enabled !== false) await until(inspect, (s) => s.livePeers === 1, "native Feishu websocket open");
  const disk = () => JSON.parse(readFileSync(join(paths.stateDir, "feishu-bot/state.json"), "utf8"));
  let id = 0;
  const send = (text: string, over: Parameters<typeof messageEnvelope>[2] = {}, messageId = `m-${++id}`) =>
    rpc("send", { raw: messageEnvelope(messageId, text, { ...over, createdAt: String(Date.now()) }) });
  async function agent(sessionId = "session-one", name = "One") {
    const c = await connectClient(paths.socketPath);
    agents.add(c);
    c.send(
      hello({
        agentId: { pid: process.pid, nonce: `f10-agent-${++rid}-AAAAAAAA` },
        cwd,
        caps: ["ev.v1", "cmd.v1", "dialog.v1", "upload.v1"],
      }),
    );
    const ack = await c.waitFrame((f) => f.t === "hello_ack");
    c.send({ t: "session", sessionId, cwd, name, reason: "startup", leafId: null, mode: "tui" });
    // Local admin round trip is a barrier for preceding session registration.
    c.send({ t: "fsb_req", rid: `barrier-${rid}`, op: "info" });
    await c.waitFrame((f) => f.t === "fsb_res" && f.rid === `barrier-${rid}`);
    let seq = 0;
    const event = (e: object) => c.send({ t: "ev", seq: ++seq, e });
    const command = () =>
      c.waitFrame((f) => f.t === "cmd" && !(f as any).queryOnly, 8_000) as unknown as Promise<CmdFrame>;
    const accept = (f: CmdFrame) =>
      c.send({ t: "cmd_result", rid: f.rid, id: f.id, ok: true, data: { op: "prompt", delivery: "observed" } });
    const finish = async (f: CmdFrame, text: string) => {
      if (f.cmd.op !== "prompt") throw new Error("expected prompt");
      accept(f);
      await until(
        async () => disk(),
        (s) => s.requests[f.id]?.reactionId !== undefined,
        "accepted + Typing persisted",
      );
      c.send({
        t: "ctl",
        epoch: "epoch-1",
        sessionId,
        items: [{ cmdId: f.id, op: "prompt", state: "consumed", at: Date.now(), updatedAt: Date.now() }],
      });
      event({ type: "message_start", message: { role: "user", content: [{ type: "text", text: f.cmd.text }] } });
      event({
        type: "message_end",
        message: { role: "assistant", content: [{ type: "text", text }], stopReason: "stop" },
      });
      event({ type: "agent_settled" });
    };
    return { c, ack, event, command, accept, finish };
  }
  async function bind(sessionId = "session-one", over: Parameters<typeof messageEnvelope>[2] = {}) {
    const before = (await inspect()).sent.length;
    await send(`/use ${sessionId}`, over);
    await until(inspect, (s) => s.sent.slice(before).some((m) => String(m.body.content).includes("已绑定")), "binding");
  }
  return { home, cwd, paths, ready, rpc, inspect, sent, disk, send, agent, bind, stop, crash };
}

// describe-level timeout includes child startup/shutdown and slow CI scheduling; every inner wait
// also has a deadline. No silent skip for missing tsx/dev deps or real hub startup errors.
describe("F10 Feishu bot — real hub child assembly", () => {
  it("LAN-P5: real child + SQLite + Feishu: each completed method inserts once, emits once, and a LAN spawn alerts once", async () => {
    const h = await boot({ lanSecurity: true, spawn: true });
    const a = await h.agent();
    expect(h.ready.caps).toEqual(expect.arrayContaining(["lan.2fa.v1", "lan.sessions.v1"]));
    await until(h.inspect, (s) => s.lan?.state === "on", "LAN listener ready");
    const port = h.ready.lanPort!;
    let rid = 0;
    const admin = async (type: "lan_req" | "tfa_req", op: Record<string, unknown>) => {
      const id = `lan-p5-${++rid}`;
      a.c.send({ t: type, rid: id, ...op });
      return a.c.waitFrame((f) => f.t === (type === "tfa_req" ? "tfa_res" : "lan_res") && f.rid === id);
    };
    const info = await admin("lan_req", { op: "info" });
    const credentials = info.info as { username: string; initialPassword: string };
    const loginBody = { username: credentials.username, password: credentials.initialPassword };
    const cookieOf = (r: Awaited<ReturnType<typeof lanPostJson>>) => r.headers["set-cookie"]![0]!.split(";")[0]!;
    const post = (ip: string, path: string, body: unknown, cookie?: string) =>
      lanPostJson(port, path, body, cookie === undefined ? {} : { Cookie: cookie }, ip);
    const get = (ip: string, path: string, cookie: string) =>
      lanRequest(port, { path, localAddress: ip, headers: { Cookie: cookie, "X-PWH": "1" } });
    const assertSuccess = async (
      ip: string,
      method: string,
      result: Awaited<ReturnType<typeof post>>,
      count: number,
      newIp: boolean,
    ) => {
      expect(result.status).toBe(200);
      const cookie = cookieOf(result);
      const sessions = await get(ip, "/api/lan/sessions", cookie);
      expect(sessions.status).toBe(200);
      const rows = JSON.parse(sessions.body).sessions;
      expect(rows).toHaveLength(count);
      expect(rows.filter((s: { current: boolean }) => s.current)).toMatchObject([{ method }]);
      const state = await until(
        h.inspect,
        (s) => (s.securityEvents ?? []).filter((e) => e.type === "login-success").length === count,
        `login event ${method}`,
      );
      expect((state.securityEvents ?? []).filter((e) => e.type === "login-success").at(-1)).toMatchObject({
        ip,
        method,
        newIp,
      });
      return cookie;
    };
    // Same-IP password success is still an event, but deliberately NOT a high-risk Feishu alert.
    await assertSuccess("127.0.0.2", "password", await post("127.0.0.2", "/api/login", loginBody), 1, true);
    await assertSuccess("127.0.0.2", "password", await post("127.0.0.2", "/api/login", loginBody), 2, false);
    const begin = await admin("tfa_req", { op: "totp_begin" });
    expect(begin.ok).toBe(true);
    const b32 = (begin.data as { secretB32: string }).secretB32;
    let bits = "";
    for (const ch of b32) bits += "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567".indexOf(ch).toString(2).padStart(5, "0");
    const secret = Uint8Array.from(bits.match(/.{8}/g) ?? [], (b) => parseInt(b, 2));
    const crypto = {
      hmacSha1: (key: Uint8Array, msg: Uint8Array) => createHmac("sha1", key).update(msg).digest(),
      timingSafeEqual,
    };
    const step = Math.floor(Date.now() / 30000);
    const confirm = (await admin("tfa_req", {
      op: "totp_confirm",
      code: totpCode(secret, step, crypto),
    })) as unknown as TfaResFrame;
    if (!confirm.ok || confirm.data.kind !== "totp_confirm") throw Error(JSON.stringify(confirm));
    const recovery = confirm.data.recoveryCodes[0]!;
    const status = await admin("tfa_req", { op: "status" });
    expect(status).toMatchObject({ ok: true, data: { knownIps: 0, state: "enrolled" } }); // Q15
    const t = await post("127.0.0.3", "/api/login", loginBody);
    expect(t.status).toBe(401);
    expect(JSON.parse(t.body)).toMatchObject({ error: "E_2FA" });
    await assertSuccess(
      "127.0.0.3",
      "totp",
      await post(
        "127.0.0.3",
        "/api/login/2fa",
        { method: "totp", code: totpCode(secret, step + 1, crypto) },
        cookieOf(t),
      ),
      3,
      true,
    );
    const r = await post("127.0.0.4", "/api/login", loginBody);
    expect(r.status).toBe(401);
    await assertSuccess(
      "127.0.0.4",
      "recovery",
      await post("127.0.0.4", "/api/login/2fa", { method: "recovery", code: recovery }, cookieOf(r)),
      4,
      true,
    );
    // Establish real tenant evidence before the real approval port issues callback nonces.
    await h.send("/list");
    await h.sent("One · sessio");
    expect(await admin("tfa_req", { op: "feishu", on: true })).toMatchObject({ ok: true });
    const f = await post("127.0.0.5", "/api/login", loginBody);
    expect(f.status).toBe(401);
    expect(JSON.parse(f.body)).toMatchObject({
      error: "E_2FA",
      feishu: "sent",
      methods: expect.arrayContaining(["feishu"]),
    });
    const disk = await until(
      async () => h.disk(),
      (s) => Object.values(s.nonces).some((n: any) => n.action === "login-approve"),
      "live approval nonce",
    );
    const n: any = Object.values(disk.nonces).find((n: any) => n.action === "login-approve");
    const waiting = get("127.0.0.5", "/api/login/2fa/wait", cookieOf(f));
    await h.rpc("send", { raw: callback(n.nonce, { id: "lan-p5-approve", chatId: n.chatId, messageId: n.messageId }) });
    const finalCookie = await assertSuccess("127.0.0.5", "feishu", await waiting, 5, true);
    const spawnBody = { id: "lan-p5-spawn-0001", cwd: h.cwd, confirm: true, expectCwd: h.cwd };
    const spawned = await post("127.0.0.5", "/api/headless", spawnBody, finalCookie);
    expect(spawned.status, spawned.body).toBe(202);
    expect((await post("127.0.0.5", "/api/headless", spawnBody, finalCookie)).status).toBe(202);
    const state = await until(
      h.inspect,
      (s) => (s.securityEvents ?? []).filter((e) => e.type === "lan-spawn").length === 1,
      "one spawn event",
    );
    expect((state.securityEvents ?? []).filter((e) => e.type === "lan-spawn")).toMatchObject([
      { mode: "new", ip: "127.0.0.5" },
    ]);
    for (const [ip, method] of [
      ["127.0.0.2", "密码"],
      ["127.0.0.3", "TOTP"],
      ["127.0.0.4", "恢复码"],
      ["127.0.0.5", "飞书审批"],
    ] as const) {
      const notice = await h.sent(`新 IP 登录：${ip}`);
      const notices = notice.sent.filter((m) => String(m.body.content).includes(`新 IP 登录：${ip}`));
      expect(notices).toHaveLength(1);
      expect(String(notices[0]!.body.content)).toContain(`方式 ${method}`);
    }
    const notice = await h.sent("检测到局域网会话");
    expect(notice.sent.filter((m) => String(m.body.content).includes("检测到局域网会话"))).toHaveLength(1);
    expect(readFileSync(h.paths.hubJson, "utf8")).not.toContain(b32);
    expect(readFileSync(h.paths.logFile, "utf8")).not.toContain(b32);
  }, 60000);

  it("FB1/FB2: /list → numeric /use → labelled token round trip and Typing cleanup", async () => {
    const h = await boot(),
      a = await h.agent();
    expect(a.ack.caps).toEqual(h.ready.caps);
    expect(h.ready.caps).toContain(FSB_HUB_CAP);
    await h.send("/list");
    await h.sent("One · sessio");
    await h.send("/use 1");
    await h.sent("已绑定");
    await h.send("write report");
    const f = await a.command();
    expect(f.cmd).toMatchObject({
      op: "prompt",
      text: expect.stringMatching(/^\[飞书 · .* · #[A-Za-z0-9_-]{12}\]\nwrite report$/),
    });
    await a.finish(f, "round-trip result");
    const state = await h.sent("round-trip result");
    expect(state.sent.filter((m) => String(m.body.content).includes("round-trip result"))).toHaveLength(1);
    expect(String(state.sent.at(-1)!.body.content)).toContain("One · sessio");
    await until(
      h.inspect,
      (s) => s.calls.some((c) => c.method === "DELETE" && c.path.includes("/reactions/")),
      "Typing removal",
    );
    expect((await h.inspect()).calls.filter((c) => c.method === "POST" && c.path.endsWith("/reactions"))).toEqual([
      expect.objectContaining({ json: { reaction_type: { emoji_type: "Typing" } } }),
    ]);
    await until(
      async () => h.disk(),
      (s) => s.requests[f.id]?.state === "replied",
      "durable replied",
    );
  }, 30_000);

  it("/help + unknown never dispatch; /cur + /unbind preserve explicit binding semantics", async () => {
    const h = await boot(),
      a = await h.agent();
    await h.send("/help");
    await h.sent("/file");
    await h.send("/not-a-command");
    await h.sent("未知命令 /not-a-command");
    await h.bind();
    await h.send("/cur");
    await h.sent("One · sessio");
    await h.send("/unbind");
    await h.sent("unbound");
    expect(a.c.frames.filter((f: any) => f.t === "cmd")).toEqual([]);
    expect(Object.values(h.disk().bindings)).toHaveLength(0);
  }, 30_000);

  it("FB3: two group topics bind different agents; replies stay in their own topic", async () => {
    const h = await boot(),
      a = await h.agent("session-one", "One"),
      b = await h.agent("session-two", "Two");
    const t1 = { chatType: "group" as const, threadId: "thread-one", mentions: true };
    const t2 = { chatType: "group" as const, threadId: "thread-two", mentions: true };
    await h.bind("session-one", t1);
    await h.bind("session-two", t2);
    await h.send("topic one task", t1, "topic-one-task");
    const fa = await a.command();
    await a.finish(fa, "TOPIC_ONE_RESULT");
    await h.send("topic two task", t2, "topic-two-task");
    const fb = await b.command();
    await b.finish(fb, "TOPIC_TWO_RESULT");
    const state = await h.sent("TOPIC_TWO_RESULT");
    for (const [marker, parent] of [
      ["TOPIC_ONE_RESULT", "topic-one-task"],
      ["TOPIC_TWO_RESULT", "topic-two-task"],
    ]) {
      const reply = state.calls.find((c) => c.method === "POST" && String(c.json?.content).includes(marker));
      expect(reply?.path).toBe(`/open-apis/im/v1/messages/${parent}/reply`);
      expect(reply?.json.reply_in_thread).toBe(true);
    }
    expect(fa.id).not.toBe(fb.id);
    expect(a.c.frames.filter((f: any) => f.t === "cmd")).toHaveLength(1);
    expect(b.c.frames.filter((f: any) => f.t === "cmd")).toHaveLength(1);
  }, 30_000);

  it("FB4: card answer/replay and web/TUI closed-race loser use the real dialog command route", async () => {
    const h = await boot(),
      a = await h.agent();
    await h.bind();
    const dialog = (dialogId: string) => ({
      dialogId,
      source: "ask_user",
      toolCallId: `tool-${dialogId}`,
      questions: [{ question: "Which?", options: [{ label: "Yes" }, { label: "No" }] }],
      allowCancel: true,
      openedAt: Date.now(),
    });
    const publish = (open: object[], closed: object[] = []) =>
      a.c.send({ t: "dialogs", epoch: "dialog-epoch", open, closed });
    publish([dialog("d1")]);
    const nonceFor = async (id: string) =>
      until(
        async () => h.disk(),
        (s) =>
          Object.values(s.nonces).some(
            (n: any) =>
              n.action === "dialog" &&
              JSON.parse(n.target).op === "option" &&
              JSON.parse(n.target).option === 0 &&
              s.dialogCards[JSON.parse(n.target).card]?.dialogId === id,
          ),
        `nonce ${id}`,
      );
    const first = await nonceFor("d1");
    const nonce: any = Object.values(first.nonces).find(
      (n: any) => n.action === "dialog" && JSON.parse(n.target).op === "option",
    );
    const cb = callback(nonce.nonce, { id: "card-answer", chatId: nonce.chatId, messageId: nonce.messageId });
    await h.rpc("send", { raw: cb });
    const f = await a.command();
    expect(f.cmd).toEqual({
      op: "dialog_answer",
      dialogId: "d1",
      epoch: "dialog-epoch",
      answers: [{ selected: ["Yes"], other: null }],
    });
    a.c.send({ t: "cmd_result", rid: f.rid, id: f.id, ok: true, data: { op: "dialog_answer" } });
    publish([], [{ dialogId: "d1", by: "web", outcome: "answered", at: Date.now() }]);
    await h.rpc("send", { raw: cb });
    publish([dialog("d2")]);
    const second = await nonceFor("d2");
    const loser: any = Object.values(second.nonces).find(
      (n: any) =>
        n.action === "dialog" &&
        JSON.parse(n.target).op === "option" &&
        second.dialogCards[JSON.parse(n.target).card]?.dialogId === "d2",
    );
    // Authoritative agent closure represents the competing web/TUI answer winning the race.
    publish([], [{ dialogId: "d2", by: "web", outcome: "answered", at: Date.now() }]);
    await until(
      async () => h.disk(),
      (s) => Object.values(s.dialogCards).some((c: any) => c.dialogId === "d2" && c.status === "answered"),
      "closed race",
    );
    await h.rpc("send", {
      raw: callback(loser.nonce, { id: "late-card", chatId: loser.chatId, messageId: loser.messageId }),
    });
    await until(h.inspect, (s) => s.acks >= 4, "callback receipts");
    expect(a.c.frames.filter((f: any) => f.t === "cmd" && f.cmd.op === "dialog_answer")).toHaveLength(1);
  }, 30_000);

  // ---- session-switch card (session-card-plan r3) ----
  const cardNonces = (s: any, action: string) =>
    Object.values(s.nonces as Record<string, any>).filter((n) => n.action === action);
  const pickNonceFor = async (h: any, sid: string) => {
    const s = await until(
      async () => h.disk(),
      (d: any) =>
        cardNonces(d, "session-pick").some((n: any) => {
          try {
            return JSON.parse(n.target).s === sid;
          } catch {
            return false;
          }
        }),
      `button nonce ${sid}`,
    );
    return cardNonces(s, "session-pick").find((n: any) => JSON.parse(n.target).s === sid);
  };
  const clickCard = async (h: any, sid: string, id: string, sender?: string) => {
    const n = await pickNonceFor(h, sid);
    await h.rpc("send", {
      raw: callback(n.nonce, { id, chatId: n.chatId, messageId: n.messageId, ...(sender ? { sender } : {}) }),
    });
    return n;
  };

  it("SW1: /list sends a reusable button card; A→B→A clicks switch the binding each time", async () => {
    const h = await boot(),
      a = await h.agent("session-one", "One"),
      b = await h.agent("session-two", "Two");
    expect(a.ack.caps).toContain(FSB_HUB_CAP);
    await h.send("/list");
    const first = await until(
      async () => h.disk(),
      (s: any) => cardNonces(s, "session-card").length === 1 && cardNonces(s, "session-pick").length === 2,
      "anchor + two button nonces durable",
    );
    const anchor = cardNonces(first, "session-card")[0];
    expect(JSON.parse(anchor.target)).toMatchObject({ k: "p2p:chat" }); // anchor never rendered, carries the key
    const aNonce = (await pickNonceFor(h, "session-one")).nonce;
    await clickCard(h, "session-one", "sw1-a");
    await h.sent("已绑定");
    await until(
      async () => h.disk(),
      (s: any) => s.bindings["p2p:chat"]?.sessionId === "session-one",
      "bound one",
    );
    await clickCard(h, "session-two", "sw1-b"); // successful click keeps the card open
    await until(
      async () => h.disk(),
      (s: any) => s.bindings["p2p:chat"]?.sessionId === "session-two",
      "bound two",
    );
    const reissued = await until(
      async () => h.disk(),
      (s: any) =>
        cardNonces(s, "session-pick").length === 2 && // exactly one re-issue per consumed button
        cardNonces(s, "session-pick").every((n: any) => n.nonce !== aNonce),
      "consumed nonce re-issued exactly once",
    );
    expect(cardNonces(reissued, "session-pick").map((n: any) => n.nonce)).not.toContain(aNonce);
    expect(anchor.expiresAt).toBe(cardNonces(reissued, "session-pick")[0].expiresAt); // absolute expiry shared
    await clickCard(h, "session-one", "sw1-a2"); // and the card is reusable for the way back
    await until(
      async () => h.disk(),
      (s: any) => s.bindings["p2p:chat"]?.sessionId === "session-one",
      "bound one again",
    );
    expect(b.c.frames.filter((f: any) => f.t === "cmd")).toEqual([]); // clicks never dispatch work
  }, 30_000);

  it("SW2: an authorized click on an offline target closes the card; a stranger's click changes nothing", async () => {
    const h = await boot(),
      a = await h.agent("session-one", "One"),
      b = await h.agent("session-two", "Two");
    await h.send("/list");
    await pickNonceFor(h, "session-two");
    const cookie = await login(h.ready.port, h.paths.tokenFile);
    b.c.send({ t: "bye", reason: "quit" });
    b.c.sock.destroy();
    // poll FRESH SSE snapshots (a new connection replays the current agents list): session-two not live
    await until(
      async () => {
        const sse = await openSse(h.ready.port, { cookie });
        try {
          const frame = await sse.waitFor((e) => e.event === "agents");
          const data: unknown = frame.data;
          const cards = Array.isArray(data) ? data : ((data as { agents?: unknown[] }).agents ?? []);
          return cards.some((c: any) => c?.session?.sessionId === "session-two" && c?.state === "live");
        } finally {
          sse.close();
        }
      },
      (stillLive) => !stillLive,
      "session-two offline",
    );
    const before = (await h.inspect()).sent.length;
    await clickCard(h, "session-two", "sw2-off");
    await h.sent("已关闭"); // the failure gate closes the whole card
    await until(
      async () => h.disk(),
      (s: any) => cardNonces(s, "session-card").length === 0 && cardNonces(s, "session-pick").length === 0,
      "card nonces purged",
    );
    expect(h.disk().bindings["p2p:chat"]).toBeUndefined();
    // a non-operator click (no nonce consume possible) triggers neither gate nor binding
    await h.send("/list");
    const strangerNonce = await pickNonceFor(h, "session-one");
    const acksBefore = (await h.inspect()).acks;
    await h.rpc("send", {
      raw: callback(strangerNonce.nonce, {
        id: "sw2-stranger",
        sender: "ou_stranger",
        chatId: strangerNonce.chatId,
        messageId: strangerNonce.messageId,
      }),
    });
    await until(h.inspect, (s) => s.acks > acksBefore, "stranger callback ACKed");
    const after = (await h.inspect()).sent.slice(before).map((m) => String(m.body.content));
    expect(after.filter((c) => c.includes("已关闭"))).toHaveLength(1); // only the gate's own close notice
    expect(h.disk().bindings["p2p:chat"]).toBeUndefined();
    expect(a.c.frames.filter((f: any) => f.t === "cmd")).toEqual([]);
  }, 30_000);

  it("SW3: two rapid /list supersede — every old nonce is purged, only the newest card is live", async () => {
    const h = await boot();
    await h.agent("session-one", "One");
    await h.send("/list");
    const first = await pickNonceFor(h, "session-one");
    await h.send("/list");
    const latest = await until(
      async () => h.disk(),
      (s: any) => {
        const picks = cardNonces(s, "session-pick");
        return picks.length === 1 && picks[0].nonce !== first.nonce && cardNonces(s, "session-card").length === 1;
      },
      "superseded: single anchor + fresh button nonce",
    );
    // the stale nonce is unknown now — clicking it is a silent no-op
    await h.rpc("send", {
      raw: callback(first.nonce, { id: "sw3-stale", chatId: first.chatId, messageId: first.messageId }),
    });
    await until(h.inspect, (s) => s.acks >= 3, "stale click ACKed");
    expect(h.disk().bindings["p2p:chat"]).toBeUndefined();
    const live = cardNonces(latest, "session-pick")[0];
    await h.rpc("send", {
      raw: callback(live.nonce, { id: "sw3-live", chatId: live.chatId, messageId: live.messageId }),
    });
    await until(
      async () => h.disk(),
      (s: any) => s.bindings["p2p:chat"]?.sessionId === "session-one",
      "new card works",
    );
  }, 30_000);

  it("SW4: after a hub restart an old card still switches (single-button card too); group topics stay independent", async () => {
    const h = await boot();
    await h.agent("session-one", "One"); // exactly one online session ⇒ single-button card
    await h.send("/list");
    const nonce = await pickNonceFor(h, "session-one");
    await until(
      async () => h.disk(),
      (s: any) => cardNonces(s, "session-card").length === 1,
      "anchor durable before crash",
    );
    await h.crash();
    const r = await boot({ home: h.home });
    await r.agent("session-one", "One");
    // boot adoption rebuilt the controller BEFORE the connector started: the old card accepts clicks
    await r.rpc("send", {
      raw: callback(nonce.nonce, { id: "sw4-old", chatId: nonce.chatId, messageId: nonce.messageId }),
    });
    await until(
      async () => r.disk(),
      (s: any) => s.bindings["p2p:chat"]?.sessionId === "session-one",
      "old card binds",
    );
    await r.sent("已绑定");
    // group topics are independent cards/bindings, and an unbound topic binds on first click
    const topic = (threadId: string) => ({ chatType: "group" as const, threadId, mentions: true });
    // explicit message id: the rebooted harness counter restarts and would hit the persisted dedup table
    await r.send("/list", topic("thread-a"), "sw4-topic-list");
    const topicNonce = await until(
      async () => r.disk(),
      (s: any) =>
        cardNonces(s, "session-pick").some((n: any) => {
          try {
            return JSON.parse(n.target).k === "grp:chat:thread-a";
          } catch {
            return false;
          }
        }),
      "topic card nonce",
    ).then((s: any) => cardNonces(s, "session-pick").find((n: any) => JSON.parse(n.target).k === "grp:chat:thread-a"));
    await r.rpc("send", {
      raw: callback(topicNonce.nonce, { id: "sw4-topic", chatId: topicNonce.chatId, messageId: topicNonce.messageId }),
    });
    await until(
      async () => r.disk(),
      (s: any) =>
        s.bindings["grp:chat:thread-a"]?.sessionId === "session-one" &&
        s.bindings["grp:chat:thread-a"]?.threadId === "thread-a",
      "topic bound on first click",
    );
    expect(r.disk().bindings["p2p:chat"].sessionId).toBe("session-one"); // p2p binding untouched
  }, 40_000);

  it("FB5/FB6: inbound image bytes reach shared uploads; attributed cwd image auto-sends, file button re-admits", async () => {
    const h = await boot(),
      a = await h.agent();
    await h.bind();
    const png = Buffer.from(
      "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+afo0AAAAASUVORK5CYII=",
      "base64",
    );
    await h.rpc("resource", { key: "in-image", bytes: [...png], contentType: "image/png" });
    const raw = messageEnvelope("in-image", "", { createdAt: String(Date.now()) });
    raw.event.message.message_type = "image";
    raw.event.message.content = JSON.stringify({ image_key: "in-image" });
    await h.rpc("send", { raw });
    const f = await a.command();
    if (f.cmd.op !== "prompt") throw new Error("expected image prompt");
    expect(f.cmd.text).toContain("[web-hub attachments]");
    const request = h.disk().requests[f.id];
    expect(request.payload.uploadIds).toHaveLength(1);
    // The dispatched attachment block contains the actual UploadStore path, not a fake upload port.
    const attachment = parseAttachmentBlock(f.cmd.text)?.[0];
    expect(attachment).toBeDefined();
    expect(attachment!.path).toContain(join(h.home, ".pi/agent/web-hub/uploads"));
    expect(readFileSync(attachment!.path)).toEqual(png);
    const image = join(h.cwd, "result.png"),
      file = join(h.cwd, "result.txt");
    writeFileSync(image, png);
    writeFileSync(file, "outbound file bytes");
    await a.finish(f, `image \`${image}\` and file \`${file}\``);
    await until(h.inspect, (s) => s.sent.some((m) => m.body.msg_type === "image"), "auto image");
    const disk = await until(
      async () => h.disk(),
      (s) => Object.values(s.nonces).some((n: any) => n.action === "file"),
      "file button",
    );
    const n: any = Object.values(disk.nonces).find((n: any) => n.action === "file");
    await h.rpc("send", { raw: callback(n.nonce, { id: "file-button", chatId: n.chatId, messageId: n.messageId }) });
    const sent = await until(h.inspect, (s) => s.sent.some((m) => m.body.msg_type === "file"), "button file");
    expect(sent.calls.find((c) => c.path === "/open-apis/im/v1/files")?.form.file.size).toBe(
      Buffer.byteLength("outbound file bytes"),
    );
    expect(sent.calls.find((c) => c.path === "/open-apis/im/v1/images")?.form.file.size).toBe(png.length);
  }, 30_000);

  it("FB5c: post rich text keeps its text and media file; derived mime reaches the attachment block", async () => {
    const h = await boot(),
      a = await h.agent();
    await h.bind();
    const md = Buffer.from("# notes\nhello post");
    await h.rpc("resource", { key: "in-post-file", bytes: [...md], contentType: "application/octet-stream" });
    await h.rpc("resource", { key: "in-post-cover", bytes: [...md], contentType: "image/png" });
    const raw = messageEnvelope("in-post", "", { createdAt: String(Date.now()) });
    raw.event.message.message_type = "post";
    raw.event.message.content = JSON.stringify({
      zh_cn: {
        title: "",
        content: [
          [
            { tag: "text", text: "看附件 " },
            { tag: "a", text: "链接", href: "https://example.com/x" },
          ],
          [{ tag: "media", file_key: "in-post-file", image_key: "in-post-cover", file_name: "notes.md" }],
        ],
      },
    });
    await h.rpc("send", { raw });
    const f = await a.command();
    if (f.cmd.op !== "prompt") throw new Error("expected post prompt");
    expect(f.cmd.text).toContain("看附件 链接 (https://example.com/x)");
    expect(f.cmd.text).toContain("[web-hub attachments]");
    const attachment = parseAttachmentBlock(f.cmd.text)?.[0];
    expect(attachment).toBeDefined();
    expect(attachment!.mime).toBe("text/markdown");
    expect(readFileSync(attachment!.path)).toEqual(md);
    // The media cover thumbnail is never downloaded; only the file resource is fetched.
    const downloads = (await h.inspect()).calls.filter((c) => c.path.includes("/resources/"));
    expect(downloads.map((c) => c.path)).toEqual([expect.stringContaining("/resources/in-post-file")]);
    const request = h.disk().requests[f.id];
    expect(request.payload.uploadIds).toHaveLength(1);
    await a.finish(f, "post round trip done");
    await h.sent("post round trip done");
  }, 30_000);

  it("FB7/FB8: real WS drop redelivery dedups; restart never redispatches accepted work or snapshot-backfills", async () => {
    const h = await boot(),
      a = await h.agent();
    await h.bind();
    const raw = messageEnvelope("restart-work", "once only", { createdAt: String(Date.now()) });
    await h.rpc("send", { raw });
    const f = await a.command();
    a.accept(f);
    await until(
      async () => h.disk(),
      (s) => s.requests[f.id]?.state === "accepted",
      "accepted persisted",
    );
    await h.rpc("drop");
    await until(h.inspect, (s) => s.peers >= 2 && s.livePeers === 1, "WS reconnect");
    await h.rpc("send", { raw });
    await until(h.inspect, (s) => s.acks >= 3, "redelivery ACK");
    expect(a.c.frames.filter((v: any) => v.t === "cmd" && !v.queryOnly)).toHaveLength(1);
    expect(Object.keys(h.disk().requests)).toEqual([f.id]);
    await h.crash();
    const restarted = await boot({ home: h.home }),
      b = await restarted.agent();
    await restarted.sent("结果无法确认归属");
    await restarted.rpc("send", { raw });
    await until(restarted.inspect, (s) => s.acks >= 1, "boot dedup ACK");
    expect(b.c.frames.filter((v: any) => v.t === "cmd" && !v.queryOnly)).toEqual([]);
    expect(restarted.disk().requests[f.id].state).toBe("unattributed");
    expect((await restarted.inspect()).sent.some((m) => String(m.body.content).includes("once only"))).toBe(false);
  }, 40_000);

  it("FB11: post-restart redelivery noise — stale/unsupported never page the owner, decode failures debounce", async () => {
    const h = await boot();
    await h.agent();
    await h.crash();
    const r = await boot({ home: h.home });
    await r.agent();
    // Feishu redelivers downtime traffic: a stale owner message, an event type we never
    // subscribed to, and two copies of a malformed subscribed (real decode failure) event.
    await r.rpc("send", { raw: messageEnvelope("stale-1", "old", { createdAt: String(Date.now() - 301_000) }) });
    const unknown: any = messageEnvelope("unknown-1", "ignored", { createdAt: String(Date.now()) });
    unknown.header.event_type = "im.chat.disbanded_v1";
    unknown.event = { chat_id: "oc_chat" };
    await r.rpc("send", { raw: unknown });
    const bad = (id: string) => ({
      schema: "2.0",
      header: { event_id: id, event_type: "im.message.receive_v1", app_id: "cli_test", tenant_key: "tenant" },
      event: {},
    });
    await r.rpc("send", { raw: bad("bad-1") });
    await r.rpc("send", { raw: bad("bad-2") });
    await until(r.inspect, (s) => s.acks >= 4, "all noise ACKed");
    await until(
      r.inspect,
      (s) => s.sent.some((m) => String(m.body.content).includes("undecodable:message-invalid")),
      "owner page for the real decode failure",
    );
    await new Promise((resolve) => setTimeout(resolve, 300));
    const contents = (await r.inspect()).sent.map((m) => String(m.body.content));
    // Exactly one owner page (the second bad copy is debounced); stale/unsupported never page.
    expect(contents.filter((c) => c.includes("飞书机器人状态"))).toHaveLength(1);
    expect(contents.some((c) => c.includes("stale"))).toBe(false);
  }, 40_000);

  it("FB9: /new known directory forks real fake-pi, binds live session once; duplicate never forks twice", async () => {
    const h = await boot({ spawn: true });
    await h.agent();
    await h.send(`/new ${h.cwd}`, {}, "new-request");
    const disk = await until(
      async () => h.disk(),
      (s) => Object.values(s.bindings).some((b: any) => b.sessionId.startsWith("sess-fake-")),
      "new live binding",
      15_000,
    );
    const binding: any = Object.values(disk.bindings)[0];
    expect(binding.sessionId).toMatch(/^sess-fake-/);
    await h.send(`/new ${h.cwd}`, {}, "new-request");
    await until(h.inspect, (s) => s.acks >= 2, "new duplicate ACK");
    const argv = readFileSync(join(h.cwd, ".fake-pi-argv.log"), "utf8").trim().split("\n");
    expect(argv).toHaveLength(1);
    expect(JSON.parse(argv[0]!).argv).toContain("--mode");
    await h.send("/cur");
    await h.sent("sess-f");
  }, 40_000);

  it("off: same legacy caps/HTTP, no bot files or traffic, unavailable admin is explicit", async () => {
    const h = await boot({ enabled: false }),
      a = await h.agent();
    // Frozen pre-bot cap bytes/order for this feature-off config, not merely !includes(fsb).
    expect(JSON.stringify(h.ready.caps)).toBe(
      JSON.stringify([
        "ctl.v1",
        "cmd.v1",
        "dialog.v1",
        "command.v1",
        "ctl.v2",
        "upload.v1",
        "dialog.bg.v1",
        "hold.v1",
        "runtx.v1",
        "quota.pools.v1",
        "todo.archive.v1",
        "version.v1",
      ]),
    );
    expect(a.ack.caps).toEqual(h.ready.caps);
    a.c.send({ t: "fsb_req", rid: "off-info", op: "info" });
    expect(await a.c.waitFrame((f) => f.t === "fsb_res" && f.rid === "off-info")).toMatchObject({
      ok: false,
      code: "E_FSB_STATE",
    });
    expect(await h.inspect()).toEqual({ sent: [], calls: [], peers: 0, livePeers: 0, acks: 0 });
    expect(existsSync(join(h.paths.stateDir, "feishu-bot"))).toBe(false);
    const cookie = await login(h.ready.port, h.paths.tokenFile);
    const sse = await openSse(h.ready.port, { cookie });
    try {
      expect(sse.status).toBe(200);
      const hubFrame = await sse.waitFor((e) => e.event === "hub");
      expect((hubFrame.data as { caps: string[] }).caps).toEqual(h.ready.caps);
      const snapshot = await sse.waitFor((e) => e.event === "agents");
      expect(JSON.stringify(snapshot.data)).toContain("session-one");
      expect(JSON.stringify(sse.events)).not.toContain("fsb.v1");
      expect(JSON.stringify(sse.events)).not.toContain("feishuBot");
    } finally {
      sse.close();
    }
  }, 30_000);
});
