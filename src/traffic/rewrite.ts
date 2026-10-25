import type { DatabaseSync } from "node:sqlite";
import * as zlib from "node:zlib";
import { JqError, type JqErrorKind, type JqRunner } from "./jq.js";
import { collectSecrets, redactText } from "./redact.js";

export interface RewriteRule {
  id: number;
  name: string;
  enabled: number;
  priority: number;
  url_pattern: string | null;
  method: string | null;
  model: string | null;
  body_jq: string | null;
  headers_jq: string | null;
}

export interface RewriteContext {
  url: string;
  method: string;
  model: string | null;
}

export interface EngineSettings {
  jqPath: string;
  timeoutMs: number;
  handoffMs: number;
  retryGraceMs: number;
  maxHoldMs: number;
  queueWaitMs: number;
}

export type RewriteErrorKind =
  | JqErrorKind
  | "body_unsupported"
  | "body_not_json"
  | "headers_not_object"
  | "header_name_invalid"
  | "header_value_invalid"
  | "engine_unavailable";

export type RewritePhase = "body" | "headers";

export class RewriteError extends Error {
  readonly kind: RewriteErrorKind;
  readonly phase: RewritePhase;
  readonly ruleId: number | null;
  readonly ruleName: string | null;
  readonly exitCode: number | undefined;
  private readonly rawStderr: string | undefined;
  private readonly secrets: string[];

  constructor(
    kind: RewriteErrorKind,
    phase: RewritePhase,
    ruleId: number | null = null,
    ruleName: string | null = null,
    rawStderr?: string,
    exitCode?: number,
    message?: string,
    secrets: string[] = [],
  ) {
    const label = ruleName === null ? "未知规则" : `规则 \"${ruleName}\" #${ruleId ?? "?"}`;
    super(
      message ??
        `traffic-record rewrite blocked: [${label}] ${phase} ${kind}${exitCode === undefined ? "" : ` (exit ${exitCode})`}`,
    );
    this.name = "RewriteError";
    this.kind = kind;
    this.phase = phase;
    this.ruleId = ruleId;
    this.ruleName = ruleName;
    this.rawStderr = rawStderr;
    this.exitCode = exitCode;
    this.secrets = secrets;
  }

  toSafeEvent(): {
    kind: RewriteErrorKind;
    phase: RewritePhase;
    rule_id: number | null;
    rule_name: string | null;
    message: string;
    detail: string | null;
  } {
    return {
      kind: this.kind,
      phase: this.phase,
      rule_id: this.ruleId,
      rule_name: this.ruleName,
      message: this.message,
      detail: this.phase === "body" && this.rawStderr ? redactText(this.rawStderr, { secrets: this.secrets }) : null,
    };
  }
}

export type BodyEncoding = "identity" | "zstd" | "gzip" | "deflate" | "br";
export type BodyInput =
  | { kind: "none" }
  | { kind: "json"; text: string; encoding: BodyEncoding; source: "init-string" | "init-binary" | "request-clone" }
  | { kind: "unsupported"; reason: string };
export type BodyReader = () => Promise<BodyInput>;

export interface ApplyResult {
  ruleIds: number[];
  bodyChanged: boolean;
  body: string | Uint8Array | null;
  origBodyText: string | null;
  encoding: BodyEncoding;
  bodyBytes: number | null;
  headersChanged: boolean;
  headers: Record<string, string>;
  origHeaders: Record<string, string>;
}

const WIRE_HEADER_NAME = /^[!#$%&'*+\-.^_`|~0-9a-z]+$/;
const FRAMING_HEADERS = new Set([
  "content-length",
  "transfer-encoding",
  "connection",
  "keep-alive",
  "upgrade",
  "te",
  "trailer",
  "host",
]);

const DEFAULT_SETTINGS = {
  jqPath: "",
  timeoutMs: 2000,
  handoffMs: 10_000,
  retryGraceMs: 30_000,
  maxHoldMs: 120_000,
  queueWaitMs: 60_000,
} as const;

function settingValue(rows: Array<{ key: string; value: string }>, key: string): string | undefined {
  return rows.find((row) => row.key === key)?.value;
}

function positiveSetting(value: string | undefined, fallback: number): number {
  const parsed = Number(value ?? "");
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

export function getEngineSettings(d: DatabaseSync): EngineSettings {
  const rows = d.prepare("SELECT key, value FROM rewrite_settings").all() as Array<{ key: string; value: string }>;
  return {
    jqPath: settingValue(rows, "jq_path") ?? DEFAULT_SETTINGS.jqPath,
    timeoutMs: positiveSetting(settingValue(rows, "timeout_ms"), DEFAULT_SETTINGS.timeoutMs),
    handoffMs: positiveSetting(settingValue(rows, "serialize_handoff_ms"), DEFAULT_SETTINGS.handoffMs),
    retryGraceMs: positiveSetting(settingValue(rows, "serialize_retry_grace_ms"), DEFAULT_SETTINGS.retryGraceMs),
    maxHoldMs: positiveSetting(settingValue(rows, "serialize_max_hold_ms"), DEFAULT_SETTINGS.maxHoldMs),
    queueWaitMs: positiveSetting(settingValue(rows, "serialize_queue_wait_ms"), DEFAULT_SETTINGS.queueWaitMs),
  };
}

export function loadEnabledRules(d: DatabaseSync): RewriteRule[] {
  return d
    .prepare(
      `SELECT id, name, enabled, priority, url_pattern, method, model, body_jq, headers_jq
			 FROM rewrite_rules WHERE enabled = 1 ORDER BY priority ASC, id ASC`,
    )
    .all() as unknown as RewriteRule[];
}

export function matchRule(rule: RewriteRule, ctx: RewriteContext): boolean {
  if (rule.url_pattern) {
    try {
      if (!new RegExp(rule.url_pattern).test(ctx.url)) return false;
    } catch {
      return false;
    }
  }
  if (rule.method && rule.method.toLowerCase() !== ctx.method.toLowerCase()) return false;
  if (rule.model && !ctx.model?.toLowerCase().includes(rule.model.toLowerCase())) return false;
  return true;
}

export function headersToJson(h: unknown): Record<string, string> {
  const out: Record<string, string> = {};
  if (!h) return out;
  if (typeof Headers !== "undefined" && h instanceof Headers) {
    h.forEach((value, key) => {
      out[key.toLowerCase()] = String(value);
    });
    return out;
  }
  if (Array.isArray(h)) {
    for (const entry of h) {
      if (Array.isArray(entry) && entry.length >= 2) out[String(entry[0]).toLowerCase()] = String(entry[1]);
    }
    return out;
  }
  if (typeof h === "object") {
    for (const [key, value] of Object.entries(h as Record<string, unknown>)) out[key.toLowerCase()] = String(value);
  }
  return out;
}

function ruleLabel(rule: RewriteRule): [number, string] {
  return [rule.id, rule.name];
}

export function jsonToHeaders(v: unknown, rule: RewriteRule): Record<string, string> {
  if (v === null || typeof v !== "object" || Array.isArray(v)) {
    const [id, name] = ruleLabel(rule);
    throw new RewriteError("headers_not_object", "headers", id, name);
  }
  const out: Record<string, string> = {};
  for (const [key, value] of Object.entries(v as Record<string, unknown>)) {
    if (value === null || typeof value === "object" || !["string", "number", "boolean"].includes(typeof value)) {
      const [id, name] = ruleLabel(rule);
      throw new RewriteError("headers_not_object", "headers", id, name);
    }
    out[key.toLowerCase()] = String(value);
  }
  return out;
}

export function sanitizeSendHeaders(h: Record<string, string>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [rawName, rawValue] of Object.entries(h)) {
    const name = rawName.toLowerCase();
    if (!WIRE_HEADER_NAME.test(name)) throw new RewriteError("header_name_invalid", "headers");
    const value = String(rawValue);
    if (value.includes("\r") || value.includes("\n")) throw new RewriteError("header_value_invalid", "headers");
    if (FRAMING_HEADERS.has(name)) continue;
    out[name] = value;
  }
  return out;
}

function byteView(value: unknown): Uint8Array | null {
  if (value instanceof Uint8Array) return value;
  if (value instanceof ArrayBuffer) return new Uint8Array(value);
  if (ArrayBuffer.isView(value)) return new Uint8Array(value.buffer, value.byteOffset, value.byteLength);
  return null;
}

function encodingFromHeaders(headersLower: Record<string, string>): BodyEncoding | null {
  const value = (headersLower["content-encoding"] ?? "identity").split(",", 1)[0]?.trim().toLowerCase() ?? "identity";
  if (value === "" || value === "identity") return "identity";
  if (value === "zstd" || value === "gzip" || value === "deflate" || value === "br") return value;
  return null;
}

export function encodingOf(headers: Record<string, string>): BodyEncoding {
  const encoding = encodingFromHeaders(headersToJson(headers));
  if (encoding === null)
    throw new Error(`unsupported content-encoding: ${headersToJson(headers)["content-encoding"] ?? ""}`);
  return encoding;
}

export function decodeBody(bytes: Uint8Array, encoding: BodyEncoding): string {
  let decoded: Uint8Array = bytes;
  try {
    switch (encoding) {
      case "identity":
        break;
      case "gzip":
        decoded = zlib.gunzipSync(bytes);
        break;
      case "deflate":
        decoded = zlib.inflateSync(bytes);
        break;
      case "br":
        decoded = zlib.brotliDecompressSync(bytes);
        break;
      case "zstd": {
        const decompress = (zlib as unknown as { zstdDecompressSync?: (input: Uint8Array) => Uint8Array })
          .zstdDecompressSync;
        if (!decompress) throw new Error("zstd unavailable");
        decoded = decompress(bytes);
        break;
      }
    }
    return new TextDecoder("utf-8", { fatal: true }).decode(decoded);
  } catch (err) {
    throw new Error(`decode failed: ${String(err)}`);
  }
}

export function encodeBody(text: string, encoding: BodyEncoding): string | Uint8Array {
  if (encoding === "identity") return text;
  const input = Buffer.from(text, "utf8");
  switch (encoding) {
    case "gzip":
      return zlib.gzipSync(input);
    case "deflate":
      return zlib.deflateSync(input);
    case "br":
      return zlib.brotliCompressSync(input);
    case "zstd": {
      const compress = (zlib as unknown as { zstdCompressSync?: (value: Uint8Array) => Uint8Array }).zstdCompressSync;
      if (!compress) throw new Error("zstd unavailable");
      return compress(input);
    }
  }
}

/** 按请求输入形态读取并验证 JSON body；请求体只应由调用方在命中 body 规则后读取。 */
export async function extractBody(
  input: unknown,
  init: unknown,
  headersLower: Record<string, string>,
): Promise<BodyInput> {
  const initBody = typeof init === "object" && init !== null ? (init as { body?: unknown }).body : undefined;
  if (typeof initBody === "string") {
    try {
      JSON.parse(initBody);
      return { kind: "json", text: initBody, encoding: "identity", source: "init-string" };
    } catch {
      return { kind: "unsupported", reason: "not-json" };
    }
  }
  const bytes = byteView(initBody);
  if (bytes) {
    const encoding = encodingFromHeaders(headersLower);
    if (!encoding) return { kind: "unsupported", reason: "unsupported-encoding" };
    try {
      const text = decodeBody(bytes, encoding);
      JSON.parse(text);
      return { kind: "json", text, encoding, source: "init-binary" };
    } catch {
      return { kind: "unsupported", reason: "decode-or-not-json" };
    }
  }
  if (initBody !== undefined && initBody !== null) return { kind: "unsupported", reason: "unsupported-body" };
  if (typeof Request !== "undefined" && input instanceof Request && input.body !== null) {
    try {
      const text = await input.clone().text();
      JSON.parse(text);
      return { kind: "json", text, encoding: "identity", source: "request-clone" };
    } catch {
      return { kind: "unsupported", reason: "clone-or-not-json" };
    }
  }
  return { kind: "none" };
}

function safeJqError(err: JqError, phase: RewritePhase, rule: RewriteRule, secrets: string[] = []): RewriteError {
  return new RewriteError(err.kind, phase, rule.id, rule.name, err.rawStderr, err.exitCode, undefined, secrets);
}

/**
 * 改写执行环境（T2a：jq 执行器与告警出口由调用方 engine 注入，本模块无状态）。
 */
export interface RewriteEnv {
  jq: Pick<JqRunner, "run">;
  /** 规则级告警（如 url_pattern 非法）；缺省丢弃。 */
  warn?: (event: Record<string, unknown>) => void;
}

async function applyBodyChain(
  rules: RewriteRule[],
  body: Extract<BodyInput, { kind: "json" }>,
  settings: EngineSettings,
  secrets: string[],
  env: RewriteEnv,
): Promise<{ text: string; changed: boolean }> {
  let text = body.text;
  const original = text;
  for (const rule of rules) {
    if (!rule.body_jq?.trim()) continue;
    try {
      text = await env.jq.run(rule.body_jq, text, settings);
    } catch (err) {
      if (err instanceof JqError) throw safeJqError(err, "body", rule, secrets);
      throw err;
    }
  }
  return { text, changed: text !== original };
}

function validPattern(rule: RewriteRule, env: RewriteEnv): boolean {
  if (!rule.url_pattern) return true;
  try {
    new RegExp(rule.url_pattern);
    return true;
  } catch {
    env.warn?.({
      type: "rewrite_warn",
      rule_id: rule.id,
      rule_name: rule.name,
      message: "url_pattern 表达式非法，已跳过",
    });
    return false;
  }
}

async function applyRequestSnapshot(
  rules: RewriteRule[],
  settings: EngineSettings,
  ctx: RewriteContext,
  readBody: BodyReader,
  headers: unknown,
  env: RewriteEnv,
): Promise<ApplyResult | null> {
  if (rules.length === 0) return null;
  const matched: RewriteRule[] = [];
  for (const rule of rules) {
    if (rule.enabled === 0 || !validPattern(rule, env)) continue;
    if (matchRule(rule, ctx)) matched.push(rule);
  }
  if (matched.length === 0) return null;
  matched.sort((a, b) => a.priority - b.priority || a.id - b.id);

  const originalHeaders = headersToJson(headers);
  let finalHeaders = { ...originalHeaders };
  const headerRules = matched.filter((rule) => Boolean(rule.headers_jq?.trim()));
  if (headerRules.length > 0) {
    let headerJson: unknown = originalHeaders;
    for (const rule of headerRules) {
      try {
        const output = await env.jq.run(rule.headers_jq as string, JSON.stringify(headerJson), settings);
        headerJson = JSON.parse(output);
        finalHeaders = jsonToHeaders(headerJson, rule);
      } catch (err) {
        if (err instanceof JqError) throw safeJqError(err, "headers", rule);
        if (err instanceof RewriteError) throw err;
        throw new RewriteError("headers_not_object", "headers", rule.id, rule.name);
      }
    }
  }

  let sendHeaders: Record<string, string>;
  try {
    sendHeaders = sanitizeSendHeaders(finalHeaders);
  } catch (err) {
    if (err instanceof RewriteError && err.ruleId === null) {
      const rule = headerRules[headerRules.length - 1] ?? matched[matched.length - 1];
      throw new RewriteError(err.kind, "headers", rule?.id ?? null, rule?.name ?? null);
    }
    throw err;
  }

  const bodyRules = matched.filter((rule) => Boolean(rule.body_jq?.trim()));
  let body: string | Uint8Array | null = null;
  let origBodyText: string | null = null;
  let bodyChanged = false;
  let encoding: BodyEncoding = "identity";
  let bodyBytes: number | null = null;
  if (bodyRules.length > 0) {
    const input = await readBody();
    if (input.kind === "unsupported") {
      const rule = bodyRules[0];
      if (!rule) throw new RewriteError("body_unsupported", "body");
      throw new RewriteError(
        input.reason === "not-json" ? "body_not_json" : "body_unsupported",
        "body",
        rule.id,
        rule.name,
      );
    }
    if (input.kind === "json") {
      origBodyText = input.text;
      encoding = input.encoding;
      const secrets = collectSecrets(sendHeaders, origBodyText);
      const result = await applyBodyChain(bodyRules, input, settings, secrets, env);
      bodyChanged = result.changed;
      let encoded: string | Uint8Array;
      try {
        encoded = encodeBody(result.text, input.encoding);
      } catch {
        const rule = bodyRules[0];
        throw new RewriteError(
          "body_unsupported",
          "body",
          rule?.id ?? null,
          rule?.name ?? null,
          undefined,
          undefined,
          undefined,
          secrets,
        );
      }
      bodyBytes = typeof encoded === "string" ? Buffer.byteLength(encoded, "utf8") : encoded.byteLength;
      if (bodyChanged)
        body =
          input.source === "init-binary" && input.encoding === "identity" ? Buffer.from(result.text, "utf8") : encoded;
    }
  }

  return {
    ruleIds: matched.map((rule) => rule.id),
    bodyChanged,
    body,
    origBodyText,
    encoding,
    bodyBytes,
    headersChanged: JSON.stringify(sendHeaders) !== JSON.stringify(originalHeaders),
    headers: sendHeaders,
    origHeaders: originalHeaders,
  };
}

export async function applyRequest(
  rules: RewriteRule[],
  settings: EngineSettings,
  ctx: RewriteContext,
  readBody: BodyReader,
  headers: unknown,
  env: RewriteEnv,
): Promise<ApplyResult | null> {
  return applyRequestSnapshot(rules, settings, ctx, readBody, headers, env);
}
