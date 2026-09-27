<!--
  Browser-level CSP probe surface (vue-plan.md v2.1 §4.4.1, §5.2 — P0). Built through the exact
  same `vite.config.ts` pipeline as the real production bundle (`--mode csp-probe` only swaps
  the entry/outDir), so what this proves is true of the real build too. Covers, per element
  `data-probe`:
    "pct"    — `:style="{'--pct': ...}"` object binding + an external-CSS `width: var(--pct)` rule
    "width"  — `:style="{width: ...}"` object binding (plain px value)
    "vshow"  — `v-show` toggling `display`
    "level"  — numeric-driven dynamic `:class` switching
    "static" — 30 connected pure-static sibling nodes (no bindings at all), to force Vue's
               static-hoisting/stringification path (`createStaticVNode`, which inserts via
               `innerHTML`) so the probe also exercises that code path, not just simple bindings.
  No `<style>` block (SFC style blocks are banned repo-wide) — all CSS lives in `probe.css`,
  loaded externally by `main.ts`.
-->
<script setup lang="ts">
import { ref } from "vue";

const showToggle = ref(true);
const level = ref(1);

function cycleLevel(): void {
  level.value = level.value >= 3 ? 1 : level.value + 1;
}
</script>

<template>
  <div class="probe-root">
    <div class="pct-box" data-probe="pct" :style="{ '--pct': '42%' }"></div>
    <div class="width-box" data-probe="width" :style="{ width: '10px' }"></div>
    <div v-show="showToggle" class="vshow-box" data-probe="vshow">visible</div>
    <div :class="`level-${level}`" data-probe="level"></div>

    <button type="button" data-action="toggle-vshow" @click="showToggle = !showToggle">toggle</button>
    <button type="button" data-action="cycle-level" @click="cycleLevel">cycle</button>

    <div class="static-block" data-probe="static">
      <span class="s" data-i="0"></span><span class="s" data-i="1"></span><span class="s" data-i="2"></span
      ><span class="s" data-i="3"></span><span class="s" data-i="4"></span><span class="s" data-i="5"></span
      ><span class="s" data-i="6"></span><span class="s" data-i="7"></span><span class="s" data-i="8"></span
      ><span class="s" data-i="9"></span><span class="s" data-i="10"></span><span class="s" data-i="11"></span
      ><span class="s" data-i="12"></span><span class="s" data-i="13"></span><span class="s" data-i="14"></span
      ><span class="s" data-i="15"></span><span class="s" data-i="16"></span><span class="s" data-i="17"></span
      ><span class="s" data-i="18"></span><span class="s" data-i="19"></span><span class="s" data-i="20"></span
      ><span class="s" data-i="21"></span><span class="s" data-i="22"></span><span class="s" data-i="23"></span
      ><span class="s" data-i="24"></span><span class="s" data-i="25"></span><span class="s" data-i="26"></span
      ><span class="s" data-i="27"></span><span class="s" data-i="28"></span><span class="s" data-i="29"></span>
    </div>
  </div>
</template>
