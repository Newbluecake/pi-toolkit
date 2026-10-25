/**
 * #6 归属故障矩阵（plan §5.3 / r3 裁定 R1-1）：评审交错、无交错 strict 回退、同 generation 网络重试、
 * hook 级并发回填，以及主/子会话交错、warming 交错、compaction、过期 / 旧纪元票据、白名单外 API、tap lost。
 *
 * 断言口径：每个线级记录只落到发起它的请求行；规则只作用于可证明归属的请求；无票据 / 无法证明的请求字节不变。
 */
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ensureDb } from "../../src/traffic/db.js";
import type { TrafficEngine } from "../../src/traffic/engine.js";
import { TICKET_HEADER } from "../../src/traffic/tap.js";
import { TICKET_TTL } from "../../src/traffic/ticket.js";
import {
  activate,
  beginRequest,
  createUpstream,
  fullRequest,
  json,
  sse,
  URL_MESSAGES,
  type Activation,
  type Upstream,
} from "./helpers/harness.js";
import { teardownEngine } from "./helpers/engine.js";

const HAS_JQ = existsSync("/usr/bin/jq");

let dir: string;
let dbPath: string;
let realFetch: typeof globalThis.fetch;
let up: Upstream;
let host: Activation;
let engine: TrafficEngine;

const strictPayload = (msg: string) => ({
  model: "m",
  temperature: 1,
  tools: [{ name: "t", strict: true }],
  messages: [{ role: "user", content: msg }],
});
/** pi-ai strict-tools 回退：同一请求去掉 strict 后再调一次 onPayload。 */
const fallbackPayload = (msg: string) => ({
  model: "m",
  temperature: 1,
  tools: [{ name: "t" }],
  messages: [{ role: "user", content: msg }],
});

function addRule(bodyJq = ".temperature = 0"): void {
  const now = new Date().toISOString();
  ensureDb(engine)
    .prepare(
      "INSERT INTO rewrite_rules (name, enabled, priority, body_jq, created_at, updated_at) VALUES ('t0', 1, 1, ?, ?, ?)",
    )
    .run(bodyJq, now, now);
  engine.refreshRules(); // 发送路径只读内存快照（安全评审 #4）
}

function rows(): Array<Record<string, any>> {
  return ensureDb(engine).prepare("SELECT * FROM requests ORDER BY id").all() as Array<Record<string, any>>;
}

beforeEach(async () => {
  dir = mkdtempSync(join(tmpdir(), "pi-traffic-attr-"));
  dbPath = join(dir, "traffic.db");
  realFetch = globalThis.fetch;
  up = createUpstream();
  globalThis.fetch = up.fetch;
  host = activate({ dbPath, sessionId: "S-main" });
  await host.commands.get("record")!("on", host.ctx());
  engine = (await import("../../src/traffic/engine.js")).peekEngine()!;
  expect(engine.recording).toBe(true);
});

afterEach(async () => {
  await teardownEngine(engine);
  globalThis.fetch = realFetch;
  vi.useRealTimers();
  rmSync(dir, { recursive: true, force: true });
});

describe.skipIf(!HAS_JQ)("评审交错与 generation", () => {
  it("评审交错：A 已配对 → 400 → B headers 铸 TB → A strict 回退 payload ⇒ 不绑定 TB、记 unattributed；A 回退 fetch 原样透传；B payload 同样 unattributed", async () => {
    addRule();
    const a = await beginRequest(host);
    const ta = a.ticket();
    expect(ta).toMatch(/^[0-9a-f]{32}$/);
    await a.payload(strictPayload("A"));
    up.queue.push(() =>
      json(400, { type: "error", error: { type: "invalid_request_error", message: "Too many strict tools (" } }),
    );
    const r1 = await a.fetch(JSON.stringify(strictPayload("A")));
    expect(r1.status).toBe(400);
    // gen 1 已改写（证明可归属的请求被规则作用）。
    expect(JSON.parse(up.calls[0]!.body!).temperature).toBe(0);

    // B 的 headers 在 A 回退之前铸 TB。
    const b = await beginRequest(host);
    const tb = b.ticket();
    expect(tb).not.toBe(ta);

    // A 的 strict 回退 payload 到达：L = {TA, TB} ⇒ 不绑定任何票据。
    await a.payload(fallbackPayload("A"));
    expect(engine.tickets.counters.unattributedPayloads).toBe(1);
    expect(engine.tickets.lookup(tb!)!.generation).toBeNull();
    expect(engine.tickets.lookup(ta!)!.generation!.gen).toBe(1);

    // B 随后的 payload（L={TA,TB}，TA 的 400 未退役）同样 unattributed。
    await b.payload(strictPayload("B"));
    expect(engine.tickets.counters.unattributedPayloads).toBe(2);
    expect(engine.tickets.lookup(tb!)!.generation).toBeNull();

    // A 的回退 fetch（携 TA，正文摘要 ≠ gen 1）⇒ 原样透传、不改写、不写 TA 的行。
    const fallbackBody = JSON.stringify(fallbackPayload("A"));
    const r2 = await a.fetch(fallbackBody);
    await a.respond(r2);
    expect(up.calls[1]!.body).toBe(fallbackBody); // 字节不变
    expect(JSON.parse(up.calls[1]!.body!).temperature).toBe(1);
    expect(up.calls[1]!.body).not.toBe(up.calls[0]!.body); // 回退正文与首发确实不同
    expect(JSON.parse(up.calls[0]!.body!).tools[0].strict).toBe(true);
    expect(JSON.parse(up.calls[1]!.body!).tools[0].strict).toBeUndefined();
    expect(engine.tickets.counters.unattributedFetches).toBe(1);

    // B 的 fetch（TB 从未绑定）⇒ 剥离透传、不改写。
    const rb = await b.fetch(JSON.stringify(strictPayload("B")));
    await b.respond(rb);
    expect(JSON.parse(up.calls[2]!.body!).temperature).toBe(1);
    // 票据头恒剥离。
    for (const call of up.calls) expect(call.headers[TICKET_HEADER]).toBeUndefined();

    await engine.dbPort.whenIdle();
    const all = rows();
    // gen1 行（TA）：首发改写 + 400；回退与 B 的 payload 各一条 unattributed hook 级行。
    expect(all).toHaveLength(3);
    expect(all[0]!.status).toBe(400);
    expect(all[0]!.rewrite_status).toBe("applied");
    expect(JSON.parse(all[0]!.payload).temperature).toBe(0);
    expect(JSON.parse(all[0]!.orig_payload).tools[0].strict).toBe(true);
    expect(all[1]!.rewrite_status).toBe("unattributed");
    expect(JSON.parse(all[1]!.payload).tools[0].strict).toBeUndefined();
    expect(all[1]!.url).toBeNull(); // A 回退 fetch 不写任何票据行的线级字段
    expect(all[2]!.rewrite_status).toBe("unattributed");
    expect(all[2]!.url).toBeNull();
  });

  it("安全评审 #1（E1）：A 400 后超过 30s（SDK 仍在读错误体）B 铸 TB ⇒ A 迟到的 strict 回退 payload 不绑定 TB；B 也不被改写；message_end 后恢复配对", async () => {
    addRule();
    vi.useFakeTimers({ toFake: ["Date"] });
    const a = await beginRequest(host);
    const ta = a.ticket()!;
    await a.payload(strictPayload("A"));
    up.queue.push(() =>
      json(400, { type: "error", error: { type: "invalid_request_error", message: "Too many strict tools (" } }),
    );
    const r1 = await a.fetch(JSON.stringify(strictPayload("A")));
    expect(r1.status).toBe(400);
    expect(JSON.parse(up.calls[0]!.body!).temperature).toBe(0);
    // 400 响应头已到、inFlight=0；SDK 读错误体的时间没有上界 —— 超过 failedRetireMs。
    vi.setSystemTime(Date.now() + TICKET_TTL.failedRetireMs + 1);
    const b = await beginRequest(host); // mint 的 sweep 让 TA 以 TTL 退役 ⇒ 墓碑
    const tb = b.ticket()!;
    expect(engine.tickets.lookup(ta)!.retiredReason).toBe("ttl");
    await r1.text();
    // A 迟到的回退 payload：L={TB}，但 runner 有墓碑 ⇒ 不绑定。
    await a.payload(fallbackPayload("A"));
    expect(engine.tickets.lookup(tb)!.generation).toBeNull();
    expect(engine.tickets.counters.tombstonedPayloads).toBe(1);
    await b.payload(strictPayload("B"));
    expect(engine.tickets.lookup(tb)!.generation).toBeNull();
    expect(engine.tickets.counters.tombstonedPayloads).toBe(2);
    // 两次 fetch 均原样透传（规则不作用于无法证明的请求）。
    const fallbackBody = JSON.stringify(fallbackPayload("A"));
    await (await a.fetch(fallbackBody)).text();
    expect(up.calls[1]!.body).toBe(fallbackBody);
    const bBody = JSON.stringify(strictPayload("B"));
    await (await b.fetch(bBody)).text();
    expect(up.calls[2]!.body).toBe(bBody);
    expect(JSON.parse(up.calls[2]!.body!).temperature).toBe(1);
    // 完成边界：本轮 assistant message_end ⇒ 清墓碑，下一个请求恢复可证明。
    await host.emit("message_end", { message: { role: "assistant", content: [] } });
    vi.useRealTimers();
    await fullRequest(host, strictPayload("C"));
    expect(JSON.parse(up.calls[3]!.body!).temperature).toBe(0);
    expect(engine.tickets.counters.tombstonesCleared).toBe(1);
  });

  it("A 已配对 → 400 → B headers → B payload 先到（L={TA,TB}）⇒ B 不绑定、不改写", async () => {
    addRule();
    const a = await beginRequest(host);
    await a.payload(strictPayload("A"));
    up.queue.push(() => json(400));
    await a.fetch(JSON.stringify(strictPayload("A")));
    const b = await beginRequest(host);
    await b.payload(strictPayload("B"));
    const res = await b.fetch(JSON.stringify(strictPayload("B")));
    await b.respond(res);
    expect(engine.tickets.counters.unattributedPayloads).toBe(1);
    expect(JSON.parse(up.calls[1]!.body!).temperature).toBe(1);
  });

  it("无交错 strict 回退：L={TA} ⇒ generation 2，stub 收到对**新正文**重新改写的字节（不是 gen 1 结果的重放），gen 2 新行", async () => {
    addRule();
    const a = await beginRequest(host);
    await a.payload(strictPayload("A"));
    up.queue.push(() => json(400));
    await a.fetch(JSON.stringify(strictPayload("A")));
    await a.payload(fallbackPayload("A"));
    const ticket = engine.tickets.lookup(a.ticket()!)!;
    expect(ticket.generation!.gen).toBe(2);
    expect(engine.tickets.counters.generationBumps).toBe(1);
    const res = await a.fetch(JSON.stringify(fallbackPayload("A")));
    await a.respond(res);
    const sent = JSON.parse(up.calls[1]!.body!);
    expect(sent.temperature).toBe(0); // 重新改写
    expect(sent.tools[0].strict).toBeUndefined(); // 是新正文
    expect(up.calls[1]!.body).not.toBe(up.calls[0]!.body);
    expect(ticket.retired).toBe(true); // 2xx ⇒ 退役（规则 ①）
    await engine.dbPort.whenIdle();
    const all = rows();
    expect(all).toHaveLength(2);
    expect(all[0]!.status).toBe(400);
    expect(all[1]!.status).toBe(200);
    expect(all[1]!.rewrite_status).toBe("applied");
    expect(JSON.parse(all[1]!.orig_payload).tools[0].strict).toBeUndefined();
  });

  it("同 generation 网络重试：529 后重试 ⇒ 字节一致、jq 只跑一次", async () => {
    addRule();
    const runSpy = vi.spyOn(engine.jq, "run");
    const a = await beginRequest(host);
    const payload = strictPayload("A");
    await a.payload(payload);
    up.queue.push(() => json(529));
    const r1 = await a.fetch(JSON.stringify(payload));
    expect(r1.status).toBe(529);
    const r2 = await a.fetch(JSON.stringify(payload)); // SDK 内重试：同 headers 同正文
    await a.respond(r2);
    expect(up.calls).toHaveLength(2);
    expect(up.calls[1]!.body).toBe(up.calls[0]!.body);
    expect(JSON.parse(up.calls[1]!.body!).temperature).toBe(0);
    expect(runSpy).toHaveBeenCalledTimes(1);
    await engine.dbPort.whenIdle();
    const all = rows();
    expect(all).toHaveLength(1);
    expect(all[0]!.status).toBe(200);
  });

  it("同 generation 并发重试（第一次改写尚未完成）也只跑一次 jq，两次字节一致", async () => {
    addRule();
    const runSpy = vi.spyOn(engine.jq, "run");
    const a = await beginRequest(host);
    const payload = strictPayload("A");
    await a.payload(payload);
    const [x, y] = await Promise.all([a.fetch(JSON.stringify(payload)), a.fetch(JSON.stringify(payload))]);
    await Promise.all([x.text(), y.text()]);
    expect(runSpy).toHaveBeenCalledTimes(1);
    expect(up.calls[0]!.body).toBe(up.calls[1]!.body);
  });
});

describe("hook 级响应回填", () => {
  it("白名单外 API：两条并发 hook 级行 ⇒ 均不回填，unattributedResponses=2", async () => {
    const c = host.ctx({ api: "bedrock-converse-stream" });
    const a = await beginRequest(host, c);
    const b = await beginRequest(host, c);
    expect(a.ticket()).toBeNull();
    expect(b.ticket()).toBeNull();
    await a.payload({ n: "A" });
    await b.payload({ n: "B" });
    const ra = await a.fetch('{"n":"A"}');
    const rb = await b.fetch('{"n":"B"}');
    await a.respond(ra);
    await b.respond(rb);
    expect(engine.tickets.counters.unattributedResponses).toBe(2);
    await engine.dbPort.whenIdle();
    const all = rows();
    expect(all).toHaveLength(2);
    expect(all.map((r) => r.status)).toEqual([null, null]);
    expect(all.map((r) => r.rewrite_status)).toEqual([null, null]);
  });

  it("恰一条 hook 级行且无存活票据 ⇒ 回填", async () => {
    const c = host.ctx({ api: "bedrock-converse-stream" });
    const a = await beginRequest(host, c);
    await a.payload({ n: "A" });
    const res = await a.fetch('{"n":"A"}');
    await a.respond(res);
    await engine.dbPort.whenIdle();
    expect(rows()[0]!.status).toBe(200);
    expect(engine.tickets.counters.hookBackfills).toBe(1);
  });

  it("票据请求 2xx 后（票据已退役）的 after_provider_response 不会回填一条无关的 hook 级行", async () => {
    // 一条白名单外请求失败（无 after），残留为等待中的 hook 级行
    const c = host.ctx({ api: "bedrock-converse-stream" });
    const stuck = await beginRequest(host, c);
    await stuck.payload({ n: "stuck" });
    // 随后一个票据请求成功
    const t = await beginRequest(host);
    await t.payload({ n: "T", messages: [] });
    const res = await t.fetch(JSON.stringify({ n: "T", messages: [] }));
    await t.respond(res);
    await engine.dbPort.whenIdle();
    const all = rows();
    expect(all[0]!.status).toBeNull(); // 未被冒充回填
    expect(all[1]!.status).toBe(200); // 票据行由 fetch 层精确写入
    expect(engine.tickets.counters.unattributedResponses).toBe(1);
  });
});

describe("其余交错与边界", () => {
  it("主/子会话同 origin 交错（正文与凭证不同）⇒ 每行只拿到自己的线级头与状态", async () => {
    const child = activate({ role: "child", dbPath, sessionId: "S-child" });
    const m = await beginRequest(host);
    const k = await beginRequest(child);
    await k.payload({ who: "child" });
    await m.payload({ who: "main" });
    up.queue.push(() => json(429)); // 子会话的第一个请求
    const rk = await k.fetch('{"who":"child"}');
    const rm = await m.fetch('{"who":"main"}');
    await m.respond(rm);
    expect(rk.status).toBe(429);
    const rk2 = await k.fetch('{"who":"child"}');
    await k.respond(rk2);
    await engine.dbPort.whenIdle();
    const all = rows();
    const main = all.find((r) => r.session_id === "S-main")!;
    const kid = all.find((r) => r.session_id === "S-child")!;
    expect(JSON.parse(main.request_headers)["x-api-key"]).toBe("key-S-main");
    expect(JSON.parse(kid.request_headers)["x-api-key"]).toBe("key-S-child");
    expect(main.status).toBe(200);
    expect(kid.status).toBe(200);
    expect(JSON.parse(main.payload).who).toBe("main");
    expect(JSON.parse(kid.payload).who).toBe("child");
  });

  it("streaming warming 与真实请求交错（同 runner 两张存活票据）⇒ 两者都 unattributed；规则 ② 在 warming 窗口内不退役", async () => {
    await host.emit("cache_warming_decision", { action: "send", warmCost: 0, missCost: 1, continuationProbability: 1 });
    const real = await beginRequest(host);
    const warm = await beginRequest(host);
    await real.payload({ k: "real" });
    await warm.payload({ k: "warm", max_tokens: 1 });
    expect(engine.tickets.counters.unattributedPayloads).toBe(2);
    await host.emit("message_end", { message: { role: "assistant" } });
    expect(engine.tickets.liveOf(engine.tickets.lookup(real.ticket()!)!.runner)).toHaveLength(2);
  });

  it("安全评审 #3：扩展拿不到 warming 的最终裁定 ⇒ action=stop 的 decision 事件同样使规则 ② 在 60s 内不成立", async () => {
    await host.emit("cache_warming_decision", { action: "stop", warmCost: 1, missCost: 0, continuationProbability: 0 });
    const a = await beginRequest(host);
    await host.emit("message_end", { message: { role: "assistant" } });
    // 修复前：stop ⇒ 不记 warmingAllowedAt ⇒ message_end 退役了可能正被（其它 handler 改判为 warm 的）warming 使用的票据。
    expect(engine.tickets.lookup(a.ticket()!)!.retired).toBe(false);
    expect(engine.tickets.counters.retiredByMessageEnd).toBe(0);
  });

  it("裁定 A4（复审反例）：warming W 延迟 >60s → A 的 message_end 退役 W、清墓碑 → B 铸 TB → W 迟到 payload ⇒ TB 的请求不被改写；/record off→on 后恢复", async () => {
    addRule();
    vi.useFakeTimers({ toFake: ["Date"] });
    await host.emit("cache_warming_decision", { action: "send", warmCost: 0, missCost: 1, continuationProbability: 1 });
    const w = await beginRequest(host); // warming：headers 已触发，payload 卡在异步钩子 / 错误体读取
    const tw = w.ticket()!;
    vi.setSystemTime(Date.now() + TICKET_TTL.warmingWindowMs + 1);
    await host.emit("message_end", { message: { role: "assistant", content: [] } }); // 窗口已过：规则 ② 成立
    expect(engine.tickets.lookup(tw)?.retired ?? true).toBe(true);
    const b = await beginRequest(host);
    const tb = b.ticket()!;
    await w.payload({ temperature: 1, max_tokens: 1, w: true }); // 迟到：L={TB} ⇒ 录制层可能错配（已接受残留）
    await b.payload(strictPayload("B"));
    const bBody = JSON.stringify(strictPayload("B"));
    await (await b.fetch(bBody)).text();
    // 关键：携 TB 的请求一律不改写（改写路径 fail closed，不按时间解除）。
    expect(up.calls[0]!.body).toBe(bBody);
    expect(JSON.parse(up.calls[0]!.body!).temperature).toBe(1);
    expect(engine.tickets.lookup(tb)!.runner.rewriteSuspended).toBe(true);
    expect(engine.tickets.counters.rewriteSuspendedRequests).toBeGreaterThanOrEqual(1);
    // 时间再过很久也不解除。
    vi.setSystemTime(Date.now() + 24 * 3600_000);
    await fullRequest(host, strictPayload("C"));
    expect(JSON.parse(up.calls[1]!.body!).temperature).toBe(1);
    vi.useRealTimers();
    // 可验证边界：/record off → on。
    await host.commands.get("record")!("off", host.ctx());
    await host.commands.get("record")!("on", host.ctx());
    await fullRequest(host, strictPayload("D"));
    expect(JSON.parse(up.calls[2]!.body!).temperature).toBe(0);
    expect(engine.tickets.counters.rewriteResumes).toBe(1);
    await engine.dbPort.whenIdle();
    expect(rows().some((r) => r.rewrite_status === "suspended")).toBe(true);
  });

  it("裁定 A4：子会话 warming 未完成时 agent_settled ⇒ 不清 warming 状态 / 改写暂停；之后 B 的请求不被改写", async () => {
    addRule();
    const child = activate({ role: "child", dbPath, sessionId: "S-child" });
    await child.emit("cache_warming_decision", {
      action: "send",
      warmCost: 0,
      missCost: 1,
      continuationProbability: 1,
    });
    const w = await beginRequest(child);
    const runner = engine.tickets.lookup(w.ticket()!)!.runner;
    const warmedAt = runner.warmingAllowedAt;
    await child.emit("agent_settled", {}); // W 尚未完成（无 payload、无 fetch）
    expect(runner.warmingAllowedAt).toBe(warmedAt);
    expect(runner.rewriteSuspended).toBe(true);
    const b = await beginRequest(child);
    await w.payload({ temperature: 1, w: true }); // 迟到 warming payload
    await b.payload(strictPayload("B"));
    const bBody = JSON.stringify(strictPayload("B"));
    await (await b.fetch(bBody)).text();
    expect(up.calls[0]!.body).toBe(bBody);
    expect(JSON.parse(up.calls[0]!.body!).temperature).toBe(1);
  });

  it("裁定 A1：暂停后「规则全部禁用 → 再启用」是解除边界；暂停期间规则仍启用的刷新不解除；绑定在 decision 之前的票据 fetch 也不改写", async () => {
    addRule();
    const early = await beginRequest(host);
    await early.payload(strictPayload("E")); // decision 之前已绑定（generation 带规则）
    await host.emit("cache_warming_decision", { action: "stop", warmCost: 1, missCost: 0, continuationProbability: 0 });
    const eBody = JSON.stringify(strictPayload("E"));
    await (await early.fetch(eBody)).text();
    expect(up.calls[0]!.body).toBe(eBody); // fetch 层检查：暂停后不对任何请求应用规则
    await host.emit("message_end", { message: { role: "assistant", content: [] } });
    engine.refreshRules(); // 规则仍启用：不是边界
    await fullRequest(host, strictPayload("F"));
    expect(JSON.parse(up.calls[1]!.body!).temperature).toBe(1);
    ensureDb(engine).exec("UPDATE rewrite_rules SET enabled = 0");
    engine.refreshRules(); // 观测到零启用规则
    ensureDb(engine).exec("UPDATE rewrite_rules SET enabled = 1");
    engine.refreshRules();
    await fullRequest(host, strictPayload("G"));
    expect(JSON.parse(up.calls[2]!.body!).temperature).toBe(0);
  });

  it("裁定 A2：T5 否决端口——TrafficWiring.rewriteArmed() = open ∧ 录制中 ∧ 有启用规则", async () => {
    expect(host.wiring!.rewriteArmed()).toBe(false); // 无规则
    addRule();
    expect(host.wiring!.rewriteArmed()).toBe(true);
    await host.commands.get("record")!("off", host.ctx());
    expect(host.wiring!.rewriteArmed()).toBe(false);
  });

  it("compaction 只触发 headers：票据铸造但从未绑定 ⇒ fetch 剥离透传、不录线级字段；2xx 后退役，不影响下一个请求的配对", async () => {
    const comp = await beginRequest(host);
    const res = await comp.fetch('{"summary":true}');
    await res.text();
    expect(up.calls[0]!.headers[TICKET_HEADER]).toBeUndefined();
    expect(engine.tickets.lookup(comp.ticket()!)!.retired).toBe(true);
    await fullRequest(host, { after: "compaction" });
    await engine.dbPort.whenIdle();
    const all = rows();
    expect(all).toHaveLength(1);
    expect(all[0]!.url).toBe(URL_MESSAGES);
    expect(engine.tickets.counters.ticketsBound).toBe(1);
  });

  it("票据过期回收后的迟到 fetch ⇒ 剥离透传，staleTickets++", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    const r = await beginRequest(host);
    vi.setSystemTime(Date.now() + TICKET_TTL.unboundMs + 1);
    engine.tickets.sweep();
    vi.useRealTimers();
    const res = await r.fetch('{"late":1}');
    await res.text();
    expect(up.calls[0]!.headers[TICKET_HEADER]).toBeUndefined();
    expect(engine.tickets.counters.staleTickets).toBe(1);
  });

  it("reload 后旧纪元的票据 ⇒ 新 engine 不认，剥离透传", async () => {
    const r = await beginRequest(host);
    await r.payload({ a: 1 });
    // reload：旧激活 shutdown，新激活 /record on
    await host.emit("session_shutdown", { reason: "reload" });
    globalThis.fetch = up.fetch;
    const host2 = activate({ dbPath, sessionId: "S-main" });
    await host2.commands.get("record")!("on", host2.ctx());
    engine = (await import("../../src/traffic/engine.js")).peekEngine()!;
    const res = await r.fetch('{"a":1}');
    await res.text();
    expect(up.calls[0]!.headers[TICKET_HEADER]).toBeUndefined();
    expect(engine.tickets.counters.staleTickets).toBe(1);
    await engine.dbPort.whenIdle();
    expect(rows().every((row) => row.url === null)).toBe(true);
  });

  it.skipIf(!HAS_JQ)("白名单外 API：不铸票据、只写 hook 级行、规则不生效并一次性提示", async () => {
    addRule();
    const c = host.ctx({ api: "openai-codex-responses" });
    for (let i = 0; i < 2; i++) {
      const r = await beginRequest(host, c);
      expect(r.ticket()).toBeNull();
      await r.payload({ temperature: 1 });
      const res = await r.fetch('{"temperature":1}');
      await r.respond(res);
    }
    for (const call of up.calls) expect(JSON.parse(call.body!).temperature).toBe(1);
    expect(engine.tickets.counters.unsupportedApiPayloads).toBe(2);
    expect(host.notes.filter((n) => n.includes("不在票据白名单"))).toHaveLength(1);
    expect(engine.codexWsWarned).toBe(true);
  });

  it("无票据请求（keepalive/quota/title/topic 风格：不经钩子的裸 fetch）⇒ 字节不变、零行", async () => {
    addRule();
    const body = '{"temperature":1,"messages":[]}';
    const res = await globalThis.fetch(URL_MESSAGES, { method: "POST", headers: { "x-api-key": "k" }, body });
    await res.text();
    expect(up.calls[0]!.body).toBe(body);
    await engine.dbPort.whenIdle();
    expect(rows()).toHaveLength(0);
  });

  it("tap lost：已绑定票据的请求绕过活动 wrapper（第三方丢弃了它）而响应已到 ⇒ 停录、notify 一次", async () => {
    const r = await beginRequest(host);
    await r.payload({ a: 1 });
    // 请求走了一个不经 wrapper 的下游
    const res = await up.fetch(URL_MESSAGES, { method: "POST", body: '{"a":1}' });
    await r.respond(res);
    expect(engine.tapLost).toBe(true);
    expect(engine.recording).toBe(false);
    expect(host.notes.filter((n) => n.includes("tap lost"))).toHaveLength(1);
  });

  it("规则 ②：assistant message_end 退役本 runner 全部存活票据，随后的请求可证明", async () => {
    const a = await beginRequest(host);
    await a.payload({ a: 1 });
    up.queue.push(() => json(500));
    await a.fetch('{"a":1}');
    // agent 级重试前，pi 先结束失败的 assistant 消息
    await host.emit("message_end", { message: { role: "assistant" } });
    expect(engine.tickets.lookup(a.ticket()!)!.retired).toBe(true);
    const b = await beginRequest(host);
    await b.payload({ b: 1 });
    expect(engine.tickets.lookup(b.ticket()!)!.generation?.gen).toBe(1);
    expect(engine.tickets.counters.unattributedPayloads).toBe(0);
  });

  it("流式响应 chunk 合并入库到票据行", async () => {
    up.queue.push(() => sse(["data: 1\n\n", "data: 2\n\n", "data: 3\n\n"]));
    await fullRequest(host, { s: 1 });
    await new Promise((r) => setTimeout(r, 20));
    await engine.dbPort.whenIdle();
    const id = rows()[0]!.id;
    const chunks = ensureDb(engine)
      .prepare("SELECT seq, data FROM stream_chunks WHERE request_id = ? ORDER BY seq")
      .all(id);
    expect(chunks.map((c: any) => c.data).join("")).toBe("data: 1\n\ndata: 2\n\ndata: 3\n\n");
    expect(engine.streamDone.has(id)).toBe(true);
  });
});
