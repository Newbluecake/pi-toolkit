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
  preview-perf P5 (plan r3 §5.3) adds the WORKER case: the page drives the REAL
  `highlight-worker-client` (lazily creating the REAL module worker — the exact production
  path, the same worker chunk the product build emits) and publishes the outcome on
  `window.__PWH_WORKER_RESULT__`: "spans-ok" only when the worker loaded under the production
  CSP, tokenized, and its transferred `HighlightSpans` decode back into token parts. A CSP
  rejection (missing `worker-src` falls back to `script-src 'self'`) surfaces as "fallback"
  plus a recorded violation — the runner asserts both, on Chromium AND Firefox.
  No `<style>` block (SFC style blocks are banned repo-wide) — all CSS lives in `probe.css`,
  loaded externally by `main.ts`.
-->
<script setup lang="ts">
import { onMounted, ref } from "vue";
import { getHighlightWorkerClient } from "../src/components/shared/highlight-worker-client.js";
import { decodeHighlightSpans } from "@logic/highlight.js";

const showToggle = ref(true);
const level = ref(1);

function cycleLevel(): void {
  level.value = level.value >= 3 ? 1 : level.value + 1;
}

/** §5.3 sample: TypeScript that MUST yield a `tok-keyword` span through the worker. */
const WORKER_SAMPLE = 'const answer = 42; // comment\nlet s = "str";\n';
const workerResult = ref<string>("pending");

onMounted(() => {
  const g = window as unknown as { __PWH_WORKER_RESULT__?: string };
  const handle = getHighlightWorkerClient().request(WORKER_SAMPLE, "typescript");
  void handle.result.then((outcome) => {
    if (outcome.status !== "spans") {
      workerResult.value = outcome.status; // plain | fallback | cancelled — all fail the probe
      g.__PWH_WORKER_RESULT__ = outcome.status;
      return;
    }
    const parts = decodeHighlightSpans(outcome.spans, WORKER_SAMPLE, 0, WORKER_SAMPLE.length);
    const ok = parts !== null && parts.some((p) => p.cls.includes("tok-keyword"));
    workerResult.value = ok ? "spans-ok" : "spans-bad";
    g.__PWH_WORKER_RESULT__ = workerResult.value;
  });
});
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

    <!-- preview-perf P5 §5.3: the module-worker case. The assertion rides the window global
         (the runner waitForFunction's it); this box only visualizes the outcome. -->
    <div class="worker-box" data-probe="worker" :data-worker-result="workerResult">worker: {{ workerResult }}</div>
  </div>
</template>
