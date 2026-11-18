/**
 * schedule macOS end-to-end (darwin plan §5.3, P4-B) — REAL `activate()` × fake pi on a REAL
 * darwin machine: the full agent-side lifecycle over the real platform backends (ps/sysctl
 * identity, snapshot path backend, perl flock locks — no seam is injected):
 *   create (cron/once/every) → list/get → run_now through BOTH executors (background + message) →
 *   the real session clock auto-claiming a due occurrence → history.
 *
 * The auto-claim segment deliberately uses REAL timers (a `once` task due ~1.2 s ahead) instead
 * of a FakeClock: `activate()` pins the production `systemClock` inside the wiring, and real
 * segmented timers + real perl lock children in the loop are the stronger E-MAC evidence.
 *
 * The hub segment (P4-C, real hub child): the schedule-hub.test.ts harness — a REAL `startHub`
 * child over a Unix socket × a fake Feishu (HTTP + pbbp2 websocket fakes) — whose coordinator
 * resolves identity/paths through the REAL darwin backends (ps/sysctl identity, snapshot path
 * backend; P4-A made those the platform defaults). The agent session enables `webHub`, so the
 * REAL activate() carries the sched.v1 link end to end: the hub projects this session's tasks,
 * a background report reaches fake Feishu and its receipt returns as `sched_receipts` (the agent
 * clears its pendingReports index), a dead-holder run (a REAL short-lived darwin child, judged
 * dead by the hub's ps probe) becomes ONE unknown-run notice, and across extra hub scan rounds
 * the ledger directory stays byte-and-mtime identical (the hub is read-only by construction).
 */
import { spawn, type ChildProcess } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import activate from "../../src/index.js";
import type { RunOutcome } from "../../src/core/types.js";
import { defHash, hash8, type ScheduleTask } from "../../src/schedule/core/spec.js";
import { ensureStoreRoot, openSessionStore } from "../../src/schedule/core/writer.js";
import type { SpawnServiceDeps } from "../../src/service/spawn-service.js";
import { createDarwinIdentity } from "../../src/web-hub/protocol/sched-identity.js";
import { resetSecureDomainForTests } from "../../src/secure/domain.js";
import { resolveHubPaths } from "../../src/web-hub/protocol/paths.js";
import { freezeDomain, makeFakeVault } from "../secure/helpers.js";
import { AGENT_ID_KEY, resetGlobals as resetWebHubGlobals } from "../web-hub/agent/helpers.js";
import { config, connectClient, hello } from "../web-hub/hub/helpers.js";
import {
  BASELINE,
  emit,
  fakeCtx,
  fakePi,
  resetGlobals,
  sandbox,
  SID,
  systemPromptFor,
  userTrigger,
  wakeEvent,
  type FakeCtx,
  type FakePi,
} from "./helpers/schedule-activate.js";

const harness = vi.hoisted(() => ({
  requests: [] as any[],
  outcome: undefined as undefined | ((req: any, runId: string) => RunOutcome),
  seq: 0,
  gate: undefined as undefined | Promise<void>,
  spawnDeps: undefined as SpawnServiceDeps | undefined,
}));

vi.mock("../../src/service/spawn-service.js", async (importOriginal) => {
  const original = await importOriginal<typeof import("../../src/service/spawn-service.js")>();
  return {
    ...original,
    createSpawnService: (deps: SpawnServiceDeps) => {
      harness.spawnDeps = deps;
      const runs = new Map<string, any>();
      return {
        spawn: async (req: any) => {
          harness.requests.push(req);
          const runId = `r_bg${++harness.seq}`;
          runs.set(runId, req);
          return { runId, slots: { limit: 4, inUse: 1, free: 3 } };
        },
        waitOutcome: async (runId: string) => {
          await harness.gate;
          return { kind: "settled" as const, outcome: harness.outcome!(runs.get(runId), runId) };
        },
        spawnAndWait: async () => {
          throw new Error("unused");
        },
        abort: async () => false,
        waitAll: async () => ({ settled: [], pending: [] }),
        stopChildrenOf: async () => ({ stopped: [], pending: [] }),
        resolveRun: () => ({ ok: false as const, error: "unused" }),
        resolveResume: () => ({ ok: false as const, error: "unused" }),
        snapshots: () => [],
      };
    },
  };
});

function outcomeOf(runId: string, status: RunOutcome["status"], text: string): RunOutcome {
  return {
    runId,
    status,
    text,
    turns: 1,
    durationMs: 5,
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
  };
}

const sb = sandbox("pi-sched-darwin-e2e-");
afterAll(() => sb.cleanup());
/** Real hub children of the P4-C segment — killed by afterEach even when an assertion fails mid-test. */
const hubChildren = new Set<ChildProcess>();
let sessionN = 0;
let schedDir = "";

beforeEach(() => {
  resetGlobals();
  harness.requests.length = 0;
  harness.seq = 0;
  harness.gate = undefined;
  harness.outcome = (_req, runId) => outcomeOf(runId, "completed", "darwin e2e 报告正文。");
  schedDir = join(sb.home, `sched-${++sessionN}`);
  sb.writeSettings({ ...BASELINE, schedule: { enabled: true, dir: schedDir } });
});
afterEach(() => {
  resetGlobals();
  for (const child of [...hubChildren]) {
    try {
      child.kill("SIGKILL");
    } catch {
      /* already gone */
    }
  }
  hubChildren.clear();
  // the P4-C hub segment enables webHub: release the process-global agent connection too
  resetWebHubGlobals();
  delete (globalThis as Record<symbol, unknown>)[AGENT_ID_KEY];
  resetSecureDomainForTests();
  vi.useRealTimers();
});

interface Session {
  h: FakePi;
  c: FakeCtx;
  file: string;
  tool: (params: Record<string, unknown>) => Promise<any>;
  cmd: (args: string) => Promise<void>;
  shutdown: () => Promise<void>;
  ledger: () => any;
  stateFile: string;
}

async function openSession(opts: { sid?: string; mode?: string } = {}): Promise<Session> {
  const h = fakePi();
  activate(h.pi);
  const file = join(sb.home, `s-${++sessionN}.jsonl`);
  writeFileSync(file, '{"type":"session"}\n');
  h.sessionFile.path = file;
  const c = fakeCtx(sb.home, {
    file,
    ...(opts.sid ? { sid: opts.sid } : {}),
    ...(opts.mode ? { mode: opts.mode } : {}),
  });
  await emit(h, "session_start", { type: "session_start", reason: "startup" }, c.ctx);
  const sid = opts.sid ?? SID;
  const stateFile = join(schedDir, sid, "state.json");
  return {
    h,
    c,
    file,
    stateFile,
    tool: (params) => h.tools.get("schedule")!.execute("c1", params, undefined, undefined, c.ctx),
    cmd: (args) => h.commands.get("schedule")!.handler(args, c.ctx),
    shutdown: async () => void (await emit(h, "session_shutdown", { type: "session_shutdown" }, c.ctx)),
    ledger: () => JSON.parse(readFileSync(stateFile, "utf8")),
  };
}

/** The tool result's text content (pi content blocks, not a plain string). */
function textOf(r: { content: Array<{ type: string; text?: string }> }): string {
  return r.content.map((b) => b.text ?? "").join("\n");
}

async function until(cond: () => boolean, label: string, ms = 15_000): Promise<void> {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (cond()) return;
    await new Promise((r) => setTimeout(r, 20));
  }
  throw new Error(`timeout: ${label}`);
}

/** The next UTC minute boundary as "YYYY-MM-DDTHH:mm" (a valid once `at`, cron.ts ONCE_AT_RE). */
function nextMinuteUtc(): string {
  return new Date(Math.ceil((Date.now() + 500) / 60_000) * 60_000).toISOString().slice(0, 16);
}

/** Async variant of `until` for polling RPC reads (hub child inspect/sched). */
async function untilAsync<T>(
  read: () => Promise<T> | T,
  ok: (v: T) => boolean,
  label: string,
  ms = 20_000,
): Promise<T> {
  const end = Date.now() + ms;
  for (;;) {
    const v = await read();
    if (ok(v)) return v;
    if (Date.now() > end) throw new Error(`timeout: ${label}`);
    await new Promise((r) => setTimeout(r, 50));
  }
}

/** A recursive content+mtime snapshot of the store root — the hub must never touch any of it. */
function snapshotStore(dir: string): Record<string, string> {
  const out: Record<string, string> = {};
  const walk = (at: string, prefix: string): void => {
    for (const e of readdirSync(at, { withFileTypes: true })) {
      const p = join(at, e.name);
      const rel = prefix === "" ? e.name : `${prefix}/${e.name}`;
      if (e.isDirectory()) {
        out[`${rel}/`] = `dir mtime=${statSync(p).mtimeMs}`;
        walk(p, rel);
      } else {
        const st = statSync(p);
        out[rel] = `size=${st.size} mtime=${st.mtimeMs} sha=${createHash("sha256")
          .update(readFileSync(p))
          .digest("hex")
          .slice(0, 16)}`;
      }
    }
  };
  walk(dir, "");
  return out;
}

describe.skipIf(process.platform !== "darwin")("schedule darwin e2e — real activate, real platform backends", () => {
  it("create (cron/once/every) is active at once; list and get render the tasks; run_now (background) executes through the real executor and lands a report", async () => {
    const s = await openSession();
    // cron
    const cron = await s.tool({
      action: "create",
      name: "daily",
      cron: "0 8 * * *",
      tz: "UTC",
      prompt: "summarize commits",
    });
    expect(cron.details).toMatchObject({ ok: true });
    expect(typeof cron.details.id).toBe("string");
    // once (future, minute-granular wall time in UTC — cron.ts ONCE_AT_RE)
    const once = await s.tool({
      action: "create",
      name: "one-shot",
      at: nextMinuteUtc(),
      tz: "UTC",
      prompt: "one shot",
    });
    expect(once.details).toMatchObject({ ok: true });
    // every — local-only interval (webHub off) must be accepted at once
    const every = await s.tool({
      action: "create",
      name: "tick",
      form: "message",
      every: "20m",
      prompt: "tick",
      feishu: false,
    });
    expect(every.details).toMatchObject({ ok: true });
    const ids = [cron.details.id, once.details.id, every.details.id] as string[];

    // list carries all three; get renders one with its schedule line
    const list = await s.tool({ action: "list" });
    for (const id of ids) expect(textOf(list)).toContain(id);
    const get = await s.tool({ action: "get", id: cron.details.id });
    expect(textOf(get)).toContain("daily");
    expect(s.ledger().tasks).toHaveLength(3);
    expect(s.ledger().tasks[0]).not.toHaveProperty("approval"); // active at once, no approval step

    // run_now (background executor): claim → mocked spawn child → completed + report file
    await s.tool({ action: "run_now", id: cron.details.id });
    await until(() => s.ledger().runs.some((x: any) => x.state === "completed"), "background run completed");
    const run = s.ledger().runs.find((x: any) => x.state === "completed");
    expect(run).toMatchObject({ form: "background", kind: "manual" });
    expect(harness.requests[0]).toMatchObject({
      type: "general-purpose",
      prompt: expect.stringContaining("summarize commits"),
      suppressDelivery: true,
      callerOwned: true,
      timeoutPolicy: "fixed",
    });
    expect(existsSync(join(schedDir, SID, run.reportFile))).toBe(true);
    expect(readFileSync(join(schedDir, SID, run.reportFile), "utf8")).toContain("darwin e2e 报告正文。");
    await s.shutdown();
  });

  it("run_now (message executor): queued → wake with a token → authorized trigger → settled with a report; a forged token is aborted on sight", async () => {
    const s = await openSession();
    const r = await s.tool({
      action: "create",
      name: "msg",
      form: "message",
      cron: "0 8 * * *",
      tz: "UTC",
      prompt: "say hi",
      feishu: true,
    });
    const id = r.details.id as string;
    await emit(s.h, "before_agent_start", userTrigger(), s.c.ctx); // capability: unknown → observed
    await s.tool({ action: "run_now", id });
    await until(() => s.h.sent.some((m) => m.message.details?.kind === "message"), "message wake sent");
    const wake = s.h.sent.find((m) => m.message.details?.kind === "message")!;
    expect(wake.options).toEqual({ triggerTurn: true });

    // a forged token is an orphan: aborted on sight
    await emit(
      s.h,
      "before_agent_start",
      wakeEvent({ kind: "message", token: "forged", runKey: "x", noteId: "n" }),
      s.c.ctx,
    );
    expect(s.c.aborts.n).toBe(1);

    // the authorized trigger runs the turn and settles the run with a report
    s.c.state.idle = false;
    await emit(s.h, "before_agent_start", wakeEvent(wake.message.details), s.c.ctx);
    await emit(s.h, "agent_start", { type: "agent_start" }, s.c.ctx);
    await emit(
      s.h,
      "message_start",
      { message: { role: "custom", customType: "subagent:schedule", details: wake.message.details } },
      s.c.ctx,
    );
    await emit(s.h, "context", { messages: [] }, s.c.ctx);
    await emit(
      s.h,
      "message_end",
      { message: { role: "assistant", content: [{ type: "text", text: "hi!" }] } },
      s.c.ctx,
    );
    s.c.state.idle = true;
    await emit(s.h, "agent_settled", { aborted: false }, s.c.ctx);
    await until(() => s.ledger().runs[0].state === "settled", "message run settled");
    expect(s.ledger().runs[0].reportFile).toBeDefined();
    await s.shutdown();
  });

  it(
    "the real session clock auto-claims a due once task (real timers, real perl locks); history lists the run",
    { timeout: 120_000 },
    async () => {
      const s = await openSession();
      // A once `at` is minute-granular wall time and must satisfy T >= armedSince (the stack build),
      // so arm the NEXT UTC minute boundary and let the real segmented timer fire there — at most
      // ~61 s of wall time, the price of a real activate() pinning the production system clock.
      const r = await s.tool({
        action: "create",
        name: "auto-one",
        at: nextMinuteUtc(),
        tz: "UTC",
        prompt: "auto run",
      });
      const id = r.details.id as string;
      await until(
        () => existsSync(s.stateFile) && s.ledger().runs.some((x: any) => x.taskId === id),
        "auto run claimed",
        90_000,
      );
      await until(
        () => s.ledger().runs.some((x: any) => x.taskId === id && x.state === "completed"),
        "auto run completed",
        30_000,
      );
      const run = s.ledger().runs.find((x: any) => x.taskId === id);
      expect(run).toMatchObject({ form: "background", kind: "auto", state: "completed" });
      expect(existsSync(join(schedDir, SID, run.reportFile))).toBe(true);
      // history renders the auto run; get shows it under "recent runs"
      const history = await s.tool({ action: "history" });
      expect(textOf(history)).toContain(id);
      expect(history.details).toMatchObject({ runs: expect.any(Number) });
      const get = await s.tool({ action: "get", id });
      expect(textOf(get)).toContain("recent runs");
      await s.shutdown();
    },
  );

  it("secure/locked domains still expose no schedule surface and create nothing (D8/D11)", async () => {
    const v = makeFakeVault();
    try {
      const verdict = freezeDomain(v, { mountinfo: v.unmounted });
      expect(verdict.domain.kind).toBe("locked");
      const sb2 = sandbox("pi-sched-darwin-e2e-sec-");
      try {
        sb2.writeSettings({ ...BASELINE, schedule: { enabled: true } });
        const h = fakePi();
        const c = fakeCtx(sb2.home);
        activate(h.pi);
        expect(h.tools.has("schedule")).toBe(false);
        expect(h.commands.has("schedule")).toBe(false);
        await emit(h, "session_start", { type: "session_start", reason: "startup" }, c.ctx);
        const prompt = await systemPromptFor(h, c.ctx);
        expect(prompt).not.toContain("pi_schedules");
        expect(existsSync(join(sb2.home, ".pi", "agent", "schedules"))).toBe(false);
        await emit(h, "session_shutdown", { type: "session_shutdown" }, c.ctx);
      } finally {
        resetGlobals();
        sb2.cleanup();
      }
    } finally {
      resetSecureDomainForTests();
      v.cleanup();
    }
  });
});

// ----------------------------------------------------------------- P4-C: the real hub child

/** The schedule-hub.test.ts harness (real startHub over the hub's real unix socket, fake
 *  Feishu HTTP + pbbp2 websocket), plus a `sched` op reading the schedule coordinator's
 *  status/projection — captured off FrontendDeps before the frontend is built. */
const HUB_CHILD = String.raw`
const root = process.cwd();
const load = (p) => import(root + "/" + p);
const { startHub } = await load("src/web-hub/hub/hub.ts");
const { createHttpFrontend } = await load("src/web-hub/hub/http.ts");
const { createCredentialStore } = await load("src/web-hub/hub/feishu/credentials.ts");
const { resolveHubPaths } = await load("src/web-hub/protocol/paths.ts");
const { normalizeFeishuBotHubConfig } = await load("src/web-hub/protocol/feishu.ts");
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
let __sched, __registry;
const hub = await startHub(cfg, (deps) => { __sched = deps.schedules; __registry = deps.registry; return createHttpFrontend(deps); }, {feishuSeams: {
  fetch: fake.fetch,
  webSocket: () => new WebSocket(ws.url)
}});
if ("exists" in hub) throw new Error("unexpected existing hub");
if (!__sched) throw new Error("schedule coordinator missing (config.schedule absent?)");
const reply = (id, value) => process.send?.({id, value});
process.on("message", async (m) => {
  try {
    if (m.op === "inspect") {
      reply(m.id, {sent: fake.sent, livePeers: ws.peers.filter(p => !p.closed).length, caps: hub.info.caps, regs: (__registry?.list?.() ?? []).map(a => ({sid: a.session?.sessionId, connected: __registry.isConnected(a.agentKey)}))});
    } else if (m.op === "sched") {
      reply(m.id, {status: __sched.status(), payload: __sched.snapshot(m.sid)});
    } else if (m.op === "stop") {
      await hub.close("test"); await ws.dispose(); reply(m.id, true); process.disconnect();
    } else throw new Error("unknown fixture op");
  } catch (e) { process.send?.({id: m.id, error: String(e)}); }
});
process.send?.({ready: true});
`;

interface HubSent {
  messageId: string;
  kind: string;
  body: Record<string, unknown>;
}
interface HubInspect {
  sent: HubSent[];
  livePeers: number;
  caps: string[];
  regs: Array<{ sid?: string; connected: boolean }>;
}
interface HubSched {
  status: { pendingSeen: number; counters: Record<string, number>; degraded?: string };
  payload: {
    sessions: Array<{
      sessionId: string;
      degraded?: string;
      tasks: Array<{ task: { name: string } }>;
      runs: Array<{ taskId: string; runKey?: string; state: string }>;
    }>;
  };
}

interface HubChild {
  /** Fresh 0700 XDG runtime dir owning the (short) unix socket — BOTH processes must resolve
   *  the same candidate: the sandbox home sits deep under the macOS worktree tmp, so the
   *  home-derived socket path exceeds SOCKET_PATH_MAX_BYTES and both sides would fall back to
   *  the shared `/tmp/pi-webhub-<uid>` dir (collision-prone under a parallel test pool). */
  xdg: string;
  inspect(): Promise<HubInspect>;
  sched(sid: string): Promise<HubSched>;
  nudge(sid: string): void;
  stop(): Promise<void>;
  stderr(): string;
}

/** Boot the real hub child on `home` with the schedule store at `storeDir` (the same store root
 *  the activate()'d agent session writes). Also connects a RAW nudge client whose only job is
 *  `sched_changed` — the test can force targeted hub re-scans deterministically, never waiting
 *  for the hub's 60 s full-scan interval. The caller MUST set `process.env.XDG_RUNTIME_DIR` to
 *  `hub.xdg` while the agent session runs (and restore it afterwards). */
async function bootHubChild(home: string, storeDir: string): Promise<HubChild> {
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
  const xdg = mkdtempSync(join(tmpdir(), "p4c-xdg-")); // 0700, test-owned, unique per run
  const child: ChildProcess = spawn(process.execPath, ["--import", "tsx", "--input-type=module", "-e", HUB_CHILD], {
    cwd: resolve("."),
    stdio: ["ignore", "ignore", "pipe", "ipc"],
    env: {
      ...process.env,
      HOME: home,
      XDG_RUNTIME_DIR: xdg,
      PI_CODING_AGENT_DIR: join(home, ".pi/agent"),
      SCHED_CONFIG: JSON.stringify(cfg),
    },
  });
  hubChildren.add(child);
  let stderr = "";
  child.stderr!.on("data", (b: Buffer) => (stderr += b.toString()));
  const exited = new Promise<void>((done) => child.once("close", () => done()));
  let rid = 0;
  const rpc = <T>(op: string, arg?: Record<string, unknown>): Promise<T> =>
    new Promise<T>((res, rej) => {
      const id = ++rid;
      const timer = setTimeout(() => {
        child.off("message", onMsg);
        rej(new Error(`rpc ${op} timeout`));
      }, 15_000);
      timer.unref?.();
      const onMsg = (m: { id: number; value?: T; error?: string }) => {
        if (m.id !== id) return;
        clearTimeout(timer);
        child.off("message", onMsg);
        m.error !== undefined ? rej(new Error(m.error)) : res(m.value as T);
      };
      child.on("message", onMsg);
      child.send({ id, op, ...(arg ?? {}) }, (e) => {
        if (e) {
          clearTimeout(timer);
          child.off("message", onMsg);
          rej(e);
        }
      });
    });
  // ONE persistent listener flips a flag — never await a per-poll listener promise (it may never
  // resolve) and never leak listeners across polls (the fabric-thread-e2e precedent).
  const readyState = { ready: false, closed: false };
  child.on("message", (m: { ready?: boolean }) => {
    if (m?.ready === true) readyState.ready = true;
  });
  child.once("close", () => (readyState.closed = true));
  await untilAsync(
    () => readyState,
    (s) => s.ready || s.closed,
    `hub child ${readyState.closed ? `exited: ${stderr}` : "ready"}`,
    30_000,
  );
  expect(readyState.ready, `hub child failed to start: ${stderr}`).toBe(true);
  const inspect = () => rpc<HubInspect>("inspect");
  await untilAsync(inspect, (s) => s.livePeers === 1, "feishu websocket open", 20_000);
  const sched = (sid: string) => rpc<HubSched>("sched", { sid });
  // the nudge client: hello only (never a session frame — it must not shadow the agent's view)
  const paths = resolveHubPaths({ home, uid: process.getuid?.() ?? 0, xdgRuntimeDir: xdg });
  const nudge = await connectClient(paths.socketPath);
  nudge.send(
    hello({ agentId: { pid: 4242, nonce: "nonce-sched-P4C-0123456789" }, epoch: "p4c-nudge", cwd: "/tmp/p4c" }),
  );
  await nudge.waitFrame((f) => f.t === "hello_ack");
  const stop = async (): Promise<void> => {
    hubChildren.delete(child);
    nudge.sock.destroy();
    if (child.connected) await rpc("stop").catch(() => undefined);
    await Promise.race([exited, new Promise((r) => setTimeout(r, 10_000))]);
    child.kill("SIGKILL");
    rmSync(xdg, { recursive: true, force: true });
  };
  return {
    xdg,
    inspect,
    sched,
    nudge: (sid: string) => nudge.send({ t: "sched_changed", sessionId: sid }),
    stop,
    stderr: () => stderr,
  };
}

// P4-C (darwin plan §5.3 end): the real-hub-child segment. P4-A landed — the hub resolves its
// identity/paths per platform (darwin: ps/sysctl identity, snapshot path backend), so a real
// darwin hub child reads the darwin ledger instead of fail-closing on a missing /proc identity.
describe.skipIf(process.platform !== "darwin")("schedule darwin e2e — real hub child (P4-C)", () => {
  it("hub projection / receipt / unknown prediction / zero ledger writes", { timeout: 120_000 }, async () => {
    // webHub on (control plane): the REAL activate() now carries the schedule router + the
    // agent→hub link, so receipts arrive as sched_receipts over the real connection.
    sb.writeSettings({
      ...BASELINE,
      webHub: { enabled: true, autoStart: false, port: 0, idleExitMinutes: 10 },
      schedule: { enabled: true, dir: schedDir },
    });
    harness.outcome = (_req, runId) => outcomeOf(runId, "completed", "darwin hub 段报告正文 P4C。");

    // ---- the store root must exist before the hub pins it at start (resolveStoreRoot) — the
    // production order has the agent create it (wire.ts hubConfig()), so mirror that through the
    // real darwin backend here.
    ensureStoreRoot(schedDir);

    // ---- the real hub child, booted FIRST so the agent session connects at once. The parent
    // must resolve the SAME socket candidate ⇒ pin XDG_RUNTIME_DIR for the activation window.
    const hub = await bootHubChild(sb.home, schedDir);
    const savedXdg = process.env.XDG_RUNTIME_DIR;
    process.env.XDG_RUNTIME_DIR = hub.xdg;
    try {
      // the hub's declared caps carry sched.v1 (the coordinator exists on the darwin backends)
      const boot = await hub.inspect();
      expect(boot.caps).toContain("sched.v1");

      // ---- the REAL activate() session (fake pi): the agent links to the hub socket and
      // registers THIS session — the registry row is the deterministic link-live proof (the
      // ledger itself only materialises at the first task write, so the projection is polled
      // after that instead).
      const s = await openSession();
      await untilAsync(
        hub.inspect,
        (x) => x.regs.some((row) => row.sid === SID && row.connected),
        "agent session registered on the hub (agent link live)",
      );

      // ---- create (feishu on) + run_now through the real background executor
      const r = await s.tool({
        action: "create",
        name: "hub-日报",
        form: "background",
        cron: "0 8 * * *",
        tz: "UTC",
        prompt: "hub 段汇总",
        feishu: true,
      });
      const id = r.details.id as string;
      await s.tool({ action: "run_now", id });
      await until(
        () => s.ledger().runs.some((x: any) => x.taskId === id && x.state === "completed"),
        "hub-segment background run completed",
      );
      expect(s.ledger().pendingReports).toHaveLength(1);

      // ---- the hub discovers the report (sched_changed from the agent's own commit) and
      // pushes ONE Feishu card with the report body; the receipt returns as sched_receipts
      // over the REAL agent link and the agent clears its pendingReports index.
      const pushed = await untilAsync(
        hub.inspect,
        (x) => x.sent.some((m) => JSON.stringify(m.body).includes("darwin hub 段报告正文 P4C")),
        "report pushed to fake feishu",
      );
      expect(pushed.sent.filter((m) => JSON.stringify(m.body).includes("darwin hub 段报告正文 P4C"))).toHaveLength(1);
      await until(() => s.ledger().pendingReports.length === 0, "pending index receipt-cleaned", 20_000);

      // ---- hub projection: the session's task + the completed run (the ledger materialised
      // with the task write; the agent's own sched_changed nudged the hub into scanning it)
      const proj = await untilAsync(
        () => hub.sched(SID),
        (p) =>
          p.payload.sessions.length === 1 &&
          p.payload.sessions[0]!.sessionId === SID &&
          p.payload.sessions[0]!.tasks.some((t) => t.task.name === "hub-日报"),
        "hub projection carries the task",
      );
      expect(proj.status.degraded).toBeUndefined();
      expect(proj.payload.sessions[0]!.runs.some((x) => x.taskId === id && x.state === "completed")).toBe(true);

      // ---- unknown-run prediction: a REAL short-lived darwin child becomes a dead holder
      // (identity via ps lstart), written into the ledger through the REAL darwin writer
      // (perl flock) as a non-terminal manual run. The hub's ps probe judges it dead and ONE
      // unknown notice rides the hour's card — while the ledger keeps the run untouched.
      const selfId = createDarwinIdentity().readSelf();
      expect(selfId).toBeDefined();
      const ghost = spawn(process.execPath, ["-e", "setTimeout(() => {}, 1500)"]);
      const ghostStart = createDarwinIdentity().probe.startOf(ghost.pid!);
      await new Promise<void>((done) => ghost.once("exit", () => done()));
      expect(typeof ghostStart).toBe("number");
      const task = s.ledger().tasks.find((t: any) => t.id === id) as ScheduleTask;
      const runKey = `${id}@m-${hash8("p4c-unknown-0123456789")}`;
      const root = ensureStoreRoot(schedDir);
      const store = openSessionStore({
        root,
        sessionId: SID,
        self: selfId!,
        epoch: "p4c-e2e",
        lockTimeoutMs: 5_000,
      });
      const tx = await store.transact((draft) => {
        if (draft.runs.some((x) => x.runKey === runKey)) return { value: "dup", write: false };
        draft.runs.push({
          runKey,
          taskId: id,
          kind: "manual",
          form: "background",
          scheduledAt: Date.now(),
          defHash: defHash(task),
          state: "running",
          holder: {
            pid: ghost.pid!,
            start: ghostStart as number,
            host: selfId!.host,
            boot: selfId!.boot,
            epoch: "p4c-ghost",
          },
          startedAt: Date.now(),
          note: "none",
        });
        return { value: undefined, write: true };
      });
      expect(tx).toMatchObject({ ok: true, wrote: true });
      hub.nudge(SID); // targeted rescan NOW — no 60 s full-scan wait
      const unknown = await untilAsync(
        hub.inspect,
        (x) => x.sent.some((m) => JSON.stringify(m.body).includes("定时任务结果未知")),
        "unknown-run notice pushed",
      );
      const unknownCards = unknown.sent.filter((m) => JSON.stringify(m.body).includes("定时任务结果未知"));
      expect(unknownCards).toHaveLength(1);
      expect(JSON.stringify(unknownCards[0]!.body)).toContain("hub-日报");
      // the hub only PREDICTS — the ledger still holds the run as `running`
      expect(s.ledger().runs.some((x: any) => x.runKey === runKey && x.state === "running")).toBe(true);

      // ---- zero ledger writes: with every agent-side write settled, two more hub scan rounds
      // (nudged, and confirmed via the scan counter) leave the store directory byte- and
      // mtime-identical — the hub is read-only on the agent's ledger by construction.
      const snapA = snapshotStore(schedDir);
      const before = (await hub.sched(SID)).status.counters.scans ?? 0;
      hub.nudge(SID);
      hub.nudge(SID);
      const finalSched = await untilAsync(
        () => hub.sched(SID),
        (p) => (p.status.counters.scans ?? 0) >= before + 2,
        "hub re-scanned the ledger twice",
      );
      await new Promise((r) => setTimeout(r, 300)); // any (buggy) write would have landed by now
      expect(snapshotStore(schedDir)).toEqual(snapA);
      // the receipt leg really went over the live agent link
      expect(finalSched.status.counters.receiptsPushed ?? 0).toBeGreaterThanOrEqual(1);

      await s.shutdown();
    } finally {
      if (savedXdg === undefined) delete process.env.XDG_RUNTIME_DIR;
      else process.env.XDG_RUNTIME_DIR = savedXdg;
      await hub.stop();
    }
  });
});
