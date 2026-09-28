<!--
  Queue list (control-plan.md v2.1 §7.4/§7.7 — C5): sits above the composer, rendering
  `mergeQueue`'s model — local optimistic `pendingCtl` items first, then the server-side queue
  mirror (D6, including terminal-typed entries). Every row carries compact English badges
  (mode `steer`/`follow-up`, source `web`/`terminal`, state) per the UI-text split; the prose
  notes (dropped / unconfirmed / unknown / not-executed) are translated.

  `failed` rows offer Retry / Discard; `notExecuted` (E_UNKNOWN_ID — provably never ran) offers
  Resend (the dock maps it to a NEW id, §7.7) and Discard; `dropped` rows show the one-shot
  "returned to the terminal editor" note until discarded.
-->
<script setup lang="ts">
import { computed } from "vue";
import { clip } from "../../format.js";
import { useI18n } from "../../composables/useI18n.js";
import type { QueueListEmits, QueueListProps } from "../../contracts.js";
import AppIcon from "../../icons/AppIcon.vue";

const props = defineProps<QueueListProps>();
const emit = defineEmits<QueueListEmits>();
const { t } = useI18n();

interface Row {
  readonly key: string;
  readonly text: string;
  readonly mode: string | null; // steer | follow-up badge
  readonly kind: string | null; // non-prompt op label
  readonly source: string | null; // web | terminal
  readonly state: string;
  readonly failed: boolean;
  readonly notExecuted: boolean;
  readonly note: string | null;
}

function asRecord(v: unknown): Record<string, unknown> {
  return v !== null && typeof v === "object" ? (v as Record<string, unknown>) : {};
}

const STATE_KEYS: Readonly<Record<string, string>> = {
  sending: "control.stateSending",
  queued: "control.stateQueued",
  failed: "control.stateFailed",
  dropped: "control.stateDropped",
  unknown: "control.stateUnknown",
  querying: "control.stateQuerying",
  notExecuted: "control.stateNotExecuted",
  unconfirmed: "control.stateUnconfirmed",
  unobserved: "control.stateUnobserved",
  running: "control.stateRunning",
  observed: "control.stateUnobserved",
  started: "control.stateQueued",
};

function stateLabel(state: string): string {
  const key = STATE_KEYS[state];
  return key === undefined ? state : t(key);
}

function noteFor(it: Record<string, unknown>, state: string): string | null {
  if (state === "dropped") return t("control.droppedNote");
  if (state === "unconfirmed" || state === "unobserved" || state === "observed") return t("control.unconfirmedNote");
  if (state === "unknown" || state === "querying")
    return it["offline"] === true ? t("control.offlineNote") : t("control.unknownNote");
  if (state === "notExecuted") return t("control.notExecutedNote");
  if (state === "failed") {
    const err = typeof it["error"] === "string" ? it["error"] : "";
    if (err === "E_SESSION_CHANGED") return t("control.sessionChanged");
    if (err === "E_HUB_RESTARTING") return t("control.hubRestarting");
    if (typeof it["message"] === "string" && it["message"] !== "") return clip(it["message"], 160);
    return err === "" ? null : clip(err, 160);
  }
  return null;
}

const KIND_LABELS: Readonly<Record<string, string>> = {
  abort: "stop",
  steer_subagent: "steer sub",
  abort_subagent: "stop sub",
  dialog_answer: "answer",
  dialog_cancel: "cancel",
};

const rows = computed<readonly Row[]>(() =>
  props.items.map((raw, i) => {
    const it = asRecord(raw);
    const id = typeof it["id"] === "string" ? it["id"] : `row-${i}`;
    const kind = typeof it["kind"] === "string" ? it["kind"] : "prompt";
    const isServerRow = typeof it["source"] === "string"; // D6 mirror entries carry source (cmdId only on web ones)
    const state = isServerRow ? "queued" : typeof it["state"] === "string" ? it["state"] : "sending";
    const deliver =
      typeof it["deliver"] === "string" ? it["deliver"] : typeof it["behavior"] === "string" ? it["behavior"] : null;
    const text =
      typeof it["text"] === "string"
        ? clip(it["text"], 160)
        : kind === "command" && typeof it["name"] === "string"
          ? `/${it["name"]}`
          : "";
    return {
      key: id,
      text,
      mode: deliver === "steer" || deliver === "followUp" ? deliver : null,
      kind: kind === "prompt" ? null : (KIND_LABELS[kind] ?? (kind === "command" ? null : kind)),
      source: isServerRow ? (it["source"] === "tui" ? "terminal" : "web") : "web",
      state,
      failed: state === "failed",
      notExecuted: state === "notExecuted",
      note: noteFor(it, state),
    };
  }),
);
</script>

<template>
  <ul v-if="rows.length > 0" class="queue-list" tabindex="0" :aria-label="t('control.queueAria')">
    <li v-for="row in rows" :key="row.key" class="queue-item" :data-state="row.state">
      <span class="queue-badges">
        <span v-if="row.kind !== null" class="chip" translate="no">{{ row.kind }}</span>
        <span v-if="row.mode === 'steer'" class="chip" translate="no">{{ t("control.badgeSteer") }}</span>
        <span v-else-if="row.mode === 'followUp'" class="chip" translate="no">{{ t("control.badgeFollowUp") }}</span>
        <span class="chip chip-muted" translate="no">{{
          row.source === "terminal" ? t("control.sourceTerminal") : t("control.sourceWeb")
        }}</span>
        <span class="chip state-chip" translate="no">{{ stateLabel(row.state) }}</span>
      </span>
      <span class="queue-text" translate="no">{{ row.text }}</span>
      <span class="queue-actions">
        <template v-if="row.failed || row.notExecuted">
          <button
            class="btn btn-ghost btn-xs"
            type="button"
            :aria-label="row.notExecuted ? t('control.resendAria') : t('control.retryAria')"
            @click="emit('retry', row.key)"
          >
            <AppIcon name="refresh" class="icon-sm" />{{ row.notExecuted ? t("control.resend") : t("control.retry") }}
          </button>
          <button
            class="btn btn-ghost btn-xs"
            type="button"
            :aria-label="t('control.discardAria')"
            @click="emit('discard', row.key)"
          >
            <AppIcon name="x" class="icon-sm" />{{ t("control.discard") }}
          </button>
        </template>
        <button
          v-else-if="row.state === 'dropped'"
          class="btn btn-ghost btn-xs"
          type="button"
          :aria-label="t('control.discardAria')"
          @click="emit('discard', row.key)"
        >
          <AppIcon name="x" class="icon-sm" />{{ t("control.discard") }}
        </button>
      </span>
      <span v-if="row.note !== null" class="queue-note">{{ row.note }}</span>
    </li>
  </ul>
</template>
