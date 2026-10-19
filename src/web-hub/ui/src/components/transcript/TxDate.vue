<!--
  The injected `[date]` message (src/date) as a centered dashed divider — the date-separator
  idiom of chat apps (date-marker plan, layout A): `2026-10-19 周一 14:12 · Asia/Shanghai`, nothing else (the per-kind
  note line was removed on user request 2026-10-19). Plain text interpolation only (never `v-html`). Entries
  that cannot be parsed never reach this component (entries.ts falls back to TxCustom).
-->
<script setup lang="ts">
import { computed } from "vue";
import { useI18n } from "../../composables/useI18n.js";
import type { DateMarker } from "../../logic/dateMarker.js";

const props = defineProps<{ readonly marker: DateMarker }>();
const { t } = useI18n();

const WEEKDAYS = new Set(["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"]);
const weekday = computed(() =>
  WEEKDAYS.has(props.marker.weekday) ? t(`transcript.dateWeek${props.marker.weekday}`) : props.marker.weekday,
);
</script>

<template>
  <div class="tx-date tx-item" role="separator" :aria-label="t('transcript.dateAriaLabel')">
    <div class="tx-date-line">
      <span class="tx-date-text" translate="no"
        >{{ marker.date }} {{ weekday }} {{ marker.time }} · {{ marker.zone }}</span
      >
    </div>
  </div>
</template>
