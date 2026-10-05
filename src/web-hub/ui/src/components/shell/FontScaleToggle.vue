<!--
  Font-size slider popover (user feedback: too few steps, wants drag-to-adjust). The "Aa"
  trigger in the top bar opens a small popover pinned below/right-aligned to the button (the
  button sits at the bar's right edge, so right-aligning keeps the panel on-screen), with a
  range slider (0.8–3.0, 0.05 steps), a live percentage readout, and a reset-to-100% button.
  Closes on Esc (focus returns to the trigger), on pointer down outside, or on re-clicking
  the trigger. Coarse-pointer ≥44px targets come from shell.css's `.fontscale-popover` rules.

  Dragging must not hammer the persisted store: the slider's `input` event goes through
  `useFontScale.preview()` (DOM-only, live preview while dragging) and only `change` /
  reset go through `setScale()`/`reset()` (which persist). The component stays self-wired
  (`useFontScale` + `themeStorage.ts`'s `browserLocalStorage()`), so neither the frozen
  `TopBarProps` contract nor `App.vue` changes. There is exactly one instance in the app.
-->
<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, ref } from "vue";
import { useI18n } from "../../composables/useI18n.js";
import {
  FONT_SCALE_MAX,
  FONT_SCALE_MIN,
  FONT_SCALE_STEP,
  fontScalePercent,
  useFontScale,
} from "../../composables/useFontScale.js";
import { browserLocalStorage } from "./themeStorage.js";

const { t } = useI18n();
const fontScale = useFontScale({ storage: browserLocalStorage(), doc: document });

const open = ref(false);
const root = ref<HTMLElement | null>(null);
const triggerEl = ref<HTMLButtonElement | null>(null);
const rangeEl = ref<HTMLInputElement | null>(null);

const scale = computed(() => fontScale.scale.value);
const pct = computed(() => fontScalePercent(fontScale.scale.value));

function onDocPointerDown(ev: Event): void {
  const target = ev.target;
  if (root.value && target instanceof Node && !root.value.contains(target)) closePopover();
}

function onDocKeydown(ev: KeyboardEvent): void {
  if (ev.key === "Escape") closePopover(true);
}

function closePopover(restoreFocus = false): void {
  if (!open.value) return;
  open.value = false;
  document.removeEventListener("pointerdown", onDocPointerDown, true);
  document.removeEventListener("keydown", onDocKeydown, true);
  if (restoreFocus) triggerEl.value?.focus();
}

function openPopover(): void {
  if (open.value) return;
  open.value = true;
  document.addEventListener("pointerdown", onDocPointerDown, true);
  document.addEventListener("keydown", onDocKeydown, true);
  // Move focus into the panel so Esc / slider arrow keys work immediately.
  void nextTick(() => rangeEl.value?.focus());
}

function toggle(): void {
  if (open.value) closePopover();
  else openPopover();
}

function rangeValue(ev: Event): number {
  return Number((ev.target as HTMLInputElement).value);
}

function onRangeInput(ev: Event): void {
  fontScale.preview(rangeValue(ev)); // live preview while dragging — no storage write
}

function onRangeChange(ev: Event): void {
  fontScale.setScale(rangeValue(ev)); // released — persist
}

function onReset(): void {
  fontScale.reset();
  rangeEl.value?.focus();
}

onBeforeUnmount(() => {
  document.removeEventListener("pointerdown", onDocPointerDown, true);
  document.removeEventListener("keydown", onDocKeydown, true);
});
</script>

<template>
  <span ref="root" class="fontscale-root">
    <button
      ref="triggerEl"
      type="button"
      class="btn btn-ghost btn-icon fontscale-toggle"
      aria-haspopup="dialog"
      :aria-expanded="open"
      :aria-label="t('shell.fontScale.aria', { pct })"
      :title="t('shell.fontScale.label')"
      @click="toggle"
    >
      <span aria-hidden="true">Aa</span>
    </button>
    <div v-if="open" class="fontscale-popover" role="dialog" :aria-label="t('shell.fontScale.label')">
      <input
        ref="rangeEl"
        type="range"
        :min="FONT_SCALE_MIN"
        :max="FONT_SCALE_MAX"
        :step="FONT_SCALE_STEP"
        :value="scale"
        :aria-label="t('shell.fontScale.label')"
        :aria-valuetext="`${pct}%`"
        @input="onRangeInput"
        @change="onRangeChange"
      />
      <span class="fontscale-readout" aria-hidden="true">{{ pct }}%</span>
      <button type="button" class="btn btn-ghost fontscale-reset" @click="onReset">
        {{ t("shell.fontScale.reset") }}
      </button>
    </div>
  </span>
</template>
