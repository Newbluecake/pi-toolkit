/**
 * Password-mode browser transport (plan §10, package LF).
 *
 * Shares the EventSource lifecycle with the token client through
 * `./transport-core.js` (one stream per tab, 45s-silence watchdog, exponential reopen
 * backoff, connect-handshake deadline — source-governance batch2 ⑩-U, extracted verbatim),
 * driving the LAN `data-auth-mode="password"` listener instead of the loopback token one:
 *
 * - No `#t=` hash is ever read or sent; if present it is only cleared via
 *   `history.replaceState` (plan §10 "token 只在 token 模式").
 * - No `reloginOnce`: an EventSource that goes CLOSED (verified against real
 *   Chromium — see `docs/dev/web-hub/lan-plan.md` §10 "已排除" — a non-200
 *   response, 401 or 503 alike, always fails the connection with no browser
 *   retry, so the two are indistinguishable from `error` alone) always means
 *   "show the login form"; only a genuine mid-stream network hiccup leaves
 *   `readyState` at CONNECTING, which the browser retries on its own.
 * - `login(username, password)` drives the full `/api/login` state machine
 *   from §10's 错误文案 row: 401 invalid / 429 saturated (no retry) / 429
 *   `E_RATE` (auto-retry) / plain 429 (countdown, no auto-retry) / 503 (up to
 *   `BUSY_RETRY_MAX` retries, then a manual retry) / 421 (no retry) / network
 *   error — never touches localStorage, never logs the password anywhere.
 * - `event: auth` (`{reason:"revoked"|"expired"}`) closes the stream
 *   immediately and reports the reason instead of waiting for the generic
 *   `error` path.
 * - `subscribe`/`unsubscribe`/`page` mirror `createClient`'s REST calls (same
 *   endpoints, same request shapes) minus the token-mode `withRelogin` dance
 *   — a password-mode 401 means the cookie session is gone, already surfaced
 *   via the `auth` SSE event / `probeSessionAfterClose`, not a re-login
 *   token. `wireFleetUi` (shared with `app.js`) calls all three unconditionally,
 *   so omitting any of them throws synchronously inside `effects()` on the
 *   very first subscribe attempt — no `/api/subscribe` request is ever sent,
 *   `sub.pending` never clears, and the transcript is stuck at "loading
 *   history…" forever with no console.* output (the throw escapes the
 *   triggering SSE/click callback as an uncaught exception, not a console
 *   call).
 * - Control plane (control-plan v2.1 §7.2, package C4): `command()`/`dialog()` are one-shot
 *   `postApi` calls to the write endpoints (16s budget, §3.3) — NO relogin dance: a
 *   password-mode 401 means the cookie session is gone and is surfaced as `E_AUTH` (the
 *   `transport/password.ts` wrapper maps it to `onConn("auth")` via REST_AUTH_PATHS).
 * - LAN security r2 §5.6/§5.9 (package G): second-factor login. `login()` additionally
 *   returns `{ok:false, kind:"second-factor", challenge}` when the hub answers the
 *   password with a 401 `E_2FA` challenge (`Lan2faChallenge`, frozen in
 *   `@protocol/lan-2fa.ts`); `submitSecondFactor`/`waitApproval`/`cancelSecondFactor`
 *   drive `/api/login/2fa{,/wait,/cancel}`. The wait loop long-polls serially (one
 *   request in flight, 30s per-poll timeout > the server's 15s hold + 8s reserve), treats
 *   ANY poll timeout/failure as "retry" until `challenge.expiresAt`, never polls faster
 *   than `WAIT_MIN_POLL_MS` (a pathology floor — a conformant server paces the loop by
 *   holding each poll), and backs off 1s→2s→4s…≤8s after consecutive TRANSPORT errors
 *   (reset by any HTTP response). `waitApproval` is idempotent per challenge (a duplicate
 *   call with the SAME challenge object rides the in-flight loop instead of registering a
 *   second server-side waiter, which would 409 `E_2FA_BUSY`); a `submitSecondFactor`
 *   success aborts the loop (settles `cancelled`, which callers ignore) so a stale `/wait`
 *   answer can never bounce a completed login back to the password form.
 */
import { API, HISTORY_LIMIT_MAX, PROXY_CLIENT_TIMEOUT_MS, VERSION_INFO_CLIENT_TIMEOUT_MS } from "./contract.js";
import { createStreamLifecycle, createTimer } from "./transport-core.js";
import {
  PROXY_LIST_BODY_MAX_BYTES,
  PROXY_OPEN_BODY_MAX_BYTES,
  parseProxyList,
  parseProxyOpen,
  parseProxyStop,
  proxyFetch,
} from "./proxy.js";
import { outcomeFromError, outcomeFromResponse } from "./control.js";
import {
  PREVIEW_CHUNK_QUERY,
  PREVIEW_ADMIT_TOTAL_MS,
  PREVIEW_CLIENT_TIMEOUT_MS,
  PREVIEW_DIR_BODY_MAX_BYTES,
  PREVIEW_DOWNLOAD_CLIENT_TIMEOUT_MS,
  PREVIEW_IDENT_QUERY,
  PREVIEW_IMAGE_MAX_BYTES,
  PREVIEW_OFFSET_QUERY,
  PREVIEW_PROBE_CLIENT_TIMEOUT_MS,
  validatePreviewIdent,
} from "@protocol/preview.ts";
import { parsePreviewDirListing } from "@protocol/preview.ts";
import {
  parseWtDiffFile,
  parseWtDiffFileList,
  WTDIFF_CLIENT_TIMEOUT_MS,
  WTDIFF_FILE_BODY_MAX_BYTES,
  WTDIFF_LIST_BODY_MAX_BYTES,
} from "@protocol/worktree-diff.ts";
import {
  parseWtGraphPayload,
  WTGRAPH_BODY_MAX_BYTES,
  WTGRAPH_CLIENT_TIMEOUT_MS,
  WTGRAPH_MERGED_CLIENT_TIMEOUT_MS,
  WTGRAPH_MERGED_QUERY,
} from "@protocol/worktree-graph.ts";
import { checkPreviewHeaders, previewOutcomeFromResponse } from "./preview.js";
import { parseProbeResults } from "./previewProbe.js";
import { historyOutcomeFromResponse } from "./sessionHistory.ts";
import { LOAD_TOP_BODY_MAX_BYTES, LOAD_TOP_CLIENT_TIMEOUT_MS, parseLoadTopWire } from "./load.js";
import { parseVersionInfoWire, VERSION_LIMITS } from "@protocol/version-info.ts";
import { AVATAR_DELETE_PATH, AVATAR_PATH } from "@protocol/avatar.ts";
import { validateAvatarPng } from "@protocol/avatar-png.ts";
import {
  LAN_2FA_CANCEL_PATH,
  LAN_2FA_LIMITS,
  LAN_2FA_PATH,
  LAN_2FA_WAIT_PATH,
  TOTP_CODE_RE,
  normalizeRecoveryCode,
} from "@protocol/lan-2fa.ts";

export const REQUEST_TIMEOUT_MS = 10_000;
export const CMD_REQUEST_TIMEOUT_MS = 16_000; // control-plan §3.3 browser write budget
export const LOGIN_TIMEOUT_MS = 25_000; // plan §10 "排队等待": KDF fair-scheduling wait can run up to 20s
export const BUSY_RETRY_MAX = 5;
export const BUSY_RETRY_DEFAULT_MS = 2_000;
export const RATE_RETRY_DEFAULT_MS = 1_000;
export const THROTTLE_RETRY_DEFAULT_MS = 30_000;
// plan §10 review fix (lan-plan.md §15.9 #8): an SSE stream going CLOSED is ambiguous between
// “not signed in” (401) and “hub momentarily busy / network hiccup” (503, or the fetch itself
// failing) — both fail the EventSource connection with no browser retry, indistinguishable from
// `error` alone. `GET /api/session` disambiguates before deciding what to show.
export const CLOSE_PROBE_MAX = 5;
export const CLOSE_PROBE_BACKOFF_MS = 2_000;
// LAN security r2 §5.6 (package G): `/2fa` submit budget above the server's 12s factor
// deadline; the wait loop's per-poll timeout sits above the server's 15s hold + 8s
// completion reserve (23s) so a healthy poll always ends with a real answer, and any
// timeout means "retry". `WAIT_MIN_POLL_MS` is the pathology floor between poll starts —
// with a conformant server the hold itself paces the loop and this never engages.
export const SECOND_FACTOR_TIMEOUT_MS = 16_000;
export const WAIT_POLL_TIMEOUT_MS = LAN_2FA_LIMITS.pollTimeoutMs;
export const WAIT_MIN_POLL_MS = 1_000;
// Bounded backoff after consecutive TRANSPORT errors in the wait loop (verifier rework #4):
// 1s→2s→4s→… capped here, reset by any HTTP response. Never below WAIT_MIN_POLL_MS.
export const WAIT_ERROR_BACKOFF_MAX_MS = 8_000;

/**
 * @typedef {{
 *   fetch: (url: string, init?: any) => Promise<{ ok: boolean, status: number, headers?: { get(name: string): string | null }, json(): Promise<any> }>,
 *   EventSource: new (url: string, init?: any) => any,
 *   location: { hash: string, pathname: string, search: string },
 *   history: { replaceState(data: any, unused: string, url?: string): void },
 *   setTimeout: (fn: () => void, ms: number) => any,
 *   clearTimeout: (t: any) => void,
 *   now: () => number,
 *   AbortController?: new () => { signal: any, abort(): void },
 *   onMessage: (msg: { event: string, data: any, id?: number }) => void,
 *   onConn: (state: "connecting" | "open" | "reconnecting" | "auth") => void,
 *   onAuthEvent: (reason: "revoked" | "expired") => void,
 *   onUnauthenticated: () => void,
 *   onSessionInfo?: (info: { initialPasswordInUse: boolean }) => void,
 *   onLoginRetry?: (kind: "rate" | "busy") => void,
 * }} PasswordClientDeps
 */

/**
 * @typedef {{ error: "E_2FA", methods: ("totp" | "recovery" | "feishu")[], feishu: "sent" | "unavailable", expiresAt: number }}
 *   Lan2faChallengeWire — the frozen `Lan2faChallenge` of `@protocol/lan-2fa.ts`, re-declared
 *   structurally so this .js module stays runtime-free of TypeScript type imports.
 */

const FACTOR_METHODS = new Set(["totp", "recovery", "feishu"]);

/**
 * Defensive narrowing of a 401 body into the frozen `Lan2faChallengeSchema` shape
 * (`@protocol/lan-2fa.ts`). Anything off-contract ⇒ `null` (the caller falls back to the
 * plain "invalid password" branch, byte-identical to pre-2FA behavior).
 * @param {unknown} body @returns {Lan2faChallengeWire | null}
 */
function narrowChallenge(body) {
  if (body === null || typeof body !== "object") return null;
  const b = body;
  if (b.error !== "E_2FA") return null;
  if (!Array.isArray(b.methods) || b.methods.length < 1 || b.methods.length > 3) return null;
  if (!b.methods.every((m) => typeof m === "string" && FACTOR_METHODS.has(m))) return null;
  if (new Set(b.methods).size !== b.methods.length) return null;
  if (b.feishu !== "sent" && b.feishu !== "unavailable") return null;
  if (typeof b.expiresAt !== "number" || !Number.isFinite(b.expiresAt) || b.expiresAt < 0) return null;
  return { error: "E_2FA", methods: [...b.methods], feishu: b.feishu, expiresAt: b.expiresAt };
}

/** `#t=` present among the hash params (never parsed further — only used to decide whether to clear it). @param {unknown} hash */
function hashHasToken(hash) {
  if (typeof hash !== "string" || !hash.startsWith("#")) return false;
  return new URLSearchParams(hash.slice(1)).get("t") !== null;
}

/**
 * @param {{ headers?: { get(name: string): string | null } }} r
 * @param {number} fallbackMs
 */
function retryAfterMs(r, fallbackMs) {
  const raw = typeof r.headers?.get === "function" ? r.headers.get("Retry-After") : null;
  const n = raw === null || raw === undefined ? NaN : Number(raw);
  return Number.isFinite(n) && n >= 0 ? n * 1000 : fallbackMs;
}

/**
 * @param {PasswordClientDeps} deps
 */
export function createPasswordClient(deps) {
  const timer = createTimer(deps);
  const stream = createStreamLifecycle(deps, {
    /**
     * `event: auth` (`{reason:"revoked"|"expired"}`) closes the stream immediately and
     * reports the reason instead of waiting for the generic `error` path.
     * @param {string} name @param {any} data @param {any} source @returns {boolean}
     */
    handleFrame(name, data, source) {
      if (name !== "auth") return false;
      const reason = data && (data.reason === "revoked" || data.reason === "expired") ? data.reason : "revoked";
      stream.dropSource(source);
      stream.resetBackoff();
      deps.onConn("auth");
      deps.onAuthEvent(reason);
      return true;
    },
    /**
     * CLOSED: 401 and 503 are indistinguishable from `error` alone (both fail the connection
     * with no browser retry) — the §10 review-fix probe (lan-plan.md §15.9 #8) disambiguates
     * before deciding what to show. The connect deadline was already cleared by the lifecycle
     * core before this hook runs — it must not race the probe's own reopen schedule.
     * @param {any} source
     */
    onClosedError(source) {
      void probeSessionAfterClose(source);
    },
  });

  /** @param {number} ms */
  const sleep = (ms) => new Promise((resolve) => timer(resolve, ms));

  /** `sleep` that also resolves early when `signal` aborts (the wait loop's pacing sleeps
   *  must not outlive a `cancelSecondFactor()`/submit-success abort). A settled timer
   *  removes its listener so a never-aborted session leaks nothing.
   *  @param {number} ms @param {any} [signal] */
  function sleepAbortable(ms, signal) {
    if (signal === undefined || signal === null || typeof signal.addEventListener !== "function") return sleep(ms);
    if (signal.aborted === true) return Promise.resolve();
    return new Promise((resolve) => {
      const t = timer(() => {
        if (typeof signal.removeEventListener === "function") signal.removeEventListener("abort", onAbort);
        resolve();
      }, ms);
      const onAbort = () => {
        deps.clearTimeout(t);
        resolve();
      };
      signal.addEventListener("abort", onAbort, { once: true });
    });
  }

  /**
   * Fetch with a deadline. The optional `signal` (web-hub-upload plan U4b: chunk
   * abort-on-remove) is MERGED with the internal timeout controller — whoever fires first wins,
   * and the shared controller aborts the underlying fetch either way. A pre-aborted signal never
   * issues the fetch at all. External aborts surface as `Error("E_ABORT")`, timeouts as
   * `Error("E_DEADLINE")`.
   * @param {string} url @param {any} init @param {number} timeoutMs
   * @param {{ aborted?: boolean, addEventListener?: (t: string, fn: () => void, o?: any) => void,
   *   removeEventListener?: (t: string, fn: () => void) => void }} [signal]
   */
  async function request(url, init, timeoutMs, signal) {
    if (signal && signal.aborted === true) throw new Error("E_ABORT");
    const AC = deps.AbortController ?? (typeof AbortController === "function" ? AbortController : undefined);
    const ac = AC ? new AC() : undefined;
    /** @type {any} */
    let t = null;
    const deadline = new Promise((_, reject) => {
      t = timer(() => {
        ac?.abort();
        reject(new Error("E_DEADLINE"));
      }, timeoutMs);
    });
    // External-signal merge: `Promise.race` attaches handlers to every racer, so the losers'
    // later rejections (the aborted fetch itself) are swallowed rather than unhandled.
    /** @type {Promise<never> | null} */
    let externalAbort = null;
    /** @type {(() => void) | null} */
    let onExternalAbort = null;
    if (signal && typeof signal.addEventListener === "function") {
      externalAbort = new Promise((_, reject) => {
        onExternalAbort = () => {
          ac?.abort();
          reject(new Error("E_ABORT"));
        };
      });
      signal.addEventListener("abort", onExternalAbort, { once: true });
    }
    try {
      const racers = [
        deps.fetch(url, { credentials: "same-origin", ...init, ...(ac ? { signal: ac.signal } : {}) }),
        deadline,
      ];
      if (externalAbort !== null) racers.push(externalAbort);
      return await Promise.race(racers);
    } finally {
      deps.clearTimeout(t);
      if (onExternalAbort !== null && signal && typeof signal.removeEventListener === "function") {
        signal.removeEventListener("abort", onExternalAbort);
      }
    }
  }

  async function fetchSessionInfo() {
    try {
      const r = await request(API.session, { method: "GET" }, REQUEST_TIMEOUT_MS);
      if (!r.ok) return;
      const body = await r.json();
      deps.onSessionInfo?.({ initialPasswordInUse: !!(body && body.initialPasswordInUse === true) });
    } catch {
      /* diagnostic only — never blocks the sign-in flow */
    }
  }

  /** One `/api/login` attempt, classified but not retried. @param {string} username @param {string} password */
  async function postLoginOnce(username, password) {
    /** @type {any} */
    let r;
    try {
      r = await request(
        API.login,
        {
          method: "POST",
          headers: { "Content-Type": "application/json", "X-PWH": "1" },
          body: JSON.stringify({ username, password }),
        },
        LOGIN_TIMEOUT_MS,
      );
    } catch {
      return { kind: "network" };
    }
    /** @type {any} */
    let body;
    try {
      body = await r.json();
    } catch {
      body = undefined;
    }
    if (r.ok) return { kind: "ok", body: body && typeof body === "object" ? body : {} };
    if (r.status === 401) {
      // LAN security r2 §5.6: a correct password from a new IP answers 401 `E_2FA` with the
      // challenge payload — distinct from an invalid password (same status, no/unknown body).
      const challenge = narrowChallenge(body);
      if (challenge !== null) return { kind: "challenge", challenge };
      return { kind: "invalid" };
    }
    if (r.status === 421) return { kind: "not-allowed" };
    if (r.status === 429) {
      if (body && body.saturated === true) return { kind: "saturated", retryAfterMs: retryAfterMs(r, 60_000) };
      if (body && body.error === "E_RATE")
        return { kind: "rate", retryAfterMs: retryAfterMs(r, RATE_RETRY_DEFAULT_MS) };
      return { kind: "throttled", retryAfterMs: retryAfterMs(r, THROTTLE_RETRY_DEFAULT_MS) };
    }
    if (r.status === 503) return { kind: "busy", retryAfterMs: retryAfterMs(r, BUSY_RETRY_DEFAULT_MS) };
    return { kind: "unknown", status: r.status };
  }

  /**
   * @param {string} username @param {string} password
   * @returns {Promise<
   *   | { ok: true, initialPassword: boolean }
   *   | { ok: false, kind: "second-factor", challenge: Lan2faChallengeWire }
   *   | { ok: false, kind: "invalid" | "not-allowed" | "network" | "busy-exhausted" }
   *   | { ok: false, kind: "saturated" | "throttled", retryAfterS: number }
   *   | { ok: false, kind: "unknown", status: number }
   * >}
   */
  async function login(username, password) {
    let busyAttempts = 0;
    for (;;) {
      if (stream.isClosed()) return { ok: false, kind: "network" };
      const res = await postLoginOnce(username, password);
      switch (res.kind) {
        case "ok":
          stream.resetBackoff();
          stream.openStream();
          return { ok: true, initialPassword: res.body.initialPassword === true };
        case "invalid":
          return { ok: false, kind: "invalid" };
        case "challenge":
          return { ok: false, kind: "second-factor", challenge: res.challenge };
        case "not-allowed":
          return { ok: false, kind: "not-allowed" };
        case "network":
          return { ok: false, kind: "network" };
        case "saturated":
          return { ok: false, kind: "saturated", retryAfterS: Math.ceil(res.retryAfterMs / 1000) };
        case "throttled":
          return { ok: false, kind: "throttled", retryAfterS: Math.ceil(res.retryAfterMs / 1000) };
        case "rate":
          deps.onLoginRetry?.("rate");
          await sleep(res.retryAfterMs);
          continue; // §10 错误文案: "429 E_RATE（进行中配额）⇒ Too many requests, retrying…"
        case "busy":
          busyAttempts++;
          if (busyAttempts > BUSY_RETRY_MAX) return { ok: false, kind: "busy-exhausted" };
          deps.onLoginRetry?.("busy");
          await sleep(res.retryAfterMs);
          continue; // §10: "503（不是认证失败）… 自动重试最多 5 次"
        default:
          return { ok: false, kind: "unknown", status: res.status };
      }
    }
  }

  async function logout() {
    try {
      await request(
        API.logout,
        { method: "POST", headers: { "Content-Type": "application/json", "X-PWH": "1" }, body: "{}" },
        REQUEST_TIMEOUT_MS,
      );
    } catch {
      /* best effort — the client-side state is reset regardless */
    }
    stream.closeStream();
    stream.resetBackoff();
    deps.onConn("auth");
    deps.onUnauthenticated();
  }

  /** @param {{ ok: boolean, status: number, json(): Promise<any> }} r */
  async function errorOf(r) {
    try {
      const body = await r.json();
      if (body && typeof body.error === "string") return body.error;
    } catch {
      /* non-JSON error body */
    }
    return r.status === 401 ? "E_AUTH" : `HTTP ${r.status}`;
  }

  /**
   * fleet-drawer plan §3.4/§6.5 (F5): run-endpoint error reader — like `errorOf` but ALSO keeps
   * the body's `message` as `reason` (the §3.6 denial vocabulary rides `message` on
   * `/api/run/*`). Mirrors token-client's twin 1:1 (the two transports stay independent
   * modules by design; `transport-contract.test.ts` pins behavioral parity). Reads the body
   * exactly once — never pair with `errorOf` on the same response.
   * @param {{ ok: boolean, status: number, json(): Promise<any> }} r
   * @returns {Promise<{ error: string, reason?: string }>}
   */
  async function runErrorOf(r) {
    /** @type {any} */
    let body;
    try {
      body = await r.json();
    } catch {
      body = undefined;
    }
    const b = body && typeof body === "object" ? body : {};
    const out = {
      error: typeof b.error === "string" ? b.error : r.status === 401 ? "E_AUTH" : `HTTP ${r.status}`,
    };
    if (typeof b.message === "string") out.reason = b.message;
    return out;
  }

  /** @param {string} path @param {unknown} body @param {number} [timeoutMs] @param {any} [signal] */
  function postApi(path, body, timeoutMs = REQUEST_TIMEOUT_MS, signal) {
    return request(
      path,
      { method: "POST", headers: { "Content-Type": "application/json", "X-PWH": "1" }, body: JSON.stringify(body) },
      timeoutMs,
      signal,
    );
  }

  /**
   * Bug fix: `wireFleetUi` (shared with token-mode `createClient` in app.js) unconditionally
   * calls `client.subscribe` / `client.unsubscribe` / `client.page` — this transport used to lack
   * all three, so the very first subscribe attempt threw `TypeError: client.subscribe is not a
   * function` synchronously inside `effects()`, before any `/api/subscribe` fetch was ever issued
   * and before the `.then()` that clears `sub.pending` could run, wedging the transcript at
   * "loading history…" forever with zero `/api/subscribe` or `/api/history` network activity (the
   * exception escapes to the top of the triggering SSE/click callback, invisible unless something
   * is listening for uncaught exceptions rather than `console.*` calls). No `withRelogin`/token
   * dance here (unlike app.js): password-mode 401s mean the cookie session is gone, which is
   * already surfaced via the SSE `auth` event / `probeSessionAfterClose`, not a re-login token.
   * @param {string} clientId @param {string} agentKey @returns {Promise<{ ok: true } | { ok: false, error: string }>}
   */
  async function subscribe(clientId, agentKey) {
    try {
      const r = await postApi(API.subscribe, { clientId, agentKey });
      return r.ok ? { ok: true } : { ok: false, error: await errorOf(r) };
    } catch (e) {
      return { ok: false, error: e instanceof Error ? e.message : "E_NETWORK" };
    }
  }

  /** @param {string} clientId @param {string} agentKey */
  async function unsubscribe(clientId, agentKey) {
    try {
      await postApi(API.unsubscribe, { clientId, agentKey });
    } catch {
      /* best effort */
    }
  }

  /**
   * @param {string} agentKey @param {string} before @param {number} [limit]
   * @returns {Promise<{ ok: true, data: any } | { ok: false, error: string }>}
   */
  async function page(agentKey, before, limit = 200) {
    const n = Math.max(1, Math.min(HISTORY_LIMIT_MAX, Math.floor(limit)));
    const url = `${API.history}?agent=${encodeURIComponent(agentKey)}&before=${encodeURIComponent(before)}&limit=${n}`;
    try {
      const r = await request(url, { method: "GET" }, REQUEST_TIMEOUT_MS);
      if (!r.ok) return { ok: false, error: await errorOf(r) };
      return { ok: true, data: await r.json() };
    } catch (e) {
      return { ok: false, error: e instanceof Error ? e.message : "E_NETWORK" };
    }
  }

  // -------------------------------------------------------------------------
  // run-transcript endpoints (fleet-drawer plan §3.4/§6.5, package F5). One-shot
  // `postApi`/`request` calls — no relogin dance (password mode has none): a 401 means the
  // cookie session is gone and is reported by `transport/password.ts`'s fetch wrapper via
  // `isRestAuthEndpoint` (REST_AUTH_PATHS covers both run POSTs, the prefix rule the GET).
  // -------------------------------------------------------------------------

  /**
   * POST /api/run/subscribe — 202 `{ok:true}` means the snapshot rides SSE `run_history`; the
   * §3.6 denial body's `message` is surfaced as `reason`.
   * @param {string} clientId @param {string} agentKey @param {string} runId
   * @returns {Promise<{ ok: true } | { ok: false, error: string, reason?: string }>}
   */
  async function runSubscribe(clientId, agentKey, runId) {
    try {
      const r = await postApi(API.runSubscribe, { clientId, agentKey, runId });
      if (r.ok) return { ok: true };
      return { ok: false, ...(await runErrorOf(r)) };
    } catch (e) {
      return { ok: false, error: e instanceof Error ? e.message : "E_NETWORK" };
    }
  }

  /**
   * POST /api/run/unsubscribe — fire-and-forget, failures swallowed (§6.5 table, same as
   * `unsubscribe`; a 401 still reaches `onConn("auth")` through the transport wrapper).
   * @param {string} clientId @param {string} agentKey @param {string} runId
   */
  async function runUnsubscribe(clientId, agentKey, runId) {
    try {
      await postApi(API.runUnsubscribe, { clientId, agentKey, runId });
    } catch {
      /* best effort */
    }
  }

  /**
   * GET /api/run/history (§3.4: `?agent=&run=&before=&limit=`) — one older page for a run
   * transcript; `live` is always false in the reply (the GET never attaches a tap).
   * @param {string} agentKey @param {string} runId @param {string} before @param {number} [limit]
   * @returns {Promise<{ ok: true, data: any } | { ok: false, error: string, reason?: string }>}
   */
  async function runPage(agentKey, runId, before, limit = 200) {
    const n = Math.max(1, Math.min(HISTORY_LIMIT_MAX, Math.floor(limit)));
    const url = `${API.runHistory}?agent=${encodeURIComponent(agentKey)}&run=${encodeURIComponent(runId)}&before=${encodeURIComponent(before)}&limit=${n}`;
    try {
      const r = await request(url, { method: "GET" }, REQUEST_TIMEOUT_MS);
      if (!r.ok) return { ok: false, ...(await runErrorOf(r)) };
      return { ok: true, data: await r.json() };
    } catch (e) {
      return { ok: false, error: e instanceof Error ? e.message : "E_NETWORK" };
    }
  }

  /**
   * §7.2: one-shot write endpoint, 16s budget (§3.3). No withRelogin — a 401 is a lost cookie
   * session, surfaced as `E_AUTH` for the transport wrapper to route to `onConn("auth")`.
   * @param {unknown} req @returns {Promise<import("./control.js").CmdOutcome>}
   */
  async function command(req) {
    try {
      const r = await postApi(API.cmd, req, CMD_REQUEST_TIMEOUT_MS);
      return await outcomeFromResponse(r);
    } catch (e) {
      return outcomeFromError(e);
    }
  }

  /** @param {unknown} req @returns {Promise<import("./control.js").CmdOutcome>} */
  async function dialog(req) {
    try {
      const r = await postApi(API.dialog, req, CMD_REQUEST_TIMEOUT_MS);
      return await outcomeFromResponse(r);
    } catch (e) {
      return outcomeFromError(e);
    }
  }

  // -------------------------------------------------------------------------
  // upload endpoints (web-hub-upload plan §1.2/§4.3, package U4b)
  // -------------------------------------------------------------------------

  /**
   * Upload response → outcome. Same table as `outcomeFromResponse` but keeps §1.2's
   * upload-specific fields the cmd mapping drops: a 409 `E_UPLOAD_OFFSET` body's `received`
   * (the authoritative resync offset) and the ok-body verbatim (`begin`'s `chunkBytes`/
   * `received`, `commit`'s `path`). `r.json()` is read exactly once (a real `Response` body
   * can only be consumed once).
   * @param {{ ok: boolean, status: number, headers?: { get(name: string): string | null }, json(): Promise<any> }} r
   */
  async function uploadFromResponse(r) {
    /** @type {any} */
    let body;
    try {
      body = await r.json();
    } catch {
      body = undefined;
    }
    const b = body && typeof body === "object" ? body : {};
    if (r.ok) return { ok: true, data: b };
    const out = {
      ok: false,
      error: typeof b.error === "string" ? b.error : r.status === 401 ? "E_AUTH" : `HTTP ${r.status}`,
      retryable: typeof b.retryable === "boolean" ? b.retryable : r.status === 429 || r.status >= 500,
    };
    if (typeof b.message === "string") out.message = b.message;
    const raw = typeof r.headers?.get === "function" ? r.headers.get("Retry-After") : null;
    const hn = raw === null || raw === undefined ? NaN : Number(raw);
    const ra =
      Number.isFinite(hn) && hn >= 0
        ? hn
        : typeof b.retryAfterS === "number" && b.retryAfterS >= 0
          ? b.retryAfterS
          : undefined;
    if (ra !== undefined) out.retryAfterS = ra;
    if (typeof b.received === "number" && Number.isFinite(b.received)) out.received = b.received;
    return out;
  }

  /**
   * Fetch-level failure for an upload call: timeout `E_DEADLINE` (retryable — §4.3 re-`begin`s
   * for the authoritative `received`), external abort `E_ABORT` (never retryable — the tray
   * item is being removed/retried), anything else `E_NETWORK`.
   * @param {unknown} err
   */
  function uploadFromError(err) {
    const msg = err instanceof Error ? err.message : String(err);
    if (msg === "E_DEADLINE") return { ok: false, error: "E_DEADLINE", retryable: true };
    if (msg === "E_ABORT") return { ok: false, error: "E_ABORT", retryable: false };
    return { ok: false, error: "E_NETWORK", message: msg, retryable: true };
  }

  /**
   * §4.2/§1.2: 503 `E_BUSY` (startup scan not finished, §2.2.4) retries on the existing login
   * busy backoff (`BUSY_RETRY_MAX`/`BUSY_RETRY_DEFAULT_MS`, `Retry-After` seconds when the hub
   * sends one) before the (retryable) outcome surfaces. `send` never throws; a `close()` or an
   * aborted signal ends the loop on the next attempt instead of sleeping forever.
   * @param {() => Promise<any>} send
   */
  async function uploadWithBusyRetry(send) {
    let busyAttempts = 0;
    for (;;) {
      const out = await send();
      if (!(out.ok === false && out.error === "E_BUSY")) return out;
      busyAttempts++;
      if (busyAttempts > BUSY_RETRY_MAX || stream.isClosed()) return out;
      const ms = out.retryAfterS !== undefined ? out.retryAfterS * 1000 : BUSY_RETRY_DEFAULT_MS;
      await sleep(ms);
      if (stream.isClosed()) return out; // closed during the backoff — stop hammering a dead client
    }
  }

  /**
   * The four upload endpoints (§1.2), one-shot `postApi`/`request` calls — no relogin dance
   * (password mode has none): a 401 means the cookie session is gone, surfaced BOTH as the
   * `E_AUTH` outcome and via `onConn("auth")` so `LoginView` remounts (the same signal the
   * SSE `auth` event / `probeSessionAfterClose` give; `transport/password.ts`'s fetch-wrapper
   * `REST_AUTH_PATHS` deliberately does NOT include the upload paths — firing it there too
   * would double-report). `chunk` goes through `request()` as raw `application/octet-stream`
   * bytes with the merged external abort signal so a tray remove interrupts the in-flight POST.
   */
  const upload = {
    /**
     * @param {{ agentKey: string, id: string, name: string, size: number, mime?: string }} p
     * @param {any} [signal]
     * @returns {Promise<any>}
     */
    async begin(p, signal) {
      const out = await uploadWithBusyRetry(async () => {
        try {
          return await uploadFromResponse(await postApi(API.uploadBegin, p, CMD_REQUEST_TIMEOUT_MS, signal));
        } catch (e) {
          return uploadFromError(e);
        }
      });
      if (out.ok === false && out.error === "E_AUTH") deps.onConn("auth");
      return out;
    },
    /**
     * @param {{ id: string, offset: number, bytes: Uint8Array }} p
     * @param {any} [signal]
     * @returns {Promise<any>}
     */
    async chunk(p, signal) {
      const out = await uploadWithBusyRetry(async () => {
        try {
          const url = `${API.uploadChunk}?id=${encodeURIComponent(p.id)}&offset=${p.offset}`;
          const r = await request(
            url,
            {
              method: "POST",
              headers: { "Content-Type": "application/octet-stream", "X-PWH": "1" },
              body: p.bytes,
            },
            CMD_REQUEST_TIMEOUT_MS,
            signal,
          );
          return await uploadFromResponse(r);
        } catch (e) {
          return uploadFromError(e);
        }
      });
      if (out.ok === false && out.error === "E_AUTH") deps.onConn("auth");
      return out;
    },
    /**
     * @param {{ id: string }} p
     * @param {any} [signal]
     * @returns {Promise<any>}
     */
    async commit(p, signal) {
      const out = await uploadWithBusyRetry(async () => {
        try {
          return await uploadFromResponse(await postApi(API.uploadCommit, p, CMD_REQUEST_TIMEOUT_MS, signal));
        } catch (e) {
          return uploadFromError(e);
        }
      });
      if (out.ok === false && out.error === "E_AUTH") deps.onConn("auth");
      return out;
    },
    /**
     * Best-effort cleanup (§4.2 tray removal) — no external signal: an abort endpoint call
     * must never be cancelled by the very removal that triggered it.
     * @param {{ id: string }} p
     * @returns {Promise<any>}
     */
    async abort(p) {
      const out = await uploadWithBusyRetry(async () => {
        try {
          return await uploadFromResponse(await postApi(API.uploadAbort, p, CMD_REQUEST_TIMEOUT_MS));
        } catch (e) {
          return uploadFromError(e);
        }
      });
      if (out.ok === false && out.error === "E_AUTH") deps.onConn("auth");
      return out;
    },
  };

  // -------------------------------------------------------------------------
  // headless-spawn endpoints (web-hub-spawn plan SP11 / arch §8.2–§8.3)
  // -------------------------------------------------------------------------

  /**
   * Spawn response → outcome (same table as token-client's). Keeps §8.2's spawn-specific
   * fields: a 409 `E_CONFIRM_REQUIRED` body's `resolvedCwd`/`reason`. No busy-retry wrapper —
   * spawn's 503 is `E_LAUNCHER`, a policy state the UI shows. `r.json()` is read exactly once.
   * @param {{ ok: boolean, status: number, headers?: { get(name: string): string | null }, json(): Promise<any> }} r
   */
  async function spawnFromResponse(r) {
    /** @type {any} */
    let body;
    try {
      body = await r.json();
    } catch {
      body = undefined;
    }
    const b = body && typeof body === "object" ? body : {};
    if (r.ok) return { ok: true, data: b, status: r.status };
    /** @type {any} */
    const out = {
      ok: false,
      error: typeof b.error === "string" ? b.error : r.status === 401 ? "E_AUTH" : `HTTP ${r.status}`,
      retryable: typeof b.retryable === "boolean" ? b.retryable : r.status === 429 || r.status >= 500,
      status: r.status,
    };
    if (typeof b.message === "string") out.message = b.message;
    const raw = typeof r.headers?.get === "function" ? r.headers.get("Retry-After") : null;
    const hn = raw === null || raw === undefined ? NaN : Number(raw);
    const ra =
      Number.isFinite(hn) && hn >= 0
        ? hn
        : typeof b.retryAfterS === "number" && b.retryAfterS >= 0
          ? b.retryAfterS
          : undefined;
    if (ra !== undefined) out.retryAfterS = ra;
    if (typeof b.resolvedCwd === "string") out.resolvedCwd = b.resolvedCwd;
    if (typeof b.reason === "string") out.reason = b.reason;
    // created-dirs plan r2 §4: the LAN-only E_DIR cause (additive — a pre-feature hub
    // simply never sends it; unknown values ride through, the UI maps/falls back).
    if (typeof b.detail === "string") out.detail = b.detail;
    return out;
  }

  /**
   * Fetch-level failure for a spawn call (same table as token-client's): timeout `E_DEADLINE`
   * (retryable — §3.2 resends the SAME id once; the hub's idempotency LRU dedupes it into
   * `dup:true`), external abort `E_ABORT` (never retryable), anything else `E_NETWORK`.
   * @param {unknown} err
   */
  function spawnFromError(err) {
    const msg = err instanceof Error ? err.message : String(err);
    if (msg === "E_DEADLINE") return { ok: false, error: "E_DEADLINE", retryable: true, status: 0 };
    if (msg === "E_ABORT") return { ok: false, error: "E_ABORT", retryable: false, status: 0 };
    return { ok: false, error: "E_NETWORK", message: msg, retryable: true, status: 0 };
  }

  /**
   * default-model plan F1 (D1): narrow `GET /api/headless`'s optional `prefs` slot (same rule
   * as token-client's — only a well-formed `{defaultModel: string|null}` rides through).
   * @param {any} d
   */
  function narrowPrefs(d) {
    const p = d !== null && typeof d === "object" ? d.prefs : undefined;
    if (p === null || typeof p !== "object") return {};
    return { prefs: { defaultModel: typeof p.defaultModel === "string" ? p.defaultModel : null } };
  }

  /**
   * The four `/api/headless*` endpoints (arch §8.2), one-shot `postApi`/`request` calls — no
   * relogin dance (password mode has none). Unlike the upload namespace above, a 401 does NOT
   * call `deps.onConn("auth")` here: `transport/password.ts`'s fetch-wrapper `REST_AUTH_PATHS`
   * covers the headless paths (firing here too would double-report). The GETs carry `X-PWH: 1`
   * (arch §8.2's CSRF gate requires it on reads too). 404s ride back verbatim — arch §8.3: a
   * list 404 means "feature off / LAN `lan:\"off\"`", not an error.
   */
  const spawn = {
    /** @returns {Promise<any>} */
    async list() {
      try {
        const r = await request(API.headless, { method: "GET", headers: { "X-PWH": "1" } }, REQUEST_TIMEOUT_MS);
        const out = await spawnFromResponse(r);
        if (out.ok === false) return { ok: false, error: out.error, status: out.status };
        const d = out.data;
        return { ok: true, policy: d.policy, items: Array.isArray(d.items) ? d.items : [], ...narrowPrefs(d) };
      } catch (e) {
        return spawnFromError(e);
      }
    },
    /** @returns {Promise<any>} */
    async dirs() {
      try {
        const r = await request(API.headlessDirs, { method: "GET", headers: { "X-PWH": "1" } }, REQUEST_TIMEOUT_MS);
        const out = await spawnFromResponse(r);
        if (out.ok === false) return { ok: false, error: out.error, status: out.status };
        const d = out.data;
        return {
          ok: true,
          recent: Array.isArray(d.recent) ? d.recent : [],
          ...(d.partial === true ? { partial: true } : {}),
        };
      } catch (e) {
        return spawnFromError(e);
      }
    },
    /** @param {unknown} req @returns {Promise<any>} */
    async start(req) {
      try {
        const r = await postApi(API.headless, req, CMD_REQUEST_TIMEOUT_MS);
        const out = await spawnFromResponse(r);
        if (out.ok === true) return { ok: true, data: out.data };
        const { status: _status, ...rest } = out;
        return rest;
      } catch (e) {
        const { status: _status, ...rest } = spawnFromError(e);
        return rest;
      }
    },
    /** @param {string} spawnId @param {boolean} [force] @returns {Promise<any>} */
    async stop(spawnId, force) {
      try {
        const r = await postApi(
          `${API.headless}/${encodeURIComponent(spawnId)}/stop`,
          force === true ? { force: true } : {},
          CMD_REQUEST_TIMEOUT_MS,
        );
        const out = await spawnFromResponse(r);
        if (out.ok === false) return { ok: false, error: out.error };
        const d = out.data;
        return { ok: true, state: typeof d.state === "string" ? d.state : "stopping" };
      } catch (e) {
        return { ok: false, error: spawnFromError(e).error };
      }
    },
    /**
     * default-model plan F1 (§3 ④): `POST /api/headless/prefs`, one-shot like the rest of this
     * client's spawn surface (the `isRestAuthEndpoint` wrapper covers `/api/headless*` — a 401
     * is reported there, never here). `""` clears; 200 `{prefs}` rides back (narrowed).
     * @param {string} defaultModel @returns {Promise<any>}
     */
    async setPrefs(defaultModel) {
      try {
        const r = await postApi(API.headlessPrefs, { defaultModel }, CMD_REQUEST_TIMEOUT_MS);
        const out = await spawnFromResponse(r);
        if (out.ok === false) {
          const { status: _status, ...rest } = out;
          return rest;
        }
        const p = out.data && typeof out.data.prefs === "object" && out.data.prefs !== null ? out.data.prefs : {};
        return { ok: true, prefs: { defaultModel: typeof p.defaultModel === "string" ? p.defaultModel : null } };
      } catch (e) {
        const { status: _status, ...rest } = spawnFromError(e);
        return rest;
      }
    },
    /**
     * session-history plan §4.7.1: `GET /api/headless/history` — the SAME wire behavior as the
     * token client's `spawn.history` (the shared `historyOutcomeFromResponse` helper does the
     * narrowing + error mapping; `transport-contract.test.ts` pins the two identical). One-shot
     * like the rest of this client's spawn surface: a 401 is reported by the
     * `isRestAuthEndpoint` fetch wrapper (`/api/headless*` prefix covers `/history`), never here.
     * @param {{ q?: string, kind?: "main" | "all", cursor?: string, limit?: number }} q
     * @returns {Promise<any>}
     */
    async history(q) {
      const params = new URLSearchParams();
      if (typeof q?.q === "string" && q.q.trim() !== "") params.set("q", q.q.trim());
      if (q?.kind === "all") params.set("kind", "all");
      if (typeof q?.cursor === "string" && q.cursor !== "") params.set("cursor", q.cursor);
      if (typeof q?.limit === "number" && Number.isFinite(q.limit)) params.set("limit", String(q.limit));
      const url = `${API.headless}/history${params.size > 0 ? `?${params.toString()}` : ""}`;
      try {
        const r = await request(url, { method: "GET", headers: { "X-PWH": "1" } }, REQUEST_TIMEOUT_MS);
        return await historyOutcomeFromResponse(r);
      } catch (e) {
        return { ok: false, error: spawnFromError(e).error, status: 0 };
      }
    },
    /**
     * spawn-dirmkdir: `POST /api/headless/mkdir` — the SAME wire behavior as the token
     * client's `spawn.mkdir` (`transport-contract.test.ts` pins the two identical). One-shot
     * like the rest of this client's spawn surface: a 401 is reported by the
     * `isRestAuthEndpoint` fetch wrapper (`/api/headless*` prefix covers `/mkdir`), never here.
     * @param {string} path @param {string} name @returns {Promise<any>}
     */
    async mkdir(path, name) {
      try {
        const r = await postApi(API.headlessMkdir, { path, name }, CMD_REQUEST_TIMEOUT_MS);
        const out = await spawnFromResponse(r);
        if (out.ok === false) {
          /** @type {any} */
          const err = { ok: false, error: out.error, status: out.status };
          if (typeof out.reason === "string") err.reason = out.reason;
          if (typeof out.retryAfterS === "number") err.retryAfterS = out.retryAfterS;
          return err;
        }
        const d = out.data;
        // created-dirs plan r2 §4: `known:true` rides only when the hub sent exactly that
        // (same rule as the token client — transport-contract.test.ts pins the two identical).
        return {
          ok: true,
          path: typeof d.path === "string" ? d.path : "",
          ...(d.known === true ? { known: true } : {}),
        };
      } catch (e) {
        const { retryable: _retryable, ...rest } = spawnFromError(e);
        return rest;
      }
    },
    /**
     * spawn-relaunch: `POST /api/headless/relaunch` — the SAME wire behavior as the token
     * client's `spawn.relaunch` (`transport-contract.test.ts` pins the two identical).
     * One-shot like the rest of this client's spawn surface: a 401 is reported by the
     * `isRestAuthEndpoint` fetch wrapper (`/api/headless*` prefix covers `/relaunch`), never
     * here. The hub's relaunch is idempotent on a non-terminal record (`dup:true`).
     * @param {string} spawnId @returns {Promise<any>}
     */
    async relaunch(spawnId) {
      try {
        const r = await postApi(API.headlessRelaunch, { spawnId }, CMD_REQUEST_TIMEOUT_MS);
        const out = await spawnFromResponse(r);
        if (out.ok === false) {
          /** @type {any} */
          const err = { ok: false, error: out.error, status: out.status };
          if (typeof out.reason === "string") err.reason = out.reason;
          if (typeof out.message === "string") err.message = out.message;
          if (typeof out.retryAfterS === "number") err.retryAfterS = out.retryAfterS;
          return err;
        }
        const d = out.data;
        return {
          ok: true,
          spawnId: typeof d.spawnId === "string" ? d.spawnId : spawnId,
          state: typeof d.state === "string" ? d.state : "starting",
          ...(d.dup === true ? { dup: true } : {}),
        };
      } catch (e) {
        const { retryable: _retryable, ...rest } = spawnFromError(e);
        return rest;
      }
    },
  };

  // -------------------------------------------------------------------------
  // card removal (web-hub-delete-session plan v2 §4.1/§5.3): POST /api/agents/remove, one-shot
  // like `spawn.stop` above (password mode has no relogin dance; a 401 is reported by the
  // `isRestAuthEndpoint` fetch wrapper in `transport/password.ts`, never fired here).
  // -------------------------------------------------------------------------

  /**
   * @param {{agentKey: string} | {spawnId: string}} target
   * @returns {Promise<any>}
   */
  async function removeAgent(target) {
    try {
      const r = await postApi(API.agentRemove, target, CMD_REQUEST_TIMEOUT_MS);
      const out = await spawnFromResponse(r);
      if (out.ok === false) {
        /** @type {any} */
        const err = { ok: false, error: out.error };
        if (typeof out.message === "string") err.message = out.message;
        if (typeof out.reason === "string") err.reason = out.reason;
        if (typeof out.retryAfterS === "number") err.retryAfterS = out.retryAfterS;
        return err;
      }
      const d = out.data;
      /** @type {any} */
      const ok = { ok: true, removed: d.removed === true };
      if (d.pending === true) ok.pending = true;
      if (typeof d.spawnId === "string") ok.spawnId = d.spawnId;
      return ok;
    } catch (e) {
      return { ok: false, error: spawnFromError(e).error };
    }
  }

  /**
   * plan §10 review fix (lan-plan.md §15.9 #8): an SSE stream that goes CLOSED is ambiguous
   * between “not signed in” (401) and “hub momentarily busy / network hiccup” (503, or the probe
   * request itself failing) — both fail the browser's EventSource with no retry, indistinguishable
   * from `error` alone. Probe `GET /api/session` first: 200 ⇒ the session is still good (keep the
   * current page, just re-open the stream on the normal backoff schedule); 401 ⇒ genuinely signed
   * out (show the form); 503 / network error ⇒ keep the current page state as-is (no login form,
   * no `onConn("auth")`) and re-probe after a fixed backoff, bounded by `CLOSE_PROBE_MAX` attempts
   * before falling back to the ordinary stream-reopen loop (which will re-enter this same probe if
   * the stream goes CLOSED again — so the overall retry never truly stops, it just stops busy-
   * looping the probe itself).
   * @param {any} source
   */
  async function probeSessionAfterClose(source) {
    for (let attempt = 1; ; attempt++) {
      if (stream.isClosed() || !stream.currentIs(source)) return; // superseded by a newer stream, logout, or close()
      /** @type {"ok" | "unauthenticated" | "busy" | "network"} */
      let outcome;
      try {
        const r = await request(API.session, { method: "GET" }, REQUEST_TIMEOUT_MS);
        outcome = r.status === 401 ? "unauthenticated" : r.ok ? "ok" : "busy";
      } catch {
        outcome = "network";
      }
      if (stream.isClosed() || !stream.currentIs(source)) return;
      if (outcome === "ok") {
        deps.onConn("reconnecting");
        stream.scheduleReopen();
        return;
      }
      if (outcome === "unauthenticated") {
        stream.clearCurrent();
        deps.onConn("auth");
        deps.onUnauthenticated();
        stream.scheduleReopen(); // picks a freshly-authenticated cookie back up (e.g. signed in from another tab)
        return;
      }
      // "busy" (503) or "network": keep the current page state, re-probe after a bounded backoff.
      if (attempt >= CLOSE_PROBE_MAX) {
        stream.scheduleReopen();
        return;
      }
      await sleep(CLOSE_PROBE_BACKOFF_MS);
    }
  }

  // -------------------------------------------------------------------------
  // content-preview endpoint (web-hub-preview plan v3 §3.2/§4.6, package PV4)
  // -------------------------------------------------------------------------

  /**
   * chunked-plan §4.1 (P2a): normalize `req.chunk` (`true` = first chunk, `{offset, ident}`
   * = continuation) into the query suffix + the `checkPreviewHeaders` gate object. `chunk`
   * combined with `dir` is a protocol violation (§2.2 mutual exclusion) rejected LOCALLY
   * with `E_BAD_REQUEST` — never sent. A malformed chunk object (non-integer/negative
   * offset, invalid ident) is rejected the same way; the hub would 400 it anyway. Mirrors
   * the token client's helper verbatim (the two transports stay independent modules;
   * `transport-contract.test.ts` pins identical behavior).
   * @param {{ dir?: true, chunk?: true | { offset: number, ident: string } }} req
   * @returns {{ suffix: string, gate?: { offset: number, ident?: string } } | { badRequest: true }}
   */
  function previewChunkPart(req) {
    const chunk = req.chunk;
    if (chunk === undefined) return { suffix: "" };
    if (req.dir === true) return { badRequest: true };
    if (chunk === true) return { suffix: `&${PREVIEW_CHUNK_QUERY}=1`, gate: { offset: 0 } };
    if (
      chunk !== null &&
      typeof chunk === "object" &&
      Number.isSafeInteger(chunk.offset) &&
      chunk.offset >= 0 &&
      validatePreviewIdent(chunk.ident)
    ) {
      return {
        suffix: `&${PREVIEW_CHUNK_QUERY}=1&${PREVIEW_OFFSET_QUERY}=${chunk.offset}&${PREVIEW_IDENT_QUERY}=${encodeURIComponent(chunk.ident)}`,
        gate: { offset: chunk.offset, ident: chunk.ident },
      };
    }
    return { badRequest: true };
  }

  /**
   * `GET /api/preview` (§4.6) — same flow as the token client's, minus the relogin dance
   * (password mode has none; a 401 means the cookie session is gone and is reported by
   * `transport/password.ts`'s fetch wrapper via `isRestAuthEndpoint`, which covers
   * `/api/preview`). Header-driven pre-body gate (`checkPreviewHeaders`, LAN 4 MiB image
   * cap), one 40s deadline (`PREVIEW_CLIENT_TIMEOUT_MS`) spanning headers AND body, merged
   * with the caller's `signal`; an incomplete body ⇒ `E_PREVIEW_CHANGED` (§4.5.2: the hub
   * `destroy()`s a mid-stream identity/hash failure).
   *
   * dir-plan §5 P2: `req.dir === true` appends `&dir=1` and unlocks the `Kind: dir` response
   * — a capped JSON read under the SAME 40s deadline (never beyond
   * `PREVIEW_DIR_BODY_MAX_BYTES` DECODED bytes — gzip included, the cap never judges
   * Content-Length), then `parsePreviewDirListing` is the contract gate. An un-opt-in-ed
   * request receiving `Kind: dir` fails `checkPreviewHeaders` (`E_BAD_RESPONSE`, §1.3's fetch
   * path — a single-response contract violation, body aborted unread).
   * @param {{ agentKey: string, sessionId: string, path: string, dir?: true,
   *   chunk?: true | { offset: number, ident: string } }} req
   * @param {{ signal?: any, maxPixels?: number }} [opts]
   * @returns {Promise<any>}
   */
  async function previewFetch(req, opts) {
    const signal = opts !== undefined ? opts.signal : undefined;
    const maxPixels = opts !== undefined && typeof opts.maxPixels === "number" ? opts.maxPixels : undefined;
    if (signal !== undefined && signal !== null && signal.aborted === true) {
      return { ok: false, status: 0, error: "E_ABORT" };
    }
    const chunkPart = previewChunkPart(req);
    if ("badRequest" in chunkPart) return { ok: false, status: 0, error: "E_BAD_REQUEST" };
    const url = `${API.preview}?agentKey=${encodeURIComponent(req.agentKey)}&sessionId=${encodeURIComponent(req.sessionId)}&path=${encodeURIComponent(req.path)}${req.dir === true ? "&dir=1" : ""}${chunkPart.suffix}`;
    const AC = deps.AbortController ?? (typeof AbortController === "function" ? AbortController : undefined);
    const ac = AC ? new AC() : undefined;
    let expired = false;
    /** @type {any} */
    let deadlineTimer = null;
    /** @type {Promise<never>} */
    const deadline = new Promise((_, reject) => {
      deadlineTimer = timer(() => {
        expired = true;
        ac?.abort();
        reject(new Error("E_DEADLINE"));
      }, PREVIEW_CLIENT_TIMEOUT_MS);
    });
    /** @type {(() => void) | null} */
    let onExternalAbort = null;
    if (signal && typeof signal.addEventListener === "function") {
      onExternalAbort = () => ac?.abort();
      signal.addEventListener("abort", onExternalAbort, { once: true });
    }
    /** Fetch-level failure ⇒ local code (status 0): the caller's abort, our own deadline, or network. @param {unknown} e */
    const fromError = (e) => {
      if (signal && signal.aborted === true) return { ok: false, status: 0, error: "E_ABORT" };
      if (expired || (e instanceof Error && e.message === "E_DEADLINE"))
        return { ok: false, status: 0, error: "E_DEADLINE" };
      return { ok: false, status: 0, error: "E_NETWORK" };
    };
    try {
      /** @type {any} */
      let r;
      try {
        r = await Promise.race([
          deps.fetch(url, {
            credentials: "same-origin",
            method: "GET",
            headers: { "X-PWH": "1" },
            ...(ac ? { signal: ac.signal } : {}),
          }),
          deadline,
        ]);
      } catch (e) {
        return fromError(e);
      }
      if (!r.ok) return await previewOutcomeFromResponse(r);
      const chk = checkPreviewHeaders(r.headers, {
        imageMaxBytes: PREVIEW_IMAGE_MAX_BYTES.lan,
        ...(maxPixels !== undefined ? { maxPixels } : {}),
        dir: req.dir === true,
        ...(chunkPart.gate !== undefined ? { chunk: chunkPart.gate } : {}),
      });
      if (!chk.ok) {
        // Pre-body refusal: abort so the server stops sending, never touch the body.
        ac?.abort();
        return { ok: false, status: 0, ...chk };
      }
      if (chk.kind === "dir") {
        // dir-plan §5 P2: a dir body is capped-and-parsed JSON, not a length-oracled byte
        // stream — read it under the SAME 40s deadline, never beyond
        // PREVIEW_DIR_BODY_MAX_BYTES decoded bytes (gzip included: the cap judges decoded
        // bytes, never Content-Length). With a streaming body use the reader and count as the
        // chunks arrive (aborting the fetch the moment the cap trips); without one read the
        // whole ArrayBuffer first and check its byteLength after.
        /** @type {any} */
        let parsed;
        let byteLength = 0;
        try {
          const body = r.body;
          if (body && typeof body.getReader === "function") {
            const reader = body.getReader();
            /** @type {Uint8Array[]} */
            const chunks = [];
            for (;;) {
              const step = await Promise.race([reader.read(), deadline]);
              if (step.done === true) break;
              const chunk = step.value;
              const len = chunk && typeof chunk.byteLength === "number" ? chunk.byteLength : 0;
              byteLength += len;
              if (byteLength > PREVIEW_DIR_BODY_MAX_BYTES) {
                ac?.abort(); // stop the server sending any more of an over-budget body
                return { ok: false, status: 0, error: "E_BAD_RESPONSE" };
              }
              chunks.push(chunk);
            }
            const merged = new Uint8Array(byteLength);
            let off = 0;
            for (const c of chunks) {
              merged.set(c, off);
              off += c.byteLength;
            }
            parsed = JSON.parse(new TextDecoder().decode(merged));
          } else {
            const buf = await Promise.race([r.arrayBuffer(), deadline]);
            byteLength = buf && typeof buf.byteLength === "number" ? buf.byteLength : 0;
            if (byteLength > PREVIEW_DIR_BODY_MAX_BYTES) return { ok: false, status: 0, error: "E_BAD_RESPONSE" };
            parsed = JSON.parse(new TextDecoder().decode(buf));
          }
        } catch (e) {
          if (signal && signal.aborted === true) return { ok: false, status: 0, error: "E_ABORT" };
          if (expired || (e instanceof Error && e.message === "E_DEADLINE"))
            return { ok: false, status: 0, error: "E_DEADLINE" };
          return { ok: false, status: 0, error: "E_BAD_RESPONSE" }; // undecodable / non-JSON body
        }
        if (signal && signal.aborted === true) return { ok: false, status: 0, error: "E_ABORT" };
        const listing = parsePreviewDirListing(parsed, byteLength);
        if (listing === null) return { ok: false, status: 0, error: "E_BAD_RESPONSE" };
        return { ok: true, kind: "dir", listing };
      }
      /** @type {any} */
      let buf;
      try {
        buf = await Promise.race([r.arrayBuffer(), deadline]);
      } catch (e) {
        return fromError(e);
      }
      if (signal && signal.aborted === true) return { ok: false, status: 0, error: "E_ABORT" };
      if (!buf || typeof buf.byteLength !== "number" || buf.byteLength !== chk.size) {
        return { ok: false, status: r.status, error: "E_PREVIEW_CHANGED" };
      }
      if (chk.kind === "image") {
        return {
          ok: true,
          kind: "image",
          mime: chk.mime,
          size: chk.size,
          dims: chk.dims,
          blob: new Blob([buf], { type: chk.mime }),
        };
      }
      return {
        ok: true,
        kind: "text",
        size: chk.totalSize,
        truncated: chk.truncated,
        // chunked-plan §4.1: `bytes` = this response's decoded body bytes (valid against old
        // hubs too — the truncated-copy fix depends on it); `chunk` rides only when the
        // header gate accepted the offset/ident echo.
        bytes: chk.size,
        text: new TextDecoder().decode(buf),
        ...(chk.chunk !== undefined ? { chunk: chk.chunk } : {}),
      };
    } finally {
      deps.clearTimeout(deadlineTimer);
      if (onExternalAbort !== null && signal && typeof signal.removeEventListener === "function") {
        signal.removeEventListener("abort", onExternalAbort);
      }
    }
  }

  /**
   * `POST /api/preview/probe` (2026-10-07 修订「先探测后标记」) — same flow as the token
   * client's, minus the relogin dance (password mode has none; a 401 means the cookie
   * session is gone and is reported by `transport/password.ts`'s fetch wrapper via
   * `isRestAuthEndpoint`, which covers `/api/preview/probe` — it prefixes `/api/preview`).
   * ONE request for a whole message's candidates; 5s deadline (`PREVIEW_PROBE_CLIENT_TIMEOUT_MS`)
   * spanning headers+body, merged with the caller's `signal`; the 200 body is validated by
   * `parseProbeResults` and any deviation maps to a local `E_BAD_RESPONSE`.
   *
   * dir-plan §1.3/§5 P2: `req.dirs === true` adds `dirs:true` to the JSON body (directories
   * then answer `"dir"`); a dirs-LESS request that still receives `"dir"` folds that ENTRY
   * to `"missing"` — a version mismatch is entry-level, and for this client the click
   * genuinely could not succeed (it never sends `dir=1`), which is exactly probe `missing`'s
   * definition. A whole-batch `E_BAD_RESPONSE` would degrade every candidate for one bad
   * entry — deliberately NOT taken here.
   * @param {{ agentKey: string, sessionId: string, paths: readonly string[], dirs?: true, files?: true }} req
   * @param {{ signal?: any }} [opts]
   * @returns {Promise<any>}
   */
  async function probePost(req, opts) {
    const signal = opts !== undefined ? opts.signal : undefined;
    if (signal !== undefined && signal !== null && signal.aborted === true) {
      return { ok: false, status: 0, error: "E_ABORT" };
    }
    const dirs = req.dirs === true;
    // preview-download: same opt-in discipline as `dirs` — literal true only.
    const files = req.files === true;
    const url = `${API.previewProbe}?agentKey=${encodeURIComponent(req.agentKey)}&sessionId=${encodeURIComponent(req.sessionId)}`;
    const AC = deps.AbortController ?? (typeof AbortController === "function" ? AbortController : undefined);
    const ac = AC ? new AC() : undefined;
    let expired = false;
    /** @type {any} */
    let deadlineTimer = null;
    /** @type {Promise<never>} */
    const deadline = new Promise((_, reject) => {
      deadlineTimer = timer(() => {
        expired = true;
        ac?.abort();
        reject(new Error("E_DEADLINE"));
      }, PREVIEW_PROBE_CLIENT_TIMEOUT_MS);
    });
    /** @type {(() => void) | null} */
    let onExternalAbort = null;
    if (signal && typeof signal.addEventListener === "function") {
      onExternalAbort = () => ac?.abort();
      signal.addEventListener("abort", onExternalAbort, { once: true });
    }
    /** Fetch-level failure ⇒ local code (status 0). @param {unknown} e */
    const fromError = (e) => {
      if (signal && signal.aborted === true) return { ok: false, status: 0, error: "E_ABORT" };
      if (expired || (e instanceof Error && e.message === "E_DEADLINE"))
        return { ok: false, status: 0, error: "E_DEADLINE" };
      return { ok: false, status: 0, error: "E_NETWORK" };
    };
    try {
      /** @type {any} */
      let r;
      try {
        r = await Promise.race([
          deps.fetch(url, {
            credentials: "same-origin",
            method: "POST",
            headers: { "Content-Type": "application/json", "X-PWH": "1" },
            body: JSON.stringify({
              paths: req.paths,
              ...(dirs ? { dirs: true } : {}),
              ...(files ? { files: true } : {}),
            }),
            ...(ac ? { signal: ac.signal } : {}),
          }),
          deadline,
        ]);
      } catch (e) {
        return fromError(e);
      }
      if (!r.ok) {
        const o = await previewOutcomeFromResponse(r);
        /** @type {any} */
        const out = { ok: false, status: o.status, error: o.error };
        if (typeof o.retryAfterS === "number") out.retryAfterS = o.retryAfterS;
        return out;
      }
      /** @type {any} */
      let body;
      try {
        body = await Promise.race([r.json(), deadline]);
      } catch (e) {
        return fromError(e);
      }
      if (signal && signal.aborted === true) return { ok: false, status: 0, error: "E_ABORT" };
      const parsed = parseProbeResults(body, req.paths.length);
      if (!parsed.ok) return { ok: false, status: 0, error: parsed.error };
      // dir-plan §1.3 single fold point: dirs-less + "dir" ⇒ per-entry "missing".
      // preview-download mirrors it: files-less + "file" ⇒ per-entry "missing".
      const kinds = parsed.kinds.map((k) => ((!dirs && k === "dir") || (!files && k === "file") ? "missing" : k));
      return { ok: true, results: kinds };
    } finally {
      deps.clearTimeout(deadlineTimer);
      if (onExternalAbort !== null && signal && typeof signal.removeEventListener === "function") {
        signal.removeEventListener("abort", onExternalAbort);
      }
    }
  }

  /**
   * web-hub-html-preview plan v2 §2.1/§5 (P2): `POST /api/preview/html-cap?agentKey=&sessionId=` —
   * the password-mode twin of the token client's `htmlCapPost` (§4.6's shared-wire rule:
   * `transport-contract.test.ts` pins the two identical). One-shot like the rest of this
   * client — a mint is NOT idempotent (§0: every mint is a new cap), so nothing retries; a
   * 401 is a lost cookie session, reported by `transport/password.ts`'s fetch wrapper via
   * `isRestAuthEndpoint` (its `/api/preview` prefix covers the mint path). 8 s deadline
   * (`PREVIEW_ADMIT_TOTAL_MS`, the hub's own mint budget); the 200 body is the protocol's
   * `PreviewHtmlCapResponseBody`, structurally validated (`url` `/pv/`-prefixed, `openUrl`
   * `/pvw/`-prefixed, `idleMs`/`hardRemainingMs` finite ≥ 0) — any deviation ⇒ local
   * `E_BAD_RESPONSE`. Non-200 bodies ride `previewOutcomeFromResponse` (a 403
   * `E_PREVIEW_DENIED{reason}` keeps its `reason` verbatim).
   * @param {{ agentKey: string, sessionId: string, path: string }} req
   * @param {{ signal?: any }} [opts]
   * @returns {Promise<any>}
   */
  async function htmlCapPost(req, opts) {
    const signal = opts !== undefined ? opts.signal : undefined;
    if (signal !== undefined && signal !== null && signal.aborted === true) {
      return { ok: false, status: 0, error: "E_ABORT" };
    }
    const url = `${API.previewHtmlCap}?agentKey=${encodeURIComponent(req.agentKey)}&sessionId=${encodeURIComponent(req.sessionId)}`;
    const AC = deps.AbortController ?? (typeof AbortController === "function" ? AbortController : undefined);
    const ac = AC ? new AC() : undefined;
    let expired = false;
    /** @type {any} */
    let deadlineTimer = null;
    /** @type {Promise<never>} */
    const deadline = new Promise((_, reject) => {
      deadlineTimer = timer(() => {
        expired = true;
        ac?.abort();
        reject(new Error("E_DEADLINE"));
      }, PREVIEW_ADMIT_TOTAL_MS);
    });
    /** @type {(() => void) | null} */
    let onExternalAbort = null;
    if (signal && typeof signal.addEventListener === "function") {
      onExternalAbort = () => ac?.abort();
      signal.addEventListener("abort", onExternalAbort, { once: true });
    }
    /** Fetch-level failure ⇒ local code (status 0). @param {unknown} e */
    const fromError = (e) => {
      if (signal && signal.aborted === true) return { ok: false, status: 0, error: "E_ABORT" };
      if (expired || (e instanceof Error && e.message === "E_DEADLINE"))
        return { ok: false, status: 0, error: "E_DEADLINE" };
      return { ok: false, status: 0, error: "E_NETWORK" };
    };
    try {
      /** @type {any} */
      let r;
      try {
        r = await Promise.race([
          deps.fetch(url, {
            credentials: "same-origin",
            method: "POST",
            headers: { "Content-Type": "application/json", "X-PWH": "1" },
            body: JSON.stringify({ path: req.path }),
            ...(ac ? { signal: ac.signal } : {}),
          }),
          deadline,
        ]);
      } catch (e) {
        return fromError(e);
      }
      if (!r.ok) {
        const o = await previewOutcomeFromResponse(r);
        /** @type {any} */
        const out = { ok: false, status: o.status, error: o.error };
        if (typeof o.reason === "string") out.reason = o.reason;
        if (typeof o.retryAfterS === "number") out.retryAfterS = o.retryAfterS;
        return out;
      }
      /** @type {any} */
      let body;
      try {
        body = await Promise.race([r.json(), deadline]);
      } catch (e) {
        return fromError(e);
      }
      if (signal && signal.aborted === true) return { ok: false, status: 0, error: "E_ABORT" };
      const b = body !== null && typeof body === "object" ? body : {};
      if (
        typeof b.url !== "string" ||
        !b.url.startsWith("/pv/") ||
        typeof b.openUrl !== "string" ||
        !b.openUrl.startsWith("/pvw/") ||
        typeof b.idleMs !== "number" ||
        !Number.isFinite(b.idleMs) ||
        b.idleMs < 0 ||
        typeof b.hardRemainingMs !== "number" ||
        !Number.isFinite(b.hardRemainingMs) ||
        b.hardRemainingMs < 0
      ) {
        return { ok: false, status: 0, error: "E_BAD_RESPONSE" };
      }
      return { ok: true, url: b.url, openUrl: b.openUrl, idleMs: b.idleMs, hardRemainingMs: b.hardRemainingMs };
    } finally {
      deps.clearTimeout(deadlineTimer);
      if (onExternalAbort !== null && signal && typeof signal.removeEventListener === "function") {
        signal.removeEventListener("abort", onExternalAbort);
      }
    }
  }

  /**
   * preview-download: `GET /api/preview?download=1` — the SAME wire behavior as the token
   * client's `previewDownload` (`transport-contract.test.ts` pins the two identical),
   * one-shot like the rest of this client (a 401 is reported by the
   * `isRestAuthEndpoint` fetch wrapper, which covers `/api/preview`).
   * @param {{ agentKey: string, sessionId: string, path: string }} req
   * @param {{ signal?: any }} [opts]
   * @returns {Promise<any>}
   */
  async function previewDownload(req, opts) {
    const signal = opts !== undefined ? opts.signal : undefined;
    if (signal !== undefined && signal !== null && signal.aborted === true) {
      return { ok: false, status: 0, error: "E_ABORT" };
    }
    const url = `${API.preview}?agentKey=${encodeURIComponent(req.agentKey)}&sessionId=${encodeURIComponent(req.sessionId)}&path=${encodeURIComponent(req.path)}&download=1`;
    const AC = deps.AbortController ?? (typeof AbortController === "function" ? AbortController : undefined);
    const ac = AC ? new AC() : undefined;
    let expired = false;
    /** @type {any} */
    let deadlineTimer = null;
    /** @type {Promise<never>} */
    const deadline = new Promise((_, reject) => {
      deadlineTimer = timer(() => {
        expired = true;
        ac?.abort();
        reject(new Error("E_DEADLINE"));
      }, PREVIEW_DOWNLOAD_CLIENT_TIMEOUT_MS);
    });
    /** @type {(() => void) | null} */
    let onExternalAbort = null;
    if (signal && typeof signal.addEventListener === "function") {
      onExternalAbort = () => ac?.abort();
      signal.addEventListener("abort", onExternalAbort, { once: true });
    }
    /** @param {unknown} e */
    const fromError = (e) => {
      if (signal && signal.aborted === true) return { ok: false, status: 0, error: "E_ABORT" };
      if (expired || (e instanceof Error && e.message === "E_DEADLINE"))
        return { ok: false, status: 0, error: "E_DEADLINE" };
      return { ok: false, status: 0, error: "E_NETWORK" };
    };
    try {
      /** @type {any} */
      let r;
      try {
        r = await Promise.race([
          deps.fetch(url, {
            credentials: "same-origin",
            method: "GET",
            headers: { "X-PWH": "1" },
            ...(ac ? { signal: ac.signal } : {}),
          }),
          deadline,
        ]);
      } catch (e) {
        return fromError(e);
      }
      if (!r.ok) return await previewOutcomeFromResponse(r);
      const chk = checkPreviewHeaders(r.headers, { download: true });
      if (!chk.ok) {
        ac?.abort(); // pre-body refusal — never pull the bytes of an out-of-contract response
        return { ok: false, status: 0, ...chk };
      }
      /** @type {any} */
      let buf;
      try {
        buf = await Promise.race([r.arrayBuffer(), deadline]);
      } catch (e) {
        return fromError(e);
      }
      if (signal && signal.aborted === true) return { ok: false, status: 0, error: "E_ABORT" };
      if (!buf || typeof buf.byteLength !== "number" || buf.byteLength !== chk.size) {
        return { ok: false, status: r.status, error: "E_PREVIEW_CHANGED" };
      }
      return {
        ok: true,
        kind: "download",
        size: chk.size,
        blob: new Blob([buf], { type: "application/octet-stream" }),
      };
    } finally {
      deps.clearTimeout(deadlineTimer);
      if (onExternalAbort !== null && signal && typeof signal.removeEventListener === "function") {
        signal.removeEventListener("abort", onExternalAbort);
      }
    }
  }

  const preview = { fetch: previewFetch, probe: probePost, download: previewDownload, htmlCap: htmlCapPost };

  // -------------------------------------------------------------------------
  // worktree-diff endpoints (worktree-diff plan v3.1 §1.2/§4.6, package D4)
  // -------------------------------------------------------------------------

  /**
   * The shared capped-JSON GET behind `GET /api/worktree-diff/{files,file}` — same flow as
   * the token client's, minus the relogin dance (password mode has none; a 401 means the
   * cookie session is gone and is reported by `transport/password.ts`'s fetch wrapper via
   * `isRestAuthEndpoint`, which covers both wtdiff paths). ONE `WTDIFF_CLIENT_TIMEOUT_MS`
   * deadline spans headers AND body, merged with the caller's `signal`. The 200 body is a
   * capped JSON envelope (the cap judges DECODED bytes — gzip included, never
   * Content-Length): over `maxBytes` ⇒ abort the fetch so the server stops sending + local
   * `E_BAD_RESPONSE` (status 0). `JSON.parse` then the protocol parser
   * (`parseWtDiffFileList` / `parseWtDiffFile`) is the contract gate — `null` ⇒ local
   * `E_BAD_RESPONSE`. Non-200 bodies `{error, reason}` ride verbatim through
   * `previewOutcomeFromResponse` (stripped to §4.6's error half, the probePost precedent) —
   * including 409 `E_STALE_CTX{reason:"base"|"entry"}`, which this layer NEVER retries on its
   * own: the UI (§4.5, D5) owns the one-shot list re-pull.
   * @param {string} url @param {number} maxBytes @param {(raw: any, byteLength: number) => any} parse
   * @param {any} signal @param {number} [timeoutMs] worktree-graph plan v2 §4.4 (P4): the graph
   * endpoint reuses this flow with `WTGRAPH_CLIENT_TIMEOUT_MS` (its §2.4 wall-clock differs from
   * wtdiff's budget) — absent keeps `WTDIFF_CLIENT_TIMEOUT_MS` (byte-identical wtdiff behavior).
   * @returns {Promise<any>}
   */
  async function wtdiffGet(url, maxBytes, parse, signal, timeoutMs = WTDIFF_CLIENT_TIMEOUT_MS) {
    const AC = deps.AbortController ?? (typeof AbortController === "function" ? AbortController : undefined);
    const ac = AC ? new AC() : undefined;
    let expired = false;
    /** @type {any} */
    let deadlineTimer = null;
    /** @type {Promise<never>} */
    const deadline = new Promise((_, reject) => {
      deadlineTimer = timer(() => {
        expired = true;
        ac?.abort();
        reject(new Error("E_DEADLINE"));
      }, timeoutMs);
    });
    /** @type {(() => void) | null} */
    let onExternalAbort = null;
    if (signal && typeof signal.addEventListener === "function") {
      onExternalAbort = () => ac?.abort();
      signal.addEventListener("abort", onExternalAbort, { once: true });
    }
    /** Fetch-level failure ⇒ local code (status 0): the caller's abort, our own deadline, or network. @param {unknown} e */
    const fromError = (e) => {
      if (signal && signal.aborted === true) return { ok: false, status: 0, error: "E_ABORT" };
      if (expired || (e instanceof Error && e.message === "E_DEADLINE"))
        return { ok: false, status: 0, error: "E_DEADLINE" };
      return { ok: false, status: 0, error: "E_NETWORK" };
    };
    try {
      /** @type {any} */
      let r;
      try {
        r = await Promise.race([
          deps.fetch(url, {
            credentials: "same-origin",
            method: "GET",
            headers: { "X-PWH": "1" },
            ...(ac ? { signal: ac.signal } : {}),
          }),
          deadline,
        ]);
      } catch (e) {
        return fromError(e);
      }
      if (!r.ok) {
        const o = await previewOutcomeFromResponse(r);
        /** @type {any} */
        const out = { ok: false, status: o.status, error: o.error };
        if (typeof o.reason === "string") out.reason = o.reason;
        if (typeof o.retryAfterS === "number") out.retryAfterS = o.retryAfterS;
        return out;
      }
      // A capped JSON body, never a length-oracled byte stream: read under the SAME deadline,
      // never beyond `maxBytes` DECODED bytes (gzip included: the cap judges decoded bytes,
      // never Content-Length). With a streaming body use the reader and count as the chunks
      // arrive (aborting the fetch the moment the cap trips); without one read the whole
      // ArrayBuffer first and check its byteLength after.
      /** @type {any} */
      let parsed;
      let byteLength = 0;
      try {
        const body = r.body;
        if (body && typeof body.getReader === "function") {
          const reader = body.getReader();
          /** @type {Uint8Array[]} */
          const chunks = [];
          for (;;) {
            const step = await Promise.race([reader.read(), deadline]);
            if (step.done === true) break;
            const chunk = step.value;
            const len = chunk && typeof chunk.byteLength === "number" ? chunk.byteLength : 0;
            byteLength += len;
            if (byteLength > maxBytes) {
              ac?.abort(); // stop the server sending any more of an over-budget body
              return { ok: false, status: 0, error: "E_BAD_RESPONSE" };
            }
            chunks.push(chunk);
          }
          const merged = new Uint8Array(byteLength);
          let off = 0;
          for (const c of chunks) {
            merged.set(c, off);
            off += c.byteLength;
          }
          parsed = JSON.parse(new TextDecoder().decode(merged));
        } else {
          const buf = await Promise.race([r.arrayBuffer(), deadline]);
          byteLength = buf && typeof buf.byteLength === "number" ? buf.byteLength : 0;
          if (byteLength > maxBytes) return { ok: false, status: 0, error: "E_BAD_RESPONSE" };
          parsed = JSON.parse(new TextDecoder().decode(buf));
        }
      } catch (e) {
        if (signal && signal.aborted === true) return { ok: false, status: 0, error: "E_ABORT" };
        if (expired || (e instanceof Error && e.message === "E_DEADLINE"))
          return { ok: false, status: 0, error: "E_DEADLINE" };
        return { ok: false, status: 0, error: "E_BAD_RESPONSE" }; // undecodable / non-JSON body
      }
      if (signal && signal.aborted === true) return { ok: false, status: 0, error: "E_ABORT" };
      const value = parse(parsed, byteLength);
      if (value === null) return { ok: false, status: 0, error: "E_BAD_RESPONSE" };
      return { ok: true, value };
    } finally {
      deps.clearTimeout(deadlineTimer);
      if (onExternalAbort !== null && signal && typeof signal.removeEventListener === "function") {
        signal.removeEventListener("abort", onExternalAbort);
      }
    }
  }

  /**
   * `GET /api/worktree-diff/files` (§1.2) — the expanded row's file list. §1.10's envelope
   * semantics: the body cap is `WTDIFF_LIST_BODY_MAX_BYTES` decoded bytes and the parsed
   * `WtDiffFileList` is the parser's own product (unknown fields ignored, every off-contract
   * member ⇒ `E_BAD_RESPONSE`). `untracked:"no"` is the degraded list mode (§3.3) and rides
   * the query only when set.
   * @param {{ agentKey: string, sessionId: string, wt: string, untracked?: "no" }} req
   * @param {{ signal?: any }} [opts]
   * @returns {Promise<any>}
   */
  async function wtdiffFiles(req, opts) {
    const signal = opts !== undefined ? opts.signal : undefined;
    if (signal !== undefined && signal !== null && signal.aborted === true) {
      return { ok: false, status: 0, error: "E_ABORT" };
    }
    const url = `${API.wtdiffFiles}?agentKey=${encodeURIComponent(req.agentKey)}&sessionId=${encodeURIComponent(req.sessionId)}&wt=${encodeURIComponent(req.wt)}${req.untracked === "no" ? "&untracked=no" : ""}`;
    return await wtdiffGet(url, WTDIFF_LIST_BODY_MAX_BYTES, parseWtDiffFileList, signal);
  }

  /**
   * `GET /api/worktree-diff/file` (§1.2) — one file's diff payload. `base` is the list's HEAD
   * oid (a mismatch answers 409 `E_STALE_CTX{reason:"base"}` — surfaced, never retried here);
   * `untracked` must match the list request that produced the entry (it joins the hub's
   * changeset key, §1.2 — omitting it stale-fails a still-present file).
   * @param {{ agentKey: string, sessionId: string, wt: string, base: string, path: string, orig?: string, untracked?: "no" }} req
   * @param {{ signal?: any }} [opts]
   * @returns {Promise<any>}
   */
  async function wtdiffFile(req, opts) {
    const signal = opts !== undefined ? opts.signal : undefined;
    if (signal !== undefined && signal !== null && signal.aborted === true) {
      return { ok: false, status: 0, error: "E_ABORT" };
    }
    const url = `${API.wtdiffFile}?agentKey=${encodeURIComponent(req.agentKey)}&sessionId=${encodeURIComponent(req.sessionId)}&wt=${encodeURIComponent(req.wt)}&base=${encodeURIComponent(req.base)}&path=${encodeURIComponent(req.path)}${req.orig !== undefined ? `&orig=${encodeURIComponent(req.orig)}` : ""}${req.untracked === "no" ? "&untracked=no" : ""}`;
    return await wtdiffGet(url, WTDIFF_FILE_BODY_MAX_BYTES, parseWtDiffFile, signal);
  }

  const worktreeDiff = { files: wtdiffFiles, file: wtdiffFile };

  // -------------------------------------------------------------------------
  // worktree-graph endpoint (worktree-graph plan v2 §4.4, package P4)
  // -------------------------------------------------------------------------

  /**
   * `GET /api/worktree-graph` — the worktree commit-graph payload, same capped-JSON GET flow
   * as the token client's, minus the relogin dance (password mode has none; a 401 means the
   * cookie session is gone and is reported by `transport/password.ts`'s fetch wrapper via
   * `isRestAuthEndpoint`, which covers `/api/worktree-graph` by prefix — its params ride the
   * query string). The three graph knobs all come from the frozen P0 protocol module: the
   * `WTGRAPH_BODY_MAX_BYTES` 512 KiB body cap (§2.5's three-stage trim keeps the hub under
   * it), the `WTGRAPH_CLIENT_TIMEOUT_MS` 35 s deadline (§2.4's 23 s server wall-clock +
   * transfer reserve), and `parseWtGraphPayload` as the contract gate — a STRICT
   * key-whitelist parser, so any off-contract member anywhere ⇒ `null` ⇒ local
   * `E_BAD_RESPONSE` (status 0), never silently ignored. Error reasons ride the REUSED codes
   * verbatim: 504 `E_DEADLINE{reason:"log-timeout"}`, 503 `E_WTDIFF_UNSUPPORTED{reason:
   * "missing-object"|"git-too-old"}`, 500 `E_INTERNAL{reason:"git-failed"}` — this layer
   * never retries on its own (the UI owns the retry, §4.3).
   * merged-plan r3 §6/§7.1 (package P4): `merged === true` (the hub declared
   * `wtgraph.merged.v1`) switches the deadline to `WTGRAPH_MERGED_CLIENT_TIMEOUT_MS` 48 s
   * (the M phase lifts the server wall-clock to 37 s + the 10 s transfer reserve); without
   * it the deadline stays `WTGRAPH_CLIENT_TIMEOUT_MS` 35 s — byte-identical to the baseline.
   * @param {string} url @param {any} signal @param {boolean} [merged]
   * @returns {Promise<any>}
   */
  async function wtgraphGet(url, signal, merged) {
    const deadline = merged === true ? WTGRAPH_MERGED_CLIENT_TIMEOUT_MS : WTGRAPH_CLIENT_TIMEOUT_MS;
    return await wtdiffGet(url, WTGRAPH_BODY_MAX_BYTES, parseWtGraphPayload, signal, deadline);
  }

  /**
   * `GET /api/worktree-graph?agentKey&sessionId&wt` (§3) — one graph pull for the panel's
   * graph section. `wt` is the `WorktreeRowWire.path` input (the same request input wtdiff
   * uses, never derived from the session); a 409 `E_SESSION_CHANGED` (hub-side
   * registry/sessionId mismatch) rides verbatim, never retried here.
   * merged-plan r3 §6/§7.1 (P4): `req.merged === true` appends `&merged=1` (the query key is
   * the protocol module's `WTGRAPH_MERGED_QUERY`, never a hand copy) and the 48 s deadline;
   * without it the URL is byte-identical to the baseline (old hubs ignore unknown query keys).
   * @param {{ agentKey: string, sessionId: string, wt: string, merged?: true }} req
   * @param {{ signal?: any }} [opts]
   * @returns {Promise<any>}
   */
  async function wtgraph(req, opts) {
    const signal = opts !== undefined ? opts.signal : undefined;
    if (signal !== undefined && signal !== null && signal.aborted === true) {
      return { ok: false, status: 0, error: "E_ABORT" };
    }
    const merged = req.merged === true;
    const url = `${API.wtgraph}?agentKey=${encodeURIComponent(req.agentKey)}&sessionId=${encodeURIComponent(req.sessionId)}&wt=${encodeURIComponent(req.wt)}${merged ? `&${WTGRAPH_MERGED_QUERY}=1` : ""}`;
    return await wtgraphGet(url, signal, merged);
  }

  const worktreeGraph = { graph: wtgraph };

  // -------------------------------------------------------------------------
  // sysload plan §7.1/§7.3/§10 (package P4): `GET /api/load/top` — same flow as token.ts's
  // sibling (independently duplicated, same discipline this file already applies to every
  // other endpoint pair above).
  // -------------------------------------------------------------------------

  /**
   * @param {any} [signal]
   * @returns {Promise<any>}
   */
  async function loadTop(signal) {
    if (signal !== undefined && signal !== null && signal.aborted === true) {
      return { ok: false, status: 0, error: "E_ABORT" };
    }
    const r = await wtdiffGet(
      API.loadTop,
      LOAD_TOP_BODY_MAX_BYTES,
      parseLoadTopWire,
      signal,
      LOAD_TOP_CLIENT_TIMEOUT_MS,
    );
    // wtdiffGet settles `{ ok: true, value }`; `LoadTopOutcome` (transport/types.ts) is
    // `{ ok: true, data }` — the transport's cast hid this mismatch and every successful
    // snapshot was dropped as "unavailable" (2026-10-11 field report).
    return r.ok ? { ok: true, data: r.value } : r;
  }

  // -------------------------------------------------------------------------
  // web-hub-version plan §5.1 (V2): `GET /api/version` — same flow as token.ts's sibling
  // (independently duplicated, same discipline this file already applies to every other
  // endpoint pair above). 401 ⇒ onConn("auth") is reported by transport/password.ts's fetch
  // wrapper (`REST_AUTH_PATHS` has an exact-match entry for `API.versionInfo`), never here.
  // -------------------------------------------------------------------------

  /**
   * @param {any} [signal]
   * @returns {Promise<any>}
   */
  async function versionInfo(signal) {
    if (signal !== undefined && signal !== null && signal.aborted === true) {
      return { ok: false, status: 0, error: "E_ABORT" };
    }
    const r = await wtdiffGet(
      API.versionInfo,
      VERSION_LIMITS.bodyBytes,
      parseVersionInfoWire,
      signal,
      VERSION_INFO_CLIENT_TIMEOUT_MS,
    );
    return r.ok ? { ok: true, data: r.value } : r;
  }

  // -------------------------------------------------------------------------
  // custom-avatar endpoints (web-hub-avatar plan v2.1 §2.1/§5, package C)
  // -------------------------------------------------------------------------

  let avatarEtag;
  /** @type {Blob | undefined} */
  let avatarBytes;
  let avatarSide;

  /** @param {any} r */
  async function avatarErrorFromResponse(r) {
    /** @type {any} */
    let body;
    try {
      body = await r.json();
    } catch {
      body = undefined;
    }
    const b = body && typeof body === "object" ? body : {};
    /** @type {any} */
    const out = {
      ok: false,
      status: r.status,
      error: typeof b.error === "string" ? b.error : r.status === 401 ? "E_AUTH" : `HTTP ${r.status}`,
    };
    if (typeof b.reason === "string") out.reason = b.reason;
    if (b.effect === "unknown") out.effect = "unknown";
    const raw = typeof r.headers?.get === "function" ? r.headers.get("Retry-After") : null;
    const headerRetry = raw === null || raw === undefined ? NaN : Number(raw);
    const retryAfterS =
      Number.isFinite(headerRetry) && headerRetry >= 0
        ? headerRetry
        : typeof b.retryAfterS === "number" && b.retryAfterS >= 0
          ? b.retryAfterS
          : undefined;
    if (retryAfterS !== undefined) out.retryAfterS = retryAfterS;
    return out;
  }

  /** @param {unknown} e */
  function avatarErrorFromException(e) {
    const msg = e instanceof Error ? e.message : String(e);
    if (msg === "E_ABORT") return { ok: false, status: 0, error: "E_ABORT" };
    if (msg === "E_DEADLINE") return { ok: false, status: 0, error: "E_DEADLINE", effect: "unknown" };
    return { ok: false, status: 0, error: "E_NETWORK", effect: "unknown" };
  }

  /** @param {any} opts */
  async function avatarFetch(opts) {
    const signal = opts?.signal;
    if (signal?.aborted === true) return { ok: false, status: 0, error: "E_ABORT" };
    try {
      const headers = { "X-PWH": "1" };
      if (typeof avatarEtag === "string") headers["If-None-Match"] = avatarEtag;
      const r = await request(AVATAR_PATH, { method: "GET", headers }, REQUEST_TIMEOUT_MS, signal);
      if (r.status === 304) {
        if (avatarBytes !== undefined && typeof avatarEtag === "string" && typeof avatarSide === "number")
          return { ok: true, bytes: avatarBytes, etag: avatarEtag, side: avatarSide };
        return { ok: false, status: 304, error: "E_NOT_MODIFIED" };
      }
      if (!r.ok) return await avatarErrorFromResponse(r);
      const raw =
        typeof r.arrayBuffer === "function"
          ? await r.arrayBuffer()
          : typeof r.blob === "function"
            ? await (await r.blob()).arrayBuffer()
            : undefined;
      if (!(raw instanceof ArrayBuffer) && !ArrayBuffer.isView(raw))
        return { ok: false, status: 0, error: "E_BAD_RESPONSE" };
      const bytes =
        raw instanceof ArrayBuffer ? new Uint8Array(raw) : new Uint8Array(raw.buffer, raw.byteOffset, raw.byteLength);
      const validation = validateAvatarPng(bytes);
      if (!validation.ok) return { ok: false, status: 0, error: "E_BAD_RESPONSE", reason: validation.reason };
      const etag = typeof r.headers?.get === "function" ? r.headers.get("ETag") : null;
      if (typeof etag !== "string" || etag === "") return { ok: false, status: 0, error: "E_BAD_RESPONSE" };
      avatarEtag = etag;
      avatarBytes = new Blob([bytes], { type: "image/png" });
      avatarSide = validation.side;
      return { ok: true, bytes: avatarBytes, etag, side: validation.side };
    } catch (e) {
      return avatarErrorFromException(e);
    }
  }

  /** @param {Uint8Array} bytes @param {any} [opts] */
  async function avatarUpload(bytes, opts) {
    const signal = opts?.signal;
    try {
      const r = await request(
        AVATAR_PATH,
        { method: "POST", headers: { "Content-Type": "application/octet-stream", "X-PWH": "1" }, body: bytes },
        CMD_REQUEST_TIMEOUT_MS,
        signal,
      );
      if (!r.ok) return await avatarErrorFromResponse(r);
      return { ok: true, data: await r.json() };
    } catch (e) {
      return avatarErrorFromException(e);
    }
  }

  async function avatarRemove() {
    try {
      const r = await request(
        AVATAR_DELETE_PATH,
        { method: "POST", headers: { "Content-Type": "application/json", "X-PWH": "1" }, body: "{}" },
        CMD_REQUEST_TIMEOUT_MS,
      );
      if (!r.ok) return await avatarErrorFromResponse(r);
      return { ok: true, data: await r.json() };
    } catch (e) {
      return avatarErrorFromException(e);
    }
  }

  const avatar = { fetch: avatarFetch, upload: avatarUpload, remove: avatarRemove };

  // ---------------------------------------------------------------------------
  // web-hub-privacy plan v2.1 (P1, 传输层 only — P2 owns the views). Mirrors token-client's
  // twin 1:1 (the two transports stay independent modules by design;
  // `transport-contract.test.ts` pins behavioral parity): `verify` (this LAN/password transport
  // is the ONLY mode whose hub actually mounts the endpoint) and `lock` (LAN unlock carries an
  // inline `password`). A wrong password is a 200 verdict (`data.ok === false`), NEVER an
  // error — 401 is reserved for a lost session; a 429 carries `retryAfterS` (the shared login
  // limiter's Retry-After — same countdown UI as the login form).
  // ---------------------------------------------------------------------------
  /**
   * @param {string} path @param {unknown} body
   * @returns {Promise<{ ok: true, data: { ok: boolean } } | { ok: false, error: string, status?: number, retryAfterS?: number }>}
   */
  async function privacyPost(path, body) {
    try {
      const r = await postApi(path, body, CMD_REQUEST_TIMEOUT_MS);
      if (r.ok) {
        const d = await r.json();
        if (d === null || typeof d !== "object" || typeof d.ok !== "boolean")
          return { ok: false, error: "E_BAD_RESPONSE", status: r.status };
        return { ok: true, data: { ok: d.ok } };
      }
      const retryRaw = typeof r.headers?.get === "function" ? r.headers.get("Retry-After") : null;
      const retryS = retryRaw === null ? NaN : Number(retryRaw);
      return {
        ok: false,
        error: await errorOf(r),
        status: r.status,
        ...(Number.isFinite(retryS) && retryS >= 0 ? { retryAfterS: retryS } : {}),
      };
    } catch (e) {
      return { ok: false, error: e instanceof Error ? e.message : "E_NETWORK" };
    }
  }
  const privacy = {
    /** @param {string} password */
    verify: (password) => privacyPost(API.privacyVerify, { password }),
    /** @param {{ agentKey: string, sessionId: string, locked: boolean, password?: string }} req */
    lock: (req) => privacyPost(API.privacyLock, req),
  };

  // -------------------------------------------------------------------------
  // web-hub-proxy plan v2 §3.8/§8 (X2): the three proxy endpoints — one-shot calls, no relogin
  // dance (a 401 is a lost cookie session, reported by transport/password.ts's fetch wrapper
  // via `REST_AUTH_PATHS` exact-match entries — never inside the client).
  // -------------------------------------------------------------------------
  /** @param {string} path @param {unknown} body @param {(raw: unknown) => any} parse @param {number} max @param {any} [signal] */
  function proxyPost(path, body, parse, max, signal) {
    return proxyFetch(
      () =>
        request(
          path,
          { method: "POST", headers: { "Content-Type": "application/json", "X-PWH": "1" }, body: JSON.stringify(body) },
          PROXY_CLIENT_TIMEOUT_MS,
          signal,
        ),
      parse,
      max,
      signal,
    );
  }
  const proxy = {
    /** @param {{ target: string }} req @param {{ signal?: any }} [opts] */
    open: (req, opts) =>
      proxyPost(API.proxyOpen, { target: req.target }, parseProxyOpen, PROXY_OPEN_BODY_MAX_BYTES, opts?.signal),
    /** @param {{ signal?: any }} [opts] */
    list: (opts) =>
      proxyFetch(
        () =>
          request(API.proxyList, { method: "GET", headers: { "X-PWH": "1" } }, PROXY_CLIENT_TIMEOUT_MS, opts?.signal),
        parseProxyList,
        PROXY_LIST_BODY_MAX_BYTES,
        opts?.signal,
      ),
    /** @param {string} instanceId @param {{ signal?: any }} [opts] */
    stop: (instanceId, opts) =>
      proxyPost(API.proxyStop, { instanceId }, parseProxyStop, PROXY_OPEN_BODY_MAX_BYTES, opts?.signal),
  };

  // -------------------------------------------------------------------------
  // LAN security r2 §5.6/§5.9 (package G): second-factor endpoints. All three live under
  // `/api/login*` behind the `pwh_lan2fa` challenge cookie (HttpOnly, Path=/api/login — the
  // browser attaches it automatically; this client never sees the token). The fetch wrapper's
  // `isRestAuthEndpoint` deliberately does NOT cover these paths: a 401 here is a challenge
  // answer (`E_2FA_CODE`), never a lost session, so `onConn("auth")` must NOT fire.
  // -------------------------------------------------------------------------

  /**
   * `POST /api/login/2fa`. Codes are validated LOCALLY first (§5.3: malformed input is a 400
   * with no attempt consumed — answered here without any request at all): TOTP must match
   * `TOTP_CODE_RE`; recovery codes go through `normalizeRecoveryCode` (case/separators/
   * Crockford aliases) before hitting the wire. Outcomes:
   * - 200 ⇒ the hub set `pwh_lan` and cleared the challenge cookie; the stream opens here.
   * - `{error:"E_2FA_CODE", attemptsLeft}` — wrong code, challenge still alive.
   * - `{error:"E_2FA_METHOD_LOCKED", retryAfterMs}` — per-method sliding window full (§5.5).
   * - `{error:"E_2FA_EXPIRED"|"E_2FA_USED"|…}` — challenge dead ⇒ the caller restarts login.
   * - `{error:"E_LOCKED", retryAfterMs}` — shared per-IP login lockout (429).
   * - `{error:"network"}` — fetch failure/deadline; the challenge MAY still be alive.
   * @param {{ method: "totp" | "recovery", code: string }} input
   * @returns {Promise<
   *   | { ok: true, initialPassword: boolean }
   *   | { ok: false, error: string, attemptsLeft?: number, retryAfterMs?: number }
   * >}
   */
  async function submitSecondFactor(input) {
    if (stream.isClosed()) return { ok: false, error: "network" };
    /** @type {"totp" | "recovery"} */
    let method;
    /** @type {string} */
    let code;
    if (input !== null && typeof input === "object" && input.method === "totp") {
      method = "totp";
      code = typeof input.code === "string" ? input.code.trim() : "";
      if (!TOTP_CODE_RE.test(code)) return { ok: false, error: "E_BAD_REQUEST" };
    } else if (input !== null && typeof input === "object" && input.method === "recovery") {
      method = "recovery";
      const normalized = typeof input.code === "string" ? normalizeRecoveryCode(input.code) : undefined;
      if (normalized === undefined) return { ok: false, error: "E_BAD_REQUEST" };
      code = normalized;
    } else {
      return { ok: false, error: "E_BAD_REQUEST" };
    }
    /** @type {any} */
    let r;
    try {
      r = await postApi(LAN_2FA_PATH, { method, code }, SECOND_FACTOR_TIMEOUT_MS);
    } catch {
      return { ok: false, error: "network" };
    }
    /** @type {any} */
    let body;
    try {
      body = await r.json();
    } catch {
      body = undefined;
    }
    const b = body !== null && typeof body === "object" ? body : {};
    if (r.ok && b.ok === true) {
      // A successful submit ends the challenge: abort any in-flight `/wait` loop FIRST so a
      // stale late answer (denied/expired/approved) can never settle afterwards and bounce
      // the completed login back to the password form. The aborted loop settles
      // `{state:"cancelled"}`, which callers ignore; its post-fetch abort check discards a
      // response that raced in just before the abort.
      abortWaitSession();
      stream.resetBackoff();
      stream.openStream();
      return { ok: true, initialPassword: b.initialPassword === true };
    }
    /** @type {any} */
    const out = {
      ok: false,
      error: typeof b.error === "string" ? b.error : r.status === 401 ? "E_2FA_CODE" : `HTTP ${r.status}`,
    };
    if (Number.isInteger(b.attemptsLeft) && b.attemptsLeft >= 0) out.attemptsLeft = b.attemptsLeft;
    const headerRetry = retryAfterMs(r, NaN);
    if (Number.isFinite(headerRetry)) out.retryAfterMs = headerRetry;
    else if (typeof b.retryAfterMs === "number" && Number.isFinite(b.retryAfterMs) && b.retryAfterMs >= 0)
      out.retryAfterMs = b.retryAfterMs;
    return out;
  }

  /**
   * In-flight wait loop, or null. The challenge OBJECT identity (`key`) identifies the
   * challenge: a second `waitApproval` call with the SAME challenge object rides the
   * existing loop (the hub allows ONE waiter per challenge — a literal second request
   * would 409 `E_2FA_BUSY`); any other challenge supersedes (the old loop is aborted
   * first). Identity is deliberately NOT `expiresAt`: two distinct challenges can share
   * an expiry and must never share a loop (verifier rework #5).
   * @type {{ key: object | undefined, expiresAt: number, promise: Promise<any>, abort(): void } | null}
   */
  let waitSession = null;

  function abortWaitSession() {
    const s = waitSession;
    if (s !== null) {
      waitSession = null;
      s.abort();
    }
  }

  /**
   * `GET /api/login/2fa/wait` long-poll loop (§5.6/§5.9). Serial polls, one in flight: each
   * request gets the 30s per-poll timeout (server hold 15s + 8s reserve = 23s < 30s), and ANY
   * failure — timeout included — is retried until `challenge.expiresAt`, never faster than
   * `WAIT_MIN_POLL_MS` between poll starts (the conformant server's own hold paces the loop).
   * Terminal outcomes: approved (200 + `pwh_lan`; the stream opens here), `denied`, `expired`
   * (also for `E_2FA_EXPIRED`/`E_2FA_USED`/a locally observed `expiresAt` pass — all mean
   * "restart login"), `cancelled` (local abort via `cancelSecondFactor`/`close()`/a
   * `submitSecondFactor` success — the challenge is over either way), or
   * `{state:"error"}` for the rest (e.g. a conflicting second waiter `E_2FA_BUSY`).
   * @param {Lan2faChallengeWire} challenge
   * @returns {Promise<
   *   | { ok: true, initialPassword: boolean }
   *   | { ok: false, state: "denied" | "expired" | "cancelled" }
   *   | { ok: false, state: "error", error: string }
   * >}
   */
  function waitApproval(challenge) {
    const key = challenge !== null && typeof challenge === "object" ? challenge : undefined;
    const expiresAt =
      challenge !== null && typeof challenge === "object" && typeof challenge.expiresAt === "number"
        ? challenge.expiresAt
        : deps.now();
    if (waitSession !== null && key !== undefined && waitSession.key === key) return waitSession.promise;
    abortWaitSession();
    const AC = deps.AbortController ?? (typeof AbortController === "function" ? AbortController : undefined);
    const ac = AC ? new AC() : undefined;
    const session = {
      key,
      expiresAt,
      promise: /** @type {Promise<any>} */ (Promise.resolve()),
      abort() {
        ac?.abort();
      },
    };
    session.promise = waitLoop(expiresAt, ac !== undefined ? ac.signal : undefined, session);
    waitSession = session;
    return session.promise;
  }

  /** @param {number} expiresAt @param {any} signal @param {{ expiresAt: number }} session */
  async function waitLoop(expiresAt, signal, session) {
    let errorStreak = 0; // consecutive TRANSPORT errors; any HTTP response resets it (§5.6)
    try {
      for (;;) {
        if (stream.isClosed() || signal?.aborted === true) return { ok: false, state: "cancelled" };
        const started = deps.now();
        if (started >= expiresAt) return { ok: false, state: "expired" };
        /** @type {any} */
        let r;
        /** @type {unknown} */
        let fetchErr;
        try {
          r = await request(
            LAN_2FA_WAIT_PATH,
            { method: "GET", headers: { "X-PWH": "1" } },
            WAIT_POLL_TIMEOUT_MS,
            signal,
          );
        } catch (e) {
          fetchErr = e;
        }
        if (stream.isClosed() || signal?.aborted === true) return { ok: false, state: "cancelled" };
        if (fetchErr !== undefined) {
          errorStreak += 1;
          // §5.6: any poll timeout/failure ⇒ retry, never a tight loop; consecutive
          // transport errors back off 1s→2s→4s→…≤8s (abort-aware sleep).
          await pacePoll(
            started,
            signal,
            Math.min(WAIT_MIN_POLL_MS * 2 ** (errorStreak - 1), WAIT_ERROR_BACKOFF_MAX_MS),
          );
          continue;
        }
        errorStreak = 0; // a response — any response — proves the transport is alive
        /** @type {any} */
        let body;
        try {
          body = await r.json();
        } catch {
          body = undefined;
        }
        const b = body !== null && typeof body === "object" ? body : {};
        if (r.ok && b.ok === true) {
          stream.resetBackoff();
          stream.openStream();
          return { ok: true, initialPassword: b.initialPassword === true };
        }
        if (b.state === "pending") {
          await pacePoll(started, signal);
          continue;
        }
        if (b.state === "denied") return { ok: false, state: "denied" };
        if (b.state === "expired") return { ok: false, state: "expired" };
        const error = typeof b.error === "string" ? b.error : `HTTP ${r.status}`;
        if (error === "E_2FA_EXPIRED" || error === "E_2FA_USED") return { ok: false, state: "expired" };
        if (error === "E_2FA_BUSY") return { ok: false, state: "error", error };
        // E_DB / E_RATE / unparseable / unexpected status: transient until the challenge expires.
        await pacePoll(started, signal);
      }
    } finally {
      if (waitSession === session) waitSession = null;
    }
  }

  /** Pathology floor between poll starts (see WAIT_MIN_POLL_MS) plus an optional bounded
   *  transport-error backoff; the sleep is abort-aware so a cancelled session never lingers
   *  in a backoff nap. @param {number} started @param {any} [signal] @param {number} [extraMs] */
  async function pacePoll(started, signal, extraMs = 0) {
    const elapsed = deps.now() - started;
    const wait = Math.max(WAIT_MIN_POLL_MS - elapsed, extraMs);
    if (wait > 0) await sleepAbortable(wait, signal);
  }

  /**
   * `POST /api/login/2fa/cancel` — best-effort; also aborts any in-flight wait loop (its
   * promise settles `{state:"cancelled"}`). The caller returns to the password form
   * regardless of the outcome.
   * @returns {Promise<{ ok: true } | { ok: false, error: string }>}
   */
  async function cancelSecondFactor() {
    abortWaitSession();
    try {
      const r = await postApi(LAN_2FA_CANCEL_PATH, {}, REQUEST_TIMEOUT_MS);
      return r.ok ? { ok: true } : { ok: false, error: await errorOf(r) };
    } catch (e) {
      return { ok: false, error: e instanceof Error ? e.message : "E_NETWORK" };
    }
  }

  return {
    /** Clear a stray `#t=` (never read/sent in password mode), fetch session info, then open the stream. */
    async start() {
      deps.onConn("connecting");
      if (hashHasToken(deps.location.hash)) {
        deps.history.replaceState(null, "", `${deps.location.pathname}${deps.location.search}`);
      }
      void fetchSessionInfo();
      if (!stream.isClosed()) stream.openStream();
    },
    login,
    logout,
    submitSecondFactor,
    waitApproval,
    cancelSecondFactor,
    subscribe,
    unsubscribe,
    page,
    runSubscribe,
    runUnsubscribe,
    runPage,
    command,
    dialog,
    upload,
    spawn,
    removeAgent,
    preview,
    worktreeDiff,
    worktreeGraph,
    loadTop,
    versionInfo,
    avatar,
    privacy,
    proxy,
    close() {
      stream.close();
      abortWaitSession();
    },
    /** Test/diagnostic hooks. */
    stats() {
      const s = stream.stats();
      return { open: s.open, backoff: s.backoff };
    },
  };
}
