/**
 * 线级抓取与请求改写拦截。
 * 改写发生在原生 fetch 之前；流式响应仍通过 clone 旁路保存。
 */
import { ensureDb } from "./db.js";
import {
  beginAttempt,
  blockAttempt,
  claimPending,
  failAttempt,
  settleAttempt,
  takeHookHeaders,
  urlMatchesBase,
} from "./correlate.js";
import {
  acquireSlot,
  armPoison,
  armRetryGrace,
  attachAttempt,
  currentSlot,
  drainGate,
  releaseSlot,
  type GateSlot,
  type ReleaseReason,
} from "./serialize.js";
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
} from "./rewrite.js";
import { RewriteError } from "./rewrite.js";
import { isSecureSession } from "./secure.js";
import { broadcast } from "./sse.js";
import { state, type Attempt } from "./state.js";

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

function noteDbError(err: unknown): void {
  const message = err instanceof Error ? err.message : String(err);
  if (!state.dbError) state.dbError = message;
  if (!state.dbErrorNotified) {
    state.dbErrorNotified = true;
    broadcast({ type: "record_warn", message: `数据库错误，改写持久化已禁用: ${message}` });
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

/**
 * 在 fetch 侧接管一个已有的 hook slot；若当前 holder 属于别的请求，
 * 则创建 orphan slot，保持改写路径仍然串行。
 */
async function attachOrAcquire(attempt: Attempt): Promise<GateSlot | null> {
  // 录制关闭 = 改写引擎停机。fetch 层现场复查（钩子放行后用户可能刚 /record off），
  // drain 掉可能残留的持有者，避免 slot 空持有到 handoff 看门狗超时并污染 gateNoFetch。
  if (!state.recording) {
    drainGate("drain");
    return null;
  }
  const holder = currentSlot();
  if (holder === null && (attempt.slot === null || attempt.slot === undefined)) return null;
  if (holder !== null && attempt.slot === holder && urlMatchesBase(attempt.url, holder.baseUrl)) {
    attachAttempt(holder);
    return holder;
  }

  let db;
  try {
    db = ensureDb();
    const rules = loadEnabledRules(db);
    if (rules.length === 0) {
      drainGate("drain");
      return null;
    }
    const settings = getEngineSettings(db);
    const slot = await acquireSlot(
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
    attachAttempt(slot);
    return slot;
  } catch (err) {
    // A storage failure must never turn the provider request into an extension error.
    noteDbError(err);
    return null;
  }
}

/** DB 失败时整体放行：存储故障不能阻断 provider 请求。 */
export async function tryRewrite(
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
        claimPending(attempt, body.text);
      }
    }
    return body;
  };
  try {
    const result = await applyRequest(slot.rules, slot.settings as EngineSettings, context, readBody, headers);
    if (result) {
      attempt.applied = result;
      attempt.rewriteRuleIds = result.ruleIds.slice();
      if (result.origBodyText !== null) attempt.origPayload = result.origBodyText;
    }
    return result;
  } catch (err) {
    if (err instanceof RewriteError) throw err;
    noteDbError(err);
    return null;
  }
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

function hookHeaders(attempt: Attempt): Record<string, string> {
  const cached = attempt.pending?.hookHeaders ?? takeHookHeaders();
  if (!cached) return {};
  try {
    return headersToJson(JSON.parse(cached));
  } catch {
    return {};
  }
}

/** 发送前写入最终线级值；失败只告警，不影响真实发送。 */
export async function recordPreSend(
  attempt: Attempt,
  applied: ApplyResult | null,
  input?: unknown,
  init?: unknown,
): Promise<void> {
  if (attempt.rowId === null) {
    if (applied && attempt.pending !== null) state.unlinkedRewrites++;
    return;
  }
  try {
    const d = ensureDb();
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
      noteDbError(err);
    }
    const payloadBytes = applied?.bodyBytes ?? bodyByteLength(input, init);
    if (applied && attempt.degraded) state.unlinkedRewrites++;
    if (!applied || applied.ruleIds.length === 0) {
      d.prepare(
        "UPDATE requests SET url = ?, method = ?, request_headers = COALESCE(?, request_headers), payload_encoding = ?, payload_bytes = ? WHERE id = ?",
      ).run(attempt.url, attempt.method, headerText, encoding, payloadBytes, attempt.rowId);
      return;
    }
    const finalPayload = await bodyTextOf(applied);
    const originalPayload = applied.origBodyText ?? attempt.origPayload ?? null;
    d.prepare(
      `UPDATE requests SET url = ?, method = ?,
			 payload = COALESCE(?, payload), request_headers = COALESCE(?, request_headers),
			 payload_encoding = ?, payload_bytes = ?,
			 orig_payload = ?, orig_request_headers = ?, rewrite_rule_ids = ?, rewrite_status = 'applied'
			 WHERE id = ?`,
    ).run(
      attempt.url,
      attempt.method,
      applied.bodyChanged ? finalPayload : null,
      headerText,
      encoding,
      payloadBytes,
      originalPayload,
      JSON.stringify(applied.origHeaders),
      JSON.stringify(applied.ruleIds),
      attempt.rowId,
    );
  } catch (err) {
    noteDbError(err);
  }
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

/**
 * 阻断通知回调（由 index.ts 注册，形状对齐 setGateReleaseHandler）。
 * capture 层拿不到 ctx.ui.notify，只能回调出去。
 */
let blockedHandler: ((message: string) => void) | null = null;

export function setRewriteBlockedHandler(handler: ((message: string) => void) | null): void {
  blockedHandler = handler;
}

/** 阻断请求的五步事务：写行、封存 attempt、移出 pool、双 SSE、poison。 */
export function onRewriteBlocked(attempt: Attempt, slot: GateSlot | null, err: unknown): Error {
  const safe = blockedSafeEvent(err);
  const ruleName = safe.rule_name ?? "未知规则";
  const ruleId = safe.rule_id === null ? "?" : String(safe.rule_id);
  const message = `traffic-record rewrite blocked: [规则 "${ruleName}" #${ruleId}] ${safe.phase} ${safe.kind}`;
  if (attempt.rowId !== null) {
    try {
      const d = ensureDb();
      const origHeaders = attempt.origHeaders ?? {};
      const ruleIds =
        attempt.rewriteRuleIds.length > 0 ? attempt.rewriteRuleIds : safe.rule_id === null ? [] : [safe.rule_id];
      d.prepare(
        `UPDATE requests SET status = 0, rewrite_status = 'blocked', rewrite_error = ?,
				 orig_payload = ?, orig_request_headers = ?, rewrite_rule_ids = ?, url = ?, method = ?
				 WHERE id = ?`,
      ).run(
        JSON.stringify(safe),
        attempt.origPayload ?? null,
        JSON.stringify(origHeaders),
        JSON.stringify(ruleIds),
        attempt.url,
        attempt.method,
        attempt.rowId,
      );
    } catch (dbErr) {
      noteDbError(dbErr);
    }
  }
  blockAttempt(attempt);
  const blockedError = err instanceof RewriteError ? err : new Error(message);
  blockedError.message = message;
  broadcast({
    type: "rewrite_error",
    id: attempt.rowId,
    session_id: attempt.pending?.sessionId ?? null,
    ...safe,
    message,
  });
  broadcast({ type: "response", id: attempt.rowId, session_id: attempt.pending?.sessionId ?? null, status: 0 });
  // 弹到 pi 界面，否则 SDK 只会显示笼统的 "Connection error."。
  // 安全边界：只用 toSafeEvent 的结构化字段，绝不带 detail（含 jq stderr）。
  // 去重靠 poison 窗口：重试在 patchFetch 的 slot.blocked 处提前抛出，不会重入本函数。
  blockedHandler?.(
    `改写阻断：规则「${ruleName}」#${ruleId} ${safe.phase} 阶段 ${safe.kind}\n请求已中断。详情见 Web 页「改写」子页。`,
  );
  if (slot !== null) armPoison(slot, blockedError);
  return blockedError;
}

async function captureStream(requestId: number, sessionId: string, res: Response): Promise<string> {
  if (isSecureSession()) return "";
  if (!res.body) {
    state.streamDone.add(requestId);
    return "";
  }
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  const started = Date.now();
  const parts: string[] = [];
  let seq = 0;
  try {
    const d = ensureDb();
    const stmt = d.prepare(
      "INSERT INTO stream_chunks (request_id, session_id, seq, ts, elapsed_ms, data) VALUES (?, ?, ?, ?, ?, ?)",
    );
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      const text = decoder.decode(value, { stream: true });
      if (!text) continue;
      parts.push(text);
      stmt.run(requestId, sessionId, seq, new Date().toISOString(), Date.now() - started, text);
      seq++;
    }
    const tail = decoder.decode();
    if (tail) {
      parts.push(tail);
      stmt.run(requestId, sessionId, seq, new Date().toISOString(), Date.now() - started, tail);
      seq++;
    }
    if (seq > 0) broadcast({ type: "stream", request_id: requestId, session_id: sessionId, chunks: seq });
  } catch {
    // 旁路失败不得影响主链路。
  } finally {
    try {
      reader.releaseLock();
    } catch {}
    state.streamDone.add(requestId);
  }
  return parts.join("");
}

/** 供 server.ts 重放复用：后台消费响应体。 */
export { captureStream };

export function patchFetch(): void {
  if (state.originalFetch) return;
  const orig = globalThis.fetch;
  if (typeof orig !== "function") return;
  state.originalFetch = orig;
  globalThis.fetch = (async (input: any, init?: any) => {
    const original = state.originalFetch ?? orig;
    const url = typeof input === "string" ? input : (input?.url ?? String(input));
    const method = String(init?.method ?? input?.method ?? "GET").toUpperCase();
    // 加密会话：完全透传，不建 attempt、不改写、不记录、不旁路读流。
    if (isSecureSession()) return original(input, init);
    const attempt = beginAttempt(String(url), method);
    if (!attempt) return original(input, init);
    const cheapBody = typeof init?.body === "string" ? init.body : null;
    attempt.origPayload = cheapBody;
    const slot = await attachOrAcquire(attempt);
    let released = false;
    const release = (reason: ReleaseReason): void => {
      if (slot && !released) {
        released = true;
        releaseSlot(slot, reason);
      }
    };
    try {
      claimPending(attempt, cheapBody);
      if (slot?.blocked) throw slot.blocked.error;

      let applied: ApplyResult | null = null;
      try {
        applied = await tryRewrite(attempt, slot, input, init);
      } catch (err) {
        throw onRewriteBlocked(attempt, slot, err);
      }
      const effective = applied ? rebuildRequest(input, init, applied) : { input, init };
      await recordPreSend(attempt, applied, effective.input, effective.init ?? init);

      let res: Response;
      try {
        res = await original(effective.input, effective.init);
      } catch (err) {
        failAttempt(attempt, err);
        if (isAbortError(err)) release("aborted");
        else if (slot) armRetryGrace(slot);
        throw err;
      }
      settleAttempt(attempt, res);
      if (slot && isRetryableStatus(res.status)) armRetryGrace(slot);
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
        void captureStream(pending.rowId, pending.sessionId, res.clone());
      } catch {}
      return res;
    } finally {
      // poison / retry-grace 各自持有定时器；其它未覆盖异常由 finally 释放。
      if (slot && !released && !slot.blocked && !slot.retryGraceArmed) release("failed");
    }
  }) as typeof globalThis.fetch;
}

export function unpatchFetch(): void {
  if (!state.originalFetch) return;
  try {
    globalThis.fetch = state.originalFetch;
  } catch {}
  state.originalFetch = null;
}
