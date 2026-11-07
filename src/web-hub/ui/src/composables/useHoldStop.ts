import { computed, inject, onScopeDispose, ref, watch, type ComputedRef, type InjectionKey } from "vue";

/** Current-turn stop only. Composer owns dispatch/singleflight across ring/fallback remounts;
 * this controller owns one 700ms gesture. No transport, global ticker or shared mutable state. */
export const HOLD_STOP_MS = 700;
export interface HoldStopHost {
  readonly scope: ComputedRef<string | null>;
  readonly eligible: ComputedRef<boolean>;
  readonly abortPending: ComputedRef<boolean>;
}
export const HOLD_STOP_HOST: InjectionKey<HoldStopHost> = Symbol("web-hub-hold-stop");

export function useHoldStop(busy: () => boolean, emitStop: () => void) {
  const host = inject(HOLD_STOP_HOST, null);
  const holding = ref(false);
  const pointerActive = ref(false);
  const confirming = ref(false);
  const cancelled = ref(false);
  const hint = ref(false);
  const key = ref<string | null>(null);
  const pending = computed(() => host?.abortPending.value === true);
  const enabled = computed(() => busy() && (host === null || (host.eligible.value && !pending.value)));
  const scope = computed(() => host?.scope.value ?? "standalone");
  let generation = 0;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let feedbackTimer: ReturnType<typeof setTimeout> | undefined;
  let pointer: { id: number; type: string; x: number; y: number; target: HTMLElement; fired: boolean } | null = null;
  let origin: HTMLElement | null = null;
  let intentScope: string | null = null;

  function clearFeedback(): void {
    if (feedbackTimer !== undefined) clearTimeout(feedbackTimer);
    feedbackTimer = undefined;
    cancelled.value = false;
    hint.value = false;
  }
  function cancel(feedback: "cancelled" | "hint" | "none" = "cancelled"): void {
    const active = holding.value || confirming.value || key.value !== null;
    generation++;
    if (timer !== undefined) clearTimeout(timer);
    timer = undefined;
    pointer = null;
    pointerActive.value = false;
    key.value = null;
    holding.value = false;
    confirming.value = false;
    clearFeedback();
    if (active && feedback !== "none") {
      cancelled.value = feedback === "cancelled";
      hint.value = feedback === "hint";
      feedbackTimer = setTimeout(clearFeedback, 1500);
    }
  }

  function sameIntent(): boolean {
    return enabled.value && intentScope === scope.value;
  }

  function onPointerdown(ev: PointerEvent): void {
    // A second finger never takes over OR cancels the primary gesture.
    if (!enabled.value || pointer !== null || !ev.isPrimary || ev.button !== 0) return;
    if (!(ev.currentTarget instanceof HTMLElement)) return;
    cancel("none");
    origin = ev.currentTarget;
    intentScope = scope.value;
    const token = generation;
    pointer = { id: ev.pointerId, type: ev.pointerType, x: ev.clientX, y: ev.clientY, target: origin, fired: false };
    cancelled.value = false;
    pointerActive.value = true;
    holding.value = true;
    timer = setTimeout(() => {
      timer = undefined;
      if (token !== generation || pointer === null || pointer.fired || !sameIntent()) return;
      // Latch BEFORE the synchronous emit (which can publish host pending / unmount us).
      pointer.fired = true;
      holding.value = false;
      emitStop();
    }, HOLD_STOP_MS);
  }

  function onPointermove(ev: PointerEvent): void {
    if (pointer === null || pointer.id !== ev.pointerId || pointer.fired) return;
    const r = pointer.target.getBoundingClientRect();
    if (
      ev.clientX < r.left ||
      ev.clientX > r.right ||
      ev.clientY < r.top ||
      ev.clientY > r.bottom ||
      (pointer.type === "touch" && Math.hypot(ev.clientX - pointer.x, ev.clientY - pointer.y) > 8)
    )
      cancel();
  }

  function onPointerup(ev: PointerEvent): void {
    if (pointer?.id === ev.pointerId) cancel("hint");
  }
  function onPointercancel(ev: PointerEvent): void {
    if (pointer?.id === ev.pointerId) cancel();
  }
  function onPointerleave(ev: PointerEvent): void {
    // Touch capture may suppress leave: window pointermove also checks bounds.
    if (pointer?.id === ev.pointerId && !pointer.fired) cancel();
  }
  function onContextmenu(ev: MouseEvent): void {
    ev.preventDefault();
    // Mobile menus can arrive at ~500ms. Cancelling touch here would make 700ms unreachable.
    if (pointer !== null && pointer.type !== "touch") cancel();
  }

  function openConfirm(ev?: Event): void {
    if (!enabled.value || pointer !== null || confirming.value) return;
    if (ev?.currentTarget instanceof HTMLElement) origin = ev.currentTarget;
    intentScope = scope.value;
    clearFeedback();
    confirming.value = true;
  }
  function onClick(ev: MouseEvent): void {
    ev.preventDefault();
    const source = ev as MouseEvent & { pointerType?: string; sourceCapabilities?: { firesTouchEvents?: boolean } };
    if (ev.detail !== 0 || source.pointerType || source.sourceCapabilities?.firesTouchEvents || pointer !== null)
      return;
    // keyup already opens the same group; its following synthetic click is idempotent.
    openConfirm(ev);
  }
  function onKeydown(ev: KeyboardEvent): void {
    if (ev.key === "Escape") {
      if (holding.value || confirming.value || key.value !== null) {
        ev.preventDefault();
        ev.stopPropagation();
        cancel();
      }
      return;
    }
    if (ev.key !== "Enter" && ev.key !== " ") return;
    ev.preventDefault();
    if (
      !enabled.value ||
      ev.repeat ||
      ev.isComposing ||
      ev.keyCode === 229 ||
      ev.altKey ||
      ev.ctrlKey ||
      ev.metaKey ||
      ev.shiftKey
    )
      return;
    key.value = ev.key;
    intentScope = scope.value;
    if (ev.currentTarget instanceof HTMLElement) origin = ev.currentTarget;
  }
  function onKeyup(ev: KeyboardEvent): void {
    if (ev.key !== "Enter" && ev.key !== " ") return;
    ev.preventDefault();
    const matching =
      key.value === ev.key && !ev.isComposing && !ev.altKey && !ev.ctrlKey && !ev.metaKey && !ev.shiftKey;
    key.value = null;
    if (matching && sameIntent()) openConfirm(ev);
  }
  function onBlur(): void {
    if (!confirming.value) cancel("none");
  }
  function restoreFocus(): void {
    if (enabled.value && intentScope === scope.value && origin?.isConnected) origin.focus();
  }
  function dismiss(): void {
    cancel("none");
    restoreFocus();
  }
  function confirm(): void {
    if (!confirming.value || !sameIntent()) {
      cancel();
      return;
    }
    confirming.value = false;
    emitStop();
    restoreFocus();
  }
  function onHidden(): void {
    if (document.hidden) cancel("none");
  }
  function onEscape(ev: KeyboardEvent): void {
    if (ev.key === "Escape") {
      ev.preventDefault();
      ev.stopPropagation();
      dismiss();
    }
  }

  const onScroll = () => cancel();
  const onWindowBlur = () => cancel("none");
  const active = computed(
    () => pointerActive.value || confirming.value || key.value !== null || cancelled.value || hint.value,
  );
  function ambient(add: boolean): void {
    if (add) {
      window.addEventListener("pointermove", onPointermove, true);
      window.addEventListener("pointerup", onPointerup, true);
      window.addEventListener("pointercancel", onPointercancel, true);
      window.addEventListener("scroll", onScroll, true);
      window.addEventListener("blur", onWindowBlur);
      document.addEventListener("visibilitychange", onHidden);
      document.addEventListener("keydown", onEscape, true);
    } else {
      window.removeEventListener("pointermove", onPointermove, true);
      window.removeEventListener("pointerup", onPointerup, true);
      window.removeEventListener("pointercancel", onPointercancel, true);
      window.removeEventListener("scroll", onScroll, true);
      window.removeEventListener("blur", onWindowBlur);
      document.removeEventListener("visibilitychange", onHidden);
      document.removeEventListener("keydown", onEscape, true);
    }
  }
  watch(active, (v) => ambient(v), { flush: "sync" });
  watch([enabled, scope, pending], () => cancel("none"), { flush: "sync" });
  onScopeDispose(() => {
    cancel("none");
    ambient(false);
  });

  return {
    holding,
    confirming,
    cancelled,
    hint,
    pending,
    enabled,
    cancel,
    confirm,
    dismiss,
    openConfirm,
    onPointerdown,
    onPointerleave,
    onPointercancel,
    onContextmenu,
    onClick,
    onKeydown,
    onKeyup,
    onBlur,
  };
}
