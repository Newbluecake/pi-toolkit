/**
 * 关联层（T2b，plan §5.3 / §8.1）：推断式关联退役。原 holder / pendingSlot / 唯一候选 / 正文探针 tie-break 的
 * 认领用例改为断言「不再推断」；纯函数工具（URL 边界、响应键、探针）保留原断言。
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import * as correlate from "../../src/traffic/correlate.js";
import { makeProbe, respKeyOf, urlMatchesBase } from "../../src/traffic/correlate.js";
import { ensureDb } from "../../src/traffic/db.js";
import { peekEngine, type TrafficEngine } from "../../src/traffic/engine.js";
import { activate, BASE_URL, beginRequest, createUpstream, URL_MESSAGES, type Activation } from "./helpers/harness.js";
import { teardownEngine } from "./helpers/engine.js";

const fetchUrl = URL_MESSAGES;
const body = JSON.stringify({ messages: [{ role: "user", content: "same payload used by concurrent requests" }] });

let dir: string;
let realFetch: typeof globalThis.fetch;
let host: Activation;
let engine: TrafficEngine;

beforeEach(async () => {
  dir = mkdtempSync(join(tmpdir(), "pi-traffic-corr-"));
  realFetch = globalThis.fetch;
  globalThis.fetch = createUpstream().fetch;
  host = activate({ dbPath: join(dir, "traffic.db"), sessionId: "S" });
  await host.commands.get("record")!("on", host.ctx());
  engine = peekEngine()!;
});

afterEach(async () => {
  await teardownEngine(engine);
  globalThis.fetch = realFetch;
  rmSync(dir, { recursive: true, force: true });
});

function rows(): Array<Record<string, any>> {
  return ensureDb(engine).prepare("SELECT * FROM requests ORDER BY id").all() as Array<Record<string, any>>;
}

describe("纯函数工具", () => {
  it("e/V14: URL 使用 origin 与路径边界，null/空 baseUrl 永不匹配", () => {
    expect(urlMatchesBase(`${BASE_URL}/messages`, BASE_URL)).toBe(true);
    expect(urlMatchesBase("https://api.example.test/v10/messages", BASE_URL)).toBe(false);
    expect(urlMatchesBase("https://other.example.test/v1/messages", BASE_URL)).toBe(false);
    expect(urlMatchesBase(fetchUrl, null)).toBe(false);
    expect(urlMatchesBase(fetchUrl, "")).toBe(false);
    expect(urlMatchesBase("not a URL", BASE_URL)).toBe(false);
  });

  it("respKeyOf 依次取 request-id 家族（大小写不敏感，Headers / 普通对象）", () => {
    expect(respKeyOf({ "Request-Id": "r1" })).toBe("r1");
    expect(respKeyOf(new Headers({ "x-request-id": "r2" }))).toBe("r2");
    expect(respKeyOf({ "cf-ray": "c" })).toBe("c");
    expect(respKeyOf({})).toBeNull();
  });

  it("makeProbe：<24 字符为 null，否则取中段 128 字符", () => {
    expect(makeProbe("short")).toBeNull();
    const probe = makeProbe(body)!;
    expect(body.includes(probe)).toBe(true);
    expect(probe.length).toBeLessThanOrEqual(128);
  });
});

describe("不再推断（holder / 唯一候选 / 正文探针）", () => {
  it("推断式关联层已退役：模块不再导出 createCorrelator，engine 上无 corr / pendingRequests / attempts", () => {
    expect((correlate as Record<string, unknown>).createCorrelator).toBeUndefined();
    const e = engine as unknown as Record<string, unknown>;
    expect(e.corr).toBeUndefined();
    expect(e.pendingRequests).toBeUndefined();
    expect(e.attempts).toBeUndefined();
    expect(engine.gate.gateStats()).toMatchObject({ active: false, retired: true, queueDepth: 0 });
  });

  it("b/A1: 相同 payload 的两个并发请求（同 runner，L 两张票据）⇒ 都不绑定、都不回填，行不互相串值", async () => {
    const a = await beginRequest(host);
    const b = await beginRequest(host);
    await a.payload(JSON.parse(body));
    await b.payload(JSON.parse(body));
    const ra = await a.fetch(body);
    const rb = await b.fetch(body);
    await a.respond(ra);
    await b.respond(rb);
    await engine.dbPort.whenIdle();
    const all = rows();
    expect(all).toHaveLength(2);
    for (const row of all) {
      expect(row.rewrite_status).toBe("unattributed");
      expect(row.url).toBeNull(); // 没有任何 fetch 被「最早的 waiting 候选」认领
      expect(row.status).toBeNull();
    }
  });

  it("a/orphan: 无票据的 provider fetch（同 URL、正文完全相同）不认领任何 waiting 行", async () => {
    const r = await beginRequest(host);
    await r.payload(JSON.parse(body));
    const res = await realLikeFetch(fetchUrl, body); // 不携带票据：例如 keepalive 自带 transformHeaders
    await res.text();
    await engine.dbPort.whenIdle();
    const all = rows();
    expect(all).toHaveLength(1);
    expect(all[0]!.url).toBeNull();
    expect(all[0]!.status).toBeNull();
  });

  it("f: after_provider_response 不按 status / respKey / 最近 settle 猜：并发 hook 级行一律不回填", async () => {
    const c = host.ctx({ api: "google-generative-ai" });
    const a = await beginRequest(host, c);
    const b = await beginRequest(host, c);
    await a.payload({ a: 1 });
    await b.payload({ b: 1 });
    await host.emit("after_provider_response", { status: 200, headers: { "request-id": "same" } }, c);
    await engine.dbPort.whenIdle();
    expect(rows().map((r) => r.status)).toEqual([null, null]);
    expect(engine.tickets.counters.unattributedResponses).toBe(1);
  });

  it("i/V8: 请求头按票据隔离（不再有进程单槽 stash）：两个 runner 交错，各行拿到自己的头", async () => {
    const child = activate({ role: "child", dbPath: join(dir, "traffic.db"), sessionId: "K" });
    const a = await beginRequest(host);
    const k = await beginRequest(child);
    await a.payload({ who: "a" });
    await k.payload({ who: "k" });
    await engine.dbPort.whenIdle();
    const all = rows();
    expect(JSON.parse(all.find((r) => r.session_id === "S")!.request_headers)["x-api-key"]).toBe("key-S");
    expect(JSON.parse(all.find((r) => r.session_id === "K")!.request_headers)["x-api-key"]).toBe("key-K");
  });
});

function realLikeFetch(url: string, b: string): Promise<Response> {
  return globalThis.fetch(url, { method: "POST", headers: { "content-type": "application/json" }, body: b });
}
