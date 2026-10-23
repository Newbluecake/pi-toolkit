import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import * as zlib from "node:zlib";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import * as dbModule from "../../src/traffic/db.js";
import { ensureDb } from "../../src/traffic/db.js";
import { accessUrls, startServer } from "../../src/traffic/server.js";
import { resetState, state } from "../../src/traffic/state.js";

let dir: string;
let port: number;
let sourceId: number;
let upstreamCalls = 0;
let lastFetchInit: RequestInit | undefined;
let upstream: ReturnType<typeof createServer>;

function jsonHeaders(): Record<string, string> {
  return { "content-type": "application/json", "x-api-key": "secret" };
}

async function api(path: string, init?: RequestInit): Promise<{ response: Response; body: any }> {
  const response = await fetch(`http://127.0.0.1:${port}${path}`, init);
  let body: any = null;
  try {
    body = await response.json();
  } catch {}
  return { response, body };
}

async function sendJson(path: string, method: string, value: unknown): Promise<{ response: Response; body: any }> {
  return api(path, {
    method,
    headers: { "content-type": "application/json" },
    body: JSON.stringify(value),
  });
}

function addSource(sessionId = "source-session"): number {
  const result = ensureDb()
    .prepare(
      `INSERT INTO requests (session_id, turn, ts, provider, model, payload, request_headers, url, method)
			 VALUES (?, 0, ?, 'test', 'test-model', ?, ?, ?, 'POST')`,
    )
    .run(
      sessionId,
      new Date().toISOString(),
      JSON.stringify({ temperature: 1 }),
      JSON.stringify(jsonHeaders()),
      `http://127.0.0.1:${upstream.address() && typeof upstream.address() !== "string" ? (upstream.address() as { port: number }).port : 0}/rewrite`,
    );
  return Number(result.lastInsertRowid);
}

async function waitForSse(reader: ReadableStreamDefaultReader<Uint8Array>, expected: string): Promise<string> {
  const decoder = new TextDecoder();
  let text = "";
  const deadline = Date.now() + 3000;
  while (Date.now() < deadline) {
    const next = await Promise.race([
      reader.read(),
      new Promise<never>((_, reject) => setTimeout(() => reject(new Error("SSE timeout")), 3000)),
    ]);
    if (next.done) break;
    text += decoder.decode(next.value, { stream: true });
    if (text.includes(expected)) return text;
  }
  throw new Error(`SSE event not received: ${expected}`);
}

async function countRules(name: string): Promise<number> {
  const listed = await api("/api/rewrite/rules");
  return (listed.body as Array<{ name: string }>).filter((r) => r.name === name).length;
}

beforeAll(async () => {
  dir = mkdtempSync(join(tmpdir(), "pi-traffic-rewrite-api-"));
  resetState();
  state.dbPath = join(dir, "traffic.db");
  // 改写引擎（含重放）按录制开关门控，重放改写用例需显式开启录制。
  state.recording = true;
  ensureDb();

  upstream = createServer((_req: IncomingMessage, res: ServerResponse) => {
    upstreamCalls++;
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ ok: true }));
  });
  await new Promise<void>((resolve) => upstream.listen(0, "127.0.0.1", resolve));
  port = await startServer();
  sourceId = addSource();
  state.originalFetch = async (input: RequestInfo | URL, init?: RequestInit) => {
    lastFetchInit = init;
    return fetch(input, init);
  };
});

afterAll(async () => {
  state.originalFetch = null;
  await new Promise<void>((resolve) => upstream.close(() => resolve()));
  await new Promise<void>((resolve) => state.server?.close(() => resolve()));
  resetState();
  rmSync(dir, { recursive: true, force: true });
});

describe("rewrite API", () => {
  it("supports CRUD and broadcasts every successful rule mutation", async () => {
    const events = await fetch(`http://127.0.0.1:${port}/api/events`);
    const reader = events.body!.getReader();
    await reader.read();

    const created = await sendJson("/api/rewrite/rules", "POST", {
      name: "temperature",
      enabled: 0,
      priority: 2,
      url_pattern: "/rewrite$",
      method: "post",
      model: "MODEL",
      body_jq: " .temperature = 0 ",
      headers_jq: " . ",
    });
    expect(created.response.status).toBe(201);
    expect(created.body).toMatchObject({
      name: "temperature",
      enabled: 0,
      priority: 2,
      method: "POST",
      body_jq: ".temperature = 0",
    });
    await expect(waitForSse(reader, '"type":"rewrite_rules"')).resolves.toBeTruthy();

    const id = created.body.id as number;
    const listed = await api("/api/rewrite/rules");
    expect(listed.body.map((r: any) => r.id)).toContain(id);

    const updated = await sendJson(`/api/rewrite/rules/${id}`, "PUT", {
      name: "temperature-updated",
      enabled: 1,
      priority: -10,
      url_pattern: null,
      method: "",
      model: "",
      body_jq: ".temperature = 0",
      headers_jq: null,
    });
    expect(updated.response.status).toBe(200);
    expect(updated.body).toMatchObject({ name: "temperature-updated", enabled: 1, priority: -10, method: null });
    await expect(waitForSse(reader, '"type":"rewrite_rules"')).resolves.toBeTruthy();

    const removed = await api(`/api/rewrite/rules/${id}`, { method: "DELETE" });
    expect(removed.response.status).toBe(200);
    await expect(waitForSse(reader, '"type":"rewrite_rules"')).resolves.toBeTruthy();
    await reader.cancel();
  });

  it.each([
    ["abc", '{"name":"bad","priority":"abc"}'],
    ["fraction", JSON.stringify({ name: "bad", priority: 1.5 })],
    ["infinity", '{"name":"bad","priority":Infinity}'],
    ["empty name", JSON.stringify({ name: "   ", priority: 1 })],
    ["bad regex", JSON.stringify({ name: "bad", priority: 1, url_pattern: "[" })],
    ["bad method", JSON.stringify({ name: "bad", priority: 1, method: "OPTIONS" })],
  ] as const)("rejects %s with 400", async (_label, raw) => {
    const result = await api("/api/rewrite/rules", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: raw,
    });
    expect(result.response.status).toBe(400);
    expect(result.body.error).toBeTruthy();
  });

  it("returns 404 for missing rules", async () => {
    const get = await api("/api/rewrite/rules/999999");
    const put = await sendJson("/api/rewrite/rules/999999", "PUT", { name: "x", priority: 1 });
    const del = await api("/api/rewrite/rules/999999", { method: "DELETE" });
    expect(get.response.status).toBe(404);
    expect(put.response.status).toBe(404);
    expect(del.response.status).toBe(404);
  });

  it("rejects a jq program that is really a shell command, with a corrective hint", async () => {
    // 真实事故：用户把整条 shell 命令粘进 body_jq，单引号在 jq 语言里非法，
    // 结果每个 provider 请求都被 fail-closed 阻断，且只显示 "Connection error."。
    const created = await sendJson("/api/rewrite/rules", "POST", {
      name: "shell wrapped",
      priority: 1,
      enabled: true,
      body_jq: `jq '.thinking.type = "adaptive"'`,
    });
    expect(created.response.status).toBe(400);
    expect(String(created.body.error)).toContain("body_jq");
    expect(String(created.body.error)).toContain('.thinking.type = "adaptive"');
    expect(await countRules("shell wrapped")).toBe(0);
  });

  it("rejects an invalid headers_jq but accepts a valid program", async () => {
    const bad = await sendJson("/api/rewrite/rules", "POST", {
      name: "bad headers",
      priority: 1,
      enabled: true,
      headers_jq: ".[ unclosed",
    });
    expect(bad.response.status).toBe(400);
    expect(String(bad.body.error)).toContain("headers_jq");

    const good = await sendJson("/api/rewrite/rules", "POST", {
      name: "good headers",
      priority: 1,
      enabled: true,
      headers_jq: '.["x-trace"] = "1"',
    });
    expect(good.response.status).toBe(201);
    await api(`/api/rewrite/rules/${good.body.id}`, { method: "DELETE" });
  });

  it("never locks the user out: a disabled save of a broken rule is always allowed", async () => {
    // UI 的 enabled 复选框是一次全量 PUT。若无条件校验 jq，
    // 「已启用的坏规则」会连停用都做不到 —— 用户被永久锁在阻断状态。
    const created = await sendJson("/api/rewrite/rules", "POST", {
      name: "broken but disabled",
      priority: 1,
      enabled: false,
      body_jq: `jq '.a = 1'`,
    });
    expect(created.response.status).toBe(201);

    const disabledAgain = await sendJson(`/api/rewrite/rules/${created.body.id}`, "PUT", {
      name: "broken but disabled",
      priority: 1,
      enabled: false,
      body_jq: `jq '.a = 1'`,
    });
    expect(disabledAgain.response.status).toBe(200);

    // 但一旦想启用它，就必须先修好语法。
    const enableIt = await sendJson(`/api/rewrite/rules/${created.body.id}`, "PUT", {
      name: "broken but disabled",
      priority: 1,
      enabled: true,
      body_jq: `jq '.a = 1'`,
    });
    expect(enableIt.response.status).toBe(400);
    await api(`/api/rewrite/rules/${created.body.id}`, { method: "DELETE" });
  });

  it("persists settings across closing and reopening the database", async () => {
    const saved = await sendJson("/api/rewrite/settings", "PUT", {
      jq_path: "/usr/bin/jq",
      timeout_ms: 3210,
      serialize_handoff_ms: 1200,
      serialize_retry_grace_ms: 2300,
      serialize_max_hold_ms: 6000,
      serialize_queue_wait_ms: 3400,
    });
    expect(saved.response.status).toBe(200);
    expect(saved.body).toMatchObject({
      jq_path: "/usr/bin/jq",
      timeout_ms: 3210,
      serialize_handoff_ms: 1200,
      serialize_retry_grace_ms: 2300,
      serialize_max_hold_ms: 6000,
      serialize_queue_wait_ms: 3400,
      jq_available: true,
      correlation_mode: "best_effort",
      recording: true,
      active: false,
    });
    const invalid = await sendJson("/api/rewrite/settings", "PUT", { timeout_ms: 99 });
    expect(invalid.response.status).toBe(400);
    for (const [key, value] of [
      ["serialize_handoff_ms", 999],
      ["serialize_retry_grace_ms", 120001],
      ["serialize_max_hold_ms", 4999],
      ["serialize_queue_wait_ms", 300001],
    ] as const) {
      const result = await sendJson("/api/rewrite/settings", "PUT", { [key]: value });
      expect(result.response.status, key).toBe(400);
    }

    state.db?.close();
    state.db = null;
    ensureDb();
    const reopened = await api("/api/rewrite/settings");
    expect(reopened.body).toMatchObject({
      jq_path: "/usr/bin/jq",
      timeout_ms: 3210,
      serialize_handoff_ms: 1200,
    });
  });

  it("rewrites replay body and stores final wire values plus original edits", async () => {
    const rule = await sendJson("/api/rewrite/rules", "POST", {
      name: "replay-rewrite",
      enabled: 1,
      priority: 1,
      body_jq: ".temperature = 0",
      headers_jq: '. + {"host":"invalid.example","content-length":"1","x-rewritten":"yes"}',
    });
    const replay = await sendJson("/api/replay", "POST", {
      request_id: sourceId,
      url: `http://127.0.0.1:${(upstream.address() as { port: number }).port}/rewrite`,
      method: "POST",
      headers: { ...jsonHeaders(), host: "user.example", "content-length": "99" },
      payload: { temperature: 1 },
    });
    expect(replay.response.status).toBe(200);
    expect(replay.body.status).toBe(200);
    expect(lastFetchInit?.body).toBe('{"temperature":0}');
    const newId = replay.body.id as number;
    const row = ensureDb().prepare("SELECT * FROM requests WHERE id = ?").get(newId) as Record<string, any>;
    expect(JSON.parse(row.payload)).toEqual({ temperature: 0 });
    const sentHeaders = JSON.parse(row.request_headers);
    expect(sentHeaders).toMatchObject({ "x-rewritten": "yes", "content-type": "application/json" });
    expect(sentHeaders.host).toBeUndefined();
    expect(sentHeaders["content-length"]).toBeUndefined();
    expect(JSON.parse(row.orig_payload)).toEqual({ temperature: 1 });
    expect(JSON.parse(row.orig_request_headers)).toMatchObject({ host: "user.example", "content-length": "99" });
    expect(JSON.parse(row.rewrite_rule_ids)).toEqual([rule.body.id]);
    expect(row.rewrite_status).toBe("applied");
    await api(`/api/rewrite/rules/${rule.body.id}`, { method: "DELETE" });
  });

  it("replay re-encodes the final JSON when content-encoding is zstd", async () => {
    const zstdCompress = (zlib as unknown as { zstdCompressSync?: (value: Uint8Array) => Uint8Array }).zstdCompressSync;
    const zstdDecompress = (zlib as unknown as { zstdDecompressSync?: (value: Uint8Array) => Uint8Array })
      .zstdDecompressSync;
    if (!zstdCompress || !zstdDecompress) return;
    const db = ensureDb();
    const source = db
      .prepare(
        `INSERT INTO requests (session_id, turn, ts, provider, model, payload, request_headers, payload_encoding, payload_bytes, url, method)
				 VALUES (?, 0, ?, 'test', 'test-model', ?, ?, 'zstd', ?, ?, 'POST')`,
      )
      .run(
        "zstd-source",
        new Date().toISOString(),
        JSON.stringify({ temperature: 1 }),
        JSON.stringify({ ...jsonHeaders(), "content-encoding": "zstd" }),
        zstdCompress(Buffer.from('{"temperature":1}', "utf8")).byteLength,
        `http://127.0.0.1:${(upstream.address() as { port: number }).port}/rewrite`,
      );
    const rule = await sendJson("/api/rewrite/rules", "POST", {
      name: "zstd-replay-rewrite",
      enabled: 1,
      priority: -100,
      body_jq: ".temperature = 7",
    });
    const replay = await sendJson("/api/replay", "POST", {
      request_id: Number(source.lastInsertRowid),
      url: `http://127.0.0.1:${(upstream.address() as { port: number }).port}/rewrite`,
      method: "POST",
      payload: { temperature: 1 },
    });
    expect(replay.response.status).toBe(200);
    const wire = Buffer.from(lastFetchInit?.body as Uint8Array);
    expect(JSON.parse(Buffer.from(zstdDecompress(wire)).toString("utf8"))).toEqual({ temperature: 7 });
    expect(lastFetchInit?.headers).toMatchObject({ "content-encoding": "zstd" });
    const row = db.prepare("SELECT * FROM requests WHERE id = ?").get(replay.body.id) as Record<string, any>;
    expect(JSON.parse(row.payload)).toEqual({ temperature: 7 });
    expect(row.payload_encoding).toBe("zstd");
    expect(row.payload_bytes).toBe(wire.byteLength);
    const detail = await api(`/api/requests/${replay.body.id}`);
    expect(detail.body).toMatchObject({ payload_encoding: "zstd", payload_bytes: wire.byteLength });
    await api(`/api/rewrite/rules/${rule.body.id}`, { method: "DELETE" });
  });

  it("rejects unknown replay content encoding before sending", async () => {
    const before = upstreamCalls;
    const replay = await sendJson("/api/replay", "POST", {
      request_id: sourceId,
      url: `http://127.0.0.1:${(upstream.address() as { port: number }).port}/rewrite`,
      method: "POST",
      headers: { ...jsonHeaders(), "content-encoding": "X-unknown" },
      payload: { temperature: 1 },
    });
    expect(replay.response.status).toBe(400);
    expect(replay.body.error).toBe("不支持的 content-encoding: X-unknown");
    expect(upstreamCalls).toBe(before);
  });

  it("keeps state and settings available while the database is unavailable", async () => {
    const ensureDbSpy = vi.spyOn(dbModule, "ensureDb").mockImplementation(() => {
      throw new Error("mock database failure");
    });
    try {
      const stateResponse = await api("/api/state");
      expect(stateResponse.response.status).toBe(200);
      expect(stateResponse.body.rewrite).toMatchObject({
        enabled_rules: null,
        correlation_mode: "unknown",
        db_error: "Error: mock database failure",
      });
      const settings = await api("/api/rewrite/settings");
      expect(settings.response.status).toBe(200);
      expect(settings.body).toMatchObject({
        timeout_ms: 2000,
        serialize_handoff_ms: 10000,
        db_error: "Error: mock database failure",
      });
      const requests = await api("/api/requests");
      expect(requests.response.status).toBe(503);
      expect(requests.body.error).toBe("Error: mock database failure");
    } finally {
      ensureDbSpy.mockRestore();
    }
  });

  it("blocks replay on RewriteError, does not call upstream, and records safe error", async () => {
    const rule = await sendJson("/api/rewrite/rules", "POST", {
      name: "block-replay",
      enabled: 1,
      priority: -20,
      body_jq: 'error("blocked")',
    });
    const before = upstreamCalls;
    const replay = await sendJson("/api/replay", "POST", {
      request_id: sourceId,
      url: `http://127.0.0.1:${(upstream.address() as { port: number }).port}/rewrite`,
      method: "POST",
      headers: jsonHeaders(),
      payload: { temperature: 1 },
    });
    expect(replay.response.status).toBe(400);
    expect(upstreamCalls).toBe(before);
    const row = ensureDb().prepare("SELECT * FROM requests WHERE id = ?").get(replay.body.id) as Record<string, any>;
    expect(row.status).toBe(0);
    expect(row.rewrite_status).toBe("blocked");
    expect(JSON.parse(row.rewrite_error)).toMatchObject({
      kind: "runtime_error",
      phase: "body",
      rule_id: rule.body.id,
    });

    await api(`/api/rewrite/rules/${rule.body.id}`, { method: "DELETE" });
  });

  it("excludes blocked rows from detail pairing and export, and returns rewrite fields", async () => {
    const db = ensureDb();
    const session = "pairing-session";
    const insert = db.prepare(
      "INSERT INTO requests (session_id, turn, ts, provider, model, payload, origin, rewrite_status, rewrite_rule_ids) VALUES (?, 0, ?, 'p', 'm', '{}', NULL, ?, ?)",
    );
    const good1 = Number(insert.run(session, new Date().toISOString(), null, "[1]").lastInsertRowid);
    const blocked = Number(insert.run(session, new Date().toISOString(), "blocked", "[999]").lastInsertRowid);
    const good2 = Number(insert.run(session, new Date().toISOString(), null, "[999]").lastInsertRowid);
    const message = db.prepare(
      "INSERT INTO messages (session_id, turn, ts, role, message) VALUES (?, 0, ?, 'assistant', ?)",
    );
    message.run(session, new Date().toISOString(), JSON.stringify({ answer: 1 }));
    message.run(session, new Date().toISOString(), JSON.stringify({ answer: 2 }));

    const detail = await api(`/api/requests/${good2}`);
    expect(detail.body.response).toEqual({ answer: 2 });
    expect(detail.body.rewrite_rule_ids).toEqual([999]);
    expect(detail.body.rule_names).toEqual(["#999（已删除）"]);
    const blockedDetail = await api(`/api/requests/${blocked}`);
    expect(blockedDetail.body.response).toBeNull();
    const list = await api(`/api/requests?session_id=${session}`);
    expect(list.body.find((row: any) => row.id === blocked).rewrite_status).toBe("blocked");

    const exported = await fetch(`http://127.0.0.1:${port}/api/export?session_id=${session}`);
    const text = await exported.text();
    expect(text).toContain(`"request_id":${good1}`);
    expect(text).toContain(`"request_id":${good2}`);
    expect(text).not.toContain(`"request_id":${blocked}`);
  });

  it("rejects requests without a token from a non-loopback address when available", async () => {
    const lan = accessUrls(port).find((value) => !value.includes("127.0.0.1"));
    if (!lan) return;
    const host = lan.slice("http://".length).split(" ")[0];
    const response = await fetch(`http://${host}/api/rewrite/rules`);
    expect(response.status).toBe(401);
  });
});
