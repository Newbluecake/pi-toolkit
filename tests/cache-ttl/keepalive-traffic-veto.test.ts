/**
 * T5（traffic-merge plan §7.3）· cache-ttl/keepalive 现有套件的最小补充：
 * `CacheKeepaliveServiceImpl` 发送闸门经 late-bound 端口（`src/traffic/keepalive-port.ts`）询问 traffic 否决。
 *
 * - 规则上膛（rewriteArmed）⇒ 跳过本次 ping（非终态、不熔断、不动 capture、不伸 aliveUntil）；
 * - 规则停用但 capture 早于该会话最近一次实际改写（进程标记）⇒ 仍否决；新 capture 自愈；
 * - 端口未注册（traffic off）⇒ 行为与输出字节不变（冻结面）；
 * - HUD `ping off:traffic-rewrite`（pingSegmentParts）。
 */
import { describe, expect, it, vi, afterEach } from "vitest";
import { FakeClock } from "../../src/core/clock.js";
import type { CacheKeepaliveDeps, CacheKeepaliveService } from "../../src/service/cache-keepalive.js";
import { createCacheKeepaliveService, diagOf, fakeSender } from "./fake-pipeline.js";
import type { PipelinePingInput, SendPipelinePing } from "../../src/cache-ttl/pipeline-ping-types.js";
import type { CacheTtlSettings } from "../../src/config/settings.js";
import { pingSegmentParts, type CapturedRequest } from "../../src/cache-ttl/keepalive-state.js";
import { createChildKeepaliveLedger, type ChildKeepaliveLedger } from "../../src/cache-ttl/ping-ledger.js";
import {
  createTrafficKeepalivePort,
  noteTrafficRewrite,
  registerTrafficKeepalivePort,
  resetTrafficRewriteMarksForTest,
  type TrafficVetoEngineView,
} from "../../src/traffic/keepalive-port.js";

const encoder = new TextEncoder();

function messageStartChunk(usage: { cache_read_input_tokens?: number; cache_creation_input_tokens?: number }): string {
  return `data: ${JSON.stringify({ type: "message_start", message: { usage: { input_tokens: 10, ...usage } } })}\n\n`;
}

function fakeOkResponse(chunks: string[]): Response {
  let i = 0;
  const reader = {
    cancel: async () => {},
    read: async () => {
      if (i < chunks.length) {
        const value = encoder.encode(chunks[i]!);
        i += 1;
        return { done: false, value };
      }
      return { done: true, value: undefined };
    },
  };
  return { ok: true, status: 200, body: { getReader: () => reader } } as unknown as Response;
}

/** proven-hit fetch（message_start 带 cache_read ⇒ ping 有产出，供自愈用例断言成功路径）。 */
function provenHitFetch(): typeof fetch {
  return vi.fn(async () =>
    fakeOkResponse([messageStartChunk({ cache_read_input_tokens: 500, cache_creation_input_tokens: 0 })]),
  ) as unknown as typeof fetch;
}

async function flush(times = 10): Promise<void> {
  for (let i = 0; i < times; i += 1) await Promise.resolve();
}

const SETTINGS: CacheTtlSettings = {
  mode: "auto",
  keepalive: true,
  keepaliveIntervalMs: 240_000,
  keepaliveMinPrefixTokens: 20_000,
};

function fakeCtx() {
  const ctx = {
    ui: { setStatus: vi.fn() },
    mode: "tui",
    model: {
      provider: "anthropic",
      api: "anthropic-messages",
      id: "claude-x",
      baseUrl: "https://api.anthropic.com",
      headers: {},
      cost: { cacheRead: 0.3, cacheWrite: 3.75, tiers: [] },
    },
    modelRegistry: {
      find: vi.fn(),
      getApiKeyAndHeaders: vi.fn().mockResolvedValue({ ok: true, apiKey: "sk-ant-api-x", headers: {} }),
    },
    sessionManager: { getSessionId: () => "s1" },
  };
  ctx.modelRegistry.find?.mockImplementation((provider: string, id: string) =>
    provider === ctx.model.provider && id === ctx.model.id ? ctx.model : undefined,
  );
  return ctx;
}

function capture(overrides: Partial<CapturedRequest> = {}, instance: string, tokens = 30_000): CapturedRequest {
  return {
    sessionId: "s1",
    instance,
    payload: { model: "claude-x", messages: [{ role: "user", content: "hi" }], max_tokens: 100, stream: true },
    fingerprint: {
      sessionId: "s1",
      provider: "anthropic",
      api: "anthropic-messages",
      modelId: "claude-x",
      ctxModelId: "claude-x",
      baseUrl: "https://api.anthropic.com",
      authHeaderKeys: "",
      breakpointPath: "messages.0",
      thinkingDigest: "",
      systemDigest: "",
      toolsDigest: "",
      messageCount: 1,
    },
    shape: { ephemeralBreakpoints: 1, ttl1h: false, hasThinking: false, maxTokens: 100 },
    prefix: { tokens, source: "usage" },
    capturedAt: 0,
    ...overrides,
  };
}

function view(overrides: Partial<TrafficVetoEngineView> = {}): TrafficVetoEngineView {
  return { state: "open", recording: true, rulesSnapshot: { rules: [{ id: 1 }] }, ...overrides };
}

function harness(overrides: Partial<CacheKeepaliveDeps> = {}) {
  const clock = (overrides.clock as FakeClock | undefined) ?? new FakeClock(0);
  const ctx = fakeCtx();
  const sender = fakeSender(provenHitFetch());
  let self: CacheKeepaliveService | undefined;
  const service = createCacheKeepaliveService({
    clock,
    ctx: ctx as never,
    sessionId: "s1",
    settings: { ...SETTINGS },
    backgroundBusy: () => true, // armed by default
    isCurrent: (s) => self === s,
    sendPipelinePing: sender.send,
    appendEntry: vi.fn(),
    emit: vi.fn(),
    ...overrides,
  });
  self = service;
  return { clock, ctx, service, sender };
}

afterEach(() => {
  resetTrafficRewriteMarksForTest();
});

describe("cache-keepalive × traffic 否决端口（T5）", () => {
  it("规则上膛 ⇒ 到点的 ping 被跳过：不发送、lastSkip=traffic-rewrite、非终态继续 arm、窗口不动", async () => {
    let armed = true;
    const unregister = registerTrafficKeepalivePort(
      createTrafficKeepalivePort(() => (armed ? view() : view({ recording: false }))),
    );
    try {
      const { service, clock, sender } = harness();
      service.noteRequest(capture({}, service.instanceId));
      service.noteRequestSettled("s1", service.instanceId);
      const aliveBeforeVeto = service.report().window.aliveUntil; // noteRequest 开窗时设定
      clock.advance(240_000); // 跨过 240s interval ⇒ tick 决定 ping ⇒ 端口否决
      await flush();
      expect(sender.calls).toHaveLength(0);
      const report = service.report();
      expect(report.lastSkip).toBe("traffic-rewrite");
      expect(report.window.pings).toBe(0);
      expect(report.window.pingInFlight).toBe(false); // 否决在 onPingStarted 之前
      expect(report.window.aliveUntil).toBe(aliveBeforeVeto); // 否决不伸 aliveUntil
      expect(report.session.disabled).toBeUndefined(); // 非熔断
      expect(clock.pendingTimers).toBeGreaterThan(0); // 重新 arm
      // HUD 渲染
      expect(pingSegmentParts(report)?.text).toBe("ping off:traffic-rewrite");
      expect(pingSegmentParts(report)?.state).toBe("paused");
      // 下一个 tick 仍被否决（规则持续上膛）
      clock.advance(15_000);
      await flush();
      expect(sender.calls).toHaveLength(0);
      expect(service.report().lastSkip).toBe("traffic-rewrite");
    } finally {
      unregister();
    }
  });

  it("规则停用但 capture 早于该会话最近一次实际改写 ⇒ 仍否决；新 capture（更晚）自愈恢复 ping", async () => {
    const unregister = registerTrafficKeepalivePort(createTrafficKeepalivePort(() => view({ recording: false })));
    try {
      noteTrafficRewrite("s1", 50); // 进程级标记：capture(capturedAt=0) 之前发生过实际改写
      const { service, clock, sender } = harness();
      service.noteRequest(capture({ capturedAt: 0 }, service.instanceId));
      service.noteRequestSettled("s1", service.instanceId);
      clock.advance(240_000);
      await flush();
      expect(sender.calls).toHaveLength(0);
      expect(service.report().lastSkip).toBe("traffic-rewrite");
      // 规则停用后的下一次未改写真实请求 ⇒ capturedAt=100 > 50 ⇒ 自愈
      service.noteRequest(capture({ capturedAt: 100 }, service.instanceId));
      service.noteRequestSettled("s1", service.instanceId);
      expect(service.report().lastSkip).toBeUndefined(); // noteRequest 清 lastSkip
      clock.advance(240_000);
      await flush();
      expect(sender.calls.length).toBeGreaterThanOrEqual(1);
      expect(service.report().window.pings).toBeGreaterThanOrEqual(1);
      expect(pingSegmentParts(service.report())?.text).not.toContain("traffic-rewrite");
    } finally {
      unregister();
    }
  });

  it("其它会话的改写标记不否决本会话（键 = capture.sessionId）", async () => {
    const unregister = registerTrafficKeepalivePort(createTrafficKeepalivePort(() => view({ recording: false })));
    try {
      noteTrafficRewrite("other-session", 999_999);
      const { service, clock, sender } = harness();
      service.noteRequest(capture({ capturedAt: 0 }, service.instanceId));
      service.noteRequestSettled("s1", service.instanceId);
      clock.advance(240_000);
      await flush();
      expect(sender.calls.length).toBeGreaterThanOrEqual(1); // 不受其它会话标记影响
    } finally {
      unregister();
    }
  });

  it("端口未注册（traffic off）⇒ 即便标记存在也不否决：行为与输出字节不变（冻结面）", async () => {
    noteTrafficRewrite("s1", 999_999); // 标记在，但没有端口 ⇒ trafficVetoPing 恒 false
    const { service, clock, sender } = harness();
    service.noteRequest(capture({ capturedAt: 0 }, service.instanceId));
    service.noteRequestSettled("s1", service.instanceId);
    clock.advance(240_000);
    await flush();
    expect(sender.calls).toHaveLength(1);
    const report = service.report();
    expect(report.lastSkip).not.toBe("traffic-rewrite"); // ping 正常发出（物理 IO 结算中是 io-busy，与 traffic 无关）
    expect(report.window.pings).toBe(1);
    expect(pingSegmentParts(report)?.text).not.toContain("traffic-rewrite");
  });
});

describe("cache-keepalive × traffic 否决 × ping-ledger（验收回归：否决不得泄漏 lease）", () => {
  /** 子会话形态的 harness：真实 ping-ledger（isolated 工厂实例）+ 预算参数，childPingGate 走 tryAcquire 路径。 */
  function harnessLedger(clock: FakeClock, ledger: ChildKeepaliveLedger) {
    return harness({
      clock,
      pingLedger: ledger,
      maxConcurrentPings: 2,
      runBudgetUsd: 100,
      processBudgetUsd: 100,
    });
  }

  it("连续否决 tick：lease 即撤不计费——activeCount/reserved 恒 0，跨 150s 回收窗后 spent24h 仍 0，lastSkip 不被 global-cap 取代", async () => {
    const clock = new FakeClock(0);
    const ledger = createChildKeepaliveLedger();
    const unregister = registerTrafficKeepalivePort(createTrafficKeepalivePort(() => view()));
    try {
      const { service, sender } = harnessLedger(clock, ledger);
      service.noteRequest(capture({ capturedAt: 0 }, service.instanceId));
      service.noteRequestSettled("s1", service.instanceId);
      clock.advance(240_000); // 窗口 1 第一笔否决 tick：预算闸已 tryAcquire ⇒ 否决必须当场撤销
      await flush();
      expect(sender.calls).toHaveLength(0);
      expect(ledger.activeCount()).toBe(0);
      expect(ledger.reserved()).toBe(0);
      clock.advance(15_000);
      await flush(); // 255s 第二笔
      clock.advance(15_000);
      await flush(); // 270s 第三笔
      expect(ledger.activeCount()).toBe(0); // 旧代码在此已泄漏 2~3 个 lease（cap=2 ⇒ global-cap）
      expect(ledger.reserved()).toBe(0);
      expect(service.report().lastSkip).toBe("traffic-rewrite");
      // 新真实请求重开窗口；其否决 tick（~510s）跨过第一笔泄漏 lease 的 150s 回收窗（240s+150s=390s）：
      // 若有泄漏，这次 tryAcquire 里的 reclaimExpired 会把 estimateUsd 记入 spent24h（幽灵计费）。
      service.noteRequest(capture({ capturedAt: 300_000 }, service.instanceId));
      service.noteRequestSettled("s1", service.instanceId);
      clock.advance(240_000);
      await flush(20);
      expect(sender.calls).toHaveLength(0);
      expect(service.report().lastSkip).toBe("traffic-rewrite");
      expect(ledger.activeCount()).toBe(0);
      expect(ledger.spent24h(clock.now())).toBe(0); // 无幽灵计费
    } finally {
      unregister();
    }
  });

  it("无否决时 ledger 路径字节不变：ping 正常发出，acquire→settle 一个循环，无预留残留", async () => {
    const clock = new FakeClock(0);
    const ledger = createChildKeepaliveLedger();
    const { service, sender } = harnessLedger(clock, ledger);
    service.noteRequest(capture({ capturedAt: 0 }, service.instanceId));
    service.noteRequestSettled("s1", service.instanceId);
    clock.advance(240_000);
    await flush(20);
    expect(sender.calls).toHaveLength(1);
    expect(ledger.activeCount()).toBe(0); // runPing 的 finally 已 settle（真实计费路径不受否决分支影响）
    expect(ledger.reserved()).toBe(0);
    expect(service.report().window.pings).toBe(1);
  });
});

describe("发送前 guard 复查（安全评审 T5-#2：鉴权等待 / 重试退避中启用规则）", () => {
  /** 鉴权等待型 sender：进入后先挂起（模拟 pipeline 内的 auth await），放行后才调 guard（真实传输的顺序：
   * auth → guard → base fetch）。guard 放行才视为「发出」。 */
  function authGateSender() {
    const inputs: PipelinePingInput[] = [];
    const passedGuard: PipelinePingInput[] = [];
    let releaseAuth!: () => void;
    const authGate = new Promise<void>((resolve) => (releaseAuth = resolve));
    const send: SendPipelinePing = async (input) => {
      inputs.push(input);
      await authGate; // 鉴权等待窗：onTick 已放行，规则在此期间上膛
      if (!input.guard()) {
        return {
          outcome: { kind: "not-sent", reason: "guard", diag: diagOf({ baseFetchCalls: 0, onPayloadCalls: 0 }) },
          settled: Promise.resolve(),
        };
      }
      passedGuard.push(input);
      // 本用例断言 passedGuard 恒空；防御性返回一个合法的零网络 not-sent（不触发任何 latch）。
      return {
        outcome: {
          kind: "not-sent",
          reason: "capability",
          diag: diagOf({ baseFetchCalls: 0, explicitSuccess: false }),
        },
        settled: Promise.resolve(),
      };
    };
    return { send, inputs, passedGuard, releaseAuth };
  }

  it("鉴权等待中启用规则 ⇒ 鉴权完成后 guard 否决：不发送、refund 预算、lastSkip=traffic-rewrite、不熔断、lease 撤销不计费", async () => {
    const clock = new FakeClock(0);
    const ledger = createChildKeepaliveLedger();
    const auth = authGateSender();
    const unregister = registerTrafficKeepalivePort(
      // 初始未上膛（规则未启用）⇒ onTick 放行；鉴权等待中翻转
      createTrafficKeepalivePort(() => (armed ? view() : view({ recording: false }))),
    );
    let armed = false;
    try {
      const { service } = harness({
        clock,
        pingLedger: ledger,
        maxConcurrentPings: 2,
        runBudgetUsd: 100,
        processBudgetUsd: 100,
        sendPipelinePing: auth.send,
      });
      service.noteRequest(capture({ capturedAt: 0 }, service.instanceId));
      service.noteRequestSettled("s1", service.instanceId);
      clock.advance(240_000); // onTick 未否决 ⇒ ping 启动，sender 挂在鉴权上
      await flush();
      expect(auth.inputs).toHaveLength(1);
      expect(service.report().window.pingInFlight).toBe(true);
      armed = true; // 鉴权等待期间：traffic 网页启用规则并刷新快照
      auth.releaseAuth();
      await flush(20);
      expect(auth.passedGuard).toHaveLength(0); // guard 否决 ⇒ 从未发出
      const report = service.report();
      expect(report.lastSkip).toBe("traffic-rewrite");
      expect(report.window.pingInFlight).toBe(false); // 首尝试 not-sent ⇒ refundBudget
      expect(report.window.pings).toBe(0);
      expect(report.session.disabled).toBeUndefined(); // 非熔断
      expect(ledger.activeCount()).toBe(0); // lease 由 runPing 的 finally 以 0（撤销不计费）结算
      expect(ledger.spent24h(clock.now())).toBe(0);
      // 后续 tick 不再发送（onTick 否决）
      clock.advance(15_000);
      await flush();
      expect(auth.inputs).toHaveLength(1);
      expect(service.report().lastSkip).toBe("traffic-rewrite");
    } finally {
      unregister();
    }
  });

  it("重试退避中启用规则 ⇒ 后续尝试不发送（可恢复暂停）：capture 身份/aliveUntil 不变、不进 onUnproven、lease 0；关闭规则后无需 noteRequest 即恢复发送", async () => {
    const clock = new FakeClock(0);
    const ledger = createChildKeepaliveLedger();
    const fetchImpl = vi.fn(async () => {
      throw new Error("network down");
    }) as unknown as typeof fetch;
    const sender = fakeSender(fetchImpl);
    const unregister = registerTrafficKeepalivePort(
      createTrafficKeepalivePort(() => (armed ? view() : view({ recording: false }))),
    );
    let armed = false;
    try {
      const { service } = harness({
        clock,
        pingLedger: ledger,
        maxConcurrentPings: 2,
        runBudgetUsd: 100,
        processBudgetUsd: 100,
        sendPipelinePing: sender.send,
      });
      service.noteRequest(capture({ capturedAt: 0 }, service.instanceId));
      service.noteRequestSettled("s1", service.instanceId);
      const captureBefore = service.report().window.capture;
      const aliveBefore = service.report().window.aliveUntil;
      clock.advance(240_000); // 第一次尝试：网络错误（可重试）
      await flush(20);
      expect(fetchImpl).toHaveBeenCalledTimes(1);
      armed = true; // 2s 退避期间：规则上膛
      clock.advance(2_000); // 第二次尝试：dispatchPing 的 guard 否决（fakeSender 在 sender 入口调 guard）
      await flush(20);
      expect(fetchImpl).toHaveBeenCalledTimes(1); // 后续尝试未到达网络
      expect(sender.calls.length).toBeGreaterThanOrEqual(2); // sender 进入了，但被 guard 拦下
      const report = service.report();
      expect(report.lastSkip).toBe("traffic-rewrite");
      expect(report.session.disabled).toBeUndefined(); // 非熔断
      // 可恢复暂停（安全复审第 2 轮）：不进 onUnproven——capture 对象身份不变、原 aliveUntil 保留、
      // 窗口未「停止」、未证明计数未动
      expect(report.window.capture).toBe(captureBefore);
      expect(report.window.aliveUntil).toBe(aliveBefore);
      expect(report.window.lastStopReason).toBeUndefined();
      expect(report.window.pingInFlight).toBe(false);
      expect(report.session.unprovenTotal).toBe(0);
      expect(ledger.activeCount()).toBe(0); // lease 已结算（never-processed ⇒ 0 计费，撤销不计费）
      expect(ledger.spent24h(clock.now())).toBe(0);
      // 关闭规则且**不** noteRequest：15s tick 在窗口 TTL 内（285s 边界前）恢复发送
      armed = false;
      clock.advance(15_000);
      await flush(20);
      expect(fetchImpl).toHaveBeenCalledTimes(2); // 恢复发送（仍是网络错误，进入新的重试链）
    } finally {
      unregister();
    }
  });
});
