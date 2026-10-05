<!--
  抽屉里被选中 run 的头部(fleet-drawer plan v2 §6.3/§6.6 — F6):图标 + 名字 + type chip +
  状态行,外加「← 子 agent 列表」返回键(back —— 退选 run、回到树视图,fullscreen 下是
  唯一的返回路径)和关闭按钮(`.drawer-close`,§6.4 #6 的焦点目标)。

  §6.3 的 lastRow 回退:被选中的 run 移出投影行后(64/8 上限淘汰),头部改用
  `runTx.lastRow`(F5 在 reducer 里保留的最后一条 FleetRowWire)继续显示,并加
  「不在列表中」chip(U10);transcript 本身按 runId 查询,不依赖 rows,不中断。
-->
<script setup lang="ts">
import { computed } from "vue";
import type { FleetRowWire } from "@protocol/messages.js";
import type { RunHeaderEmits, RunHeaderProps } from "../../contracts.js";
import { clip } from "../../format.js";
import { fleetRowVisualState } from "../../composables/visual-state.js";
import { useI18n } from "../../composables/useI18n.js";
import AppIcon from "../../icons/AppIcon.vue";
import { FLEET_STATE_ICON, fleetStateSpins } from "../fleet/state-icon.js";

const props = defineProps<RunHeaderProps>();
const emit = defineEmits<RunHeaderEmits>();
const { t } = useI18n();

const runId = computed(() => props.agent.runSel ?? props.agent.runTx?.runId ?? "");

/** 先查当前投影行;不在则回退 lastRow(§6.3)。 */
const row = computed<FleetRowWire | undefined>(() => {
  const id = runId.value;
  if (id === "") return undefined;
  for (const r of props.agent.fleet as readonly FleetRowWire[]) {
    if (r && String(r.runId) === id) return r;
  }
  return props.agent.runTx?.lastRow as FleetRowWire | undefined;
});
const listed = computed(() => {
  const id = runId.value;
  if (id === "") return false;
  return (props.agent.fleet as readonly FleetRowWire[]).some((r) => r && String(r.runId) === id);
});

const name = computed(() => {
  const r = row.value;
  if (r === undefined) return runId.value;
  return clip(String(r.label ?? r.type ?? r.runId), 60);
});
const typeChip = computed(() => {
  const ty = row.value?.type;
  return typeof ty === "string" && ty !== "" ? ty : "";
});
const statusText = computed(() => {
  const tx = props.agent.runTx;
  const r = row.value;
  if (tx !== null && tx !== undefined && tx.status !== "") return tx.status;
  if (r !== undefined) return String(r.phaseLabel ?? r.status ?? "");
  return "";
});
const visualState = computed(() =>
  row.value === undefined
    ? ("idle" as const)
    : fleetRowVisualState({
        status: String(row.value.status ?? ""),
        phaseLabel: String(row.value.phaseLabel ?? ""),
        highlight: row.value.highlight === "warn" || row.value.highlight === "crit" ? row.value.highlight : "none",
        terminal: row.value.terminal === true,
      }),
);
const icon = computed(() => FLEET_STATE_ICON[visualState.value]);
const spins = computed(() => fleetStateSpins(visualState.value));
</script>

<template>
  <header class="run-head">
    <button class="btn btn-ghost btn-xs drawer-back" type="button" @click="emit('back')">
      <AppIcon name="chev-left" class="icon-sm" />{{ t("drawer.backToTree") }}
    </button>
    <span class="run-icon run-head-icon"><AppIcon :name="icon" :class="{ icon: true, spin: spins }" /></span>
    <span class="run-head-name">
      <b translate="no">{{ name }}</b>
      <span v-if="typeChip" class="chip" translate="no">{{ typeChip }}</span>
      <span v-if="!listed" class="chip chip-notlisted">{{ t("drawer.notListed") }}</span>
    </span>
    <span v-if="statusText" class="run-head-status" translate="no">{{ statusText }}</span>
    <button
      class="btn btn-ghost btn-icon drawer-close"
      type="button"
      :aria-label="t('drawer.close')"
      @click="emit('close')"
    >
      <AppIcon name="x" class="icon-sm" />
    </button>
  </header>
</template>
