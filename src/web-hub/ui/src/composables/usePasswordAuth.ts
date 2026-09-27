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
import { ref, type Ref } from "vue";
import { createPasswordTransport, type PasswordTransportDeps } from "../transport/password.js";
import type { PasswordTransport, TransportHooks } from "../transport/types.js";
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
}

export interface UsePasswordAuthHandle {
  readonly busy: Readonly<Ref<boolean>>;
  readonly error: Readonly<Ref<LoginErrorView | null>>;
  readonly initialPasswordHint: Readonly<Ref<boolean>>;
  readonly plaintext: boolean;
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
        if (c === "open") error.value = null;
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
    if (!transport) return;
    stopCountdown();
    error.value = null;
    busy.value = true;
    const res = await transport.login(payload.username, payload.password);
    if (res.ok) {
      error.value = null;
      busy.value = false;
      if (res.initialPassword) initialPasswordHint.value = true;
      return;
    }
    switch (res.kind) {
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
    createTransport,
    submit,
    signOut,
    dispose() {
      stopCountdown();
    },
  };
}
