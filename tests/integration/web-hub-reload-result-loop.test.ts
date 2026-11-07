/**
 * #30 reload-result plan §3 C2 — the cross-layer closed loop, REAL frames end to end:
 *
 *   real agent wiring (`wireWebHub`, real composition: wrapCommandApi + DeferredReloadController
 *   + reload command port + /agent status command) over a REAL agent-server unix socket →
 *   real registry (reclaim, epoch change) → real HTTP/SSE → the unmodified UI `reduce` → the
 *   real `useOutdatedReload` composable → the coordinator.
 *
 * The takeover is a REAL second activation: `vi.resetModules()` + dynamic re-import stands in
 * for the module re-evaluation a /reload performs, so `connection.ts`'s `MODULE_INSTANCE` is
 * fresh — `acquireConnection` hands the old connection over (`bye{handover}`), the new hello
 * carries a NEW epoch, and the registry reclaims (agent_up + gap). The tracked record itself
 * lives in the `Symbol.for("pi-subagent:web-hub:reload-track")` store, which survives the
 * re-evaluation exactly like a real /reload — the started fact and the handover marker from
 * activation 1 meet activation 2's `session_start{reload}` takeover validation, and the
 * completed fact rides the new connection's hello_ack slot replay back to the UI.
 *
 * Positive case (plan §3 C2): deferred → parked → started → second-activation takeover (epoch
 * change, via reclaim) → completed → done, settling BEFORE the 90 s effect timer. The card's
 * pluginVersion deliberately stays outdated the whole time (activation 2's buildInfo still
 * reports the old version), so the done can ONLY come from the completed fact matching the hub
 * version — the new mechanism, isolated from #23's version-到位 fallback.
 *
 * Control group: the same stack with the port's phase sink REMOVED (the pre-#30 agent's wire —
 * no `status.reload` field ever, byte-level). It settles exactly the way
 * `web-hub-outdated-reload-loop.test.ts` pinned the old loop: the reload still happens agent-
 * side, the reclaim's agent_up carries the new version, and the UI converges done through the
 * version signal alone.
 */
import { readFileSync } from "node:fs";
import net from "node:net";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { request as httpRequest } from "node:http";
import { nextTick, ref, type Ref } from "vue";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ExtensionAPI, RegisteredCommand } from "@earendil-works/pi-coding-agent";
import { wrapCommandApi } from "../../src/commands/capture.js";
import { createStatusCommand } from "../../src/commands/status.js";
import { DeferredReloadController } from "../../src/reload/defer.js";
import { createReloadCommandPort } from "../../src/reload/command-port.js";
import { wireWebHub as wireWebHubA, type WebHubControl, type WebHubDeps } from "../../src/web-hub/agent/index.js";
import { parseSlashCommand } from "../../src/web-hub/agent/slash.js";
import { createCommandRouter } from "../../src/web-hub/hub/commands.js";
import { createHttpFrontend } from "../../src/web-hub/hub/http.js";
import { createRegistry } from "../../src/web-hub/hub/registry.js";
import { createAgentServer } from "../../src/web-hub/hub/agent-server.js";
import type { CmdOutcome, ControlHandle, HubHandle, HubState } from "../../src/web-hub/ui/src/types.js";
import { initialState, reduce } from "../../src/web-hub/ui/src/logic/state.js";
import { newCmdId, outcomeFromHttp } from "../../src/web-hub/ui/src/logic/control.js";
import { useOutdatedReload } from "../../src/web-hub/ui/src/composables/useOutdatedReload.js";
import { fakeCtx, fakePi, pathsIn, resetGlobals, SETTINGS, tmpDir, waitUntil } from "../web-hub/agent/helpers.js";
import { config as hubConfig, memLog } from "../web-hub/hub/helpers.js";
import { fakeDeps, login, makeTmp, parseSseBlock, postJson, type SseEvent } from "../web-hub/http/helpers.js";

const here = dirname(fileURLToPath(import.meta.url));

/** The repo's own version — `packageVersionSync()`'s value in tests; the hub reports the same,
 *  so the completed fact's version matches ⇒ done (Q2's equality branch). */
const REPO_VERSION = (JSON.parse(readFileSync(join(here, "..", "..", "package.json"), "utf8")) as { version: string })
  .version;
/** Activation 1 (and the positive case's activation 2) deliberately report an OLD version, so
 *  the card never reaches the hub version and `isSettled` stays false — done can only come from
 *  the completed fact. compareVersions("0.0.1", REPO_VERSION) < 0 ⇒ outdated from the start. */
const OLD_VERSION = "0.0.1";
/** Fixed base clock (registry + UI share it; the agent keeps its own, monotone). */
const T0 = 1_700_200_000_000;

const TRACK_KEY = Symbol.for("pi-subagent:web-hub:reload-track");
const wipeReloadTrack = (): void => {
  delete (globalThis as Record<symbol, unknown>)[TRACK_KEY];
};

// ---------------------------------------------------------------------------
// A · hub fixture: real registry + real command router + real HTTP/SSE + REAL agent-server
// ---------------------------------------------------------------------------

interface HubFixture {
  port: number;
  cookie: string;
  clock: { t: number };
  sockPath: string;
  sse: {
    text(): string;
    events: SseEvent[];
    clientId(): string | undefined;
    waitFor(pred: (e: SseEvent) => boolean, ms?: number): Promise<SseEvent>;
    close(): void;
  };
  cleanup(): Promise<void>;
}

async function startHub(version: string = REPO_VERSION): Promise<HubFixture> {
  const tmp = makeTmp("pwh-rr-loop-");
  const clock = { t: T0 };
  const deps = fakeDeps(tmp.dir);
  const reg = createRegistry({ now: () => clock.t, log: memLog(), pidAlive: () => true, hubVersion: version });
  const router = createCommandRouter({ registry: reg, log: memLog(), now: () => clock.t });
  const fe = createHttpFrontend({
    ...deps,
    now: () => clock.t,
    info: () => ({
      version,
      buildId: `${version}@rrloop`,
      pid: 1,
      startedAt: 1,
      proto: { major: 1, minor: 2 },
      caps: ["cmd.v1", "command.v1"],
    }),
    registry: reg,
    bus: reg.bus,
    commands: router,
  });
  const { port } = await fe.listen();
  // the REAL agent socket on the same registry — hub.ts's own composition
  const sockPath = join(tmp.dir, "hub.sock");
  const server = net.createServer();
  await new Promise<void>((r) => server.listen(sockPath, () => r()));
  const agentServer = createAgentServer(server, {
    registry: reg,
    config: hubConfig({ pluginVersion: version, buildId: `${version}@hub` }),
    log: memLog(),
    now: () => clock.t,
    httpPort: () => port,
  });
  const cookie = await login(port, deps.paths.tokenFile);
  const sse = await openRawSse(port, cookie);
  return {
    port,
    cookie,
    clock,
    sockPath,
    sse,
    cleanup: async () => {
      sse.close();
      await agentServer.close();
      await new Promise<void>((r) => server.close(() => r()));
      await fe.close();
      tmp.cleanup();
    },
  };
}

/** Real `/api/events` connection: response bytes accumulated verbatim + parsed events. */
function openRawSse(port: number, cookie: string): Promise<HubFixture["sse"]> {
  return new Promise((resolve, reject) => {
    const req = httpRequest(
      {
        host: "127.0.0.1",
        port,
        path: "/api/events",
        headers: { Cookie: cookie, Accept: "text/event-stream" },
        agent: false,
      },
      (res) => {
        if (res.statusCode !== 200) {
          reject(new Error(`sse connect failed: ${res.statusCode}`));
          return;
        }
        let raw = "";
        let buf = "";
        const events: SseEvent[] = [];
        const waiters: Array<() => void> = [];
        const notify = (): void => {
          for (const w of [...waiters]) w();
        };
        const conn: HubFixture["sse"] = {
          text: () => raw,
          events,
          clientId: () => events.find((e) => e.event === "hello")?.data?.clientId as string | undefined,
          waitFor(pred, ms = 8_000) {
            return new Promise((res2, rej2) => {
              const check = (): boolean => {
                const hit = events.find(pred);
                if (hit !== undefined) {
                  cleanup();
                  res2(hit);
                  return true;
                }
                return false;
              };
              const timer = setTimeout(() => {
                cleanup();
                rej2(new Error(`waitFor timeout; got ${events.map((e) => e.event).join(",")}`));
              }, ms);
              const cleanup = (): void => {
                clearTimeout(timer);
                const i = waiters.indexOf(onEv);
                if (i >= 0) waiters.splice(i, 1);
              };
              const onEv = (): void => {
                check();
              };
              if (!check()) waiters.push(onEv);
            });
          },
          close: () => req.destroy(),
        };
        res.setEncoding("utf8");
        res.on("data", (chunk: string) => {
          raw += chunk;
          buf += chunk;
          let idx: number;
          while ((idx = buf.indexOf("\n\n")) >= 0) {
            const block = buf.slice(0, idx);
            buf = buf.slice(idx + 2);
            const ev = parseSseBlock(block);
            if (ev !== undefined) events.push(ev);
          }
          notify();
        });
        res.on("error", () => undefined);
        resolve(conn);
      },
    );
    req.on("error", reject);
    req.end();
  });
}

// ---------------------------------------------------------------------------
// B · agent activation fixture (activation 1: STATIC imports; activation 2: the dynamically
//     re-imported module instance below). Composition = src/index.ts's own, with test doubles.
// ---------------------------------------------------------------------------

interface RunRow {
  runId: string;
  status: string;
}

interface Activation1 {
  agentKey(): Promise<string>;
  ctl: DeferredReloadController;
  runs: { rows: RunRow[] };
  clock: { v: number };
  /** How many times ctx.reload ran (the shutdown{reload} fired inside). */
  reloaded: { count: number };
  cleanup(): void;
}

/** Real `net.connect` to the hub's agent socket (the fabric-thread-e2e pattern). */
function realNetConnect(): typeof net.connect {
  return ((...args: unknown[]) => net.connect(...(args as never))) as typeof net.connect;
}

function bootActivation1(hub: HubFixture, opts: { sink: boolean; agentHome: string }): Activation1 {
  resetGlobals();
  const tmp = tmpDir("wh-rr-act1-");
  const runs: { rows: RunRow[] } = { rows: [{ runId: "r-rr-loop-1", status: "running" }] };
  const clock = { v: T0 };
  const reloaded = { count: 0 };
  const raw = fakePi();
  const registered = new Map<string, Omit<RegisteredCommand, "name" | "sourceInfo">>();
  const { ctx } = fakeCtx({ leaf: "L1", idle: true });
  (ctx as unknown as { cwd: string }).cwd = tmp.dir;
  const commandCtx: Record<string, unknown> = ctx;
  const basePi = {
    ...raw.pi,
    getCommands: () => [{ name: "agent", source: "extension" }],
    registerCommand(name: string, command: Omit<RegisteredCommand, "name" | "sourceInfo">) {
      registered.set(name, command);
    },
    sendUserMessage(text: string) {
      const parsed = parseSlashCommand(text);
      if (parsed === undefined) return;
      const command = registered.get(parsed.name);
      if (command !== undefined)
        void Promise.resolve((command.handler as (a: string, c: unknown) => unknown)(parsed.args, commandCtx)).catch(
          () => undefined,
        );
    },
  };
  const captureRef: { current?: unknown } = {};
  const recorderRef: { current?: unknown } = {};
  const owned = new Set<string>();
  const pi = wrapCommandApi(
    basePi as unknown as ExtensionAPI,
    () => captureRef.current as never,
    owned,
    new Map(),
    () => recorderRef.current as never,
  );
  const ctl = new DeferredReloadController({
    fire: () => pi.sendUserMessage("/agent reload fire", { deliverAs: "followUp", expandPromptTemplates: true }),
  });
  const deps: WebHubDeps = {
    settings: SETTINGS,
    // the FLEET slot wants RunSnapshot shapes — a minimal row crashes projectFleet's view
    // model; [] keeps the wire clean (the park condition is the status command's own
    // query.list count, and the UI parks on the deferred FACT anyway — U3's ordering)
    fleet: () => [] as never,
    env: { HOME: opts.agentHome },
    paths: pathsIn(dirname(hub.sockPath)),
    netConnect: realNetConnect(),
    buildInfo: async () => ({ pluginVersion: OLD_VERSION, buildId: `${OLD_VERSION}@rrloop` }),
    argv1: "/nonexistent/pi",
    now: () => clock.v,
    ownedCommandNames: owned,
    gitRunner: (async () => ({ code: 128, stdout: "", stdoutCapped: false, stderr: "not a repo" })) as never,
  };
  const control: WebHubControl = wireWebHubA(pi, deps);
  captureRef.current = control.capture;
  if (control.recorder !== undefined) recorderRef.current = control.recorder;
  const port = createReloadCommandPort(
    () => ctl,
    pi,
    opts.sink ? (event) => control.onReloadPhase?.(event) : undefined, // sink off ⇒ the pre-#30 wire
  );
  pi.registerCommand(
    "agent",
    createStatusCommand({
      query: { list: () => runs.rows } as never,
      orphans: { register: () => undefined, recent: [], totalCount: 0 },
      notifier: { enqueue: () => undefined },
      reload: port,
    } as never),
  );
  // pi's AgentSession.reload: shutdown{reload} lands INSIDE the awaited reload() — the second
  // activation's session_start{reload} is fired separately below (a real /reload's shape).
  commandCtx.reload = async () => {
    reloaded.count += 1;
    raw.fire("session_shutdown", { type: "session_shutdown", reason: "reload" }, ctx);
  };
  commandCtx.waitForIdle = async () => undefined;
  return {
    ctl,
    runs,
    clock,
    reloaded,
    agentKey: async () => {
      raw.fire("session_start", { type: "session_start", reason: "startup" }, ctx);
      await hub.sse.waitFor((e) => e.event === "agent_up");
      return (hub.sse.events.find((e) => e.event === "agent_up")?.data?.agent?.agentKey as string) ?? "";
    },
    cleanup: () => {
      resetGlobals();
      tmp.cleanup();
    },
  };
}

/** Activation 2 — a REAL second module instance (what a /reload re-evaluates): fresh
 *  MODULE_INSTANCE ⇒ new epoch, handover of the old connection, same process-global
 *  reload-track store. Minimal wiring: it only needs to take over and replay its slots. */
async function bootActivation2(
  hub: HubFixture,
  opts: { buildVersion: string; agentHome: string },
): Promise<{ goLive(): Promise<string> }> {
  vi.resetModules();
  const mod = (await import("../../src/web-hub/agent/index.js")) as typeof import("../../src/web-hub/agent/index.js");
  const raw = fakePi();
  const tmp = tmpDir("wh-rr-act2-");
  const { ctx } = fakeCtx({ leaf: "L1", idle: true }); // SAME session identity as activation 1
  (ctx as unknown as { cwd: string }).cwd = tmp.dir;
  const clock = { v: T0 };
  mod.wireWebHub(raw.pi, {
    settings: SETTINGS,
    fleet: () => [] as never,
    env: { HOME: opts.agentHome },
    paths: pathsIn(dirname(hub.sockPath)),
    netConnect: realNetConnect(),
    buildInfo: async () => ({ pluginVersion: opts.buildVersion, buildId: `${opts.buildVersion}@rrloop2` }),
    argv1: "/nonexistent/pi",
    now: () => clock.v,
    gitRunner: (async () => ({ code: 128, stdout: "", stdoutCapped: false, stderr: "not a repo" })) as never,
  });
  return {
    async goLive() {
      raw.fire("session_start", { type: "session_start", reason: "reload" }, ctx);
      const up = await hub.sse.waitFor((e) => e.event === "agent_up" && e.data?.agent?.epoch !== undefined);
      return up.data!.agent!.agentKey as string;
    },
  };
}

// ---------------------------------------------------------------------------
// C · UI fixture: real reduce + real composable; SSE 原文喂入; send 走真实 /api/cmd
// ---------------------------------------------------------------------------

interface UiLoop {
  handle: ReturnType<typeof useOutdatedReload>;
  state: Ref<HubState>;
  sent: Array<{ agentKey: string; args: string; id: string }>;
  pump(): Promise<void>;
  timers: Map<number, { fn: () => void; ms: number }>;
  fireTimers(ms: number): void;
}

async function startUi(hub: HubFixture): Promise<UiLoop> {
  const state = ref(initialState()) as Ref<HubState>;
  const sent: Array<{ agentKey: string; args: string; id: string }> = [];
  const control = {
    runCommand: async (
      agentKey: string,
      _name: string,
      args: string,
      opts?: { confirm?: boolean; id?: string },
    ): Promise<CmdOutcome> => {
      const id = opts?.id ?? newCmdId();
      sent.push({ agentKey, args, id });
      const res = await postJson(
        hub.port,
        "/api/cmd",
        { agentKey, id, op: "command", name: "agent", args, confirm: true },
        { Cookie: hub.cookie, Origin: `http://127.0.0.1:${hub.port}` },
      );
      let body: unknown;
      try {
        body = JSON.parse(res.body);
      } catch {
        body = undefined;
      }
      const retryAfter = res.headers["retry-after"];
      const ra = retryAfter === undefined ? undefined : Number(Array.isArray(retryAfter) ? retryAfter[0] : retryAfter);
      return outcomeFromHttp(
        res.status,
        body,
        ra !== undefined && Number.isFinite(ra) && ra >= 0 ? ra : undefined,
      ) as CmdOutcome;
    },
  } as unknown as ControlHandle;
  const hubHandle = { state, dispatch: () => {}, control } as unknown as HubHandle;
  const timers = new Map<number, { fn: () => void; ms: number }>();
  let nextTimer = 1;
  const handle = useOutdatedReload({
    hub: hubHandle,
    storage: null,
    setTimeout: (fn: () => void, ms: number) => {
      const id = nextTimer++;
      timers.set(id, { fn, ms });
      return id;
    },
    clearTimeout: (h: unknown) => void timers.delete(h as number),
    now: () => hub.clock.t,
  });
  let consumed = 0;
  const flush = async (): Promise<void> => {
    for (let i = 0; i < 6; i++) await Promise.resolve();
    await nextTick();
    for (let i = 0; i < 6; i++) await Promise.resolve();
    await nextTick();
  };
  return {
    handle,
    state,
    sent,
    timers,
    fireTimers: (ms: number) => {
      for (const [id, t] of [...timers]) {
        if (t.ms === ms) {
          timers.delete(id);
          t.fn();
        }
      }
    },
    pump: async () => {
      const events = hub.sse.events;
      while (consumed < events.length) {
        const e = events[consumed++]!;
        state.value = reduce(state.value, { event: e.event, data: e.data, id: e.id, at: hub.clock.t });
      }
      await flush();
    },
  };
}

const cleanups: Array<() => unknown> = [];

/** Poll loop that keeps pumping SSE events into the UI (the harness feeds reduce manually —
 *  without pumping between polls, a phase wait would deadlock on its own event source). */
async function pumpUntil(ui: UiLoop, pred: () => boolean, ms: number, label: string): Promise<void> {
  const start = Date.now();
  for (;;) {
    await ui.pump();
    if (pred()) return;
    if (Date.now() - start > ms) throw new Error(`pumpUntil timeout: ${label}`);
    await new Promise((r) => setTimeout(r, 20));
  }
}
afterEach(async () => {
  vi.useRealTimers();
  for (const fn of cleanups.splice(0)) await fn();
  resetGlobals();
  wipeReloadTrack();
});

// ---------------------------------------------------------------------------

/** boot hub + UI + activation 1 and bring the card up (commands slot seen by the UI). */
async function bringUp(
  opts: { hubVersion?: string; sink?: boolean } = {},
): Promise<{ hub: HubFixture; ui: UiLoop; act1: Activation1; agentKey: string; firstEpoch: string }> {
  const hub = await startHub(opts.hubVersion);
  cleanups.push(() => hub.cleanup());
  const ui = await startUi(hub);
  const act1 = bootActivation1(hub, { sink: opts.sink !== false, agentHome: dirname(hub.sockPath) });
  cleanups.push(() => act1.cleanup());
  const agentKey = await act1.agentKey();
  await hub.sse.waitFor((e) => e.event === "commands" && e.data?.agentKey === agentKey);
  await ui.pump();
  const firstEpoch = hub.sse.events.find((e) => e.event === "agent_up")?.data?.agent?.epoch as string;
  return { hub, ui, act1, agentKey, firstEpoch };
}

/** request → parked(deferred) → runs settle → started ⇒ awaiting (the shared prefix of the
 *  positive-path cases; asserts the cross-layer cmdId attribution on the way). */
async function driveToStarted(ctx: {
  hub: HubFixture;
  ui: UiLoop;
  act1: Activation1;
  agentKey: string;
}): Promise<void> {
  const { hub, ui, act1, agentKey } = ctx;
  ui.handle.request(agentKey);
  await waitUntil(() => ui.sent.length === 1, 5_000, "send dispatched");
  await pumpUntil(
    ui,
    () => ui.handle.entryOf(agentKey).phase === "parked" && ui.handle.entryOf(agentKey).waitingFor === "runs",
    8_000,
    "parked with waitingFor runs",
  );
  expect(hub.sse.text()).toContain(`"cmdIds":["${ui.sent[0]!.id}"]`);
  expect(hub.sse.text()).toContain('"state":"deferred"');
  act1.runs.rows = [];
  act1.ctl.handleRunSettled(0);
  await pumpUntil(ui, () => ui.handle.entryOf(agentKey).phase === "awaiting", 8_000, "awaiting on started");
  await ui.pump();
  expect([...ui.timers.values()].some((t) => t.ms === 90_000)).toBe(true);
  expect(hub.sse.text()).toContain('"state":"started"');
}

describe("#30 C2: reload-result closed loop (real wiring → agent socket → registry → SSE → UI)", () => {
  it("正例：deferred→parked→started→第二个 activation 接管（epoch 变化、走 reclaim）→completed→done，早于 90s", async () => {
    wipeReloadTrack();
    const { hub, ui, act1, agentKey, firstEpoch } = await bringUp();
    expect(ui.handle.outdatedOf(agentKey)).toBe(true); // 0.0.1 < hub REPO_VERSION
    await driveToStarted({ hub, ui, act1, agentKey });

    // --- the takeover: a REAL second activation (fresh module instance ⇒ new epoch ⇒ reclaim)
    const act2 = await bootActivation2(hub, { buildVersion: OLD_VERSION, agentHome: dirname(hub.sockPath) });
    const key2 = await act2.goLive();
    expect(key2).toBe(agentKey); // same process identity ⇒ same agentKey (the reclaim path)
    const up2 = await hub.sse.waitFor(
      (e) => e.event === "agent_up" && e.data?.agent?.epoch !== undefined && e.data?.agent?.epoch !== firstEpoch,
    );
    expect(up2.data?.agent?.epoch).not.toBe(firstEpoch); // epoch 变化、走 reclaim
    // no agent_down in between: the handover bye{handover} opened the claim window, not a down
    expect(hub.sse.events.some((e) => e.event === "agent_down")).toBe(false);

    // --- completed fact rides the new connection's hello_ack slot replay back over the wire
    const completedEv = await hub.sse.waitFor(
      (e) => e.event === "status" && (e.data?.status?.reload as { state?: string } | undefined)?.state === "completed",
      8_000,
      "completed status frame",
    );
    const completed = completedEv.data?.status?.reload as Record<string, unknown>;
    expect(completed).toMatchObject({
      v: 1,
      open: false,
      version: REPO_VERSION, // packageVersionSync() === hub version ⇒ Q2's equality branch
      epoch: up2.data?.agent?.epoch, // the TAKING activation's instance
      cmdIds: [ui.sent[0]!.id],
    });
    await pumpUntil(ui, () => ui.handle.entryOf(agentKey).phase === "done", 8_000, "done on completed");
    // 隔离证据：卡片版本全程落后（0.0.1 ≠ hub），done 只能来自 completed 事实的版本比对
    expect(ui.handle.outdatedOf(agentKey)).toBe(true);
    // 早于 90s：生效计时从未触发（succeed 清了它）——剩下的唯一计时器是 done 的 4s toast
    const remaining = [...ui.timers.values()].map((t) => t.ms);
    expect(remaining).toEqual([4_000]);
    expect(ui.sent).toHaveLength(1); // D7: no automatic re-send
  });

  it("对照组（去掉字段的老 agent）：无 status.reload ⇒ #23 的版本到位路径收敛 done，帧里从未出现该字段", async () => {
    wipeReloadTrack();
    const hub = await startHub();
    cleanups.push(() => hub.cleanup());
    const ui = await startUi(hub);
    const act1 = bootActivation1(hub, { sink: false, agentHome: dirname(hub.sockPath) });
    cleanups.push(() => act1.cleanup());

    const agentKey = await act1.agentKey();
    await hub.sse.waitFor((e) => e.event === "commands" && e.data?.agentKey === agentKey);
    await ui.pump();
    expect(ui.handle.outdatedOf(agentKey)).toBe(true);

    // request → accepted → awaiting（没有 deferred 事实：老 agent 的 wire 上什么都没有）
    ui.handle.request(agentKey);
    await waitUntil(() => ui.sent.length === 1, 5_000, "send dispatched");
    await pumpUntil(ui, () => ui.handle.entryOf(agentKey).phase === "awaiting", 8_000, "awaiting");
    await ui.pump();
    const effectArmed = [...ui.timers.values()].some((t) => t.ms === 90_000);
    expect(effectArmed).toBe(true);

    // the reload still happens agent-side (port without a sink still reloads); the takeover
    // reports the NEW version ⇒ the #23 version-到位 fallback settles done
    act1.runs.rows = [];
    act1.ctl.handleRunSettled(0);
    await waitUntil(() => act1.reloaded.count === 1, 8_000, "agent-side reload ran");
    const act2 = await bootActivation2(hub, { buildVersion: REPO_VERSION, agentHome: dirname(hub.sockPath) });
    await act2.goLive();
    await hub.sse.waitFor((e) => e.event === "agent_up" && (e.data?.agent?.pluginVersion as string) === REPO_VERSION);
    await pumpUntil(ui, () => ui.handle.entryOf(agentKey).phase === "done", 8_000, "done via version到位");
    expect(ui.sent).toHaveLength(1);
    // 老 agent 的 wire：任何 status 帧从未携带 reload 字段（去掉字段 = sink 不存在）
    const statusEvents = hub.sse.events.filter((e) => e.event === "status");
    expect(statusEvents.length).toBeGreaterThan(0);
    for (const e of statusEvents) expect(e.data?.status?.reload).toBeUndefined();
    expect(hub.sse.text()).not.toContain('"reload":');
  });

  it("U7 跨层：completed 版本 ≠ hub ⇒ 立即 E_RELOAD_NO_UPGRADE，不等版本到位", async () => {
    wipeReloadTrack();
    // hub 报一个不同于 repo 的版本：completed.version（packageVersionSync = repo 版本）与之
    // 不等 ⇒ Q2 的不等分支，而非 done。卡片仍 0.0.1 ⇒ 版本到位永远不会成立。
    const { hub, ui, act1, agentKey } = await bringUp({ hubVersion: "9.9.9" });
    expect(ui.handle.outdatedOf(agentKey)).toBe(true);
    await driveToStarted({ hub, ui, act1, agentKey });

    const act2 = await bootActivation2(hub, { buildVersion: OLD_VERSION, agentHome: dirname(hub.sockPath) });
    await act2.goLive();
    const completedEv = await hub.sse.waitFor(
      (e) => e.event === "status" && (e.data?.status?.reload as { state?: string } | undefined)?.state === "completed",
      8_000,
      "completed status frame",
    );
    const completed = completedEv.data?.status?.reload as Record<string, unknown>;
    expect(completed.version).toBe(REPO_VERSION); // 事实携带可信版本，但它 ≠ hub 的 9.9.9
    await pumpUntil(
      ui,
      () =>
        ui.handle.entryOf(agentKey).phase === "failed" && ui.handle.entryOf(agentKey).error === "E_RELOAD_NO_UPGRADE",
      8_000,
      "failed E_RELOAD_NO_UPGRADE",
    );
    // 不再等版本到位：卡片仍落后，且没有任何在飞计时器还在等（失败已清场）
    expect(ui.handle.outdatedOf(agentKey)).toBe(true);
    expect([...ui.timers.values()].map((t) => t.ms)).toEqual([]);
    expect(ui.sent).toHaveLength(1); // 失败不重发、不 cancel
  });

  it("Q3 跨层：IDLE_WAIT(open:true) ⇒ 立即失败不 cancel；到总截止恰好 cancel 一次", async () => {
    wipeReloadTrack();
    const { hub, ui, act1, agentKey } = await bringUp();
    // 请求已 park（deferred 事实由真实链路写下，记录含真实 life/cmdIds/execId）
    ui.handle.request(agentKey);
    await waitUntil(() => ui.sent.length === 1, 5_000, "send dispatched");
    await pumpUntil(
      ui,
      () => ui.handle.entryOf(agentKey).phase === "parked" && ui.handle.entryOf(agentKey).waitingFor === "runs",
      8_000,
      "parked with waitingFor runs",
    );
    // 注入 IDLE_WAIT 事实：按 D5 的进程内接口直接改写 tracker 的 store（同一 life/cmdIds，
    // rev+1，state=failed/open=true），由真实 wiring 的下一个 1s onTick 探测到投影变化后
    // 经真实 socket→registry→SSE 发出（wiring-reload-status.test.ts 的同款注入法）。
    const store = (globalThis as Record<symbol, unknown>)[TRACK_KEY] as {
      v: 1;
      rec?: Record<string, unknown>;
    };
    const rec = store.rec as Record<string, unknown>;
    expect(rec).toMatchObject({ state: "deferred", open: true, cmdIds: [ui.sent[0]!.id] });
    store.rec = {
      ...rec,
      rev: (rec["rev"] as number) + 1,
      state: "failed",
      code: "E_RELOAD_IDLE_WAIT",
      open: true,
    };
    (globalThis as Record<symbol, unknown>)[TRACK_KEY] = store;
    await hub.sse.waitFor(
      (e) => e.event === "status" && (e.data?.status?.reload as { code?: string })?.code === "E_RELOAD_IDLE_WAIT",
      8_000,
      "IDLE_WAIT status frame via the real 1s tick",
    );
    // 立即失败（不等 30 分钟），且当下不发 cancel
    await pumpUntil(
      ui,
      () =>
        ui.handle.entryOf(agentKey).phase === "failed" && ui.handle.entryOf(agentKey).error === "E_RELOAD_IDLE_WAIT",
      8_000,
      "failed E_RELOAD_IDLE_WAIT",
    );
    expect(ui.sent.filter((s) => s.args === "reload cancel")).toHaveLength(0);
    // 到总截止（request 起算 30min；fake timer 推进）：恰好一次 cancel（cancelOnce 去重）
    expect([...ui.timers.values()].some((t) => t.ms === 1_800_000)).toBe(true); // cancelAt 已布防
    ui.fireTimers(1_800_000);
    for (let i = 0; i < 6; i++) await Promise.resolve();
    await pumpUntil(
      ui,
      () => ui.sent.filter((s) => s.args === "reload cancel").length === 1,
      5_000,
      "exactly one cancel",
    );
    // 再次触发同截止不重发；最终原因保持 IDLE_WAIT（不被后继 cancelled 细化/改写）
    ui.fireTimers(1_800_000);
    for (let i = 0; i < 6; i++) await Promise.resolve();
    await ui.pump();
    expect(ui.sent.filter((s) => s.args === "reload cancel")).toHaveLength(1);
    expect(ui.handle.entryOf(agentKey)).toMatchObject({ phase: "failed", error: "E_RELOAD_IDLE_WAIT" });
    // 后端真的收到了 cancel（真实 /api/cmd 链路）：事实链推进到 cancelled{user, open:false}
    await hub.sse.waitFor(
      (e) =>
        e.event === "status" &&
        (e.data?.status?.reload as { state?: string })?.state === "cancelled" &&
        (e.data?.status?.reload as { code?: string })?.code === "user",
      8_000,
      "cancelled user fact",
    );
    await ui.pump();
    expect(ui.handle.entryOf(agentKey)).toMatchObject({ phase: "failed", error: "E_RELOAD_IDLE_WAIT" });
  });

  it("U6 跨层：started 后 agent 下线 ⇒ E_RELOAD_LOST；同 key 新 activation 的 completed ⇒ 复活 done（Q4）", async () => {
    wipeReloadTrack();
    const { hub, ui, act1, agentKey } = await bringUp();
    await driveToStarted({ hub, ui, act1, agentKey });

    // started 后目标进程退出：bye（非 handover）+ close ⇒ registry 立即 down ⇒ agent_down
    resetGlobals(); // 关掉当前进程连接：live 链路发 bye{test-teardown} + end
    await hub.sse.waitFor((e) => e.event === "agent_down" && e.data?.agentKey === agentKey, 8_000, "agent_down");
    await pumpUntil(
      ui,
      () => ui.handle.entryOf(agentKey).phase === "failed" && ui.handle.entryOf(agentKey).error === "E_RELOAD_LOST",
      8_000,
      "failed E_RELOAD_LOST",
    );
    expect([...ui.timers.values()].map((t) => t.ms)).toEqual([]); // 计时器全清，不再空等

    // 同 key 新 activation（新进程形状：重演模块求值 + 全新连接）：接管标记在 store 里
    // 存活，session_start{reload} 验证通过 ⇒ completed 随新连接的 hello_ack 槽重放到 wire
    const act2 = await bootActivation2(hub, { buildVersion: OLD_VERSION, agentHome: dirname(hub.sockPath) });
    const key2 = await act2.goLive();
    expect(key2).toBe(agentKey); // 同 key（同一 agentId；down 后基座空出 ⇒ 新注册同 key）
    await hub.sse.waitFor(
      (e) => e.event === "status" && (e.data?.status?.reload as { state?: string } | undefined)?.state === "completed",
      8_000,
      "completed status frame after revival",
    );
    // Q4 允许的唯一复活：failed 相只接受同请求迟到的 completed ⇒ done（版本相等分支）
    await pumpUntil(ui, () => ui.handle.entryOf(agentKey).phase === "done", 8_000, "revived to done");
    expect(ui.sent).toHaveLength(1); // 全程不重发、不 cancel
  });
});
