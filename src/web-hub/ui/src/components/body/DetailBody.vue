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
import type { FleetRowWire } from "@protocol/messages.js";
import type { DetailBodyEmits, DetailBodyProps } from "../../contracts.js";
import FleetSummaryBar from "../fleet/FleetSummaryBar.vue";
import Transcript from "../transcript/Transcript.vue";

const props = defineProps<DetailBodyProps>();
const emit = defineEmits<DetailBodyEmits>();
</script>

<template>
  <div class="detail-body">
    <FleetSummaryBar
      :rows="agent.fleet as unknown as readonly FleetRowWire[]"
      :open="drawerOpen ?? false"
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
