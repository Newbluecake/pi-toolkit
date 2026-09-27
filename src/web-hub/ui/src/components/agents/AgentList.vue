<!--
  Agent sidebar / list (ui-design.md §5, §5.1, §6.1, vue-plan.md v2.1 §3.2, §5.2 — P3
  exclusive, `components/agents/**`). Owns the filter textbox and the live/"stale & offline"
  grouping (ui-design §5.1) over the already-derived `AgentCardView[]` its parent
  (`DashboardView.vue`) computes once per agent via `agentCardModel.ts`.
-->
<script setup lang="ts">
import { computed } from "vue";
import AppIcon from "../../icons/AppIcon.vue";
import { useI18n } from "../../composables/useI18n.js";
import type { AgentListEmits, AgentListProps } from "../../contracts.js";
import EmptyState from "../shell/EmptyState.vue";
import AgentCard from "./AgentCard.vue";

const props = defineProps<AgentListProps>();
const emit = defineEmits<AgentListEmits>();
const { t } = useI18n();

const filtered = computed(() => {
  const needle = props.filter.trim().toLowerCase();
  if (needle === "") return props.cards;
  return props.cards.filter((c) => `${c.shortCwd} ${c.sessionLabel}`.toLowerCase().includes(needle));
});
const live = computed(() => filtered.value.filter((c) => !c.stale && !c.down));
const staleOrDown = computed(() => filtered.value.filter((c) => c.stale || c.down));

function onFilterInput(ev: Event): void {
  emit("update:filter", (ev.target as HTMLInputElement).value);
}
</script>

<template>
  <nav class="sidebar" aria-label="Agents">
    <div class="sidebar-head">
      <h2 class="sidebar-title">
        {{ t("agents.title") }} <span class="count num">{{ cards.length }}</span>
      </h2>
      <div class="search">
        <AppIcon name="search" />
        <input
          class="input"
          type="search"
          name="agent-filter"
          :placeholder="t('agents.filterPlaceholder')"
          :aria-label="t('agents.filterAria')"
          autocomplete="off"
          spellcheck="false"
          :value="filter"
          @input="onFilterInput"
        />
      </div>
    </div>

    <EmptyState
      v-if="cards.length === 0"
      icon="terminal"
      :title="t('agents.emptyTitle')"
      :body="`${t('agents.emptyBodyLead')} webHub.enabled ${t('agents.emptyBodyTail')}`"
    />
    <ul v-else class="agent-list">
      <li v-for="card in live" :key="card.key">
        <AgentCard :card="card" :selected="card.key === selectedKey" />
      </li>
      <li v-if="staleOrDown.length > 0" class="agent-group">{{ t("agents.staleOffline") }}</li>
      <li v-for="card in staleOrDown" :key="card.key">
        <AgentCard :card="card" :selected="card.key === selectedKey" />
      </li>
    </ul>
  </nav>
</template>
