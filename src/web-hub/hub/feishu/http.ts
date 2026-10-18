/**
 * Feishu bounded HTTP client (bot plan §2.2 / §3, package F2). Pi-free, `node:*`-free: it only needs the
 * platform `fetch`, injected as a seam (never env-configurable), and a clock seam for deadlines.
 *
 * Guarantees (each pinned by `tests/web-hub/hub/feishu/http.test.ts`):
 * - **Destination allowlist (§2.2):** the origin is one of the two frozen API bases
 *   (`isAllowedApiBase`), the path is a plain `/open-apis/…` / `/callback/…` path; the resulting URL
 *   is re-parsed and its origin compared to the base. Anything else ⇒ `destination` failure, NO fetch.
 * - **`redirect: "error"`** on every request (a 3xx can never carry the bearer token elsewhere).
 * - **Deadlines:** one `AbortController` per call, aborted by an unref'd clock timer (covers the body read
 *   too) and by the caller's optional `signal`. Timer + listener are always released.
 * - **Size caps:** JSON responses ≤ `maxResponseBytes` (default `FEISHU_HTTP.maxJsonBytes`), request bodies
 *   ≤ `maxRequestBytes`, streamed downloads ≤ the caller's cap (Content-Length pre-check + running count).
 * - **Never throws:** every outcome is a typed {@link FeishuResult}; failure `reason` is generated locally
 *   (`unreachable` | `timeout` | `http-<n>` | `api-code-<n>` | …) — never an arbitrary `Error.message`.
 * - **Redaction in every error/log path:** `msg` is sanitized ({@link redactSecrets}); URLs, request
 *   bodies, response bodies and headers are never put into a failure or an `onEvent` record, and `onEvent`
 *   carries only the static `op` label + numbers.
 * - **No module-scope mutable state:** everything lives in the `createFeishuHttp` closure.
 */

import {
  FEISHU_BOOTSTRAP_RETRYABLE_CODES,
  FEISHU_HTTP,
  FEISHU_SEND_UNCERTAIN_CODES,
  isAllowedApiBase,
} from "../../protocol/feishu.js";

// ---------------------------------------------------------------------------
// clock seam
// ---------------------------------------------------------------------------

/** Timer/clock seam (tests inject a fake; production uses {@link systemFeishuClock}). */
export interface FeishuClock {
  now(): number;
  setTimeout(fn: () => void, ms: number): unknown;
  clearTimeout(handle: unknown): void;
}

/** Real clock; timers are unref'd (a ref'd timer would wedge `pi -p` / hub shutdown). */
export const systemFeishuClock: FeishuClock = {
  now: () => Date.now(),
  setTimeout: (fn, ms) => {
    const handle = setTimeout(fn, ms);
    handle.unref();
    return handle;
  },
  clearTimeout: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>),
};

/** Fetch seam. The default resolves `globalThis.fetch` per call (never captured at import time). */
export type FeishuFetch = (input: string, init: RequestInit) => Promise<Response>;

// ---------------------------------------------------------------------------
// result types
// ---------------------------------------------------------------------------

export type FeishuFailureKind =
  /** destination allowlist / path validation refused — nothing was sent */
  | "destination"
  /** local argument validation refused — nothing was sent */
  | "bad-request"
  /** token stage failed before the call (set by `token.ts`/`api.ts`) — nothing was sent */
  | "auth"
  | "unreachable"
  | "timeout"
  /** caller `signal` fired (or a sink failed) */
  | "aborted"
  | "http"
  | "api"
  | "too-large"
  /** 2xx with an unusable body */
  | "protocol";

export interface FeishuFailure {
  ok: false;
  kind: FeishuFailureKind;
  /** Locally generated: `unreachable` | `timeout` | `http-<n>` | `api-code-<n>` | `too-large` | `protocol:<tag>` | … */
  reason: string;
  /** Whether repeating the SAME request later is reasonable (transient transport / 5xx / 429 / busy codes). */
  retryable: boolean;
  /**
   * Could the request have taken effect on the platform? `"none"` ⇒ provably rejected before/at the server
   * (safe to treat as not sent); `"unknown"` ⇒ timeout / reset / 5xx / `230020` / unparseable 2xx — a send
   * may only be retried with the SAME `uuid`.
   */
  effect: "none" | "unknown";
  status?: number;
  code?: number;
  /** Sanitized platform message (redacted, control chars stripped, ≤200 chars). */
  msg?: string;
  /** Scope names (`im:resource`, …) extracted from the platform message by a restricted grammar. */
  scopes?: string[];
  /** Token-stage classification when `kind === "auth"` (see `token.ts`). */
  auth?: "unconfigured" | "refused" | "auth_failed" | "transient" | "stale" | "aborted";
  /** `code ∈ FEISHU_CAPABILITY_DENIED_CODES` (set by `api.ts`; §4 runtime capability probing). */
  capabilityDenied?: true;
}

export type FeishuResult<T> = { ok: true; data: T } | FeishuFailure;

/** A successful JSON call: the whole decoded envelope plus its `data` member (when an object). */
export interface FeishuJson {
  status: number;
  body: Record<string, unknown>;
  data: Record<string, unknown> | undefined;
}

export interface FeishuStreamInfo {
  bytes: number;
  contentType?: string;
}

export type FeishuMethod = "GET" | "POST" | "PATCH" | "DELETE" | "PUT";

export interface FeishuRequest {
  /** Static, id-free label for `onEvent` (e.g. `"reply"`). NEVER put ids/paths in it. */
  op: string;
  method: FeishuMethod;
  /** `/open-apis/…` or `/callback/…`; dynamic segments MUST already be `encodeURIComponent`'d. */
  path: string;
  query?: Readonly<Record<string, string>>;
  /** Extra static headers (e.g. `locale`). `Authorization`/`Content-Type`/`Host`/`Cookie`/`Content-Length` are ignored. */
  headers?: Readonly<Record<string, string>>;
  /** Bearer token (also added to the redaction set for this call). */
  token?: string;
  json?: unknown;
  form?: FormData;
  timeoutMs?: number;
  /** JSON response cap (default `FEISHU_HTTP.maxJsonBytes`). */
  maxResponseBytes?: number;
  /** Serialized JSON request cap (default `FEISHU_HTTP.maxJsonBytes`). */
  maxRequestBytes?: number;
  signal?: AbortSignal;
  /** Extra literals to redact from `msg` for this call (e.g. the app secret being sent). */
  secrets?: readonly string[];
}

export interface FeishuStreamOptions {
  /** Hard cap on streamed bytes. */
  maxBytes: number;
  /** Receives every body chunk, in order; awaiting it provides backpressure. A throw aborts the download. */
  sink: (chunk: Uint8Array) => void | Promise<void>;
}

/** Redaction-safe observation of one finished call (no URL, no ids, no bodies). */
export interface FeishuHttpEvent {
  op: string;
  ok: boolean;
  /** `ok` or the failure `reason`. */
  outcome: string;
  status?: number;
  code?: number;
  ms: number;
}

export interface FeishuHttp {
  /** The (validated-per-call) API origin this client talks to. */
  readonly apiBase: string;
  json(req: FeishuRequest): Promise<FeishuResult<FeishuJson>>;
  stream(req: FeishuRequest, opts: FeishuStreamOptions): Promise<FeishuResult<FeishuStreamInfo>>;
  /** Apply the same redaction every error path uses (for callers that need to log something derived). */
  redact(text: string, extra?: readonly string[]): string;
}

export interface FeishuHttpDeps {
  apiBase: string;
  fetch?: FeishuFetch;
  clock?: FeishuClock;
  /** Live secrets to redact from every message (app secret, current token). Called per redaction. */
  secrets?: () => readonly string[];
  onEvent?: (event: FeishuHttpEvent) => void;
}

// ---------------------------------------------------------------------------
// redaction
// ---------------------------------------------------------------------------

const MSG_MAX_CHARS = 200;
const MIN_SECRET_LEN = 4;

/**
 * Remove secrets from free text. Layers: (1) the caller's literal secrets (any occurrence), (2) `Bearer …`,
 * (3) Feishu token shapes (`t-…`/`u-…`/`a-…`/`c-…`), (4) `key: value` / `key=value` pairs for credential-ish keys,
 * (5) every URL (`ticket`/`access_key` query strings live there; a WS URL is itself a credential).
 */
export function redactSecrets(text: string, secrets: readonly string[] = []): string {
  let out = text;
  for (const secret of secrets) {
    if (typeof secret === "string" && secret.length >= MIN_SECRET_LEN) out = out.split(secret).join("[redacted]");
  }
  out = out.replace(/\b(?:https?|wss?):\/\/[^\s"'<>]+/gi, "[url]");
  out = out.replace(/Bearer\s+[^\s"',;]+/gi, "Bearer [redacted]");
  out = out.replace(
    /("?(?:app_secret|appsecret|client_secret|tenant_access_token|app_access_token|user_access_token|access_token|refresh_token|device_code|ticket|authorization)"?\s*[:=]\s*)("[^"]*"|[^\s,&}]+)/gi,
    "$1[redacted]",
  );
  out = out.replace(/\b[tuac]-[A-Za-z0-9_-]{16,}/g, "[redacted]");
  return out;
}

/** Platform message ⇒ one bounded, control-free, redacted line (never throws). */
export function sanitizeApiMessage(raw: unknown, secrets: readonly string[] = []): string | undefined {
  if (typeof raw !== "string" || raw.length === 0) return undefined;
  // Strip control/format characters BEFORE redaction so a secret split by a control char cannot survive,
  // and cap the input first so a hostile megabyte message cannot cost regex time.
  const stripped = raw
    .slice(0, 4_096)
    // eslint-disable-next-line no-control-regex
    .replace(/[\u0000-\u001f\u007f-\u009f\u200b-\u200f\u2028-\u202e\u2066-\u2069\ufeff]+/g, " ")
    .trim();
  if (stripped.length === 0) return undefined;
  const redacted = redactSecrets(stripped, secrets);
  return [...redacted].slice(0, MSG_MAX_CHARS).join("");
}

/**
 * Scope names (`im:resource`, `im:message.reactions:write_only`, …) found in a platform message by a
 * restricted grammar over fixed namespaces — not arbitrary words/URLs (probe `errors.ts` parity).
 */
export function extractMissingScopes(message: unknown, secrets: readonly string[] = []): string[] {
  if (typeof message !== "string") return [];
  const found =
    message
      .slice(0, 4_096)
      .match(
        /(?<![a-zA-Z0-9_.:/-])(?:im|contact|drive|docs|docx|bitable|application|cardkit|event|auth|bot):[a-z_]+(?:[.:][a-z_]+)*(?![a-zA-Z0-9_.:/-])/g,
      ) ?? [];
  return [...new Set(found)]
    .filter(
      (scope) =>
        scope.length <= 120 &&
        !/secret|token|device_code|open_id/.test(scope) &&
        !secrets.some((s) => s.length >= MIN_SECRET_LEN && scope.includes(s)),
    )
    .slice(0, 16);
}

// ---------------------------------------------------------------------------
// classification helpers
// ---------------------------------------------------------------------------

const RETRYABLE_HTTP = new Set([408, 425, 429, 500, 502, 503, 504]);

function effectOf(kind: FeishuFailureKind, status: number | undefined, code: number | undefined): "none" | "unknown" {
  switch (kind) {
    case "destination":
    case "bad-request":
    case "auth":
      return "none";
    case "unreachable":
    case "timeout":
    case "aborted":
    case "too-large":
    case "protocol":
      return "unknown";
    case "http":
    case "api":
      if (status !== undefined && status >= 500) return "unknown";
      if (code !== undefined && FEISHU_SEND_UNCERTAIN_CODES.includes(code)) return "unknown";
      return "none";
  }
}

function retryableOf(kind: FeishuFailureKind, status: number | undefined, code: number | undefined): boolean {
  if (kind === "unreachable" || kind === "timeout") return true;
  if (kind === "http") return status !== undefined && RETRYABLE_HTTP.has(status);
  if (kind === "api") {
    if (status !== undefined && RETRYABLE_HTTP.has(status)) return true;
    return (
      code !== undefined &&
      (FEISHU_BOOTSTRAP_RETRYABLE_CODES.includes(code) || FEISHU_SEND_UNCERTAIN_CODES.includes(code))
    );
  }
  return false;
}

/** Build a failure; `reason` is the only free-form field and callers pass locally-generated strings. */
export function makeFailure(
  kind: FeishuFailureKind,
  reason: string,
  extra: { status?: number; code?: number; msg?: string; scopes?: string[]; auth?: FeishuFailure["auth"] } = {},
): FeishuFailure {
  const failure: FeishuFailure = {
    ok: false,
    kind,
    reason,
    retryable: retryableOf(kind, extra.status, extra.code),
    effect: effectOf(kind, extra.status, extra.code),
  };
  if (extra.status !== undefined) failure.status = extra.status;
  if (extra.code !== undefined) failure.code = extra.code;
  if (extra.msg !== undefined) failure.msg = extra.msg;
  if (extra.scopes !== undefined && extra.scopes.length > 0) failure.scopes = extra.scopes;
  if (extra.auth !== undefined) failure.auth = extra.auth;
  return failure;
}

/** Internal sentinel — never escapes {@link createFeishuHttp}. */
class TooLarge extends Error {}
class SinkFailed extends Error {}

const PATH_RE = /^\/(?:open-apis|callback)\/[A-Za-z0-9._~!*'()%/-]*$/;
/** Error envelopes are tiny; a 2xx JSON-typed download that is a real envelope fits well under this. */
const ENVELOPE_PROBE_BYTES = 8 * 1024;
const ERROR_BODY_MAX_BYTES = 64 * 1024;

function validPath(path: string): boolean {
  if (!PATH_RE.test(path) || path.length > 2_048) return false;
  if (path.includes("//")) return false;
  const lowered = path.toLowerCase();
  if (lowered.includes("/../") || lowered.endsWith("/..") || lowered.includes("/./") || lowered.endsWith("/.")) {
    return false;
  }
  return !lowered.includes("%2e") && !lowered.includes("%2f") && !lowered.includes("%5c");
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function decodeJson(bytes: Uint8Array): Record<string, unknown> | undefined {
  try {
    const parsed: unknown = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
    return isPlainObject(parsed) ? parsed : undefined;
  } catch {
    return undefined;
  }
}

function concat(chunks: readonly Uint8Array[], total: number): Uint8Array {
  const out = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    out.set(chunk, offset);
    offset += chunk.length;
  }
  return out;
}

// ---------------------------------------------------------------------------
// the client
// ---------------------------------------------------------------------------

export function createFeishuHttp(deps: FeishuHttpDeps): FeishuHttp {
  const apiBase = deps.apiBase;
  const clock = deps.clock ?? systemFeishuClock;
  const fetchImpl: FeishuFetch = deps.fetch ?? ((input, init) => globalThis.fetch(input, init));

  const secretsFor = (req?: FeishuRequest): string[] => {
    const out: string[] = [];
    try {
      for (const s of deps.secrets?.() ?? []) if (typeof s === "string") out.push(s);
    } catch {
      /* a throwing provider must not break error reporting */
    }
    if (req?.token) out.push(req.token);
    for (const s of req?.secrets ?? []) out.push(s);
    return out;
  };

  function emit(req: FeishuRequest, startedAt: number, result: FeishuResult<unknown>, status?: number): void {
    if (deps.onEvent === undefined) return;
    try {
      const event: FeishuHttpEvent = {
        op: req.op,
        ok: result.ok,
        outcome: result.ok ? "ok" : result.reason,
        ms: Math.max(0, clock.now() - startedAt),
      };
      const st = result.ok ? status : (result.status ?? status);
      if (st !== undefined) event.status = st;
      if (!result.ok && result.code !== undefined) event.code = result.code;
      deps.onEvent(event);
    } catch {
      /* observers never affect the call */
    }
  }

  function classifyEnvelope(
    req: FeishuRequest,
    status: number,
    body: Record<string, unknown> | undefined,
  ): FeishuResult<FeishuJson> {
    const secrets = secretsFor(req);
    const code = body !== undefined && typeof body["code"] === "number" ? (body["code"] as number) : undefined;
    const ok2xx = status >= 200 && status < 300;
    if (code !== undefined && code !== 0) {
      return makeFailure("api", `api-code-${code}`, {
        status,
        code,
        ...optionalMsg(body?.["msg"], secrets),
      });
    }
    if (!ok2xx) return makeFailure("http", `http-${status}`, { status });
    if (body === undefined) return makeFailure("protocol", "protocol:non-json", { status });
    if (code !== 0) return makeFailure("protocol", "protocol:invalid-api-response", { status });
    const data = body["data"];
    return { ok: true, data: { status, body, data: isPlainObject(data) ? data : undefined } };
  }

  function optionalMsg(raw: unknown, secrets: readonly string[]): { msg?: string; scopes?: string[] } {
    const out: { msg?: string; scopes?: string[] } = {};
    const msg = sanitizeApiMessage(raw, secrets);
    if (msg !== undefined) out.msg = msg;
    const scopes = extractMissingScopes(raw, secrets);
    if (scopes.length > 0) out.scopes = scopes;
    return out;
  }

  /** Read the whole body under a hard cap; `TooLarge` before any oversized allocation. */
  async function readBounded(res: Response, limit: number): Promise<Uint8Array> {
    const declared = Number(res.headers.get("content-length"));
    if (Number.isFinite(declared) && declared > limit) throw new TooLarge();
    const reader = res.body?.getReader();
    if (reader === undefined) return new Uint8Array();
    const chunks: Uint8Array[] = [];
    let total = 0;
    try {
      for (;;) {
        const r = await reader.read();
        if (r.done) break;
        total += r.value.length;
        if (total > limit) throw new TooLarge();
        chunks.push(r.value);
      }
    } finally {
      // cancel is a no-op on a drained stream and frees the connection on every early exit
      reader.cancel().catch(() => undefined);
    }
    return concat(chunks, total);
  }

  /**
   * Shared envelope: validation → fetch → `consume` under one deadline. `consume` may throw; the
   * thrown value is mapped from the abort flags (never from its message).
   */
  async function run<T>(
    req: FeishuRequest,
    consume: (res: Response) => Promise<FeishuResult<T>>,
  ): Promise<FeishuResult<T>> {
    const startedAt = clock.now();
    const finish = (result: FeishuResult<T>, status?: number): FeishuResult<T> => {
      emit(req, startedAt, result, status);
      return result;
    };

    if (!isAllowedApiBase(apiBase)) return finish(makeFailure("destination", "destination:base"));
    if (!validPath(req.path)) return finish(makeFailure("destination", "destination:path"));
    let url: string;
    try {
      const built = new URL(apiBase + req.path);
      if (req.query !== undefined) for (const [k, v] of Object.entries(req.query)) built.searchParams.set(k, v);
      if (
        built.origin !== apiBase ||
        built.protocol !== "https:" ||
        built.username !== "" ||
        built.password !== "" ||
        built.hash !== ""
      ) {
        return finish(makeFailure("destination", "destination:url"));
      }
      url = built.toString();
    } catch {
      return finish(makeFailure("destination", "destination:url"));
    }

    const headers: Record<string, string> = { Accept: "application/json" };
    for (const [name, value] of Object.entries(req.headers ?? {})) {
      if (/^(?:authorization|content-type|host|cookie|content-length)$/i.test(name)) continue;
      if (/^[A-Za-z][A-Za-z0-9-]{0,63}$/.test(name) && typeof value === "string" && !/[\r\n]/.test(value)) {
        headers[name] = value;
      }
    }
    if (req.token !== undefined) headers["Authorization"] = `Bearer ${req.token}`;
    let body: string | FormData | undefined;
    if (req.form !== undefined) {
      body = req.form; // fetch derives the multipart boundary header itself
    } else if (req.json !== undefined) {
      let serialized: string;
      try {
        serialized = JSON.stringify(req.json);
      } catch {
        return finish(makeFailure("bad-request", "bad-request:json"));
      }
      if (serialized === undefined) return finish(makeFailure("bad-request", "bad-request:json"));
      if (new TextEncoder().encode(serialized).length > (req.maxRequestBytes ?? FEISHU_HTTP.maxJsonBytes)) {
        return finish(makeFailure("bad-request", "bad-request:request-too-large"));
      }
      headers["Content-Type"] = "application/json; charset=utf-8";
      body = serialized;
    }
    if (req.signal?.aborted) return finish(makeFailure("aborted", "aborted"));

    const ac = new AbortController();
    let timedOut = false;
    let externallyAborted = false;
    const onExternal = (): void => {
      externallyAborted = true;
      ac.abort();
    };
    req.signal?.addEventListener("abort", onExternal, { once: true });
    const timeoutMs = Math.max(1, Math.floor(req.timeoutMs ?? FEISHU_HTTP.defaultTimeoutMs));
    const timer = clock.setTimeout(() => {
      timedOut = true;
      ac.abort();
    }, timeoutMs);

    let status: number | undefined;
    try {
      const init: RequestInit = { method: req.method, headers, redirect: "error", signal: ac.signal };
      if (body !== undefined) init.body = body;
      const res = await fetchImpl(url, init);
      status = res.status;
      const result = await consume(res);
      return finish(result, status);
    } catch (error) {
      if (error instanceof TooLarge)
        return finish(makeFailure("too-large", "too-large", status !== undefined ? { status } : {}), status);
      if (error instanceof SinkFailed) return finish(makeFailure("aborted", "sink-failed"), status);
      if (timedOut) return finish(makeFailure("timeout", "timeout"), status);
      if (externallyAborted) return finish(makeFailure("aborted", "aborted"), status);
      return finish(makeFailure("unreachable", "unreachable"), status);
    } finally {
      clock.clearTimeout(timer);
      req.signal?.removeEventListener("abort", onExternal);
    }
  }

  return {
    apiBase,
    redact: (text, extra = []) => redactSecrets(text, [...secretsFor(), ...extra]),

    json: (req) =>
      run<FeishuJson>(req, async (res) => {
        const bytes = await readBounded(res, req.maxResponseBytes ?? FEISHU_HTTP.maxJsonBytes);
        return classifyEnvelope(req, res.status, decodeJson(bytes));
      }),

    stream: (req, opts) =>
      run<FeishuStreamInfo>(req, async (res) => {
        const contentType = res.headers.get("content-type") ?? undefined;
        if (res.status < 200 || res.status >= 300) {
          // an error response: classify its (small) envelope; never feed it to the sink
          const bytes = await readBounded(res, ERROR_BODY_MAX_BYTES).catch((e: unknown) => {
            if (e instanceof TooLarge) return new Uint8Array();
            throw e;
          });
          const failure = classifyEnvelope(req, res.status, decodeJson(bytes));
          return failure.ok ? makeFailure("http", `http-${res.status}`, { status: res.status }) : failure;
        }
        const declared = Number(res.headers.get("content-length"));
        if (Number.isFinite(declared) && declared > opts.maxBytes) {
          res.body?.cancel().catch(() => undefined);
          throw new TooLarge();
        }
        const reader = res.body?.getReader();
        let total = 0;
        if (reader === undefined) return { ok: true, data: { bytes: 0, ...(contentType ? { contentType } : {}) } };
        const probing = contentType !== undefined && /json/i.test(contentType);
        const held: Uint8Array[] = [];
        let heldBytes = 0;
        const push = async (chunk: Uint8Array): Promise<void> => {
          total += chunk.length;
          if (total > opts.maxBytes) throw new TooLarge();
          try {
            await opts.sink(chunk);
          } catch {
            throw new SinkFailed();
          }
        };
        const flushHeld = async (): Promise<void> => {
          const pending = held.splice(0);
          heldBytes = 0;
          for (const chunk of pending) await push(chunk);
        };
        let deciding = probing;
        try {
          for (;;) {
            const r = await reader.read();
            if (r.done) break;
            if (deciding) {
              held.push(r.value);
              heldBytes += r.value.length;
              if (heldBytes > ENVELOPE_PROBE_BYTES) {
                deciding = false;
                await flushHeld();
              }
              continue;
            }
            await push(r.value);
          }
          if (deciding) {
            // whole body ≤ probe size and JSON-typed: a tiny `{code≠0,msg}` object is Feishu's error envelope
            const whole = concat(held, heldBytes);
            const parsed = decodeJson(whole);
            if (
              parsed !== undefined &&
              typeof parsed["code"] === "number" &&
              parsed["code"] !== 0 &&
              typeof parsed["msg"] === "string" &&
              Object.keys(parsed).length <= 4
            ) {
              const failure = classifyEnvelope(req, res.status, parsed);
              if (!failure.ok) return failure;
            }
            await flushHeld();
          }
        } finally {
          reader.cancel().catch(() => undefined);
        }
        return { ok: true, data: { bytes: total, ...(contentType ? { contentType } : {}) } };
      }),
  };
}
