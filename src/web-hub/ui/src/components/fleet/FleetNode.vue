<!--
  A single subagent-tree row (ui-design.md §5.3, vue-plan.md v2.1 §3.2/§5.2 — P4). Recursive:
  renders itself as a `<details><summary class="run">…</summary><ul>…children…</ul></details>`
  when it has children (foldable via the native `<details>` element — no JS-owned open/closed
  map needed, see the file-level note in `FleetPanel.vue`), or a plain `<div class="run">` leaf
  otherwise. Depth ≥3 subtrees start collapsed (`initialOpen`); >3 terminal siblings in the same
  `<ul>` fold behind "Show N Finished Runs" (`useFoldSiblings`, applied to `node.children` here
  and to the root list in `FleetPanel.vue`).
-->
<script setup lang="ts">
import { computed, ref, watch } from "vue";
import type { FleetNodeProps } from "../../contracts.js";
import type { FleetRowWire } from "@protocol/messages.js";
import { formatDuration, formatUsd, clip } from "../../format.js";
import { fleetRowVisualState } from "../../composables/visual-state.js";
import { useI18n } from "../../composables/useI18n.js";
import AppIcon from "../../icons/AppIcon.vue";
import { FLEET_STATE_ICON, fleetStateSpins } from "./state-icon.js";
import { useFoldSiblings } from "./use-fold-siblings.js";

const props = defineProps<FleetNodeProps>();
const { t } = useI18n();

const row = computed(() => props.node.row as unknown as FleetRowWire);
const visualState = computed(() => fleetRowVisualState(row.value));
const icon = computed(() => FLEET_STATE_ICON[visualState.value]);
const spins = computed(() => fleetStateSpins(visualState.value));
const highlight = computed<"none" | "warn" | "crit">(() =>
  row.value.highlight === "warn" || row.value.highlight === "crit" ? row.value.highlight : "none",
);
const terminal = computed(() => row.value.terminal === true);
const name = computed(() => clip(String(row.value.label ?? row.value.type ?? row.value.runId), 60));
const typeChip = computed(() => (typeof row.value.type === "string" && row.value.type !== "" ? row.value.type : ""));
const phase = computed(() => String(row.value.phaseLabel ?? row.value.status ?? ""));
const activity = computed(() => {
  const streamLine = row.value.streamLine;
  const toolTrail = row.value.toolTrail;
  const raw = typeof streamLine === "string" && streamLine !== "" ? streamLine : toolTrail;
  return typeof raw === "string" && raw !== "" ? clip(raw, 160) : "";
});
const modelShort = computed(() => {
  const m = row.value.model;
  if (typeof m !== "string" || m === "") return "";
  const slash = m.lastIndexOf("/");
  return slash >= 0 ? m.slice(slash + 1) : m;
});
const costLabel = computed(() => (typeof row.value.costUsd === "number" ? formatUsd(row.value.costUsd) : "—"));

// §5.3 "实时进度": non-terminal elapsed ticks locally between `fleet` frames off the shared
// `now` clock, corrected the instant a fresh frame changes `elapsedMs`; terminal rows are frozen
// at their final value. This component instance is keyed by `runId` (see `FleetPanel.vue` /
// the recursive `v-for` below), so the baseline refs below persist for this row's whole lifetime
// — they are NOT re-initialized by ordinary re-renders (props changing), only by unmount/remount.
const baselineElapsed = ref(row.value.elapsedMs);
const baselineNow = ref(props.now);
watch(
  () => row.value.elapsedMs,
  (v) => {
    baselineElapsed.value = v;
    baselineNow.value = props.now;
  },
);
const displayElapsedMs = computed(() =>
  terminal.value ? row.value.elapsedMs : baselineElapsed.value + Math.max(0, props.now - baselineNow.value),
);
const elapsedLabel = computed(() => formatDuration(displayElapsedMs.value));

const hasChildren = computed(() => props.node.children.length > 0);
// ui-design.md §5.3: "有子节点的行可折叠（默认展开；深度 ≥3 默认折叠）"
const initialOpen = props.depth < 3;
const childrenFold = useFoldSiblings(() => props.node.children);
</script>

<template>
  <li>
    <details v-if="hasChildren" :open="initialOpen">
      <summary class="run" :data-st="visualState" :data-hl="highlight === 'none' ? undefined : highlight">
        <AppIcon name="chev-right" class="icon icon-sm chev" />
        <span class="run-icon"><AppIcon :name="icon" :class="{ icon: true, spin: spins }" /></span>
        <span class="run-name">
          <b translate="no">{{ name }}</b>
          <span v-if="typeChip" class="chip" translate="no">{{ typeChip }}</span>
        </span>
        <span v-if="activity" class="run-activity"
          ><span class="phase">{{ phase }}</span> {{ activity }}</span
        >
        <span class="run-nums">
          <span v-if="modelShort" class="model" translate="no">{{ modelShort }}</span>
          <span class="time">{{ elapsedLabel }}</span>
          <span class="cost">{{ costLabel }}</span>
        </span>
      </summary>
      <ul>
        <FleetNode
          v-for="child in childrenFold.visible.value"
          :key="child.row.runId as string"
          :node="child"
          :depth="depth + 1"
          :now="now"
        />
      </ul>
      <button
        v-if="childrenFold.hiddenCount.value > 0"
        class="btn btn-ghost run-more"
        type="button"
        @click="childrenFold.reveal()"
      >
        {{ t("fleet.showFinished", { n: childrenFold.hiddenCount.value }) }}
      </button>
    </details>
    <div
      v-else
      class="run"
      :class="{ 'is-terminal': terminal }"
      :data-st="visualState"
      :data-hl="highlight === 'none' ? undefined : highlight"
    >
      <span class="chev" aria-hidden="true"></span>
      <span class="run-icon"><AppIcon :name="icon" :class="{ icon: true, spin: spins }" /></span>
      <span class="run-name">
        <b translate="no">{{ name }}</b>
        <span v-if="typeChip" class="chip" translate="no">{{ typeChip }}</span>
      </span>
      <span v-if="activity" class="run-activity"
        ><span class="phase">{{ phase }}</span> {{ activity }}</span
      >
      <span class="run-nums">
        <span v-if="modelShort" class="model" translate="no">{{ modelShort }}</span>
        <span class="time">{{ elapsedLabel }}</span>
        <span class="cost">{{ costLabel }}</span>
      </span>
    </div>
  </li>
</template>
