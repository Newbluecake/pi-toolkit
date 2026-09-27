<!--
  Bottom dock: read-only notice + follow-live switch + jump-to-latest (ui-design.md §5.4, §6.5,
  vue-plan.md v2.1 §3.2, §5.2 — P3 exclusive, `components/detail/**`). Lives in the document
  flow (`detail.css`'s `.detail` column, `dock.css`'s `.dock`), never `position: fixed`, so it
  can never cover the transcript. The "Latest · N new" button only appears once `following` is
  off and there is something to jump to (ui-design §5.4).
-->
<script setup lang="ts">
import AppIcon from "../../icons/AppIcon.vue";
import { useI18n } from "../../composables/useI18n.js";
import type { DetailDockEmits, DetailDockProps } from "../../contracts.js";

const props = defineProps<DetailDockProps>();
const emit = defineEmits<DetailDockEmits>();
const { t } = useI18n();

function onToggle(ev: Event): void {
  emit("update:following", (ev.target as HTMLInputElement).checked);
}
</script>

<template>
  <div class="dock">
    <span class="readonly"
      ><AppIcon name="eye" class="icon-sm" />{{ t("common.readonly")
      }}<span class="long"> {{ t("detail.dockLong") }}</span></span
    >
    <div class="dock-actions">
      <label class="switch"
        ><input type="checkbox" role="switch" name="follow" :checked="following" @change="onToggle" />{{
          t("detail.follow")
        }}</label
      >
      <button v-if="!following && newCount > 0" class="btn btn-primary jump-latest" type="button" @click="emit('jump')">
        <AppIcon name="arrow-down" />{{ t("detail.latest")
        }}<span class="badge-new">{{ t("detail.newCount", { n: newCount }) }}</span>
      </button>
    </div>
  </div>
</template>
