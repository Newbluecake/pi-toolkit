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

**opencode-go**（`src/quota/adapters/opencode.ts`，2026-11-03）：OpenCode Go 套餐，`GET {quota.opencodeGoBaseUrl}/zen/go/v1/usage`
（默认 https://opencode.ai，实测 HTTP 200），`Authorization: Bearer <key>`（auth.json `opencode-go` / env `OPENCODE_API_KEY`）；
`usage.{rolling,weekly,monthly}` ⇒ `5h`/`week`/`month` 三窗格独立解析（一格坏只丢一格，全坏 ⇒ undefined），percent=已用
百分比（clamp 0..100）、resetsAt ISO ⇒ resetAt。默认在 `quota.providers` 白名单里（无 key 时零请求）；web 行走既有
`quota.pools.v1` cap 门控白名单（legacy 路径字节不变），i18n 标签「OpenCode Go」。

**费用折算（`src/quota/cost-scan.ts`，2026-11-03 用户拍板，形态 B）**：quota 面板各窗口重置文案旁显示
按 API 目录价折算的费用（`22:06 重置 · ≈$12.30`，不新增行；HUD 不加；推翻 quota-web D8——LAN 也显示、
无设置门）。数据源 = pi 会话 JSONL 增量扫描：`<agentDir>/sessions/<编码cwd>/*.jsonl` 的 assistant 条目
自带 provider/timestamp/usage.cost.total（pi 已算好）；主/子会话文件同目录全计入（子用量只在子文件里，
无双算）；**只扫当前 cwd 的会话目录**（拍板的数据源边界，跨 cwd 用量不并入）。有界增量范式抄
provenance.ts（per-file byte 游标、两车道、单 pass ≤250ms/≤16MiB、nofollow open、≤1fd）；关键差异：
hour bucket **按文件归属**——文件身份变化/收缩 ⇒ 该文件 bucket 连游标一起丢弃重扫，严格无双算。游标 +
buckets 以 `costScan` 顶层组读改写进 quota-state.json（同 demotion/baseline 纪律：flush 前重读保留其它组、
tmp+rename、0600；bucket 保鲜 40d，状态上限 8MiB 最旧 mtime 淘汰）。计价：`cost.total` 有限 ⇒ 权威（含 0）；
缺失 ⇒ token×目录价兜底（`ctx.modelRegistry.find` 注入，per-Mtok，仿 pricing.ts 的 priceUsage 无 tier）；
目录价全零 ⇒ 计 $0 不标（「零价」）；目录价缺失 ⇒ 该小时记 unpriced（「无价」），窗口和是上界下界 ⇒
wire `costUnpriced:true` ⇒ UI `≈$X.XX+`。窗口对齐：起点 = resetAt − 时长（5h→5h、week→7d、month→30d，
`COST_WINDOW_SPAN_MS`），hour bucket 相交即计入（边缘 ±1h 误差，`≈` 前缀声明近似）；resetAt 缺失 ⇒
不出折算。wire：`QuotaWindowWire.costUsd?/costUnpriced?`（open schema 免 PROTO bump，legacy/pools 两路
都放行——旧 hub 忽略未知键不丢帧；无 cost 数据时投影/指纹逐字节不变，quota-legacy golden 与
kimi-zai golden 钉死）；`quotaFingerprint`按分四舍五入纳入。驱动：扫描器无 timer（I5），
stack 随 quota 构造（惰性加载、资源零持有 ⇒ 不进 stack-teardown 步骤表），web-hub agent 1Hz tick 经`deps.quotaCostTick` 推进（内部节流 incomplete 2s / complete 15s + single-flight）；webHub 关 ⇒
零 I/O（I9）。droid-standard/droid-core 是外部 provider，JSONL 无数据 ⇒ 不出折算。GLM 合并行
（`glmPair` worst-of 按引用挑窗）⇒ 折算跟随供窗一侧。残留：初始回填期间（本机 1.4GB/1163 文件约数分钟）
折算是下界但不带标记；`costUsd` 不含跨 cwd 会话用量。
