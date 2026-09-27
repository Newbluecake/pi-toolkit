<!--
  Global notice list (vue-plan.md v2.1 §7, §5.2 — P3 exclusive, `components/shell/**`). Renders
  under the top bar (`App.vue`'s `.banners` container, `shell.css`) — at most a handful of
  banners (initial-password reminder, connection health, session-expired), never a scrollable
  list.
-->
<script setup lang="ts">
import type { NoticeStackEmits, NoticeStackProps } from "../../contracts.js";
import NoticeBanner from "./NoticeBanner.vue";

defineProps<NoticeStackProps>();
const emit = defineEmits<NoticeStackEmits>();
</script>

<template>
  <div class="banners">
    <NoticeBanner v-for="notice in notices" :key="notice.id" :notice="notice" @action="emit('action', $event)" />
  </div>
</template>
