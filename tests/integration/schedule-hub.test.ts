/* eslint-disable @typescript-eslint/no-explicit-any */
import { spawn, type ChildProcess } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { systemClock } from "../../src/core/clock.js";
import { createScheduleAgent } from "../../src/schedule/agent/wire.js";
import { createScheduleHubRouter } from "../../src/schedule/agent/coordinator.js";
import { installBackgroundExecutor } from "../../src/schedule/agent/bg.js";
import { createTask, type OpsPorts } from "../../src/schedule/agent/ops.js";
import { sweep } from "../../src/schedule/core/claim.js";
import { sessionDirName } from "../../src/schedule/core/paths.js";
import { SCHED_HUB_CAP } from "../../src/web-hub/protocol/schedule.js";
import { resolveHubPaths } from "../../src/web-hub/protocol/paths.js";
import { config, connectClient, hello } from "../web-hub/hub/helpers.js";
import { addTask, approve, env as coreEnv, makeTask, self, type Env } from "../schedule/core/fixtures.js";
import type { RunOutcome } from "../../src/core/types.js";

/**
 * scheduled-reports I1 (plan r3 §14 SC2/SC5/SC7): a REAL hub child process (real H1 coordinator, real F1
 * schedule service, real outbox) × a fake Feishu (HTTP + pbbp2 websocket fakes) × REAL agent-side pieces
 * (S1 ledger, A0 agent + router/coordinator, A1 background executor) talking over the hub's real unix socket.
 *
 *   SC2  create → approve → background run → report + pendingReports → `sched_changed` → hub discovers →
 *        Feishu final message → receipt → `sched_receipts` frame → agent removes the pending index entry.
 *   SC5  an OFFLINE session whose cron occurrences were missed (S1 sweep) → the hub's startup reconcile pushes ONE
 *        merged 「已错过」 card with the right count; nothing is pushed twice.
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
const cfg = JSON.parse(process.env.SCHED_CONFIG);
const paths = resolveHubPaths({home: cfg.home, uid: process.getuid?.() ?? 0});
const fake = createFakeFeishu({appId: "cli_test"});
fake.on("POST", "/callback/ws/endpoint", () => ({json: {code: 0, data: {
  URL: "wss://msg-frontier.feishu.cn/ws?service_id=33&device_id=sched-device", ClientConfig: {
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
const reply = (id, value) => process.send?.({id, value});
process.on("message", async (m) => {
  try {
    if (m.op === "inspect") {
      reply(m.id, {sent: fake.sent, livePeers: ws.peers.filter(p => !p.closed).length, caps: hub.info.caps});
    } else if (m.op === "stop") {
      await hub.close("test"); await ws.dispose(); reply(m.id, true); process.disconnect();
    } else throw new Error("unknown fixture op");
  } catch (e) { process.send?.({id: m.id, error: String(e)}); }
});
process.send?.({ready: true});
`;

interface Inspection {
  sent: Array<{ messageId: string; kind: string; body: Record<string, any> }>;
  livePeers: number;
  caps: string[];
}

const closers = new Set<() => Promise<void>>();
const dirs = new Set<string>();
const envs: Env[] = [];
afterEach(async () => {
  for (const c of [...closers]) await c().catch(() => undefined);
  closers.clear();
  for (const e of envs.splice(0)) e.cleanup();
  for (const d of dirs) rmSync(d, { recursive: true, force: true });
  dirs.clear();
}, 30_000);

async function until<T>(read: () => Promise<T> | T, ok: (v: T) => boolean, label: string, ms = 15_000): Promise<T> {
  const end = Date.now() + ms;
  for (;;) {
    const v = await read();
    if (ok(v)) return v;
    if (Date.now() > end) throw new Error(`timeout: ${label}`);
    await new Promise((r) => setTimeout(r, 50));
  }
}

async function bootHub(storeDir: string) {
  const home = mkdtempSync(join(tmpdir(), "pwh-sched-i1-"));
  dirs.add(home);
  mkdirSync(join(home, "project"), { recursive: true });
  const cfg = config({
    home,
    schedule: { dir: storeDir, toleranceS: 60 },
    feishuBot: {
      allowGroups: false,
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
      SCHED_CONFIG: JSON.stringify(cfg),
    },
  });
  let stderr = "";
  child.stderr!.on("data", (b: Buffer) => (stderr += b.toString()));
  const exited = new Promise<void>((done) => child.once("close", () => done()));
  let rid = 0;
  const rpc = <T>(op: string): Promise<T> =>
    new Promise<T>((res, rej) => {
      const id = ++rid;
      const onMsg = (m: any) => {
        if (m.id !== id) return;
        child.off("message", onMsg);
        m.error ? rej(new Error(m.error)) : res(m.value);
      };
      child.on("message", onMsg);
      child.send({ id, op }, (e) => e && rej(e));
    });
  await new Promise<void>((res, rej) => {
    child.on("message", (m: any) => m.ready && res());
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
  return { paths, inspect, stderr: () => stderr };
}

const completed = (runId: string, text: string): RunOutcome => ({
  runId,
  status: "completed",
  text,
  turns: 1,
  durationMs: 3,
  diag: {
    createdAt: 0,
    phase: "settled",
    phaseEnteredAt: 0,
    pendingTools: 0,
    turns: 1,
    escalation: [],
    orphaned: false,
    generation: 1,
    degraded: [],
    staleInputs: 0,
    unkillable: [],
  },
});

describe("scheduled reports × real hub child × fake Feishu", () => {
  it("SC2: background report → hub discovers it → Feishu final → receipt → sched_receipts → the agent drops its pending index entry", async () => {
    const E = coreEnv(Date.now());
    envs.push(E);
    const hub = await bootHub(E.storeDir);
    const SIDA = "019a1111-aaaa-7bbb-8ccc-dddddddddddd";

    // ---- real agent-side stack over the SAME store root, linked to the hub's real socket
    const router = createScheduleHubRouter({ hubConfig: () => ({ dir: E.root.real, toleranceS: 60 }) });
    const ctx = {
      mode: "tui",
      sessionManager: {
        getSessionId: () => SIDA,
        getSessionFile: () => join(E.dir, "a.jsonl"),
        getEntries: () => [],
      },
    };
    const agent = createScheduleAgent({
      ctx: ctx as never,
      mode: { kind: "interactive", arm: true },
      sessionId: SIDA,
      self: self(),
      dir: E.storeDir,
      plain: true,
      inVault: () => false,
      clock: systemClock,
      warn: () => undefined,
      router,
      storeOpts: { lockTimeoutMs: 2_000 },
    });
    const ports: OpsPorts = {
      agent,
      now: () => Date.now(),
      limits: { defaultTimeoutS: 1800, maxTimeoutS: 14_400 },
      agentTypes: { has: () => true },
      capability: () => "verified",
      ownerCwd: () => E.dir,
      defaultTz: () => "UTC",
    };
    const client = await connectClient(hub.paths.socketPath);
    client.send(hello({ caps: ["ev.v1", SCHED_HUB_CAP], agentId: { pid: 4242, nonce: "nonce-sched-A-0123456789" } }));
    const ack = (await client.waitFrame((f) => f.t === "hello_ack")) as { caps?: string[] };
    expect(ack.caps).toContain(SCHED_HUB_CAP);
    client.send({
      t: "session",
      sessionId: SIDA,
      cwd: E.dir,
      reason: "startup",
      leafId: null,
      mode: "tui",
    });
    router.bindLink({ ready: () => true, send: (f) => client.send(f as never) });
    client.sock.on("data", () => undefined);
    const received: Array<Record<string, any>> = [];
    const poll = setInterval(() => {
      for (const f of client.frames as Array<Record<string, any>>) {
        if (received.includes(f)) continue;
        received.push(f);
        if (f.t === "sched_receipts") router.onSchedReceipts(f as never);
        if (f.t === "sched_run") router.onSchedRun(f as never);
      }
    }, 20);
    closers.add(async () => void clearInterval(poll));

    // ---- AI creates, the user approves (S2: approval = defHash), a background run executes and reports
    const created = await createTask(
      ports,
      {
        name: "日报",
        form: "background",
        when: { kind: "cron", expr: "0 8 * * *", tz: "UTC" },
        prompt: "汇总",
        feishu: true,
      },
      { by: "agent", via: "tool" },
    );
    if (!created.ok) throw new Error(created.detail);
    const store = agent.ensureStore();
    await store.transact((d) => {
      const t = d.tasks[0]!;
      approve(t);
      return { value: undefined, write: true };
    });
    const bg = installBackgroundExecutor(agent, {
      spawn: {
        spawn: async () => ({ runId: "r_hubbg", slots: { limit: 1, inUse: 1, free: 0 } }),
        waitOutcome: async () => ({
          kind: "settled" as const,
          outcome: completed("r_hubbg", "SC2 报告正文：本日共 3 次提交"),
        }),
      } as never,
      notes: {
        currentSessionId: () => SIDA,
        sessionFile: () => join(E.dir, "a.jsonl"),
        isIdle: () => false,
        sendMessage: () => undefined,
      },
    });
    const started = await agent.runNow({ taskId: created.value.id, reqId: "sc2-request-0123456789" });
    expect(started.kind).toBe("started");
    await bg.drain();
    const ledger = () => JSON.parse(readFileSync(join(E.storeDir, sessionDirName(SIDA), "state.json"), "utf8"));
    expect(ledger().runs[0]).toMatchObject({ state: "completed" });
    expect(ledger().pendingReports).toHaveLength(1);

    // ---- the hub discovers it (sched_changed) and pushes ONE Feishu message with the report body
    const sent = await until(
      hub.inspect,
      (s) => s.sent.some((m) => JSON.stringify(m.body).includes("SC2 报告正文")),
      "report pushed to Feishu",
    );
    expect(sent.sent.filter((m) => JSON.stringify(m.body).includes("SC2 报告正文"))).toHaveLength(1);

    // ---- receipt → sched_receipts frame → the agent's coordinator removes the index entry
    await until(
      () => received.filter((f) => f.t === "sched_receipts"),
      (r) => r.length > 0,
      "sched_receipts frame",
    );
    await until(
      () => ledger().pendingReports.length,
      (n) => n === 0,
      "pending index entry removed",
    );
    // exactly-once-ish: nothing is pushed a second time after the receipt landed
    await new Promise((r) => setTimeout(r, 400));
    const final = await hub.inspect();
    expect(final.sent.filter((m) => JSON.stringify(m.body).includes("SC2 报告正文"))).toHaveLength(1);

    bg.dispose();
    agent.dispose();
    client.sock.destroy();
  }, 90_000);

  it("SC5: an offline session's missed occurrences become ONE merged missed-notice card at the hub's reconcile; no duplicate on a later scan", async () => {
    const E = coreEnv(Date.now());
    envs.push(E);
    const SIDB = "019a2222-aaaa-7bbb-8ccc-eeeeeeeeeeee";
    const now = Date.now();
    const store = E.store(SIDB, { now: () => Date.now() });
    const task = approve(
      makeTask({ name: "离线日报", when: { kind: "cron", expr: "* * * * *", tz: "UTC" }, feishu: true }),
    );
    await addTask(store, task, now - 6 * 60_000); // decided only up to 6 minutes ago ⇒ ~5 occurrences past tolerance
    const swept = await sweep(store);
    if (swept.kind !== "swept") throw new Error(JSON.stringify(swept));
    expect(swept.missed.length).toBeGreaterThan(0);
    const missedTotal = JSON.parse(readFileSync(join(E.storeDir, sessionDirName(SIDB), "state.json"), "utf8")).occ[
      task.id
    ].missedTotal as number;
    expect(missedTotal).toBeGreaterThanOrEqual(4);

    const hub = await bootHub(E.storeDir); // the session is OFFLINE (no agent ever connects)
    const sent = await until(
      hub.inspect,
      (s) => s.sent.some((m) => JSON.stringify(m.body).includes("离线日报")),
      "missed notice pushed",
    );
    const cards = sent.sent.filter((m) => JSON.stringify(m.body).includes("离线日报"));
    expect(cards).toHaveLength(1); // merged: one card for the task, not one per missed occurrence
    expect(JSON.stringify(cards[0]!.body)).toContain(String(missedTotal));
    await new Promise((r) => setTimeout(r, 700));
    expect((await hub.inspect()).sent.filter((m) => JSON.stringify(m.body).includes("离线日报"))).toHaveLength(1);
  }, 90_000);
});
