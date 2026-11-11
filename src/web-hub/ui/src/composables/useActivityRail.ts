/** Click-driven activity drawer; the open state is persisted by its docked-mode owner. */
import { computed, onScopeDispose, ref, shallowRef, watch, type Ref } from "vue";
import type { FleetDrawerMode } from "../contracts.js";

export type ActivityPanel = "agent" | "bash";
export type ActivityOrigin = "pointer" | "keyboard" | "restore";

const PANEL_KEY = "webhub.fleetDrawer.panel";

function readPanel(): ActivityPanel | null {
  try {
    const stored = window.localStorage.getItem(PANEL_KEY);
    return stored === "agent" || stored === "bash" ? stored : null;
  } catch {
    return null;
  }
}

function savePanel(panel: ActivityPanel): void {
  try {
    window.localStorage.setItem(PANEL_KEY, panel);
  } catch {
    // Storage may be disabled; the rail remains usable in memory.
  }
}

export function useActivityRail(options: {
  mode: Readonly<Ref<FleetDrawerMode>>;
  drawerOpen: Ref<boolean>;
  hasAgent: Readonly<Ref<boolean>>;
  hasBash: Readonly<Ref<boolean>>;
  deselectRun(): void;
}) {
  const available = (kind: ActivityPanel) => (kind === "agent" ? options.hasAgent.value : options.hasBash.value);
  // Frames can arrive after the detail mounts. Until the saved panel becomes available,
  // show the original default without overwriting the saved user preference.
  let pendingRestore = readPanel();
  const panel = ref<ActivityPanel>(
    pendingRestore !== null && available(pendingRestore) ? pendingRestore : options.hasAgent.value ? "agent" : "bash",
  );
  if (pendingRestore === panel.value && available(panel.value)) pendingRestore = null;
  const trigger = shallowRef<HTMLElement | null>(null);
  const origin = ref<ActivityOrigin>("restore");
  const open = computed(() => available(panel.value) && options.drawerOpen.value);
  function cancelRestore() {
    pendingRestore = null;
  }
  function close() {
    cancelRestore();
    options.drawerOpen.value = false;
    options.deselectRun();
  }
  function toggle(kind: ActivityPanel, via: "pointer" | "keyboard", el?: HTMLElement | null) {
    if (!available(kind)) return;
    cancelRestore();
    savePanel(kind);
    if (el) trigger.value = el;
    if (options.drawerOpen.value && panel.value === kind) {
      close();
      return;
    }
    if (kind === "bash") options.deselectRun();
    panel.value = kind;
    origin.value = via;
    options.drawerOpen.value = true;
  }
  watch(options.mode, (mode) => {
    origin.value = "restore";
    if (mode !== "docked") options.deselectRun();
  });
  watch([options.hasAgent, options.hasBash], () => {
    if (pendingRestore !== null && available(pendingRestore)) {
      if (pendingRestore === "bash" && panel.value !== "bash") options.deselectRun();
      panel.value = pendingRestore;
      pendingRestore = null;
      return;
    }
    if (available(panel.value)) return;
    options.deselectRun();
    panel.value = options.hasAgent.value ? "agent" : "bash";
  });
  onScopeDispose(() => options.deselectRun());
  return { panel, open, trigger, origin, close, toggle, cancelRestore };
}
