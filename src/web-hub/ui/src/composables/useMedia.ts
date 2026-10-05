/**
 * `matchMedia` as a reactive boolean (vue-plan.md v2.1 §3.6, §3.9, §5.2 — P1). Used for the
 * mobile transcript-window default (`(max-width: 480px)`), the ≥1025 split-pane breakpoint, and
 * `(pointer: coarse)` touch-target sizing (§3.12/§6.3) — one small composable instead of four
 * bespoke `resize`/`matchMedia` listeners.
 */
import { onScopeDispose, ref, type Ref } from "vue";

export interface MediaLike {
  matches: boolean;
  addEventListener(type: "change", listener: (ev: { matches: boolean }) => void): void;
  removeEventListener(type: "change", listener: (ev: { matches: boolean }) => void): void;
}

export interface MediaWindow {
  matchMedia(query: string): MediaLike;
}

export interface UseMediaHandle {
  readonly matches: Readonly<Ref<boolean>>;
  dispose(): void;
}

/**
 * Registers cleanup with `onScopeDispose` when called inside a component/effect scope (harmless
 * no-op otherwise, e.g. in a plain unit test that calls `dispose()` itself instead).
 */
export function useMedia(win: MediaWindow, query: string): UseMediaHandle {
  const mql = win.matchMedia(query);
  const matches = ref(mql.matches) as Ref<boolean>;
  const onChange = (ev: { matches: boolean }): void => {
    matches.value = ev.matches;
  };
  mql.addEventListener("change", onChange);
  let disposed = false;
  const dispose = (): void => {
    if (disposed) return;
    disposed = true;
    mql.removeEventListener("change", onChange);
  };
  onScopeDispose(dispose, true); // failSilently: safe to call outside a component/effect scope (unit tests)
  return { matches, dispose };
}
