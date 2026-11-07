/** #41/#42: hover is ephemeral; only pinnedOpen belongs to the persisted drawer owner.
 * QuotaPill's hover/fine gating precedent, with the approved 120/280ms intent/grace windows.
 */
import { computed, onScopeDispose, ref, shallowRef, watch, type Ref } from "vue";
import type { FleetDrawerMode } from "../contracts.js";

export type ActivityPanel = "agent" | "bash";
export type ActivityOrigin = "hover" | "pointer" | "keyboard" | "restore" | "interaction";
export const ACTIVITY_ENTER_MS = 120;
export const ACTIVITY_LEAVE_MS = 280;

export function useActivityRail(options: {
  mode: Readonly<Ref<FleetDrawerMode>>;
  pinnedOpen: Ref<boolean>;
  hoverFine: Readonly<Ref<boolean>>;
  hasAgent: Readonly<Ref<boolean>>;
  hasBash: Readonly<Ref<boolean>>;
  deselectRun(): void;
}) {
  const selectedPanel = ref<ActivityPanel>(options.hasAgent.value ? "agent" : "bash");
  const peekPanel = ref<ActivityPanel | null>(null);
  const trigger = shallowRef<HTMLElement | null>(null);
  const origin = ref<ActivityOrigin>("restore");
  const layoutHeld = ref(false);
  let enterTimer: ReturnType<typeof setTimeout> | undefined;
  let leaveTimer: ReturnType<typeof setTimeout> | undefined;
  const available = (panel: ActivityPanel) => (panel === "agent" ? options.hasAgent.value : options.hasBash.value);
  const canPeek = computed(() => options.hoverFine.value && options.mode.value !== "fullscreen");
  const panel = computed(() =>
    options.pinnedOpen.value ? selectedPanel.value : (peekPanel.value ?? selectedPanel.value),
  );
  const open = computed(() => available(panel.value) && (options.pinnedOpen.value || peekPanel.value !== null));
  const peeking = computed(() => open.value && !options.pinnedOpen.value);
  const effectiveMode = computed(() => (peeking.value || layoutHeld.value ? ("overlay" as const) : options.mode.value));
  /** Task60 (compact-panel-plan §2.1): read-only view of the pointerdown-promoted hold.
   * Host/geometry decisions need to distinguish a HELD overlay (floating rail must survive
   * until the click lands) from a settled open; mutation stays owned by the guards below. */
  const held = computed(() => layoutHeld.value);
  // A pointerdown promotion must not move its target before click. Normal click capture
  // releases after the action; pointerup's *next task* is only a no-click fallback, never a
  // pointerup microtask. These guards exist only during this one gesture.
  function releaseInteraction() {
    layoutHeld.value = false;
  }
  watch(
    layoutHeld,
    (held, _old, cleanup) => {
      if (!held) return;
      let fallback: ReturnType<typeof setTimeout> | undefined;
      const afterUp = () => {
        if (fallback !== undefined) clearTimeout(fallback);
        fallback = setTimeout(releaseInteraction, 0);
      };
      document.addEventListener("pointerup", afterUp);
      document.addEventListener("pointercancel", releaseInteraction);
      window.addEventListener("blur", releaseInteraction);
      cleanup(() => {
        if (fallback !== undefined) clearTimeout(fallback);
        document.removeEventListener("pointerup", afterUp);
        document.removeEventListener("pointercancel", releaseInteraction);
        window.removeEventListener("blur", releaseInteraction);
      });
    },
    { flush: "sync" },
  );
  function cancelEnter() {
    if (enterTimer !== undefined) clearTimeout(enterTimer);
    enterTimer = undefined;
  }
  function keep() {
    if (leaveTimer !== undefined) clearTimeout(leaveTimer);
    leaveTimer = undefined;
  }
  function clearPeek() {
    cancelEnter();
    keep();
    peekPanel.value = null;
  }
  function close() {
    layoutHeld.value = false;
    clearPeek();
    options.pinnedOpen.value = false;
    options.deselectRun();
  }
  function enter(kind: ActivityPanel, event: PointerEvent) {
    if (!canPeek.value || event.pointerType === "touch" || options.pinnedOpen.value || !available(kind)) return;
    cancelEnter();
    keep();
    const el = event.currentTarget instanceof HTMLElement ? event.currentTarget : null;
    const show = () => {
      if (!available(kind)) return;
      trigger.value = el;
      origin.value = "hover";
      peekPanel.value = kind;
    };
    if (peekPanel.value !== null) show();
    else
      enterTimer = setTimeout(() => {
        enterTimer = undefined;
        show();
      }, ACTIVITY_ENTER_MS);
  }
  function leave() {
    cancelEnter();
    keep();
    if (!peeking.value) return;
    leaveTimer = setTimeout(() => {
      leaveTimer = undefined;
      peekPanel.value = null;
    }, ACTIVITY_LEAVE_MS);
  }
  function toggle(kind: ActivityPanel, via: "pointer" | "keyboard", el?: HTMLElement | null) {
    if (!available(kind)) return;
    if (el) trigger.value = el;
    if (options.pinnedOpen.value && selectedPanel.value === kind) {
      close();
      return;
    }
    layoutHeld.value = false;
    clearPeek();
    if (kind === "bash") options.deselectRun();
    selectedPanel.value = kind;
    origin.value = via;
    options.pinnedOpen.value = true;
  }
  function promote(holdLayout = false) {
    if (!peeking.value) return;
    const kind = panel.value;
    layoutHeld.value = holdLayout;
    clearPeek();
    selectedPanel.value = kind;
    origin.value = "interaction";
    options.pinnedOpen.value = true;
  }
  function togglePin() {
    if (!options.pinnedOpen.value) {
      promote();
      return;
    }
    const kind = selectedPanel.value;
    close();
    if (canPeek.value) {
      origin.value = "hover";
      peekPanel.value = kind;
    }
  }
  watch([options.mode, canPeek], () => {
    layoutHeld.value = false;
    clearPeek();
    origin.value = "restore";
  });
  watch(options.mode, (mode) => {
    if (mode !== "docked") options.deselectRun();
  });
  watch([options.hasAgent, options.hasBash], () => {
    if (available(panel.value)) return;
    layoutHeld.value = false;
    options.deselectRun();
    clearPeek();
    selectedPanel.value = options.hasAgent.value ? "agent" : "bash";
  });
  onScopeDispose(() => {
    layoutHeld.value = false;
    clearPeek();
    options.deselectRun();
  });
  return {
    releaseInteraction,
    panel,
    open,
    peeking,
    held,
    effectiveMode,
    trigger,
    origin,
    canPeek,
    enter,
    leave,
    keep,
    close,
    toggle,
    promote,
    togglePin,
  };
}
