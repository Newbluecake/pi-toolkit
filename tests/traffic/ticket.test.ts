/**
 * #5 票据台账（plan §5.3）：铸造 / 配对判据 / generation / 四条退役规则 / 台账回收（TTL + FIFO）。
 * 纯逻辑，注入时钟；与 fetch 层的集成见 attribution-matrix.test.ts，阻断重抛与通知去重见 capture-rewrite d/d2。
 */
import { describe, expect, it } from "vitest";
import {
  createTicketLedger,
  decidePairing,
  MAX_TICKETS,
  newTicketId,
  rewriteSuspended,
  suspendRewrite,
  TICKET_APIS,
  TICKET_TTL,
  type Ticket,
  type TicketGeneration,
} from "../../src/traffic/ticket.js";

function clock(start = 1_000_000) {
  const c = { t: start, now: () => c.t };
  return c;
}

function gen(n = 1): TicketGeneration {
  return {
    gen: n,
    row: null,
    sessionId: "s",
    model: null,
    baseUrl: null,
    rules: [],
    settings: { jqPath: "", timeoutMs: 1, handoffMs: 1, retryGraceMs: 1, maxHoldMs: 1, queueWaitMs: 1 },
    digest: null,
    rewrite: null,
    wireRecorded: false,
    streamCaptured: false,
  };
}

function setup() {
  const c = clock();
  const ledger = createTicketLedger({ now: c.now });
  const runner = ledger.newRunner("host");
  const mint = (r = runner): Ticket =>
    ledger.mint(r, { epoch: 1, sessionId: "s", api: "anthropic-messages", headersSnapshot: null });
  return { c, ledger, runner, mint };
}

describe("铸造", () => {
  it("128-bit 十六进制票据、唯一、加入本 runner 的存活集合；白名单首批三个 API", () => {
    const { ledger, runner, mint } = setup();
    const a = mint();
    const b = mint();
    expect(a.id).toMatch(/^[0-9a-f]{32}$/);
    expect(a.id).not.toBe(b.id);
    expect(ledger.liveOf(runner)).toEqual([a, b]);
    expect([...TICKET_APIS].sort()).toEqual(["anthropic-messages", "openai-completions", "openai-responses"]);
    expect(TICKET_APIS.has("openai-codex-responses")).toBe(false);
  });

  it("runner 互相隔离：另一 runner 的票据不进本 runner 的 L", () => {
    const { ledger, runner, mint } = setup();
    const other = ledger.newRunner("child");
    mint(other);
    expect(ledger.liveOf(runner)).toHaveLength(0);
    expect(decidePairing(ledger.liveOf(runner)).kind).toBe("unattributed");
  });
});

describe("配对判据（L 恰为 {T}）", () => {
  it("|L|=0 / |L|≥2 ⇒ unattributed；绝不按「唯一未配对票据」认领", () => {
    const { ledger, runner, mint } = setup();
    expect(decidePairing(ledger.liveOf(runner))).toEqual({ kind: "unattributed", live: 0 });
    const a = mint();
    a.generation = gen(1); // A 已配对
    mint(); // B 未配对 —— 是「唯一未配对票据」，但 L={A,B}
    expect(decidePairing(ledger.liveOf(runner))).toEqual({ kind: "unattributed", live: 2 });
  });

  it("L={T} 且未绑定 ⇒ bound gen 1", () => {
    const { ledger, runner, mint } = setup();
    const a = mint();
    expect(decidePairing(ledger.liveOf(runner))).toEqual({ kind: "bound", ticket: a, gen: 1 });
  });

  it("L={T} 已绑定、最近 fetch 失败且无在途 ⇒ bumped gen+1；无 fetch / fetch 在途 / 最近成功 ⇒ unattributed", () => {
    const { ledger, runner, mint } = setup();
    const a = mint();
    a.generation = gen(1);
    a.generations = 1;
    expect(decidePairing(ledger.liveOf(runner)).kind).toBe("unattributed"); // 已绑定但未 fetch
    a.lastFetchOk = false;
    a.inFlight = 1;
    expect(decidePairing(ledger.liveOf(runner)).kind).toBe("unattributed"); // 在途
    a.inFlight = 0;
    expect(decidePairing(ledger.liveOf(runner))).toEqual({ kind: "bumped", ticket: a, gen: 2 });
    a.lastFetchOk = true;
    expect(decidePairing(ledger.liveOf(runner)).kind).toBe("unattributed");
  });
});

describe("退役规则", () => {
  it("① fetch 2xx ⇒ 退役（离开 L，但台账仍认得以容纳重试）", () => {
    const { ledger, runner, mint } = setup();
    const a = mint();
    ledger.retire(a, "success");
    expect(ledger.liveOf(runner)).toHaveLength(0);
    expect(ledger.lookup(a.id)).toBe(a);
    expect(ledger.counters.retiredBySuccess).toBe(1);
  });

  it("② assistant message_end ⇒ L 内全部（含未绑定 / 已绑定未 fetch）退役；60s 内放行过 warming ⇒ 不退役", () => {
    const { c, ledger, runner, mint } = setup();
    const a = mint();
    a.generation = gen(1);
    mint();
    runner.warmingAllowedAt = c.t;
    expect(ledger.retireOnMessageEnd(runner)).toBe(-1);
    expect(ledger.liveOf(runner)).toHaveLength(2);
    c.t += TICKET_TTL.warmingWindowMs;
    expect(ledger.retireOnMessageEnd(runner)).toBe(2);
    expect(ledger.liveOf(runner)).toHaveLength(0);
  });

  it("③ TTL：未绑定 30s；非成功票据最后一次 fetch 结束后 30s（在途不退役）", () => {
    const { c, ledger, runner, mint } = setup();
    const unbound = mint();
    const failed = mint();
    failed.generation = gen(1);
    failed.fetches = 1;
    failed.lastFetchOk = false;
    failed.lastFetchEndAt = c.t + 10_000; // 失败 fetch 晚 10s 结束
    c.t += TICKET_TTL.unboundMs - 1;
    expect(ledger.liveOf(runner)).toHaveLength(2);
    c.t += 1;
    expect(ledger.liveOf(runner)).toEqual([failed]);
    expect(unbound.retiredReason).toBe("ttl");
    failed.inFlight = 1; // 又一次 fetch 在途
    c.t = failed.lastFetchEndAt + TICKET_TTL.failedRetireMs;
    expect(ledger.liveOf(runner)).toEqual([failed]); // 在途
    failed.inFlight = 0;
    expect(ledger.liveOf(runner)).toHaveLength(0);
    // TTL 退役不是完成证明 ⇒ runner 立墓碑（安全评审 #1）。
    expect(runner.tombstoned).toBe(true);
    expect(ledger.counters.tombstones).toBe(2);
  });

  it("④ engine 关闭 ⇒ 全部退役并清空台账", () => {
    const { ledger, runner, mint } = setup();
    const a = mint();
    ledger.retireAll();
    expect(a.retired).toBe(true);
    expect(ledger.liveOf(runner)).toHaveLength(0);
    expect(ledger.lookup(a.id)).toBeUndefined();
  });

  it("子会话 agent_settled：丢弃未 fetch 的票据与 hook 级行；已 fetch 的保留在台账", () => {
    const { ledger, runner, mint } = setup();
    const a = mint();
    const b = mint();
    b.fetches = 1;
    runner.hookRows.push({ row: null, sessionId: "s", createdAt: 0 });
    ledger.discardUnfetched(runner);
    expect(ledger.lookup(a.id)).toBeUndefined();
    expect(ledger.lookup(b.id)).toBe(b);
    expect(runner.hookRows).toHaveLength(0);
  });
});

describe("台账回收（fetch 层不再识别）", () => {
  it("未绑定 30s、已绑定未 fetch 120s、已 fetch 的「最后响应 + 60s」、硬上限 10 min", () => {
    const { c, ledger, mint } = setup();
    const unbound = mint();
    const boundIdle = mint();
    boundIdle.generation = gen(1);
    const fetched = mint();
    fetched.generation = gen(1);
    fetched.fetches = 1;
    fetched.lastFetchOk = true;
    fetched.lastFetchEndAt = c.t;
    c.t += TICKET_TTL.unboundMs;
    expect(ledger.lookup(unbound.id)).toBeUndefined();
    expect(ledger.lookup(fetched.id)).toBe(fetched);
    c.t += TICKET_TTL.fetchedKeepMs - TICKET_TTL.unboundMs;
    expect(ledger.lookup(fetched.id)).toBeUndefined();
    expect(ledger.lookup(boundIdle.id)).toBe(boundIdle);
    c.t = 1_000_000 + TICKET_TTL.boundUnfetchedMs;
    expect(ledger.lookup(boundIdle.id)).toBeUndefined();

    const long = mint();
    long.generation = gen(1);
    long.fetches = 1;
    long.inFlight = 1; // 长流：在途也受硬上限约束
    c.t += TICKET_TTL.hardMs;
    expect(ledger.lookup(long.id)).toBeUndefined();
  });

  it(`总量 ≤${MAX_TICKETS} 条 FIFO`, () => {
    const { ledger, mint } = setup();
    const first = mint();
    for (let i = 0; i < MAX_TICKETS; i++) mint();
    expect(ledger.tickets.size).toBe(MAX_TICKETS);
    expect(ledger.lookup(first.id)).toBeUndefined();
    expect(first.retired).toBe(true);
  });
});

describe("墓碑（安全评审 #1：存储回收 ≠ 完成证明）", () => {
  it("非成功票据 TTL 退役 ⇒ 墓碑；此后即使 L 恰为 {TB}（未绑定）也判 unattributed；规则 ② 清墓碑后恢复配对", () => {
    const { c, ledger, runner, mint } = setup();
    const a = mint();
    a.generation = gen(1);
    a.generations = 1;
    a.fetches = 1;
    a.lastFetchOk = false; // 400：SDK 仍可能在读错误体，之后 strict 回退再来一个 payload
    a.lastFetchEndAt = c.t;
    c.t += TICKET_TTL.failedRetireMs + 1;
    const b = mint(); // mint 的 sweep 让 TA 以 TTL 退役
    expect(a.retiredReason).toBe("ttl");
    expect(runner.tombstoned).toBe(true);
    const live = ledger.liveOf(runner);
    expect(live).toEqual([b]);
    // 修复前：L={TB} ⇒ bound —— A 迟到的回退 payload 会被绑到 TB。
    expect(decidePairing(live, runner.tombstoned)).toEqual({ kind: "unattributed", live: 1, tombstoned: true });
    expect(ledger.retireOnMessageEnd(runner)).toBe(1);
    expect(runner.tombstoned).toBe(false);
    expect(ledger.counters.tombstonesCleared).toBe(1);
    const c2 = mint();
    expect(decidePairing(ledger.liveOf(runner), runner.tombstoned)).toEqual({ kind: "bound", ticket: c2, gen: 1 });
  });

  it("已绑定票据被升代判据考虑前就被 TTL 退役 ⇒ 墓碑同样挡住 bumped", () => {
    const { c, ledger, runner, mint } = setup();
    const a = mint();
    a.generation = gen(1);
    a.generations = 1;
    a.fetches = 1;
    a.lastFetchOk = false;
    a.lastFetchEndAt = c.t;
    c.t += TICKET_TTL.failedRetireMs;
    expect(ledger.liveOf(runner)).toHaveLength(0);
    const b = mint();
    b.generation = gen(1);
    b.generations = 1;
    b.fetches = 1;
    b.lastFetchOk = false;
    b.lastFetchEndAt = c.t;
    expect(decidePairing(ledger.liveOf(runner))).toMatchObject({ kind: "bumped" }); // 无墓碑参数时的旧判据
    expect(decidePairing(ledger.liveOf(runner), runner.tombstoned)).toMatchObject({ kind: "unattributed" });
  });

  it("FIFO 淘汰（容量回收）也立墓碑；成功退役（规则 ①）不立、也不清", () => {
    const { ledger, runner, mint } = setup();
    const other = ledger.newRunner("child");
    const first = mint(other);
    for (let i = 0; i < MAX_TICKETS; i++) {
      const t = mint();
      ledger.retire(t, "success"); // 本 runner 的票据都已证明完成
    }
    expect(first.retired).toBe(true);
    expect(ledger.lookup(first.id)).toBeUndefined();
    expect(other.tombstoned).toBe(true); // 被挤掉的 other 票据未经证明
    expect(runner.tombstoned).toBe(false); // 已成功退役的票据被回收不算
    const x = mint(other);
    ledger.retire(x, "success");
    expect(other.tombstoned).toBe(true); // 规则 ① 只证明 x 自己完成
  });

  it("子会话 agent_settled（discardUnfetched）：无 warming 时是完成边界 ⇒ 清墓碑；warming 窗口内与 message_end 同样不清，且绝不清 warming 状态 / 改写暂停", () => {
    const { c, ledger, runner, mint } = setup();
    mint();
    c.t += TICKET_TTL.unboundMs;
    ledger.sweep();
    expect(runner.tombstoned).toBe(true);
    runner.warmingAllowedAt = c.t;
    suspendRewrite(runner, { resumeSeq: 0, zeroSeq: 0 }, ledger.counters);
    expect(ledger.retireOnMessageEnd(runner)).toBe(-1);
    expect(runner.tombstoned).toBe(true);
    ledger.discardUnfetched(runner); // warming 可能仍在途
    expect(runner.tombstoned).toBe(true);
    expect(runner.warmingAllowedAt).toBe(c.t);
    expect(runner.rewriteSuspended).toBe(true);
    c.t += TICKET_TTL.warmingWindowMs;
    ledger.discardUnfetched(runner);
    expect(runner.tombstoned).toBe(false); // 录制归属沿用时间窗
    expect(runner.rewriteSuspended).toBe(true); // 改写暂停不按时间解除
  });
});

describe("改写暂停（第三轮裁定 A：warming 无完成证据 ⇒ 改写 fail closed）", () => {
  it("不按时间解除；/record off→on（resumeSeq）或暂停后观测到零启用规则再启用（zeroSeq ∧ 有规则）才解除", () => {
    const { c, ledger, runner } = setup();
    const marks = { resumeSeq: 3, zeroSeq: 7 };
    suspendRewrite(runner, marks, ledger.counters);
    c.t += 24 * 3600_000;
    expect(rewriteSuspended(runner, marks, 1, ledger.counters)).toBe(true);
    marks.zeroSeq++; // 规则全部禁用（被观测到）
    expect(rewriteSuspended(runner, marks, 0, ledger.counters)).toBe(true); // 尚未再启用
    expect(rewriteSuspended(runner, marks, 2, ledger.counters)).toBe(false); // 再启用 ⇒ 解除
    expect(ledger.counters.rewriteResumes).toBe(1);
    suspendRewrite(runner, marks, ledger.counters); // 新的 decision 以当前序号为起点
    expect(rewriteSuspended(runner, marks, 2, ledger.counters)).toBe(true);
    marks.resumeSeq++;
    expect(rewriteSuspended(runner, marks, 2, ledger.counters)).toBe(false);
  });

  it("新台账（新 engine）的 runner 不继承暂停", () => {
    const { ledger, runner } = setup();
    suspendRewrite(runner, { resumeSeq: 0, zeroSeq: 0 }, ledger.counters);
    const fresh = createTicketLedger().newRunner("host");
    expect(fresh.rewriteSuspended).toBe(false);
  });
});

describe("票据值（安全评审 #7：已接受残留的前提）", () => {
  it("一次性 128-bit 随机值：32 位十六进制、每次不同、不含会话 / 用户信息", () => {
    const ids = new Set<string>();
    for (let i = 0; i < 64; i++) {
      const id = newTicketId();
      expect(id).toMatch(/^[0-9a-f]{32}$/);
      ids.add(id);
    }
    expect(ids.size).toBe(64);
    const ledger = createTicketLedger();
    const runner = ledger.newRunner("host");
    const t = ledger.mint(runner, {
      epoch: 1,
      sessionId: "secret-session-0123456789abcdef",
      api: "anthropic-messages",
      headersSnapshot: null,
    });
    expect(t.id).not.toContain("0123456789abcdef");
    expect(t.id).toMatch(/^[0-9a-f]{32}$/);
  });
});
