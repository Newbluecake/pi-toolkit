<script setup lang="ts">
import { registerTerminalExtra } from "../../i18n/terminal-extra.js";
registerTerminalExtra();
import AppIcon from "../../icons/AppIcon.vue";
import { useI18n } from "../../composables/useI18n.js";
const { t } = useI18n();
defineProps<{ maximized: boolean; busy: boolean; attached: boolean }>();
const emit = defineEmits<{ focus: []; list: []; background: []; maximize: []; font: [step: number]; terminate: [] }>();
</script>
<template>
  <header class="terminal-chrome">
    <strong><AppIcon name="terminal" class="icon" /> {{ t("terminal.title") }}</strong>
    <button class="btn btn-ghost" data-terminal-focus @click="emit('focus')">{{ t("terminal.focus") }}</button>
    <button class="btn btn-ghost" :disabled="busy" @click="emit('list')">{{ t("terminal.list") }}</button>
    <button class="btn btn-ghost" :disabled="busy" @click="emit('background')">{{ t("terminal.background") }}</button>
    <button class="btn btn-ghost" :aria-label="t('terminal.smallerFont')" @click="emit('font', -1)">A−</button>
    <button class="btn btn-ghost" :aria-label="t('terminal.largerFont')" @click="emit('font', 1)">A+</button>
    <button class="btn btn-ghost" :aria-pressed="maximized" @click="emit('maximize')">
      <AppIcon :name="maximized ? 'restore' : 'maximize'" class="icon" /><span>{{
        maximized ? t("terminal.restore") : t("terminal.maximize")
      }}</span>
    </button>
    <button class="btn btn-ghost" :disabled="busy || !attached" @click="emit('terminate')">
      {{ t("terminal.terminate") }}
    </button>
  </header>
</template>
