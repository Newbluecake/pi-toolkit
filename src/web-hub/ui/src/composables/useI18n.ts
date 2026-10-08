/**
 * i18n composable (vue-plan.md v2.1 §3.8, §5.2 — P0). Auto-detects zh/en from
 * `navigator.languages` and exposes `t(key, params)` for a `"namespace.leafKey"` lookup against
 * `i18n/index.ts`'s merged `MESSAGES`. Falls back to the English namespace/leaf, then to the
 * raw key itself, so a missing translation degrades to a visible-but-harmless key string
 * rather than throwing.
 *
 * 2026-10-08 — manual language switch (user request, TopBar toggle): plan §0.2's "no manual
 * switcher" is superseded. A persisted override (`localStorage["pwh_lang"]`, mirrors
 * useTheme.ts's `pwh_theme` discipline — the source-scan whitelist carries this file) beats
 * auto-detection. Calls WITHOUT arguments share one reactive source: `t` reads it per call and
 * `lang` is a getter, so every component re-renders on switch — but destructuring `lang` off
 * the handle freezes it, so call sites that need reactivity must keep the handle
 * (`i18n.lang`). Calls WITH an explicit languages argument stay pinned (test seam, unchanged).
 */
import { ref } from "vue";
import { MESSAGES } from "../i18n/index.js";

export type Lang = "en" | "zh";

/** Persisted override key (see the header note; mirrors useTheme.ts's `pwh_theme`). */
export const LANG_STORAGE_KEY = "pwh_lang";

/** Minimal storage surface (mirrors useTheme.ts's ThemeStorage) so the pure part is testable. */
export interface LangStorage {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
}

/** First language tag starting with `zh` ⇒ `"zh"`, otherwise `"en"` (plan §3.8). */
export function detectLang(languages: readonly string[] | undefined): Lang {
  const first = (languages ?? []).find((l) => typeof l === "string" && l !== "");
  return typeof first === "string" && first.toLowerCase().startsWith("zh") ? "zh" : "en";
}

/** Read the persisted override; storage failures and junk values both fail open to `null` (auto). */
export function loadLangOverride(storage: LangStorage): Lang | null {
  let raw: string | null = null;
  try {
    raw = storage.getItem(LANG_STORAGE_KEY);
  } catch {
    return null;
  }
  return raw === "zh" || raw === "en" ? raw : null;
}

function defaultStorage(): LangStorage | null {
  try {
    return typeof localStorage === "undefined" ? null : localStorage;
  } catch {
    return null;
  }
}

/** The shared reactive source for no-arg `useI18n()` calls. Module scope is deliberate: the UI
 * bundle is a single-page app (no per-activate rebuild like the pi extension host), and this is
 * what makes a runtime switch visible in all ~57 components without touching their call sites. */
const override = ref<Lang | null>(
  loadLangOverride(defaultStorage() ?? { getItem: () => null, setItem: () => {}, removeItem: () => {} }),
);
/** Auto-detection reads `navigator.languages` FRESH per call (never memoized at module load):
 * legacy tests stub navigator after import and expect the stub to win — and a user changing
 * browser languages without a reload gets picked up the same way. detectLang is trivial. */
function activeLang(): Lang {
  return override.value ?? detectLang(typeof navigator === "undefined" ? undefined : navigator.languages);
}

/**
 * Set (`"zh"`/`"en"`) or clear (`null` = back to auto-detect) the language override. Persisted
 * best-effort; storage failures only mean the choice doesn't survive a reload.
 */
export function setLangOverride(lang: Lang | null, storage: LangStorage | null = defaultStorage()): void {
  override.value = lang;
  try {
    if (lang === null) storage?.removeItem(LANG_STORAGE_KEY);
    else storage?.setItem(LANG_STORAGE_KEY, lang);
  } catch {
    /* storage disabled — session-only override */
  }
}

/** Test hook: reset the shared source to the auto-detected language (module state is shared
 * across tests in one worker). */
export function resetLangForTests(): void {
  override.value = null;
}

function splitKey(key: string): { ns: string; leaf: string } {
  const dot = key.indexOf(".");
  return dot < 0 ? { ns: key, leaf: "" } : { ns: key.slice(0, dot), leaf: key.slice(dot + 1) };
}

function lookup(lang: Lang, key: string): string | undefined {
  const { ns, leaf } = splitKey(key);
  return MESSAGES[lang]?.[ns]?.[leaf];
}

/** `{name}`-style placeholder substitution only — the result is always plain text, never HTML. */
function interpolate(raw: string, params: Readonly<Record<string, string | number>> | undefined): string {
  if (!params) return raw;
  return raw.replace(/\{(\w+)\}/g, (whole, name: string) =>
    Object.prototype.hasOwnProperty.call(params, name) ? String(params[name]) : whole,
  );
}

export interface I18nHandle {
  readonly lang: Lang;
  t(key: string, params?: Readonly<Record<string, string | number>>): string;
}

function pinnedHandle(lang: Lang): I18nHandle {
  return {
    lang,
    t(key, params) {
      const raw = lookup(lang, key) ?? lookup("en", key) ?? key;
      return interpolate(raw, params);
    },
  };
}

export function useI18n(navigatorLanguages?: readonly string[] | undefined): I18nHandle {
  // Test seam: an explicit languages argument pins the handle exactly like the pre-override
  // build (byte-identical behavior for every existing pinned call).
  if (navigatorLanguages !== undefined) return pinnedHandle(detectLang(navigatorLanguages));
  return {
    get lang() {
      return activeLang();
    },
    t(key, params) {
      const lang = activeLang();
      const raw = lookup(lang, key) ?? lookup("en", key) ?? key;
      return interpolate(raw, params);
    },
  };
}
