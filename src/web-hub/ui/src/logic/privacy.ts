/**
 * Session privacy lock — browser-side pure half (web-hub-privacy plan v2.1, package P2).
 *
 * Only the browser-local idle-relock preference lives here: how many MINUTES of no interaction
 * (keyboard / pointer / touch / scroll, and only while the unlocked session is actually being
 * viewed) before an unlocked-view of a privacy-marked session relocks itself,
 * `pwh_privacy_timeout`, legal integer range 1–60, product default 10, anything else fails open
 * to the default. NOT a pi-process setting — same discipline as `sessionKeepAlive.ts`'s
 * `pwh_keepalive`: the hub is one per machine serving many browsers, and a viewing-comfort
 * timeout has nothing to do with which pi. Storage is injected by the caller
 * (`shell/themeStorage.ts`'s `browserLocalStorage()`), so this file never names the storage
 * global and `source-scan.test.ts`'s localStorage rule stays clean.
 *
 * The view-lock state machine itself (unlock memory / four relock paths / verify calls) is
 * `composables/usePrivacyLock.ts`; the wire semantics are P1's (`@protocol/privacy.ts`,
 * `transport/types.ts`'s `PrivacyTransport`).
 */

/** Browser-local storage key (siblings: `pwh_theme`, `pwh_keepalive`, `pwh_deliver`). */
export const PRIVACY_TIMEOUT_STORAGE_KEY = "pwh_privacy_timeout";

/** Product default: relock after 10 minutes without interaction (plan「客户端行为」). */
export const PRIVACY_TIMEOUT_DEFAULT_MIN = 10;

export const PRIVACY_TIMEOUT_MIN_MIN = 1;
export const PRIVACY_TIMEOUT_MAX_MIN = 60;

/** Storage global injected by the caller (mirrors `sessionKeepAlive.ts`'s KeepAliveStorage). */
export interface PrivacyPrefStorage {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
}

/**
 * Validate a raw stored value: an integer in [1,60] passes through (numeric strings included —
 * localStorage only stores strings), everything else falls back to the default 10. Deliberately
 * NOT min/max clamping (mirrors `clampKeepAlive`): a corrupted pref should not silently become
 * 60.
 */
export function clampPrivacyTimeoutMin(v: unknown): number {
  const n = typeof v === "number" ? v : typeof v === "string" && v.trim() !== "" ? Number(v) : Number.NaN;
  return Number.isInteger(n) && n >= PRIVACY_TIMEOUT_MIN_MIN && n <= PRIVACY_TIMEOUT_MAX_MIN
    ? n
    : PRIVACY_TIMEOUT_DEFAULT_MIN;
}

/** Read the preference; a throwing/unavailable storage fails open to the default. */
export function loadPrivacyTimeoutMin(storage: PrivacyPrefStorage): number {
  let raw: string | null = null;
  try {
    raw = storage.getItem(PRIVACY_TIMEOUT_STORAGE_KEY);
  } catch {
    return PRIVACY_TIMEOUT_DEFAULT_MIN;
  }
  return clampPrivacyTimeoutMin(raw);
}

/** Persist one of the legal values (the settings card). Write failures are ignored — the
 * in-memory value still applies for this load (same fail-open shape as `setKeepAlivePref`). */
export function setPrivacyTimeoutMin(storage: PrivacyPrefStorage, v: number): void {
  try {
    storage.setItem(PRIVACY_TIMEOUT_STORAGE_KEY, String(clampPrivacyTimeoutMin(v)));
  } catch {
    /* storage disabled/unavailable */
  }
}
