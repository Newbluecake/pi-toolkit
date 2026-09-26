/**
 * Password-mode browser transport (plan §10, package LF).
 *
 * Mirrors `createClient` in `app.js` (same EventSource lifecycle: one stream
 * per tab, 45s-silence watchdog, exponential reopen backoff) but for the LAN
 * `data-auth-mode="password"` listener instead of the loopback token one:
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
 */
import { API, SILENCE_MS, SSE_EVENTS } from "./contract.js";

export const REQUEST_TIMEOUT_MS = 10_000;
export const LOGIN_TIMEOUT_MS = 25_000; // plan §10 "排队等待": KDF fair-scheduling wait can run up to 20s
export const WATCHDOG_TICK_MS = 5_000;
export const BACKOFF_MIN_MS = 1_000;
export const BACKOFF_MAX_MS = 30_000;
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
const ES_CLOSED = 2;

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
  /** @type {any} */
  let es = null;
  let lastFrameAt = deps.now();
  /** @type {any} */
  let watchdog = null;
  /** @type {any} */
  let reopenTimer = null;
  let backoff = BACKOFF_MIN_MS;
  let closed = false;

  /** @param {() => void} fn @param {number} ms */
  const timer = (fn, ms) => {
    const t = deps.setTimeout(fn, ms);
    if (t && typeof t.unref === "function") t.unref();
    return t;
  };

  /** @param {number} ms */
  const sleep = (ms) => new Promise((resolve) => timer(resolve, ms));

  /**
   * @param {string} url @param {any} init @param {number} timeoutMs
   */
  async function request(url, init, timeoutMs) {
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
    try {
      return await Promise.race([
        deps.fetch(url, { credentials: "same-origin", ...init, ...(ac ? { signal: ac.signal } : {}) }),
        deadline,
      ]);
    } finally {
      deps.clearTimeout(t);
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
    if (r.status === 401) return { kind: "invalid" };
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
   *   | { ok: false, kind: "invalid" | "not-allowed" | "network" | "busy-exhausted" }
   *   | { ok: false, kind: "saturated" | "throttled", retryAfterS: number }
   *   | { ok: false, kind: "unknown", status: number }
   * >}
   */
  async function login(username, password) {
    let busyAttempts = 0;
    for (;;) {
      if (closed) return { ok: false, kind: "network" };
      const res = await postLoginOnce(username, password);
      switch (res.kind) {
        case "ok":
          backoff = BACKOFF_MIN_MS;
          openStream();
          return { ok: true, initialPassword: res.body.initialPassword === true };
        case "invalid":
          return { ok: false, kind: "invalid" };
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
    closeStream();
    backoff = BACKOFF_MIN_MS;
    deps.onConn("auth");
    deps.onUnauthenticated();
  }

  function closeStream() {
    if (watchdog !== null) deps.clearTimeout(watchdog);
    if (reopenTimer !== null) deps.clearTimeout(reopenTimer);
    watchdog = reopenTimer = null;
    if (es) {
      try {
        es.close();
      } catch {
        /* already closed */
      }
      es = null;
    }
  }

  function armWatchdog() {
    if (watchdog !== null) deps.clearTimeout(watchdog);
    watchdog = timer(() => {
      watchdog = null;
      if (closed) return;
      if (es && deps.now() - lastFrameAt > SILENCE_MS) {
        deps.onConn("reconnecting");
        openStream();
        return;
      }
      armWatchdog();
    }, WATCHDOG_TICK_MS);
  }

  function scheduleReopen() {
    if (closed || reopenTimer !== null) return;
    const delay = backoff;
    backoff = Math.min(BACKOFF_MAX_MS, backoff * 2);
    reopenTimer = timer(() => {
      reopenTimer = null;
      if (!closed) openStream();
    }, delay);
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
      if (closed || es !== source) return; // superseded by a newer stream, logout, or close()
      /** @type {"ok" | "unauthenticated" | "busy" | "network"} */
      let outcome;
      try {
        const r = await request(API.session, { method: "GET" }, REQUEST_TIMEOUT_MS);
        outcome = r.status === 401 ? "unauthenticated" : r.ok ? "ok" : "busy";
      } catch {
        outcome = "network";
      }
      if (closed || es !== source) return;
      if (outcome === "ok") {
        deps.onConn("reconnecting");
        scheduleReopen();
        return;
      }
      if (outcome === "unauthenticated") {
        es = null;
        deps.onConn("auth");
        deps.onUnauthenticated();
        scheduleReopen(); // picks a freshly-authenticated cookie back up (e.g. signed in from another tab)
        return;
      }
      // "busy" (503) or "network": keep the current page state, re-probe after a bounded backoff.
      if (attempt >= CLOSE_PROBE_MAX) {
        scheduleReopen();
        return;
      }
      await sleep(CLOSE_PROBE_BACKOFF_MS);
    }
  }

  function openStream() {
    if (closed) return;
    if (es) {
      try {
        es.close();
      } catch {
        /* already closed */
      }
      es = null;
    }
    if (reopenTimer !== null) {
      deps.clearTimeout(reopenTimer);
      reopenTimer = null;
    }
    const source = new deps.EventSource(API.events, { withCredentials: true });
    es = source;
    lastFrameAt = deps.now();
    for (const name of SSE_EVENTS) {
      source.addEventListener(name, (/** @type {any} */ ev) => {
        if (es !== source) return; // stale stream
        lastFrameAt = deps.now();
        let data = null;
        try {
          data = typeof ev.data === "string" && ev.data !== "" ? JSON.parse(ev.data) : null;
        } catch {
          return; // malformed frame: ignore
        }
        if (name === "auth") {
          const reason = data && (data.reason === "revoked" || data.reason === "expired") ? data.reason : "revoked";
          es = null;
          try {
            source.close();
          } catch {
            /* already closed */
          }
          backoff = BACKOFF_MIN_MS;
          deps.onConn("auth");
          deps.onAuthEvent(reason);
          return;
        }
        if (name === "hello") {
          backoff = BACKOFF_MIN_MS;
          deps.onConn("open");
        }
        const id = Number(ev.lastEventId);
        deps.onMessage(
          Number.isFinite(id) && ev.lastEventId !== "" ? { event: name, data, id } : { event: name, data },
        );
      });
    }
    source.addEventListener("error", () => {
      if (es !== source || closed) return;
      if (source.readyState !== ES_CLOSED) {
        deps.onConn("reconnecting"); // browser auto-reconnects (genuine network hiccup, never a plain HTTP error — verified against Chromium)
        return;
      }
      // CLOSED: 401 and 503 are indistinguishable here (both fail the connection, no browser
      // retry) — probe §10 review fix (lan-plan.md §15.9 #8) disambiguates instead of treating
      // every CLOSED as "not signed in".
      void probeSessionAfterClose(source);
    });
    armWatchdog();
  }

  return {
    /** Clear a stray `#t=` (never read/sent in password mode), fetch session info, then open the stream. */
    async start() {
      deps.onConn("connecting");
      if (hashHasToken(deps.location.hash)) {
        deps.history.replaceState(null, "", `${deps.location.pathname}${deps.location.search}`);
      }
      void fetchSessionInfo();
      if (!closed) openStream();
    },
    login,
    logout,
    close() {
      closed = true;
      closeStream();
    },
    /** Test/diagnostic hooks. */
    stats() {
      return { open: es !== null, backoff };
    },
  };
}
