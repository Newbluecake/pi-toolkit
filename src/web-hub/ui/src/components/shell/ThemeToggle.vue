<!--
  Three-state theme switcher (vue-plan.md v2.1 §3.9, §17.1, §5.2 — P3 exclusive,
  `components/shell/**`). Not in the static mockup (which only demoed dark mode via a JS-free
  `#mock-dark` checkbox) — `useTheme()` (P1) owns the actual class/localStorage bookkeeping,
  this is purely the control that drives its `pref` ref two-way.

  ui-design.md §3.9: on ≤480px the segmented `role="radiogroup"` collapses into a single icon
  button that cycles system → light → dark → system on tap (still fully reachable, still one
  `aria-label` announcing the *next* state it will switch to).
-->
<script setup lang="ts">
import { computed } from "vue";
import { useI18n } from "../../composables/useI18n.js";
import { useMedia } from "../../composables/useMedia.js";
import type { ThemeToggleEmits, ThemeToggleProps } from "../../contracts.js";
import type { ThemePref } from "../../types.js";

const props = defineProps<ThemeToggleProps>();
const emit = defineEmits<ThemeToggleEmits>();
const { t } = useI18n();

const OPTIONS: readonly { value: ThemePref; labelKey: string }[] = [
  { value: "system", labelKey: "shell.theme.system" },
  { value: "light", labelKey: "shell.theme.light" },
  { value: "dark", labelKey: "shell.theme.dark" },
];

const isCompact = useMedia(window, "(max-width: 480px)").matches;

function select(value: ThemePref): void {
  emit("update:modelValue", value);
}

const nextValue = computed<ThemePref>(() => {
  const idx = OPTIONS.findIndex((o) => o.value === props.modelValue);
  return OPTIONS[(idx + 1) % OPTIONS.length]!.value;
});

function cycle(): void {
  select(nextValue.value);
}
</script>

<template>
  <div v-if="!isCompact" class="theme-toggle" role="radiogroup" :aria-label="t('shell.theme.groupLabel')">
    <button
      v-for="opt in OPTIONS"
      :key="opt.value"
      type="button"
      role="radio"
      :aria-checked="modelValue === opt.value"
      :aria-label="t(opt.labelKey)"
      @click="select(opt.value)"
    >
      {{ t(opt.labelKey) }}
    </button>
  </div>
  <button
    v-else
    type="button"
    class="btn btn-ghost btn-icon"
    :aria-label="`${t('shell.theme.groupLabel')}: ${t(OPTIONS.find((o) => o.value === modelValue)!.labelKey)} → ${t(OPTIONS.find((o) => o.value === nextValue)!.labelKey)}`"
    @click="cycle"
  >
    {{ t(OPTIONS.find((o) => o.value === modelValue)!.labelKey).charAt(0) }}
  </button>
</template>
