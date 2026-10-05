<!--
  Delivery-mode switch (control-plan.md v2.1 §7.4/§7.5 — C5). Shown by the composer only while
  the agent is busy: Steer = 插话当前轮 (default), Follow-up = 排到之后. 2026-10-05 (user field
  report): always a native `<select>` dropdown at every width — the ≥481px two-button radiogroup
  is retired (native select stays fully keyboard/touch accessible and costs the least header
  space; §7.5's "原生可达" rationale now applies everywhere).
-->
<script setup lang="ts">
import { computed } from "vue";
import { useI18n } from "../../composables/useI18n.js";
import AppIcon from "../../icons/AppIcon.vue";
import type { DeliverSwitchEmits, DeliverSwitchProps } from "../../contracts.js";

defineProps<DeliverSwitchProps>();
const emit = defineEmits<DeliverSwitchEmits>();
const { t } = useI18n();

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
  <span v-else class="deliver-wrap">
    <select
      class="deliver-select"
      name="deliver"
      :aria-label="t('control.deliverGroup')"
      :value="modelValue"
      @change="onSelect"
    >
      <option v-for="o in options" :key="o.value" :value="o.value">{{ o.label.value }}</option>
    </select>
    <AppIcon name="chev-down" class="icon-sm deliver-caret" />
  </span>
</template>
