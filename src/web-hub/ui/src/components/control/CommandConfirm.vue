<!--
  Inline two-step confirmation for `E_CONFIRM_REQUIRED` commands (control-plan.md v2.1
  §4.6/§7.7 — C5). Same interaction grammar as `StopButton`: first click arms (danger colour,
  4s auto-revert, Esc reverts, `aria-live` announcement), second click emits `confirm` — the
  dock then re-issues `runCommand` with a NEW id and `confirm: true` (§4.6: confirmation is UX
  anti-misclick, not a security boundary). `cancel` drops the pending command entirely.
-->
<script setup lang="ts">
import { computed, onUnmounted, ref } from "vue";
import { useI18n } from "../../composables/useI18n.js";
import AppIcon from "../../icons/AppIcon.vue";

const props = defineProps<{
  readonly name: string;
  readonly args: string;
  readonly message?: string | undefined;
}>();
const emit = defineEmits<{ confirm: []; cancel: [] }>();
const { t } = useI18n();

const ARM_MS = 4000;

const armed = ref(false);
let armTimer: ReturnType<typeof setTimeout> | undefined;

function disarm(): void {
  armed.value = false;
  if (armTimer !== undefined) {
    clearTimeout(armTimer);
    armTimer = undefined;
  }
}

function onConfirmClick(): void {
  if (!armed.value) {
    armed.value = true;
    armTimer = setTimeout(disarm, ARM_MS);
    return;
  }
  disarm();
  emit("confirm");
}

function onKeydown(ev: KeyboardEvent): void {
  if (ev.key === "Escape") {
    ev.stopPropagation();
    if (armed.value) disarm();
    else emit("cancel");
  }
}

onUnmounted(disarm);

const commandLabel = computed(() => `/${props.name}${props.args !== "" ? ` ${props.args}` : ""}`);
</script>

<template>
  <div class="command-confirm" role="group" :aria-label="t('control.cmdConfirm', { name })" @keydown="onKeydown">
    <AppIcon name="alert" class="icon-sm" />
    <span class="command-confirm-text">
      <b translate="no">{{ commandLabel }}</b>
      <span class="command-confirm-msg">{{ message ?? t("control.cmdConfirm", { name }) }}</span>
      <span class="command-confirm-hint">{{ t("control.cmdConfirmHint") }}</span>
    </span>
    <button
      class="btn btn-danger command-confirm-run"
      :class="{ armed }"
      type="button"
      :data-armed="armed ? 'true' : undefined"
      @click="onConfirmClick"
    >
      {{ armed ? t("control.cmdConfirm", { name }) : t("control.send") }}
    </button>
    <button class="btn btn-ghost" type="button" @click="emit('cancel')">{{ t("dialog.cancel") }}</button>
    <span v-if="armed" class="sr-only" role="status">{{ t("control.cmdConfirmHint") }}</span>
  </div>
</template>
