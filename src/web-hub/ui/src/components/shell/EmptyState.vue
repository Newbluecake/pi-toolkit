<!--
  Generic icon + title + body + actions empty-state block (vue-plan.md v2.1 §9, §12, §5.2 — P3
  exclusive, `components/shell/**`). Used for "no agents connected", "select an agent" and
  "agent not connected" (ui-design.md §9's total table) — `EmptyStateProps` (`contracts.ts`,
  frozen) intentionally has no `icon`-per-case escape hatch beyond `icon`/`title`/`body`, so any
  richer body content (e.g. an inline `<code>` fragment) is composed by the caller into a single
  plain-text `body` string instead of being slotted here.
-->
<script setup lang="ts">
import AppIcon from "../../icons/AppIcon.vue";
import type { EmptyStateProps } from "../../contracts.js";

defineProps<EmptyStateProps>();
</script>

<template>
  <div class="empty">
    <span class="empty-icon" aria-hidden="true"><AppIcon :name="icon" /></span>
    <h2>{{ title }}</h2>
    <p v-if="body">{{ body }}</p>
    <slot name="actions" />
  </div>
</template>
