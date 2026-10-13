/**
 * Desktop sidebar collapse state (session-list rail) — the STATE half, lifted out of
 * `AgentList.vue` (2026-10-13, user report 「收起按钮只藏了内容，侧栏还占着原来的宽度」).
 *
 * Why lifted: the collapse rail and the draggable width (`useSidebarWidth.ts`) BOTH resolve
 * through the same `--sidebar-w` custom property on `.layout`'s grid. When the collapse wrote
 * its 56px inline on `<html>` while the resizer wrote the dragged width inline on `.layout`,
 * the element-level value shadowed the inherited one — collapsing with a previously dragged
 * width hid every sidebar child via `.is-collapsed` but kept the column at the dragged width
 * (a blank panel with a lone chevron). Owning the state in `DashboardView.vue` lets the
 * SINGLE `layoutStyle` computed arbitrate: collapsed ⇒ 56px wins; else dragged width; else
 * the stylesheet breakpoints.
 *
 * Storage is injected (never the `localStorage` identifier — the `source-scan.test.ts`
 * discipline every composable here follows); callers pass `shell/themeStorage.ts`'s
 * `browserLocalStorage()`. Persistence is best-effort and the storage key is unchanged, so a
 * collapse persisted by the old AgentList-owned implementation carries over.
 */
import { ref, watch, type Ref } from "vue";

/** Same key the AgentList-owned implementation used — existing users keep their state. */
export const SIDEBAR_COLLAPSE_STORAGE_KEY = "webhub.agentList.collapsed";

/** The collapsed rail width, applied as `--sidebar-w` on `.layout` while collapsed. */
export const SIDEBAR_RAIL_WIDTH = "56px";

export interface SidebarCollapseStorage {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
}

/** Read the persisted flag; anything but the literal "1" (errors included) means expanded. */
export function loadSidebarCollapsed(storage: SidebarCollapseStorage): boolean {
  try {
    return storage.getItem(SIDEBAR_COLLAPSE_STORAGE_KEY) === "1";
  } catch {
    return false;
  }
}

export interface SidebarCollapse {
  readonly collapsed: Ref<boolean>;
  /** Set + persist (best-effort). */
  set(next: boolean): void;
  toggle(): void;
}

export function useSidebarCollapse(opts: { readonly storage: SidebarCollapseStorage }): SidebarCollapse {
  const collapsed = ref(loadSidebarCollapsed(opts.storage));
  watch(collapsed, (v) => {
    try {
      opts.storage.setItem(SIDEBAR_COLLAPSE_STORAGE_KEY, v ? "1" : "0");
    } catch {
      /* storage disabled — the in-memory state still applies for this load */
    }
  });
  return {
    collapsed,
    set(next: boolean): void {
      collapsed.value = next;
    },
    toggle(): void {
      collapsed.value = !collapsed.value;
    },
  };
}
