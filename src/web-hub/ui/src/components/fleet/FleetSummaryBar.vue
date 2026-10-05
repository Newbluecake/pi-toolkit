<!--
  fleet 摘要行(fleet-drawer plan v2 §6.3 — F6):原 `FleetPanel.vue` 的 `<summary>` 摘要行
  (running 数 · 总数 · 成本)的迁移动地 —— 常驻文档流的一行 `<button
  aria-controls="fleet-drawer" :aria-expanded>`,点击开合右侧抽屉。docked 且抽屉已打开时由
  CSS 整条隐藏(`.detail[data-drawer="docked"][data-drawer-open] .fleet-summary-bar`,
  drawer.css),其余模式下它就是抽屉的唯一入口。没有子 agent 行时不渲染(沿用 ui-design.md
  §9「不占位」)。浮层机制(原 FleetPanel 的 document 监听 + `.tree-scroll` 绝对定位)已随
  FleetPanel 一起删除;Esc/外点关闭契约移交给 FleetDrawer(§6.4)。
-->
<script setup lang="ts">
import { computed } from "vue";
import type { FleetSummaryBarEmits, FleetSummaryBarProps } from "../../contracts.js";
import "../../styles/fleet.css";
import { formatUsd } from "../../format.js";
import { useI18n } from "../../composables/useI18n.js";
import AppIcon from "../../icons/AppIcon.vue";
import { fleetSummary } from "./summary.js";

const props = defineProps<FleetSummaryBarProps>();
const emit = defineEmits<FleetSummaryBarEmits>();
const { t } = useI18n();

const summary = computed(() => fleetSummary(props.rows));
const costLabel = computed(() => formatUsd(summary.value.costUsd));
</script>

<template>
  <button
    v-if="summary.total > 0"
    class="fleet-summary-bar"
    type="button"
    aria-controls="fleet-drawer"
    :aria-expanded="open"
    @click="emit('toggle')"
  >
    <AppIcon name="chev-right" class="icon icon-sm chev" />
    <span class="panel-title">{{ t("fleet.panelTitle") }}</span>
    <span class="panel-stats">
      <span v-if="summary.running > 0" class="pill" data-st="running"
        ><span class="dot"></span>{{ t("fleet.running", { n: summary.running }) }}</span
      >
      <span class="num">{{ t("fleet.totalCost", { n: summary.total, cost: costLabel }) }}</span>
    </span>
  </button>
</template>
