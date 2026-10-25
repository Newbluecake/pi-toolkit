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

import { redactSecrets } from "../core/redact.js";

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
  | { kind: "network"; error?: string } // fetch itself failed / aborted before receiving a response
  | { kind: "malformed" }; // no body, or scanned 64KB without seeing message_start

export const PING_SCAN_LIMIT_BYTES = 64 * 1024;
export const HTTP_ERROR_BODY_CAP_BYTES = 2048;
const DEFAULT_PING_TIMEOUT_MS = 20_000;

const OAUTH_TOKEN_MARKER = "sk-ant-oat";

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

/**
 * O2 (provider-evidence TTL gating, 2026-10-12): remove ONLY the `ttl` field from
 * every ephemeral `cache_control` node, degrading a `ttl:"1h"` write intent to a
 * plain 5m ephemeral breakpoint. Used when the replay route has NO proven 1h
 * landing on record (`provider-evidence.ts`) — on a collapsing relay the `ttl`
 * field buys nothing (the 1h entry never exists) while still billing the 2× 1h
 * write rate, and a 5m ping can never refresh a real 1h entry anyway (separate
 * cache namespaces, official semantics).
 *
 * Fingerprint semantics are unchanged BY CONSTRUCTION: `CaptureFingerprint` was
 * computed at capture time from the REAL request and covers breakpoint PATHS,
 * digests and counts — never `ttl` values — so deleting `ttl` here touches no
 * fingerprinted field. Every other byte of the replay stays verbatim (I-K1).
 *
 * Copy-on-write: the input tree is never mutated (the keepalive capture is shared
 * state reused across pings), subtrees containing no `ttl` are returned by
 * reference, and cycles are left untouched (captures are `structuredClone`
 * products and acyclic in practice — the WeakSet is pure defence).
 */
export function stripCacheControlTtl<T>(node: T): T {
  return stripTtlNode(node, new WeakSet<object>()) as T;
}

function stripTtlNode(node: unknown, seen: WeakSet<object>): unknown {
  if (node === null || typeof node !== "object" || seen.has(node)) return node;
  seen.add(node);
  if (Array.isArray(node)) {
    let changed = false;
    const out = node.map((item) => {
      const stripped = stripTtlNode(item, seen);
      if (stripped !== item) changed = true;
      return stripped;
    });
    return changed ? out : node;
  }
  const obj = node as RecordValue;
  const control = obj.cache_control;
  const stripControl = isObjectRecord(control) && control.type === "ephemeral" && "ttl" in control;
  let result: RecordValue | undefined;
  for (const [key, value] of Object.entries(obj)) {
    let next: unknown;
    if (key === "cache_control" && stripControl) {
      const { ttl: _dropped, ...rest } = control;
      next = rest;
    } else {
      next = stripTtlNode(value, seen);
    }
    if (next !== value && result === undefined) result = { ...obj };
    if (result !== undefined) result[key] = next;
  }
  return result ?? node;
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

/**
 * Raw usage numbers scanned from the first `message_start` SSE event — the shared
 * currency of both the keepalive ping (classified into `PingOutcome`) and the
 * `/cache-ttl probe` (O4, which needs the 1h/5m write SPLIT, not a verdict).
 */
export interface RawScannedUsage {
  inputTokens: number;
  outputTokens: number;
  cacheRead: number;
  cacheWrite: number;
  /**
   * `usage.cache_creation.ephemeral_1h_input_tokens` — the proof that a real 1h entry exists.
   * `undefined` when the route doesn't report the split at all (distinct from a reported 0).
   */
  cacheWrite1h: number | undefined;
}

/**
 * Outcome of `postAndScanUsage` — the keepalive/probe-shared wire result BEFORE
 * classification. The non-`usage` kinds map 1:1 onto the same-named `PingOutcome`
 * variants.
 */
export type UsageScanOutcome =
  | { kind: "usage"; usage: RawScannedUsage | undefined } // `undefined` = message_start carried no usage object
  | { kind: "http"; status: number } // any non-2xx HTTP status
  | { kind: "accepted-then-lost" } // got a 200 response but stream ended/errored/timed out before message_start
  | { kind: "network"; error?: string } // fetch itself failed / aborted before receiving a response
  | { kind: "malformed" }; // no body, or scanned 64KB without seeing message_start

interface AnthropicMessageStartEvent {
  type: "message_start";
  message?: { usage?: Record<string, unknown> };
}

export function isMessageStartEvent(value: unknown): value is AnthropicMessageStartEvent {
  return isObjectRecord(value) && value.type === "message_start";
}

function finiteOr(value: unknown, fallback: number): number {
  return typeof value === "number" && Number.isFinite(value) ? value : fallback;
}

/** Project pi-ai's wire usage shape (`cache_creation.ephemeral_1h_input_tokens` split included) onto `RawScannedUsage`. */
export function rawUsageFrom(event: AnthropicMessageStartEvent): RawScannedUsage | undefined {
  const usage = event.message?.usage;
  if (!usage) return undefined;
  const creation = isObjectRecord(usage.cache_creation) ? usage.cache_creation : undefined;
  const split1h = creation ? creation.ephemeral_1h_input_tokens : undefined;
  return {
    inputTokens: finiteOr(usage.input_tokens, 0),
    outputTokens: finiteOr(usage.output_tokens, 0),
    cacheRead: finiteOr(usage.cache_read_input_tokens, 0),
    cacheWrite: finiteOr(usage.cache_creation_input_tokens, 0),
    cacheWrite1h: typeof split1h === "number" && Number.isFinite(split1h) ? split1h : undefined,
  };
}

/** Classify scanned usage into the keepalive proven/unproven verdict (I-K7). */
export function classifyUsage(usage: RawScannedUsage | undefined): PingOutcome {
  if (!usage) return { kind: "no-usage" };
  if (usage.cacheRead > 0 && usage.cacheWrite === 0) {
    return { kind: "proven-hit", cacheReadTokens: usage.cacheRead, inputTokens: usage.inputTokens };
  }
  if (usage.cacheWrite > 0) {
    return { kind: "proven-write", cacheWriteTokens: usage.cacheWrite };
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
 * Shared send-and-scan core (O4 extraction, 2026-10-12): bare POST, stream just far
 * enough to capture the first `message_start` event's raw usage (early-abort), and
 * release all resources. `sendKeepalivePing` is a thin classifying wrapper over this;
 * `/cache-ttl probe` (`probe.ts`) consumes the raw usage directly (it needs the
 * 1h/5m write split, not the proven/unproven verdict).
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
export async function postAndScanUsage(request: PingRequest, options: SendPingOptions = {}): Promise<UsageScanOutcome> {
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
            return { kind: "usage", usage: rawUsageFrom(parsed) };
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

/** The abort reason `postAndScanUsage`'s timeout timer aborts with — recognized verbatim by `networkErrorDescriptor`. */
const PING_TIMEOUT_SENTINEL = "keepalive ping timeout";

/** Hard cap on the descriptor (task spec: ~80; never let a pathological name/code grow past it). */
const NETWORK_ERROR_DESCRIPTOR_MAX = 80;

function sanitizeDescriptor(raw: string): string {
  // Collapse whitespace FIRST (so a tab isn't just deleted mid-token), then keep only
  // identifier-ish characters: URLs ("/", "?", "&", "="), header/body syntax and control
  // chars are dropped STRUCTURALLY, before the belt-and-braces `redactSecrets` pass.
  const collapsed = raw.replace(/\s+/g, " ");
  const safe = collapsed.replace(/[^A-Za-z0-9_ .:+-]/g, "");
  return redactSecrets(safe, []).trim().slice(0, NETWORK_ERROR_DESCRIPTOR_MAX);
}

/**
 * Short sanitized descriptor of a network-class failure, for diagnostics/audit trails
 * (2026-10-16 field-evidence follow-up): the error's `code` (`ECONNRESET`, `UND_ERR_SOCKET`,
 * `UND_ERR_CONNECT_TIMEOUT`, ...) — walking the `cause` chain and an `AggregateError`'s first
 * `errors` entry (undici wraps: `TypeError: fetch failed` → `AggregateError` → coded cause),
 * falling back to our own timeout sentinel message, then the error `name` (`AbortError`,
 * `TypeError`), then `"network"`.
 *
 * NEVER uses arbitrary error MESSAGES (they can carry URLs/headers/bodies/secrets) — only
 * `code`/`name` identifiers plus the exact-match internal sentinel — and caps the result at 80
 * chars. Belt-and-braces `redactSecrets` on top. Always returns a string.
 */
export function networkErrorDescriptor(error: unknown): string {
  let cur: unknown = error;
  for (let depth = 0; depth < 4 && cur instanceof Error; depth += 1) {
    const err = cur as Error & { code?: unknown; errors?: unknown };
    if (typeof err.code === "string" && err.code !== "") return sanitizeDescriptor(err.code);
    if (err.message === PING_TIMEOUT_SENTINEL) return PING_TIMEOUT_SENTINEL;
    const aggregated = err.errors;
    if (Array.isArray(aggregated) && aggregated.length > 0 && aggregated[0] instanceof Error) {
      cur = aggregated[0];
      continue;
    }
    if (err.cause instanceof Error) {
      cur = err.cause;
      continue;
    }
    return sanitizeDescriptor(err.name !== "" ? err.name : "network");
  }
  return "network";
}

function classify(error: unknown, headersReceived: boolean): UsageScanOutcome {
  // Once we've received response headers, any failure while reading the body
  // (abort/timeout/network drop) means the server accepted the request but we
  // lost the result before it could be proven — never silently call it "network".
  if (headersReceived) return { kind: "accepted-then-lost" };
  return { kind: "network", error: networkErrorDescriptor(error) };
}

/**
 * Send a single keepalive ping (see `postAndScanUsage` for the wire/resource
 * contract) and classify the scanned usage into the proven/unproven verdict.
 * Never throws.
 */
export async function sendKeepalivePing(request: PingRequest, options: SendPingOptions = {}): Promise<PingOutcome> {
  const scan = await postAndScanUsage(request, options);
  if (scan.kind !== "usage") return scan;
  return classifyUsage(scan.usage);
}
