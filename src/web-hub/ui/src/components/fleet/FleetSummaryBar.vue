<!--
  fleet 摘要入口(fleet-drawer plan v2 §6.3 — F6;2026-10 用户现场要求「整个子 Agent 这个
  点击按钮放到右侧居中的位置作为一个悬浮展开的按钮使用」):原常驻文档流的全宽摘要行改为
  悬浮竖排 tab —— 一个 `<button aria-controls="fleet-drawer" :aria-expanded>`,absolute 钉在
  `.detail-body`(detail.css 已 `position:relative`)右缘、垂直居中,点击开合右侧抽屉。
  DOM 类名 `.fleet-summary-bar` 保持不变(scripts/web-hub/visual/checks-body.ts 的
  checkFleetDrawerOpen 按 class + aria-expanded 断言;FleetDrawer 的外点豁免/焦点归还也按
  `[aria-controls="fleet-drawer"]` 找它)。docked 且抽屉已打开时仍由 CSS 整条隐藏
  (`.detail[data-drawer="docked"][data-drawer-open] .fleet-summary-bar`,drawer.css —— 沿用
  F6 契约:宽屏 docked 打开时抽屉本身就是常驻视图,× 关闭;悬浮按钮不抢这个位)。overlay/
  fullscreen 模式下抽屉(z-index 30/40)盖住按钮,抽屉自带关闭。没有子 agent 行时不渲染
  (沿用 ui-design.md §9「不占位」)。浮层机制(原 FleetPanel 的 document 监听 +
  `.tree-scroll` 绝对定位)已随 FleetPanel 一起删除;Esc/外点关闭契约移交给 FleetDrawer(§6.4)。

  2026-10-09 「这个单词竖过来感觉很怪」: 竖排面板名去掉,改为「‹ + bot 图标 + 计数徽标」——
  ‹ 指向抽屉滑出的方向(右侧),面板名只留在 aria-label 里。
  2026-10-09 「数字应该是进行中的 agent，不需要展示已经结束了的」: 徽标只数 running,没有
  进行中的子 agent 时不显示徽标(总数/成本仍在 aria-label 与抽屉里)。
  竖排 tab 的可见内容只有「图标 + 计数徽标」;聚合计数(running/总数/成本)全部
  收进 `aria-label`(不给 `title` —— ui-design §6.3「不依赖 hover」,visual 的
  shell-no-title-tooltips 在触屏档位断言全页无 [title])。
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

/** 可见面只留图标/标题/计数;running·总数·成本全量进 aria-label(桌面 hover 无 tooltip 依赖)。 */
const ariaLabel = computed(() => {
  const parts = [t("fleet.panelTitle")];
  if (summary.value.running > 0) parts.push(t("fleet.running", { n: summary.value.running }));
  parts.push(t("fleet.totalCost", { n: summary.value.total, cost: costLabel.value }));
  return parts.join(" · ");
});
</script>

<template>
  <button
    v-if="summary.total > 0"
    class="fleet-summary-bar"
    type="button"
    aria-controls="fleet-drawer"
    :aria-expanded="open"
    :aria-label="ariaLabel"
    @click="emit('toggle')"
  >
    <AppIcon name="chev-left" class="icon icon-sm chev" />
    <AppIcon name="bot" class="icon fab-icon" />
    <span v-if="summary.running > 0" class="pill fab-count" data-st="running">
      <span class="dot"></span>
      <span class="num">{{ summary.running }}</span>
    </span>
  </button>
</template>
