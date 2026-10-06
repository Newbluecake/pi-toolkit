<!--
  Stop button with a two-step inline confirm (control-plan.md v2.1 §7.4 — C5): first click ARMS
  (danger colour, 4s auto-revert, Esc reverts, `aria-live` announcement — never a native
  `confirm()`, which is hostile on mobile and untestable), second click within the window emits
  `stop`. K12's conclusion is surfaced in the armed label: queued messages survive an abort
  (pi has no clearQueue extension surface), so the armed copy says so when `queueCount > 0`.
-->
<script setup lang="ts">
import { computed } from "vue";
import { useArmedConfirm } from "../../composables/useArmedConfirm.js";
import { useI18n } from "../../composables/useI18n.js";
import type { StopButtonEmits, StopButtonProps } from "../../contracts.js";
import AppIcon from "../../icons/AppIcon.vue";

const props = defineProps<StopButtonProps>();
const emit = defineEmits<StopButtonEmits>();
const { t } = useI18n();

// Two-step armed state machine — shared with ContextRing.vue's merged stop mode via
// `useArmedConfirm` (single source for the C5 grammar).
const { armed, trigger, onKeydown } = useArmedConfirm(() => emit("stop"));

function onClick(): void {
  if (!props.busy) return;
  trigger();
}

const label = computed(() => (armed.value ? t("control.stopConfirm") : t("control.stop")));
const queueNote = computed(() =>
  armed.value && (props.queueCount ?? 0) > 0 ? t("control.stopQueueNote", { n: props.queueCount ?? 0 }) : "",
);
</script>

<template>
  <span v-if="busy" class="stop-wrap">
    <button
      v-if="busy"
      class="btn stop-btn"
      :class="{ armed }"
      type="button"
      :data-armed="armed ? 'true' : undefined"
      :aria-label="t('control.stopAria')"
      @click="onClick"
      @keydown="onKeydown"
    >
      <AppIcon name="stop" class="icon" />
      <!-- 2026-10-05 user request: resting state is icon-only (the red square IS the affordance);
           the confirm copy still appears while armed (the two-step confirm's safety text). -->
      <span v-if="armed" class="lbl-md">{{ label }}</span>
    </button>
    <span v-if="armed" class="stop-live sr-only" role="status">{{ t("control.stopArmed") }}</span>
    <span v-if="queueNote" class="stop-queue-note">{{ queueNote }}</span>
  </span>
</template>
