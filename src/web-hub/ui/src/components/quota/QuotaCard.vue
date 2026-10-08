<!--
  Subscription-quota popover card (quota-web plan §3/D2): three-provider-row detail behind
  `QuotaPill.vue`'s trigger. Esc / outside-pointerdown close + focus-return mirror
  `shell/SettingsOverlay.vue`'s desktop popover exactly (non-modal `role="dialog"`, no Tab trap,
  `preventDefault()` on Esc so `DashboardView.vue`'s own global Escape handler — which checks
  `event.defaultPrevented` — never double-handles the same keypress).

  Per-window reset times are **always** shown once known (plan: "弹出卡内各窗重置时间常显，不受
  `D6` 规则影响" — the pill's reset-annex priority rule is a pill-only shortcut, never applied
  here). The ETA warning line only appears when the forecast would exhaust the window before its
  own reset (`etaMs` defined AND, when `resetAt` is also known, `now + etaMs < resetAt`).
-->
<script setup lang="ts">
import { nextTick, onMounted, onUnmounted, ref } from "vue";
import { useI18n } from "../../composables/useI18n.js";
import { etaDurationKey, fmtResetAt } from "@logic/quota.js";
import type { QuotaProviderWire, QuotaWindowWire, QuotaWire } from "@protocol/messages.js";
import "../../styles/quota.css";

const props = defineProps<{ quota: QuotaWire; now: number; anchorEl: HTMLElement | null }>();
const emit = defineEmits<{ close: [] }>();
const { t } = useI18n();

const panelEl = ref<HTMLElement | null>(null);

function onKeydown(ev: KeyboardEvent): void {
  if (ev.key !== "Escape") return;
  ev.preventDefault();
  emit("close");
}

function onPointerDown(ev: PointerEvent): void {
  if (!(ev.target instanceof Node)) return;
  const panel = panelEl.value;
  if (panel !== null && panel.contains(ev.target)) return;
  if (props.anchorEl !== null && props.anchorEl.contains(ev.target)) return;
  // Same real-browser-vs-happy-dom pointerdown default-action race `SettingsOverlay.vue`
  // documents: cancel the default focus change outright so `anchorEl.focus()` on unmount is the
  // only focus-setter that ever runs for this path.
  ev.preventDefault();
  emit("close");
}

onMounted(async () => {
  document.addEventListener("keydown", onKeydown, true);
  document.addEventListener("pointerdown", onPointerDown, true);
  await nextTick();
  panelEl.value?.focus();
});

onUnmounted(() => {
  document.removeEventListener("keydown", onKeydown, true);
  document.removeEventListener("pointerdown", onPointerDown, true);
  props.anchorEl?.focus();
});

function providerLabel(id: string): string {
  return t(`quota.provider.${id}`);
}

function scopeText(scope: QuotaWindowWire["scope"]): string {
  return scope === "week" ? t("quota.scopeWeek") : t("quota.scope5h");
}

function barWidth(usedPct: number): string {
  const pct = Number.isFinite(usedPct) ? Math.min(100, Math.max(0, usedPct)) : 0;
  return `${pct}%`;
}

function demotedClock(p: QuotaProviderWire): string | undefined {
  return p.demotedUntil === undefined ? undefined : fmtResetAt(p.demotedUntil, props.now);
}

/** verification r_WV2Y9VQZ #2: the stale badge carries an age ("stale N min") whenever the
 *  provider's own `fetchedAt` is known; falls back to a bare "stale" badge when it is absent
 *  (older agent peer, or a defensively-missing verdict field) — never fabricates an age. Negative
 *  ages (clock skew between agent and browser) clamp to 0 rather than printing a negative number. */
function staleBadgeText(p: QuotaProviderWire): string {
  if (p.fetchedAt === undefined) return t("quota.staleBadge");
  const ageMin = Math.max(0, Math.floor((props.now - p.fetchedAt) / 60_000));
  return t("quota.staleBadgeAge", { n: ageMin });
}

/** D6's note: "ETA<reset 时红字" — `etaMs` known AND (no reset known, OR the forecast exhausts
 *  strictly before it). */
function etaWarn(w: QuotaWindowWire): boolean {
  if (w.etaMs === undefined) return false;
  if (w.resetAt === undefined) return true;
  return props.now + w.etaMs < w.resetAt;
}

function etaWarnText(w: QuotaWindowWire): string {
  const dur = etaDurationKey(w.etaMs);
  if (dur === undefined) return "";
  const duration = t(`quota.${dur.key}`, dur.params);
  return t("quota.etaWarn", { duration });
}

function resetText(w: QuotaWindowWire): string | undefined {
  const clock = fmtResetAt(w.resetAt, props.now);
  return clock === undefined ? undefined : t("quota.resetSuffix", { clock });
}
</script>

<template>
  <div id="quota-panel" ref="panelEl" class="q-card" role="dialog" :aria-label="t('quota.title')" tabindex="-1">
    <h2 class="q-card-title">{{ t("quota.title") }}</h2>
    <div v-for="p in quota.providers" :key="p.id" class="q-prov">
      <div class="q-head">
        <span class="q-name">{{ providerLabel(p.id) }}</span>
        <span v-if="p.plan" class="q-plan">{{ p.plan }}</span>
        <span v-if="demotedClock(p)" class="q-badge q-demoted">{{
          t("quota.demotedBadgeUntil", { clock: demotedClock(p)! })
        }}</span>
        <span v-else-if="p.stale" class="q-badge q-stale">{{ staleBadgeText(p) }}</span>
      </div>
      <div v-for="w in p.windows" :key="w.scope" class="q-row">
        <span class="q-scope">{{ scopeText(w.scope) }}</span>
        <span class="q-bar" :data-lv="w.level"><i :style="{ width: barWidth(w.usedPct) }"></i></span>
        <span class="q-val">{{ Math.round(w.usedPct) }}%</span>
        <span v-if="etaWarn(w) || resetText(w)" class="q-sub" :class="{ 'q-warn': etaWarn(w) }">
          <template v-if="etaWarn(w)">{{ etaWarnText(w) }}<template v-if="resetText(w)"> · </template></template
          >{{ resetText(w) }}
        </span>
      </div>
    </div>
    <div class="q-foot">
      <span>{{ t("quota.footerSampledBy") }}</span>
      <span>{{ t("quota.footerUpdatedAt", { clock: fmtResetAt(quota.at, now) ?? "" }) }}</span>
    </div>
  </div>
</template>
