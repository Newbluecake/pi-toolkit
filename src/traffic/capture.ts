/**
 * 线级抓取与请求改写拦截。
 * 改写发生在下游 fetch 之前；流式响应仍通过 clone 旁路保存。
 *
 * T2a：不再自行 patch `globalThis.fetch`——由 tap.ts 的 trampoline 在活动 wrapper 内调用
 * `capture.handleFetch(next, …)`（`next` 为安装时捕获的固定下游）。全部状态归 engine，入口固定 engine
 * 与纪元，所有写经 persist 闸口；流捕获登记进 engine 取消域，每批复查闸口。
 */
import { ensureDb } from "./db.js";
import { urlMatchesBase } from "./correlate.js";
import type { GateSlot, ReleaseReason } from "./serialize.js";
import { idleTimer } from "./cancel.js";
import type { TrafficEngine } from "./engine.js";
import { persist, persistAllowed } from "./persist.js";
import {
  applyRequest,
  decodeBody,
  encodingOf,
  extractBody,
  getEngineSettings,
  headersToJson,
  loadEnabledRules,
  sanitizeSendHeaders,
  type ApplyResult,
  type BodyInput,
  type EngineSettings,
  type RewriteEnv,
} from "./rewrite.js";
import { RewriteError } from "./rewrite.js";
import { isSecure } from "./secure.js";
import { broadcast } from "./sse.js";
import type { Attempt } from "./state.js";

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

function noteDbErrorOn(state: TrafficEngine, err: unknown): void {
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

function bodyByteLength(input: unknown, init: unknown): number | null {
  const initBody = typeof init === "object" && init !== null ? (init as { body?: unknown }).body : undefined;
  if (typeof initBody === "string") return Buffer.byteLength(initBody, "utf8");
  if (isBinaryBody(initBody)) return initBody.byteLength;
  if (
    typeof initBody === "undefined" &&
    typeof Request !== "undefined" &&
    input instanceof Request &&
    input.body === null
  )
    return null;
  return null;
}

async function bodyTextOf(result: ApplyResult): Promise<string | null> {
  if (!result.bodyChanged || result.body === null) return null;
  if (typeof result.body === "string") return result.body;
  const bytes = result.body instanceof Uint8Array ? result.body : new Uint8Array(result.body);
  return decodeBody(bytes, result.encoding);
}

function isAbortError(err: unknown): boolean {
  return typeof err === "object" && err !== null && "name" in err && (err as { name?: unknown }).name === "AbortError";
}

function isRetryableStatus(status: number): boolean {
  return status === 408 || status === 409 || status === 425 || status === 429 || status >= 500;
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
  tryRewrite(attempt: Attempt, slot: GateSlot | null, input: unknown, init: unknown): Promise<ApplyResult | null>;
  recordPreSend(
    attempt: Attempt,
    applied: ApplyResult | null,
    input?: unknown,
    init?: unknown,
    epoch?: number,
  ): Promise<void>;
  onRewriteBlocked(attempt: Attempt, slot: GateSlot | null, err: unknown, epoch?: number): Error;
  /** 后台消费响应体并逐批入库；登记进取消域，每批复查 persist 闸口。 */
  captureStream(
    requestId: number,
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

export function createCapture(state: TrafficEngine): Capture {
  const gate = state.gate;
  const corr = state.corr;
  let blockedHandler: ((message: string) => void) | null = null;
  const rewriteEnv = (): RewriteEnv => ({ jq: state.jq, warn: (event) => broadcast(state, event) });

  /**
   * 在 fetch 侧接管一个已有的 hook slot；若当前 holder 属于别的请求，
   * 则创建 orphan slot，保持改写路径仍然串行。
   */
  async function attachOrAcquire(attempt: Attempt): Promise<GateSlot | null> {
    // 录制关闭 = 改写引擎停机。fetch 层现场复查（钩子放行后用户可能刚 /record off），
    // drain 掉可能残留的持有者，避免 slot 空持有到 handoff 看门狗超时并污染 gateNoFetch。
    if (!state.recording) {
      gate.drainGate("drain");
      return null;
    }
    const holder = gate.currentSlot();
    if (holder === null && (attempt.slot === null || attempt.slot === undefined)) return null;
    if (holder !== null && attempt.slot === holder && urlMatchesBase(attempt.url, holder.baseUrl)) {
      gate.attachAttempt(holder);
      return holder;
    }

    let db;
    try {
      db = ensureDb(state);
      const rules = loadEnabledRules(db);
      if (rules.length === 0) {
        gate.drainGate("drain");
        return null;
      }
      const settings = getEngineSettings(db);
      const slot = await gate.acquireSlot(
        {
          sessionId: attempt.pending?.sessionId ?? state.currentSessionId ?? "",
          baseUrl: attempt.url,
          model: attempt.pending?.model ?? null,
          modelApi: null,
          rules,
          settings,
        },
        "orphan",
      );
      slot.degraded = true;
      attempt.degraded = true;
      gate.attachAttempt(slot);
      return slot;
    } catch (err) {
      // A storage failure must never turn the provider request into an extension error.
      noteDbErrorOn(state, err);
      return null;
    }
  }

  /** DB 失败时整体放行：存储故障不能阻断 provider 请求。 */
  async function tryRewrite(
    attempt: Attempt,
    slot: GateSlot | null,
    input: unknown,
    init: unknown,
  ): Promise<ApplyResult | null> {
    // B2-严格：drainGate 放行的 degraded slot 仍带着非空 rules 快照，
    // 故此处必须复查 recording —— 这是「/record off 立刻停止在途改写」的唯一可靠拦截点。
    if (!state.recording || slot === null || slot.rules.length === 0) return null;
    const headers = requestHeaders(input, init);
    const originalHeaders = headersToJson(headers);
    attempt.origHeaders = originalHeaders;
    const context = {
      url: attempt.url,
      method: attempt.method,
      model: attempt.pending?.model ?? slot.model,
    };
    let claimTried = typeof init === "object" && init !== null && typeof (init as { body?: unknown }).body === "string";
    const readBody = async (): Promise<BodyInput> => {
      const body = await extractBody(input, init, originalHeaders);
      if (body.kind === "json") {
        attempt.origPayload = body.text;
        if (!claimTried) {
          claimTried = true;
          corr.claimPending(attempt, body.text);
        }
      }
      return body;
    };
    try {
      const result = await applyRequest(
        slot.rules,
        slot.settings as EngineSettings,
        context,
        readBody,
        headers,
        rewriteEnv(),
      );
      if (result) {
        attempt.applied = result;
        attempt.rewriteRuleIds = result.ruleIds.slice();
        if (result.origBodyText !== null) attempt.origPayload = result.origBodyText;
      }
      return result;
    } catch (err) {
      if (err instanceof RewriteError) throw err;
      noteDbErrorOn(state, err);
      return null;
    }
  }

  function hookHeaders(attempt: Attempt): Record<string, string> {
    const cached = attempt.pending?.hookHeaders ?? corr.takeHookHeaders();
    if (!cached) return {};
    try {
      return headersToJson(JSON.parse(cached));
    } catch {
      return {};
    }
  }

  /** 发送前写入最终线级值；失败只告警，不影响真实发送。所有写经 persist 闸口（await 之后重新取连接）。 */
  async function recordPreSend(
    attempt: Attempt,
    applied: ApplyResult | null,
    input?: unknown,
    init?: unknown,
    epoch: number = state.epoch,
  ): Promise<void> {
    if (attempt.rowId === null) {
      if (applied && attempt.pending !== null) state.unlinkedRewrites++;
      return;
    }
    const rowId = attempt.rowId;
    try {
      let sendHeaders: Record<string, string>;
      if (applied) {
        sendHeaders = applied.headers;
      } else {
        const rawHeaders = headersToJson(requestHeaders(input, init));
        if (Object.keys(rawHeaders).length > 0) {
          try {
            sendHeaders = sanitizeSendHeaders(rawHeaders);
          } catch {
            sendHeaders = rawHeaders;
          }
        } else {
          sendHeaders = sanitizeSendHeaders(hookHeaders(attempt));
        }
      }
      const headerText = Object.keys(sendHeaders).length > 0 ? JSON.stringify(sendHeaders) : null;
      let encoding: "identity" | "zstd" | "gzip" | "deflate" | "br" = "identity";
      try {
        encoding = encodingOf(sendHeaders);
      } catch (err) {
        noteDbErrorOn(state, err);
      }
      const payloadBytes = applied?.bodyBytes ?? bodyByteLength(input, init);
      if (applied && attempt.degraded) state.unlinkedRewrites++;
      if (!applied || applied.ruleIds.length === 0) {
        persist(state, epoch, (d) =>
          d
            .prepare(
              "UPDATE requests SET url = ?, method = ?, request_headers = COALESCE(?, request_headers), payload_encoding = ?, payload_bytes = ? WHERE id = ?",
            )
            .run(attempt.url, attempt.method, headerText, encoding, payloadBytes, rowId),
        );
        return;
      }
      const finalPayload = await bodyTextOf(applied);
      const originalPayload = applied.origBodyText ?? attempt.origPayload ?? null;
      persist(state, epoch, (d) =>
        d
          .prepare(
            `UPDATE requests SET url = ?, method = ?,
			 payload = COALESCE(?, payload), request_headers = COALESCE(?, request_headers),
			 payload_encoding = ?, payload_bytes = ?,
			 orig_payload = ?, orig_request_headers = ?, rewrite_rule_ids = ?, rewrite_status = 'applied'
			 WHERE id = ?`,
          )
          .run(
            attempt.url,
            attempt.method,
            applied.bodyChanged ? finalPayload : null,
            headerText,
            encoding,
            payloadBytes,
            originalPayload,
            JSON.stringify(applied.origHeaders),
            JSON.stringify(applied.ruleIds),
            rowId,
          ),
      );
    } catch (err) {
      noteDbErrorOn(state, err);
    }
  }

  /**
   * 阻断通知回调（由 index.ts 注册，形状对齐 setGateReleaseHandler）。
   * capture 层拿不到 ctx.ui.notify，只能回调出去。
   */
  function setRewriteBlockedHandler(handler: ((message: string) => void) | null): void {
    blockedHandler = handler;
  }

  /** 阻断请求的五步事务：写行、封存 attempt、移出 pool、双 SSE、poison。 */
  function onRewriteBlocked(attempt: Attempt, slot: GateSlot | null, err: unknown, epoch: number = state.epoch): Error {
    const safe = blockedSafeEvent(err);
    const ruleName = safe.rule_name ?? "未知规则";
    const ruleId = safe.rule_id === null ? "?" : String(safe.rule_id);
    const message = `traffic-record rewrite blocked: [规则 "${ruleName}" #${ruleId}] ${safe.phase} ${safe.kind}`;
    if (attempt.rowId !== null) {
      const rowId = attempt.rowId;
      try {
        const origHeaders = attempt.origHeaders ?? {};
        const ruleIds =
          attempt.rewriteRuleIds.length > 0 ? attempt.rewriteRuleIds : safe.rule_id === null ? [] : [safe.rule_id];
        persist(state, epoch, (d) =>
          d
            .prepare(
              `UPDATE requests SET status = 0, rewrite_status = 'blocked', rewrite_error = ?,
  				 orig_payload = ?, orig_request_headers = ?, rewrite_rule_ids = ?, url = ?, method = ?
  				 WHERE id = ?`,
            )
            .run(
              JSON.stringify(safe),
              attempt.origPayload ?? null,
              JSON.stringify(origHeaders),
              JSON.stringify(ruleIds),
              attempt.url,
              attempt.method,
              rowId,
            ),
        );
      } catch (dbErr) {
        noteDbErrorOn(state, dbErr);
      }
    }
    corr.blockAttempt(attempt);
    const blockedError = err instanceof RewriteError ? err : new Error(message);
    blockedError.message = message;
    broadcast(state, {
      type: "rewrite_error",
      id: attempt.rowId,
      session_id: attempt.pending?.sessionId ?? null,
      ...safe,
      message,
    });
    broadcast(state, {
      type: "response",
      id: attempt.rowId,
      session_id: attempt.pending?.sessionId ?? null,
      status: 0,
    });
    // 弹到 pi 界面，否则 SDK 只会显示笼统的 "Connection error."。
    // 安全边界：只用 toSafeEvent 的结构化字段，绝不带 detail（含 jq stderr）。
    // 去重靠 poison 窗口：重试在 patchFetch 的 slot.blocked 处提前抛出，不会重入本函数。
    blockedHandler?.(
      `改写阻断：规则「${ruleName}」#${ruleId} ${safe.phase} 阶段 ${safe.kind}\n请求已中断。详情见 Web 页「改写」子页。`,
    );
    if (slot !== null) gate.armPoison(slot, blockedError);
    return blockedError;
  }

  async function captureStream(
    requestId: number,
    sessionId: string,
    res: Response,
    epoch: number = state.epoch,
    opts: CaptureStreamOptions = {},
  ): Promise<string> {
    const end = (kind: "eof" | "aborted"): void => {
      try {
        opts.onEnd?.(kind);
      } catch {}
    };
    if (isSecure() || state.state !== "open") {
      // 不读、不落库：同样不能留下存活的上游。
      void res.body?.cancel().catch(() => {});
      end("aborted");
      return "";
    }
    if (!res.body) {
      state.streamDone.add(requestId);
      end("eof");
      return "";
    }
    const reader = res.body.getReader();
    // 取消只「触发」不等待：engine 关闭 / 重放中止 / 读流空闲超时 ⇒ reader.cancel()。
    const cancelReader = (): void => {
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
    // 只有真正读到 EOF 才算自然结束；其它一切退出（落库抛错 / 闸口拒绝 / 取消 / 读错）都必须先触发上游取消，
    // 再注销清理入口——否则仍存活的上游会失去全部清理入口（安全评审 #3）。
    let eof = false;
    const insert = (text: string): boolean => {
      // 每批复查闸口（secure / engine 关闭 / 纪元）：失败 ⇒ 取消读取、停止旁路。
      if (!persistAllowed(state, epoch)) {
        cancelReader();
        return false;
      }
      ensureDb(state)
        .prepare(
          "INSERT INTO stream_chunks (request_id, session_id, seq, ts, elapsed_ms, data) VALUES (?, ?, ?, ?, ?, ?)",
        )
        .run(requestId, sessionId, seq, new Date().toISOString(), Date.now() - started, text);
      seq++;
      return true;
    };
    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) {
          eof = true;
          break;
        }
        idle?.touch();
        const text = decoder.decode(value, { stream: true });
        if (!text) continue;
        parts.push(text);
        if (!insert(text)) break;
      }
      const tail = decoder.decode();
      if (tail && state.state === "open") {
        parts.push(tail);
        insert(tail);
      }
      if (seq > 0) broadcast(state, { type: "stream", request_id: requestId, session_id: sessionId, chunks: seq });
    } catch {
      // 旁路失败不得影响主链路（对 provider 的 clone 分支：只取消本分支，不影响消费方读取原流）。
    } finally {
      idle?.clear();
      // 非 EOF 退出：先触发取消（不等待），再注销取消域条目。
      if (!eof) cancelReader();
      unregister();
      opts.signal?.removeEventListener("abort", onAbort);
      try {
        reader.releaseLock();
      } catch {}
      state.streamDone.add(requestId);
      end(eof ? "eof" : "aborted");
    }
    return parts.join("");
  }

  async function handleFetch(original: FetchLike, input: any, init: any, _ticket: string | null): Promise<Response> {
    {
      // 入口固定纪元（engine 引用本身即闭包固定）；之后所有写经 persist(state, epoch, …)。
      const epoch = state.epoch;
      const url = typeof input === "string" ? input : (input?.url ?? String(input));
      const method = String(init?.method ?? input?.method ?? "GET").toUpperCase();
      // 加密会话：完全透传，不建 attempt、不改写、不记录、不旁路读流。
      if (isSecure()) return original(input, init);
      const attempt = corr.beginAttempt(String(url), method);
      if (!attempt) return original(input, init);
      const cheapBody = typeof init?.body === "string" ? init.body : null;
      attempt.origPayload = cheapBody;
      const slot = await attachOrAcquire(attempt);
      let released = false;
      const release = (reason: ReleaseReason): void => {
        if (slot && !released) {
          released = true;
          gate.releaseSlot(slot, reason);
        }
      };
      try {
        corr.claimPending(attempt, cheapBody);
        if (slot?.blocked) throw slot.blocked.error;

        let applied: ApplyResult | null = null;
        try {
          applied = await tryRewrite(attempt, slot, input, init);
        } catch (err) {
          throw onRewriteBlocked(attempt, slot, err, epoch);
        }
        const effective = applied ? rebuildRequest(input, init, applied) : { input, init };
        await recordPreSend(attempt, applied, effective.input, effective.init ?? init, epoch);

        let res: Response;
        try {
          res = await original(effective.input, effective.init);
        } catch (err) {
          corr.failAttempt(attempt, err);
          if (isAbortError(err)) release("aborted");
          else if (slot) gate.armRetryGrace(slot);
          throw err;
        }
        corr.settleAttempt(attempt, res);
        if (slot && isRetryableStatus(res.status)) gate.armRetryGrace(slot);
        else release("settled");

        try {
          const pending = attempt.pending;
          if (!pending || pending.rowId === null || !res.body || pending.streamCaptured) return res;
          const contentType = (res.headers.get("content-type") ?? "").toLowerCase();
          if (
            !contentType.includes("event-stream") &&
            !contentType.includes("x-ndjson") &&
            !contentType.includes("stream+json")
          )
            return res;
          pending.streamCaptured = true;
          void captureStream(pending.rowId, pending.sessionId, res.clone(), epoch);
        } catch {}
        return res;
      } finally {
        // poison / retry-grace 各自持有定时器；其它未覆盖异常由 finally 释放。
        if (slot && !released && !slot.blocked && !slot.retryGraceArmed) release("failed");
      }
    }
  }

  return { handleFetch, tryRewrite, recordPreSend, onRewriteBlocked, captureStream, setRewriteBlockedHandler };
}
