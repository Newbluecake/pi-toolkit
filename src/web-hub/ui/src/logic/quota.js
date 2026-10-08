/**
 * quota-web plan §3 (D5/D6): pure, DOM-free logic behind the top-bar quota pill/card.
 *
 * `pillView` is the D6 selection algorithm (the only piece plan §5 calls out for exhaustive
 * parameterized coverage): pick the single worst (provider, window) pair across the WHOLE
 * snapshot — level desc, then usedPct desc — for the headline label, then independently decide
 * which reset time (if any) rides along as the pill's annex, per the user's 2026-10-08
 * amendment ("5h>70% 带 5h 重置；5h 与 7d 同时触界时优先 7d 重置").
 *
 * `freshestQuota` is the D5 cross-session hoist: every subscribed agent's `AgentState.status`
 * carries its own mirrored `StatusInfo.quota` (untouched — `@logic/state.js` already stores
 * `status` wholesale, so no reducer change was needed for this feature, see quota-web plan's
 * delivery note); this picks whichever one has the largest `at`.
 *
 * `fmtResetAt` mirrors `src/quota/render.ts`'s `formatResetAt` (same-day → "HH:MM", else →
 * "M/D HH:MM") so the web card reads the same way the HUD/injected prose already does — that
 * module cannot be imported here (it is agent-side, Node-only, and pi-toolkit's pure core), so
 * the convention is re-implemented against `Date`, which behaves identically client-side.
 */

/** @typedef {import("@protocol/messages.js").QuotaWire} QuotaWire */
/** @typedef {import("@protocol/messages.js").QuotaProviderWire} QuotaProviderWire */
/** @typedef {import("@protocol/messages.js").QuotaWindowWire} QuotaWindowWire */

/** `scope` → the compact English token used everywhere else in the repo (AGENTS.md UI-text
 *  split; mirrors `src/quota/render.ts`'s `formatScope`). */
export function scopeLabel(scope) {
  return scope === "week" ? "7d" : "5h";
}

/** Same calendar day (local time) as `now` ⇒ "HH:MM"; otherwise "M/D HH:MM". `resetAt`
 *  undefined/non-finite ⇒ `undefined` (caller omits the annex entirely). */
export function fmtResetAt(resetAt, now) {
  if (typeof resetAt !== "number" || !Number.isFinite(resetAt)) return undefined;
  const d = new Date(resetAt);
  const n = new Date(typeof now === "number" && Number.isFinite(now) ? now : Date.now());
  const hh = String(d.getHours()).padStart(2, "0");
  const mm = String(d.getMinutes()).padStart(2, "0");
  const sameDay = n.getFullYear() === d.getFullYear() && n.getMonth() === d.getMonth() && n.getDate() === d.getDate();
  return sameDay ? `${hh}:${mm}` : `${d.getMonth() + 1}/${d.getDate()} ${hh}:${mm}`;
}

/** `etaMs` → an i18n message key + its numeric params, so the component only ever calls
 *  `t("quota." + key, params)` — no duration string is assembled here (prose, not a marker,
 *  needs real zh/en translations). `undefined`/invalid/negative ⇒ `undefined`. */
export function etaDurationKey(etaMs) {
  if (typeof etaMs !== "number" || !Number.isFinite(etaMs) || etaMs < 0) return undefined;
  const totalMinutes = Math.round(etaMs / 60_000);
  if (totalMinutes < 60) return { key: "etaMinutes", params: { n: Math.max(1, totalMinutes) } };
  const hours = Math.floor(totalMinutes / 60);
  const minutes = totalMinutes % 60;
  return minutes > 0
    ? { key: "etaHoursMinutes", params: { h: hours, m: minutes } }
    : { key: "etaHours", params: { h: hours } };
}

/**
 * Picks the single worst `{ provider, window }` pair: level desc, then usedPct desc. Ties beyond
 * that (identical level AND usedPct) keep the first one encountered (snapshot provider/window
 * order), which is deterministic given `QuotaWire.providers`/`.windows` arrays are themselves
 * built in a fixed order upstream — never randomized.
 * @param {QuotaWire} quota
 * @param {"5h" | "week"} [scopeFilter]
 */
function worstOf(quota, scopeFilter) {
  let best;
  for (const p of quota.providers) {
    for (const w of p.windows) {
      if (scopeFilter !== undefined && w.scope !== scopeFilter) continue;
      if (
        best === undefined ||
        w.level > best.window.level ||
        (w.level === best.window.level && w.usedPct > best.window.usedPct)
      ) {
        best = { provider: p, window: w };
      }
    }
  }
  return best;
}

/**
 * D6 pill view-model. `null` when there is nothing to show (no providers/windows at all —
 * caller renders no pill, same as an absent `quota` wire).
 * @param {QuotaWire | undefined} quota
 * @returns {{
 *   level: 0|1|2|3, providerId: string, scope: "5h"|"week", usedPct: number,
 *   resetScope: "5h"|"week"|undefined, resetAt: number|undefined,
 * } | null}
 */
export function pillView(quota) {
  if (quota === undefined || !Array.isArray(quota.providers) || quota.providers.length === 0) return null;
  const worst = worstOf(quota);
  if (worst === undefined) return null;
  const { provider, window } = worst;

  // Reset-time annex (independent of the headline selection above — plan D6's second rule):
  //  - a triggered (level>=1) 7d/week window always carries its own reset time;
  //  - a triggered 5h window carries its reset only once usedPct > 70;
  //  - whenever a 5h window AND a week window are BOTH independently triggered (level>=1)
  //    anywhere in the whole snapshot, the week side wins regardless of which window the
  //    headline above actually picked (user 2026-10-08 amendment).
  let resetScope;
  let resetAt;
  if (window.level >= 1) {
    if (window.scope === "week") {
      resetScope = "week";
      resetAt = window.resetAt;
    } else if (window.usedPct > 70) {
      resetScope = "5h";
      resetAt = window.resetAt;
    }
  }
  const anyFiveHTriggered = quota.providers.some((p) => p.windows.some((w) => w.scope === "5h" && w.level >= 1));
  const anyWeekTriggered = quota.providers.some((p) => p.windows.some((w) => w.scope === "week" && w.level >= 1));
  if (anyFiveHTriggered && anyWeekTriggered) {
    const worstWeek = worstOf(quota, "week");
    resetScope = "week";
    resetAt = worstWeek?.window.resetAt;
  }

  return {
    level: window.level,
    providerId: provider.id,
    scope: window.scope,
    usedPct: Math.round(window.usedPct),
    resetScope,
    resetAt,
  };
}

/**
 * D5 cross-session hoist: among every subscribed agent's mirrored `status.quota`, picks the one
 * with the largest `at`. Agents without a (well-formed) quota wire are skipped; `undefined` when
 * none carries one (quota feature off everywhere / no session sampled yet).
 * @param {Iterable<{ status?: Record<string, unknown> }>} agents
 * @returns {QuotaWire | undefined}
 */
export function freshestQuota(agents) {
  let best;
  for (const a of agents) {
    const status = a && typeof a === "object" ? a.status : undefined;
    const q = status && typeof status === "object" ? /** @type {any} */ (status).quota : undefined;
    if (q === null || typeof q !== "object") continue;
    if (typeof q.at !== "number" || !Number.isFinite(q.at)) continue;
    if (!Array.isArray(q.providers)) continue;
    if (best === undefined || q.at > best.at) best = q;
  }
  return best;
}
