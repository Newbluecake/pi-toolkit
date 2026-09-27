<!--
  Collapsed-by-default "thinking" block (ui-design.md §5.4): a pill summary "✦ Thinking · N
  lines ›" that expands to the raw thinking text in a scroll-capped, left-bordered panel
  (`styles/transcript.css`'s `.thinking-text`, max 320px). Plain text only — thinking content is
  never markdown-rendered (matches the legacy vanilla-DOM behavior, `render/transcript.js`'s
  `pre(doc, "thinking-text", b.thinking)`).
-->
<script setup lang="ts">
import { computed } from "vue";
import { useI18n } from "../../composables/useI18n.js";

const props = defineProps<{ readonly text: string }>();
const { t } = useI18n();

const lineCount = computed(() => (props.text === "" ? 0 : props.text.split("\n").length));
</script>

<template>
  <details class="thinking">
    <summary>
      <span>{{ t("transcript.thinking", { n: lineCount }) }}</span>
    </summary>
    <div class="thinking-text">{{ text }}</div>
  </details>
</template>
