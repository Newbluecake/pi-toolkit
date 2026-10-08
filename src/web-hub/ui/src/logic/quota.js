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
 * Worst window of a list: level desc, then usedPct desc; ties keep the first encountered
 * (every caller relies on the arrays' fixed upstream order — never randomized). Non-finite
 * `usedPct` compares as 0 (see `normPct`) — same defensive wire policy end-to-end.
 * @param {QuotaWindowWire[]} windows
 */
function worstWindow(windows) {
  let best;
  for (const w of windows) {
    if (best === undefined || w.level > best.level || (w.level === best.level && normPct(w) > normPct(best))) {
      best = w;
    }
  }
  return best;
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
    const w = worstWindow(scopeFilter === undefined ? p.windows : p.windows.filter((x) => x.scope === scopeFilter));
    if (w === undefined) continue;
    if (
      best === undefined ||
      w.level > best.window.level ||
      (w.level === best.window.level && w.usedPct > best.window.usedPct)
    ) {
      best = { provider: p, window: w };
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

/** GLM merge pair ids, in snapshot-emit order (label comes from the first). */
const GLM_CN_ID = "zai-coding-cn";
const GLM_INTL_ID = "zai";

/** Defensive pct read: a non-finite `usedPct` behaves as 0% everywhere — comparisons AND
 *  display — so a degenerate window never throws, never leaks `NaN%`, and never beats a
 *  finite sibling on the tie-break (verifier 2026-10 wire policy).
 * @param {QuotaWindowWire} w */
function normPct(w) {
  return Number.isFinite(w.usedPct) ? w.usedPct : 0;
}

/**
 * True when two providers carry indistinguishable headline values — the same set of window
 * scopes, and per scope the same `level` and the same ROUNDED `usedPct` — so the pill/card may
 * collapse them into ONE row. Currently applied to the `zai-coding-cn`/`zai` (GLM / GLM 国际)
 * pair only, but the comparison itself is provider-agnostic. Windows are reduced per scope with
 * the same worst-window comparison as everywhere else (defensive: scopes are unique in
 * practice). Non-finite usedPct never compares equal (NaN !== NaN).
 * @param {QuotaProviderWire} a
 * @param {QuotaProviderWire} b
 */
export function glmMergeable(a, b) {
  const worstByScope = (windows) => {
    const m = new Map();
    for (const w of windows) {
      const cur = m.get(w.scope);
      if (cur === undefined || w.level > cur.level || (w.level === cur.level && w.usedPct > cur.usedPct)) {
        m.set(w.scope, w);
      }
    }
    return m;
  };
  const ma = worstByScope(a.windows);
  const mb = worstByScope(b.windows);
  if (ma.size !== mb.size) return false;
  for (const [scope, wa] of ma) {
    const wb = mb.get(scope);
    if (wb === undefined) return false;
    if (wa.level !== wb.level) return false;
    if (Math.round(wa.usedPct) !== Math.round(wb.usedPct)) return false;
  }
  return true;
}

/**
 * Per-provider pill view-models (2026-10 multi-group requirement: the top bar shows EVERY
 * subscription's availability, not just the single worst one — and an exhausted L3 group keeps
 * its label, ⚠ is only ever a prefix). One group per provider in snapshot order (providers with
 * no windows are skipped — nothing to show for them), each carrying:
 *  - its own headline window = that provider's worst window (level desc, then usedPct desc —
    the same comparison `worstOf` uses snapshot-wide);
 *  - the D6 reset-annex decision scoped to that provider ALONE (triggered week ⇒ week reset;
    triggered 5h with usedPct>70 ⇒ 5h reset; both triggered ⇒ week reset), plus the
    unavailable fallback: a level-3 group always carries its headline window's resetAt when
    known ("不可用" with a recovery time);
 *  - `available: level < 3` (level 3 = exhausted/near-exhausted ⇒ the spawn gate fast-fails
    new runs on that provider, i.e. "unavailable" to the dispatcher).
 *
 * GLM merge: when BOTH `zai-coding-cn` and `zai` are present and `glmMergeable` holds, they
 * collapse into ONE group emitted at the FIRST one's snapshot position (the other contributes
 * no group of its own), with `ids:[both]` and `labelId:"zai-coding-cn"` (label "GLM") — values
 * and reset annex come from the `zai-coding-cn` side (identical by the merge rule, modulo
 * resetAt/etaMs the pill/card read only from the first). The pair decision itself lives in
 * `glmPair` below — the ONE shared rule the card reuses, never re-implemented locally.
 *
 * Defensive wire policy (verifier 2026-10): a provider id the UI does not know (a future wire
 * peer) simply renders under its raw id — `labelId` is the id and the component's label lookup
 * falls back to it; a non-finite `usedPct` reads as 0% — the group is still shown, never
 * `NaN%`. Neither ever throws.
 * @param {QuotaWire | undefined} quota
 * @returns {{
 *   ids: string[],
 *   labelId: string,
 *   level: 0|1|2|3,
 *   scope: "5h"|"week",
 *   usedPct: number,
 *   windows: {scope: "5h"|"week", level: 0|1|2|3, usedPct: number}[],
 *   weekResetAt: number|undefined,
 *   resetScope: "5h"|"week"|undefined,
 *   resetAt: number|undefined,
 *   available: boolean,
 * }[]}
 */
export function pillGroups(quota) {
  if (quota === undefined || !Array.isArray(quota.providers)) return [];
  const providers = quota.providers.filter((p) => Array.isArray(p.windows) && p.windows.length > 0);
  const pair = glmPair(providers);

  /** Both windows of one provider, 5h first then week (user 2026-10-08: an available group
   *  shows BOTH quotas, not just the worst window), worst-window per scope defensively, each
   *  with its own rounded pct (non-finite ⇒ 0, same defensive policy as the group headline). */
  const windowsOf = (p) => {
    const worst = new Map();
    for (const w of p.windows) {
      const cur = worst.get(w.scope);
      if (cur === undefined || w.level > cur.level || (w.level === cur.level && w.usedPct > cur.usedPct)) {
        worst.set(w.scope, w);
      }
    }
    const order = { "5h": 0, week: 1 };
    return [...worst.values()]
      .filter((w) => w.scope === "5h" || w.scope === "week")
      .sort((a, b) => order[a.scope] - order[b.scope])
      .map((w) => ({
        scope: w.scope,
        level: w.level,
        usedPct: Math.round(normPct(w)),
      }));
  };

  /** One group off a single provider's windows (headline = worst window; D6 annex scoped to
   *  that provider alone; level-3 groups always advertise a recovery time when one is known). */
  const groupOf = (p, ids, labelId) => {
    const headline = worstWindow(p.windows);
    // D6 reset annex, scoped to this provider alone (a provider's windows have one entry per
    // scope in practice; worstWindow makes duplicate scopes deterministic anyway).
    const week = worstWindow(p.windows.filter((w) => w.scope === "week"));
    const five = worstWindow(p.windows.filter((w) => w.scope === "5h"));
    let resetScope;
    let resetAt;
    if (week !== undefined && week.level >= 1) {
      resetScope = "week";
      resetAt = week.resetAt;
    } else if (five !== undefined && five.level >= 1 && five.usedPct > 70) {
      resetScope = "5h";
      resetAt = five.resetAt;
    }
    if (headline.level >= 3 && resetAt === undefined && headline.resetAt !== undefined) {
      // Unavailable groups always advertise a recovery time when one is known.
      resetScope = headline.scope;
      resetAt = headline.resetAt;
    }
    return {
      ids,
      labelId,
      level: headline.level,
      scope: headline.scope,
      // Non-finite usedPct reads as 0% via normPct — the group still renders, never `NaN%`
      // (defensive wire policy, see the function header).
      usedPct: Math.round(normPct(headline)),
      windows: windowsOf(p),
      // Exhausted-display clock source: the WEEK window's resetAt, or the headline window's
      // when the provider has no week window at all (unknown ⇒ omit the clock).
      weekResetAt: week !== undefined ? week.resetAt : headline.resetAt,
      resetScope,
      resetAt,
      available: headline.level < 3,
    };
  };

  const groups = [];
  for (const p of providers) {
    if (pair !== undefined && pair.members.includes(p)) {
      if (p === pair.skip) continue;
      groups.push(groupOf(pair.source, [GLM_CN_ID, GLM_INTL_ID], GLM_CN_ID));
      continue;
    }
    groups.push(groupOf(p, [p.id], p.id));
  }
  return groups;
}

/**
 * The GLM merge PAIR decision — the ONE shared rule both the pill (`pillGroups`) and the card
 * (`QuotaCard.vue`'s `cardRows`) consume (never re-implemented locally): when BOTH
 * `zai-coding-cn` and `zai` are present and `glmMergeable` holds, the pair collapses into ONE
 * group/row.
 * @param {QuotaProviderWire[]} providers snapshot order
 * @returns {{
 *   skip: QuotaProviderWire,
 *   source: QuotaProviderWire,
 *   members: QuotaProviderWire[],
 * } | undefined} `undefined` ⇒ no merge. `skip` = the member that must NOT emit its own
 * group/row (the SECOND of the two in snapshot order); `source` = always the `zai-coding-cn`
 * side — its windows/values are what the merged group/row shows; `members` = `[cn, intl]`
 * regardless of snapshot order, for flag aggregation (plans / demoted / stale badges).
 */
export function glmPair(providers) {
  const cn = providers.find((p) => p.id === GLM_CN_ID);
  const intl = providers.find((p) => p.id === GLM_INTL_ID);
  if (cn === undefined || intl === undefined) return undefined;
  if (!glmMergeable(cn, intl)) return undefined;
  const cnFirst = providers.indexOf(cn) < providers.indexOf(intl);
  return { skip: cnFirst ? intl : cn, source: cn, members: [cn, intl] };
}

/**
 * Pill DISPLAY selection — 2026-10-08 user ruling (supersedes the plain "one segment per
 * provider" rendering): 「如果有可用订阅，只展示可用订阅；如果都耗尽了，展示 7d 重置时间」.
 *  - ≥1 available (level<3) group ⇒ `mode:"available"`, groups = ONLY the available ones
 *    (each renders BOTH its windows — `windows[]` on the group — plus its D6 reset annex);
 *    exhausted groups are hidden from the pill's face but stay in aria/title (the component
 *    reads `pillGroups` directly for that — never loses them for screen readers/hover).
 *  - ALL groups exhausted ⇒ `mode:"exhausted"`, groups = all of them, each rendered in its
 *    week-reset form: `⚠ Label · 7d {clock}` with the clock from `weekResetAt` (the week
 *    window's resetAt, or the headline window's when there is no week window; omitted when
 *    unknown).
 * `null` when there is nothing to show (no windowed providers) — caller renders no pill.
 * @param {QuotaWire | undefined} quota
 * @returns {{ mode: "available"|"exhausted", groups: ReturnType<typeof pillGroups> } | null}
 */
export function pillDisplay(quota) {
  const groups = pillGroups(quota);
  if (groups.length === 0) return null;
  const available = groups.filter((g) => g.available);
  if (available.length > 0) return { mode: "available", groups: available };
  return { mode: "exhausted", groups };
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
