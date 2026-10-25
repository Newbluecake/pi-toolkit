/**
 * #4 trampoline：plan §5.2 转换规则表逐行；每次安装新闭包、旧 wrapper 退役透传；重挂持有旧 wrapper 的 F；
 * 重入守卫；tap lost；票据头恒剥离。
 */
import { tmpdir } from "node:os";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { TrafficEngine } from "../../src/traffic/engine.js";
import {
  TICKET_HEADER,
  checkTapAfterResponse,
  installTap,
  noteTicketSeen,
  peekTapRecord,
  retireTap,
  stripTicket,
  tapActiveFor,
  type TapHandler,
  tapSnapshot,
} from "../../src/traffic/tap.js";
import { makeEngine, teardownEngine } from "./helpers/engine.js";

type Call = { who: string; ticket: string | null };

let engine: TrafficEngine;
let calls: Call[];
let saved: typeof globalThis.fetch;

function ticketOf(init: any): string | null {
  const headers = init?.headers;
  if (!headers) return null;
  if (headers instanceof Headers) return headers.get(TICKET_HEADER);
  for (const [k, v] of Object.entries(headers as Record<string, string>)) {
    if (k.toLowerCase() === TICKET_HEADER) return v;
  }
  return null;
}

/** 链底「原生」fetch：记录收到的票据头。 */
function nativeFn(): typeof globalThis.fetch {
  return (async (_input: any, init?: any) => {
    calls.push({ who: "N", ticket: ticketOf(init) });
    return new Response("ok", { status: 200 });
  }) as typeof globalThis.fetch;
}

/** 第三方 wrapper：捕获安装时的下游 `inner` 并调用它。 */
function thirdParty(name: string, inner: typeof globalThis.fetch): typeof globalThis.fetch {
  return (async (input: any, init?: any) => {
    calls.push({ who: name, ticket: ticketOf(init) });
    return inner(input, init);
  }) as typeof globalThis.fetch;
}

/** 录制处理器桩：记一次「录制」并调用固定下游。 */
function recordingHandler(): TapHandler & { mock: { calls: unknown[][] } } {
  return vi.fn(async (next, input, init) => next(input, init)) as never;
}

const withTicket = { method: "POST", headers: { [TICKET_HEADER]: "T1", "x-other": "1" }, body: "{}" };

beforeEach(() => {
  saved = globalThis.fetch;
  calls = [];
  globalThis.fetch = nativeFn();
  engine = makeEngine(tmpdir());
  engine.recording = true;
});

afterEach(async () => {
  await teardownEngine(engine);
  globalThis.fetch = saved;
});

describe("转换规则表", () => {
  it("行 1：无活动 wrapper + /record on ⇒ 新建 w(next=当前全局) 并设为全局", async () => {
    const before = globalThis.fetch;
    const handler = recordingHandler();
    const w = installTap(engine, handler);
    expect(globalThis.fetch).toBe(w.wrapper);
    expect(w.next).toBe(before);
    expect(peekTapRecord()?.activeId).toBe(w.id);
    expect(engine.tapId).toBe(w.id);
    await globalThis.fetch("https://x.test/", withTicket);
    expect(handler.mock.calls).toHaveLength(1);
    // 交给处理器的入参已剥离票据头，票据值单列。
    expect(handler.mock.calls[0]![3]).toBe("T1");
    expect(calls).toEqual([{ who: "N", ticket: null }]);
  });

  it("每次安装新建闭包；同 engine 重复安装幂等；别的 engine 安装 ⇒ 旧 wrapper 先退役（至多一个活动）", async () => {
    const w1 = installTap(engine, recordingHandler());
    expect(installTap(engine, recordingHandler())).toBe(w1);
    const other = makeEngine(tmpdir());
    other.recording = true;
    const w2 = installTap(other, recordingHandler());
    expect(w2.wrapper).not.toBe(w1.wrapper);
    expect(w1.retired).toBe(true);
    expect(tapActiveFor(engine)).toBeUndefined();
    expect(tapActiveFor(other)).toBe(w2);
    // w1 是最外层时退役即还原，w2 的下游是 w1 退役后还原出来的全局。
    expect(w2.next).toBe(w1.next);
    await other.close("t");
  });

  it("行 2：活动 w 且全局 === w，engine 关闭 ⇒ 全局还原为 w.next；w 退役", async () => {
    const before = globalThis.fetch;
    const w = installTap(engine, recordingHandler());
    expect(retireTap(engine)).toBe("restored");
    expect(globalThis.fetch).toBe(before);
    expect(w.retired).toBe(true);
    expect(peekTapRecord()?.activeId).toBeNull();
    expect(retireTap(engine)).toBe("none");
  });

  it("行 3：活动 w 被第三方包住，engine 关闭 ⇒ 全局不动；w 退役为纯透传（只剥票据，不录）", async () => {
    const handler = recordingHandler();
    const w = installTap(engine, handler);
    const outer = thirdParty("F", globalThis.fetch);
    globalThis.fetch = outer;
    await engine.close("reload");
    expect(globalThis.fetch).toBe(outer);
    expect(w.retired).toBe(true);
    await globalThis.fetch("https://x.test/", withTicket);
    expect(handler.mock.calls).toHaveLength(0);
    // F 看到票据（它在 w 外层），N 收到的请求已无票据头。
    expect(calls).toEqual([
      { who: "F", ticket: "T1" },
      { who: "N", ticket: null },
    ]);
  });

  it("行 4：w 已退役，第三方把持有旧 w 的 F 挂回全局后 /record on ⇒ w′(next=F)；w′→F→w→N 各一次、只录一次、F 无票据、无递归", async () => {
    const native = globalThis.fetch;
    const h1 = recordingHandler();
    const w = installTap(engine, h1);
    const F = thirdParty("F", w.wrapper); // F 持有旧 w
    expect(retireTap(engine)).toBe("restored");
    expect(globalThis.fetch).toBe(native);
    globalThis.fetch = F; // 第三方重新挂回
    const h2 = recordingHandler();
    const w2 = installTap(engine, h2);
    expect(w2.wrapper).not.toBe(w.wrapper);
    expect(w2.next).toBe(F);
    await globalThis.fetch("https://x.test/", withTicket);
    expect(h2.mock.calls).toHaveLength(1);
    expect(h1.mock.calls).toHaveLength(0);
    expect(calls).toEqual([
      { who: "F", ticket: null },
      { who: "N", ticket: null },
    ]);
    expect(peekTapRecord()?.reentry).toBe(0);
  });

  it("行 5：延迟绑定环（下游再次读 globalThis.fetch）⇒ 重入守卫改走 nativeFetch，计数 + 只记一次日志，请求成功、不二次录制", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const handler = recordingHandler();
    installTap(engine, handler);
    // 第三方 L 以「延迟绑定」方式工作：调用时才读 globalThis.fetch。先把 L 挂为全局，再 /record on，
    // 得到链 w2(next=L)；L 回调全局 = w2 自己 ⇒ 环。
    retireTap(engine);
    const lateBinding = (async (input: any, init?: any) => {
      calls.push({ who: "L", ticket: ticketOf(init) });
      return globalThis.fetch(input, init);
    }) as typeof globalThis.fetch;
    globalThis.fetch = lateBinding;
    const w2 = installTap(engine, handler);
    expect(w2.next).toBe(lateBinding);
    const res = await globalThis.fetch("https://x.test/", withTicket);
    expect(res.status).toBe(200);
    expect(handler.mock.calls).toHaveLength(1);
    expect(peekTapRecord()?.reentry).toBe(1);
    expect(engine.counters.tapReentry).toBe(1);
    expect(calls).toEqual([
      { who: "L", ticket: null },
      { who: "N", ticket: null },
    ]);
    // 第二次环：计数增加，日志不重复。
    await globalThis.fetch("https://x.test/", withTicket);
    expect(peekTapRecord()?.reentry).toBe(2);
    expect(warn).toHaveBeenCalledTimes(1);
    expect(w2.retired).toBe(false);
  });

  it("行 6：after_provider_response 到达而活动 w 从未见过该票据 ⇒ tap lost：停录、退役、notify 一次", async () => {
    const notes: string[] = [];
    engine.notify = (m) => notes.push(m);
    installTap(engine, recordingHandler());
    await globalThis.fetch("https://x.test/", withTicket);
    expect(checkTapAfterResponse(engine, "T1")).toBe(false); // 见过
    expect(engine.recording).toBe(true);
    expect(checkTapAfterResponse(engine, "T-unseen")).toBe(true);
    expect(engine.tapLost).toBe(true);
    expect(engine.recording).toBe(false);
    expect(tapActiveFor(engine)).toBeUndefined();
    expect(notes).toHaveLength(1);
    expect(notes[0]).toContain("tap lost");
    // 停用后不再判定 / 不再通知。
    expect(checkTapAfterResponse(engine, "T-other")).toBe(false);
    expect(notes).toHaveLength(1);
    // /record on 重新安装后恢复。
    engine.recording = true;
    installTap(engine, recordingHandler());
    expect(engine.tapLost).toBe(false);
  });
});

/**
 * 延迟绑定的第三方层 L：全局就是自己时走它自己保存的平台出口 N（独立使用时正常），否则调用「当前全局」。
 * depth 计数让修复前的无限递归以明确断言失败（而不是爆栈 / 卡死）。
 */
function lateBindingLayer(platform: typeof globalThis.fetch): typeof globalThis.fetch & { depth: number } {
  let depth = 0;
  const L = (async (input: any, init?: any) => {
    calls.push({ who: "L", ticket: ticketOf(init) });
    depth++;
    if (depth > 20) throw new Error("unbounded recursion through L");
    try {
      return globalThis.fetch === L ? await platform(input, init) : await globalThis.fetch(input, init);
    } finally {
      depth--;
    }
  }) as typeof globalThis.fetch & { depth: number };
  Object.defineProperty(L, "depth", { get: () => depth });
  return L;
}

describe("安全评审 #1：重入守卫覆盖停录 / secure / 退役透传", () => {
  function setupLateChain(): { L: typeof globalThis.fetch; handler: ReturnType<typeof recordingHandler> } {
    const N = globalThis.fetch;
    // 先在平台 N 上安装并退役一次 ⇒ nativeFetch = N（安全出口已知）。
    installTap(engine, recordingHandler());
    retireTap(engine);
    const L = lateBindingLayer(N);
    globalThis.fetch = L;
    const handler = recordingHandler();
    installTap(engine, handler); // w(next=L)
    calls = [];
    return { L, handler };
  }

  it("/record off（recording=false 透传）下延迟绑定环有界终止：改走 nativeFetch，请求成功", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const { handler } = setupLateChain();
    engine.recording = false;
    const res = await globalThis.fetch("https://x.test/", withTicket);
    expect(res.status).toBe(200);
    expect(handler.mock.calls).toHaveLength(0);
    expect(calls).toEqual([
      { who: "L", ticket: null },
      { who: "N", ticket: null },
    ]);
    expect(engine.counters.tapReentry).toBe(1);
    expect(warn).toHaveBeenCalledTimes(1);
  });

  it("加密会话透传路径同样受守卫保护", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    setupLateChain();
    process.env.PI_SECURE_SESSION = "1";
    try {
      const res = await globalThis.fetch("https://x.test/", withTicket);
      expect(res.status).toBe(200);
    } finally {
      delete process.env.PI_SECURE_SESSION;
    }
    expect(calls.map((c) => c.who)).toEqual(["L", "N"]);
  });

  it("retained 退役（F 持有 w 且在外层）后，延迟绑定环有界终止", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const N = globalThis.fetch;
    installTap(engine, recordingHandler());
    retireTap(engine); // nativeFetch = N
    const L = lateBindingLayer(N);
    globalThis.fetch = L;
    const w = installTap(engine, recordingHandler()); // w(next=L)
    const F = thirdParty("F", w.wrapper);
    globalThis.fetch = F;
    expect(retireTap(engine)).toBe("retained");
    calls = [];
    const res = await globalThis.fetch("https://x.test/", withTicket);
    expect(res.status).toBe(200);
    // F → w(退役) → L → F → w(重入 ⇒ nativeFetch=N)
    expect(calls.map((c) => c.who)).toEqual(["F", "L", "F", "N"]);
    expect(peekTapRecord()?.reentry).toBe(1);
  });
});

describe("安全评审 #2：首次安装前已有延迟绑定 wrapper（nativeFetch 不可信）", () => {
  it("回退出口自身成环 ⇒ 有界失败（E_TRAFFIC_FETCH_LOOP）+ tap lost 停用；之后请求经 L 正常", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const notes: string[] = [];
    engine.notify = (m) => notes.push(m);
    const N = globalThis.fetch;
    const L = lateBindingLayer(N);
    globalThis.fetch = L; // 第三方先加载：首次安装时看到的全局就是 L
    const handler = recordingHandler();
    const w = installTap(engine, handler);
    expect(w.next).toBe(L);
    expect(peekTapRecord()?.nativeFetch).toBe(L);
    calls = [];
    await expect(globalThis.fetch("https://x.test/", withTicket)).rejects.toMatchObject({
      code: "E_TRAFFIC_FETCH_LOOP",
    });
    expect(engine.tapLost).toBe(true);
    expect(engine.tapLostReason).toBe("fetch-loop");
    expect(engine.recording).toBe(false);
    expect(tapActiveFor(engine)).toBeUndefined();
    expect(globalThis.fetch).toBe(L); // 退役还原
    expect(tapSnapshot().loopFailures).toBe(1);
    expect(notes).toHaveLength(1);
    expect(notes[0]).toContain("环路");
    // 停用后：L 独立工作。
    calls = [];
    const res = await globalThis.fetch("https://x.test/", withTicket);
    expect(res.status).toBe(200);
    expect(calls.map((c) => c.who)).toEqual(["L", "N"]);
  });

  it("同一加载顺序下 recording=false 透传也有界失败（不递归）", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const L = lateBindingLayer(globalThis.fetch);
    globalThis.fetch = L;
    installTap(engine, recordingHandler());
    engine.recording = false;
    await expect(globalThis.fetch("https://x.test/", withTicket)).rejects.toMatchObject({
      code: "E_TRAFFIC_FETCH_LOOP",
    });
    expect(tapActiveFor(engine)).toBeUndefined();
  });
});

describe("票据头恒剥离", () => {
  it("engine 停录 / 关闭 / 加密会话 下活动 wrapper 也剥离票据并透传，不调用处理器", async () => {
    const handler = recordingHandler();
    installTap(engine, handler);
    engine.recording = false;
    await globalThis.fetch("https://x.test/", withTicket);
    engine.recording = true;
    process.env.PI_SECURE_SESSION = "1";
    try {
      await globalThis.fetch("https://x.test/", withTicket);
    } finally {
      delete process.env.PI_SECURE_SESSION;
    }
    expect(handler.mock.calls).toHaveLength(0);
    expect(calls).toEqual([
      { who: "N", ticket: null },
      { who: "N", ticket: null },
    ]);
  });

  it("stripTicket：Headers / 二元组数组 / 普通对象（大小写不敏感）/ Request 均剥离；不携带时返回原对象", () => {
    const obj = { method: "POST", headers: { "X-PI-Traffic-Ticket": "A", a: "1" } };
    const r1 = stripTicket("u", obj);
    expect(r1.ticket).toBe("A");
    expect(r1.init.headers).toEqual({ a: "1" });
    expect(obj.headers).toHaveProperty("X-PI-Traffic-Ticket"); // 不改原对象

    const r2 = stripTicket("u", { headers: new Headers({ [TICKET_HEADER]: "B", b: "2" }) });
    expect(r2.ticket).toBe("B");
    expect((r2.init.headers as Headers).get(TICKET_HEADER)).toBeNull();
    expect((r2.init.headers as Headers).get("b")).toBe("2");

    const r3 = stripTicket("u", {
      headers: [
        [TICKET_HEADER, "C"],
        ["c", "3"],
      ],
    });
    expect(r3.ticket).toBe("C");
    expect(r3.init.headers).toEqual([["c", "3"]]);

    const req = new Request("https://x.test/", { headers: { [TICKET_HEADER]: "D", d: "4" } });
    const r4 = stripTicket(req, undefined);
    expect(r4.ticket).toBe("D");
    expect((r4.input as Request).headers.get(TICKET_HEADER)).toBeNull();
    expect((r4.input as Request).headers.get("d")).toBe("4");

    const plain = { headers: { a: "1" } };
    const r5 = stripTicket("u", plain);
    expect(r5.init).toBe(plain);
    expect(r5.ticket).toBeNull();
  });

  it("noteTicketSeen 有界（FIFO 1024）", () => {
    for (let i = 0; i < 1100; i++) noteTicketSeen(engine, `t${i}`);
    expect(engine.tapSeen.size).toBe(1024);
    expect(engine.tapSeen.has("t0")).toBe(false);
    expect(engine.tapSeen.has("t1099")).toBe(true);
  });
});
