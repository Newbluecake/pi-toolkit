<!--
  Status pill (dot/icon + label; ui-design.md §3.2, vue-plan.md v2.1 §3.2, §5.2 — P3 exclusive,
  `components/detail/**`). One shared rendering for every `RunVisualState` — used by
  `DetailHeader.vue`; `AgentCard.vue` (agents/) renders its own inline variant since it needs
  slightly different icon overrides (waiting/offline dialog icons) not modeled by this
  component's plain `label` prop.
-->
<script setup lang="ts">
import { computed } from "vue";
import type { StatusPillProps } from "../../contracts.js";

const props = defineProps<StatusPillProps>();

const dotClass = computed(() => {
  switch (props.state) {
    case "running":
      return "dot-live";
    case "stale":
      return "dot-dashed";
    case "idle":
    case "offline":
    case "aborted":
    case "queued":
      return "dot-hollow";
    default:
      return undefined;
  }
});
</script>

<template>
  <span class="pill" :data-st="state"><span class="dot" :class="dotClass"></span>{{ label }}</span>
</template>
