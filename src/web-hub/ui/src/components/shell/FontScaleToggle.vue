<!--
  Font-size cycle button (user feedback: body text too small on phones). Sits in the top bar
  next to `ThemeToggle.vue`. Unlike ThemeToggle it is *self-wired* rather than controlled —
  `useFontScale()` owns the `pwh_fontscale` storage/`--fs-scale` bookkeeping itself (the same
  split as `useTheme.ts` + `themeStorage.ts`), so neither the frozen `TopBarProps` contract
  nor `App.vue` had to change to host it. There is exactly one instance in the app.

  No font-scale icon exists in the frozen `IconName` set, so the glyph is the literal text
  "Aa" (aria-hidden); the accessible name carries the current percentage and the one a tap
  switches to, mirroring the compact ThemeToggle's "current → next" announcement grammar.
  The 44px coarse-pointer hit area comes from primitives.css's `(pointer: coarse)` `.btn-icon`
  rule — this button is a plain `.btn .btn-ghost .btn-icon`.
-->
<script setup lang="ts">
import { computed } from "vue";
import { useI18n } from "../../composables/useI18n.js";
import { fontScalePercent, nextFontScale, useFontScale } from "../../composables/useFontScale.js";
import { browserLocalStorage } from "./themeStorage.js";

const { t } = useI18n();
const fontScale = useFontScale({ storage: browserLocalStorage(), doc: document });

const pct = computed(() => fontScalePercent(fontScale.scale.value));
const nextPct = computed(() => fontScalePercent(nextFontScale(fontScale.scale.value)));

function cycle(): void {
  fontScale.cycle();
}
</script>

<template>
  <button
    type="button"
    class="btn btn-ghost btn-icon fontscale-toggle"
    :aria-label="t('shell.fontScale.aria', { pct, next: nextPct })"
    :title="t('shell.fontScale.label')"
    @click="cycle"
  >
    <span aria-hidden="true">Aa</span>
  </button>
</template>
