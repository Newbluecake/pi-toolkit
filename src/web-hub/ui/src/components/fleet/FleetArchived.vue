<!--
  web-hub archive plan (docs/dev/web-hub/archive-report.md): the fleet drawer's archived-runs
  fold — the bottom「已归档 N」section under the agent tree. Rows here are TERMINAL runs the
  user archived (manually or via the webHub.archiveAfterMin sweep — sweep entries carry the
  `auto` badge). Pure display: the rows still exist in the fleet wire (the agent sends ALL rows
  plus the archive set; only the UI partitions), so no data is lost and「取消归档」(hover,
  top-right) puts the row straight back into the tree via the FLEET_ARCHIVE seam.

  Row shape mirrors the tree's terminal rows, dimmed: icon / optional type badge / title +
  @label / cost / time range. No per-row fold, no transcript open button (the run-open entry
  stays on the tree; an archived row is intentionally read-only display). Expand state is a
  plain local ref (TodoPanel/WorktreePanel precedent — never persisted).
-->
<script setup lang="ts">
import { computed, inject, ref, watch } from "vue";
import type { FleetRowWire } from "@protocol/messages.js";
import { useI18n } from "../../composables/useI18n.js";
import AppIcon from "../../icons/AppIcon.vue";
import { FLEET_STATE_ICON } from "./state-icon.js";
import { fleetRowVisualState } from "../../composables/visual-state.js";
import { typeBadge, shortModelLabel } from "@logic/fleetRow.js";
import { formatUsd } from "../../format.js";
import { formatTimeRange } from "@logic/timeRange.js";
import type { ArchiveSet } from "./archiveView.js";
import { FLEET_ARCHIVE, isTerminalRow } from "./summary.js";
import "../../styles/fleet.css";

const props = defineProps<{ rows: readonly FleetRowWire[]; set: ArchiveSet }>();
const { t } = useI18n();
const arch = inject(FLEET_ARCHIVE, null);
const open = ref(false);
/** fleet-fill-budget: the drawer re-balances when the archived list opens/closes (its rows sit in
 *  the agents half; ResizeObserver on `.tree-scroll` never fires for a content-only change). */
const emit = defineEmits<{ "update:open": [open: boolean] }>();
watch(open, (v) => emit("update:open", v));

function nameOf(row: FleetRowWire): string {
  return String(row.title ?? row.label ?? row.type ?? row.runId);
}
function badgeOf(row: FleetRowWire): { letter: string; tone: number } | null {
  const ty = typeof row.type === "string" && row.type !== "" ? row.type : "";
  return ty === "" ? null : typeBadge(ty);
}
function typeOf(row: FleetRowWire): string {
  return typeof row.type === "string" && row.type !== "" ? row.type : "";
}
function subLabelOf(row: FleetRowWire): string {
  const l = row.label;
  return typeof l === "string" && l !== "" ? `@${l}` : "";
}
function modelOf(row: FleetRowWire): string {
  const m = row.model;
  if (typeof m !== "string" || m === "") return "";
  return shortModelLabel(m.slice(m.lastIndexOf("/") + 1));
}
function costOf(row: FleetRowWire): string {
  return typeof row.costUsd === "number" ? formatUsd(row.costUsd) : "—";
}
function timeRangeOf(row: FleetRowWire): { text: string; title: string } | null {
  return formatTimeRange(row.startedAt, row.endedAt);
}
function isAuto(row: FleetRowWire): boolean {
  return props.set.get(String(row.runId))?.auto === true;
}
function onUnarchive(row: FleetRowWire): void {
  arch?.unarchive("run", String(row.runId));
}
const terminalRows = computed(() => props.rows.filter((r) => isTerminalRow(r as unknown as Record<string, unknown>)));
</script>

<template>
  <section class="fleet-archived" :data-open="open" :aria-label="t('fleet.archivedFold', { n: rows.length })">
    <button class="fleet-archived-fold" type="button" :aria-expanded="open" @click="open = !open">
      <AppIcon name="chev-right" class="icon-sm chev" />
      <span>{{ t("fleet.archivedFold", { n: rows.length }) }}</span>
    </button>
    <ul v-if="open" class="fleet-archived-list">
      <li v-for="row in terminalRows" :key="String(row.runId)" class="arch-row">
        <span class="run-icon"
          ><AppIcon :name="FLEET_STATE_ICON[fleetRowVisualState(row)]" class="icon icon-sm"
        /></span>
        <span
          v-if="badgeOf(row)"
          class="run-type"
          role="img"
          translate="no"
          :data-tone="badgeOf(row)!.tone"
          :title="typeOf(row)"
          >{{ badgeOf(row)!.letter }}</span
        >
        <span class="arch-name" :title="nameOf(row)"
          ><b translate="no">{{ nameOf(row) }}</b>
          <span v-if="subLabelOf(row)" class="run-label" translate="no">{{ subLabelOf(row) }}</span>
          <span v-if="isAuto(row)" class="arch-auto" translate="no">auto</span>
        </span>
        <span v-if="modelOf(row)" class="run-model" translate="no">{{ modelOf(row) }}</span>
        <span class="run-cost">{{ costOf(row) }}</span>
        <span v-if="timeRangeOf(row)" class="run-meta" translate="no" :title="timeRangeOf(row)!.title">{{
          timeRangeOf(row)!.text
        }}</span>
        <button v-if="arch !== null" class="btn btn-ghost arch-act" type="button" @click.stop="onUnarchive(row)">
          {{ t("fleet.unarchive") }}
        </button>
      </li>
    </ul>
  </section>
</template>
