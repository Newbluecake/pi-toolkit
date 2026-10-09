/**
 * Motion preference (`pwh_motion`, 2026-10) — the browser-side switch over the OS
 * `prefers-reduced-motion` setting. Field report: the user's desktop Edge reports
 * `prefers-reduced-motion: reduce` (Windows animation effects off), which killed every
 * animation in the UI (composer busy breathe, spinners, dots, carets, skeletons…) via the
 * reduce media rules spread across the stylesheets. This pref is the runtime half of the
 * switch:
 *
 *   - `"system"` (default / absent / invalid): follow the OS. No `data-motion` attribute on
 *     `<html>`; the rewritten media rules (see `../../motion-css.ts`) answer the OS query.
 *   - `"on"`:  animations ALWAYS run (`<html data-motion="on">`) — the rewritten reduce
 *     rules stop applying even when the OS requests reduce.
 *   - `"off"`: reduced motion ALWAYS (`<html data-motion="off">`) — the forced copies
 *     emitted by the CSS rewrite (motion-css.ts) apply even when the OS does not request reduce.
 *
 * Persistence discipline mirrors `usePlaintextWarning.ts` (the latest pref pattern): the
 * storage global is INJECTED by the caller (components pass `shell/themeStorage.ts`'s
 * `browserLocalStorage()`), so this file never names the storage identifier and stays clean
 * under `source-scan.test.ts`'s localStorage rule; anything but the exact tokens
 * `"system" | "on" | "off"` fails open to `"system"` — byte-identical to the pre-feature
 * behavior when the pref is missing. The shared reactive source is module scope
 * (single-page app, one ref — same rationale as `usePlaintextWarning.ts`/`useI18n.ts`), so
 * the settings card instantly re-applies the attribute and every later `useMotionPref()`
 * caller sees fresh values; OTHER tabs are picked up through the `storage` event.
 * `public/theme-init.js` applies the attribute before first paint; this composable is the
 * runtime counterpart (exactly the `pwh_theme` / `useTheme.ts` split).
 */
import { ref, type Ref } from "vue";

/** Browser-local storage key (siblings: `pwh_theme`, `pwh_fontscale`, `pwh_keepalive`). */
export const MOTION_STORAGE_KEY = "pwh_motion";

export type MotionPref = "system" | "on" | "off";

/** Storage global injected by the caller (same minimal face as `PlaintextWarnStorage`). */
export interface MotionStorage {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
}

/** The slice of a `storage` event this module cares about (test-injectable). */
export interface MotionStorageEvent {
  readonly key: string | null;
  readonly newValue: string | null;
}

/** Minimal `window` face for the cross-tab storage-event sync (test-injectable). */
export interface MotionWindow {
  addEventListener(type: "storage", listener: (ev: MotionStorageEvent) => void): void;
  removeEventListener(type: "storage", listener: (ev: MotionStorageEvent) => void): void;
}

/** Minimal `matchMedia` face for the system branch of {@link prefersReducedMotion}. */
export interface MotionMatchMediaWindow {
  matchMedia(query: string): { readonly matches: boolean };
}

/** Minimal `document` face for the `<html data-motion>` attribute (test-injectable). */
export interface MotionDocument {
  readonly documentElement: MotionDocumentElement;
}

export interface MotionDocumentElement {
  setAttribute(name: string, value: string): void;
  removeAttribute(name: string): void;
}

/** Only the three exact tokens parse; absent/junk ⇒ `null` (fail open to `"system"`). */
export function parseMotionPref(raw: string | null): MotionPref | null {
  return raw === "system" || raw === "on" || raw === "off" ? raw : null;
}

/** Read the preference; a throwing/unavailable storage fails open to `"system"`. */
export function loadMotionPref(storage: MotionStorage): MotionPref {
  let raw: string | null = null;
  try {
    raw = storage.getItem(MOTION_STORAGE_KEY);
  } catch {
    return "system";
  }
  return parseMotionPref(raw) ?? "system";
}

/** Persist the preference (the settings card writes it). Write failures are ignored — the
 * in-memory preference still applies for this load (same fail-open shape as useDeliverDefault). */
export function setMotionPrefValue(storage: MotionStorage, pref: MotionPref): void {
  try {
    storage.setItem(MOTION_STORAGE_KEY, pref);
  } catch {
    /* storage disabled/unavailable */
  }
}

/** Apply the pref to `<html>`: `"on"`/`"off"` set `data-motion`, `"system"` removes it —
 * the rewritten reduce rules (motion-css.ts) read exactly that attribute. */
export function applyMotionAttr(doc: MotionDocument, pref: MotionPref): void {
  if (pref === "on" || pref === "off") doc.documentElement.setAttribute("data-motion", pref);
  else doc.documentElement.removeAttribute("data-motion");
}

/**
 * The single funnel for JS-side motion decisions (smooth scrolling, animated scroll
 * restores, canvas loops …). Honours the pref: `"on"` ⇒ never reduced, `"off"` ⇒ always
 * reduced, `"system"` ⇒ whatever `matchMedia("(prefers-reduced-motion: reduce)")` says.
 * A missing/unusable `matchMedia` under `"system"` answers `false` — the same answer a
 * browser without the feature gives the media query (no-preference is the platform default).
 * No call sites exist yet (all current scrolling is instant `scrollTop` assignment); new
 * JS-side motion decisions MUST route through this helper instead of calling `matchMedia`
 * directly, or the `data-motion` switch will not reach them.
 */
export function prefersReducedMotion(pref: MotionPref, win?: MotionMatchMediaWindow | null): boolean {
  if (pref === "on") return false;
  if (pref === "off") return true;
  const w = win === undefined ? (typeof window === "undefined" ? null : window) : win;
  if (w === null || typeof w.matchMedia !== "function") return false;
  return w.matchMedia("(prefers-reduced-motion: reduce)").matches;
}

// --- shared reactive source (see the header: module scope is deliberate) ----------------------
const pref = ref<MotionPref>("system");
let listenerWin: MotionWindow | null = null;
let listenerDoc: MotionDocument | null = null;
let activeStorage: MotionStorage | null = null;

function onStorageEvent(ev: MotionStorageEvent): void {
  if (ev.key === MOTION_STORAGE_KEY) {
    const next = parseMotionPref(ev.newValue) ?? "system";
    pref.value = next;
    if (listenerDoc !== null) applyMotionAttr(listenerDoc, next);
    return;
  }
  // `key === null` means a storage.clear() in another tab — re-read the whole key.
  if (ev.key === null && activeStorage !== null) {
    const next = loadMotionPref(activeStorage);
    pref.value = next;
    if (listenerDoc !== null) applyMotionAttr(listenerDoc, next);
  }
}

function defaultDoc(): MotionDocument | null {
  return typeof document === "undefined" ? null : document;
}

function defaultWin(): MotionWindow | null {
  return typeof window === "undefined" ? null : window;
}

export interface MotionPrefHandle {
  /** Current preference — shared by every component (drives the settings radio rows). */
  readonly pref: Ref<MotionPref>;
  /** Apply + persist (the settings card). Updates the attribute and every mounted consumer. */
  setPref(next: MotionPref): void;
}

export function useMotionPref(opts: {
  storage: MotionStorage;
  /** Defaults to the real `document` when present; `null` disables attribute writes (tests). */
  doc?: MotionDocument | null;
  /** Defaults to the real `window` when present; `null` disables cross-tab sync (tests). */
  win?: MotionWindow | null;
}): MotionPrefHandle {
  activeStorage = opts.storage;
  pref.value = loadMotionPref(opts.storage);
  const doc = opts.doc === undefined ? defaultDoc() : opts.doc;
  if (doc !== null) {
    listenerDoc = doc;
    applyMotionAttr(doc, pref.value); // theme-init.js already did this pre-paint; re-assert
  }
  const win = opts.win === undefined ? defaultWin() : opts.win;
  if (win !== null && listenerWin === null) {
    listenerWin = win;
    win.addEventListener("storage", onStorageEvent); // page-lifetime listener (SPA, never removed)
  }
  return {
    pref,
    setPref(next) {
      pref.value = next;
      setMotionPrefValue(opts.storage, next);
      if (doc !== null) applyMotionAttr(doc, next);
    },
  };
}

/** Test hook: drop the shared source back to "system" and detach the cross-tab listener
 * (module state is shared across tests in one worker — same shape as `resetPlaintextWarningForTests`). */
export function resetMotionPrefForTests(): void {
  pref.value = "system";
  if (listenerWin !== null) {
    listenerWin.removeEventListener("storage", onStorageEvent);
    listenerWin = null;
  }
  listenerDoc = null;
  activeStorage = null;
}
