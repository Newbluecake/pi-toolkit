<!--
  A `customType`-tagged message (ui-design.md §5.4: dashed card, mono-font `customType` header).
  Notification-class custom messages (subagent completion notices, system notices, …) carry a
  markdown source (**bold**, lists, code blocks) that used to render as raw `{{ text }}`
  characters — rendered through the same `MarkdownView.vue` `TxAssistant.vue` already uses, so
  it stays on the allow-listed-subset parser + ordinary Vue interpolation (never `v-html`, see
  `MarkdownView.vue`'s own header comment and `tests/web-hub/ui/source-scan.test.ts`).
-->
<script setup lang="ts">
import { useI18n } from "../../composables/useI18n.js";
import AppIcon from "../../icons/AppIcon.vue";
import MarkdownView from "./MarkdownView.vue";

defineProps<{ readonly customType: string; readonly text: string; readonly truncated: boolean }>();
const { t } = useI18n();
</script>

<template>
  <div class="msg-custom tx-item">
    <div class="kind">
      <AppIcon name="branch" class="icon icon-sm" /><span translate="no">{{ customType }}</span>
    </div>
    <MarkdownView :text="text" />
    <span v-if="truncated" class="badge badge-trunc">{{ t("transcript.truncated") }}</span>
  </div>
</template>
