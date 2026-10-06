import { onUnmounted, ref, type Ref } from "vue";

/**
 * Two-step armed confirm (control-plan.md v2.1 §7.4 — C5 grammar), shared by
 * `control/StopButton.vue` and the composer's merged `ContextRing.vue` stop mode (2026-10
 * user request: the stop icon lives INSIDE the context ring): the first `trigger()` ARMS
 * (auto-revert after `armMs`, Esc disarms via `onKeydown` — never a native `confirm()`, which
 * is hostile on mobile and untestable), the second `trigger()` within the window fires
 * `onConfirm`. Both components keep their own labels/aria-live regions; only the arm/disarm
 * state machine lives here so the two surfaces can never drift apart.
 */
export function useArmedConfirm(
  onConfirm: () => void,
  armMs = 4000,
): {
  armed: Ref<boolean>;
  disarm: () => void;
  trigger: () => void;
  onKeydown: (ev: KeyboardEvent) => void;
} {
  const armed = ref(false);
  let armTimer: ReturnType<typeof setTimeout> | undefined;

  function disarm(): void {
    armed.value = false;
    if (armTimer !== undefined) {
      clearTimeout(armTimer);
      armTimer = undefined;
    }
  }

  function trigger(): void {
    if (!armed.value) {
      armed.value = true;
      armTimer = setTimeout(disarm, armMs);
      return;
    }
    disarm();
    onConfirm();
  }

  function onKeydown(ev: KeyboardEvent): void {
    if (ev.key === "Escape" && armed.value) {
      ev.stopPropagation();
      disarm();
    }
  }

  onUnmounted(disarm);

  return { armed, disarm, trigger, onKeydown };
}
