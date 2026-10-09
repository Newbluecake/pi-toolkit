/**
 * Plaintext-HTTP warning visibility preference (2026-10 user opt-out). The web-hub UI shows
 * standing "your traffic is unencrypted" warnings in seven places (ControlNotice's plainHttp
 * body, AttachmentTray, WorktreeDiffDialog, PreviewHost, SpawnConfirm, HistoryForkConfirm,
 * LoginView) whenever the page is served as LAN password auth over plain `http:`. The user is
 * the sole LAN user behind password auth and has explicitly accepted the plaintext risk
 * (AGENTS.md web-hub U1 rulings), so this preference — `pwh_hide_plaintext_warn`, a pure
 * browser-local preference in the `pwh_theme` / `pwh_deliver` / `pwh_keepalive` family, NOT a
 * pi-process setting — hides those warnings per browser.
 *
 * Discipline (mirrors `useDeliverDefault.ts` / `@logic/sessionKeepAlive.ts`):
 * - the storage global is INJECTED by the caller (components pass `shell/themeStorage.ts`'s
 *   `browserLocalStorage()`), so this file never names the storage identifier and stays clean
 *   under `source-scan.test.ts`'s localStorage rule;
 * - anything but the exact token `"1"` — absent, `"0"`, junk — fails open to SHOWING the
 *   warnings, byte-identical to the pre-feature behavior when the pref is missing;
 * - hiding warnings changes NOTHING about security behavior (auth, LAN gating, preview/diff
 *   admission): it is warning-text visibility only.
 *
 * The reactive source is module scope, deliberately (same rationale as `useI18n.ts`'s
 * `override`): the UI bundle is one single-page app, and one shared ref is what makes the
 * settings toggle instantly re-render every warning in the tree without per-component wiring.
 * Every `usePlaintextWarning()` call re-reads the pref, so a component mounting later can
 * never pin a stale value; same-tab flips go through `setHidden` (shared ref + persist), and
 * OTHER tabs are picked up through the `storage` event.
 */
import { ref, type Ref } from "vue";

/** Browser-local storage key (siblings: `pwh_theme`, `pwh_fontscale`, `pwh_deliver`, `pwh_keepalive`). */
export const PLAINTEXT_WARN_STORAGE_KEY = "pwh_hide_plaintext_warn";

/** Storage global injected by the caller (same minimal face as `KeepAliveStorage`). */
export interface PlaintextWarnStorage {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
}

/** The slice of a `storage` event this module cares about (test-injectable). */
export interface PlaintextStorageEvent {
  readonly key: string | null;
  readonly newValue: string | null;
}

/** Minimal `window` face for the cross-tab storage-event sync (test-injectable). */
export interface PlaintextWarnWindow {
  addEventListener(type: "storage", listener: (ev: PlaintextStorageEvent) => void): void;
  removeEventListener(type: "storage", listener: (ev: PlaintextStorageEvent) => void): void;
}

/** Only the exact token `"1"` hides; absent/`"0"`/junk keeps the warnings visible. */
export function parsePlaintextHidden(raw: string | null): boolean {
  return raw === "1";
}

/** Read the preference; a throwing/unavailable storage fails open to "show the warnings". */
export function loadPlaintextHidden(storage: PlaintextWarnStorage): boolean {
  let raw: string | null = null;
  try {
    raw = storage.getItem(PLAINTEXT_WARN_STORAGE_KEY);
  } catch {
    return false;
  }
  return parsePlaintextHidden(raw);
}

/** Persist the preference (the settings card writes `"1"`/`"0"`). Write failures are ignored —
 * the in-memory preference still applies for this load (same fail-open shape as useDeliverDefault). */
export function setPlaintextHiddenPref(storage: PlaintextWarnStorage, hidden: boolean): void {
  try {
    storage.setItem(PLAINTEXT_WARN_STORAGE_KEY, hidden ? "1" : "0");
  } catch {
    /* storage disabled/unavailable */
  }
}

// --- shared reactive source (see the header: module scope is deliberate) ----------------------
const hidden = ref(false);
let listenerWin: PlaintextWarnWindow | null = null;
let listenerStorage: PlaintextWarnStorage | null = null;

function onStorageEvent(ev: PlaintextStorageEvent): void {
  if (ev.key === PLAINTEXT_WARN_STORAGE_KEY) {
    hidden.value = parsePlaintextHidden(ev.newValue);
    return;
  }
  // `key === null` means a storage.clear() in another tab — re-read the whole key.
  if (ev.key === null && listenerStorage !== null) hidden.value = loadPlaintextHidden(listenerStorage);
}

function defaultWin(): PlaintextWarnWindow | null {
  return typeof window === "undefined" ? null : window;
}

export interface PlaintextWarningHandle {
  /** Current preference — shared by every component (drives the settings radio rows). */
  readonly hidden: Ref<boolean>;
  /** Apply + persist (the settings card). Updates every mounted component immediately. */
  setHidden(next: boolean): void;
  /** Whether the plaintext warning line should render for the given transport flag. Read this
   * inside a `computed` so the shared ref's reactivity propagates (same-tab AND cross-tab). */
  warnVisible(isPlaintext: boolean): boolean;
}

export function usePlaintextWarning(opts: {
  storage: PlaintextWarnStorage;
  /** Defaults to the real `window` when present; `null` disables cross-tab sync (tests). */
  win?: PlaintextWarnWindow | null;
}): PlaintextWarningHandle {
  hidden.value = loadPlaintextHidden(opts.storage);
  const win = opts.win === undefined ? defaultWin() : opts.win;
  if (win !== null && listenerWin === null) {
    listenerWin = win;
    listenerStorage = opts.storage;
    win.addEventListener("storage", onStorageEvent); // page-lifetime listener (SPA, never removed)
  }
  return {
    hidden,
    setHidden(next) {
      hidden.value = next;
      setPlaintextHiddenPref(opts.storage, next);
    },
    warnVisible(isPlaintext: boolean): boolean {
      return isPlaintext && !hidden.value;
    },
  };
}

/** Test hook: drop the shared source back to "shown" and detach the cross-tab listener
 * (module state is shared across tests in one worker — same shape as `resetLangForTests`). */
export function resetPlaintextWarningForTests(): void {
  hidden.value = false;
  if (listenerWin !== null) {
    listenerWin.removeEventListener("storage", onStorageEvent);
    listenerWin = null;
    listenerStorage = null;
  }
}
