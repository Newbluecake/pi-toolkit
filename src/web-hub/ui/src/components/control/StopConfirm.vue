<!-- Current-turn stop's explicit keyboard/AT alternative. No native confirm or command routing.
     The cancel button receives focus; key repeat never confirms. Scope cancellation belongs
     to useHoldStop/Composer. Pointer holding never moves focus here. -->
<script setup lang="ts">
import { nextTick, ref } from "vue";
import { useI18n } from "../../composables/useI18n.js";
const props = defineProps<{
  confirming: boolean;
  holding: boolean;
  cancelled: boolean;
  hint: boolean;
  pending: boolean;
  enabled: boolean;
  queueCount: number;
  helpId: string;
}>();
const emit = defineEmits<{ confirm: []; cancel: []; alternative: [ev: Event] }>();
const { t } = useI18n();
const cancelButton = ref<HTMLButtonElement | null>(null);
// v-if remounts only the group, not this component: focus uses the template ref callback.
function focusCancel(el: unknown): void {
  if (el instanceof HTMLButtonElement && cancelButton.value !== el) {
    cancelButton.value = el;
    void nextTick(() => {
      if (props.confirming && el.isConnected && cancelButton.value === el) el.focus();
    });
  }
}
function onKeydown(ev: KeyboardEvent): void {
  if (ev.repeat) {
    ev.preventDefault();
    ev.stopPropagation();
  }
  if (ev.key === "Escape") {
    ev.preventDefault();
    ev.stopPropagation();
    emit("cancel");
  }
}
</script>
<template>
  <span :id="helpId" class="sr-only">{{ t("control.stopHelp") }}</span>
  <button class="stop-alternative" type="button" :disabled="!enabled" @click="emit('alternative', $event)">
    {{ t("control.stopAlternative") }}
  </button>
  <span class="stop-live sr-only" role="status" aria-live="polite">{{
    pending
      ? t("control.stopPending")
      : holding
        ? t("control.stopHolding")
        : cancelled
          ? t("control.stopCancelled")
          : hint
            ? t("control.stopHint")
            : ""
  }}</span>
  <span v-if="holding || pending || cancelled || hint" class="stop-hold-note" role="note">
    {{
      pending
        ? t("control.stopPending")
        : holding
          ? t("control.stopHolding")
          : cancelled
            ? t("control.stopCancelled")
            : t("control.stopHint")
    }}
    <span v-if="queueCount > 0" class="stop-queue-note">{{ t("control.stopQueueNote", { n: queueCount }) }}</span>
  </span>
  <div
    v-if="confirming"
    class="stop-confirm"
    role="group"
    :aria-label="t('control.stopConfirmTitle')"
    @keydown="onKeydown"
  >
    <span>{{ t("control.stopConfirmTitle") }}</span>
    <span v-if="queueCount > 0" class="stop-queue-note">{{ t("control.stopQueueNote", { n: queueCount }) }}</span>
    <span class="stop-confirm-actions">
      <button :ref="focusCancel" type="button" class="btn btn-ghost" @click="emit('cancel')">
        {{ t("dialog.cancel") }}
      </button>
      <button type="button" class="btn btn-danger" :disabled="!enabled" @click="emit('confirm')">
        {{ t("control.stopConfirm") }}
      </button>
    </span>
  </div>
</template>
