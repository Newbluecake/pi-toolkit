<!--
  A centered separator pill (ui-design.md §5.4): plain for `model_change`, expandable (native
  `<details>`) when a `summary` is provided for `compaction`/`branch_summary` entries.
-->
<script setup lang="ts">
import type { IconName } from "../../icons/names.js";
import { useI18n } from "../../composables/useI18n.js";
import AppIcon from "../../icons/AppIcon.vue";

const props = defineProps<{
  readonly icon: IconName;
  readonly label: string;
  readonly summary?: string;
  readonly truncated?: boolean;
}>();
const { t } = useI18n();
</script>

<template>
  <details v-if="summary" class="tx-divider-wrap tx-item">
    <summary class="tx-divider">
      <span class="label"><AppIcon :name="icon" class="icon icon-sm" />{{ label }}</span>
      <span v-if="truncated" class="badge badge-trunc">{{ t("transcript.truncated") }}</span>
    </summary>
    <div class="tx-summary">{{ summary }}</div>
  </details>
  <div v-else class="tx-divider tx-item">
    <span class="label"><AppIcon :name="icon" class="icon icon-sm" />{{ label }}</span>
  </div>
</template>
