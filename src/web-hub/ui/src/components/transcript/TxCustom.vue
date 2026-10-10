<!--
  A `customType`-tagged message (ui-design.md §5.4). 2026-10-05 (user field report): notification-class
  custom messages (subagent completion notices, system notices, …) used to render as a free-floating
  dashed card with no identity — indistinguishable in the stream and not left-aligned with other
  content. They now mirror `TxAssistant.vue`'s chrome: an avatar + `msg-head` identity row (a friendly
  who label + the mono customType chip) above the markdown body, sharing `.msg-assistant`'s grid so the
  content's left edge lines up with every other message (the avatar column only exists ≥481px, same as
  assistant messages).
  The body still renders through the same `MarkdownView.vue` `TxAssistant.vue` uses — allow-listed-subset
  parser + ordinary Vue interpolation (never `v-html`, see `MarkdownView.vue`'s own header comment and
  `tests/web-hub/ui/source-scan.test.ts`).
-->
<script setup lang="ts">
import { computed } from "vue";
import { useI18n } from "../../composables/useI18n.js";
import AppIcon from "../../icons/AppIcon.vue";
import MarkdownView from "./MarkdownView.vue";

const props = defineProps<{ readonly customType: string; readonly text: string; readonly truncated: boolean }>();
const { t } = useI18n();

/** `subagent:` is the toolkit's legacy NAMESPACE (renamed pi-subagent → pi-toolkit; runtime ids keep
 *  it on purpose), not a statement that the message comes from a subagent — usage ticks, compact
 *  hints, quota or cache notices all share it. Only the run/workflow delivery kinds below get the
 *  「子代理」 who label; every other kind is a plain notice. The chip shows the kind without the
 *  namespace (2026-10-10 user report: `subagent:usage-tick` read as a subagent message). */
const NAMESPACE = "subagent:";
const SUBAGENT_KINDS = new Set([
  "notification",
  "workflow-notification",
  "workflow-notice",
  "timeout",
  "worktree-disposition",
  "fabric",
  "started",
  "completed",
  "failed",
  "task-started",
  "child",
]);
/** Short display aliases for namespaced kinds whose raw name is an implementation detail. */
const KIND_ALIASES: Readonly<Record<string, string>> = { "usage-tick": "usage" };
const namespaced = computed(() => props.customType.startsWith(NAMESPACE));
const kind = computed(() => (namespaced.value ? props.customType.slice(NAMESPACE.length) : props.customType));
const isSubagentNotice = computed(() => namespaced.value && SUBAGENT_KINDS.has(kind.value));
const chipText = computed(() => (namespaced.value ? (KIND_ALIASES[kind.value] ?? kind.value) : props.customType));
</script>

<template>
  <article class="msg-custom tx-item">
    <span class="avatar avatar-notice"><AppIcon name="branch" class="icon" /></span>
    <div class="msg-main">
      <div class="msg-head">
        <span class="who">{{ isSubagentNotice ? t("transcript.whoSubagent") : t("transcript.whoNotice") }}</span>
        <span class="kind-chip" translate="no" :title="customType">{{ chipText }}</span>
      </div>
      <MarkdownView :text="text" />
      <span v-if="truncated" class="badge badge-trunc">{{ t("transcript.truncated") }}</span>
    </div>
  </article>
</template>
