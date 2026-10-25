# quota · 开发者要点

> 何时读：改动 `src/quota/**`、`quota.*` 设置键、额度提醒梯度、spawn 额度闸门之前。
> 来源：AGENTS.md@fcbf71dc 的对应条目，原文搬运，未改写（仅路径按目录移动更新）。新的实现细节直接写在这里，不要再写回 AGENTS.md。
> 相关：`../external-agent/quota-plan.md`、`../quota-web/`

## src/quota/

`src/quota/` — quota-aware dispatch: provider adapters + TTL cache, laddered turn_end warnings, and a spawn fast-fail gate
(design: `docs/dev/quota/`). A window whose `resetAt` has elapsed levels to 0 (`reason:"reset-elapsed"`, HUD `7d 100%·reset`) and bypasses
the refresh TTL only while the snapshot predates the reset; `quota.repeatS` re-sends at L3 only. Ladder thresholds are per-window
(repo defaults: 5h 50/75/90, week/7d 50/95/98 — `ladder.ts`'s `DEFAULT_THRESHOLDS_BY_WINDOW`; `l3EtaMs` stays global). `quota.windows.{5h,week}.{l1,l2,l3}Percent`
override a single window; the legacy flat `quota.l1Percent/l2Percent/l3Percent` still work and, when set, override BOTH windows
(back-compat) — window-level fields win over the flat override, which wins over the per-window default. Each window's l1<=l2<=l3
is clamped independently.
**droid pools** (`src/quota/adapters/droid.ts`, plan `docs/dev/external-agent/quota-plan.md`): Factory's standard/core pools are
virtual providers `droid-standard`/`droid-core` with a `month` window (`mo`); `droid/<id>` spawns gate on the owning pool with the
**core→standard fallback** (2026-10-16 user-confirmed live: core-pool models keep running, billed against standard quota, once core
is exhausted — `verdictsForModel` returns `["droid-core","droid-standard"]` keys so a core model is blocked only when BOTH pools are
at the block level; standard models never fall back; unknown pool ⇒ both must be exhausted), notices/listings say 「额度尽，回落
Standard 计费」 (pool state `"fallback"`) instead of 告急/已拦 while standard has room, extra-usage blocks unless
`quota.droidAllowExtraUsage`; 401/402/403 now also signal the external-provider availability gate (2026-10-20,
supersedes quota-plan D3's warn-only rule; HUD unchanged); web rows need cap `quota.pools.v1`. Suspicious-reading
detection survives restarts: `baseline.ts` persists each provider's last ACCEPTED reading into the same `quota-state.json`
(`baselines` key; both stores read-modify-write so neither flush clobbers the other's group) and seeds `classifyDrop` after a
restart — display/verdicts still need a fresh accepted snapshot; an all-zero reading against a non-elapsed >0 baseline is never
confirmed as a reset by repetition (only reset evidence or a non-all-zero read accepts).
