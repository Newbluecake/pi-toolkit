/**
 * Token-mode transport (extracted from `app.js` — vue-plan.md v2.1 §3.1, §5.2 — P0).
 * All I/O injected (tests drive it with fakes): `#t=` hash → POST /api/login (X-PWH:1) →
 * token kept in localStorage → `history.replaceState` clears the hash; exactly ONE
 * EventSource per tab; 45s without any frame ⇒ close + reopen; 401 (API or a CLOSED
 * EventSource) ⇒ one silent re-login with the stored token. Every request has a deadline
 * (AbortController), every timer is cleared on close.
 *
 * The EventSource lifecycle itself (one stream per tab, the 45s-silence watchdog, the
 * exponential reopen backoff, the connect-handshake deadline) is shared with the password
 * client through `./transport-core.js` (source-governance batch2 ⑩-U — extracted verbatim);
 * this file keeps only the token-mode differences: the `#t=`/localStorage login handshake,
 * the one-shot silent `reloginOnce` refresh, and the 401 `withRelogin` dance.
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
  parseWtGraphCommitFiles,
  WTGRAPH_FILES_BODY_MAX_BYTES,
  WTGRAPH_FILES_CLIENT_TIMEOUT_MS,
  WTGRAPH_FILES_QUERY,
} from "@protocol/worktree-graph.ts";
import { checkPreviewHeaders, previewOutcomeFromResponse } from "./preview.js";
import { parseProbeResults } from "./previewProbe.js";
import { historyOutcomeFromResponse } from "./sessionHistory.ts";
import { LOAD_TOP_BODY_MAX_BYTES, LOAD_TOP_CLIENT_TIMEOUT_MS, parseLoadTopWire } from "./load.js";
import { parseVersionInfoWire, VERSION_LIMITS } from "@protocol/version-info.ts";
import { AVATAR_DELETE_PATH, AVATAR_PATH } from "@protocol/avatar.ts";
import { validateAvatarPng } from "@protocol/avatar-png.ts";

export const TOKEN_KEY = "pwh_token";
export const REQUEST_TIMEOUT_MS = 10_000;
export const CMD_REQUEST_TIMEOUT_MS = 16_000; // control-plan §3.3 browser write budget
// web-hub-upload plan §4.2/§1.2 (package U4b): a 503 `E_BUSY` (startup scan not finished, §2.2.4)
// is auto-retried on a bounded backoff before it ever reaches the tray. Mirrors
// password-client's login busy policy (`BUSY_RETRY_MAX`/`BUSY_RETRY_DEFAULT_MS`) — restated
// here rather than imported so the two transports stay independent modules (the same
// duplication `REQUEST_TIMEOUT_MS` already carries); `transport-contract.test.ts`'s shared
// upload suite pins both sides to identical behavior.
export const UPLOAD_BUSY_RETRY_MAX = 5;
export const UPLOAD_BUSY_RETRY_DEFAULT_MS = 2_000;

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
  const timer = createTimer(deps);
  let reloginUsed = false;
  const stream = createStreamLifecycle(deps, {
    /** One silent re-login per failure episode (reset by the next `hello`). */
    onHello() {
      reloginUsed = false;
    },
    /**
     * CLOSED ⇒ HTTP error (401 after hub restart, …): one silent re-login, then back off.
     * The connect deadline was already cleared by the lifecycle core before this hook runs —
     * it must not race the relogin/reopen flow.
     */
    onClosedError() {
      stream.clearCurrent(); // the CLOSED source is dead, never reused
      void reloginOnce().then((ok) => {
        if (stream.isClosed()) return;
        if (!ok && !deps.storage.getItem(TOKEN_KEY)) deps.onConn("auth");
        else deps.onConn("reconnecting");
        stream.scheduleReopen();
      });
    },
  });

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
      if (busyAttempts > UPLOAD_BUSY_RETRY_MAX || stream.isClosed()) return out;
      const ms = out.retryAfterS !== undefined ? out.retryAfterS * 1000 : UPLOAD_BUSY_RETRY_DEFAULT_MS;
      await sleep(ms);
      if (stream.isClosed()) return out; // closed during the backoff — stop hammering a dead client
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
    // created-dirs plan r2 §4: the LAN-only E_DIR cause (additive — a pre-feature hub
    // simply never sends it; unknown values ride through, the UI maps/falls back).
    if (typeof b.detail === "string") out.detail = b.detail;
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
    /**
     * session-history plan §4.7.1: `GET /api/headless/history`. Querystring built from the
     * frozen `HistoryQueryWire` (blank `q` omitted — §3.6 treats it as unset; `kind` only
     * when `"all"`; `cursor`/`limit` only when present). A 200 body runs through
     * `narrowHistoryPage` (structural narrowing — non-conforming items dropped, a missing
     * `stats.enum` counts as complete); a non-object body maps to `E_BAD_RESPONSE`. A 409
     * keeps its `reason` (`"cursor-expired"`) so the list reducer can auto-restart once.
     * Rides `withRelogin` like the other GETs (side-effect free, replay safe). The narrowing
     * helper lives in `./session-history.ts` (this file's `.js`→`.ts` specifier rule, same
     * as `contract.js`'s `@protocol/http-contract.ts`).
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
        const r = await withRelogin(() => request(url, { method: "GET", headers: { "X-PWH": "1" } }));
        return await historyOutcomeFromResponse(r);
      } catch (e) {
        return { ok: false, error: spawnFromError(e).error, status: 0 };
      }
    },
    /**
     * spawn-dirmkdir: `POST /api/headless/mkdir` — create ONE folder inside an admitted parent
     * (the DirPicker browse panel's 「新建文件夹」). Rides `withRelogin` like the other
     * endpoints (a replayed POST after re-login is safe: an already-created name answers 409
     * `E_CONFLICT{reason:"exists"}` instead of a second create). The 200 `{path}` echo (the
     * RESOLVED absolute path) rides back verbatim; the error half keeps `reason` so the
     * picker's classified error line (`exists`/`permission`/`readonly`/…) works.
     * @param {string} path @param {string} name @returns {Promise<any>}
     */
    async mkdir(path, name) {
      try {
        const r = await withRelogin(() => postRaw(API.headlessMkdir, { path, name }, CMD_REQUEST_TIMEOUT_MS));
        const out = await spawnFromResponse(r);
        if (out.ok === false) {
          /** @type {any} */
          const err = { ok: false, error: out.error, status: out.status };
          if (typeof out.reason === "string") err.reason = out.reason;
          if (typeof out.retryAfterS === "number") err.retryAfterS = out.retryAfterS;
          return err;
        }
        const d = out.data;
        // created-dirs plan r2 §4: `known:true` (created inside the spawn roots ⇒ already a
        // known spawn dir) rides only when the hub sent exactly that.
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
     * spawn-relaunch: `POST /api/headless/relaunch` — re-fork a terminal managed record's
     * session. Rides `withRelogin` like the other endpoints — a replayed POST after re-login
     * is safe: the hub's relaunch is idempotent on a non-terminal record (`dup:true`, never a
     * second fork). The 202 `{spawnId, state, dup?}` rides back (narrowed); the error half
     * keeps `reason`/`status` so AgentList's `classifyRelaunchError` buckets it.
     * @param {string} spawnId @returns {Promise<any>}
     */
    async relaunch(spawnId) {
      try {
        const r = await withRelogin(() => postRaw(API.headlessRelaunch, { spawnId }, CMD_REQUEST_TIMEOUT_MS));
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
   * chunked-plan §4.1 (P2a): normalize `req.chunk` (`true` = first chunk, `{offset, ident}`
   * = continuation) into the query suffix + the `checkPreviewHeaders` gate object. `chunk`
   * combined with `dir` is a protocol violation (§2.2 mutual exclusion) rejected LOCALLY
   * with `E_BAD_REQUEST` — never sent. A malformed chunk object (non-integer/negative
   * offset, invalid ident) is rejected the same way; the hub would 400 it anyway.
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
      const send = () =>
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
   * mint ONE path-shaped capability for an admitted HTML entry (body `{path}`). `probePost`
   * skeleton (same shape, own AbortController, external-signal merge) with TWO deliberate
   * differences the plan freezes:
   * - the deadline is `PREVIEW_ADMIT_TOTAL_MS` (8 s — the hub's own §2.1 mint budget reuses the
   *   same constant), not the 5 s probe budget;
   * - **NO POST replay**: a mint is NOT idempotent (§0 non-goals — every mint is a new cap, no
   *   dedup), so this call deliberately does NOT ride `withRelogin`. A 401 surfaces as the
   * final `E_AUTH` error half and `transport/token.ts`'s `withAuthNotice` flips the login
   * view; replaying it after a silent re-login would mint a SECOND cap for the same file.
   *
   * The 200 body is the protocol's `PreviewHtmlCapResponseBody`, structurally validated here
   * (`url` starts `/pv/`, `openUrl` starts `/pvw/`, `idleMs`/`hardRemainingMs` finite ≥ 0) — any
   * deviation ⇒ local `E_BAD_RESPONSE` (status 0). Non-200 bodies ride through
   * `previewOutcomeFromResponse` (keeps a 403 `E_PREVIEW_DENIED{reason:"dir-too-broad"|"upload"}`
   * verbatim for the UI's source-switch decision); `Retry-After` folds exactly like every
   * other preview namespace method.
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
        // No withRelogin here BY DESIGN (see the doc comment): one-shot POST, never replayed.
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
   * preview-download: `GET /api/preview?download=1` — raw bytes of ANY admitted regular
   * file (the preview dialog's 「下载」 button + the unsupported-phase offer). Same skeleton
   * as `previewFetch` (X-PWH: 1, `withRelogin` — a GET is replay-safe), with the download
   * opt-in branch of `checkPreviewHeaders` as the header contract and a Content-Length body
   * oracle (an incomplete body ⇒ `E_PREVIEW_CHANGED`, same as the image/text flows). The
   * deadline is `PREVIEW_DOWNLOAD_STREAM_MS + 30s` — the hub streams up to 120s for the
   * 256 MiB cap, so the 40s preview timeout would cut big downloads mid-stream.
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
   * The shared capped-JSON GET behind `GET /api/worktree-diff/{files,file}` — the same flow
   * as `previewFetch`'s dir branch: ONE `WTDIFF_CLIENT_TIMEOUT_MS` deadline spans headers AND
   * body, merged with the caller's `signal` exactly like `request()` does; a 401 rides
   * `withRelogin` (silent re-login + same-URL replay — GET ⇒ side-effect free); the FINAL 401
   * surfaces as `E_AUTH` and `transport/token.ts`'s `withAuthNotice` flips the login view.
   * The 200 body is a capped JSON envelope (the cap judges DECODED bytes — gzip included,
   * never Content-Length): over `maxBytes` ⇒ abort the fetch so the server stops sending +
   * local `E_BAD_RESPONSE` (status 0). `JSON.parse` then the protocol parser
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
   * `GET /api/worktree-graph` — the worktree commit-graph payload, riding the exact same
   * capped-JSON GET flow as `wtdiffGet` above (one deadline spanning headers AND body,
   * merged with the caller's `signal`; decoded-byte cap with mid-stream abort; JSON.parse →
   * protocol parser as the contract gate; non-200 `{error, reason}` riding verbatim). Only
   * the three knobs differ, all imported from the frozen P0 protocol module: the
   * `WTGRAPH_BODY_MAX_BYTES` 512 KiB body cap (§2.5's three-stage trim keeps the hub under
   * it), the `WTGRAPH_CLIENT_TIMEOUT_MS` 35 s deadline (§2.4's 23 s server wall-clock +
   * transfer reserve), and `parseWtGraphPayload` as the gate — a STRICT key-whitelist
   * parser, so any off-contract member anywhere ⇒ `null` ⇒ local `E_BAD_RESPONSE`
   * (status 0), never silently ignored. Error reasons ride the REUSED codes verbatim: 504
   * `E_DEADLINE{reason:"log-timeout"}`, 503 `E_WTDIFF_UNSUPPORTED{reason:"missing-object"|
   * "git-too-old"}`, 500 `E_INTERNAL{reason:"git-failed"}` — this layer never retries on
   * its own (the UI owns the retry, §4.3).
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

  /**
   * `GET /api/worktree-graph/files?agentKey&sessionId&wt&h` (wtgraph.files.v1) — one served
   * commit's changed files (first-parent diff). Same capped-JSON GET flow as `wtgraphGet`, with
   * `WTGRAPH_FILES_BODY_MAX_BYTES` / `WTGRAPH_FILES_CLIENT_TIMEOUT_MS` and the strict
   * `parseWtGraphCommitFiles` gate; 409 `E_STALE_CTX{reason:"commit"}` (the oid is not in a graph
   * window the hub served) rides verbatim — the UI re-pulls the graph, this layer never retries.
   * @param {{ agentKey: string, sessionId: string, wt: string, h: string }} req
   * @param {{ signal?: any }} [opts]
   * @returns {Promise<any>}
   */
  async function wtgraphFiles(req, opts) {
    const signal = opts !== undefined ? opts.signal : undefined;
    if (signal !== undefined && signal !== null && signal.aborted === true) {
      return { ok: false, status: 0, error: "E_ABORT" };
    }
    const url = `${API.wtgraphFiles}?agentKey=${encodeURIComponent(req.agentKey)}&sessionId=${encodeURIComponent(req.sessionId)}&wt=${encodeURIComponent(req.wt)}&${WTGRAPH_FILES_QUERY}=${encodeURIComponent(req.h)}`;
    return await wtdiffGet(
      url,
      WTGRAPH_FILES_BODY_MAX_BYTES,
      parseWtGraphCommitFiles,
      signal,
      WTGRAPH_FILES_CLIENT_TIMEOUT_MS,
    );
  }

  const worktreeGraph = { graph: wtgraph, commitFiles: wtgraphFiles };

  // -------------------------------------------------------------------------
  // sysload plan §7.1/§7.3/§10 (package P4): `GET /api/load/top`
  // -------------------------------------------------------------------------

  /**
   * `GET /api/load/top` (§7.3) — the on-demand top-process snapshot, reusing `wtdiffGet`'s
   * capped-JSON GET flow with sysload-specific knobs (`LOAD_TOP_BODY_MAX_BYTES`/
   * `LOAD_TOP_CLIENT_TIMEOUT_MS`, `@logic/load.js`) and `parseLoadTopWire` as the contract gate
   * (no query params — the endpoint is hub-global, same posture as the `load` SSE event). A
   * 401 rides `withRelogin` (silent re-login + replay, GET ⇒ side-effect free) — the final
   * `E_AUTH` flips the login view via `transport/token.ts`'s `withAuthNotice`, same as every
   * other read-only endpoint here.
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
  // web-hub-version plan §5.1 (V2): `GET /api/version`
  // -------------------------------------------------------------------------

  /**
   * `GET /api/version` (V0's frozen `VERSION_INFO_PATH`, mirrored into `API.versionInfo`) —
   * the version/compat snapshot for the version chip + panel. Same capped-JSON GET flow as
   * `loadTop` above with the plan's own knobs: body cap `VERSION_LIMITS.bodyBytes` (§8's
   * ≤64 KiB response budget — the hub already trims to it) and a client deadline padded above
   * the endpoint's server-side wall clock (hub budget 4s + the parallel `ui.probe()` wait;
   * LAN rides `deriveBudget(8000, …)` — `VERSION_INFO_CLIENT_TIMEOUT_MS` below covers both).
   * `parseVersionInfoWire` (V0, imported — never re-implemented) is the contract gate; a 401
   * rides `withRelogin` (silent re-login + replay, GET ⇒ side-effect free) exactly like
   * `loadTop`.
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
      const r = await withRelogin(() => request(AVATAR_PATH, { method: "GET", headers }, REQUEST_TIMEOUT_MS, signal));
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
  // web-hub-privacy plan v2.1 (P1, 传输层 only — P2 owns the views): `verify` (LAN-only
  // endpoint; a loopback/token hub 404s it and P2 renders the click-to-confirm variant there)
  // and `lock` (both listeners; LAN unlock carries an inline `password`). A wrong password is
  // a 200 verdict (`data.ok === false`), NEVER an error — 401 is reserved for a lost session.
  // A 429 carries `retryAfterS` (the login limiter's Retry-After — same countdown UI).
  // ---------------------------------------------------------------------------
  /**
   * @param {string} path @param {unknown} body
   * @returns {Promise<{ ok: true, data: { ok: boolean } } | { ok: false, error: string, status?: number, retryAfterS?: number }>}
   */
  async function privacyPost(path, body) {
    try {
      const r = await withRelogin(() => postRaw(path, body, CMD_REQUEST_TIMEOUT_MS));
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
  // web-hub-proxy plan v2 §3.8/§8 (X2): `POST /api/proxy/open` · `GET /api/proxy` ·
  // `POST /api/proxy/stop`. Every call is one request through `withRelogin` (a 401 means the
  // request was never processed, so the replay after a silent re-login is safe); the response
  // is folded by `proxyFetch` and gated by the `parseProxy*` contract parsers.
  // -------------------------------------------------------------------------
  /** @param {string} path @param {unknown} body @param {(raw: unknown) => any} parse @param {number} max @param {any} [signal] */
  function proxyPost(path, body, parse, max, signal) {
    return proxyFetch(
      () => withRelogin(() => postRaw(path, body, PROXY_CLIENT_TIMEOUT_MS, signal)),
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
          withRelogin(() =>
            request(API.proxyList, { method: "GET", headers: { "X-PWH": "1" } }, PROXY_CLIENT_TIMEOUT_MS, opts?.signal),
          ),
        parseProxyList,
        PROXY_LIST_BODY_MAX_BYTES,
        opts?.signal,
      ),
    /** @param {string} instanceId @param {{ signal?: any }} [opts] */
    stop: (instanceId, opts) =>
      proxyPost(API.proxyStop, { instanceId }, parseProxyStop, PROXY_OPEN_BODY_MAX_BYTES, opts?.signal),
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
      if (!stream.isClosed()) stream.openStream();
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
    worktreeDiff,
    worktreeGraph,
    loadTop,
    versionInfo,
    avatar,
    privacy,
    proxy,
    close() {
      stream.close();
    },
    /** Test/diagnostic hooks. */
    stats() {
      const s = stream.stats();
      return { opens: s.opens, open: s.open, reloginUsed, backoff: s.backoff };
    },
  };
}
