<!--
  Queue list (control-plan.md v2.1 §7.4/§7.7 — C5): sits above the composer, rendering
  `mergeQueue`'s model — local optimistic `pendingCtl` items first, then the server-side queue
  mirror (D6, including terminal-typed entries). Every row carries compact English badges
  (mode `steer`/`follow-up`, source `web`/`terminal`, state) per the UI-text split; the prose
  notes (dropped / unconfirmed / unknown / not-executed) are translated.

  `failed` rows offer Retry / Discard; `notExecuted` (E_UNKNOWN_ID — provably never ran) offers
  Resend (the dock maps it to a NEW id, §7.7) and Discard; `dropped` rows show the one-shot
  "returned to the terminal editor" note until discarded.

  steer-recall (web-hub-steer-recall plan §7, P-ui): hold rows (`held` / `returned` /
  `recalling` / `handed` / `tooLate`) render as their own row type. While `holdLink === "live"`
  (and the row's own mode is `recallable` — a `gone` row stays copy-only even then, Y2) a held
  row offers 撤回 (recall → composer) and a returned row offers edit + discard; an unavailable
  row offers ONLY copy (the local original text when the dock has it, else the wire's 200-char
  clip) plus the holdUnavailable note — never recallable from a stale view (an edit-resend
  could double-deliver once the agent hands the buffered copy to pi). `tooLate` is the
  undifferentiated "already delivered / recalled elsewhere" state (arch §11 Q5): handed-style
  chip + copy. Buttons are native (Enter/Space) and disabled + aria-disabled while recalling.
-->
<script setup lang="ts">
import { computed } from "vue";
import { clip } from "../../format.js";
import { HOLD_ROW_STATES } from "@logic/control.js";
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
  // --- hold rows (steer-recall §7) ---
  readonly holdRow: boolean;
  /** "recallable" | "unavailable" — the row's own mode (a gone/scope-stale row is copy-only). */
  readonly holdMode: "recallable" | "unavailable";
  /** The buffer state under a recall join — decides which buttons render while `recalling`. */
  readonly holdBase: string | null;
  readonly reason: string | null;
  readonly prevSession: boolean;
  readonly recalling: boolean;
  /** The data-state actually rendered (unavailable/tooLate collapse to their visual states). */
  readonly dataState: string;
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

const HOLD_STATE_KEYS: Readonly<Record<string, string>> = {
  held: "control.stateHeld",
  recalling: "control.stateRecalling",
  returned: "control.stateReturned",
  handed: "control.stateHanded",
  tooLate: "control.stateHanded", // Q5: undifferentiated "already delivered" look
};

function stateLabel(state: string): string {
  const key = STATE_KEYS[state];
  return key === undefined ? state : t(key);
}

function holdStateLabel(state: string): string {
  const key = HOLD_STATE_KEYS[state];
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

/** §7's returned-reason notes; an unknown reason degrades to the generic stale note. */
function returnedNote(reason: string | null): string {
  if (reason === "aborted") return t("control.returnedAborted");
  if (reason === "session") return t("control.returnedSession");
  if (reason === "reload") return t("control.returnedReload");
  return t("control.returnedStale");
}

function holdNote(state: string, holdMode: string, reason: string | null): string | null {
  if (holdMode === "unavailable") return t("control.holdUnavailable");
  switch (state) {
    case "held":
    case "recalling":
      return t("control.heldNote");
    case "returned":
      return returnedNote(reason);
    case "handed":
      return t("control.handedNote");
    case "tooLate":
      return t("control.tooLate");
    default:
      return null;
  }
}

const KIND_LABELS: Readonly<Record<string, string>> = {
  abort: "stop",
  steer_subagent: "steer sub",
  abort_subagent: "stop sub",
  dialog_answer: "answer",
  dialog_cancel: "cancel",
};

const rows = computed<readonly Row[]>(() => {
  const holdEnabled = props.holdEnabled !== false;
  const linkMode: "recallable" | "unavailable" = props.holdLink === "live" ? "recallable" : "unavailable";
  const out: Row[] = [];
  for (let i = 0; i < props.items.length; i++) {
    const it = asRecord(props.items[i]);
    const id = typeof it["id"] === "string" ? it["id"] : `row-${i}`;
    const kind = typeof it["kind"] === "string" ? it["kind"] : "prompt";
    const isServerRow = typeof it["source"] === "string"; // D6 mirror entries carry source (cmdId only on web ones)
    const state = isServerRow ? "queued" : typeof it["state"] === "string" ? it["state"] : "sending";
    if (!holdEnabled && HOLD_ROW_STATES.has(state)) continue; // pre-feature peers: no hold chrome at all
    if (kind === "prompt" && HOLD_ROW_STATES.has(state)) {
      // Hold row (steer-recall §7): from the status.held snapshot (held:true) or this tab's
      // own optimistic item. Per-row mode beats the list-level link — mergeQueue marks `gone`
      // (absent from the newest same-scope snapshot, Y2's ctl-truncation ruling) and
      // scope-stale rows copy-only even while everything else is recallable.
      const mode: "recallable" | "unavailable" =
        it["mode"] === "recallable" || it["mode"] === "unavailable"
          ? (it["mode"] as "recallable" | "unavailable")
          : linkMode;
      const unavailable = mode === "unavailable";
      const base = it["holdBase"] === "returned" || it["holdBase"] === "held" ? (it["holdBase"] as string) : null;
      const deliver =
        typeof it["deliver"] === "string" ? it["deliver"] : typeof it["behavior"] === "string" ? it["behavior"] : null;
      const text = typeof it["text"] === "string" ? clip(it["text"], 160) : "";
      const reason = typeof it["reason"] === "string" ? it["reason"] : null;
      out.push({
        key: id,
        text,
        mode: deliver === "steer" || deliver === "followUp" ? deliver : null,
        kind: null,
        source: "web",
        state,
        failed: false,
        notExecuted: false,
        note: holdNote(state, mode, reason),
        holdRow: true,
        holdMode: mode,
        holdBase: base ?? (state === "returned" ? "returned" : "held"),
        reason,
        prevSession: it["prevSession"] === true,
        recalling: state === "recalling",
        dataState: unavailable ? "unavailable" : state === "tooLate" ? "handed" : state,
      });
      continue;
    }
    const text =
      typeof it["text"] === "string"
        ? clip(it["text"], 160)
        : kind === "command" && typeof it["name"] === "string"
          ? `/${it["name"]}`
          : "";
    out.push({
      key: id,
      text,
      mode:
        typeof it["deliver"] === "string" ? it["deliver"] : typeof it["behavior"] === "string" ? it["behavior"] : null,
      kind: kind === "prompt" ? null : (KIND_LABELS[kind] ?? (kind === "command" ? null : kind)),
      source: isServerRow ? (it["source"] === "tui" ? "terminal" : "web") : "web",
      state,
      failed: state === "failed",
      notExecuted: state === "notExecuted",
      note: noteFor(it, state),
      holdRow: false,
      holdMode: "unavailable",
      holdBase: null,
      reason: null,
      prevSession: false,
      recalling: false,
      dataState: state,
    });
  }
  return out;
});

/** aria labels carry the text prefix (first ~40 chars) so a screen reader can tell rows apart. */
function ariaText(row: Row): string {
  return clip(row.text, 40);
}

/** The chip label: an unavailable row shows the UNAVAILABLE token (its underlying buffer state
 * stays visible through the note); tooLate shows the handed token (Q5's shared 已交付 look). */
function holdChipState(row: Row): string {
  if (row.holdMode === "unavailable") return "unavailable";
  if (row.state === "tooLate") return "handed";
  return row.state;
}

/** Recall/edit render only while the row is still actionable (held/returned/recalling) — a
 * terminal handed/tooLate row offers at most copy. */
function actionable(row: Row): boolean {
  return row.state === "held" || row.state === "returned" || row.state === "recalling";
}

/** Copy renders for unavailable rows and tooLate — the ONLY action a stale row ever offers. */
function showCopy(row: Row): boolean {
  return row.holdMode === "unavailable" || row.state === "tooLate";
}
</script>

<template>
  <ul v-if="rows.length > 0" class="queue-list" tabindex="0" :aria-label="t('control.queueAria')">
    <li v-for="row in rows" :key="row.key" class="queue-item" :data-state="row.dataState">
      <template v-if="row.holdRow">
        <span class="queue-badges">
          <span v-if="row.mode === 'steer'" class="chip" translate="no">{{ t("control.badgeSteer") }}</span>
          <span v-else-if="row.mode === 'followUp'" class="chip" translate="no">{{ t("control.badgeFollowUp") }}</span>
          <span class="chip chip-muted" translate="no">{{ t("control.sourceWeb") }}</span>
          <span class="chip state-chip" translate="no">{{ holdStateLabel(holdChipState(row)) }}</span>
        </span>
        <span class="queue-text" translate="no">{{ row.text }}</span>
        <span class="queue-actions">
          <template v-if="row.holdMode === 'recallable' && actionable(row)">
            <button
              v-if="row.holdBase === 'held'"
              class="btn btn-ghost btn-xs"
              type="button"
              data-recall
              :disabled="row.recalling"
              :aria-disabled="row.recalling"
              :aria-label="t('control.recallAria', { text: ariaText(row) })"
              @click="emit('recall', row.key)"
            >
              <AppIcon name="arrow-up" class="icon-sm" />{{ t("control.recall") }}
            </button>
            <template v-else-if="row.holdBase === 'returned'">
              <button
                class="btn btn-ghost btn-xs"
                type="button"
                data-edit
                :disabled="row.recalling"
                :aria-disabled="row.recalling"
                :aria-label="t('control.editAria', { text: ariaText(row) })"
                @click="emit('edit', row.key)"
              >
                <AppIcon name="arrow-up" class="icon-sm" />{{ t("control.edit") }}
              </button>
              <button
                class="btn btn-ghost btn-xs"
                type="button"
                data-discard-held
                :disabled="row.recalling"
                :aria-disabled="row.recalling"
                :aria-label="t('control.discardHeldAria')"
                @click="emit('discardHeld', row.key)"
              >
                <AppIcon name="x" class="icon-sm" />{{ t("control.discard") }}
              </button>
            </template>
          </template>
          <button
            v-if="showCopy(row)"
            class="btn btn-ghost btn-xs"
            type="button"
            data-copy-held
            :aria-label="t('control.copyHeldAria')"
            @click="emit('copyHeld', row.key)"
          >
            <AppIcon name="copy" class="icon-sm" />{{ t("control.copyHeld") }}
          </button>
        </span>
        <span v-if="row.note !== null" class="queue-note">{{ row.note }}</span>
        <span v-if="row.prevSession" class="queue-note">{{ t("control.previousSession") }}</span>
      </template>
      <template v-else>
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
      </template>
    </li>
  </ul>
</template>
