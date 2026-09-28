<!--
  Top bar: brand, connection pill, hub version, read-only chip, theme toggle, sign out
  (vue-plan.md v2.1 §3.2, §7, §5.2 — P3 exclusive, `components/shell/**`). `TopBarProps` is
  frozen with no `user`/username field (`contracts.ts`), so — unlike the static mockup, which
  also showed a `.user-chip` — this build has no username slot to render; §7's connection pill
  states are otherwise ported verbatim (states.html: `connecting` = spinning loader icon,
  `open`/`reconnecting` = the same live dot, `auth` = an unlock icon with no dot).
-->
<script setup lang="ts">
import { computed } from "vue";
import AppIcon from "../../icons/AppIcon.vue";
import { useI18n } from "../../composables/useI18n.js";
import { UI_BUILD } from "../../build-info.js";
import { uiBuildStamp } from "@logic/build-stamp.js";
import type { TopBarEmits, TopBarProps } from "../../contracts.js";
import ThemeToggle from "./ThemeToggle.vue";

const props = defineProps<TopBarProps>();
const emit = defineEmits<TopBarEmits>();
const { t } = useI18n();

const connLabelKey = computed(() => `shell.conn.${props.conn}`);
const uiStamp = computed(() => uiBuildStamp(UI_BUILD));
</script>

<template>
  <header class="topbar">
    <span class="brand">
      <span class="brand-mark" aria-hidden="true"><AppIcon name="logo" /></span>
      <span translate="no">pi web-hub</span>
    </span>

    <span class="pill conn" :data-conn="conn" role="status">
      <AppIcon v-if="conn === 'connecting'" name="loader" class="icon-sm spin" />
      <AppIcon v-else-if="conn === 'auth'" name="unlock" class="icon-sm" />
      <span v-else class="dot dot-live"></span>
      {{ t(connLabelKey) }}
    </span>

    <span v-if="hubVersion" class="topbar-meta" translate="no">{{ t("shell.hubVersion", { v: hubVersion }) }}</span>
    <span v-if="uiStamp" class="topbar-meta" translate="no">{{ t("shell.uiBuild", { v: uiStamp }) }}</span>
    <span class="chip"><AppIcon name="eye" class="icon-sm" />{{ t("common.readonly") }}</span>

    <span class="topbar-spacer"></span>

    <ThemeToggle :model-value="theme" @update:model-value="emit('update:theme', $event)" />

    <button
      v-if="canSignOut"
      class="btn btn-ghost"
      type="button"
      :aria-label="t('shell.signOut')"
      @click="emit('signout')"
    >
      <AppIcon name="logout" />
      <span class="lbl-md" aria-hidden="true">{{ t("shell.signOut") }}</span>
    </button>
  </header>
</template>
