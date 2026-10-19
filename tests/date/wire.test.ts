import { describe, expect, it } from "vitest";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { DATE_CUSTOM_TYPE, DATE_REINJECT_IDLE_MS } from "../../src/date/core.js";
import { readLastInjectedDate, readLastInjection, wireDate } from "../../src/date/index.js";

const TZ = "Asia/Shanghai";
/** 2026-10-15 18:00 (Asia/Shanghai)。 */
const T_DAY1 = Date.UTC(2026, 9, 15, 10, 0, 0);
const MARKER_DAY1 = `[date] 2026-10-15 Thu 18:00 (${TZ})`;
/** 2026-10-16 10:00 (Asia/Shanghai)——跨过午夜。 */
const T_DAY2 = Date.UTC(2026, 9, 16, 2, 0, 0);
const MARKER_DAY2 = `[date] 2026-10-16 Fri 10:00 (${TZ})`;
/** 同日 19:00（首轮后恰 1h，闲置重注入边界）。 */
const T_DAY1_IDLE = T_DAY1 + DATE_REINJECT_IDLE_MS;
const MARKER_DAY1_IDLE = `[date] 2026-10-15 Thu 19:00 (${TZ})`;

interface SentCall {
  message: { customType: string; content: string; display: boolean; details: unknown };
  options: { triggerTurn: false } | undefined;
}

type Handler = (event: never, ctx: ExtensionContext) => unknown;

interface MockPi {
  pi: ExtensionAPI;
  handlers: Map<string, Handler[]>;
  sent: SentCall[];
  registeredEvents(): string[];
}

function mockPi(failSend = false): MockPi {
  const handlers = new Map<string, Handler[]>();
  const sent: SentCall[] = [];
  const pi = {
    on: (event: string, handler: Handler) => {
      const list = handlers.get(event) ?? [];
      list.push(handler);
      handlers.set(event, list);
    },
    sendMessage: (message: SentCall["message"], options: SentCall["options"]) => {
      if (failSend) throw new Error("send failed");
      sent.push({ message, options });
    },
  } as unknown as ExtensionAPI;
  return { pi, handlers, sent, registeredEvents: () => [...handlers.keys()] };
}

function ctx(opts: { mode?: string; branch?: unknown[] } = {}): ExtensionContext {
  return {
    mode: opts.mode ?? "interactive",
    sessionManager: { getBranch: () => opts.branch ?? [] },
  } as unknown as ExtensionContext;
}

function fire(pi: MockPi, event: string, context: ExtensionContext): unknown {
  const list = pi.handlers.get(event) ?? [];
  expect(list.length).toBeGreaterThan(0);
  // 所有已注册 handler 依次执行，返回最后一个非 undefined 结果（模块只注册一个）。
  let result: unknown;
  for (const handler of list) result = handler({} as never, context);
  return result;
}

describe("date wire", () => {
  it("injects once on the first turn of a session (before_agent_start message)", () => {
    const pi = mockPi();
    let t = T_DAY1;
    wireDate(pi.pi, { enabled: true, now: () => t, timeZone: TZ });
    expect(pi.registeredEvents()).toEqual(["session_start", "before_agent_start", "turn_end"]);

    const first = fire(pi, "before_agent_start", ctx()) as {
      message: {
        customType: string;
        content: string;
        display: boolean;
        details: { date: string; kind: string; at: number };
      };
    };
    expect(first.message).toEqual({
      customType: DATE_CUSTOM_TYPE,
      content: MARKER_DAY1,
      display: true,
      details: { date: "2026-10-15", kind: "first", at: T_DAY1 },
    });
    // 同日且 <1h 的第二轮：不重复注入。
    expect(fire(pi, "before_agent_start", ctx())).toBeUndefined();
    expect(pi.sent).toHaveLength(0);
    t = T_DAY1 + 60_000;
    fire(pi, "turn_end", ctx());
    expect(pi.sent).toHaveLength(0);
  });

  it("injects at turn_end when the day rolls over mid-run, exactly once", () => {
    const pi = mockPi();
    let t = T_DAY1;
    wireDate(pi.pi, { enabled: true, now: () => t, timeZone: TZ });
    fire(pi, "before_agent_start", ctx()); // 首轮 D1

    t = T_DAY2; // 模型连续运行跨过午夜，turn 结束时发现跨日
    fire(pi, "turn_end", ctx());
    expect(pi.sent).toHaveLength(1);
    expect(pi.sent[0]).toEqual({
      message: {
        customType: DATE_CUSTOM_TYPE,
        content: `${MARKER_DAY2} — 当前日期已变更，时间为注入时刻`,
        display: true,
        details: { date: "2026-10-16", kind: "cross-day", at: T_DAY2 },
      },
      options: { triggerTurn: false },
    });
    // 同（新）日再次 turn_end / before_agent_start：不重复。
    fire(pi, "turn_end", ctx());
    expect(fire(pi, "before_agent_start", ctx())).toBeUndefined();
    expect(pi.sent).toHaveLength(1);
  });

  it("a new turn that already crossed midnight is handled by before_agent_start, turn_end stays silent", () => {
    const pi = mockPi();
    let t = T_DAY1;
    wireDate(pi.pi, { enabled: true, now: () => t, timeZone: TZ });
    fire(pi, "before_agent_start", ctx()); // 首轮 D1
    fire(pi, "turn_end", ctx()); // 同日：无注入
    expect(pi.sent).toHaveLength(0);

    t = T_DAY2; // 用户新一轮开始时已跨日（无先行的 turn_end 捕获）
    const result = fire(pi, "before_agent_start", ctx()) as {
      message: { content: string; details: { kind: string } };
    };
    expect(result.message.content).toBe(`${MARKER_DAY2} — 当前日期已变更，时间为注入时刻`);
    expect(result.message.details.kind).toBe("cross-day");
    // turn_end 不得重复注入同一日期。
    fire(pi, "turn_end", ctx());
    expect(pi.sent).toHaveLength(0);
  });

  it("reinjects date+time on a new turn after ≥1h idle on the same day (kind idle, bare marker)", () => {
    const pi = mockPi();
    let t = T_DAY1;
    wireDate(pi.pi, { enabled: true, now: () => t, timeZone: TZ });
    fire(pi, "before_agent_start", ctx()); // 首轮 18:00
    t = T_DAY1_IDLE; // 同日 19:00，恰 1h 边界 ⇒ 注入
    const idle = fire(pi, "before_agent_start", ctx()) as {
      message: { content: string; details: { date: string; kind: string; at: number } };
    };
    expect(idle.message.content).toBe(MARKER_DAY1_IDLE);
    expect(idle.message.details).toEqual({ date: "2026-10-15", kind: "idle", at: T_DAY1_IDLE });
    expect(pi.sent).toHaveLength(0); // 走 message 返回值，不走 sendMessage
    // 闲置注入重置基线：再过 30 分钟的新一轮不注入。
    t = T_DAY1_IDLE + 30 * 60 * 1000;
    expect(fire(pi, "before_agent_start", ctx())).toBeUndefined();
  });

  it("does not reinject on the same day within 1h", () => {
    const pi = mockPi();
    let t = T_DAY1;
    wireDate(pi.pi, { enabled: true, now: () => t, timeZone: TZ });
    fire(pi, "before_agent_start", ctx());
    t = T_DAY1 + 30 * 60 * 1000; // 30 分钟：不注入
    expect(fire(pi, "before_agent_start", ctx())).toBeUndefined();
    t = T_DAY1_IDLE - 1; // 差 1ms：不注入
    expect(fire(pi, "before_agent_start", ctx())).toBeUndefined();
    expect(pi.sent).toHaveLength(0);
  });

  it("turn_end never performs the idle reinject (same day, even hours later)", () => {
    const pi = mockPi();
    let t = T_DAY1;
    wireDate(pi.pi, { enabled: true, now: () => t, timeZone: TZ });
    fire(pi, "before_agent_start", ctx());
    t = T_DAY1 + 4 * 60 * 60 * 1000; // 同日 22:00
    fire(pi, "turn_end", ctx());
    expect(pi.sent).toHaveLength(0);
    // 但用户发起的下一轮（before_agent_start）会补上闲置注入。
    const idle = fire(pi, "before_agent_start", ctx()) as { message: { content: string; details: { kind: string } } };
    expect(idle.message.content).toBe("[date] 2026-10-15 Thu 22:00 (Asia/Shanghai)");
    expect(idle.message.details.kind).toBe("idle");
  });

  it("seeds the cross-day baseline from the branch on resume (getBranch, last entry wins)", () => {
    const pi = mockPi();
    let t = T_DAY2;
    wireDate(pi.pi, { enabled: true, now: () => t, timeZone: TZ });
    const branch = [
      { type: "custom_message", customType: DATE_CUSTOM_TYPE, details: { date: "2026-10-14", kind: "first" } },
      { type: "custom_message", customType: "subagent:quota", details: { level: 0 } },
      { type: "custom_message", customType: DATE_CUSTOM_TYPE, details: { date: "2026-10-15", kind: "first" } },
    ];
    fire(pi, "session_start", ctx({ branch }));
    // 播种基线 = branch 最后一条（2026-10-15）；直接 turn_end（无先行
    // before_agent_start）即跨日 ⇒ 证明 branch 读取真的进入跨日判定。
    fire(pi, "turn_end", ctx({ branch }));
    expect(pi.sent).toHaveLength(1);
    expect(pi.sent[0]!.message.details).toEqual({ date: "2026-10-16", kind: "cross-day", at: T_DAY2 });
  });

  it("still injects once on the first turn after resume even when the day is unchanged", () => {
    const pi = mockPi();
    const t = T_DAY1;
    wireDate(pi.pi, { enabled: true, now: () => t, timeZone: TZ });
    const branch = [{ type: "custom_message", customType: DATE_CUSTOM_TYPE, details: { date: "2026-10-15" } }];
    fire(pi, "session_start", ctx({ branch }));
    const first = fire(pi, "before_agent_start", ctx({ branch })) as {
      message: { content: string; details: { kind: string; at: number } };
    };
    // 首轮规则：同日也注入一次，且无跨日附注；旧条目缺 at 不影响首轮。
    expect(first.message.content).toBe(MARKER_DAY1);
    expect(first.message.details.kind).toBe("first");
    expect(first.message.details.at).toBe(T_DAY1);
    expect(fire(pi, "before_agent_start", ctx({ branch }))).toBeUndefined();
  });

  it("resume seeding with details.at: first turn still injects (rule 1) and persists a fresh at", () => {
    const pi = mockPi();
    const t = T_DAY1;
    wireDate(pi.pi, { enabled: true, now: () => t, timeZone: TZ });
    const branch = [
      {
        type: "custom_message",
        customType: DATE_CUSTOM_TYPE,
        details: { date: "2026-10-15", at: T_DAY1 - 5 * 3600_000 },
      },
    ];
    fire(pi, "session_start", ctx({ branch }));
    const first = fire(pi, "before_agent_start", ctx({ branch })) as {
      message: { content: string; details: { kind: string; at: number } };
    };
    // 首轮无条件注入（不受播种的旧 at 影响），并写入新鲜的 at。
    expect(first.message.content).toBe(MARKER_DAY1);
    expect(first.message.details.kind).toBe("first");
    expect(first.message.details.at).toBe(T_DAY1);
  });

  it("a resume across midnight injects the cross-day note on its first turn", () => {
    const pi = mockPi();
    const t = T_DAY2;
    wireDate(pi.pi, { enabled: true, now: () => t, timeZone: TZ });
    const branch = [{ type: "custom_message", customType: DATE_CUSTOM_TYPE, details: { date: "2026-10-15" } }];
    fire(pi, "session_start", ctx({ branch }));
    const first = fire(pi, "before_agent_start", ctx({ branch })) as {
      message: { content: string; details: { kind: string } };
    };
    expect(first.message.content).toBe(`${MARKER_DAY2} — 当前日期已变更，时间为注入时刻`);
    expect(first.message.details.kind).toBe("cross-day");
  });

  it("registers nothing when enabled=false (zero wiring)", () => {
    const pi = mockPi();
    wireDate(pi.pi, { enabled: false });
    expect(pi.registeredEvents()).toEqual([]);
    expect(pi.sent).toHaveLength(0);
  });

  it("injects in child (print-mode) sessions too — no mode gate", () => {
    const pi = mockPi();
    let t = T_DAY1;
    wireDate(pi.pi, { enabled: true, now: () => t, timeZone: TZ });
    const childCtx = ctx({ mode: "print" });
    const first = fire(pi, "before_agent_start", childCtx) as { message: { content: string } };
    expect(first.message.content).toBe(MARKER_DAY1);
    t = T_DAY2;
    fire(pi, "turn_end", childCtx);
    expect(pi.sent).toHaveLength(1);
    expect(pi.sent[0]!.message.content).toBe(`${MARKER_DAY2} — 当前日期已变更，时间为注入时刻`);
  });

  it("seeds lazily on the first handler call (child sessions never receive session_start)", () => {
    const pi = mockPi();
    const t = T_DAY2;
    wireDate(pi.pi, { enabled: true, now: () => t, timeZone: TZ });
    const branch = [{ type: "custom_message", customType: DATE_CUSTOM_TYPE, details: { date: "2026-10-15" } }];
    // 不触发 session_start，直接 before_agent_start：懒播种后按跨日注入（带附注）。
    const first = fire(pi, "before_agent_start", ctx({ mode: "print", branch })) as {
      message: { content: string; details: { kind: string } };
    };
    expect(first.message.content).toBe(`${MARKER_DAY2} — 当前日期已变更，时间为注入时刻`);
    expect(first.message.details.kind).toBe("cross-day");
  });

  it("re-arms the first-turn flag when the turn_end send fails, so the next run retries", () => {
    const pi = mockPi(true);
    let t = T_DAY1;
    wireDate(pi.pi, { enabled: true, now: () => t, timeZone: TZ });
    fire(pi, "before_agent_start", ctx());
    t = T_DAY2;
    expect(() => fire(pi, "turn_end", ctx())).not.toThrow();
    expect(pi.sent).toHaveLength(0);
    // 下一次 before_agent_start 补注入（首重试路径）。
    const retry = fire(pi, "before_agent_start", ctx()) as { message: { content: string } };
    expect(retry.message.content).toBe(`${MARKER_DAY2} — 当前日期已变更，时间为注入时刻`);
  });

  it("a session replacement within one activation (session_start again) re-arms the first-turn rule", () => {
    const pi = mockPi();
    const t = T_DAY1;
    wireDate(pi.pi, { enabled: true, now: () => t, timeZone: TZ });
    fire(pi, "session_start", ctx());
    expect(fire(pi, "before_agent_start", ctx())).toBeDefined();
    expect(fire(pi, "before_agent_start", ctx())).toBeUndefined();
    // /new：新 branch 为空 ⇒ 首轮再次注入。
    fire(pi, "session_start", ctx({ branch: [] }));
    const again = fire(pi, "before_agent_start", ctx()) as { message: { content: string } } | undefined;
    expect(again?.message.content).toBe(MARKER_DAY1);
  });

  it("readLastInjectedDate tolerates missing/foreign/malformed entries", () => {
    expect(readLastInjectedDate([])).toBeUndefined();
    expect(
      readLastInjectedDate([
        { type: "custom", customType: DATE_CUSTOM_TYPE, data: { date: "2026-10-15" } }, // appendEntry 元数据，非消息
      ]),
    ).toBeUndefined();
    expect(
      readLastInjectedDate([{ type: "custom_message", customType: DATE_CUSTOM_TYPE, details: {} }]),
    ).toBeUndefined();
    expect(
      readLastInjectedDate([
        { type: "custom_message", customType: "other", details: { date: "2026-10-15" } },
        { type: "custom_message", customType: DATE_CUSTOM_TYPE, details: { date: "2026-10-16" } },
      ]),
    ).toBe("2026-10-16");
  });

  it("readLastInjection seeds date + at; missing/malformed at degrades to unknown", () => {
    const mk = (details: unknown) => [{ type: "custom_message", customType: DATE_CUSTOM_TYPE, details }];
    expect(readLastInjection(mk({ date: "2026-10-15", at: 12345 }))).toEqual({ date: "2026-10-15", at: 12345 });
    expect(readLastInjection(mk({ date: "2026-10-15", at: T_DAY1 }))).toEqual({ date: "2026-10-15", at: T_DAY1 });
    // 旧版本条目：缺 at ⇒ 时刻未知，仅日期可用。
    expect(readLastInjection(mk({ date: "2026-10-15" }))).toEqual({ date: "2026-10-15" });
    expect(readLastInjection(mk({ date: "2026-10-15", at: "nope" }))).toEqual({ date: "2026-10-15" });
    expect(readLastInjection(mk({ date: "2026-10-15", at: Number.NaN }))).toEqual({ date: "2026-10-15" });
    expect(readLastInjection(mk({ date: "2026-10-15", at: Number.POSITIVE_INFINITY }))).toEqual({ date: "2026-10-15" });
    expect(readLastInjection(mk({ at: 12345 }))).toEqual({ at: 12345 });
    expect(readLastInjection([])).toEqual({});
    // 委托关系：日期键语义不变。
    expect(readLastInjectedDate(mk({ date: "2026-10-15", at: 12345 }))).toBe("2026-10-15");
  });

  it("send-failure rollback restores the previous injection timestamp for the idle baseline", () => {
    const pi = mockPi(true);
    let t = T_DAY1;
    wireDate(pi.pi, { enabled: true, now: () => t, timeZone: TZ });
    fire(pi, "before_agent_start", ctx()); // 首轮 D1 18:00（message 返回值，不受 failSend 影响）
    t = T_DAY2;
    expect(() => fire(pi, "turn_end", ctx())).not.toThrow(); // 跨日发送失败 ⇒ 回滚到 (D1, T_DAY1)
    // 回滚后新一轮仍按跨日补注入，并把 at 重置为本次注入时刻。
    t = T_DAY2 + 30 * 60 * 1000;
    const cross = fire(pi, "before_agent_start", ctx()) as { message: { content: string; details: { kind: string } } };
    expect(cross.message.details.kind).toBe("cross-day");
    // 跨日注入后 at=T_DAY2+30m；1h 内同日不注入。
    t = T_DAY2 + 30 * 60 * 1000 + 30 * 60 * 1000;
    expect(fire(pi, "before_agent_start", ctx())).toBeUndefined();
    // ≥1h 后同日注入 idle。
    t = T_DAY2 + 30 * 60 * 1000 + DATE_REINJECT_IDLE_MS;
    const idle = fire(pi, "before_agent_start", ctx()) as { message: { details: { kind: string } } };
    expect(idle.message.details.kind).toBe("idle");
  });

  it("idle re-injection is visible too (display:true, details.kind idle, content stays the bare marker)", () => {
    const pi = mockPi();
    let t = T_DAY1;
    wireDate(pi.pi, { enabled: true, now: () => t, timeZone: TZ });
    fire(pi, "before_agent_start", ctx());
    t = T_DAY1_IDLE;
    const idle = fire(pi, "before_agent_start", ctx()) as { message: SentCall["message"] };
    expect(idle.message).toEqual({
      customType: DATE_CUSTOM_TYPE,
      content: MARKER_DAY1_IDLE,
      display: true,
      details: { date: "2026-10-15", kind: "idle", at: T_DAY1_IDLE },
    });
  });
});
