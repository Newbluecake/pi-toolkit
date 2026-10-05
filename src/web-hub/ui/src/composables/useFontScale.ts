/**
 * Continuous font-scale preference (80%–300%, 5% steps). A strict mirror of `useTheme.ts`'s
 * precedent: `public/theme-init.js` already applies the persisted value as the `--fs-scale`
 * custom property on `<html>` before first paint (no flash of the wrong text size); this
 * composable is the *runtime* counterpart — reading the same `pwh_fontscale` storage key,
 * writing the same property, and persisting changes made through the settings page's
 * (`shell/SettingsView.vue`, 2026-10) font-size slider. Like `useTheme.ts`, it never touches the storage global directly (deps are
 * injected, the toggle passes `shell/themeStorage.ts`'s `browserLocalStorage()`), so this
 * file stays clean under `source-scan.test.ts`'s storage-identifier rule without needing a
 * path exemption.
 *
 * Storage holds the aligned decimal as a string ("1.25", "0.8", "1"). A stored value that is
 * unparseable or outside [MIN, MAX] fails open to 1 (100%) — same fail-open philosophy as
 * `theme-init.js`. Values passed in at runtime are clamped to the range and aligned to STEP,
 * so the slider (or any future caller) can never put a misaligned value into the DOM.
 */
import { ref, type Ref } from "vue";

export const FONT_SCALE_STORAGE_KEY = "pwh_fontscale";

export const FONT_SCALE_MIN = 0.8;
export const FONT_SCALE_MAX = 3.0; // 2026-10-05: user asked for up to 300%
export const FONT_SCALE_STEP = 0.05;
export const FONT_SCALE_DEFAULT = 1;

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

/** Clamp to [MIN, MAX] and align to the nearest STEP (two decimals — 0.05 grid). */
export function alignFontScale(value: number): number {
  const clamped = Math.min(FONT_SCALE_MAX, Math.max(FONT_SCALE_MIN, value));
  return Number((Math.round(clamped / FONT_SCALE_STEP) * FONT_SCALE_STEP).toFixed(2));
}

/** Storage/DOM string form of an aligned value: 1 → "1", 1.25 → "1.25", 0.8 → "0.8". */
export function formatFontScale(value: number): string {
  return String(alignFontScale(value));
}

/** Read the persisted preference; unparseable or out-of-range values fail open to 1. */
export function loadFontScale(storage: FontScaleStorage): number {
  let raw: string | null = null;
  try {
    raw = storage.getItem(FONT_SCALE_STORAGE_KEY);
  } catch {
    /* storage disabled/unavailable — same fail-open-to-default behavior as theme-init.js */
  }
  if (raw === null) return FONT_SCALE_DEFAULT;
  const parsed = Number(raw);
  if (!Number.isFinite(parsed) || parsed < FONT_SCALE_MIN || parsed > FONT_SCALE_MAX) {
    return FONT_SCALE_DEFAULT;
  }
  return alignFontScale(parsed);
}

/** Write `--fs-scale` on `<html>`; tokens.css's `calc(<px> * var(--fs-scale, 1))` does the rest. */
export function applyFontScale(doc: FontScaleDocument, scale: number): void {
  doc.documentElement.style.setProperty("--fs-scale", String(scale));
}

/** Percent for labels/aria/readout: 1 → 100, 1.25 → 125. */
export function fontScalePercent(scale: number): number {
  return Math.round(scale * 100);
}

export interface UseFontScaleOptions {
  storage: FontScaleStorage;
  doc: FontScaleDocument;
}

export interface FontScaleHandle {
  /** Current value — aligned to STEP and within [MIN, MAX]. */
  readonly scale: Ref<number>;
  /** Live-apply without persisting (slider `input` while dragging). */
  preview(value: number): void;
  /** Apply + persist (slider `change` on release, reset button). */
  setScale(value: number): void;
  /** Back to 100% (applied + persisted). */
  reset(): void;
}

export function useFontScale(opts: UseFontScaleOptions): FontScaleHandle {
  const scale = ref(loadFontScale(opts.storage)) as Ref<number>;

  // theme-init.js already set the property pre-paint; this re-asserts it (harmless) so the
  // runtime state and the DOM can never drift apart.
  applyFontScale(opts.doc, scale.value);

  function persist(value: number): void {
    try {
      opts.storage.setItem(FONT_SCALE_STORAGE_KEY, formatFontScale(value));
    } catch {
      /* storage disabled/unavailable — the in-memory preference still applies for this load */
    }
  }

  return {
    scale,
    // The slider's input/change split is deliberate: dragging must not hammer localStorage,
    // so preview() skips persistence entirely instead of debouncing it.
    preview(value) {
      scale.value = alignFontScale(value);
      applyFontScale(opts.doc, scale.value);
    },
    setScale(value) {
      scale.value = alignFontScale(value);
      applyFontScale(opts.doc, scale.value);
      persist(scale.value);
    },
    reset() {
      scale.value = FONT_SCALE_DEFAULT;
      applyFontScale(opts.doc, scale.value);
      persist(scale.value);
    },
  };
}
