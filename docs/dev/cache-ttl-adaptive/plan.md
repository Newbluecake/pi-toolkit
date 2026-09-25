# `cacheTtl.mode = "adaptive"` 实施方案（自适应 1h 预测器）

> 前置：本文假定读者已读过 `docs/dev/cache-ttl-keepalive/plan.md`（下称「保活方案」）与其
> `review.md`。保活 ping 已落地并在真实环境验证通过（`src/cache-ttl/keepalive-state.ts`、
> `src/cache-ttl/ping-client.ts`、`src/service/cache-keepalive.ts`、`src/cache-ttl/cache-ttl.ts`、
> `src/stack.ts` 五处接入、`src/index.ts:164`）。**本方案不重新设计保活，只新增一档 mode 与一个
> 预测器 service，并与保活衔接。**
>
> 施工纪律：TypeScript strict（`noUncheckedIndexedAccess` / `exactOptionalPropertyTypes` /
> `noImplicitOverride`）、ESM 相对导入带 `.js`、模块作用域禁放可变状态、定时器必须 `unref`
> （本方案**不新增任何定时器**，见 §9）、`src/index.ts` 只做装配、每会话状态挂 `src/stack.ts`。

---

## 评审驱动修订（第二轮评审 `review.md`，已裁决并入）

本节汇总对第二轮评审（0 Blocker / 2 Major / 6 Minor）的裁决与并入正文的修订，provenance 留痕。

| 条目   | 裁决                   | 改了什么                                                                                                                                                                                                                                                                                                                                                                                               | 落点                |
| ------ | ---------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ------------------- |
| **M1** | 采纳修法 a             | **账本锚定**：`LedgerUsage` 增加 `entrySeq`（`getEntries()` 里的下标）与 `modelId`（`entry.message.model`）；`invalidateAdaptive` 记录 `lastInvalidateSeq`（失效时刻的 `entries.length − 1` 高水位）；warm 判定追加 `entrySeq > lastInvalidateSeq && modelId === ctx.model.id`。账本不新鲜 ⇒ 判**冷**（Δ̂ = P，走冷分支，不经过热探针）——compact/换模型后的首请求不再假阳性熔断                         | §3.4、§3.5、§9.4    |
| **M2** | 采纳复合判据           | 探针熔断条件由 `writeRatio > 25%` 改为 **`cacheWrite > max(3 × predictedDeltaTokens, 64_000)`**。64k 下限（高于评审建议的 48k：一次部分命中的 compact 后重写合法可达 50k+；本探针只抓路由级结构性违例，不抓单次大重写；仍远低于 0.75P 级冷写，检测力保留）。仍只读 `cacheRead`/`cacheWrite`，不依赖 `cache_creation` 拆分字段，鲁棒性论点不变。`probeMaxWriteRatioPercent` 设置/常量**退役**，不留死键 | §4.2、§7.2、§12 T10 |
| **m1** | 修复                   | pending 被丢弃（账本 120s 未至 / invalidate 清 pending）时按 `predictedDeltaTokens` **预记账**进 `upgradeWriteTokens` ⇒ §4.4 的 ≤0.75×(W+P)×R 上界在**每条路径**上都成立，不再有 droppedPending 洞                                                                                                                                                                                                     | §4.4、§6.1a、§9.4   |
| **m2** | 修复                   | `reconcile()` 增加幂等水印 `lastReconciledEntrySeq`：**一切**副作用（pending 结账、§5.2 三态记账、tokens 累计、熔断判定）都要求 `ledger.entrySeq > lastReconciledEntrySeq`，同一账本被 `message_end`/`turn_end`/`agent_end` 重复触发只计一次                                                                                                                                                           | §4.2、§5.2          |
| **m3** | 接受为 v1 限制         | S4 锁存后热升级持续烧 W，撞线后 `write-budget` 熔断会堵死后续冷升级；且「预算耗尽」以 bad-tone 熔断呈现语义偏重。v1 不改（W 可调大/设 0 回滚已覆盖运维面）                                                                                                                                                                                                                                             | 本节                |
| **m4** | 接受为 v1 限制         | `oneHourCoverUntil` 在 decide 时刻乐观武装：升级请求若 HTTP 失败，cover 仍生效 ⇒ 后续 >5min 空档的 miss 可能以 `1h-ineffective` 误熔断。概率低（升级请求失败本就罕见），v1 不改                                                                                                                                                                                                                        | 本节                |
| **m5** | 接受为 v1 限制         | S4 的「锁存」实为「粘性但会衰减」（环形缓冲 20 条）；评审量化确认节流 + W 兜底足以按住成本（会话级 ≤ ~$0.75），不构成缺陷。文档措辞以本节为准                                                                                                                                                                                                                                                          | 本节、§3.3          |
| **m6** | 接受为 v1 限制         | dispose 后 `decide()` 复用 `breaker` 理由，审计里 disposed 与真熔断不可区分。v1 不加独立 `disposed` 理由                                                                                                                                                                                                                                                                                               | 本节                |
| 锚点   | 修正                   | §6.1 引 `cache-ttl.ts:315-317` → 实为 **`:310-311`**（`rewrite(cloned,…)` 后 `pendingCapture = { port, base: captureRequest(…) }`）；§7.3.5 `TIME_SETTING_MS_PATHS` 实为 **`settings.ts:407-435`**；§9.3 `accept()` 实为 **`cache-keepalive.ts:180-191`**                                                                                                                                              | §6.1、§7.3、§9.3    |
| 门编号 | 无需改                 | `capture.shape.ttl1h` 门在代码（`keepalive-state.ts:327-328`）与保活方案里**都是 #7**，本文一致，无 #6 残留                                                                                                                                                                                                                                                                                            | —                   |
| 默认值 | **改默认（用户裁决）** | adaptive **默认启用**：新增单开关 `cacheTtl.adaptiveEnabled`（默认 `true`），设置文件**未显式写 mode** 时 `parseCacheTtlSettings` 把默认 mode 解析为 `"adaptive"`；显式 `auto`/`on`/`off`/`adaptive` 一律尊重。把默认改回去 = 把该 flag 的默认值改成 `false`（一行）。flag 为 `false` 时 `auto`/`on`/`off` 三档行为与现状**逐字节一致**（flag 只决定默认 mode 的解析与 adaptive service 是否被咨询）   | §7.1–§7.4、§12 T11  |

---

## 0. 背景、目标与成本模型

### 0.1 用户诉求

> 「检测到可能超过 5 分钟后，自动将缓存模式切换到 1h；后续如果是连续请求（小于 5min），
> 再将缓存模式切换回来。」

落到已有代码里就是：核心判定发生在 `before_provider_request`（`src/cache-ttl/cache-ttl.ts:263`，
我们已经在那里改写 payload）——**长时域信号存在 ⇒ 本次写入带 `ttl:"1h"`；密集交互 ⇒ 不带 ttl
（provider 默认 5m）**。「切回来」不需要显式动作：每次请求独立判定，不升级即 passthrough。

### 0.2 两套机制互补，不是二选一（已确认事实，直接引用）

| 场景                                       | 请求时序                                      | 1h 预测能否生效                     |
| ------------------------------------------ | --------------------------------------------- | ----------------------------------- |
| **后台派单**（本仓库 dev-flow 的默认做法） | 派完后主会话紧接着还有请求                    | ✓ 那次写 1h，覆盖随后空档           |
| **前台阻塞派单**                           | 请求 N 带出工具调用 → 阻塞数十分钟 → 请求 N+1 | ✗ 请求 N 发出时尚未武装（时序陷阱） |

前台阻塞只能靠 ping 覆盖（11 × 4min ≈ **44 分钟**上限，保活方案 §6.2）。分工与衔接见 §6。

本方案额外给出**第三条出路**覆盖时序陷阱：会话一旦**实测出现过**一次 > 5min 的请求间隔
（`history-gap` 信号 S4），后续所有**热请求**都带 1h——因为热请求的升级边际成本极低（§0.4），
用一个弱信号买覆盖是划算的。这条是本方案相对任务书描述的唯一增量设计，理由见 §3.3 S4。

### 0.3 计价与实测基准（**每处都标注基准**）

倍率（官方）：**5m 写 1.25×、1h 写 2.0×、cache read 0.1×**，基数 = 该模型的 base input 费率。

本会话实测标定（用户提供，直接引用）：

- 前缀 `P ≈ 410k` token。
- base input 费率反推：`$0.41 / 821k cache-read` ⇒ `0.41 / 0.821 = $0.499 /M @0.1×` ⇒
  **base ≈ $5.0 /M**。
- 由此：`0.1P = $0.205`（一次 ping）、`0.75P = $1.54`、`1.25P = $2.56`、`2.0P = $4.10`。

用户给出的对照表（**基准 = 同一空档下最终那次真实请求本来也要付的东西**，即保活方案 §0.3 的
情景 A/C/D 口径）：

| 空档                  | 持续 ping     | 写入时带 1h        |
| --------------------- | ------------- | ------------------ |
| 12 min（3 次 ping）   | $0.62         | $1.54              |
| 30 min（7.5 次）      | $1.54         | $1.54 ← **平衡点** |
| 44 min（11 次，上限） | $2.26         | $1.54              |
| 60 min                | ping 覆盖不到 | $1.54              |

**这一列「写入时带 1h = $1.54」的基准是「冷请求」**：缓存已死、这次请求反正要全量写，
`2.0P − 1.25P = 0.75P = $1.54`。这不是 `2P`（`2P` 是「凭空把一个已有条目转成 1h」的口径，
保活评审 M1 抓的就是这个混用）。

### 0.4 关键新发现：热请求上的 1h 升级只按**增量**计费（改变了整个方案的重心）

官方 prompt caching 文档「Mixing different TTLs」小节给出精确计费规则（已取证，见 §13 引用）：

> 约束：**更长 TTL 的断点必须排在更短 TTL 的断点之前**（1h 断点必须出现在任何 5m 断点之前）。
> 混用 TTL 时 API 确定三个计费位置：
>
> - `A`：**最高一次 cache hit** 处的 token 数（无命中则为 0）
> - `B`：`A` 之后**最高的 1h 断点**处的 token 数（无 1h 断点则 `B = A`）
> - `C`：**最后一个断点**处的 token 数
>   计费：`A` 按 cache read；`(B − A)` 按 **1h 写**；`(C − B)` 按 **5m 写**。

把它套到我们的改写上（`rewrite()` 是**全量**改写：payload 里每个 `cache_control.type ===
"ephemeral"` 都加 `ttl:"1h"`，因此 `B = C`，天然满足「长 TTL 在前」的排序约束——这也是**必须
保持全量改写、不许只改最后一个断点**的硬理由，见 §12 T3）：

- **基线（不改写，全 5m）**：`B' = A` ⇒ 费用 = `0.1·A + 1.25·(C − A)`
- **改写后（全 1h）**：`B = C` ⇒ 费用 = `0.1·A + 2.0·(C − A)`
- **边际差额（基准：同一次请求不改写时的费用）**

  > **ΔCost = 0.75 × (C − A) = 0.75 × Δ**，其中 **Δ = 本次请求相对「最高命中点」新增的 token 数**

两种极端：

| 请求类型                   | `A`        | `Δ = C − A`    | 边际成本（基准：同请求不改写） | P=410k 实例       |
| -------------------------- | ---------- | -------------- | ------------------------------ | ----------------- |
| **冷**（缓存已死，无命中） | 0          | 整段前缀 `P`   | `0.75 × P`                     | **$1.54**         |
| **热**（缓存命中）         | 已缓存前缀 | 本轮新增 token | `0.75 × Δ`                     | Δ=16k ⇒ **$0.06** |

**三条推论，全方案的骨架由它们决定：**

1. **热升级极其便宜**：Δ 通常是「一条用户消息 + 若干 tool_result + 上一条 assistant 消息」，
   典型 2k–30k token。`0.75 × 16k × $5/M = $0.06`，**比一次 ping（$0.205，基准同为「本来不会
   发生的额外支出」）还便宜 3 倍，却直接买下一小时覆盖**。⇒ 热路径是主战场，可以用较宽的信号。
2. **冷升级仍然昂贵**（$1.54），且误判无法挽回 ⇒ 冷路径必须窄、必须限次、必须有冷却。
3. **降级是自动的、优雅的**：写过一次 1h 条目（位置 `B`）后，后续密集请求在其上追加 5m 增量
   写。一次长空档后 5m 条目死掉、1h 条目还在 ⇒ 下一次请求 `A = B`，只需重写 `C − B` 这一小段。
   **所以「切回来」真的不需要任何动作**，只需要保证「未被 1h 覆盖的尾巴」别涨太大（§3.4 的
   `refreshAfterTokens` 节流即为此）。

**风险对冲**：推论 1 是**从官方计费规则推导**出来的，尚未在本仓库的真实路由
（`cloudrouter-anthropic/claude-opus-5`，中间还隔着一层代理）上实测。方案**不假设它为真**：
第一次升级被当作**探针**，从 pi 官方 usage 账本读回实际 `cacheWrite`，若热升级真的引发了整段
前缀重写（`cacheWrite` 占比过高）⇒ 立即熔断整会话的 adaptive 升级（§4.2）。这把一个「文档
理解可能有误」的风险转成了**一次、可测量、有上界**的支出。

### 0.5 成本不对称 ⇒ 预测器必须单独定义

- 误判一次 ping ≈ **$0.205**（基准：本来不必发生的额外 read）。
- 误判一次**冷**升级 ≈ **$1.54**（基准：同一次冷写请求不带 ttl 时的 1.25P）——7.5 倍。
- 误判一次**热**升级 ≈ **$0.06**（同上基准，Δ=16k）——0.3 倍。

现有武装信号 `src/service/cache-keepalive.ts:231` 的
`backgroundBusy() || activeTools > 0 || uiPrompts > 0` **绝不可直接复用**：`activeTools` 由
`tool_execution_start/end` 计数、**对工具类型完全不挑**（一次 200ms 的 `read` 也 +1），在正常
对话里几乎恒为真 ⇒ 等价于「永远升级」。对热路径它只是「无信息量」（每轮白付 0.75Δ），对冷路径
它是「每轮白付 $1.54」，绝对不可接受。详见 §3.3 的排除论证。

### 0.6 非目标

- 不做 tokenizer；Δ 只用 pi 官方账本的**实测值**做代理（§3.4）。
- 不改 `auto` / `on` / `off` 三档的任何现有语义。
- ~~不改默认 `cacheTtl.mode`~~ **（用户已裁决：默认启用，经 `cacheTtl.adaptiveEnabled` 单开关实现，
  显式 mode 永远优先；§7.1/§7.4）**。
- 不给已经是 1h 的 payload 做任何事（`already-1h` 直接放行）。
- 不做配额感知（沿用保活方案 §15 R7 的用户裁决）。
- 不在子会话启用（HOST_KEY 守卫天然排除）。

---

## 1. 术语与不变量

| 术语                  | 含义                                                                                        |
| --------------------- | ------------------------------------------------------------------------------------------- |
| **热请求（warm）**    | 本次请求**实测**命中缓存：上一条 assistant usage `cacheRead > 0` 且距上次请求 < 5min − 边际 |
| **冷请求（cold）**    | 非热请求（缓存推定已死 / 无账本可读 / 会话首个请求）                                        |
| **Δ（delta）**        | `C − A`，本次相对最高命中点新增的 token 数；决策时用上一条 assistant 的 `cacheWrite` 作代理 |
| **升级（upgrade）**   | 本次 `before_provider_request` 把全部 ephemeral 断点改写成 `ttl:"1h"`                       |
| **探针（probe）**     | 会话内第一次升级；其账本回读结果决定是否允许第二次                                          |
| **回读（reconcile）** | `message_end`/`turn_end` 后从 session entries 读该次请求的真实 usage                        |

**不变量（改代码必须保住）**

- **I-A1（只加不减）**：adaptive 只会**添加** `ttl:"1h"`，**永不删除**任何已存在的 ttl。
  不升级时走 passthrough（完全不改写 payload），语义与 `auto` 完全一致。
- **I-A2（全量改写）**：升级时必须改写 payload 里**每一个** ephemeral 断点（复用现有
  `rewrite()`）。部分改写会违反官方「长 TTL 必须在短 TTL 之前」的排序约束（§0.4）。
- **I-A3（显式选择才有权改写）**：`adaptive` 本身是用户的显式选择，因此它有权写 ttl；但它
  **不得**改写 `mode` 设置、不得持久化任何东西、不得在 `auto`/`on`/`off` 三档下产生任何行为
  变化（I-K5 在 adaptive 下的解释，见 §2.3）。
- **I-A4（能力门）**：`model.compat?.supportsLongCacheRetention === false` ⇒ **一律不升级**
  （pi 语义是「未设置即 true」，见 §5.4）。
- **I-A5（实测优先）**：所有成本判据都以 pi 官方 usage 账本的**实测值**为准，不用估算；账本
  读不到 ⇒ 按最保守分支处理（视为冷 / 拒绝升级）。
- **I-A6（有界支出）**：每会话升级引发的**实测** `cacheWrite` 总量受硬预算约束；预算耗尽 ⇒
  本会话不再升级。上界证明见 §4.4。
- **I-A7（身份守卫）**：adaptive service 复用保活的四重 `accept()`（disposed / sessionId /
  instanceId / `isCurrent`），跨会话与跨实例调用一律静默丢弃并计数。
- **I-A8（零定时器）**：adaptive service **不持有任何定时器**，纯事件驱动。
- **I-A9（不与 §6.3 重复升级）**：`consumeUpgrade`（保活 §6.3）只在 `mode === "auto"` 生效；
  adaptive 档下**不得**调用它。两条路径互斥，见 §6.2。

---

## 2. mode 语义与命名（问题 1）

### 2.1 四档语义表

| mode           | 对 payload 的动作                                          | 保活 ping                  | §6.3 预算耗尽升级              | 说明     |
| -------------- | ---------------------------------------------------------- | -------------------------- | ------------------------------ | -------- |
| `auto`         | **透传**（跟随 pi / `PI_CACHE_RETENTION`）                 | 工作                       | **生效**                       | 现状不变 |
| `on`           | 每个断点强制 `ttl:"1h"`                                    | 休眠(#7)                   | 无意义（已 1h）                | 现状不变 |
| `off`          | 删除每个断点的 `ttl`（显式 5m）                            | 工作                       | 不生效                         | 现状不变 |
| **`adaptive`** | **逐请求判定**：升级 ⇒ 同 `on`；不升级 ⇒ 同 `auto`（透传） | 工作，且升级后自动休眠(#7) | **不生效**（被 adaptive 取代） | 新增     |

**命名取舍**：

- 选 `adaptive` 作为 `cacheTtl.mode` 的第 4 个枚举值。
- **被否决 A**：新增独立布尔 `cacheTtl.adaptive`，与 `mode` 正交。否决理由：需要额外定义它与
  `on`/`off` 的 6 种组合语义（`on + adaptive` 是什么？），而实际语义是互斥的；四档枚举与用户
  心智（「缓存模式」）一一对应。
- **被否决 B**：改造 `auto` 使其自带自适应。否决理由：`auto` 已有明确的「透传、跟随
  `PI_CACHE_RETENTION`」语义且是当前默认值，改它等于**在不通知的情况下改变所有现有用户的
  计费行为**，违反「默认不改变现有用户 `cacheTtl.mode`」的要求。
- **被否决 C**：叫 `smart` / `dynamic`。否决理由：`adaptive` 与 pi 生态里
  `forceAdaptiveThinking` 的用词一致，且直译「自适应」无歧义。

### 2.2 `adaptive` 与 `auto` 的关系（不要混淆）

`auto` = **透传**：我们完全不碰 payload，pi 自己按 `resolveCacheRetention(options, env)`
（`PI_CACHE_RETENTION=long` ⇒ 1h）决定。
`adaptive` = **透传 + 条件加写**：不升级时逐字节等同于 `auto`；升级时在 `auto` 的结果上**追加**
`ttl:"1h"`。

因此：用户若已经设了 `PI_CACHE_RETENTION=long`，pi 会自己写 1h，adaptive 的 `already-1h` 门
（G-E）直接放行，不做任何事、不计任何预算。二者不会打架。

### 2.3 I-K5（不篡改用户显式设置）在 adaptive 下的边界

I-K5 原文约束的是「保活不得越过用户显式选择的 `on`/`off` 去改 ttl」。在 adaptive 下：

- **有权改**：选择 `adaptive` 这个行为本身，就是用户授权「由扩展逐请求决定 ttl」。
- **无权改**（硬边界，全部写进 I-A1/I-A3）：
  1. 不得**删除**任何 ttl（含 pi 自己写的 1h）——只加不减。
  2. 不得修改 `cacheTtl.mode` 本身、不得写设置文件、不得改 `PI_CACHE_RETENTION`。
  3. 不得在 `supportsLongCacheRetention === false` 的模型/路由上写 1h（写了也被上游丢弃，
     只会污染指纹与账本）。
  4. 不得在非 `anthropic-messages` API 上改写（其它 API 没有 `cache_control` 语义）。
  5. 熔断后**永久**退回 passthrough，直到会话结束（不因新请求自愈）。

---

## 3. 预测器（问题 2）

### 3.1 判定发生的位置与顺序

在 `src/cache-ttl/cache-ttl.ts` 的 `before_provider_request`（当前 `:263`）内，顺序固定为：

```
1. port?.syncModeState(mode, dirty)                       // 现状保留
2. sessionId = readSessionId(ctx)
3. pendingCapture = undefined                             // 现状保留（配对槽清理）
4. payload 形状校验（isObjectRecord + messages 数组）      // 现状保留
5. ledger = readLatestAssistantUsage(ctx)                 // 新：一次读取，两处复用
6. mode === "adaptive" 时：
     shape    = inspectPayload(event.payload)             // 只读遍历，不克隆
     decision = adaptive.decide(sessionId, adaptive.instanceId, { shape, ledger, now })
7. upgrade = decision?.upgrade === true
           || (mode === "auto" && port.consumeUpgrade(...))   // I-A9：两者互斥
8. action  = upgrade ? "force-1h"
           : mode === "on"  ? "force-1h"
           : mode === "off" ? "strip-ttl"
           : "passthrough"                                 // auto / adaptive-未升级
9. 克隆 → action !== "passthrough" 时 rewrite(clone, action) → captureRequest(clone, …, prefix←ledger)
10. adaptive.noteDecision(sessionId, instanceId, decision)  // 记录 pending 探针 / 计数 / 间隔
```

> 注意第 9 步的既有顺序（先改写、后 `inspectPayload` 捕获）必须保持：`captureRequest` 里的
> `inspectPayload(cloned)` 反映的是**真正发出去的字节**，这正是保活门 #7 能感知到「本次写了
> 1h」的根本原因（§6.1）。

### 3.2 信号来源（全部有 file:line 取证）

| 记号    | 信号                | 取值来源                                                                                                                 | 强/弱 |
| ------- | ------------------- | ------------------------------------------------------------------------------------------------------------------------ | ----- |
| **S1**  | 非终态 subagent run | `query.list().filter(s => ["queued","starting","running","stopping"].includes(s.status))`（同 `src/stack.ts:1089-1091`） | 强    |
| **S1h** | subagent 剩余时域   | `max(run.deadlines.hardDeadlineAt ?? run.deadlines.deadlineAt) − now`（`src/core/types.ts:78-91`）                       | 修饰  |
| **S2**  | 后台 bash job       | `bashJobs?.backgroundJobCount() ?? 0`（`src/bash/manager.ts:226`）                                                       | 强    |
| **S3**  | 阻塞式 UI 闸门      | `ui_prompt_start/end` 计数（与 `src/cache-ttl/cache-ttl.ts:194-201` 同源事件，转发一份给 adaptive）                      | 强    |
| **S4**  | 本会话历史长空档    | 请求间隔环形缓冲（最近 20 个）里 `> ASSUMED_TTL_MS` 的个数 ≥ 1                                                           | 弱    |
| —       | `activeTools`       | `tool_execution_start/end` 计数——**只进审计与状态栏，不进判定**                                                          | 排除  |

`AdaptiveSignals` 由 stack 在构造 service 时以闭包形式注入（与 `backgroundBusy` 同款，
`src/stack.ts:1089`），service 自己只维护 `uiPrompts` / `activeTools` 两个计数器。

### 3.3 为什么排除 `activeTools`，为什么这三个「强信号」够窄

**排除 `activeTools` 的三条理由**（任一独立成立）：

1. **无信息量**：`tool_execution_start` 对工具类型完全不挑。一次 200ms 的 `read`、一次
   `TaskUpdate`、一次 `memory` 写都 +1。在正常 agent 循环里几乎每个 `before_provider_request`
   之前都刚结束/正在进行工具调用 ⇒ 判据恒真 ⇒ 等价于「无条件升级」，预测器退化为 `on`。
2. **冷路径致命**：恒真判据落到冷分支上 = 每次长空档后的首个请求白付 `0.75P = $1.54`（基准：
   同一冷写请求不带 ttl 的 1.25P）。
3. **有更好的替代**：真正「会阻塞很久」的工具，其阻塞形态已经被 S1（subagent 有独立 run 与
   deadline）、S2（bash 自动后台化）、S3（人类闸门）三条**类型化**信号精确捕获；`activeTools`
   只是它们的超集噪声。

**三个强信号的窄性论证**：

- **S1（非终态 subagent run）**：subagent 是**分钟到小时量级**的工作单元（独立会话、独立模型
  调用、独立 watchdog 预算）。run registry 还提供 `deadlines`，可以对冷路径追加
  「剩余时域 ≥ `coldMinHorizonMs`」的量化门（S1h）。误判形态是「subagent 秒级返回」——只在
  `Agent` 工具被用来跑极短任务时出现，属可接受的少数派。
- **S2（后台 bash job）**：默认 `bashJobs.autoBackgroundMs = 290_000`（`src/config/settings.ts:309`，
  ≈ **4 分 50 秒**）。也就是说，一个被**自动**后台化的 job 已经跑了将近 5 分钟——它的存在本身
  就是「这条命令是长任务」的事后证据。显式 `background: true` 的 job 也是调用方主动声明的长任务。
  这是三条信号里判据最硬的一条。
- **S3（阻塞式 UI 闸门）**：`ask_user` 等待人类输入，响应时间无上界；用户离开工位 = 必然超 5min。

**S4（历史长空档，弱）的定位**：只用于**热**升级，永不用于冷升级。它专门解决 §0.2 的「前台
阻塞派单时序陷阱」：请求 N 发出时无信号，阻塞 40 分钟后请求 N+1 到来——此时 S4 记下了这个
40min 空档，于是从请求 N+2 起（只要它是热请求）都带 1h，下一次同样的阻塞就被覆盖。
因为热升级的边际成本是 `0.75 × Δ ≈ $0.06`（基准见 §0.4），用一个「这个会话有长空档习惯」的
弱证据买覆盖，期望值明显为正。S4 可用 `cacheTtl.adaptiveHistoryGapSignal` 关掉（默认 true）。

### 3.4 冷/热判定与 Δ 代理（全部用实测账本，I-A5；M1 修订：账本锚定）

```
ledger = readLatestAssistantUsage(ctx)      // 最近一条 assistant message 的 usage（带锚定字段）
账本新鲜 ⇔ ledger.source === "usage"
         && ledger.entrySeq > state.lastInvalidateSeq      // M1：不是 compact/换模型等失效事件之前的旧账本
         && ledger.modelId === ctx.model.id                // M1：与当前模型同源（assistant entry 自带 model 字段）
warm  ⇔ 账本新鲜
     && ledger.cacheRead > 0                                        // 实测：上一次确实命中
     && state.lastRequestStartedAt !== undefined
     && now − state.lastRequestStartedAt < ASSUMED_TTL_MS − TTL_SAFETY_MARGIN_MS   // 300s − 45s
Δ̂（预测增量）= ledger.cacheWrite                                     // 上一次实际写了多少增量
```

**M1（评审第二轮）背景**：pi 的 compaction 是**追加** compaction entry、不删历史
（`dist/core/compaction/compaction.js:46-52` 对 `type === "compaction"` 返回 `undefined`，旧
assistant entries 仍在 `getEntries()` 里），裸的反向扫描会读到 compact **前**的账本
（cacheRead>0、cacheWrite 很小）⇒ 误判热 ⇒ 真实前缀其实是全新的 ⇒ 热探针把「合法的前缀变更」
误读成「推论 1 不成立」⇒ **会话级永久熔断**。锚定后：compact/换模型会触发 `invalidateAdaptive`
（§9.4）抬高 `lastInvalidateSeq`，其后的首个请求账本必不新鲜 ⇒ 判**冷** ⇒ 走冷分支（强信号下
仍可升级一次，语义本来如此）且**不经过热探针**，不再误熔断。`entrySeq`/`modelId` 读不到时
（`source: "unknown"` / 空串）一律视为不新鲜——`readLatestAssistantUsage` 保持绝不抛异常、
降级到 `source: "unknown"` 的既有防御行为。

`ledger.cacheWrite` 是「上一次请求写入的增量」，用作「这一次大概会写多少增量」的代理：在稳定的
对话循环里两者同量级；在刚 compact 完 / 刚换模型 / 刚加载大量 tool_result 之后它会很大——
而那恰恰是我们**应该**拒绝热升级的时刻（`delta-too-large`）。这是「宁可漏升级、不可误升级」
的保守方向，符合 I-A5。

### 3.5 完整判定规则（伪代码，`src/cache-ttl/adaptive.ts` 纯函数）

```ts
export function decideAdaptiveTtl(input: AdaptiveDecideInput): AdaptiveDecision {
  const { now, mode, api, provider, supportsLongCacheRetention, shape, signals, ledger, config, state } = input;
  const no = (reason: AdaptiveDeclineReason): AdaptiveDecision => ({ upgrade: false, reason, at: now });

  // ── A 组：能力门（与判定信号无关，任何一条不过 ⇒ 永不升级）──────────────
  if (mode !== "adaptive") return no("mode"); // G-A 防御
  if (api !== ANTHROPIC_MESSAGES_API) return no("not-anthropic"); // G-B
  if (PING_DENY_PROVIDERS.has(provider)) return no("not-anthropic"); // G-B'（copilot 按次计费）
  if (!supportsLongCacheRetention) return no("no-1h-support"); // G-C / I-A4
  if (shape.ephemeralBreakpoints === 0) return no("no-cache-control"); // G-D（根本没开缓存）
  if (shape.ttl1h) return no("already-1h"); // G-E（pi 已写 1h）
  if (state.breaker !== undefined) return no("breaker"); // G-F（§4.2）
  if (state.upgradeWriteTokens >= config.writeBudgetTokens) return no("write-budget"); // G-G / I-A6

  // ── B 组：时域信号 ───────────────────────────────────────────────────
  const strong: AdaptiveSignalKind[] = [];
  if (signals.subagentRuns > 0) strong.push("subagent");
  if (signals.backgroundBashJobs > 0) strong.push("bash-job");
  if (signals.uiPrompts > 0) strong.push("ui-gate");
  const weak = config.historyGapSignal && state.longGapCount >= 1 ? (["history-gap"] as const) : [];
  if (strong.length === 0 && weak.length === 0) return no("no-signal");

  // ── C 组：冷热分流（M1：账本必须先过新鲜度锚定）─────────────────────────
  const ledgerFresh =
    ledger.source === "usage" &&
    ledger.entrySeq > state.lastInvalidateSeq &&
    ledger.modelId !== "" &&
    ledger.modelId === modelId; // modelId = ctx.model.id，由调用方读入
  const warm =
    ledgerFresh &&
    ledger.cacheRead > 0 &&
    state.lastRequestStartedAt !== undefined &&
    now - state.lastRequestStartedAt < ASSUMED_TTL_MS - TTL_SAFETY_MARGIN_MS;

  if (warm) {
    // 热：边际 0.75 × Δ（基准：同请求不改写）。信号宽（强弱皆可），但要控 Δ 与刷新频率。
    if (ledger.cacheWrite > config.maxDeltaTokens) return no("delta-too-large");
    const episodeJustArmed = strong.length > 0 && !state.armedEpisode; // 信号刚打开：必升
    // 节流只约束「上一次升级之后」的重复购买；本会话还没升级过时不受节流（否则 S4-only 永远无法首开）。
    if (
      state.lastUpgradeAt !== undefined &&
      !episodeJustArmed &&
      state.tokensSinceLast1hWrite < config.refreshAfterTokens
    )
      return no("refresh-throttled");
    return {
      upgrade: true,
      class: "warm",
      signals: [...strong, ...weak],
      predictedDeltaTokens: ledger.cacheWrite,
      at: now,
    };
  }

  // 冷：边际 0.75 × P（$1.54）。只认强信号 + 量化时域 + 限次 + 冷却。
  if (strong.length === 0) return no("cold-signal-too-weak");
  const horizonOk =
    signals.backgroundBashJobs > 0 || // 熬过一个冷窗口的 bash job 必是长任务
    signals.uiPrompts > 0 || // 熬过一个冷窗口的人类闸门必是 AFK
    (signals.subagentRuns > 0 &&
      (signals.maxSubagentHorizonMs === undefined || signals.maxSubagentHorizonMs >= config.coldMinHorizonMs));
  if (!horizonOk) return no("cold-signal-too-weak");
  if (state.coldUpgrades >= config.coldUpgrades) return no("cold-budget");
  if (state.lastColdUpgradeAt !== undefined && now - state.lastColdUpgradeAt < config.coldCooldownMs)
    return no("cold-cooldown");
  return {
    upgrade: true,
    class: "cold",
    signals: strong,
    predictedDeltaTokens: ledger.source === "usage" ? ledger.cacheRead + ledger.cacheWrite : 0,
    at: now,
  };
}
```

`ASSUMED_TTL_MS` / `TTL_SAFETY_MARGIN_MS` / `ANTHROPIC_MESSAGES_API` / `PING_DENY_PROVIDERS`
从 `./keepalive-state.js` **值导入**；`keepalive-state.ts` 反过来只**类型导入**
`AdaptiveSnapshot`（type-only 在运行时被擦除 ⇒ 无 ESM 运行时环，已在两侧注释说明）。

### 3.6 真值表（任务要求的五类 + 冷热两态 + 边角）

`config` 取默认值：`maxDeltaTokens=32_000`、`refreshAfterTokens=16_000`、`coldMinHorizonMs=600_000`、
`coldUpgrades=1`、`coldCooldownMs=1_200_000`、`writeBudgetTokens=200_000`。

| #   | 场景                                | S1  | S1h | S2  | S3  | S4  | activeTools | 冷/热 | Δ̂    | 判定                                      | 边际成本（基准：同请求不改写） |
| --- | ----------------------------------- | --- | --- | --- | --- | --- | ----------- | ----- | ---- | ----------------------------------------- | ------------------------------ |
| 1   | 刚派了后台 subagent（紧接着发请求） | 1   | 30m | 0   | 0   | 否  | 3           | 热    | 8k   | **升级 warm**                             | 0.75×8k ≈ $0.03                |
| 2   | 同上，但这次请求在 40min 后         | 1   | 30m | 0   | 0   | 是  | 0           | 冷    | —    | **升级 cold**                             | 0.75×P = $1.54                 |
| 3   | 同上，subagent 剩余时域只有 3min    | 1   | 3m  | 0   | 0   | 是  | 0           | 冷    | —    | 拒绝 `cold-signal-too-weak`               | 0                              |
| 4   | 后台 bash job 跑着                  | 0   | —   | 2   | 0   | 否  | 1           | 热    | 5k   | **升级 warm**                             | ≈ $0.02                        |
| 5   | 后台 bash job 跑着，请求在 20min 后 | 0   | —   | 1   | 0   | 是  | 0           | 冷    | —    | **升级 cold**                             | $1.54                          |
| 6   | UI 闸门挂着（ask_user 等待）        | 0   | —   | 0   | 1   | 否  | 1           | 热    | 2k   | **升级 warm**                             | ≈ $0.01                        |
| 7   | **只有快工具在跑**                  | 0   | —   | 0   | 0   | 否  | 4           | 热    | 6k   | **拒绝** `no-signal`                      | 0                              |
| 8   | **什么都没有**                      | 0   | —   | 0   | 0   | 否  | 0           | 热    | 3k   | **拒绝** `no-signal`                      | 0                              |
| 9   | 什么都没有，但会话有过长空档        | 0   | —   | 0   | 0   | 是  | 0           | 热    | 3k   | **升级 warm**（S4 弱信号）                | ≈ $0.01                        |
| 10  | 同 #9 但是冷请求                    | 0   | —   | 0   | 0   | 是  | 0           | 冷    | —    | 拒绝 `cold-signal-too-weak`               | 0                              |
| 11  | 刚 compact 完，subagent 在跑        | 1   | 30m | 0   | 0   | 否  | 0           | 热    | 120k | 拒绝 `delta-too-large`                    | 0                              |
| 12  | subagent 在跑，上次刚升级过         | 1   | 30m | 0   | 0   | 否  | 2           | 热    | 4k   | 拒绝 `refresh-throttled`（累计 4k < 16k） | 0                              |
| 13  | subagent 在跑，自上次升级已累计 20k | 1   | 30m | 0   | 0   | 否  | 2           | 热    | 6k   | **升级 warm**（刷新尾巴）                 | ≈ $0.02                        |
| 14  | `supportsLongCacheRetention:false`  | 1   | 30m | 3   | 1   | 是  | 5           | 热    | 5k   | 拒绝 `no-1h-support`                      | 0                              |
| 15  | pi 已写 1h（`PI_CACHE_RETENTION`）  | 1   | 30m | 0   | 0   | 是  | 0           | 热    | 5k   | 拒绝 `already-1h`                         | 0                              |
| 16  | 会话首个请求（无账本）+ subagent    | 1   | 30m | 0   | 0   | 否  | 0           | 冷    | —    | **升级 cold**（首次，预算内）             | $1.54                          |
| 17  | 第二次冷升级（15min 后）            | 1   | 30m | 0   | 0   | 是  | 0           | 冷    | —    | 拒绝 `cold-budget`（已用 1/1）            | 0                              |
| 18  | 探针判定为「热升级也全量重写」      | 1   | 30m | 0   | 0   | 是  | 0           | 热    | 5k   | 拒绝 `breaker`                            | 0                              |

> #12 与 #13 的 `armedEpisode`：`state.armedEpisode` 在「上一次决策时 strong.length > 0」为真，
> 在 `agent_settled` 且所有强信号归零时清零。「信号刚打开」的首次升级绕过节流，保证派单后
> **立刻**拿到 1h 覆盖（这正是 #1 的主场景）。

---

## 4. 误判成本上界与回退（问题 3）

### 4.1 三类误判及其自我纠正

| 误判                                     | 后果（基准）                                                                                                 | 自我纠正机制                                                                                                   |
| ---------------------------------------- | ------------------------------------------------------------------------------------------------------------ | -------------------------------------------------------------------------------------------------------------- |
| **E1 热升级后其实是密集交互**            | 多付 `0.75 × Δ`（基准：同请求不改写），≈$0.06                                                                | **不需要纠正**——1h 条目只是白买保险，后续请求照常在其上写 5m 增量；`refreshAfterTokens` 节流保证不会每轮重复买 |
| **E2 冷升级后其实是密集交互**            | 多付 `0.75 × P`（同基准），$1.54                                                                             | `coldUpgrades`（默认 1）+ `coldCooldownMs`（20min）+ 统一 token 预算；且冷升级要求强信号 + 量化时域            |
| **E3 上游忽略了 `ttl:"1h"`**（代理吞掉） | 保活门 #7 已经停了 ping，缓存 5min 后死掉，下次请求全量重写 `1.25P = $2.56`（基准：ping 本可覆盖的理想情况） | §4.3 的「1h 失效探测」——一次即熔断                                                                             |

### 4.2 探针与熔断（`AdaptiveBreakerReason`；M2 修订：复合判据；m2 修订：幂等水印）

每次升级都在 `state.pending` 里记一条 `{ at, class, predictedDeltaTokens, minEntrySeq }`；
`message_end` / `turn_end` / `agent_end` 时 `reconcile()` 读回该次请求的真实 usage，执行：

```ts
// m2 幂等水印：同一账本被三个事件重复触发只计一次（一切副作用都过这道闸）
if (ledger.source !== "usage" || ledger.entrySeq <= state.lastReconciledEntrySeq) return state;
state.lastReconciledEntrySeq = ledger.entrySeq;

state.upgradeWriteTokens += ledger.cacheWrite; // I-A6 预算记账（实测，不是估算）
if (ledger.cacheWrite1h !== undefined && ledger.cacheWrite1h > 0) state.confirmed1hWrites += 1;
else state.unconfirmed1hWrites += 1; // 见 §5.3：0 不等于没生效

// M2 复合判据：绝对写入超「预测增量的 3 倍」且超 64k 下限才熔断。
// 旧 ratio 判据（writeRatio > 25% ⇔ Δ > A/3）对 A < 96k 的小前缀会话一次顶格 32k 合法增量即假阳性，已退役。
if (pending.class === "warm" && ledger.cacheWrite > Math.max(3 * pending.predictedDeltaTokens, 64_000))
  trip("warm-write-too-expensive"); // §0.4 推论 1 在这条路由上不成立 ⇒ 立即停手
if (pending.class === "warm" && ledger.cacheRead === 0) trip("warm-miss"); // 我们判为热，实际 miss ⇒ 冷热判据在这条路由上不可靠
if (state.upgradeWriteTokens >= config.writeBudgetTokens) trip("write-budget");
```

- 复合判据仍**与是否能读到 `cache_creation` 拆分无关**（只用 `cacheRead`/`cacheWrite` 两个所有
  路由都报的字段），对代理吞掉 `cache_creation` 的场景也成立——这是本设计最关键的鲁棒性点，
  M2 修订后保持不变。
- 64k 下限的取舍：一次部分命中的 compact 后重写合法可达 50k+，下限若定在 48k 会把「单次大重写」
  误当路由级违例；64k 仍远低于任何 0.75P 级全量冷写，检测力保留。两个常量写死（
  `ADAPTIVE_PROBE_WRITE_FACTOR = 3` / `ADAPTIVE_PROBE_WRITE_FLOOR_TOKENS = 64_000`），不做设置项。
- 熔断是**会话级、永久**的（不因新请求自愈），与保活的 I-K7 同构。
- 熔断时打一条 `console.warn`（与保活「仅会话级停用才打 warn」的噪音策略一致）+ 审计条目 +
  状态栏可见。

### 4.3 E3「1h 失效」探测（不改保活状态机）

adaptive 维护 `oneHourCoverUntil = 最近一次升级时刻 + 3_600_000`。在 `reconcile()` 里：

```ts
if (
  state.oneHourCoverUntil !== undefined &&
  now < state.oneHourCoverUntil &&
  gapBeforeThisRequest > ASSUMED_TTL_MS && // 这次是冷请求
  ledger.cacheRead === 0
) {
  // 却完全没命中
  state.ineffective1h += 1;
  trip("1h-ineffective"); // 一次即熔断
}
```

含义：我们写过 1h、理论上一小时内的空档都该命中，结果一次 >5min 的空档后**完全没命中** ⇒
上游根本没接受 `ttl:"1h"`。熔断后本会话退回 passthrough，保活 ping 因为 `capture.shape.ttl1h`
不再为真而**自动恢复工作**（门 #7 放行）——这就是 E3 的完整回退路径，代价上界 = 一次
`1.25P = $2.56`（基准：ping 本可覆盖的理想情况）。

**为什么不改保活门 #7**（被否决方案，§12 T4）：把 `capture.shape.ttl1h` 换成
`ttl1hConfirmed` 三态需要动 `WindowState` / `evaluateTick` / `onRealRequest` 等已验证的核心，
而收益只是把 E3 的上界从「一次 2.56」降到「一个窗口内的 ping 继续跑」。用一次性探测 + 熔断
换取「不动已验证核心」，赔率更好。

### 4.4 每会话额外支出上界（**可证明**）

设 `R` = base input 费率（$/token），`P` = 会话最大前缀 token 数，`W` =
`adaptiveWriteBudgetTokens`（默认 200_000）。

| 项               | 上界推导                                                                      | 基准                          | P=410k, R=$5/M 实例 |
| ---------------- | ----------------------------------------------------------------------------- | ----------------------------- | ------------------- |
| **升级边际支出** | 预算在**每次升级前**检查，故最多超出一次完整前缀：`0.75 × (W + P) × R`        | 同一批请求不改写时的费用      | **$2.29**           |
| **E3 失效探测**  | 一次全量重写：`1.25 × P × R`（只在上游忽略 ttl 的病态路由上发生，一次即熔断） | ping 本可覆盖该空档的理想情况 | **$2.56**           |
| **合计（最坏）** | `0.75 × (W + P) × R + 1.25 × P × R`                                           | —                             | **$4.85**           |

补充说明：

- **m1 修订（droppedPending 路径补洞）**：pending 被丢弃的两条路径——账本 120s 未至
  （§6.1a 的 `pendingTtlMs`）与 `invalidateAdaptive` 清 pending（§9.4）——都按该 pending 的
  `predictedDeltaTokens` **预记账**进 `upgradeWriteTokens` 并计 `droppedPending += 1`。
  预记账是保守高估（热 pending 的 Δ̂ ≤ `maxDeltaTokens` = 32k，冷 pending 的 Δ̂ ≈ P），方向安全。
  由此「预算在每次升级前检查 + 每次升级（含丢弃的）最多记账一次 ≤ P」⇒ Σ ≤ W + P 在**每条
  路径**上成立，上表的「可证明」不再有洞。
- 冷升级不需要单独计入——它消耗的 `cacheWrite ≈ P`，一次就吃掉 `W` 的两倍，因此 `coldUpgrades`
  默认 1 其实是被 `W` 二次约束的（先撞上哪个算哪个）。保留 `coldUpgrades` 是为了让「冷」这个
  高风险动作有一个语义明确、可单独关掉（设 0）的开关。
- **典型（非最坏）会话**：3–8 次热升级 × `0.75 × 8k × R ≈ $0.03` ⇒ **$0.1–0.25**，同时省掉
  原本要付的若干次 `1.25P = $2.56` 全量重写。
- `W` 可调；把 `W` 设 0 等价于关闭 adaptive 的升级（仍保留观测），可作为回滚手段。

---

## 5. 可观测性：我们能否确认一次 1h 写入真的生效了？（问题 4）

### 5.1 取证结论：**能，pi 保留了拆分字段**

任务书担心「pi 的 usage 映射可能把两种写入合并成 `cacheWrite`」——**取证后结论是没有合并**：

`node_modules/@earendil-works/pi-coding-agent/dist/bundle/chunks/anthropic-messages-JWX2WP65.js`
（`message_start` 分支，压缩一行内）：

```js
output.usage.cacheRead    = event.message.usage.cache_read_input_tokens || 0,
output.usage.cacheWrite   = event.message.usage.cache_creation_input_tokens || 0,
output.usage.cacheWrite1h = event.message.usage.cache_creation?.ephemeral_1h_input_tokens || 0,
```

三条独立佐证：

1. **类型**：`node_modules/@earendil-works/pi-ai/dist/types.d.ts:265-271`
   ```ts
   export interface Usage { input; output; cacheRead; cacheWrite;
     /** Subset of `cacheWrite` written with 1h retention. Only Anthropic reports this split. */
     cacheWrite1h?: number; … }
   ```
2. **计价**：`node_modules/@earendil-works/pi-ai/dist/models.js:537-543`
   ```js
   const longWrite = usage.cacheWrite1h ?? 0;
   const shortWrite = usage.cacheWrite - longWrite;
   usage.cost.cacheWrite = (rates.cacheWrite * shortWrite + rates.input * 2 * longWrite) / 1e6;
   ```
   ⇒ pi 自己就按 2× 给 1h 写入计价，`usage.cost.total` 会体现出来（HUD footer 读的就是
   `entry.message.usage.cost.total`，`src/hud/footer.ts:183`）。
3. **持久化**：`dist/core/compaction/compaction.js:54-60` 在合并 usage 时显式处理
   `cacheWrite1h`，证明它随 message entry 一起进 session 文件并被回读。

**结论**：`readLatestAssistantUsage(ctx).cacheWrite1h > 0` 是「这次请求确实产生了 1h 写入」的
**直接证据**。

### 5.2 但 `cacheWrite1h === 0` 不等于「没生效」

`ephemeral_1h_input_tokens` 来自 `usage.cache_creation` 这个**可选**子对象。经中间代理
（用户实际路由是 `cloudrouter-anthropic`）时，代理完全可能只透传
`cache_creation_input_tokens` 而丢掉 `cache_creation` 拆分对象 ⇒ `cacheWrite1h` 恒为 0。
因此判据必须是**三态**：

| 观测                                                    | 结论                                                    | 记账字段              |
| ------------------------------------------------------- | ------------------------------------------------------- | --------------------- |
| `cacheWrite1h > 0`                                      | **已确认 1h 写入**                                      | `confirmed1hWrites`   |
| `cacheWrite > 0 && cacheWrite1h === 0`                  | **无法确认**（代理丢字段 / 上游忽略 ttl，二者不可区分） | `unconfirmed1hWrites` |
| 后续 >5min 空档后仍 `cacheRead > 0`                     | **间接确认**（只有 1h 条目能活过 5min）                 | `indirect1hConfirms`  |
| 后续 >5min 空档后 `cacheRead === 0`（且在 1h 覆盖期内） | **确认失效** ⇒ 熔断                                     | `ineffective1h`       |

「间接反推」正是任务书预设的替代手段，这里把它做成**一等公民的审计字段**而不是事后人工分析：

```ts
// reconcile() 内，处理「本次是冷请求」的分支（m2：与所有副作用一样过 lastReconciledEntrySeq 水印）
if (state.oneHourCoverUntil !== undefined && now < state.oneHourCoverUntil && gapBeforeThisRequest > ASSUMED_TTL_MS) {
  if (ledger.cacheRead > 0)
    state.indirect1hConfirms += 1; // 活过了 5min ⇒ 1h 真的生效
  else {
    state.ineffective1h += 1;
    trip("1h-ineffective");
  } // §4.3
}
```

### 5.3 审计字段设计

审计条目 customType：**`subagent:cache-adaptive`**（与保活的 `subagent:cache-keepalive` 并列；
未注册 renderer ⇒ 不进 UI、不进上下文，只落 session 文件，先例
`src/compact-hint/threshold.ts` 的 `subagent:usage-tick`）。

两种 `kind`：

```ts
// kind: "decision" —— 每次 mode==="adaptive" 的 before_provider_request 都写一条
{ kind: "decision", at, upgrade: boolean, class?: "warm"|"cold",
  reason?: AdaptiveDeclineReason, signals: AdaptiveSignalKind[],
  signalCounts: { subagentRuns, backgroundBashJobs, uiPrompts, activeTools, maxSubagentHorizonMs },
  gapBeforeMs, predictedDeltaTokens, longGapCount,
  budget: { upgradeWriteTokens, writeBudgetTokens, coldUpgrades, coldUpgradeCap } }

// kind: "reconcile" —— 每次账本回读写一条（含未升级请求，用于 §5.2 的间接确认）
{ kind: "reconcile", at, pendingClass?: "warm"|"cold",
  cacheRead, cacheWrite, cacheWrite1h, writeRatioPercent, costTotalUsd,
  ttl1h: "confirmed"|"unconfirmed"|"indirect"|"ineffective"|"n/a",
  upgradeWriteTokens, breaker?: AdaptiveBreakerReason }
```

同时 `pi.events.emit("subagent:cache-adaptive", { kind, at })`（与保活的
`subagent:keepalive` 同款，供未来 HUD 段订阅）。

**HUD 回填结论沿用保活方案 §9.3**：带外 usage 不能回填 HUD；但本方案的升级发生在**真实请求**
上，其 usage **本来就在 HUD 账本里**（`usage.cost.total` 已含 2× 1h 写入）⇒ adaptive 的成本
天然可见，不存在保活那样的「花了钱 HUD 看不到」问题。这是 adaptive 相对 ping 的一个额外优点，
值得写进状态栏说明。

---

## 6. 与保活的衔接与 §6.3 的关系（问题 5）

### 6.1 门 #7（`skip("ttl-1h")`）的复用是否严密？

`src/cache-ttl/keepalive-state.ts:327-328`：

```ts
// #7 — G5
if (capture.shape.ttl1h) return skip("ttl-1h", true);
```

**严密，理由链完整：**

1. `capture.shape` 来自 `inspectPayload(cloned)`，而 `cloned` 是**改写之后**的对象
   （`src/cache-ttl/cache-ttl.ts:310-311`：先 `rewrite(cloned, effective, …)` 再
   `captureRequest(cloned, …)`）⇒ shape 反映**真正发出去的字节**，不是意图。
2. adaptive 升级走的是同一条 `rewrite(…, "force-1h")` 路径（I-A2 全量改写）⇒
   `analyzePayload` 里 `control.ttl === "1h"` 必为真 ⇒ `ttl1h === true`。
3. `skip(..., terminal: true)` ⇒ 本窗口不再 `arm()`，不会有任何 ping 花费。
4. 下一次真实请求 `onRealRequest` 重建窗口、重新捕获 shape ⇒ 若那一次没升级，ping 自动恢复。

**三个边角必须在测试里钉死（§11）：**

- **a. 1h 写入失败（HTTP 错误 / 请求没发出去）**：pi 的请求失败 ⇒ 不产生 assistant message ⇒
  账本没有新条目 ⇒ `reconcile()` 的 pending 会被**下一次** `reconcile` 用一条更新的账本消费。
  为避免「拿新请求的账本给老 pending 结账」，`pending` 必须带 `requestSeq`，且
  `reconcile()` 只在 `ledger.entrySeq`（用 `getEntries()` 里的下标作单调代理）**大于等于**
  pending 记录时的快照值（`minEntrySeq` = 决策时刻的 `entries.length`）时才结账；超过
  `pendingTtlMs = 120_000` 未结账的 pending 直接丢弃：按 m1 修订**预记账** `predictedDeltaTokens`
  进 `upgradeWriteTokens` 并计 `droppedPending += 1`（§4.4 上界在此路径上依然成立）。
  窗口这边由保活自己的 `invalidate`/`onRealRequest` 处理，不受影响。
- **b. 上游忽略 ttl**：§4.3 的 E3 探测，一次即熔断，ping 随之恢复。
- **c. adaptive 升级 + 保活同时开启**：升级窗口内 ping 被门 #7 关掉（省钱，正确）；未升级窗口
  ping 照常工作（覆盖前台阻塞场景）。**这就是两套机制的分工点**。

### 6.2 与 §6.3「预算耗尽升级」的关系：**并存但互斥，adaptive 档下取代它**

现状路径（`src/cache-ttl/cache-ttl.ts:275`）：

```ts
const upgrade = port !== undefined && mode === "auto" && port.consumeUpgrade(sessionId, port.instanceId);
```

- `mode === "auto"` 这个字面量守卫**天然排除** `"adaptive"`（新枚举值不等于 `"auto"`）⇒
  **不存在重复升级的可能**，这是类型层面的保证，不是约定。I-A9 只是把它写成不变量。
- 语义上：§6.3 的判据是「ping 预算耗尽 + 缓存推定已死」，**完全不看是否还有后台工作**；
  adaptive 的冷分支判据是「强信号 + 量化剩余时域 + 限次 + 冷却」，**严格更有信息量**。
  因此在 adaptive 档下让 §6.3 沉默是正确的：
  - 若 44 分钟后 subagent 仍在跑 ⇒ adaptive 冷分支 S1 会升级（且要求剩余时域 ≥ 10min）。
  - 若 44 分钟后工作已结束 ⇒ 不该升级，而 §6.3 会盲目升级（多付 $1.54）。
- `auto` 档下 §6.3 **保持原样**，不做任何改动。
- 状态栏的 `→1h` 提示（`renderPingSegment`，`keepalive-state.ts:846-870`）目前条件是
  `mode === "auto" && config.upgradeAfterBudget && supportsLongCacheRetention`——adaptive 档下
  这个提示会自动消失（因为 `mode !== "auto"`），改由 adaptive 自己的状态段表达（§8）。
  需要补一条注释说明这是有意为之。

### 6.3 分工总表

| 空档来源               | 请求时序             | 谁覆盖                                      | 成本（基准：不做任何事时的全量重写 1.25P） |
| ---------------------- | -------------------- | ------------------------------------------- | ------------------------------------------ |
| 后台派单（有后续请求） | 热请求 + 强信号      | **adaptive 热升级**                         | `0.75 × Δ` ≈ $0.03，省 $2.56               |
| 前台阻塞（首次）       | 无预警               | **保活 ping**（≤44min）                     | `0.1P × n` ≤ $2.26                         |
| 前台阻塞（复发）       | 热请求 + S4 历史信号 | **adaptive 热升级**（ping 随之休眠）        | `0.75 × Δ` ≈ $0.03                         |
| 超长空档（>1h）        | 任意                 | 谁都覆盖不到                                | 只能吃 1.25P                               |
| 冷请求 + 强信号        | 已经冷了但工作还在跑 | **adaptive 冷升级**（限 1 次 + 20min 冷却） | `0.75P` = $1.54（换一小时覆盖）            |

---

## 7. 设置项（问题 6）

### 7.1 复用/修改（默认值修订：adaptive 默认启用，见评审驱动修订表）

| 键                         | 改动                                                                                                                                                                                                             | 默认       |
| -------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------- |
| `cacheTtl.mode`            | 枚举新增 `"adaptive"`（`auto`/`on`/`off`/`adaptive`）                                                                                                                                                            | `auto`     |
| `cacheTtl.adaptiveEnabled` | **新增**：adaptive 总开关。`true`（默认）时，设置文件**未显式写 mode** ⇒ 解析为 `"adaptive"`；显式写的任何 mode 一律尊重。`false` ⇒ 默认回落 `auto` 且 adaptive service 不被咨询，`auto`/`on`/`off` 逐字节同现状 | **`true`** |

> 单开关语义：翻转默认值就是一行（`DEFAULT_SETTINGS.cacheTtl.adaptiveEnabled: true → false`）。
> 这与 §2.1「被否决 A」不冲突：被否决的是「与 `mode` 正交、需要定义 6 种组合语义」的独立布尔；
> 本 flag 只决定①默认 mode 的解析方向 ②mode 为 adaptive 时是否咨询 service，显式 mode 永远优先，
> 没有组合语义要定义。

### 7.2 新增 8 个 spec（全部在 `cacheTtl.*` 下；默认值修订：含 `adaptiveEnabled` 总开关）

| 键（存储/展示）                       | 内部字段                   | 类型          | 默认              | 说明                                                                                 |
| ------------------------------------- | -------------------------- | ------------- | ----------------- | ------------------------------------------------------------------------------------ |
| `cacheTtl.adaptiveEnabled`            | 同名                       | boolean       | **true**          | adaptive 总开关（默认启用；`false` ⇒ 未显式 mode 回落 `auto`，三档行为逐字节同现状） |
| `cacheTtl.adaptiveWriteBudgetTokens`  | 同名                       | count         | **200000**        | 每会话升级引发的**实测** `cacheWrite` 总预算（I-A6）                                 |
| `cacheTtl.adaptiveMaxDeltaTokens`     | 同名                       | count         | **32000**         | 热升级允许的 Δ̂ 上限（`delta-too-large` 门）                                          |
| `cacheTtl.adaptiveRefreshAfterTokens` | 同名                       | count         | **16000**         | 距上次升级累计写入超过它才允许再次热升级（节流）                                     |
| `cacheTtl.adaptiveColdUpgrades`       | 同名                       | count         | **1**             | 每会话冷升级次数上限；0 = 禁用冷升级                                                 |
| `cacheTtl.adaptiveColdCooldownS`      | `adaptiveColdCooldownMs`   | 秒（内部 ms） | **1200**（20min） | 两次冷升级的最小间隔                                                                 |
| `cacheTtl.adaptiveColdMinHorizonS`    | `adaptiveColdMinHorizonMs` | 秒（内部 ms） | **600**（10min）  | 冷升级要求的 subagent 最小剩余时域（S1h）                                            |
| `cacheTtl.adaptiveHistoryGapSignal`   | 同名                       | boolean       | **true**          | 是否启用 S4 弱信号（只影响热升级）                                                   |

**写死常量（不做设置项，理由同保活 §10.1：护栏不许被调没）**：
`ADAPTIVE_PROBE_WRITE_FACTOR = 3`、`ADAPTIVE_PROBE_WRITE_FLOOR_TOKENS = 64_000`（M2 复合判据，
§4.2）、`ADAPTIVE_PENDING_TTL_MS = 120_000`、`ADAPTIVE_GAP_RING_SIZE = 20`、
`ADAPTIVE_COVER_MS = 3_600_000`（1h 覆盖期）。
复用保活常量 `ASSUMED_TTL_MS` / `TTL_SAFETY_MARGIN_MS` / `ANTHROPIC_MESSAGES_API` /
`PING_DENY_PROVIDERS`。

> M2 修订说明：原 `ADAPTIVE_PROBE_MAX_WRITE_RATIO_PERCENT = 25` / `probeMaxWriteRatioPercent`
> **已退役，代码与设置里都不留死键**；复合判据的 factor/floor 以常量形式进入 `AdaptiveConfig`
> （纯函数需要它们作输入，便于测试注入），由 service 从常量填入，不登记 spec。

### 7.3 改动点（file:line）

1. `src/config/settings.ts:132` — `export type CacheTtlMode = "auto" | "on" | "off" | "adaptive";`
2. `src/config/settings.ts:133-146` — `CacheTtlSettings` 追加 8 个字段（带中文 doc 注释，与
   现有 keepalive 字段风格一致）。
3. `src/config/settings.ts:337-343` — `DEFAULT_SETTINGS.cacheTtl` 补 8 个默认值。
4. `src/config/settings.ts:609-633` — `parseCacheTtlSettings`：
   - `mode` 校验加 `|| mode === "adaptive"`；
   - **默认值修订**：先解析 `adaptiveEnabled`；`mode` 缺省（非字符串/未写）时取
     `adaptiveEnabled ? "adaptive" : "auto"`；显式写的合法 mode（含 `"auto"`）一律尊重；
   - 7 个旋钮字段用既有的内联 `bool()/num()`；`adaptiveColdCooldownMs` 用
     `num(raw, d, 60_000, 7_200_000)`，`adaptiveColdMinHorizonMs` 用 `num(raw, d, 0, 7_200_000)`。
5. `src/config/settings.ts:407-435` — `TIME_SETTING_MS_PATHS` 追加
   `"cacheTtl.adaptiveColdCooldownMs"`、`"cacheTtl.adaptiveColdMinHorizonMs"`。
6. `src/config/settings.ts:924-957` — `migrateLegacyCacheTtlState` 两处 mode 白名单
   （`:943` 与 `:953`）各加 `&& mode !== "adaptive"` / `&& existingMode !== "adaptive"`。
7. `src/config/setting-specs.ts:236-240` — `choice("cacheTtl.mode", ["auto","on","off","adaptive"], …)`
   并更新 description。
8. `src/config/setting-specs.ts:260` 之后 — 追加 8 条 spec：`count` ×4、`seconds` ×2、`bool` ×2。
9. **不动 `src/ui/`**（设置编辑器直接读 `SETTING_SPECS`）。

### 7.4 默认值（**已由用户裁决：默认启用**）

**裁决结果（取代本节原先的「不改默认」建议）**：adaptive **默认启用**，经由单开关
`cacheTtl.adaptiveEnabled`（默认 `true`）实现——设置文件未显式写 `mode` 时解析为 `"adaptive"`。
翻转默认 = 把 `DEFAULT_SETTINGS.cacheTtl.adaptiveEnabled` 改成 `false`（一行），且 flag 为
`false` 时 `auto`/`on`/`off` 三档行为与现状逐字节一致。

**默认启用的论据**（即原「阶段 2」论据，用户采纳）：§0.4 的量化结论——热升级 $0.06 买一小时
覆盖，比默认开启的保活 ping（$0.205/次、最多覆盖 44min）**更便宜且覆盖更久**，而现有默认已经
接受了 ping 的开销。

**已知代价（用户已知情并接受）**：adaptive 的最坏情况上界 $4.85/会话（§4.4，m1 修订后在每条
路径上都成立）高于保活的 $2.26/窗口；在极端病态路由上（吞 `cache_creation`、忽略 ttl）需要两次
熔断才收敛。回滚手段：`cacheTtl.adaptiveEnabled=false`（整特性关掉）或
`cacheTtl.adaptiveWriteBudgetTokens=0`（只关升级、保留观测）。

**上线验收仍看两个数**：`confirmed1hWrites`/`indirect1hConfirms` > 0（1h 真的生效）且
`upgradeWriteTokens / 升级次数` ≈ Δ 量级（热升级确实是增量计费）。

---

## 8. 状态栏与 `/cache-ttl status`（问题 7）

### 8.1 设计原则：**先产结构化快照，再产字符串**

已知后续任务要把这一段改成 HUD 原生渲染（结构化数据 + HUD 主题着色 + 独立成行）。因此：

```ts
// src/cache-ttl/keepalive-state.ts（状态渲染区，与 renderCacheStatus 同文件）
export type CacheSegmentKind = "mode" | "ttl-now" | "ping" | "adaptive";
export type CacheSegmentTone = "neutral" | "info" | "good" | "warn" | "bad";

export interface CacheStatusSegment {
  kind: CacheSegmentKind;
  /** 稳定的机器可读 id，HUD 用它决定着色与排序，永不国际化。 */
  id: string; // 例: "ttl-now:1h", "adaptive:armed", "ping:capped"
  /** 人类可读短文本（当前 TUI 状态栏用）。 */
  text: string;
  tone: CacheSegmentTone;
  /** HUD 可选展开：结构化细节，禁止塞已拼好的字符串。 */
  detail?: Record<string, string | number | boolean>;
}

export interface CacheStatusSnapshot {
  mode: CacheDisplayMode; // "auto" | "on" | "off" | "adaptive"
  dirty: boolean;
  /** 本次请求实际写的是什么 —— 用户最想知道的一行。 */
  effectiveTtl: "1h" | "5m" | "provider-default" | "unknown";
  /** 为什么是它（升级理由或拒绝理由），机器可读。 */
  effectiveReason: string; // AdaptiveSignalKind[] join / AdaptiveDeclineReason / "mode:on" …
  segments: readonly CacheStatusSegment[];
  keepalive?: KeepaliveReport;
  adaptive?: AdaptiveSnapshot;
}

export function buildCacheStatusSnapshot(input: CacheStatusInput): CacheStatusSnapshot;
/** 现有签名与返回值保持不变；内部改为 buildCacheStatusSnapshot(...) → join(" · ")。 */
export function renderCacheStatus(input: CacheStatusInput): string | undefined;
```

`CacheStatusInput` 扩展为 `{ mode, dirty, report?, adaptive? }`（`adaptive` 可选，未开启时缺席）。
`CacheDisplayMode` 从 `"auto"|"on"|"off"` 扩到含 `"adaptive"`（`keepalive-state.ts:831`）。

### 8.2 状态栏文案（单 key `"cache-ttl"`，两写入方不变）

| 情形                                     | 文案                                     | segment ids                      |
| ---------------------------------------- | ---------------------------------------- | -------------------------------- |
| adaptive，当前请求写 1h（后台 subagent） | `⏱ cache adaptive · →1h (subagent)`      | `mode:adaptive`, `ttl-now:1h`    |
| adaptive，当前请求 5m（密集交互）        | `⏱ cache adaptive · 5m`                  | `mode:adaptive`, `ttl-now:5m`    |
| adaptive，1h 覆盖生效中（剩余 37min）    | `⏱ cache adaptive · 1h cover 37m`        | + `adaptive:cover`               |
| adaptive + 预算快到                      | `⏱ cache adaptive · 5m · budget 90%`     | + `adaptive:budget`（tone=warn） |
| adaptive 熔断                            | `⏱ cache adaptive · off:1h-ineffective`  | `adaptive:breaker`（tone=bad）   |
| 未确认 1h（代理吞字段）                  | `⏱ cache adaptive · →1h?`（问号=未确认） | `ttl-now:1h`（tone=warn）        |
| 其余（auto/on/off）                      | **与现状逐字一致**                       | —                                |

**字数预算（后续修订）**：状态栏是与其它扩展 status 共享的**同一行**，cache-ttl 是其中最长的一段，
实测 `cache adaptive · 5m · budget 198k/200k · off:warm-write-too-expensive · ping disabled:proven-write ×1`
（101 字符）会把「watching / input·rounds」挤到折行处只留一个 `443` 孤儿行。因此做了三步压缩，
**只改显示文本，不改语义**（精确值一律留在结构化 `detail` 与 `/cache-ttl status`）：

1. `adaptive:budget` 显示百分比（`budget 99%`，向下取整以免在触顶前自称 100%），精确 token 数留在 `detail`。
2. 熔断原因在状态栏用短别名（`warm-write-too-expensive` → `warm-write-costly`，`BREAKER_DISPLAY` 对
   `AdaptiveBreakerReason` 穷举，新增原因会编译失败而不是回落成长文本）；`detail.reason` 与命令输出仍用原文。
3. 熔断期间不再显示 `ttl-now` 细分段（`off:<reason>` 已蕴含），且 `ping disabled:` → `ping off:`。

压缩后该行 78 字符（整行 134 → 111，130 列终端有余量）。注意这只是「缩短」；终端再窄或再加一个
扩展 status 仍会折行——真要根治要走 §8.1 说的 HUD 原生渲染（cache 独立成行）。

`effectiveTtl` 在每次 `before_provider_request` 后由 `updateStatus` 刷新（adaptive 决策已产出）。

### 8.3 `/cache-ttl status` 新增行（`renderKeepaliveReportLines` 之后追加

`renderAdaptiveReportLines(snapshot)`）

```
adaptive: mode=adaptive · last=upgrade(warm, subagent+history-gap) @ <ts>
adaptive signals: subagents=1 (horizon 28m) · bash=0 · uiPrompts=0 · activeTools=3 (ignored) · longGaps=2
adaptive budget: write 48k/200k tok · warm 4 · cold 0/1 · cooldown ready
adaptive 1h: confirmed 3 · unconfirmed 1 · indirect 1 · ineffective 0 · cover ends in 37m
adaptive last reconcile: cacheRead=402k cacheWrite=7k cacheWrite1h=7k ratio=2% cost=$0.12 → confirmed
adaptive breaker: none            (或  disabled: warm-write-too-expensive @ <ts>)
adaptive dropped: sessionMismatch=0 instanceMismatch=0 pending=0
```

### 8.4 命令面

- `src/cache-ttl/cache-ttl.ts:31-35` `MODE_LABEL` 加
  `adaptive: "adaptive (predict 1h before long gaps)"`。
- `:332` `USAGE` 改为
  `usage: /cache-ttl on | off | auto | adaptive | save | keepalive on|off | status`。
- `:365` `if (arg === "on" || arg === "off" || arg === "auto")` 加 `|| arg === "adaptive"`。
- `/cache-ttl save` 无需改动（`persistSettingOverride` 只写值，不校验枚举，
  `src/config/settings.ts:969-1005`）。

---

## 9. 零悬挂与生命周期（问题 8）

### 9.1 归属：新 stack service `src/service/cache-adaptive.ts`

**为什么不塞进 `cache-keepalive.ts`**（§12 T1）：`settings.cacheTtl.keepalive=false` 时
`src/stack.ts:1083` 根本不构造保活 service ⇒ adaptive 会被一个**不相关的设置**关掉；而
把构造条件改成无条件又会破坏现有集成测试（`tests/integration/cache-keepalive.test.ts:251`
断言 `stack.keepalive` 为 `undefined`）并改变 `/cache-ttl keepalive` 的语义。独立 service
代价是 ~60 行守卫样板，换来两个功能完全解耦。

**为什么不放在 `wireCacheTtl` 闭包里**（§12 T2）：与保活方案 T7 同一理由——闭包状态的生命周期
由 activate 管、而不是由 session 管，`/new`、fork、resume 都会串味；stack service 是本仓库
已拍板的范式。

### 9.2 状态分层

| 层                                        | 内容                                                                                                    | pi 依赖 |
| ----------------------------------------- | ------------------------------------------------------------------------------------------------------- | ------- |
| `src/cache-ttl/adaptive.ts`（纯）         | 类型、`decideAdaptiveTtl`、reducers、`buildAdaptiveSnapshot`                                            | 无      |
| `src/cache-ttl/usage-ledger.ts`（纯-ish） | `readLatestAssistantUsage` / `readLatestAssistantCacheTokens`（结构化 ctx duck type，**不 import pi**） | 无      |
| `src/service/cache-adaptive.ts`           | 身份守卫、信号读取、审计、快照、`dispose`                                                               | 有      |
| `src/cache-ttl/cache-ttl.ts`              | hook 接线、决策调用、payload 改写、命令                                                                 | 有      |
| `src/stack.ts` / `src/index.ts`           | 构造 / 持有 / 释放（装配）                                                                              | 有      |

### 9.3 生命周期与守卫

- **构造**：`src/stack.ts:1097` 之后（`keepalive` 之后、fleet widget 之前，此时 `query` 与
  `bashJobs` 都已存在），**无条件构造**（不受 `cacheTtl.keepalive` 影响；mode 可运行时切换，
  所以也不能按 `mode === "adaptive"` 条件构造）。
- **模块级句柄**：`src/stack.ts:119` 之后加 `let previousAdaptive: CacheAdaptiveService | undefined;`
  （与 `previousKeepalive` 同款注释）。
- **上一栈释放**：`src/stack.ts:700`（`previousKeepalive?.dispose()`）之后加
  `previousAdaptive?.dispose(); previousAdaptive = undefined;`。
- **Stack 字段**：`src/stack.ts:476` 之后加 `adaptive: CacheAdaptiveService;`（**非可选**，
  因为无条件构造）；`:1278` 的 return 里加 `adaptive,`。
- **`session_start` 防御块**：`src/index.ts:440` 之后加 `holder.current.adaptive?.dispose();`
  （用可选链：`holder.current` 可能来自旧版本 Stack 形状）。
- **`session_shutdown`**：`src/index.ts:472` 之后加 `stack.adaptive?.dispose();`。
- **装配**：`src/index.ts:164` 改为
  `wireCacheTtl(pi, settings, { keepalive: () => holder.current?.keepalive, adaptive: () => holder.current?.adaptive });`
- **身份守卫（I-A7）**：照抄 `src/service/cache-keepalive.ts:180-191` 的 `accept()`（disposed /
  sessionId / instanceId / `isCurrent`），`isCurrent: (self) => previousAdaptive === self`。
- **epoch**：adaptive **不需要** window epoch —— 它没有任何 `await`、没有在途请求、没有迟到
  回调（I-A8）。唯一的跨时刻关联是 `pending`（等账本回读），用 `requestSeq` + `pendingTtlMs`
  兜底（§6.1a），并计 `dropped.pending`。
- **`/reload`**：状态全在 service 实例里；`session_shutdown` 兜底 dispose（模块级
  `previousAdaptive` 在 reload 后不可达，与保活同理）。
- **定时器**：**零**（I-A8）。不存在 `pi -p` 被 ref'd timer 卡死的风险。
- **`dispose()`**：幂等；只置 `disposed = true`（没有 timer/socket 要释放）；**不**清状态栏
  （状态栏 key 由 `cache-ttl.ts` 与保活 service 共享，保活的 dispose 已经会清）。

### 9.4 事件接线（全部在 `wireCacheTtl` 内，`src/cache-ttl/cache-ttl.ts:185` 的

`wireKeepaliveEvents` 扩写为 `wireCacheEvents`）

| 事件                                                                                                                                   | 保活（现状）                              | adaptive（新增）                                                                                                                                                                                                                                                                                                         |
| -------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `tool_execution_start/end`                                                                                                             | `noteToolStart/End`                       | `noteToolStart/End`（只为审计展示）                                                                                                                                                                                                                                                                                      |
| `ui_prompt_start/end`                                                                                                                  | `noteUiPromptStart/End`                   | `noteUiPromptStart/End`（S3 信号源）                                                                                                                                                                                                                                                                                     |
| `agent_settled`                                                                                                                        | `noteAgentSettled` + `noteRequestSettled` | `noteAgentSettled`（清计数 + 结束 armedEpisode）                                                                                                                                                                                                                                                                         |
| `message_end`                                                                                                                          | `noteRequestSettled`                      | **`reconcile()`**（账本回读，§4.2）                                                                                                                                                                                                                                                                                      |
| `turn_end`                                                                                                                             | `noteRequestSettled`                      | **`reconcile()`**（兜底；幂等）                                                                                                                                                                                                                                                                                          |
| `agent_end`                                                                                                                            | `noteRequestSettled`                      | `reconcile()`（兜底）                                                                                                                                                                                                                                                                                                    |
| `session_compact(_failed)` / `model_select` / `thinking_level_select` / `session_tree` / `resources_discover` / `session_info_changed` | `invalidate(...)`                         | **`invalidateAdaptive(reason)`**：记录 `lastInvalidateSeq = entries.length − 1`（M1 高水位，后续 warm 判定要求 `ledger.entrySeq >` 它）；清 `pending`（被清的 pending 按 m1 预记账 `predictedDeltaTokens` 进预算并计 `droppedPending`）、清 `oneHourCoverUntil`（前缀换了，1h 条目不再对应当前前缀）、**不**清预算与熔断 |

---

## 10. 文件清单与改动点（file:line）

### 10.1 新建

| 文件                                  | 内容                                                                                                                                                                                                                                                              | pi-free |
| ------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------- |
| `src/cache-ttl/adaptive.ts`           | 类型 + `decideAdaptiveTtl` + reducers（`noteDecision`/`onLedgerObserved`/`invalidateAdaptive`/`noteAgentSettled`）+ `buildAdaptiveSnapshot` + 常量                                                                                                                | ✅      |
| `src/cache-ttl/usage-ledger.ts`       | `LedgerCtxLike`（duck type）、`LedgerUsage`（**M1：含 `entrySeq` / `modelId` / `entriesLength` / `cacheWrite1h` / `costTotalUsd`**）、`readLatestAssistantUsage`、`readLatestAssistantCacheTokens`（从 `cache-ttl.ts:88` 移入，行为逐字不变）、`prefixFromLedger` | ✅      |
| `src/service/cache-adaptive.ts`       | `CacheAdaptiveService` / `AdaptivePort` / `createCacheAdaptiveService`                                                                                                                                                                                            | ❌      |
| `docs/dev/cache-ttl-adaptive/plan.md` | 本文                                                                                                                                                                                                                                                              | —       |

### 10.2 修改（精确锚点）

| 文件:行                                    | 改动                                                                                                                                                |
| ------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------- |
| `src/config/settings.ts:132`               | `CacheTtlMode` 加 `"adaptive"`                                                                                                                      |
| `src/config/settings.ts:133-146`           | `CacheTtlSettings` +8 字段                                                                                                                          |
| `src/config/settings.ts:337-343`           | 默认值 +8                                                                                                                                           |
| `src/config/settings.ts:407-435`           | `TIME_SETTING_MS_PATHS` +2                                                                                                                          |
| `src/config/settings.ts:609-633`           | `parseCacheTtlSettings`：mode 白名单 + adaptiveEnabled 默认升格 + 7 旋钮逐字段容错                                                                  |
| `src/config/settings.ts:943,953`           | `migrateLegacyCacheTtlState` 两处白名单                                                                                                             |
| `src/config/setting-specs.ts:236-240`      | `choice` 增枚举值 + description                                                                                                                     |
| `src/config/setting-specs.ts:260+`         | +8 条 spec                                                                                                                                          |
| `src/cache-ttl/keepalive-state.ts:831`     | `CacheDisplayMode` 加 `"adaptive"`                                                                                                                  |
| `src/cache-ttl/keepalive-state.ts:833-844` | `CacheStatusInput` 加 `adaptive?: AdaptiveSnapshot`（type-only import）                                                                             |
| `src/cache-ttl/keepalive-state.ts:846-889` | 新增 `CacheStatusSegment`/`CacheStatusSnapshot`/`buildCacheStatusSnapshot`；`renderCacheStatus` 改为其薄封装（**外部签名与输出逐字不变**）          |
| `src/cache-ttl/keepalive-state.ts:891+`    | 新增 `renderAdaptiveReportLines(snapshot)`                                                                                                          |
| `src/cache-ttl/cache-ttl.ts:31-35`         | `MODE_LABEL` +1                                                                                                                                     |
| `src/cache-ttl/cache-ttl.ts:49-53`         | `updateStatus` 传 `adaptive?.snapshot()`                                                                                                            |
| `src/cache-ttl/cache-ttl.ts:56-70`         | `rewrite(node, action: RewriteAction, seen)`：`"force-1h"` 写 ttl、`"strip-ttl"` 删 ttl；调用方按 §3.1 第 8 步映射（原 `mode` 参数语义搬到 action） |
| `src/cache-ttl/cache-ttl.ts:88-106`        | 删除（移入 `usage-ledger.ts`），改为 re-export 以免破坏潜在外部引用                                                                                 |
| `src/cache-ttl/cache-ttl.ts:128-142`       | `captureRequest` 增参 `prefix: PrefixEstimate`（由调用方从 ledger 派生，避免重复读）                                                                |
| `src/cache-ttl/cache-ttl.ts:185-247`       | `wireKeepaliveEvents` → `wireCacheEvents`，按 §9.4 表补 adaptive 转发                                                                               |
| `src/cache-ttl/cache-ttl.ts:263-319`       | `before_provider_request` 按 §3.1 重排（含 `inspectPayload` 预检、`decide`、`noteDecision`）                                                        |
| `src/cache-ttl/cache-ttl.ts:332,365`       | USAGE 与命令参数白名单                                                                                                                              |
| `src/cache-ttl/cache-ttl.ts:352-360`       | `/cache-ttl status` 追加 `renderAdaptiveReportLines`                                                                                                |
| `src/cache-ttl/cache-ttl.ts:20-30`         | `CacheTtlDeps` 加 `adaptive?: () => CacheAdaptiveService \| undefined`                                                                              |
| `src/stack.ts:119`                         | `previousAdaptive` 句柄                                                                                                                             |
| `src/stack.ts:476`                         | `Stack.adaptive`                                                                                                                                    |
| `src/stack.ts:700`                         | `previousAdaptive?.dispose()`                                                                                                                       |
| `src/stack.ts:1097+`                       | 构造 `createCacheAdaptiveService({ ctx, sessionId, settings: settings.cacheTtl, signals, isCurrent, appendEntry, emit, clock: systemClock })`       |
| `src/stack.ts:1278`                        | return 加 `adaptive`                                                                                                                                |
| `src/index.ts:164`                         | `wireCacheTtl` 增 `adaptive` 读取闭包                                                                                                               |
| `src/index.ts:440`                         | 防御块 `holder.current.adaptive?.dispose()`                                                                                                         |
| `src/index.ts:472`                         | shutdown `stack.adaptive?.dispose()`                                                                                                                |

> `src/stack.ts` 构造处的 `signals` 闭包（与 `:1089` 的 `backgroundBusy` 同款写法）：
>
> ```ts
> signals: () => {
>   const runs = query.list().filter((s) => ["queued", "starting", "running", "stopping"].includes(s.status));
>   const horizons = runs
>     .map((r) => r.deadlines.hardDeadlineAt ?? r.deadlines.deadlineAt)
>     .filter((v): v is number => typeof v === "number");
>   return {
>     subagentRuns: runs.length,
>     maxSubagentHorizonMs: horizons.length > 0 ? Math.max(...horizons) - Date.now() : undefined,
>     backgroundBashJobs: bashJobs?.backgroundJobCount() ?? 0,
>   };
> },
> ```
>
> （`uiPrompts`/`activeTools` 由 service 自己的计数器补齐；`exactOptionalPropertyTypes` 下
> `maxSubagentHorizonMs` 显式写成 `number | undefined` 而非条件展开。）

---

## 11. 测试矩阵（问题 9）

### 11.1 `tests/cache-ttl/adaptive-state.test.ts`（新建，纯函数，无 mock）

**A. 预测器真值表** —— §3.6 的 18 行逐行一个 `it`，断言 `decision.upgrade`、`class`、
`reason`、`signals`。用 `it.each(TRUTH_TABLE)` 表驱动，表本身从文档复制。

**B. 能力门（A 组）**

1. `mode !== "adaptive"` ⇒ `mode`
2. `api = "openai-completions"` ⇒ `not-anthropic`
3. `provider = "github-copilot"` ⇒ `not-anthropic`
4. `supportsLongCacheRetention = false` ⇒ `no-1h-support`（**任务书点名必须覆盖**：信号全开
   也不升级）
5. `ephemeralBreakpoints = 0` ⇒ `no-cache-control`
6. `shape.ttl1h = true` ⇒ `already-1h`
7. 熔断态 ⇒ `breaker`
8. `upgradeWriteTokens >= writeBudgetTokens` ⇒ `write-budget`

**C. 冷热判定** 9. `ledger.source = "unknown"` ⇒ 判冷 10. `cacheRead = 0` ⇒ 判冷 11. `now − lastRequestStartedAt = 260s`（> 300−45=255s）⇒ 判冷（边界）12. `= 254s` ⇒ 判热（边界）

**D. 热路径节流与 Δ 门** 13. `cacheWrite > maxDeltaTokens` ⇒ `delta-too-large` 14. `armedEpisode = false` + 强信号 ⇒ 绕过节流升级 15. `armedEpisode = true` + `tokensSinceLast1hWrite < refreshAfterTokens` ⇒ `refresh-throttled` 16. 累计超过阈值 ⇒ 再次升级

**E. 冷路径限次/冷却/时域** 17. `coldUpgrades = 0` ⇒ `cold-budget` 18. 冷却期内 ⇒ `cold-cooldown` 19. `maxSubagentHorizonMs < coldMinHorizonMs` 且只有 S1 ⇒ `cold-signal-too-weak` 20. 同上但另有 S2 ⇒ 升级（S2 不看时域）21. 只有 S4 ⇒ `cold-signal-too-weak`（**S4 永不进冷路径**）

**F. reducer（误判回退，任务书点名；M2 修订）** 22. `onLedgerObserved` 热 pending + `cacheWrite` 超复合阈
值（`> max(3 × predictedDeltaTokens, 64_000)`）⇒ 熔断 `warm-write-too-expensive` 23. 热 pending + `cacheRead = 0` ⇒ 熔断 `warm-miss` 24. 1h 覆盖期内的冷请求 `cacheRead > 0` ⇒ `indirect1hConfirms += 1`，不熔断 25. 1h 覆盖期内的冷请求 `cacheRead = 0` ⇒ `ineffective1h += 1` + 熔断 `1h-ineffective` 26. `cacheWrite1h > 0` ⇒ `confirmed1hWrites += 1`；`= 0 && cacheWrite > 0` ⇒
`unconfirmed1hWrites += 1`（**§5.2 三态**）27. `upgradeWriteTokens` 累计到超预算 ⇒ 熔断 `write-budget`，且**下一次** decide 返回
`write-budget`（幂等）28. pending 超 `ADAPTIVE_PENDING_TTL_MS` ⇒ 丢弃并计 `dropped.pending`，不误结账29. `requestSeq` 未前进 ⇒ 不结账（防止拿旧账本给新 pending 结账）30. 熔断后任何输入都不再升级（永久性）31. reducer 不变性：未变更时返回**同一引用**（`toBe`），变更时返回新对象（与保活 reducer 同约）

**G. 空档环形缓冲与 S4** 32. 21 个间隔只保留最近 20 个 33. `longGapCount` 只统计 `> ASSUMED_TTL_MS` 的间隔34. `historyGapSignal = false` ⇒ S4 不产生信号
34a. **m5 补充**：S4-only + 已升级过 + 累计 < 16k ⇒ `refresh-throttled`；S4-only + 本会话首次升级 ⇒
不受节流（`lastUpgradeAt === undefined`）

**F2. 评审回归用例（M1/M2/m1/m2，点名补）**

- F2-1（M1）：invalidate（compact）后首个请求，旧账本 `entrySeq ≤ lastInvalidateSeq` ⇒ 判**冷**；
  冷升级后 reconcile 读到大 `cacheWrite` ⇒ **不走热探针、不熔断**；换模型（`modelId` 不匹配）同理
- F2-2（M2）：小前缀会话（A=40k）热 pending + 合法顶格增量 `cacheWrite=32k` ⇒ **不熔断**
  （32k ≤ max(3×32k, 64k)；旧 ratio 判据 44% > 25% 会误熔断）
- F2-3（m1）：pending 超 `ADAPTIVE_PENDING_TTL_MS` 被丢弃 ⇒ 按 `predictedDeltaTokens` 预记账进
  `upgradeWriteTokens`，上界路径闭合
- F2-4（m2）：同一账本连续两次 `onLedgerObserved`（模拟 message_end + turn_end 双触发）⇒
  第二次返回**同一引用**，计数不变
- F2-5（m1 变体）：`invalidateAdaptive` 清掉未结账 pending ⇒ 同样预记账 + `droppedPending += 1`

**H. 快照** 35. `buildAdaptiveSnapshot` 覆盖：未武装 / 升级中 / 覆盖期 / 预算告警 / 熔断 五态的
`segments[].id` 与 `tone`

### 11.2 `tests/cache-ttl/usage-ledger.test.ts`（新建）

36. 从最后一条 assistant message 读 `cacheRead/cacheWrite/cacheWrite1h`
37. `cacheWrite1h` 缺失 ⇒ `undefined`（不是 0，必须与「报告了 0」可区分）
38. 无 entries / `getEntries` 抛异常 / 非数组 ⇒ `source = "unknown"`
39. 跳过 toolResult 与 user entries，只取 assistant
40. `readLatestAssistantCacheTokens` 行为与迁移前逐字一致（回归）

### 11.3 `tests/cache-ttl/adaptive-lifecycle.test.ts`（新建，service 层，`FakeClock`）

41. `accept()` 四重守卫：错 sessionId / 错 instanceId / `isCurrent=false` / `disposed`
    ⇒ 静默丢弃且 `dropped.*` 自增
42. `dispose()` 幂等；dispose 后 `decide()` 返回 `{upgrade:false, reason:"breaker"}`（或专门的
    `disposed` 理由——**实现取 `breaker`，并在注释里说明**）
43. **无定时器**：构造 + 若干事件 + dispose 后，`FakeClock` 的 pending timer 数为 0（I-A8 断言）
44. `signals()` 抛异常 ⇒ 视为全 0 信号（不升级），不向上抛
45. `ctx.model` 读取抛异常 ⇒ `supportsLongCacheRetention` 取 `false` ⇒ 不升级（与
    `cache-keepalive.ts:247` 同款保守语义）
46. 审计：一次升级产生一条 `decision` + 一条 `reconcile` 条目，字段齐全且**不含任何 header/密钥**
47. `invalidateAdaptive("session-compact")` 清 pending 与 `oneHourCoverUntil`，保留预算与熔断

### 11.4 `tests/cache-ttl/cache-ttl.test.ts`（扩充现有 253 行）

48. **四档互不串味**（任务书点名）：
    - `mode="on"`：payload 全部断点带 `ttl:"1h"`，**不调用** `adaptive.decide`
    - `mode="off"`：全部断点的 ttl 被删除，**不调用** `adaptive.decide`
    - `mode="auto"`：返回 `undefined`（透传），调用 `port.consumeUpgrade`，**不调用**
      `adaptive.decide`
    - `mode="adaptive"`：调用 `adaptive.decide`，**不调用** `port.consumeUpgrade`（I-A9）
49. adaptive 升级 ⇒ 返回的 clone 里每个断点都有 `ttl:"1h"`（I-A2 全量）
50. adaptive 不升级 ⇒ 返回 `undefined`，且 payload 对象**未被就地修改**（I-A1）
51. adaptive 不升级但 payload 已带 1h（pi 写的）⇒ 不删 ttl、`decide` 返回 `already-1h`（I-A1）
52. `/cache-ttl adaptive` 切换 + `status` 输出含 adaptive 段；`save` 持久化 `"adaptive"`
53. 非法参数仍报 USAGE（含新 `adaptive` 字样）
54. `adaptive` 依赖缺席（`deps.adaptive` 未传）⇒ 行为等同 `auto`，不抛
55. 捕获顺序回归：升级后 `noteRequest` 收到的 `shape.ttl1h === true`（**门 #7 衔接的根因断言**）

### 11.5 `tests/cache-ttl/keepalive-state.test.ts`（扩充）

56. `renderCacheStatus` 在 `auto`/`on`/`off` 三档下输出**与改造前逐字一致**（快照回归）
57. `mode="adaptive"` 时 `renderPingSegment` 不再出现 `→1h` 提示（§6.2）
58. `buildCacheStatusSnapshot` 的 `effectiveTtl`/`effectiveReason`/`segments` 覆盖 §8.2 七行表
59. `evaluateTick` 在 `capture.shape.ttl1h = true` 时返回 `skip("ttl-1h", terminal:true)`
    （既有用例，补一条注释指明它现在也服务于 adaptive）

### 11.6 `tests/config/cache-ttl-settings.test.ts` / `cache-ttl-migration.test.ts`（扩充）

60. `parseCacheTtlSettings({mode:"adaptive"})` ⇒ 保留；`{mode:"bogus"}` ⇒ 回落「flag 默认」
    （`adaptiveEnabled` 默认 true ⇒ `"adaptive"`；显式 `adaptiveEnabled:false` ⇒ `"auto"`）
    60a. **默认值修订**：mode 缺省（整个 cacheTtl 块缺省 / `mode` 非字符串）⇒ `adaptiveEnabled` 开时
    解析为 `"adaptive"`，关时 `"auto"`；显式 `{mode:"auto"}` 永远保持 `auto`（尊重显式选择）
61. 8 个新字段的逐字段容错（类型错 / 越界 / 缺失 ⇒ 各自默认）
62. `adaptiveColdCooldownMs` 钳位 [60s, 7200s]；`SETTING_SPECS` 里展示 key 是 `…CooldownS`
63. `TIME_SETTING_MS_PATHS` 包含两个新 ms path，且 `secondsKeyOf` 映射正确
64. `SETTING_SPECS["cacheTtl.mode"].values` 含 4 个值
65. 迁移：legacy state 里 `mode:"adaptive"` 被接受（不再 warn）

### 11.7 `tests/integration/cache-adaptive.test.ts`（新建，真实 `buildSessionStack` + `wireCacheTtl`）

66. 真 stack + 真 wire：`mode="adaptive"`，注入一个 `running` 的 subagent run ⇒
    `before_provider_request` 返回带 `ttl:"1h"` 的 clone
67. 无任何后台 ⇒ 返回 `undefined`
68. stack 重建 ⇒ 旧 adaptive 被 dispose，新实例不同，旧实例调用被丢弃
69. `session_shutdown` ⇒ `adaptive.dispose()` 被调用；之后 `decide()` 无副作用
70. 升级后喂一条带 `usage` 的 assistant entry + 触发 `message_end` ⇒ `snapshot()` 的
    `confirmed1hWrites` / `upgradeWriteTokens` 正确
71. **与 ping 的衔接（任务书点名）**：同一 stack 上 `keepalive=true`，adaptive 升级后推进
    `FakeClock` 超过 ping 间隔 ⇒ **一次 fetch 都没发**（`lastSkip === "ttl-1h"`）；未升级的
    下一个窗口 ⇒ ping 正常发出
72. `supportsLongCacheRetention=false` 的 ctx.model ⇒ 无论信号如何都不改写 payload

**总计新增/修改约 72 条用例**；`npm test` 必须保持全绿（当前 188 文件 / 2848 tests）。

---

## 12. 取舍记录（被否决的备选）

| #   | 备选                                                                   | 否决理由                                                                                                                                                                                      |
| --- | ---------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| T1  | adaptive 状态塞进 `cache-keepalive.ts`                                 | 会被无关设置 `cacheTtl.keepalive=false` 关掉；改为无条件构造又破坏 `tests/integration/cache-keepalive.test.ts:251` 与 `/cache-ttl keepalive` 语义                                             |
| T2  | adaptive 状态放 `wireCacheTtl` 闭包                                    | 生命周期归 activate 而非 session，`/new`/fork/resume 串味；违反 stack service 范式（同保活 T7）                                                                                               |
| T3  | 只把**最后一个**断点改成 1h（省钱）                                    | 违反官方「长 TTL 断点必须在短 TTL 之前」的排序约束（§0.4），会被 API 拒绝或产生不可预测计费                                                                                                   |
| T4  | 把保活门 #7 改成 `ttl1hConfirmed` 三态                                 | 要动 `WindowState`/`evaluateTick`/`onRealRequest` 等已验证核心；收益仅把 E3 上界从 $2.56 降到「窗口内继续 ping」。改用一次性探测 + 熔断（§4.3）                                               |
| T5  | 直接复用 `armed()`（`backgroundBusy \|\| activeTools \|\| uiPrompts`） | `activeTools` 不挑工具类型、几乎恒真 ⇒ 退化为 `on`；冷路径每轮 $1.54（§3.3）                                                                                                                  |
| T6  | 用 `ctx.getContextUsage()` 估 Δ                                        | 是上下文总量，不是「相对最高命中点的增量」，系统性高估（保活 M3 同一教训）；改用实测 `cacheWrite` 代理                                                                                        |
| T7  | 用 wall-clock 单独判定冷热（不看 `cacheRead`）                         | 时钟只能推定、不能证明；`cacheRead > 0` 是实测证据（I-A5）。两者取「与」是最保守组合                                                                                                          |
| T8  | 独立命令 `/cache-adaptive`                                             | 同一主题，做成 `/cache-ttl adaptive` 子档（同保活 T6）                                                                                                                                        |
| T9  | 用独立状态栏 key `"cache-adaptive"`                                    | 状态栏已在保活阶段合并为单 key `"cache-ttl"`；再拆回去等于回退那次清理                                                                                                                        |
| T10 | 把熔断探针阈值做成设置项                                               | 它是熔断护栏，暴露出去等于允许把护栏调没（同保活 §10.1 的 T10 原则）。M2 修订：原 ratio 判据整体退役，替换为写死的复合常量 `ADAPTIVE_PROBE_WRITE_FACTOR/FLOOR_TOKENS`（§4.2），同样不做设置项 |
| T11 | ~~默认即把 `cacheTtl.mode` 改成 `adaptive`~~（**已被用户裁决推翻**）   | 原否决理由：不通知就改计费行为 + 推论 1 未实测。**用户裁决默认启用**：经单开关 `cacheTtl.adaptiveEnabled`（默认 true）升格缺省 mode，显式 mode 永远优先，回滚一行（§7.4）                     |
| T12 | 升级后主动 `invalidate()` 保活窗口                                     | 多余：门 #7 已经 terminal skip；主动 invalidate 反而会丢掉下一次真实请求前的捕获，让 ping 在「未升级窗口」也失效                                                                              |

---

## 13. 外部事实引用（取证清单）

1. **官方计费规则（Mixing different TTLs）**：`Position A/B/C` 与
   「read(A) + 1h-write(B−A) + 5m-write(C−B)」、以及「长 TTL 断点必须在短 TTL 之前」——
   Anthropic Prompt caching 文档
   <https://platform.claude.com/docs/en/build-with-claude/prompt-caching>（§0.4 的推导基础）。
2. **倍率**：5m 写 1.25×、1h 写 2×、read 0.1×（同上文档 Pricing 段）。
3. **pi 的 usage 映射保留 1h 拆分**：
   `node_modules/@earendil-works/pi-coding-agent/dist/bundle/chunks/anthropic-messages-JWX2WP65.js`
   的 `message_start` 分支（`output.usage.cacheWrite1h = event.message.usage.cache_creation?.ephemeral_1h_input_tokens || 0`）；
   类型 `node_modules/@earendil-works/pi-ai/dist/types.d.ts:265-271`；
   计价 `node_modules/@earendil-works/pi-ai/dist/models.js:537-543`；
   持久化/合并 `dist/core/compaction/compaction.js:54-60`。
4. **长缓存可用性语义**：`node_modules/@earendil-works/pi-ai/dist/api/anthropic-messages.js:120`
   `supportsLongCacheRetention: model.compat?.supportsLongCacheRetention ?? true`（**未设置即
   为 true**）；`:28-37` 的 `getCacheControl` 只在 `retention === "long" && supports…` 时写
   `ttl:"1h"`。用户实际路由 `cloudrouter-anthropic/claude-opus-5` 未设该标志 ⇒ 支持 1h；
   `newapi-aws` 与 `copilot-anthropic` 的同名模型显式 `false`。
   service 侧已有实现可参照：`src/service/cache-keepalive.ts:247-251`。
5. **`PI_CACHE_RETENTION` 语义**：`anthropic-messages.js:19-27` 的 `resolveCacheRetention`
   （`"long"` ⇒ 长缓存），即 `auto` 档「跟随环境变量」的出处。
6. **bash 自动后台化阈值**：`src/config/settings.ts:309` `autoBackgroundMs: 290_000`（≈4m50s），
   S2 信号强度的依据。

---

## 14. 分步施工顺序（问题 10）

每步都可独立提交、独立通过 CI（`npm run format:check && npm run typecheck && npm test && npm run build`）。

### 步骤 1 — 账本读取抽取（纯重构，零行为变化）

- 新建 `src/cache-ttl/usage-ledger.ts`；把 `cache-ttl.ts:88-106` 的
  `readLatestAssistantCacheTokens` 移入并扩写出 `readLatestAssistantUsage`。
- `cache-ttl.ts` 改为 import + re-export。
- 新建 `tests/cache-ttl/usage-ledger.test.ts`（用例 36–40）。
- **验证**：`npx vitest run tests/cache-ttl` + `npm run typecheck`。
- 提交：`refactor(cache-ttl): extract usage ledger readers into a pi-free module`

### 步骤 2 — 设置层（`adaptive` 枚举 + 7 个 spec）

- `src/config/settings.ts` 六处 + `src/config/setting-specs.ts` 两处（§7.3）。
- 扩充 `tests/config/cache-ttl-settings.test.ts`、`tests/config/cache-ttl-migration.test.ts`
  （用例 60–65）。
- 此时 `mode="adaptive"` 在运行时**行为等同 `auto`**（还没有预测器）——这是有意的安全中间态。
- **验证**：`npx vitest run tests/config` + `npm run typecheck`。
- 提交：`feat(cache-ttl): add the adaptive mode value and its settings surface`

### 步骤 3 — 纯预测器 `src/cache-ttl/adaptive.ts`

- 类型 + `decideAdaptiveTtl` + reducers + `buildAdaptiveSnapshot` + 常量。
- 新建 `tests/cache-ttl/adaptive-state.test.ts`（用例 1–35，含真值表表驱动）。
- 尚未接线，纯函数可独立验证。
- **验证**：`npx vitest run tests/cache-ttl/adaptive-state.test.ts`。
- 提交：`feat(cache-ttl): adaptive 1h predictor state machine (pure)`

### 步骤 4 — stack service `src/service/cache-adaptive.ts` + stack/index 接线

- service（守卫 / 信号 / 审计 / 快照 / dispose，零定时器）。
- `src/stack.ts` 四处（`:119` / `:476` / `:700` / `:1097+` / `:1278`）、`src/index.ts` 三处
  （`:164` / `:440` / `:472`）。
- 新建 `tests/cache-ttl/adaptive-lifecycle.test.ts`（用例 41–47）。
- 此时 service 已存在但 `cache-ttl.ts` 还没调用 `decide` ⇒ 行为仍等同 `auto`。
- **验证**：`npx vitest run tests/cache-ttl tests/integration` + `npm run typecheck`。
- 提交：`feat(service): per-session cache adaptive service (timerless stack service)`

### 步骤 5 — hook 接线：真正开始改写 payload

- `cache-ttl.ts`：`RewriteAction` 重构、`before_provider_request` 重排（§3.1）、
  `wireCacheEvents` 扩写（§9.4）、`CacheTtlDeps.adaptive`。
- 扩充 `tests/cache-ttl/cache-ttl.test.ts`（用例 48–55）。
- **这是第一个有行为变化的提交**；`mode` 默认仍是 `auto`，需显式切换才生效。
- **验证**：`npx vitest run tests/cache-ttl` + `npm run typecheck`。
- 提交：`feat(cache-ttl): adaptive mode rewrites ttl:1h ahead of predicted long gaps`

### 步骤 6 — 可观测性：状态栏结构化快照 + `/cache-ttl status`

- `keepalive-state.ts`：`CacheDisplayMode` 扩档、`CacheStatusSegment`/`CacheStatusSnapshot`/
  `buildCacheStatusSnapshot`、`renderCacheStatus` 薄封装、`renderAdaptiveReportLines`。
- `cache-ttl.ts`：`updateStatus` 传快照、`status` 子命令追加段、`MODE_LABEL`/`USAGE`/参数白名单。
- 扩充 `tests/cache-ttl/keepalive-state.test.ts`（用例 56–59）。
- **验证**：`npx vitest run tests/cache-ttl` + 人工在 TUI 里看一眼状态栏七种形态。
- 提交：`feat(cache-ttl): structured cache status snapshot (HUD-ready) with adaptive segments`

### 步骤 7 — 集成测试与衔接钉死

- 新建 `tests/integration/cache-adaptive.test.ts`（用例 66–72），重点是 71（升级后 ping
  一次都不发）与 72（`supportsLongCacheRetention:false`）。
- **验证**：`npm test`（全量）+ `npm run build`。
- 提交：`test(cache-ttl): end-to-end adaptive wiring and keepalive hand-off`

### 步骤 8 — 文档与 CHANGELOG

- `README.md` / `README.en.md` 的 cache-ttl 段补 `adaptive` 一行 + 成本口径一句话。
- `AGENTS.md` 的 `src/cache-ttl/` 与 `src/service/` 条目补一句。
- CHANGELOG（Conventional Commits 自动生成，人工校对）。
- **验证**：`npm run format:check`。
- 提交：`docs(cache-ttl): document the adaptive mode, its cost model and its bounds`

---

## 15. 风险登记

| #   | 风险                                                    | 影响                            | 缓解                                                                          | 残余             |
| --- | ------------------------------------------------------- | ------------------------------- | ----------------------------------------------------------------------------- | ---------------- |
| R1  | §0.4 推论 1（热升级只按增量计费）在真实代理路由上不成立 | 每次热升级 $1.54 而非 $0.06     | 探针复合判据（`cacheWrite > max(3×Δ̂, 64k)`，M2）一次即熔断（§4.2）；上界 §4.4 | 一次 ≤$1.54      |
| R2  | 代理吞掉 `cache_creation` 拆分 ⇒ 无法直接确认 1h        | 观测降级为间接反推              | 三态记账（§5.2）+ `indirect1hConfirms`；熔断判据只用 `cacheRead`/`cacheWrite` | 观测滞后一个空档 |
| R3  | 上游完全忽略 `ttl:"1h"`                                 | 门 #7 停了 ping，缓存 5min 后死 | E3 探测一次即熔断，ping 自动恢复（§4.3）                                      | 一次 ≤$2.56      |
| R4  | `cacheWrite` 作 Δ̂ 代理在 compact/换模型后严重失真       | 误判为 `delta-too-large` 少升级 | 保守方向（宁可漏升级）；`invalidateAdaptive` 在 compact 时清 pending          | 少量漏升级       |
| R5  | S1 误判（subagent 秒级返回）                            | 热路径 $0.06 / 冷路径 $1.54     | 冷路径加 `coldMinHorizonMs` 量化门 + 限 1 次 + 20min 冷却                     | 每会话 ≤$1.54    |
| R6  | 新 service 与保活 service 的守卫代码重复（~60 行）      | 维护成本                        | 两者注释互相引用；若第三个出现再抽公共 `accept()` 工厂                        | 可接受           |
| R7  | `query.list()` / `bashJobs` 在极端路径抛异常            | 信号读取失败                    | `signals()` 整体 try/catch ⇒ 全 0 ⇒ 不升级（用例 44）                         | 无               |
| R8  | 订阅制（OAuth）用户没有按 token 计费                    | 成本模型换算成配额              | 比值不变（0.75Δ vs 1.25P）；沿用保活 §15 R7 的用户裁决                        | 用户已裁决       |

---

## 16. 后续修订（post-v1，不改写上文历史结论）

### 16.1 双预算熔断：美元主闸 + token 兜底（修订 §4.4 的 `W` 口径）

**问题**（实测确认，非论证）：`adaptiveWriteBudgetTokens`（默认 200_000）是 token 绝对值，
但它要防的是钱。同样 200k 在不同模型间差 3–5 倍；而升级只发生在 Anthropic 路由。实测会话
前缀 P：中位 105k、p75 162k、p90 267k——200k 在中位前缀下只兜得住约 1.9 次全量重写（p90 连
一次都不够）；同时健康路由上它只够 12–25 次增量升级，长会话中途被烧穿后**静默**退回 5m。

**修订**：

- `LedgerUsage` 新增 `cacheWriteUsd`（读 `usage.cost.cacheWrite`，与 `costTotalUsd` 同一
  `finite()` 守卫；§5.1 已取证 pi 对 1h 写入按 2× 计价进 `cost.cacheWrite`）。
- `AdaptiveState` 新增 `upgradeWriteUsd`：在 pending 结账处累加**边际成本**
  `0.375 × ledger.cacheWriteUsd`。推导：1h 写 2.0× vs 5m 写 1.25× ⇒ 升级边际 0.75×；pi 把
  1h 写按 2.0× 计入 `cost.cacheWrite`，故边际占实付 1h 写入的 `0.75/2.0 = 0.375`
  （`MARGINAL_WRITE_FRACTION`）。`cacheWriteUsd === undefined` 不累加——缺数据不猜，
  该会话由 token 预算单独兜底。
- 熔断判据改为**任一预算撞线**即 `write-budget`（`budgetExhausted()`）：美元主闸 +
  token 兜底（成本数据缺失的路由）。decide 前置检查与两处结账后熔断同步换用。
- 新设置 `cacheTtl.adaptiveWriteBudgetUsd`：默认 **1.0**，解析范围 [0, 100]（不取整——0.5
  被 floor 成 0 会把「半美元」误读成「关闭」），**0 = 关闭美元闸**（纯 token 判据）。
  `adaptiveWriteBudgetTokens` 默认值 200_000 不变（纯新增键，无迁移）。
  ⚠️ `SETTING_SPECS` 的 `min/max` 必须与 `usd()` 的 [0, 100] **保持一致**：编辑器与
  `set` 命令只按 spec 校验，而 reload 走 `usd()`——后者对越界值是**回落默认**而非钳位，
  且 `setPath` 改的就是 adaptive service 正在读的同一个对象，spec 漏写上限会造成
  「当前会话立刻按越界值生效、reload 后静默变回 1.0」的静默漂移（v1 审查 M1）。
- **丢弃型 pending 只预记 token、不预记 USD**（TTL 超时丢弃与前缀漂移 invalidate 两条路径）：
  这与「`cacheWriteUsd` 缺失不累加」是同一条原则——成本从不靠猜。等价于把丢弃 pending 视作
  「该路由未报成本」，由 token 兜底覆盖；USD 侧因此是**保守低估**，不是记账漏洞。
- 观测：`AdaptiveSnapshot` 增加 `upgradeWriteUsd` / `writeBudgetUsd` / `usdFraction`；
  budget 状态段显示两者中**更接近上限**者的百分比，`detail` 同时给两组数字；
  `/cache-ttl status` 预算行追加 `· $x.xx/$y.yy`（闸关时 `$x.xx/off`）。

与 §4.4 上界的关系：USD 闸收紧的是「典型会话 $0.1–0.25」这一行的**单位一致性**，最坏上界
（一次超出 ≤ 0.75×(W+P)×R + 1.25×P×R）不变，只是现在直接以美元度量。

### 16.2 探针地板挂钩实测前缀（修订 §4.2 M2 复合判据的地板项）

**问题**：固定地板 `ADAPTIVE_PROBE_WRITE_FLOOR_TOKENS = 64_000` 与预算没有共同坐标系——
前缀 P < 64k 的病态路由每次全量重写都不触发探针，可以一路烧到撞预算才熔断。

**修订**：判据 `cacheWrite > max(factor × Δ̂, floor)` 中

```
floor = min(ADAPTIVE_PROBE_WRITE_FLOOR_TOKENS, max(ADAPTIVE_PROBE_WRITE_FLOOR_MIN_TOKENS, fraction × P))
P     = 结账时刻实测前缀（cacheRead + cacheWrite，复用 prefixFromLedger）
fraction = ADAPTIVE_PROBE_WRITE_FLOOR_FRACTION = 0.5
MIN   = ADAPTIVE_PROBE_WRITE_FLOOR_MIN_TOKENS = 4_000
```

三个常数的关系（「只在需要的地方收紧」）：

- **大前缀（P ≥ 128k）**：0.5P ≥ 64k，被 `min` 夹回 64k ⇒ 行为与修订前**逐字节一致**，
  不引入新的误熔断；
- **小前缀（如 P = 40k）**：地板降到 20k，才能**一次**识别「整个前缀被重写」（旧逻辑下
  该路由每次全量重写都不触发探针，只能烧预算）；
- **极小前缀（P < 8k）**：4k 硬下限防止地板缩进普通增量噪声区、误伤合法增量。

`probeWriteFactor = 3` 不变；M2「探针只抓路由级结构性违例，不抓单次大重写」的定性不变。

### 16.3 入场费：§0.4 推论 1 只在 1h→1h 成立（实测推翻，热探针口径修订）

**取证**（26 个真实会话的 `subagent:cache-adaptive` 审计条目，15 次升级结算）：

```
UP warm Δ̂=966    → settle read 0      write 83139  w1h 83139  ⇒ warm-miss
UP warm Δ̂=1652   → settle read 0      write 70735  w1h 70735  ⇒ warm-miss
UP warm Δ̂=4712   → settle read 0      write 265875 w1h 265875 ⇒ warm-miss
UP warm Δ̂=920    → settle read 11356  write 80462             ⇒ warm-write-too-expensive
UP warm Δ̂=440    → settle read 10966  write 211413            ⇒ warm-write-too-expensive
UP warm Δ̂=3841   → settle read 10931  write 249482            ⇒ warm-write-too-expensive
--- 唯一活下来的会话：首升是 cold（冷路径本来就不过探针），交完费之后 ---
UP cold Δ̂=184103 → settle read 10931  write 174109            ⇒ 无熔断
UP warm Δ̂=580    → settle read 185040 write 3334              ⇒ 无熔断（推论 1 成立）
UP warm Δ̂=490    → settle read 208214 write 268               ⇒ 无熔断
UP warm Δ̂=1255   → settle read 225049 write 897               ⇒ 无熔断
```

**结论**：带 `ttl:"1h"` 的请求**读不到以 5m 写入的缓存条目**。一条前缀的**首次**升级必然
整条重写为 1h（`cacheRead = 0` 或只剩早先就是 1h 的小残块，`cacheWrite1h = cacheWrite ≈ P`，
即上游**确实 honor 了 ttl**），此后 1h→1h 的热升级才符合 §0.4 推论 1（只计增量）。这一次性
成本称为**入场费（entry fee）**。

§4.2 的两个热探针恰恰只观测那一次过渡请求，于是：

1. 入场费的形态（read≈0 或 read≪P、write≈P）与「路由级病态」在**单次观测**下不可区分 ⇒
   每个会话的第一次热升级必然误熔断；
2. 熔断发生在回本之前 ⇒ 特性永远走不到上表最后三行那种白菜价升级；
3. `warm-miss` 的判据排在写入探针之前，把一次 `cacheWrite1h = cacheWrite`（**明确确认 1h
   生效**）的结算判成「冷热判据不可靠」，诊断完全反向；
4. 熔断是会话级的，学费每会话重交一次（有成本数据的几笔合计约 $7，零回报）。

**修订（本节为准）**：

- **新概念 `covered1h`**（`isPrefix1hCovered(state, now)`）：§4.3 的 cover 窗口仍开着
  **且**本会话至少已有一次升级结算出写入（`confirmed + unconfirmed > 0`）。写进
  `AdaptivePending`，决策时刻取值（`noteDecision` 读**武装前**的 state）。
  `invalidateAdaptive` 清 cover ⇒ 前缀漂移后的下一次升级重新算作过渡，与 M1 同构。
- **探针只判稳态**：`warm-miss` / `warm-write-too-expensive` 仅在 `pending.covered1h === true`
  时运行。过渡请求不判——「这条路由结构性地不认 1h」的检测交给 §4.3 的 `1h-ineffective`，
  它按构造观测的就是**交费之后**的状态（真正的二次确认）。
- **入场费单列预算**：过渡结算累计到 `feeWriteTokens` / `feeWriteUsd` / `feeUpgrades`，
  受 `feeBudgetTokens`（设置 `cacheTtl.adaptiveFeeBudgetTokens`，默认 600k）与
  `feeBudgetUsd`（`cacheTtl.adaptiveFeeBudgetUsd`，默认 $3）约束；边际预算 `W` 回归它本来
  的口径（稳态 1h 溢价）。不分列的话，P > W 的会话只是把瞬时误熔断的理由从 `warm-miss`
  换成 `write-budget`，问题原样存在。
- **入场费的美元口径不是 0.375**：过渡的反事实是「本可命中 5m（0.1×P）+ 只写增量」，
  实际是「整条 P 按 2.0× 重写」⇒ 边际 ≈ (2.0−0.1)/2.0 = **0.95 × `cost.cacheWrite`**
  （`ENTRY_FEE_MARGINAL_WRITE_FRACTION`）。沿用 0.375 会把学费低报约 2.5 倍。
- **交费要有时域**：未覆盖的热升级额外要求「可量化的时域」——`horizonOk`（长 bash/UI 门/
  足够剩余时域的 subagent）**或** S4 弱信号（本会话已证实有长空档，正是回本条件）；否则
  `fee-horizon-too-short`。费预算耗尽 ⇒ `fee-budget`，且**只挡新前缀**，稳态升级照常
  （学费已经交过，掐掉后续廉价升级等于把买到的东西扔掉）。
- **熔断语义不变**：`fee-budget` / `fee-horizon-too-short` 都是 decline 理由，不是熔断；
  熔断集合仍是 §4.2 的四个。

**上界修订**：每会话额外支出 ≤ 入场费预算（tokens `F` 或美元 `Fu`，先撞者为准，且允许最后
一次结算冲过线）+ §4.4 原有的 `0.75 × (W + P) × R`。`feeBudgetTokens = 0` 是新的整体回滚
开关（永不开新前缀 ⇒ 升级路径整体关闭），与 `adaptiveWriteBudgetTokens = 0` 并列。

**可观测性**：审计 `decision` 增加 `covered1h`，`reconcile` 增加 `pendingCovered1h` /
`feeWriteTokens` / `feeWriteUsd`；`/cache-ttl status` 新增独立一行
`adaptive entry fee: paid N× · <tok>/<budget> tok · $x/$y[ · exhausted (no new prefix)]`
——与边际预算分行呈现，把两者读成一个数正是本次修订要纠正的错误。

---

## 17. 现场事故复盘：保活与自适应互相拆台（2026-09-23，v1 后修订）

> 上文 §6「与保活的衔接」认定两个子系统正交，只在 gate #7（捕获到 1h 载荷就停 ping）处
> 交接。现场数据证明这个判断是错的：它们不是正交，而是**反相关**——保活最有价值的
> 长空档，恰好就是自适应判 cold 并整块升 1h 的时刻，而升级会把保活刚续上的缓存作废。

### 17.1 现场（session `01a0cf02-8569`，cloudrouter-anthropic / claude-opus-5）

```
16:51:08  1h 写入 7,799 tok      → 1h 链尾停在 prefix 248,705
16:51:52  5m 写入   301 tok      （adaptive: refresh-throttled）
16:52:15  5m 写入 3,046 tok      ← 最后一次真实请求，保活窗口开启
16:56:11  ping proven-hit read=249,006
17:00:11  ping proven-hit read=249,006
17:04:12  ping proven-hit read=249,006   ← 缓存被证明活着
17:05:21  subagent 完成通知触发 turn；decision: upgrade=true class=cold
                                       predictedDeltaTokens=252,052
17:05:30  read=11,356  write=239,709（全 1h）  $2.40  → write-budget 熔断
```

三次 ping 全部成功，最后一次距那次 turn 只有 69 秒。

### 17.2 实测事实：1h 请求只能读 1h 写过的前缀

同一会话内 **13/13 精确命中**：每一次 `cacheWrite1h > 0` 的请求，其 `cacheRead` 都**恰好**
等于上一个 1h 写入点（read + write），期间所有 5m 写入的增量对它不可见，会被按 1h 重写。
最直接的一例：16:51:03 的 5m 请求写了 2,064 tok，5 秒后 16:51:08 的 1h 请求 `cacheRead`
仍是 240,906 而非 242,970。

推论：**保活 ping 回放的是上一次真实请求的载荷**，而自适应绝大多数请求是 declined（5m），
所以 ping 续的一直是 **5m 命名空间**；真正花了钱的 1h 链（本会话 477,058 tok / $4.77）
因为 gate #7 的 1h 豁免而无人保活。本会话观测到的 1h 实际存活期落在 **7–13.6 分钟之间**
（7.0 分钟的间隔命中，13.6 分钟的间隔全丢），远不是一小时——§4.3 的 `ADAPTIVE_COVER_MS`
= 1h 这个假设在该路由上不成立。

### 17.3 四个缺陷与修复

| 编号 | 缺陷                                                                                                                                                            | 修复                                                                                                                                                                                                                                   |
| ---- | --------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| D1   | `decideAdaptiveTtl` 的 warm/cold 判据只看 `state.lastRequestStartedAt`，ping 不更新它 ⇒ 保活 13.5 分钟后仍判 cold，而 cold 分支的定价前提是「前缀反正已经死了」 | 新增 `AdaptiveDecideInput.lastProvenCacheReadAt`（来自 `CacheKeepaliveService.provenCacheReadAt()`），warm 窗口按 `max(lastRequestStartedAt, lastProvenCacheReadAt)` 计；cold 分支入口加硬闸 `cold-cache-alive`                        |
| D3   | `1h-ineffective` 探针以 `cacheRead > 0` 为成功判据 ⇒ 读了 11,356/252,052（4.5%，只是跨会话共享的 system/tools 块）被记成 `indirect1hConfirm`                    | 改为与**上一次结算的前缀**（新状态字段 `lastPrefixTokens`）比：`cacheRead < ADAPTIVE_COVER_HIT_FRACTION(0.5) × prevPrefix` 即判 collapse。锚定旧前缀而非当前前缀，所以「合法的大增量」不会误伤（同会话健康长空档命中率实测 81.5%–91%） |
| D4   | 结算按 `pending.covered1h` 这个**决策时刻的声明**分账 ⇒ 239,709 tok / $1.36 记进边际预算，一次请求打爆 $1 上限                                                  | 以账单为准：读崩塌即视为全量重写，走入场费预算                                                                                                                                                                                         |
| D5   | `closeWindowAccounting` 把该窗口记为 load-bearing、`avoidedMissTokens += 248,705`，而这三次 ping 的成果被下一条请求原地扔掉                                     | `onRealRequest` 把新捕获的 `shape.ttl1h` 透给会计；1h 后继请求 ⇒ 记入新增的 `discardedWindows` / `discardedPings`，不再冒充 load-bearing                                                                                               |

反事实（D1 修复后的同一现场）：判 warm ⇒ `tokensSinceLast1hWrite = 3,347 < refreshAfterTokens
16,000` ⇒ `refresh-throttled` ⇒ 保持 5m ⇒ 命中 249,006。**$0.14 取代 $2.40。**

回归测试：`tests/cache-ttl/adaptive-keepalive-incident.test.ts`（直接用现场真实数字），
`tests/service/cache-adaptive-signals.test.ts` 末尾的 `provenCacheReadAt` 接线三例。
每组都配了「不接 pinger ⇒ 仍走 cold」的对照，保证测试可证伪。

### 17.4 未决（留给数据）

D2 —— 「1h 在该路由上实际只活约 10 分钟」——本次**不改** `ADAPTIVE_COVER_MS`，也不取消
gate #7 的 1h 豁免。理由：D3 修完之后，`1h-ineffective` 才第一次具备真实的鉴别力，
cover 窗口内的长空档请求会自己把证据打出来（trip 或 confirm）。先收数据，再决定是
(a) 让保活按实测存活期去续 1h 前缀，还是 (b) 在该路由上直接关掉 adaptive。

---

## 18. 已覆盖前缀的续期也要重写 5m 尾巴（v1 后修订，§17.2 的直接推论）

§17.2 证实「1h 请求只能读到上一个 1h 写入点」。§16.3 只把它用在了**首次**升级（入场费），
却漏了**已覆盖前缀的续期**：升级之后被 decline 的请求都是 5m，它们写下的增量构成一段
1h 请求看不见的 **5m 尾巴**，下一次续 1h 必须把它连同新增量一起按 1h 重写。

**取证**（同一会话 `01a0cf02`，逐次续期；尾巴 = 上次 1h 结算后所有 5m 写入之和）：

```
pred Δ=1,829  尾巴=15,532 → 实际 1h 写 17,094
pred Δ=8,992  尾巴=21,194 → 实际 1h 写 22,460
pred Δ=1,183  尾巴=5,098  → 实际 1h 写 7,109
```

**缺陷**：warm 分支的 `predictedDeltaTokens = ledger.cacheWrite`（只含 Δ），于是
(1) `delta-too-large` 闸门量的是 Δ，任意大的尾巴都能放行；(2) M2 探针预测值偏低，只靠地板兜底；
(3) 美元边际一律按 0.375 计，但尾巴的反事实是「5m 下本可 0.1× 读中」，真实边际是 0.95；
(4) 升级请求**自身**的 1h 写入被计进 `tokensSinceLast1hWrite`，尾巴被高估、续期节流提前放行。

**修订（本节为准）**：

- `tokensSinceLast1hWrite` 的语义收紧为「上一个 1h 写入点之后的 5m 写入量」，即 1h 请求读不到的尾巴。
- 已覆盖（`covered1h`）的 warm 升级：预测 1h 写入 = `tokensSinceLast1hWrite + ledger.cacheWrite`，
  `delta-too-large` 以此判；未覆盖（入场费路径）仍以 Δ 判，由入场费预算/时域兜底。
- `AdaptivePending.tail5mTokens` 记录决策时的尾巴。结算时：
  - 已覆盖结算的美元边际按 `(0.95 × min(尾巴, W) + 0.375 × (W − 尾巴部分)) / W` 计
    （`TAIL_REWRITE_MARGINAL_WRITE_FRACTION`）；
  - 尾巴计数：`cacheWrite1h > 0` ⇒ 1h 写入点前移，新尾巴 = `cacheWrite − cacheWrite1h`（通常 0）；
    `cacheWrite1h === 0`（升级未落地、实际按 5m 发出——现场确有 `w1h=0` 的「升级」）⇒ 恢复决策前的尾巴；
    未上报拆分 ⇒ 按已落地处理（与旧行为一致）。

回归测试：`tests/cache-ttl/adaptive-state.test.ts` 末尾的「§18」组（现场数字，含未覆盖对照）。

未决：现场 `w1h=0` 的「升级」为何没按 1h 发出，尚未定位。

---

## 19. 验证驱动修订：与保活按空档择一、谱系感知、入场费只认强信号（2026-09-25）

来源：`verification-2026-09-25.md`（经济学仿真 `tests/cache-ttl/adaptive-economics.test.ts` + 17 个现场会话）。
规则层面全部符合设计，但**叠加保活（生产默认）时重复付费**、现场净亏 $9–12。本节为准，覆盖 §0.2 / §3.3 S4 /
§4.2 / §6 中与之冲突的表述。回归测试：`tests/cache-ttl/adaptive-verification-fixes.test.ts`（现场数字）、
`tests/integration/cache-adaptive.test.ts` 末例（真实 stack 接线）。

| #   | 问题                                                                                                                                                                          | 修订                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        |
| --- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| F1  | ≤44min 的等待保活已覆盖，adaptive 仍付入场费 + 续期；前缀被 1h 覆盖后 ping 仍续 5m 链 ⇒ 双付（仿真 adaptive+ka $4.86 vs 仅保活 $3.69）                                        | **双向仲裁**。(a) `AdaptiveDecideInput.keepaliveHorizonMs`（= `keepaliveGapHorizonMs` = maxPings×interval + TTL，默认 49min；保活关闭/会话熔断/非 tui·rpc/非 anthropic/非流式 ⇒ `undefined`）：定义时，**开新前缀**（未覆盖 warm 与 cold）须 gap 环里已有 > 该时域的空档，否则 `keepalive-covers`；已覆盖续期不受影响。(b) 保活 tick 新门 #11.5 `adaptive-1h`（terminal）：`adaptiveCoversPrefix` 成立（无熔断、无未结算升级、至少一次 `cacheWrite1h>0` 确认、cover 窗口内、5m 尾巴 ≤ `refreshAfterTokens`）时本窗口不 ping。1h 提前死 ⇒ 下一次长空档触发 `1h-ineffective` ⇒ 谓词转假 ⇒ 恢复 ping，损失一次 |
| F2  | `1h-ineffective` 与 cover 不区分前缀谱系：唤醒轮前缀更短（01a0d2f9，83,691 < 87,393）或 warm 窗口内整前缀失效（01a0d2e4 10:48:34）后，长空档 miss 被判「路由不认 1h」，误熔断 | **漂移检测**：非升级结算若「前缀缩短」或「`lastGapMs ≤ TTL` 且读塌缩」⇒ 视为前缀漂移：清 `oneHourCoverUntil`、`driftCoverClears += 1`、本次不做 1h 判决。升级自身的塌缩结算（入场费形态）不算漂移                                                                                                                                                                                                                                                                                                                                                                                                           |
| F3  | 只有 S4 弱信号也能付入场费（01a0d24f $2.06，此后无长空档；5/9 次入场费未回本）                                                                                                | 未覆盖 warm 升级必须 `horizonOk`（强信号 + 量化时域）；S4 只用于已覆盖前缀的续期                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            |
| F4  | cold 升级按 0.95 记入场费，但其反事实（前缀已死，5m 也要全写）边际只有 0.375 ⇒ 多记约 2.5×（仿真 $1.87 vs $1.35）                                                             | `entryFeeFraction`：cold ⇒ `MARGINAL_WRITE_FRACTION`(0.375)，warm 过渡 ⇒ 0.95                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               |
| F5  | 已覆盖升级读塌缩时 D4 记作入场费，热探针却仍按 1h→1h 判（01a0d188 04:04:55 同时记费并触发 `warm-write-too-expensive`）                                                        | 热探针条件加 `!readCollapsed`；读到了前缀却超写的稳态违例照常熔断                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           |

仿真结果（修订后）：等 20min（ping 时域内）adaptive+ka = 仅保活 $3.69（0 次升级，`keepalive-covers`）；等 60min 且 1h
真活 60min：adaptive+ka $5.18，低于 auto $5.46 与仅保活 $8.45（保活在超出时域的空档上空转 11 次）；1h 只活 10min：
多花不超过一次入场费即熔断。记账误差 ≤ 3%。

未决：唤醒轮与用户轮的 system prompt 分叉（谱系分裂的主因）已由 91a2878 wake replay 修复，现场样本几乎全部早于它；
F1–F5 与 wake replay 同时生效后需要重采现场数据，届时再评估 S4 的剩余价值与 `ADAPTIVE_COVER_MS`。

### 19.1 独立评审修订（gpt-5.6-sol 评审打回，同日）

评审结论 REJECT（0 Blocker / 4 Major / 2 Minor）：F1 的可用性判断与 F2 的谱系判断仍可能**比修复前更差**。裁决与修订：

| #   | 评审意见                                                                                                                  | 裁决     | 修订                                                                                                                                                                                                                                                                                                                      |
| --- | ------------------------------------------------------------------------------------------------------------------------- | -------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| R1  | `gapHorizonMs()` 是静态能力值：前缀 < `keepaliveMinPrefixTokens` 时保活不 ping，adaptive 却拒升                           | 部分采纳 | `gapHorizonMs(prefixTokens)`：本次请求实测前缀（未证实 = 0）低于门槛 ⇒ `undefined`。窗口 ping 预算与单次 unproven 不查：二者都随下一次真实请求开启的新窗口重置——而 horizon 描述的正是那个窗口；连续失败走会话熔断（已 ⇒ `undefined`）                                                                                     |
| R2  | `adaptive-1h` 是 terminal，却以乐观的 1h cover 为依据；1h 若 ~27min 就死，27–44min 的空档由「ping 可覆盖」变成整前缀 miss | 采纳     | 让位必须有**证据**：`adaptiveCoversPrefix(…, horizonMs)` 追加 `max1hSurvivalMs ≥ horizon`（本会话已观测到被覆盖请求在 ≥ 保活时域的空档后读中 1h 条目，由 1h 判决的 hit 分支记录，跨 /reload 恢复）且剩余 cover ≥ horizon。无证据时照常 ping。代价：60min 空档场景 adaptive+ka 从 $5.18 回到 $5.87（仍远低于仅保活 $8.45） |
| R3  | pending/ledger 只按 `entrySeq ≥ minEntrySeq` 关联，F2 又读全局 `lastGapMs`                                                | 部分采纳 | 会话内请求串行、reconcile 先于下一次决策，错配是既有的理论风险（非本次引入）。低成本加固：`lastDecisionEntriesLength`，账本不属于最新一次决策的请求时照常记账，但**不做漂移/1h 判决**                                                                                                                                     |
| R4  | F2 只是启发式：合法缩短会误清 cover；前缀变长的谱系切换仍会误熔断                                                         | 采纳     | **谱系键** `payloadLineageKey`（system 文本摘要 + 工具列表 + thinking 配置，与保活指纹同源）：`isPrefix1hCovered` 要求当前请求与 cover 同谱系；异谱系请求的 miss 不判决、也不清对方谱系的 cover（交替谱系会回来）；启发式漂移改为「读塌缩 且（前缀缩短 或 warm 窗口内）」——只缩短不算                                     |
| R5  | `driftCoverClears` 不随 /reload 恢复                                                                                      | 采纳     | read-back 恢复 `driftCoverClears` 与 `max1hSurvivalMs`（取历史最大值）；谱系/cover 等前缀相关瞬态仍不恢复                                                                                                                                                                                                                 |
| R6  | 测试注入静态 horizon，缺服务/动态场景                                                                                     | 采纳     | 新增：服务侧 `gapHorizonMs` 前缀门槛、dep 收到的 horizon、R2 证据/剩余 cover、R3、R4 各分支、`payloadLineageKey`、read-back；仿真里 horizon 只在前缀 ≥ 20k 时传入。R1–R4 共 7 个变异全部被用例击杀                                                                                                                        |

真机冒烟（隔离 worktree + 临时 agent 目录，claude-sonnet-5）：后台 bash job 运行时决策为 `keepalive-covers`、
`keepaliveHorizonMs=2940000`，全程无 1h 写入，job 结束后的唤醒轮（76s 空档）命中缓存。

### 19.2 第二轮评审修订（同一评审者复审，REJECT：3 Major / 3 Minor）

| #   | 评审意见                                                                                 | 裁决         | 修订                                                                                                                                                                                       |
| --- | ---------------------------------------------------------------------------------------- | ------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| R7  | R1 没看**当前**请求能否被 ping（非流式请求的下一窗口保活在 #7.5 停止）                   | 采纳         | `AdaptiveDecideRequest.streaming`（`before_provider_request` 直接读 `payload.stream`）；非流式 ⇒ 不查 horizon。保活侧删掉「上一窗口 capture 非流式」的检查——它描述的不是下一请求开启的窗口 |
| R8  | 谱系键用「长度+首尾 64 字符」与工具名，同长中段改动（记忆时间戳）/工具 schema 变化会碰撞 | 采纳         | `payloadLineageKey` 改为全文 FNV-1a：完整 system 文本、完整工具定义 JSON、thinking 配置；保活 G7 指纹不变                                                                                  |
| R9  | `max1hSurvivalMs` 是会话级标量，换模型/路由后证据被复用                                  | 采纳         | 证据绑定路由 `provider\|model`（账本新增可选 `providerId`）：记录时换路由即替换、不合并；`adaptiveCoversPrefix` 要求证据路由 = 最近结算路由；read-back 成对恢复，缺路由的旧证据不恢复      |
| —   | 证据产生时剩余 cover 往往不足 horizon，让位要等下一次覆盖续期                            | 保留（有意） | 若在命中时延长 cover，需假设该代理「命中刷新 TTL」，未经实测；保守起见不延长。新增真实调用链用例 `R2 flow` 钉死「证据 → 仍不让位 → 续期后让位」                                            |
| —   | R3 边界                                                                                  | 补测         | `-1` 初值与相等（正常情形：新 assistant 条目恰好落在 `entriesLength`）边界用例                                                                                                             |

R7–R9 与 R3 边界共 6 个变异全部被击杀。
