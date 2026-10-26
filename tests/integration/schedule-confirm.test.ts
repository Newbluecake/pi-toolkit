/* eslint-disable @typescript-eslint/no-explicit-any */
import { spawn, type ChildProcess } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { systemClock } from "../../src/core/clock.js";
import { createScheduleHubRouter } from "../../src/schedule/agent/coordinator.js";
import { createScheduleAgent, type ScheduleAgent } from "../../src/schedule/agent/wire.js";
import { wireScheduleSurface } from "../../src/schedule/agent/surface.js";
import type { OpsPorts } from "../../src/schedule/agent/ops.js";
import { approveTask } from "../../src/schedule/core/claim.js";
import { sessionDirName } from "../../src/schedule/core/paths.js";
import { defHash, isApproved } from "../../src/schedule/core/spec.js";
import { removeTask } from "../../src/schedule/core/writer.js";
import { createScheduleCommand } from "../../src/commands/schedule.js";
import { createScheduleTool } from "../../src/tools/schedule-tool.js";
import { resolveHubPaths } from "../../src/web-hub/protocol/paths.js";
import { SCHED_API_PATH, SCHED_CONFIRM_CAP, SCHED_HUB_CAP } from "../../src/web-hub/protocol/schedule.js";
import { callbackEnvelope, messageEnvelope } from "../fixtures/feishu/f6.js";
import { env as coreEnv, self, type Env } from "../schedule/core/fixtures.js";
import { config, connectClient, hello, type TestClient } from "../web-hub/hub/helpers.js";
import { login, rawRequest } from "../web-hub/http/helpers.js";

/**
 * #61 I2 — the whole "confirm the AI's scheduled task on the spot" chain, end to end:
 *
 *   REAL hub child process (H2 schedule service, F2 Feishu cards, real nonce state, real HTTP frontend)
 *   × REAL agent-side stack (S1 ledger, A0 agent + hub coordinator, C1 confirm module + TUI presenter, the real
 *     `schedule` tool and `/schedule` command, C2 offers/decide link over the hub's real unix socket)
 *   × fake Feishu (HTTP + pbbp2 websocket fakes) × fake pi / fake TUI (`ui.select`, notifications).
 *
 * Three channels (TUI select, web panel, Feishu owner card) race for one decision; the ledger CAS is the only
 * referee. Every scenario ends by asserting the LEDGER (exactly one effect) and what each losing channel sees.
 */
const CHILD = String.raw`
const root = process.cwd();
const load = (p) => import(root + "/" + p);
const { startHub } = await load("src/web-hub/hub/hub.ts");
const { createHttpFrontend } = await load("src/web-hub/hub/http.ts");
const { createCredentialStore } = await load("src/web-hub/hub/feishu/credentials.ts");
const { resolveHubPaths } = await load("src/web-hub/protocol/paths.ts");
const { normalizeFeishuBotHubConfig } = await load("src/web-hub/protocol/feishu.ts");
const { encodeFrame } = await load("src/web-hub/hub/feishu/frame.ts");
const { createFakeFeishu } = await load("tests/fixtures/feishu/fake-http.ts");
const { createFakeWsServer } = await load("tests/fixtures/feishu/fake-ws-server.ts");
const cfg = JSON.parse(process.env.CONFIRM_CONFIG);
const paths = resolveHubPaths({home: cfg.home, uid: process.getuid?.() ?? 0});
const fake = createFakeFeishu({appId: "cli_test"});
fake.on("POST", "/callback/ws/endpoint", () => ({json: {code: 0, data: {
  URL: "wss://msg-frontier.feishu.cn/ws?service_id=33&device_id=confirm-device", ClientConfig: {
    PingInterval: 90, ReconnectCount: -1, ReconnectInterval: 1, ReconnectNonce: 0
  }
}}}));
const ws = await createFakeWsServer();
cfg.feishuBot = normalizeFeishuBotHubConfig(cfg.feishuBot);
const store = createCredentialStore({dir: paths.stateDir + "/feishu-bot"});
await store.load();
const saved = await store.commit({brand: "feishu", appId: fake.appId, appSecret: fake.appSecret, ownerOpenId: "ou_owner", botOpenId: "ou_bot"});
if (!saved.ok) throw new Error("fixture credentials: " + saved.reason);
const hub = await startHub(cfg, (deps) => createHttpFrontend(deps), {feishuSeams: {
  fetch: fake.fetch,
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
      reply(m.id, {sent: fake.sent, calls: fake.calls.map(({signal, ...c}) => c),
        livePeers: ws.peers.filter(p => !p.closed).length, caps: hub.info.caps});
    } else if (m.op === "stop") {
      await hub.close("test"); await ws.dispose(); reply(m.id, true); process.disconnect();
    } else throw new Error("unknown fixture op");
  } catch (e) { process.send?.({id: m.id, error: String(e)}); }
});
process.send?.({ready: true, port: hub.httpPort, caps: hub.info.caps});
`;

interface Inspection {
  sent: Array<{ messageId: string; kind: string; body: Record<string, any> }>;
  calls: Array<{ method: string; path: string; json?: any }>;
  livePeers: number;
  caps: string[];
}

const closers = new Set<() => Promise<void> | void>();
const dirs = new Set<string>();
const envs: Env[] = [];
afterEach(async () => {
  for (const c of [...closers].reverse()) await Promise.resolve(c()).catch(() => undefined);
  closers.clear();
  for (const e of envs.splice(0)) e.cleanup();
  for (const d of dirs) rmSync(d, { recursive: true, force: true });
  dirs.clear();
}, 40_000);

async function until<T>(read: () => Promise<T> | T, ok: (v: T) => boolean, label: string, ms = 15_000): Promise<T> {
  const end = Date.now() + ms;
  for (;;) {
    const v = await read();
    if (ok(v)) return v;
    if (Date.now() > end) throw new Error(`timeout: ${label}`);
    await new Promise((r) => setTimeout(r, 40));
  }
}
const quiet = (ms = 600) => new Promise<void>((r) => setTimeout(r, ms));

// ---------------------------------------------------------------------------------------------- hub fixture

async function bootHub(storeDir: string | undefined) {
  const home = mkdtempSync(join(tmpdir(), "pwh-confirm-i2-"));
  dirs.add(home);
  mkdirSync(join(home, "project"), { recursive: true });
  const cfg = config({
    home,
    ...(storeDir === undefined ? {} : { schedule: { dir: storeDir, toleranceS: 60 } }),
    feishuBot: {
      allowGroups: true,
      groupRootTopics: false,
      notify: "bound",
      spawnScope: "known",
      debounceMs: 0,
      staleMessageS: 300,
      files: { outbound: "auto", inbound: false, maxInboundMiB: 30 },
    },
  } as never);
  const child: ChildProcess = spawn(process.execPath, ["--import", "tsx", "--input-type=module", "-e", CHILD], {
    cwd: resolve("."),
    stdio: ["ignore", "ignore", "pipe", "ipc"],
    env: {
      ...process.env,
      HOME: home,
      XDG_RUNTIME_DIR: "",
      PI_CODING_AGENT_DIR: join(home, ".pi/agent"),
      CONFIRM_CONFIG: JSON.stringify(cfg),
    },
  });
  let stderr = "";
  child.stderr!.on("data", (b: Buffer) => (stderr += b.toString()));
  const exited = new Promise<void>((done) => child.once("close", () => done()));
  let rid = 0;
  const rpc = <T>(op: string, data: Record<string, unknown> = {}): Promise<T> =>
    new Promise<T>((res, rej) => {
      const id = ++rid;
      const onMsg = (m: any) => {
        if (m.id !== id) return;
        child.off("message", onMsg);
        m.error ? rej(new Error(`${m.error}; stderr: ${stderr}`)) : res(m.value);
      };
      child.on("message", onMsg);
      child.send({ id, op, ...data }, (e) => e && rej(e));
    });
  const ready = await new Promise<{ port: number; caps: string[] }>((res, rej) => {
    child.on("message", (m: any) => m.ready && res(m));
    child.once("close", () => rej(new Error(`hub startup failed: ${stderr}`)));
  });
  const stop = async (): Promise<void> => {
    closers.delete(stop);
    try {
      if (child.connected) await rpc("stop");
      await Promise.race([exited, new Promise((r) => setTimeout(r, 10_000))]);
    } finally {
      child.kill("SIGKILL");
    }
  };
  closers.add(stop);
  const paths = resolveHubPaths({ home, uid: process.getuid?.() ?? 0, xdgRuntimeDir: undefined });
  const inspect = () => rpc<Inspection>("inspect");
  await until(inspect, (s) => s.livePeers === 1, "feishu websocket open");
  let mid = 0;
  const send = (text: string, over: Parameters<typeof messageEnvelope>[2] = {}, messageId = `cm-${++mid}`) => {
    const raw = messageEnvelope(messageId, text, { ...over, createdAt: String(Date.now()) });
    return rpc("send", { raw });
  };
  const disk = () => JSON.parse(readFileSync(join(paths.stateDir, "feishu-bot/state.json"), "utf8"));
  let cookie: string | undefined;
  const web = async (sessionId: string): Promise<any[]> => {
    cookie ??= await login(ready.port, paths.tokenFile);
    const r = await rawRequest(ready.port, {
      path: `${SCHED_API_PATH}?sessionId=${sessionId}`,
      headers: { Cookie: cookie, "X-PWH": "1" },
    });
    if (r.status !== 200) throw new Error(`GET /api/schedules → ${r.status}`);
    const payload = JSON.parse(r.body) as { sessions: Array<{ sessionId: string; tasks: any[] }> };
    return payload.sessions.find((s) => s.sessionId === sessionId)?.tasks ?? [];
  };
  const webStatus = async (): Promise<number> => {
    cookie ??= await login(ready.port, paths.tokenFile);
    return (await rawRequest(ready.port, { path: SCHED_API_PATH, headers: { Cookie: cookie, "X-PWH": "1" } })).status;
  };
  return { home, paths, ready, rpc, inspect, send, disk, web, webStatus, stop, stderr: () => stderr };
}
type Hub = Awaited<ReturnType<typeof bootHub>>;

// ---------------------------------------------------------------------------------------------- agent fixture

const SID = "019a3333-aaaa-7bbb-8ccc-dddddddddddd";
let agentSeq = 0;

type Handler = (event: any, ctx: any) => any;

/** One agent process's schedule stack, linked to the hub's real unix socket (a "session start"). */
async function agentStack(h: Hub, E: Env, o: { idle?: boolean; withRouter?: boolean } = {}) {
  const handlers = new Map<string, Handler[]>();
  const piSent: any[] = [];
  const pi = {
    on: (e: string, fn: Handler) => void handlers.set(e, [...(handlers.get(e) ?? []), fn]),
    sendMessage: (m: unknown) => void piSent.push(m),
  };
  const ui = {
    idle: o.idle ?? true,
    selects: [] as Array<{ title: string; options: string[]; argc: number; resolve: (v: string | undefined) => void }>,
    notes: [] as Array<{ text: string; level?: string }>,
  };
  const ctx = {
    mode: "tui",
    hasUI: true,
    cwd: E.dir,
    isIdle: () => ui.idle,
    sessionManager: {
      getSessionId: () => SID,
      getSessionFile: () => join(E.dir, "a.jsonl"),
      getEntries: () => [],
    },
    modelRegistry: { find: () => undefined },
    ui: {
      setStatus: () => undefined,
      select: (...args: [string, string[]]) =>
        new Promise<string | undefined>((resolve) =>
          ui.selects.push({ title: args[0], options: args[1], argc: args.length, resolve }),
        ),
      notify: (text: string, level?: string) => void ui.notes.push({ text, ...(level ? { level } : {}) }),
    },
  };
  const emit = async (event: string): Promise<void> => {
    for (const fn of handlers.get(event) ?? []) await fn({ type: event }, ctx);
  };

  const router =
    o.withRouter === false
      ? undefined
      : createScheduleHubRouter({ hubConfig: () => ({ dir: E.root.real, toleranceS: 60 }) });
  let agentRef: ScheduleAgent | undefined;
  const surface = wireScheduleSurface(pi as never, {
    settings: { defaultTimeoutMs: 1_800_000, maxTimeoutMs: 14_400_000 },
    types: { get: () => ({}) as never, list: () => [] },
    current: () => agentRef,
  });
  const agent = createScheduleAgent({
    ctx: ctx as never,
    mode: { kind: "interactive", arm: true },
    sessionId: SID,
    self: self(),
    dir: E.storeDir,
    plain: true,
    inVault: () => false,
    clock: systemClock,
    warn: () => undefined,
    ...(router ? { router } : {}),
    confirm: () => surface.confirm(),
    storeOpts: { lockTimeoutMs: 2_000 },
  } as never);
  agentRef = agent;
  const ports: OpsPorts = {
    agent,
    now: () => Date.now(),
    limits: { defaultTimeoutS: 1800, maxTimeoutS: 14_400 },
    agentTypes: { has: () => true },
    capability: () => "verified",
    ownerCwd: () => E.dir,
    defaultTz: () => "UTC",
  };
  await surface.start(ctx as never, agent);

  // ---- link to the real hub
  let client: TestClient | undefined;
  const hubFrames: Array<Record<string, any>> = [];
  const decides: Array<Record<string, any>> = [];
  if (router) {
    client = await connectClient(h.paths.socketPath);
    client.send(
      hello({
        agentId: { pid: 4242, nonce: `nonce-confirm-${++agentSeq}-0123456789` },
        cwd: E.dir,
        caps: ["ev.v1", "cmd.v1", "dialog.v1", "upload.v1", SCHED_HUB_CAP, SCHED_CONFIRM_CAP],
      }),
    );
    const ack = (await client.waitFrame((f) => f.t === "hello_ack")) as { caps?: string[] };
    const hubCaps = ack.caps ?? [];
    client.send({
      t: "session",
      sessionId: SID,
      cwd: E.dir,
      name: "日报会话",
      reason: "startup",
      leafId: null,
      mode: "tui",
    });
    const live = () => client !== undefined && !client.sock.destroyed;
    router.bindLink({
      ready: () => live() && hubCaps.includes(SCHED_HUB_CAP),
      confirmReady: () => live() && hubCaps.includes(SCHED_HUB_CAP) && hubCaps.includes(SCHED_CONFIRM_CAP),
      send: (f) => {
        if (live()) client!.send(f as never);
      },
    });
    const c = client;
    const seen = new Set<unknown>();
    const poll = setInterval(() => {
      for (const f of c.frames as Array<Record<string, any>>) {
        if (seen.has(f)) continue;
        seen.add(f);
        hubFrames.push(f);
        if (f.t === "sched_receipts") router.onSchedReceipts(f as never);
        else if (f.t === "sched_run") router.onSchedRun(f as never);
        else if (f.t === "sched_decide") {
          decides.push(f);
          router.onSchedDecide(f as never);
        } else if (f.t === "cmd")
          c.send({ t: "cmd_result", rid: f.rid, id: f.id, ok: true, data: { op: "prompt", delivery: "observed" } });
      }
    }, 20);
    poll.unref();
    closers.add(() => void clearInterval(poll));
    router.onHubCaps(); // what wireWebHub does on hello_ack
  }

  // ---- the user-facing entry points, wired exactly like src/index.ts does
  const tool = createScheduleTool({ agent: () => agent, ports: () => ports, confirm: () => surface.confirm() });
  const callTool = async (params: Record<string, unknown>) => {
    const r = await tool.execute("id", params as never, undefined, undefined, {} as never);
    return { text: (r.content[0] as { text: string }).text, details: r.details as Record<string, any> };
  };
  const cmd = createScheduleCommand({
    enabled: () => true,
    agent: () => agent,
    ports: () => ports,
    confirm: () => surface.confirm(),
    inVault: () => false,
  });
  /** `/schedule …` as the web UI runs it (a web-claimed invocation). */
  const webCommand = async (args: string): Promise<string> => {
    const out: string[] = [];
    await cmd.handler(args, {
      webInvocation: true,
      ui: { notify: (m: string) => out.push(m), confirm: async () => true, input: async () => undefined },
    } as never);
    return out.join("\n");
  };
  const ledger = () =>
    JSON.parse(readFileSync(join(E.storeDir, sessionDirName(SID), "state.json"), "utf8")) as { tasks: any[] };
  const task = (id: string) => ledger().tasks.find((t) => t.id === id);
  let disposed = false;
  const dispose = () => {
    if (disposed) return;
    disposed = true;
    surface.shutdown();
    agent.dispose();
    client?.sock.destroy();
  };
  closers.add(dispose);
  return {
    agent,
    surface,
    ui,
    piSent,
    callTool,
    webCommand,
    ledger,
    task,
    emit,
    client,
    hubFrames,
    decides,
    dispose,
    notices: () => piSent.filter((m) => m?.details?.kind === "confirm"),
    /** the agent goes away WITHOUT saying goodbye (crash / kill -9): no `withdrawn` frame ever reaches the hub. */
    crash: () => {
      client?.sock.destroy();
      dispose();
    },
  };
}
type Stack = Awaited<ReturnType<typeof agentStack>>;

// ---------------------------------------------------------------------------------------------- feishu helpers

const callback = (nonce: string, o: Parameters<typeof callbackEnvelope>[1]) => {
  const raw = callbackEnvelope(nonce, o);
  raw.header.create_time = String(Date.now());
  return raw;
};

/** Bind the owner's p2p chat to the session AND let the owner make one request (the hub's owner proof). */
async function bindOwner(h: Hub, a: Stack): Promise<void> {
  const before = (await h.inspect()).sent.length;
  await h.send(`/use ${SID}`);
  await until(h.inspect, (s) => s.sent.slice(before).some((m) => String(m.body.content).includes("已绑定")), "bound");
  await h.send("你好");
  await until(
    () => a.hubFrames.filter((f) => f.t === "cmd").length,
    (n) => n >= 1,
    "owner request dispatched",
  );
  await until(
    async () => h.disk(),
    (s: any) => Object.values(s.requests ?? {}).some((r: any) => r.senderOpenId === "ou_owner"),
    "owner request recorded",
  );
}

const cardNonces = (disk: any, action: string): any[] =>
  Object.values(disk.nonces as Record<string, any>).filter((n: any) => n.action === action);

/** The live approval card(s): message ids that have BOTH buttons durable. */
const liveCards = async (h: Hub): Promise<Array<{ messageId: string; chatId: string; ok: any; no: any }>> => {
  const d = h.disk();
  return cardNonces(d, "sched-ok").flatMap((ok: any) => {
    const no = cardNonces(d, "sched-no").find((n: any) => n.messageId === ok.messageId);
    return no ? [{ messageId: ok.messageId as string, chatId: ok.chatId as string, ok, no }] : [];
  });
};
const cardsSent = (s: Inspection): string[] =>
  s.sent.filter((m) => JSON.stringify(m.body).includes("定时任务待确认")).map((m) => m.messageId);
const deletes = (s: Inspection, messageId: string) =>
  s.calls.filter((c) => c.method === "DELETE" && c.path === `/open-apis/im/v1/messages/${messageId}`);
const patches = (s: Inspection, messageId: string): string[] =>
  s.calls.filter((c) => c.method === "PATCH" && c.path.endsWith(`/${messageId}`)).map((c) => JSON.stringify(c.json));
const click = (h: Hub, n: any, id: string, sender = "ou_owner") =>
  h.rpc("send", { raw: callback(n.nonce, { id, chatId: n.chatId, messageId: n.messageId, sender }) });
const webOffer = async (h: Hub, id: string) => (await h.web(SID)).find((t) => t.task.id === id)?.offer;

const DAILY = { name: "日报", cron: "0 8 * * *", tz: "UTC", prompt: "汇总今天的提交" };

/** hub + agent + bound owner chat + one AI-created task with all three channels showing. */
async function scenario(o: { idle?: boolean } = {}) {
  const E = coreEnv(Date.now());
  envs.push(E);
  const h = await bootHub(E.storeDir);
  const a = await agentStack(h, E, o);
  await bindOwner(h, a);
  const created = await a.callTool({ action: "create", ...DAILY });
  const id = created.details.id as string;
  const offer = await until(
    () => webOffer(h, id),
    (v) => v !== undefined,
    "web offer",
  );
  const [card] = await until(
    () => liveCards(h),
    (c) => c.length === 1,
    "feishu card with both buttons",
  );
  return { E, h, a, id, offer: offer as { offerId: string; expiresAt: number }, card: card! };
}

// ---------------------------------------------------------------------------------------------- the tests

describe("#61 I2 — AI-created scheduled task confirmed on the spot (real hub × real agent stack × fake Feishu/pi)", () => {
  it("create ⇒ the TUI box, the web offer and the Feishu card all appear for the same definition; the tool tells the model it was asked", async () => {
    const E = coreEnv(Date.now());
    envs.push(E);
    const h = await bootHub(E.storeDir);
    expect(h.ready.caps).toContain(SCHED_CONFIRM_CAP);
    const a = await agentStack(h, E);
    await bindOwner(h, a);
    const created = await a.callTool({ action: "create", ...DAILY });
    const id = created.details.id as string;
    expect(created.details).toMatchObject({ ok: true, pending: true, confirm: "offered" });
    expect(created.text).toContain("has been asked to confirm it now");

    // TUI: one three-option box, no timeout/abort handle (select takes exactly (title, options))
    await until(
      () => a.ui.selects.length,
      (n) => n === 1,
      "tui select",
    );
    expect(a.ui.selects[0]!.options).toHaveLength(3);
    expect(a.ui.selects[0]!.argc).toBe(2); // no pi timeout / abort signal — D12: the box is never ours to close
    expect(a.ui.selects[0]!.title).toContain(id);
    // web: the projection carries the offer for exactly this definition
    const task = (await h.web(SID)).find((t) => t.task.id === id);
    expect(task).toMatchObject({ pendingApproval: true, defHash: defHash(a.task(id)) });
    expect(task.offer.offerId).toMatch(/\S/);
    // Feishu: one card, full prompt, both buttons durable, bound to this hash
    const [card] = await until(
      () => liveCards(h),
      (c) => c.length === 1,
      "card",
    );
    const sent = await h.inspect();
    expect(cardsSent(sent)).toEqual([card!.messageId]);
    // the placeholder is sent first; the interactive card (full prompt + both buttons) arrives as the PATCH
    const full = patches(sent, card!.messageId).join("\n");
    expect(full).toContain("汇总今天的提交");
    expect(full).toContain(card!.ok.nonce);
    expect(full).toContain(card!.no.nonce);
    const anchor = cardNonces(h.disk(), "sched-card")[0];
    expect(JSON.parse(anchor.target)).toMatchObject({ sid: SID, taskId: id, defHash: defHash(a.task(id)) });
    expect(isApproved(a.task(id))).toBe(false);
  }, 90_000);

  it("Feishu wins: card keeps 「已通过飞书批准」 (never recalled), the web offer is gone, the TUI box never opens, ledger approved exactly once, the AI is told once", async () => {
    const { h, a, id, card } = await scenario({ idle: false });
    expect(a.ui.selects).toHaveLength(0); // blocked: a turn is "running" — the box has not been opened
    await click(h, card.ok, "fw-1");
    await until(
      () => isApproved(a.task(id)),
      (v) => v,
      "approved",
    );
    expect(a.task(id).approval).toMatchObject({ hash: defHash(a.task(id)), via: "web" });
    const s = await until(
      h.inspect,
      (x) => patches(x, card.messageId).some((p) => p.includes("已通过飞书批准")),
      "terminal PATCH",
    );
    expect(deletes(s, card.messageId)).toHaveLength(0);
    await until(
      () => webOffer(h, id),
      (v) => v === undefined,
      "web offer gone",
    );
    expect((await liveCards(h)).length).toBe(0);
    // the TUI presenter must not pop the (now stale) box when the session turns idle later
    a.ui.idle = true;
    await a.emit("agent_settled");
    await quiet();
    expect(a.ui.selects).toHaveLength(0);
    expect(a.notices()).toHaveLength(1);
    expect(a.notices()[0].content).toContain("飞书");
  }, 90_000);

  it("web wins (`/schedule approve <id> <hash>`): the Feishu card is recalled (DELETE once), the offer vanishes, the TUI box never opens, a late click on the old button decides nothing", async () => {
    const { h, a, id, card } = await scenario({ idle: false });
    const out = await a.webCommand(`approve ${id} ${defHash(a.task(id))}`);
    expect(out).toContain("已批准");
    const s = await until(h.inspect, (x) => deletes(x, card.messageId).length === 1, "card recalled");
    expect(deletes(s, card.messageId)).toHaveLength(1);
    await until(
      () => webOffer(h, id),
      (v) => v === undefined,
      "web offer gone",
    );
    expect((await liveCards(h)).length).toBe(0);
    a.ui.idle = true;
    await a.emit("agent_settled");
    await quiet();
    expect(a.ui.selects).toHaveLength(0);
    // late click on the purged nonce: nothing reaches the agent
    const before = a.decides.length;
    await click(h, card.ok, "late-1");
    await quiet(400);
    expect(a.decides).toHaveLength(before);
    expect(deletes(await h.inspect(), card.messageId)).toHaveLength(1);
    expect(isApproved(a.task(id))).toBe(true);
  }, 90_000);

  it("TUI wins (select → 批准): the card is recalled, the offer vanishes, the ledger is approved with via tui", async () => {
    const { h, a, id, card } = await scenario({ idle: false });
    a.ui.idle = true;
    await a.emit("agent_settled"); // the session is idle now → the box opens
    await until(
      () => a.ui.selects.length,
      (n) => n === 1,
      "tui box opens when idle",
    );
    a.ui.selects[0]!.resolve(a.ui.selects[0]!.options[0]); // 批准
    await until(
      () => isApproved(a.task(id)),
      (v) => v,
      "approved",
    );
    expect(a.task(id).approval).toMatchObject({ via: "tui" });
    const s = await until(h.inspect, (x) => deletes(x, card.messageId).length === 1, "card recalled");
    expect(patches(s, card.messageId).some((p) => p.includes("已通过飞书批准"))).toBe(false);
    await until(
      () => webOffer(h, id),
      (v) => v === undefined,
      "web offer gone",
    );
  }, 90_000);

  it("the TUI box is never aborted: Feishu approves while it is open ⇒ only a notification; answering 批准 afterwards changes nothing", async () => {
    const { h, a, id, card } = await scenario();
    await until(
      () => a.ui.selects.length,
      (n) => n === 1,
      "box open",
    );
    await click(h, card.ok, "open-box-1");
    await until(
      () => isApproved(a.task(id)),
      (v) => v,
      "approved",
    );
    await until(
      () => a.ui.notes.find((n) => n.text.includes(id) && /已在飞书批准.*可直接关闭/.test(n.text)),
      (v) => v !== undefined,
      "notification instead of abort",
    );
    const hashBefore = a.task(id).approval.hash;
    a.ui.selects[0]!.resolve(a.ui.selects[0]!.options[0]);
    await quiet();
    expect(a.task(id).approval.hash).toBe(hashBefore);
    expect(a.notices()).toHaveLength(1);
    expect((await h.inspect()).calls.filter((c) => c.method === "DELETE").length).toBe(0);
  }, 90_000);

  it("reject a created task from Feishu ⇒ the task is deleted everywhere (ledger, web), the card says so", async () => {
    const { h, a, id, card } = await scenario({ idle: false });
    await click(h, card.no, "rej-create");
    await until(
      () => a.task(id),
      (t) => t === undefined,
      "task deleted from ledger",
    );
    const s = await until(
      h.inspect,
      (x) => patches(x, card.messageId).some((p) => p.includes("已通过飞书拒绝")),
      "terminal reject PATCH",
    );
    expect(deletes(s, card.messageId)).toHaveLength(0);
    await until(
      async () => (await h.web(SID)).some((t) => t.task.id === id),
      (v) => v === false,
      "task gone from the web projection",
    );
    expect(
      a
        .notices()
        .map((n) => n.content)
        .join("\n"),
    ).toContain("拒绝");
    a.ui.idle = true;
    await a.emit("agent_settled");
    await quiet();
    expect(a.ui.selects).toHaveLength(0);
  }, 90_000);

  it("reject an UPDATE (web `/schedule reject`) ⇒ the previously approved definition is restored and executable again; the name is untouched", async () => {
    const { h, a, id, card } = await scenario({ idle: false });
    await a.webCommand(`approve ${id} ${defHash(a.task(id))}`);
    await until(
      () => isApproved(a.task(id)),
      (v) => v,
      "approved",
    );
    await until(h.inspect, (x) => deletes(x, card.messageId).length === 1, "first card recalled");
    const original = defHash(a.task(id));

    const upd = await a.callTool({ action: "update", id, prompt: "改成别的内容", name: "新名字" });
    expect(upd.details).toMatchObject({ ok: true, confirm: "offered" });
    expect(isApproved(a.task(id))).toBe(false); // an edit of an execution field revokes the approval
    const offer = await until(
      () => webOffer(h, id),
      (v) => v !== undefined,
      "offer for the edit",
    );
    expect(offer.offerId).toBeDefined();
    const [second] = await until(
      () => liveCards(h),
      (c) => c.length === 1,
      "fresh card for the new definition",
    );
    expect(second!.messageId).not.toBe(card.messageId);

    const out = await a.webCommand(`reject ${id} ${defHash(a.task(id))}`);
    expect(out).toMatch(/恢复|已拒绝/);
    expect(a.task(id).prompt).toBe(DAILY.prompt);
    expect(defHash(a.task(id))).toBe(original);
    expect(isApproved(a.task(id))).toBe(true); // the old approval is valid again
    expect(a.task(id).name).toBe("新名字"); // name is not part of the definition hash and is not rolled back
    await until(h.inspect, (x) => deletes(x, second!.messageId).length === 1, "second card recalled");
    await until(
      () => webOffer(h, id),
      (v) => v === undefined,
      "offer gone",
    );
  }, 90_000);

  it("create → update: the old card is recalled and its button is dead; the NEW card (new hash) is the only one that can approve", async () => {
    const { h, a, id, card } = await scenario({ idle: false });
    const oldHash = defHash(a.task(id));
    await a.callTool({ action: "update", id, prompt: "第二版 prompt" });
    const newHash = defHash(a.task(id));
    expect(newHash).not.toBe(oldHash);
    await until(h.inspect, (x) => deletes(x, card.messageId).length === 1, "old card recalled");
    const [fresh] = await until(
      async () => (await liveCards(h)).filter((c) => c.messageId !== card.messageId),
      (c) => c.length === 1,
      "new card",
    );
    const before = a.decides.length;
    await click(h, card.ok, "old-click"); // the purged old nonce
    await quiet(400);
    expect(a.decides).toHaveLength(before);
    expect(isApproved(a.task(id))).toBe(false);
    await click(h, fresh!.ok, "new-click");
    await until(
      () => isApproved(a.task(id)),
      (v) => v,
      "approved",
    );
    expect(a.task(id).approval.hash).toBe(newHash);
    expect(a.decides).toHaveLength(before + 1);
    expect(a.decides[before]).toMatchObject({ defHash: newHash, decision: "approve" });
  }, 90_000);

  it("TUI + Feishu answer at the same moment ⇒ one decision, one notice, one terminal state", async () => {
    const { h, a, id, card } = await scenario();
    await until(
      () => a.ui.selects.length,
      (n) => n === 1,
      "box open",
    );
    const box = a.ui.selects[0]!;
    await Promise.all([click(h, card.ok, "race-feishu"), Promise.resolve(box.resolve(box.options[0]))]);
    await until(
      () => isApproved(a.task(id)),
      (v) => v,
      "approved",
    );
    await quiet(800);
    expect(a.notices()).toHaveLength(1);
    expect(a.task(id).approval.hash).toBe(defHash(a.task(id)));
    expect((await liveCards(h)).length).toBe(0);
    expect(a.decides.length).toBeLessThanOrEqual(1);
  }, 90_000);

  it("web `/schedule approve` and a Feishu click at the same moment ⇒ approved once, the other side reports a neutral outcome (never a failure)", async () => {
    const { h, a, id, card } = await scenario({ idle: false });
    const hash = defHash(a.task(id));
    const [out] = await Promise.all([a.webCommand(`approve ${id} ${hash}`), click(h, card.ok, "race-web")]);
    expect(out).toMatch(/已批准|已是批准状态/);
    await until(
      () => isApproved(a.task(id)),
      (v) => v,
      "approved",
    );
    expect(a.task(id).approval.hash).toBe(hash);
    await until(
      async () => (await liveCards(h)).length,
      (n) => n === 0,
      "card settled",
    );
    const s = await h.inspect();
    const text = patches(s, card.messageId).join("\n");
    expect(text).not.toContain("未确认是否生效");
    expect(text).not.toContain("会话离线");
    await until(
      () => webOffer(h, id),
      (v) => v === undefined,
      "offer gone",
    );
  }, 90_000);

  it("the agent is offline: a Feishu click answers 「会话离线」 and decides nothing; the web projection offers nothing; the task stays pending", async () => {
    const { h, a, id, card } = await scenario({ idle: false });
    a.crash();
    await until(
      () => webOffer(h, id),
      (v) => v === undefined,
      "offer hidden while offline",
    );
    const task = (await h.web(SID)).find((t) => t.task.id === id);
    expect(task.pendingApproval).toBe(true);
    const before = (await h.inspect()).sent.length;
    await click(h, card.ok, "offline-click");
    await until(
      h.inspect,
      (s) => s.sent.slice(before).some((m) => JSON.stringify(m.body).includes("会话离线")),
      "offline notice",
    );
    expect(a.decides).toHaveLength(0);
    expect(a.task(id).approval).toBeUndefined();
  }, 90_000);

  it("/reload after the AI's create, then the task is deleted behind the hub's back ⇒ the card settles on the ledger evidence: 「任务已删除」 (no guess, no recall)", async () => {
    const { E, h, a, id, card } = await scenario({ idle: false });
    a.crash(); // no `withdrawn` frame: the hub has neither an open nor a closed entry for this offer
    await E.store(SID).transact((d: any) => ({ value: removeTask(d, id), write: true }));
    const b = await agentStack(h, E, { idle: false }); // the reloaded session re-attaches and republishes an empty list
    const s = await until(
      h.inspect,
      (x) => patches(x, card.messageId).some((p) => p.includes("任务已删除")),
      "card settled on deletion evidence",
    );
    expect(deletes(s, card.messageId)).toHaveLength(0);
    expect((await liveCards(h)).length).toBe(0);
    expect(b.ui.selects).toHaveLength(0);
  }, 90_000);

  it("/reload after the task was approved elsewhere ⇒ the card settles on the ledger evidence: 「已批准」 (not 「已撤回」)", async () => {
    const { E, h, a, id, card } = await scenario({ idle: false });
    const hash = defHash(a.task(id));
    a.crash();
    const r = await approveTask(E.store(SID), id, hash, "web");
    expect(r.kind).toBe("changed");
    await agentStack(h, E, { idle: false });
    const s = await until(
      h.inspect,
      (x) => patches(x, card.messageId).some((p) => p.includes("已批准")),
      "card settled on approval evidence",
    );
    expect(deletes(s, card.messageId)).toHaveLength(0);
    expect((await liveCards(h)).length).toBe(0);
  }, 90_000);

  it("/reload with the task still pending and no evidence either way ⇒ the card is kept (fail-closed), never recalled by a guess", async () => {
    const { E, h, a, id, card } = await scenario({ idle: false });
    a.crash();
    await agentStack(h, E, { idle: false });
    await quiet(1500);
    const s = await h.inspect();
    expect(deletes(s, card.messageId)).toHaveLength(0);
    expect(patches(s, card.messageId).some((p) => /任务已删除|已批准/.test(p))).toBe(false);
    expect((await liveCards(h)).length).toBe(1);
    void id;
  }, 90_000);

  it("schedule off on the hub: no confirm cap, no schedules API, no Feishu card — and a TUI-only agent sends the hub nothing", async () => {
    const E = coreEnv(Date.now());
    envs.push(E);
    const h = await bootHub(undefined);
    expect(h.ready.caps).not.toContain(SCHED_CONFIRM_CAP);
    expect(h.ready.caps).not.toContain(SCHED_HUB_CAP);
    expect(await h.webStatus()).toBe(404);
    // an agent stack WITHOUT a hub router (what schedule-on / webHub-off looks like) is TUI-only
    const a = await agentStack(h, E, { withRouter: false });
    const created = await a.callTool({ action: "create", ...DAILY });
    expect(created.details).toMatchObject({ ok: true, confirm: "offered" });
    await until(
      () => a.ui.selects.length,
      (n) => n === 1,
      "tui still asks",
    );
    await quiet(500);
    expect(cardsSent(await h.inspect())).toEqual([]);
    expect(a.hubFrames).toEqual([]);
  }, 90_000);

  it("new agent × hub without the confirm cap: the link never becomes confirm-ready ⇒ no sched_offers frame, TUI-only", async () => {
    const E = coreEnv(Date.now());
    envs.push(E);
    const h = await bootHub(undefined);
    const a = await agentStack(h, E);
    const created = await a.callTool({ action: "create", ...DAILY });
    expect(created.details.confirm).toBe("offered");
    await until(
      () => a.ui.selects.length,
      (n) => n === 1,
      "tui still asks",
    );
    expect(a.agent.coordinator.confirmReady()).toBe(false);
    await quiet(500);
    expect(cardsSent(await h.inspect())).toEqual([]);
    expect(a.hubFrames.filter((f) => String(f.t).startsWith("sched_"))).toEqual([]);
  }, 90_000);
});
