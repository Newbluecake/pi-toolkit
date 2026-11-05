# quota · 开发者要点

> 何时读：改动 `src/quota/**`、`quota.*` 设置键、额度提醒梯度、spawn 额度闸门之前。
> 来源：AGENTS.md@fcbf71dc 的对应条目，原文搬运，未改写（仅路径按目录移动更新）。新的实现细节直接写在这里，不要再写回 AGENTS.md。
> 相关：`../external-agent/quota-plan.md`、`../quota-web/`

## src/quota/

`src/quota/` — quota-aware dispatch: provider adapters + TTL cache, laddered turn_end warnings, and a spawn fast-fail gate
(design: `docs/dev/quota/`). A window whose `resetAt` has elapsed levels to 0 (`reason:"reset-elapsed"`, HUD `7d 100%·reset`) and bypasses
the refresh TTL only while the snapshot predates the reset; `quota.repeatS` re-sends at L3 only. Ladder thresholds are per-window
(repo defaults: 5h 50/75/90, week/7d 50/95/98 — `ladder.ts`'s `DEFAULT_THRESHOLDS_BY_WINDOW`; `l3EtaMs` stays global).
Rule 3b (forecast-before-reset) is default-off for **5h as well as month** (2026-11-05 拍板；`DEFAULT_THRESHOLDS_BY_WINDOW` 是唯一开关源，
`service.thresholds()` 跟随它，settings 层只覆盖百分比/l3EtaMs ⇒ 用户改阈值不会重开；week 仍开，3a ETA 硬线保留)。注入给模型的
`[quota 预警/提示/严重]` 文案不再携带预测耗尽时间（2026-11-05 拍板：「按当前速率…后耗尽」「早于窗口重置（…）」「预计…内耗尽」
子句删除，只留用量 + `（窗口 … 重置）`；软化正文「可能在窗口重置前用完」非具体时间，保留；Web/HUD 的耗尽预估显示不变）。
`quota.windows.{5h,week}.{l1,l2,l3}Percent`
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

**费用折算（`src/quota/cost-scan.ts`，2026-11-03 用户拍板，形态 B；同日拍板改全项目扫描）**：quota 面板各窗口重置文案旁显示
按 API 目录价折算的费用（`22:06 重置 · ≈$12.30`，不新增行；HUD 不加；推翻 quota-web D8——LAN 也显示、
无设置门）。数据源 = pi 会话 JSONL 增量扫描：root = `<agentDir>/sessions/`，其下每个子目录一个项目
（`<编码cwd>/*.jsonl`），**全部项目计入**（2026-11-03 拍板的数据源边界，推翻早先「只扫当前 cwd」——
跨 cwd 用量本就该并入折算）；assistant 条目自带 provider/timestamp/usage.cost.total（pi 已算好）；
主/子会话文件同目录全计入（子用量只在子文件里，无双算）。有界增量范式抄 provenance.ts（per-file
byte 游标、两车道、nofollow open、≤1fd）；关键差异：hour bucket **按文件归属**——文件身份变化/收缩
⇒ 该文件 bucket 连游标一起丢弃重扫，严格无双算。单 pass 预算 **500ms/32MiB**（全项目 1.4GB/1166
文件量级：实测首回填 48 pass / 背靠背 7.2s，按生产 busy tick 2s 节奏 ≈ 1.5–2 分钟收敛；500ms 仍远小于
驱动它的 1Hz tick）。目录枚举有界且公平：root 每 pass readdir 一层；子目录分帧枚举（每 pass ≤1024
lstat + 时间片 ≤120ms，目录内可断点续扫；顺序 = 断点目录 → 热目录 → 轮转，不娥死早期目录）；首轮全量
枚举完成后转**轻量探测**（实测稳态 pass 4–37ms）：lstat 各项目目录（mtime 变 ⇒ 有增删 ⇒ 重枚举该目录）

- 抽 stat 48h 内活跃文件（append 不动目录 mtime）+ 每 pass 滚动补枚举 3 个目录（自愈漏网：唤醒沉睡会话
  最迟 目录数/3 个 idle pass 后发现，78 目录 ≈ 6.5min）。游标 + buckets 以 `costScan` 顶层组读改写进
  quota-state.json（同 demotion/baseline 纪律：flush 前重读保留其它组、tmp+rename、0600；**本组紧凑
  序列化**——条目多一个数量级后 pretty 缩进是不可接受的固定开销，同文件其它 store flush 时会重排格式，
  解析不受影响）。bucket 保鲜 40d；状态上限 **32MiB**（实测全项目状态 ≈ 360KiB，近 90× 余量）。淘汰防
  抖动（硬要求）：超限先淘汰「桶空且最旧 mtime」（重扫只费字节、不丢费用历史），不够再淘汰任意最旧；
  被淘汰路径记入进程内 evictedPaths **本进程不再重扫**（切断「淘汰→重扫→再淘汰」环；complete 保持
  false，与 TRACKED_FILES_MAX=20000 容量语义一致）；`view().readBytes`（本进程累计读取字节）是
  「无重复扫描」的可观测证据，测试钉住：收敛后重复 pass 零重读、append 只读增量。计价：
  `cost.total` 有限 ⇒ 权威（含 0）；缺失 ⇒ token×目录价兜底（`ctx.modelRegistry.find` 注入，per-Mtok，
  仿 pricing.ts 的 priceUsage 无 tier）；目录价全零 ⇒ 计 $0 不标（「零价」）；目录价缺失 ⇒ 该小时记
unpriced（「无价」），窗口和是上界下界 ⇒ wire `costUnpriced:true` ⇒ UI `≈$X.XX+`。窗口对齐：起点 =
resetAt − 时长（5h→5h、week→7d、month→30d，`COST_WINDOW_SPAN_MS`），hour bucket 相交即计入（边缘
±1h 误差，`≈` 前缀声明近似）；resetAt 缺失 ⇒ 不出折算。wire：`QuotaWindowWire.costUsd?/costUnpriced?`
（open schema 免 PROTO bump，legacy/pools 两路都放行——旧 hub 忽略未知键不丢帧；无 cost 数据时投影/指纹
逐字节不变，quota-legacy golden 与 kimi-zai golden 钉死）；`quotaFingerprint`按分四舍五入纳入。驱动：
扫描器无 timer（I5），stack 随 quota 构造（惰性加载、资源零持有 ⇒ 不进 stack-teardown 步骤表），
web-hub agent 1Hz tick 经`deps.quotaCostTick` 推进（内部节流 incomplete 2s / complete 15s +
single-flight）；webHub 关 ⇒ 零 I/O（I9）。进度可见：`view()`暴露`complete`+`scannedFiles`/
`totalFiles`（首轮枚举未扫完时 totalFiles 是下界）+ `readBytes`，供 `/agent status` 或后续 UI
使用（当前未接线）。droid-standard/droid-core 是外部 provider，JSONL 无数据 ⇒ 不出折算。GLM 合并行
（`glmPair`worst-of 按引用挑窗）：zai/zai-coding-cn 是同一 GLM 账号的两个端点（百分比恒等），
cost bucket 却按 JSONL 实际调用的 provider 归属——单侧窗口可能无 bucket，故折算是**账号窗口
费用**而非端点归因：投影层（quota-sampler`accountWindowCost`）对两 provider 分别求窗口费用后
usd 相加、unpriced 取 OR（全 undefined 才 undefined），两条 GLM wire 行带同一账号费用 ⇒
worst-of 挑哪侧、单侧出行都有折算，UI 不再相加（无双计）；非 GLM provider 行为逐字节不变。
残留：初始回填期间（实测 ≈1.5–2 分钟）
折算是下界但不带标记（可用`view().complete` 区分，UI 未接）。
