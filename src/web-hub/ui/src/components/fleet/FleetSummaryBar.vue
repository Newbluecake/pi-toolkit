<!-- #41/#42 supersede the 2026-10-15 merged badge: independent agent/bash counts.
     Both buttons remain usable while docked; AgentDetail owns the common split anchor. -->
<script setup lang="ts">
import { computed } from "vue";
import type { FleetSummaryBarEmits, FleetSummaryBarProps } from "../../contracts.js";
import "../../styles/fleet.css";
import { formatUsd } from "../../format.js";
import { useI18n } from "../../composables/useI18n.js";
import AppIcon from "../../icons/AppIcon.vue";
import { fleetSummary } from "./summary.js";
import { summaryCounts } from "../detail/bashJobsView.js";

const props = defineProps<FleetSummaryBarProps>();
const emit = defineEmits<FleetSummaryBarEmits>();
const { t } = useI18n();
const summary = computed(() => fleetSummary(props.rows));
const omittedActive = computed(() => {
  const n = props.omitted?.active;
  return typeof n === "number" && n > 0 ? n : 0;
});
const omittedTerminal = computed(() => {
  const n = props.omitted?.terminal;
  return typeof n === "number" && n > 0 ? n : 0;
});
const hasOmitted = computed(() => omittedActive.value > 0 || omittedTerminal.value > 0);
const hasAgent = computed(() => summary.value.total > 0 || hasOmitted.value);
const buttons = computed(() => {
  const bash = props.bashJobs === undefined ? null : summaryCounts(props.bashJobs);
  const agentLabel = [
    t("fleet.panelTitle"),
    t("fleet.running", { n: summary.value.running }),
    t(hasOmitted.value ? "fleet.listedCost" : "fleet.totalCost", {
      n: summary.value.total,
      cost: formatUsd(summary.value.costUsd),
    }),
  ];
  if (omittedActive.value > 0) agentLabel.push(t("fleet.omittedActive", { n: omittedActive.value }));
  if (omittedTerminal.value > 0) agentLabel.push(t("fleet.omittedTerminal", { n: omittedTerminal.value }));
  return [
    {
      kind: "agent" as const,
      icon: "bot" as const,
      running: summary.value.running,
      available: hasAgent.value,
      label: agentLabel.join(" · "),
    },
    {
      kind: "bash" as const,
      icon: "terminal" as const,
      running: bash?.running ?? 0,
      available: bash !== null && bash.running + bash.done + bash.failed > 0,
      label: [
        t("fleet.commandsTitle"),
        t("fleet.running", { n: bash?.running ?? 0 }),
        t("detail.bashJobsDone", { n: (bash?.done ?? 0) + (bash?.failed ?? 0) }),
      ].join(" · "),
    },
  ].filter((b) => b.available);
});
function toggle(kind: "agent" | "bash", event: MouseEvent): void {
  emit("toggle-panel", kind, event.detail === 0 ? "keyboard" : "pointer", event.currentTarget as HTMLElement);
  // Retain the legacy no-argument event; production only listens to toggle-panel.
  emit("toggle");
}
</script>

<template>
  <div v-if="buttons.length > 0" class="activity-rail" role="group" :aria-label="t('fleet.activityTitle')">
    <button
      v-for="button in buttons"
      :key="button.kind"
      class="fleet-summary-bar"
      type="button"
      :data-panel="button.kind"
      :data-active="button.running > 0 || undefined"
      aria-controls="fleet-drawer"
      :aria-expanded="open && (panel ?? (hasAgent ? 'agent' : 'bash')) === button.kind"
      :aria-label="button.label"
      @click="toggle(button.kind, $event)"
    >
      <AppIcon :name="button.icon" class="icon fab-icon" />
      <span v-if="button.running > 0" class="pill fab-count" data-st="running">
        <span class="num">{{ button.running > 99 ? "99+" : button.running }}</span>
      </span>
    </button>
  </div>
</template>
