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
  - 2026-10-17 用户裁定:行内「⋯」Steer/Stop 面板整体移除(改为输入框 @mention 子 agent 做 steer、问主会话做 stop)。

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
import AppIcon from "../../icons/AppIcon.vue";
import { FLEET_STATE_ICON, fleetStateSpins } from "./state-icon.js";
import { typeBadge, shortModelLabel } from "@logic/fleetRow.js";
import { fleetActivity, isTerminalRow, FLEET_SELECT } from "./summary.js";

const props = withDefaults(defineProps<FleetTreeProps>(), { depth: 0 });
const { t } = useI18n();

// ---------------------------------------------------------------------------
// per-list fold("Show N Finished Runs")—— 每个实例只管自己这一层兄弟列表
// ---------------------------------------------------------------------------
const TERMINAL_FOLD_MAX = 3;
/** 2026-10-16 user ("agent 或 bash 很少就默认展开，不然显得空空的"): a level with at most this
 *  many finished siblings shows them all — the fold only kicks in for longer lists. */
const TERMINAL_FOLD_FEW = 5;
const expanded = ref(false);
const terminalCount = computed(() => props.nodes.filter((n) => isTerminalRow(n.row)).length);
const hiddenCount = computed(() =>
  expanded.value || terminalCount.value <= TERMINAL_FOLD_FEW ? 0 : terminalCount.value - TERMINAL_FOLD_MAX,
);
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

function rowOf(node: FleetTreeNode): FleetRowWire {
  return node.row as unknown as FleetRowWire;
}
function nameOf(row: FleetRowWire): string {
  return clip(String(row.label ?? row.type ?? row.runId), 60);
}
function typeOf(row: FleetRowWire): string {
  return typeof row.type === "string" && row.type !== "" ? row.type : "";
}
function badgeOf(row: FleetRowWire): { letter: string; tone: number } | null {
  const t = typeOf(row);
  return t === "" ? null : typeBadge(t);
}
function phaseOf(row: FleetRowWire): string {
  return String(row.phaseLabel ?? row.status ?? "");
}
/** Line-2 slot is always rendered: live activity, else (consult runs only — `row.consult`, never the
 *  `consult-` label prefix) a short consult note; any other row without activity shows the phase only. */
function activityOf(row: FleetRowWire): string {
  const act = fleetActivity(row);
  if (act !== "" || row.consult !== true) return act;
  if (row.status === "completed") return t("fleet.consultDone");
  if (row.status === "failed" || row.status === "timed_out" || row.status === "aborted")
    return t("fleet.consultIncomplete");
  return t("fleet.consultRunning");
}
function modelShortOf(row: FleetRowWire): string {
  const m = row.model;
  if (typeof m !== "string" || m === "") return "";
  const slash = m.lastIndexOf("/");
  return shortModelLabel(slash >= 0 ? m.slice(slash + 1) : m);
}
/** 2026-10-16 user 「provider 信息还是应该展示出来，按屏幕宽度压缩展示」: the `provider` half of
 *  `provider/id` (empty when the ref carries none). Rendered as its own muted span before the
 *  model so fleet.css can compress it per container width (full on wide rows, ellipsized on
 *  narrow ones) while the model id keeps priority; the full ref stays in the `title`. */
function modelProviderOf(row: FleetRowWire): string {
  const m = row.model;
  if (typeof m !== "string" || m === "") return "";
  const slash = m.lastIndexOf("/");
  return slash > 0 ? m.slice(0, slash) : "";
}
/** M-B2 (thinking-level visibility): the row's effective thinking level as a
 * small muted `·<level>` token next to the model. Empty string = unknown →
 * renders nothing (no dangling `·`). English token only (compact marker rule). */
function thinkingTokenOf(row: FleetRowWire): string {
  const t = row.thinking;
  return typeof t === "string" && t !== "" ? `·${t}` : "";
}
function modelBlockOf(row: FleetRowWire): boolean {
  return modelShortOf(row) !== "" || thinkingTokenOf(row) !== "";
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
</script>

<template>
  <ul class="tree" :aria-label="depth === 0 ? t('fleet.treeLabel') : undefined">
    <li v-for="node in visible" :key="String(rowOf(node).runId)">
      <details v-if="node.children.length > 0" :open="depth < 3">
        <summary class="run" :data-st="fleetRowVisualState(rowOf(node))" :data-hl="highlightOf(rowOf(node))">
          <span class="run-icon"
            ><AppIcon
              :name="FLEET_STATE_ICON[fleetRowVisualState(rowOf(node))]"
              :class="{ icon: true, spin: fleetStateSpins(fleetRowVisualState(rowOf(node))) }"
          /></span>
          <span
            v-if="badgeOf(rowOf(node))"
            class="run-type"
            role="img"
            translate="no"
            :data-tone="badgeOf(rowOf(node))!.tone"
            :title="typeOf(rowOf(node))"
            :aria-label="typeOf(rowOf(node))"
            >{{ badgeOf(rowOf(node))!.letter }}</span
          >
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
            <AppIcon name="chev-right" class="icon icon-sm chev" aria-hidden="true" />
          </span>
          <span class="run-activity"
            ><span class="phase">{{ phaseOf(rowOf(node)) }}</span> {{ activityOf(rowOf(node)) }}</span
          >
          <span v-if="modelBlockOf(rowOf(node))" class="run-model">
            <span
              v-if="modelProviderOf(rowOf(node))"
              class="model-provider"
              translate="no"
              :title="String(rowOf(node).model ?? '')"
              ><span class="model-provider-name">{{ modelProviderOf(rowOf(node)) }}</span
              >/</span
            >
            <span
              v-if="modelShortOf(rowOf(node))"
              class="model"
              translate="no"
              :title="String(rowOf(node).model ?? '')"
              >{{ modelShortOf(rowOf(node)) }}</span
            >
            <span v-if="thinkingTokenOf(rowOf(node))" class="model-thinking" translate="no">{{
              thinkingTokenOf(rowOf(node))
            }}</span>
          </span>
          <span class="run-time">{{ formatDuration(displayElapsedMs(rowOf(node))) }}</span>
          <span class="run-cost">{{ costLabelOf(rowOf(node)) }}</span>
        </summary>
        <FleetTree :nodes="node.children" :depth="depth + 1" :now="now" />
      </details>
      <div
        v-else
        class="run"
        :class="{ 'is-terminal': rowOf(node).terminal === true }"
        :data-st="fleetRowVisualState(rowOf(node))"
        :data-hl="highlightOf(rowOf(node))"
      >
        <span class="run-icon"
          ><AppIcon
            :name="FLEET_STATE_ICON[fleetRowVisualState(rowOf(node))]"
            :class="{ icon: true, spin: fleetStateSpins(fleetRowVisualState(rowOf(node))) }"
        /></span>
        <span
          v-if="badgeOf(rowOf(node))"
          class="run-type"
          role="img"
          translate="no"
          :data-tone="badgeOf(rowOf(node))!.tone"
          :title="typeOf(rowOf(node))"
          :aria-label="typeOf(rowOf(node))"
          >{{ badgeOf(rowOf(node))!.letter }}</span
        >
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
        </span>
        <span class="run-activity"
          ><span class="phase">{{ phaseOf(rowOf(node)) }}</span> {{ activityOf(rowOf(node)) }}</span
        >
        <span v-if="modelBlockOf(rowOf(node))" class="run-model">
          <span
            v-if="modelProviderOf(rowOf(node))"
            class="model-provider"
            translate="no"
            :title="String(rowOf(node).model ?? '')"
            ><span class="model-provider-name">{{ modelProviderOf(rowOf(node)) }}</span
            >/</span
          >
          <span
            v-if="modelShortOf(rowOf(node))"
            class="model"
            translate="no"
            :title="String(rowOf(node).model ?? '')"
            >{{ modelShortOf(rowOf(node)) }}</span
          >
          <span v-if="thinkingTokenOf(rowOf(node))" class="model-thinking" translate="no">{{
            thinkingTokenOf(rowOf(node))
          }}</span>
        </span>
        <span class="run-time">{{ formatDuration(displayElapsedMs(rowOf(node))) }}</span>
        <span class="run-cost">{{ costLabelOf(rowOf(node)) }}</span>
      </div>
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
