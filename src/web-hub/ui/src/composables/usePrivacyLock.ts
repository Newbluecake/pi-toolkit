/**
 * Session privacy lock — the view-lock state machine (web-hub-privacy plan v2.1, package P2,
 * 「客户端行为」节). P1 owns the data layer (`@logic/state.js`'s `privacy` slot +
 * `privacyFailClosed`/`isAgentLocked`, the transports' `privacy.verify/lock`); this composable
 * owns everything VIEW-side:
 *
 * - **桌面 band 门控**: `enabled = cap ∧ desktop(≥768px)` — the phone band ignores the privacy
 *   slot entirely (照常渲染、无锁标、无锁屏 — 用户裁决 2026-10-13). `failClosed = enabled ∧
 *   !ready` (cap advertised but no `privacy` frame yet ⇒ render NO session detail).
 * - **视图解锁是纯内存**: `viewUnlock` (`{agentKey, sessionId}`) — a page reload or route
 *   switch is a relock. The stored sessionId is re-validated against the agent's CURRENT
 *   session on every read, so `/new` mid-view never inherits the unlock.
 * - **回锁四路**: ① route change (the `route` ref changes ⇒ `viewUnlock` cleared); ② idle
 *   timeout — interaction = keydown/pointerdown/touchstart/scroll,计时只在 viewing 该会话时
 *   (timer armed only while the unlocked session is the selected one), length from the
 *   `pwh_privacy_timeout` browser pref (`@logic/privacy.ts`, 1–60min, default 10, re-read on
 *   every arm); ③ manual `relock()` (the header's 「立即锁定」); ④ `visibilitychange: hidden`.
 * - **回锁/标记瞬间的浮层清理**: a watcher on the selected session's locked transition fires
 *   `onRelock` (DashboardView wires it to close the App-level preview dialog; the wtdiff/graph
 *   dialogs, AskUserForm, FleetDrawer, DetailDock's cmdResult all live INSIDE `AgentDetail`
 *   and die with its unmount — the lock screen replaces that whole subtree, P0's requirement).
 * - **verify/lock outcomes** (P1's `PrivacyOutcome`): `200 {ok:false}` is a VERDICT (wrong
 *   password), never an error and never a 401; `429` rides the login-style `errors.throttled`
 *   countdown UI (`retryAfterS`, one-second ticks, form stays busy until it elapses) — the
 *   same shape `usePasswordAuth`'s `runCountdown` implements for sign-in.
 *
 * Every timer is held in this closure and cleared by `dispose()` (also registered with
 * `onScopeDispose`, failSilently, for component hosts).
 */
import { computed, onScopeDispose, ref, watch, type ComputedRef, type Ref } from "vue";
import { isAgentLocked, privacyFailClosed } from "@logic/state.js";
import { loadPrivacyTimeoutMin, type PrivacyPrefStorage } from "@logic/privacy.js";
import type { PrivacyOutcome } from "../transport/types.js";
import type { HubHandle, LoginErrorView, Route } from "../types.js";

/** Minimal event-target faces (the real `window`/`document` satisfy them structurally). */
export interface PrivacyLockEventTarget {
  addEventListener(type: string, listener: (ev: Event) => void, options?: unknown): void;
  removeEventListener(type: string, listener: (ev: Event) => void, options?: unknown): void;
}
export interface PrivacyLockDocument extends PrivacyLockEventTarget {
  readonly visibilityState: string;
}

/** Relock triggers (diagnostics/tests; the UI treats them identically). */
export type PrivacyRelockReason = "route" | "timeout" | "manual" | "hidden";

/** The unmark (取消标记) dialog's target — `null` = dialog closed. */
export interface PrivacyUnmarkTarget {
  readonly agentKey: string;
  readonly sessionId: string;
}

export interface UsePrivacyLockOptions<TTimer = ReturnType<typeof setTimeout>> {
  /** The hub handle — `state` drives every computed; `privacy` is the call surface (absent ⇒
   *  unlock/mark/unmark no-op, chrome still follows the `privacy.v1` cap). */
  readonly hub: HubHandle;
  /** Transport auth mode: `password` (LAN) unlocks/unmarks with the LAN password; `token`
   *  (loopback) is the honest click-to-confirm variant (plan v2.1 N1 — `verify` is 404 there). */
  readonly mode: "token" | "password";
  /** `(min-width: 768px)` — the desktop band gate. Mobile band ignores everything here. */
  readonly desktop: Readonly<Ref<boolean>>;
  /** The live route — any change relocks (path ①). */
  readonly route: Readonly<Ref<Route>>;
  /** Browser pref storage for `pwh_privacy_timeout` (re-read on every idle-timer arm). */
  readonly storage: PrivacyPrefStorage;
  readonly win: PrivacyLockEventTarget;
  readonly doc: PrivacyLockDocument;
  setTimeout(fn: () => void, ms: number): TTimer;
  clearTimeout(handle: TTimer): void;
  /** Fired exactly once per locked TRANSITION of the viewed session (mark-from-another-tab and
   *  every relock path) — the host closes that session's overlays (preview dialog) here. */
  onRelock?(): void;
}

export interface UsePrivacyLockHandle {
  /** Hub advertises `privacy.v1` (P1: `state.privacy.cap`). Absent ⇒ byte-level zero trace. */
  readonly cap: ComputedRef<boolean>;
  /** Chrome gate: `cap ∧ desktop`. Every badge/button/lock-screen keys off this. */
  readonly enabled: ComputedRef<boolean>;
  /** Fail-closed window (plan「锁状态下发」): `enabled ∧ !ready` ⇒ render NO session detail. */
  readonly failClosed: ComputedRef<boolean>;
  /** Persistent mark state (「隐私标记」) — drives the card badge + header button. */
  isMarked(agentKey: string): boolean;
  /** The P0 gate: marked AND not view-unlocked ⇒ mount `PrivacyLockScreen`, not `AgentDetail`. */
  isViewLocked(agentKey: string): boolean;
  /** The agent's CURRENT sessionId (null without a session — such agents can't be marked). */
  sessionIdOf(agentKey: string): string | null;
  /** Lock screen state (password mode: verify in flight / verdict / 429 countdown). */
  readonly screenBusy: Readonly<Ref<boolean>>;
  readonly screenError: Readonly<Ref<LoginErrorView | null>>;
  /** Unlock the VIEW of `agentKey` — token mode: click-confirm (no request); password mode:
   *  `privacy.verify(password)`. No-op when the agent has no session or is not marked. */
  unlock(agentKey: string, password: string | null): Promise<void>;
  /** ③ manual 「立即锁定」 — clears the view unlock; the locked-transition watcher fires
   *  `onRelock`. No-op when nothing is unlocked. */
  relock(reason: PrivacyRelockReason): void;
  /** 「隐私标记」: `privacy.lock({locked:true})` — no password (marking is not sensitive).
   *  Failures surface via `actionError` (auto-clears after a few seconds). */
  mark(agentKey: string): Promise<void>;
  /** Transient mark/unmark-button failure for inline display (per-agent keyed). */
  readonly actionError: Readonly<
    Ref<{ readonly agentKey: string; readonly key: string; readonly code: string } | null>
  >;
  /** Open the 取消标记 dialog for `agentKey` (LAN: password form; loopback: confirm). */
  requestUnmark(agentKey: string): void;
  cancelUnmark(): void;
  readonly unmarkTarget: Readonly<Ref<PrivacyUnmarkTarget | null>>;
  readonly unmarkBusy: Readonly<Ref<boolean>>;
  readonly unmarkError: Readonly<Ref<LoginErrorView | null>>;
  /** Confirm the unmark — `password` REQUIRED on LAN (request-scoped, never stored), ignored
   *  on loopback. Closes the dialog on success; errors stay in the dialog. */
  confirmUnmark(password: string | null): Promise<void>;
  dispose(): void;
}

/** Interaction events that reset the idle-relock timer (plan: 键盘/指针/触摸/滚动). */
const INTERACTION_EVENTS = ["keydown", "pointerdown", "touchstart", "scroll"] as const;

/** Transient `actionError` auto-clear window. */
const ACTION_ERROR_MS = 6_000;

export function usePrivacyLock<TTimer = ReturnType<typeof setTimeout>>(
  opts: UsePrivacyLockOptions<TTimer>,
): UsePrivacyLockHandle {
  const { hub } = opts;

  /** `isAgentLocked`/`privacyFailClosed` are typed against the reducer's internal `State`;
   *  `HubState` is its render-gated structural VIEW over the very same object (`useHub.ts`
   *  casts `raw` once), so this one bridge cast at the boundary is sound — the same discipline
   *  `useHub`'s own `raw as unknown as HubState` applies in the other direction. */
  type LogicState = Parameters<typeof isAgentLocked>[0];
  const stateNow = (): LogicState => hub.state.value as unknown as LogicState;

  const cap = computed(() => hub.state.value.privacy?.cap === true);
  const ready = computed(() => hub.state.value.privacy?.ready === true);
  const enabled = computed(() => cap.value && opts.desktop.value);
  // plan「锁状态下发」fail-closed: the canonical P1 predicate + the desktop gate (the phone
  // band ignores the privacy slot entirely, fail-closed included).
  const failClosed = computed(() => enabled.value && privacyFailClosed(stateNow()));

  /** The pure-memory view unlock (never persisted — a reload is a relock). */
  const viewUnlock = ref<{ readonly agentKey: string; readonly sessionId: string } | null>(null);

  const screenBusy = ref(false);
  const screenError = ref<LoginErrorView | null>(null);
  const unmarkTarget = ref<PrivacyUnmarkTarget | null>(null);
  const unmarkBusy = ref(false);
  const unmarkError = ref<LoginErrorView | null>(null);
  const actionError = ref<{ readonly agentKey: string; readonly key: string; readonly code: string } | null>(null);

  function sessionIdOf(agentKey: string): string | null {
    const session = hub.state.value.agents.get(agentKey)?.session;
    const sid = session !== null && typeof session === "object" ? (session as { sessionId?: unknown }).sessionId : null;
    return typeof sid === "string" && sid !== "" ? sid : null;
  }

  function isMarked(agentKey: string): boolean {
    return enabled.value && isAgentLocked(stateNow(), agentKey);
  }

  function isViewLocked(agentKey: string): boolean {
    if (!isMarked(agentKey)) return false;
    const u = viewUnlock.value;
    return !(u !== null && u.agentKey === agentKey && u.sessionId === sessionIdOf(agentKey));
  }

  // --- countdown (login-style `errors.throttled` + Retry-After ticks), two slots -----------

  const countdownTimers = new Map<"screen" | "unmark", TTimer>();

  function stopCountdown(slot: "screen" | "unmark"): void {
    const t = countdownTimers.get(slot);
    if (t !== undefined) {
      opts.clearTimeout(t);
      countdownTimers.delete(slot);
    }
  }

  function throttledView(s: number): LoginErrorView {
    return { key: "errors.throttled", countdownS: s };
  }

  /** 429: tick down once per second, then re-enable the form (mirrors usePasswordAuth). */
  function runCountdown(seconds: number, slot: "screen" | "unmark"): void {
    stopCountdown(slot);
    let remaining = Math.max(1, Math.ceil(seconds));
    const errorRef = slot === "screen" ? screenError : unmarkError;
    const busyRef = slot === "screen" ? screenBusy : unmarkBusy;
    errorRef.value = throttledView(remaining);
    busyRef.value = true;
    const tick = (): void => {
      remaining -= 1;
      if (remaining <= 0) {
        countdownTimers.delete(slot);
        errorRef.value = null;
        busyRef.value = false;
        return;
      }
      errorRef.value = throttledView(remaining);
      countdownTimers.set(slot, opts.setTimeout(tick, 1_000));
    };
    countdownTimers.set(slot, opts.setTimeout(tick, 1_000));
  }

  function errorViewOf(outcome: Extract<PrivacyOutcome, { ok: false }>): LoginErrorView {
    if (outcome.error === "E_SESSION_CHANGED") return { key: "privacy.sessionChanged" };
    if (outcome.status === 0 || outcome.status === undefined) return { key: "errors.network" };
    return { key: "errors.unknown" };
  }

  /** Settle a verify/unlock-class outcome onto (busyRef, errorRef); returns the verdict. */
  function settleVerdict(outcome: PrivacyOutcome, slot: "screen" | "unmark"): boolean {
    const busyRef = slot === "screen" ? screenBusy : unmarkBusy;
    const errorRef = slot === "screen" ? screenError : unmarkError;
    if (outcome.ok) {
      if (outcome.data.ok) {
        busyRef.value = false;
        errorRef.value = null;
        return true;
      }
      // 200 {ok:false} — wrong-password VERDICT (never an error, never a 401, plan 评审 #3).
      busyRef.value = false;
      errorRef.value = { key: "errors.invalid" };
      return false;
    }
    if (outcome.retryAfterS !== undefined) {
      runCountdown(outcome.retryAfterS, slot); // stays busy until the countdown re-enables
      return false;
    }
    busyRef.value = false;
    errorRef.value = errorViewOf(outcome);
    return false;
  }

  // --- transient actionError (card/header mark failures) ------------------------------------

  let actionErrorTimer: TTimer | null = null;
  function showActionError(agentKey: string, outcome: Extract<PrivacyOutcome, { ok: false }>): void {
    const v = errorViewOf(outcome);
    actionError.value = {
      agentKey,
      key: v.key,
      code: outcome.error,
    };
    if (actionErrorTimer !== null) opts.clearTimeout(actionErrorTimer);
    actionErrorTimer = opts.setTimeout(() => {
      actionErrorTimer = null;
      actionError.value = null;
    }, ACTION_ERROR_MS);
  }

  // --- actions ------------------------------------------------------------------------------

  async function unlock(agentKey: string, password: string | null): Promise<void> {
    const sessionId = sessionIdOf(agentKey);
    if (sessionId === null || !isMarked(agentKey)) return;
    if (opts.mode === "token") {
      // loopback 诚实降级 (plan 评审 #7 (a)): no second credential exists — the lock screen's
      // click IS the confirmation; no `verify` request (the hub 404s it there anyway).
      viewUnlock.value = { agentKey, sessionId };
      return;
    }
    const privacy = hub.privacy;
    if (privacy === undefined || screenBusy.value) return;
    stopCountdown("screen");
    screenError.value = null;
    screenBusy.value = true;
    let outcome: PrivacyOutcome;
    try {
      outcome = await privacy.verify(password ?? "");
    } catch {
      screenBusy.value = false;
      screenError.value = { key: "errors.network" };
      return;
    }
    if (settleVerdict(outcome, "screen")) viewUnlock.value = { agentKey, sessionId };
  }

  function relock(_reason: PrivacyRelockReason): void {
    if (viewUnlock.value === null) return;
    viewUnlock.value = null; // the locked-transition watcher below fires onRelock
    stopCountdown("screen");
    screenError.value = null;
    screenBusy.value = false;
  }

  async function mark(agentKey: string): Promise<void> {
    const privacy = hub.privacy;
    const sessionId = sessionIdOf(agentKey);
    if (privacy === undefined || sessionId === null) return;
    let outcome: PrivacyOutcome;
    try {
      outcome = await privacy.lock({ agentKey, sessionId, locked: true });
    } catch {
      actionError.value = { agentKey, key: "errors.network", code: "E_NETWORK" };
      return;
    }
    if (outcome.ok) return; // the hub's `privacy` broadcast flips the badge/screen itself
    showActionError(agentKey, outcome);
  }

  function requestUnmark(agentKey: string): void {
    const sessionId = sessionIdOf(agentKey);
    if (sessionId === null) return;
    stopCountdown("unmark");
    unmarkError.value = null;
    unmarkBusy.value = false;
    unmarkTarget.value = { agentKey, sessionId };
  }

  function cancelUnmark(): void {
    stopCountdown("unmark");
    unmarkTarget.value = null;
    unmarkError.value = null;
    unmarkBusy.value = false;
  }

  async function confirmUnmark(password: string | null): Promise<void> {
    const target = unmarkTarget.value;
    const privacy = hub.privacy;
    if (target === null || privacy === undefined || unmarkBusy.value) return;
    stopCountdown("unmark");
    unmarkError.value = null;
    unmarkBusy.value = true;
    let outcome: PrivacyOutcome;
    try {
      // The password lives ONLY inside this request body (plan v2.1 N1: 不缓存、不复用查看
      // 解锁的任何状态) — loopback sends none (the hub doesn't ask for one there).
      outcome = await privacy.lock({
        agentKey: target.agentKey,
        sessionId: target.sessionId,
        locked: false,
        ...(opts.mode === "password" && password !== null ? { password } : {}),
      });
    } catch {
      unmarkBusy.value = false;
      unmarkError.value = { key: "errors.network" };
      return;
    }
    if (settleVerdict(outcome, "unmark")) {
      const unmarked = target.agentKey;
      unmarkTarget.value = null;
      // Unmarked ⇒ never locked again this view — drop a stale view-unlock for it too.
      if (viewUnlock.value?.agentKey === unmarked) viewUnlock.value = null;
    }
  }

  // --- relock paths ① (route) / ④ (visibilitychange) + the onRelock transition watcher ------

  const selectedKey = computed(() => (opts.route.value.name === "agent" ? opts.route.value.key : null));
  const selectedLocked = computed(() => selectedKey.value !== null && isViewLocked(selectedKey.value));

  let disposed = false;

  // The ONE side-effect channel: entering the locked state of the VIEWED session — from any
  // path (timeout/manual/hidden relock, or another tab marking it mid-view) — closes that
  // session's overlays (preview; the in-detail dialogs die with AgentDetail's unmount).
  const stopLockWatch = watch(selectedLocked, (locked, was) => {
    if (locked === true && was === false) opts.onRelock?.();
  });

  // ① 切换路由即回锁 (视图态纯内存) — any route change drops the view unlock and resets the
  // lock screen's verdict/busy state (a fresh view of the same session asks again).
  const stopRouteWatch = watch(
    () => opts.route.value,
    () => {
      relock("route");
      stopCountdown("screen");
      screenError.value = null;
      screenBusy.value = false;
    },
  );

  function onVisibility(): void {
    if (opts.doc.visibilityState === "hidden") relock("hidden");
  }
  opts.doc.addEventListener("visibilitychange", onVisibility);

  // A view-unlock stops being meaningful the moment the mark vanishes (unmark from another
  // tab) or the session rotates (/new) — drop it so the idle machinery disarms too.
  const unlockStale = computed(() => {
    const u = viewUnlock.value;
    return u !== null && (!isMarked(u.agentKey) || sessionIdOf(u.agentKey) !== u.sessionId);
  });
  const stopStaleWatch = watch(unlockStale, (stale) => {
    if (stale) viewUnlock.value = null;
  });

  // --- relock path ② (idle timeout) ----------------------------------------------------------

  let idleTimer: TTimer | null = null;
  let idleListenersOn = false;

  /** Timing runs ONLY while the unlocked marked session is the one being viewed (plan:
   *  「只在 viewing 该会话时计时」). */
  const idleActive = computed(() => {
    const u = viewUnlock.value;
    return u !== null && selectedKey.value === u.agentKey && isMarked(u.agentKey) && !selectedLocked.value;
  });

  function disarmIdle(): void {
    if (idleTimer !== null) {
      opts.clearTimeout(idleTimer);
      idleTimer = null;
    }
    if (idleListenersOn) {
      idleListenersOn = false;
      for (const type of INTERACTION_EVENTS) opts.win.removeEventListener(type, onInteraction, true);
    }
  }

  function armIdleTimer(): void {
    if (idleTimer !== null) opts.clearTimeout(idleTimer);
    // The pref is re-read on EVERY arm (mirrors `pwh_keepalive`): a settings change applies to
    // the next interaction/arm, no reload needed.
    const minutes = loadPrivacyTimeoutMin(opts.storage);
    idleTimer = opts.setTimeout(() => {
      idleTimer = null;
      relock("timeout");
    }, minutes * 60_000);
  }

  function onInteraction(): void {
    if (idleActive.value) armIdleTimer(); // reset the countdown; inert otherwise
  }

  function armIdle(): void {
    armIdleTimer();
    if (!idleListenersOn) {
      idleListenersOn = true;
      for (const type of INTERACTION_EVENTS) opts.win.addEventListener(type, onInteraction, true);
    }
  }

  const stopIdleWatch = watch(idleActive, (active) => {
    if (active) armIdle();
    else disarmIdle();
  });

  function dispose(): void {
    if (disposed) return;
    disposed = true;
    stopLockWatch();
    stopRouteWatch();
    stopStaleWatch();
    stopIdleWatch();
    disarmIdle();
    stopCountdown("screen");
    stopCountdown("unmark");
    if (actionErrorTimer !== null) {
      opts.clearTimeout(actionErrorTimer);
      actionErrorTimer = null;
    }
    opts.doc.removeEventListener("visibilitychange", onVisibility);
  }
  onScopeDispose(dispose, true); // failSilently: unit tests call dispose() themselves

  return {
    cap,
    enabled,
    failClosed,
    isMarked,
    isViewLocked,
    sessionIdOf,
    screenBusy,
    screenError,
    unlock,
    relock,
    mark,
    actionError,
    requestUnmark,
    cancelUnmark,
    unmarkTarget,
    unmarkBusy,
    unmarkError,
    confirmUnmark,
    dispose,
  };
}
