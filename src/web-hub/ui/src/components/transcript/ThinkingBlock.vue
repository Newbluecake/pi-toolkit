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
import { computed, ref, watch } from "vue";
import { useCoarseClamp } from "../../composables/useCoarseClamp.js";
import { useI18n } from "../../composables/useI18n.js";
import ClampToggle from "./ClampToggle.vue";

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

/* --- streaming follow (2026-10-08 user request) -------------------------------------------
 * While the block is live, keep the scroll-capped `.thinking-text` panel pinned to the latest
 * line. Any USER scroll inside the panel flips `sticky` by position: scrolled up ⇒ stop
 * following (the model can't fight the reader); scrolled back to the bottom ⇒ resume — the
 * same near-bottom semantics as the transcript's own follow scroll (`useFollowScroll.ts`).
 * Our own scrollTop write would fire a `scroll` event indistinguishable from a user drag, so
 * it carries a one-shot `suppressScroll` token the handler consumes (mirrors Transcript.vue's
 * restore-token pattern). */
const FOLLOW_THRESHOLD_PX = 24;
const body = ref<HTMLElement | null>(null);
const sticky = ref(true);
let suppressScroll = false;

function onBodyScroll(): void {
  const el = body.value;
  if (!el) return;
  if (suppressScroll) {
    suppressScroll = false;
    return;
  }
  sticky.value = el.scrollHeight - el.scrollTop - el.clientHeight <= FOLLOW_THRESHOLD_PX;
}

watch(
  () => [props.text, isOpen.value] as const,
  () => {
    if (props.live !== true || !sticky.value || !isOpen.value) return;
    const el = body.value;
    if (!el) return;
    suppressScroll = true;
    el.scrollTop = el.scrollHeight;
  },
  { immediate: true, flush: "post" },
);

/* --- coarse-pointer clamp (2026-10 scroll-freeze fix) -------------------------------------
 * On touch devices `.thinking-text` must not be its own scrollport (gesture latching freezes
 * the transcript): `useCoarseClamp` clamps it with `overflow: hidden` + fade + the toggle
 * below, and "expanded" drops the cap so the text flows with the page. The streaming follow
 * above is unaffected — under a clamp there is nothing to scroll (its scrollTop writes no-op). */
const clamp = useCoarseClamp(() => body.value, [() => props.text, () => isOpen.value]);
</script>

<template>
  <details class="thinking" :open="isOpen">
    <summary @click="onSummaryClick">
      <span>{{ t("transcript.thinking", { n: lineCount }) }}</span>
    </summary>
    <div ref="body" class="thinking-text" :data-cc="clamp.dataCc" @scroll.passive="onBodyScroll">{{ shown }}</div>
    <ClampToggle :clamp="clamp" />
  </details>
</template>
