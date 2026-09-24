# 价格与缓存感知的动态 switch_context 阈值 · 实施方案 v2.1

> **状态（2026-09-25 回填）**：已实施（D1–D3，commits `2cc9107` / `af189dd` / `82b2b40` / `cd0d209`），
> D4 验收待真机（判据已展开为可执行步骤：`dynamic-threshold-acceptance.md`）。施工偏差见文末
> §15「施工偏差记录」；正文写作于施工前，「本文只写施工口径，不改代码」等表述为历史口径。
>
> 研究输入：`docs/dev/compact-hint/switch-threshold-research.md`（下称「研究」）。
> 所有「已核实」的接缝都带 `file:line`（HEAD 2026-09-25，v2.1 逐条复核过）。
> 相关方案：`docs/dev/compact-hint/compact-hint-plan.md`（hint/force/tick 现状）、
> `docs/dev/context-switch/context-switch-plan.md`（交接）、`docs/dev/cache-ttl-adaptive/plan.md`（价格/TTL/保活）。

---

## v2 修订记录

评审：gpt-6-astra，结论「修订后可施工」。用户已对全部决策点拍板。逐条处置如下。

### 用户拍板（全部采纳，见文末「已拍板决策」）

| 编号 | 拍板结果                                             | 落到本文哪里                                    |
| ---- | ---------------------------------------------------- | ----------------------------------------------- |
| D1   | 默认 `on`（`shadow`/`off` 保留）                     | §11.2；风险由 D3 的 `min` 合成 + force 不动兜住 |
| D2   | `R` 固定 $10，可配置，标注「经验先验，未跨模型校准」 | §5.1、§10.4 设置说明、§11.2                     |
| D3   | `min` 合成，动态线只能提前                           | §2.3、§3.6                                      |
| D6   | 订阅制 = 质量上限 + 额度高位前压，取值规则写死       | §8.2（含前压曲线）                              |
| D7   | 不进 tick 网格                                       | §9                                              |
| D8   | `maxQualityPercent = 60`，标注「未校准的安全上限」   | §3.5、§9、§11.2                                 |
| D9   | 改为「仅当前 session branch，不做跨 session 共享」   | §4.2                                            |
| D10  | 分档不下压 force                                     | §6④                                             |

### 范围调整（v1 瘦身）

| 编号 | 处置     | 说明                                                                                                                                                                    |
| ---- | -------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| D4   | **采纳** | 冷缓存 / TTL 整体推迟到 v2：v1 删除 cold 判定、冷却豁免、`·cold` 标记及其全部测试；不需要 settled-covered port（P1-2）。依赖记录在 §7。接缝表 S8/S9 降级为「v1 不读」。 |
| D5   | **采纳** | 遥测彻底去路径化：删除 `tool_call` 的路径集合、文件交集、纠正启发式。只记聚合数值，缺失记 `null`。字段改名为 `rProxy`（诚实标注为代理量）。落盘纪律见 §5.3。            |
| P1-1 | **采纳** | 5m/1h 写价不再区分，v1 只用模型声明的单一 `cacheWrite` 近似，`/agent status` 与遥测都带 `write pricing approximate` 标记。§3.2 / §10.3 / §5.2。                         |

### P0（全部采纳）

| 编号 | 处置     | 修法                                                                                                                                                                                                                                                                                                                                 |
| ---- | -------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| P0-1 | **采纳** | 纯函数返回判别联合 `{usable:true,…} \| {usable:false,reason}`，`0` 不再兼任「无线」与「线为零」。合成规则用 `staticHintActive` 判活，覆盖 percent=0 但绝对 token 线仍启用的组合。§3.1 / §3.6                                                                                                                                         |
| P0-2 | **采纳** | 先算可行区间 `[lowerBound, cap]` 再构造候选集，两端点恒在集合内；`cap < lowerBound`、reserve 接近窗口、窗口极小一律 `usable:false`。§3.4                                                                                                                                                                                             |
| P0-3 | **采纳** | 更正 `SessionCompactEvent` 字段（`fromHook` 在 `compactionEntry` 上，已核实 `types.d.ts:455-463` / `session-manager.d.ts:46-59`）；切换采纳与否用 `compactionEntry.fromHook` + wire 内部 switch 标记双字段记录，标记在 `tool_call`（`CustomToolCallEvent.toolName === "switch_context"`，`types.d.ts:780`）建立。同时解决 P1-3。§5.4 |
| P0-4 | **采纳** | 新写范围聚合读取器 `dynamic/usage-range.ts`（走 `getBranch()` + entry-id watermark 累加），不再误用只读最后一条的 `readLatestAssistantUsage`；跨模型/无 usage/cost 缺失一律 `null` + `costUnknownReason`。§5.5                                                                                                                       |

### P1

| 编号  | 处置   | 修法                                                                                                                                                                               |
| ----- | ------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| P1-1  | 采纳   | 见上（写价近似标记）                                                                                                                                                               |
| P1-2  | 不适用 | 随 D4 一起推迟；v2 依赖记录在 §7                                                                                                                                                   |
| P1-3  | 采纳   | 并入 P0-3 的 `tool_call` 识别                                                                                                                                                      |
| P1-4  | 采纳   | `DynamicRuntime.dispose()` 接入 `session_shutdown`（`src/index.ts:531+`）与 `session_start` 防御性清理（`:503-515`），归属写明。§2.4                                               |
| P1-5  | 采纳   | 构造期即返回惰性 runtime；每个 handler 内二次判 `ctx.mode`；测试覆盖根会话 print 与真子会话两条路径。§2.4 / T-D3-PRINT / T-D3-CHILD                                                |
| P1-6  | 采纳   | 并入 D6（§8.2）                                                                                                                                                                    |
| P1-7  | 采纳   | 模型 epoch 指纹含 provider/id/api/baseUrl/contextWindow/价格指纹；epoch 变化清空 published、按规则衰减 g、清空 S0。§4.3                                                            |
| P1-8  | 采纳   | P6 拆成 P6a（`static` 逐字节等于静态线）/ P6b（`quality` 满足上限且不进 argmin）。§12 D1 性质表                                                                                    |
| P1-9  | 采纳   | 分档边界语义与 `tokens > inputTokensAbove` 严格大于对齐，写明 B 属低档；测试 B−1/B/B+1 + 脏 tier。§3.2 / T-D1-TIER-BOUNDARY                                                        |
| P1-10 | 采纳   | 并入 D5                                                                                                                                                                            |
| P1-11 | 采纳   | 定义只读 `DynamicStatusView`，经 holder 转发（沿用 `src/index.ts:385` 的 `getState: () => holder.current?.compactHint` 形状）；旧 status 输出在端口缺席时逐字节不变。§10.3 / §10.5 |

### P2

| 编号 | 处置     | 修法                                                                                               |
| ---- | -------- | -------------------------------------------------------------------------------------------------- |
| P2-1 | **采纳** | 发布 / hintedAt / epoch 三者的状态机画成显式转换表（§9.2），含静态↔动态互切                        |
| P2-2 | **采纳** | EWMA 改写为不可变更新公式，写明方差用**旧均值**、clamp 只在读侧、样本减半用 `Math.floor`。§4.1     |
| P2-3 | **采纳** | 标记沿用仓库既有的 `·` 分隔符；测试断言改为「不含 CJK 字符」而非「纯 ASCII」。§10.1 / T-D1-MARKERS |

### 部分采纳（唯一一条）

- **P0-2 中的「force 为 0 或被禁用 ⇒ 退化」**：**部分采纳**。`cap` 在 force 关闭时**省略 force 项**（其余两项照常），动态层继续工作，而不是整体退化。理由：今天关掉强制压缩只让 force 分支被跳过（`src/stack.ts:611`），hint 层照常提醒；若因此让动态层退化，等于把两个正交开关耦合起来，且会让「关掉 force 的用户永远拿不到动态线」。§3.4 明确写出这条分支，并由 T-D1-FORCE-OFF 钉死 `basis` 永不为 `force-gap`。其余三种退化情形（`cap < lowerBound`、reserve 接近窗口、窗口极小）**完全按评审意见退化**。
  （v2.1 订正判定条件：是「**有效 force 线为 0**」，不是 `forceAtPercent === 0`——见下节第 9 条。）

---

## v2.1（复核处置）

复核：gpt-6-astra，确认 P0-1 / P0-2 已修好、force=0 的部分采纳理由成立。以下 8 项 + 1 条口径订正全部采纳。

| 编号 | 议题                       | 修法                                                                                                                                                                                                                                                                                                                                                                                     | 落在                              |
| ---- | -------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------- |
| R2-1 | P0-3 标记因果              | 120s 时间窗建立不了因果。改用 switch hook 的 **`onApplied({ seq, … })`**（`src/context-switch/hook.ts:49/89`，只在交接文本**真的被采用**时触发）建立关联；`session_compact_failed`（`src/index.ts:375`）与 `switch_context` 的 `onError`/同步 catch/`notApplied` 三条失败路径（`src/tools/switch-context-tool.ts:171/181/198`）都清 marker。时间窗降级为**兜底上限**，不再充当因果依据。 | §5.4                              |
| R2-2 | P0-4 `s0Tokens` 口径       | pi 的 `Usage` 没有 context 字段（`pi-ai/types.d.ts:270-291` 只有 `input/output/cacheRead/cacheWrite/totalTokens/cost`）。聚合器改为返回 **`firstContextTokens = input + cacheRead + cacheWrite`**（与研究 §3.1 的上下文代理口径一致）并同时透出 `firstUsage` 原始四元组；null 语义写死。                                                                                                 | §5.5、§5.2                        |
| R2-3 | RPC 模式                   | 惰性条件从 `ctx.mode !== "tui"` 改为 **`ctx.mode === "print" \|\| ctx.mode === "json"`**，与 `src/stack.ts:575` 的既有早退逐字一致；RPC 驱动的主会话照常运行动态层。                                                                                                                                                                                                                     | §2.4、T-D3-RPC                    |
| R2-4 | trigger 字段               | demand/force 由 compact hook 自己发出 ⇒ wire 建内部 trigger marker，**成功 / 失败 / 超时三条路径都清**；枚举收窄到真正可观测的 6 类，判定不了一律 `"unknown"`；`demand` 从 trigger 降为独立布尔 `precededByDemand`。                                                                                                                                                                     | §5.2、§5.4                        |
| R2-5 | 量化为 0                   | 纯函数层把线提升到至少 `ceil(W/100)`（保证过 `thresholdLineTokens` 的 floor 后仍 ≥ 1%）；抬升后越过 `cap` ⇒ `usable:false`。补大窗口 / `minHintPercent=0` / `R=0` 三个测试。                                                                                                                                                                                                             | §3.4 步骤 11、§3.5、T-D1-QUANTIZE |
| R2-6 | compaction 条目自身 usage  | `CompactionEntry.usage`（`session-manager.d.ts:54`）单列为 **`compactionCostUsd`**（切换固定成本的一部分），**绝不混进 `rProxy.costUsd`**。                                                                                                                                                                                                                                              | §5.2、§5.5                        |
| R2-7 | 落盘原子性表述             | 删除「3,500 < PIPE_BUF ⇒ 原子」这一错误论证（PIPE_BUF 只约束 pipe/FIFO）。改为 Linux `O_APPEND` 的 best-effort 说明：**可能出现撕裂行**，由消费端跳过坏行；新增双进程 append/rotate 压力测试锚点。                                                                                                                                                                                       | §5.3、T-D2-CONCURRENT             |
| R2-8 | D4 验收判据                | 去掉 `grep -c '/'`（模型 ID 本身含 `/`）。改为**解析 JSON 后递归断言不存在路径类字段**（`path`/`file`/`dir`/`cwd`/`hash` 类键名，以及任何字符串数组值）。                                                                                                                                                                                                                                | §12 D4、T-D2-NO-PATHS             |
| R2-9 | force cap 判定条件（订正） | 判定是「**有效 force 线为 0**」——即 `effectiveThresholdPercentWithTokens(windowScaledForcePercent(forceAtPercent, W), forceAtTokens, W, reserve) === 0`。`forceAtPercent === 0` 但 `forceAtTokens > 0` 时 force 线**仍然生效**，此时 cap 必须计入 force 项。                                                                                                                             | §3.4 步骤 7、§8.1                 |

---

## 0. 源码接缝核实表

| #   | 接缝                                              | 位置                                                                                                                                                                                                                                                    | 本方案怎么用                                                                                                                                        |
| --- | ------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------- |
| S1  | `turn_end` 上的 compact-hint 钩子（唯一判定入口） | `src/stack.ts:556` `createCompactHintHook`；注册在 `src/index.ts:212`；print/json 在 `:558` 早退                                                                                                                                                        | 动态线在这里每轮重算一次；不新增 hook、不新增 timer                                                                                                 |
| S2  | 阈值合成：百分比线 ∧ 绝对 token 线 ∧ reserve 上限 | `src/compact-hint/threshold.ts:146` `effectiveThresholdPercentWithTokens`、`:116` `thresholdLineTokens`                                                                                                                                                 | 动态层输出**绝对 token 线**，经同一函数收敛到百分比坐标；`effectiveThresholdPercentWithTokens > 0` 同时充当「今天是否有 hint 线」的判活谓词（P0-1） |
| S3  | force 窗口缩放                                    | `threshold.ts:35` `windowScaledForcePercent`                                                                                                                                                                                                            | **完全不动**：force 仍是安全网（研究 §7.3①、D10）                                                                                                   |
| S4  | tick 网格（非线性，ceiling = force 线）           | `threshold.ts:48/70` `usageTickMarks`/`usageTickStep`                                                                                                                                                                                                   | 网格不动（D7）；只在 tick 文案尾部追加英文短标记                                                                                                    |
| S5  | 会话级阈值状态                                    | `src/stack.ts:450` `CompactHintState`、构造于 `:851`                                                                                                                                                                                                    | 新增可选字段 `dynamic?: DynamicRuntime`，其余字段语义不变                                                                                           |
| S6  | 模型价格（含分档）                                | pi-ai `ModelCost`/`ModelCostTier`（`types.d.ts:771-784`，`tiers?: ModelCostTier[]`，语义「`inputTokensAbove` 严格小于本请求 token 时该档生效」）；既有两处读法 `src/stack.ts:1318` `priceOf`、`src/cache-ttl/keepalive-state.ts:803` `cacheReadCostUsd` | 抽出**唯一**的 tier-aware 解析到纯函数层；两处旧读法不动（不在本方案范围内重构）                                                                    |
| S7  | 上下文用量                                        | pi `ContextUsage { tokens: number\|null; contextWindow; percent: number\|null }`（`extensions/types.d.ts:194-200`）                                                                                                                                     | `tokens` 是动态层主输入（不是 percent）；`tokens == null` ⇒ 本轮不重算                                                                              |
| S8  | 缓存热度                                          | `src/service/cache-keepalive.ts:572` `provenCacheReadAt()`；`src/cache-ttl/keepalive-state.ts:31/33` `ASSUMED_TTL_MS`/`TTL_SAFETY_MARGIN_MS`                                                                                                            | **v1 不读**（D4 推迟）。仅记录为 v2 冷缓存的依赖（§7）                                                                                              |
| S9  | 1h 覆盖 / 入场费状态                              | `src/cache-ttl/adaptive.ts:452` `isPrefix1hCovered`、`:942` `buildAdaptiveSnapshot`                                                                                                                                                                     | **v1 不读**（P1-1：写价用单一 `cacheWrite` 近似）。v2 依赖（§7）                                                                                    |
| S10 | 订阅制识别                                        | `src/quota/gate.ts:55` `parseSubscriptionProviders`；`src/quota/service.ts:51` `verdictFor`；`src/quota/ladder.ts:34-47` `ProviderVerdict{ windows, stale, fetchedAt }`、`:24-32` `WindowVerdict{ scope, usedPct, resetAt? }`                           | §8.2 的订阅分支与前压曲线；`stale === true` 或 verdict 缺失 ⇒ 不前压                                                                                |
| S11 | 压缩事件                                          | `SessionCompactEvent { compactionEntry, fromExtension, reason, willRetry }`（`types.d.ts:455-463`）；**`fromHook` 在 `CompactionEntry` 上**（`session-manager.d.ts:46-59`，另有 `tokensBefore`/`summary`/`id`）                                         | 遥测切换点采样；`compactionEntry.fromHook` = 交接文本是否被采用（P0-3）                                                                             |
| S12 | 工具调用事件                                      | `pi.on("tool_call")`；`CustomToolCallEvent { toolName: string; input }`（`types.d.ts:780-783`），联合体见 `:790`                                                                                                                                        | **只用于识别 `toolName === "switch_context"`** 建立 wire 内部 switch 标记（P0-3/P1-3）。**不再采集任何文件路径**（D5）                              |
| S13 | usage 账本                                        | `src/cache-ttl/usage-ledger.ts` `readLatestAssistantUsage`（**只回扫到最后一条** assistant usage）                                                                                                                                                      | **不用于观察窗**（P0-4）；观察窗改用 §5.5 的范围聚合器。`Usage.cost.total` 字段形状见 pi-ai `types.d.ts:270-291`                                    |
| S14 | 会话条目持久化                                    | `pi.appendEntry` + `sessionManager.getBranch(fromId?)`（`session-manager.d.ts:304`，返回 `SessionEntry[]`，`SessionEntryBase{ type,id,parentId,timestamp }` 见 `:17-22`）；纪律：**绝不用 `getEntries()`**                                              | EWMA 的跨 `/reload`/resume 存活；范围聚合器的 watermark 也用 entry `id`                                                                             |
| S15 | 模型切换                                          | `model_select` 事件（`types.d.ts:698-703`，带 `previousModel`）                                                                                                                                                                                         | 模型 epoch 翻转（P1-7）                                                                                                                             |
| S16 | settings                                          | `src/config/settings.ts:116` `CompactSettings` / `:1062` `parseCompactSettings`；`src/config/setting-specs.ts:188` 仅注册了 `compact.enabled`，`:74` `choice()` 可建枚举项                                                                              | 新增嵌套块 `compact.dynamicThreshold`                                                                                                               |
| S17 | 生命周期                                          | `src/index.ts:503-515` `session_start` 防御性 dispose、`:531+` `session_shutdown` dispose 列表                                                                                                                                                          | `DynamicRuntime.dispose()` 的两个接入点（P1-4）                                                                                                     |
| S18 | 状态端口形状                                      | `src/index.ts:385` `getState: () => holder.current?.compactHint`；`src/commands/status.ts:32` `StatusCommandDeps` 的可选端口（缺席 ⇒ 输出逐字节不变）                                                                                                   | `DynamicStatusView` 的转发形状（P1-11）                                                                                                             |

---

## 1. 目标与非目标

### 目标

1. hint 线（L1 提醒线）从「写死的百分比 + 绝对 token 线」变成**按模型价格、分档、窗口与在线实测增长算出来的 token 线**。
2. 任何算不出来的情形都**退回现行行为**，且 `mode="off"` 时逐字节一致。
3. 为研究 §10 的空洞（再发现成本 `R` 测不到）补上**聚合数值型**在线遥测，使 `R` 日后可拟合。
4. 不新增定时器、不新增模块级可变状态、子会话完全惰性。

### 非目标（v1 明确不做）

- 不动 force 线、不动 `forceScaling`、不动 tick 网格生成逻辑。
- **不做冷缓存 / TTL 相关的任何判定**（D4，整体推迟到 v2，§7）。
- **不区分 5m/1h 写价**（P1-1）。
- **遥测不记录任何文件路径**（原文、相对路径、hash 一律不记），不做文件交集、不做纠正文本启发式（D5）。
- 不做跨 session 的先验共享（D9）。
- 不改 `compact_context` / `switch_context` 工具语义，不改交接内容格式。
- 不自动改写用户显式设置的阈值（用户/模型设的值是**上界**）。

---

## 2. 架构

```
src/compact-hint/dynamic/            ← 纯函数层（零 pi import，零 fs，零隐式 Date.now）
  types.ts          输入/输出/状态类型（含 P0-1 的判别联合）
  pricing.ts        tier-aware 单价解析（readRateAt / writeRateAt / tierBoundaries）
  cost-model.ts     周期平均成本 A(C)、分段闭式 C*、候选集求 argmin
  estimator.ts      g / σ / S0 / handoff 的不可变 EWMA + 序列化/回读 + epoch 衰减
  threshold.ts      computeDynamicThreshold(): 可行区间 → 候选 → argmin → 量化 → 死区
  markers.ts        英文短标记 + 中文单行说明（文案纯函数）
  telemetry.ts      遥测记录的纯构造器 + 观察窗状态机（无 IO）
  usage-range.ts    范围聚合读取器（P0-4；pi-free duck type，只吃 { getBranch }）

src/compact-hint/dynamic/
  telemetry-store.ts  ← 半纯层：只依赖 node:fs / node:path（同 src/quota/demotion.ts 的定位）
  wire.ts             ← 唯一 pi-facing 装配（wireDynamicThreshold）：读 ctx.model / ctx.getContextUsage /
                         quota，产出 DynamicRuntime；全部可变状态在闭包内
```

### 2.1 计算输入从哪里取

| 输入                      | 来源                                                                                                     | 不可用时                                                       |
| ------------------------- | -------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------- |
| 窗口 `W`、已用 `tokens`   | `ctx.getContextUsage()`（S7）                                                                            | `tokens == null` ⇒ 沿用上轮已发布线；`W` 未知 ⇒ `usable:false` |
| pi 保留线 `reserveTokens` | `state.reserveTokens`（`resolveReserveTokens` 已解析真值）                                               | 已有兜底 `PI_DEFAULT_RESERVE_TOKENS`                           |
| 价格与 tiers              | `ctx.model.cost`（结构化 duck type，不 import pi 类型）                                                  | `cacheRead` 缺失/非正 ⇒ 退化阶梯（§8）                         |
| 输出单价 `o`              | `ctx.model.cost.output`                                                                                  | 缺失 ⇒ `H = 0`，K 偏小 ⇒ C\* 偏早 ⇒ 由地板兜住                 |
| 写单价 `w`                | `ctx.model.cost.cacheWrite`（**单一值近似**，P1-1）                                                      | 缺失/0 ⇒ `Wnew = 0` + `writePricingApproximate`                |
| `g`、`σ`、`S0`、`handoff` | 在线 EWMA（§4）                                                                                          | 样本不足 ⇒ 先验混合                                            |
| 订阅信号                  | `parseSubscriptionProviders(settings.quota.subscriptionProviders)` + `quota.verdictFor(provider)`（S10） | quota 关闭/verdict 缺失/`stale` ⇒ 不前压                       |
| 模型指纹                  | `ctx.model` 的 provider/id/api/baseUrl + `contextWindow` + 价格指纹（P1-7）                              | 读不到 ⇒ 指纹记 `"unknown"`，与上次不同即翻 epoch              |

### 2.2 EWMA 状态放哪

- **放在 `wire.ts` 闭包**（每次 `activate()` / `buildSessionStack` 新建），经 `CompactHintState.dynamic` 暴露只读视图。绝不放模块作用域。
- **持久化粒度（D9）**：`pi.appendEntry("subagent:compact-dynamic", …)`，回读走 `getBranch()`（S14）。这意味着状态**只活在当前 session branch 内**：`/reload`、resume 同一分支能继承；fork 出新分支后天然看不到旧分支的条目；**不做跨 session 共享**。
- 写节流：`g`/`S0` 的 EWMA 相对上次落盘变化 >10%，或距上次落盘 ≥20 轮；`session_shutdown` flush 一次。

### 2.3 输出如何与现行三条线合成（D3：只能提前）

见 §3.6 的完整规则（含 P0-1 的判活谓词）。要点：

- 动态层**只影响 hint**；`forceAtPercent` / `forceAtTokens` / `forceScaling` 的表达式一字不改。
- 合成取 `min`：动态线只能把提醒**提前**，不能推迟。
- 今天没有 hint 线的配置，动态层不得复活它。

### 2.4 生命周期与惰性（P1-4 / P1-5）

- **所有权**：`DynamicRuntime` 由 `Stack` 持有（`stack.dynamic`，同时经 `compactHint.dynamic` 引用同一对象）。上一会话的 runtime 由**下一次 `session_start` 的防御性清理**（`src/index.ts:503-515`，在既有 `holder.current.keepalive?.dispose()` 一串后追加 `holder.current.dynamic?.dispose()`）和 **`session_shutdown`**（`:531+`，同样追加一行）共同负责——两处都幂等，谁先到谁生效。`buildSessionStack` 内不做 previous-runtime 交接（无 timer、无外部资源，不需要 `stack.ts` 的 `previousX` 模式）。
- `dispose()` 只做两件事：flush 未落盘的遥测/估计量、把内部引用置空后拒绝后续写入。**无 timer 可清**（本模块不创建任何 timer）。
- **惰性（P1-5，v2.1/R2-3 订正）**：`wireDynamicThreshold` 在 **`ctx.mode === "print" || ctx.mode === "json"`** 时**直接返回惰性 runtime**（所有方法 no-op、`statusView()` 返回 undefined）；此外每个 handler 内**再判一次**同样的条件（同一个 ctx 可能在 `/reload` 后语义变化）。
  判定条件与 compact-hint 钩子的既有早退（`src/stack.ts:575` `if (ctx.mode === "print" || ctx.mode === "json") return;`）**逐字一致**——不能写成 `mode !== "tui"`：**RPC 驱动的主会话** mode 既非 print 也非 json，它必须照常运行动态层，用 `!== "tui"` 会把它误杀。子会话跑 print 模式，因此仍然天然惰性。
  测试覆盖三条路径：根会话 print（T-D3-PRINT）、真子会话激活（T-D3-CHILD）、**RPC 主会话正常工作**（T-D3-RPC）。

---

## 3. 纯函数层规格

### 3.1 类型（`dynamic/types.ts`）—— 含 P0-1 的判别联合

```ts
export interface PriceRates {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
} // USD / 1M
export interface PriceTier extends PriceRates {
  inputTokensAbove: number;
}
export interface PriceModel {
  base: PriceRates;
  tiers: readonly PriceTier[]; // 已排序、已去脏（§3.2）
  readKnown: boolean; // cacheRead 是有限正数
  writeKnown: boolean; // cacheWrite 是有限正数；false ⇒ writePricingApproximate
}

export interface GrowthEstimate {
  g: number;
  sigma: number;
  samples: number;
}
export interface StartEstimate {
  s0: number;
  samples: number;
}

export interface DynamicConfig {
  mode: "off" | "shadow" | "on";
  minHintPercent: number; // 默认 35
  maxQualityPercent: number; // 默认 60 —— 未校准的安全上限
  rediscoveryUsd: number; // 默认 10 —— 经验先验，未跨模型校准
  unknownPriceMode: "static" | "quality"; // 默认 "static"
}

export type DegradeReason =
  | "window-unknown" // W 缺失 / 非有限 / <= 0
  | "window-too-small" // W < DYNAMIC_MIN_WINDOW
  | "usage-unknown" // ContextUsage.tokens == null
  | "price-unknown" // cacheRead 不是有限正数（且 unknownPriceMode="static"）
  | "infeasible-range" // cap < lowerBound（含 reserve 接近窗口）
  | "static-hint-disabled" // 今天就没有 hint 线
  | "internal-error"; // 纯函数抛异常的兜底归类（wire 层捕获）

export type ThresholdBasis = "cost" | "tier" | "floor" | "quality-cap" | "reserve-cap" | "force-gap" | "quota";

export interface Candidate {
  tokens: number;
  usdPerTurn: number;
  label: string;
}

export type DynamicThresholdOutcome =
  | {
      usable: true;
      hintTokens: number; // 恒 > 0，且落在 [lowerBound, cap]
      hintPercent: number; // floor(hintTokens / W * 100)，恒 >= 1
      basis: ThresholdBasis;
      lowerBound: number;
      cap: number; // 可行区间，供 status/遥测诊断
      cStarTokens: number | undefined; // 基础段闭式解；不可算时 undefined
      nextTierTokens: number | undefined;
      writePricingApproximate: boolean; // P1-1：恒 true（v1 不区分 5m/1h），writeKnown=false 时额外说明
      subscriptionPressure: number | undefined; // D6 前压所用的 usedPct
      candidates: readonly Candidate[]; // <= 8 条
    }
  | { usable: false; reason: DegradeReason };
```

**P0-1 的核心**：`usable: false` 与「线为 0」在类型上不可混淆；调用方**无法**写出 `hintTokens === 0` 这种歧义判断。

### 3.2 分档单价（`dynamic/pricing.ts`）

与 pi-ai `calculateCost` 及仓库既有两处读法（S6）口径一致：**取 `inputTokensAbove < tokens` 中阈值最大的那一档，按全请求计价**。

**P1-9 边界语义（写死）**：判据是 `tokens > tier.inputTokensAbove`（严格大于）。因此**边界值 B 本身仍属低价档**，`B + 1` 才进高价档。分档提醒因此瞄准 `B − TIER_MARGIN`，而候选集里的 `B` 表示「刚好还在低档的最后一个 token」。

```ts
export function normalizeTiers(raw: unknown, base: PriceRates): readonly PriceTier[];
// 清洗规则（P1-9 脏数据）：非有限 / 负数 / NaN 的 inputTokensAbove 丢弃；
// 单价字段非有限时继承 base 的对应字段；inputTokensAbove 重复时保留最后一个；升序排序。

export function rateAt(price: PriceModel, tokens: number): PriceRates;
export function readRateAt(price: PriceModel, tokens: number): number; // USD/token
export function writeRateAt(price: PriceModel, tokens: number): number; // 单一 cacheWrite 近似（P1-1）
export function tierBoundaries(price: PriceModel, window: number): readonly number[]; // 升序去重，落在 (0, W) 内
export function priceSegments(price: PriceModel, window: number): readonly { from: number; to: number; read: number }[];
```

### 3.3 成本模型（`dynamic/cost-model.ts`）

轮数 `m(C) = max(1, ceil((C − S0) / g))`；周期内第 `j` 轮（`j = 0..m−1`）上下文约 `S0 + j·g`。

**周期平均成本（分档精确，O(#tiers)）：**

```
A(C) = K / m  +  (1/m) · Σ_segments  read_s · [ n_s·S0 + g · (j_lo + j_hi − 1)·n_s / 2 ]
```

每个价格段 `[a, b)`：`j_lo = clamp(ceil((a − S0)/g), 0, m)`、`j_hi = clamp(ceil((b − S0)/g), 0, m)`、`n_s = j_hi − j_lo`。与朴素逐轮求和恒等（性质 P10 钉死）。

**固定成本：**

```
K    = H + R + Wnew
H    = handoffTokens · output / 1e6
Wnew = S0 · writeRateAt(S0)          // 按 S0 计（研究 §2.2）；writeKnown=false ⇒ 0
R    = config.rediscoveryUsd         // §5.1：经验先验
```

v1 的 `K` 与 `C` 无关；`K(C)` 的签名保留给 v2 的闲置修正（§7）。

**分段闭式解**：对每个价格段 `s` 求 `C*_s = S0 + sqrt(2·K·g / read_s)`，仅当落在本段区间内才收为候选。`cStarTokens` 报告 `S0` 所在段的解（供 status 显示成本下界）。

### 3.4 可行区间优先的收敛顺序（P0-2；顺序即语义）

```
 1. W 无效（非有限 / <= 0）                      ⇒ { usable:false, "window-unknown" }
 2. W < DYNAMIC_MIN_WINDOW (32_000)              ⇒ { usable:false, "window-too-small" }
 3. usedTokens 未知                              ⇒ { usable:false, "usage-unknown" }
 4. 退化阶梯（§8）：price / 订阅                 ⇒ 或 { usable:false, … }，或进入订阅分支（第 9 步）
 5. g  = clamp(growth.g + 0.5·growth.sigma, MIN_G, MAX_G_FRACTION·W)
    S0 = clamp(start.s0, MIN_S0, 0.35·W)
 6. lowerBound = max(minHintPercent%·W, S0 + 2g)
 7. effForce = effectiveThresholdPercentWithTokens(                       // ← R2-9：有效 force 线，
                  windowScaledForcePercent(forceAtPercent, W),           //    不是 forceAtPercent
                  forceAtTokens, W, reserveTokens)
    cap = min(
        maxQualityPercent%·W,
        W − reserveTokens,
        effForce > 0 ? (effForce%·W − HYSTERESIS_PCT%·W) : +∞   // 部分采纳：有效 force 线为 0 才省略该项
    )
 8. cap < lowerBound  或  cap <= 0               ⇒ { usable:false, "infeasible-range" }
        （reserve 接近窗口、质量上限低于地板、force 线过低都在这里统一退化）
 9. 订阅分支（§8.2）：line = 前压曲线(usedPct)，跳过 argmin，basis = "quality-cap" | "quota"
10. 常规分支：candidates = {lowerBound, cap}                       ← 两端点恒在集合内
                        ∪ {C*_s 落在 [lowerBound, cap] 内者}
                        ∪ {B, B − TIER_MARGIN 落在区间内者}
             C_best = argmin_{C ∈ candidates} A(C)
11. 量化下限（R2-5）：C_best = max(C_best, ceil(W / 100))            // 保证 floor 换算后 >= 1%
        若抬升后 C_best > cap                       ⇒ { usable:false, "infeasible-range" }
        hintPercent = floor(C_best / W · 100)                       // 由上一行保证 >= 1
12. 发布死区（§9.2）：|hintPercent − published.percent| < PUBLISH_DEADBAND_PCT
                      且 epoch 未变 ⇒ 沿用 published.percent
13. basis 归因：命中 C* → "cost"；命中 B/B−margin → "tier"；== lowerBound → "floor"；
               == cap 且 cap 来自质量上限 → "quality-cap"；来自 reserve → "reserve-cap"；
               来自 force−迟滞 → "force-gap"（有效 force 线为 0 时此值永不出现）
```

**R2-9 口径订正**：第 7 步的判定对象是**有效 force 线**，不是 `forceAtPercent`。`forceAtPercent === 0` 但 `forceAtTokens > 0` 时，现行钩子（`src/stack.ts:603-608`）依然会算出一条生效的 force 线，此时 cap **必须计入** force 项；只有两条线都关、`effForce === 0` 时才省略。

**R2-5 为什么必须在纯函数层兜**：合成后的线要经 `effectiveThresholdPercentWithTokens(0, tokens/1000, W, reserve)` 换算回百分比坐标，其内部是 `Math.floor((tokensK * 1000 / W) * 100)`。窗口极大（如 10M）且 `minHintPercent=0`、`R=0` 时，`lowerBound` 可低至 `MIN_S0 + 2g ≈ 4.6k`，占 10M 窗口的 0.046% ⇒ floor 后为 **0 ⇒ 线被当作「未启用」**，动态层会静默消失而不是退化——这正是 P0-1 想根除的歧义。故在纯函数层就抬到 `ceil(W/100)`，抬不动（超过 cap）就老实 `usable:false` 退回静态线。

不变式：`usable:true ⇒ max(lowerBound, ceil(W/100)) ≤ hintTokens ≤ cap`，且 `hintPercent ≥ 1`，候选集非空（两端点恒在）。

### 3.5 内部常量（不可配置，集中在 `dynamic/threshold.ts` 顶部，带推导注释）

| 常量                                    | 值                           | 依据                                                                                |
| --------------------------------------- | ---------------------------- | ----------------------------------------------------------------------------------- |
| `DYNAMIC_MIN_WINDOW`                    | 32_000                       | 更小的窗口由 reserve 主导（pi 自身线在 95% 附近），成本优化无意义                   |
| `MIN_G`                                 | 300                          | 研究 §2.3：主会话增长 P50 ≈ 779                                                     |
| `MAX_G_FRACTION`                        | 0.10                         | 单轮吃掉 >10% 窗口是异常，不让它主导阈值                                            |
| `G_SIGMA_WEIGHT`                        | 0.5                          | `g + 0.5σ` 作为 P90 的廉价单调代理                                                  |
| `G_PRIOR`                               | 800                          | 研究 §2.3 全量 P50 774 / 主会话 779                                                 |
| `G_WARMUP_SAMPLES`                      | 8                            | 先验混合窗口                                                                        |
| `S0_PRIOR_FRACTION` / `S0_PRIOR_CAP`    | 0.10 / 100_000               | 研究 §3.2：真实四次切换后 S0 = 92.5k–101.5k                                         |
| `MIN_S0`                                | 4_000                        | 机械附录 + system prompt 的地板                                                     |
| `HANDOFF_PRIOR_TOKENS`                  | 2_000                        | 研究 §3.2：交接 4,191–8,493 字符                                                    |
| `HYSTERESIS_PCT`                        | 3                            | hint 与 force 的最小间距（百分点）                                                  |
| `PUBLISH_DEADBAND_PCT`                  | 2                            | 发布死区，抑制线抖动                                                                |
| `TIER_MARGIN`                           | `max(2g, 0.01·W)`            | 跨档前留两轮余量完成切换                                                            |
| `EWMA_ALPHA_G` / `EWMA_ALPHA_S0`        | 0.2 / 0.4                    | 研究 §7.4 建议 0.2；S0 样本稀少故更快                                               |
| `SUB_PRESSURE_FROM` / `SUB_PRESSURE_TO` | 75 / 95                      | D6 前压曲线端点；75 对齐 `DEFAULT_THRESHOLDS.l2 = 75`（`src/quota/ladder.ts:57`）   |
| `MIN_LINE_PERCENT`                      | 1（即 `ceil(W/100)` tokens） | **R2-5**：低于 1% 的线经 floor 换算会变成 0（= 线未启用），必须在纯函数层抬起或退化 |

`maxQualityPercent = 60` 与 `rediscoveryUsd = 10` 是**可配置项**，不在此表；两者都必须在设置说明里标注「未校准」。

### 3.6 合成规则（P0-1 完整版，落在 `src/stack.ts` 的钩子里）

```ts
// 1) 今天是否有 hint 线（判活谓词，复用 S2 的既有函数）
const staticEffective = effectiveThresholdPercentWithTokens(
  state.thresholdPercent,
  state.thresholdTokens,
  W,
  state.reserveTokens,
);
const staticHintActive = staticEffective > 0;
const staticTokens = thresholdLineTokens(state.thresholdPercent, state.thresholdTokens, W);

// 2) 合成
let hintLineTokens: number;
if (!staticHintActive)
  hintLineTokens = 0; // 今天没有线 ⇒ 动态不得复活
else if (mode !== "on")
  hintLineTokens = staticTokens; // off / shadow
else if (!dyn.usable)
  hintLineTokens = staticTokens; // 退化 ⇒ 现行行为
else hintLineTokens = Math.min(staticTokens, dyn.hintTokens); // D3：只能提前
```

三条被显式覆盖的组合（各有一条测试）：

| 配置                                                       | `staticHintActive` | 结果                                            |
| ---------------------------------------------------------- | ------------------ | ----------------------------------------------- |
| `percent=75, tokens=0`                                     | true               | `min(0.75W, dyn)`                               |
| `percent=0, tokens=500`（百分比线关、绝对线开，W=1M）      | true               | `min(500k, dyn)`                                |
| `percent=0, tokens=2000`（绝对线 > 窗口 ⇒ 自动失效，W=1M） | **false**          | hint 关闭；动态层不得复活（T-D3-HINT-DISABLED） |

`staticHintActive ⇒ staticTokens > 0`（由 `effectiveThresholdPercentWithTokens` 与 `thresholdLineTokens` 的定义域保证），故 `min` 永远有意义。

---

## 4. 在线估计（`dynamic/estimator.ts`）

### 4.1 不可变 EWMA（P2-2）

```ts
export interface EstimatorState {
  readonly gMean: number;
  readonly gVar: number;
  readonly gSamples: number;
  readonly s0Mean: number;
  readonly s0Samples: number;
  readonly handoffMean: number;
  readonly handoffSamples: number;
  readonly lastTokens: number | undefined;
  readonly modelEpoch: number;
  readonly modelFingerprint: string;
  readonly version: 2;
}
```

**更新公式（写死，方差用旧均值）：**

```
delta  = x − mean_old
mean_new = mean_old + α · delta
var_new  = (1 − α) · (var_old + α · delta²)       // delta 基于 mean_old，不用 mean_new
sigma    = sqrt(max(0, var_new))
```

- 所有更新函数**返回新对象**，不就地改。
- **clamp 只在读侧**（`§3.4` 第 5 步）：存储层保留原始浮点值，避免反复 clamp 造成的信息丢失与不可逆。
- **round 只在渲染侧**（status / 遥测 / 标记）；内部全程浮点。
- **样本减半用 `Math.floor(samples / 2)`**（P1-7 衰减、`decayEstimator`）。

样本纪律：

- `Δ = tokens − lastTokens`；`Δ ≤ 0` **丢弃**（压缩/切换的负跳变不是增长）；`Δ > 0.25·W` **截断**到 `0.25·W` 后入 EWMA。
- `session_compact` 后把 `lastTokens` 置 `undefined`，**丢弃压缩后的第一个 Δ**。
- 热身混合：`gSamples < G_WARMUP_SAMPLES` 时
  `g = (gSamples·gMean + (G_WARMUP_SAMPLES − gSamples)·G_PRIOR) / G_WARMUP_SAMPLES`；
  `s0Samples === 0` 时用 `S0_PRIOR`。

### 4.2 持久化（D9：仅当前 session branch）

- 条目类型 `subagent:compact-dynamic`，payload = 序列化的 `EstimatorState` + `{ publishedPercent, telemetrySeq }`。
- 回读：`getBranch()` 倒序找最后一条本类型条目；逐字段校验（非有限/负数 ⇒ 取先验）；`version !== 2` ⇒ 丢弃重来；任何异常 ⇒ 全新状态。**永不抛。**
- **不做跨 session 共享**：fork 出的新分支天然看不到旧分支条目，这正是想要的语义。

### 4.3 模型 epoch（P1-7）

```
fingerprint = [provider, id, api, baseUrl, contextWindow,
               `${input}/${output}/${cacheRead}/${cacheWrite}`,
               tiers.map(t => `${t.inputTokensAbove}:${t.cacheRead}`).join(",")
              ].join("|")        // 读不到的字段记 "unknown"
```

`fingerprint` 变化（由 `model_select`（S15）或每轮 `turn_end` 的兜底比对触发）⇒ `modelEpoch += 1`，并且：

| 量          | 处置                                             | 理由                                                      |
| ----------- | ------------------------------------------------ | --------------------------------------------------------- |
| `published` | **清空**                                         | 死区必须重新起算，否则旧线会粘住新模型                    |
| `g`         | 值保留，`gSamples = floor(gSamples / 2)`         | 增长率主要由任务决定，不该全丢                            |
| `σ`         | 值保留（随 `gVar`）                              | 同上                                                      |
| `S0`        | **清空**（`s0Mean = S0_PRIOR`，`s0Samples = 0`） | 交接后起点受 system prompt / 工具定义支配，换模型基本作废 |
| `handoff`   | 值保留，样本减半                                 | 交接长度是模型写作习惯，弱相关                            |

窗口变化已包含在指纹里，因此换窗口 = 换 epoch = 清 published。

---

## 5. `R`（再发现成本）与遥测

### 5.1 `R` 的先验（D2：固定 $10，可配置）

`compact.dynamicThreshold.rediscoveryUsd`，**默认 `10`**，在文档、设置说明（§10.4）与 `/agent status`（§10.3）三处统一标注：

> **经验先验，未跨模型校准。**

依据：研究 §4.2 的反推——把 `R` 从 $0.48 提到 $10–12 时，Opus 5.5（1M 窗口，g=P50，S0=100k）的 `C*` 从约 161k 抬到约 400k = 40%，与本机四次真实 `switch_context` 的 39.6%/42.5%/44.6%/48.3%（研究 §3.2）吻合。它是「让公式复现真实选择点」的等效值，**不是**从第一性原理测得的量，且从未在别的模型上验证过。`/agent status` 同时显示它等价于多少轮（`R / 轮均成本`），便于用户判断先验是否离谱。`R = 0` 合法（纯 cache-read 最优，会被地板接住）。

### 5.2 遥测记录（D5：只记聚合数值，无任何路径；v2.1 修订 R2-2 / R2-4 / R2-6）

```ts
/** R2-4：枚举收窄到**真正可观测**的 6 类。判定不了一律 "unknown"，绝不猜。 */
export type SwitchTrigger =
  | "switch-tool" // switch hook 的 onApplied 开火：交接文本真的被采用（唯一的因果信号）
  | "dynamic-force" // 本扩展的 force 压缩路径（wire 自己发的，有内部 marker）
  | "pi-auto" // reason="threshold" 且无任何我们的 marker ⇒ pi 自己的自动压缩
  | "overflow" // reason="overflow"
  | "manual" // reason="manual" 且无 marker
  | "unknown"; // 其余一律

export interface SwitchTelemetryRecord {
  v: 2;
  ts: number;
  sessionId: string;
  seq: number; // 同一次切换的两行共用；来自 onApplied 的 seq（R2-1）
  phase: "switch" | "window";

  model: { provider: string; id: string; contextWindow: number | null };
  trigger: SwitchTrigger;
  reason: "manual" | "threshold" | "overflow" | null; // SessionCompactEvent.reason
  adopted: boolean | null; // compactionEntry.fromHook
  /** R2-1：onApplied 开火过 ⇒ 交接文本确实被这次压缩消费（因果，不是时间巧合） */
  handoffApplied: boolean;
  /** R2-4：demand 不再是 trigger，降为独立事实 */
  precededByDemand: boolean;

  before: { contextTokens: number | null; percent: number | null; turnsSinceLastSwitch: number | null };
  lines: {
    mode: "off" | "shadow" | "on";
    hintPercent: number | null;
    forcePercent: number | null;
    basis: string | null;
    dynamicUsable: boolean;
    degradeReason: string | null;
  };
  estimate: {
    g: number | null;
    sigma: number | null;
    s0: number | null;
    cStar: number | null;
    rUsd: number;
    handoffTokens: number | null;
  };
  price: {
    cacheRead: number | null;
    cacheWrite: number | null;
    output: number | null;
    tierHit: number | null;
    writePricingApproximate: true; // P1-1：v1 恒为 true
  };
  /**
   * R2-6：`CompactionEntry.usage`（`session-manager.d.ts:54`）——生成摘要/应用交接那次 LLM 调用的账。
   * 它属于**切换的固定成本 K**（对应公式里的 H），与「切换后又花了多少」是两回事，
   * 因此**单列**，绝不混进 rProxy.costUsd（混进去会把 K 重复计入 R 的代理量，直接污染拟合）。
   * switch_context 走 hook 时无摘要 LLM 调用 ⇒ 通常为 null 或 0；通用摘要压缩则不为 0。
   */
  compactionCostUsd: number | null;

  /**
   * phase === "window" 专有。命名刻意用 rProxy：这些都不是 R，只是它的代理量。
   * 任何取不到的值一律 null（绝不记 0）。
   */
  rProxy?: {
    turns: number | null;
    wallMs: number | null;
    /** R2-2：pi 的 Usage 没有 context 字段 ⇒ 用 input + cacheRead + cacheWrite 作为上下文规模代理。 */
    firstContextTokens: number | null;
    /** R2-2：同一条的原始四元组，便于日后重算代理口径而不用重跑会话。 */
    firstUsage: { input: number; output: number; cacheRead: number; cacheWrite: number } | null;
    costUsd: number | null;
    cacheRead: number | null;
    cacheWrite: number | null;
    crossModel: boolean; // 观察窗内出现多个 model id
    costUnknownReason: string | null; // "watermark-lost" | "no-usage" | "cost-missing" | null
  };
}
```

**明确删除**（相对 v1）：`filesRead` / `filesReRead` / 任何路径数组 / 路径 hash / `correctionLikeUserTurns`。
**明确改名**（v2.1）：`rProxy.s0Tokens` → `rProxy.firstContextTokens`（R2-2：原名暗示 pi 有现成的 `S0` 字段，实际上没有，只是三项相加的代理量）。

### 5.3 落盘纪律（`dynamic/telemetry-store.ts`）

- **路径**：`join(getAgentDir(), "telemetry", "compact-switch.jsonl")`。目录 `mkdirSync(..., { recursive: true, mode: 0o700 })`。
- **权限 0600**：首次创建后立刻 `chmodSync(path, 0o600)`（`appendFileSync` 的 `mode` 只在创建时生效，且受 umask 影响，故显式 chmod 一次，用 `statSync` 缓存「本会话已确认过权限」避免每行 syscall）。
- **单行追加（R2-7，表述已订正）**：每条记录只 `appendFileSync(path, line + "\n")` 一次，一次 write。渲染后若 `Buffer.byteLength(line) > TELEMETRY_MAX_LINE (3_500)`，先丢弃 `candidates` 等可选诊断字段重渲一次；仍超长则**跳过该条**并 warn。
  → **不再声称「< PIPE_BUF ⇒ 原子」**：`PIPE_BUF` 的原子性保证**只适用于 pipe/FIFO**，对普通文件无效。真实口径是：Linux 上以 `O_APPEND` 打开的普通文件，单次小写入实践上 **best-effort 不交错**，但**没有任何标准保证**——高并发、NFS/网络文件系统、信号中断下**可能出现撕裂行**。行长限制只是降低概率的工程手段，不是正确性论据。
- **消费端契约（因上条而必须）**：读取方**必须**逐行 `JSON.parse` 并**跳过解析失败的行**（并计数上报，便于发现异常）。这是 JSONL 格式契约的一部分，写进本文以免将来拟合脚本直接 `JSON.parse` 整文件而炒。
- **轮转**：写前 `statSync().size > 2 MiB` ⇒ `renameSync(path, path + ".1")`（同目录 rename 原子，自动覆盖旧的 `.1`），只保留一代，上界 4 MiB。
- **多进程并发策略（写明）**：不加锁、不用 lock 文件。接受三类损失：① 极端情况下的撕裂行（由消费端跳过，丢一条遥测）；② 两进程同时轮转时 rename 原子，最坏少保留一代历史；③ 轮转瞄准瞬间另一进程的 append 可能落到旧 inode（即已被 rename 走的 `.1`）——数据仍在，只是分到上一代文件。三条都属「遥测是 best-effort」的可接受损失，**绝不为此引入锁**（锁会把主链路和磁盘故障耦合起来）。压力测试锚点：T-D2-CONCURRENT。
- **错误处理**：磁盘满（ENOSPC）、目录异常（EACCES/ENOTDIR/EROFS）等一律**静默吞掉**，经 safe logger（`console.warn` + `[pi-subagent]` 前缀）**每会话每 errno 只报一次**；绝不抛、绝不影响主链路。
- **开关**：`mode !== "off"` 即采集（`shadow` 也采集——这正是 shadow 的用途）。

### 5.4 切换事件的采集与「是否被采纳」（P0-3 / P1-3；v2.1 重写：R2-1 / R2-4）

**为什么 v2 的做法不够**：「`tool_call` 见过 switch_context」+「120s 内发生了一次压缩」只是**时间上的共现**。工具可能因 `invalid_handoff` / `in_flight` / `cooldown` 早退，`ctx.compact()` 可能失败，交接文本可能过期而被通用摘要抢先——任一情形下那次压缩都不是这次工具调用的结果，用时间窗归因会把脏样本写进 `R` 的拟合集。

**因果信号改用 `onApplied`**（`src/context-switch/hook.ts:49` 声明、`:89` 调用）——它在 hook **真的取走并应用了交接文本**之后才开火，并带着 `PendingHandoffStore` 的 `seq`：

```ts
// src/index.ts 的 createSwitchContextCompactHook 参数里新增一行（现在只传 store/sessionFacts/debug）
onApplied: (info) => holder.current?.dynamic?.noteHandoffApplied(info), // info: { seq, keepRecent, chars, reason }
```

wire 内部维护两个 marker：

| marker          | 建立                                                                       | 清除（**所有路径都要有归宿**）                                                                                                                                                                                                           |
| --------------- | -------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `handoffMarker` | `onApplied({ seq, … })` 开火 ⇒ `{ seq, at }`                               | ① `session_compact` 消费后立即清；② `session_compact_failed`（`src/index.ts:375` 同一事件上追加 `holder.current?.dynamic?.clearMarkers("compact-failed")`）；③ 超过 `MARKER_TTL_MS (120_000)` 自然作废——**仅兜底上限，不再充当因果依据** |
| `forceMarker`   | wire 自己发出 force 压缩或 demand 时 ⇒ `{ kind: "force" \| "demand", at }` | ① `session_compact` 消费后清；② `ctx.compact()` 的 `onError` / 同步 catch ⇒ 立即清；③ `session_compact_failed` ⇒ 清；④ `MARKER_TTL_MS` 超时 ⇒ 清。**成功 / 失败 / 超时三条路径全覆盖**（R2-4）                                           |

> `switch_context` 工具自身的失败路径（`src/tools/switch-context-tool.ts:171` 的 `notApplied`、`:181` 的 `onError`、`:198` 的同步 catch）均**不会**触发 `onApplied`，所以 `handoffMarker` 天然不会被建立。其中 `notApplied` 分支仍会产生一次真实压缩，它会被正确记为 `handoffApplied: false`——这正是我们想区分的两类样本。

**`pi.on("session_compact")` 的字段读取**（按 S11 的真实形状）：

- `adopted = event.compactionEntry?.fromHook === true`（**`fromHook` 在 `compactionEntry` 上，不在事件根上**）；
- `handoffApplied = handoffMarker !== undefined`（**因果信号**），并把 `handoffMarker.seq` 用作本条记录的 `seq`；
- `reason = event.reason`；`compactionCostUsd = event.compactionEntry?.usage?.cost?.total ?? null`（R2-6）；
- `before.contextTokens` 优先 `event.compactionEntry?.tokensBefore`，缺失时回落上轮缓存的 `usage.tokens`，再缺失记 `null`；
- `precededByDemand = forceMarker?.kind === "demand"`；
- **trigger 判定表**（写在 `telemetry.ts`，逐格单测）：

  | 条件                                                   | trigger           |
  | ------------------------------------------------------ | ----------------- |
  | `handoffApplied === true`                              | `"switch-tool"`   |
  | `forceMarker?.kind === "force"`（且未 handoffApplied） | `"dynamic-force"` |
  | `reason === "overflow"`                                | `"overflow"`      |
  | `reason === "threshold"` 且无任何 marker               | `"pi-auto"`       |
  | `reason === "manual"` 且无任何 marker                  | `"manual"`        |
  | 其余（`reason` 缺失、marker 与 reason 矛盾）           | `"unknown"`       |

- 写 `phase: "switch"` 行；记 watermark（§5.5）；打开观察窗；清两个 marker。

> 为什么不查 `PendingHandoffStore.peek()?.seq`：`session_before_compact` 钩子在 `session_compact` 之前已 `store.clear(seq)` 消费掉（`src/context-switch/hook.ts` 的「消费即清」），到 `session_compact` 时必然 `undefined`。`onApplied` 恰好在那一刻开火并带出 seq，是唯一既有因果、又能拿到 seq 的接缝。

> `tool_call` 订阅在 v2.1 仍然保留，但**降级为纯辅助诊断**（记一个「模型本轮叫过 switch_context」的布尔，用于事后分析「叫了但没生效」的比例），**不再参与 trigger 归因**。handler 永远返回 `undefined`，绝不拦截工具、绝不改 `event.input`。

### 5.5 观察窗的成本聚合（P0-4；v2.1 补 R2-2 / R2-6）

**不使用** `readLatestAssistantUsage`（S13，只回扫最后一条）。新写：

```ts
// dynamic/usage-range.ts —— pi-free duck type
export interface BranchCtxLike {
  sessionManager?: { getBranch?: () => unknown } | undefined;
}

/** R2-2：pi 的 Usage 只有 input/output/cacheRead/cacheWrite/totalTokens/cost（pi-ai types.d.ts:270-291）。 */
export interface RawUsageQuad {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
}

export interface UsageRangeAggregate {
  turns: number; // 计入的 assistant usage 条目数
  costUsd: number | null;
  cacheRead: number | null;
  cacheWrite: number | null;
  /**
   * R2-2：**pi 没有 context 字段**，所以给不出真正的 S0。这里返回区间内第一条 assistant usage 的
   * `input + cacheRead + cacheWrite` 作为上下文规模的**代理**（与研究 §3.1 的口径一致）。
   * null 语义：区间内没有任何 assistant usage，或 watermark 丢失，或第一条的三个字段不全为有限数。
   * **绝不用 0 冒充**：0 是「真的一个 token 都没读」，与「没测到」是两回事。
   */
  firstContextTokens: number | null;
  /** 同一条的原始四元组，便于日后用别的口径重算而不用重跑会话；同样缺失则 null。 */
  firstUsage: RawUsageQuad | null;
  models: readonly string[]; // 去重后的 model id
  lastEntryId: string | null;
  unknownReason: "watermark-lost" | "no-usage" | "cost-missing" | null;
}

export function aggregateAssistantUsageAfter(
  ctx: BranchCtxLike | undefined,
  afterEntryId: string | null,
): UsageRangeAggregate;
```

语义（全部单测）：

- 走 `getBranch()`（S14，`SessionEntry` 带 `id`，见 `session-manager.d.ts:17-22`），定位 `afterEntryId` 的下标，**严格之后**的 `type === "message" && message.role === "assistant" && message.usage` 逐条累加。
- `afterEntryId` 在分支上找不到（被 fork/压缩切走）⇒ `turns: 0`，各数值 `null`，`unknownReason: "watermark-lost"`。
- 区间内一条 usage 都没有 ⇒ `null` + `"no-usage"`。
- **任一**计入条目缺 `usage.cost.total` ⇒ `costUsd: null` + `"cost-missing"`（`cacheRead`/`cacheWrite` 若都在则照常给出）。**绝不用 0 冒充未知。**
- `models.length > 1` ⇒ `crossModel: true`（调用方据此标注，不丢弃数据）。
- 永不抛。

**watermark**：`session_compact` 处理完后立即记录当前分支末条目 id（`getBranch()` 的最后一个 `id`，即压缩条目本身）为 `afterEntryId`。

**R2-6：compaction 条目自身的 usage 如何处理**：`CompactionEntry.usage`（`session-manager.d.ts:54`）是「生成这份摘要/应用这份交接」那次 LLM 调用的账。它属于**切换的固定成本 K**（对应 §3.3 的 `H`），与「切换之后又花了多少」正好相反。因此：

- 它**单独**记入 `phase: "switch"` 行的 `compactionCostUsd`；
- 它**绝不**计入 `rProxy.costUsd`；
- 聚合器也不会误收它：压缩条目的 `type` 是 `"compaction"` 而非 `"message"`，天然不满足累加条件（由 T-D2-RANGE-AGG 钉死）。

假如把它混进 `rProxy.costUsd`，就等于把 K 重复计入 R 的代理量，直接污染日后的拟合。

观察窗关闭（在既有 `turn_end` 里判定，**无 timer**）：`turns ≥ 6` 或 `wallMs ≥ 600_000`，先到为准；`session_shutdown` 时若仍开着则按实际值 flush，不丢样本。关闭时写 `phase: "window"` 行，同时把 `firstContextTokens`（非 null 时）喂给 estimator 的 `observeRestart` 作为 `S0` 观测值。

---

## 6. 分档价格（GPT-5.6 sol/terra 的 272k 拐点）

1. `tierBoundaries()` 把每个合法 `inputTokensAbove` 及 `B − TIER_MARGIN` 收进候选集（仅当落在可行区间内，§3.4 第 10 步）。
2. argmin 命中时 `basis = "tier"`，`nextTierTokens = B`，标记 `hint 72% · tier 272k`。
3. **跨档前一次性提醒**：`usedTokens ∈ [B − TIER_MARGIN, B]` 且该 `B` 本会话尚未提醒过 ⇒ 允许突破 hint 的 10 分钟冷却发一次（每个 `B` 一张票）。理由：跨档后单价翻倍是不可逆的请求级事件。**注意边界语义**（P1-9）：`B` 本身仍是低价档，所以票在 `usedTokens ≤ B` 时仍有效。
4. **force 不因分档下压**（D10）：force 的语义是「别把窗口撑爆」，混入省钱会让越线归因不可解释。

---

## 7. v2 预留：冷缓存 / TTL（v1 完全不做）

D4 拍板推迟。v1 因此**没有** cold 判定、没有冷却豁免、没有 `·cold` 标记、没有对应配置与测试。

v2 若重启，需要的依赖在此记账（避免将来重新考古）：

- **P1-2 settled-covered port**：需要一个「已结算且确认被 1h 覆盖」的只读端口，而不是直接读 `isPrefix1hCovered`（S9）的瞬时值——后者在 pending 未结算时会给出乐观答案。
- 冷热判据必须把 `provenCacheReadAt()`（S8）算进来：`coldAt = max(最近一次请求, provenCacheReadAt())`。memory `cache-ttl-gotchas.md` 记录的现场事故正是「只看 `cacheRead > 0` 判 warm，导致整段前缀全价重写」。
- 1h 覆盖中一律不得判 cold。
- 动态层对 keepalive / adaptive **只读**：绝不触发 ping、绝不写回任何状态。
- 届时 `K(C)` 才需要变成 C 的函数（`K_eff = (1−q)K + q·K_cold − q·(w−r)·C`，研究 §2.4），§3.3 的签名已预留。
- 写价区分 5m/1h（P1-1 的正式解）也应在同一波里做。

---

## 8. 退化阶梯

自上而下，第一条命中者生效。所有退化**只在 `/agent status` 可见**，绝不向模型发额外消息。

### 8.1 主阶梯

| #   | 条件                                                                      | 行为                                                                                                                                                                                                    | 结果                                          |
| --- | ------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------- |
| 1   | `W` 无效 / `W < 32_000` / `usage.tokens == null`                          | 现行静态线独占                                                                                                                                                                                          | `usable:false`，reason 见 §3.1                |
| 2   | `cost` 缺失或 `cacheRead` 不是有限正数                                    | `unknownPriceMode="static"`（默认）⇒ `usable:false, "price-unknown"`；`="quality"` ⇒ `usable:true`，`hintTokens = clamp(maxQualityPercent%·W, lowerBound, cap)`，`basis="quality-cap"`，**不进 argmin** | P1-8 拆成两条性质                             |
| 3   | 订阅制（见 §8.2）                                                         | 跳过 argmin，走前压曲线                                                                                                                                                                                 | `usable:true`，`basis="quality-cap"\|"quota"` |
| 4   | `cacheWrite` 缺失或 `0`                                                   | **不退化**：`Wnew = 0`，`writeKnown=false`；K 偏小 ⇒ C\* 偏早 ⇒ 地板兜住；status 标 `w?`                                                                                                                | 正常                                          |
| 5   | `g` / `S0` 样本不足                                                       | **不退化**：先验混合（§4.1）                                                                                                                                                                            | 正常                                          |
| 6   | `cap < lowerBound`（含 reserve 接近窗口、质量上限低于地板、force 线过低） | 静态线独占                                                                                                                                                                                              | `usable:false, "infeasible-range"`            |
| 7   | 纯函数抛异常（不该发生）                                                  | wire 层 try/catch ⇒ `usable:false, "internal-error"` + 一次性 warn + **本会话禁用动态层**                                                                                                               | 静态线独占                                    |

**有效 force 线为 0**（R2-9：`effectiveThresholdPercentWithTokens(windowScaledForcePercent(forceAtPercent, W), forceAtTokens, W, reserve) === 0`，即百分比线与绝对线**都**关掉）不属退化：`cap` 省略该项，`basis` 永不为 `force-gap`（见修订记录「部分采纳」）。注意 `forceAtPercent === 0` 但 `forceAtTokens > 0` 时 force 线**仍然生效**，此时 cap 必须计入 force 项。

### 8.2 订阅制（D6，取值规则写死）

**识别**：`settings.quota.enabled` 为真 ∧ `parseSubscriptionProviders(settings.quota.subscriptionProviders)(provider)` 为真 ∧ `quota.verdictFor(provider)` 返回 verdict。

**压力值取法（写死）**：

```
verdict = quota.verdictFor(provider)
if (verdict === undefined || verdict.stale === true) → 不前压，line = clamp(qualityCap, lowerBound, cap)，basis = "quality-cap"
else:
  live = verdict.windows.filter(w => w.resetAt === undefined || w.resetAt > now)   // 未过期窗口
  if (live.length === 0) → 不前压（同上）
  usedPct = max(live.map(w => w.usedPct))                                          // 取最高（Kimi 周耗尽陷阱同款口径）
```

**前压曲线**（token 空间，线性插值，端点见 §3.5）：

```
usedPct <= 75           ⇒ line = qualityCapTokens
75 < usedPct < 95       ⇒ line = qualityCapTokens − (qualityCapTokens − lowerBound) · (usedPct − 75) / 20
usedPct >= 95           ⇒ line = lowerBound
最后统一 clamp 到 [lowerBound, cap]，因此**恒不低于地板**
basis = usedPct > 75 ? "quota" : "quality-cap"；subscriptionPressure = usedPct
```

理由：订阅额度按 token 计，长前缀的每轮 cache-read 同样吃额度，高位时早切是真实收益；75 与额度阶梯的 L2（`src/quota/ladder.ts:57` `DEFAULT_THRESHOLDS.l2 = 75`）对齐，避免与既有阶梯警告在不同点位上各说各话。

---

## 9. 质量上限、迟滞与状态机

### 9.1 上下限

- **质量上限** `maxQualityPercent = 60`（D8）：**未校准的安全上限**。研究 §6 给不出精确拐点（Lost-in-the-Middle / RULER / Context Rot 只给方向），故 v1 用硬约束而非 `λ_D·D(C)` 惩罚项。真实四次切换最晚 48.3%，60 留了余量又不至于进 context rot 高风险区。
- **地板** `minHintPercent = 35`：保守启动先验，防止纯成本解（1M Claude 约 12%–16%）把用户拖进「每小时切七次」。
- **三条上限顺序**见 §3.4 第 7 步；`cap < lowerBound` 直接退化（不再出现「地板顶穿上限」这种需要仲裁的状态）。
- **`hint + 迟滞 ≤ force`**：`HYSTERESIS_PCT = 3` 在 token 空间保证，量化后再断言 `hintPercent + 1 ≤ forcePercent`（量化余量），性质 P4 钉死。
- **tick 网格不动**（D7）：网格入参仍是 `(step, forceCeiling)`。把每轮可能移动的 hint 线插进网格会破坏 `lastTickStep` 闩锁语义，让「阶梯通报」不再是阶梯。

### 9.2 发布 / hintedAt / epoch 状态机（P2-1）

三个状态量：

| 名称        | 载体                                                                    | 含义                                     |
| ----------- | ----------------------------------------------------------------------- | ---------------------------------------- |
| `published` | `DynamicRuntime`（随 estimator 落盘）                                   | 上一次对外发布的 `hintPercent`           |
| `hintedAt`  | `CompactHintState.hintedAt`（现有字段，`mode="on"` 时增加 `hintEpoch`） | hint 已发过的闩锁                        |
| `hintEpoch` | `DynamicRuntime`                                                        | 「一次高位期」的编号；只在真实回落时自增 |

转换表（`mode = "on"`；其余模式下 `hintEpoch` 恒为 0，判定表达式与今天等价）：

| 触发                                                     | `published`          | `hintEpoch` | `hintedAt`     | 是否重新提醒                        |
| -------------------------------------------------------- | -------------------- | ----------- | -------------- | ----------------------------------- |
| 动态线重算，差值 < 死区                                  | 不变                 | 不变        | 不变           | **否**                              |
| 动态线重算，差值 ≥ 死区                                  | 更新为新值           | 不变        | 不变           | **否**（线动不等于该再吵一次）      |
| 真实用量跌破 `line − HYSTERESIS_PCT%·W`                  | 不变                 | **+1**      | 清空           | 下次越线时是                        |
| 用量越线且 `hintedAt.hintEpoch !== hintEpoch` 且冷却已过 | 不变                 | 不变        | 记为当前 epoch | **是**                              |
| 模型/窗口指纹变化（epoch 翻转，§4.3）                    | **清空**             | 不变        | 不变           | 否（下次越线按常规判）              |
| `usable: true → false`（退化）                           | 不变（留作诊断）     | 不变        | **不清**       | 否 —— 防止「退化 ⇒ 立刻重提醒」     |
| `usable: false → true`（恢复）                           | 不变                 | 不变        | **不清**       | 否 —— 同上，静态↔动态互切不制造提醒 |
| `mode` 在 `/reload` 后改变                               | 清空（随新 runtime） | 归 0        | 由 stack 重建  | 按新模式常规判                      |

设计意图一句话：**只有真实用量的回落才重置提醒权，任何「线自己动了」都不重置。**

---

## 10. 对模型可见的文案 / status / settings

遵守 AGENTS.md 中英分工：短标记只用英文 token 与仓库既有的 `·` 分隔符，中文只出现在整句 prose 里。

### 10.1 tick（`buildUsageTickText` 增加可选第 4 参 `marker?: string`）

```
[pi-subagent 上下文通报] 上下文已使用约 45%。达到 41% 时会再提醒你考虑 switch_context；现在无需操作。 [hint 41% · cost]
```

标记取值：`hint 41% · cost`、`hint 35% · floor`、`hint 60% · quality`、`hint 72% · tier 272k`、`hint 38% · quota`、`hint 75% · static`。
`marker` 省略时输出与今天**逐字节相同**（`mode !== "on"` 时永远省略）。**v1 无 `·cold`**（D4）。

**测试口径（P2-3）**：断言标记**不含 CJK 字符**（`/[\u3000-\u303f\u4e00-\u9fff\uff00-\uffef]/` 不匹配），而不是断言纯 ASCII —— `·`（U+00B7）本就是仓库既有分隔符。

### 10.2 hint 文案

`buildSwitchHintText` / `buildCompactHintText` 增加可选 `note?: string`，仅当 `basis ∈ {cost, tier, quota}` 时追加一行中文 prose：

- cost：`- 本次阈值由价格模型给出 [hint 41% · cost]：继续下去每轮都要为这段长前缀付 cache-read。`
- tier：`- 再涨约 6k token 就会跨进高价档 [tier 272k]，跨档后单价翻倍；在此之前切换最划算。`
- quota：`- 订阅额度已用 88% [quota]，提前切换可以少烧一些额度。`

`note` 省略时与今天逐字节相同。demand（L2）文案**不加任何动态信息**。

### 10.3 `/agent status`（P1-11）

只读视图，不暴露内部可变对象：

```ts
export interface DynamicStatusView {
  readonly mode: "off" | "shadow" | "on";
  readonly usable: boolean;
  readonly degradeReason: string | null;
  readonly hintPercent: number | null;
  readonly basis: string | null;
  readonly lowerBoundPercent: number | null;
  readonly capPercent: number | null;
  readonly cStarPercent: number | null;
  readonly g: number | null;
  readonly sigma: number | null;
  readonly s0: number | null;
  readonly rUsd: number;
  readonly rEquivalentTurns: number | null;
  readonly priceReadPerM: number | null;
  readonly priceWritePerM: number | null;
  readonly writePricingApproximate: boolean;
  readonly subscriptionPressure: number | null;
  readonly telemetryCount: number;
  readonly telemetryPath: string | null;
}
```

渲染（英文，3 行；`mode="off"` 或端口缺席 ⇒ **整节不渲染**，旧输出逐字节不变）：

```
Compact thresholds: hint 41% (dyn·cost) · force 88% · window 1.0M · reserve 16k · range 35%..60%
  price r $0.20/M w $5.00/M~ out $20.00/M (write pricing approximate) · C* 16% · g 1.2k/turn (σ 0.9k, n=37) · S0 98k
  R $10.00 (uncalibrated prior, ≈ 96 turns) · dynamic on · telemetry 12 → ~/.pi/agent/telemetry/compact-switch.jsonl
```

退化时第 1 行末尾改为 `· dyn off (price-unknown → static line)`。

**转发形状**：`StatusCommandDeps` 增加可选端口 `dynamic?: { view(): DynamicStatusView | undefined }`，`src/index.ts` 注入 `() => holder.current?.dynamic?.statusView()` —— 经 holder 读，`/reload` 后自然指向新 stack（与 S18 的既有形状一致）。端口缺席 ⇒ 输出与今天逐字节相同。

### 10.4 `/agent settings`

在 `src/config/setting-specs.ts` 注册 5 个键（非 live，改后需 `/reload`）：

```
compact.dynamicThreshold.mode              enum  off|shadow|on   "Price-aware dynamic hint line (default on; shadow = compute + telemetry only)"
compact.dynamicThreshold.minHintPercent    number 0..100         "Never hint before this share of the window"
compact.dynamicThreshold.maxQualityPercent number 0..100         "Quality ceiling (uncalibrated safety cap); never hint later than this"
compact.dynamicThreshold.rediscoveryUsd    number >=0            "Assumed rediscovery cost per switch, USD (uncalibrated empirical prior)"
compact.dynamicThreshold.unknownPriceMode  enum  static|quality  "Fallback when the route reports no cache-read price"
```

### 10.5 `set_compact_threshold`（query 分支加一行，set 分支不变）

同样经 `DynamicStatusView` 读（P1-11），端口缺席则不加这行：

```
Dynamic hint line: 41% (cost; C* 16%, g 1.2k/turn, R $10 uncalibrated) — your configured 75%/500k stays the upper bound.
```

---

## 11. 配置与回滚

### 11.1 settings 形状

```ts
export interface DynamicThresholdSettings {
  mode: "off" | "shadow" | "on";
  minHintPercent: number;
  maxQualityPercent: number;
  rediscoveryUsd: number;
  unknownPriceMode: "static" | "quality";
}
// CompactSettings 新增：dynamicThreshold: DynamicThresholdSettings;
```

`parseCompactSettings` 内联解析（沿用「逐字段回退默认、永不抛」风格）+ 交叉校验：`minHintPercent > maxQualityPercent` ⇒ 两者都回默认；`mode` / `unknownPriceMode` 非白名单 ⇒ 默认。

### 11.2 默认值

| 键                  | 默认       | 说明                                                                                           |
| ------------------- | ---------- | ---------------------------------------------------------------------------------------------- |
| `mode`              | **`"on"`** | 用户拍板（D1）。风险由 D3 的 `min` 合成（只能提前）+ force 完全不动 + `off` 逐字节回归三重兜住 |
| `minHintPercent`    | 35         | 研究 §7.4                                                                                      |
| `maxQualityPercent` | 60         | **未校准的安全上限**（D8）                                                                     |
| `rediscoveryUsd`    | 10         | **经验先验，未跨模型校准**（D2）                                                               |
| `unknownPriceMode`  | `"static"` | 未知价格时最保守 = 不改变现行行为                                                              |

`shadow` 与 `off` 保留：`shadow` = 全量计算 + 遥测 + status，但**不改任何模型可见字节**；`off` = 完全不构造。

### 11.3 回滚保证（`mode = "off"`）

1. `mode === "off"` ⇒ 不构造 runtime，`compactHint.dynamic === undefined`；三个新 `pi.on` handler 首行 `if (!holder.current?.dynamic) return;`。
2. 钩子里的合成走原表达式（同一行代码，不是「恰好等价的新表达式」）；文案函数新参数全为可选且省略。
3. 黄金回归测试 T-D3-OFF-GOLDEN：脚本化 usage 序列（跨 hint / force / 压缩回落 / tick 全网格）下逐条断言 `sendMessage` 的 `content` 与 `details` 与改动前录制的 fixture 完全相同。

---

## 12. 分包、文件范围与测试锚点

依赖链 D1 → D2 → D3 → D4；D1/D2 均不碰 `src/stack.ts`，可独立验收。

### D1 — 纯函数层

**新增**：`src/compact-hint/dynamic/{types,pricing,cost-model,estimator,threshold,markers}.ts`
**不动**：`src/compact-hint/threshold.ts`

| 测试 id                    | 文件                                            | 断言                                                                                                                                                                                                                                    |
| -------------------------- | ----------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| T-D1-PRICE-TIER            | `tests/compact-hint/dynamic/pricing.test.ts`    | GPT-5.6 sol 272k 档：`readRateAt` 在 271_999 / 272_000 为 0.4/M，272_001 为 0.8/M                                                                                                                                                       |
| T-D1-TIER-BOUNDARY         | 同上                                            | **P1-9**：B−1 / B / B+1 三点归档正确（B 属低档）；重复 `inputTokensAbove` 保留最后一个；负数 / NaN / 非有限档位被清洗掉；单价字段缺失时继承 base                                                                                        |
| T-D1-COST-SEGMENTS         | `tests/compact-hint/dynamic/cost-model.test.ts` | 分段求和 == 朴素逐轮求和（随机 200 组，误差 < 1e-9）                                                                                                                                                                                    |
| T-D1-CSTAR                 | 同上                                            | 复现研究 §4.2：Opus 5.5（K=$0.48, g=774, S0=100k, r=$0.2/M）⇒ 160,952 ± 1%                                                                                                                                                              |
| T-D1-CSTAR-R10             | 同上                                            | `R=10` ⇒ Opus 5.5 的 C\* 落在 [380k, 420k]（锁死 §5.1 的默认值依据）                                                                                                                                                                    |
| T-D1-USABLE                | `tests/compact-hint/dynamic/threshold.test.ts`  | **P0-1**：六种退化各自返回 `{usable:false, reason}`；`usable:true` 时 `hintTokens > 0`                                                                                                                                                  |
| T-D1-FEASIBLE              | 同上                                            | **P0-2**：候选集恒含 `lowerBound`/`cap` 两端点；`cap < lowerBound` ⇒ `"infeasible-range"`；reserve 占窗口 80% ⇒ 退化；W=31_999 ⇒ `"window-too-small"`                                                                                   |
| T-D1-FORCE-OFF             | 同上                                            | **部分采纳项 + R2-9**：`forceAtPercent=0 且 forceAtTokens=0` ⇒ 仍 `usable:true` 且 `basis` 永不为 `force-gap`；**`forceAtPercent=0` 但 `forceAtTokens=900`（W=1M）⇒ cap 必须计入 force−迟滞项**，`basis` 可为 `force-gap`               |
| T-D1-TIER-CANDIDATE        | 同上                                            | GPT-5.6 sol 参数下 argmin 命中 `272k − margin`，`basis="tier"`、`nextTierTokens=272_000`                                                                                                                                                |
| T-D1-FLOOR/QUALITY/RESERVE | 同上                                            | 三条钳制各自生效时 `basis` 正确                                                                                                                                                                                                         |
| T-D1-DEADBAND              | 同上                                            | `published=41`、新解 42 ⇒ 仍 41；新解 44 ⇒ 44；epoch 变化 ⇒ 死区失效                                                                                                                                                                    |
| T-D1-QUANTIZE              | 同上                                            | **R2-5**：`W=10M`+`minHintPercent=0`+`R=0` ⇒ 线被抬到 `ceil(W/100)`、`hintPercent ≥ 1`，经 `thresholdLineTokens` 往返后不塌成 0；抬升后超过 `cap` ⇒ `usable:false, "infeasible-range"`；`W=1M` 常规参数下该抬升不生效（不影响既有结果） |
| T-D1-DEGRADE-PRICE         | 同上                                            | **P1-8**：`cacheRead` 缺失/0/NaN + `static` ⇒ `usable:false`；+ `quality` ⇒ `usable:true`、`basis="quality-cap"`、落在 `[lowerBound, cap]`                                                                                              |
| T-D1-SUBSCRIPTION          | 同上                                            | **D6**：`stale=true` ⇒ 不前压；窗口全过期 ⇒ 不前压；`usedPct` 取未过期窗口最大值；曲线在 75 / 85 / 95 三点取值正确且恒 ≥ 地板                                                                                                           |
| T-D1-WRITE-ZERO            | 同上                                            | `cacheWrite=0` 不退化；`writePricingApproximate` 恒 true                                                                                                                                                                                |
| T-D1-EWMA                  | `tests/compact-hint/dynamic/estimator.test.ts`  | **P2-2**：负 Δ 丢弃、超大 Δ 截断、压缩后首个 Δ 丢弃、热身混合；方差用旧均值（对拍手算值）；返回新对象（原对象未被改动）；样本减半 `floor`；序列化往返；脏数据回读不抛                                                                   |
| T-D1-EPOCH                 | 同上                                            | **P1-7**：指纹任一字段变化都翻 epoch；翻转后 `published` 清空、`s0Samples=0`、`gSamples` 减半                                                                                                                                           |
| T-D1-MARKERS               | `tests/compact-hint/dynamic/markers.test.ts`    | **P2-3**：标记不含 CJK（正则）；允许 `·`；note 为中文整句                                                                                                                                                                               |

**性质测试**（`tests/compact-hint/dynamic/threshold.property.test.ts`，seeded）：

| id      | 不变式                                                                                            |
| ------- | ------------------------------------------------------------------------------------------------- |
| P1      | `R ↑ ⇒ hintTokens` 单调不减（`usable:true` 的样本内）                                             |
| P2      | `cacheRead ↑ ⇒ cStar` 单调不增                                                                    |
| P3      | `g ↑ ⇒ cStar` 单调不减                                                                            |
| P4      | `usable:true ∧ force>0 ⇒ hintPercent + 1 ≤ forcePercent`                                          |
| P5      | `usable:true ⇒ lowerBound ≤ hintTokens ≤ cap ≤ min(W−reserve, 60%W)`                              |
| **P6a** | **P1-8**：价格未知 + `static` ⇒ `usable:false`，合成结果与直接用静态线**逐字节**一致              |
| **P6b** | **P1-8**：价格未知 + `quality` ⇒ `usable:true`，满足 P5，且不等于任何 argmin 候选（未进成本模型） |
| P7      | argmin 正确性：返回点 `A(C)` ≤ 所有候选的 `A(C)`                                                  |
| P8      | 幂等：把输出回填成 `published` 再算一次，结果不变                                                 |
| P9      | 全域无 NaN/Infinity/负数（注入 0、负价、极小窗口、极大 g、脏 tier）                               |
| P10     | 分段成本 == 朴素成本                                                                              |
| P11     | **P0-1**：输出恒为判别联合之一；`usable:false` 分支不含任何数值线字段                             |

**验收**：`npx vitest run tests/compact-hint` 绿；`npm run typecheck` 绿；`rg "pi-coding-agent|pi-ai|node:fs" src/compact-hint/dynamic/{types,pricing,cost-model,estimator,threshold,markers}.ts` 无命中。

### D2 — 遥测与范围聚合

**新增**：`src/compact-hint/dynamic/telemetry.ts`、`src/compact-hint/dynamic/usage-range.ts`、`src/compact-hint/dynamic/telemetry-store.ts`

| 测试 id            | 文件                                                           | 断言                                                                                                                                                                                                                                                             |
| ------------------ | -------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| T-D2-RANGE-AGG     | `tests/compact-hint/dynamic/usage-range.test.ts`               | **P0-4**：按 watermark 累加区间内所有 assistant usage（不是只读最后一条）；跨模型 ⇒ `models.length>1`                                                                                                                                                            |
| T-D2-RANGE-UNKNOWN | 同上                                                           | watermark 不在分支上 ⇒ `"watermark-lost"`；区间无 usage ⇒ `"no-usage"`；任一条缺 `cost.total` ⇒ `costUsd:null` + `"cost-missing"`；**任何情况都不返回 0 冒充未知**                                                                                               |
| T-D2-RANGE-SAFE    | 同上                                                           | `getBranch` 缺失 / 抛异常 / 返回非数组 ⇒ 不抛，返回全 `null`                                                                                                                                                                                                     |
| T-D2-TRIGGER       | `tests/compact-hint/dynamic/telemetry.test.ts`                 | **P0-3 + R2-1/R2-4**：`compactionEntry.fromHook` 读对位置（不在事件根上）；`handoffApplied` 只由 `onApplied` 开火决定（**不由时间窗决定**）；trigger 判定表六格逐格覆盖，含「marker 与 reason 矛盾 ⇒ `unknown`」                                                 |
| T-D2-WINDOW        | 同上                                                           | 观察窗 6 轮 / 600s 先到者关闭；关闭后不再产生第三条；`session_shutdown` 补写                                                                                                                                                                                     |
| T-D2-NO-PATHS      | 同上                                                           | **D5 + R2-8**：`JSON.parse` 后**递归遍历**断言 ① 不存在 `path`/`file`/`dir`/`cwd`/`hash`（大小写不敏感、含 `filePath`/`filesRead` 这类前后缀）类键名；② 不存在任何字符串数组值；③ 注入的哨兵路径不出现在任何字符串里。**不用 `grep '/'`**——`model.id` 合法含 `/` |
| T-D2-NULL-NOT-ZERO | 同上                                                           | 各缺失量序列化为 `null`（`JSON.stringify` 后断言），不是 `0`                                                                                                                                                                                                     |
| T-D2-ATOMIC-LINE   | `tests/compact-hint/dynamic/telemetry-store.test.ts`（tmpdir） | 每条恰好一次 `appendFileSync`、一行、结尾换行；超长记录先降级再跳过并 warn；行字节 ≤ 3_500（**行长是降低撕裂概率的工程手段，不断言原子性**）                                                                                                                     |
| T-D2-CONCURRENT    | 同上（tmpdir + `child_process.fork`）                          | **R2-7**：两个进程各写 N 条（其中一方跨过 2 MiB 触发 rotate）⇒ ① 主文件 + `.1` 逐行 `JSON.parse`，**可解析行**的总数 ≥ 2N×(1−ε) 且每条内容自洽；② 解析失败的行被消费端跳过而不抛；③ 进程均以 0 退出、无未捕获异常                                                |
| T-D2-PERMS         | 同上                                                           | 文件模式 0600、目录 0700（`statSync().mode & 0o777`）                                                                                                                                                                                                            |
| T-D2-ROTATE-RENAME | 同上                                                           | >2 MiB ⇒ `rename` 到 `.1`，只保留一代；再次轮转覆盖旧 `.1`                                                                                                                                                                                                       |
| T-D2-NEVER-THROW   | 同上                                                           | 目录不可写 / 路径是目录 / 模拟 ENOSPC ⇒ 不抛，每 errno 只 warn 一次                                                                                                                                                                                              |

### D3 — 接线

**新增**：`src/compact-hint/dynamic/wire.ts`
**改动**：`src/stack.ts`（`CompactHintState.dynamic?`、`Stack.dynamic?`、构造、合成 §3.6、`hintEpoch` 闩锁、**force/demand 发出处建 `forceMarker` 且 `onError`/同步 catch 清除**）、`src/index.ts`（3 个 `pi.on` + **`createSwitchContextCompactHook` 的 `onApplied` 注入**（R2-1）+ **`session_compact_failed`（`:375`）追加 `clearMarkers`** + 2 处 dispose + status/tool 端口注入）、`src/compact-hint/threshold.ts`（只加可选 `marker`/`note` 参数）、`src/config/settings.ts`、`src/config/setting-specs.ts`、`src/tools/set-compact-threshold-tool.ts`、`src/commands/status.ts`

| 测试 id                | 文件                                                     | 断言                                                                                                                                                                                                                            |
| ---------------------- | -------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| T-D3-OFF-GOLDEN        | `tests/integration/compact-dynamic-off-golden.test.ts`   | `mode="off"` ⇒ 所有 `sendMessage` 的 content/details 与 `tests/fixtures/compact-hint-golden.json` 逐字节相同                                                                                                                    |
| T-D3-SHADOW-SILENT     | `tests/integration/compact-dynamic-wiring.test.ts`       | `shadow` ⇒ 模型可见字节与 off 相同；但 status 有动态节、遥测有写入                                                                                                                                                              |
| T-D3-ON-DEFAULT        | `tests/config/compact-dynamic-settings.test.ts`          | **D1**：缺省配置解析出 `mode="on"`                                                                                                                                                                                              |
| T-D3-ON-LINE           | `tests/integration/compact-dynamic-wiring.test.ts`       | `on` + Opus 5.5 价格 + 静态 75%/500k ⇒ hint 在约 40% 触发                                                                                                                                                                       |
| T-D3-ON-NEVER-LATER    | 同上                                                     | **D3**：静态设 30% ⇒ 动态不得推到 40%                                                                                                                                                                                           |
| T-D3-HINT-DISABLED     | 同上                                                     | **P0-1**：`percent=0, tokens=2000, W=1M` ⇒ hint 保持关闭；`percent=0, tokens=500` ⇒ `min(500k, dyn)`                                                                                                                            |
| T-D3-STATE-MACHINE     | 同上                                                     | **P2-1**：逐行验证 §9.2 转换表（线移动不重提醒；真实回落才重置；退化/恢复不制造提醒）                                                                                                                                           |
| T-D3-TIER-EXEMPT       | 同上                                                     | 跨档前一次性提醒突破冷却，每个 B 一次                                                                                                                                                                                           |
| T-D3-DISPOSE           | 同上                                                     | **P1-4**：`session_shutdown` 与「无 shutdown 直接 session_start」两条路径都 dispose；dispose 后再来事件不写遥测                                                                                                                 |
| T-D3-PRINT             | 同上                                                     | **P1-5**：根会话 `ctx.mode="print"` ⇒ 惰性 runtime、零遥测                                                                                                                                                                      |
| T-D3-CHILD             | 同上                                                     | **P1-5**：真子会话激活路径同样惰性                                                                                                                                                                                              |
| T-D3-RPC               | 同上                                                     | **R2-3**：`ctx.mode` 既非 `print` 也非 `json`（RPC 驱动的主会话）⇒ 动态层**正常运行**（不得被 `mode !== "tui"` 误杀）；判定条件与 `src/stack.ts:575` 逐字一致                                                                   |
| T-D3-NO-TIMER          | 同上                                                     | spy 全局 `setInterval`/`setTimeout`：wire 一次都不调                                                                                                                                                                            |
| T-D3-TOOLCALL-PASSTHRU | 同上                                                     | `tool_call` handler 恒返回 `undefined`，且不改 `event.input`                                                                                                                                                                    |
| T-D3-CAUSALITY         | 同上                                                     | **R2-1**：仅 `tool_call` 出现但 `onApplied` 未开火（工具早退 / `ctx.compact()` 失败 / 交接过期）⇒ `handoffApplied:false` 且 `trigger ≠ "switch-tool"`；`onApplied` 开火后的压缩 ⇒ `handoffApplied:true`、`seq` 取自 `onApplied` |
| T-D3-MARKER-CLEANUP    | 同上                                                     | **R2-4**：`forceMarker` 在 ①`session_compact` 成功、②`ctx.compact()` `onError`/同步 catch、③`session_compact_failed`、④`MARKER_TTL_MS` 超时 四条路径后均为空；随后的无关压缩不得被记成 `"dynamic-force"`                        |
| T-D3-STATUS-VIEW       | `tests/commands/status.test.ts`（追加）                  | **P1-11**：端口缺席 ⇒ 输出逐字节同今天；`on` ⇒ 三行格式；退化文案；`/reload` 后 view 指向新 stack                                                                                                                               |
| T-D3-TOOL              | `tests/tools/set-compact-threshold-tool.test.ts`（追加） | query 在 on/shadow/off 三态的文案；set 分支行为不变                                                                                                                                                                             |
| T-D3-SETTINGS          | `tests/config/compact-dynamic-settings.test.ts`          | 逐字段回退、`min > max` 交叉校验、5 个 spec 的 path 可解析                                                                                                                                                                      |

**验收**：`npm test` 全绿（3621 项不得回归）、`npm run typecheck`、`npm run format:check`、`npm run build`。

### D4 — 文档与真机验收

**文件**：`docs/dev/compact-hint/compact-hint-plan.md`（追加 §15 指针）、`docs/dev/compact-hint/dynamic-threshold-acceptance.md`（新建）、`AGENTS.md`（`src/compact-hint/` 条目补一句）、本文件（回填施工偏差）。

**真机验收（确定性判据）**：

1. `mode=on`（默认）+ 1M Claude ⇒ hint 在 38%–45% 触发一次，tick 末尾出现 `[hint NN% · cost]`。
2. `compact-switch.jsonl` 在一次真实 `switch_context` 后有 2 条同 `seq` 记录（`phase` 分别为 `switch`/`window`），且 `adopted === true`、`handoffApplied === true`、`trigger === "switch-tool"`（R2-1：seq 来自 `onApplied`）。
3. `rProxy.costUsd` 至少出现一次非 null 值；**逐行 `JSON.parse` 后递归断言无路径类字段**（键名匹配 `/path|file|dir|cwd|hash/i` 或值为字符串数组即失败）——**不再用 `grep -c '/'`**，因为 `model.id` 本身就含 `/`（R2-8）。
4. `ls -l` 显示文件权限 `-rw-------`。
5. 切到 GPT-5.6 sol（372k）⇒ status 的 `next tier` 显示 `272k`，跨档前收到一次 tier 提醒。
6. `mode=off` + `/reload` ⇒ status 无动态节，tick/hint 文案与 fixture 一致。
7. `pi -p` 子会话 ⇒ 无遥测写入、无挂起。
8. 订阅制 provider 在额度 >75% 时 status 显示 `dyn·quota` 且 hint 线被前压。

---

## 13. 不变式自查（AGENTS.md）

| 不变式                            | 处置                                                                                                                |
| --------------------------------- | ------------------------------------------------------------------------------------------------------------------- |
| 零挂起 / 定时器必须 unref         | **不新增任何定时器**；全部挂既有 `turn_end` / `tool_call` / `session_compact` / `session_shutdown`（T-D3-NO-TIMER） |
| 禁止模块级可变状态                | 状态全在 `wire.ts` 闭包 + `Stack.dynamic`；dispose 归属见 §2.4                                                      |
| 子会话惰性                        | 构造期惰性 + handler 内二次判 mode（T-D3-PRINT / T-D3-CHILD）                                                       |
| 中英分工                          | 标记不含 CJK（T-D1-MARKERS）；中文只在整句 prose                                                                    |
| 纯层不 import pi                  | D1 六个模块由 `rg` 断言；`usage-range.ts` 为 duck type；`telemetry-store.ts` 只用 node fs                           |
| `getBranch()` 而非 `getEntries()` | 估计量回读与范围聚合都走 `getBranch()`                                                                              |
| 不回写 cache-ttl 状态             | v1 根本不读 cache-ttl（D4 推迟）；v2 的只读纪律记在 §7                                                              |
| 遥测不得影响主链路                | 全静默吞错 + 每 errno 一次 warn；无锁                                                                               |
| Conventional Commits              | `feat(compact-hint): …` / `test(compact-hint): …`，每包 1–2 个提交                                                  |

---

## 14. 剩余风险

1. **`R = $10` 是反推值**，且默认 `mode=on` 直接生效。缓解：`min` 合成只能提前、force 完全不动、地板/上限双侧夹紧、`off` 一键逐字节回滚；遥测持续为拟合攒数据。
2. **`maxQualityPercent=60` 未经校准**：若真实质量拐点更早，动态层不会保护；只能靠遥测的 `rProxy` 观察切换后成本与轮数是否异常。
3. **`rProxy` 是弱代理**：去掉文件交集后，v1 只能看到「切换后 N 轮花了多少钱」，无法区分「正常推进」与「重新探索」。这是 D5 隐私取舍的直接代价，`R` 的拟合精度会低于 v1 草案的设想。
4. **写价单值近似**（P1-1）：1h 覆盖场景下 `Wnew` 被低估 ⇒ K 偏小 ⇒ C\* 偏早；由地板兜住，且 status/遥测都标了 `approximate`。
5. **多进程遥测无锁**：极端情况下可能丢一条记录或丢一代轮转历史（§5.3 已论证为可接受）。
6. **`tool_call` 订阅的常态开销**：每次工具调用一次字符串比较；若 pi 未来把该事件变成可拦截关键路径需复核。
7. **`min` 合成不可推迟**：若将来发现某些低价路由应当更晚提醒，需要改成替换语义（D3 当时的另一选项）。

---

## 已拍板决策（v2 全部落定）

| 编号 | 议题                   | **拍板结果**                                                                                                                                                                                           |
| ---- | ---------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| D1   | `mode` 默认值          | **`on`**（`shadow`/`off` 保留）。风险由「动态只能提前 + force 不动 + off 逐字节回归」兜住                                                                                                              |
| D2   | `R` 的参数化           | **固定美元，默认 $10，可配置**；文档与设置说明统一标注「经验先验，未跨模型校准」                                                                                                                       |
| D3   | 动态线与静态线合成     | **`min`**：动态线只能提前                                                                                                                                                                              |
| D4   | 冷缓存 / TTL           | **整体推迟到 v2**：v1 不做 cold 判定与冷却豁免，也不需要 settled-covered port；依赖记在 §7                                                                                                             |
| D5   | 遥测内容               | **不记任何文件路径（原文/相对/hash 一律不记）**；砍掉路径集合、文件交集、纠正启发式；只记聚合数值，缺失记 `null`；字段名 `rProxy`；0600 权限、单行原子追加、rename 轮转、多进程无锁、静默吞错          |
| D6   | 订阅制策略             | **质量上限 + 额度高位前压**。压力值 = 该 provider verdict 中**未过期**窗口 `usedPct` 的最大值；verdict 缺失或 `stale` ⇒ 不前压。曲线：≤75% 取质量上限，75%→95% 线性压到地板，≥95% 取地板，恒不低于地板 |
| D7   | 动态线是否进 tick 网格 | **不进**；只出现在 tick 文案的英文标记里                                                                                                                                                               |
| D8   | `maxQualityPercent`    | **60**，标注「未校准的安全上限」                                                                                                                                                                       |
| D9   | 先验持久化范围         | **仅当前 session branch**（`appendEntry` + `getBranch()`），不做跨 session 共享                                                                                                                        |
| D10  | 分档是否下压 force     | **不下压**，force 永远只是安全网                                                                                                                                                                       |

> 施工中若与上表冲突，以上表为准；需要偏离时先改本表并说明理由。

---

## 15. 施工偏差记录（D4 回填，2026-09-25）

D1–D3 三包施工时逐条报告的偏差在此汇总（格式：**方案位置 → 实际实现 → 理由**）。均不
违反「已拍板决策」表；每条都已随包落测试。D4 本身只改文档（本文 + `compact-hint-plan.md`
§15 + `AGENTS.md` + 新建 `dynamic-threshold-acceptance.md`）。

### D1 — 纯函数层（`2cc9107`）

| #   | 方案位置                                                                        | 实际实现                                                                                                                                                                                                                                                                        | 理由                                                                                                                                                                   |
| --- | ------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | §12 D1 T-D1-TIER-CANDIDATE（「GPT-5.6 sol 参数下 argmin 命中 272k − margin」）  | 默认参数下该用例**不可达**：372k 窗口的质量上限 60% ≈ 223k，低于 272k − TIER_MARGIN，argmin 永远先被 quality-cap 截住。测试改用 `maxQualityPercent=80` + `rediscoveryUsd=13.15` 构造（K≈13.376 ⇒ 命中 272k − margin ≈ 72%），断言 `basis="tier"`、`nextTierTokens=272_000` 不变 | 「避开高价档」的目标在默认参数下由质量上限天然达成（60% 档 < 档界 ≈73%），argmin 无需亲自动手；测试移到可复现参数域，被测行为（tier 候选与归因）不变                   |
| 2   | §3.4 步骤 13（`reserve-cap` 归因）                                              | 实测推得 `reserve-cap` 只在**有效 force 线为 0**（两条 force 线都关，R2-9）时才可能成为 cap 的最小项；测试在 force-off 用例覆盖                                                                                                                                                 | force 线本身已被 reserve 钳制（`effectiveThresholdPercentWithTokens` 内含 reserve clamp），故「force − 迟滞 ≤ W − reserve」恒成立，reserve 项在 force 生效时不可能胜出 |
| 3   | §3.6（合成规则「落在 `src/stack.ts` 的钩子里」）                                | 合成逻辑抽成纯函数 `composeHintLineTokens`（`dynamic/threshold.ts`），钩子只做 IO 编排后调用                                                                                                                                                                                    | P6a（「价格未知 ⇒ 合成结果与静态线逐字节一致」）是纯函数性质，必须落在 D1 纯层才可性质测试；钩子测试也随之变薄                                                         |
| 4   | §3.1 DegradeReason 枚举 / §3.4 收敛顺序                                         | `static-hint-disabled` 的判定插在步骤 3 与 4 之间，作为**步骤 3.5**                                                                                                                                                                                                             | 判活谓词 `effectiveThresholdPercentWithTokens` 需要 W 做换算，必须在 W 校验（步骤 1–2）之后、退化阶梯之前判；提前到 3.5 语义不变、位置诚实                             |
| 5   | §3.1（`candidates`，未说明跳过 argmin 的分支）                                  | 订阅分支与 quality 降级分支跳过 argmin，返回的 `candidates` 为**空数组**（不塞伪候选）                                                                                                                                                                                          | 候选集只描述 argmin 真正评估过的点；没跑 argmin 就没有候选——与 P6b「不等于任何 argmin 候选」配套，空数组是唯一诚实表达                                                 |
| 6   | §3.5 常量表（只列 `EWMA_ALPHA_G=0.2` / `EWMA_ALPHA_S0=0.4`，未给 handoff 的 α） | handoff EWMA 的 α 取 `EWMA_ALPHA_S0=0.4`（与 S0 共用常量，代码注释写明口径）                                                                                                                                                                                                    | handoff 观测与 S0 同源同样稀少（每次真实切换才一个样本），「稀少故更快」的推导对两者一致；不单设常量                                                                   |
| 7   | §4.1 样本纪律（「Δ ≤ 0 丢弃；Δ > 0.25·W 截断后入 EWMA」）                       | Δ 被丢弃或截断时，`lastTokens` **仍然前移**到本次 tokens                                                                                                                                                                                                                        | `lastTokens` 是「上一次观测位置」而非「上一次入样位置」；不前移会让下个 Δ 跨过压缩/跳变点累积出假增长，污染 g                                                          |
| 8   | §12 D1 性质 P8（「把输出回填成 published 再算一次，结果不变」）                 | 幂等断言在 **hintPercent / basis 层**（不在 hintTokens 层）                                                                                                                                                                                                                     | published 与死区都定义在百分比坐标（§9.2）；同百分比内的 token 级微动正是死区要吸收的对象，tokens 层断言会误报                                                         |
| 9   | §12 D1 性质 P7（argmin 正确性）                                                 | P7 采样域限定在**不会触发量化抬升**的区域（测试显式取 `minHintPercent ≥ 10%`，使 `ceil(W/100) < lowerBound` 恒成立）                                                                                                                                                            | 步骤 11（R2-5）的 `ceil(W/100)` 抬升会把返回点从 argmin 原点移走——那是刻意的下限而非 argmin 错误；性质测试只应断言 argmin 本身                                         |
| 10  | §3.3（「与朴素逐轮求和恆等（P10 钉死）」）                                      | P10 允许在**测度为零的边界点**（段边界恰落在整数轮上，clamp 开闭区间使两种求和的段归属差一轮、但该轮计数为 0）出现浮点级分歧                                                                                                                                                    | 严格恒等在该边界点对浮点求和顺序敏感；差一轮且贡献为零时不构成数值分歧，放宽为「除零测度边界外恒等」才可稳定通过                                                       |
| 11  | §10.1 标记取值（六种，未列 `reserve-cap`/`force-gap`）                          | `markers.ts` 为这两种 basis 补了同构短 token：`hint NN% · reserve` / `hint NN% · force`                                                                                                                                                                                         | `ThresholdBasis` 是闭合枚举，标记函数必须全收敛；这两种值仅在 force 两线全关等罕见配置下可见，缺了会让 tick 尾巴静默空缺                                               |
| 12  | §8.2（订阅压力取法内嵌 `resetAt > now`）                                        | 抽成纯函数 `resolveSubscriptionPressure(verdict, now)`，now 由参数注入                                                                                                                                                                                                          | D1 层「零隐式 Date.now」纪律；now 注入后 stale/过期窗口逻辑可用固定时钟单测（T-D1-SUBSCRIPTION）                                                                       |
| 13  | §3.1 `PriceModel.readKnown`（「cacheRead 是有限正数」只描述了 base）            | `readKnown = base.cacheRead 有限正 ∧ **全部** tier 的 cacheRead 有限正`                                                                                                                                                                                                         | 分档后实际读价由命中档决定；base 合法但某 tier 的 cacheRead 脏 ⇒ 命中该档时单价不可信，应整体走 `price-unknown` 降级而不是拿脏价算钱                                   |

### D2 — 遥测与范围聚合（`af189dd`）

| #   | 方案位置                                                               | 实际实现                                                                                                                                       | 理由                                                                                                                                                                    |
| --- | ---------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | §5.4 末段（`tool_call` 记「叫过 switch_context」布尔「用于事后分析」） | 该辅助布尔**只保存在 wire 内存**，不进 `SwitchTelemetryRecord` 落盘 schema                                                                     | §5.2 的落盘 schema 没有它的字段；v1 的分析价值（「叫了但没生效」比例）不抵扩 schema 的成本，先留内存面                                                                  |
| 2   | §5.2（`seq`「来自 onApplied 的 seq」）                                 | 非交接类切换（`onApplied` 未开火）用**会话内单调递增的 fallback seq** 配对，并经估计量持久化条目的 `telemetrySeq` 跨 `/reload` 续号（D3 接线） | switch/window 两行仍需配对键；fallback 序号与 PendingHandoffStore 的 seq 语义不同（schema 注释已写明），持久化避免 `/reload` 后撞号导致错误配对                         |
| 3   | §5.5（观察窗关闭：`turns ≥ 6` 或 `wallMs ≥ 600s`）                     | 观察窗未到期时又来了新切换 ⇒ **先 flush 旧窗**（按实际值落 window 行）**再开新窗**，不丢样本                                                   | 否则旧窗样本被静默丢弃（只前移 watermark）；被打断的窗口恰是高频切换场景的真实数据，R 代理量不能系统性少记它们                                                          |
| 4   | §5.3（「首次创建后立刻 chmodSync」）                                   | chmod 时机为「**首次成功追加后**执行一次」（`statSync` 缓存已确认状态，免每行 syscall）                                                        | 文件由 `appendFileSync` 隐式创建，无法在「创建后、写入前」插入 chmod；首条追加成功后立刻 chmod，效果相同（任何其他读者看到内容前权限已收紧）                            |
| 5   | §5.3（「先丢弃 `candidates` 等可选诊断字段重溪一次；仍超长则跳过」）   | 两档降级：第一档丢 `rProxy.firstUsage`（原始四元组），第二档再清空 `estimate`/`price` 的数值诊断；两档后仍 >3,500B 才跳过并 warn               | v2.1 落盘 schema 已无 `candidates` 字段（D5 去路径化后记录天然变小）；降级顺序按「体积大、信息价值低」排：原始四元组最先丢，核心事实（trigger/seq/rProxy 聚合）保到最后 |

### D3 — 接线（`82b2b40` 黄金基线 + `cd0d209`）

| #   | 方案位置                                                                            | 实际实现                                                                                                                                                        | 理由                                                                                                                                                                        |
| --- | ----------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | §10.3 `DynamicStatusView` 接口                                                      | 补 `priceOutputPerM` 字段                                                                                                                                       | 方案的渲染示例第 2 行含 `out $20.00/M` 段但接口漏列该字段；补齐后 status 才渲染得出来                                                                                       |
| 2   | §10.3 转发形状（端口只有 `view()`）                                                 | status 端口增加可选 `facts()`：只读快照 `compactHint` 的 `forceAtPercent/forceAtTokens/forceScaling/reserveTokens`；窗口由命令时点的 `ctx.getContextUsage()` 给 | 第 1 行的 `force N% · window M · reserve K` 段需要这些配置；`facts()` 缺席仅省略该段，端口整体缺席则整节不渲染的既有语义不变                                                |
| 3   | §9.2 转换表（「真实用量跌破 line − 迟滞 ⇒ hintEpoch+1」）                           | 「回落重置」加**方向守卫**：只有 `percent < previousPercent`（用量真的在下降）且跌破 `line − 迟滞` 才调 `noteRealDrop()`；动态线上移越过静止的用量不触发        | 转换表的设计意图是「只有真实用量的回落才重置提醒权」；无守卫时「线自己上移、越过静止用量」会被误判成回落，白送一次重提醒                                                    |
| 4   | §10.2（「仅当 basis ∈ {cost, tier, quota} 时追加 note」）                           | 再收紧：note 只在**动态线真正胜出**（`min` 合成取的是动态线）或**跨档票命中**时附加；静态线更早时即使 basis 是 cost/tier/quota 也不加                           | 合成取 `min` 后生效线可能是静态线，此时文案宣称「阈值由价格模型给出」名不副实；note 必须跟生效线走，不能跟计算结果走                                                        |
| 5   | §4.1（handoff EWMA 观测）/§5.4 `onApplied` 的 info                                  | `onApplied` 只带 `chars`（字符数），handoff 观测按 `chars / 4`（`HANDOFF_CHARS_PER_TOKEN`）换算成 token                                                         | pi 的 `onApplied` 面上没有 token 数；交接文本以英文代码标识符/路径为主 ≈4 chars/token，与先验 2000 token 对应实测 4191–8493 字符的量级吻合                                  |
| 6   | §3.4 步骤 7（cap 的 force 项按 `windowScaledForcePercent(forceAtPercent, W)` 计算） | `forceScaling=false` 时由 wire 先按钩子的字面表达式算出**有效线**，再以绝对 token 线（`tokensK = effPct/100·W/1000`，`atPercent=0`）的形式喂给 D1               | D1 的入参形状是「锚点百分比 + 绝对线」；窗口缩放是 pi 配置语义，在 wire 层一次性归一化，纯函数层保持输入最小、无需感知 forceScaling                                         |
| 7   | §10.3（`rEquivalentTurns`「= R / 轮均成本」）                                       | 口径写死：轮均成本优先取 **argmin 候选里距当前线最近者的 `A(C)`**；候选不可用时回落 `readRateAt(hintTokens) · hintTokens` 渐近估计                              | 「轮均成本」不定义口径就会各写各的；取动态解附近的真实周期平均成本最贴合用户问题「R 相当于几轮白干」                                                                        |
| 8   | §10.3 渲染示例（`g 1.2k/turn (σ 0.9k, n=37)`）                                      | 第 2 行**省略样本数**段（渲染为 `g 1.2k/turn (σ 0.9k)`）                                                                                                        | `DynamicStatusView` 未透出样本计数；status 是诊断视图不是统计报表，行宽优先留给价格/C*/g/σ/S0 本体                                                                          |
| 9   | §5.2/§12 D2（遥测记录形状）                                                         | telemetry.ts 的局部快照类型（`ThresholdSnapshot`/`EstimateSnapshot`/`PriceSnapshot` 等）保留，**不与** D1 的 `DynamicThresholdOutcome`/`EstimatorState` 合并    | 两者职责不同：D1 类型是判别联合的内存对象（`undefined` 语义、永不落盘），遥测快照是全可空（`null` 语义）+ 带 `v:2` 版本字段的序列化切片；合并会让任一侧的缺失语义污染另一侧 |
| 10  | §11.1（`CompactSettings` 新增 `dynamicThreshold`）                                  | 既有 `tests/config/compact-settings.test.ts` 的**严格（整对象）期望随新字段更新**（同 commit 内）                                                               | 该套件对 `CompactSettings` 做整形状断言，新增合法字段必须同步期望，否则要么编译失败要么断言误报；顺带把默认值（`mode="on"` 等）钉死在旧套件里                               |
