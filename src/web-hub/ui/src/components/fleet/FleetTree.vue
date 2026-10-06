<!--
  fleet 抽屉里的子 agent 树(fleet-drawer plan v2 §6.3 — F6)。吸收并替换被删除的
  `FleetPanel.vue`(浮层机制)/`FleetNode.vue`(行渲染)/`fleet/tree.ts`(纯折叠,现居
  `summary.ts`):一个自递归组件,每个实例负责一层兄弟列表 —— 「Show N Finished Runs」的
  展开状态因此天然按层隔离(原 FleetNode 的 per-instance fold,语义不变),深度 ≥3 的子树
  默认折叠的规则也不变(以本层 depth 判定)。

  与旧实现的差异(全部来自 §6.3 迁移表):
  - run 名在入口开放时(`FLEET_SELECT.canOpen`,即 card.runTranscript、LAN 下还要看
    runTranscriptLan)包一层 `<button class="run-open">`,`@click.stop.prevent` 调
    `FLEET_SELECT.select(runId)` —— 否则会顺带折叠父 `<details>`;不开放时保持纯文本。
  - 孤儿行(父 run 不在投影行内、被 `fleetTree` 提升为根)带「父 run 未列出」chip
    (`orphans` 集合由 FleetDrawer 用 `orphanRunIds(rows)` 算好传下来,只在根层级判定)。
  - 根层级底部渲染「另有 N 个运行中/已结束未列出」(fleet 帧 `omitted`,§3.2/#12)。
  - 「⋯」行内 Steer/Stop(CONTROL_CTX → FleetActions)原样保留。

  非终态行的 elapsed 在 fleet 帧之间随共享 `now` 本地走时:旧实现靠 FleetNode 实例(keyed
  by runId)持有 per-row baseline;这里每行不再是独立组件,baseline 改由本组件内一个以
  runId 为键的 Map 持有 —— 行对象的 `elapsedMs` 变化(新帧)时重置基线,行集合收缩时 pruning,
  行为与旧实现对齐(旧的 fleet.test.ts 用时钟用例钉过,新的 fleet-tree.test.ts 同样钉)。
-->
<script setup lang="ts">
import { computed, inject, ref, watch } from "vue";
import type { FleetRowWire } from "@protocol/messages.js";
import type { FleetTreeProps } from "../../contracts.js";
import type { FleetTreeNode } from "../../types.js";
import "../../styles/fleet.css";
import { formatDuration, formatUsd, clip } from "../../format.js";
import { fleetRowVisualState } from "../../composables/visual-state.js";
import { useI18n } from "../../composables/useI18n.js";
import { CONTROL_CTX } from "../../composables/useControl.js";
import AppIcon from "../../icons/AppIcon.vue";
import FleetActions from "./FleetActions.vue";
import { FLEET_STATE_ICON, fleetStateSpins } from "./state-icon.js";
import { fleetActivity, isTerminalRow, FLEET_SELECT } from "./summary.js";

const props = withDefaults(defineProps<FleetTreeProps>(), { depth: 0 });
const { t } = useI18n();

// ---------------------------------------------------------------------------
// per-list fold("Show N Finished Runs")—— 每个实例只管自己这一层兄弟列表
// ---------------------------------------------------------------------------
const TERMINAL_FOLD_MAX = 3;
const expanded = ref(false);
const terminalCount = computed(() => props.nodes.filter((n) => isTerminalRow(n.row)).length);
const hiddenCount = computed(() => (expanded.value ? 0 : Math.max(0, terminalCount.value - TERMINAL_FOLD_MAX)));
const visible = computed<readonly FleetTreeNode[]>(() => {
  if (expanded.value || hiddenCount.value === 0) return props.nodes;
  let seenTerminal = 0;
  return props.nodes.filter((n) => {
    if (!isTerminalRow(n.row)) return true;
    seenTerminal++;
    return seenTerminal <= TERMINAL_FOLD_MAX;
  });
});

// ---------------------------------------------------------------------------
// per-row elapsed 走时(baseline Map,见文件头注释)
// ---------------------------------------------------------------------------
const tickBaselines = new Map<string, { elapsedMs: number; at: number }>();
watch(
  () => props.nodes,
  (nodes) => {
    const alive = new Set<string>();
    const sync = (list: readonly FleetTreeNode[]): void => {
      for (const n of list) {
        const row = n.row as unknown as FleetRowWire;
        const runId = String(row.runId);
        alive.add(runId);
        const b = tickBaselines.get(runId);
        const elapsed = typeof row.elapsedMs === "number" ? row.elapsedMs : 0;
        if (b === undefined || b.elapsedMs !== elapsed) tickBaselines.set(runId, { elapsedMs: elapsed, at: props.now });
        sync(n.children);
      }
    };
    sync(nodes);
    for (const key of [...tickBaselines.keys()]) if (!alive.has(key)) tickBaselines.delete(key);
  },
  { immediate: true },
);

function displayElapsedMs(row: FleetRowWire): number {
  const elapsed = typeof row.elapsedMs === "number" ? row.elapsedMs : 0;
  if (row.terminal === true) return elapsed;
  const b = tickBaselines.get(String(row.runId)) ?? { elapsedMs: elapsed, at: props.now };
  return b.elapsedMs + Math.max(0, props.now - b.at);
}

// ---------------------------------------------------------------------------
// row 渲染辅助(原 FleetNode 的 computed,按行调用)
// ---------------------------------------------------------------------------
const sel = inject(FLEET_SELECT, null);
const controlCtx = inject(CONTROL_CTX, null);

function rowOf(node: FleetTreeNode): FleetRowWire {
  return node.row as unknown as FleetRowWire;
}
function nameOf(row: FleetRowWire): string {
  return clip(String(row.label ?? row.type ?? row.runId), 60);
}
function typeChipOf(row: FleetRowWire): string {
  return typeof row.type === "string" && row.type !== "" ? row.type : "";
}
function phaseOf(row: FleetRowWire): string {
  return String(row.phaseLabel ?? row.status ?? "");
}
function modelShortOf(row: FleetRowWire): string {
  const m = row.model;
  if (typeof m !== "string" || m === "") return "";
  const slash = m.lastIndexOf("/");
  return slash >= 0 ? m.slice(slash + 1) : m;
}
function costLabelOf(row: FleetRowWire): string {
  return typeof row.costUsd === "number" ? formatUsd(row.costUsd) : "—";
}
function highlightOf(row: FleetRowWire): "warn" | "crit" | undefined {
  return row.highlight === "warn" || row.highlight === "crit" ? row.highlight : undefined;
}
function isOrphan(row: FleetRowWire): boolean {
  return props.orphans?.has(String(row.runId)) === true;
}
function actionsAvailable(row: FleetRowWire): boolean {
  return controlCtx !== null && controlCtx.enabled && row.terminal !== true;
}

// 「⋯」行内动作面板的展开状态:旧实现是 FleetNode 实例上的一个 ref(每行一份)。这里每行共享
// 本实例,用一个 openRunId 保持「同时至多展开一行」(旧行为下行间互不影响,但同一时刻展开
// 多行没有实际用途;单开语义更简单,而且行 keyed by runId,切换行自动收起旧面板)。
const actionsOpenRunId = ref<string | null>(null);
function toggleActions(runId: string): void {
  actionsOpenRunId.value = actionsOpenRunId.value === runId ? null : runId;
}
</script>

<template>
  <ul class="tree" :aria-label="depth === 0 ? t('fleet.treeLabel') : undefined">
    <li v-for="node in visible" :key="String(rowOf(node).runId)">
      <details v-if="node.children.length > 0" :open="depth < 3">
        <summary class="run" :data-st="fleetRowVisualState(rowOf(node))" :data-hl="highlightOf(rowOf(node))">
          <AppIcon name="chev-right" class="icon icon-sm chev" />
          <span class="run-icon"
            ><AppIcon
              :name="FLEET_STATE_ICON[fleetRowVisualState(rowOf(node))]"
              :class="{ icon: true, spin: fleetStateSpins(fleetRowVisualState(rowOf(node))) }"
          /></span>
          <span class="run-name">
            <button
              v-if="sel?.canOpen.value"
              class="run-open"
              type="button"
              @click.stop.prevent="sel!.select(String(rowOf(node).runId))"
            >
              <b translate="no">{{ nameOf(rowOf(node)) }}</b>
            </button>
            <b v-else translate="no">{{ nameOf(rowOf(node)) }}</b>
            <span v-if="isOrphan(rowOf(node))" class="chip chip-orphan">{{ t("drawer.parentMissing") }}</span>
            <span v-if="typeChipOf(rowOf(node))" class="chip" translate="no" :title="typeChipOf(rowOf(node))">{{
              typeChipOf(rowOf(node))
            }}</span>
          </span>
          <span v-if="fleetActivity(rowOf(node))" class="run-activity"
            ><span class="phase">{{ phaseOf(rowOf(node)) }}</span> {{ fleetActivity(rowOf(node)) }}</span
          >
          <span class="run-nums">
            <span
              v-if="modelShortOf(rowOf(node))"
              class="model"
              translate="no"
              :title="String(rowOf(node).model ?? '')"
              >{{ modelShortOf(rowOf(node)) }}</span
            >
            <span class="time">{{ formatDuration(displayElapsedMs(rowOf(node))) }}</span>
            <span class="cost">{{ costLabelOf(rowOf(node)) }}</span>
          </span>
          <button
            v-if="actionsAvailable(rowOf(node))"
            class="btn btn-ghost btn-xs run-actions-toggle"
            type="button"
            :aria-expanded="actionsOpenRunId === String(rowOf(node).runId)"
            :aria-label="t('control.fleetActionsAria')"
            @click.stop.prevent="toggleActions(String(rowOf(node).runId))"
          >
            &#x2026;
          </button>
        </summary>
        <FleetActions
          v-if="actionsOpenRunId === String(rowOf(node).runId) && actionsAvailable(rowOf(node))"
          :agent-key="controlCtx!.agentKey"
          :run-id="String(rowOf(node).runId)"
          :enabled="true"
        />
        <FleetTree :nodes="node.children" :depth="depth + 1" :now="now" />
      </details>
      <div
        v-else
        class="run"
        :class="{ 'is-terminal': rowOf(node).terminal === true }"
        :data-st="fleetRowVisualState(rowOf(node))"
        :data-hl="highlightOf(rowOf(node))"
      >
        <span class="chev" aria-hidden="true"></span>
        <span class="run-icon"
          ><AppIcon
            :name="FLEET_STATE_ICON[fleetRowVisualState(rowOf(node))]"
            :class="{ icon: true, spin: fleetStateSpins(fleetRowVisualState(rowOf(node))) }"
        /></span>
        <span class="run-name">
          <button
            v-if="sel?.canOpen.value"
            class="run-open"
            type="button"
            @click.stop.prevent="sel!.select(String(rowOf(node).runId))"
          >
            <b translate="no">{{ nameOf(rowOf(node)) }}</b>
          </button>
          <b v-else translate="no">{{ nameOf(rowOf(node)) }}</b>
          <span v-if="isOrphan(rowOf(node))" class="chip chip-orphan">{{ t("drawer.parentMissing") }}</span>
          <span v-if="typeChipOf(rowOf(node))" class="chip" translate="no" :title="typeChipOf(rowOf(node))">{{
            typeChipOf(rowOf(node))
          }}</span>
        </span>
        <span v-if="fleetActivity(rowOf(node))" class="run-activity"
          ><span class="phase">{{ phaseOf(rowOf(node)) }}</span> {{ fleetActivity(rowOf(node)) }}</span
        >
        <span class="run-nums">
          <span
            v-if="modelShortOf(rowOf(node))"
            class="model"
            translate="no"
            :title="String(rowOf(node).model ?? '')"
            >{{ modelShortOf(rowOf(node)) }}</span
          >
          <span class="time">{{ formatDuration(displayElapsedMs(rowOf(node))) }}</span>
          <span class="cost">{{ costLabelOf(rowOf(node)) }}</span>
        </span>
        <button
          v-if="actionsAvailable(rowOf(node))"
          class="btn btn-ghost btn-xs run-actions-toggle"
          type="button"
          :aria-expanded="actionsOpenRunId === String(rowOf(node).runId)"
          :aria-label="t('control.fleetActionsAria')"
          @click="toggleActions(String(rowOf(node).runId))"
        >
          &#x2026;
        </button>
      </div>
      <FleetActions
        v-if="
          node.children.length === 0 && actionsOpenRunId === String(rowOf(node).runId) && actionsAvailable(rowOf(node))
        "
        :agent-key="controlCtx!.agentKey"
        :run-id="String(rowOf(node).runId)"
        :enabled="true"
      />
    </li>
  </ul>
  <button v-if="hiddenCount > 0" class="btn btn-ghost run-more" type="button" @click="expanded = true">
    {{ t("fleet.showFinished", { n: hiddenCount }) }}
  </button>
  <template v-if="depth === 0 && omitted">
    <p v-if="omitted.active > 0" class="fleet-omitted">{{ t("drawer.omittedActive", { n: omitted.active }) }}</p>
    <p v-if="omitted.terminal > 0" class="fleet-omitted">{{ t("drawer.omittedTerminal", { n: omitted.terminal }) }}</p>
  </template>
</template>
