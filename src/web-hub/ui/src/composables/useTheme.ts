/**
 * Three-state theme preference (vue-plan.md v2.1 §3.9, §5.2 — P1). `public/theme-init.js` (P0)
 * already applies the persisted class before first paint; this composable is the *runtime*
 * counterpart — reading the same `pwh_theme` localStorage key, applying the same two classes,
 * and persisting further changes made through the settings page (`shell/SettingsView.vue`,
 * 2026-10 — the top-bar `ThemeToggle.vue` dropdown is retired). This file's path matches
 * `source-scan.test.ts`'s `LOCALSTORAGE_ALLOWED` exemption (`/theme|token-client/i`) — the one
 * place in `src/web-hub/ui/**` (besides the frozen `theme-init.js`) allowed to touch
 * `localStorage`.
 */
import { ref, watch, type Ref } from "vue";
import type { ThemePref } from "../types.js";

export const THEME_STORAGE_KEY = "pwh_theme";

export interface ThemeStorage {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
}

export interface ThemeDocumentElement {
  classList: { add(...classes: string[]): void; remove(...classes: string[]): void };
}

export interface ThemeDocument {
  readonly documentElement: ThemeDocumentElement;
}

export interface ThemeMeta {
  setAttribute(name: string, value: string): void;
}

function isThemePref(v: string | null): v is ThemePref {
  return v === "system" || v === "light" || v === "dark";
}

/** Read the persisted preference, defaulting to `"system"` (matches `theme-init.js`'s fallback). */
export function loadThemePref(storage: ThemeStorage): ThemePref {
  let raw: string | null = null;
  try {
    raw = storage.getItem(THEME_STORAGE_KEY);
  } catch {
    /* storage disabled/unavailable — same fail-open-to-"system" behavior as theme-init.js */
  }
  return isThemePref(raw) ? raw : "system";
}

/** `"system"` removes both classes (tokens.css's `prefers-color-scheme` takes over). */
export function applyThemeClasses(doc: ThemeDocument, pref: ThemePref): void {
  doc.documentElement.classList.remove("theme-light", "theme-dark");
  if (pref === "light") doc.documentElement.classList.add("theme-light");
  else if (pref === "dark") doc.documentElement.classList.add("theme-dark");
}

const META_COLOR: Record<ThemePref, string> = {
  system: "#0B7A70",
  light: "#0B7A70",
  dark: "#0B0F10",
};

export interface UseThemeOptions {
  storage: ThemeStorage;
  doc: ThemeDocument;
  metaThemeColor?: ThemeMeta | null;
}

export interface ThemeHandle {
  readonly pref: Ref<ThemePref>;
  setPref(next: ThemePref): void;
}

export function useTheme(opts: UseThemeOptions): ThemeHandle {
  const pref = ref<ThemePref>(loadThemePref(opts.storage)) as Ref<ThemePref>;

  function apply(next: ThemePref): void {
    applyThemeClasses(opts.doc, next);
    opts.metaThemeColor?.setAttribute("content", META_COLOR[next]);
  }
  apply(pref.value); // theme-init.js already set the class pre-paint; this also sets the meta color

  watch(
    pref,
    (next) => {
      try {
        opts.storage.setItem(THEME_STORAGE_KEY, next);
      } catch {
        /* storage disabled/unavailable — the in-memory preference still applies for this load */
      }
      apply(next);
    },
    { flush: "sync" }, // theme swap is an imperative side effect, not part of render-gated DOM patching — must apply the moment setPref() is called, not on Vue's next tick
  );

  return {
    pref,
    setPref(next) {
      pref.value = next;
    },
  };
}
