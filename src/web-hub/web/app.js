/**
 * web-hub browser entry (plan §包 E; token-mode transport split out to `token-client.js` in
 * vue-plan.md v2.1's P0 — vue-plan.md v2.1 §3.1, §5.2). Two parts:
 *
 * - `createClient(deps)` (now in `token-client.js`, re-exported nowhere — imported directly
 *   below) — transport only, all I/O injected (tests drive it with fakes): `#t=` hash → POST
 *   /api/login (X-PWH:1) → token kept in localStorage → `history.replaceState` clears the
 *   hash; exactly ONE EventSource per tab; 45s without any frame ⇒ close + reopen; 401 (API or
 *   a CLOSED EventSource) ⇒ one silent re-login with the stored token. Every request has a
 *   deadline (AbortController), every timer is cleared on close.
 * - `mountApp(win, doc)` — wires client → `reduce` → render. P1 is read-only:
 *   no composer (the `#composer` placeholder stays hidden for P2).
 *
 * Importing this module has no side effects unless a browser document with
 * `#app` exists (so vitest/node can import the exports).
 */
import { createClient } from "./token-client.js";
export { createClient }; // re-exported so existing consumers importing createClient from app.js keep working (behavior unchanged, plan §3.1/§5.2)
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

// ---------------------------------------------------------------------------
// DOM wiring (browser only)
// ---------------------------------------------------------------------------

const RESYNC_MIN_INTERVAL_MS = 2_000;
const PAGE_TRIGGER_PX = 48;
// requestAnimationFrame is suspended by the browser while the tab is hidden/backgrounded (no
// guaranteed cadence) — without a bounded fallback, a state change (e.g. switching the selected
// agent) made while the page isn't visible would sit un-rendered indefinitely with no sign
// anything is wrong (the click's own network calls still fire; only the DOM never catches up).
const RENDER_FALLBACK_MS = 200;

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

  // Render lifecycle guard (regression: a queueRender()-scheduled rAF/fallback-timer pair could
  // still fire and call render() after the UI has gone away — page unload, an explicit
  // client.close() (token or password transport), or the client dropping back to "auth" (logout,
  // session revoke/expiry). `disposed` gates queueRender() itself (defense in depth even if a
  // fake/degraded environment's clearTimeout/cancelAnimationFrame is a no-op — see `run` below);
  // `closedForGood` makes a real `close()` permanent, since neither transport ever reopens its
  // stream after `close()`. A transient "auth" state (logout, revoke) is NOT permanent: the same
  // client instance can log back in and reopen its stream, at which point `onConn("open")` lifts
  // the guard again so rendering resumes.
  let disposed = false;
  let closedForGood = false;
  /** @type {any} */
  let pendingRafId = null;
  /** @type {any} */
  let pendingTimerId = null;

  function cancelPendingRender() {
    if (pendingRafId !== null && typeof win.cancelAnimationFrame === "function") {
      win.cancelAnimationFrame(pendingRafId);
    }
    if (pendingTimerId !== null) win.clearTimeout(pendingTimerId);
    pendingRafId = null;
    pendingTimerId = null;
    renderQueued = false;
  }

  function dispose() {
    disposed = true;
    cancelPendingRender();
  }

  function disposeForGood() {
    closedForGood = true;
    dispose();
  }

  function resumeIfLive() {
    if (closedForGood) return;
    disposed = false;
  }

  const client = makeClient({
    onMessage: dispatch,
    onConn: (c) => {
      if (c === "auth") dispose();
      else if (c === "open") resumeIfLive();
      dispatch({ event: "conn", data: { state: c } });
    },
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
    if (disposed) return;
    if (renderQueued) return;
    renderQueued = true;
    let done = false;
    const run = () => {
      // Defense in depth alongside `cancelPendingRender()`'s cancelAnimationFrame/clearTimeout
      // calls: some environments' `clearTimeout`/`cancelAnimationFrame` are inert (e.g. a
      // degraded/fake `win`), so a "cancelled" callback can still be invoked directly — both
      // `done` (already-ran) and `disposed` (torn down since this render was queued) must gate
      // the actual render() call independently of whether cancellation truly took effect.
      if (done || disposed) return;
      done = true;
      if (pendingTimerId !== null) win.clearTimeout(pendingTimerId);
      pendingRafId = null;
      pendingTimerId = null;
      renderQueued = false;
      render();
    };
    if (typeof win.requestAnimationFrame === "function") {
      pendingRafId = win.requestAnimationFrame(run);
      pendingTimerId = win.setTimeout(run, RENDER_FALLBACK_MS);
    } else {
      pendingTimerId = win.setTimeout(run, 16);
    }
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

  // `close()` is the one genuinely final transport teardown both `createClient` and
  // `createPasswordClient` expose (`closed = true`, never reopens the stream) — wrap it so any
  // caller (pagehide below, an embedding page's own unmount, or a test's cleanup call) also
  // permanently stops rendering, not just the transport.
  const closeForGood = () => {
    disposeForGood();
    client.close();
  };

  win.addEventListener("pagehide", closeForGood);
  void client.start();
  queueRender();
  return { client: { ...client, close: closeForGood }, getState: () => state };
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
