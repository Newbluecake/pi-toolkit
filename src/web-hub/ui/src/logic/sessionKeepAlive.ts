/**
 * Session-subscription LRU keep-alive (web-hub-session-switch plan §1.2 D2, package D2).
 *
 * Two halves live here, both pi-free and DOM-free (storage injected by the caller, same
 * discipline as `logic/models.js`'s cache read/write — this file never names the storage
 * global, keeping `source-scan.test.ts`'s rule clean):
 *
 *  - the browser-local preference: how many sessions (INCLUDING the currently selected one)
 *    stay subscribed on the hub, `pwh_keepalive`, legal values 1..5 integers, product default
 *    3, anything else fails open to 3. NOT a pi-process setting (`config/setting-specs.ts`):
 *    the hub is one per machine serving many pi's, and the cache quota has nothing to do with
 *    which pi. `1` is the legacy single-slot behavior (the product's one-click rollback).
 *  - `planKeepAlive`: the pure planner `useHub` consults on every selection change. It never
 *    mutates its input and never talks to a transport — `useHub.ts` owns the effects.
 *
 * Library-level default note (plan D2-5): `useHub` itself defaults to K=1 when no
 * `keepAliveSessions` getter is supplied, so every existing use-hub test and embed keeps the
 * pre-D2 single-slot behavior; only `App.vue`'s wiring lifts the product default to 3.
 */

/** Browser-local storage key (siblings: `pwh_theme`, `pwh_fontscale`, `pwh_deliver`). */
export const KEEPALIVE_STORAGE_KEY = "pwh_keepalive";

/** Product default: 3 sessions kept subscribed (current + 2 background). */
export const KEEPALIVE_DEFAULT = 3;

export const KEEPALIVE_MIN = 1;
export const KEEPALIVE_MAX = 5;

/** The settings-page radio choices (any other in-range integer a hand-edited pref may hold is honored). */
export const KEEPALIVE_CHOICES = [1, 3, 5] as const;

/** Storage global injected by the caller (`shell/themeStorage.ts`'s `browserLocalStorage()`). */
export interface KeepAliveStorage {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
}

/**
 * Validate a raw stored value: an integer in [1,5] passes through (numeric strings included —
 * localStorage only stores strings), everything else (missing, non-numeric, 0, 6, 2.5 …)
 * falls back to the default 3. Deliberately NOT min/max clamping: a corrupted pref should not
 * silently become 5.
 */
export function clampKeepAlive(v: unknown): number {
  const n = typeof v === "number" ? v : typeof v === "string" && v.trim() !== "" ? Number(v) : Number.NaN;
  return Number.isInteger(n) && n >= KEEPALIVE_MIN && n <= KEEPALIVE_MAX ? n : KEEPALIVE_DEFAULT;
}

/** Read the preference; a throwing/unavailable storage fails open to the default. */
export function loadKeepAlive(storage: KeepAliveStorage): number {
  let raw: string | null = null;
  try {
    raw = storage.getItem(KEEPALIVE_STORAGE_KEY);
  } catch {
    return KEEPALIVE_DEFAULT;
  }
  return clampKeepAlive(raw);
}

/** Persist one of the legal values (the settings radio group). Write failures are ignored —
 * the in-memory preference still applies for this load (same fail-open shape as useDeliverDefault). */
export function setKeepAlivePref(storage: KeepAliveStorage, v: number): void {
  try {
    storage.setItem(KEEPALIVE_STORAGE_KEY, String(v));
  } catch {
    /* storage disabled/unavailable */
  }
}

export interface PlanKeepAliveInput {
  /** Current LRU order, MRU last (the useHub closure's `sessionLru`). Not mutated. */
  readonly lru: readonly string[];
  /** The newly selected key, or null (list view / mobile back). */
  readonly selected: string | null;
  /** The previously selected key (the one being switched away from), or null. */
  readonly old: string | null;
  /** K: max sessions kept subscribed, INCLUDING the selected one ⇒ at most cap-1 background. */
  readonly cap: number;
  /** Whether the key still exists in `raw.agents` (agent_removed / snapshot shrink). */
  readonly exists: (key: string) => boolean;
  /** Whether the agent's history is in the error state (D2-8: failed sessions never keep alive). */
  readonly failed: (key: string) => boolean;
}

export interface KeepAlivePlan {
  /** The committed LRU order for the next planning round (MRU last). */
  readonly lru: string[];
  /** Keys whose main subscription must be torn down now, oldest-first. */
  readonly evict: string[];
}

/**
 * Plan one selection change:
 *  ① drop keys that no longer exist (D2-11 — they never reach `evict`: the hub already cleared
 *     their subscriptions on `agent_removed`);
 *  ② a FAILED old session is evicted immediately regardless of quota (D2-8 — otherwise
 *     switching back lands in the manual-retry-only state, worse than the old behavior);
 *  ③ the selected key moves to the MRU tail (appended when absent);
 *  ④ while background keys exceed cap-1, evict from the LRU head. The selected key is never
 *     evictable (it sits at the tail; the loop stops defensively if it ever meets it).
 */
export function planKeepAlive(input: PlanKeepAliveInput): KeepAlivePlan {
  const evict: string[] = [];
  let lru = input.lru.filter((k) => input.exists(k)); // ①
  if (input.old !== null && input.old !== input.selected && input.exists(input.old) && input.failed(input.old)) {
    lru = lru.filter((k) => k !== input.old); // ②
    evict.push(input.old);
  }
  if (input.selected !== null && input.exists(input.selected)) {
    lru = [...lru.filter((k) => k !== input.selected), input.selected]; // ③
  }
  const maxBackground = Math.max(0, input.cap - 1);
  const selIn = input.selected !== null && lru.includes(input.selected);
  let overflow = lru.length - (selIn ? 1 : 0) - maxBackground;
  while (overflow > 0 && lru.length > 0) {
    const head = lru[0]!;
    if (head === input.selected) break; // never evict the selection (defensive: it is at the tail)
    lru = lru.slice(1);
    evict.push(head);
    overflow -= 1;
  }
  return { lru, evict };
}
