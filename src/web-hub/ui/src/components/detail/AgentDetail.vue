<!--
  Detail pane orchestration: header, agent-level notices, history waiting/error/loaded
  branching, dock (ui-design.md §5, §9, vue-plan.md v2.1 §3.2, §5.2 — P3 exclusive,
  `components/detail/**`).

  `DetailBodyEmits` (frozen `contracts.ts`) has no "retry" event, while `AgentDetailEmits` does
  — the only reading of the two contracts together that makes both true: this component (which
  already receives the full `agent`, including `history`/`historyError`) decides whether
  `agent.history` is `"waiting"` (skeleton), `"error"` (inline error + a Retry button that
  dispatches `retry`) or otherwise (mount `<DetailBody>`, P4's seam, which only ever renders a
  *loaded* transcript). `<DetailBody>`'s own `following`/`new-count` contract drives
  `<DetailDock>`; "jump to latest" (`DetailDockEmits.jump`) is implemented as simply flipping
  `following` back to `true` — `useFollowScroll` (P1) already special-cases a `following`
  transition, so no separate "scroll now" channel is needed in the frozen contracts.
-->
<script setup lang="ts">
import { computed, ref, watch } from "vue";
import { useI18n } from "../../composables/useI18n.js";
import type { AgentDetailEmits, AgentDetailProps } from "../../contracts.js";
import type { Notice } from "../../types.js";
import { buildAgentNotices } from "./agentNotices.js";
import DetailBody from "../body/DetailBody.vue";
import DetailDock from "./DetailDock.vue";
import DetailHeader from "./DetailHeader.vue";
import NoticeBanner from "../shell/NoticeBanner.vue";

const RETRY_NOTICE_ID = "history-error";

const props = defineProps<AgentDetailProps>();
const emit = defineEmits<AgentDetailEmits>();
const { t } = useI18n();

const agentNotices = computed(() => buildAgentNotices(props.agent, t));
const historyErrorNotice = computed<Notice | null>(() => {
  if (props.agent.history !== "error") return null;
  return {
    id: RETRY_NOTICE_ID,
    tone: "danger",
    title: props.agent.historyError ?? t("notices.retryNow"),
    action: { label: t("notices.retryNow") },
    persistent: false,
  };
});
const notices = computed<readonly Notice[]>(() =>
  historyErrorNotice.value ? [...agentNotices.value, historyErrorNotice.value] : agentNotices.value,
);

function onNoticeAction(id: string): void {
  if (id === RETRY_NOTICE_ID) emit("retry");
}

const following = ref(true);
const newCount = ref(0);

// AgentDetail is remounted per agent by DashboardView's `:key="agent.key"`; reset defensively
// too, in case a future caller ever reuses one instance across agents.
watch(
  () => props.agent.key,
  () => {
    following.value = true;
    newCount.value = 0;
  },
);

function onUpdateFollowing(value: boolean): void {
  following.value = value;
  if (value) newCount.value = 0;
}

function onNewCount(n: number): void {
  newCount.value = n;
}

function onJump(): void {
  onUpdateFollowing(true);
}
</script>

<template>
  <main class="detail" aria-labelledby="detail-title">
    <DetailHeader :agent="agent" :narrow="narrow" @back="emit('back')" />

    <NoticeBanner v-for="notice in notices" :key="notice.id" :notice="notice" @action="onNoticeAction" />

    <div v-if="agent.history === 'waiting'" class="detail-body" aria-busy="true">
      <div class="skel-stack">
        <span class="skel skel-bubble"></span>
        <span class="skel skel-w90"></span><span class="skel skel-w80"></span><span class="skel skel-w60"></span>
      </div>
      <p class="sr-only" role="status">{{ t("detail.loadingHistory") }}</p>
    </div>

    <DetailBody
      v-else
      class="detail-body"
      :agent="agent"
      :now="now"
      :following="following"
      :narrow="narrow"
      @load-older="emit('load-older')"
      @update:following="onUpdateFollowing"
      @new-count="onNewCount"
    />

    <DetailDock :following="following" :new-count="newCount" @update:following="onUpdateFollowing" @jump="onJump" />
  </main>
</template>
