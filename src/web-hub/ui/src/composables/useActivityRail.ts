/** Click-driven activity drawer; the open state is persisted by its docked-mode owner. */
import { computed, onScopeDispose, ref, shallowRef, watch, type Ref } from "vue";
import type { FleetDrawerMode } from "../contracts.js";

export type ActivityPanel = "agent" | "bash";
export type ActivityOrigin = "pointer" | "keyboard" | "restore";

export function useActivityRail(options: {
  mode: Readonly<Ref<FleetDrawerMode>>;
  drawerOpen: Ref<boolean>;
  hasAgent: Readonly<Ref<boolean>>;
  hasBash: Readonly<Ref<boolean>>;
  deselectRun(): void;
}) {
  const panel = ref<ActivityPanel>(options.hasAgent.value ? "agent" : "bash");
  const trigger = shallowRef<HTMLElement | null>(null);
  const origin = ref<ActivityOrigin>("restore");
  const available = (kind: ActivityPanel) => (kind === "agent" ? options.hasAgent.value : options.hasBash.value);
  const open = computed(() => available(panel.value) && options.drawerOpen.value);
  function close() {
    options.drawerOpen.value = false;
    options.deselectRun();
  }
  function toggle(kind: ActivityPanel, via: "pointer" | "keyboard", el?: HTMLElement | null) {
    if (!available(kind)) return;
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
    if (available(panel.value)) return;
    options.deselectRun();
    panel.value = options.hasAgent.value ? "agent" : "bash";
  });
  onScopeDispose(() => options.deselectRun());
  return { panel, open, trigger, origin, close, toggle };
}
