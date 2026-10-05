<!--
  Detail pane header: back button (≤767 only), title, status pill, session info, context/cost
  metrics (ui-design.md §5.2, vue-plan.md v2.1 §3.2, §5.2 — P3 exclusive,
  `components/detail/**`). web-hub-spawn SP12 adds, via `HUB_CTX` inject only (frozen props
  untouched, kept deliberately local so the pending mobile-collapse line can still reflow this
  header freely): the managed session's 「停止会话」 button and the first-prompt refill notice
  (arch §9.1).
-->
<script setup lang="ts">
import { computed, inject, onUnmounted, ref } from "vue";
import AppIcon from "../../icons/AppIcon.vue";
import { agentVisualState } from "../../composables/visual-state.js";
import { useI18n } from "../../composables/useI18n.js";
import { formatUsd } from "../../format.js";
import { managedFor } from "../../logic/spawn.js";
import type { DetailHeaderEmits, DetailHeaderProps } from "../../contracts.js";
import { HUB_CTX } from "../control/controlContext.js";
import "../../styles/spawn.css";
import { cardOf, sessionOf, statusOf } from "./agentViews.js";
import ContextMeter from "./ContextMeter.vue";
import SessionInfo from "./SessionInfo.vue";
import StatusPill from "./StatusPill.vue";

const props = defineProps<DetailHeaderProps>();
const emit = defineEmits<DetailHeaderEmits>();
const { t } = useI18n();

const session = computed(() => sessionOf(props.agent));
const card = computed(() => cardOf(props.agent));
const status = computed(() => statusOf(props.agent));

const visual = computed(() => agentVisualState(props.agent));
const statusLabel = computed(() => t(`common.status.${visual.value}`));

const title = computed(() => {
  const name = session.value?.name;
  if (typeof name === "string" && name !== "") return name;
  const sessionId = session.value?.sessionId;
  return typeof sessionId === "string" && sessionId !== "" ? sessionId.slice(0, 8) : t("agents.noSessionName");
});

const contextUsage = computed(() => status.value?.contextUsage);
const contextMeterProps = computed(() => {
  const usage = contextUsage.value;
  return {
    percent: usage?.percent ?? null,
    ...(usage?.tokens !== undefined ? { tokens: usage.tokens } : {}),
    ...(usage?.contextWindow !== undefined ? { window: usage.contextWindow } : {}),
  };
});
const subCostLabel = computed(() => {
  const sub = status.value?.subagentCostUsd;
  return typeof sub === "number" && sub > 0 ? t("detail.subCost", { v: formatUsd(sub) }) : null;
});

// ---------------------------------------------------------------------------
// web-hub-spawn SP12 (arch §9.1) — additive, inject-only (the frozen DetailHeaderProps stay
// untouched): a spawn record managing THIS agent adds 「停止会话」 (two-step arm, same grammar
// as StopButton) wired to `useSpawn.stop`, and a terminal failed/expired first prompt whose
// body `useNewSession` already put back into the draft surfaces as a one-time dismissible note.
// ---------------------------------------------------------------------------
const hub = inject(HUB_CTX, null);
const managed = computed(() => managedFor(hub?.state.value.spawns ?? null, props.agent.key));

const stopArmed = ref(false);
const stopBusy = ref(false);
const stopError = ref<string | null>(null);
let stopArmTimer: ReturnType<typeof setTimeout> | undefined;
const STOP_ARM_MS = 4000;

function disarmStop(): void {
  stopArmed.value = false;
  if (stopArmTimer !== undefined) {
    clearTimeout(stopArmTimer);
    stopArmTimer = undefined;
  }
}

async function onStopSession(): Promise<void> {
  const rec = managed.value;
  const spawn = hub?.spawn;
  if (rec === undefined || spawn === undefined || stopBusy.value || rec.state === "stopping") return;
  if (!stopArmed.value) {
    stopArmed.value = true;
    stopArmTimer = setTimeout(disarmStop, STOP_ARM_MS);
    return;
  }
  disarmStop();
  stopBusy.value = true;
  stopError.value = null;
  try {
    const outcome = await spawn.stop(rec.spawnId);
    if (!outcome.ok) stopError.value = outcome.error ?? "E_FAILED";
  } finally {
    stopBusy.value = false;
  }
}

function onStopKeydown(ev: KeyboardEvent): void {
  if (ev.key === "Escape" && stopArmed.value) {
    ev.stopPropagation();
    disarmStop();
  }
}

onUnmounted(disarmStop);

/** One-time first-prompt notice: keyed by spawnId, dismissed per record (一次性). */
const fpNotice = computed(() => {
  const flow = hub?.spawn?.newSession.flow.value;
  if (flow === undefined) return null;
  if (
    flow.phase === "done" &&
    flow.agentKey === props.agent.key &&
    flow.firstPrompt !== undefined &&
    (flow.firstPrompt.state === "failed" || flow.firstPrompt.state === "expired") &&
    flow.firstPrompt.refilled === "draft"
  ) {
    return { id: flow.spawnId, state: flow.firstPrompt.state };
  }
  if (flow.phase === "failed" && flow.agentKey === props.agent.key && flow.refilled === "draft") {
    return { id: flow.spawnId ?? flow.reqId ?? "", state: flow.code ?? flow.kind };
  }
  return null;
});
const fpDismissedId = ref<string | null>(null);
const fpNoticeVisible = computed(() => fpNotice.value !== null && fpNotice.value.id !== fpDismissedId.value);
</script>

<template>
  <header class="detail-head">
    <div class="detail-titlebar">
      <button
        v-if="narrow"
        class="btn btn-ghost detail-back"
        type="button"
        :aria-label="t('common.backToAgents')"
        @click="emit('back')"
      >
        <AppIcon name="chev-left" class="icon-lg" />
      </button>
      <h2 class="detail-title" id="detail-title">{{ title }}</h2>
      <StatusPill :state="visual" :label="statusLabel" />
      <button
        v-if="managed"
        class="btn spawn-stop-btn"
        :class="{ armed: stopArmed }"
        type="button"
        :disabled="stopBusy || managed.state === 'stopping'"
        :aria-label="t('spawn.stopSessionAria')"
        @click="onStopSession"
        @keydown="onStopKeydown"
      >
        <AppIcon name="ban" class="icon-sm" />
        {{
          managed.state === "stopping"
            ? t("spawn.stopSessionStopping")
            : stopArmed
              ? t("spawn.stopSessionConfirm")
              : t("spawn.stopSession")
        }}
      </button>
    </div>

    <p v-if="stopError" class="spawn-stop-note" role="alert">
      {{ t("spawn.stopSessionFailed", { code: stopError }) }}
    </p>
    <p v-if="fpNoticeVisible && fpNotice" class="spawn-fp-note" role="status">
      {{ t("spawn.fpRefilled", { state: fpNotice.state }) }}
      <button class="btn btn-ghost btn-xs" type="button" @click="fpDismissedId = fpNotice.id">
        {{ t("spawn.fpRefilledDismiss") }}
      </button>
    </p>

    <SessionInfo :session="session" :card="card" />

    <dl class="metrics">
      <div class="metric">
        <dt>{{ t("detail.contextLabel") }}</dt>
        <dd>
          <ContextMeter v-bind="contextMeterProps" />
        </dd>
      </div>
      <div class="metric">
        <dt>{{ t("detail.costLabel") }}</dt>
        <dd>
          {{ formatUsd(status?.costUsd) }}
          <span v-if="subCostLabel" class="aside">{{ subCostLabel }}</span>
        </dd>
      </div>
    </dl>
  </header>
</template>
