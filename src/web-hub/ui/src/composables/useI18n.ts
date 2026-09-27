/**
 * i18n composable (vue-plan.md v2.1 §3.8, §5.2 — P0). Auto-detects zh/en from
 * `navigator.languages` (no manual switcher — plan §0.2) and exposes `t(key, params)` for a
 * `"namespace.leafKey"` lookup against `i18n/index.ts`'s merged `MESSAGES`. Falls back to the
 * English namespace/leaf, then to the raw key itself, so a missing translation degrades to a
 * visible-but-harmless key string rather than throwing.
 */
import { MESSAGES } from "../i18n/index.js";

export type Lang = "en" | "zh";

/** First language tag starting with `zh` ⇒ `"zh"`, otherwise `"en"` (plan §3.8). */
export function detectLang(languages: readonly string[] | undefined): Lang {
  const first = (languages ?? []).find((l) => typeof l === "string" && l !== "");
  return typeof first === "string" && first.toLowerCase().startsWith("zh") ? "zh" : "en";
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

export function useI18n(navigatorLanguages: readonly string[] | undefined = navigator.languages): I18nHandle {
  const lang = detectLang(navigatorLanguages);
  return {
    lang,
    t(key, params) {
      const raw = lookup(lang, key) ?? lookup("en", key) ?? key;
      return interpolate(raw, params);
    },
  };
}
