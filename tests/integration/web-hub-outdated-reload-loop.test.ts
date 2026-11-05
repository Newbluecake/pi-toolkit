/**
 * #23 P-C 跨层闭环（plan §3 P-C 第 1 条）：真实 agent wiring 的 hello → 真实 registry +
 * 真实 hub HTTP/SSE → UI `reduce` + `useOutdatedReload` composable → 协调器 entry。不走任何
 * 帧手写（对照组的「老 agent」hello 也是从真实 wiring 捕获的帧去掉 `epoch.up.v1` 派生的），
 * 不走任何 SSE 手写（浏览器侧读的是真实 `/api/events` 原文，逐块解析成 {event,data,id} 喂
 * 给 reduce）。send 方向同样跨层：composable 的 `runCommand` POST 真实 `/api/cmd`（真
 * command router → 真 registry.request → conn 收到 cmd 帧 → 测试替 agent 回 cmd_result）。
 *
 * 钉住的闭环断言（plan 原文逐条）：
 *  - 正例（steerRecall:false，hello 带 `epoch.up.v1`）：epoch 变化的 reclaim 发 `agent_up`
 *    ⇒ 版本到位即 done；
 *  - 对照组（老 caps，无 `epoch.up.v1` 亦无 `hold.v1`）：reclaim 只有 `gap` ⇒ UI 停在
 *    awaiting ⇒ 90s 生效计时到 ⇒ `E_TIMEOUT`（老 agent 的残留行为显式入测）；
 *  - 时间窗：claiming 10s 后 stale ⇒ `E_OFFLINE`；10–60s 内同 key reclaim（新版本）⇒
 *    failed 收敛 done；
 *  - 超过 reap 窗口（`agent_down`）后按 `register()` 实际返回的 key 断言，不预设换 key：
 *    (a) 同进程同 identity ⇒ 同 key（reclaimed:false）⇒ 新注册路径发 `agent_up` ⇒ 版本到
 *    位即 done；(b) 新进程新 identity ⇒ 新 key ⇒ 旧请求保持 `E_OFFLINE`，新 key idle；
 *  - 原始 bug 复现：命令被接受后目标退出（bye{quit} ⇒ 立即 down）⇒ awaiting 立即
 *    `E_OFFLINE`，计时器全清，之后 90s/总预算都不再改写（不再空等，不自动重发）。
 *
 * 门禁归属见 docs/dev/web-hub/README.md 的 outdated reload 一节；实现依据
 * docs/dev/web-update-stuck/plan.md（r3）。
 */
import { nextTick, ref, type Ref } from "vue";
import { afterEach, describe, expect, it } from "vitest";
import { wireWebHub, type WebHubDeps, type WebHubSettings } from "../../src/web-hub/agent/index.js";
import { createCommandRouter } from "../../src/web-hub/hub/commands.js";
import { createHttpFrontend } from "../../src/web-hub/hub/http.js";
import { createRegistry } from "../../src/web-hub/hub/registry.js";
import type { AgentFrame, CmdFrame } from "../../src/web-hub/protocol/messages.js";
import { PROTO } from "../../src/web-hub/protocol/version.js";
import { initialState, reduce } from "../../src/web-hub/ui/src/logic/state.js";
import { newCmdId, outcomeFromHttp } from "../../src/web-hub/ui/src/logic/control.js";
import { useOutdatedReload } from "../../src/web-hub/ui/src/composables/useOutdatedReload.js";
import type { CmdOutcome, ControlHandle, HubHandle, HubState } from "../../src/web-hub/ui/src/types.js";
import {
  fakeCtx,
  fakeNet,
  fakePi,
  pathsIn,
  resetGlobals,
  SETTINGS,
  tmpDir,
  waitUntil,
} from "../web-hub/agent/helpers.js";
import { fakeConn, memLog, type FakeConn, type Hello } from "../web-hub/hub/helpers.js";
import { fakeDeps, login, makeTmp, parseSseBlock, postJson, type SseEvent } from "../web-hub/http/helpers.js";
import { request as httpRequest } from "node:http";

// ---------------------------------------------------------------------------
// 常量：hub 版本 2.0.0，agent 旧版本 1.2.3（真实 wiring 的 buildInfo），重载后 2.0.0。
// ---------------------------------------------------------------------------

const OLD_VERSION = "1.2.3";
const NEW_VERSION = "2.0.0";
/** 与 registry 的 hubVersion dep 同源 —— UI 侧 hubVersion 读的是同一个值的 SSE `hub` 帧。 */
const HUB_VERSION = NEW_VERSION;
const EPOCH_NEW = "epoch-pc-new";
/** 固定基准时钟（registry/HTTP/coordinator 共用，测试里单调推进）。 */
const T0 = 1_700_100_000_000;

// ---------------------------------------------------------------------------
// A · 真实 wiring 捕获 hello（tests/web-hub/agent/helpers.ts 的 fakeNet，plan 指定路径）
// ---------------------------------------------------------------------------

/** 从真实 `wireWebHub` 捕获一条 hello（settings 可注入 steerRecall 等）。真定时器：
 * session_start → socket 出现 → emit connect → hello 落进 FakeSocket。 */
async function captureHello(settings: Partial<WebHubSettings>): Promise<Hello> {
  resetGlobals(); // 关掉上一条 wiring 留在进程全局里的连接
  const dir = tmpDir("wh-pc-hello-");
  const n = fakeNet();
  const { pi, fire } = fakePi();
  try {
    const deps: WebHubDeps = {
      settings: { ...SETTINGS, ...settings },
      fleet: () => [],
      env: { HOME: dir.dir },
      paths: pathsIn(dir.dir),
      buildInfo: async () => ({ pluginVersion: OLD_VERSION, buildId: `${OLD_VERSION}@pc` }),
      argv1: "/nonexistent/pi",
      netConnect: n.netConnect,
    };
    wireWebHub(pi, deps);
    // fakeCtx 的硬编码 cwd（/tmp/wa）不存在 —— worktree 采样器对它 spawn git 会把 ENOENT 甩成
    // unhandled rejection（wiring-hold.test.ts 的 ctxIn 同款注释）；指到真实临时目录。
    const { ctx } = fakeCtx({ mode: "tui" });
    (ctx as unknown as { cwd: string }).cwd = dir.dir;
    fire("session_start", { type: "session_start", reason: "startup" }, ctx);
    await waitUntil(() => n.sockets.length > 0, 3_000, "wiring socket");
    const s = n.sockets[0]!;
    s.emit("connect");
    await waitUntil(() => s.frames().some((f) => f.t === "hello"), 3_000, "hello frame");
    return s.frames().find((f) => f.t === "hello") as Hello;
  } finally {
    resetGlobals();
    dir.cleanup();
  }
}

/** 派生一条 re-hello：同 identity（或换 identity）、新 epoch、新版本 —— /reload 后的进程
 * 就是这个形状（同 pid+nonce、新 epoch、buildInfo 变新）。 */
function reHello(base: Hello, over: Partial<Hello> = {}): Hello {
  return { ...base, epoch: EPOCH_NEW, pluginVersion: NEW_VERSION, buildId: `${NEW_VERSION}@pc`, ...over };
}

// ---------------------------------------------------------------------------
// B · 真实 hub fixture：真 registry + 真 command router + 真 HTTP/SSE（http/helpers.ts）
// ---------------------------------------------------------------------------

interface HubFixture {
  port: number;
  cookie: string;
  clock: { t: number };
  reg: ReturnType<typeof createRegistry>;
  /** 真实 SSE 原文 + 解析结果（append-only；pump 按 index 消费）。 */
  sse: {
    text(): string;
    events: SseEvent[];
    clientId(): string | undefined;
    waitFor(pred: (e: SseEvent) => boolean, ms?: number): Promise<SseEvent>;
    close(): void;
  };
  /** 同步推进 registry 时钟并 tick（stale/reap 只在 tick 里发生）。 */
  advance(ms: number): void;
  register(hello: Hello): { agentKey: string; reclaimed: boolean; conn: FakeConn };
  cleanup(): Promise<void>;
}

async function startHub(): Promise<HubFixture> {
  const tmp = makeTmp("pwh-pc-loop-");
  const clock = { t: T0 };
  const deps = fakeDeps(tmp.dir);
  const reg = createRegistry({
    now: () => clock.t,
    log: memLog(),
    pidAlive: () => true,
    hubVersion: HUB_VERSION,
  });
  const router = createCommandRouter({ registry: reg, log: memLog(), now: () => clock.t });
  const fe = createHttpFrontend({
    ...deps,
    now: () => clock.t,
    info: () => ({
      version: HUB_VERSION,
      buildId: "b1",
      pid: 1,
      startedAt: 1,
      proto: PROTO,
      caps: ["cmd.v1", "command.v1"],
    }),
    registry: reg,
    bus: reg.bus,
    commands: router,
  });
  const { port } = await fe.listen();
  const cookie = await login(port, deps.paths.tokenFile);
  const sse = await openRawSse(port, cookie);
  const cleanup = async (): Promise<void> => {
    sse.close();
    await fe.close();
    tmp.cleanup();
  };
  return {
    port,
    cookie,
    clock,
    reg,
    sse,
    advance: (ms) => {
      clock.t += ms;
      reg.tick(clock.t);
    },
    register: (hello) => {
      const conn = fakeConn();
      const out = reg.register(hello, conn);
      return { ...out, conn };
    },
    cleanup,
  };
}

/** 真实 `/api/events` 连接：响应字节逐字累积（原文），同时解析成 {event,data,id}。 */
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
          waitFor(pred, ms = 3_000) {
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
// C · UI 侧：真实 reduce + 真实 composable，SSE 原文喂入；send 走真实 /api/cmd
// ---------------------------------------------------------------------------

interface UiLoop {
  handle: ReturnType<typeof useOutdatedReload>;
  state: Ref<HubState>;
  sent: Array<{ agentKey: string; args: string }>;
  /** 把 SSE 新到的事件（按 index）喂 reduce，并冲刷微任务 + watch（P-A loop 的 push 步）。 */
  pump(): Promise<void>;
  /** 等 hub 侧把命令帧递到 agent conn，替 agent 回 cmd_result{ok}（命令被接受）。 */
  acceptCommand(agentKey: string, conn: FakeConn): Promise<CmdFrame>;
  timers: Map<number, { fn: () => void; ms: number }>;
  fireTimers(ms: number): void;
}

async function startUi(hub: HubFixture): Promise<UiLoop> {
  const state = ref(initialState()) as Ref<HubState>;
  const sent: Array<{ agentKey: string; args: string }> = [];
  const control = {
    runCommand: async (agentKey: string, _name: string, args: string): Promise<CmdOutcome> => {
      sent.push({ agentKey, args });
      // 真 transport 形状：POST /api/cmd（CSRF/Origin/cookie 同 security.test.ts 的口径），
      // 响应经 control.js 的真实 outcomeFromHttp 映射成 CmdOutcome。
      const res = await postJson(
        hub.port,
        "/api/cmd",
        { agentKey, id: newCmdId(), op: "command", name: "agent", args, confirm: true },
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
    setTimeout: (fn, ms) => {
      const id = nextTimer++;
      timers.set(id, { fn, ms });
      return id;
    },
    clearTimeout: (h) => void timers.delete(h as number),
    now: () => hub.clock.t, // 与 hub 同一座墙钟（协调器的绝对截止时间跟着推进）
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
    fireTimers: (ms) => {
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
    acceptCommand: async (agentKey, conn) => {
      await waitUntil(() => conn.sent.some((f) => f.t === "cmd"), 3_000, `cmd frame for ${agentKey}`);
      const frame = conn.sent.find((f) => f.t === "cmd") as CmdFrame;
      hub.reg.onFrame(agentKey, {
        t: "cmd_result",
        rid: frame.rid,
        id: frame.id,
        ok: true,
        data: { op: "command", kind: "extension", completion: "sync" },
      } as AgentFrame);
      await flush();
      return frame;
    },
  };
}

/** 注册 + 等 UI 看到卡片，再灌 commands 槽（真实 wiring 在 hello_ack 后必发；UI precheck
 * 需要 `agent.commands` 在，否则 unsupported）。 */
async function bringUp(hello: Hello): Promise<{ hub: HubFixture; ui: UiLoop; agentKey: string; conn: FakeConn }> {
  const hub = await startHub();
  const ui = await startUi(hub);
  const { agentKey, conn } = hub.register(hello);
  await hub.sse.waitFor((e) => e.event === "agent_up");
  await ui.pump();
  hub.reg.onFrame(agentKey, { t: "commands", epoch: hello.epoch, items: [] });
  await hub.sse.waitFor((e) => e.event === "commands" && e.data?.agentKey === agentKey);
  await ui.pump();
  return { hub, ui, agentKey, conn };
}

/** request → send → 命令被接受 → awaiting（真实 /api/cmd 全链）。 */
async function requestAccepted(ui: UiLoop, agentKey: string, conn: FakeConn): Promise<void> {
  ui.handle.request(agentKey);
  for (let i = 0; i < 6; i++) await Promise.resolve();
  await nextTick();
  expect(ui.sent).toEqual([{ agentKey, args: "reload" }]);
  await ui.acceptCommand(agentKey, conn);
  // cmd_result → HTTP 响应 → runCommand promise → 协调器 .then：跨两次真实 TCP + 微任务链，
  // 用 waitUntil 等相位落定（真实时钟，3s 上限）。
  await waitUntil(() => ui.handle.entryOf(agentKey).phase === "awaiting", 3_000, "awaiting after cmd_result");
  expect(ui.handle.entryOf(agentKey).phase).toBe("awaiting");
}

const fixtures: Array<() => Promise<void>> = [];
afterEach(async () => {
  resetGlobals();
  for (const cleanup of fixtures.splice(0)) await cleanup();
});

// ---------------------------------------------------------------------------

describe("#23 P-C 跨层闭环：真实 wiring hello → registry → HTTP/SSE → reduce → 协调器", () => {
  it("真实 wiring 的 hello：steerRecall:false ⇒ 尾部恰一个 epoch.up.v1；默认配置不含（正例的前提）", async () => {
    const off = await captureHello({ steerRecall: false });
    expect(off.caps.at(-1)).toBe("epoch.up.v1");
    expect(off.caps.filter((c) => c === "epoch.up.v1")).toHaveLength(1);
    expect(off.caps).not.toContain("hold.v1");
    expect(off.caps).toContain("cmd.v1"); // card.control（/api/cmd 的 requiredCaps）
    expect(off.caps).toContain("command.v1");
    expect(off.pluginVersion).toBe(OLD_VERSION);
    const on = await captureHello({});
    expect(on.caps).not.toContain("epoch.up.v1"); // 默认 hello 不追加（A 级 golden 钉住）
    expect(on.caps).toContain("hold.v1");
  });

  it("正例：epoch.up.v1 的 epoch 变化 reclaim ⇒ SSE agent_up（新版本）⇒ 版本到位即 done", async () => {
    const hello = await captureHello({ steerRecall: false });
    expect(hello.caps).toContain("epoch.up.v1");
    const { hub, ui, agentKey, conn } = await bringUp(hello);
    fixtures.push(hub.cleanup);
    // 落后成立：hub 2.0.0 > agent 1.2.3（registry 用同一 hubVersion 算的 outdated）
    expect(ui.handle.outdatedOf(agentKey)).toBe(true);
    await requestAccepted(ui, agentKey, conn);
    // /reload：同 identity、新 epoch、新版本重连（老 conn 被 reclaim 关闭）
    const again = hub.register(reHello(hello));
    expect(again.agentKey).toBe(agentKey);
    expect(again.reclaimed).toBe(true);
    const up = await hub.sse.waitFor((e) => e.event === "agent_up" && e.data?.agent?.pluginVersion === NEW_VERSION);
    expect(up.data.agent.epoch).toBe(EPOCH_NEW);
    expect(up.data.agent.outdated).toBe(false);
    await ui.pump();
    expect(ui.handle.entryOf(agentKey).phase).toBe("done");
    expect(ui.sent).toHaveLength(1); // 不自动重发（D7）
  });

  it("正例（Y7.2 路径）：默认配置 hello 带 hold.v1 ⇒ epoch 变化 reclaim 同样发 agent_up ⇒ done", async () => {
    const hello = await captureHello({}); // 默认配置：hold.v1，无 epoch.up.v1
    expect(hello.caps).toContain("hold.v1");
    expect(hello.caps).not.toContain("epoch.up.v1");
    const { hub, ui, agentKey, conn } = await bringUp(hello);
    fixtures.push(hub.cleanup);
    await requestAccepted(ui, agentKey, conn);
    const again = hub.register(reHello(hello));
    expect(again.reclaimed).toBe(true);
    const up = await hub.sse.waitFor((e) => e.event === "agent_up" && e.data?.agent?.pluginVersion === NEW_VERSION);
    expect(up.data.agent.epoch).toBe(EPOCH_NEW);
    await ui.pump();
    expect(ui.handle.entryOf(agentKey).phase).toBe("done");
  });

  it("对照组：老 caps（无 epoch.up.v1 亦无 hold.v1）⇒ 只有 gap ⇒ awaiting 90s 后 E_TIMEOUT", async () => {
    const real = await captureHello({ steerRecall: false });
    // 老 agent = 同一条真实 wiring 的 hello 去掉新 cap（pre-#23 的 wire 形状）
    const oldCaps = real.caps.filter((c) => c !== "epoch.up.v1");
    expect(oldCaps).not.toContain("hold.v1");
    const hello: Hello = { ...real, caps: oldCaps };
    const { hub, ui, agentKey, conn } = await bringUp(hello);
    fixtures.push(hub.cleanup);
    // 订阅该 agent，让 reclaim 的 gap 真的到达 SSE（证明「只有 gap」）
    const sub = await postJson(
      hub.port,
      "/api/subscribe",
      { clientId: hub.sse.clientId(), agentKey },
      { Cookie: hub.cookie },
    );
    expect(sub.status).toBe(202);
    await hub.sse.waitFor((e) => e.event === "history");
    await requestAccepted(ui, agentKey, conn);
    const before = hub.sse.events.length;
    hub.register(reHello(hello)); // epoch 变化，但两个 cap 都没有
    await hub.sse.waitFor((e) => e.event === "gap");
    await ui.pump();
    // reclaim 之后到达的帧里没有 agent_up —— 老 agent 的 wire 就是只有 gap
    const after = hub.sse.events.slice(before);
    expect(after.filter((e) => e.event === "agent_up")).toHaveLength(0);
    expect(after.some((e) => e.event === "gap")).toBe(true);
    expect(ui.handle.entryOf(agentKey).phase).toBe("awaiting"); // 版本帧永远不来
    hub.clock.t += 90_000; // 90s 生效计时到（假时钟；计时器由测试显式触发）
    ui.fireTimers(90_000);
    for (let i = 0; i < 6; i++) await Promise.resolve();
    await nextTick();
    expect(ui.handle.entryOf(agentKey)).toMatchObject({ phase: "failed", error: "E_TIMEOUT" });
  });

  it("时间窗：close 后 10s stale ⇒ E_OFFLINE；10–60s 内同 key reclaim（新版本）⇒ 收敛 done", async () => {
    const hello = await captureHello({ steerRecall: false });
    const { hub, ui, agentKey, conn } = await bringUp(hello);
    fixtures.push(hub.cleanup);
    await requestAccepted(ui, agentKey, conn);
    hub.reg.onClose(agentKey, false); // socket 断（无 bye）⇒ claim window
    hub.advance(10_001); // detachGraceMs(10s) ⇒ stale
    await hub.sse.waitFor((e) => e.event === "agent_stale");
    await ui.pump();
    expect(ui.handle.entryOf(agentKey)).toMatchObject({ phase: "failed", error: "E_OFFLINE" });
    expect(ui.timers.size).toBe(0); // 计时器全清
    // 30s（10–60s 窗口内）：同 identity、新版本重新注册 —— stale 分支必发 agent_up
    hub.clock.t += 20_000;
    const again = hub.register(reHello(hello));
    expect(again.agentKey).toBe(agentKey);
    expect(again.reclaimed).toBe(true);
    await hub.sse.waitFor((e) => e.event === "agent_up" && e.data?.agent?.pluginVersion === NEW_VERSION);
    await ui.pump();
    expect(ui.handle.entryOf(agentKey).phase).toBe("done"); // 慢 reload：先 E_OFFLINE 再自动 done
  });

  it("reap 后 (a)：同进程同 identity ⇒ register() 返回同 key（reclaimed:false）⇒ agent_up ⇒ done", async () => {
    const hello = await captureHello({ steerRecall: false });
    const { hub, ui, agentKey, conn } = await bringUp(hello);
    fixtures.push(hub.cleanup);
    await requestAccepted(ui, agentKey, conn);
    hub.reg.onClose(agentKey, false);
    hub.advance(10_001); // stale
    await hub.sse.waitFor((e) => e.event === "agent_stale");
    await ui.pump();
    expect(ui.handle.entryOf(agentKey).error).toBe("E_OFFLINE");
    hub.advance(50_000); // 合计 60s+ ⇒ tick ⇒ reap（agent_down，记录与 byAgentId 删除）
    const down = await hub.sse.waitFor((e) => e.event === "agent_down" && e.data?.agentKey === agentKey);
    expect(down.data.reason).toBe("reaped");
    await ui.pump();
    expect(ui.handle.entryOf(agentKey)).toMatchObject({ phase: "failed", error: "E_OFFLINE" });
    // 超窗口后同 identity 重新注册：不预设是否换 key —— 用 register() 实际返回值断言
    const again = hub.register(reHello(hello));
    expect(again.reclaimed).toBe(false); // 全新记录路径（reap 已删）
    expect(again.agentKey).toBe(agentKey); // 同进程同 identity ⇒ base key 空出 ⇒ 同 key
    await hub.sse.waitFor((e) => e.event === "agent_up" && e.data?.agent?.pluginVersion === NEW_VERSION);
    await ui.pump();
    expect(ui.handle.entryOf(agentKey).phase).toBe("done"); // 同 key + 版本到位 ⇒ 收敛（D6）
  });

  it("reap 后 (b)：新进程新 identity ⇒ 新 key ⇒ 旧请求保持 E_OFFLINE，新 key idle", async () => {
    const hello = await captureHello({ steerRecall: false });
    const { hub, ui, agentKey, conn } = await bringUp(hello);
    fixtures.push(hub.cleanup);
    await requestAccepted(ui, agentKey, conn);
    hub.reg.onClose(agentKey, false);
    hub.advance(10_001);
    await hub.sse.waitFor((e) => e.event === "agent_stale");
    await ui.pump();
    hub.advance(50_000);
    await hub.sse.waitFor((e) => e.event === "agent_down" && e.data?.agentKey === agentKey);
    await ui.pump();
    expect(ui.handle.entryOf(agentKey)).toMatchObject({ phase: "failed", error: "E_OFFLINE" });
    // 新进程：不同 pid + nonce（hello 其余字段沿用真实 wiring 捕获的帧）
    const next = hub.register(
      reHello(hello, { agentId: { pid: hello.agentId.pid + 1, nonce: "noncePCnewprocess0001" } }),
    );
    expect(next.reclaimed).toBe(false);
    expect(next.agentKey).not.toBe(agentKey); // 实际的新 key
    await hub.sse.waitFor((e) => e.event === "agent_up" && e.data?.agent?.agentKey === next.agentKey);
    await ui.pump();
    // 旧请求不被跨 key 追认：保持 E_OFFLINE；新卡片是独立实体（idle）
    expect(ui.handle.entryOf(agentKey)).toMatchObject({ phase: "failed", error: "E_OFFLINE" });
    expect(ui.handle.entryOf(next.agentKey).phase).toBe("idle");
    expect(ui.sent).toHaveLength(1);
  });

  it("原始 bug 复现：命令被接受后目标退出（bye{quit} ⇒ 立即 down）⇒ 立即 E_OFFLINE，不再空等", async () => {
    const hello = await captureHello({ steerRecall: false });
    const { hub, ui, agentKey, conn } = await bringUp(hello);
    fixtures.push(hub.cleanup);
    await requestAccepted(ui, agentKey, conn); // 命令已被 agent 接受（cmd_result ok）
    const effectArmed = ui.timers.size; // awaiting 的 90s 生效计时在飞
    expect(effectArmed).toBeGreaterThan(0);
    // 目标进程退出：bye{quit} + close(hadBye) ⇒ registry 立即 down ⇒ SSE agent_down
    hub.reg.onFrame(agentKey, { t: "bye", reason: "quit" });
    hub.reg.onClose(agentKey, true);
    await hub.sse.waitFor((e) => e.event === "agent_down" && e.data?.agentKey === agentKey);
    await ui.pump();
    // 修复后：不再空等 90s/30min —— agent_down 一到立即结算 E_OFFLINE
    expect(ui.handle.entryOf(agentKey)).toMatchObject({ phase: "failed", error: "E_OFFLINE" });
    expect(ui.timers.size).toBe(0); // 生效计时被清，没有任何东西还在等
    // 之后时钟推进 + 显式触发任何残留计时器（不该有）也不改写结果；不自动重发
    hub.clock.t += 120_000;
    ui.fireTimers(90_000);
    ui.fireTimers(60_000);
    for (let i = 0; i < 6; i++) await Promise.resolve();
    await nextTick();
    expect(ui.handle.entryOf(agentKey)).toMatchObject({ phase: "failed", error: "E_OFFLINE" });
    expect(ui.sent).toHaveLength(1); // D7：不自动重试
  });
});
