<!--
  Subagent tree panel (ui-design.md §5.3, vue-plan.md v2.1 §3.2/§5.2 — P4). A single native
  `<details>` (foldable, keyboard-accessible for free) whose `<summary>` always shows the live
  summary line (running count · total · cost) even while collapsed; the tree itself renders
  through `FleetNode.vue` off `buildFleetTree(fleetTree(rows))`. Renders nothing at all when
  `rows` is empty (ui-design.md §9: "无子agent — 不渲染子 agent 面板，不占位").

  Per-row fold state (open/closed `<details>`, "Show N Finished Runs" reveal) deliberately lives
  in the DOM / in `FleetNode.vue`'s own local `initialOpen`/`useFoldSiblings` state, not here —
  `DetailBody.vue` keys this whole component by the agent's key, so switching agents remounts it
  fresh (plan §3.3 "切 agent 时重置") with zero extra plumbing.
-->
<script setup lang="ts">
import { computed } from "vue";
import type { FleetPanelProps } from "../../contracts.js";
import "../../styles/fleet.css";
import { formatUsd } from "../../format.js";
import { useI18n } from "../../composables/useI18n.js";
import AppIcon from "../../icons/AppIcon.vue";
import FleetNode from "./FleetNode.vue";
import { buildFleetTree, flattenFleetTree, isTerminalRow } from "./tree.js";
import { useFoldSiblings } from "./use-fold-siblings.js";

const props = defineProps<FleetPanelProps>();
const { t } = useI18n();

const tree = computed(() => buildFleetTree(props.rows));
const flat = computed(() => flattenFleetTree(tree.value));
const runningCount = computed(() => flat.value.filter((n) => !isTerminalRow(n.row)).length);
const totalCount = computed(() => flat.value.length);
const totalCost = computed(() =>
  flat.value.reduce((sum, n) => {
    const c = (n.row as { costUsd?: unknown }).costUsd;
    return sum + (typeof c === "number" ? c : 0);
  }, 0),
);
const rootFold = useFoldSiblings(() => tree.value);
</script>

<template>
  <details v-if="totalCount > 0" class="fleet" :open="defaultOpen">
    <summary class="panel-head">
      <AppIcon name="chev-right" class="icon icon-sm chev" />
      <span class="panel-title">{{ t("fleet.panelTitle") }}</span>
      <span class="panel-stats">
        <span v-if="runningCount > 0" class="pill" data-st="running"
          ><span class="dot"></span>{{ t("fleet.running", { n: runningCount }) }}</span
        >
        <span class="num">{{ t("fleet.totalCost", { n: totalCount, cost: formatUsd(totalCost) }) }}</span>
      </span>
    </summary>
    <div class="tree-scroll">
      <ul class="tree" :aria-label="t('fleet.treeLabel')">
        <FleetNode
          v-for="node in rootFold.visible.value"
          :key="node.row.runId as string"
          :node="node"
          :depth="0"
          :now="now"
        />
      </ul>
      <button
        v-if="rootFold.hiddenCount.value > 0"
        class="btn btn-ghost run-more"
        type="button"
        @click="rootFold.reveal()"
      >
        {{ t("fleet.showFinished", { n: rootFold.hiddenCount.value }) }}
      </button>
    </div>
  </details>
</template>
