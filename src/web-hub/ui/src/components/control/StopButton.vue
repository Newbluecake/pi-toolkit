<!-- Current-turn stop, provider-absent fallback. Primary pointer holds 700ms; short clicks
     never arm. Keyboard/AT use explicit confirmation. Shared host pending comes from Composer,
     not this surface, so remounting a fallback cannot bypass an in-flight abort. -->
<script setup lang="ts">
import { useId } from "vue";
import { useHoldStop } from "../../composables/useHoldStop.js";
import { useI18n } from "../../composables/useI18n.js";
import type { StopButtonEmits, StopButtonProps } from "../../contracts.js";
import AppIcon from "../../icons/AppIcon.vue";
import StopConfirm from "./StopConfirm.vue";

const props = defineProps<StopButtonProps>();
const emit = defineEmits<StopButtonEmits>();
const { t } = useI18n();
const helpId = useId();
const stop = useHoldStop(
  () => props.busy,
  () => emit("stop"),
);
</script>

<template>
  <span v-if="busy" class="stop-wrap">
    <button
      class="btn stop-btn stop-hold-target"
      :class="{ holding: stop.holding.value }"
      type="button"
      :disabled="!stop.enabled.value"
      :data-holding="stop.holding.value || undefined"
      :aria-label="t('control.stopAria')"
      :aria-describedby="helpId"
      @pointerdown="stop.onPointerdown"
      @pointerleave="stop.onPointerleave"
      @lostpointercapture="stop.onPointercancel"
      @contextmenu="stop.onContextmenu"
      @mousedown.prevent
      @click="stop.onClick"
      @keydown="stop.onKeydown"
      @keyup="stop.onKeyup"
      @blur="stop.onBlur"
    >
      <AppIcon name="stop" class="icon" />
      <span class="stop-hold-progress" aria-hidden="true"></span>
    </button>
    <StopConfirm
      :help-id="helpId"
      :holding="stop.holding.value"
      :confirming="stop.confirming.value"
      :cancelled="stop.cancelled.value"
      :hint="stop.hint.value"
      :pending="stop.pending.value"
      :enabled="stop.enabled.value"
      :queue-count="queueCount ?? 0"
      @confirm="stop.confirm"
      @cancel="stop.dismiss"
      @alternative="stop.openConfirm"
    />
  </span>
</template>
