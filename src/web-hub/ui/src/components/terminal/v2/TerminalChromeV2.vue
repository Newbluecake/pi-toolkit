<script setup lang="ts">
import { registerTerminalV2Extra } from "../../../i18n/terminal-v2-extra.js";
registerTerminalV2Extra();
import AppIcon from "../../../icons/AppIcon.vue";
import { useI18n } from "../../../composables/useI18n.js";
const { t } = useI18n();
defineProps<{ maximized: boolean; busy: boolean; canRename: boolean }>();
const emit = defineEmits<{
  focus: [];
  rename: [];
  background: [];
  maximize: [];
  font: [step: number];
}>();
</script>
<template>
  <header class="terminal-v2-chrome">
    <strong id="terminal-v2-title"><AppIcon name="terminal" class="icon" /> {{ t("terminalV2.title") }}</strong>
    <div class="terminal-v2-chrome-actions">
      <button
        class="btn btn-ghost"
        type="button"
        data-terminal-focus
        :aria-label="t('terminalV2.focus')"
        @click="emit('focus')"
      >
        <AppIcon name="terminal" class="icon" /><span>{{ t("terminalV2.focus") }}</span>
      </button>
      <button
        class="btn btn-ghost"
        type="button"
        :disabled="busy || !canRename"
        :aria-label="t('terminalV2.rename')"
        :title="t('terminalV2.rename')"
        @click="emit('rename')"
      >
        <AppIcon name="edit" class="icon" /><span>{{ t("terminalV2.rename") }}</span>
      </button>
      <button
        class="btn btn-ghost terminal-v2-font"
        type="button"
        :aria-label="t('terminalV2.smallerFont')"
        @click="emit('font', -1)"
      >
        A−
      </button>
      <button
        class="btn btn-ghost terminal-v2-font"
        type="button"
        :aria-label="t('terminalV2.largerFont')"
        @click="emit('font', 1)"
      >
        A+
      </button>
      <button
        class="btn btn-ghost"
        type="button"
        :aria-pressed="maximized"
        :aria-label="maximized ? t('terminalV2.restore') : t('terminalV2.maximize')"
        @click="emit('maximize')"
      >
        <AppIcon :name="maximized ? 'restore' : 'maximize'" class="icon" />
        <span>{{ maximized ? t("terminalV2.restore") : t("terminalV2.maximize") }}</span>
      </button>
      <button
        class="btn btn-ghost"
        type="button"
        :aria-label="t('terminalV2.collapse')"
        :title="t('terminalV2.collapse')"
        @click="emit('background')"
      >
        <AppIcon name="x" class="icon" />
      </button>
    </div>
  </header>
</template>
