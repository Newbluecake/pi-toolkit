/**
 * `quota` i18n namespace (quota-web plan §3/D9): the top-bar subscription-quota pill + its
 * popover card. Per AGENTS.md's UI-text split, the pill/card's `5h`/`7d` scope tokens and the
 * `GLM`/`Kimi` provider abbreviations are treated as unit/brand tokens (kept identical in both
 * languages, assembled client-side in `QuotaPill.vue`/`QuotaCard.vue` rather than looked up
 * here) — everything that actually reads as prose (the card's long window label, reset/ETA
 * sentences, badges, aria text) goes through this namespace.
 */
const quota = {
  title: "Subscription quota",
  pillAria: "Subscription quota",
  toggleAria: "Subscription quota details",
  // Card row's long window label (distinct from the pill's compact "5h"/"7d" token — mirrors
  // the mockup: the card spells "week" out, the pill never does).
  scope5h: "5h",
  scopeWeek: "week",
  resetSuffix: "{clock} reset",
  pillAriaBase: "Subscription quota: {provider} {scope} {pct}%",
  pillAriaReset: "Subscription quota: {provider} {scope} {pct}%, resets {clock}",
  "provider.zai-coding-cn": "GLM",
  "provider.zai": "GLM Intl",
  "provider.kimi-coding": "Kimi",
  planBadgeAria: "Plan: {plan}",
  demotedBadge: "⤓ demoted",
  demotedBadgeUntil: "⤓ demoted · resumes {clock}",
  staleBadge: "stale",
  staleBadgeAge: "stale {n} min",
  etaMinutes: "{n} min",
  etaHours: "{h} h",
  etaHoursMinutes: "{h}h {m}m",
  etaWarn: "At current rate, exhausts in about {duration}",
  footerSampledBy: "Sampled by the main session",
  footerUpdatedAt: "Updated {clock}",
  emptyNote: "No subscription quota data yet",
};

export default quota;
