/**
 * 内嵌 HTTP server：Web 页面 + JSON API + SSE + 编辑重放。
 * 绑 0.0.0.0 但强制 token 鉴权（回环访问豁免）。
 */
import type { DatabaseSync } from "node:sqlite";
import { randomBytes } from "node:crypto";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { networkInterfaces } from "node:os";
import { statSync } from "node:fs";
import { captureStream } from "./capture.js";
import { ensureDb } from "./db.js";
import { PAGE, PAGE_GZIP } from "./page.js";
import {
  applyRequest,
  encodeBody,
  encodingOf,
  getEngineSettings,
  headersToJson,
  loadEnabledRules,
  sanitizeSendHeaders,
  RewriteError,
  type BodyInput,
} from "./rewrite.js";
import { gateStats } from "./serialize.js";
import { broadcast } from "./sse.js";
import { BASE_PORT, BIND_HOST, MAX_PORT_TRIES, state } from "./state.js";
import { JqError, probeJq, runJq } from "./jq.js";

function sendJson(res: ServerResponse, data: unknown, status = 200): void {
  const body = JSON.stringify(data);
  res.writeHead(status, { "content-type": "application/json; charset=utf-8" });
  res.end(body);
}

function parseBody(row: Record<string, unknown>, key: string): unknown {
  try {
    return JSON.parse(row[key] as string);
  } catch {
    return null;
  }
}

const RULE_METHODS = new Set(["GET", "POST", "PUT", "PATCH", "DELETE"]);

type NormalizedRule = {
  name: string;
  enabled: number;
  priority: number;
  url_pattern: string | null;
  method: string | null;
  model: string | null;
  body_jq: string | null;
  headers_jq: string | null;
};

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function normalizeOptionalString(value: unknown, field: string): string | null {
  if (value === undefined || value === null || value === "") return null;
  if (typeof value !== "string") throw new Error(`${field} 必须是字符串`);
  const trimmed = value.trim();
  return trimmed || null;
}

/**
 * 保存前校验 jq 程序能否编译。只拒绝 compile_error —— 在 `{}` 这个探针输入上的
 * 运行时错误 / 空输出 / 多输出都是合法程序的正常表现，不能据此拒绝保存；
 * jq 缺失或超时同样放行（无法校验不等于程序有错）。
 *
 * 只校验 enabled=1 的规则：PUT 是全量更新（UI 的 enabled 复选框就是一次全量 PUT），
 * 无条件校验会让「已启用的坏规则」连停用都做不到，把用户锁死在阻断状态里。
 */
async function assertRuleJqCompiles(rule: NormalizedRule, d: DatabaseSync): Promise<void> {
  if (rule.enabled !== 1) return;
  const engine = getEngineSettings(d);
  const opts = { jqPath: engine.jqPath || undefined, timeoutMs: engine.timeoutMs };
  for (const [field, program] of [
    ["body_jq", rule.body_jq],
    ["headers_jq", rule.headers_jq],
  ] as const) {
    if (!program || program.trim() === "") continue;
    try {
      await runJq(program, "{}", opts);
    } catch (err) {
      if (!(err instanceof JqError) || err.kind !== "compile_error") continue;
      // 本扩展最常见的误填：把整条 shell 命令粘进来。单引号在 jq 语言里非法。
      const shellWrapped = /^\s*jq\s+['"]/.test(program);
      const hint = shellWrapped
        ? `：该字段只要 jq 程序本身，不要包 shell 外壳。应填 ${program.replace(/^\s*jq\s+['"]/, "").replace(/['"]\s*$/, "")}`
        : "";
      throw new Error(`${field} jq 语法错误${hint}`);
    }
  }
}

function normalizeRulePayload(value: unknown): NormalizedRule {
  if (!isObject(value)) throw new Error("请求体必须是 JSON 对象");
  const name = typeof value.name === "string" ? value.name.trim() : "";
  if (!name) throw new Error("name 不能为空");
  if (name.length > 200) throw new Error("name 长度不能超过 200 个字符");

  const priority = value.priority === undefined ? 100 : value.priority;
  if (typeof priority !== "number" || !Number.isInteger(priority) || priority < -100000 || priority > 100000) {
    throw new Error("priority 必须是 -100000 到 100000 之间的整数");
  }

  let enabled = 0;
  if (value.enabled !== undefined) {
    if (value.enabled === true || value.enabled === 1) enabled = 1;
    else if (value.enabled === false || value.enabled === 0) enabled = 0;
    else throw new Error("enabled 必须是布尔值或 0/1");
  }

  const urlPattern = normalizeOptionalString(value.url_pattern, "url_pattern");
  if (urlPattern) {
    try {
      new RegExp(urlPattern);
    } catch (err) {
      throw new Error(`url_pattern 正则无法编译: ${String(err instanceof Error ? err.message : err)}`);
    }
  }
  const methodValue = normalizeOptionalString(value.method, "method");
  const method = methodValue?.toUpperCase() ?? null;
  if (method && !RULE_METHODS.has(method)) throw new Error("method 必须是 GET、POST、PUT、PATCH、DELETE 或空值");

  return {
    name,
    enabled,
    priority,
    url_pattern: urlPattern,
    method,
    model: normalizeOptionalString(value.model, "model"),
    body_jq: normalizeOptionalString(value.body_jq, "body_jq"),
    headers_jq: normalizeOptionalString(value.headers_jq, "headers_jq"),
  };
}

const DEFAULT_ENGINE_SETTINGS = {
  jqPath: "",
  timeoutMs: 2000,
  handoffMs: 10_000,
  retryGraceMs: 30_000,
  maxHoldMs: 120_000,
  queueWaitMs: 60_000,
} as const;

function tryDb(): { d: DatabaseSync | null; error: string | null } {
  try {
    return { d: ensureDb(), error: null };
  } catch (err) {
    return { d: null, error: String(err) };
  }
}

function correlationMode(enabledRules: number | null): "exact" | "best_effort" | "unknown" | "inactive" {
  if (enabledRules === null) return "unknown";
  // 录制关闭 = 改写引擎停机，闸门不介入，谈不上关联精度。
  if (!state.recording) return "inactive";
  return enabledRules > 0 ? "exact" : "best_effort";
}

/**
 * 改写引擎是否真正介入出站流量 —— UI 三处展示面的唯一真值。
 * 客户端不要各自用 recording / enabled_rules 推导，一律读这个字段。
 */
function rewriteActive(enabledRules: number | null, dbError: string | null): boolean {
  return state.recording && (enabledRules ?? 0) > 0 && !dbError;
}

async function rewriteSettingsResponse(
  d: DatabaseSync | null,
  dbError: string | null = state.dbError,
): Promise<Record<string, unknown>> {
  const engine = d ? getEngineSettings(d) : DEFAULT_ENGINE_SETTINGS;
  const enabledRules = d ? loadEnabledRules(d).length : null;
  const probe = await probeJq(engine.jqPath || undefined);
  return {
    jq_path: engine.jqPath,
    timeout_ms: engine.timeoutMs,
    serialize_handoff_ms: engine.handoffMs,
    serialize_retry_grace_ms: engine.retryGraceMs,
    serialize_max_hold_ms: engine.maxHoldMs,
    serialize_queue_wait_ms: engine.queueWaitMs,
    jq_version: probe.version,
    jq_available: probe.ok,
    db_error: dbError,
    recording: state.recording,
    enabled_rules: enabledRules,
    active: rewriteActive(enabledRules, dbError),
    correlation_mode: correlationMode(enabledRules),
    gate: gateStats(),
  };
}

async function handleApi(req: IncomingMessage, res: ServerResponse, url: URL): Promise<void> {
  const path = url.pathname;

  if (path === "/api/state") {
    const result = tryDb();
    let sessions: number | null = null;
    let requests: number | null = null;
    let messages: number | null = null;
    let enabledRules: number | null = null;
    let dbBytes = 0;
    if (result.d) {
      try {
        const count = (sql: string) => (result.d!.prepare(sql).get() as { c: number }).c;
        sessions = count("SELECT COUNT(*) c FROM sessions");
        requests = count("SELECT COUNT(*) c FROM requests");
        messages = count("SELECT COUNT(*) c FROM messages");
        enabledRules = loadEnabledRules(result.d).length;
        try {
          dbBytes = statSync(state.dbPath).size;
        } catch {}
      } catch (err) {
        state.dbError = String(err instanceof Error ? err.message : err);
      }
    }
    const jq = await probeJq();
    const codexWsWarned = state.codexWsWarned;
    const dbError = result.error ?? state.dbError;
    sendJson(res, {
      recording: state.recording,
      port: state.serverPort,
      host: BIND_HOST,
      sessionId: state.currentSessionId,
      sessions,
      requests,
      messages,
      dbBytes,
      dbPath: state.dbPath,
      db_error: dbError,
      rewrite: {
        enabled_rules: enabledRules,
        active: rewriteActive(enabledRules, dbError),
        correlation_mode: correlationMode(enabledRules),
        gate: gateStats(),
        jq_available: jq.ok,
        jq_version: jq.version,
        db_error: dbError,
        codex_ws_warning: codexWsWarned,
      },
    });
    return;
  }

  if (path === "/api/rewrite/settings" && req.method === "GET") {
    const result = tryDb();
    sendJson(res, await rewriteSettingsResponse(result.d, result.error));
    return;
  }

  const result = tryDb();
  if (!result.d) {
    sendJson(res, { error: result.error ?? "数据库不可用" }, 503);
    return;
  }
  const d = result.d;
  if (path === "/api/rewrite/rules" && req.method === "GET") {
    const rows = d.prepare("SELECT * FROM rewrite_rules ORDER BY priority ASC, id ASC").all();
    sendJson(res, rows);
    return;
  }

  if (path === "/api/rewrite/rules" && req.method === "POST") {
    let input: unknown;
    try {
      input = JSON.parse(await readBody(req));
      const rule = normalizeRulePayload(input);
      await assertRuleJqCompiles(rule, d);
      const now = new Date().toISOString();
      const result = d
        .prepare(
          `INSERT INTO rewrite_rules (name, enabled, priority, url_pattern, method, model, body_jq, headers_jq, created_at, updated_at)
					 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          rule.name,
          rule.enabled,
          rule.priority,
          rule.url_pattern,
          rule.method,
          rule.model,
          rule.body_jq,
          rule.headers_jq,
          now,
          now,
        );
      const id = Number(result.lastInsertRowid);
      broadcast({ type: "rewrite_rules" });
      sendJson(res, d.prepare("SELECT * FROM rewrite_rules WHERE id = ?").get(id), 201);
    } catch (err) {
      sendJson(res, { error: String(err instanceof Error ? err.message : err) }, 400);
    }
    return;
  }

  const ruleMatch = path.match(/^\/api\/rewrite\/rules\/(\d+)$/);
  if (ruleMatch && req.method === "PUT") {
    const id = Number(ruleMatch[1]);
    if (!d.prepare("SELECT id FROM rewrite_rules WHERE id = ?").get(id)) {
      sendJson(res, { error: "not found" }, 404);
      return;
    }
    try {
      const rule = normalizeRulePayload(JSON.parse(await readBody(req)));
      await assertRuleJqCompiles(rule, d);
      const now = new Date().toISOString();
      d.prepare(
        `UPDATE rewrite_rules SET name = ?, enabled = ?, priority = ?, url_pattern = ?, method = ?, model = ?,
					 body_jq = ?, headers_jq = ?, updated_at = ? WHERE id = ?`,
      ).run(
        rule.name,
        rule.enabled,
        rule.priority,
        rule.url_pattern,
        rule.method,
        rule.model,
        rule.body_jq,
        rule.headers_jq,
        now,
        id,
      );
      broadcast({ type: "rewrite_rules" });
      sendJson(res, d.prepare("SELECT * FROM rewrite_rules WHERE id = ?").get(id));
    } catch (err) {
      sendJson(res, { error: String(err instanceof Error ? err.message : err) }, 400);
    }
    return;
  }

  if (ruleMatch && req.method === "DELETE") {
    const id = Number(ruleMatch[1]);
    const result = d.prepare("DELETE FROM rewrite_rules WHERE id = ?").run(id);
    if (!result.changes) {
      sendJson(res, { error: "not found" }, 404);
      return;
    }
    broadcast({ type: "rewrite_rules" });
    sendJson(res, { ok: true });
    return;
  }

  if (path === "/api/rewrite/settings" && req.method === "GET") {
    sendJson(res, await rewriteSettingsResponse(d));
    return;
  }

  if (path === "/api/rewrite/settings" && req.method === "PUT") {
    try {
      const input = JSON.parse(await readBody(req));
      if (!isObject(input)) throw new Error("请求体必须是 JSON 对象");
      const current = getEngineSettings(d);
      const jqPath = input.jq_path === undefined ? current.jqPath : input.jq_path;
      if (typeof jqPath !== "string") throw new Error("jq_path 必须是字符串");
      const ranges = [
        ["timeout_ms", current.timeoutMs, 100, 60000],
        ["serialize_handoff_ms", current.handoffMs, 1000, 60000],
        ["serialize_retry_grace_ms", current.retryGraceMs, 1000, 120000],
        ["serialize_max_hold_ms", current.maxHoldMs, 5000, 600000],
        ["serialize_queue_wait_ms", current.queueWaitMs, 1000, 300000],
      ] as const;
      const values = new Map<string, number>();
      for (const [key, fallback, min, max] of ranges) {
        const value = input[key] === undefined ? fallback : input[key];
        if (typeof value !== "number" || !Number.isInteger(value) || value < min || value > max) {
          throw new Error(`${key} 必须是 ${min} 到 ${max} 之间的整数`);
        }
        values.set(key, value);
      }
      const upsert = d.prepare(
        "INSERT INTO rewrite_settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value",
      );
      upsert.run("jq_path", jqPath.trim());
      for (const [key, value] of values) upsert.run(key, String(value));
      sendJson(res, await rewriteSettingsResponse(d));
    } catch (err) {
      sendJson(res, { error: String(err instanceof Error ? err.message : err) }, 400);
    }
    return;
  }

  if (path === "/api/sessions") {
    const rows = d
      .prepare(
        `SELECT s.id, s.started_at, s.cwd, s.provider, s.model,
				   (SELECT COUNT(*) FROM requests r WHERE r.session_id = s.id) AS req_count,
				   (SELECT COUNT(*) FROM messages m WHERE m.session_id = s.id) AS msg_count
				 FROM sessions s ORDER BY s.started_at DESC LIMIT 500`,
      )
      .all();
    sendJson(res, rows);
    return;
  }

  if (path === "/api/requests") {
    const sid = url.searchParams.get("session_id");
    const limit = Math.min(Number(url.searchParams.get("limit")) || 100, 1000);
    const offset = Number(url.searchParams.get("offset")) || 0;
    const rows = sid
      ? d
          .prepare(
            `SELECT id, session_id, turn, ts, provider, model, status, origin, replay_of, rewrite_status, LENGTH(payload) AS size
						 FROM requests WHERE session_id = ? ORDER BY id DESC LIMIT ? OFFSET ?`,
          )
          .all(sid, limit, offset)
      : d
          .prepare(
            `SELECT id, session_id, turn, ts, provider, model, status, origin, replay_of, rewrite_status, LENGTH(payload) AS size
						 FROM requests ORDER BY id DESC LIMIT ? OFFSET ?`,
          )
          .all(limit, offset);
    sendJson(res, rows);
    return;
  }

  const reqMatch = path.match(/^\/api\/requests\/(\d+)$/);
  if (reqMatch) {
    const id = Number(reqMatch[1]);
    const row = d.prepare("SELECT * FROM requests WHERE id = ?").get(id) as Record<string, unknown> | undefined;
    if (!row) {
      sendJson(res, { error: "not found" }, 404);
      return;
    }
    // 配对：同会话内第 k 个「实际录制」请求 ↔ 第 k 条 assistant 消息（replay 行不参与配对）
    const paired =
      row.origin === "replay" || row.rewrite_status === "blocked"
        ? null
        : (d
            .prepare(
              `SELECT message FROM messages
							 WHERE session_id = ? AND role = 'assistant'
							 ORDER BY id LIMIT 1 OFFSET (
							   SELECT COUNT(*) FROM requests
							    WHERE session_id = ? AND id < ? AND origin IS NULL
							      AND (rewrite_status IS NULL OR rewrite_status <> 'blocked')
							 )`,
            )
            .get(row.session_id as string, row.session_id as string, id) as { message: string } | undefined);
    const streamStat = d
      .prepare(
        "SELECT COUNT(*) c, COALESCE(SUM(LENGTH(data)), 0) bytes, MIN(elapsed_ms) ttfb, MAX(elapsed_ms) dur FROM stream_chunks WHERE request_id = ?",
      )
      .get(id) as { c: number; bytes: number; ttfb: number; dur: number };
    const parsedRuleIds = parseBody(row, "rewrite_rule_ids");
    const rewriteRuleIds = Array.isArray(parsedRuleIds)
      ? parsedRuleIds.filter((value): value is number => typeof value === "number" && Number.isInteger(value))
      : null;
    const ruleNames: string[] = [];
    if (rewriteRuleIds && rewriteRuleIds.length > 0) {
      const placeholders = rewriteRuleIds.map(() => "?").join(",");
      const found = d
        .prepare(`SELECT id, name FROM rewrite_rules WHERE id IN (${placeholders})`)
        .all(...rewriteRuleIds) as Array<{ id: number; name: string }>;
      const names = new Map(found.map((rule) => [rule.id, rule.name]));
      for (const ruleId of rewriteRuleIds) ruleNames.push(names.get(ruleId) ?? `#${ruleId}（已删除）`);
    }
    // replay 行无配对 assistant 消息：把捕获到的响应体原文带给「输出」子页（截断保护）
    let replayBody: string | null = null;
    if (row.origin === "replay" && streamStat.c > 0) {
      const chunks = d
        .prepare("SELECT data FROM stream_chunks WHERE request_id = ? ORDER BY seq LIMIT 20000")
        .all(id) as Array<{ data: string }>;
      replayBody = chunks.map((c) => c.data).join("");
      if (replayBody.length > 100_000) replayBody = `${replayBody.slice(0, 100_000)}\n…（截断，完整见「流式」子页）`;
    }
    sendJson(res, {
      ...row,
      payload: parseBody(row, "payload"),
      request_headers: row.request_headers ? parseBody(row, "request_headers") : null,
      response_headers: row.response_headers ? parseBody(row, "response_headers") : null,
      orig_payload: row.orig_payload ? parseBody(row, "orig_payload") : null,
      orig_request_headers: row.orig_request_headers ? parseBody(row, "orig_request_headers") : null,
      rewrite_rule_ids: rewriteRuleIds,
      rewrite_status: row.rewrite_status ?? null,
      payload_encoding: row.payload_encoding ?? null,
      payload_bytes: row.payload_bytes ?? null,
      rewrite_error: row.rewrite_error ? parseBody(row, "rewrite_error") : null,
      rule_names: ruleNames,
      response: paired ? parseBody(paired, "message") : null,
      replay_body: replayBody,
      stream:
        streamStat && streamStat.c > 0
          ? { chunks: streamStat.c, bytes: streamStat.bytes, ttfbMs: streamStat.ttfb, durationMs: streamStat.dur }
          : null,
    });
    return;
  }

  const streamMatch = path.match(/^\/api\/stream\/(\d+)$/);
  if (streamMatch) {
    const id = Number(streamMatch[1]);
    const rows = d
      .prepare("SELECT seq, ts, elapsed_ms, data FROM stream_chunks WHERE request_id = ? ORDER BY seq LIMIT 50000")
      .all(id);
    // done：本进程内该请求的流式捕获已收尾（重放面板据此停止轮询）
    sendJson(res, { rows, done: state.streamDone.has(id) });
    return;
  }

  const msgMatch = path.match(/^\/api\/messages\/(\d+)$/);
  if (msgMatch) {
    const row = d.prepare("SELECT * FROM messages WHERE id = ?").get(Number(msgMatch[1])) as
      Record<string, unknown> | undefined;
    if (!row) {
      sendJson(res, { error: "not found" }, 404);
      return;
    }
    sendJson(res, { ...row, message: parseBody(row, "message") });
    return;
  }

  if (path === "/api/export") {
    const sid = url.searchParams.get("session_id");
    if (!sid) {
      sendJson(res, { error: "missing session_id" }, 400);
      return;
    }
    // 导出只含实际录制的请求，replay 行不进数据集（避免破坏配对与数据集纯度）
    const reqs = d
      .prepare(
        "SELECT * FROM requests WHERE session_id = ? AND origin IS NULL AND (rewrite_status IS NULL OR rewrite_status <> 'blocked') ORDER BY id",
      )
      .all(sid) as Array<Record<string, unknown>>;
    const assts = d
      .prepare("SELECT message FROM messages WHERE session_id = ? AND role = 'assistant' ORDER BY id")
      .all(sid) as Array<{ message: string }>;
    const lines = reqs.map((r, i) =>
      JSON.stringify({
        session_id: r.session_id,
        request_id: r.id,
        turn: r.turn,
        ts: r.ts,
        provider: r.provider,
        model: r.model,
        status: r.status,
        request: parseBody(r, "payload"),
        response: assts[i] ? parseBody(assts[i], "message") : null,
      }),
    );
    res.writeHead(200, {
      "content-type": "application/x-ndjson; charset=utf-8",
      "content-disposition": `attachment; filename="record-${sid.slice(0, 8)}-${reqs.length}.jsonl"`,
    });
    res.end(lines.join("\n") + "\n");
    return;
  }

  sendJson(res, { error: "not found" }, 404);
}

/** 读取请求体（重放接口用） */
function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    let data = "";
    req.on("data", (c) => {
      data += c;
      if (data.length > 32_000_000) reject(new Error("body too large"));
    });
    req.on("end", () => resolve(data));
    req.on("error", reject);
  });
}

/** 重放前过滤 header：长度/连接相关头交给 fetch 重算（payload 编辑后长度已变），其余（含鉴权头）透传 */
export function filterReplayHeaders(headers: Record<string, unknown>): Record<string, string> {
  // 保留旧导出和“丢弃非字符串值”的历史行为；实际清理统一交给引擎的 sanitizeSendHeaders。
  const stringHeaders: Record<string, string> = {};
  for (const [key, value] of Object.entries(headers)) {
    if (typeof value === "string") stringHeaders[key] = value;
  }
  return sanitizeSendHeaders(stringHeaders);
}

/**
 * 编辑重放：用（可编辑的）URL / method / headers / payload 重新发往真实 provider，
 * 结果写入新的 requests 行（origin='replay'，replay_of 指向源请求，可形成重放链）。
 * 响应体（流式逐 chunk / 非流式整体）写入 stream_chunks。
 */
async function handleReplay(req: IncomingMessage, res: ServerResponse): Promise<void> {
  const dbResult = tryDb();
  if (!dbResult.d) {
    sendJson(res, { error: dbResult.error ?? "数据库不可用" }, 503);
    return;
  }
  const d = dbResult.d;
  let body: Record<string, unknown>;
  try {
    const parsed = JSON.parse(await readBody(req));
    if (!isObject(parsed)) throw new Error("请求体必须是 JSON 对象");
    body = parsed;
  } catch {
    sendJson(res, { error: "请求体不是合法 JSON" }, 400);
    return;
  }
  const src = d.prepare("SELECT * FROM requests WHERE id = ?").get(Number(body.request_id)) as
    Record<string, any> | undefined;
  if (!src) {
    sendJson(res, { error: "源记录不存在" }, 404);
    return;
  }
  const url = String(body.url ?? src.url ?? "");
  if (!url) {
    sendJson(res, { error: "该记录未保存请求 URL（旧版录制），无法重放" }, 400);
    return;
  }
  const method = String(body.method ?? src.method ?? "POST").toUpperCase();
  let rawHeaders: unknown;
  let payload: unknown;
  try {
    rawHeaders = body.headers ?? (src.request_headers ? JSON.parse(src.request_headers) : {});
    payload = body.payload ?? JSON.parse(src.payload);
  } catch {
    sendJson(res, { error: "源记录中的请求 JSON 无法解析" }, 400);
    return;
  }
  if (!isObject(rawHeaders) && !Array.isArray(rawHeaders) && !(rawHeaders instanceof Headers)) {
    sendJson(res, { error: "headers 必须是 JSON 对象、数组或 Headers" }, 400);
    return;
  }
  const payloadStr = typeof payload === "string" ? payload : JSON.stringify(payload);
  if (payloadStr === undefined) {
    sendJson(res, { error: "payload 不能为空" }, 400);
    return;
  }
  const originalHeaders = headersToJson(rawHeaders);
  const originalHeadersText = JSON.stringify(rawHeaders);
  const ts = new Date().toISOString();

  const ins = d
    .prepare(
      `INSERT INTO requests (session_id, turn, ts, provider, model, payload, request_headers, url, method, origin, replay_of)
			 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'replay', ?)`,
    )
    .run(src.session_id, src.turn, ts, src.provider, src.model, payloadStr, originalHeadersText, url, method, src.id);
  const newId = Number(ins.lastInsertRowid);
  broadcast({
    type: "request",
    id: newId,
    session_id: src.session_id,
    turn: src.turn,
    ts,
    provider: src.provider,
    model: src.model,
    status: null,
    size: payloadStr.length,
    origin: "replay",
  });

  let applied: Awaited<ReturnType<typeof applyRequest>> = null;
  let sendHeaders: Record<string, string> = {};
  let finalText = payloadStr;
  let sendBody: string | Uint8Array = payloadStr;
  let encoding: ReturnType<typeof encodingOf> = "identity";
  // 录制关闭 = 改写引擎停机，重放同样不改写。传空规则集复用 applyRequest 的零规则短路
  // （不读 body、不 spawn jq、直接返回 null），无需新增分支。
  const rewriteSkipped = !state.recording;
  try {
    applied = await applyRequest(
      rewriteSkipped ? [] : loadEnabledRules(d),
      getEngineSettings(d),
      { url, method, model: src.model ?? null },
      async (): Promise<BodyInput> => ({ kind: "json", text: payloadStr, encoding: "identity" }) as BodyInput,
      originalHeaders,
    );
    sendHeaders = sanitizeSendHeaders(applied?.headers ?? originalHeaders);
    if (applied?.bodyChanged && applied.body !== null) {
      finalText = typeof applied.body === "string" ? applied.body : new TextDecoder().decode(applied.body);
    }
    try {
      encoding = encodingOf(sendHeaders);
    } catch {
      const value = sendHeaders["content-encoding"] ?? "";
      sendJson(res, { id: newId, error: `不支持的 content-encoding: ${value}` }, 400);
      return;
    }
    try {
      sendBody = encoding === "identity" ? finalText : encodeBody(finalText, encoding);
    } catch {
      sendJson(res, { id: newId, error: `不支持的 content-encoding: ${encoding}` }, 400);
      return;
    }

    const rewritten = Boolean(applied && applied.ruleIds.length > 0);
    const payloadBytes = typeof sendBody === "string" ? Buffer.byteLength(sendBody, "utf8") : sendBody.byteLength;
    d.prepare(
      `UPDATE requests SET payload = ?, request_headers = ?, payload_encoding = ?, payload_bytes = ?, url = ?, method = ?,
			 ${rewritten ? "orig_payload = ?, orig_request_headers = ?, rewrite_rule_ids = ?, rewrite_status = 'applied'" : "orig_payload = orig_payload"}
			 WHERE id = ?`,
    ).run(
      finalText,
      JSON.stringify(sendHeaders),
      encoding,
      payloadBytes,
      url,
      method,
      ...(rewritten ? [payloadStr, originalHeadersText, JSON.stringify(applied?.ruleIds ?? [])] : []),
      newId,
    );
  } catch (err) {
    if (!(err instanceof RewriteError)) throw err;
    const safe = err.toSafeEvent();
    d.prepare(
      `UPDATE requests SET status = 0, payload = ?, request_headers = ?, orig_payload = ?, orig_request_headers = ?,
			 rewrite_rule_ids = ?, rewrite_status = 'blocked', rewrite_error = ?, url = ?, method = ? WHERE id = ?`,
    ).run(
      payloadStr,
      JSON.stringify(originalHeaders),
      payloadStr,
      originalHeadersText,
      JSON.stringify(err.ruleId === null ? [] : [err.ruleId]),
      JSON.stringify(safe),
      url,
      method,
      newId,
    );
    broadcast({ type: "rewrite_error", id: newId, session_id: src.session_id, ...safe });
    broadcast({ type: "response", id: newId, session_id: src.session_id, status: 0 });
    sendJson(res, { id: newId, error: safe.message, rewrite_error: safe }, 400);
    return;
  }

  // 重放必须绕过自己的 fetch patch，避免干扰 provider 请求关联队列。
  // T1 严格化（exactOptionalPropertyTypes）：body 键只在真有正文时写入，GET/HEAD 不携带 body 键
  // （fetch 对「无键」与「显式 undefined」行为一致）。
  const doFetch = state.originalFetch ?? globalThis.fetch;
  let upstream: Response;
  try {
    const replayInit: RequestInit = { method, headers: sendHeaders };
    if (method !== "GET" && method !== "HEAD") replayInit.body = sendBody;
    upstream = await doFetch(url, replayInit);
  } catch (err) {
    d.prepare("UPDATE requests SET status = ?, response_headers = ? WHERE id = ?").run(
      0,
      JSON.stringify({ error: String(err) }),
      newId,
    );
    broadcast({ type: "response", id: newId, session_id: src.session_id, status: 0 });
    sendJson(res, { id: newId, error: String(err) }, 502);
    return;
  }

  const respHeaders: Record<string, string> = {};
  upstream.headers.forEach((v, k) => {
    respHeaders[k] = v;
  });
  d.prepare("UPDATE requests SET status = ?, response_headers = ? WHERE id = ?").run(
    upstream.status,
    JSON.stringify(respHeaders),
    newId,
  );
  broadcast({ type: "response", id: newId, session_id: src.session_id, status: upstream.status });
  // 流式成功响应：后台逐 chunk 入库，页面立即返回（内容见新记录「流式/输出」子页）；
  // 错误（≥400）/ 非流式响应 body 一般很小，收完随应答带回，页面右侧直接展示
  const ct = (upstream.headers.get("content-type") ?? "").toLowerCase();
  const isStream = ct.includes("event-stream") || ct.includes("x-ndjson") || ct.includes("stream+json");
  if (upstream.status >= 400 || !isStream) {
    const bodyText = await captureStream(newId, src.session_id, upstream);
    sendJson(res, {
      id: newId,
      status: upstream.status,
      headers: respHeaders,
      ...(rewriteSkipped ? { rewrite_skipped: "recording_off" } : {}),
      body: bodyText.length > 20_000 ? `${bodyText.slice(0, 20_000)}\n…（截断，完整见 #${newId}）` : bodyText,
    });
    return;
  }
  void captureStream(newId, src.session_id, upstream);
  sendJson(res, {
    id: newId,
    status: upstream.status,
    headers: respHeaders,
    ...(rewriteSkipped ? { rewrite_skipped: "recording_off" } : {}),
  });
}

/** 非回环请求必须携带正确 token；本机访问豁免 */
function isAuthorized(req: IncomingMessage, url: URL): boolean {
  if (!state.accessToken) return true;
  const remote = req.socket.remoteAddress ?? "";
  if (remote === "127.0.0.1" || remote === "::1" || remote === "::ffff:127.0.0.1") return true;
  const provided = url.searchParams.get("token") ?? (req.headers["x-record-token"] as string | undefined) ?? "";
  return provided === state.accessToken;
}

/** 可访问 URL 列表：优先真实局域网 IPv4，过滤 docker/网桥/代理虚拟网卡；无局域网时才回退到 127.0.0.1 */
export function accessUrls(port: number): string[] {
  const q = state.accessToken ? `?token=${state.accessToken}` : "";
  const skipIface = /^(docker|br-|veth|virbr|tun|tap|utun|meta|zt|tailscale)/i;
  const isPrivate = (ip: string) => /^192\.168\./.test(ip) || /^10\./.test(ip) || /^172\.(1[6-9]|2\d|3[01])\./.test(ip);
  const lan: string[] = [];
  const other: string[] = [];
  for (const [name, addrs] of Object.entries(networkInterfaces())) {
    if (skipIface.test(name)) continue;
    for (const addr of addrs ?? []) {
      if (addr.family !== "IPv4" || addr.internal) continue;
      const line = `http://${addr.address}:${port}${q}   (${name})`;
      (isPrivate(addr.address) ? lan : other).push(line);
    }
  }
  const urls = [...lan, ...other];
  if (urls.length === 0) urls.push(`http://127.0.0.1:${port}`);
  return urls;
}

function handleHttp(req: IncomingMessage, res: ServerResponse): void {
  try {
    const url = new URL(req.url ?? "/", "http://127.0.0.1");

    if (!isAuthorized(req, url)) {
      res.writeHead(401, { "content-type": "text/plain; charset=utf-8" });
      res.end("401 unauthorized: 缺少或错误的 ?token=（局域网访问需带 token，见 /record status）");
      return;
    }

    if (url.pathname === "/") {
      // 页面已模块级 gzipSync 预压缩：客户端支持 gzip 时直接回发压缩副本
      const accept = req.headers["accept-encoding"];
      if (typeof accept === "string" && accept.includes("gzip")) {
        res.writeHead(200, { "content-type": "text/html; charset=utf-8", "content-encoding": "gzip" });
        res.end(PAGE_GZIP);
      } else {
        res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
        res.end(PAGE);
      }
      return;
    }

    if (url.pathname === "/api/events") {
      res.writeHead(200, {
        "content-type": "text/event-stream",
        "cache-control": "no-cache",
        connection: "keep-alive",
      });
      res.write("retry: 2000\n\n");
      state.sseClients.add(res);
      req.on("close", () => state.sseClients.delete(res));
      return;
    }

    if (url.pathname === "/api/replay" && req.method === "POST") {
      void handleReplay(req, res).catch((err) => {
        try {
          sendJson(res, { error: String(err) }, 500);
        } catch {}
      });
      return;
    }

    if (url.pathname.startsWith("/api/")) {
      void handleApi(req, res, url).catch((err) => {
        try {
          sendJson(res, { error: String(err) }, 500);
        } catch {}
      });
      return;
    }

    res.writeHead(404, { "content-type": "text/plain; charset=utf-8" });
    res.end("not found");
  } catch (err) {
    try {
      sendJson(res, { error: String(err) }, 500);
    } catch {}
  }
}

export async function startServer(): Promise<number> {
  if (state.server && state.serverPort !== null) return state.serverPort;
  ensureDb();
  state.accessToken = state.accessToken ?? randomBytes(16).toString("hex");
  for (let port = BASE_PORT; port < BASE_PORT + MAX_PORT_TRIES; port++) {
    const started = await new Promise<boolean>((resolve) => {
      const s = createServer(handleHttp);
      s.once("error", () => {
        try {
          s.close();
        } catch {}
        resolve(false);
      });
      s.listen(port, BIND_HOST, () => {
        state.server = s;
        resolve(true);
      });
    });
    if (started) {
      state.serverPort = port;
      return port;
    }
  }
  throw new Error(`端口 ${BASE_PORT}-${BASE_PORT + MAX_PORT_TRIES - 1} 均被占用`);
}
