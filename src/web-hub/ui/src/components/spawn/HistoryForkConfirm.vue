<!--
  HistoryForkConfirm — the fork warning inside SessionHistoryDialog (session-history plan
  §4.7.2 / arch §7.4). Two very different producers share this one view:

  - the useNewSession 409 `{reason:"session-open"}` confirm (the hub refused an in-place
    resume because occupancy was detected / could not be excluded) — `reason`/`by`/`gap`
    come from the wire, and confirming calls `useNewSession.confirm()`, which switches the
    SAME id to `mode:"fork"` (plan §4.7.1);
  - the row action 「复制为新会话」 (user-chosen fork, incl. `forkOnly` rows) — `reason` is
    the item's advisory `forkOnly` or the pseudo-reason `"manual"`; confirming submits
    `{session:{…, mode:"fork"}}`, which `useNewSession` sends in ONE shot with
    `confirm:true, expectCwd` (PD17 — this local confirm is the only one).

  Pure presentation: the body key comes from `forkConfirmKey(reason, by, gap)` and the
  `{gap}` placeholder of the unverified body from `historyGapKey(gap)` (`@logic/
  sessionHistory.ts`); every string renders through interpolation ⇒ textContent, never HTML.
  The bottom re-renders the SAME W1–W7 best-effort small print the dialog shows
  (`history.bestEffortNote`), plus the LAN plaintext warning when `plaintext`.
-->
<script setup lang="ts">
import { computed, onMounted, ref } from "vue";
import type { ForkReason, HistoryLiveWire, ProofGap } from "@protocol/session-history.js";
import { useI18n } from "../../composables/useI18n.js";
import { forkConfirmKey, historyGapKey } from "../../logic/sessionHistory.js";
import "../../styles/history.css";

const props = defineProps<{
  /** The fork reason (`ForkReason`) or the local pseudo-reason `"manual"` (user-chosen fork). */
  readonly reason: ForkReason | "manual";
  /** `HistoryLiveWire.by` — distinguishes open/card from open/managed (absent for subagent/unverified). */
  readonly by?: HistoryLiveWire["by"] | undefined;
  readonly gap?: ProofGap | undefined;
  /** `live.pid` — fills the {pid} placeholder of the pid-carrying bodies. */
  readonly pid?: number | undefined;
  /** LAN plaintext HTTP ⇒ the permanent warning line (same rule as SpawnConfirm). */
  readonly plaintext: boolean;
  /** Resend/submit in flight (useNewSession is back in `submitting`). */
  readonly busy?: boolean;
}>();
const emit = defineEmits<{ confirm: []; cancel: [] }>();
const { t } = useI18n();

const pidText = computed(() => (typeof props.pid === "number" ? String(props.pid) : "?"));

/** The `{gap}` fragment of the unverified body — every ProofGap has its own line (§4.7.2). */
const gapText = computed(() => {
  const key = historyGapKey(props.gap);
  return key !== undefined ? t(key, { pid: pidText.value }) : t("history.gapProcPartial");
});

const bodyText = computed(() =>
  t(forkConfirmKey(props.reason, props.by, props.gap), { pid: pidText.value, gap: gapText.value }),
);

// The confirm view replaces the dialog's form — focus its primary action so a keyboard user
// can Enter straight away (the swap dropped whatever was focused before). Non-DOM harnesses
// (and a `busy` resend, where the buttons are disabled) skip the grab.
const runBtn = ref<HTMLButtonElement | null>(null);
onMounted(() => {
  if (props.busy !== true) runBtn.value?.focus();
});
</script>

<template>
  <div class="spawn-confirm" role="group" :aria-label="t('history.forkTitle')">
    <h3 class="spawn-confirm-title">{{ t("history.forkTitle") }}</h3>
    <p class="spawn-confirm-body">{{ bodyText }}</p>
    <p v-if="plaintext" class="spawn-plain-warning" role="note">{{ t("spawn.confirmPlaintext") }}</p>
    <p class="history-besteffort" role="note">{{ t("history.bestEffortNote") }}</p>
    <div class="spawn-confirm-actions">
      <button class="btn btn-ghost" type="button" :disabled="busy === true" @click="emit('cancel')">
        {{ t("dialog.cancel") }}
      </button>
      <button ref="runBtn" class="btn btn-primary" type="button" :disabled="busy === true" @click="emit('confirm')">
        {{ t("history.forkRun") }}
      </button>
    </div>
  </div>
</template>
