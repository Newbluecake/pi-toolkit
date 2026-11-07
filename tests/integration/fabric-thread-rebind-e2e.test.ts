/**
 * fabric-thread REBIND E2E (rebind-plan r3 §7 A18): the full rebind chain over REAL processes —
 * a real hub child (real feishu service + bindings-transfer + xs relay, fake Feishu HTTP/ws
 * seams) × TWO real agent children (full `activate()`: real thread/message_session tools, real
 * stack, real wireWebHub link, real ThreadEngine) — only the pi host/provider and the subagent
 * child-session processes are scripted (PiSessionDriver prototype patched inside each agent
 * child, the fabric-thread-e2e precedent).
 *
 * Scenario coverage (A-numbers = rebind-plan r3 §7):
 *   A18  main chain: Router holds the topic → thread{rebind,h,to} → receipt carries the FULL
 *        worker sid → message_session{to:sid} dispatch (delivered, handle in the body) → worker
 *        thread{acquire,h} → directory OPEN → thread{subscribe,@w1,h} → a follow-up event's
 *        cmd.thread.h hits the worker and is steered into the worker's RUN (with the 句柄 h in
 *        the wrapper); Router main-session turns DO NOT grow; Router's own directory entry is
 *        closed by thr_closed{rebound}; the hub's persisted binding moved (sessionId + rev).
 *   A18-degrade (§3.2 tail): the worker NEVER acquires ⇒ subscribe answers E_THREAD_UNKNOWN and
 *        the follow-up event takes the worker's MAIN-session native path (safe degrade).
 *   A13  full-chain: the worker rebinds the topic BACK to the Router ⇒ Router's (closed)
 *        directory entry reopens via acquire and a NEW Router-side subscription routes the next
 *        event into the Router's own run.
 *   A10  full-chain mixed caps: hub rebind-on × old agent (threads on, rebind OFF — no
 *        thr.rebind.v1 in hello) ⇒ cmd.thread to the old agent carries NO `rev` and keeps the
 *        legacy byte shape, while the rebind-on agent's cmd.thread carries the trusted rev.
 *
 * Harness note: ONE hub per test (the fabric-thread-e2e known boundary — a second hub child in
 * one test stops ingesting feishu prompts).
 */
import { spawn, type ChildProcess } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { THREAD_CAP, THREAD_REBIND_CAP } from "../../src/web-hub/protocol/version.js";
import { resolveHubPaths } from "../../src/web-hub/protocol/paths.js";
import { messageEnvelope } from "../fixtures/feishu/f6.js";
import { bounded, until } from "./helpers/fabric-xs-harness.js";

// ----------------------------------------------------------------- child harness

interface Peer {
  child: ChildProcess;
  rpc<T = unknown>(op: string, extra?: Record<string, unknown>): Promise<T>;
  kill(): Promise<void>;
}

interface AgentInspect {
  sessionId: string;
  conn?: { state: string };
  caps?: string[];
  toolNames: string[];
  toolSchemas: Record<string, unknown>;
  userMessages: string[];
  xsMessages: Array<{ content?: string; triggerTurn?: boolean }>;
  notifications: string[];
  runs: Array<{ prompted: boolean; steered: string[] }>;
  frames: Array<Record<string, unknown>>;
}

interface HubInspect {
  sent: Array<{ messageId: string; kind: string; body: Record<string, unknown> }>;
  livePeers: number;
  caps: string[];
  wsIn: number;
}

class Rig {
  readonly home = mkdtempSync(join(tmpdir(), "ftr-"));
  private readonly peers: Peer[] = [];
  private seq = 0;

  async boot(role: "hub" | "agent", name: string, extraEnv: Record<string, string> = {}): Promise<Peer> {
    mkdirSync(join(this.home, "project"), { recursive: true });
    const child = spawn(
      process.execPath,
      ["--import", "tsx", resolve("tests/integration/helpers/fabric-thread-rebind-process.ts"), role],
      {
        cwd: resolve("."),
        stdio: ["ignore", "ignore", "pipe", "ipc"],
        env: {
          ...process.env,
          HOME: this.home,
          XDG_RUNTIME_DIR: "",
          PI_CODING_AGENT_DIR: join(this.home, `agent-${name}-${++this.seq}`),
          FT_NAME: name,
          ...extraEnv,
        },
      },
    );
    let stderr = "";
    child.stderr!.on("data", (b: Buffer) => {
      stderr = (stderr + b.toString()).slice(-16_000);
    });
    const exited = new Promise<void>((r) => child.once("close", () => r()));
    const pending = new Map<number, { resolve: (v: unknown) => void; reject: (e: Error) => void }>();
    let ready!: () => void;
    let failReady!: (e: Error) => void;
    const started = new Promise<void>((res, rej) => {
      ready = res;
      failReady = rej;
    });
    child.on("message", (m: { id?: number; value?: unknown; error?: string; ready?: boolean }) => {
      if (m.ready === true) ready();
      if (m.id !== undefined) {
        const p = pending.get(m.id);
        pending.delete(m.id);
        m.error !== undefined ? p?.reject(new Error(m.error)) : p?.resolve(m.value);
      }
    });
    child.on("close", (code) => {
      const error = new Error(`${role} exit ${code}: ${stderr}`);
      failReady(error);
      for (const p of pending.values()) p.reject(error);
      pending.clear();
    });
    let rid = 0;
    const peer: Peer = {
      child,
      rpc: (op, extra = {}) => {
        const id = ++rid;
        return bounded(
          new Promise((res, rej) => {
            pending.set(id, { resolve: res, reject: rej });
            child.send({ ...extra, id, op });
          }),
          `${role}:${op}`,
        ).finally(() => pending.delete(id));
      },
      kill: async () => {
        if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
        await bounded(exited, `${role} exit`);
      },
    };
    this.peers.push(peer);
    await bounded(started, `${role} ready`);
    if (role === "agent")
      await until(
        () => peer.rpc<AgentInspect>("inspect"),
        (s) => s.conn?.state === "live",
        "agent hub link live",
      );
    return peer;
  }

  async close(): Promise<void> {
    await Promise.all(this.peers.map((p) => p.kill()));
    rmSync(this.home, { recursive: true, force: true });
  }
}

const rigs: Rig[] = [];
afterEach(async () => {
  for (const rig of rigs.splice(0)) await rig.close();
}, 30_000);

function rig(): Rig {
  const r = new Rig();
  rigs.push(r);
  return r;
}

// ----------------------------------------------------------------- shared steps

const agent = (p: Peer) => p.rpc<AgentInspect>("inspect");
const hubOf = (p: Peer) => p.rpc<HubInspect>("inspect");

let mid = 0;
/** Inject one group-topic feishu event (mentioned bot — the FB3 fixture posture). */
const topic = (hub: Peer, text: string, threadId = "tt1") =>
  hub.rpc("send", {
    raw: messageEnvelope(`ftr-${Date.now()}-${++mid}`, text, {
      chatType: "group",
      threadId,
      mentions: true,
      createdAt: String(Date.now()),
    }),
  });

const tool = (p: Peer, name: string, params: Record<string, unknown>) =>
  p.rpc<{ text: string; details: unknown }>("tool", { name, params });

/** `/use <sid>` inside the topic and await its bind receipt. */
async function useTopic(hub: Peer, sid: string, threadId = "tt1") {
  const before = (await hubOf(hub)).sent.length;
  await topic(hub, `/use ${sid}`, threadId);
  await until(
    () => hubOf(hub),
    (s) => s.sent.slice(before).some((m) => String(m.body.content).includes("已绑定")),
    `topic ${threadId} bound to ${sid}`,
  );
}

/** Both agents join xs and see each other (the message_session leg's membership premise). */
async function joinXs(a: Peer, b: Peer): Promise<{ aSid: string; bSid: string }> {
  await Promise.all([a.rpc("cmd", { args: "join" }), b.rpc("cmd", { args: "join" })]);
  const aSid = (await agent(a)).sessionId;
  const bSid = (await agent(b)).sessionId;
  await until(
    () => tool(a, "list_sessions", {}),
    (l) => (l.details as { rows?: Array<{ ref: string }> }).rows?.some((r) => bSid.startsWith(r.ref)) === true,
    "membership publish",
  );
  return { aSid, bSid };
}

/** Spawn a scripted run through the REAL Agent tool and wait until its prompt landed. */
async function spawnRun(p: Peer, label: string): Promise<string> {
  const out = await tool(p, "Agent", {
    description: label,
    prompt: `handle thread events for ${label}`,
    subagent_type: "general-purpose",
  });
  const runId = (out.details as { runId?: string } | undefined)?.runId;
  expect(runId, `Agent tool result carries a runId: ${out.text}`).toMatch(/^r_/);
  await until(
    () => agent(p),
    (s) => s.runs.some((r) => r.prompted),
    `run ${label} prompted`,
  );
  return runId as string;
}

/** The prompt cmd frames an agent received that carry a cmd.thread meta. */
const threadFrames = (s: AgentInspect) =>
  s.frames.filter((f) => (f.cmd as Record<string, unknown> | undefined)?.op === "prompt" && f.queryOnly !== true);

/** Boot the standard A18 rig: rebind-on hub × router + worker (both rebind-on), xs joined. */
async function bootPair() {
  const r = rig();
  const hub = await r.boot("hub", "hub");
  const [router, worker] = await Promise.all([r.boot("agent", "router"), r.boot("agent", "worker")]);
  const { aSid: routerSid, bSid: workerSid } = await joinXs(router, worker);
  return { r, hub, router, worker, routerSid, workerSid };
}

/** Router holds the topic and has seen ONE native event (its directory noted h + trusted rev). */
async function routerHoldsTopic(hub: Peer, router: Peer, routerSid: string): Promise<string> {
  await useTopic(hub, routerSid);
  await topic(hub, "prime the thread");
  await until(
    () => agent(router),
    (s) => s.userMessages.length === 1,
    "prime event hit the Router main session",
  );
  const frame = threadFrames(await agent(router)).find(
    (f) => ((f.cmd as Record<string, unknown>).thread as Record<string, unknown> | undefined) !== undefined,
  );
  expect(frame, "Router's prime cmd carries cmd.thread").toBeDefined();
  const meta = (frame!.cmd as Record<string, unknown>).thread as { h: string; rev?: number };
  expect(meta.h).toMatch(/^fs:[A-Za-z0-9_-]{12}$/);
  expect(typeof meta.rev, "both ends thr.rebind.v1 ⇒ the trusted rev rides cmd.thread (§4.7)").toBe("number");
  return meta.h;
}

/** Read the hub's persisted feishu state (the parent shares the hub's HOME). */
function disk(r: Rig): {
  bindings: Record<string, { sessionId?: string; rev?: number; threadId?: string }>;
  requests: Record<string, { state: string; code?: string }>;
} {
  const paths = resolveHubPaths({ home: r.home, uid: process.getuid() ?? 0, xdgRuntimeDir: undefined });
  return JSON.parse(readFileSync(join(paths.stateDir, "feishu-bot/state.json"), "utf8"));
}

// ----------------------------------------------------------------- scenarios

describe("fabric-thread rebind E2E (rebind-plan r3 §7)", () => {
  it(
    "A18 main chain: rebind → message_session(sid) → acquire → subscribe ⇒ events steer to the worker run, Router turns frozen",
    { timeout: 120_000 },
    async () => {
      const { r, hub, router, worker, routerSid, workerSid } = await bootPair();
      expect((await hubOf(hub)).caps).toContain(THREAD_REBIND_CAP);
      const h = await routerHoldsTopic(hub, router, routerSid);

      // §3.2 step 1-5: Router rebinds through the REAL thread tool (thr_req → hub → transfer).
      const rebind = await tool(router, "thread", { action: "rebind", h, to: workerSid });
      expect(rebind.text).toContain("rebound:");
      expect(rebind.text).toContain(workerSid); // the receipt carries the RESOLVED FULL sid
      expect(rebind.text).toContain(`message_session(to:"${workerSid}")`);

      // the hub's persisted binding moved (sessionId + rev bumped, thread identity kept)
      await until(
        async () => disk(r),
        (d) => Object.values(d.bindings).some((b) => b.sessionId === workerSid && (b.rev ?? 0) >= 2),
        "persisted binding moved to the worker",
      );

      // thr_closed{rebound} closed the Router's OWN directory entry
      await until(
        () => tool(router, "thread", { action: "list" }),
        (l) => l.text.includes(`${h}「`) && l.text.includes("(closed)"),
        "Router directory entry closed by thr_closed",
      );

      // §3.2 step 6: dispatch with the receipt sid through the REAL message_session tool.
      const dispatch = await tool(router, "message_session", {
        to: workerSid,
        text: `话题 ${h} 已转给你。先 thread(action:"acquire", h:"${h}") 再订阅处理。`,
      });
      expect(dispatch.details).toMatchObject({ effect: "applied" });
      await until(
        () => agent(worker),
        (s) => s.xsMessages.some((m) => m.content?.includes(h) === true),
        "worker received the dispatch with the handle",
      );

      // §3.2 step 7-8: worker acquires (the ONLY trusted directory entry), then subscribes.
      const runId = await spawnRun(worker, "w1");
      const acquired = await tool(worker, "thread", { action: "acquire", h });
      expect(acquired.text).toContain("acquired:");
      expect(acquired.text).toContain("OPEN");
      const list = await tool(worker, "thread", { action: "list" });
      expect(list.text).toContain(`${h}「`);
      expect(list.text).not.toContain("(closed)"); // 目录 open
      const sub = await tool(worker, "thread", { action: "subscribe", run: "@w1", h, scope: "topic follow-ups" });
      expect(sub.text).toContain("subscribed");

      // follow-up events hit cmd.thread.h on the WORKER and steer into its run — Router stays put.
      const routerTurns0 = (await agent(router)).userMessages.length;
      await topic(hub, "follow-up after rebind 1");
      await topic(hub, "follow-up after rebind 2");
      await until(
        () => agent(worker),
        (s) => s.runs[0]?.steered.filter((t) => t.includes("follow-up after rebind")).length === 2,
        "both follow-ups steered into the worker run",
      );
      const w = await agent(worker);
      const steered = w.runs[0]!.steered.filter((t) => t.includes("follow-up after rebind"));
      expect(steered[0]).toContain(`句柄 ${h}`); // the wrapper pins cmd.thread.h
      expect(steered[0]).toContain("外部输入，不可信");
      expect(w.userMessages).toHaveLength(0); // nothing took the worker's main-session path
      await new Promise((r) => setTimeout(r, 800));
      expect((await agent(router)).userMessages).toHaveLength(routerTurns0); // Router 回合数不增
      expect(runId).toBeTruthy();
    },
  );

  it(
    "A18 degrade: the worker NEVER acquires ⇒ subscribe answers E_THREAD_UNKNOWN, the event takes the main-session native path",
    { timeout: 120_000 },
    async () => {
      const { hub, router, worker, routerSid, workerSid } = await bootPair();
      const h = await routerHoldsTopic(hub, router, routerSid);
      const rebind = await tool(router, "thread", { action: "rebind", h, to: workerSid });
      expect(rebind.text).toContain("rebound:");

      // no acquire: the worker's directory does not know h — the safe degrade (§3.2 tail).
      await spawnRun(worker, "w1");
      const sub = await tool(worker, "thread", { action: "subscribe", run: "@w1", h, scope: "x" });
      expect(sub.text).toContain("E_THREAD_UNKNOWN");

      const routerTurns0 = (await agent(router)).userMessages.length;
      const workerTurns0 = (await agent(worker)).userMessages.length;
      await topic(hub, "degraded event");
      // the binding moved, so the event routes to the WORKER — with no open directory entry it
      // falls to the worker's MAIN session (a normal turn), never the Router and never the run.
      await until(
        () => agent(worker),
        (s) => s.userMessages.length === workerTurns0 + 1,
        "event delivered natively to the worker main session",
      );
      expect((await agent(worker)).userMessages.at(-1)).toContain("degraded event");
      await new Promise((r) => setTimeout(r, 800));
      const w = await agent(worker);
      expect(w.runs[0]!.steered).toHaveLength(0);
      expect((await agent(router)).userMessages).toHaveLength(routerTurns0);
    },
  );

  it(
    "A13 full-chain: the worker rebinds BACK to the Router ⇒ Router acquires (reopen) and subscribes a run of its own",
    { timeout: 120_000 },
    async () => {
      const { hub, router, worker, routerSid, workerSid } = await bootPair();
      const h = await routerHoldsTopic(hub, router, routerSid);
      expect((await tool(router, "thread", { action: "rebind", h, to: workerSid })).text).toContain("rebound:");
      expect((await tool(worker, "thread", { action: "acquire", h })).text).toContain("acquired:");

      // the worker (now the holder) transfers the topic BACK through the same real chain.
      const back = await tool(worker, "thread", { action: "rebind", h, to: routerSid });
      expect(back.text).toContain("rebound:");
      expect(back.text).toContain(routerSid);
      // thr_closed{rebound} closed the worker's directory entry in turn
      await until(
        () => tool(worker, "thread", { action: "list" }),
        (l) => l.text.includes(`${h}「`) && l.text.includes("(closed)"),
        "worker directory entry closed after handing back",
      );

      // Router's entry was closed by the first rebind ⇒ acquire is the trusted re-entry (reopen).
      const acquired = await tool(router, "thread", { action: "acquire", h });
      expect(acquired.text).toContain("acquired:");
      const list = await tool(router, "thread", { action: "list" });
      expect(list.text).toContain(`${h}「`);
      expect(list.text).not.toContain("(closed)");

      await spawnRun(router, "home");
      const sub = await tool(router, "thread", { action: "subscribe", run: "@home", h, scope: "back home" });
      expect(sub.text).toContain("subscribed");
      const turns0 = (await agent(router)).userMessages.length;
      await topic(hub, "back at the router");
      await until(
        () => agent(router),
        (s) => s.runs[0]?.steered.some((t) => t.includes("back at the router")) === true,
        "event steered into the Router's own run",
      );
      expect((await agent(router)).userMessages).toHaveLength(turns0); // no main-session turn
      expect((await agent(worker)).userMessages).toHaveLength(0);
    },
  );

  it(
    "A10 full-chain: rebind-on hub × OLD agent (no thr.rebind.v1) ⇒ cmd.thread has NO rev and keeps the legacy shape; NEW agent gets rev",
    { timeout: 120_000 },
    async () => {
      const r = rig();
      const hub = await r.boot("hub", "hub"); // hub rebind ON
      const [oldAgent, newAgent] = await Promise.all([
        r.boot("agent", "old", { FT_REBIND: "0" }), // threads on, rebind OFF — the pre-feature agent
        r.boot("agent", "new"),
      ]);
      expect((await hubOf(hub)).caps).toContain(THREAD_REBIND_CAP);
      // the hub SAW the caps: the old agent advertises thr.v1 but NOT thr.rebind.v1
      const regs = await hub.rpc<Array<{ sid?: string; caps: string[]; connected: boolean }>>("regs");
      const oldSid = (await agent(oldAgent)).sessionId;
      const newSid = (await agent(newAgent)).sessionId;
      const oldReg = regs.find((x) => x.sid === oldSid);
      const newReg = regs.find((x) => x.sid === newSid);
      expect(oldReg?.caps).toContain(THREAD_CAP);
      expect(oldReg?.caps).not.toContain(THREAD_REBIND_CAP);
      expect(newReg?.caps).toContain(THREAD_REBIND_CAP);
      // §4.8 仅 rebind-on 注册：the old agent's `thread` tool is the frozen LEGACY schema —
      // three actions, no `to` — while the rebind-on agent's carries rebind/acquire + `to`.
      const actionsOf = (s: AgentInspect) =>
        (
          (s.toolSchemas.thread as { properties?: { action?: { anyOf?: Array<{ const?: string }> } } })?.properties
            ?.action?.anyOf ?? []
        ).map((v) => v.const);
      const paramsOf = (s: AgentInspect) =>
        Object.keys((s.toolSchemas.thread as { properties?: Record<string, unknown> })?.properties ?? {}).sort();
      expect(actionsOf(await agent(oldAgent))).toEqual(["list", "subscribe", "unsubscribe"]);
      expect(paramsOf(await agent(oldAgent))).not.toContain("to");
      expect(actionsOf(await agent(newAgent))).toEqual(["list", "subscribe", "unsubscribe", "rebind", "acquire"]);

      // old agent holds topic tt1; the rebind-on agent holds topic tt2.
      await useTopic(hub, oldSid, "tt1");
      await useTopic(hub, newSid, "tt2");
      await topic(hub, "old agent event", "tt1");
      await topic(hub, "new agent event", "tt2");
      await until(
        () => agent(oldAgent),
        (s) => s.userMessages.length === 1,
        "old agent received its event",
      );
      await until(
        () => agent(newAgent),
        (s) => s.userMessages.length === 1,
        "new agent received its event",
      );
      const metaOf = (s: AgentInspect) =>
        threadFrames(s)
          .map((f) => (f.cmd as Record<string, unknown>).thread as Record<string, unknown> | undefined)
          .find((t) => t !== undefined);
      const oldMeta = metaOf(await agent(oldAgent));
      const newMeta = metaOf(await agent(newAgent));
      expect(oldMeta).toBeDefined();
      // cmd.thread to the old agent is BYTE-SHAPE-identical to the pre-feature form: h/label/sentAt,
      // no rev (G2b for the rebind cap — ThreadMeta.rev only rides when BOTH ends carry thr.rebind.v1).
      expect(Object.keys(oldMeta!).sort()).toEqual(["h", "label", "sentAt"]);
      expect("rev" in oldMeta!).toBe(false);
      expect(newMeta).toBeDefined();
      expect(typeof newMeta!.rev).toBe("number");
    },
  );
});
