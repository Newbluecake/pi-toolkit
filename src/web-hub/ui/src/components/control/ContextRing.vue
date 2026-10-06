<!--
  Context-ring indicator (2026-10-05, user 现场拍板): the detail header's context metric moved
  HERE — a small SVG progress ring pinned inside the composer textarea's right edge, wrapped in
  a 44px touch button (coarse-pointer compliant). Clicking toggles an UPWARD details panel (the
  composer hugs the screen's bottom edge — same orientation as the retired DeliverSwitch menu)
  carrying the full former header metrics: context % + used/total tokens, cost, and the
  sub-agent cost aside (read-only; `formatUsd`/`formatPercent`/`formatNumber` throughout).

  MERGED STOP (2026-10 user request "把 stop 图标放到上下文比例圆圈中"): while the agent is
  BUSY the ring's ENTIRE zone becomes the two-step stop button — the arc keeps showing context
  usage around a centered stop icon, but nothing else may intercept taps inside the zone (stop
  wins: the details panel neither opens nor survives `busy` flipping true). The armed grammar
  is StopButton's exactly (4s auto-revert, Esc reverts, `aria-live`, queue note when
  `queueCount > 0`) via the shared `useArmedConfirm` composable; armed turns icon + arc danger.
  While IDLE there is no stop affordance at all — the ring is today's details toggle.

  Data arrives via the inject-only `DETAIL_METRICS` channel (`AgentDetail` provides it — the
  frozen `ComposerProps` stay untouched). No provider (dashboard, read-only dock) or no
  `contextUsage` reported yet ⇒ the RING renders nothing — but a busy agent still needs its
  stop reachable, so that case falls back to today's standalone `StopButton` (the old
  stop-only CSS tier keys on `.stop-btn` WITHOUT `.ctx-ring`, so no layout rule changes).

  Ring geometry (radius/stroke) is FIXED px, never token-derived: it is a graphic, not text, so
  it stays the same size at any `--fs-scale` (the `pwh_fontscale` preference must not blow it
  up). The merged stop icon is fixed px for the same reason — it is part of the ring graphic,
  which is exactly why the single 36px textarea `padding-right` slot suffices at every font
  scale. Esc / outside click close the panel; Esc refocuses the trigger (DeliverSwitch/
  ThemeToggle conventions — no timers, no rAF).
-->
<script setup lang="ts">
import { computed, inject, onBeforeUnmount, ref, watch } from "vue";
import { useArmedConfirm } from "../../composables/useArmedConfirm.js";
import { useI18n } from "../../composables/useI18n.js";
import { formatNumber, formatPercent, formatUsd, localeFor } from "../../format.js";
import type { ContextRingEmits, ContextRingProps } from "../../contracts.js";
import AppIcon from "../../icons/AppIcon.vue";
import StopButton from "./StopButton.vue";
import { DETAIL_METRICS } from "./controlContext.js";

const props = withDefaults(defineProps<ContextRingProps>(), { busy: false, queueCount: 0 });
const emit = defineEmits<ContextRingEmits>();
const { t, lang } = useI18n();
const metrics = inject(DETAIL_METRICS, null);

const locale = computed(() => localeFor(lang));
const usage = computed(() => metrics?.contextUsage.value);
const hasRing = computed(() => metrics !== null && usage.value !== undefined);
const percent = computed(() => usage.value?.percent ?? null);
const tokens = computed(() => usage.value?.tokens);
const window_ = computed(() => usage.value?.contextWindow);
const costUsd = computed(() => metrics?.costUsd.value);
const subCost = computed(() => {
  const sub = metrics?.subagentCostUsd.value;
  return typeof sub === "number" && sub > 0 ? sub : null;
});

/* Fixed-px geometry (see the header comment): r=16 / stroke 4.5 inside a 40×40 viewBox.
 * Size history: 22px → 50px (2026-10-05 "too small") → 40px (2026-10-06) → 27px → 20px
 * (2026-10-06 "直径再缩小四分之一" — at 27px the arc crowded the halved-padding input border).
 * r=7.5 / stroke 4 in a 20×20 viewBox (outer 9.5 ≤ 10). */
const R = 7.5;
const CIRC = 2 * Math.PI * R;
const dash = computed(() => {
  const p = percent.value;
  const clamped = p === null ? 0 : Math.min(100, Math.max(0, p));
  return `${(clamped / 100) * CIRC} ${CIRC}`;
});

/** Color grading (tokens): <75% primary, ≥75% warning, ≥90% danger. (While the merged stop is
 * ARMED the arc is forced to danger by CSS regardless of this tone — armed wins.) */
const tone = computed(() => {
  const p = percent.value;
  if (p === null) return "ok";
  if (p >= 90) return "danger";
  if (p >= 75) return "warn";
  return "ok";
});

const ariaLabel = computed(() => t("control.contextRingAria", { p: formatPercent(percent.value, locale.value) }));

// --- merged stop (busy): two-step armed confirm, StopButton's grammar via the shared composable.
const { armed, disarm, trigger, onKeydown: onStopKeydown } = useArmedConfirm(() => emit("stop"));

/** K12 surfacing, same as StopButton: queued messages survive an abort, so the armed copy
 * says so when `queueCount > 0`. */
const queueNote = computed(() =>
  armed.value && props.queueCount > 0 ? t("control.stopQueueNote", { n: props.queueCount }) : "",
);

const open = ref(false);
const root = ref<HTMLElement | null>(null);
const trigger_ = ref<HTMLButtonElement | null>(null);

function closePanel(refocus: boolean): void {
  if (!open.value) return;
  open.value = false;
  if (refocus) trigger_.value?.focus();
}

function onKeydown(ev: KeyboardEvent): void {
  if (ev.key === "Escape" && open.value) {
    ev.stopPropagation();
    closePanel(true);
  }
}

// Stop wins the zone: `busy` flipping true force-closes the details panel (it must not compete
// with the stop button for taps); `busy` flipping false drops any pending armed state.
watch(
  () => props.busy,
  (v) => {
    if (v) closePanel(false);
    else disarm();
  },
);

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
  <span v-if="hasRing" ref="root" class="ctx-ring" :data-tone="tone" :data-stop="busy || undefined">
    <!-- Busy: the ring's ENTIRE hit zone is the two-step stop button (stop wins — this button
         carries no panel toggle and the panel below can't be open). The arc keeps rendering
         around the centered icon so context usage stays visible. -->
    <button
      v-if="busy"
      type="button"
      class="ctx-ring-btn ctx-ring-stop-btn"
      :class="{ armed }"
      :data-armed="armed ? 'true' : undefined"
      :aria-label="t('control.stopAria')"
      @click="trigger"
      @keydown="onStopKeydown"
    >
      <svg class="ctx-ring-svg" width="20" height="20" viewBox="0 0 20 20" aria-hidden="true" focusable="false">
        <circle class="ctx-ring-track" cx="10" cy="10" :r="R" />
        <circle class="ctx-ring-bar" cx="10" cy="10" :r="R" :stroke-dasharray="dash" transform="rotate(-90 10 10)" />
      </svg>
      <AppIcon name="stop" class="ctx-ring-stop-icon" />
    </button>
    <!-- Idle: today's details toggle, unchanged — no stop affordance. -->
    <button
      v-else
      ref="trigger_"
      type="button"
      class="ctx-ring-btn"
      :aria-expanded="open"
      :aria-label="ariaLabel"
      @click="open = !open"
      @keydown="onKeydown"
    >
      <svg class="ctx-ring-svg" width="20" height="20" viewBox="0 0 20 20" aria-hidden="true" focusable="false">
        <circle class="ctx-ring-track" cx="10" cy="10" :r="R" />
        <circle class="ctx-ring-bar" cx="10" cy="10" :r="R" :stroke-dasharray="dash" transform="rotate(-90 10 10)" />
      </svg>
    </button>
    <span v-if="armed" class="stop-live sr-only" role="status">{{ t("control.stopArmed") }}</span>
    <span v-if="queueNote" class="ctx-ring-stop-note" role="note">{{ queueNote }}</span>
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
  <!-- No ring (no DETAIL_METRICS provider / no contextUsage yet): the ring self-hides, but a
       busy agent's stop must stay reachable ⇒ today's standalone StopButton look (the old
       stop-only padding tier keys on `.stop-btn` without `.ctx-ring`). -->
  <StopButton v-else :busy="busy" :queue-count="queueCount" @stop="emit('stop')" />
</template>
