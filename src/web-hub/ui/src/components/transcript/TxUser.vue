<!--
  A user message bubble (ui-design.md §5.4: right-aligned, teal-soft bubble, `pre-wrap`).
-->
<script setup lang="ts">
import { computed } from "vue";
import { formatDateTime } from "../../format.js";
import { useI18n } from "../../composables/useI18n.js";

const props = defineProps<{
  readonly text: string;
  readonly truncated: boolean;
  readonly timestamp: number | undefined;
}>();
const { lang, t } = useI18n();
const timeLabel = computed(() =>
  props.timestamp === undefined ? "" : formatDateTime(props.timestamp, lang === "zh" ? "zh-CN" : "en-US"),
);
</script>

<template>
  <div class="msg-user tx-item">
    <div class="bubble">{{ text }}</div>
    <span v-if="truncated" class="badge badge-trunc">{{ t("transcript.truncated") }}</span>
    <span v-if="timeLabel" class="msg-time" translate="no">{{ timeLabel }}</span>
  </div>
</template>
