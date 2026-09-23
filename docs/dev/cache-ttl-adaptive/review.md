# `cache-ttl-adaptive` 实施方案评审（独立评审，第二轮）

评审对象：`docs/dev/cache-ttl-adaptive/plan.md`（1181 行）。
方法：成本推导全部独立重算；方案引用的代码锚点逐一与工作区（含未提交改动）比对；
保活既有实现不重审，只核对接口。

**总评：可以开工** —— 成本推导**无错误**（本次头号核查目标，详见 §1），无 Blocker；
但有 2 个 Major（探针/冷热判据在 compact、换模型、小前缀会话上会假阳性熔断，建议开工前先修，
修法已给出，不动整体设计）。

---

## 1. 成本推导复核（评审点 1，最高优先级）：**全部通过，无基准混用**

逐项独立重算（P=410k，R=$5/M，R 由 $0.41/821k@0.1× 反推 = $4.99/M ✓）：

| 位置                           | 重算                                                                                        | 结论                                                                                       |
| ------------------------------ | ------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------ |
| §0.3 标定                      | 0.1P=$0.205、0.75P=$1.5375、1.25P=$2.5625、2P=$4.10                                         | ✓                                                                                          |
| §0.3 ping 对照表               | 3×0.205=$0.62；7.5×0.205=$1.54（平衡点）；11×0.205=$2.26                                    | ✓，且显式标注「写入时带 1h=$1.54」的基准是**冷请求边际**（2.0P−1.25P），正是 M1 要求的口径 |
| §0.4 A/B/C 推导                | 基线 B′=A ⇒ 0.1A+1.25(C−A)；全量改写 B=C ⇒ 0.1A+2.0(C−A)；边际 0.75(C−A)=0.75Δ              | ✓ 推导正确；「全量改写 ⇒ B=C 且满足长 TTL 在前」作为 I-A2 的硬理由成立                     |
| §0.4 两极端                    | 冷 0.75P=$1.54；热 Δ=16k ⇒ 0.75×16k×$5/M=$0.06                                              | ✓                                                                                          |
| §3.6 真值表边际列（18 行逐行） | #1 0.75×8k=$0.03、#4 ≈$0.02、#6 ≈$0.01、#9 ≈$0.01、#13 ≈$0.02；#2/#5/#16 冷 $1.54；拒绝行 0 | ✓ 全部与「同请求不改写」基准一致                                                           |
| §4.4 上界                      | 0.75×(200k+410k)×$5/M=$2.2875≈$2.29；1.25P=$2.5625≈$2.56；合计 $4.85                        | ✓ 算术正确；逻辑上「预算升级前检查 + 单次 cacheWrite ≤ P」⇒ Σ≤W+P 成立（一个洞见 Minor 1） |
| §4.4 典型会话                  | 3–8×0.75×8k×R=$0.09–0.24 ⇒ "$0.1–0.25"                                                      | ✓                                                                                          |
| §0.5/§6.3 等                   | 误判比 1.54/0.205=7.5×、0.06/0.205=0.3×；§6.3 表各行与表头基准（不做任何事时的 1.25P）一致  | ✓                                                                                          |

**基准一致性（热=Δ、冷=P）**：全文逐处核对（§0.3、§0.4、§0.5、§3.3、§3.6、§4.1、§4.4、§6.3 表），
热升级一律 0.75Δ、冷升级一律 0.75P，**无漂移、无总/边际混用**。上一轮 M1 和主会话犯的
两个错误这次都没有：方案甚至把 §0.3 的 $1.54 显式标注为冷基准、把 E3 的 1.25P 显式标注为
「ping 本可覆盖」基准，口径声明是合格的。

唯一可挑剔（不构成错误）：§7.4 拿「adaptive $4.85/**会话**」对比「保活 $2.26/**窗口**」，
单位不对等（一个会话可有多个窗口）；但该对比用于**反对**改默认、方向保守，不误导决策。

对 §6.2 描述 keepalive §6.3 的核实：`consumeUpgrade` 确实要求
`now − lastReadStartedAt > ASSUMED_TTL_MS`（`src/cache-ttl/keepalive-state.ts:721-733`），
即只在缓存推定已死时触发 ⇒ 边际确为 0.75P=$1.54，方案描述准确 ✓。

## 2. Major

### M1 — 探针与冷热判据对「合法的前缀变更」假阳性：compact / 换模型后 adaptive 会熔断自杀

**问题**：`warm` 判定（plan.md:290-298）只看 `ledger.cacheRead > 0` + 时间窗，**账本没有
新鲜度/前缀锚定**。而 pi 的 compaction 是**追加** compaction entry、不删历史
（`node_modules/.../dist/core/compaction/compaction.js:46-52`，`getMessageFromEntryForCompaction`
对 compaction entry 返回 undefined、旧 assistant entries 仍在 `getEntries()` 里）⇒ compact 后
`readLatestAssistantUsage` 读到的仍是 compact **前**的账本（cacheRead>0、cacheWrite 很小）。
此时若有强信号（subagent 还在跑——dev-flow 长会话的常态）：判热 → Δ̂ 小 → 过 delta 门 →
**热升级**。但这次请求的前缀是压缩后的新前缀，实际写入很大：

- 部分命中（系统提示命中、summary 重写）⇒ writeRatio 极易 > 25% ⇒ `warm-write-too-expensive`
  熔断（plan.md:432）；
- 全 miss（或换模型后新缓存命名空间，必全 miss）⇒ `warm-miss` 熔断（plan.md:433）。

熔断是**会话级永久**的（plan.md:439）。也就是说：**每次 compact/换模型 + 后台工作在跑，就有
不小概率把 adaptive 在本会话直接打死**——而长会话恰恰是 adaptive 的主战场。
`invalidateAdaptive`（plan.md:861 表）只清 pending 与 cover，**不使旧账本失效**，挡不住这条
时序（invalidate 发生在 compact 事件时，误判升级发生在下一个请求）。
注：这次升级本身成本有界（计入 W，≤0.75×压缩写入），甚至买 1h 是对的——坏的是**熔断**：
probe 把「前缀合法变更」误读成「§0.4 推论 1 在此路由不成立」。

**证据**：plan.md:290-298（warm 判定）、:432-433（两条探针）、:861-876（invalidate 语义）；
`src/cache-ttl/cache-ttl.ts:88-106`（现有账本读取不含 model/entry 锚定，方案沿用）。

**建议修法**（任选其一，a 更优）：
a. 账本带锚定：`LedgerUsage` 增加 `entrySeq`（`getEntries().length`）与 `modelId`；
`invalidateAdaptive` 记录 `lastInvalidateSeq`；warm 要求 `ledger.entrySeq > lastInvalidateSeq
   && ledger.modelId === ctx.model.id`。前缀变更后的首个请求账本不新鲜 ⇒ 判**冷** ⇒ 走冷分支
（强信号下仍可升级一次，语义本来就该如此，且不经过热探针）。
b. 兜底：`reconcile()` 里若 pending 之后发生过 invalidate，跳过当次两条热探针判定。

### M2 — `probeMaxWriteRatioPercent=25` 在小/中前缀会话假阳性

**问题**：判据 `cacheWrite/(cacheRead+cacheWrite) > 25%` 等价于 `Δ > A/3`（A=命中前缀）。
本方案按 P=410k 标定（Δ=16k 时 ratio≈4%），但对小会话：A=40k、Δ=16k ⇒ 28.6% ⇒ **熔断**；
凡 A < 96k 的会话，一次顶格（32k）合法增量即熔断。小前缀会话里「增量占比天然偏高」是
**正常形态**而非推论 1 失效。该判据「不依赖 cache_creation 拆分」的鲁棒性论点成立，但
25% 这个常数本身在大/小会话间不可移植。且 pending 里明明记了 `predictedDeltaTokens`
（plan.md:421），更直接的判据（实际写入 vs 预测增量）没有被使用。

**证据**：plan.md:419-443（§4.2）、:379（`maxDeltaTokens=32_000` 默认值）。

**建议修法**：trip 条件改为复合判据，例如
`cacheWrite > max(3 × predictedDeltaTokens, 48_000)`（仍只用 cacheRead/cacheWrite 两字段，
不依赖拆分字段，保留原有鲁棒性论点），或 ratio 判据叠加绝对下限（如 `>25% 且 cacheWrite>64k`）。
测试矩阵补「小前缀合法大增量不熔断」用例（§11.1 F 组目前只有正向熔断用例 plan.md:969）。

## 3. Minor

### m1 — §4.4「可证明」上界在 droppedPending 路径有洞

pending 被丢弃（账本 120s 未至或 seq 不齐，plan.md:618-620）时，该次升级的**实测** cacheWrite
不计入 `upgradeWriteTokens` ⇒ 真实上界是 0.75×(W+2P)×R 而非 0.75×(W+P)×R。实务敞口很小：
账本连续读不到 ⇒ 后续请求判冷 ⇒ 被 `coldUpgrades=1` 兜住，泄漏 ≤ 一次 0.75P。
**建议**：pending 丢弃时按 `predictedDeltaTokens` 预记账，或在 §4.4 注明该 caveat（「可证明」
三字目前的表述过强）。证据：plan.md:472-481、:616-620。

### m2 — reconcile 的非 pending 路径缺幂等水印

`reconcile()` 挂在 `message_end`/`turn_end`/`agent_end` 三处（plan.md:861-876），同一轮会
多次触发。pending 结账有 `requestSeq`/entrySeq 水印保护（plan.md:616-619 ✓），但
§5.2 的 `indirect1hConfirms`/`ineffective1h` 分支（plan.md:552-561）没有水印 ⇒ 同一账本会被
三个事件重复计数（审计计数虚高；`ineffective1h` 重复 trip 产生重复审计条目）。
**建议**：记 `lastReconciledEntrySeq`，reconcile 的一切副作用都过这道水印；补一条
「message_end+turn_end 双触发只计一次」的用例（现有 #29 只护 pending 结账）。

### m3 — S4 锁存后烧预算，可能堵死后续冷升级；预算耗尽以熔断呈现

S4 锁存后热升级持续消耗 W（200k），长会话中段即可撞线；`write-budget` 是会话级永久熔断
（plan.md:434、439），此后真正需要冷升级的场景被 G-G 拒掉。且「预算耗尽」是正常运维事件，
以 `breaker`（tone=bad）呈现在语义上是误报。
**建议**：预算耗尽只走 G-G 静默拒绝（保留观测），不再 `trip("write-budget")`；或热/冷分列预算
（冷预算独立保证 coldUpgrades=1 始终可用）。

### m4 — `oneHourCoverUntil` 在 decide 时刻乐观武装

cover 从「最近一次升级时刻」（决策时）起算（plan.md:447），若升级请求 HTTP 失败（无账本、
pending 被丢弃），1h 条目实际不存在，但 cover 已生效 ⇒ 后续 >5min 空档的 miss 会以
`1h-ineffective` **误熔断**。
**建议**：cover 在 reconcile 确认（该 pending 的账本到达且 cacheWrite>0）后才武装。
（前缀变更类假阳性已被 invalidate 清 cover 覆盖 ✓；Anthropic 提前驱逐属低概率残余，可接受。）

### m5 — S4 的「锁存」语义与文档表述不符；节流结论：够用

§3.3 说「出现一次 >5min 空档，后续所有热请求都带 1h」，但环形缓冲 20 条（plan.md:328、
`ADAPTIVE_GAP_RING_SIZE=20`）意味着 20 个密集间隔后证据消失——实际是「粘性但会衰减」，
文档应明说。量化（评审点 3）：dev-flow 会话长空档几乎必然复发，S4 事实上长期为真 ⇒
退化为「热请求逢 16k 增量必升级」。单次 ≤0.75×32k×R=**$0.12**（Δ̂ 门 32k），典型
$0.008–0.03；节流 + W 兜底 ⇒ 会话级额外支出 **≤ ~$0.75 后预算熔断**。对照收益（每个
≤60min 空档省一次 $2.56 重写），期望为正，**节流足以按住成本，不构成缺陷**；真正的副作用
已单列为 m3。另：S4-only 时 `episodeJustArmed=false`（plan.md:337，`strong.length>0` 才绕过节流）
⇒ S4 受 16k 节流约束 ✓，但真值表 #9 未钉住节流态，建议补一行「S4-only + 累计 <16k ⇒
refresh-throttled」及对应用例。

### m6 — dispose 后 decide 复用 `breaker` 理由

测试 #42 注明「实现取 `breaker`，并在注释里说明」（plan.md:950-952）——disposed 与真熔断在
审计里不可区分。建议加一个独立 `AdaptiveDeclineReason = "disposed"`，一行的事。

## 4. 锚点核查（评审点 5）：**1 处错误 + 2 处漂移**（上一轮是 2 处错误）

**错误（1 处）**：

- plan.md:606（§6.1）引 `src/cache-ttl/cache-ttl.ts:315-317` 作为「先 `rewrite(cloned,…)` 再
  `captureRequest(cloned,…)`」的证据——实际在 **:310-311**（:315-317 是 `before_provider_headers`
  的 doc comment）。所断言的**顺序本身属实** ✓，仅行号错。

**漂移（2 处，内容正确、行号偏 2-4 行或范围标错）**：

- plan.md:697/895（§7.3.5）`settings.ts:424-434` 指 `TIME_SETTING_MS_PATHS`——数组实为
  **:407-435**（:424 是 `bashJobs.autoBackgroundMs`）；插入点（:433 之后）可操作。
- plan.md:850（§9.3）`cache-keepalive.ts:176-190` 指 `accept()`——实际 **:180-191**。

**抽查命中（全部逐一核对过，✓）**：`cache-ttl.ts:263`（before_provider_request）、`:275`
（consumeUpgrade 调用）、`:88-106`、`:128-142`、`:185`（wireKeepaliveEvents）、`:194-201`
（ui_prompt 转发）、`:31-35`、`:49-53`、`:56-70`、`:332`、`:365`；`keepalive-state.ts:327-328`
（门 #7）、`:831`、`:846-870`（renderPingSegment，→1h 在 :860）；`settings.ts:132`、`:133-146`、
`:309`（autoBackgroundMs=290_000）、`:337-343`、`:609-633`、`:943`、`:953`、`:969-1005`；
`setting-specs.ts:236-240`、`:260+`；`stack.ts:119`、`:476`、`:700`、`:1083-1097`、`:1089-1091`、
`:1278`；`index.ts:164`、`:440`、`:472`；`core/types.ts:78-91`；`bash/manager.ts:226`（接口行，
实现在 :1042，可接受）；`cache-keepalive.ts:231`（armed）、`:247-251`
（supportsLongCacheRetention）；`tests/integration/cache-keepalive.test.ts:251`；
`hud/footer.ts:183`；`compact-hint/threshold.ts:12`（subagent:usage-tick 先例）。

**门编号裁定**：`capture.shape.ttl1h` 门在**代码**里是 **#7**
（`src/cache-ttl/keepalive-state.ts:327-328`），在 **keepalive plan.md 里也是 #7**
（`docs/dev/cache-ttl-keepalive/plan.md:534`；#6 是 `ephemeralBreakpoints===0`）。
方案写 #7 与两者一致，**无冲突**。评审任务书「keepalive plan.md 里是 #6」的前提不成立。
（代码另有实施期插入的 `#7.5` not-streaming 门，未改 #7 编号，不影响本方案引用。）

**pi 内部引用（§13）抽查**：`pi-ai/dist/types.d.ts:265-271`（`cacheWrite1h?: number` ✓）、
`models.js:537-543`（1h 按 2× 计价 ✓）、`anthropic-messages.js:120`（`?? true` ✓）、
`:19-27`/`:28-37`（resolveCacheRetention/getCacheControl ✓）、bundle chunk
`anthropic-messages-JWX2WP65.js` 的 `cacheWrite1h=…ephemeral_1h_input_tokens||0` ✓、
`compaction.js:54-60`（combineUsage 保留 cacheWrite1h ✓）。§5.1「能确认」的结论成立。

## 5. 其余评审点结论

**评审点 2（冷热判据可靠性）**：稳定循环内可靠（一轮多请求每请求刷新
`lastRequestStartedAt` 且账本逐条更新 ✓）；工具结果涌入由 delta 门兜底、方向保守 ✓（§3.4
论证成立）；compact/换模型后不可靠 → 已列 M1。误判成冷=漏升级零成本 ✓；误判成热=多付
≤0.75P（计入 §4.4 上界）+ 熔断——熔断过重是 M1 的核心。

**评审点 4（探针与熔断完备性）**：除 M1/M2/m4 外，回退路径**闭合**已验证：熔断 → passthrough
→ payload 无 ttl1h → 门 #7（keepalive-state.ts:328，`skip(…, terminal:true)` 仅本窗口）放行
→ 下一次真实请求 `onRealRequest` 重建窗口 → ping 自动恢复 ✓。`1h-ineffective` 的前缀变更类
假阳性已被 invalidate 清 cover 覆盖 ✓。

**评审点 6（零悬挂与生命周期）**：不违反 AGENTS.md 任何铁律。零定时器（I-A8）✓；
`previousAdaptive` 沿用 `previousKeepalive` 既有范式（stack.ts:119 同款）✓；session_start
防御块 + session_shutdown 双 dispose 与保活同构 ✓；无 await/在途请求 ⇒ 不需要 window epoch
的论证成立 ✓；子会话惰性由 HOST_KEY 守卫保证（wireCacheTtl 在 `src/index.ts:164`，位于
`if (g[HOST_KEY]) return;` 之后 ✓）。reconcile 挂三事件的漏触发面有 pendingTtlMs 兜底 ✓，
重复触发面见 m2。

**评审点 7（测试矩阵）**：18 行真值表表驱动 ✓、三种熔断 + write-budget ✓、四档互不串味
（#48，含 I-A9 互斥断言）✓、#55 钉住门 #7 衔接（`shape.ttl1h===true`）✓、#71「升级后推进
时钟一次 fetch 都不发」是强断言 ✓、#56 三档逐字回归 ✓。**未发现断言过松的用例**。缺口：
W=0 回滚无显式用例（仅 B8 隐式覆盖）；m2 的双触发幂等用例；M1/M2 的回归用例（compact 后
首请求、小前缀大增量）；m5 的 S4-only 节流用例。

## 6. 结论汇总

- **总评**：**可以开工**（无 Blocker；建议开工前把 M1/M2 的修法并入步骤 3 的纯函数设计，
  二者都只动 `decideAdaptiveTtl`/reducer 的判据，不动装配与生命周期）。
- **成本推导**：无错误。基准全程自洽（热 0.75Δ / 冷 0.75P），§4.4 算术与逻辑成立
  （m1 的 droppedPending 洞敞口 ≤0.75P，需补注或预记账）。
- **锚点**：1 处错误（plan.md:606 的 :315-317 应为 :310-311）+ 2 处漂移；门编号 #7 无误。
