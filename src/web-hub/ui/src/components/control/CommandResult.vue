<!--
  Command result echo (control-plan.md v2.1 §4.9 第 10 条, §7.7 — C5). Renders a
  `CommandOutputWire` as TEXT NODES ONLY (no `v-html`, no innerHTML — source-scan enforced):
  notify rows carry their level badge, widget/status group under their `key` subtitle, text and
  error entries are `<pre>` blocks; any `interactive` entries collapse into the needsTerminal
  line listing the skipped steps; a `truncated` footer reports dropped entries/bytes;
  `captured: false` (third-party extension command) shows the terminal-only note instead.
  `completion: "async"` renders as running until `cmd_late`/`queryOnly` resolves it (the dock
  re-fetches — SSE cmd_late never carries output, §6.6).

  Auto-dismiss (2026-10 user request): ONLY informational, content-less results close on their
  own after 6 s — the terminal-only note (`done` + `captured:false` + no entries) and the equally
  content-less "ran fine, nothing to show" success card (header only). Everything the user must
  read stays until closed by hand: captured output entries, the needsTerminal steps line, the
  truncation footer, the waiting-in-terminal banner, errors, and the running state. The countdown
  pauses while the pointer hovers the card or focus is inside it (resume keeps the remaining
  time); a prop swap (DetailDock replaces the cmdResult object per dispatch) restarts the full
  window; the timer is cleared on unmount. No fade-out: `<Transition>` is source-scan banned
  (rAF, plan §3.5) and removal matches the existing instant manual close.
-->
<script setup lang="ts">
import { computed, onBeforeUnmount, watch } from "vue";
import type { CommandOutputEntry, CommandOutputWire } from "@protocol/messages.js";
import { useI18n } from "../../composables/useI18n.js";
import AppIcon from "../../icons/AppIcon.vue";

const props = defineProps<{
  readonly name: string;
  readonly state: "running" | "done" | "failed";
  readonly output?: CommandOutputWire | null | undefined;
  readonly captured?: boolean | undefined;
  readonly error?: string | undefined;
  readonly message?: string | undefined;
  /** §4.6: a non-ask_user `ui_prompt_start` within 2s of dispatch ⇒ the command is parked on a
   * terminal interaction (third-party commands only — pi-toolkit's own are degraded, §4.9). */
  readonly waitingTerminal?: boolean | undefined;
}>();
const emit = defineEmits<{ dismiss: [] }>();
const { t } = useI18n();

const entries = computed<readonly CommandOutputEntry[]>(() => props.output?.entries ?? []);

const interactiveSteps = computed(() =>
  entries.value.filter((e) => e.kind === "interactive").map((e) => e.title ?? e.text),
);

const visibleEntries = computed(() => entries.value.filter((e) => e.kind !== "interactive"));

const truncatedFooter = computed(() => {
  const tr = props.output?.truncated;
  if (!tr) return null;
  return t("control.cmdOutput.truncated", { entries: tr.droppedEntries, kib: Math.ceil(tr.droppedBytes / 1024) });
});

const showTerminalOnly = computed(
  () => props.state === "done" && props.captured === false && visibleEntries.value.length === 0,
);

// --- auto-dismiss ---------------------------------------------------------------------------

const AUTO_DISMISS_MS = 6_000;

/** The content-less informational shapes: `done` with NOTHING to read — no output entries, no
 * collapsed interactive steps, no truncation footer, not parked on a terminal interaction.
 * Covers both the terminal-only note (`captured:false`) and the bare "ran fine, nothing to
 * show" success card. Anything else (real text, actionable banners, errors, running) stays. */
const autoDismissible = computed(
  () =>
    props.state === "done" &&
    props.waitingTerminal !== true &&
    visibleEntries.value.length === 0 &&
    interactiveSteps.value.length === 0 &&
    truncatedFooter.value === null,
);

let dismissTimer: ReturnType<typeof setTimeout> | undefined;
let dismissAt = 0; // epoch-ms deadline the armed timer fires at
let remainingMs: number | null = null; // null ⇒ no countdown (ineligible, fired, or dismissed)
let hoverHeld = false;
let focusHeld = false;

function clearDismissTimer(): void {
  if (dismissTimer !== undefined) {
    clearTimeout(dismissTimer);
    dismissTimer = undefined;
  }
}

/** Arm the countdown for `remainingMs` (fires at once if it already fully elapsed). No-op when
 * the result is not auto-dismissible or a hover/focus hold is active. */
function scheduleDismiss(): void {
  const ms = remainingMs;
  if (ms === null || !autoDismissible.value || hoverHeld || focusHeld) return;
  if (ms <= 0) {
    remainingMs = null;
    emit("dismiss");
    return;
  }
  dismissAt = Date.now() + ms;
  dismissTimer = setTimeout(() => {
    dismissTimer = undefined;
    remainingMs = null;
    emit("dismiss");
  }, ms);
}

/** A new command result (DetailDock replaces the whole cmdResult object on every dispatch /
 * state transition, so any tracked prop change is a new result) restarts the full window. */
function restartDismiss(): void {
  clearDismissTimer();
  remainingMs = AUTO_DISMISS_MS;
  scheduleDismiss();
}

function pauseDismiss(): void {
  if (dismissTimer === undefined) return;
  clearDismissTimer();
  remainingMs = Math.max(0, dismissAt - Date.now());
}

/** Hover or focus holds the countdown; releasing re-arms whatever time is left. */
function holdChanged(): void {
  if (hoverHeld || focusHeld) pauseDismiss();
  else scheduleDismiss();
}

function onMouseEnter(): void {
  hoverHeld = true;
  holdChanged();
}

function onMouseLeave(): void {
  hoverHeld = false;
  holdChanged();
}

function onFocusIn(): void {
  focusHeld = true;
  holdChanged();
}

function onFocusOut(e: FocusEvent): void {
  // focus hopping BETWEEN elements inside the card must not resume the countdown — only focus
  // leaving the card (relatedTarget null or outside the listener element) releases the hold.
  const scope = e.currentTarget;
  const next = e.relatedTarget;
  if (scope instanceof Node && next instanceof Node && scope.contains(next)) return;
  focusHeld = false;
  holdChanged();
}

function onDismissClick(): void {
  clearDismissTimer(); // the manual close wins; never a second (timer) emit afterwards
  remainingMs = null;
  emit("dismiss");
}

watch(
  () =>
    [props.name, props.state, props.captured, props.output, props.error, props.message, props.waitingTerminal] as const,
  restartDismiss,
  { immediate: true },
);

onBeforeUnmount(() => {
  clearDismissTimer();
  remainingMs = null;
});
</script>

<template>
  <div
    class="command-result"
    :data-state="state"
    @mouseenter="onMouseEnter"
    @mouseleave="onMouseLeave"
    @focusin="onFocusIn"
    @focusout="onFocusOut"
  >
    <div class="command-result-head">
      <AppIcon name="terminal" class="icon-sm" />
      <b translate="no">/{{ name }}</b>
      <span v-if="state === 'running'" class="chip state-chip"
        ><AppIcon name="loader" class="icon-sm spin" />{{ t("control.cmdRunning") }}</span
      >
      <span v-else-if="state === 'failed'" class="chip state-chip" data-policy="deny">{{
        t("control.stateFailed")
      }}</span>
      <button
        class="btn btn-ghost btn-xs command-result-dismiss"
        type="button"
        :aria-label="t('control.discardAria')"
        @click="onDismissClick"
      >
        <AppIcon name="x" class="icon-sm" />
      </button>
    </div>

    <p v-if="waitingTerminal" class="command-waiting-terminal" role="status">
      <AppIcon name="monitor" class="icon-sm" />{{ t("control.cmdWaitingTerminal") }}
    </p>

    <p v-if="state === 'failed'" class="command-error" role="alert">
      {{ message ?? t("control.cmdFailed", { name, error: error ?? "E_FAILED" }) }}
    </p>

    <p v-else-if="showTerminalOnly" class="command-terminal-only">{{ t("control.cmdOutput.terminalOnly") }}</p>

    <div v-else-if="visibleEntries.length > 0" class="command-output">
      <template v-for="(entry, i) in visibleEntries" :key="i">
        <p v-if="entry.kind === 'notify'" class="output-notify">
          <span class="chip" :data-level="entry.level ?? 'info'">{{ entry.level ?? "info" }}</span>
          {{ entry.text }}
        </p>
        <div v-else-if="entry.kind === 'widget' || entry.kind === 'status'" class="output-block">
          <span v-if="entry.key" class="output-key" translate="no">{{ entry.key }}</span>
          <pre>{{ entry.text }}{{ entry.clipped === true ? t("control.cmdOutput.clipped") : "" }}</pre>
        </div>
        <pre v-else :class="{ 'output-error': entry.kind === 'error' }">{{
          entry.text + (entry.clipped === true ? t("control.cmdOutput.clipped") : "")
        }}</pre>
      </template>
    </div>

    <p v-if="interactiveSteps.length > 0" class="command-needs-terminal">
      {{ t("control.cmdOutput.needsTerminal", { steps: interactiveSteps.join(", ") }) }}
    </p>
    <p v-if="truncatedFooter !== null" class="command-truncated">{{ truncatedFooter }}</p>
  </div>
</template>
