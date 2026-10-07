<!--
  Inline sub-agent actions (control-plan.md v2.1 §7.4 — C5, `components/fleet/**`): an expanded
  row panel under a non-terminal fleet row with `Steer…` (single-line input + send ⇒
  `steer_subagent`) and `Stop` (two-step, same grammar as StopButton ⇒ `abort_subagent`).
  Outcomes surface as one inline line (ok / error code + message); the reducer's pendingCtl
  machine owns the long-lived states. The `ControlHandle` comes from the frozen `CONTROL_CTX`
  inject (plan §7.4's provide/inject seam — FleetPanel/DetailBody emits stay untouched); with
  no provider (or `enabled` false) the component renders NOTHING.
-->
<script setup lang="ts">
import { computed, inject, onUnmounted, ref } from "vue";
import { useI18n } from "../../composables/useI18n.js";
import { CONTROL_CTX } from "../../composables/useControl.js";
import type { FleetActionsProps } from "../../contracts.js";
import AppIcon from "../../icons/AppIcon.vue";

const props = defineProps<FleetActionsProps>();
const { t } = useI18n();

const ctx = inject(CONTROL_CTX, null);

const steerText = ref("");
const note = ref<{ kind: "ok" | "err"; text: string } | null>(null);

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

const active = computed(() => ctx !== null && props.enabled && ctx.enabled);

async function onSteerSend(): Promise<void> {
  if (!ctx || !active.value) return;
  const text = steerText.value;
  if (text.trim() === "") return;
  const outcome = await ctx.control.steerSub(props.agentKey, props.runId, text);
  if (outcome.ok) {
    steerText.value = "";
    note.value = { kind: "ok", text: t("control.stateQueued") };
  } else {
    note.value = { kind: "err", text: outcome.message ?? outcome.error ?? "E_FAILED" };
  }
}

function onSteerKeydown(ev: KeyboardEvent): void {
  if (ev.isComposing || ev.keyCode === 229) return;
  if (ev.key === "Enter" && !ev.shiftKey && !ev.altKey) {
    ev.preventDefault();
    void onSteerSend();
  }
}

async function onStopClick(): Promise<void> {
  if (!ctx || !active.value) return;
  if (!armed.value) {
    armed.value = true;
    armTimer = setTimeout(disarm, ARM_MS);
    return;
  }
  disarm();
  const outcome = await ctx.control.stopSub(props.agentKey, props.runId);
  note.value = outcome.ok
    ? { kind: "ok", text: t("common.status.aborted") }
    : { kind: "err", text: outcome.message ?? outcome.error ?? "E_FAILED" };
}

function onStopKeydown(ev: KeyboardEvent): void {
  if (ev.key === "Escape" && armed.value) {
    ev.stopPropagation();
    disarm();
  }
}

onUnmounted(disarm);
</script>

<template>
  <div v-if="ctx && enabled" class="fleet-actions">
    <div class="fleet-steer">
      <input
        v-model="steerText"
        type="text"
        class="fleet-steer-input"
        :placeholder="t('control.placeholderBusy')"
        :aria-label="t('control.sendAria')"
        :disabled="!active"
        @keydown="onSteerKeydown"
      />
      <button
        class="btn btn-ghost btn-xs"
        type="button"
        :disabled="!active || steerText.trim() === ''"
        :aria-label="t('control.sendAria')"
        @click="onSteerSend"
      >
        <AppIcon name="arrow-up" class="icon-sm" /><span class="lbl-md">{{ t("control.send") }}</span>
      </button>
      <button
        class="btn btn-ghost stop-btn btn-xs"
        :class="{ armed }"
        type="button"
        :disabled="!active"
        :data-armed="armed ? 'true' : undefined"
        :aria-label="t('control.stopAria')"
        @click="onStopClick"
        @keydown="onStopKeydown"
      >
        <AppIcon name="ban" class="icon-sm" /><span class="lbl-md">{{
          armed ? t("control.stopConfirm") : t("control.stop")
        }}</span>
      </button>
    </div>
    <p v-if="armed" class="fleet-actions-live sr-only" role="status">{{ t("control.stopArmed") }}</p>
    <p v-if="note" class="fleet-actions-note" :data-kind="note.kind" role="status">{{ note.text }}</p>
  </div>
</template>
