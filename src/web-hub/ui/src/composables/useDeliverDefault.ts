/**
 * Default delivery-mode preference for the control composer (`"steer"` | `"followUp"`).
 * A strict mirror of `useFontScale.ts`'s persistence discipline: the value lives under the
 * `pwh_deliver` storage key, the storage global is injected by the caller (Composer /
 * SettingsView pass `shell/themeStorage.ts`'s `browserLocalStorage()`), so this file never
 * names the storage global and stays clean under `source-scan.test.ts`'s storage-identifier
 * rule without needing a path exemption.
 *
 * Semantics (user-decided 2026-10: the per-message DeliverSwitch dropdown moved off the
 * composer into the settings page): while an agent is busy, Enter/send delivers with this
 * stored default; desktop Alt+Enter still flips per message to `"followUp"`
 * (`@logic/control.js`'s `composerKeyAction`, unchanged).
 *
 * A stored value that is missing or not exactly `"steer"`/`"followUp"` fails open to
 * `"steer"` — same fail-open philosophy as `theme-init.js` / `useFontScale.ts`.
 */
import { ref, type Ref } from "vue";

export const DELIVER_STORAGE_KEY = "pwh_deliver";

export type DeliverDefault = "steer" | "followUp";

export const DELIVER_FALLBACK: DeliverDefault = "steer";

export interface DeliverStorage {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
}

/** Read the persisted preference; anything but the two exact tokens falls back to "steer". */
export function loadDeliverDefault(storage: DeliverStorage): DeliverDefault {
  let raw: string | null = null;
  try {
    raw = storage.getItem(DELIVER_STORAGE_KEY);
  } catch {
    /* storage disabled/unavailable — same fail-open-to-default behavior as useFontScale */
  }
  return raw === "steer" || raw === "followUp" ? raw : DELIVER_FALLBACK;
}

export interface DeliverDefaultHandle {
  /** Current default — always one of the two exact tokens. */
  readonly deliver: Ref<DeliverDefault>;
  /** Apply + persist (the settings page's delivery radio group). */
  setDeliver(next: DeliverDefault): void;
}

export function useDeliverDefault(opts: { storage: DeliverStorage }): DeliverDefaultHandle {
  const deliver = ref(loadDeliverDefault(opts.storage)) as Ref<DeliverDefault>;
  return {
    deliver,
    setDeliver(next) {
      deliver.value = next;
      try {
        opts.storage.setItem(DELIVER_STORAGE_KEY, next);
      } catch {
        /* storage disabled/unavailable — the in-memory preference still applies for this load */
      }
    },
  };
}
