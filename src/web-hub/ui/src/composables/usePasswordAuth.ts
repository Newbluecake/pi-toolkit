/**
 * Password-mode auth-flow UI state (vue-plan.md v2.1 §3.8, §3.9, §5.2 — P1). Owns the bits of
 * the legacy `mountPasswordApp`/`render/login.js` pairing that are pure UI state rather than DOM
 * mutation: busy flag, mapped error view, the initial-password safety hint, and the throttled-
 * login countdown ticker. `LoginView.vue` (P3) renders `busy`/`error`/`initialPasswordHint`
 * declaratively; this composable never touches the DOM.
 *
 * `createTransport` is the seam that plugs into `useHub`'s own `createTransport(hooks)` option:
 * it merges `useHub`'s `onMessage`/`onConn` with the extra password-mode hooks
 * (`onAuthEvent`/`onSessionInfo`/`onLoginRetry`/`onUnauthenticated`) `@logic/password-client.js`
 * needs, so both composables end up sharing exactly one `PasswordTransport` instance without
 * either one constructing it standalone.
 */
import { ref, shallowRef, type Ref } from "vue";
import { createPasswordTransport, type PasswordTransportDeps } from "../transport/password.js";
import type { PasswordTransport, TransportHooks } from "../transport/types.js";
import type { Lan2faChallenge, LanFactorBody } from "@protocol/lan-2fa.js";
import type { LoginErrorView } from "../types.js";

/** Everything `@logic/password-client.js`'s `ClientDeps` needs *except* the six hook fields this
 * composable (`onMessage`/`onConn` from `useHub`, the rest owned here) supplies itself. */
export type PasswordAuthDeps = Omit<
  PasswordTransportDeps,
  "onMessage" | "onConn" | "onAuthEvent" | "onUnauthenticated" | "onSessionInfo" | "onLoginRetry"
>;

export interface UsePasswordAuthOptions<TTimer = ReturnType<typeof setTimeout>> {
  deps: PasswordAuthDeps;
  setTimeout(fn: () => void, ms: number): TTimer;
  clearTimeout(handle: TTimer): void;
  /** `location.protocol === "http:"` — drives the plaintext-HTTP safety banner. Default `false`. */
  plaintext?: boolean;
  /** Pre-auth static bootstrap from the hub's advertised LAN capability. */
  secondFactorEnabled?: () => boolean;
}

export interface UsePasswordAuthHandle {
  readonly busy: Readonly<Ref<boolean>>;
  readonly error: Readonly<Ref<LoginErrorView | null>>;
  readonly initialPasswordHint: Readonly<Ref<boolean>>;
  readonly plaintext: boolean;
  readonly challenge: Readonly<Ref<Lan2faChallenge | null>>;
  readonly attemptsLeft: Readonly<Ref<number | undefined>>;
  readonly lockedUntil: Readonly<Ref<number | undefined>>;
  submitSecondFactor(body: LanFactorBody): Promise<void>;
  waitApproval(): Promise<void>;
  cancelSecondFactor(): Promise<void>;
  /** Pass straight as `useHub`'s `createTransport` option. */
  createTransport(hooks: TransportHooks): PasswordTransport;
  submit(payload: { username: string; password: string }): Promise<void>;
  signOut(): Promise<void>;
  dispose(): void;
}

function view(key: string, params?: Record<string, string | number>, countdownS?: number): LoginErrorView {
  return {
    key,
    ...(params === undefined ? {} : { params }),
    ...(countdownS === undefined ? {} : { countdownS }),
  };
}

export function usePasswordAuth<TTimer = ReturnType<typeof setTimeout>>(
  opts: UsePasswordAuthOptions<TTimer>,
): UsePasswordAuthHandle {
  const busy = ref(false);
  const error = ref<LoginErrorView | null>(null);
  const initialPasswordHint = ref(false);
  const plaintext = opts.plaintext ?? false;
  const challenge = shallowRef<Lan2faChallenge | null>(null);
  const attemptsLeft = ref<number | undefined>();
  const lockedUntil = ref<number | undefined>();
  let generation = 0;
  let disposed = false;
  let waitingFor: Lan2faChallenge | null = null;
  let cancelling: Promise<void> | undefined;
  function clearChallenge(): void {
    generation++;
    challenge.value = null;
    attemptsLeft.value = undefined;
    lockedUntil.value = undefined;
    busy.value = false;
  }
  function success(initialPassword: boolean): void {
    clearChallenge();
    error.value = null;
    if (initialPassword) initialPasswordHint.value = true;
  }
  function cancelSecondFactor(): Promise<void> {
    const active = challenge.value !== null;
    clearChallenge();
    if (!active || transport === undefined) return cancelling ?? Promise.resolve();
    // Drain the old cancel before another password request can mint a new cookie challenge.
    const current = transport
      .cancelSecondFactor()
      .catch(() => {})
      .then(() => {});
    cancelling = current;
    void current.finally(() => {
      if (cancelling === current) cancelling = undefined;
    });
    return current;
  }
  async function restart(key: string): Promise<void> {
    await cancelSecondFactor();
    if (!disposed) error.value = view(key, { min: 5 });
  }
  async function waitApproval(): Promise<void> {
    const ch = challenge.value;
    if (disposed || transport === undefined || ch === null || ch.feishu !== "sent" || waitingFor === ch) return;
    waitingFor = ch;
    const mine = generation;
    try {
      const res = await transport.waitApproval(ch);
      if (disposed || mine !== generation) return;
      if (res.ok) success(res.initialPassword);
      else if (res.state !== "cancelled") await restart(`login.2fa.${res.state === "error" ? "failed" : res.state}`);
    } catch {
      if (!disposed && mine === generation) await restart("errors.network");
    } finally {
      if (waitingFor === ch) waitingFor = null;
    }
  }
  async function submitSecondFactor(body: LanFactorBody): Promise<void> {
    if (disposed || !transport || !challenge.value || busy.value) return;
    const mine = generation;
    busy.value = true;
    error.value = null;
    try {
      const res = await transport.submitSecondFactor(body);
      if (disposed || mine !== generation) return;
      busy.value = false;
      if (res.ok) {
        success(res.initialPassword);
        return;
      }
      if (res.error === "E_2FA_CODE") attemptsLeft.value = res.attemptsLeft;
      else if (res.error === "E_2FA_METHOD_LOCKED") lockedUntil.value = opts.deps.now() + (res.retryAfterMs ?? 0);
      else if (res.error === "E_LOCKED") {
        busy.value = true;
        runCountdown(Math.ceil((res.retryAfterMs ?? 1000) / 1000));
      } else if (res.error === "E_2FA_EXPIRED" || res.error === "E_2FA_USED") await restart("login.2fa.expired");
      else
        error.value = view(
          res.error === "network" || res.error === "E_NETWORK" ? "errors.network" : "login.2fa.failed",
        );
    } catch {
      if (!disposed && mine === generation) {
        busy.value = false;
        error.value = view("errors.network");
      }
    }
  }

  let transport: PasswordTransport | undefined;
  let countdownTimer: TTimer | null = null;

  function stopCountdown(): void {
    if (countdownTimer !== null) {
      opts.clearTimeout(countdownTimer);
      countdownTimer = null;
    }
  }

  /** §10 "429 plain ⇒ countdown ticks down every second, then re-enables the form (no auto-resubmit)". */
  function runCountdown(seconds: number): void {
    stopCountdown();
    let remaining = seconds;
    error.value = view("errors.throttled", undefined, remaining);
    const tick = (): void => {
      remaining -= 1;
      if (remaining <= 0) {
        countdownTimer = null;
        error.value = null;
        busy.value = false;
        return;
      }
      error.value = view("errors.throttled", undefined, remaining);
      countdownTimer = opts.setTimeout(tick, 1_000);
    };
    countdownTimer = opts.setTimeout(tick, 1_000);
  }

  function createTransport(hooks: TransportHooks): PasswordTransport {
    const t = createPasswordTransport({
      ...opts.deps,
      onMessage: hooks.onMessage,
      onConn: (c) => {
        if (c === "open") {
          // A stream can open before the completion promise settles. This is login success,
          // not an abandoned challenge; never cancel it from LoginView's unmount hook.
          if (challenge.value !== null) clearChallenge();
          error.value = null;
        }
        hooks.onConn(c);
      },
      onAuthEvent: (reason) => {
        error.value = view(reason === "revoked" ? "errors.revoked" : "errors.expired");
      },
      onUnauthenticated: () => {
        /* onConn("auth") already reflects it via useHub's own state.conn */
      },
      onSessionInfo: (info) => {
        initialPasswordHint.value = info.initialPasswordInUse;
      },
      onLoginRetry: (kind) => {
        error.value = view(kind === "rate" ? "errors.retryingRate" : "errors.retryingBusy");
      },
    });
    transport = t;
    return t;
  }

  async function submit(payload: { username: string; password: string }): Promise<void> {
    if (!transport || disposed) return;
    if (challenge.value !== null || cancelling !== undefined) await cancelSecondFactor();
    if (disposed) return;
    stopCountdown();
    error.value = null;
    busy.value = true;
    const mine = ++generation;
    const res = await transport.login(payload.username, payload.password);
    if (disposed || mine !== generation) return;
    if (res.ok) {
      error.value = null;
      busy.value = false;
      if (res.initialPassword) initialPasswordHint.value = true;
      return;
    }
    switch (res.kind) {
      case "second-factor":
        busy.value = false;
        challenge.value = res.challenge;
        if (opts.secondFactorEnabled?.() !== true) {
          await restart("errors.unknown");
          return;
        }
        // Start even while the TOTP/recovery panel is visible; method switches never stop it.
        if (res.challenge.feishu === "sent") void waitApproval();
        return;
      case "throttled":
        runCountdown(res.retryAfterS); // stays busy until the countdown re-enables the form
        return;
      case "invalid":
        busy.value = false;
        error.value = view("errors.invalid");
        return;
      case "saturated":
        busy.value = false;
        error.value = view("errors.saturated");
        return;
      case "not-allowed":
        busy.value = false;
        error.value = view("errors.notAllowed");
        return;
      case "busy-exhausted":
        busy.value = false;
        error.value = view("errors.busyExhausted");
        return;
      case "network":
        busy.value = false;
        error.value = view("errors.network");
        return;
      default:
        busy.value = false;
        error.value = view("errors.unknown");
    }
  }

  async function signOut(): Promise<void> {
    if (!transport) return;
    await transport.logout();
  }

  return {
    busy,
    error,
    initialPasswordHint,
    plaintext,
    challenge,
    attemptsLeft,
    lockedUntil,
    submitSecondFactor,
    waitApproval,
    cancelSecondFactor,
    createTransport,
    submit,
    signOut,
    dispose() {
      disposed = true;
      void cancelSecondFactor();
      stopCountdown();
    },
  };
}
