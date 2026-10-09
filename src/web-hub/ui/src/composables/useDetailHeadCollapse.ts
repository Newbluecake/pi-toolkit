/**
 * Detail-header info-block collapse preference (2026-10 user request 「红框部分支持收起，
 * 点击标题展开」): the block under the session-detail title — `SessionInfo`, `TodoPanel`,
 * `WorktreePanel`, `BashJobsPanel` — collapses behind the title itself, which becomes the
 * disclosure toggle. This is a pure browser-local UI preference in the `pwh_theme` /
 * `pwh_deliver` / `pwh_keepalive` / `pwh_hide_plaintext_warn` family — NOT a pi-process
 * setting — and it is global (not per session): one collapse state for every detail view.
 *
 * Discipline (mirrors `usePlaintextWarning.ts` / `useDeliverDefault.ts`):
 * - the storage global is INJECTED by the caller (`DetailHeader.vue` passes
 *   `shell/themeStorage.ts`'s `browserLocalStorage()`), so this file never names the storage
 *   identifier and stays clean under `source-scan.test.ts`'s localStorage rule;
 * - only the exact token `"1"` collapses; absent, `"0"`, junk — everything fails open to
 *   EXPANDED, byte-identical to the pre-feature header for anyone who never toggles;
 * - collapsing is presentation only: the inner panels keep their own expanded `<details>`
 *   state across collapse/expand (they are simply not rendered while collapsed).
 *
 * The reactive source is module scope, deliberately (same rationale as
 * `usePlaintextWarning.ts`): one shared ref makes every mounted DetailHeader flip in lockstep
 * (the dashboard keeps at most one detail view, but /reload-free remounts on session switch
 * share it too). Every `useDetailHeadCollapse()` call re-reads the pref, so a later mount can
 * never pin a stale value; same-tab flips go through `setCollapsed` (shared ref + persist),
 * and OTHER tabs are picked up through the `storage` event.
 */
import { ref, type Ref } from "vue";

/** Browser-local storage key (siblings: `pwh_theme`, `pwh_fontscale`, `pwh_deliver`, `pwh_keepalive`). */
export const DETAIL_HEAD_COLLAPSED_STORAGE_KEY = "pwh_detail_head_collapsed";

/** Storage global injected by the caller (same minimal face as `KeepAliveStorage`). */
export interface DetailHeadStorage {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
}

/** The slice of a `storage` event this module cares about (test-injectable). */
export interface DetailHeadStorageEvent {
  readonly key: string | null;
  readonly newValue: string | null;
}

/** Minimal `window` face for the cross-tab storage-event sync (test-injectable). */
export interface DetailHeadWindow {
  addEventListener(type: "storage", listener: (ev: DetailHeadStorageEvent) => void): void;
  removeEventListener(type: "storage", listener: (ev: DetailHeadStorageEvent) => void): void;
}

/** Only the exact token `"1"` collapses; absent/`"0"`/junk keeps the block expanded. */
export function parseDetailHeadCollapsed(raw: string | null): boolean {
  return raw === "1";
}

/** Read the preference; a throwing/unavailable storage fails open to "expanded". */
export function loadDetailHeadCollapsed(storage: DetailHeadStorage): boolean {
  let raw: string | null = null;
  try {
    raw = storage.getItem(DETAIL_HEAD_COLLAPSED_STORAGE_KEY);
  } catch {
    return false;
  }
  return parseDetailHeadCollapsed(raw);
}

/** Persist the preference (the title toggle writes `"1"`/`"0"`). Write failures are ignored —
 * the in-memory preference still applies for this load (same fail-open shape as useDeliverDefault). */
export function setDetailHeadCollapsedPref(storage: DetailHeadStorage, collapsed: boolean): void {
  try {
    storage.setItem(DETAIL_HEAD_COLLAPSED_STORAGE_KEY, collapsed ? "1" : "0");
  } catch {
    /* storage disabled/unavailable */
  }
}

// --- shared reactive source (see the header: module scope is deliberate) ----------------------
const collapsed = ref(false);
let listenerWin: DetailHeadWindow | null = null;
let listenerStorage: DetailHeadStorage | null = null;

function onStorageEvent(ev: DetailHeadStorageEvent): void {
  if (ev.key === DETAIL_HEAD_COLLAPSED_STORAGE_KEY) {
    collapsed.value = parseDetailHeadCollapsed(ev.newValue);
    return;
  }
  // `key === null` means a storage.clear() in another tab — re-read the whole key.
  if (ev.key === null && listenerStorage !== null) collapsed.value = loadDetailHeadCollapsed(listenerStorage);
}

function defaultWin(): DetailHeadWindow | null {
  return typeof window === "undefined" ? null : window;
}

export interface DetailHeadCollapseHandle {
  /** Current preference — shared by every mounted DetailHeader. */
  readonly collapsed: Ref<boolean>;
  /** Apply + persist (the title button). Updates every mounted header immediately. */
  setCollapsed(next: boolean): void;
  /** Flip + persist. */
  toggle(): void;
}

export function useDetailHeadCollapse(opts: {
  storage: DetailHeadStorage;
  /** Defaults to the real `window` when present; `null` disables cross-tab sync (tests). */
  win?: DetailHeadWindow | null;
}): DetailHeadCollapseHandle {
  collapsed.value = loadDetailHeadCollapsed(opts.storage);
  const win = opts.win === undefined ? defaultWin() : opts.win;
  if (win !== null && listenerWin === null) {
    listenerWin = win;
    listenerStorage = opts.storage;
    win.addEventListener("storage", onStorageEvent); // page-lifetime listener (SPA, never removed)
  }
  return {
    collapsed,
    setCollapsed(next) {
      collapsed.value = next;
      setDetailHeadCollapsedPref(opts.storage, next);
    },
    toggle() {
      collapsed.value = !collapsed.value;
      setDetailHeadCollapsedPref(opts.storage, collapsed.value);
    },
  };
}

/** Test hook: drop the shared source back to "expanded" and detach the cross-tab listener
 * (module state is shared across tests in one worker — same shape as `resetPlaintextWarningForTests`). */
export function resetDetailHeadCollapseForTests(): void {
  collapsed.value = false;
  if (listenerWin !== null) {
    listenerWin.removeEventListener("storage", onStorageEvent);
    listenerWin = null;
    listenerStorage = null;
  }
}
