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
// web-hub-upload plan §4.2/§1.2 (package U4b): a 503 `E_BUSY` (startup scan not finished, §2.2.4)
// is auto-retried on a bounded backoff before it ever reaches the tray. Mirrors
// password-client's login busy policy (`BUSY_RETRY_MAX`/`BUSY_RETRY_DEFAULT_MS`) — restated
// here rather than imported so the two transports stay independent modules (the same
// duplication `REQUEST_TIMEOUT_MS` already carries); `transport-contract.test.ts`'s shared
// upload suite pins both sides to identical behavior.
export const UPLOAD_BUSY_RETRY_MAX = 5;
export const UPLOAD_BUSY_RETRY_DEFAULT_MS = 2_000;
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
   * Fetch with a deadline. The optional `signal` (web-hub-upload plan U4b: chunk abort-on-remove)
   * is MERGED with the internal timeout controller — whoever fires first wins, and the shared
   * controller aborts the underlying fetch either way. A pre-aborted signal never issues the
   * fetch at all. External aborts surface as `Error("E_ABORT")`, timeouts as `Error("E_DEADLINE")`.
   * @param {string} url
   * @param {any} init
   * @param {number} [timeoutMs]
   * @param {{ aborted?: boolean, addEventListener?: (t: string, fn: () => void, o?: any) => void,
   *   removeEventListener?: (t: string, fn: () => void) => void }} [signal]
   * @returns {Promise<{ ok: boolean, status: number, json(): Promise<any> }>}
   */
  async function request(url, init, timeoutMs = REQUEST_TIMEOUT_MS, signal) {
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
    // External-signal merge: a rejection racing the fetch/timeout; `Promise.race` attaches
    // handlers to every racer, so the losers' later rejections (the aborted fetch itself) are
    // swallowed rather than becoming unhandled rejections.
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

  /** @param {string} path @param {unknown} body @param {number} [timeoutMs] @param {any} [signal] */
  function postRaw(path, body, timeoutMs, signal) {
    return request(
      path,
      {
        method: "POST",
        headers: { "Content-Type": "application/json", "X-PWH": "1" },
        body: JSON.stringify(body),
      },
      timeoutMs,
      signal,
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

  // -------------------------------------------------------------------------
  // upload endpoints (web-hub-upload plan §1.2/§4.3, package U4b)
  // -------------------------------------------------------------------------

  /** @param {number} ms */
  const sleep = (ms) => new Promise((resolve) => timer(resolve, ms));

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
   * item is being removed/retried, late events are swallowed by the reducer anyway), anything
   * else `E_NETWORK`.
   * @param {unknown} err
   */
  function uploadFromError(err) {
    const msg = err instanceof Error ? err.message : String(err);
    if (msg === "E_DEADLINE") return { ok: false, error: "E_DEADLINE", retryable: true };
    if (msg === "E_ABORT") return { ok: false, error: "E_ABORT", retryable: false };
    return { ok: false, error: "E_NETWORK", message: msg, retryable: true };
  }

  /**
   * §4.2/§1.2: 503 `E_BUSY` (startup scan) retries on the login busy backoff — `Retry-After`
   * header seconds when present, else `UPLOAD_BUSY_RETRY_DEFAULT_MS` — at most
   * `UPLOAD_BUSY_RETRY_MAX` times before the (retryable) outcome surfaces. `send` never throws
   * (fetch failures are mapped inside); a client `close()` or an aborted signal ends the loop
   * on the next attempt instead of sleeping forever.
   * @param {() => Promise<any>} send
   */
  async function uploadWithBusyRetry(send) {
    let busyAttempts = 0;
    for (;;) {
      const out = await send();
      if (!(out.ok === false && out.error === "E_BUSY")) return out;
      busyAttempts++;
      if (busyAttempts > UPLOAD_BUSY_RETRY_MAX || closed) return out;
      const ms = out.retryAfterS !== undefined ? out.retryAfterS * 1000 : UPLOAD_BUSY_RETRY_DEFAULT_MS;
      await sleep(ms);
      if (closed) return out; // closed during the backoff — stop hammering a dead client
    }
  }

  /**
   * The four upload endpoints (§1.2). All of them ride `withRelogin` — a 401 re-logs in
   * silently with the stored token and replays: `begin`/`commit`/`abort` are idempotent by id,
   * and a replayed `chunk` either lands (`offset+len === received` ⇒ `dup:true`) or 409s with
   * the authoritative `received` for the caller to resync on. `chunk` goes through `request()`
   * as raw `application/octet-stream` bytes (never JSON/base64) with the merged external
   * abort signal so a tray remove interrupts the in-flight POST immediately.
   */
  const upload = {
    /**
     * @param {{ agentKey: string, id: string, name: string, size: number, mime?: string }} p
     * @param {any} [signal]
     * @returns {Promise<any>}
     */
    async begin(p, signal) {
      return uploadWithBusyRetry(async () => {
        try {
          const r = await withRelogin(() => postRaw(API.uploadBegin, p, CMD_REQUEST_TIMEOUT_MS, signal));
          return await uploadFromResponse(r);
        } catch (e) {
          return uploadFromError(e);
        }
      });
    },
    /**
     * @param {{ id: string, offset: number, bytes: Uint8Array }} p
     * @param {any} [signal]
     * @returns {Promise<any>}
     */
    async chunk(p, signal) {
      return uploadWithBusyRetry(async () => {
        try {
          const url = `${API.uploadChunk}?id=${encodeURIComponent(p.id)}&offset=${p.offset}`;
          const r = await withRelogin(() =>
            request(
              url,
              {
                method: "POST",
                headers: { "Content-Type": "application/octet-stream", "X-PWH": "1" },
                body: p.bytes,
              },
              CMD_REQUEST_TIMEOUT_MS,
              signal,
            ),
          );
          return await uploadFromResponse(r);
        } catch (e) {
          return uploadFromError(e);
        }
      });
    },
    /**
     * @param {{ id: string }} p
     * @param {any} [signal]
     * @returns {Promise<any>}
     */
    async commit(p, signal) {
      return uploadWithBusyRetry(async () => {
        try {
          const r = await withRelogin(() => postRaw(API.uploadCommit, p, CMD_REQUEST_TIMEOUT_MS, signal));
          return await uploadFromResponse(r);
        } catch (e) {
          return uploadFromError(e);
        }
      });
    },
    /**
     * Best-effort cleanup (§4.2 tray removal) — no external signal: an abort endpoint call
     * must never be cancelled by the very removal that triggered it.
     * @param {{ id: string }} p
     * @returns {Promise<any>}
     */
    async abort(p) {
      return uploadWithBusyRetry(async () => {
        try {
          const r = await withRelogin(() => postRaw(API.uploadAbort, p, CMD_REQUEST_TIMEOUT_MS));
          return await uploadFromResponse(r);
        } catch (e) {
          return uploadFromError(e);
        }
      });
    },
  };

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
    upload,
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
