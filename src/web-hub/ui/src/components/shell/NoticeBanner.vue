<!--
  One notice banner (vue-plan.md v2.1 §7, §10, §5.2 — P3 exclusive, `components/shell/**`).
  Two render modes driven by `notice.persistent` (§10 — safety notices are collapsible but
  never dismissible, so they render as a `<details class="notice-compact">`; everything else is
  a plain `.notice` block with an optional action button emitting `action(notice.id)`).

  `NoticeBannerProps` (frozen `contracts.ts`) has no per-notice `icon` field, so the icon is
  derived from `tone` alone (danger/warn → alert, muted → unplug, info → info) rather than
  mirroring each mockup notice's bespoke icon (key/unlock/radio/message/clock) — a deliberate
  simplification forced by the frozen contract, not an oversight (see the delivery report).
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
  <details v-if="notice.persistent" class="notice notice-compact" :class="toneClass">
    <summary>
      <AppIcon :name="icon" />
      <span class="notice-line"
        ><strong>{{ notice.title }}</strong></span
      >
      <AppIcon name="chev-right" class="icon-sm chev" />
    </summary>
    <p v-if="notice.body" class="notice-more">{{ notice.body }}</p>
  </details>
  <div v-else class="notice" :class="toneClass" :role="role">
    <AppIcon :name="icon" />
    <span class="notice-body"
      ><strong>{{ notice.title }}</strong> <template v-if="notice.body">{{ notice.body }}</template></span
    >
    <button v-if="notice.action" type="button" class="btn notice-action" @click="onAction">
      {{ notice.action.label }}
    </button>
  </div>
</template>
