import { onUnmounted, ref, type Ref } from "vue";

/**
 * Two-step armed confirmation for settings actions (avatar removal / session revocation).
 * First trigger arms for armMs; second confirms; Esc and unmount disarm. Current-turn stop
 * moved to useHoldStop (#47); do not add hold behavior to these other confirmation actions.
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
