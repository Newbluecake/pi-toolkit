<!--
  Assistant error line (ui-design.md §5.4: red-soft error condition, `stopReason: "error"`).
  Split out of `TxAssistant.vue` so it is independently testable/reusable, per the component
  tree in vue-plan.md v2.1 §3.2 / ui-design.md §12.
-->
<script setup lang="ts">
import AppIcon from "../../icons/AppIcon.vue";

defineProps<{ readonly text: string }>();
</script>

<template>
  <div class="msg-error" role="alert">
    <AppIcon name="alert" class="icon icon-sm" />
    <span>{{ text }}</span>
  </div>
</template>
