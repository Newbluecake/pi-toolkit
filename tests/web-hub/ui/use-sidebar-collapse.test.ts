/**
 * `useSidebarCollapse` (2026-10-13): the sidebar rail state lifted out of AgentList so
 * DashboardView's `layoutStyle` can arbitrate rail-vs-dragged width on the single
 * `--sidebar-w` custom property. Pins: storage load shapes, best-effort persistence, the
 * unchanged storage key (users keep their pre-refactor collapse).
 */
import { describe, expect, it } from "vitest";
import { nextTick } from "vue";
import {
  loadSidebarCollapsed,
  SIDEBAR_COLLAPSE_STORAGE_KEY,
  useSidebarCollapse,
  type SidebarCollapseStorage,
} from "../../../src/web-hub/ui/src/composables/useSidebarCollapse.js";

function memStorage(initial?: Record<string, string>): SidebarCollapseStorage & { map: Map<string, string> } {
  const map = new Map(Object.entries(initial ?? {}));
  return {
    map,
    getItem: (k) => map.get(k) ?? null,
    setItem: (k, v) => void map.set(k, v),
  };
}

describe("useSidebarCollapse", () => {
  it("keeps the legacy storage key (a pre-refactor collapse carries over)", () => {
    expect(SIDEBAR_COLLAPSE_STORAGE_KEY).toBe("webhub.agentList.collapsed");
    expect(loadSidebarCollapsed(memStorage({ "webhub.agentList.collapsed": "1" }))).toBe(true);
  });

  it("loads expanded on anything but the literal '1' (absent / '0' / garbage)", () => {
    expect(loadSidebarCollapsed(memStorage())).toBe(false);
    expect(loadSidebarCollapsed(memStorage({ [SIDEBAR_COLLAPSE_STORAGE_KEY]: "0" }))).toBe(false);
    expect(loadSidebarCollapsed(memStorage({ [SIDEBAR_COLLAPSE_STORAGE_KEY]: "yes" }))).toBe(false);
  });

  it("a throwing storage fails open to expanded", () => {
    const throwing: SidebarCollapseStorage = {
      getItem: () => {
        throw new Error("denied");
      },
      setItem: () => {
        throw new Error("denied");
      },
    };
    expect(loadSidebarCollapsed(throwing)).toBe(false);
    const c = useSidebarCollapse({ storage: throwing });
    c.toggle(); // must not throw
    expect(c.collapsed.value).toBe(true);
  });

  it("set/toggle persist through the injected storage", async () => {
    const s = memStorage();
    const c = useSidebarCollapse({ storage: s });
    expect(c.collapsed.value).toBe(false);
    c.toggle();
    await nextTick();
    expect(s.map.get(SIDEBAR_COLLAPSE_STORAGE_KEY)).toBe("1");
    c.set(false);
    await nextTick();
    expect(c.collapsed.value).toBe(false);
    expect(s.map.get(SIDEBAR_COLLAPSE_STORAGE_KEY)).toBe("0");
  });
});
