<!--
  An assistant message (ui-design.md §5.4): avatar + head (who/model/time, or a "● Streaming…"
  pill while in flight) + content blocks (markdown text / collapsed thinking / tool cards /
  image placeholder) + optional error line + cost meta. The streaming caret is rendered as a
  trailing sibling after the blocks rather than spliced into the last text run — visually
  equivalent ("still going") without teaching `MarkdownView.vue` about an external cursor.
-->
<script setup lang="ts">
import { computed } from "vue";
import type { AssistantView } from "./entries.js";
import { formatDateTime, formatUsd } from "../../format.js";
import { useI18n } from "../../composables/useI18n.js";
import AppIcon from "../../icons/AppIcon.vue";
import MarkdownView from "./MarkdownView.vue";
import ThinkingBlock from "./ThinkingBlock.vue";
import ToolCard from "./ToolCard.vue";
import TxError from "./TxError.vue";

const props = defineProps<{ readonly assistant: AssistantView; readonly truncated: boolean }>();
const { lang, t } = useI18n();

const timeLabel = computed(() =>
  props.assistant.timestamp === undefined
    ? ""
    : formatDateTime(props.assistant.timestamp, lang === "zh" ? "zh-CN" : "en-US"),
);
const costLabel = computed(() => (props.assistant.costUsd === undefined ? "" : formatUsd(props.assistant.costUsd)));
</script>

<template>
  <article
    class="msg-assistant tx-item"
    :class="{ 'is-streaming': assistant.streaming }"
    :aria-busy="assistant.streaming || undefined"
  >
    <span class="avatar"><AppIcon name="logo" /></span>
    <div class="msg-main">
      <div class="msg-head">
        <span class="who">{{ t("transcript.who") }}</span>
        <span v-if="assistant.streaming" class="pill" data-st="running"
          ><span class="dot dot-live"></span>{{ t("transcript.streaming") }}</span
        >
        <span v-else class="end">
          <span v-if="assistant.model" translate="no">{{ assistant.model }}</span>
          <span v-if="timeLabel" translate="no">{{ timeLabel }}</span>
        </span>
      </div>
      <template v-for="(b, i) in assistant.blocks" :key="i">
        <ThinkingBlock
          v-if="b.kind === 'thinking'"
          :text="b.text"
          :live="assistant.streaming && i === assistant.blocks.length - 1"
        />
        <MarkdownView v-else-if="b.kind === 'text'" :text="b.text" />
        <ToolCard v-else-if="b.kind === 'toolCall'" :view="b.view" />
        <div v-else class="tx-marker">{{ t("transcript.imagePlaceholder") }}</div>
      </template>
      <span v-if="assistant.streaming" class="caret" aria-hidden="true"></span>
      <TxError v-if="assistant.errorText" :text="assistant.errorText" />
      <span v-if="truncated" class="badge badge-trunc">{{ t("transcript.truncated") }}</span>
      <div v-if="costLabel" class="msg-meta">
        <span>{{ costLabel }}</span>
      </div>
    </div>
  </article>
</template>
