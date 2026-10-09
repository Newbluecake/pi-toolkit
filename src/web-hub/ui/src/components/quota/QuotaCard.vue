<!--
  Subscription-quota popover card (quota-web plan §3/D2): per-provider-row detail behind
  `QuotaPill.vue`'s trigger — with the 2026-10 GLM merge (`cardRows`: `zai-coding-cn`+`zai`
  ALWAYS collapse into ONE "GLM" row when both are present, values per scope = worst-of the
  two sides; same `glmPair` rule as the pill). Esc /
  outside-pointerdown close + focus-return mirror
  `shell/SettingsOverlay.vue`'s desktop popover exactly (non-modal `role="dialog"`, no Tab trap,
  `preventDefault()` on Esc so `DashboardView.vue`'s own global Escape handler — which checks
  `event.defaultPrevented` — never double-handles the same keypress).

  Per-window reset times are **always** shown once known (plan: "弹出卡内各窗重置时间常显，不受
  `D6` 规则影响" — the pill's reset-annex priority rule is a pill-only shortcut, never applied
  here). The ETA warning line only appears when the forecast would exhaust the window before its
  own reset (`etaMs` defined AND, when `resetAt` is also known, `now + etaMs < resetAt`).
-->
<script setup lang="ts">
import { computed, nextTick, onMounted, onUnmounted, ref } from "vue";
import { useI18n } from "../../composables/useI18n.js";
import { etaDurationKey, fmtResetAt, glmPair } from "@logic/quota.js";
import type { QuotaProviderWire, QuotaWindowWire, QuotaWire } from "@protocol/messages.js";
import "../../styles/quota.css";

const props = defineProps<{ quota: QuotaWire; now: number; anchorEl: HTMLElement | null }>();
const emit = defineEmits<{ close: [] }>();
const { t } = useI18n();

/** Mirrors `glmPair`'s JSDoc return shape (`logic/quota.js` — the ONE shared GLM-pair rule
 *  this card reuses instead of re-implementing; never constructed locally). `source` is
 *  glmPair's SYNTHETIC merged provider (id `zai-coding-cn` ⇒ label "GLM"; windows = per-scope
 *  worst-of, each keeping its own side's resetAt/etaMs). */
interface GlmPair {
  skip: QuotaProviderWire;
  source: QuotaProviderWire;
  members: QuotaProviderWire[];
}

/** One head badge of a provider row. */
type CardBadge = { kind: "demoted"; until: number } | { kind: "stale"; provider: QuotaProviderWire };

/** One rendered provider row. GLM merge (2026-10-14 user ruling, `glmPair` — same rule as
 * the pill): when both GLM ids are present they ALWAYS merge into ONE row labeled "GLM"
 * (`labelId` = the cn side's id, regardless of snapshot order) at the FIRST member's position,
 * with per-scope worst-of window rows (each window keeps the resetAt/etaMs of the side that
 * supplied it — never one side's percentages under the other's clocks). Its badges aggregate
 * BOTH members under the "something is wrong" union policy — never hidden by a merge:
 * distinct plans each get their own badge, demotion shows while EITHER is demoted (the EARLIEST
 * resumption — the pinned pre-existing rule), and every stale member keeps its own stale badge
 * with its age. Non-GLM rows render exactly as before (demoted XOR stale, single plan). */
interface CardRow {
  key: string;
  labelId: string;
  windows: QuotaWindowWire[];
  plans: string[];
  badges: CardBadge[];
}

function finiteDemoted(provs: QuotaProviderWire[]): number | undefined {
  return provs
    .map((x) => x.demotedUntil)
    .filter((x): x is number => x !== undefined && Number.isFinite(x))
    .sort((a, b) => a - b)[0];
}

function cardRows(providers: QuotaProviderWire[]): CardRow[] {
  const pair = glmPair(providers) as GlmPair | undefined;
  const rows: CardRow[] = [];
  for (const p of providers) {
    if (pair !== undefined && pair.members.includes(p)) {
      if (p === pair.skip) continue;
      const members = pair.members;
      const badges: CardBadge[] = [];
      const demoted = finiteDemoted(members);
      if (demoted !== undefined) badges.push({ kind: "demoted", until: demoted });
      for (const m of members) {
        if (m.stale) badges.push({ kind: "stale", provider: m });
      }
      rows.push({
        key: `${pair.source.id}+${pair.skip.id}`,
        labelId: pair.source.id, // always zai-coding-cn ⇒ label "GLM"
        windows: pair.source.windows,
        plans: [...new Set(members.map((x) => x.plan).filter((x): x is string => x !== undefined))],
        badges,
      });
      continue;
    }
    // Non-merged row — exactly the pre-merge badge behavior (demoted XOR stale, one plan).
    const badges: CardBadge[] = [];
    if (p.demotedUntil !== undefined && Number.isFinite(p.demotedUntil)) {
      badges.push({ kind: "demoted", until: p.demotedUntil });
    } else if (p.stale) {
      badges.push({ kind: "stale", provider: p });
    }
    rows.push({
      key: p.id,
      labelId: p.id,
      windows: p.windows,
      plans: p.plan === undefined ? [] : [p.plan],
      badges,
    });
  }
  return rows;
}

const rows = computed<CardRow[]>(() => cardRows(props.quota.providers));

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
  const key = `quota.provider.${id}`;
  const label = t(key);
  // Unknown provider id (a future wire peer): t() falls back to the raw key — degrade to the
  // bare id instead, never "quota.provider.xxx" (verifier 2026-10).
  return label === key ? id : label;
}

/** Badge text: demoted ⇒ "⤓ demoted · resumes {clock}"; stale ⇒ its own age (or bare stale). */
function badgeText(b: CardBadge): string {
  if (b.kind === "demoted") {
    const clock = fmtResetAt(b.until, props.now) ?? "";
    return t("quota.demotedBadgeUntil", { clock });
  }
  return staleBadgeText(b.provider);
}

function badgeKey(b: CardBadge): string {
  return b.kind === "demoted" ? "demoted" : `stale-${b.provider.id}`;
}

function scopeText(scope: QuotaWindowWire["scope"]): string {
  return scope === "week" ? t("quota.scopeWeek") : t("quota.scope5h");
}

function barWidth(usedPct: number): string {
  const pct = Number.isFinite(usedPct) ? Math.min(100, Math.max(0, usedPct)) : 0;
  return `${pct}%`;
}

/** Rounded pct text; non-finite reads as 0% — the same defensive wire policy as the pill
 *  (never `NaN%`; verifier 2026-10). */
function pctText(usedPct: number): string {
  return `${Number.isFinite(usedPct) ? Math.round(usedPct) : 0}%`;
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
    <div v-for="row in rows" :key="row.key" class="q-prov">
      <div class="q-head">
        <span class="q-name">{{ providerLabel(row.labelId) }}</span>
        <span v-for="plan in row.plans" :key="plan" class="q-pill q-plan">{{ plan }}</span>
        <span
          v-for="b in row.badges"
          :key="badgeKey(b)"
          class="q-badge"
          :class="b.kind === 'demoted' ? 'q-demoted' : 'q-stale'"
          >{{ badgeText(b) }}</span
        >
      </div>
      <div v-for="w in row.windows" :key="w.scope" class="q-row">
        <span class="q-scope">{{ scopeText(w.scope) }}</span>
        <span class="q-bar" :data-lv="w.level"><i :style="{ width: barWidth(w.usedPct) }"></i></span>
        <span class="q-val">{{ pctText(w.usedPct) }}</span>
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
