/**
 * SP8 首条消息转发 — plan §SP8 事件表逐行 + arch §4.6，含 #15 硬门槛（重复发送/至多一次生效）。
 *
 * P3② 决策落点（与 src/web-hub/hub/spawn/first-prompt.ts 头注同一结论）：
 * - `fakeFirstPromptRouter`（只读使用）只对 ok 结果做 dup 回放，失败结果会重复执行——本文件用它
 *   覆盖帧形状 / 状态机 / 退避时序等与「执行次数」无关的行。
 * - 「同 id 只执行一次」类断言走本文件的 `realisticRouter()`：对齐真身 `hub/commands.ts` 的
 *   三态 LRU 语义（不可重试失败 done-缓存重放、`retryable+effect:"none"` 删除重执行、
 *   `effect:"unknown"` 保持 running 由 agent 台账去重）与 `agent/ledger.ts` 的 D7 rule 2。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { CmdFrame, CmdOrigin, CmdResultBody, CmdResultFrame } from "../../../../src/web-hub/protocol/messages.js";
import type { FirstPromptRouterPort } from "../../../../src/web-hub/hub/spawn/ports.js";
import {
  FIRST_PROMPT_CMD_DEADLINE_MS,
  createFirstPromptForwarder,
  type FirstPromptAuditRecord,
  type FirstPromptForwarder,
} from "../../../../src/web-hub/hub/spawn/first-prompt.js";
import { fakeFirstPromptRouter } from "../../contract/fakes.js";

const ID = "spawnAbCdEf1234567"; // 18 chars — SPAWN_ID_RE 形状
const AGENT = "agent-key-1";
const SESSION = "sess-1";
const TEXT = "ümlaut"; // 7 UTF-8 bytes — 钉住 textLen 按字节而非字符数
const TEXT_LEN = 7;

let clock: number;
/** 时钟与假定时器同步推进；async 版会在每个 timer 之间冲刷微任务（async router 回复落地）。 */
const advance = async (ms: number): Promise<void> => {
  clock += ms;
  await vi.advanceTimersByTimeAsync(ms);
};
const flush = async (): Promise<void> => {
  await vi.advanceTimersByTimeAsync(0);
};

interface Harness {
  fp: FirstPromptForwarder;
  audits: FirstPromptAuditRecord[];
  changes: Array<string | undefined>;
  statesAtChange: Array<string | undefined>;
  log: { warn: ReturnType<typeof vi.fn>; info: ReturnType<typeof vi.fn>; error: ReturnType<typeof vi.fn> };
}

function harness(router: FirstPromptRouterPort): Harness {
  const audits: FirstPromptAuditRecord[] = [];
  const changes: Array<string | undefined> = [];
  const statesAtChange: Array<string | undefined> = [];
  const log = { warn: vi.fn(), info: vi.fn(), error: vi.fn() };
  const fp = createFirstPromptForwarder({
    router,
    now: () => clock,
    log,
    audit: (r) => void audits.push(r),
    onChange: (spawnId) => {
      changes.push(spawnId);
      statesAtChange.push(fp.state(spawnId)?.state);
    },
  });
  return { fp, audits, changes, statesAtChange, log };
}

const okBody: CmdResultBody = { ok: true, data: { op: "prompt", delivery: "observed" } };
type ErrCode = Extract<CmdResultBody, { ok: false }>["code"];
const errBody = (code: ErrCode, retryable: boolean, effect: "none" | "unknown"): CmdResultBody => ({
  ok: false,
  code,
  retryable,
  effect,
});

/** 带 code 的 Error（`registry.ts` 的 `HubError` 结构形状），不用 `as`。 */
const codedError = (code: string, message?: string): Error => Object.assign(new Error(message ?? code), { code });

// ---------------------------------------------------------------------------
// realistic 双身：hub router 三态 LRU + agent 台账（D7 rule 2）的最小对齐实现。
// `calls` = request() 被调用（router「收到」）；`executions` = agent 台账 new-begin（真执行）。
// ---------------------------------------------------------------------------

interface AgentLedgerEntry {
  state: "running" | "done";
  result?: CmdResultBody;
}

function realisticRouter() {
  const calls: Array<{ frame: CmdFrame; agentKey: string }> = [];
  const executions: Array<{ frame: CmdFrame; agentKey: string }> = [];
  const queued: CmdResultBody[] = [];
  const agentLedger = new Map<string, AgentLedgerEntry>();
  const port = {
    async request(frame: CmdFrame, agentKey: string): Promise<CmdResultFrame> {
      calls.push({ frame, agentKey });
      const existing = agentLedger.get(frame.id);
      if (existing !== undefined) {
        if (existing.state === "done" && existing.result !== undefined) {
          const r = existing.result;
          // 同 id 重放：回放缓存结果，不再执行（ok 加 dup，失败原样）。
          return { t: "cmd_result", rid: frame.rid, id: frame.id, ...(r.ok ? { ...r, dup: true } : r) };
        }
        // running ⇒ beginOrReply 的 "running" 分支：E_DEADLINE + unknown，不执行。
        return {
          t: "cmd_result",
          rid: frame.rid,
          id: frame.id,
          ok: false,
          code: "E_DEADLINE",
          retryable: true,
          effect: "unknown",
        };
      }
      executions.push({ frame, agentKey });
      agentLedger.set(frame.id, { state: "running" });
      const body = queued.shift() ?? okBody;
      if (body.ok) agentLedger.set(frame.id, { state: "done", result: body });
      else if (body.retryable && body.effect === "none")
        agentLedger.delete(frame.id); // D7 rule 2：删除 ⇒ 重试重执行
      else if (body.effect === "unknown") {
        /* 保持 running —— 由 late settle 裁定（settleAgent） */
      } else agentLedger.set(frame.id, { state: "done", result: body }); // 不可重试失败：缓存
      return { t: "cmd_result", rid: frame.rid, id: frame.id, ...body };
    },
  } satisfies FirstPromptRouterPort;
  return {
    port,
    calls,
    executions,
    queueResult: (b: CmdResultBody) => void queued.push(b),
    /** 模拟 agent 侧 late settle（cmd_late / 台账落定）——只对 running 条目生效。 */
    settleAgent: (id: string, b: CmdResultBody) => {
      const e = agentLedger.get(id);
      if (e !== undefined && e.state === "running") agentLedger.set(id, { state: "done", result: b });
    },
  };
}

// ---------------------------------------------------------------------------

describe("createFirstPromptForwarder（plan §SP8 表 / arch §4.6）", () => {
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    clock = 1_000_000;
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("accept ⇒ pending：审计 + onChange，state()/审计永不含正文", () => {
    const router = fakeFirstPromptRouter();
    const { fp, audits, changes } = harness(router);
    fp.accept(
      ID,
      { text: TEXT, deliver: "followUp" },
      { listener: "loopback", ip: "127.0.0.1", reqId: "req-1" },
      clock + 60_000,
    );
    const view = fp.state(ID);
    expect(view).toBeDefined();
    expect(Object.keys(view ?? {}).sort()).toEqual(["attempts", "state", "textLen"]); // 无 text 键
    expect(view).toEqual({ state: "pending", textLen: TEXT_LEN, attempts: 0 });
    expect(audits).toEqual([
      { audit: "spawn", phase: "state", spawnId: ID, firstPrompt: "pending", textLen: TEXT_LEN, attempts: 0 },
    ]);
    expect(changes).toEqual([ID]);
    expect(JSON.stringify(view) + JSON.stringify(audits)).not.toContain(TEXT);
  });

  it("重复 accept ⇒ warn 且不动既有状态", async () => {
    const router = fakeFirstPromptRouter();
    const { fp, log } = harness(router);
    fp.accept(
      ID,
      { text: TEXT, deliver: "steer" },
      { listener: "loopback", ip: "127.0.0.1", reqId: "r" },
      clock + 60_000,
    );
    fp.onLive(ID, AGENT, SESSION, true);
    await flush();
    expect(fp.state(ID)?.state).toBe("delivered");
    fp.accept(
      ID,
      { text: "other", deliver: "steer" },
      { listener: "loopback", ip: "127.0.0.1", reqId: "r2" },
      clock + 60_000,
    );
    expect(log.warn).toHaveBeenCalledTimes(1);
    expect(fp.state(ID)?.state).toBe("delivered");
    expect(router.requests.length).toBe(1);
  });

  it("onLive control=false ⇒ failed{E_UNSUPPORTED}，正文即弃、零发送", async () => {
    const router = fakeFirstPromptRouter();
    const { fp } = harness(router);
    fp.accept(
      ID,
      { text: TEXT, deliver: "followUp" },
      { listener: "lan", ip: "10.0.0.9", user: "alice", reqId: "r" },
      clock + 60_000,
    );
    fp.onLive(ID, AGENT, SESSION, false);
    expect(fp.state(ID)).toEqual({ state: "failed", code: "E_UNSUPPORTED", textLen: TEXT_LEN, attempts: 0 });
    await advance(120_000);
    expect(router.requests.length).toBe(0); // 从未发送 ⇒ 正文无处泄漏
    expect(vi.getTimerCount()).toBe(0);
  });

  it("onLive control=true ⇒ sending：帧形状（fp_ id / 8000ms / origin 透传 / cmd 全量 / 首发无 retry）", async () => {
    const router = fakeFirstPromptRouter();
    const { fp, statesAtChange } = harness(router);
    const origin: CmdOrigin = { listener: "lan", ip: "10.0.0.9", user: "alice", reqId: "req-42" };
    fp.accept(ID, { text: TEXT, deliver: "steer" }, origin, clock + 60_000);
    fp.onLive(ID, AGENT, SESSION, true);
    await flush();
    expect(fp.state(ID)).toEqual({ state: "delivered", textLen: TEXT_LEN, attempts: 1 });
    expect(router.requests.length).toBe(1);
    const { frame, agentKey } = router.requests[0]!;
    expect(agentKey).toBe(AGENT);
    expect(frame.t).toBe("cmd");
    expect(frame.id).toBe(`fp_${ID}`);
    expect(frame.rid).toBe(`fp_${ID}`);
    expect(frame.deadlineMs).toBe(FIRST_PROMPT_CMD_DEADLINE_MS);
    expect(frame.deadlineMs).toBe(8_000);
    expect(frame.origin).toEqual(origin);
    expect(frame.retry).toBeUndefined();
    expect(frame.cmd).toEqual({ op: "prompt", text: TEXT, deliver: "steer", expect: { sessionId: SESSION } });
    expect(statesAtChange).toEqual(["pending", "sending", "delivered"]); // onChange 逐状态回调
  });

  // E_AGENT_GONE 在真身上只以 throw 送出（commands.ts 新建分发时直接抛 HubError；wire 的
  // CmdErrorCode 里没有这个码），故用 rejecting stub 覆盖 throw 形状。
  it("E_AGENT_GONE（throw，真身 HubError 形状）⇒ 回 pending；onLink(false) 无动作；onLink(true) ⇒ 同 id 重发带 retry:true ⇒ 送达", async () => {
    const frames: CmdFrame[] = [];
    const router = {
      request: (frame: CmdFrame, _agentKey: string): Promise<CmdResultFrame> => {
        frames.push(frame);
        return frames.length === 1
          ? Promise.reject(codedError("E_AGENT_GONE"))
          : Promise.resolve({ t: "cmd_result", rid: frame.rid, id: frame.id, ...okBody });
      },
    } satisfies FirstPromptRouterPort;
    const { fp } = harness(router);
    fp.accept(
      ID,
      { text: TEXT, deliver: "followUp" },
      { listener: "loopback", ip: "127.0.0.1", reqId: "r" },
      clock + 60_000,
    );
    fp.onLive(ID, AGENT, SESSION, true);
    await flush();
    expect(fp.state(ID)).toEqual({ state: "pending", textLen: TEXT_LEN, attempts: 1 });
    fp.onLink(ID, false);
    expect(fp.state(ID)?.state).toBe("pending"); // false 不触发任何动作
    fp.onLink(ID, true);
    await flush();
    expect(fp.state(ID)).toEqual({ state: "delivered", textLen: TEXT_LEN, attempts: 2 });
    expect(frames.length).toBe(2);
    expect(frames[0]!.id).toBe(`fp_${ID}`);
    expect(frames[1]!.id).toBe(`fp_${ID}`);
    expect(frames[0]!.retry).toBeUndefined();
    expect(frames[1]!.retry).toBe(true);
  });

  it.each([["E_DEADLINE"], ["E_BUSY_COMPACTING"], ["E_BUSY_STEER"]] as const)(
    "可重试结果 %s ⇒ 1s 退避后同 id 重发（retry:true）⇒ 送达",
    async (code) => {
      const router = fakeFirstPromptRouter();
      const { fp } = harness(router);
      router.queueResult(errBody(code, true, code === "E_DEADLINE" ? "unknown" : "none"));
      fp.accept(
        ID,
        { text: TEXT, deliver: "steer" },
        { listener: "loopback", ip: "127.0.0.1", reqId: "r" },
        clock + 60_000,
      );
      fp.onLive(ID, AGENT, SESSION, true);
      await flush();
      expect(fp.state(ID)).toEqual({ state: "sending", textLen: TEXT_LEN, attempts: 1 }); // 退避中仍 sending
      await advance(999);
      expect(router.requests.length).toBe(1); // 退避未到不早发
      await advance(1);
      expect(router.requests.length).toBe(2);
      expect(router.requests[1]!.frame.retry).toBe(true);
      expect(router.requests[1]!.frame.id).toBe(`fp_${ID}`);
      expect(fp.state(ID)).toEqual({ state: "delivered", textLen: TEXT_LEN, attempts: 2 });
    },
  );

  it("退避节律 1/3/9s；4 次用完 ⇒ expired{deadline}，不再有第 5 次", async () => {
    const router = fakeFirstPromptRouter();
    const { fp } = harness(router);
    for (let i = 0; i < 6; i += 1) router.queueResult(errBody("E_DEADLINE", true, "unknown"));
    fp.accept(
      ID,
      { text: TEXT, deliver: "steer" },
      { listener: "loopback", ip: "127.0.0.1", reqId: "r" },
      clock + 300_000,
    );
    fp.onLive(ID, AGENT, SESSION, true);
    await flush();
    expect(fp.state(ID)?.attempts).toBe(1);
    await advance(1_000);
    expect(fp.state(ID)?.attempts).toBe(2); // +1s
    await advance(3_000);
    expect(fp.state(ID)?.attempts).toBe(3); // +3s
    await advance(9_000);
    expect(router.requests.length).toBe(4); // +9s —— 第 4 次
    expect(fp.state(ID)).toEqual({ state: "expired", code: "deadline", textLen: TEXT_LEN, attempts: 4 });
    await advance(60_000);
    expect(router.requests.length).toBe(4); // 无第 5 次
    expect(vi.getTimerCount()).toBe(0);
  });

  it.each([
    ["E_UNSUPPORTED", false, "none"],
    ["E_COMMAND_DENIED", false, "none"],
    ["E_BAD_REQUEST", true, "none"],
    ["E_SESSION_CHANGED", false, "none"],
    ["E_RATE", true, "none"], // 「其他」：可重试但不在白名单 ⇒ failed（计划表口径）
  ] as const)("不可重试/其他结果 %s ⇒ failed{code} 终态、不重发", async (code, retryable, effect) => {
    const router = fakeFirstPromptRouter();
    const { fp } = harness(router);
    router.queueResult({ ok: false, code, retryable, effect });
    fp.accept(
      ID,
      { text: TEXT, deliver: "steer" },
      { listener: "loopback", ip: "127.0.0.1", reqId: "r" },
      clock + 60_000,
    );
    fp.onLive(ID, AGENT, SESSION, true);
    await flush();
    expect(fp.state(ID)).toEqual({ state: "failed", code, textLen: TEXT_LEN, attempts: 1 });
    await advance(30_000);
    expect(router.requests.length).toBe(1);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("无码 throw ⇒ 合成 failed{E_INTERNAL}", async () => {
    const router = {
      request: (): Promise<CmdResultFrame> => Promise.reject(new Error("boom")),
    } satisfies FirstPromptRouterPort;
    const { fp } = harness(router);
    fp.accept(
      ID,
      { text: TEXT, deliver: "steer" },
      { listener: "loopback", ip: "127.0.0.1", reqId: "r" },
      clock + 60_000,
    );
    fp.onLive(ID, AGENT, SESSION, true);
    await flush();
    expect(fp.state(ID)).toEqual({ state: "failed", code: "E_INTERNAL", textLen: TEXT_LEN, attempts: 1 });
  });

  it("throw 的 E_DEADLINE（registry 等待超时形状）⇒ 按退避重发", async () => {
    let calls = 0;
    const router = {
      request: (_frame: CmdFrame, _agentKey: string): Promise<CmdResultFrame> => {
        calls += 1;
        return calls === 1
          ? Promise.reject(codedError("E_DEADLINE"))
          : Promise.resolve({ t: "cmd_result", rid: "r", id: "i", ...okBody });
      },
    } satisfies FirstPromptRouterPort;
    const { fp } = harness(router);
    fp.accept(
      ID,
      { text: TEXT, deliver: "steer" },
      { listener: "loopback", ip: "127.0.0.1", reqId: "r" },
      clock + 60_000,
    );
    fp.onLive(ID, AGENT, SESSION, true);
    await flush();
    expect(fp.state(ID)).toEqual({ state: "sending", textLen: TEXT_LEN, attempts: 1 });
    await advance(1_000);
    expect(fp.state(ID)).toEqual({ state: "delivered", textLen: TEXT_LEN, attempts: 2 });
  });

  describe("#15 硬门槛：真实台账语义下的重复发送（realisticRouter）", () => {
    it("E_DEADLINE+effect:unknown：重发同 id+retry:true，agent 台账去重 ⇒ 总执行次数 1", async () => {
      const router = realisticRouter();
      const { fp } = harness(router.port);
      router.queueResult(errBody("E_DEADLINE", true, "unknown"));
      fp.accept(
        ID,
        { text: TEXT, deliver: "steer" },
        { listener: "loopback", ip: "127.0.0.1", reqId: "r" },
        clock + 60_000,
      );
      fp.onLive(ID, AGENT, SESSION, true);
      await flush();
      expect(router.executions.length).toBe(1); // 首发真执行；agent 条目保持 running
      router.settleAgent(`fp_${ID}`, okBody); // 模拟 late settle 落定为 ok
      await advance(1_000); // 1s 退避后重发
      expect(router.calls.length).toBe(2); // router 两次收到
      expect(router.calls[0]!.frame.id).toBe(`fp_${ID}`);
      expect(router.calls[1]!.frame.id).toBe(`fp_${ID}`); // id 相同
      expect(router.calls[0]!.frame.retry).toBeUndefined();
      expect(router.calls[1]!.frame.retry).toBe(true); // 第二次带 retry:true
      expect(router.executions.length).toBe(1); // 同 id 只执行一次（台账 dup-ok 回放）
      expect(fp.state(ID)).toEqual({ state: "delivered", textLen: TEXT_LEN, attempts: 2 });
    });

    it("E_BUSY（retryable+effect:none，D7 rule 2）：双侧台账删除 ⇒ 重发重新执行且只生效一次", async () => {
      const router = realisticRouter();
      const { fp } = harness(router.port);
      router.queueResult(errBody("E_BUSY_COMPACTING", true, "none"));
      fp.accept(
        ID,
        { text: TEXT, deliver: "steer" },
        { listener: "loopback", ip: "127.0.0.1", reqId: "r" },
        clock + 60_000,
      );
      fp.onLive(ID, AGENT, SESSION, true);
      await flush();
      expect(router.executions.length).toBe(1); // 首次执行 ⇒ busy（从未生效）
      await advance(1_000);
      expect(router.executions.length).toBe(2); // 重发重新执行（台账已删，D7 rule 2）
      expect(fp.state(ID)).toEqual({ state: "delivered", textLen: TEXT_LEN, attempts: 2 });
      // 只有一次 ok —— 第一次 effect:"none" 从未生效，「至多一次生效」成立。
      expect(router.calls.length).toBe(2);
    });

    it("链路抖动全程（E_AGENT_GONE → onLink(false) → onLink(true)）⇒ 恰好送达一次", async () => {
      const router = realisticRouter();
      const { fp } = harness(router.port);
      router.port.request = async (frame, agentKey) => {
        router.calls.push({ frame, agentKey });
        if (router.executions.length === 0) {
          router.executions.push({ frame, agentKey });
          throw codedError("E_AGENT_GONE"); // 真身：新建分发直接抛 HubError
        }
        router.executions.push({ frame, agentKey });
        return { t: "cmd_result", rid: frame.rid, id: frame.id, ...okBody };
      };
      fp.accept(
        ID,
        { text: TEXT, deliver: "steer" },
        { listener: "loopback", ip: "127.0.0.1", reqId: "r" },
        clock + 60_000,
      );
      fp.onLive(ID, AGENT, SESSION, true);
      await flush();
      expect(fp.state(ID)?.state).toBe("pending");
      fp.onLink(ID, false);
      fp.onLink(ID, true);
      await flush();
      expect(fp.state(ID)?.state).toBe("delivered");
      const okCount = router.calls.length; // 恰好两次 request、两次执行、一次 ok
      expect(okCount).toBe(2);
    });
  });

  describe("绝对期限 firstPromptDeadlineAt", () => {
    it("pending（未 live）到期 ⇒ expired{deadline}，attempts 0", async () => {
      const router = fakeFirstPromptRouter();
      const { fp } = harness(router);
      fp.accept(
        ID,
        { text: TEXT, deliver: "steer" },
        { listener: "loopback", ip: "127.0.0.1", reqId: "r" },
        clock + 5_000,
      );
      await advance(4_999);
      expect(fp.state(ID)?.state).toBe("pending");
      await advance(1);
      expect(fp.state(ID)).toEqual({ state: "expired", code: "deadline", textLen: TEXT_LEN, attempts: 0 });
      expect(vi.getTimerCount()).toBe(0);
    });

    it("退避中途到期 ⇒ expired{deadline} 且不再发", async () => {
      const router = fakeFirstPromptRouter();
      const { fp } = harness(router);
      for (let i = 0; i < 5; i += 1) router.queueResult(errBody("E_BUSY_STEER", true, "none"));
      fp.accept(
        ID,
        { text: TEXT, deliver: "steer" },
        { listener: "loopback", ip: "127.0.0.1", reqId: "r" },
        clock + 5_000,
      );
      fp.onLive(ID, AGENT, SESSION, true);
      await flush(); // t0 发第 1 次
      await advance(1_000); // t1 第 2 次
      await advance(3_000); // t4 第 3 次 ⇒ 下个退避 9s（t13）晚于期限（t5）
      expect(router.requests.length).toBe(3);
      await advance(1_000); // t5 期限到
      expect(fp.state(ID)).toEqual({ state: "expired", code: "deadline", textLen: TEXT_LEN, attempts: 3 });
      await advance(30_000);
      expect(router.requests.length).toBe(3); // 第 4 次永不发生
      expect(vi.getTimerCount()).toBe(0);
    });

    it("在途到期 ⇒ expired；迟到的 ok 回复被忽略", async () => {
      const resolvers: Array<(f: CmdResultFrame) => void> = [];
      const router = {
        request: (_frame: CmdFrame, _agentKey: string): Promise<CmdResultFrame> =>
          new Promise((resolve) => void resolvers.push((f) => resolve(f))),
      } satisfies FirstPromptRouterPort;
      const { fp } = harness(router);
      fp.accept(
        ID,
        { text: TEXT, deliver: "steer" },
        { listener: "loopback", ip: "127.0.0.1", reqId: "r" },
        clock + 3_000,
      );
      fp.onLive(ID, AGENT, SESSION, true);
      await flush();
      expect(fp.state(ID)?.state).toBe("sending");
      await advance(3_000);
      expect(fp.state(ID)).toEqual({ state: "expired", code: "deadline", textLen: TEXT_LEN, attempts: 1 });
      resolvers[0]!({ t: "cmd_result", rid: "r", id: "i", ...okBody }); // 迟到 ok
      await flush();
      expect(fp.state(ID)?.state).toBe("expired"); // 不回弹
    });

    it("await-link 到期 ⇒ expired{deadline}", async () => {
      const router = {
        request: (): Promise<CmdResultFrame> => Promise.reject(codedError("E_AGENT_GONE")),
      } satisfies FirstPromptRouterPort;
      const { fp } = harness(router);
      fp.accept(
        ID,
        { text: TEXT, deliver: "steer" },
        { listener: "loopback", ip: "127.0.0.1", reqId: "r" },
        clock + 5_000,
      );
      fp.onLive(ID, AGENT, SESSION, true);
      await flush();
      expect(fp.state(ID)?.state).toBe("pending");
      await advance(5_000);
      expect(fp.state(ID)).toEqual({ state: "expired", code: "deadline", textLen: TEXT_LEN, attempts: 1 });
    });
  });

  describe("onTerminal / dispose", () => {
    it("never_live：未 live 即终态 ⇒ expired{never_live}", () => {
      const router = fakeFirstPromptRouter();
      const { fp, audits } = harness(router);
      fp.accept(
        ID,
        { text: TEXT, deliver: "steer" },
        { listener: "loopback", ip: "127.0.0.1", reqId: "r" },
        clock + 60_000,
      );
      fp.onTerminal(ID, "never_live");
      expect(fp.state(ID)).toEqual({ state: "expired", code: "never_live", textLen: TEXT_LEN, attempts: 0 });
      expect(audits.at(-1)).toMatchObject({ firstPrompt: "expired", code: "never_live" });
      expect(vi.getTimerCount()).toBe(0);
    });

    it("stopped：退避中打断 ⇒ expired{stopped}，退避定时器清除", async () => {
      const router = fakeFirstPromptRouter();
      const { fp } = harness(router);
      router.queueResult(errBody("E_DEADLINE", true, "unknown"));
      fp.accept(
        ID,
        { text: TEXT, deliver: "steer" },
        { listener: "loopback", ip: "127.0.0.1", reqId: "r" },
        clock + 60_000,
      );
      fp.onLive(ID, AGENT, SESSION, true);
      await flush();
      expect(fp.state(ID)?.state).toBe("sending");
      fp.onTerminal(ID, "stopped");
      expect(fp.state(ID)).toEqual({ state: "expired", code: "stopped", textLen: TEXT_LEN, attempts: 1 });
      expect(vi.getTimerCount()).toBe(0);
      await advance(30_000);
      expect(router.requests.length).toBe(1);
    });

    it("delivered 后 onTerminal ⇒ 仍 delivered", async () => {
      const router = fakeFirstPromptRouter();
      const { fp } = harness(router);
      fp.accept(
        ID,
        { text: TEXT, deliver: "steer" },
        { listener: "loopback", ip: "127.0.0.1", reqId: "r" },
        clock + 60_000,
      );
      fp.onLive(ID, AGENT, SESSION, true);
      await flush();
      fp.onTerminal(ID, "stopped");
      expect(fp.state(ID)?.state).toBe("delivered");
    });

    it("dispose(hub_restart)：未送达 ⇒ expired{hub_restart}；随后整表清空、零残留定时器", async () => {
      // 主 harness：A=pending（未 live），B=delivered（已送达）。
      const router = fakeFirstPromptRouter();
      const { fp, audits } = harness(router);
      fp.accept(
        "spawnA000000000000001",
        { text: TEXT, deliver: "steer" },
        { listener: "loopback", ip: "127.0.0.1", reqId: "r" },
        clock + 60_000,
      );
      fp.accept(
        "spawnB000000000000002",
        { text: TEXT, deliver: "steer" },
        { listener: "loopback", ip: "127.0.0.1", reqId: "r" },
        clock + 60_000,
      );
      fp.onLive("spawnB000000000000002", "agent-b", "sess-b", true);
      await flush();
      expect(fp.state("spawnB000000000000002")?.state).toBe("delivered");
      const auditsBefore = audits.length; // pending(A) + sending/delivered(B) = 3

      fp.dispose("hub_restart");
      expect(audits.length).toBe(auditsBefore + 1); // B 已 delivered ⇒ 无新审计行
      expect(audits.at(-1)).toMatchObject({
        spawnId: "spawnA000000000000001",
        firstPrompt: "expired",
        code: "hub_restart",
      });
      // Map 清空 ⇒ 正文（连同 delivered 墓碑）出内存；state() 全部 undefined。
      expect(fp.state("spawnA000000000000001")).toBeUndefined();
      expect(fp.state("spawnB000000000000002")).toBeUndefined();
      expect(vi.getTimerCount()).toBe(0);
      await advance(60_000);
      expect(router.requests.length).toBe(1); // 只有 B 的首发，dispose 后无任何新发送

      // 退避中的记录被 dispose 打断：expired{hub_restart} 且退避定时器不再触发。
      const routerBusy = fakeFirstPromptRouter();
      const h2 = harness(routerBusy);
      routerBusy.queueResult(errBody("E_BUSY_COMPACTING", true, "none"));
      h2.fp.accept(
        "spawnC000000000000003",
        { text: TEXT, deliver: "steer" },
        { listener: "loopback", ip: "127.0.0.1", reqId: "r" },
        clock + 60_000,
      );
      h2.fp.onLive("spawnC000000000000003", "agent-c", "sess-c", true);
      await flush();
      expect(h2.fp.state("spawnC000000000000003")?.state).toBe("sending"); // 退避中
      h2.fp.dispose("hub_restart");
      expect(h2.fp.state("spawnC000000000000003")?.state).toBeUndefined();
      expect(h2.audits.at(-1)).toMatchObject({ firstPrompt: "expired", code: "hub_restart", attempts: 1 });
      expect(vi.getTimerCount()).toBe(0);
      await advance(60_000);
      expect(routerBusy.requests.length).toBe(1); // 不再发送
    });
  });

  describe("事件顺序防御", () => {
    it("onLink(true) 先于 live ⇒ 不发送；live 后正常发送", async () => {
      const router = fakeFirstPromptRouter();
      const { fp } = harness(router);
      fp.accept(
        ID,
        { text: TEXT, deliver: "steer" },
        { listener: "loopback", ip: "127.0.0.1", reqId: "r" },
        clock + 60_000,
      );
      fp.onLink(ID, true);
      await flush();
      expect(router.requests.length).toBe(0);
      fp.onLive(ID, AGENT, SESSION, true);
      await flush();
      expect(router.requests.length).toBe(1);
      expect(fp.state(ID)?.state).toBe("delivered");
    });

    it("二次 onLive ⇒ 忽略", async () => {
      const router = fakeFirstPromptRouter();
      const { fp } = harness(router);
      fp.accept(
        ID,
        { text: TEXT, deliver: "steer" },
        { listener: "loopback", ip: "127.0.0.1", reqId: "r" },
        clock + 60_000,
      );
      fp.onLive(ID, AGENT, SESSION, true);
      await flush();
      fp.onLive(ID, "agent-key-2", "sess-2", true);
      await flush();
      expect(router.requests.length).toBe(1);
      expect(router.requests[0]!.agentKey).toBe(AGENT);
    });

    it("未知 spawnId 的事件 ⇒ 无害 no-op", () => {
      const router = fakeFirstPromptRouter();
      const { fp } = harness(router);
      expect(() => {
        fp.onLive("spawnUnknown0000001", AGENT, SESSION, true);
        fp.onLink("spawnUnknown0000001", true);
        fp.onTerminal("spawnUnknown0000001", "stopped");
        expect(fp.state("spawnUnknown0000001")).toBeUndefined();
      }).not.toThrow();
    });
  });

  it("审计行形状（arch §6.6 切片）：pending/sending/delivered 各一行，含 textLen/attempts，无正文", async () => {
    const router = fakeFirstPromptRouter();
    const { fp, audits } = harness(router);
    fp.accept(
      ID,
      { text: TEXT, deliver: "followUp" },
      { listener: "lan", ip: "10.0.0.9", user: "bob", reqId: "r" },
      clock + 60_000,
    );
    fp.onLive(ID, AGENT, SESSION, true);
    await flush();
    expect(audits).toHaveLength(3);
    expect(audits[0]).toEqual({
      audit: "spawn",
      phase: "state",
      spawnId: ID,
      firstPrompt: "pending",
      textLen: TEXT_LEN,
      attempts: 0,
    });
    expect(audits[1]).toEqual({
      audit: "spawn",
      phase: "state",
      spawnId: ID,
      firstPrompt: "sending",
      textLen: TEXT_LEN,
      attempts: 1,
    });
    expect(audits[2]).toEqual({
      audit: "spawn",
      phase: "state",
      spawnId: ID,
      firstPrompt: "delivered",
      textLen: TEXT_LEN,
      attempts: 1,
    });
    expect(JSON.stringify(audits)).not.toContain(TEXT);
  });
});
