<!--
  P0→P4 seam (vue-plan.md v2.1 §1.1, §3.2, §5.2): P3's `AgentDetail.vue` imports this to
  compile without waiting on P4; P4 replaces the body wholesale (nesting `FleetPanel.vue` +
  `Transcript.vue`) without ever touching `AgentDetail.vue`. Props/emits are frozen in
  `contracts.ts` — this placeholder renders an empty, correctly-labelled `<section>` and
  nothing else, so it never fires the `load-older` / `update:following` / `new-count` emits.
-->
<script setup lang="ts">
import type { DetailBodyEmits, DetailBodyProps } from "../../contracts.js";

defineProps<DetailBodyProps>();
defineEmits<DetailBodyEmits>();
</script>

<template>
  <section aria-label="Conversation"></section>
</template>
