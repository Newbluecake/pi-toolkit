/**
 * 内嵌 HTTP server：Web 页面 + JSON API + SSE + 编辑重放。
 *
 * T2a（traffic-merge plan §4.1 / §5.2）：
 * - 每个 engine 一个服务实例（`createTrafficServer(engine)`），无模块级状态；
 * - 模式门禁：`startServer` / `replay` 在 engine 不允许服务（非主会话 tui/rpc）时抛 `E_REPLAY_MODE`；
 * - 连接账本：每个 accepted socket `unref()` 并记入 `engine.connections`，engine.close 时逐个 destroy；
 *   监听句柄同样 unref（不拖住 print/退出）；
 * - 重放：AbortController 登记进 engine 取消域（close ⇒ abort，只触发不等待）+ 二级截止（响应头 60s /
 *   读流空闲 120s / 总长 30min）；读请求体后、jq 后、上游返回后、写行前各复查一次 engine/secure；
 * - 页面在首个 `GET /` 懒加载并缓存到 `engine.page`；
 * - 所有写（规则 CRUD、引擎设置、重放行）经 persist 闸口。
 *
 * T4（§4.1 第一期加固，全部响应生效）：
 * - 默认绑 127.0.0.1（`opts.host = "0.0.0.0"` 才开 LAN；T3 接 `traffic.web.host`）；
 * - Host 白名单（鉴权前）：`127.0.0.1`/`localhost`/`[::1]`（LAN 绑定时加本机各网卡 IPv4），带端口；
 *   不在清单 ⇒ 421（防 DNS rebinding）；
 * - 反嵌入：所有响应 `X-Frame-Options: DENY` + `CSP: frame-ancestors 'none'; base-uri 'none';
 *   form-action 'self'`（不限制 script，保留运行时编译 Vue）+ `nosniff` + `Referrer-Policy: no-referrer`；
 * - 缓存：页面 `/` 与全部 `/api/*` 一律 `Cache-Control: no-store`；
 * - token：页面 `/` 回环免 token（HTML 注入 <meta name="record-token">，app.js 经 x-record-token 头携带）；
 *   **全部 `/api/*` 要 token（回环亦然）**；GET/HEAD 接受 `x-record-token` 头或 `?token=`，
 *   状态变更（非 GET/HEAD）只认 `x-record-token` 头（自定义头 ⇒ 跨站表单无法伪造）；
 *   比较两侧 SHA-256 摘要后 timingSafeEqual（照 web-hub hub/auth.ts），空串恒拒；
 * - 跨域：任何响应不发 `Access-Control-Allow-*`；`OPTIONS` 一律 405（预检永远不成功）；
 *   非 GET/HEAD：`Origin` 存在且 ≠ 本服务 origin（含 `null`）⇒ 403；`Sec-Fetch-Site: cross-site` ⇒ 403；
 *   缺元数据时仅凭 token；
 * - T2b 对接：`engine.gate` 引用已删（闸门退役，serialize_* 键标注已停用）；外部持锁（busy_timeout=0）时
 *   同步写返回 503「数据库忙」；`/api/requests` 热路径与 `/api/export` 走 `engine.dbPort.pages()`
 *   分页读（db-port.ts 的 ReadQuery，keyset + 每 tick 预算让出）。
 */
import type { DatabaseSync } from "node:sqlite";
import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { networkInterfaces } from "node:os";
import { statSync } from "node:fs";
import type { Socket } from "node:net";
import { armTimer } from "./cancel.js";
import type { ReadQuery, Rows } from "./db-port.js";
import { ensureDb } from "./db.js";
import type { TrafficEngine } from "./engine.js";
import { TrafficModeError } from "./mode.js";
import { buildPage } from "./page.js";
import { persistAllowed } from "./persist.js";
import { isSecure } from "./secure.js";
import { peekTapRecord, tapActiveFor } from "./tap.js";
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
import { broadcast } from "./sse.js";
import { BASE_PORT, MAX_PORT_TRIES } from "./state.js";
import { JqError } from "./jq.js";

function sendJson(res: ServerResponse, data: unknown, status = 200): void {
  const body = JSON.stringify(data);
  res.writeHead(status, { "content-type": "application/json; charset=utf-8" });
  res.end(body);
}

/** T4 §4.1 反嵌入/元数据头：对每个响应（含 401/404/421/405）在路由前统一设置。 */
function setSecurityHeaders(res: ServerResponse): void {
  // 不限制 script-src：页面内联 Vue 带 compiler，需要运行时编译（§4.1 反嵌入行）。
  res.setHeader("Content-Security-Policy", "frame-ancestors 'none'; base-uri 'none'; form-action 'self'");
  res.setHeader("X-Frame-Options", "DENY");
  res.setHeader("X-Content-Type-Options", "nosniff");
  res.setHeader("Referrer-Policy", "no-referrer");
}

function sha256(text: string): Buffer {
  return createHash("sha256").update(text, "utf8").digest();
}

/** 与 web-hub hub/auth.ts 同款：两侧摘要后定长常量时间比较；空候选/超长候选恒拒。 */
const MAX_TOKEN_CHARS = 1024;
function tokenMatches(provided: string | null | undefined, expected: string | null): boolean {
  if (!expected) return false; // fail closed：无 token 配置 ⇒ 全拒（startServer 恒铸造，正常不可达）
  const text =
    typeof provided === "string" && provided.length > 0 && provided.length <= MAX_TOKEN_CHARS ? provided : "";
  if (!text) return false;
  return timingSafeEqual(sha256(text), sha256(expected));
}

/** T2b：openDb busy_timeout=0 ⇒ 外部持锁时同步写立即 SQLITE_BUSY。API 层给 503 友好错误，不重试。 */
function isBusyError(err: unknown): boolean {
  if (!(err instanceof Error)) return false;
  const code = (err as Error & { code?: unknown }).code;
  return code === "SQLITE_BUSY" || code === "SQLITE_BUSY_RECOVERY" || /database is locked/i.test(err.message);
}

const BUSY_MESSAGE = "数据库忙（正被其他进程持锁），稍后重试";

/** 安全评审 #3：readBody 超限时抛出；调用方映射 413。 */
export class BodyTooLargeError extends Error {
  readonly code = "E_BODY_TOO_LARGE" as const;
  constructor() {
    super("request body too large");
  }
}

/**
 * 安全评审 #4（第二轮）：参数校验类错误——**唯一**允许把 message 作为公开文案出站的异常类型。
 * 其余任意异常在路由层一律折叠为固定错误码 + 通用文案（细节经 sanitizeDetail 只进日志）。
 */
class PublicInputError extends Error {}

/**
 * 安全评审 #4：错误细节的唯一出站/日志清洗口。已知敏感值（accessToken / db 路径）与常见
 * 绝对路径形态替换为占位符；长度截断。公开错误响应一律走固定文案（见 sendRouteError /
 * E_INTERNAL），这里的产物只进日志与本地诊断字段（db_error）。
 */
function sanitizeDetail(err: unknown, state: TrafficEngine): string {
  let text = err instanceof Error ? err.message : String(err);
  for (const secret of [state.accessToken, state.dbPath, state.legacyDbPath]) {
    if (typeof secret === "string" && secret.length > 0) {
      text = text.split(secret).join(secret === state.accessToken ? "<token>" : "<path>");
    }
  }
  text = text.replace(/\/(?:home|root|Users)\/[^\s"'，。)]*/g, "<path>");
  // 常见凭证形态（sk-…、Bearer …）一律占位：日志/库内行同样不得留存密钥样文本
  text = text.replace(/\bsk-[A-Za-z0-9_-]{8,}\b/g, "<api-key>");
  text = text.replace(/\bBearer\s+[A-Za-z0-9._-]{8,}/gi, "Bearer <token>");
  return text.length > 300 ? `${text.slice(0, 300)}…` : text;
}

/** 安全评审 #4：不可预期异常的统一公开出口——固定文案 + 错误码，细节只进日志（经 sanitizeDetail）。 */
function sendInternalError(res: ServerResponse, state: TrafficEngine, where: string, err: unknown): void {
  try {
    console.error(`[traffic] ${where}:`, sanitizeDetail(err, state));
  } catch {}
  try {
    sendJson(res, { error: "internal error", code: "E_INTERNAL" }, 500);
  } catch {}
}

/**
 * 安全评审 #4：db_error 的公开出口。底层 SQL/IO 异常的原文（可能含路径、第三方细节）
 * 不出站——busy 走白名单文案，其余一律固定「数据库不可用」；细节经 sanitizeDetail 只进日志。
 */
const PUBLIC_DB_ERROR = "数据库不可用（详情见进程日志）";
function publicDbError(raw: string | null): string | null {
  if (raw === null || raw === "") return null;
  if (/SQLITE_BUSY|database is locked/i.test(raw)) return BUSY_MESSAGE;
  return PUBLIC_DB_ERROR;
}

/**
 * 路由级错误出口（安全评审 #4 第二轮）：
 * - `PublicInputError` ⇒ 400 + 其 message（参数校验白名单）；
 * - `BodyTooLargeError` ⇒ 413 + 固定文案 + connection: close；
 * - BUSY ⇒ 503 固定文案；
 * - **其余任意异常** ⇒ 500 E_INTERNAL 固定文案，细节（经 sanitizeDetail）只进日志。
 */
function sendRouteError(res: ServerResponse, state: TrafficEngine, err: unknown, where: string): void {
  if (err instanceof PublicInputError) {
    sendJson(res, { error: err.message }, 400);
    return;
  }
  if (err instanceof BodyTooLargeError) {
    // 剩余正文已转丢弃式消费；显式 connection: close 让 socket 在 413 冲刷后关闭。
    try {
      res.writeHead(413, { "content-type": "application/json; charset=utf-8", connection: "close" });
      res.end(JSON.stringify({ error: "请求体超过 32 MiB 上限" }));
    } catch {}
    return;
  }
  if (isBusyError(err)) {
    sendJson(res, { error: BUSY_MESSAGE }, 503);
    return;
  }
  sendInternalError(res, state, where, err);
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
  if (typeof value !== "string") throw new PublicInputError(`${field} 必须是字符串`);
  const trimmed = value.trim();
  return trimmed || null;
}

function normalizeRulePayload(value: unknown): NormalizedRule {
  if (!isObject(value)) throw new PublicInputError("请求体必须是 JSON 对象");
  const name = typeof value.name === "string" ? value.name.trim() : "";
  if (!name) throw new PublicInputError("name 不能为空");
  if (name.length > 200) throw new PublicInputError("name 长度不能超过 200 个字符");

  const priority = value.priority === undefined ? 100 : value.priority;
  if (typeof priority !== "number" || !Number.isInteger(priority) || priority < -100000 || priority > 100000) {
    throw new PublicInputError("priority 必须是 -100000 到 100000 之间的整数");
  }

  let enabled = 0;
  if (value.enabled !== undefined) {
    if (value.enabled === true || value.enabled === 1) enabled = 1;
    else if (value.enabled === false || value.enabled === 0) enabled = 0;
    else throw new PublicInputError("enabled 必须是布尔值或 0/1");
  }

  const urlPattern = normalizeOptionalString(value.url_pattern, "url_pattern");
  if (urlPattern) {
    try {
      new RegExp(urlPattern);
    } catch (err) {
      throw new PublicInputError(`url_pattern 正则无法编译: ${String(err instanceof Error ? err.message : err)}`);
    }
  }
  const methodValue = normalizeOptionalString(value.method, "method");
  const method = methodValue?.toUpperCase() ?? null;
  if (method && !RULE_METHODS.has(method))
    throw new PublicInputError("method 必须是 GET、POST、PUT、PATCH、DELETE 或空值");

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

/** 读取请求体（重放 / 规则 / 设置接口用）。按**字节**计数；越限立即停读（安全评审 #3）。 */
const MAX_BODY_BYTES = 32_000_000;
function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    let over = false;
    req.on("data", (c: Buffer) => {
      if (over) return;
      size += c.length;
      if (size > MAX_BODY_BYTES) {
        // 立即停止累计与监听；丢弃式消费剩余正文（有界：内核接收窗），调用方回 413 + connection: close。
        over = true;
        req.removeAllListeners("data");
        req.removeAllListeners("end");
        req.resume();
        reject(new BodyTooLargeError());
      } else {
        chunks.push(c);
      }
    });
    req.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    req.on("error", reject);
  });
}

/**
 * 读取并解析 JSON 请求体（安全评审 #4 第二轮的唯一入口）：
 * 越限 ⇒ BodyTooLargeError（413）；解析失败 ⇒ PublicInputError（400 固定文案）；
 * 流错误原样上抛（路由层折叠为 E_INTERNAL）。
 */
async function readJsonBody(req: IncomingMessage): Promise<unknown> {
  let text: string;
  try {
    text = await readBody(req);
  } catch (err) {
    if (err instanceof BodyTooLargeError) throw err;
    throw err;
  }
  try {
    return JSON.parse(text);
  } catch {
    throw new PublicInputError("请求体不是合法 JSON");
  }
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

const CLOSED_MESSAGE = "traffic engine 已关闭";

export interface TrafficServer {
  startServer(): Promise<number>;
  accessUrls(port: number): string[];
  handleHttp(req: IncomingMessage, res: ServerResponse): void;
  /** 重放核心（无 HTTP 解析）；非主会话 tui/rpc 抛 E_REPLAY_MODE。 */
  replay(body: Record<string, unknown>, res: ServerResponse): Promise<void>;
}

export interface CreateServerOptions {
  /**
   * 绑定地址（T4 §4.1 拍板②）：默认 `127.0.0.1`；`"0.0.0.0"` = LAN 显式 opt-in
   * （T3 由 `traffic.web.host` 传入）。其余值原样交给 listen（自担）。
   */
  host?: string;
  /**
   * 起始端口（T3：`traffic.web.port`，默认 4177；占用自增，最多 MAX_PORT_TRIES 次）。
   */
  port?: number;
}

export function createTrafficServer(state: TrafficEngine, opts: CreateServerOptions = {}): TrafficServer {
  const epoch = state.epoch;
  // ---- T4：绑定与 Host 白名单（§4.1「绑定」「Host」行）----
  const bindHost = opts.host ?? "127.0.0.1";
  const lanBound = bindHost === "0.0.0.0";
  /** Host 白名单按连接的真实本地端口计算；LAN 绑定时加本机各网卡 IPv4（含 docker/网桥——Host 校验不做展示过滤）。 */
  let hostAllowCache: { port: number; hosts: Set<string> } | null = null;
  function allowedHosts(port: number): Set<string> {
    if (hostAllowCache?.port === port) return hostAllowCache.hosts;
    const hosts = new Set<string>([`127.0.0.1:${port}`, `localhost:${port}`, `[::1]:${port}`]);
    if (lanBound) {
      for (const addrs of Object.values(networkInterfaces())) {
        for (const addr of addrs ?? []) {
          if (addr.family === "IPv4" && !addr.internal) hosts.add(`${addr.address}:${port}`);
        }
      }
    }
    hostAllowCache = { port, hosts };
    return hosts;
  }
  function hostAllowed(req: IncomingMessage): boolean {
    const host = req.headers.host;
    const port = req.socket.localPort;
    if (typeof host !== "string" || host === "" || typeof port !== "number") return false;
    return allowedHosts(port).has(host.toLowerCase());
  }
  /** 回环来源（页面 `/` 免 token 的判据是来源地址，不是绑定地址）。 */
  function isLoopback(req: IncomingMessage): boolean {
    const remote = req.socket.remoteAddress ?? "";
    return remote === "127.0.0.1" || remote === "::1" || remote === "::ffff:127.0.0.1";
  }
  function headerToken(req: IncomingMessage): string | undefined {
    const value = req.headers["x-record-token"];
    return Array.isArray(value) ? value[0] : value;
  }
  /** 非 GET/HEAD 的跨站拒绝（§4.1「跨域」行）：Origin ≠ 本服务 origin（含 null）或 Sec-Fetch-Site: cross-site。 */
  function crossOriginRejected(req: IncomingMessage): boolean {
    const sfs = req.headers["sec-fetch-site"];
    if (typeof sfs === "string" && sfs.toLowerCase() === "cross-site") return true;
    const origin = req.headers.origin;
    if (origin === undefined || typeof origin !== "string") return false;
    const own = `http://${String(req.headers.host ?? "").toLowerCase()}`;
    return origin.toLowerCase().replace(/\/+$/, "") !== own;
  }
  /**
   * T2b 对接（db-port）：历史列表 / 导出经 `engine.dbPort.pages()` 分页读——keyset（≤200 行/页），
   * 页内每行 2ms 预算、页间 setImmediate 让出，外部持锁时读语句 BUSY ⇒ 抛错走 503「数据库忙」。
   * ReadQuery 的 keyset 假设整数自增 id（requests/messages 满足）；sessions 表是字符串主键 + 聚合子查询，
   * 仍走有界同步读（LIMIT 500）。
   */
  const READ_DEADLINE_MS = 10_000;
  async function readRowsPaged(q: ReadQuery): Promise<Rows> {
    const rows: Rows = [];
    for await (const page of state.dbPort.pages(q, { deadlineMs: READ_DEADLINE_MS })) {
      for (const row of page) rows.push(row);
    }
    return rows;
  }
  /** engine 仍可写（open ∧ 纪元一致 ∧ 非加密会话）。 */
  const live = (): boolean => state.state === "open" && !isSecure();
  /** await 之后重新经 persist 闸口取连接；拒绝时抛错（调用方按原逻辑回错误）。 */
  const writable = (): DatabaseSync => {
    if (!persistAllowed(state, epoch)) throw new Error(CLOSED_MESSAGE);
    return ensureDb(state);
  };

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
        await state.jq.run(program, "{}", opts);
      } catch (err) {
        if (!(err instanceof JqError) || err.kind !== "compile_error") continue;
        // 本扩展最常见的误填：把整条 shell 命令粘进来。单引号在 jq 语言里非法。
        const shellWrapped = /^\s*jq\s+['"]/.test(program);
        const hint = shellWrapped
          ? `：该字段只要 jq 程序本身，不要包 shell 外壳。应填 ${program.replace(/^\s*jq\s+['"]/, "").replace(/['"]\s*$/, "")}`
          : "";
        throw new PublicInputError(`${field} jq 语法错误${hint}`);
      }
    }
  }

  function tryDb(): { d: DatabaseSync | null; error: string | null } {
    try {
      return { d: ensureDb(state), error: null };
    } catch (err) {
      // 安全评审 #4：公开面经 publicDbError 折叠为固定文案；细节（清洗后）只进日志。
      try {
        console.error("[traffic] db unavailable:", sanitizeDetail(err, state));
      } catch {}
      return { d: null, error: sanitizeDetail(err, state) };
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
    rawDbError: string | null = state.dbError,
  ): Promise<Record<string, unknown>> {
    const dbError = publicDbError(rawDbError);
    const engine = d ? getEngineSettings(d) : DEFAULT_ENGINE_SETTINGS;
    const enabledRules = d ? loadEnabledRules(d).length : null;
    const probe = await state.jq.probe(engine.jqPath || undefined);
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
      // T2b：串行化闸门退役（r2 票据归属）。四个 serialize_* 键停用（页面展示为已停用），PUT 仍接受旧值。
      serialize_retired: true,
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
          // 安全评审 #4：db_error 是公开响应字段——经清洗边界（不含 token/路径）。
          state.dbError = sanitizeDetail(err, state);
        }
      }
      const jq = await state.jq.probe();
      const codexWsWarned = state.codexWsWarned;
      // 安全评审 #4：db_error 公开面固定文案（state.dbError 可能由 db.ts 以原文写入）。
      const dbError = publicDbError(result.error ?? state.dbError);
      sendJson(res, {
        recording: state.recording,
        port: state.serverPort,
        host: bindHost,
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
      sendJson(res, { error: PUBLIC_DB_ERROR }, 503);
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
        input = await readJsonBody(req);
        const rule = normalizeRulePayload(input);
        await assertRuleJqCompiles(rule, d);
        const now = new Date().toISOString();
        const w = writable();
        const result = w
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
        // 发送路径只读 engine 的内存规则快照（T2b 安全评审 #4）：写成功后立即刷新，不等 1s 定时器。
        state.refreshRules();
        broadcast(state, { type: "rewrite_rules" });
        sendJson(res, w.prepare("SELECT * FROM rewrite_rules WHERE id = ?").get(id), 201);
      } catch (err) {
        sendRouteError(res, state, err, "rules create");
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
        const rule = normalizeRulePayload(await readJsonBody(req));
        await assertRuleJqCompiles(rule, d);
        const now = new Date().toISOString();
        const w = writable();
        w.prepare(
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
        state.refreshRules();
        broadcast(state, { type: "rewrite_rules" });
        sendJson(res, w.prepare("SELECT * FROM rewrite_rules WHERE id = ?").get(id));
      } catch (err) {
        sendRouteError(res, state, err, "rules update");
      }
      return;
    }

    if (ruleMatch && req.method === "DELETE") {
      const id = Number(ruleMatch[1]);
      let result: { changes: number | bigint };
      try {
        result = writable().prepare("DELETE FROM rewrite_rules WHERE id = ?").run(id);
      } catch (err) {
        sendRouteError(res, state, err, "rules delete");
        return;
      }
      if (!result.changes) {
        sendJson(res, { error: "not found" }, 404);
        return;
      }
      state.refreshRules();
      broadcast(state, { type: "rewrite_rules" });
      sendJson(res, { ok: true });
      return;
    }

    if (path === "/api/rewrite/settings" && req.method === "GET") {
      sendJson(res, await rewriteSettingsResponse(d));
      return;
    }

    if (path === "/api/rewrite/settings" && req.method === "PUT") {
      try {
        const input = await readJsonBody(req);
        if (!isObject(input)) throw new PublicInputError("请求体必须是 JSON 对象");
        const current = getEngineSettings(d);
        const jqPath = input.jq_path === undefined ? current.jqPath : input.jq_path;
        if (typeof jqPath !== "string") throw new PublicInputError("jq_path 必须是字符串");
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
            throw new PublicInputError(`${key} 必须是 ${min} 到 ${max} 之间的整数`);
          }
          values.set(key, value);
        }
        const upsert = writable().prepare(
          "INSERT INTO rewrite_settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value",
        );
        upsert.run("jq_path", jqPath.trim());
        for (const [key, value] of values) upsert.run(key, String(value));
        state.refreshRules();
        sendJson(res, await rewriteSettingsResponse(ensureDb(state)));
      } catch (err) {
        sendRouteError(res, state, err, "settings update");
      }
      return;
    }

    if (path === "/api/sessions") {
      // sessions.id 是字符串主键且含聚合子查询：dbPort 的 keyset 分页不适用，保持有界同步读（LIMIT 500）。
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
      const limit = Math.max(0, Math.floor(Math.min(Number(url.searchParams.get("limit")) || 100, 1000)));
      const offset = Math.max(0, Math.floor(Number(url.searchParams.get("offset")) || 0));
      const columns =
        "id, session_id, turn, ts, provider, model, status, origin, replay_of, rewrite_status, LENGTH(payload) AS size";
      let rows: Record<string, unknown>[];
      if (offset === 0) {
        // 热路径（页面只翻最新）：keyset 分页读，ORDER BY id DESC 与旧查询一致。
        rows = await readRowsPaged({
          table: "requests",
          columns,
          ...(sid ? { where: "session_id = ?", params: [sid] } : {}),
          order: "desc",
          limit,
        });
      } else {
        // keyset 无法表达 OFFSET：保留旧同步 OFFSET 路径（LIMIT 仍钳在 1000）。
        rows = (
          sid
            ? d.prepare(`SELECT ${columns} FROM requests WHERE session_id = ? ORDER BY id DESC LIMIT ? OFFSET ?`)
            : d.prepare(`SELECT ${columns} FROM requests ORDER BY id DESC LIMIT ? OFFSET ?`)
        ).all(...(sid ? [sid, limit, offset] : [limit, offset])) as Record<string, unknown>[];
      }
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
      // 导出只含实际录制的请求，replay 行不进数据集（避免破坏配对与数据集纯度）。
      // 安全评审 #1/#2：流式导出——只选需要的列（不取 request_headers/orig_* 等凭证列），
      // 逐行序列化写出，尊重 res.write 背压（drain），客户端断开即 abort 分页迭代；
      // 内存占用 O(单页)（≤200 行/页），不随会话行数线性累积。
      // 配对语义与旧实现一致：requests（过滤后）与 assistant 消息各按 id 升序，位置 zip。
      await exportStream(res, sid);
      return;
    }

    sendJson(res, { error: "not found" }, 404);
  }

  /**
   * 流式 NDJSON 导出（安全评审 #2）。
   *
   * - 两段查询都走 `dbPort.pages()`（keyset ORDER BY id ASC；messages 必须选 `id` 列——
   *   keyset 游标从 `row.id` 前进，缺 id ⇒ 游标 NaN、跨页丢行（安全评审 #1））。
   * - assistant 行按需惰性拉取（每条请求配一行），两段各驻留至多一页。
   * - `res.write` 返回 false ⇒ await drain；与「客户端断开」竞速，断开即停止拉页。
   * - 响应头不再携带总行数（无法预知）；文件名中的 session 片段做头安全清洗。
   * - engine 关闭（getDb 返回 null）或截止耗尽 ⇒ 迭代提前结束，流在已写内容处截断。
   */
  const EXPORT_DEADLINE_MS = 60_000;
  async function exportStream(res: ServerResponse, sid: string): Promise<void> {
    const abort = new AbortController();
    let clientGone = false;
    const onGone = (): void => {
      clientGone = true;
      abort.abort();
    };
    res.once("close", onGone);
    res.once("error", onGone);
    const reqQuery: ReadQuery = {
      table: "requests",
      columns: "id, session_id, turn, ts, provider, model, status, payload",
      where: "session_id = ? AND origin IS NULL AND (rewrite_status IS NULL OR rewrite_status <> 'blocked')",
      params: [sid],
      order: "asc",
    };
    const asstQuery: ReadQuery = {
      table: "messages",
      columns: "id, message", // id 是 keyset 游标列，必须选
      where: "session_id = ? AND role = 'assistant'",
      params: [sid],
      order: "asc",
    };
    const drainOrGone = (): Promise<"drain" | "gone"> =>
      new Promise((resolve) => {
        const onDrain = (): void => {
          cleanup();
          resolve("drain");
        };
        const onClose = (): void => {
          cleanup();
          resolve("gone");
        };
        const cleanup = (): void => {
          res.off("drain", onDrain);
          res.off("close", onClose);
        };
        res.once("drain", onDrain);
        res.once("close", onClose);
      });
    const safeName = sid.replace(/[^A-Za-z0-9._-]/g, "_").slice(0, 24) || "session";
    res.writeHead(200, {
      "content-type": "application/x-ndjson; charset=utf-8",
      "content-disposition": `attachment; filename="record-${safeName}.jsonl"`,
      connection: "close", // 流式 + 可中途截断：不复用连接
    });
    async function* rows(query: ReadQuery): AsyncGenerator<Record<string, unknown>> {
      for await (const page of state.dbPort.pages(query, { deadlineMs: EXPORT_DEADLINE_MS, signal: abort.signal })) {
        for (const row of page) yield row;
      }
    }
    const assistants = rows(asstQuery);
    let assistantNext = assistants.next();
    const takeAssistant = async (): Promise<{ message: string } | null> => {
      const step = await assistantNext;
      if (step.done) return null;
      assistantNext = assistants.next();
      return step.value as { message: string };
    };
    try {
      for await (const r of rows(reqQuery)) {
        if (clientGone || abort.signal.aborted) break;
        const paired = await takeAssistant();
        const line = JSON.stringify({
          session_id: r.session_id,
          request_id: r.id,
          turn: r.turn,
          ts: r.ts,
          provider: r.provider,
          model: r.model,
          status: r.status,
          request: parseBody(r, "payload"),
          response: paired ? parseBody(paired, "message") : null,
        });
        if (clientGone || res.destroyed || res.writableEnded) break;
        if (!res.write(`${line}\n`)) {
          if ((await drainOrGone()) === "gone") break;
        }
      }
    } finally {
      // 生成器被 break/throw 提前退出 ⇒ 显式关闭，让 pages() 的迭代器 return() 释放语句。
      await assistants.return(undefined).catch(() => undefined);
      res.end();
    }
  }

  /**
   * 编辑重放：用（可编辑的）URL / method / headers / payload 重新发往真实 provider，
   * 结果写入新的 requests 行（origin='replay'，replay_of 指向源请求，可形成重放链）。
   * 响应体（流式逐 chunk / 非流式整体）写入 stream_chunks。
   */
  async function handleReplay(req: IncomingMessage, res: ServerResponse): Promise<void> {
    if (!state.serviceAllowed) throw new TrafficModeError("重放");
    let body: Record<string, unknown>;
    try {
      const parsed = await readJsonBody(req);
      if (!isObject(parsed)) throw new PublicInputError("请求体必须是 JSON 对象");
      body = parsed;
    } catch (err) {
      sendRouteError(res, state, err, "replay body");
      return;
    }
    await replay(body, res);
  }

  /** 重放核心（模式门禁的纵深防御点：非主会话 tui/rpc 一律 E_REPLAY_MODE）。 */
  async function replay(body: Record<string, unknown>, res: ServerResponse): Promise<void> {
    if (!state.serviceAllowed) throw new TrafficModeError("重放");
    // 切点 ①：读请求体后。
    if (!live()) {
      sendJson(res, { error: CLOSED_MESSAGE }, 503);
      return;
    }
    const dbResult = tryDb();
    if (!dbResult.d) {
      // 安全评审 #4 第三轮：连接获取/打开失败同样只出固定公开文案（细节已由 tryDb 进日志）。
      sendJson(res, { error: publicDbError(dbResult.error) ?? PUBLIC_DB_ERROR }, 503);
      return;
    }
    const d = dbResult.d;
    let src: Record<string, any> | undefined;
    try {
      src = d.prepare("SELECT * FROM requests WHERE id = ?").get(Number(body.request_id)) as
        Record<string, any> | undefined;
    } catch (err) {
      // 重放 DB 失败 ⇒ publicDbError 语义（安全评审 #4 第二轮）：busy ⇒ BUSY 文案，其余固定 db 文案；细节只进日志。
      try {
        console.error("[traffic] replay source lookup:", sanitizeDetail(err, state));
      } catch {}
      sendJson(res, { error: publicDbError(String(err instanceof Error ? err.message : err)) ?? PUBLIC_DB_ERROR }, 503);
      return;
    }
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

    // T2b：外部持锁（busy_timeout=0）时同步 INSERT 立即 SQLITE_BUSY ⇒ 503 友好错误（重放未开始，无半行）。
    let newId: number;
    try {
      const ins = writable()
        .prepare(
          `INSERT INTO requests (session_id, turn, ts, provider, model, payload, request_headers, url, method, origin, replay_of)
  			 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'replay', ?)`,
        )
        .run(
          src.session_id,
          src.turn,
          ts,
          src.provider,
          src.model,
          payloadStr,
          originalHeadersText,
          url,
          method,
          src.id,
        );
      newId = Number(ins.lastInsertRowid);
    } catch (err) {
      // DB 失败（含 BUSY）⇒ publicDbError 语义；其余（理论不可达）按内部错误折叠。
      if (err instanceof Error && err.message === CLOSED_MESSAGE) {
        sendJson(res, { error: CLOSED_MESSAGE }, 503);
        return;
      }
      if (!isBusyError(err)) {
        try {
          console.error("[traffic] replay insert:", sanitizeDetail(err, state));
        } catch {}
      }
      sendJson(res, { error: isBusyError(err) ? BUSY_MESSAGE : PUBLIC_DB_ERROR }, 503);
      return;
    }
    broadcast(state, {
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
        { jq: state.jq, warn: (event) => broadcast(state, event) },
      );
      // 切点 ②：jq 之后。
      if (!live()) {
        sendJson(res, { id: newId, error: CLOSED_MESSAGE }, 503);
        return;
      }
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
      writable()
        .prepare(
          `UPDATE requests SET payload = ?, request_headers = ?, payload_encoding = ?, payload_bytes = ?, url = ?, method = ?,
  			 ${rewritten ? "orig_payload = ?, orig_request_headers = ?, rewrite_rule_ids = ?, rewrite_status = 'applied'" : "orig_payload = orig_payload"}
  			 WHERE id = ?`,
        )
        .run(
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
      if (!live()) {
        sendJson(res, { id: newId, error: CLOSED_MESSAGE }, 503);
        return;
      }
      writable()
        .prepare(
          `UPDATE requests SET status = 0, payload = ?, request_headers = ?, orig_payload = ?, orig_request_headers = ?,
  			 rewrite_rule_ids = ?, rewrite_status = 'blocked', rewrite_error = ?, url = ?, method = ? WHERE id = ?`,
        )
        .run(
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
      broadcast(state, { type: "rewrite_error", id: newId, session_id: src.session_id, ...safe });
      broadcast(state, { type: "response", id: newId, session_id: src.session_id, status: 0 });
      sendJson(res, { id: newId, error: safe.message, rewrite_error: safe }, 400);
      return;
    }

    // 重放必须绕过自己的 fetch patch，避免干扰 provider 请求关联队列。
    // T1 严格化（exactOptionalPropertyTypes）：body 键只在真有正文时写入，GET/HEAD 不携带 body 键
    // （fetch 对「无键」与「显式 undefined」行为一致）。
    // T2a：绕过 trampoline——活动 wrapper 的固定下游；无活动 wrapper 时用进程原生 fetch。
    const doFetch = tapActiveFor(state)?.next ?? peekTapRecord()?.nativeFetch ?? globalThis.fetch;
    // 取消域 + 二级截止：engine.close ⇒ abort（只触发不等待）；响应头 / 总长截止兜底。
    const controller = new AbortController();
    const abort = (reason: string): void => {
      if (!controller.signal.aborted) controller.abort(new Error(`traffic replay aborted: ${reason}`));
    };
    const unregister = state.cancel.register(abort);
    const clearTotal = armTimer(state.replayDeadlines.totalMs, () => abort("total-deadline"));
    const clearHead = armTimer(state.replayDeadlines.headMs, () => abort("head-deadline"));
    const finish = (): void => {
      clearHead();
      clearTotal();
      unregister();
    };
    let upstream: Response;
    try {
      const replayInit: RequestInit = { method, headers: sendHeaders, signal: controller.signal };
      if (method !== "GET" && method !== "HEAD") replayInit.body = sendBody;
      upstream = await doFetch(url, replayInit);
    } catch (err) {
      finish();
      // 上游失败：公开面固定文案（安全评审 #4 第二轮）；细节经 sanitize 只进日志与库内行。
      const detail = sanitizeDetail(err, state);
      try {
        console.error("[traffic] replay upstream:", detail);
      } catch {}
      try {
        writable()
          .prepare("UPDATE requests SET status = ?, response_headers = ? WHERE id = ?")
          .run(0, JSON.stringify({ error: detail }), newId);
        broadcast(state, { type: "response", id: newId, session_id: src.session_id, status: 0 });
      } catch {
        // engine 已关闭 / 加密会话：丢弃写。
      }
      sendJson(res, { id: newId, error: "上游请求失败（详情已记录）" }, live() ? 502 : 503);
      return;
    }
    clearHead();
    // ---- 响应头之后：异常安全的资源作用域（安全评审 #3）----
    // 规则：只有 captureStream 报告自然 EOF 时，才允许在不中止的情况下注销 AbortController 与截止；
    // 其它任何退出（切点 ③ 拒绝、status UPDATE 抛错、流式落库抛错、读错、取消）都先 abort（只触发不等待），
    // 再 finish。故存活的上游永远至少有一个清理入口（取消域里的 controller 或总截止）。
    const settle = (kind: "eof" | "aborted"): void => {
      if (kind !== "eof") abort("replay-ended-early");
      finish();
    };
    const captureOpts = {
      idleMs: state.replayDeadlines.idleMs,
      signal: controller.signal,
      onEnd: settle,
    };
    try {
      // 切点 ③：上游返回后。
      if (!live()) {
        settle("aborted");
        void upstream.body?.cancel().catch(() => {});
        sendJson(res, { id: newId, error: CLOSED_MESSAGE }, 503);
        return;
      }

      const respHeaders: Record<string, string> = {};
      upstream.headers.forEach((v, k) => {
        respHeaders[k] = v;
      });
      writable()
        .prepare("UPDATE requests SET status = ?, response_headers = ? WHERE id = ?")
        .run(upstream.status, JSON.stringify(respHeaders), newId);
      broadcast(state, { type: "response", id: newId, session_id: src.session_id, status: upstream.status });
      // 流式成功响应：后台逐 chunk 入库，页面立即返回（内容见新记录「流式/输出」子页）；
      // 错误（≥400）/ 非流式响应 body 一般很小，收完随应答带回，页面右侧直接展示
      const ct = (upstream.headers.get("content-type") ?? "").toLowerCase();
      const isStream = ct.includes("event-stream") || ct.includes("x-ndjson") || ct.includes("stream+json");
      if (upstream.status >= 400 || !isStream) {
        const bodyText = await state.capture.captureStream(newId, src.session_id, upstream, epoch, captureOpts);
        sendJson(res, {
          id: newId,
          status: upstream.status,
          headers: respHeaders,
          ...(rewriteSkipped ? { rewrite_skipped: "recording_off" } : {}),
          body: bodyText.length > 20_000 ? `${bodyText.slice(0, 20_000)}\n…（截断，完整见 #${newId}）` : bodyText,
        });
        return;
      }
      void state.capture.captureStream(newId, src.session_id, upstream, epoch, captureOpts);
      sendJson(res, {
        id: newId,
        status: upstream.status,
        headers: respHeaders,
        ...(rewriteSkipped ? { rewrite_skipped: "recording_off" } : {}),
      });
    } catch (err) {
      // captureStream 自身不抛（其 finally 已 settle）；到这里的是它之前的同步异常（status UPDATE 等）。
      settle("aborted");
      void upstream.body?.cancel().catch(() => {});
      throw err;
    }
  }

  /** T4 §4.1：鉴权与跨域门禁后的主请求管线（Host/OPTIONS/跨域/token 见 handleHttp 顶部）。 */
  function handleHttp(req: IncomingMessage, res: ServerResponse): void {
    // 反嵌入/元数据头：所有响应（页面、API、错误页、401/404/421/405）统一携带。
    setSecurityHeaders(res);
    try {
      const url = new URL(req.url ?? "/", "http://127.0.0.1");
      const method = (req.method ?? "GET").toUpperCase();

      // 1) Host 白名单（鉴权前，防 DNS rebinding）：不在清单 ⇒ 421。
      if (!hostAllowed(req)) {
        res.writeHead(421, { "content-type": "text/plain; charset=utf-8", connection: "close" });
        res.end("421 Misdirected Request: Host 不在允许清单（防 DNS rebinding）");
        return;
      }

      // 2) OPTIONS 一律 405：预检永远不成功（本服务无任何跨域读能力，也从不发 Access-Control-Allow-*）。
      if (method === "OPTIONS") {
        res.writeHead(405, {
          "content-type": "text/plain; charset=utf-8",
          allow: "GET, HEAD, POST, PUT, PATCH, DELETE",
        });
        res.end("405 Method Not Allowed");
        return;
      }

      const isApi = url.pathname === "/api" || url.pathname.startsWith("/api/");
      const isPage = url.pathname === "/";
      // 3) 缓存：含 token 的 HTML 与全部 /api/* 一律 no-store（SSE 亦不缓存）。
      if (isApi || isPage) res.setHeader("Cache-Control", "no-store");

      // 4) 跨站元数据门禁（状态变更请求；§4.1「跨域」行）：Origin ≠ 本服务（含 null）或
      //    Sec-Fetch-Site: cross-site ⇒ 403；缺元数据时仅凭 token（下一道闸）。
      if (method !== "GET" && method !== "HEAD" && crossOriginRejected(req)) {
        res.writeHead(403, { "content-type": "text/plain; charset=utf-8" });
        res.end("403 Forbidden: 跨站请求被拒绝（Origin / Sec-Fetch-Site 校验失败）");
        return;
      }

      // 5) token 门禁。页面 `/`：回环免 token（token 经 <meta> 注入 HTML）；非回环须带（导航只能 ?token= 或头）。
      //    /api/*：一律要 token（回环亦然）；GET/HEAD 接受头或 ?token=，状态变更只认 x-record-token 头
      //    （自定义头跨站表单无法伪造 —— CSRF 纵深）。
      if (isPage) {
        if (!isLoopback(req) && !tokenMatches(headerToken(req) ?? url.searchParams.get("token"), state.accessToken)) {
          res.writeHead(401, { "content-type": "text/plain; charset=utf-8" });
          res.end("401 unauthorized: 页面访问需要 token（用 /record status 输出的带 token URL 打开）");
          return;
        }
        // 页面已模块级 gzipSync 预压缩：客户端支持 gzip 时直接回发压缩副本
        const page = (state.page ??= buildPage(state.accessToken ?? undefined));
        const accept = req.headers["accept-encoding"];
        if (typeof accept === "string" && accept.includes("gzip")) {
          res.writeHead(200, { "content-type": "text/html; charset=utf-8", "content-encoding": "gzip" });
          res.end(page.gzip);
        } else {
          res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
          res.end(page.html);
        }
        return;
      }

      if (isApi) {
        const viaHeader = headerToken(req);
        const viaQuery = url.searchParams.get("token");
        const ok =
          method === "GET" || method === "HEAD"
            ? tokenMatches(viaHeader ?? viaQuery, state.accessToken)
            : // 状态变更（POST/PUT/PATCH/DELETE）：只认自定义头形式——?token= 单独出现恒拒。
              tokenMatches(viaHeader, state.accessToken);
        if (!ok) {
          res.writeHead(401, { "content-type": "text/plain; charset=utf-8" });
          res.end(
            method === "GET" || method === "HEAD"
              ? "401 unauthorized: /api/* 需要 token（x-record-token 头或 ?token=；页面 token 见 /record status）"
              : "401 unauthorized: 状态变更请求必须经 x-record-token 头携带 token（不接受 ?token=）",
          );
          return;
        }
        if (url.pathname === "/api/events") {
          // no-store 已设置；SSE 语义只需 keep-alive。
          res.writeHead(200, { "content-type": "text/event-stream", connection: "keep-alive" });
          if (state.state !== "open") {
            res.end();
            return;
          }
          res.write("retry: 2000\n\n");
          state.sseClients.add(res);
          req.on("close", () => state.sseClients.delete(res));
          return;
        }

        if (url.pathname === "/api/replay" && method === "POST") {
          void handleReplay(req, res).catch((err: unknown) => {
            if (err instanceof TrafficModeError) {
              try {
                sendJson(res, { error: err.message, code: err.code }, 403);
              } catch {}
              return;
            }
            if (isBusyError(err)) {
              try {
                sendJson(res, { error: BUSY_MESSAGE }, 503);
              } catch {}
              return;
            }
            // 安全评审 #4：不可预期异常 ⇒ 固定文案 + E_INTERNAL；细节只进日志（清洗后）。
            sendInternalError(res, state, "api replay", err);
          });
          return;
        }

        void handleApi(req, res, url).catch((err: unknown) => {
          if (isBusyError(err)) {
            try {
              sendJson(res, { error: BUSY_MESSAGE }, 503);
            } catch {}
            return;
          }
          sendInternalError(res, state, "api", err);
        });
        return;
      }

      res.writeHead(404, { "content-type": "text/plain; charset=utf-8" });
      res.end("not found");
    } catch (err) {
      sendInternalError(res, state, "http", err);
    }
  }

  /**
   * 可访问 URL 列表（T4 §4.1「绑定」「LAN 提示」行）：
   * 默认只绑回环 ⇒ 只报 127.0.0.1；`0.0.0.0`（LAN opt-in）时优先真实局域网 IPv4（过滤
   * docker/网桥/代理虚拟网卡；无局域网时回退 127.0.0.1），URL 带 ?token=（页面导航无法带自定义头），
   * 并附明文 HTTP 风险提示（Host 白名单与 token 不替代传输加密）。
   */
  function accessUrls(port: number): string[] {
    const q = state.accessToken ? `?token=${state.accessToken}` : "";
    if (!lanBound) return [`http://127.0.0.1:${port}`];
    const skipIface = /^(docker|br-|veth|virbr|tun|tap|utun|meta|zt|tailscale)/i;
    const isPrivate = (ip: string) =>
      /^192\.168\./.test(ip) || /^10\./.test(ip) || /^172\.(1[6-9]|2\d|3[01])\./.test(ip);
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
    const urls = [...lan, ...other, `http://127.0.0.1:${port}`];
    if (lan.length + other.length > 0) {
      urls.push("⚠ 明文 HTTP：token、请求正文与 API key 可被同网段嗅探（Host 白名单与 token 不替代传输加密）");
    }
    return urls;
  }

  /**
   * 启动网页服务（安全评审 #4）：每个 engine **single-flight**——启动中的并发调用共享同一个 promise，
   * 至多一个 listener；每个曾创建的 listener 都登记在 `engine.listeners`，engine.close 逐个关闭
   * （含启动中 / 绑定失败的实例），不会因引用被覆盖而残留端口。
   */
  function startServer(): Promise<number> {
    if (!state.serviceAllowed) return Promise.reject(new TrafficModeError("网页服务"));
    if (state.state !== "open") return Promise.reject(new Error(CLOSED_MESSAGE));
    if (state.server && state.serverPort !== null) return Promise.resolve(state.serverPort);
    if (state.serverStarting) return state.serverStarting;
    const starting = listenFirstFree().finally(() => {
      if (state.serverStarting === starting) state.serverStarting = null;
    });
    state.serverStarting = starting;
    return starting;
  }

  async function listenFirstFree(): Promise<number> {
    ensureDb(state);
    state.accessToken = state.accessToken ?? randomBytes(16).toString("hex");
    // 安全评审 #5：合法端口上界截断——绝不 listen(65536+) 抛参数异常，超出即按有界「端口占用」结束。
    const startPort = opts.port ?? BASE_PORT;
    const endPort = Math.min(startPort + MAX_PORT_TRIES - 1, 65535);
    for (let port = startPort; port <= endPort; port++) {
      const started = await new Promise<Server | null>((resolve) => {
        const s = createServer(handleHttp);
        state.listeners.add(s);
        // 启动中被 engine.close 关掉（listen 回调不会再来）也要让本轮结束，否则启动 promise 永不 settle。
        s.once("close", () => {
          state.listeners.delete(s);
          resolve(null);
        });
        // 连接账本：每个 accepted socket unref 并记账，engine.close 时逐个 destroy。
        s.on("connection", (socket: Socket) => {
          socket.unref();
          if (state.state !== "open") {
            socket.destroy();
            return;
          }
          state.connections.add(socket);
          socket.once("close", () => state.connections.delete(socket));
        });
        s.once("error", () => {
          state.listeners.delete(s);
          try {
            s.close();
          } catch {}
          resolve(null);
        });
        s.listen(port, bindHost, () => {
          s.unref();
          if (state.state !== "open") {
            // 监听期间 engine 已关闭：不得留下监听。
            s.close();
            resolve(null);
            return;
          }
          resolve(s);
        });
      });
      if (state.state !== "open") throw new Error(CLOSED_MESSAGE);
      if (started) {
        state.server = started;
        state.serverPort = port;
        return port;
      }
    }
    throw new Error(`端口 ${startPort}-${Math.max(startPort, endPort)} 均被占用`);
  }

  return { startServer, accessUrls, handleHttp, replay };
}
