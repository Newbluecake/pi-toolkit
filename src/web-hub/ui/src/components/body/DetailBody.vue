<!--
  P4 takeover of the P0→P4 seam (vue-plan.md v2.1 §1.1/§3.2/§5.2); fleet-drawer plan v2
  §6.3 (F6) 把原来的 `FleetPanel.vue`(顶部浮层)换成 `FleetSummaryBar.vue`,2026-10 用户
  现场要求再把它从常驻文档流的全宽行改成悬浮竖排 tab —— 不占文档流(transcript 吃回整行
  高度),定位/逐档决策见 fleet.css 的 `.fleet-summary-bar` 块;开合右侧抽屉 —— 树本体在
  `drawer/FleetDrawer.vue`。`.detail-body` 的布局规则仍在 P3 的 `detail.css`(本组件的根
  也是那个 relative 锚点),本组件只发 class。向主会话 Transcript 传
  `:memory-key="agent.key"`(session-switch plan §1.4 E1-6 的滚动记忆 opt-in)。
-->
<script setup lang="ts">
import { computed, inject, provide, watch } from "vue";
import type { FleetRowWire } from "@protocol/messages.js";
import type { DetailBodyEmits, DetailBodyProps } from "../../contracts.js";
import FleetSummaryBar from "../fleet/FleetSummaryBar.vue";
import Transcript from "../transcript/Transcript.vue";
import { bashJobsOf } from "../detail/bashJobsView.js";
import { HUB_CTX } from "../control/controlContext.js";
import {
  acceptXsStatus,
  narrowXsRequests,
  xsEntryIndex,
  xsMentionSeeds,
  xsRemoteRows,
  xsRequestRows,
  XS_RX_PROGRESS,
} from "@logic/xsRequestState.js";

const props = defineProps<DetailBodyProps>();
const emit = defineEmits<DetailBodyEmits>();

// 2026-10-15 bash→fleet 迁移:入口按钮的 bash 小计/可见性输入(已 narrowed,零行/缺失 ⇒
// undefined);agent 计数不混入 bash。
const bashJobs = computed(() => bashJobsOf(props.agent));

// fabric-xs-activation plan §3 P4: the received-card badge index. Cap-gated (no `xs.state.v1`
// ⇒ an EMPTY map — TxCustom then renders no badge DOM at all, byte-identical) and
// session-matched ("错 session 丢弃"): the entryId match is the only attachment key.
const hub = inject(HUB_CTX, null);
const xsSnapshot = computed(() => {
  const hubCaps = (hub?.state.value.hub as { caps?: unknown } | null | undefined)?.caps;
  const snapshot = narrowXsRequests(props.agent.status, hubCaps);
  const sid = (props.agent.session as { sessionId?: unknown } | undefined)?.sessionId;
  if (snapshot === undefined || typeof sid !== "string" || snapshot.sessionId !== sid) return undefined;
  return { snapshot, sessionId: sid };
});
/** Root fix #4: fold into the SAME persistent store the dock uses — a stale frame arriving
 *  after a newer one cannot regress the stored row (and both consumers stay consistent). */
watch(
  xsSnapshot,
  (v) => {
    if (v !== undefined) acceptXsStatus(props.agent.key, v.sessionId, v.snapshot);
  },
  { immediate: true },
);
const xsBadgeIndex = computed(() => {
  // Root fix #6: same display gate — no `xs.state.v1` on the current hub frame ⇒ no badge DOM.
  const hubCaps = (hub?.state.value.hub as { caps?: unknown } | null | undefined)?.caps;
  const v = xsSnapshot.value;
  if (v === undefined || !Array.isArray(hubCaps) || !hubCaps.includes("xs.state.v1")) {
    return new Map<string, never>();
  }
  return xsEntryIndex(
    xsRequestRows(xsMentionSeeds(props.agent.key, v.sessionId), xsRemoteRows(props.agent.key, v.sessionId)),
  );
});
provide(XS_RX_PROGRESS, { rows: xsBadgeIndex });
</script>

<template>
  <div class="detail-body">
    <FleetSummaryBar
      :rows="agent.fleet as unknown as readonly FleetRowWire[]"
      :open="drawerOpen ?? false"
      :bash-jobs="bashJobs"
      @toggle="emit('toggle-drawer')"
    />
    <Transcript
      :key="agent.key"
      :agent="agent"
      :following="following"
      :narrow="narrow"
      :memory-key="agent.key"
      @load-older="emit('load-older')"
      @update:following="emit('update:following', $event)"
      @new-count="emit('new-count', $event)"
    />
  </div>
</template>
