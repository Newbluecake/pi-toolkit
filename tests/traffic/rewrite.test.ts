import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { gzipSync } from "node:zlib";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { openDb } from "../../src/traffic/db.js";
import { createJqRunner } from "../../src/traffic/jq.js";

import {
  applyRequest,
  decodeBody,
  encodeBody,
  encodingOf,
  extractBody,
  getEngineSettings,
  headersToJson,
  jsonToHeaders,
  loadEnabledRules,
  matchRule,
  sanitizeSendHeaders,
  RewriteError,
  type BodyEncoding,
  type BodyInput,
  type EngineSettings,
  type RewriteRule,
} from "../../src/traffic/rewrite.js";

let dir: string;
let db: ReturnType<typeof openDb>;
// T2a：jq 执行器由调用方注入（RewriteEnv）；本文件一个执行器，等价于源实现的模块单例。
const jq = createJqRunner();
const env = { jq };

const defaultSettings: EngineSettings = {
  jqPath: "",
  timeoutMs: 2000,
  handoffMs: 10_000,
  retryGraceMs: 30_000,
  maxHoldMs: 120_000,
  queueWaitMs: 60_000,
};
const context = { url: "https://api.example.test/v1/messages", method: "POST", model: "claude-3" };

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "pi-traffic-rewrite-"));
  db = openDb(join(dir, "traffic.db"));
});

afterEach(() => {
  db.close();
  rmSync(dir, { recursive: true, force: true });
});

function addRule(overrides: Partial<RewriteRule> = {}): RewriteRule {
  const rule: RewriteRule = {
    id: overrides.id ?? 1,
    name: overrides.name ?? `rule-${overrides.id ?? 1}`,
    enabled: overrides.enabled ?? 1,
    priority: overrides.priority ?? 100,
    url_pattern: overrides.url_pattern ?? null,
    method: overrides.method ?? null,
    model: overrides.model ?? null,
    body_jq: overrides.body_jq ?? null,
    headers_jq: overrides.headers_jq ?? null,
  };
  db.prepare(
    `INSERT INTO rewrite_rules (id, name, enabled, priority, url_pattern, method, model, body_jq, headers_jq, created_at, updated_at)
		 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    rule.id,
    rule.name,
    rule.enabled,
    rule.priority,
    rule.url_pattern,
    rule.method,
    rule.model,
    rule.body_jq,
    rule.headers_jq,
    "2025-01-01T00:00:00.000Z",
    "2025-01-01T00:00:00.000Z",
  );
  return rule;
}

function jsonBody(
  text: string,
  encoding: BodyEncoding = "identity",
  source: "init-string" | "init-binary" | "request-clone" = "init-string",
): BodyInput {
  return { kind: "json", text, encoding, source };
}

function applySnapshot(
  readBody: () => Promise<BodyInput>,
  headers: unknown = {},
  rules: RewriteRule[] = loadEnabledRules(db),
  settings: EngineSettings = getEngineSettings(db),
) {
  return applyRequest(rules, settings, context, readBody, headers, env);
}

describe("T5-a 规则加载与设置", () => {
  it("按 priority、id 排序，只返回 enabled 规则，并读取全部引擎设置", () => {
    addRule({ id: 2, priority: 2 });
    addRule({ id: 1, priority: 1 });
    addRule({ id: 3, enabled: 0, priority: 0 });
    db.prepare(
      `INSERT INTO rewrite_settings (key, value) VALUES
			 (?, ?), (?, ?), (?, ?), (?, ?), (?, ?), (?, ?)`,
    ).run(
      "jq_path",
      "/usr/bin/jq",
      "timeout_ms",
      "3210",
      "serialize_handoff_ms",
      "11000",
      "serialize_retry_grace_ms",
      "31000",
      "serialize_max_hold_ms",
      "121000",
      "serialize_queue_wait_ms",
      "61000",
    );
    expect(loadEnabledRules(db).map((rule) => rule.id)).toEqual([1, 2]);
    expect(getEngineSettings(db)).toEqual({
      jqPath: "/usr/bin/jq",
      timeoutMs: 3210,
      handoffMs: 11_000,
      retryGraceMs: 31_000,
      maxHoldMs: 121_000,
      queueWaitMs: 61_000,
    });
  });

  it("缺键或非正数设置取默认值", () => {
    db.prepare("INSERT INTO rewrite_settings (key, value) VALUES (?, ?), (?, ?)").run(
      "timeout_ms",
      "bad",
      "serialize_handoff_ms",
      "0",
    );
    expect(getEngineSettings(db)).toEqual(defaultSettings);
  });
});

describe("T5-b 匹配语义", () => {
  it("支持正则、大小写不敏感 method、model 子串与全空匹配", () => {
    const rule = addRule({ url_pattern: "/v1/messages$", method: "post", model: "CLAUDE" });
    expect(matchRule(rule, context)).toBe(true);
    expect(matchRule(rule, { ...context, url: "https://api.example.test/v1/models" })).toBe(false);
    expect(matchRule(rule, { ...context, model: "gpt-4" })).toBe(false);
    expect(matchRule({ ...rule, url_pattern: null, method: null, model: null }, context)).toBe(true);
  });

  it("运行时非法正则跳过该规则且不抛，后续规则继续生效", async () => {
    const invalid = addRule({ id: 1, priority: 1, url_pattern: "[", body_jq: ".x = 99" });
    const valid = addRule({ id: 2, priority: 2, body_jq: ".x = 2" });
    expect(matchRule(invalid, context)).toBe(false);
    await expect(
      applySnapshot(async () => jsonBody('{"x":1}'), {}, [invalid, valid], defaultSettings),
    ).resolves.toMatchObject({
      ruleIds: [2],
      body: '{"x":2}',
    });
  });
});

describe("T5-c/d 规则链", () => {
  it("两条 body 规则按 priority 叠加", async () => {
    addRule({ id: 1, priority: 1, body_jq: ".temperature = 0" });
    addRule({ id: 2, priority: 2, body_jq: ".max_tokens = 100" });
    const result = await applySnapshot(async () => jsonBody('{"temperature":1}'));
    expect(result).toMatchObject({
      ruleIds: [1, 2],
      bodyChanged: true,
      body: '{"temperature":0,"max_tokens":100}',
      origBodyText: '{"temperature":1}',
      encoding: "identity",
      bodyBytes: Buffer.byteLength('{"temperature":0,"max_tokens":100}'),
    });
  });

  it("headers 链统一小写，支持改、删、增并还原为扁平字符串", async () => {
    addRule({ headers_jq: '. + {"x-added": true} | ."X-Mixed" = "changed" | del(.old)' });
    const result = await applySnapshot(async () => ({ kind: "none" }), { "X-Mixed": "old", OLD: "gone" });
    expect(result?.origHeaders).toEqual({ "x-mixed": "old", old: "gone" });
    expect(result?.headers).toEqual({ "x-mixed": "changed", "x-added": "true" });
    expect(result?.headersChanged).toBe(true);
  });
});

describe("T5-e body 形态矩阵", () => {
  it("1/9 string body", async () => {
    addRule({ body_jq: ".x = 2" });
    const input = await extractBody("url", { body: '{"x":1}' }, {});
    expect(input).toMatchObject({ kind: "json", source: "init-string", encoding: "identity" });
    const result = await applySnapshot(async () => input);
    expect(result).toMatchObject({ body: '{"x":2}', encoding: "identity", bodyBytes: 7 });
  });

  it("2/9 Uint8Array identity body 保持二进制形态", async () => {
    addRule({ body_jq: ".x = 2" });
    const input = await extractBody("url", { body: Buffer.from('{"x":1}') }, {});
    expect(input).toMatchObject({ kind: "json", source: "init-binary", encoding: "identity" });
    const result = await applySnapshot(async () => input);
    expect(result?.body).toBeInstanceOf(Uint8Array);
    expect(decodeBody(result?.body as Uint8Array, "identity")).toBe('{"x":2}');
    expect(result).toMatchObject({ encoding: "identity", bodyBytes: 7 });
  });

  it("3/9 Uint8Array zstd 解压、改写、再压缩往返", async () => {
    const zstd = (await import("node:zlib")) as typeof import("node:zlib") & {
      zstdCompressSync?: (input: Uint8Array) => Uint8Array;
    };
    expect(zstd.zstdCompressSync).toBeTypeOf("function");
    if (!zstd.zstdCompressSync) throw new Error("Node 22 zstd encoder unavailable");
    addRule({ body_jq: ".x = 2" });
    const source = zstd.zstdCompressSync(Buffer.from('{"x":1}'));
    const input = await extractBody("url", { body: source }, { "content-encoding": "zstd" });
    const result = await applySnapshot(async () => input, { "content-encoding": "zstd" });
    expect(result?.body).toBeInstanceOf(Uint8Array);
    expect(decodeBody(result?.body as Uint8Array, "zstd")).toBe('{"x":2}');
    expect(result).toMatchObject({ encoding: "zstd", bodyBytes: (result?.body as Uint8Array).byteLength });
  });

  it("4/9 gzip 解压、改写、再压缩往返", async () => {
    addRule({ body_jq: ".x = 2" });
    const input = await extractBody("url", { body: gzipSync(Buffer.from('{"x":1}')) }, { "content-encoding": "gzip" });
    const result = await applySnapshot(async () => input, { "content-encoding": "gzip" });
    expect(decodeBody(result?.body as Uint8Array, "gzip")).toBe('{"x":2}');
    expect(result).toMatchObject({ encoding: "gzip", bodyBytes: (result?.body as Uint8Array).byteLength });
  });

  it("5/9 Request input 在 init.body 缺失时 clone 读取", async () => {
    addRule({ body_jq: ".x = 2" });
    const request = new Request(context.url, { method: "POST", body: '{"x":1}' });
    const input = await extractBody(request, undefined, {});
    expect(input).toMatchObject({ kind: "json", text: '{"x":1}', source: "request-clone" });
    const result = await applySnapshot(async () => input, request.headers);
    expect(result?.body).toBe('{"x":2}');
  });

  it("6/9 无 body 跳过，不阻断", async () => {
    addRule({ body_jq: ".x = 2" });
    const input = await extractBody("url", {}, {});
    const result = await applySnapshot(async () => input);
    expect(result).toMatchObject({
      bodyChanged: false,
      body: null,
      origBodyText: null,
      encoding: "identity",
      bodyBytes: null,
    });
  });

  it.each([
    ["7/9 ReadableStream", new ReadableStream(), "body_unsupported"],
    ["8/9 FormData", new FormData(), "body_unsupported"],
    ["9/9 非 JSON 文本", "not json", "body_not_json"],
  ] as const)("%s 阻断", async (_label, rawBody, kind) => {
    addRule({ body_jq: ".x = 2" });
    const input = await extractBody("url", { body: rawBody }, {});
    await expect(applySnapshot(async () => input)).rejects.toMatchObject({ kind });
  });

  it("公开编码 API 覆盖 identity/gzip，并拒绝未知 content-encoding", () => {
    expect(encodingOf({})).toBe("identity");
    expect(encodingOf({ "Content-Encoding": "gzip" })).toBe("gzip");
    const encoded = encodeBody('{"x":1}', "gzip");
    expect(encoded).toBeInstanceOf(Uint8Array);
    expect(decodeBody(encoded as Uint8Array, "gzip")).toBe('{"x":1}');
    expect(() => encodingOf({ "content-encoding": "snappy" })).toThrow("unsupported content-encoding");
  });
});

describe("T5-f I3 发送头安全边界", () => {
  it("剔除 8 个 framing/hop-by-hop 头，明确保留 content-encoding", () => {
    const input = {
      "content-length": "1",
      "transfer-encoding": "chunked",
      connection: "keep-alive",
      "keep-alive": "timeout=5",
      upgrade: "websocket",
      te: "trailers",
      trailer: "x-checksum",
      host: "example.test",
      "content-encoding": "gzip",
      "x-ok": "yes",
    };
    expect(sanitizeSendHeaders(input)).toEqual({ "content-encoding": "gzip", "x-ok": "yes" });
  });

  it("阻断 CRLF 值与非法 header 名", () => {
    expect(() => sanitizeSendHeaders({ "bad name": "x" })).toThrowError(RewriteError);
    expect(() => sanitizeSendHeaders({ "x-ok": "a\r\nb" })).toThrowError(RewriteError);
    try {
      sanitizeSendHeaders({ "x-ok": "a\r\nb" });
    } catch (err) {
      expect(err).toMatchObject({ kind: "header_value_invalid" });
    }
  });

  it("jsonToHeaders 拒绝嵌套、数组、null，允许数字和布尔值", () => {
    const rule = { ...addRule(), headers_jq: "." };
    expect(jsonToHeaders({ a: 1, b: false }, rule)).toEqual({ a: "1", b: "false" });
    expect(() => jsonToHeaders({ a: [] }, rule)).toThrowError("headers_not_object");
    expect(() => jsonToHeaders(null, rule)).toThrowError("headers_not_object");
  });
});

describe("T5-g B5+V4 错误通道", () => {
  it("headers phase 三通道均无 sk-secret，detail 强制为 null", async () => {
    const secret = "sk-secret";
    addRule({ name: "header-secret", headers_jq: '.["x-api-key"] | error' });
    let error: RewriteError | undefined;
    try {
      await applySnapshot(async () => ({ kind: "none" }), { "x-api-key": secret });
    } catch (err) {
      error = err as RewriteError;
    }
    expect(error).toBeInstanceOf(RewriteError);
    const safe = error?.toSafeEvent();
    const thrownChannel = error?.message ?? "";
    const sseChannel = JSON.stringify(safe);
    const dbChannel = JSON.stringify(safe);
    expect(safe?.detail).toBeNull();
    expect([thrownChannel, sseChannel, dbChannel].join("\n")).not.toContain(secret);
  });

  it("body phase 用 collectSecrets 替换无格式密钥回显", async () => {
    const secret = "p@ss w0rd";
    addRule({ name: "body-secret", body_jq: ".password | error" });
    let error: RewriteError | undefined;
    try {
      await applySnapshot(async () => jsonBody(JSON.stringify({ password: secret })));
    } catch (err) {
      error = err as RewriteError;
    }
    expect(error).toBeInstanceOf(RewriteError);
    const safe = error?.toSafeEvent();
    expect(safe?.detail).toContain("«REDACTED»");
    expect(JSON.stringify(safe)).not.toContain(secret);
    expect(error?.message).not.toContain(secret);
  });
});

describe("T5-h 快照短路与兼容性", () => {
  it("空规则快照不读 body、不 spawn，1000 次低于 500ms", async () => {
    const before = jq.spawnCount();
    let reads = 0;
    const reader = async () => {
      reads++;
      return jsonBody("{}");
    };
    const started = performance.now();
    for (let i = 0; i < 1000; i++) {
      expect(await applyRequest([], defaultSettings, context, reader, { "X-Test": "1" }, env)).toBeNull();
    }
    const elapsed = performance.now() - started;
    expect(jq.spawnCount()).toBe(before);
    expect(reads).toBe(0);
    expect(elapsed).toBeLessThan(500);
  });

  it("规则快照经 loadEnabledRules + getEngineSettings 加载后生效", async () => {
    addRule({ body_jq: ".x = 2" });
    const result = await applyRequest(
      loadEnabledRules(db),
      getEngineSettings(db),
      context,
      async () => jsonBody('{"x":1}'),
      {},
      env,
    );
    expect(result).toMatchObject({ ruleIds: [1], body: '{"x":2}', encoding: "identity", bodyBytes: 7 });
  });
});

it("headersToJson 统一小写并处理三种输入形态", () => {
  expect(headersToJson({ A: 1, a: false })).toEqual({ a: "false" });
  expect(
    headersToJson([
      ["X-A", 1],
      ["x-b", true],
    ]),
  ).toEqual({ "x-a": "1", "x-b": "true" });
  expect(headersToJson(new Headers({ "X-A": "v" }))).toEqual({ "x-a": "v" });
});
