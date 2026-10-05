<!--
  P4 takeover of the P0→P4 seam (vue-plan.md v2.1 §1.1/§3.2/§5.2); fleet-drawer plan v2
  §6.3 (F6) 把原来的 `FleetPanel.vue`(顶部浮层)换成 `FleetSummaryBar.vue`(常驻文档流的
  摘要行按钮,开合右侧抽屉 —— 树本体移进 `drawer/FleetDrawer.vue`)。`.detail-body` 的
  布局规则仍在 P3 的 `detail.css`,本组件只发 class。
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
      @load-older="emit('load-older')"
      @update:following="emit('update:following', $event)"
      @new-count="emit('new-count', $event)"
    />
  </div>
</template>
