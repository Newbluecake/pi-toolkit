/**
 * fetch 层改写拦截（T7 用例迁到 T2b 票据归属）：规则只作用于可证明归属的请求（ticket 绑定的 generation），
 * 线级字段 / 原始正文 / 改写元数据写到该 generation 的行；阻断按 (T, generation, 摘要) 吸收 SDK 重试。
 */
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ensureDb } from "../../src/traffic/db.js";
import { peekEngine, type TrafficEngine } from "../../src/traffic/engine.js";
import { TICKET_HEADER } from "../../src/traffic/tap.js";
import {
  activate,
  beginRequest,
  createUpstream,
  json,
  sse,
  URL_MESSAGES,
  type Activation,
  type Upstream,
} from "./helpers/harness.js";
import { teardownEngine } from "./helpers/engine.js";

const HAS_JQ = existsSync("/usr/bin/jq");
const payload = { messages: [{ role: "user", content: "capture rewrite test payload" }], temperature: 1 };
const originalBody = JSON.stringify(payload);
const rewrittenBody = '{"messages":[{"role":"user","content":"capture rewrite test payload"}],"temperature":0}';

let dir: string;
let realFetch: typeof globalThis.fetch;
let up: Upstream;
let host: Activation;
let engine: TrafficEngine;
let events: string[];

function addRule(r: { body_jq?: string | null; headers_jq?: string | null; name?: string } = {}): void {
  const now = new Date().toISOString();
  ensureDb(engine)
    .prepare(
      "INSERT INTO rewrite_rules (name, enabled, priority, body_jq, headers_jq, created_at, updated_at) VALUES (?, 1, 1, ?, ?, ?, ?)",
    )
    .run(r.name ?? "test rule", r.body_jq ?? null, r.headers_jq ?? null, now, now);
  // 发送路径只读内存快照（安全评审 #4）：规则写库后刷新（运行时由后台定时器 / T4 CRUD 后调用）。
  engine.refreshRules();
}

async function rowsAfterFlush(): Promise<Array<Record<string, any>>> {
  await engine.dbPort.whenIdle();
  return ensureDb(engine).prepare("SELECT * FROM requests ORDER BY id").all() as Array<Record<string, any>>;
}

/** 一个已配对的请求（headers + payload），返回带票据的 fetch 头。 */
async function paired(p: unknown = payload) {
  const req = await beginRequest(host);
  await req.payload(p);
  const headers: Record<string, string> = {};
  for (const [k, v] of Object.entries(req.headers)) if (v !== null) headers[k] = v;
  return { req, headers };
}

beforeEach(async () => {
  dir = mkdtempSync(join(tmpdir(), "pi-capture-rewrite-"));
  realFetch = globalThis.fetch;
  up = createUpstream(() => json(200, { ok: true }));
  globalThis.fetch = up.fetch;
  host = activate({ dbPath: join(dir, "traffic.db"), sessionId: "session" });
  await host.commands.get("record")!("on", host.ctx());
  engine = peekEngine()!;
  events = [];
  engine.sseClients.add({ write: (t: string) => (events.push(t), true) } as never);
});

afterEach(async () => {
  engine.sseClients.clear();
  await teardownEngine(engine);
  globalThis.fetch = realFetch;
  vi.useRealTimers();
  rmSync(dir, { recursive: true, force: true });
});

describe.skipIf(!HAS_JQ)("capture rewrite interception（票据归属）", () => {
  it("a: rewrites before orig and records final plus original payload/header metadata", async () => {
    addRule({ headers_jq: '. + {"Content-Length":"1", "X-Changed":"yes"}', body_jq: ".temperature = 0" });
    const { req } = await paired();
    const res = await req.fetch(originalBody);
    await req.respond(res);
    expect(up.calls).toHaveLength(1);
    expect(up.calls[0]!.body).toBe(rewrittenBody);
    expect(up.calls[0]!.headers["x-changed"]).toBe("yes");
    expect(up.calls[0]!.headers["content-length"]).not.toBe("1");
    expect(up.calls[0]!.headers[TICKET_HEADER]).toBeUndefined();
    const [row] = await rowsAfterFlush();
    expect(row).toMatchObject({
      payload: rewrittenBody,
      orig_payload: originalBody,
      rewrite_status: "applied",
      payload_encoding: "identity",
      payload_bytes: 87,
      status: 200,
      url: URL_MESSAGES,
      method: "POST",
    });
    expect(JSON.parse(row!.rewrite_rule_ids)).toEqual([1]);
    expect(JSON.parse(row!.request_headers)[TICKET_HEADER]).toBeUndefined();
    expect(engine.lastRewrittenAt.get("session")).toBeTypeOf("number");
  });

  it("b: blocks before orig, broadcasts safe events; the row records blocked", async () => {
    addRule({ body_jq: 'error("boom")' });
    const { req } = await paired();
    await expect(req.fetch(originalBody)).rejects.toThrow(
      'traffic-record rewrite blocked: [规则 "test rule" #1] body runtime_error',
    );
    expect(up.calls).toHaveLength(0);
    const [row] = await rowsAfterFlush();
    expect(row).toMatchObject({ status: 0, rewrite_status: "blocked" });
    expect(events.join("\n")).toContain('"type":"rewrite_error"');
    expect(events.join("\n")).toContain('"type":"response"');
  });

  it("c: a blocked request does not capture the next request: the next one writes its own row and is rewritten", async () => {
    addRule({ body_jq: 'if .messages[0].content == "second" then .temperature = 0 else error("boom") end' });
    const first = await paired();
    await expect(first.req.fetch(originalBody)).rejects.toThrow();
    await host.emit("message_end", { message: { role: "assistant", stopReason: "error" } });
    const secondPayload = { messages: [{ role: "user", content: "second" }], temperature: 1 };
    const second = await paired(secondPayload);
    const res = await second.req.fetch(JSON.stringify(secondPayload));
    await second.req.respond(res);
    const rows = await rowsAfterFlush();
    expect(rows).toHaveLength(2);
    expect(rows[0]!.status).toBe(0);
    expect(rows[0]!.payload).toBe(originalBody);
    expect(rows[1]!.status).toBe(200);
    expect(JSON.parse(up.calls[0]!.body!).temperature).toBe(0);
  });

  it("d: blocked generation absorbs SDK retries without another spawn, row write, or broadcast", async () => {
    addRule({ body_jq: 'error("boom")' });
    const { req } = await paired();
    const before = engine.jq.spawnCount();
    await expect(req.fetch(originalBody)).rejects.toThrow();
    await engine.dbPort.whenIdle();
    const afterFirst = engine.jq.spawnCount();
    const writesAfterFirst = engine.dbPort.stats().ticks;
    const e1 = await req.fetch(originalBody).catch((e: unknown) => e);
    const e2 = await req.fetch(originalBody).catch((e: unknown) => e);
    expect(afterFirst).toBeGreaterThanOrEqual(before);
    expect(engine.jq.spawnCount()).toBe(afterFirst);
    expect(e1).toBe(e2); // 同一错误对象
    expect(events.filter((ev) => ev.includes('"type":"rewrite_error"'))).toHaveLength(1);
    await engine.dbPort.whenIdle();
    expect(engine.dbPort.stats().ticks).toBe(writesAfterFirst); // 重试零写入
    expect(up.calls).toHaveLength(0); // 原请求从未放出
  });

  it("d2: blocked notifies pi once across SDK retries and across a fresh ticket in 30s, without leaking stderr", async () => {
    addRule({ body_jq: 'error("boom-secret-stderr")' });
    const notices: string[] = [];
    engine.capture.setRewriteBlockedHandler((m) => notices.push(m));
    const { req } = await paired();
    for (let i = 0; i < 3; i++) await expect(req.fetch(originalBody)).rejects.toThrow();
    await host.emit("message_end", { message: { role: "assistant" } });
    const again = await paired(); // agent 级重试：新票据，同 (会话, 规则集, 错误)
    await expect(again.req.fetch(originalBody)).rejects.toThrow();
    expect(notices).toHaveLength(1);
    expect(notices[0]).toContain("改写阻断");
    expect(notices[0]).toContain("test rule");
    expect(notices[0]).not.toContain("boom-secret-stderr");
  });

  it("e: records rewrite metadata even when the response has no body", async () => {
    addRule({ body_jq: ".temperature = 0" });
    up.queue.push(() => new Response(null, { status: 204 }));
    const { req } = await paired();
    await req.fetch(originalBody);
    const [row] = await rowsAfterFlush();
    expect(row).toMatchObject({
      rewrite_status: "applied",
      orig_payload: originalBody,
      payload_encoding: "identity",
      status: 204,
    });
  });

  it("f: stream capture continues after recording is turned off mid-stream", async () => {
    addRule({ body_jq: ".temperature = 0" });
    let ctl!: ReadableStreamDefaultController<Uint8Array>;
    up.queue.push(
      () =>
        new Response(new ReadableStream<Uint8Array>({ start: (c) => void (ctl = c) }), {
          status: 200,
          headers: { "content-type": "text/event-stream" },
        }),
    );
    const { req } = await paired();
    const res = await req.fetch(originalBody);
    await req.respond(res);
    await host.commands.get("record")!("off", host.ctx());
    const enc = new TextEncoder();
    ctl.enqueue(enc.encode("data: a\n\n"));
    ctl.close();
    await res.text();
    await new Promise((r) => setTimeout(r, 10));
    const [row] = await rowsAfterFlush();
    const chunks = ensureDb(engine)
      .prepare("SELECT data FROM stream_chunks WHERE request_id = ?")
      .all(row!.id) as Array<{
      data: string;
    }>;
    expect(chunks.map((c) => c.data).join("")).toBe("data: a\n\n");
    expect(row!.status).toBe(200);
  });

  it("g/n: recording off ⇒ no tickets minted, total bypass — no rule query, no jq, bytes unchanged", async () => {
    addRule({ body_jq: ".temperature = 0" });
    await host.commands.get("record")!("off", host.ctx());
    const before = engine.jq.spawnCount();
    const prepareSpy = vi.spyOn(ensureDb(engine), "prepare");
    const req = await beginRequest(host);
    expect(req.ticket()).toBeNull();
    await req.payload(payload);
    await req.fetch(originalBody);
    expect(up.calls[0]!.body).toBe(originalBody);
    expect(engine.jq.spawnCount()).toBe(before);
    expect(prepareSpy.mock.calls.filter(([sql]) => String(sql).includes("FROM rewrite_rules"))).toHaveLength(0);
  });

  it("g2: /record off between pairing and fetch ⇒ the paired fetch is not rewritten", async () => {
    addRule({ body_jq: ".temperature = 0" });
    const { req } = await paired();
    await host.commands.get("record")!("off", host.ctx());
    await req.fetch(originalBody);
    expect(up.calls[0]!.body).toBe(originalBody);
  });

  it("h: non-ticket fetches pass through without DB lookup or jq", async () => {
    const before = engine.jq.spawnCount();
    const prepareSpy = vi.spyOn(ensureDb(engine), "prepare");
    await globalThis.fetch("https://unrelated.example.test/data", { method: "POST", body: originalBody });
    expect(up.calls[0]!.url).toBe("https://unrelated.example.test/data");
    expect(engine.jq.spawnCount()).toBe(before);
    expect(prepareSpy).not.toHaveBeenCalled();
    expect(engine.dbError).toBeNull();
  });

  it("i: decompresses and recompresses zstd while persisting plaintext and wire bytes", async () => {
    const zlib = (await import("node:zlib")) as typeof import("node:zlib") & {
      zstdCompressSync?: (input: Uint8Array) => Uint8Array;
      zstdDecompressSync?: (input: Uint8Array) => Uint8Array;
    };
    if (!zlib.zstdCompressSync) return;
    addRule({ body_jq: ".temperature = 0" });
    const source = zlib.zstdCompressSync(Buffer.from(originalBody));
    const { headers } = await paired();
    const res = await globalThis.fetch(URL_MESSAGES, {
      method: "POST",
      body: source,
      headers: { ...headers, "content-encoding": "zstd" },
    });
    await res.text();
    const wire = Buffer.from(up.calls[0]!.body!, "latin1");
    expect(new TextDecoder().decode(zlib.zstdDecompressSync!(wire))).toContain('"temperature":0');
    const [row] = await rowsAfterFlush();
    expect(row).toMatchObject({ payload_encoding: "zstd", payload_bytes: wire.byteLength });
    expect(row!.payload).toContain('"temperature":0');
  });

  it("j: rebuilds Request input while preserving method, signal, and rewritten body", async () => {
    addRule({ body_jq: ".temperature = 0" });
    const { headers } = await paired();
    const controller = new AbortController();
    const request = new Request(URL_MESSAGES, {
      method: "PATCH",
      body: originalBody,
      headers,
      signal: controller.signal,
    });
    await globalThis.fetch(request);
    expect(up.calls[0]!.method).toBe("PATCH");
    expect(up.calls[0]!.signal?.aborted).toBe(false);
    expect(up.calls[0]!.body).toContain('"temperature":0');
    expect(up.calls[0]!.headers[TICKET_HEADER]).toBeUndefined();
  });

  it("k: with no enabled rules, records the unchanged request without jq", async () => {
    const before = engine.jq.spawnCount();
    const { req } = await paired();
    const res = await req.fetch(originalBody);
    await req.respond(res);
    expect(up.calls[0]!.body).toBe(originalBody);
    expect(engine.jq.spawnCount()).toBe(before);
    const [row] = await rowsAfterFlush();
    expect(row).toMatchObject({ payload: originalBody, rewrite_status: null, status: 200, url: URL_MESSAGES });
    expect(row!.orig_payload).toBeNull();
  });

  it("l: an unproven body on a bound ticket (digest mismatch) is passed through unchanged and never written to the ticket row", async () => {
    addRule({ body_jq: ".temperature = 0" });
    const { req } = await paired();
    const res = await req.fetch(JSON.stringify({ ...payload, extra: 1 }));
    await res.text();
    // 首次 fetch 即绑定摘要（gen.digest 取首个 fetch 正文）——再来一个不同正文才是未证明
    const res2 = await req.fetch(JSON.stringify({ ...payload, extra: 2 }));
    await res2.text();
    expect(JSON.parse(up.calls[1]!.body!).temperature).toBe(1);
    expect(engine.tickets.counters.unattributedFetches).toBe(1);
  });

  it("m: falls back to the ticket's headers snapshot for an unchanged request and leaves its response available", async () => {
    const req = await beginRequest(host);
    await req.payload(payload);
    // SDK 发 fetch 时只带票据（极端：其它头经 Request 默认值注入）
    const res = await globalThis.fetch(URL_MESSAGES, {
      method: "POST",
      headers: { [TICKET_HEADER]: req.ticket()! },
      body: originalBody,
    });
    expect(await res.json()).toEqual({ ok: true });
    const [row] = await rowsAfterFlush();
    expect(JSON.parse(row!.request_headers)).toMatchObject({
      "x-api-key": "key-session",
      "content-type": "application/json",
    });
    expect(engine.streamDone.size).toBe(0);
  });

  it("o: turning recording back on restores rewriting for subsequent requests", async () => {
    addRule({ body_jq: ".temperature = 0" });
    await host.commands.get("record")!("off", host.ctx());
    const off = await beginRequest(host);
    await off.payload(payload);
    await off.fetch(originalBody);
    expect(up.calls[0]!.body).toBe(originalBody);
    await host.commands.get("record")!("on", host.ctx());
    const { req } = await paired();
    await req.fetch(originalBody);
    expect(up.calls[1]!.body).toContain('"temperature":0');
  });

  it("p: streamed response of a bound request is captured to its own row via the ledger", async () => {
    up.queue.push(() => sse(["data: x\n\n", "data: y\n\n"]));
    const { req } = await paired();
    const res = await req.fetch(originalBody);
    await req.respond(res);
    await res.text();
    await new Promise((r) => setTimeout(r, 5));
    const [row] = await rowsAfterFlush();
    const n = (
      ensureDb(engine).prepare("SELECT COUNT(*) c FROM stream_chunks WHERE request_id = ?").get(row!.id) as {
        c: number;
      }
    ).c;
    expect(n).toBe(2);
    expect(engine.streamDone.has(row!.id)).toBe(true);
  });
});
