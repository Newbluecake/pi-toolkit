<!--
  Fenced code block (ui-design.md §5.4/§6.4, vue-plan.md v2.1 §3.10/§5.2 — P4): a header (language
  tag + copy button) over a horizontally-scrollable `<pre>` capped at 420px tall (mockup's
  `.codeblock pre` rule, `styles/transcript.css`). Copy uses `useClipboard` (P1); on a non-secure
  context (plain-HTTP LAN, ui-design.md §6.4) it falls back to selecting the text via a `Range`
  so the user can still copy manually, with a toast-style status message next to the button.
-->
<script setup lang="ts">
import { computed, onBeforeUnmount, ref } from "vue";
import type { CodeBlockProps } from "../../contracts.js";
import { useCoarseClamp } from "../../composables/useCoarseClamp.js";
import { useClipboard } from "../../composables/useClipboard.js";
import { useI18n } from "../../composables/useI18n.js";
import { resolveFenceLang } from "@logic/highlight.js";
import AppIcon from "../../icons/AppIcon.vue";
import HighlightedCode from "../shared/HighlightedCode.vue";
import ClampToggle from "./ClampToggle.vue";

const props = defineProps<CodeBlockProps>();
const { t } = useI18n();
/** Prism grammar id for the fence info string (unknown ⇒ plain text, DOM unchanged). */
const highlightLang = computed(() => resolveFenceLang(props.lang));

const clipboard = useClipboard(window);
const preEl = ref<HTMLElement | null>(null);
const status = ref<"" | "copied" | "selected">("");
let statusTimer: ReturnType<typeof setTimeout> | undefined;

onBeforeUnmount(() => {
  if (statusTimer !== undefined) clearTimeout(statusTimer);
});

function selectFallback(): void {
  const el = preEl.value;
  if (!el || typeof document.createRange !== "function") return;
  const range = document.createRange();
  range.selectNodeContents(el);
  const sel = window.getSelection();
  sel?.removeAllRanges();
  sel?.addRange(range);
}

async function copy(): Promise<void> {
  const result = await clipboard.copy(props.text);
  if (statusTimer !== undefined) clearTimeout(statusTimer);
  if (result.ok) {
    status.value = "copied";
  } else {
    selectFallback();
    status.value = "selected";
  }
  statusTimer = setTimeout(() => {
    status.value = "";
  }, 2000);
}

/* --- coarse-pointer vertical clamp (2026-10 scroll-freeze fix) ------------------------------
 * `overflow-x: auto` + no explicit overflow-y computes overflow-y to `auto`, so on touch
 * devices this pre IS a nested vertical scroller that latches swipes. The clamp state rides
 * BOTH this pre (vertical clip + cap lift) and the `.codeblock` wrapper (the fade anchor —
 * the wrapper never scrolls horizontally, so the fade stays put while code pans). Horizontal
 * scrolling is untouched: the base `overflow-x: auto` + `overscroll-behavior-x: contain`
 * stay exactly as they are, and code is never force-wrapped. */
const clamp = useCoarseClamp(() => preEl.value, [() => props.text]);
</script>

<template>
  <div class="codeblock" :data-cc="clamp.dataCc">
    <div class="codeblock-head">
      <span translate="no">{{ lang || t("transcript.plainText") }}</span>
      <span v-if="status" class="codeblock-status" role="status">{{
        status === "copied" ? t("transcript.copyCopied") : t("transcript.copySelected")
      }}</span>
      <button class="btn btn-ghost btn-icon" type="button" :aria-label="t('transcript.copyCode')" @click="copy">
        <AppIcon name="copy" />
      </button>
    </div>
    <pre
      ref="preEl"
      translate="no"
      tabindex="0"
      :data-cc="clamp.dataCc"
    ><code><HighlightedCode :text="text" :lang="highlightLang" /></code></pre>
    <ClampToggle :clamp="clamp" />
  </div>
</template>
