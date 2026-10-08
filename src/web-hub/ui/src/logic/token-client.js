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
import {
  PREVIEW_CLIENT_TIMEOUT_MS,
  PREVIEW_DIR_BODY_MAX_BYTES,
  PREVIEW_IMAGE_MAX_BYTES,
  PREVIEW_PROBE_CLIENT_TIMEOUT_MS,
} from "@protocol/preview.ts";
import { parsePreviewDirListing } from "@protocol/preview.ts";
import { checkPreviewHeaders, previewOutcomeFromResponse } from "./preview.js";
import { parseProbeResults } from "./previewProbe.js";

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

  /**
   * fleet-drawer plan §3.4/§6.5 (F5): run-endpoint error reader — like `errorOf` but ALSO keeps
   * the body's `message` as `reason` (the §3.6 denial vocabulary rides `message` on
   * `/api/run/*`, e.g. 404 `{error:"E_NOT_FOUND", message:"not_persisted"}`). Reads the body
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

  // -------------------------------------------------------------------------
  // headless-spawn endpoints (web-hub-spawn plan SP11 / arch §8.2–§8.3)
  // -------------------------------------------------------------------------

  /**
   * Spawn response → outcome. Mirrors `uploadFromResponse`'s error mapping (Retry-After
   * folding, `retryable` default 429/5xx) but keeps §8.2's spawn-specific fields: a 409
   * `E_CONFIRM_REQUIRED` body's `resolvedCwd`/`reason` (the confirm view's inputs). Unlike
   * uploads there is no busy-retry wrapper — spawn's 503 is `E_LAUNCHER`, a policy state the
   * UI shows, never an auto-retry. `r.json()` is read exactly once.
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
    return out;
  }

  /**
   * Fetch-level failure for a spawn call (same table as `uploadFromError`): timeout
   * `E_DEADLINE` (retryable — §3.2 resends the SAME id once; the hub's idempotency LRU
   * dedupes it into `dup:true`), external abort `E_ABORT` (never retryable), anything else
   * `E_NETWORK` (retryable — same resend rule).
   * @param {unknown} err
   */
  function spawnFromError(err) {
    const msg = err instanceof Error ? err.message : String(err);
    if (msg === "E_DEADLINE") return { ok: false, error: "E_DEADLINE", retryable: true, status: 0 };
    if (msg === "E_ABORT") return { ok: false, error: "E_ABORT", retryable: false, status: 0 };
    return { ok: false, error: "E_NETWORK", message: msg, retryable: true, status: 0 };
  }

  /**
   * default-model plan F1 (D1): narrow `GET /api/headless`'s optional `prefs` slot — only a
   * well-formed `{defaultModel: string|null}` rides through; anything else (a pre-feature hub
   * sends nothing, a corrupt one sends garbage) drops the field entirely so every reader can
   * trust the typed shape.
   * @param {any} d
   */
  function narrowPrefs(d) {
    const p = d !== null && typeof d === "object" ? d.prefs : undefined;
    if (p === null || typeof p !== "object") return {};
    return { prefs: { defaultModel: typeof p.defaultModel === "string" ? p.defaultModel : null } };
  }

  /**
   * The four `/api/headless*` endpoints (arch §8.2). All ride `withRelogin` — a 401 re-logs in
   * silently with the stored token and replays: `start` is idempotent by `id` (hub LRU ⇒
   * `dup:true`, plan §3.2), `stop` is idempotent on a terminal record (202 with the current
   * state), the two GETs are side-effect free. The GETs carry `X-PWH: 1` (arch §8.2's CSRF
   * gate requires it on every `/api/headless*` request, reads included). 404s ride back
   * verbatim — arch §8.3: the UI treats a list 404 as "feature off / LAN off ⇒ unavailable",
   * never as an error worth surfacing.
   */
  const spawn = {
    /** @returns {Promise<any>} */
    async list() {
      try {
        const r = await withRelogin(() => request(API.headless, { method: "GET", headers: { "X-PWH": "1" } }));
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
        const r = await withRelogin(() => request(API.headlessDirs, { method: "GET", headers: { "X-PWH": "1" } }));
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
        const r = await withRelogin(() => postRaw(API.headless, req, CMD_REQUEST_TIMEOUT_MS));
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
        const r = await withRelogin(() =>
          postRaw(
            `${API.headless}/${encodeURIComponent(spawnId)}/stop`,
            force === true ? { force: true } : {},
            CMD_REQUEST_TIMEOUT_MS,
          ),
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
     * default-model plan F1 (§3 ④): `POST /api/headless/prefs`. `""` clears the preference
     * (explicit pi default); a non-empty value is a `parseSpawnModelRef`-valid `provider/id`
     * (the settings card validates locally first — a 400 `E_BAD_REQUEST{reason:"model-invalid"}`
     * here means the two sides drifted). Rides `withRelogin` like the other four endpoints
     * (idempotent: the same value simply re-persists). 200 `{prefs}` is the authoritative
     * post-write value and rides back verbatim (narrowed).
     * @param {string} defaultModel @returns {Promise<any>}
     */
    async setPrefs(defaultModel) {
      try {
        const r = await withRelogin(() => postRaw(API.headlessPrefs, { defaultModel }, CMD_REQUEST_TIMEOUT_MS));
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
  };

  // -------------------------------------------------------------------------
  // card removal (web-hub-delete-session plan v2 §4.1/§5.3): POST /api/agents/remove. Shape
  // copied from spawn.stop — a 401 retries once through `withRelogin` (the endpoint is
  // idempotent: a pending/already-removed target just repeats its outcome). The error half
  // reuses `spawnFromResponse`'s mapping (it already carries `reason`), re-shaped without the
  // spawn-specific `resolvedCwd` field the remove endpoint never sends.
  // -------------------------------------------------------------------------

  /**
   * @param {{agentKey: string} | {spawnId: string}} target
   * @returns {Promise<any>}
   */
  async function removeAgent(target) {
    try {
      const r = await withRelogin(() => postRaw(API.agentRemove, target, CMD_REQUEST_TIMEOUT_MS));
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

  // -------------------------------------------------------------------------
  // content-preview endpoint (web-hub-preview plan v3 §3.2/§4.6, package PV4)
  // -------------------------------------------------------------------------

  /**
   * `GET /api/preview` (§4.6). Header-driven: the response's `X-PWH-Preview-*` /
   * `Content-Length` / `Content-Type` are validated by `checkPreviewHeaders` BEFORE the body
   * is read — an over-budget image (client `maxPixels`, or Content-Length over the loopback
   * 16 MiB cap) aborts the fetch locally and returns the mirrored error without ever pulling
   * the bytes. One 40s deadline (`PREVIEW_CLIENT_TIMEOUT_MS`, §0 客户端超时) spans headers AND
   * body, merged with the caller's `signal` (usePreview's per-open controller) exactly like
   * `request()` does. A 401 rides `withRelogin` (silent re-login + same-URL replay, GET ⇒
   * side-effect free); the FINAL 401 surfaces as `E_AUTH` and `transport/token.ts`'s
   * `withAuthNotice` flips the login view. A body whose byte count doesn't match
   * `Content-Length` ⇒ `E_PREVIEW_CHANGED` (the hub `destroy()`s a mid-stream identity/hash
   * failure, plan §4.5.2 — an incomplete body must never be shown as complete).
   *
   * dir-plan §5 P2: `req.dir === true` appends `&dir=1` and unlocks the `Kind: dir` response
   * — a capped JSON read under the SAME 40s deadline (never beyond
   * `PREVIEW_DIR_BODY_MAX_BYTES` DECODED bytes — gzip included, the cap never judges
   * Content-Length), then `parsePreviewDirListing` is the contract gate. An un-opt-in-ed
   * request receiving `Kind: dir` fails `checkPreviewHeaders` (`E_BAD_RESPONSE`, §1.3's fetch
   * path — a single-response contract violation, body aborted unread).
   * @param {{ agentKey: string, sessionId: string, path: string, dir?: true }} req
   * @param {{ signal?: any, maxPixels?: number }} [opts]
   * @returns {Promise<any>}
   */
  async function previewFetch(req, opts) {
    const signal = opts !== undefined ? opts.signal : undefined;
    const maxPixels = opts !== undefined && typeof opts.maxPixels === "number" ? opts.maxPixels : undefined;
    if (signal !== undefined && signal !== null && signal.aborted === true) {
      return { ok: false, status: 0, error: "E_ABORT" };
    }
    const url = `${API.preview}?agentKey=${encodeURIComponent(req.agentKey)}&sessionId=${encodeURIComponent(req.sessionId)}&path=${encodeURIComponent(req.path)}${req.dir === true ? "&dir=1" : ""}`;
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
      const send = () =>
        deps.fetch(url, {
          credentials: "same-origin",
          method: "GET",
          headers: { "X-PWH": "1" },
          ...(ac ? { signal: ac.signal } : {}),
        });
      /** @type {any} */
      let r;
      try {
        r = await Promise.race([withRelogin(send), deadline]);
      } catch (e) {
        return fromError(e);
      }
      if (!r.ok) return await previewOutcomeFromResponse(r);
      const chk = checkPreviewHeaders(r.headers, {
        imageMaxBytes: PREVIEW_IMAGE_MAX_BYTES.loopback,
        ...(maxPixels !== undefined ? { maxPixels } : {}),
        dir: req.dir === true,
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
        text: new TextDecoder().decode(buf),
      };
    } finally {
      deps.clearTimeout(deadlineTimer);
      if (onExternalAbort !== null && signal && typeof signal.removeEventListener === "function") {
        signal.removeEventListener("abort", onExternalAbort);
      }
    }
  }

  /**
   * `POST /api/preview/probe` (2026-10-07 修订「先探测后标记」) — the batch existence probe.
   * Same auth/CSRF surface as `previewFetch` (cookie credentials + `X-PWH: 1`, 401 rides
   * `withRelogin` — POST /api/preview/probe is idempotent read-only probing, replay-safe);
   * ONE request carries a whole message's candidates. One 5s deadline
   * (`PREVIEW_PROBE_CLIENT_TIMEOUT_MS`) spans headers+body, merged with the caller's
   * `signal`; the 200 body is validated by `parseProbeResults` (length + kinds) and ANY
   * deviation maps to a local `E_BAD_RESPONSE`. The caller (usePreviewProbe) degrades a
   * failed batch wholesale to plain text — never a retry storm.
   *
   * dir-plan §1.3/§5 P2: `req.dirs === true` adds `dirs:true` to the JSON body (directories
   * then answer `"dir"`); a dirs-LESS request that still receives `"dir"` folds that ENTRY
   * to `"missing"` — a version mismatch is entry-level, and for this client the click
   * genuinely could not succeed (it never sends `dir=1`), which is exactly probe `missing`'s
   * definition. A whole-batch `E_BAD_RESPONSE` would degrade every candidate for one bad
   * entry — deliberately NOT taken here.
   * @param {{ agentKey: string, sessionId: string, paths: readonly string[], dirs?: true }} req
   * @param {{ signal?: any }} [opts]
   * @returns {Promise<any>}
   */
  async function probePost(req, opts) {
    const signal = opts !== undefined ? opts.signal : undefined;
    if (signal !== undefined && signal !== null && signal.aborted === true) {
      return { ok: false, status: 0, error: "E_ABORT" };
    }
    const dirs = req.dirs === true;
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
      const send = () =>
        deps.fetch(url, {
          credentials: "same-origin",
          method: "POST",
          headers: { "Content-Type": "application/json", "X-PWH": "1" },
          body: JSON.stringify(dirs ? { paths: req.paths, dirs: true } : { paths: req.paths }),
          ...(ac ? { signal: ac.signal } : {}),
        });
      /** @type {any} */
      let r;
      try {
        r = await Promise.race([withRelogin(send), deadline]);
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
      const kinds = dirs ? parsed.kinds : parsed.kinds.map((k) => (k === "dir" ? "missing" : k));
      return { ok: true, results: kinds };
    } finally {
      deps.clearTimeout(deadlineTimer);
      if (onExternalAbort !== null && signal && typeof signal.removeEventListener === "function") {
        signal.removeEventListener("abort", onExternalAbort);
      }
    }
  }

  const preview = { fetch: previewFetch, probe: probePost };

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
    // -----------------------------------------------------------------------
    // run-transcript endpoints (fleet-drawer plan §3.4/§6.5, package F5)
    // -----------------------------------------------------------------------
    /**
     * POST /api/run/subscribe — same `withRelogin` dance as `subscribe` (§6.5 table: a 401
     * re-logs in silently and replays; the hub's sub is idempotent per clientId+run). 202
     * `{ok:true}` means the snapshot rides SSE `run_history`; the §3.6 denial body's `message`
     * is surfaced as `reason`.
     * @param {string} clientId @param {string} agentKey @param {string} runId
     * @returns {Promise<{ ok: true } | { ok: false, error: string, reason?: string }>}
     */
    async runSubscribe(clientId, agentKey, runId) {
      try {
        const r = await withRelogin(() => postRaw(API.runSubscribe, { clientId, agentKey, runId }));
        if (r.ok) return { ok: true };
        return { ok: false, ...(await runErrorOf(r)) };
      } catch (e) {
        return { ok: false, error: e instanceof Error ? e.message : "E_NETWORK" };
      }
    },
    /**
     * POST /api/run/unsubscribe — fire-and-forget, failures swallowed (§6.5 table: “发出即不管，
     * 吞掉失败（同 unsubscribe）”； the transport adapter's fetch wrapper still reports a 401 so
     * a dead session surfaces, exactly like `unsubscribe`).
     * @param {string} clientId @param {string} agentKey @param {string} runId
     */
    async runUnsubscribe(clientId, agentKey, runId) {
      try {
        await postRaw(API.runUnsubscribe, { clientId, agentKey, runId });
      } catch {
        /* best effort */
      }
    },
    /**
     * GET /api/run/history (§3.4: `?agent=&run=&before=&limit=`) — one older page for a run
     * transcript; `live` is always false in the reply (the GET never attaches a tap).
     * @param {string} agentKey @param {string} runId @param {string} before @param {number} [limit]
     * @returns {Promise<{ ok: true, data: any } | { ok: false, error: string, reason?: string }>}
     */
    async runPage(agentKey, runId, before, limit = 200) {
      const n = Math.max(1, Math.min(HISTORY_LIMIT_MAX, Math.floor(limit)));
      const url = `${API.runHistory}?agent=${encodeURIComponent(agentKey)}&run=${encodeURIComponent(runId)}&before=${encodeURIComponent(before)}&limit=${n}`;
      try {
        const r = await withRelogin(() => request(url, { method: "GET" }));
        if (!r.ok) return { ok: false, ...(await runErrorOf(r)) };
        return { ok: true, data: await r.json() };
      } catch (e) {
        return { ok: false, error: e instanceof Error ? e.message : "E_NETWORK" };
      }
    },
    command,
    dialog,
    upload,
    spawn,
    removeAgent,
    preview,
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
