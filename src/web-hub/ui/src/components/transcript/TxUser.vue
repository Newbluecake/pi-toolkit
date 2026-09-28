<!--
  A user message bubble (ui-design.md §5.4: right-aligned, teal-soft bubble, `pre-wrap`).

  C5 (control-plan.md v2.1 §7.7): web-sent user messages get a small `web` badge, matched
  best-effort off the agent's ctl ledger (`CONTROL_VIEW.isWebMessage` — timestamp proximity to
  a `started`/`consumed` ledger entry; any doubt ⇒ no badge). The inject is optional: mounted
  outside a detail pane (isolated tests) nothing changes.
-->
<script setup lang="ts">
import { computed, inject } from "vue";
import { formatDateTime } from "../../format.js";
import { useI18n } from "../../composables/useI18n.js";
import { CONTROL_VIEW } from "../control/controlContext.js";

const props = defineProps<{
  readonly text: string;
  readonly truncated: boolean;
  readonly timestamp: number | undefined;
}>();
const { lang, t } = useI18n();
const timeLabel = computed(() =>
  props.timestamp === undefined ? "" : formatDateTime(props.timestamp, lang === "zh" ? "zh-CN" : "en-US"),
);

const view = inject(CONTROL_VIEW, null);
const fromWeb = computed(() => view?.isWebMessage(props.timestamp) === true);
</script>

<template>
  <div class="msg-user tx-item">
    <div class="bubble">{{ text }}</div>
    <span v-if="fromWeb" class="badge badge-web" translate="no">{{ t("control.badgeWeb") }}</span>
    <span v-if="truncated" class="badge badge-trunc">{{ t("transcript.truncated") }}</span>
    <span v-if="timeLabel" class="msg-time" translate="no">{{ timeLabel }}</span>
  </div>
</template>
