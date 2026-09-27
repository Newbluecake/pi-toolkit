<!--
  A `customType`-tagged message (ui-design.md §5.4: dashed card, mono-font `customType` header).
-->
<script setup lang="ts">
import { useI18n } from "../../composables/useI18n.js";
import AppIcon from "../../icons/AppIcon.vue";

defineProps<{ readonly customType: string; readonly text: string; readonly truncated: boolean }>();
const { t } = useI18n();
</script>

<template>
  <div class="msg-custom tx-item">
    <div class="kind">
      <AppIcon name="branch" class="icon icon-sm" /><span translate="no">{{ customType }}</span>
    </div>
    <div>{{ text }}</div>
    <span v-if="truncated" class="badge badge-trunc">{{ t("transcript.truncated") }}</span>
  </div>
</template>
