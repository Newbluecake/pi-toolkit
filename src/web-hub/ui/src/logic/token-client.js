/**
 * Token-mode transport (extracted from `app.js` — vue-plan.md v2.1 §3.1, §5.2 — P0).
 * All I/O injected (tests drive it with fakes): `#t=` hash → POST /api/login (X-PWH:1) →
 * token kept in localStorage → `history.replaceState` clears the hash; exactly ONE
 * EventSource per tab; 45s without any frame ⇒ close + reopen; 401 (API or a CLOSED
 * EventSource) ⇒ one silent re-login with the stored token. Every request has a deadline
 * (AbortController), every timer is cleared on close.
 *
 * `app.js` only imports `createClient` from here now — behavior is unchanged
 * (`tests/web-hub/web/client.test.ts` is the byte-for-byte proof, just repointed at this
 * file). Splitting it out means the new Vue UI (`src/web-hub/ui/`) can reuse this pure
 * transport through the `@logic` alias without ever pulling in `app.js`'s bottom-of-file
 * "mount if #app exists" side effect.
 *
 * Control plane (control-plan v2.1 §7.2, package C4): `command()`/`dialog()` POST the
 * idempotent write endpoints. A 401 goes through the same `withRelogin` dance as
 * subscribe/page — replaying the same body with the same `id` after a silent re-login is
 * safe (D7: hub LRU + agent ledger dedupe it). The fetch budget is 16s (§3.3: above the
 * server's 13s request deadline, below the listener's requestTimeout + network slack); on
 * timeout the outcome is `E_DEADLINE{effect:"unknown"}` — never auto re-executed, the
 * queryOnly flow (§3.4) decides.
 */
import { API, HISTORY_LIMIT_MAX, SILENCE_MS, SSE_EVENTS } from "./contract.js";
import { outcomeFromError, outcomeFromResponse } from "./control.js";

export const TOKEN_KEY = "pwh_token";
export const REQUEST_TIMEOUT_MS = 10_000;
export const CMD_REQUEST_TIMEOUT_MS = 16_000; // control-plan §3.3 browser write budget
export const WATCHDOG_TICK_MS = 5_000;
export const BACKOFF_MIN_MS = 1_000;
export const BACKOFF_MAX_MS = 30_000;
const ES_CLOSED = 2;

/** `#t=<token>` (optionally among other `&` params) → token. @param {unknown} hash */
export function readHashToken(hash) {
  if (typeof hash !== "string" || !hash.startsWith("#")) return undefined;
  const t = new URLSearchParams(hash.slice(1)).get("t");
  return typeof t === "string" && t !== "" && t.length <= 512 ? t : undefined;
}

/**
 * @typedef {{
 *   fetch: (url: string, init?: any) => Promise<{ ok: boolean, status: number, json(): Promise<any> }>,
 *   EventSource: new (url: string, init?: any) => any,
 *   storage: { getItem(k: string): string | null, setItem(k: string, v: string): void, removeItem(k: string): void },
 *   location: { hash: string, pathname: string, search: string },
 *   history: { replaceState(data: any, unused: string, url?: string): void },
 *   setTimeout: (fn: () => void, ms: number) => any,
 *   clearTimeout: (t: any) => void,
 *   now: () => number,
 *   AbortController?: new () => { signal: any, abort(): void },
 *   onMessage: (msg: { event: string, data: any, id?: number }) => void,
 *   onConn: (state: "connecting" | "open" | "reconnecting" | "auth") => void,
 * }} ClientDeps
 */

/**
 * @param {ClientDeps} deps
 */
export function createClient(deps) {
  /** @type {any} */
  let es = null;
  let lastFrameAt = deps.now();
  /** @type {any} */
  let watchdog = null;
  /** @type {any} */
  let reopenTimer = null;
  let reloginUsed = false;
  let backoff = BACKOFF_MIN_MS;
  let closed = false;
  let opens = 0;

  /** @param {() => void} fn @param {number} ms */
  const timer = (fn, ms) => {
    const t = deps.setTimeout(fn, ms);
    if (t && typeof t.unref === "function") t.unref();
    return t;
  };

  /**
   * @param {string} url
   * @param {any} init
   * @param {number} [timeoutMs]
   * @returns {Promise<{ ok: boolean, status: number, json(): Promise<any> }>}
   */
  async function request(url, init, timeoutMs = REQUEST_TIMEOUT_MS) {
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

  /** @param {string} path @param {unknown} body @param {number} [timeoutMs] */
  function postRaw(path, body, timeoutMs) {
    return request(
      path,
      {
        method: "POST",
        headers: { "Content-Type": "application/json", "X-PWH": "1" },
        body: JSON.stringify(body),
      },
      timeoutMs,
    );
  }

  /** @param {string} token @returns {Promise<boolean>} */
  async function login(token) {
    try {
      const r = await postRaw(API.login, { token });
      return r.ok;
    } catch {
      return false;
    }
  }

  /** One silent re-login per failure episode (reset by the next `hello`). */
  async function reloginOnce() {
    if (reloginUsed) return false;
    reloginUsed = true;
    const token = deps.storage.getItem(TOKEN_KEY);
    if (!token) return false;
    return login(token);
  }

  /**
   * @param {() => Promise<{ ok: boolean, status: number, json(): Promise<any> }>} send
   */
  async function withRelogin(send) {
    let r = await send();
    if (r.status === 401 && (await reloginOnce())) r = await send();
    return r;
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
        if (name === "hello") {
          reloginUsed = false;
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
        deps.onConn("reconnecting"); // browser auto-reconnects with Last-Event-ID
        return;
      }
      // CLOSED ⇒ HTTP error (401 after hub restart, …): one silent re-login, then back off.
      es = null;
      void reloginOnce().then((ok) => {
        if (closed) return;
        if (!ok && !deps.storage.getItem(TOKEN_KEY)) deps.onConn("auth");
        else deps.onConn("reconnecting");
        scheduleReopen();
      });
    });
    armWatchdog();
  }

  /**
   * §7.2: `withRelogin(() => postRaw(API.cmd, req))` — a 401 re-logs in silently and replays
   * the SAME body (same id ⇒ deduped, D7). Timeout/network ⇒ outcomeFromError's
   * `effect:"unknown"` mapping (queryOnly flow, never auto re-execute).
   * @param {unknown} req @returns {Promise<import("./control.js").CmdOutcome>}
   */
  async function command(req) {
    try {
      const r = await withRelogin(() => postRaw(API.cmd, req, CMD_REQUEST_TIMEOUT_MS));
      return await outcomeFromResponse(r);
    } catch (e) {
      return outcomeFromError(e);
    }
  }

  /** @param {unknown} req @returns {Promise<import("./control.js").CmdOutcome>} */
  async function dialog(req) {
    try {
      const r = await withRelogin(() => postRaw(API.dialog, req, CMD_REQUEST_TIMEOUT_MS));
      return await outcomeFromResponse(r);
    } catch (e) {
      return outcomeFromError(e);
    }
  }

  return {
    /** Log in from the URL fragment (if any), then open the single SSE stream. */
    async start() {
      deps.onConn("connecting");
      const token = readHashToken(deps.location.hash);
      if (token !== undefined) {
        // Clear the fragment first so the token never lingers in the address bar/history.
        deps.history.replaceState(null, "", `${deps.location.pathname}${deps.location.search}`);
        if (await login(token)) deps.storage.setItem(TOKEN_KEY, token);
        else if (!(await reloginOnce())) deps.onConn("auth");
      }
      if (!closed) openStream();
    },
    /** @param {string} clientId @param {string} agentKey @returns {Promise<{ ok: true } | { ok: false, error: string }>} */
    async subscribe(clientId, agentKey) {
      try {
        const r = await withRelogin(() => postRaw(API.subscribe, { clientId, agentKey }));
        return r.ok ? { ok: true } : { ok: false, error: await errorOf(r) };
      } catch (e) {
        return { ok: false, error: e instanceof Error ? e.message : "E_NETWORK" };
      }
    },
    /** @param {string} clientId @param {string} agentKey */
    async unsubscribe(clientId, agentKey) {
      try {
        await postRaw(API.unsubscribe, { clientId, agentKey });
      } catch {
        /* best effort */
      }
    },
    /**
     * @param {string} agentKey @param {string} before @param {number} [limit]
     * @returns {Promise<{ ok: true, data: any } | { ok: false, error: string }>}
     */
    async page(agentKey, before, limit = 200) {
      const n = Math.max(1, Math.min(HISTORY_LIMIT_MAX, Math.floor(limit)));
      const url = `${API.history}?agent=${encodeURIComponent(agentKey)}&before=${encodeURIComponent(before)}&limit=${n}`;
      try {
        const r = await withRelogin(() => request(url, { method: "GET" }));
        if (!r.ok) return { ok: false, error: await errorOf(r) };
        return { ok: true, data: await r.json() };
      } catch (e) {
        return { ok: false, error: e instanceof Error ? e.message : "E_NETWORK" };
      }
    },
    command,
    dialog,
    close() {
      closed = true;
      if (watchdog !== null) deps.clearTimeout(watchdog);
      if (reopenTimer !== null) deps.clearTimeout(reopenTimer);
      watchdog = reopenTimer = null;
      if (es) {
        try {
          es.close();
        } catch {
          /* ignore */
        }
      }
      es = null;
    },
    /** Test/diagnostic hooks. */
    stats() {
      return { opens, open: es !== null, reloginUsed, backoff };
    },
  };
}
