<!--
  Copy-to-clipboard icon button (ui-design.md §6.4, §12, §13, vue-plan.md v2.1 §3.2, §5.2 — P3
  exclusive, `components/detail/**`). Used inside `SessionInfo.vue`'s `.kv` rows. On a secure
  context, copies `value` via `useClipboard` (P1) and flashes a check icon; on plain-HTTP LAN
  (`isSecureContext === false`, ui-design §6.4/§6.7's documented case) or any other clipboard
  failure, falls back to selecting an off-screen copy of the text (so a manual Ctrl/Cmd+C still
  works) and announces "Selected — press Copy" instead of silently doing nothing.
-->
<script setup lang="ts">
import { onScopeDispose, ref } from "vue";
import AppIcon from "../../icons/AppIcon.vue";
import { useClipboard } from "../../composables/useClipboard.js";
import { useI18n } from "../../composables/useI18n.js";
import type { CopyButtonProps } from "../../contracts.js";

const props = defineProps<CopyButtonProps>();
const { t } = useI18n();

type Feedback = "idle" | "copied" | "selected";
const feedback = ref<Feedback>("idle");
let resetTimer: ReturnType<typeof setTimeout> | undefined;

function scheduleReset(): void {
  if (resetTimer !== undefined) clearTimeout(resetTimer);
  resetTimer = setTimeout(() => {
    feedback.value = "idle";
  }, 2000);
}

/** Off-screen (not `display: none` — a `Range` can't select that) selectable copy of `text`,
 * removed a few seconds later. */
function selectFallback(text: string): void {
  const span = document.createElement("span");
  span.textContent = text;
  span.style.position = "fixed";
  span.style.top = "0";
  span.style.left = "0";
  span.style.opacity = "0";
  span.style.pointerEvents = "none";
  document.body.appendChild(span);
  const range = document.createRange();
  range.selectNodeContents(span);
  const sel = window.getSelection();
  sel?.removeAllRanges();
  sel?.addRange(range);
  setTimeout(() => {
    span.remove();
  }, 5000);
}

async function onClick(): Promise<void> {
  const clipboard = useClipboard(window);
  const res = await clipboard.copy(props.value);
  if (res.ok) {
    feedback.value = "copied";
  } else {
    selectFallback(props.value);
    feedback.value = "selected";
  }
  scheduleReset();
}

onScopeDispose(() => {
  if (resetTimer !== undefined) clearTimeout(resetTimer);
});
</script>

<template>
  <span>
    <button class="btn btn-ghost btn-icon" type="button" :aria-label="label" @click="onClick">
      <AppIcon v-if="feedback === 'idle'" name="copy" />
      <AppIcon v-else name="check" />
    </button>
    <span class="sr-only" role="status">{{
      feedback === "copied" ? t("common.copied") : feedback === "selected" ? t("common.selectedPressCopy") : ""
    }}</span>
  </span>
</template>
