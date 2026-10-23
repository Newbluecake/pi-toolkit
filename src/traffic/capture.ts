/**
 * fetch 层：票据认领、按 (T, generation, 正文摘要) 改写与线级录制（traffic-merge plan §5.3 fetch 表）。
 *
 * 由 tap.ts 的活动 wrapper 调用 `capture.handleFetch(next, input, init, ticket)`：`next` 为 wrapper 安装时捕获的固定
 * 下游，入参已剥离票据头，票据值单独传入。全部状态归 engine，入口固定 engine 与纪元；所有写进写后账本（persist.ts 的
 * `record*`），provider 请求从不等待 DB。
 *
 * | 情形                                           | 行为                                                                     |
 * | ---------------------------------------------- | ------------------------------------------------------------------------ |
 * | 无票据头                                       | 纯透传，不认领、不改写、不录                                             |
 * | 票据未知 / 已回收 / 属其他纪元                 | 透传，`staleTickets++`                                                   |
 * | 票据从未绑定（compaction 只有 headers 等）     | 透传，不改写、不录线级字段（响应仍参与退役规则 ①）                       |
 * | 已绑定，本 generation 尚无正文摘要             | 绑定摘要；按本 generation 规则快照改写，结果缓存；线级字段写本 generation 行 |
 * | 已绑定，摘要等于本 generation 摘要             | 同 generation 的网络重试：复用缓存结果（正文字节一致），不重跑 jq          |
 * | 已绑定，摘要不等                               | 未被证明的新正文：原样透传、不改写、`unattributedFetches++`，不写该票据行 |
 * | 本 generation 已 blocked（同摘要）             | 再抛同一错误，不重跑 jq、不放出原请求；通知按 (会话, 规则集, 错误) 30s 去重 |
 *
 * 状态与响应头由 fetch 层直接从 `Response` 写入（精确）；2xx/3xx ⇒ 票据退役（规则 ①）。
 */
import { createHash } from "node:crypto";
import { urlMatchesBase } from "./correlate.js";
import { idleTimer } from "./cancel.js";
import { newRowRef, type RowRef } from "./db-port.js";
import type { TrafficEngine } from "./engine.js";
import { recordChunk, recordPatch } from "./persist.js";
import {
  applyRequest,
  decodeBody,
  encodingOf,
  extractBody,
  headersToJson,
  sanitizeSendHeaders,
  type ApplyResult,
  type RewriteEnv,
} from "./rewrite.js";
import { RewriteError } from "./rewrite.js";
import { isSecure } from "./secure.js";
import { broadcast } from "./sse.js";
import { rewriteSuspended, type RewriteOutcome, type Ticket, type TicketGeneration } from "./ticket.js";

/** 把 fetch 的 headers 入参（Headers / 二元组数组 / 普通对象）归一化为普通对象 */
export function normalizeHeaders(h: unknown): Record<string, string> {
  const out: Record<string, string> = {};
  if (!h) return out;
  if (h instanceof Headers) {
    h.forEach((v, k) => {
      out[k] = v;
    });
    return out;
  }
  if (Array.isArray(h)) {
    for (const e of h) {
      if (Array.isArray(e) && e.length >= 2) out[String(e[0])] = String(e[1]);
    }
    return out;
  }
  if (typeof h === "object") {
    for (const [k, v] of Object.entries(h as Record<string, unknown>)) {
      if (typeof v === "string") out[k] = v;
    }
  }
  return out;
}

export function noteDbErrorOn(state: TrafficEngine, err: unknown): void {
  const message = err instanceof Error ? err.message : String(err);
  if (!state.dbError) state.dbError = message;
  if (!state.dbErrorNotified) {
    state.dbErrorNotified = true;
    broadcast(state, { type: "record_warn", message: `数据库错误，改写持久化已禁用: ${message}` });
  }
}

function requestHeaders(input: unknown, init: unknown): unknown {
  if (typeof init === "object" && init !== null && "headers" in init) return (init as { headers?: unknown }).headers;
  return typeof input === "object" && input !== null ? (input as { headers?: unknown }).headers : undefined;
}

function isBinaryBody(value: unknown): value is ArrayBuffer | ArrayBufferView {
  return value instanceof ArrayBuffer || ArrayBuffer.isView(value);
}

function bodyByteLength(init: unknown): number | null {
  const initBody = typeof init === "object" && init !== null ? (init as { body?: unknown }).body : undefined;
  if (typeof initBody === "string") return Buffer.byteLength(initBody, "utf8");
  if (isBinaryBody(initBody)) return initBody.byteLength;
  return null;
}

function byteView(value: ArrayBuffer | ArrayBufferView): Uint8Array {
  if (value instanceof ArrayBuffer) return new Uint8Array(value);
  return new Uint8Array(value.buffer, value.byteOffset, value.byteLength);
}

async function bodyTextOf(result: ApplyResult): Promise<string | null> {
  if (!result.bodyChanged || result.body === null) return null;
  if (typeof result.body === "string") return result.body;
  const bytes = result.body instanceof Uint8Array ? result.body : new Uint8Array(result.body);
  return decodeBody(bytes, result.encoding);
}

/**
 * 原始正文摘要（sha256；压缩正文按 content-encoding 解压后摘要）。不 JSON.parse（热路径只做一次哈希）。
 * 不可摘要（流式 body 等）⇒ null：无法证明同一正文，fetch 层按未证明处理（透传不改写）。
 */
export async function bodyDigest(input: unknown, init: unknown): Promise<string | null> {
  const initBody = typeof init === "object" && init !== null ? (init as { body?: unknown }).body : undefined;
  const hash = (data: string | Uint8Array): string => createHash("sha256").update(data).digest("hex");
  if (typeof initBody === "string") return hash(initBody);
  if (isBinaryBody(initBody)) {
    const bytes = byteView(initBody);
    try {
      const encoding = encodingOf(headersToJson(requestHeaders(input, init)));
      if (encoding !== "identity") return hash(decodeBody(bytes, encoding));
    } catch {
      // 未知编码：按原始字节摘要。
    }
    return hash(bytes);
  }
  if (initBody !== undefined && initBody !== null) return null;
  if (typeof Request !== "undefined" && input instanceof Request) {
    if (input.body === null) return "none";
    try {
      return hash(await input.clone().text());
    } catch {
      return null;
    }
  }
  return "none";
}

/** 根据 applyRequest 的结果重建 fetch 入参，保留 Request 的原有请求属性。 */
export function rebuildRequest(input: any, init: any, result: ApplyResult): { input: any; init: any } {
  if (typeof Request !== "undefined" && input instanceof Request) {
    const options: RequestInit = { headers: result.headers, signal: input.signal };
    if (result.bodyChanged) options.body = result.body as NonNullable<RequestInit["body"]>;
    return { input: new Request(input, options), init: undefined };
  }
  return {
    input,
    init: {
      ...(init ?? {}),
      headers: result.headers,
      ...(result.bodyChanged ? { body: result.body } : {}),
    },
  };
}

function blockedSafeEvent(err: unknown): {
  kind: string;
  phase: string;
  rule_id: number | null;
  rule_name: string | null;
  message: string;
  detail: string | null;
} {
  if (err instanceof RewriteError) return err.toSafeEvent();
  return {
    kind: "runtime_error",
    phase: "body",
    rule_id: null,
    rule_name: null,
    message: "改写引擎异常",
    detail: null,
  };
}

type FetchLike = (input: any, init?: any) => Promise<Response>;

export interface Capture {
  /** 活动 wrapper 调用：`original` 为 wrapper 安装时捕获的固定下游；入参已剥离票据头。 */
  handleFetch(original: FetchLike, input: any, init: any, ticket: string | null): Promise<Response>;
  /**
   * 后台消费响应体并逐批进写后账本；登记进取消域，每批复查 persist 闸口。`requestId` 为已落库的行 id（重放）或
   * 行引用（provider 请求，行可能尚在账本中）。
   */
  captureStream(
    requestId: number | RowRef,
    sessionId: string,
    res: Response,
    epoch?: number,
    opts?: CaptureStreamOptions,
  ): Promise<string>;
  setRewriteBlockedHandler(handler: ((message: string) => void) | null): void;
}

export interface CaptureStreamOptions {
  /** 读流空闲上界（ms）；超时 ⇒ reader.cancel()（不等待）。缺省不设。 */
  idleMs?: number;
  /** 额外的取消信号（重放的 AbortController）。 */
  signal?: AbortSignal;
  /**
   * 结束回调：`eof` = 上游自然读完；`aborted` = 其它一切退出（此时 reader 取消已触发）。重放据此在
   * 非 EOF 时 abort 自己的 AbortController，之后才注销截止与取消域条目。
   */
  onEnd?: (kind: "eof" | "aborted") => void;
}

/** 阻断通知去重窗口（同一 (会话, 规则集, 错误)）。 */
export const BLOCKED_NOTIFY_DEDUP_MS = 30_000;

export function createCapture(state: TrafficEngine): Capture {
  let blockedHandler: ((message: string) => void) | null = null;
  const rewriteEnv = (): RewriteEnv => ({ jq: state.jq, warn: (event) => broadcast(state, event) });
  const blockedNotified = new Map<string, number>();

  const counters = () => state.tickets.counters;

  function setRewriteBlockedHandler(handler: ((message: string) => void) | null): void {
    blockedHandler = handler;
  }

  function notifyBlocked(gen: TicketGeneration, safe: ReturnType<typeof blockedSafeEvent>, text: string): void {
    const key = JSON.stringify([gen.sessionId, gen.rules.map((r) => r.id), safe.kind, safe.phase, safe.rule_id]);
    const t = Date.now();
    for (const [k, at] of blockedNotified) if (t - at >= BLOCKED_NOTIFY_DEDUP_MS) blockedNotified.delete(k);
    if (blockedNotified.has(key)) return;
    blockedNotified.set(key, t);
    blockedHandler?.(text);
  }

  /** 改写阻断：写阻断行（进账本）、双 SSE、通知（去重），返回要抛给 SDK 的错误。 */
  function onRewriteBlocked(
    gen: TicketGeneration,
    url: string,
    method: string,
    origHeaders: Record<string, string>,
    origPayload: string | null,
    err: unknown,
    epoch: number,
  ): Error {
    const safe = blockedSafeEvent(err);
    const ruleName = safe.rule_name ?? "未知规则";
    const ruleId = safe.rule_id === null ? "?" : String(safe.rule_id);
    const message = `traffic-record rewrite blocked: [规则 "${ruleName}" #${ruleId}] ${safe.phase} ${safe.kind}`;
    const ruleIds = gen.rules.map((r) => r.id);
    const finish = (rowId: number | null): void => {
      broadcast(state, { type: "rewrite_error", id: rowId, session_id: gen.sessionId, ...safe, message });
      broadcast(state, { type: "response", id: rowId, session_id: gen.sessionId, status: 0 });
    };
    if (gen.row) {
      const ok = recordPatch(
        state,
        epoch,
        gen.row,
        "requests",
        {
          status: 0,
          rewrite_status: "blocked",
          rewrite_error: JSON.stringify(safe),
          orig_payload: origPayload,
          orig_request_headers: JSON.stringify(origHeaders),
          rewrite_rule_ids: JSON.stringify(ruleIds.length > 0 ? ruleIds : safe.rule_id === null ? [] : [safe.rule_id]),
          url,
          method,
        },
        { onDone: finish },
      );
      if (!ok) finish(null);
    } else {
      finish(null);
    }
    const blockedError = err instanceof RewriteError ? err : new Error(message);
    blockedError.message = message;
    // 安全边界：只用 toSafeEvent 的结构化字段，绝不带 detail（含 jq stderr）。
    notifyBlocked(
      gen,
      safe,
      `改写阻断：规则「${ruleName}」#${ruleId} ${safe.phase} 阶段 ${safe.kind}\n请求已中断。详情见 Web 页「改写」子页。`,
    );
    return blockedError;
  }

  async function runRewrite(
    gen: TicketGeneration,
    url: string,
    method: string,
    input: unknown,
    init: unknown,
    epoch: number,
  ): Promise<RewriteOutcome> {
    // 录制关闭 = 改写引擎停机。
    if (!state.recording || gen.rules.length === 0) return { kind: "ok", result: null };
    const headers = requestHeaders(input, init);
    const originalHeaders = headersToJson(headers);
    let origPayload: string | null =
      typeof init === "object" && init !== null && typeof (init as { body?: unknown }).body === "string"
        ? ((init as { body: string }).body as string)
        : null;
    try {
      const result = await applyRequest(
        gen.rules,
        gen.settings,
        { url, method, model: gen.model },
        async () => {
          const body = await extractBody(input, init, originalHeaders);
          if (body.kind === "json") origPayload = body.text;
          return body;
        },
        headers,
        rewriteEnv(),
      );
      return { kind: "ok", result };
    } catch (err) {
      if (err instanceof RewriteError) {
        return {
          kind: "blocked",
          error: onRewriteBlocked(gen, url, method, originalHeaders, origPayload, err, epoch),
        };
      }
      // 存储 / 引擎故障绝不阻断 provider 请求。
      noteDbErrorOn(state, err);
      return { kind: "ok", result: null };
    }
  }

  /** 同 generation 复用缓存结果：正文字节一致；规则未改头时用本次请求自己的头（SDK 重试计数等）。 */
  function reuseResult(gen: TicketGeneration, cached: ApplyResult, input: unknown, init: unknown): ApplyResult {
    if (gen.rules.some((r) => Boolean(r.headers_jq?.trim()))) return cached;
    try {
      return { ...cached, headers: sanitizeSendHeaders(headersToJson(requestHeaders(input, init))) };
    } catch {
      return cached;
    }
  }

  /** 首次 fetch：线级字段写本 generation 行（进账本）。 */
  async function recordWire(
    ticket: Ticket,
    gen: TicketGeneration,
    url: string,
    method: string,
    applied: ApplyResult | null,
    effectiveInit: unknown,
    effectiveInput: unknown,
    epoch: number,
  ): Promise<void> {
    if (!gen.row) return;
    const row = gen.row;
    try {
      let sendHeaders: Record<string, string>;
      if (applied) {
        sendHeaders = applied.headers;
      } else {
        const raw = headersToJson(requestHeaders(effectiveInput, effectiveInit));
        if (Object.keys(raw).length > 0) {
          try {
            sendHeaders = sanitizeSendHeaders(raw);
          } catch {
            sendHeaders = raw;
          }
        } else {
          let snap: Record<string, string> = {};
          try {
            snap = headersToJson(ticket.headersSnapshot ? JSON.parse(ticket.headersSnapshot) : {});
          } catch {}
          try {
            sendHeaders = sanitizeSendHeaders(snap);
          } catch {
            sendHeaders = snap;
          }
        }
      }
      const headerText = Object.keys(sendHeaders).length > 0 ? JSON.stringify(sendHeaders) : null;
      let encoding: "identity" | "zstd" | "gzip" | "deflate" | "br" = "identity";
      try {
        encoding = encodingOf(sendHeaders);
      } catch (err) {
        noteDbErrorOn(state, err);
      }
      const payloadBytes = applied?.bodyBytes ?? bodyByteLength(effectiveInit);
      if (!applied || applied.ruleIds.length === 0) {
        recordPatch(
          state,
          epoch,
          row,
          "requests",
          { url, method, request_headers: headerText, payload_encoding: encoding, payload_bytes: payloadBytes },
          { coalesce: ["request_headers"] },
        );
        return;
      }
      const finalPayload = await bodyTextOf(applied);
      recordPatch(
        state,
        epoch,
        row,
        "requests",
        {
          url,
          method,
          payload: applied.bodyChanged ? finalPayload : null,
          request_headers: headerText,
          payload_encoding: encoding,
          payload_bytes: payloadBytes,
          orig_payload: applied.origBodyText ?? null,
          orig_request_headers: JSON.stringify(applied.origHeaders),
          rewrite_rule_ids: JSON.stringify(applied.ruleIds),
          rewrite_status: "applied",
        },
        { coalesce: ["payload", "request_headers"] },
      );
    } catch (err) {
      noteDbErrorOn(state, err);
    }
  }

  function endFetch(ticket: Ticket, ok: boolean): void {
    ticket.inFlight = Math.max(0, ticket.inFlight - 1);
    ticket.lastFetchOk = ok;
    ticket.lastFetchEndAt = state.tickets.now();
    if (ok) {
      // 规则 ①：2xx/3xx 响应头 ⇒ 立即退役（已开始的流不会回退）；等 after_provider_response 消费。
      ticket.awaitingHookSince = ticket.lastFetchEndAt;
      state.tickets.retire(ticket, "success");
    }
  }

  async function sendObserved(
    ticket: Ticket,
    next: FetchLike,
    input: any,
    init: any,
  ): Promise<{ res: Response } | { error: unknown }> {
    try {
      const res = init === undefined ? await next(input) : await next(input, init);
      endFetch(ticket, res.status < 400);
      return { res };
    } catch (error) {
      endFetch(ticket, false);
      return { error };
    }
  }

  async function passthrough(ticket: Ticket, next: FetchLike, input: any, init: any): Promise<Response> {
    const out = await sendObserved(ticket, next, input, init);
    if ("error" in out) throw out.error;
    return out.res;
  }

  async function handleFetch(original: FetchLike, input: any, init: any, ticketId: string | null): Promise<Response> {
    // 入口固定纪元（engine 引用本身即闭包固定）。
    const epoch = state.epoch;
    const call = (i: any, n: any): Promise<Response> => (n === undefined ? original(i) : original(i, n));
    // 加密会话 / 无票据：纯透传，不认领、不改写、不录。
    if (isSecure() || ticketId === null) return call(input, init);
    const ticket = state.tickets.lookup(ticketId);
    if (!ticket || ticket.epoch !== epoch) {
      counters().staleTickets++;
      return call(input, init);
    }
    ticket.fetches++;
    ticket.inFlight++;
    const gen = ticket.generation;
    // 从未绑定（compaction 只有 headers / 绑定判据失败）：透传，不改写、不录线级字段。
    if (!gen) return passthrough(ticket, original, input, init);

    const url = typeof input === "string" ? input : String(input?.url ?? input);
    const method = String(init?.method ?? input?.method ?? "GET").toUpperCase();
    if (gen.baseUrl !== null && !urlMatchesBase(url, gen.baseUrl)) {
      counters().unattributedFetches++;
      return passthrough(ticket, original, input, init);
    }
    let digest: string | null;
    try {
      digest = await bodyDigest(input, init);
    } catch {
      digest = null;
    }
    // 摘要绑定 / 比对必须基于**当前** generation（await 期间可能升了 generation）。
    if (ticket.generation !== gen || digest === null) {
      counters().unattributedFetches++;
      return passthrough(ticket, original, input, init);
    }
    let first = false;
    if (gen.digest === null) {
      gen.digest = digest;
      first = true;
    } else if (gen.digest !== digest) {
      // 未被证明的新正文（例如因交错未能升 generation 的 strict 回退 payload）：原样透传、不改写、不写该票据行。
      counters().unattributedFetches++;
      return passthrough(ticket, original, input, init);
    }
    if (
      gen.rewrite === null &&
      gen.rules.length > 0 &&
      rewriteSuspended(ticket.runner, state.rewriteMarks, state.rulesSnapshot.rules.length, counters())
    ) {
      // 改写暂停（第三轮裁定 A）：绑定之后才观测到 warming 的票据同样不改写（本 generation 固定为「无改写」）。
      counters().rewriteSuspendedRequests++;
      gen.rewrite = Promise.resolve({ kind: "ok", result: null });
    }
    gen.rewrite ??= runRewrite(gen, url, method, input, init, epoch);
    const outcome = await gen.rewrite;
    if (outcome.kind === "blocked") {
      // 不放出原请求；同 generation / 同摘要的重试再抛同一错误（不重跑 jq、不重复通知）。
      endFetch(ticket, false);
      throw outcome.error;
    }
    const applied = outcome.result ? (first ? outcome.result : reuseResult(gen, outcome.result, input, init)) : null;
    const effective = applied ? rebuildRequest(input, init, applied) : { input, init };
    if (first && !gen.wireRecorded) {
      gen.wireRecorded = true;
      await recordWire(ticket, gen, url, method, applied, effective.init ?? init, effective.input, epoch);
    }
    // 安全评审 #8：「实际改写已发出」的标记放在出站边界，与是否录行（gen.row / childSessions）及落库成败解耦。
    if (applied && applied.ruleIds.length > 0) state.lastRewrittenAt.set(gen.sessionId, Date.now());
    const out = await sendObserved(ticket, original, effective.input, effective.init);
    if ("error" in out) throw out.error;
    const res = out.res;
    if (gen.row) {
      const row = gen.row;
      const status = res.status;
      const headersJson: Record<string, string> = {};
      res.headers.forEach((v, k) => {
        headersJson[k] = v;
      });
      recordPatch(
        state,
        epoch,
        row,
        "requests",
        { status, response_headers: JSON.stringify(headersJson) },
        {
          onDone: (rowId) => broadcast(state, { type: "response", id: rowId, session_id: gen.sessionId, status }),
        },
      );
      try {
        const contentType = (res.headers.get("content-type") ?? "").toLowerCase();
        if (
          res.body &&
          !gen.streamCaptured &&
          (contentType.includes("event-stream") ||
            contentType.includes("x-ndjson") ||
            contentType.includes("stream+json"))
        ) {
          gen.streamCaptured = true;
          void captureStream(row, gen.sessionId, res.clone(), epoch);
        }
      } catch {}
    }
    return res;
  }

  async function captureStream(
    requestId: number | RowRef,
    sessionId: string,
    res: Response,
    epoch: number = state.epoch,
    opts: CaptureStreamOptions = {},
  ): Promise<string> {
    const ref = typeof requestId === "number" ? newRowRef(requestId) : requestId;
    const end = (kind: "eof" | "aborted"): void => {
      try {
        opts.onEnd?.(kind);
      } catch {}
    };
    const markDone = (): void => {
      state.dbPort.sealChunks(epoch, ref, (rowId) => {
        if (rowId !== null) state.streamDone.add(rowId);
      });
    };
    if (isSecure() || state.state !== "open") {
      // 不读、不落库：同样不能留下存活的上游。
      void res.body?.cancel().catch(() => {});
      end("aborted");
      return "";
    }
    if (!res.body) {
      markDone();
      end("eof");
      return "";
    }
    const reader = res.body.getReader();
    // 取消只「触发」不等待：engine 关闭 / 重放中止 / 读流空闲超时 / 落库失败 ⇒ reader.cancel()。
    let cancelled = false;
    const cancelReader = (): void => {
      cancelled = true;
      void reader.cancel().catch(() => {});
    };
    const unregister = state.cancel.register(cancelReader);
    const onAbort = (): void => cancelReader();
    opts.signal?.addEventListener("abort", onAbort, { once: true });
    if (opts.signal?.aborted) cancelReader();
    const idle = opts.idleMs !== undefined ? idleTimer(opts.idleMs, cancelReader) : null;
    const decoder = new TextDecoder();
    const started = Date.now();
    const parts: string[] = [];
    let seq = 0;
    // 只有真正读到 EOF（且未被取消）才算自然结束；其它一切退出都必须先触发上游取消，再注销清理入口（安全评审 #3）。
    let eof = false;
    // chunk 批在 flush 时落库失败 ⇒ 取消读取（异步回调）。
    const onChunkFail = (): void => cancelReader();
    const insert = (text: string): boolean => {
      // 每批复查闸口（secure / engine 关闭 / 纪元；recordChunk 内经 persistAllowed）：失败 ⇒ 取消读取、停止旁路。
      const ok = recordChunk(
        state,
        epoch,
        ref,
        sessionId,
        { seq, ts: new Date().toISOString(), elapsedMs: Date.now() - started, data: text },
        onChunkFail,
      );
      if (!ok) {
        cancelReader();
        return false;
      }
      seq++;
      return true;
    };
    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) {
          eof = !cancelled;
          break;
        }
        if (cancelled) break;
        idle?.touch();
        const text = decoder.decode(value, { stream: true });
        if (!text) continue;
        parts.push(text);
        if (!insert(text)) break;
      }
      const tail = decoder.decode();
      if (eof && tail && state.state === "open") {
        parts.push(tail);
        insert(tail);
      }
      if (seq > 0) {
        const chunks = seq;
        state.dbPort.sealChunks(epoch, ref, (rowId) => {
          if (rowId !== null) broadcast(state, { type: "stream", request_id: rowId, session_id: sessionId, chunks });
        });
      }
    } catch {
      // 旁路失败不得影响主链路（对 provider 的 clone 分支：只取消本分支，不影响消费方读取原流）。
    } finally {
      idle?.clear();
      // 非 EOF 退出：先触发取消（不等待），再注销取消域条目。
      if (!eof && !cancelled) cancelReader();
      unregister();
      opts.signal?.removeEventListener("abort", onAbort);
      try {
        reader.releaseLock();
      } catch {}
      markDone();
      end(eof ? "eof" : "aborted");
    }
    return parts.join("");
  }

  return { handleFetch, captureStream, setRewriteBlockedHandler };
}
