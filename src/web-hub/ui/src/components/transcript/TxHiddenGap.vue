<!--
  Client-side transcript-window affordance (vue-plan.md v2.1 §3.6, §5.2 — P4; not part of the
  legacy vanilla-DOM renderer, which never windowed the transcript). Sits above/below the
  mounted `.tx-item` slice: "N earlier messages hidden · Show" (reveals more of the *local*
  window, `Transcript.vue`'s `showEarlier()`) or "N newer hidden · Jump to latest" (re-enables
  follow and jumps to the bottom).
-->
<script setup lang="ts">
import { useI18n } from "../../composables/useI18n.js";
import AppIcon from "../../icons/AppIcon.vue";

const props = defineProps<{ readonly count: number; readonly direction: "before" | "after" }>();
defineEmits<{ action: [] }>();
const { t } = useI18n();
</script>

<template>
  <button class="btn tx-window-gap" type="button" @click="$emit('action')">
    <AppIcon :name="direction === 'before' ? 'arrow-up' : 'arrow-down'" />
    {{
      direction === "before" ? t("transcript.hiddenBefore", { n: count }) : t("transcript.hiddenAfter", { n: count })
    }}
  </button>
</template>
