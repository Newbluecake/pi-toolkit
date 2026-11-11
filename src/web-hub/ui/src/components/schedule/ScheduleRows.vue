<!--
  ScheduleRows (schedule-auto-approve r2, plan §6-W2): PURE presentation of the aggregated
  scheduled-task rows (`@logic/schedule.js`'s taskRowsOf) — consumed by detail's TasksPanel
  (and the composer chip's compact section). No hub/control/ticker dependency: parents
  own `now` (ticker) and every action; this component only renders and emits. It imports
  `styles/schedule.css` itself so every consumer gets the row grammar.

  Row grammar (plan D6 / preview.html A2): name · status chip (`running` with a spinning
  loader while any run is non-terminal, `paused` when disabled) · when text + next/paused ·
  last-run line (state token colored ok/fail via runToneOf, relAgo token, `run <id> »` jump
  ONLY when the wire carries a runId — old hubs never send one). Action icon buttons
  (pause/resume + delete) render ONLY with `canWrite` (offline/read-only surfaces hide them).
  `plainNames` swaps the clickable name buttons for plain spans (the composer's read-only
  section — no focusable dead affordances there; a11y fix 2026-11-05).

  Compact inline markers (chips, tokens) are English in both locales (AGENTS.md UI-text rule).
-->
<script setup lang="ts">
import AppIcon from "../../icons/AppIcon.vue";
import { useI18n } from "../../composables/useI18n.js";
import { relAgo, runStateKey, runToneOf } from "../../logic/schedule.js";
import type { TaskRow } from "./taskRow.js";
import "../../styles/schedule.css";

const props = defineProps<{
  readonly rows: readonly TaskRow[];
  /** Ticker-provided epoch ms (parents own the 30s ticker; 0 ⇒ relative tokens blank). */
  readonly now: number;
  /** Show the action column (offline/read-only surfaces pass false ⇒ no buttons at all). */
  readonly canWrite?: boolean;
  /** Compact variant (composer's section — tighter paddings via [data-compact]). */
  readonly compact?: boolean;
  /** Render row names as plain spans instead of buttons (the composer's read-only section —
   *  no focusable dead affordances; a11y fix 2026-11-05). */
  readonly plainNames?: boolean;
}>();
const emit = defineEmits<{
  pause: [id: string];
  resume: [id: string];
  remove: [id: string];
  openRun: [runId: string];
  openDetail: [id: string];
}>();
const { t } = useI18n();

/** Enabled rows show the relative next-run token; a missing/never nextAt renders `next —`. */
function nextLabel(row: TaskRow): string {
  if (!row.enabled) return "paused";
  return row.nextIn !== "" ? `next ${row.nextIn}` : "next —";
}
</script>

<template>
  <ul class="sched-rows" :data-compact="props.compact === true ? 'true' : undefined">
    <li v-for="row in props.rows" :key="row.id" class="sched-row" :data-enabled="row.enabled">
      <span class="sched-row-body">
        <span class="sched-row-head">
          <button
            v-if="props.plainNames !== true"
            class="sched-row-name"
            type="button"
            translate="no"
            :title="t('detail.schedOpenDetailAria', { name: row.name })"
            :aria-label="t('detail.schedOpenDetailAria', { name: row.name })"
            @click="emit('openDetail', row.id)"
          >
            {{ row.name }}
          </button>
          <span v-else class="sched-row-name" translate="no" :title="row.name">{{ row.name }}</span>
          <span v-if="row.live" class="chip" data-st="running">
            <AppIcon name="loader" class="icon-sm spin" />running
          </span>
          <span v-else-if="!row.enabled" class="chip" data-st="paused">paused</span>
        </span>
        <span class="sched-row-meta"> {{ row.whenText }}<span class="sep"> · </span>{{ nextLabel(row) }} </span>
        <span v-if="row.lastRun !== undefined" class="sched-row-run">
          last <span :class="runToneOf(row.lastRun.state) ?? 'plain'">{{ runStateKey(row.lastRun.state) }}</span>
          {{ relAgo(row.lastRun.at, props.now) }}
          <span v-if="row.lastRun.catchUp" class="chip">catch-up ×{{ row.lastRun.catchUp.dueCount }}</span>
          <template v-if="row.lastRun.runId !== undefined">
            <span class="sep"> · </span>
            <button class="sched-run-link" type="button" @click="emit('openRun', row.lastRun!.runId)">
              run {{ row.lastRun.runId }} »
            </button>
          </template>
        </span>
      </span>
      <span v-if="props.canWrite === true" class="sched-row-acts">
        <button
          v-if="row.enabled"
          class="icon-btn"
          type="button"
          :title="t('detail.schedPause')"
          :aria-label="t('detail.schedPauseAria', { name: row.name })"
          @click="emit('pause', row.id)"
        >
          <AppIcon name="pause" class="icon-sm" />
        </button>
        <button
          v-else
          class="icon-btn"
          type="button"
          :title="t('detail.schedResume')"
          :aria-label="t('detail.schedResumeAria', { name: row.name })"
          @click="emit('resume', row.id)"
        >
          <AppIcon name="play" class="icon-sm" />
        </button>
        <button
          class="icon-btn danger"
          type="button"
          :title="t('detail.schedRemove')"
          :aria-label="t('detail.schedRemoveAria', { name: row.name })"
          @click="emit('remove', row.id)"
        >
          <AppIcon name="trash" class="icon-sm" />
        </button>
      </span>
    </li>
  </ul>
</template>
