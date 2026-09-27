<!--
  Detail pane header: back button (≤767 only), title, status pill, session info, context/cost
  metrics (ui-design.md §5.2, vue-plan.md v2.1 §3.2, §5.2 — P3 exclusive,
  `components/detail/**`).
-->
<script setup lang="ts">
import { computed } from "vue";
import AppIcon from "../../icons/AppIcon.vue";
import { agentVisualState } from "../../composables/visual-state.js";
import { useI18n } from "../../composables/useI18n.js";
import { formatUsd } from "../../format.js";
import type { DetailHeaderEmits, DetailHeaderProps } from "../../contracts.js";
import { cardOf, sessionOf, statusOf } from "./agentViews.js";
import ContextMeter from "./ContextMeter.vue";
import SessionInfo from "./SessionInfo.vue";
import StatusPill from "./StatusPill.vue";

const props = defineProps<DetailHeaderProps>();
const emit = defineEmits<DetailHeaderEmits>();
const { t } = useI18n();

const session = computed(() => sessionOf(props.agent));
const card = computed(() => cardOf(props.agent));
const status = computed(() => statusOf(props.agent));

const visual = computed(() => agentVisualState(props.agent));
const statusLabel = computed(() => t(`common.status.${visual.value}`));

const title = computed(() => {
  const name = session.value?.name;
  if (typeof name === "string" && name !== "") return name;
  const sessionId = session.value?.sessionId;
  return typeof sessionId === "string" && sessionId !== "" ? sessionId.slice(0, 8) : t("agents.noSessionName");
});

const contextUsage = computed(() => status.value?.contextUsage);
const contextMeterProps = computed(() => {
  const usage = contextUsage.value;
  return {
    percent: usage?.percent ?? null,
    ...(usage?.tokens !== undefined ? { tokens: usage.tokens } : {}),
    ...(usage?.contextWindow !== undefined ? { window: usage.contextWindow } : {}),
  };
});
const subCostLabel = computed(() => {
  const sub = status.value?.subagentCostUsd;
  return typeof sub === "number" && sub > 0 ? t("detail.subCost", { v: formatUsd(sub) }) : null;
});
</script>

<template>
  <header class="detail-head">
    <div class="detail-titlebar">
      <button
        v-if="narrow"
        class="btn btn-ghost detail-back"
        type="button"
        :aria-label="t('common.backToAgents')"
        @click="emit('back')"
      >
        <AppIcon name="chev-left" class="icon-lg" />
      </button>
      <h2 class="detail-title" id="detail-title">{{ title }}</h2>
      <StatusPill :state="visual" :label="statusLabel" />
    </div>

    <SessionInfo :session="session" :card="card" />

    <dl class="metrics">
      <div class="metric">
        <dt>{{ t("detail.contextLabel") }}</dt>
        <dd>
          <ContextMeter v-bind="contextMeterProps" />
        </dd>
      </div>
      <div class="metric">
        <dt>{{ t("detail.costLabel") }}</dt>
        <dd>
          {{ formatUsd(status?.costUsd) }}
          <span v-if="subCostLabel" class="aside">{{ subCostLabel }}</span>
        </dd>
      </div>
    </dl>
  </header>
</template>
