/**
 * web-hub browser entry (plan §包 E). Two parts:
 *
 * - `createClient(deps)` — transport only, all I/O injected (tests drive it
 *   with fakes): `#t=` hash → POST /api/login (X-PWH:1) → token kept in
 *   localStorage → `history.replaceState` clears the hash; exactly ONE
 *   EventSource per tab; 45s without any frame ⇒ close + reopen; 401 (API or
 *   a CLOSED EventSource) ⇒ one silent re-login with the stored token. Every
 *   request has a deadline (AbortController), every timer is cleared on close.
 * - `mountApp(win, doc)` — wires client → `reduce` → render. P1 is read-only:
 *   no composer (the `#composer` placeholder stays hidden for P2).
 *
 * Importing this module has no side effects unless a browser document with
 * `#app` exists (so vitest/node can import the exports).
 */
import { API, HISTORY_LIMIT_MAX, SILENCE_MS, SSE_EVENTS } from "./contract.js";
import { initialState, needsSubscribe, reduce, selectedAgent } from "./state.js";
import { costLabel, renderAgentList } from "./render/agents.js";
import { renderBanner } from "./render/banner.js";
import { renderFleet } from "./render/fleet.js";
import { renderTranscript } from "./render/transcript.js";
import { el } from "./render/dom.js";
import { createPasswordClient } from "./password-client.js";
import {
  clearPasswordField,
  hideLoginForm,
  queryLoginUi,
  readLoginForm,
  setLoginBusy,
  setLoginError,
  showAuthModeError,
  showInitialPasswordBanner,
  showLoginForm,
} from "./render/login.js";

export const TOKEN_KEY = "pwh_token";
export const REQUEST_TIMEOUT_MS = 10_000;
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
   * @returns {Promise<{ ok: boolean, status: number, json(): Promise<any> }>}
   */
  async function request(url, init) {
    const AC = deps.AbortController ?? (typeof AbortController === "function" ? AbortController : undefined);
    const ac = AC ? new AC() : undefined;
    /** @type {any} */
    let t = null;
    const deadline = new Promise((_, reject) => {
      t = timer(() => {
        ac?.abort();
        reject(new Error("E_DEADLINE"));
      }, REQUEST_TIMEOUT_MS);
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

  /** @param {string} path @param {unknown} body */
  function postRaw(path, body) {
    return request(path, {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-PWH": "1" },
      body: JSON.stringify(body),
    });
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

// ---------------------------------------------------------------------------
// DOM wiring (browser only)
// ---------------------------------------------------------------------------

const RESYNC_MIN_INTERVAL_MS = 2_000;
const PAGE_TRIGGER_PX = 48;

/**
 * @param {any} win
 * @param {Document} doc
 */
export function mountApp(win, doc) {
  return wireFleetUi(win, doc, (hooks) =>
    createClient({
      fetch: (url, init) => win.fetch(url, init),
      EventSource: win.EventSource,
      storage: win.localStorage,
      location: win.location,
      history: win.history,
      setTimeout: (fn, ms) => win.setTimeout(fn, ms),
      clearTimeout: (t) => win.clearTimeout(t),
      now: () => Date.now(),
      ...hooks,
    }),
  );
}

/**
 * Shared read-only fleet UI (agent list / session head / fleet panel /
 * transcript) driven by an SSE-backed client. Used by both `mountApp` (token
 * mode, `createClient`) and `mountPasswordApp` (password mode,
 * `createPasswordClient` in `password-client.js`) — both transports expose
 * the same `{ onMessage, onConn }` hook shape and `{ start, close }` shape.
 * @param {any} win
 * @param {Document} doc
 * @param {(hooks: { onMessage: (msg: any) => void, onConn: (state: string) => void }) => { start(): Promise<void>, close(): void }} makeClient
 */
function wireFleetUi(win, doc, makeClient) {
  const $ = (/** @type {string} */ id) => /** @type {HTMLElement} */ (doc.getElementById(id));
  const ui = {
    conn: $("conn"),
    hub: $("hub"),
    agents: $("agents"),
    banner: $("banner"),
    head: $("session-head"),
    fleet: $("fleet"),
    transcript: $("transcript"),
  };
  let state = initialState();
  /** @type {Map<string, Node>} */
  const cache = new Map();
  let cacheAgent = /** @type {string | null} */ (null);
  let renderQueued = false;
  /** @type {string | null} */
  let prevSelected = null;
  /** @type {string | null} */
  let firstItemId = null;
  /** @type {Map<string, number>} */
  const lastSubAt = new Map();
  let subTimer = /** @type {any} */ (null);

  const client = makeClient({
    onMessage: dispatch,
    onConn: (c) => dispatch({ event: "conn", data: { state: c } }),
  });

  /** @param {{ event: string, data: any, id?: number }} msg */
  function dispatch(msg) {
    const next = reduce(state, msg);
    if (next === state) return;
    state = next;
    effects();
    queueRender();
  }

  function effects() {
    if (state.selected !== prevSelected) {
      const old = prevSelected;
      prevSelected = state.selected;
      const oa = old === null ? undefined : state.agents.get(old);
      if (old !== null && oa?.sub && state.clientId) {
        void client.unsubscribe(state.clientId, old);
        dispatch({ event: "unsubscribed", data: { agentKey: old } });
      }
    }
    const key = needsSubscribe(state);
    const clientId = state.clientId;
    if (key === undefined || clientId === null) return;
    const wait = (lastSubAt.get(key) ?? 0) + RESYNC_MIN_INTERVAL_MS - Date.now();
    if (wait > 0) {
      // rate-limit resync storms; re-evaluate once the window passes
      if (subTimer === null) {
        subTimer = win.setTimeout(() => {
          subTimer = null;
          effects();
        }, wait);
      }
      return;
    }
    lastSubAt.set(key, Date.now());
    dispatch({ event: "subscribing", data: { agentKey: key, clientId } });
    void client.subscribe(clientId, key).then((r) => {
      dispatch(
        r.ok
          ? { event: "subscribed", data: { agentKey: key } }
          : { event: "subscribe_failed", data: { agentKey: key, error: r.error } },
      );
    });
  }

  function queueRender() {
    if (renderQueued) return;
    renderQueued = true;
    const raf =
      typeof win.requestAnimationFrame === "function"
        ? win.requestAnimationFrame.bind(win)
        : (/** @type {() => void} */ f) => win.setTimeout(f, 16);
    raf(() => {
      renderQueued = false;
      render();
    });
  }

  /** @param {string} agentKey */
  function select(agentKey) {
    dispatch({ event: "select", data: { agentKey } });
  }

  function render() {
    ui.conn.textContent = state.conn;
    ui.conn.setAttribute("data-state", state.conn);
    const hubVersion = state.hub && typeof state.hub.version === "string" ? `hub v${state.hub.version}` : "";
    ui.hub.textContent = hubVersion;
    ui.agents.replaceChildren(renderAgentList(doc, state, select));

    const a = selectedAgent(state);
    if (!a) {
      ui.banner.replaceChildren();
      ui.head.replaceChildren(el(doc, "div", { class: "tx-status" }, "select an agent"));
      ui.fleet.replaceChildren();
      ui.transcript.replaceChildren();
      return;
    }
    const banner = renderBanner(doc, a.prompts);
    ui.banner.replaceChildren(...(banner ? [banner] : []));
    ui.head.replaceChildren(renderHead(a));
    ui.fleet.replaceChildren(renderFleet(doc, a.fleet));

    if (cacheAgent !== a.key) {
      cache.clear();
      cacheAgent = a.key;
      firstItemId = null;
    }
    const box = ui.transcript;
    const nearBottom = box.scrollHeight - box.scrollTop - box.clientHeight < 64;
    const prevHeight = box.scrollHeight;
    const prevTop = box.scrollTop;
    const prevFirst = firstItemId;
    firstItemId = a.items[0]?.id ?? null;
    // older page prepended ⇔ the previous first item is still there but no longer first
    const prepended = prevFirst !== null && firstItemId !== prevFirst && a.items.some((it) => it.id === prevFirst);
    box.replaceChildren(...renderTranscript(doc, a, cache));
    if (prepended) box.scrollTop = prevTop + (box.scrollHeight - prevHeight);
    else if (nearBottom) box.scrollTop = box.scrollHeight;
  }

  /** @param {import("./state.js").AgentState} a */
  function renderHead(a) {
    const s = a.session ?? {};
    const st = a.status ?? {};
    const model = s.model ? `${s.model.provider}/${s.model.id}` : "";
    const ctx =
      st.contextUsage && typeof st.contextUsage.percent === "number"
        ? `ctx ${Math.round(st.contextUsage.percent)}%`
        : "";
    const parts = [
      typeof s.name === "string" && s.name !== "" ? s.name : String(s.sessionId ?? ""),
      String(s.cwd ?? a.card?.cwd ?? ""),
      model,
      ctx,
      costLabel(st),
      st.busy ? "busy" : "idle",
      a.down ? `down${a.downReason ? ` (${a.downReason})` : ""}` : a.card?.state === "stale" ? "stale" : "",
    ].filter((x) => x !== "");
    const retry = a.history === "error" ? el(doc, "button", { class: "btn-retry" }, "retry") : null;
    if (retry) retry.addEventListener("click", () => dispatch({ event: "retry", data: { agentKey: a.key } }));
    return el(doc, "div", { class: "session-head" }, [el(doc, "span", null, parts.join(" · ")), retry]);
  }

  ui.transcript.addEventListener("scroll", () => {
    const a = selectedAgent(state);
    if (!a || a.history !== "loaded" || !a.hasMore || a.paging || !a.oldestEntryId) return;
    if (ui.transcript.scrollTop > PAGE_TRIGGER_PX) return;
    const key = a.key;
    dispatch({ event: "paging", data: { agentKey: key } });
    void client.page(key, a.oldestEntryId).then((r) => {
      dispatch(
        r.ok
          ? { event: "page", data: { ...r.data, agentKey: key } }
          : { event: "page_failed", data: { agentKey: key, error: r.error } },
      );
    });
  });

  win.addEventListener("pagehide", () => client.close());
  void client.start();
  queueRender();
  return { client, getState: () => state };
}

// ---------------------------------------------------------------------------
// auth-mode gate (plan §10, package LF)
// ---------------------------------------------------------------------------

/**
 * `data-auth-mode` three-state gate: `mountApp` above is untouched (still the
 * exact token-mode function every existing test calls directly) — this is
 * the new entrypoint the bottom-of-file bootstrap actually uses, and it is
 * the one place with "no fallback to token" (plan §10 row 1): only the
 * literal string `"token"` reaches `mountApp`.
 * @param {any} win
 * @param {Document} doc
 */
export function mountAuthApp(win, doc) {
  const mode = doc.documentElement?.dataset?.authMode;
  if (mode === "token") return mountApp(win, doc);
  if (mode === "password") return mountPasswordApp(win, doc);
  return mountErrorApp(doc);
}

/** §10 row 1: missing/invalid `data-auth-mode` — no `#t=`, no localStorage, no `/api/login`, no SSE. @param {Document} doc */
function mountErrorApp(doc) {
  const $ = (/** @type {string} */ id) => doc.getElementById(id);
  showAuthModeError(queryLoginUi($));
  return { client: null, getState: () => null };
}

/**
 * Password-mode mount: the login screen gates the shared fleet UI
 * (`wireFleetUi`, reused byte-for-byte from `mountApp`) behind
 * `createPasswordClient`. `render/login.js` owns every DOM mutation for the
 * login screen (hidden/disabled/textContent/value only — no innerHTML).
 * @param {any} win
 * @param {Document} doc
 */
function mountPasswordApp(win, doc) {
  const $ = (/** @type {string} */ id) => doc.getElementById(id);
  const loginUi = queryLoginUi($);
  const plaintext = win.location?.protocol === "http:";
  // Fail-closed by default: the form is the first thing shown, before the
  // transport even starts (no FOUC of the read-only shell while unauthed).
  showLoginForm(loginUi, plaintext);

  /** @param {string} state */
  function onConnVisibility(state) {
    if (state === "open") hideLoginForm(loginUi);
    else if (state === "auth") showLoginForm(loginUi, plaintext);
  }

  /** @type {any} */
  let countdownTimer = null;
  function stopCountdown() {
    if (countdownTimer !== null) {
      win.clearTimeout(countdownTimer);
      countdownTimer = null;
    }
  }
  /** @param {number} seconds @param {(n: number) => string} textFor */
  function runCountdown(seconds, textFor) {
    stopCountdown();
    let remaining = seconds;
    setLoginError(loginUi, textFor(remaining));
    const tick = () => {
      remaining -= 1;
      if (remaining <= 0) {
        countdownTimer = null;
        setLoginError(loginUi, "");
        setLoginBusy(loginUi, false);
        return;
      }
      setLoginError(loginUi, textFor(remaining));
      countdownTimer = win.setTimeout(tick, 1_000);
    };
    countdownTimer = win.setTimeout(tick, 1_000);
  }

  const fleet = wireFleetUi(win, doc, (hooks) =>
    createPasswordClient({
      fetch: (url, init) => win.fetch(url, init),
      EventSource: win.EventSource,
      location: win.location,
      history: win.history,
      setTimeout: (fn, ms) => win.setTimeout(fn, ms),
      clearTimeout: (t) => win.clearTimeout(t),
      now: () => Date.now(),
      onMessage: hooks.onMessage,
      onConn: (c) => {
        onConnVisibility(c);
        hooks.onConn(c);
      },
      onAuthEvent: (reason) => {
        setLoginError(
          loginUi,
          reason === "revoked"
            ? "Signed out on another tab or by the host."
            : "Session expired — please sign in again.",
        );
      },
      onUnauthenticated: () => {
        /* onConnVisibility already reacted to the matching onConn("auth") */
      },
      onSessionInfo: (info) => showInitialPasswordBanner(loginUi, info.initialPasswordInUse),
      onLoginRetry: (kind) => {
        setLoginError(loginUi, kind === "rate" ? "Too many requests, retrying…" : "Hub is busy, retrying…");
      },
    }),
  );

  if (loginUi.form) {
    loginUi.form.addEventListener("submit", (/** @type {any} */ ev) => {
      ev.preventDefault?.();
      stopCountdown();
      const { username, password } = readLoginForm(loginUi);
      setLoginError(loginUi, "");
      setLoginBusy(loginUi, true);
      void fleet.client.login(username, password).then((/** @type {any} */ res) => {
        if (res.ok) {
          clearPasswordField(loginUi);
          setLoginError(loginUi, "");
          setLoginBusy(loginUi, false);
          if (res.initialPassword) showInitialPasswordBanner(loginUi, true);
          return;
        }
        switch (res.kind) {
          case "throttled":
            runCountdown(res.retryAfterS, (n) => `Too many attempts. Try again in ${n}s.`);
            return; // stays busy until the countdown re-enables the form
          case "invalid":
            setLoginBusy(loginUi, false);
            setLoginError(loginUi, "Invalid username or password.");
            return;
          case "saturated":
            setLoginBusy(loginUi, false);
            setLoginError(
              loginUi,
              'Sign-in from new addresses is temporarily blocked. Ask the host to run "/webhub unlock".',
            );
            return;
          case "not-allowed":
            setLoginBusy(loginUi, false);
            setLoginError(
              loginUi,
              'This address is not on the hub\'s allow-list. Use one of the addresses shown by "/webhub open".',
            );
            return;
          case "busy-exhausted":
            setLoginBusy(loginUi, false);
            setLoginError(loginUi, "Hub database unavailable — retry");
            return;
          case "network":
            setLoginBusy(loginUi, false);
            setLoginError(loginUi, "Cannot reach hub.");
            return;
          default:
            setLoginBusy(loginUi, false);
            setLoginError(loginUi, "Sign-in failed.");
        }
      });
    });
  }

  if (loginUi.signout) {
    loginUi.signout.addEventListener("click", () => {
      void fleet.client.logout();
    });
  }

  return fleet;
}

if (typeof window !== "undefined" && typeof document !== "undefined" && document.getElementById("app")) {
  mountAuthApp(window, document);
}
