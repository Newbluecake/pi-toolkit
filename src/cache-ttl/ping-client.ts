/**
 * Keepalive ping client for prompt-cache TTL (cache-ttl keepalive).
 *
 * pi-free: this module must never import from `@earendil-works/pi-*` (or any pi
 * package) — it only depends on globalThis `fetch`/`AbortController`/streams.
 * See docs/dev/cache-ttl-keepalive/plan.md §7 for the full design and rationale.
 *
 * Ownership: this module owns and exports `PingRequest` and `PingOutcome` (the
 * proven/unproven verdict). It must NOT define window/epoch/evaluateTick types —
 * those belong to the sibling pure module `src/cache-ttl/keepalive-state.ts`
 * (owned by a parallel workstream). Do not import that file from here.
 */

type RecordValue = Record<string, unknown>;

function isObjectRecord(value: unknown): value is RecordValue {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

/**
 * Fallback auth material used ONLY to fill header keys that are missing from
 * a verbatim-captured header set (root-cause fix, see `buildPingRequest`
 * below) — never used to override a key that was actually captured.
 */
export interface PingAuthFallback {
  apiKey?: string | undefined;
  headers?: Record<string, string> | undefined;
}

/** A fully-constructed bare HTTP request ready to POST, produced by `buildPingRequest`. */
export interface PingRequest {
  url: string;
  headers: Record<string, string>;
  body: Record<string, unknown>;
}

/**
 * Where the final ping headers came from, for the audit trail (plan.md
 * root-cause fix): `"captured"` = every header was replayed verbatim from
 * the real request's `before_provider_headers` snapshot; `"captured+auth-
 * filled"` = one or more keys were missing from the capture (pi may inject
 * auth downstream of that hook) and were backfilled from
 * `getApiKeyAndHeaders`.
 */
export type PingHeaderSource = "captured" | "captured+auth-filled";

export interface BuildPingRequestResult {
  request: PingRequest;
  headerSource: PingHeaderSource;
  /** Key names only (never values — they may carry secrets) that were absent from the capture and filled from auth fallback. */
  filledAuthKeys: string[];
}

/**
 * Result of a single keepalive ping attempt.
 *
 * Ownership note (I-K7): only `proven-hit` (`cache_read > 0 && cache_creation === 0`)
 * counts as a verified success. Every other variant — including `proven-write` (a
 * confirmed cache WRITE, the expensive failure mode), `no-usage`, `accepted-then-lost`,
 * `http`, `network`, and `malformed` — must be treated as "unproven" by callers and
 * must never be mistaken for success. This module only classifies; the session-level
 * breaker bookkeeping (consecutiveUnproven / unprovenTotal / windowEpoch, etc.) lives
 * in the sibling state module and stack service, not here.
 */
export type PingOutcome =
  | { kind: "proven-hit"; cacheReadTokens: number; inputTokens: number }
  | { kind: "proven-write"; cacheWriteTokens: number } // cache_creation_input_tokens > 0
  | { kind: "no-usage" } // 200 but usage missing, or cache_read === cache_creation === 0
  | { kind: "accepted-then-lost" } // got a 200 response but stream ended/errored/timed out before message_start
  | { kind: "http"; status: number } // any non-2xx HTTP status
  | { kind: "network" } // fetch itself failed / aborted before receiving a response
  | { kind: "malformed" }; // no body, or scanned 64KB without seeing message_start

const PING_SCAN_LIMIT_BYTES = 64 * 1024;
const HTTP_ERROR_BODY_CAP_BYTES = 2048;
const DEFAULT_PING_TIMEOUT_MS = 20_000;

const OAUTH_TOKEN_MARKER = "sk-ant-oat";

/**
 * Redact obvious secrets (bearer tokens, api-key query params, and any literal
 * secret values passed in) from an error/log message before it can surface anywhere.
 * Mirrors the approach in `src/web-search/resilience.ts` (kept local to stay pi-free
 * and avoid a cross-feature import).
 */
export function redactSecrets(message: string, secrets: readonly (string | undefined)[]): string {
  let redacted = message
    .replace(/([?&](?:api_key|apikey|key)=)[^&\s]+/gi, "$1[REDACTED]")
    .replace(/(authorization:\s*bearer\s+)[^\s]+/gi, "$1[REDACTED]");
  for (const secret of secrets) {
    if (secret) redacted = redacted.split(secret).join("[REDACTED]");
  }
  return redacted;
}

/**
 * Prepare the ping payload from a verbatim-captured provider request body.
 *
 * §7.2 / I-K1: the only permitted mutation is forcing `max_tokens: 1` when
 * thinking is NOT active (Anthropic requires `max_tokens > thinking.budget_tokens`
 * for thinking requests, and dropping/altering `thinking` itself would invalidate
 * the messages cache block — the single most expensive way to get this feature
 * wrong). Every other field — including `stream` — must be replayed byte-for-byte.
 *
 * This function deliberately does NOT force `stream: true`: doing so would be an
 * un-provable payload mutation (I-K1 requires "identical except max_tokens"). The
 * caller (`evaluateTick`'s `not-streaming` gate) is responsible for refusing to
 * ping any capture whose `payload.stream !== true` in the first place — replaying
 * such a payload verbatim would give a non-streaming response we can't early-abort,
 * and rewriting it here would break the invariant we're trying to protect.
 */
export function preparePingPayload(captured: Record<string, unknown>): Record<string, unknown> {
  const body: Record<string, unknown> = { ...captured };
  const thinking = captured.thinking;
  const thinkingActive = isObjectRecord(thinking) && thinking.type !== "disabled";
  if (!thinkingActive) body.max_tokens = 1; // the only allowed change
  return body;
}

function stripTrailingSlash(url: string): string {
  return url.endsWith("/") ? url.slice(0, -1) : url;
}

function isOAuthApiKey(apiKey: string | undefined): boolean {
  return typeof apiKey === "string" && apiKey.includes(OAUTH_TOKEN_MARKER);
}

/**
 * Fallback headers built from resolved auth — used exclusively to fill in
 * keys missing from a verbatim header capture (e.g. pi injects the real
 * bearer token further downstream than `before_provider_headers`). This is
 * intentionally the ONLY header-construction logic left in this module: no
 * static `anthropic-beta`, no model-catalog header layering — those are
 * whatever the real request's headers already were, replayed as-is.
 */
function authFallbackHeaders(auth: PingAuthFallback): Record<string, string> {
  const headers: Record<string, string> = {};
  if (isOAuthApiKey(auth.apiKey)) {
    headers.authorization = `Bearer ${auth.apiKey}`;
  } else if (auth.apiKey) {
    headers["x-api-key"] = auth.apiKey;
  }
  if (auth.headers) {
    for (const [key, value] of Object.entries(auth.headers)) headers[key] = value;
  }
  return headers;
}

/**
 * Build the bare POST request (url + headers + body) for a keepalive ping.
 *
 * Root-cause fix (real-environment first-ping failure, proven-write on
 * replay): this used to hand-assemble headers in layers — baseline, then an
 * OAuth/api-key branch, then `model.headers`, then `auth.headers` — with a
 * hardcoded `anthropic-beta: claude-code-20250219,oauth-2025-04-20` and a
 * comment claiming "betas don't affect the cache key". That assumption does
 * NOT hold behind a gateway/router (observed: `cloudrouter-anthropic`) where
 * header differences can select a different route or cache namespace than
 * the real request used, so the replay stopped being byte-for-byte and
 * produced a cache WRITE instead of a hit on the very first real ping.
 *
 * The fix: headers are replayed VERBATIM from `capturedHeaders` (the real
 * request's `before_provider_headers` snapshot — see `cache-ttl.ts`). The
 * only permitted addition is filling in header KEYS that are entirely
 * missing from the capture (pi may resolve/attach auth further downstream
 * of that hook than where we snapshot) using `authFallback` — and even then,
 * an already-captured key is never overwritten. No betas, no model/auth
 * header layering, no invented values.
 */
export function buildPingRequest(
  body: Record<string, unknown>,
  baseUrl: string,
  capturedHeaders: Record<string, string>,
  authFallback: PingAuthFallback = {},
): BuildPingRequestResult {
  const url = `${stripTrailingSlash(baseUrl)}/v1/messages`;
  const headers: Record<string, string> = { ...capturedHeaders };
  // If the capture already carries EITHER auth-identity scheme, the real
  // request evidently authenticated some way — never bolt on the OTHER
  // scheme too (e.g. adding a guessed `x-api-key` alongside a captured
  // `authorization` header) just because the fallback happens to construct
  // it. Only a header genuinely absent from both schemes gets filled.
  const hasAuthIdentity = "authorization" in headers || "x-api-key" in headers;
  const fallback = authFallbackHeaders(authFallback);
  const filledAuthKeys: string[] = [];
  for (const [key, value] of Object.entries(fallback)) {
    if (hasAuthIdentity && (key === "authorization" || key === "x-api-key")) continue;
    if (!(key in headers)) {
      headers[key] = value;
      filledAuthKeys.push(key);
    }
  }
  filledAuthKeys.sort();
  const headerSource: PingHeaderSource = filledAuthKeys.length > 0 ? "captured+auth-filled" : "captured";
  return { request: { url, headers, body }, headerSource, filledAuthKeys };
}

/** Read up to `limit` bytes of a response body as text; never throws. */
async function readCapped(res: Response, limit: number): Promise<string> {
  try {
    const reader = res.body?.getReader();
    if (!reader) {
      // Fall back to text() if no streaming reader is available (e.g. test doubles).
      const text = await res.text().catch(() => "");
      return text.slice(0, limit);
    }
    const decoder = new TextDecoder();
    let result = "";
    let total = 0;
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      result += decoder.decode(value, { stream: true });
      if (total >= limit) {
        try {
          await reader.cancel();
        } catch {
          // ignore
        }
        break;
      }
    }
    return result.slice(0, limit);
  } catch {
    return "";
  }
}

interface AnthropicUsage {
  input_tokens?: number;
  output_tokens?: number;
  cache_read_input_tokens?: number;
  cache_creation_input_tokens?: number;
}

interface AnthropicMessageStartEvent {
  type: "message_start";
  message?: { usage?: AnthropicUsage };
}

function isMessageStartEvent(value: unknown): value is AnthropicMessageStartEvent {
  return isObjectRecord(value) && value.type === "message_start";
}

/** Classify a `message_start` event's usage into the proven/unproven verdict. */
function classifyUsage(event: AnthropicMessageStartEvent): PingOutcome {
  const usage = event.message?.usage;
  if (!usage) return { kind: "no-usage" };
  const cacheRead = usage.cache_read_input_tokens ?? 0;
  const cacheCreation = usage.cache_creation_input_tokens ?? 0;
  const inputTokens = usage.input_tokens ?? 0;
  if (cacheRead > 0 && cacheCreation === 0) {
    return { kind: "proven-hit", cacheReadTokens: cacheRead, inputTokens };
  }
  if (cacheCreation > 0) {
    return { kind: "proven-write", cacheWriteTokens: cacheCreation };
  }
  return { kind: "no-usage" };
}

export interface SendPingOptions {
  /** Injectable fetch implementation; defaults to `globalThis.fetch`. Required in tests. */
  fetchImpl?: typeof fetch;
  /** Parent/session-level abort signal; aborting it aborts the in-flight ping. */
  signal?: AbortSignal;
  /** Hard timeout for the whole ping; default 20_000ms (§7.4, not a setting — safety const). */
  timeoutMs?: number;
}

/**
 * Send a single keepalive ping: bare POST, stream just far enough to classify the
 * result (early-abort at `message_start`), and release all resources.
 *
 * This function never throws. It guarantees, on every exit path (successful
 * early-stop, timeout, external/parent abort, non-2xx HTTP status, malformed
 * response, or network failure):
 *   - the request timeout timer is cleared,
 *   - the parent abort listener (if any) is removed,
 *   - the internal AbortController is aborted (releases the underlying socket),
 *   - any obtained stream reader is explicitly cancelled (not left to GC).
 *
 * (§7.4 / m3 resource-release contract.)
 */
export async function sendKeepalivePing(request: PingRequest, options: SendPingOptions = {}): Promise<PingOutcome> {
  const fetchImpl = options.fetchImpl ?? fetch;
  const parentSignal = options.signal;
  const timeoutMs = options.timeoutMs ?? DEFAULT_PING_TIMEOUT_MS;

  const controller = new AbortController();
  const onParentAbort = () => controller.abort();
  parentSignal?.addEventListener("abort", onParentAbort, { once: true });

  const timer = setTimeout(() => controller.abort(new Error("keepalive ping timeout")), timeoutMs);
  timer.unref?.();

  let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
  let headersReceived = false;

  try {
    let res: Response;
    try {
      res = await fetchImpl(request.url, {
        method: "POST",
        headers: request.headers,
        body: JSON.stringify(request.body),
        signal: controller.signal,
      });
    } catch (error) {
      return classify(error, headersReceived);
    }

    headersReceived = true;

    if (!res.ok) {
      await readCapped(res, HTTP_ERROR_BODY_CAP_BYTES);
      return { kind: "http", status: res.status };
    }

    reader = res.body?.getReader();
    if (!reader) return { kind: "malformed" };

    const decoder = new TextDecoder();
    let buffer = "";
    let totalBytes = 0;

    try {
      for (;;) {
        let step: { done: boolean; value?: Uint8Array | undefined };
        try {
          step = await reader.read();
        } catch (error) {
          return classify(error, headersReceived);
        }
        if (step.done || !step.value) {
          // Stream ended before we ever saw message_start: accepted, then lost.
          return { kind: "accepted-then-lost" };
        }
        totalBytes += step.value.byteLength;
        buffer += decoder.decode(step.value, { stream: true });

        let newlineIndex: number;
        while ((newlineIndex = buffer.indexOf("\n")) !== -1) {
          const line = buffer.slice(0, newlineIndex).trim();
          buffer = buffer.slice(newlineIndex + 1);
          if (!line.startsWith("data:")) continue;
          const dataText = line.slice("data:".length).trim();
          if (!dataText || dataText === "[DONE]") continue;
          let parsed: unknown;
          try {
            parsed = JSON.parse(dataText);
          } catch {
            continue; // ignore unparsable SSE frames, keep scanning
          }
          if (isMessageStartEvent(parsed)) {
            return classifyUsage(parsed);
          }
        }

        if (totalBytes >= PING_SCAN_LIMIT_BYTES) {
          return { kind: "malformed" };
        }
      }
    } finally {
      try {
        await reader.cancel();
      } catch {
        // ignore — m3: best-effort explicit cancel, not relying on GC
      }
    }
  } finally {
    clearTimeout(timer);
    parentSignal?.removeEventListener("abort", onParentAbort);
    controller.abort(); // m3: make sure the socket is torn down
  }
}

function classify(error: unknown, headersReceived: boolean): PingOutcome {
  // Once we've received response headers, any failure while reading the body
  // (abort/timeout/network drop) means the server accepted the request but we
  // lost the result before it could be proven — never silently call it "network".
  if (headersReceived) return { kind: "accepted-then-lost" };
  return { kind: "network" };
}
