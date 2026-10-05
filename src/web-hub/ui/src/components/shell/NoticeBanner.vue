<!--
  One notice banner (vue-plan.md v2.1 §7, §10, §5.2 — P3 exclusive, `components/shell/**`).
  ALL notices render as a compact one-line `<details class="notice-compact">` (icon + title +
  chevron; body and the optional action button live in the expanded region) — unified 2026-10-05
  on a user field report: full-block banners ate too much vertical space on phones, the compact
  title row (previously reserved for persistent safety notices) is now the single render mode.

  `NoticeBannerProps` (frozen `contracts.ts`) has no per-notice `icon` field, so the icon is
  derived from `tone` alone (danger/warn → alert, muted → unplug, info → info) rather than
  mirroring each mockup notice's bespoke icon (key/unlock/radio/message/clock) — a deliberate
  simplification forced by the frozen contract, not an oversight (see the delivery report).
  The `persistent` flag no longer changes the render shape (safety notices stay never-dismissible
  upstream — nothing here ever renders a dismiss control).
-->
<script setup lang="ts">
import { computed } from "vue";
import AppIcon from "../../icons/AppIcon.vue";
import type { IconName } from "../../icons/names.js";
import type { NoticeBannerEmits, NoticeBannerProps } from "../../contracts.js";

const props = defineProps<NoticeBannerProps>();
const emit = defineEmits<NoticeBannerEmits>();

const toneClass = computed(() => (props.notice.tone === "info" ? "" : `notice--${props.notice.tone}`));
const icon = computed<IconName>(() => {
  switch (props.notice.tone) {
    case "danger":
      return "alert";
    case "warn":
      return "alert";
    case "muted":
      return "unplug";
    default:
      return "info";
  }
});
const role = computed(() => (props.notice.tone === "danger" ? "alert" : "status"));

function onAction(): void {
  emit("action", props.notice.id);
}
</script>

<template>
  <details class="notice notice-compact" :class="toneClass">
    <summary :role="role">
      <AppIcon :name="icon" />
      <span class="notice-line"
        ><strong>{{ notice.title }}</strong></span
      >
      <AppIcon name="chev-right" class="icon-sm chev" />
    </summary>
    <p v-if="notice.body" class="notice-more">{{ notice.body }}</p>
    <p v-if="notice.action" class="notice-more">
      <button type="button" class="btn notice-action" @click="onAction">{{ notice.action.label }}</button>
    </p>
  </details>
</template>
