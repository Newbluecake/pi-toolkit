/**
 * Preview line-number visibility preference (`pwh_linenumbers`, 2026-10-23) — the
 * browser-local switch for the numbered source view in the file preview. ON by default
 * (用户拍板: 默认开启); only the exact token `"0"` disables it — absent, `"1"`, junk, or a
 * throwing/unavailable storage all fail open to ON. A pure browser preference in the
 * `pwh_theme` / `pwh_keepalive` / `pwh_hide_plaintext_warn` family, NOT a pi-process
 * setting: one hub serves many pi's, and the gutter is a per-browser display choice shared
 * by ALL open preview windows.
 *
 * Discipline mirrors `usePlaintextWarning.ts` (the latest pref pattern): the storage global
 * is INJECTED by the caller (components pass `shell/themeStorage.ts`'s
 * `browserLocalStorage()`), so this file never names the storage identifier and stays clean
 * under `source-scan.test.ts`'s localStorage rule. The reactive source is module scope,
 * deliberately (same rationale as `usePlaintextWarning.ts`/`useI18n.ts`): one shared ref is
 * what makes the header toggle instantly re-render every open preview window without
 * per-window wiring. Every `useLineNumbersPref()` call re-reads the pref, so a window
 * opened later can never pin a stale value; other tabs sync through the `storage` event.
 */
import { ref, type Ref } from "vue";

/** Browser-local storage key (siblings: `pwh_theme`, `pwh_fontscale`, `pwh_keepalive`). */
export const LINE_NUMBERS_STORAGE_KEY = "pwh_linenumbers";

/** Storage global injected by the caller (same minimal face as `PlaintextWarnStorage`). */
export interface LineNumbersStorage {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
}

/** The slice of a `storage` event this module cares about (test-injectable). */
export interface LineNumbersStorageEvent {
  readonly key: string | null;
  readonly newValue: string | null;
}

/** Minimal `window` face for the cross-tab storage-event sync (test-injectable). */
export interface LineNumbersWindow {
  addEventListener(type: "storage", listener: (ev: LineNumbersStorageEvent) => void): void;
  removeEventListener(type: "storage", listener: (ev: LineNumbersStorageEvent) => void): void;
}

/** Only the exact token `"0"` hides the numbers; everything else keeps the default ON. */
export function parseLineNumbersOn(raw: string | null): boolean {
  return raw !== "0";
}

/** Read the preference; a throwing/unavailable storage fails open to ON (same default). */
export function loadLineNumbersOn(storage: LineNumbersStorage): boolean {
  let raw: string | null = null;
  try {
    raw = storage.getItem(LINE_NUMBERS_STORAGE_KEY);
  } catch {
    return true;
  }
  return parseLineNumbersOn(raw);
}

/** Persist the preference (`"1"` = show / `"0"` = hide). Write failures are ignored — the
 *  in-memory preference still applies for this load (same fail-open shape as the other prefs). */
export function setLineNumbersPref(storage: LineNumbersStorage, on: boolean): void {
  try {
    storage.setItem(LINE_NUMBERS_STORAGE_KEY, on ? "1" : "0");
  } catch {
    /* storage disabled/unavailable */
  }
}

// --- shared reactive source (see the header: module scope is deliberate) ----------------------
const on = ref(true);
let listenerWin: LineNumbersWindow | null = null;
let listenerStorage: LineNumbersStorage | null = null;

function onStorageEvent(ev: LineNumbersStorageEvent): void {
  if (ev.key === LINE_NUMBERS_STORAGE_KEY) {
    on.value = parseLineNumbersOn(ev.newValue);
    return;
  }
  // `key === null` means a storage.clear() in another tab — re-read the whole key.
  if (ev.key === null && listenerStorage !== null) on.value = loadLineNumbersOn(listenerStorage);
}

function defaultWin(): LineNumbersWindow | null {
  return typeof window === "undefined" ? null : window;
}

export interface LineNumbersPrefHandle {
  /** Current preference — shared by every preview window (drives the header toggle). */
  readonly on: Ref<boolean>;
  /** Apply + persist (the header toggle). Updates every mounted preview immediately. */
  setOn(next: boolean): void;
}

export function useLineNumbersPref(opts: {
  storage: LineNumbersStorage;
  /** Defaults to the real `window` when present; `null` disables cross-tab sync (tests). */
  win?: LineNumbersWindow | null;
}): LineNumbersPrefHandle {
  on.value = loadLineNumbersOn(opts.storage);
  const win = opts.win === undefined ? defaultWin() : opts.win;
  if (win !== null && listenerWin === null) {
    listenerWin = win;
    listenerStorage = opts.storage;
    win.addEventListener("storage", onStorageEvent); // page-lifetime listener (SPA, never removed)
  }
  return {
    on,
    setOn(next) {
      on.value = next;
      setLineNumbersPref(opts.storage, next);
    },
  };
}

/** Test hook: drop the shared source back to the default (on) and detach the cross-tab
 *  listener (module state is shared across tests in one worker — same shape as
 *  `resetPlaintextWarningForTests`). */
export function resetLineNumbersPrefForTests(): void {
  on.value = true;
  if (listenerWin !== null) {
    listenerWin.removeEventListener("storage", onStorageEvent);
    listenerWin = null;
    listenerStorage = null;
  }
}
