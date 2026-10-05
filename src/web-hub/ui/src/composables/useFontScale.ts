/**
 * Four-step font-scale preference (100% / 115% / 130% / 150%). A strict mirror of
 * `useTheme.ts`'s precedent: `public/theme-init.js` already applies the persisted value as
 * the `--fs-scale` custom property on `<html>` before first paint (no flash of the wrong
 * text size); this composable is the *runtime* counterpart — reading the same
 * `pwh_fontscale` storage key, writing the same property, and persisting further changes
 * made through `FontScaleToggle.vue`. Like `useTheme.ts`, it never touches the storage
 * global directly (deps are injected, `App.vue`/the toggle pass
 * `shell/themeStorage.ts`'s `browserLocalStorage()`), so this file stays clean under
 * `source-scan.test.ts`'s storage-identifier rule without needing a path exemption.
 */
import { ref, watch, type Ref } from "vue";

export const FONT_SCALE_STORAGE_KEY = "pwh_fontscale";

/** Cycle order of the toggle: 100% → 115% → 130% → 150% → 100%. */
export const FONT_SCALES = ["1", "1.15", "1.3", "1.5"] as const;
export type FontScale = (typeof FONT_SCALES)[number];

export interface FontScaleStorage {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
}

export interface FontScaleDocumentElement {
  style: { setProperty(name: string, value: string): void };
}

export interface FontScaleDocument {
  readonly documentElement: FontScaleDocumentElement;
}

function isFontScale(v: string | null): v is FontScale {
  return (FONT_SCALES as readonly string[]).includes(v ?? "");
}

/** Read the persisted preference, defaulting to `"1"` (matches `theme-init.js`'s fallback). */
export function loadFontScale(storage: FontScaleStorage): FontScale {
  let raw: string | null = null;
  try {
    raw = storage.getItem(FONT_SCALE_STORAGE_KEY);
  } catch {
    /* storage disabled/unavailable — same fail-open-to-default behavior as theme-init.js */
  }
  return isFontScale(raw) ? raw : "1";
}

/** Write `--fs-scale` on `<html>`; tokens.css's `calc(<px> * var(--fs-scale, 1))` does the rest. */
export function applyFontScale(doc: FontScaleDocument, scale: FontScale): void {
  doc.documentElement.style.setProperty("--fs-scale", scale);
}

/** Next step in the cycle (wraps 150% → 100%). */
export function nextFontScale(current: FontScale): FontScale {
  const idx = FONT_SCALES.indexOf(current);
  return FONT_SCALES[(idx + 1) % FONT_SCALES.length]!;
}

/** Percent for labels/aria: "1" → 100, "1.15" → 115. */
export function fontScalePercent(scale: FontScale): number {
  return Math.round(Number(scale) * 100);
}

export interface UseFontScaleOptions {
  storage: FontScaleStorage;
  doc: FontScaleDocument;
}

export interface FontScaleHandle {
  readonly scale: Ref<FontScale>;
  setScale(next: FontScale): void;
  /** Advance one step in the 100→115→130→150→100 cycle. */
  cycle(): void;
}

export function useFontScale(opts: UseFontScaleOptions): FontScaleHandle {
  const scale = ref<FontScale>(loadFontScale(opts.storage)) as Ref<FontScale>;

  // theme-init.js already set the property pre-paint; this re-asserts it (harmless) so the
  // runtime state and the DOM can never drift apart.
  applyFontScale(opts.doc, scale.value);

  watch(
    scale,
    (next) => {
      try {
        opts.storage.setItem(FONT_SCALE_STORAGE_KEY, next);
      } catch {
        /* storage disabled/unavailable — the in-memory preference still applies for this load */
      }
      applyFontScale(opts.doc, next);
    },
    { flush: "sync" }, // imperative side effect like useTheme's class swap — apply the moment setScale() is called
  );

  return {
    scale,
    setScale(next) {
      scale.value = next;
    },
    cycle() {
      scale.value = nextFontScale(scale.value);
    },
  };
}
