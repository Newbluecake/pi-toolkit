<!--
  Context-ring indicator (2026-10-05, user 现场拍板): the detail header's context metric moved
  HERE — a small SVG progress ring pinned inside the composer textarea's right edge, wrapped in
  a 44px touch button (coarse-pointer compliant). Clicking toggles an UPWARD details panel (the
  composer hugs the screen's bottom edge — same orientation as the retired DeliverSwitch menu)
  carrying the full former header metrics: context % + used/total tokens, cost, and the
  sub-agent cost aside (read-only; `formatUsd`/`formatPercent`/`formatNumber` throughout).

  Data arrives via the inject-only `DETAIL_METRICS` channel (`AgentDetail` provides it — the
  frozen `ComposerProps` stay untouched). No provider (dashboard, read-only dock) or no
  `contextUsage` reported yet ⇒ the component renders NOTHING, zero errors.

  Ring geometry (radius/stroke) is FIXED px, never token-derived: it is a graphic, not text, so
  it stays the same size at any `--fs-scale` (the `pwh_fontscale` preference must not blow it
  up). Esc / outside click close the panel; Esc refocuses the trigger (DeliverSwitch/ThemeToggle
  conventions — no timers, no rAF).
-->
<script setup lang="ts">
import { computed, inject, onBeforeUnmount, ref, watch } from "vue";
import { useI18n } from "../../composables/useI18n.js";
import { formatNumber, formatPercent, formatUsd, localeFor } from "../../format.js";
import { DETAIL_METRICS } from "./controlContext.js";

const { t, lang } = useI18n();
const metrics = inject(DETAIL_METRICS, null);

const locale = computed(() => localeFor(lang));
const usage = computed(() => metrics?.contextUsage.value);
const percent = computed(() => usage.value?.percent ?? null);
const tokens = computed(() => usage.value?.tokens);
const window_ = computed(() => usage.value?.contextWindow);
const costUsd = computed(() => metrics?.costUsd.value);
const subCost = computed(() => {
  const sub = metrics?.subagentCostUsd.value;
  return typeof sub === "number" && sub > 0 ? sub : null;
});

/* Fixed-px geometry (see the header comment): r=12 / stroke 3.5 inside a 30×30 viewBox.
 * (2026-10-05 field report: the original 22px ring read too small next to the input box.) */
const R = 12;
const CIRC = 2 * Math.PI * R;
const dash = computed(() => {
  const p = percent.value;
  const clamped = p === null ? 0 : Math.min(100, Math.max(0, p));
  return `${(clamped / 100) * CIRC} ${CIRC}`;
});

/** Color grading (tokens): <75% primary, ≥75% warning, ≥90% danger. */
const tone = computed(() => {
  const p = percent.value;
  if (p === null) return "ok";
  if (p >= 90) return "danger";
  if (p >= 75) return "warn";
  return "ok";
});

const ariaLabel = computed(() => t("control.contextRingAria", { p: formatPercent(percent.value, locale.value) }));

const open = ref(false);
const root = ref<HTMLElement | null>(null);
const trigger = ref<HTMLButtonElement | null>(null);

function closePanel(refocus: boolean): void {
  if (!open.value) return;
  open.value = false;
  if (refocus) trigger.value?.focus();
}

function onKeydown(ev: KeyboardEvent): void {
  if (ev.key === "Escape" && open.value) {
    ev.stopPropagation();
    closePanel(true);
  }
}

function onDocClick(ev: MouseEvent): void {
  if (!open.value) return;
  if (root.value !== null && ev.target instanceof Node && !root.value.contains(ev.target)) closePanel(false);
}

watch(open, (v) => {
  if (v) document.addEventListener("click", onDocClick, true);
  else document.removeEventListener("click", onDocClick, true);
});
onBeforeUnmount(() => document.removeEventListener("click", onDocClick, true));
</script>

<template>
  <span v-if="metrics !== null && usage !== undefined" ref="root" class="ctx-ring" :data-tone="tone">
    <button
      ref="trigger"
      type="button"
      class="ctx-ring-btn"
      :aria-expanded="open"
      :aria-label="ariaLabel"
      @click="open = !open"
      @keydown="onKeydown"
    >
      <svg class="ctx-ring-svg" width="30" height="30" viewBox="0 0 30 30" aria-hidden="true" focusable="false">
        <circle class="ctx-ring-track" cx="15" cy="15" :r="R" />
        <circle class="ctx-ring-bar" cx="15" cy="15" :r="R" :stroke-dasharray="dash" transform="rotate(-90 15 15)" />
      </svg>
    </button>
    <dl v-if="open" class="ctx-ring-panel" :aria-label="t('control.contextRingPanelAria')" @keydown="onKeydown">
      <div class="ctx-ring-row">
        <dt>{{ t("detail.contextLabel") }}</dt>
        <dd>
          <span class="num">{{ formatPercent(percent, locale) }}</span>
          <span v-if="tokens !== undefined && window_ !== undefined" class="aside"
            >{{ formatNumber(tokens, locale) }} / {{ formatNumber(window_, locale) }}</span
          >
        </dd>
      </div>
      <div class="ctx-ring-row">
        <dt>{{ t("detail.costLabel") }}</dt>
        <dd>
          <span class="num">{{ formatUsd(costUsd) }}</span>
          <span v-if="subCost !== null" class="aside">{{ t("detail.subCost", { v: formatUsd(subCost) }) }}</span>
        </dd>
      </div>
    </dl>
  </span>
</template>
