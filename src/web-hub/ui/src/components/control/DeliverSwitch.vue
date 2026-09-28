<!--
  Delivery-mode switch (control-plan.md v2.1 §7.4/§7.5 — C5). Shown by the composer only while
  the agent is busy: a two-option `role="radiogroup"` (Steer = 插话当前轮, default; Follow-up =
  排到之后). On narrow/coarse layouts it collapses to a native `<select>` (§7.5: 原生可达).
-->
<script setup lang="ts">
import { computed } from "vue";
import { useI18n } from "../../composables/useI18n.js";
import { useMedia } from "../../composables/useMedia.js";
import type { DeliverSwitchEmits, DeliverSwitchProps } from "../../contracts.js";

const props = defineProps<DeliverSwitchProps>();
const emit = defineEmits<DeliverSwitchEmits>();
const { t } = useI18n();

// §7.5: ≤480px the radiogroup folds into a native select (same breakpoint as the dock's
// iconified Stop/Send row in control.css).
const narrow = useMedia(window, "(max-width: 480px)").matches;

const options = [
  { value: "steer", label: computed(() => t("control.deliverSteer")) },
  { value: "followUp", label: computed(() => t("control.deliverFollowUp")) },
] as const;

function onSelect(ev: Event): void {
  const value = (ev.target as HTMLSelectElement).value;
  if (value === "steer" || value === "followUp") emit("update:modelValue", value);
}
</script>

<template>
  <span v-if="!busy" class="deliver-idle">{{ t("control.idleHint") }}</span>
  <select
    v-else-if="narrow"
    class="deliver-switch deliver-select"
    name="deliver"
    :aria-label="t('control.deliverGroup')"
    :value="modelValue"
    @change="onSelect"
  >
    <option v-for="o in options" :key="o.value" :value="o.value">{{ o.label.value }}</option>
  </select>
  <span v-else class="deliver-switch" role="radiogroup" :aria-label="t('control.deliverGroup')">
    <button
      v-for="o in options"
      :key="o.value"
      type="button"
      role="radio"
      :aria-checked="modelValue === o.value"
      :class="{ active: modelValue === o.value }"
      @click="emit('update:modelValue', o.value)"
    >
      {{ o.label.value }}
    </button>
  </span>
</template>
