<!--
  Context-ring indicator (2026-10-05, user 现场拍板): the detail header's context metric moved
  HERE — a small SVG progress ring inside the composer input card, wrapped in
  a 44px touch button (coarse-pointer compliant). It sits at the right end of the card's
  bottom row while that row is expanded (switcher rendered + input empty) and re-anchors to
  the card's right-edge vertical center whenever the row collapses (typing / no switcher —
  control.css's `:has(.model-switcher):not(.has-text)` tier). Clicking toggles an UPWARD
  details panel (the composer hugs the screen's bottom edge — same orientation as the retired
  DeliverSwitch menu) carrying the full former header metrics: context % + used/total tokens,
  cost, and the sub-agent cost aside (read-only; `formatUsd`/`formatPercent`/`formatKTokens`
  throughout).

  MERGED STOP (#47): while BUSY, the ring zone is the current-turn 700ms hold target.
  Short pointer clicks do not arm; keyboard/AT open explicit confirmation. useHoldStop shares
  the grammar with StopButton; Composer owns singleflight across both surfaces. Context usage
  stays visible and independent of the CSS hold progress. Holding/confirmation suppress peek.
  While IDLE there is no stop affordance; the ring is the existing details toggle.

  HOVER PEEK (2026-10-16 user request 「这个展示做成 hover 展示吧」): a hover-capable pointer
  resting ~150ms on the ring zone opens the details panel as a non-pinned PEEK — QuotaPill's
  popover grammar (no focus steal; closes ~200ms after the pointer leaves BOTH the ring zone
  and the panel, so ring→panel traversal keeps it open; a transiting pointer never flashes
  it; touch/coarse pointers never peek). Click still PINS exactly as before (pinned survives
  pointer-leave; Esc / outside click / clicking again close it, Esc refocuses the trigger —
  touch + keyboard path unchanged). The peek is read-only and allowed while BUSY too (it sits
  above the ring and never intercepts the stop button), but holding/confirmation hides it (stop wins).

  Data arrives via the inject-only `DETAIL_METRICS` channel (`AgentDetail` provides it — the
  frozen `ComposerProps` stay untouched). No provider (dashboard, read-only dock) ⇒ the ring
  can't exist and a busy agent's stop falls back to the standalone `StopButton` (the old
  stop-only CSS tier keys on `.stop-btn` WITHOUT `.ctx-ring`). Provider present + usage still
  pending ⇒ idle renders nothing, while busy renders the ring SHELL (track + centered stop
  icon, arc at 0) so stop never flashes the bare standalone square mid-switch (2026-10-12).

  Ring geometry (radius/stroke) is FIXED px, never token-derived: it is a graphic, not text, so
  it stays the same size at any `--fs-scale` (the `pwh_fontscale` preference must not blow it
  up). The merged stop icon is fixed px for the same reason — it is part of the ring graphic,
  which is exactly why the single 36px textarea `padding-right` slot suffices at every font
  scale. Esc / outside click close the panel; Esc refocuses the trigger (DeliverSwitch/
  ThemeToggle conventions — no timers, no rAF).
-->
<script setup lang="ts">
import { computed, inject, onBeforeUnmount, ref, useId, watch } from "vue";
import { useHoldStop } from "../../composables/useHoldStop.js";
import { useI18n } from "../../composables/useI18n.js";
import { useMedia } from "../../composables/useMedia.js";
import { formatKTokens, formatPercent, formatUsd, localeFor } from "../../format.js";
import type { ContextRingEmits, ContextRingProps } from "../../contracts.js";
import AppIcon from "../../icons/AppIcon.vue";
import StopButton from "./StopButton.vue";
import StopConfirm from "./StopConfirm.vue";
import { DETAIL_METRICS } from "./controlContext.js";

const props = withDefaults(defineProps<ContextRingProps>(), { busy: false, queueCount: 0 });
const emit = defineEmits<ContextRingEmits>();
const i18n = useI18n();
const { t } = i18n;
const metrics = inject(DETAIL_METRICS, null);

const locale = computed(() => localeFor(i18n.lang));
const usage = computed(() => metrics?.contextUsage.value);
/* 2026-10-12 裸红方块 fix: provider presence and usage availability are DISTINCT gates.
 * The usage-backed arc still requires real usage, but the ring ZONE renders whenever the
 * provider exists AND (busy || usage known): a busy session whose contextUsage is still
 * pending (the first seconds after switching sessions) keeps stop inside the ring shell —
 * previously it fell through to the standalone StopButton, a bare red square that read as a
 * rendering glitch. The standalone fallback is now reserved for provider-ABSENT contexts
 * (dashboard / read-only dock). */
const hasProvider = metrics !== null;
const hasUsage = computed(() => usage.value !== undefined);
const showZone = computed(() => hasProvider && (props.busy || hasUsage.value));
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

/** Context usage tone is independent of #47's CSS-only hold progress. */
const tone = computed(() => {
  const p = percent.value;
  if (p === null) return "ok";
  if (p >= 90) return "danger";
  if (p >= 75) return "warn";
  return "ok";
});

const ariaLabel = computed(() => t("control.contextRingAria", { p: formatPercent(percent.value, locale.value) }));

// #47 shares only the gesture; host dispatch/pending lives in Composer.
const helpId = useId();
const stop = useHoldStop(
  () => props.busy && showZone.value,
  () => emit("stop"),
);
const stopActive = computed(() => stop.holding.value || stop.confirming.value || stop.pending.value);

/* ------------------- details panel: click-pinned + hover peek (2026-10-16) ------------------- */

/** Hover-capable pointer (desktop): gates the hover-peek panel — touch/coarse pointers never
 *  auto-open on hover (same `(hover: hover) and (pointer: fine)` gate as QuotaPill's popover). */
const hoverFine = useMedia(window, "(hover: hover) and (pointer: fine)").matches;

/** Click-pinned open (today's only open state pre-2026-10-16; the touch + keyboard path). */
const pinned = ref(false);
/** Hover "peek" open (hover-capable pointers only): same panel, non-pinned — closes ~200ms
 *  after the pointer leaves BOTH the ring zone and the panel, never steals focus, and a click
 *  on top of it simply pins it. Hidden while stop is holding, confirming or pending. */
const peek = ref(false);
const open = computed(() => !stopActive.value && (pinned.value || peek.value));

const root = ref<HTMLElement | null>(null);
const trigger_ = ref<HTMLButtonElement | null>(null);

let hoverIn: ReturnType<typeof setTimeout> | undefined;
let hoverOut: ReturnType<typeof setTimeout> | undefined;

/** Cancel any pending peek-close (pointer re-entered the ring zone or the panel). */
function stopPeekClose(): void {
  if (hoverOut !== undefined) {
    clearTimeout(hoverOut);
    hoverOut = undefined;
  }
}

/** ~150ms rest before the peek opens (a pointer merely transiting the ring must not flash the
 *  panel). Bound to the ring ZONE (the root span — busy stop button included, so the busy
 *  peek works) and to the panel itself; while busy this only ever peeks (read-only), never
 *  pins — pinning stays an idle-trigger-only click path. */
function onZoneEnter(): void {
  stopPeekClose();
  if (!hoverFine.value || open.value) return;
  hoverIn = setTimeout(() => {
    hoverIn = undefined;
    peek.value = true;
  }, 150);
}

/** ~200ms close grace: covers the ring→panel traversal gap; cancelled by re-entering either. */
function schedulePeekClose(): void {
  stopPeekClose();
  hoverOut = setTimeout(() => {
    hoverOut = undefined;
    peek.value = false;
  }, 200);
}

/** Leaving the ring zone OR the panel: close the peek unless a click pinned it. */
function onZoneLeave(): void {
  if (hoverIn !== undefined) {
    clearTimeout(hoverIn);
    hoverIn = undefined;
  }
  if (!pinned.value && peek.value) schedulePeekClose();
}

/** Click on the idle trigger: toggles a PIN on top of any peek (QuotaPill's `onToggle`). */
function onToggle(): void {
  pinned.value = !pinned.value;
  peek.value = false;
}

function closePanel(refocus: boolean): void {
  pinned.value = false;
  peek.value = false;
  if (refocus) trigger_.value?.focus();
}

function onKeydown(ev: KeyboardEvent): void {
  if (ev.key === "Escape" && open.value) {
    ev.stopPropagation();
    closePanel(true);
  }
}

// Stop wins the zone: `busy` flipping true force-closes the details panel — pin AND hover
// peek alike (it must not compete with the stop button for taps); `busy` flipping false drops
// any pending hold/confirmation state.
watch(
  () => props.busy,
  (v) => {
    if (v) closePanel(false);
    else stop.cancel();
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
onBeforeUnmount(() => {
  document.removeEventListener("click", onDocClick, true);
  if (hoverIn !== undefined) clearTimeout(hoverIn);
  if (hoverOut !== undefined) clearTimeout(hoverOut);
});
</script>

<template>
  <span
    v-if="showZone"
    ref="root"
    class="ctx-ring"
    :data-tone="tone"
    :data-stop="busy || undefined"
    @mouseenter="onZoneEnter"
    @mouseleave="onZoneLeave"
  >
    <!-- Busy: the ring's ENTIRE hit zone is the hold-to-stop button (stop wins — this button
         carries no panel toggle; the panel below can only be a read-only hover PEEK, never
         click-pinned, and never intercepts this button's taps). The arc keeps rendering
         around the centered icon so context usage stays visible. -->
    <button
      v-if="busy"
      type="button"
      class="ctx-ring-btn ctx-ring-stop-btn stop-hold-target"
      :class="{ holding: stop.holding.value }"
      :disabled="!stop.enabled.value"
      :data-holding="stop.holding.value || undefined"
      :aria-describedby="helpId"
      :aria-label="t('control.stopAria')"
      @pointerdown="stop.onPointerdown"
      @pointerleave="stop.onPointerleave"
      @lostpointercapture="stop.onPointercancel"
      @contextmenu="stop.onContextmenu"
      @mousedown.prevent
      @click="stop.onClick"
      @keydown="stop.onKeydown"
      @keyup="stop.onKeyup"
      @blur="stop.onBlur"
    >
      <!-- Track always renders (the shell); the bar arc sits at 0 while usage is pending and
           fills in when the first contextUsage arrives — the stop icon is centered either way. -->
      <svg class="ctx-ring-svg" width="20" height="20" viewBox="0 0 20 20" aria-hidden="true" focusable="false">
        <circle class="ctx-ring-track" cx="10" cy="10" :r="R" />
        <circle class="ctx-ring-bar" cx="10" cy="10" :r="R" :stroke-dasharray="dash" transform="rotate(-90 10 10)" />
      </svg>
      <AppIcon name="stop" class="ctx-ring-stop-icon" />
      <span class="stop-hold-progress" aria-hidden="true"></span>
    </button>
    <!-- Idle: the details toggle — click pins (hover peeks, see HOVER PEEK); no stop affordance. -->
    <button
      v-else
      ref="trigger_"
      type="button"
      class="ctx-ring-btn"
      :aria-expanded="open"
      :aria-label="ariaLabel"
      @click="onToggle"
      @keydown="onKeydown"
    >
      <svg class="ctx-ring-svg" width="20" height="20" viewBox="0 0 20 20" aria-hidden="true" focusable="false">
        <circle class="ctx-ring-track" cx="10" cy="10" :r="R" />
        <circle class="ctx-ring-bar" cx="10" cy="10" :r="R" :stroke-dasharray="dash" transform="rotate(-90 10 10)" />
      </svg>
    </button>
    <StopConfirm
      v-if="busy"
      :help-id="helpId"
      :holding="stop.holding.value"
      :confirming="stop.confirming.value"
      :cancelled="stop.cancelled.value"
      :hint="stop.hint.value"
      :pending="stop.pending.value"
      :enabled="stop.enabled.value"
      :queue-count="queueCount"
      @confirm="stop.confirm"
      @cancel="stop.dismiss"
      @alternative="stop.openConfirm"
    />
    <dl
      v-if="open"
      class="ctx-ring-panel"
      :aria-label="t('control.contextRingPanelAria')"
      @keydown="onKeydown"
      @mouseenter="onZoneEnter"
      @mouseleave="onZoneLeave"
    >
      <div class="ctx-ring-row">
        <dt>{{ t("detail.contextLabel") }}</dt>
        <dd>
          <span class="num">{{ formatPercent(percent, locale) }}</span>
          <span v-if="tokens !== undefined && window_ !== undefined" class="aside"
            >{{ formatKTokens(tokens, locale) }} / {{ formatKTokens(window_, locale) }}</span
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
  <!-- Provider ABSENT (dashboard / read-only dock): the ring can't exist at all, so a busy
       agent's stop falls back to the standalone StopButton (the old stop-only CSS tier keys on
       `.stop-btn` WITHOUT `.ctx-ring`). Provider present + idle + usage pending renders nothing
       (showZone false), exactly like the pre-fix no-usage idle case. -->
  <StopButton v-else-if="!hasProvider" :busy="busy" :queue-count="queueCount" @stop="emit('stop')" />
</template>
