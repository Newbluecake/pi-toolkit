import { describe, expect, it } from "vitest";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { DATE_CUSTOM_TYPE } from "../../src/date/core.js";
import { readLastInjectedDate, wireDate } from "../../src/date/index.js";

const TZ = "Asia/Shanghai";
/** 2026-10-15 18:00 (Asia/Shanghai)。 */
const T_DAY1 = Date.UTC(2026, 9, 15, 10, 0, 0);
const MARKER_DAY1 = `[date] 2026-10-15 Thu (${TZ})`;
/** 2026-10-16 10:00 (Asia/Shanghai)——跨过午夜。 */
const T_DAY2 = Date.UTC(2026, 9, 16, 2, 0, 0);
const MARKER_DAY2 = `[date] 2026-10-16 Fri (${TZ})`;

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
      message: { customType: string; content: string; display: boolean; details: { date: string; kind: string } };
    };
    expect(first.message).toEqual({
      customType: DATE_CUSTOM_TYPE,
      content: MARKER_DAY1,
      display: false,
      details: { date: "2026-10-15", kind: "first" },
    });
    // 同日第二轮：不重复注入。
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
        content: `${MARKER_DAY2} — 当前日期已变更`,
        display: false,
        details: { date: "2026-10-16", kind: "cross-day" },
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
    expect(result.message.content).toBe(`${MARKER_DAY2} — 当前日期已变更`);
    expect(result.message.details.kind).toBe("cross-day");
    // turn_end 不得重复注入同一日期。
    fire(pi, "turn_end", ctx());
    expect(pi.sent).toHaveLength(0);
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
    expect(pi.sent[0]!.message.details).toEqual({ date: "2026-10-16", kind: "cross-day" });
  });

  it("still injects once on the first turn after resume even when the day is unchanged", () => {
    const pi = mockPi();
    const t = T_DAY1;
    wireDate(pi.pi, { enabled: true, now: () => t, timeZone: TZ });
    const branch = [{ type: "custom_message", customType: DATE_CUSTOM_TYPE, details: { date: "2026-10-15" } }];
    fire(pi, "session_start", ctx({ branch }));
    const first = fire(pi, "before_agent_start", ctx({ branch })) as {
      message: { content: string; details: { kind: string } };
    };
    // 首轮规则：同日也注入一次，且无跨日附注。
    expect(first.message.content).toBe(MARKER_DAY1);
    expect(first.message.details.kind).toBe("first");
    expect(fire(pi, "before_agent_start", ctx({ branch }))).toBeUndefined();
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
    expect(first.message.content).toBe(`${MARKER_DAY2} — 当前日期已变更`);
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
    expect(pi.sent[0]!.message.content).toBe(`${MARKER_DAY2} — 当前日期已变更`);
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
    expect(first.message.content).toBe(`${MARKER_DAY2} — 当前日期已变更`);
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
    expect(retry.message.content).toBe(`${MARKER_DAY2} — 当前日期已变更`);
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
});
