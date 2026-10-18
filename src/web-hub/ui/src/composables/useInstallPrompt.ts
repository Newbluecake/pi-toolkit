/**
 * PWA install — the browser half of `logic/pwaInstall.ts` (2026-10-18 「安装为应用」 card).
 *
 * Chromium fires `beforeinstallprompt` shortly after load, BEFORE any settings panel is open,
 * and the spec's only way to keep the install UI available is to `preventDefault()` the event
 * and hold it — so the capture listener is registered at APP BOOT (`main.ts`, before
 * `createApp`) and the held event lives in this module's singleton. Module scope is the same
 * deliberate SPA pattern as `useI18n.ts`'s shared `override` ref: the UI bundle is a
 * single-page app with no pi `/reload`-style re-activation, and one page load = one capture.
 *
 * `appinstalled` (fires on accept) latches an `installed` flag that outranks everything but an
 * already-standalone display mode; consuming the prompt clears the held event, so a dismissed
 * choice falls back to the platform guidance until the browser re-fires the event.
 *
 * Everything DOM/global is injected as a structural `InstallWindow` (useClipboard precedent) —
 * unit tests drive the state machine with a fake window + synthetic events, no real browser.
 */
import { computed, readonly, ref, shallowRef, type ComputedRef, type Ref } from "vue";
import { deriveInstallState, type InstallState } from "../logic/pwaInstall.js";

/** The half of `window` this composable reads (a fake with exactly these members works). */
export interface InstallWindow {
  readonly navigator: { readonly userAgent?: string; readonly standalone?: boolean };
  readonly isSecureContext: boolean;
  matchMedia(query: string): { matches: boolean };
  addEventListener(type: string, listener: (ev: Event) => void): void;
  readonly location: { readonly origin: string };
}

/** `beforeinstallprompt`'s non-standard surface (TS lib.dom still types it as a bare Event). */
export interface BeforeInstallPromptEvent extends Event {
  prompt(): Promise<void>;
  readonly userChoice: Promise<{ readonly outcome: "accepted" | "dismissed"; readonly platform: string }>;
}

/** The singleton's live inputs, exposed for tests; `null` until `wireInstallPromptCapture`. */
const heldEvent = shallowRef<BeforeInstallPromptEvent | null>(null);
const appInstalled = ref(false);
let wired = false;

/** Boot wiring — call ONCE from `main.ts` before mount (idempotent; late calls are no-ops). */
export function wireInstallPromptCapture(win: InstallWindow): void {
  if (wired) return;
  wired = true;
  win.addEventListener("beforeinstallprompt", (ev) => {
    const e = ev as BeforeInstallPromptEvent;
    if (typeof e.prompt !== "function" || !(e.userChoice instanceof Promise)) return; // not the real event
    ev.preventDefault(); // keep Chromium's mini-infobar down; the settings card owns the flow
    heldEvent.value = e;
  });
  win.addEventListener("appinstalled", () => {
    appInstalled.value = true;
    heldEvent.value = null;
  });
}

/** Test hook (useI18n's `resetLangForTests` precedent): singleton back to the pre-wire state. */
export function resetInstallPromptForTests(): void {
  heldEvent.value = null;
  appInstalled.value = false;
  wired = false;
}

export function isStandaloneDisplay(win: InstallWindow): boolean {
  try {
    if (win.matchMedia("(display-mode: standalone)").matches) return true;
  } catch {
    /* a fake without real matchMedia semantics — fall through to navigator.standalone */
  }
  return win.navigator.standalone === true; // iOS Safari home-screen web app
}

/** What `prompt()` resolved to on the last install click (`null` = never / still pending). */
export type InstallOutcome = "accepted" | "dismissed";

export interface InstallPromptHandle {
  readonly state: ComputedRef<InstallState>;
  readonly outcome: Readonly<Ref<InstallOutcome | null>>;
  /** Fire the held event's native prompt. No-op when there is nothing to prompt with. */
  install(): Promise<void>;
}

export function useInstallPrompt(win: InstallWindow): InstallPromptHandle {
  const state = computed<InstallState>(() =>
    deriveInstallState({
      ua: win.navigator.userAgent ?? "",
      standalone: isStandaloneDisplay(win) || appInstalled.value,
      hasPrompt: heldEvent.value !== null,
      isSecureContext: win.isSecureContext,
      origin: win.location.origin,
    }),
  );
  const outcome = ref<InstallOutcome | null>(null);
  async function install(): Promise<void> {
    const ev = heldEvent.value;
    if (ev === null) return;
    heldEvent.value = null; // one shot per event; a dismissal falls back to guidance
    await ev.prompt();
    const choice = await ev.userChoice.catch(() => null); // never reject the click over a lost race
    if (choice !== null) outcome.value = choice.outcome;
  }
  return { state, outcome: readonly(outcome), install };
}
