<!--
  "Thinking" block (ui-design.md §5.4): a pill summary "✦ Thinking · N lines ›" around the raw
  thinking text in a scroll-capped, left-bordered panel (`styles/transcript.css`'s
  `.thinking-text`, max 320px). Plain text only — thinking content is never markdown-rendered
  (matches the legacy vanilla-DOM behavior, `render/transcript.js`'s
  `pre(doc, "thinking-text", b.thinking)`).

  Openness is semi-controlled, not fully: while `live` (this block is the one currently
  streaming, see `TxAssistant.vue`) it defaults open so the user can watch the model think in
  real time; once it stops being live it auto-collapses UNLESS the text is short enough to be
  worth leaving open (`AUTO_COLLAPSE_LINES`/`AUTO_COLLAPSE_CHARS`). A manual click on the
  `<summary>` at any point (live or not) overrides every future auto-decision for this block's
  lifetime in the DOM — `manualOverride` is never reset, so the model can't fight a choice the
  user already made.
-->
<script setup lang="ts">
import { computed, ref } from "vue";
import { useI18n } from "../../composables/useI18n.js";

/** Thresholds above which a finished thinking block auto-collapses instead of staying open. */
const AUTO_COLLAPSE_LINES = 12;
const AUTO_COLLAPSE_CHARS = 600;

const props = defineProps<{ readonly text: string; readonly live?: boolean }>();
const { t } = useI18n();

/**
 * Models (notably Claude) end thinking with a trailing `\n\n`; under `white-space: pre-wrap` that
 * renders as a visible blank line and inflates the line count. Leading/trailing blank space is
 * never meaningful in thinking prose, so trim it for both display and counting.
 */
const shown = computed(() => props.text.trim());
const lineCount = computed(() => (shown.value === "" ? 0 : shown.value.split("\n").length));
const isLong = computed(() => lineCount.value > AUTO_COLLAPSE_LINES || shown.value.length > AUTO_COLLAPSE_CHARS);

/** `undefined` until the user toggles it by hand; once set, auto logic never touches `isOpen` again. */
const manualOverride = ref<boolean | undefined>(undefined);
/** Auto-derived openness: force open while live; once it stops, collapse only if long. */
const autoOpen = computed(() => props.live === true || !isLong.value);
const isOpen = computed(() => manualOverride.value ?? autoOpen.value);

function onSummaryClick(e: MouseEvent): void {
  // Drive openness entirely from `isOpen` (manual-or-auto) instead of letting the browser's
  // native `<details>` toggle behavior run: a native `toggle` event fires for ANY open-state
  // change, including the ones Vue itself makes when `:open` is patched (e.g. forcing it open on
  // `live`), so listening on `toggle` can't tell "the user clicked" apart from "the binding
  // changed" and would wrongly freeze `manualOverride` on every automatic flip. A click on the
  // summary is unambiguously a user gesture (Enter/Space on a focused `<summary>` also
  // synthesizes one), so intercept it here instead.
  e.preventDefault();
  manualOverride.value = !isOpen.value;
}
</script>

<template>
  <details class="thinking" :open="isOpen">
    <summary @click="onSummaryClick">
      <span>{{ t("transcript.thinking", { n: lineCount }) }}</span>
    </summary>
    <div class="thinking-text">{{ shown }}</div>
  </details>
</template>
