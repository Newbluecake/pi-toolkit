/**
 * Effective dark-theme signal (web-hub-mermaid plan §6.1, P2). `useTheme` owns the *preference*
 * (`system`/`light`/`dark`) and applies `theme-light`/`theme-dark` classes on `<html>`; what a
 * diagram renderer needs is the *effective* color scheme the user actually sees right now:
 *
 *   dark  ⇔  `html.theme-dark`, OR (no `theme-light` AND `prefers-color-scheme: dark`)
 *
 * — exactly the precedence `tokens.css`/`public/theme-init.js` paint with. A transcript page
 * holds many diagrams at once, so the observers are shared: the first consumer installs one
 * MutationObserver (class attribute on `documentElement`) plus one `(prefers-color-scheme:
 * dark)` mql listener feeding a single reactive ref; every later consumer in the same page
 * just reads it. The last one out (refcount → 0) tears everything down — no leaked observers
 * when the last diagram unmounts (keepalive session switches mount/unmount these routinely).
 *
 * Injectable surface (mirrors `useTheme`/`useMedia` discipline) so the wiring is testable
 * without a DOM; happy-dom's real `window` satisfies it in component tests.
 */
import { onScopeDispose, ref, type Ref } from "vue";

export interface EffectiveDarkElement {
  readonly classList: { contains(token: string): boolean };
}

export interface EffectiveDarkMediaQuery {
  readonly matches: boolean;
  addEventListener?(type: "change", listener: (ev: { matches: boolean }) => void): void;
  removeEventListener?(type: "change", listener: (ev: { matches: boolean }) => void): void;
}

/** Structural subset of `MutationObserver` this composable uses (tests fake this). */
export interface MutationObserverLike {
  observe(target: unknown, options: { attributes: boolean; attributeFilter: string[] }): void;
  disconnect(): void;
}

/** `new MutationObserver(cb)` as far as this module cares (0-arg callback: records unused). */
export type MutationObserverCtor = new (callback: () => void) => MutationObserverLike;

export interface EffectiveDarkWindow {
  readonly document?: { readonly documentElement: EffectiveDarkElement } | undefined;
  matchMedia?(query: string): EffectiveDarkMediaQuery | undefined;
  readonly MutationObserver?: MutationObserverCtor | undefined;
}

function defaultWindow(): EffectiveDarkWindow {
  return typeof window === "undefined" ? {} : (window as unknown as EffectiveDarkWindow);
}

/** Pure decision (plan §6.1): `theme-dark` wins, then `theme-light` blocks, then the OS query. */
export function computeEffectiveDark(
  el: EffectiveDarkElement | null | undefined,
  mqlMatches: boolean | undefined,
): boolean {
  if (el?.classList.contains("theme-dark") === true) return true;
  if (el?.classList.contains("theme-light") === true) return false;
  return mqlMatches === true;
}

interface SharedDark {
  readonly dark: Ref<boolean>;
  refs: number;
  stop(): void;
}

/** Module-scope singleton: the UI is a single-page app, one document ⇒ one live signal. */
let shared: SharedDark | null = null;

/**
 * Returns the shared reactive effective-dark ref. Observers are installed on first use and
 * released when the last consumer's scope disposes (refcount; safe outside a component scope
 * too — such a caller just never auto-releases).
 */
export function useEffectiveDark(win: EffectiveDarkWindow = defaultWindow()): Readonly<Ref<boolean>> {
  if (shared === null) {
    const docEl = win.document?.documentElement ?? null;
    const mql = win.matchMedia?.("(prefers-color-scheme: dark)") ?? null;
    const dark = ref(computeEffectiveDark(docEl, mql?.matches));
    const resync = (): void => {
      dark.value = computeEffectiveDark(docEl, mql?.matches);
    };
    let observer: MutationObserverLike | null = null;
    if (win.MutationObserver !== undefined && docEl !== null) {
      try {
        observer = new win.MutationObserver(resync);
        observer.observe(docEl, { attributes: true, attributeFilter: ["class"] });
      } catch {
        observer = null; // hostile fake — the mql listener and the initial read still work
      }
    }
    const onChange = (ev: { matches: boolean }): void => {
      void ev;
      resync();
    };
    mql?.addEventListener?.("change", onChange);
    shared = {
      dark,
      refs: 0,
      stop() {
        observer?.disconnect();
        mql?.removeEventListener?.("change", onChange);
      },
    };
  }
  shared.refs += 1;
  const mine = shared;
  onScopeDispose(() => {
    if (mine !== shared) return; // a newer singleton already replaced this one
    mine.refs -= 1;
    if (mine.refs <= 0) {
      mine.stop();
      shared = null;
    }
  }, true); // failSilently: callable from plain unit tests outside a component scope
  return shared.dark;
}
