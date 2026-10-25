/**
 * Session-list density preference (2026-10 user request 「会话列表压缩展示，就只展示目录，
 * 标题和别名」): `compact` (DEFAULT — directory + title + @alias only) or `detailed` (the
 * pre-feature card with cost / model / context meter / chips). Browser-local, global, in the
 * `pwh_*` family (see `useDetailHeadCollapse.ts`); the storage global is INJECTED by the
 * caller (`browserLocalStorage()`), so this file never names the storage identifier.
 *
 * Only the exact token `"detailed"` selects detailed; absent/junk ⇒ compact. The reactive
 * source is module scope on purpose: `AgentList` (toggle) and every `AgentCard` share one ref
 * without widening the frozen `AgentCardProps`.
 */
import { ref, type Ref } from "vue";

export const LIST_DENSITY_STORAGE_KEY = "pwh_list_density";

export type ListDensity = "compact" | "detailed";

export interface ListDensityStorage {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
}

export function parseListDensity(raw: string | null): ListDensity {
  return raw === "detailed" ? "detailed" : "compact";
}

const density = ref<ListDensity>("compact");
let loaded = false;

/** Shared read-only view for components that only render (AgentCard). */
export function useListDensityValue(): Readonly<Ref<ListDensity>> {
  return density;
}

export interface ListDensityHandle {
  readonly density: Ref<ListDensity>;
  setDensity(next: ListDensity): void;
  toggle(): void;
}

/** Loads the stored preference ONCE per page lifetime (later calls keep the shared ref, so a
 * remount can never clobber an in-memory choice whose write failed), then returns the handle. */
export function useListDensity(opts: { storage: ListDensityStorage }): ListDensityHandle {
  if (!loaded) {
    loaded = true;
    try {
      density.value = parseListDensity(opts.storage.getItem(LIST_DENSITY_STORAGE_KEY));
    } catch {
      density.value = "compact";
    }
  }
  const set = (next: ListDensity): void => {
    density.value = next;
    try {
      opts.storage.setItem(LIST_DENSITY_STORAGE_KEY, next);
    } catch {
      /* storage disabled — in-memory preference still applies */
    }
  };
  return {
    density,
    setDensity: set,
    toggle: () => set(density.value === "compact" ? "detailed" : "compact"),
  };
}

/** Test hook: back to the default. */
export function resetListDensityForTests(): void {
  density.value = "compact";
  loaded = false;
}
