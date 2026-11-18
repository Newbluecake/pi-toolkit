/**
 * Shared EventSource lifecycle for the two browser transports (source-governance batch2
 * ⑩-U): the stream machinery used to be duplicated 1:1 between `token-client.js` and
 * `password-client.js`; both clients now delegate to `createStreamLifecycle` and keep only
 * their mode differences. One stream per tab (`API.events`), a 45s-silence watchdog
 * (`SILENCE_MS`), exponential reopen backoff (`BACKOFF_MIN_MS`→`BACKOFF_MAX_MS`), a 10s
 * connect-handshake deadline (`CONNECT_TIMEOUT_MS`), and the shared conn-state vocabulary
 * (`onConn("open"|"reconnecting"|"auth")` — "connecting" is emitted by the clients' own
 * `start()`, never here).
 *
 * The two auth modes inject their differences as hooks:
 * - `onHello()` — per-mode hello bookkeeping (the token client resets its one-shot
 *   relogin flag there).
 * - `handleFrame(name, data, source)` — intercepts a frame BEFORE the hello bookkeeping
 *   and `onMessage`; return true when consumed (the password client's `event: auth`,
 *   which closes the stream immediately and reports the reason instead of waiting for
 *   the generic `error` path).
 * - `onClosedError(source)` — the CLOSED-readyState `error` path, entered after this
 *   module has cleared the connect deadline: token mode runs its silent re-login dance,
 *   password mode runs the `/api/session` close-probe (lan-plan.md §15.9 #8).
 *
 * Every timer goes through `createTimer` (unref'd where the platform supports it) and is
 * cleared by `closeStream()`; `close()` additionally latches `closed`, so no watchdog tick,
 * reopen timer, or handshake deadline can ever bring the stream back.
 */
import { API, SILENCE_MS, SSE_EVENTS } from "./contract.js";

export const WATCHDOG_TICK_MS = 5_000;
export const BACKOFF_MIN_MS = 1_000;
export const BACKOFF_MAX_MS = 30_000;
// Handshake deadline for a fresh EventSource: a healthy hello lands in a few hundred ms, and
// Chromium fires NO `error` for an accepted-but-silent connection — it just sits at readyState
// CONNECTING, so without this timer the only guard was the 45s SILENCE watchdog (2026-10-13
// LAN incident: /api/events hung mid-handshake, conn stuck "connecting" forever). 10s is ~an
// order of magnitude above the healthy case yet far below the silence watchdog.
export const CONNECT_TIMEOUT_MS = 10_000;
const ES_CLOSED = 2;

/**
 * `deps.setTimeout` wrapper that unref()s the timer when the platform supports it (Node —
 * browsers return a plain number). Shared by the stream lifecycle below and by both
 * clients' request/sleep helpers (previously duplicated in each client).
 * @param {{ setTimeout: (fn: () => void, ms: number) => any }} deps
 * @returns {(fn: () => void, ms: number) => any}
 */
export function createTimer(deps) {
  return (fn, ms) => {
    const t = deps.setTimeout(fn, ms);
    if (t && typeof t.unref === "function") t.unref();
    return t;
  };
}

/**
 * @param {{
 *   EventSource: new (url: string, init?: any) => any,
 *   setTimeout: (fn: () => void, ms: number) => any,
 *   clearTimeout: (t: any) => void,
 *   now: () => number,
 *   onMessage: (msg: { event: string, data: any, id?: number }) => void,
 *   onConn: (state: "connecting" | "open" | "reconnecting" | "auth") => void,
 * }} deps
 * @param {{
 *   onHello?: () => void,
 *   handleFrame?: (name: string, data: any, source: any) => boolean,
 *   onClosedError: (source: any) => void,
 * }} hooks
 */
export function createStreamLifecycle(deps, hooks) {
  /** @type {any} */
  let es = null;
  let lastFrameAt = deps.now();
  /** @type {any} */
  let watchdog = null;
  /** @type {any} */
  let reopenTimer = null;
  /** @type {any} */
  let connectTimer = null;
  let backoff = BACKOFF_MIN_MS;
  let closed = false;
  let opens = 0;

  const timer = createTimer(deps);

  function clearConnectTimer() {
    if (connectTimer !== null) deps.clearTimeout(connectTimer);
    connectTimer = null;
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
    opens++;
    lastFrameAt = deps.now();
    // Handshake deadline (see CONNECT_TIMEOUT_MS): no hello in time ⇒ the connection hung
    // mid-handshake — Chromium never reports that as `error`, and the 45s silence watchdog is
    // far too late for boot. Close the hung stream ourselves and retry on the normal backoff.
    // Cleared by `hello`, by closeStream(), and by the CLOSED `error` branch (which hands the
    // stream to the mode's `onClosedError` hook — the timer must not race it); deliberately
    // NOT cleared by a transient (CONNECTING) `error`: the spec is "hello within
    // CONNECT_TIMEOUT_MS of creation", a browser auto-retry does not buy a fresh deadline.
    clearConnectTimer();
    connectTimer = timer(() => {
      connectTimer = null;
      if (closed || es !== source) return;
      try {
        source.close();
      } catch {
        /* already closed */
      }
      es = null;
      deps.onConn("reconnecting");
      scheduleReopen();
    }, CONNECT_TIMEOUT_MS);
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
        // Mode-specific frame interception (password's `event: auth`) sits exactly where its
        // in-line branch used to: BEFORE the hello bookkeeping and before onMessage.
        if (hooks.handleFrame !== undefined && hooks.handleFrame(name, data, source) === true) return;
        if (name === "hello") {
          clearConnectTimer();
          hooks.onHello?.();
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
        deps.onConn("reconnecting"); // browser auto-reconnects with Last-Event-ID (a genuine network hiccup, never a plain HTTP error — verified against Chromium)
        return;
      }
      // CLOSED: the connect attempt is over (the stream failed outright — a non-200 response,
      // 401 or 503 alike, fails the connection with no browser retry, indistinguishable from
      // `error` alone), so its handshake deadline must not race the mode's closed flow
      // (token: one silent re-login; password: the /api/session probe).
      clearConnectTimer();
      hooks.onClosedError(source);
    });
    armWatchdog();
  }

  function closeStream() {
    if (watchdog !== null) deps.clearTimeout(watchdog);
    if (reopenTimer !== null) deps.clearTimeout(reopenTimer);
    clearConnectTimer();
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

  return {
    openStream,
    closeStream,
    scheduleReopen,
    /** Backoff reset (a fresh handshake/login succeeded). */
    resetBackoff() {
      backoff = BACKOFF_MIN_MS;
    },
    /** @returns {boolean} */
    isClosed() {
      return closed;
    },
    /** Supersession guard for the closed-flow hooks. @param {any} source @returns {boolean} */
    currentIs(source) {
      return es === source;
    },
    /** Detach the current stream WITHOUT closing it (it is already closed/failed upstream). */
    clearCurrent() {
      es = null;
    },
    /**
     * Drop a stream whose frame said the session is over: handshake deadline off, detached,
     * closed. @param {any} source
     */
    dropSource(source) {
      clearConnectTimer();
      es = null;
      try {
        source.close();
      } catch {
        /* already closed */
      }
    },
    close() {
      closed = true;
      closeStream();
    },
    /** Test/diagnostic hooks (each client picks the fields its own stats() exposes). */
    stats() {
      return { opens, open: es !== null, backoff };
    },
  };
}
