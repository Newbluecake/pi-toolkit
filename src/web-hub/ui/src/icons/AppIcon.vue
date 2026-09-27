<!--
  Single icon reference (vue-plan.md v2.1 §3.2, §5.2 — P0 frozen). Always a `<use>` against
  `IconSprite.vue`'s symbols — never a second inline copy of any path data.
-->
<script setup lang="ts">
import type { IconName } from "./names.js";

defineProps<{ name: IconName }>();
</script>

<template>
  <svg class="icon" aria-hidden="true"><use :href="`#i-${name}`" /></svg>
</template>
