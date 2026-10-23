/**
 * T5（traffic-merge plan §7.3）：keepalive 否决端口。
 *
 * - 端口语义矩阵（rewriteArmed / vetoCapture）；
 * - 进程级改写标记（FIFO 容量、位置刷新、engine 关闭后存活）；
 * - 注册/注销身份校验；trafficVetoPing 的 fail-open 与未注册冻结面；
 * - 真 engine + 真改写路径：出站边界同时写 engine.lastRewrittenAt 与进程标记（作者裁定 must-fix），
 *   且键 = 会话 id（与 cache-ttl capture 的 sessionId 同源）、时钟 = Date.now()。
 */
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ensureDb } from "../../src/traffic/db.js";
import { peekEngine, type TrafficEngine } from "../../src/traffic/engine.js";
import {
  createTrafficKeepalivePort,
  noteTrafficRewrite,
  peekTrafficKeepalivePort,
  REWRITE_MARKS_CAP,
  registerTrafficKeepalivePort,
  resetTrafficRewriteMarksForTest,
  trafficVetoPing,
  trafficVetoStats,
  type TrafficKeepaliveVetoPort,
  type TrafficVetoEngineView,
} from "../../src/traffic/keepalive-port.js";
import { TICKET_HEADER } from "../../src/traffic/tap.js";
import { activate, beginRequest, createUpstream, json, type Activation, type Upstream } from "./helpers/harness.js";
import { teardownEngine } from "./helpers/engine.js";

const HAS_JQ = existsSync("/usr/bin/jq");
const payload = { messages: [{ role: "user", content: "keepalive-port test payload" }], temperature: 1 };

function view(overrides: Partial<TrafficVetoEngineView> = {}): TrafficVetoEngineView {
  return {
    state: "open",
    recording: true,
    rulesSnapshot: { rules: [{ id: 1 }] },
    ...overrides,
  };
}

let dir: string;
let realFetch: typeof globalThis.fetch;
let up: Upstream;
let host: Activation;
let engine: TrafficEngine | undefined;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "pi-ka-port-"));
  realFetch = globalThis.fetch;
  up = createUpstream(() => json(200, { ok: true }));
  globalThis.fetch = up.fetch;
});

afterEach(async () => {
  if (engine) await teardownEngine(engine);
  engine = undefined;
  globalThis.fetch = realFetch;
  resetTrafficRewriteMarksForTest();
  vi.useRealTimers();
  rmSync(dir, { recursive: true, force: true });
});

describe("端口语义（单元）", () => {
  it("rewriteArmed：engine 缺席 / 非 open / 未录制 / 零规则 / secure ⇒ false；全满足 ⇒ true", () => {
    const cases: Array<[TrafficVetoEngineView, boolean]> = [
      [view(), true],
      [view({ state: "closing" }), false],
      [view({ state: "closed" }), false],
      [view({ recording: false }), false],
      [view({ rulesSnapshot: { rules: [] } }), false],
    ];
    for (const [engineView, expected] of cases) {
      const port = createTrafficKeepalivePort(() => engineView);
      expect(port.rewriteArmed(), JSON.stringify(engineView)).toBe(expected);
    }
    expect(createTrafficKeepalivePort(() => undefined).rewriteArmed()).toBe(false);
    // isSecure 纵深防御（secure 会话 traffic 本不接线）
    expect(createTrafficKeepalivePort(() => view(), { isSecure: () => true }).rewriteArmed()).toBe(false);
  });

  it("rewriteArmed：readEngine 抛错 ⇒ false（fail-open，不否决）", () => {
    const port = createTrafficKeepalivePort(() => {
      throw new Error("boom");
    });
    expect(port.rewriteArmed()).toBe(false);
    expect(port.vetoCapture("s", 0)).toBe(false);
  });

  it("vetoCapture：armed ⇒ 恒否决；未 armed ⇒ 仅当该会话标记 ≥ capturedAt", () => {
    resetTrafficRewriteMarksForTest();
    noteTrafficRewrite("s1", 500);
    const armed = createTrafficKeepalivePort(() => view());
    const idle = createTrafficKeepalivePort(() => view({ recording: false }));
    // armed：无视标记与时刻
    expect(armed.vetoCapture("s1", 999_999)).toBe(true);
    expect(armed.vetoCapture("other", 0)).toBe(true);
    // 未 armed：标记 ≥ capturedAt 才否决（= 边界：恰等也否决；capture 早于改写 ⇒ 旧前缀 ⇒ 否决）
    expect(idle.vetoCapture("s1", 500)).toBe(true);
    expect(idle.vetoCapture("s1", 499)).toBe(true);
    expect(idle.vetoCapture("s1", 501)).toBe(false);
    expect(idle.vetoCapture("other", 0)).toBe(false);
  });

  it("进程标记：容量 FIFO、同会话重写刷新位置、空 id / 非有限时刻拒写", () => {
    resetTrafficRewriteMarksForTest();
    for (let i = 0; i < REWRITE_MARKS_CAP; i += 1) noteTrafficRewrite(`s${i}`, i);
    noteTrafficRewrite("s0", 99_999); // 刷新 s0 到队尾
    noteTrafficRewrite("extra", 1); // 超容量 ⇒ 淘汰最旧（现在是 s1）
    const port = createTrafficKeepalivePort(() => view({ recording: false }));
    expect(port.vetoCapture("s1", 0)).toBe(false); // 被淘汰
    expect(port.vetoCapture("s0", 99_998)).toBe(true); // 保留且时刻最新
    expect(port.vetoCapture("extra", 0)).toBe(true);
    noteTrafficRewrite("", 123); // 空 id 拒写
    noteTrafficRewrite("s2", Number.NaN); // 非有限时刻拒写
    expect(port.vetoCapture("s2", 0)).toBe(true); // 原值未变
  });

  it("注册/注销：身份校验——旧端口的迟到注销不删新端口", () => {
    const a = createTrafficKeepalivePort(() => undefined);
    const b = createTrafficKeepalivePort(() => undefined);
    const unregisterA = registerTrafficKeepalivePort(a);
    expect(peekTrafficKeepalivePort()).toBe(a);
    const unregisterB = registerTrafficKeepalivePort(b);
    expect(peekTrafficKeepalivePort()).toBe(b);
    unregisterA(); // 迟到的旧注销：全局已是 b，不动
    expect(peekTrafficKeepalivePort()).toBe(b);
    unregisterB();
    expect(peekTrafficKeepalivePort()).toBeUndefined();
  });

  it("trafficVetoPing：端口未注册 ⇒ 恒 false（冻结面，即便标记存在）；端口抛错 ⇒ false", () => {
    resetTrafficRewriteMarksForTest();
    noteTrafficRewrite("s1", 100);
    expect(trafficVetoPing("s1", 0)).toBe(false);
    const unregister = registerTrafficKeepalivePort({
      rewriteArmed: () => true,
      vetoCapture: () => {
        throw new Error("boom");
      },
    });
    expect(trafficVetoPing("s1", 0)).toBe(false);
    unregister();
  });

  it("进程标记独立于端口生命周期：注销端口后标记仍在，新端口继续否决（engine 关闭场景）", () => {
    resetTrafficRewriteMarksForTest();
    const unregister = registerTrafficKeepalivePort(createTrafficKeepalivePort(() => view()));
    noteTrafficRewrite("s1", 500);
    unregister(); // 模拟 session_shutdown / reload：端口随激活注销
    const port2: TrafficKeepaliveVetoPort = createTrafficKeepalivePort(() => undefined); // 新激活：engine 尚不存在
    expect(port2.vetoCapture("s1", 400)).toBe(true); // 旧 capture 仍被否决（must-fix）
    expect(port2.vetoCapture("s1", 600)).toBe(false);
  });
});

describe("共享状态畸形（安全评审 T5-#3：never-throw + 形状校验 + 保守策略）", () => {
  const MARKS_KEY = Symbol.for("pi-subagent:traffic-rewrite-marks");
  const PORT_KEY = Symbol.for("pi-subagent:traffic-keepalive-port");
  const g = globalThis as Record<symbol, unknown>;
  const idlePort = () => createTrafficKeepalivePort(() => view({ recording: false }));

  afterEach(() => {
    resetTrafficRewriteMarksForTest();
    delete g[PORT_KEY];
  });

  it("畸形标记（非 Map / map:null / 字符串 / 数字）⇒ vetoCapture 否决；noteTrafficRewrite 不抛且用合法结构替换（自愈）", () => {
    resetTrafficRewriteMarksForTest();
    for (const malformed of [{ v: 1, map: null }, { v: 1 }, "garbage", 42]) {
      g[MARKS_KEY] = malformed;
      const port = idlePort();
      expect(port.vetoCapture("any-session", 0), String(malformed)).toBe(true); // 损坏 ⇒ 否决
    }
    trafficVetoStats.marksFailures = 0;
    g[MARKS_KEY] = { v: 1, map: null };
    expect(() => noteTrafficRewrite("s1", 500)).not.toThrow(); // 写侧 never-throw
    // 替换后自愈：合法结构 + 本次条目生效
    expect(idlePort().vetoCapture("s1", 499)).toBe(true);
    expect(idlePort().vetoCapture("s1", 501)).toBe(false);
    expect(idlePort().vetoCapture("other", 0)).toBe(false);
  });

  it("Map 条目值类型错 ⇒ 该条否决（保守），其它条目正常；该会话下次改写覆盖修复", () => {
    resetTrafficRewriteMarksForTest();
    noteTrafficRewrite("s1", 100);
    noteTrafficRewrite("s2", 200);
    (g[MARKS_KEY] as { map: Map<string, unknown> }).map.set("s1", "corrupt");
    const port = idlePort();
    expect(port.vetoCapture("s1", 9_999)).toBe(true); // 值损坏 ⇒ 否决
    expect(port.vetoCapture("s2", 199)).toBe(true); // 其它条目不受影响
    expect(port.vetoCapture("s2", 201)).toBe(false);
    noteTrafficRewrite("s1", 300); // 覆盖修复
    expect(port.vetoCapture("s1", 299)).toBe(true);
    expect(port.vetoCapture("s1", 301)).toBe(false);
  });

  it("抛错 getter ⇒ vetoCapture 否决、noteTrafficRewrite 不抛（写回失败只计数）", () => {
    resetTrafficRewriteMarksForTest();
    Object.defineProperty(globalThis, MARKS_KEY, {
      configurable: true,
      get() {
        throw new Error("boom");
      },
    });
    try {
      expect(idlePort().vetoCapture("s1", 0)).toBe(true); // 读拖错 ⇒ 同损坏 ⇒ 否决
      expect(() => noteTrafficRewrite("s1", 100)).not.toThrow(); // 只读访问器 ⇒ 写回抛错被兑底
      expect(trafficVetoStats.marksFailures).toBeGreaterThan(0); // 失败计数
    } finally {
      delete g[MARKS_KEY]; // configurable 访问器可删
    }
  });

  it("畸形端口（非对象 / 缺方法）⇒ peek 返回 undefined、trafficVetoPing 放行（与未注册同款冻结面）", () => {
    resetTrafficRewriteMarksForTest();
    for (const malformed of [42, "x", {}, { rewriteArmed: () => true }]) {
      g[PORT_KEY] = malformed;
      expect(peekTrafficKeepalivePort(), String(JSON.stringify(malformed))).toBeUndefined();
      expect(trafficVetoPing("s1", 0)).toBe(false); // 放行方向（traffic 没说话就不否决）
    }
  });
});

describe.skipIf(!HAS_JQ)("真 engine + 真改写路径（出站边界标记）", () => {
  beforeEach(async () => {
    host = activate({ dbPath: join(dir, "traffic.db"), sessionId: "session-a" });
    await host.commands.get("record")!("on", host.ctx());
    engine = peekEngine()!;
    const now = new Date().toISOString();
    ensureDb(engine)
      .prepare(
        "INSERT INTO rewrite_rules (name, enabled, priority, body_jq, headers_jq, created_at, updated_at) VALUES (?, 1, 1, ?, ?, ?, ?)",
      )
      .run("ka-port rule", ".temperature = 0", null, now, now);
    engine.refreshRules();
  });

  it("实际改写同时写 engine.lastRewrittenAt 与进程标记（同会话 id、Date.now 时钟）", async () => {
    const before = Date.now();
    const req = await beginRequest(host);
    await req.payload(payload);
    const headers = { ...req.headers };
    expect(headers[TICKET_HEADER]).toBeDefined();
    const res = await req.fetch(JSON.stringify(payload));
    await req.respond(res);
    expect(up.calls[0]!.body).toContain('"temperature":0');
    const after = Date.now();
    // engine 侧（T2b 语义）
    const engineAt = engine!.lastRewrittenAt.get("session-a");
    expect(engineAt).toBeTypeOf("number");
    expect(engineAt!).toBeGreaterThanOrEqual(before);
    expect(engineAt!).toBeLessThanOrEqual(after);
    // 进程级镜像（T5）：同键同时刻，供 engine 关闭后的否决
    const port = createTrafficKeepalivePort(() => undefined);
    expect(port.vetoCapture("session-a", before - 1)).toBe(true);
    expect(port.vetoCapture("session-a", after + 1)).toBe(false);
    // 键 = 会话 id（cache-ttl 的 captureRequest 同样以 ctx.sessionManager.getSessionId() 为键）
    expect(port.vetoCapture("session-a", engineAt! - 1)).toBe(true);
    expect(port.vetoCapture("other-session", 0)).toBe(false);
  });

  it("engine 关闭后（reload 场景）镜像仍否决改写前的旧 capture", async () => {
    const req = await beginRequest(host);
    await req.payload(payload);
    const res = await req.fetch(JSON.stringify(payload));
    await req.respond(res);
    const rewrittenAt = engine!.lastRewrittenAt.get("session-a")!;
    const closed = engine!;
    engine = undefined; // afterEach 不再重复 teardown
    await teardownEngine(closed); // engine close：lastRewrittenAt 随 engine 消失
    const port = createTrafficKeepalivePort(() => peekEngine()); // 新激活读不到 engine
    expect(port.rewriteArmed()).toBe(false);
    expect(port.vetoCapture("session-a", rewrittenAt - 1)).toBe(true); // 旧 capture 仍否决
    expect(port.vetoCapture("session-a", rewrittenAt + 1)).toBe(false); // 规则停用后的新 capture 自愈
  });

  it("安全评审 T5-#3：标记全局畸形时真实改写请求照常发送，且出站边界的写入自愈畸形结构", async () => {
    (globalThis as Record<symbol, unknown>)[Symbol.for("pi-subagent:traffic-rewrite-marks")] = { v: 1, map: null };
    const req = await beginRequest(host);
    await req.payload(payload);
    const res = await req.fetch(JSON.stringify(payload)); // noteTrafficRewrite 位于 sendObserved 之前
    await req.respond(res);
    // 请求未被辅助记账阻断：改写后的正文到达上游，响应正常结算
    expect(up.calls).toHaveLength(1);
    expect(up.calls[0]!.body).toContain('"temperature":0');
    const engineAt = engine!.lastRewrittenAt.get("session-a");
    expect(engineAt).toBeTypeOf("number");
    // 出站边界的 noteTrafficRewrite 用合法结构替换了畸形值，且写入本次条目
    const port = createTrafficKeepalivePort(() => undefined);
    expect(port.vetoCapture("session-a", engineAt! - 1)).toBe(true);
    expect(port.vetoCapture("session-a", engineAt! + 1)).toBe(false);
  });
});
