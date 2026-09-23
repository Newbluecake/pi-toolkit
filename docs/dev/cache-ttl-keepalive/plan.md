# 提示词缓存保活 ping（cache-ttl keepalive）实施方案

状态：**v2 施工口径（已按 `review.md` 的 4 个 Blocker + M1–M6 + m1–m3 修订）**。
配套调研 `explore.md`（装配管线取证）、评审 `review.md`。现状代码 `src/cache-ttl/cache-ttl.ts`（101 行）。
本文档给出可直接照着写代码的设计，**每个决策都附理由与被否决的备选**。

---

## 修订记录

### v2（针对首轮评审的 B1–B4 / M1–M6 / m1–m3）

| 评审条目                        | 改了什么                                                                                                                                                                                                                                                                                                                                                                | 改在哪一节                             |
| ------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------- |
| **B1 跨会话捕获竞态**           | 新增会话身份三层防护：① 调度器随 stack 诞生并在同一条赋值语句变可达（窗口结构性消失）；② 捕获记录携带 `sessionId` + 服务实例自持 `ownSessionId`/`generation`，不匹配即静默丢弃并计入 `dropped.sessionMismatch`；③ 每个 `await` 返回点重查 `disposed` + 会话身份；stale ctx 读取一律 try/catch，抛出即自我 dispose                                                       | §1 I-K6、§2.3、§2.4、§8.2、§8.4、§13.4 |
| **B2 架构归属 → stack service** | 调度层改为 `src/service/cache-keepalive.ts`，在 `buildSessionStack` 内构造、作为 `Stack.keepalive` 暴露、由 `previousKeepalive` 句柄在下次 build 顶部 dispose + `session_shutdown`/防御性 dispose 兜底；定时器改用 `systemClock.setTimer`（已 unref）自续期，抄 `UsageBroadcaster`。删除原 §2.1「否决 stack.ts」表与 HUD 三件套方案；文件清单/施工顺序/测试矩阵同步改写 | §2 全节、§8 全节、§12 T7/T11、§14、§13 |
| **B3 熔断覆盖不全**             | 判定口径改为「**只有 `cache_read > 0 && cache_creation === 0` 才算成功**」；其余（无 usage、双 0、accepted-then-disconnect、超时、abort、HTTP 任意错误、网络错误）一律 `unproven`，计入**会话级**计数器，不因真实请求重置；`provenWrite ≥ 1`、`consecutiveUnproven ≥ 2`、`unprovenTotal ≥ 3` 任一命中即整会话永久停用                                                   | §1 I-K7、§7.5、§5.3、§13.2、§13.5      |
| **B4 配额（已裁决降级）**       | 按用户裁决**移除**全部配额感知设计（无 `Retry-After`、无 402/403/429 分类、无每日上限）；只保留「连续 2 次 unproven 即整会话停」这条可靠性卫生，并给出 N=2 的成本推导。配额风险在风险登记中标注为「用户已裁决为可接受」，不加护栏                                                                                                                                       | §7.5、§10.2、§15 R7                    |
| **M1 成本口径混用**             | §0.3 重写为三种基准分列（无 ping 的最终真实请求 / n 次成功 read 后的真实请求 / 下一次必 miss 时 5m→1h 的**边际** 0.75P），明确 `n < 11.5` 只约束 ping 预算、**不**自动推导「该升级 1h」；升级改为独立判据                                                                                                                                                               | §0.3、§6.3                             |
| **M2 短空档纯亏（已接受）**     | 不加严武装、不加成本上限（用户裁决）；改为**事后可审计**：每个窗口关闭时按「无 ping 时缓存是否还活着」分类为 `load-bearing` / `unnecessary`，计数进会话统计、审计条目和 `/cache-ttl status`                                                                                                                                                                             | §9.2、§9.4、§13.1                      |
| **M3 前缀估算高估**             | 弃用 `getContextUsage()` 与 `JSON.stringify/4`，改用**实测下界**：最近一条 assistant 消息 `usage.cacheRead + usage.cacheWrite`（pi 官方账本）；拿不到即**不 ping**，并记录 `prefixSource` 到审计与状态                                                                                                                                                                  | §3.4、§5.4 G6、§13.1                   |
| **M4 指纹覆盖不足**             | 区分「安全关键」与「有效性关键」两类漂移；指纹扩到 `sessionId/provider/api/modelId/baseUrl/authHeaderKeys/breakpointPath/thinkingDigest/systemDigest/toolsDigest/messageCount`，ping 前逐项比对，任何未知变化即 invalidate；新增 `before_agent_start` systemPrompt 摘要漂移作废                                                                                         | §3.3、§5.2 #8、§13.1                   |
| **M5 估算为 0 会误导**          | 费率缺失时**禁止**显示 `$0`，显示「费用未知」；状态栏/命令一律同时给出实测 cache-read tokens、请求次数、`estimated/unknown` 标注、失败与禁用状态；RPC/headless 走审计条目 + `/cache-ttl status`                                                                                                                                                                         | §9.1、§9.3                             |
| **M6 测试矩阵漏安全路径**       | 新增/改写：stack dispose 释放定时器与 socket、holder 为空静默跳过、跨会话 token 失配丢弃、accepted-then-disconnect、无 body/无 usage、连续真实请求重试不复活、第三方后置 handler、provider/baseUrl 变化、真实请求与 ping 同时开始的抢占、auth await 后越界                                                                                                              | §13.2–§13.6                            |
| **m1 配置项数量不一致**         | 统一为 **5 个 spec**（含 `TIME_SETTING_MS_PATHS` 的 ms path ↔ 展示 key 映射测试）                                                                                                                                                                                                                                                                                       | §10.1、§13.5                           |
| **m2 auth 等待后越界**          | `getApiKeyAndHeaders` 之后、POST 之前**再查一次** `now < aliveUntil − margin`；auth 等待计入窗口预算                                                                                                                                                                                                                                                                    | §7.4、§8.4、§13.2                      |
| **m3 unref ≠ 释放**             | 明确 reader/socket/abort listener 的释放契约与断言项（成功早停、超时、shutdown abort、非 2xx 四条路径）                                                                                                                                                                                                                                                                 | §7.4、§11、§13.2                       |

> 异议（一行，按要求不再论证）：我原本认为纯/脏分层应把调度器留在 `src/cache-ttl/`，现按上游裁决改为 stack service，并已确认它同时消灭了 B1 的竞态窗口。

### v3（针对 v2 复核，限定范围补丁）

| 复核条目                               | 改了什么                                                                                                                                                                                                                                                                                                                                                                        | 改在哪一节                                                          |
| -------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------- |
| **B5 + B3 残留：窗口代际守卫**         | 新增 `windowEpoch`：窗口因真实请求 / `invalidate` / 会话或实例变更而重置时自增；ping 开始时绑定 `pingEpoch`，`runPing()` 的**每个 await 返回点**与**任何 reducer 写入之前**都校验 epoch；失配 ⇒ 静默丢弃、**不计 proven 也不计 unproven**、不回写任何窗口字段、不动 `aliveUntil`、不动 breaker 计数器。并写明 abort 与迟到返回（reject / 已拿到 body 两条路径）的交互语义与取舍 | §1 I-K8、§5.3、§7.5「abort 与迟到返回」、§8.2/8.4、§11、§13.3/§13.6 |
| **B1 残留：服务实例身份**              | service 实例分配不可复用 `instanceId`；`CapturedRequest` 携带 `instance`；`accept()` 四重校验（未 dispose + sessionId + instanceId + 「本实例仍是 holder 上的当前实例」`isCurrent()`）；失配计入 `dropped.instanceMismatch` 并在 `/cache-ttl status` 暴露                                                                                                                       | §1 I-K9、§2.3、§2.4、§8.1/8.2、§9.4、§13.3/§13.6                    |
| **锚点订正**                           | `src/index.ts:443` → **442**；删除错误引用 `src/stack.ts:461-470`，换成真正对应的 `src/stack.ts:99-103`（模块级 handoff 只覆盖同模块换会话）+ `src/index.ts:458-466`（shutdown 侧注释，466 行是 `stack.fleetWidget?.dispose()`）；`src/stack.ts:1073` → **1074 之后**；`src/stack.ts:1237+` → **1239**                                                                          | §2.2、§2.4                                                          |
| **裁决不修：漏发 shutdown 的在途释放** | 按上游裁决**不加任何机制/hook**，仅在风险登记新增一条「漏发 shutdown 且此后无 build 时，在途连接释放依赖进程退出——已评估为可接受残余风险」                                                                                                                                                                                                                                      | §15 R9                                                              |

---

## 0. 背景、目标与成本模型

### 0.1 问题

主会话把活儿派给 subagent / 后台 bash 之后，自己可能几十分钟不发任何 provider 请求。
Anthropic 的 `cache_control: {type:"ephemeral"}` 默认 5 分钟 TTL，等后台干完活主会话恢复
时，前缀早已过期 → 整段前缀按 1.25× 重新写入。

### 0.2 方案

主会话空闲且确有后台工作时，周期性地把**上一次真正发出去的 payload 原样重放**，利用
Anthropic「cache read 免费刷新 TTL」的特性给缓存续命。

外部事实（已验证，直接引用，不再复核）：

- 官方文档：“The cache is refreshed **for no additional cost** each time the cached content is used”；
  “The lifetime is measured from the **start** of the request that writes or reads the entry”
  —— 生成耗时计入寿命，所以间隔必须留余量，且计时锚点是**请求开始时刻**而不是完成时刻。
- 官方 skills 仓库 `claude-api/shared/prompt-caching.md`：5–60 分钟的空档推荐
  “保持 5m TTL，空闲时在过期前重发上一个请求”，而不是付 2× 写入转 1h。
- 计价倍率：5m 写 1.25×、1h 写 2×、cache read 0.1×（Claude Fable 5.1 read 为 0.025×）。

### 0.3 成本模型（M1 修订：三种基准分列，不混用）

设 P = **可复用前缀**的 token 数。所有数字都以「P 的倍数」表示，**基准是同一场景下
最终那次真实请求本来也要付的东西**，三种情景分别算：

| 情景                                       | 支出                                   | 说明                                           |
| ------------------------------------------ | -------------------------------------- | ---------------------------------------------- |
| **A. 不 ping，空档超过 TTL**               | `1.25P`（5m 全量写）                   | 最终真实请求踩 miss                            |
| **B. 不 ping，空档没超过 TTL**             | `0.1P`（read）                         | 什么都不用做，缓存自己活着                     |
| **C. ping n 次成功，最终真实请求命中**     | `0.1P × n` + `0.1P`（最终请求的 read） | ping 把 A 变成 B，代价是 n 次 read             |
| **D. 下一次必 miss 时，把那次写升级成 1h** | `2P`（1h 全量写）                      | 与 A 同基准，**边际差额 = 2P − 1.25P = 0.75P** |

由此得到三个**互相独立**的判据：

1. **ping 预算上限**：C 优于 A ⇔ `0.1n + 0.1 < 1.25` ⇔ `n < 11.5`。
   （评审确认此推导正确。Fable read 0.025× ⇒ `n < 49`，但统一取最保守的 11.5，理由见 §6.2。）
2. **短空档纯亏**：若实际落在 B（空档 < TTL），C 比 B 多花 `0.1P × n`。这是**默认开启的已知代价**，
   用户已裁决接受；方案只负责让它**事后可量化**（§9.2 的 `load-bearing` / `unnecessary` 分类）。
3. **1h 升级判据（不由 n 推导）**：只有在「这次真实请求**必定**是全量写」时，才比较
   `1.25P`（5m 写）与 `2P`（1h 写）：边际 `0.75P` 买下一小时覆盖。它是否值得取决于
   **预期还会发生多少次长空档**，与 ping 次数无关 ⇒ 做成独立开关
   `cacheTtl.keepaliveUpgradeAfterBudget`，默认开但可关（§6.3）。

订阅制（Claude Pro/Max OAuth）用户没有按 token 计费，ping 消耗额度而非美元；比值相同，
配额问题按 §15 R7 的用户裁决处理。

### 0.4 非目标（v1 明确不做）

- 不给 1h TTL 的会话做保活（§5.4 G5）。
- 不把带外 usage 回填进 HUD 的 token/cost 累计（技术上做不到，§9.3）。
- 不做 tokenizer；前缀规模只用**实测下界**，测不到就不 ping（§3.4）。
- 不做配额感知（`Retry-After`/429 分类/每日上限）——用户已裁决（§15 R7）。
- 不在子会话（subagent 会话）里启用（HOST_KEY 守卫天然排除，§2.6）。

---

## 1. 术语与不变量

| 术语                     | 含义                                                                                    |
| ------------------------ | --------------------------------------------------------------------------------------- |
| **捕获（capture）**      | 在 `before_provider_request` 里记下“本次真正发出去的 payload”及其指纹                   |
| **窗口（window）**       | 从一次真实请求开始，到下一次真实请求/失效为止；ping 预算按窗口计                        |
| **武装（armed）**        | 存在“会回来用同一前缀”的理由：后台 subagent / 后台 bash / 前台工具阻塞 / ui_prompt 阻塞 |
| **存活期（aliveUntil）** | `lastReadStartedAt + 300s`，缓存条目被推定仍然存在的截止时刻                            |
| **proven hit**           | 回包 `cache_read > 0 && cache_creation === 0`——唯一被认可的成功                         |
| **unproven**             | 除 proven hit 以外的一切结果（含失败、无 usage、断连）——**都按“可能已发生写入”处理**    |

**不变量（改代码时必须保住）**

- **I-K1（绝不制造写入）**：ping 必须发生在 `now < aliveUntil − margin` 内，payload 与上一次真实
  请求**逐字节同构**（除 §7.2 允许的 `max_tokens` 下调）。宁可不 ping，绝不因前缀不匹配触发全量写。
- **I-K2（预算硬顶）**：每窗口 ping 次数 ≤ `maxPings`，无绕过路径。
- **I-K3（可见）**：会话内发过 ping ⇒ 状态栏与 `/cache-ttl` 必须显示次数、实测 tokens、
  费用（未知时显示“费用未知”，**禁止显示 $0**）。
- **I-K4（零悬挂）**：定时器走 `systemClock.setTimer`（已 unref）；dispose 清定时器 + abort 在途
  ping + 释放 reader/listener；`/reload` 不残留；ping 失败静默、不重试、不阻塞 pi 任何流程。
- **I-K5（不篡改用户显式设置）**：不改 `cacheTtl.mode` 三档语义；唯一 TTL 升级路径是 §6.3 的
  一次性 `upgradePending`，且仅在 `mode === "auto"` 生效。
- **I-K6（会话身份，B1）**：每条捕获、每次事件、每个 tick、**每个 `await` 返回点**都必须验证
  `sessionId` 与服务实例身份仍是当前会话；不匹配 ⇒ 静默丢弃并计数。stale ctx 的任何读取都
  try/catch，抛出即自我 dispose。
- **I-K7（只认 proven hit，B3）**：会话级 breaker 由 `unproven` 计数驱动，**不因真实请求重置**；
  `provenWrite ≥ 1` 或 `consecutiveUnproven ≥ 2` 或 `unprovenTotal ≥ 3` ⇒ 整会话永久停用。
- **I-K8（窗口代际，B5）**：每次 ping 在发起时绑定当时的 `windowEpoch`；`runPing()` 的每个
  `await` 返回点、以及**任何 reducer 写入之前**都必须校验 epoch 未变。epoch 失配 ⇒ 静默丢弃：
  **不计 proven、不计 unproven、不回写任何窗口字段、不动 `aliveUntil`/`nextPingAt`、
  不动 breaker 计数器**。迟到的 ping 结果永远不能影响它已经不属于的那个窗口。
- **I-K9（实例身份，B1）**：service 实例持有不可复用的 `instanceId`；`CapturedRequest` 携带它，
  `accept()` 必须同时满足「未 dispose」+「sessionId 相同」+「instanceId 相同」+「本实例仍是
  holder 上的当前实例」。任一不满足 ⇒ 静默丢弃并计入 `dropped.instanceMismatch`。

---

## 2. 架构与生命周期归属（问题 8｜B1 + B2 修订）

### 2.1 两层切分（上游已拍板，按此施工）

```
           ┌──────────────────────────── activate() 级（一次注册，永久存活）────────────────────────────┐
           │  src/cache-ttl/cache-ttl.ts                                                              │
 provider  │   before_provider_request handler：mode 三档改写 → 捕获最终 payload+指纹                   │
 请求  ────►│        │                                                                                 │
           │        └─ port = deps.keepalive()   // 读 holder：() => holder.current?.keepalive          │
           │              └─ port?.noteRequest({ sessionId, payload, fingerprint, prefix })            │
           │  /cache-ttl 命令（mode + keepalive 开关 + status 报告）                                    │
           └───────────────────────────────────────────┬──────────────────────────────────────────────┘
                                                       │ 仅通过 KeepalivePort（pi-free 接口）
           ┌───────────────────────────────────────────▼──────────────────────────────────────────────┐
           │  src/service/cache-keepalive.ts  ——  **stack service**（与 watchdog / reaper 并列）        │
           │   在 buildSessionStack 内构造 · Stack.keepalive 暴露 · previousKeepalive 句柄下次 build 顶部 │
           │   dispose · session_shutdown / 防御性 dispose 兜底                                         │
           │   定时器（systemClock.setTimer，自续期、已 unref）· 预算 · 熔断 · 实际发请求 · 状态栏/审计    │
           │   后台忙判定：query.list() + bashJobs.backgroundJobCount()（**不走 readBackgroundStatus**）  │
           └───────────────────────────────────────────┬──────────────────────────────────────────────┘
                                                       │ 调用纯层
           ┌───────────────────────────────────────────▼──────────────────────────────────────────────┐
           │  src/cache-ttl/keepalive-state.ts（pi-free 纯）  ：类型/常量/指纹/evaluateTick/reducer/文案 │
           │  src/cache-ttl/ping-client.ts   （pi-free 纯）  ：payload→request 构造 + 裸 POST + 早停解析 │
           └──────────────────────────────────────────────────────────────────────────────────────────┘
```

- **策略 + 载荷层留在 `src/cache-ttl/`**：mode 三档状态机、payload 改写、捕获与指纹、
  ping 请求构造（纯函数 `payload → request`）、`/cache-ttl` 命令。**无 fleet 依赖**：只 import
  `keepalive-state.ts` 里的 `KeepalivePort` 接口；`subagent` 相关设置全关时这层照常工作
  （`deps.keepalive()` 返回 `undefined` ⇒ 全部 no-op）。
- **调度层是 stack service**：定时器、调度状态、预算、熔断、真正发请求全在
  `src/service/cache-keepalive.ts`，生命周期 100% 由 stack 托管。
- **文件放 `src/service/` 而不是 `src/cache-ttl/`**：`src/service/` 正是 stack 自有服务的所在
  （spawn/query/run-registry/background-status），放这里让「这是一个 stack service」在目录层面
  也不可误读，同时保证 `cache-ttl → service` 的 import 方向单向（service 依赖 cache-ttl 的纯层，
  反向绝无 import，无环）。

### 2.2 stack 接线（file:line 级）

| 位置                                                     | 改动                                                                                                                                                                                                                                                                                                                                            |
| -------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `src/stack.ts:99-116`（`previous*` 句柄区）              | 新增 `let previousKeepalive: CacheKeepaliveService \| undefined;`，注释照抄 `previousUsageBroadcaster`（`stack.ts:105-106`）的“same rebuild-dispose pattern”口径                                                                                                                                                                                |
| `src/stack.ts:445-474`（`Stack` 接口）                   | 新增 `/** 提示词缓存保活调度器；settings.cacheTtl.keepalive=false 时缺席。 */ keepalive?: CacheKeepaliveService;`                                                                                                                                                                                                                               |
| `src/stack.ts:678-694`（build 顶部 dispose 块）          | 追加 `previousKeepalive?.dispose(); previousKeepalive = undefined;`                                                                                                                                                                                                                                                                             |
| `src/stack.ts:1074` 之后（`query`、`bashJobs` 都已存在） | 构造 service（见下方代码），并 `previousKeepalive = keepalive;`                                                                                                                                                                                                                                                                                 |
| `src/stack.ts:1239`（return 字面量起点）                 | `...(keepalive ? { keepalive } : {})`                                                                                                                                                                                                                                                                                                           |
| `src/index.ts:164`                                       | `wireCacheTtl(pi, settings, { keepalive: () => holder.current?.keepalive })`                                                                                                                                                                                                                                                                    |
| `src/index.ts:433-439`（防御性 dispose）                 | 追加 `holder.current.keepalive?.dispose();`                                                                                                                                                                                                                                                                                                     |
| `src/index.ts:455-466`（`session_shutdown`，455 起）     | 追加 `stack.keepalive?.dispose();`（紧邻 `src/index.ts:466` 的 `stack.fleetWidget?.dispose()`）——同理：`previousKeepalive` 是模块级句柄，只覆盖同模块换会话；`/reload` 重新 import 模块（jiti `moduleCache:false`）后旧句柄不可达，必须由 shutdown 兜底。依据：`src/stack.ts:99-103`（handoff 注释）+ `src/index.ts:458-466`（shutdown 侧注释） |

```ts
// src/stack.ts（query / bashJobs 之后）
const keepalive = settings.cacheTtl.keepalive
  ? createCacheKeepaliveService({
      clock: systemClock, // 已 unref（core/clock.ts:12-22）
      ctx, // 构建期 ctx：会话身份来源
      sessionId: currentSessionId(ctx), // stack.ts:324-330 既有 helper
      settings: settings.cacheTtl, // 引用传递：数值型 knob 可热改
      // B2 要求：直接用 stack 自己的数据源，不绕 Symbol.for 全局
      backgroundBusy: () =>
        query.list().some((s) => ["queued", "starting", "running", "stopping"].includes(s.status)) ||
        (bashJobs?.backgroundJobCount() ?? 0) > 0,
      readLatestUsage: () => readLatestAssistantCacheTokens(ctx), // §3.4
      fetchImpl: globalThis.fetch,
      appendEntry: (type, data) => pi.appendEntry(type, data),
      emit: (channel, payload) => pi.events.emit(channel, payload),
    })
  : undefined;
previousKeepalive = keepalive;
```

### 2.3 holder 接缝的类型签名（B2 要求明确写出）

```ts
// src/cache-ttl/keepalive-state.ts —— pi-free，cache-ttl 只认识这个接口
export interface CapturedRequest {
  /** 捕获时刻该会话的 id（`ctx.sessionManager.getSessionId()`，读不到时为 ""）。 */
  sessionId: string;
  /** 捕获时从 `port.instanceId` 读到的、该 service 实例不可复用的 id（I-K9）。 */
  instance: string;
  /** 真正发出去的那一份 payload 的独立副本。 */
  payload: Record<string, unknown>;
  fingerprint: CaptureFingerprint; // §3.3
  shape: PayloadShape; // §3.2
  /** 实测前缀 token 下界 + 来源；unknown 时不 ping（§3.4）。 */
  prefix: { tokens: number; source: "usage" } | { tokens: 0; source: "unknown" };
  capturedAt: number;
}

export interface KeepalivePort {
  /** 本实例不可复用的 id：捕获钩子读它填进 `CapturedRequest.instance`（I-K9）。 */
  readonly instanceId: string;
  /** 捕获入口；已 dispose / 会话或实例不匹配 / 非 holder 当前实例 ⇒ 静默丢弃。 */
  noteRequest(captured: CapturedRequest): void;
  /** 真实请求响应结束（message_end / tool_execution_start / turn_end / agent_end / agent_settled）。 */
  noteRequestSettled(sessionId: string, instance: string): void;
  /** 显式作废本窗口捕获（compaction / 模型切换 / 系统提示漂移 / payload 形状异常…）；会自增 windowEpoch。 */
  invalidate(reason: InvalidateReason, sessionId?: string, instance?: string): void;
  /** §6.3：消费一次「下一次必写请求升级成 1h」的许可。 */
  consumeUpgrade(sessionId: string, instance: string, now?: number): boolean;
  /** `/cache-ttl status` 的数据源（纯数据，渲染在 cache-ttl 层）。 */
  report(): KeepaliveReport;
  /** `/cache-ttl keepalive on|off`（仅当前进程）。 */
  setEnabled(on: boolean): void;
}

// src/cache-ttl/cache-ttl.ts
export interface CacheTtlDeps {
  persist?: (mode: CacheTtlMode) => string | undefined;
  /** holder read-through：index.ts 传 `() => holder.current?.keepalive`。 */
  keepalive?: () => KeepalivePort | undefined;
}
```

**holder 为空时的行为（必须实现成这样）**：

- `deps.keepalive` 未注入（子会话 / 单测 / `subagent` 相关全关）或 `holder.current` 为
  `undefined`（activate 完成但首个 `session_start` 未完成）或 `holder.current.keepalive` 缺席
  （`cacheTtl.keepalive=false`）⇒ 捕获调用整体跳过，**不抛、不 warn、不记状态**，
  `before_provider_request` 的返回值与今天完全一致。
- 写法：`const port = deps.keepalive?.(); if (!port) return;`——单点、可测（§13.4）。
- `consumeUpgrade` 同理：port 缺席 ⇒ 视作 `false`，改写路径按纯 mode 走。

### 2.4 会话切换竞态的三层防护（B1）

1. **结构性消除**：调度器不再有“先建盒子、后换 stack”的两段式。它在 `buildSessionStack` 内诞生，
   并随 `holder.current = stack`（`src/index.ts:442`）一次赋值变为可达——**不存在“新盒子已建、
   stack 未换”的窗口**。这正是 B2 的接线顺带修掉 B1 的地方。
2. **身份校验**：捕获钩子是 activate 级、跨会话共享的。它每次都从 `ctx` 读
   `sessionId = ctx.sessionManager?.getSessionId?.()`（try/catch，读不到给 `""`）并放进
   `CapturedRequest`，并从 `port.instanceId` 读当前实例 id 一并带上。服务实例自持构建期的
   `ownSessionId` 与不可复用的 `instanceId`；`noteRequest`/`noteRequestSettled`/`invalidate`/
   `consumeUpgrade`/武装计数一律先过 `accept()`（§8.2）：
   ```ts
   // 四重校验：未 dispose + 同会话 + 同实例 + 仍是 holder 上的当前实例
   if (this.disposed) return false;
   if (sessionId === "" || sessionId !== this.ownSessionId) {
     this.dropped.sessionMismatch += 1; // 只计数，不做任何状态变更
     return false;
   }
   if (instance !== this.instanceId || !this.deps.isCurrent(this)) {
     this.dropped.instanceMismatch += 1;
     return false;
   }
   ```
   - `sessionId === ""`（读不到会话 id 的降级宿主）⇒ **一律丢弃**（宁可不 ping）。
   - 旧 runner 的迟到回调落到新 service：id 不同 ⇒ 丢弃。
   - 新 session 已 `session_start` 但 stack 尚未替换完成时，捕获落到**旧** service：
     id 不同 ⇒ 丢弃；且该实例马上会被下次 build 顶部 dispose。
   - **同 sessionId 的 `/reload` 重建（B1 残留，I-K9）**：sessionId 相同不足以证明实例仍属当前
     stack，因此必须再比 `instanceId` 并调 `isCurrent(this)`（`stack.ts` 构造时注入
     `(self) => holder.current?.keepalive === self`）。旧实例在 reload 重建窗口里收到的调用
     ⇒ `instanceMismatch` 丢弃。
3. **窗口代际（I-K8）**：入口校验挡的是“别的会话/实例进来”，**自己旧结果迟到回写**由
   §8.4 的 `windowEpoch` 守卫挡；两者互补，缺一不可。
4. **await 返回点复查**：`runPing()` 里每个 `await`（auth 解析、fetch、body 读取）之后都要
   `if (this.disposed) return;`，并在写状态栏/审计前再查一次；所有 `ctx.*` 读取包 try/catch，
   抛出即 `this.dispose()`（stale ctx 语义与 `src/hud/index.ts:60-64` 的注释一致）。

### 2.5 dispose 契约

`dispose()` 幂等（`if (this.disposed) return;`，抄 `usage-broadcast.ts:91-97`）并完成：
清定时器（`clock.clearTimer`）→ `abortController.abort()`（释放 fetch reader/socket，§7.4）→
移除 parent abort listener → `setStatus("cache-keepalive", undefined)`（包 try/catch）→
`disposed = true`。此后任何入口都是 no-op。

触达路径共四条，全部覆盖：`/new`·fork·resume（下次 build 顶部 `previousKeepalive?.dispose()`）、
`/reload`（`session_shutdown` 的 `stack.keepalive?.dispose()`）、漏发 shutdown
（`src/index.ts:433-439` 防御性 dispose）、进程退出（定时器已 unref，不阻塞）。

### 2.6 主/子会话边界

`wireCacheTtl` 在 HOST_KEY 守卫**之后**调用（`src/index.ts:148-164`），子会话 activate 在守卫处
`return`，因此捕获钩子与 stack service 都只存在于主会话。这是期望行为：子会话自己在持续发请求。

### 2.7 文件清单（v2）

| 文件                                       | 性质                                | 职责                                                                                                                                                                                                                                    |
| ------------------------------------------ | ----------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `src/cache-ttl/keepalive-state.ts`         | **新增，pi-free 纯**                | 类型（`KeepalivePort`/`CapturedRequest`/`CaptureFingerprint`/`WindowState`/`SessionTotals`）、常量、`inspectPayload`、`buildFingerprint`、`compareFingerprint`、`evaluateTick`、窗口/会话 reducer、状态栏与报告文案、`cacheReadCostUsd` |
| `src/cache-ttl/ping-client.ts`             | **新增，pi-free**（只依赖 `fetch`） | `preparePingPayload`、`buildPingRequest`（纯：payload+auth+model → `{url, headers, body}`）、`sendKeepalivePing`（裸 POST + SSE 早停 + 结果分类）                                                                                       |
| `src/service/cache-keepalive.ts`           | **新增，stack service**             | `createCacheKeepaliveService(deps)`：定时器（`systemClock.setTimer` 自续期）、武装判定、预算、熔断、auth 解析、发请求、状态栏、审计条目、`KeepalivePort` 实现、`dispose()`                                                              |
| `src/cache-ttl/cache-ttl.ts`               | 改造                                | handler 签名加 `ctx`（`explore.md §2` 预警）；改写后捕获并交给 `deps.keepalive()`；`/cache-ttl keepalive on\|off`、`/cache-ttl status`                                                                                                  |
| `src/stack.ts`                             | 改造                                | `previousKeepalive` 句柄、`Stack.keepalive`、build 顶部 dispose、构造与注入（§2.2）                                                                                                                                                     |
| `src/index.ts`                             | 改造                                | 传 holder read-through、两处 dispose 兜底（§2.2）                                                                                                                                                                                       |
| `src/config/settings.ts`                   | 改造                                | `CacheTtlSettings` 扩 5 字段 + 默认值 + `parseCacheTtlSettings` + `TIME_SETTING_MS_PATHS`                                                                                                                                               |
| `src/config/setting-specs.ts`              | 改造                                | **5 个**新 spec（m1）                                                                                                                                                                                                                   |
| `README.md` / `README.en.md` / `AGENTS.md` | 文档                                | 功能条目与模块描述（`src/service/` 与 `src/cache-ttl/` 两处都要提一句）                                                                                                                                                                 |

---

## 3. 载荷捕获、指纹与前缀实测（问题 3｜M3 + M4 修订）

### 3.1 捕获哪一份

在 `cache-ttl.ts` 的 `before_provider_request` handler 内，**改写之后、return 之前**捕获
（`explore.md §5.1` 已证明链式语义：我们的返回值就是真正发出去的 payload，且仓库内只有这一个 handler）：

```ts
pi.on("before_provider_request", (event, ctx) => {
  const port = deps.keepalive?.(); // holder read-through；空 ⇒ 全程 no-op（§2.3）
  const sessionId = readSessionId(ctx); // try/catch，失败给 ""
  const upgrade = port?.consumeUpgrade(sessionId) === true; // §6.3
  const effective: CacheTtlMode = upgrade && mode === "auto" ? "on" : mode;
  const payload = event.payload;
  if (!isObjectRecord(payload) || !Array.isArray(payload.messages)) {
    port?.invalidate("payload-shape", sessionId);
    return undefined;
  }
  if (effective === "auto") {
    port?.noteRequest(capture(payload, ctx, sessionId, /* needsClone */ true));
    return undefined; // 行为与今天完全一致
  }
  let cloned: unknown;
  try {
    cloned = structuredClone(payload);
  } catch (error) {
    /* 现有 warn 分支不变 */
    port?.invalidate("clone-failed", sessionId);
    return undefined;
  }
  rewrite(cloned, effective, new WeakSet<object>());
  port?.noteRequest(capture(cloned as RecordValue, ctx, sessionId, /* needsClone */ false));
  return cloned as RecordValue;
});
```

- `auto` 分支必须自己克隆一份（`needsClone`）：pi 会把同一对象继续 `{...params, stream:true}`
  展开使用（`anthropic-messages.js:382`），持有外部可变对象几分钟是纯风险。`on/off` 分支复用已有克隆。
- `capture()` 只做**便宜**的工作：`inspectPayload`（§3.2）、`buildFingerprint`（§3.3）、
  `readLatestAssistantCacheTokens`（§3.4，从后向前扫 entries，命中即停）。**没有**全量
  `JSON.stringify`（M3 一并解决了 R6 的 CPU 顾虑）。
- **已知残余风险**：若宿主还装了别的扩展且注册在我们**之后**又改写 payload，捕获就不是最终态。
  兜底不再只靠“熔断一次”，而是 I-K7 的 proven-hit-only 口径（§7.5）：任何无法证明纯命中的结果
  都计入会话级 breaker，最多两次即永久停用。

### 3.2 `PayloadShape`

```ts
export interface PayloadShape {
  ephemeralBreakpoints: number; // cache_control.type === "ephemeral" 个数
  ttl1h: boolean; // 任一 breakpoint 带 ttl === "1h"
  hasThinking: boolean; // payload.thinking 存在且 type !== "disabled"
  maxTokens: number | undefined; // payload.max_tokens
}
```

`inspectPayload` 抄 `cache-ttl.ts:37-48` 的迭代 + `WeakSet` 防环骨架。

### 3.3 指纹（M4：安全关键 vs 有效性关键）

先把两类漂移分清，这是 M4 的核心答复：

- **安全关键（可能把 ping 变成写入或打到错误端点）**：条目是否还存活（`aliveUntil` 门）、
  重放内容是否逐字节同构（我们持有副本，天然成立）、**请求要送到的端点/认证/模型是否还是捕获
  时那一个**。后者必须显式比对——否则可能把「旧模型 id」发到「新模型的 endpoint/auth」，
  产生 401/404（无害但无效）或读到无关分桶（无效）。
- **有效性关键（只会浪费 0.1P，不会变成写入）**：system 提示漂移、工具集变化。因为我们重放的是
  **旧内容**，命中的是旧条目，仍是纯读；只是未来的真实请求已经换了前缀，这次刷新白费。
  这类也要作废（省钱），但严重度低一档。

```ts
export interface CaptureFingerprint {
  sessionId: string;
  provider: string; // ctx.model.provider
  api: string; // ctx.model.api
  modelId: string; // payload.model（wire 上的真身）
  ctxModelId: string; // ctx.model.id（可能与 payload.model 不同：fallback 模型）
  baseUrl: string; // ctx.model.baseUrl
  authHeaderKeys: string; // 解析 auth 后的 header key 排序拼接（**不含值**）
  breakpointPath: string; // 每个 ephemeral breakpoint 的位置签名，如 "system#0,tools#last,messages#12"
  thinkingDigest: string; // JSON.stringify(payload.thinking) ?? ""
  systemDigest: string; // system 文本的 长度 + 前 64 + 后 64 字符
  toolsDigest: string; // tools 个数 + name 列表拼接
  messageCount: number;
}
```

- 都是 O(工具数 + 常数) 的便宜字段，不做全量序列化（T4 的否决理由仍然成立）。
- `authHeaderKeys` 在**第一次 ping 解析 auth 后**回填进指纹并锁定；后续 ping 解析出的 key 集合
  不同 ⇒ 视为端点/认证变化 ⇒ invalidate（**不** ping）。
- **ping 前比对**（`compareFingerprint(capture.fingerprint, currentFingerprint(ctx, auth))`）：
  `sessionId / provider / api / ctxModelId / baseUrl / authHeaderKeys` 任一不同 ⇒
  `invalidate("fingerprint-drift:<field>")`；`payload.model` 与 `ctx.model.id` 的关系不做强约束
  （fallback 模型合法），但 `ctxModelId` 变了一定作废。
- **事件驱动作废**（覆盖不经过真实请求的变化）：

| 事件                                          | 作废理由                                                | 类别     |
| --------------------------------------------- | ------------------------------------------------------- | -------- |
| `session_compact` / `session_compact_failed`  | 上下文被重写                                            | 有效性   |
| `session_tree`                                | 分支跳转，消息序列变了                                  | 有效性   |
| `model_select`                                | 换模型（缓存按模型分桶）                                | **安全** |
| `thinking_level_select`                       | 官方文档：thinking 参数变化作废 messages 缓存块         | 有效性   |
| `before_agent_start`（systemPrompt 摘要变化） | 系统提示漂移（memory 注入、skill 变化）；只比摘要，便宜 | 有效性   |
| `resources_discover` / `session_info_changed` | 资源/工具集可能变化                                     | 有效性   |
| `session_start` / `session_shutdown`          | 会话替换（另由 §2.4 身份校验兜底）                      | **安全** |
| payload 形状异常 / `structuredClone` 失败     | 兜底                                                    | **安全** |

### 3.4 前缀规模：只用实测下界（M3）

```ts
/** 最近一条带 usage 的 assistant 消息的 cacheRead + cacheWrite = 上一轮真实请求**实际**被缓存/命中的 token 数。 */
export function readLatestAssistantCacheTokens(ctx: ExtensionContext): { tokens: number; source: "usage" } | undefined;
```

- 数据源与 HUD 同一口径（`src/hud/footer.ts:178-188` 读 `entry.message.usage.cacheRead/cacheWrite`），
  是 pi 官方账本里的**实测值**，不是估算；从 `ctx.sessionManager.getEntries()` **从后向前**扫，
  命中第一条 `role === "assistant" && usage` 即停（O(1) 摊销）。降级探测复用
  `probeReadBackEntries(ctx)`（`src/adapters/pi-compat.ts:59`）。
- **拿不到就不 ping**：`source: "unknown"` ⇒ 门 G6 直接拒（新会话第一轮、read-back 不可用的宿主）。
  第一轮的前缀本来就小，损失可忽略。
- 为什么弃用原方案的两个来源（M3 已确认）：`ctx.getContextUsage()?.tokens` 是**上下文总量**
  （含未被 breakpoint 覆盖的尾部），`JSON.stringify(payload).length / 4` 含大量非前缀字段开销，
  两者都会**高估** P，从而绕过 20k 下限去 ping 小前缀。现口径宁可低估（`cacheRead+cacheWrite`
  只统计真正被缓存的部分）而跳过。
- `prefix.source` 进审计条目与 `/cache-ttl status`（M5：让用户看到数字是怎么来的）。

---

## 4. 武装信号（问题 1 的输入侧）

| 信号          | 来源                                                                                                             | 维护方式                                                                                    |
| ------------- | ---------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------- |
| `bg`          | **stack 自有数据源**：`query.list()` 的非终态计数 + `bashJobs?.backgroundJobCount()`（§2.2 的 `backgroundBusy`） | tick 时现读                                                                                 |
| `activeTools` | `tool_execution_start` / `tool_execution_end`（activate 级钩子 → port）                                          | `+1` / `−1` 并 `Math.max(0, …)` 钳位；**`agent_settled` 强制归零**（工具崩溃漏 end 时自愈） |
| `uiPrompts`   | `ui_prompt_start` / `ui_prompt_end`                                                                              | 同上钳位；`dispose()` 归零                                                                  |

`armed = bg || activeTools > 0 || uiPrompts > 0`，覆盖任务要求的四类（前台 `Agent` 工具阻塞、
`runningSubagents > 0`、`runningBashJobs > 0`、`ui_prompt` 阻塞）。

- **为什么不走 `readBackgroundStatus()`**：那个 `Symbol.for` 全局是给**跨模块消费者**
  （feishu-notify）准备的（`src/service/background-status.ts:10-30`）；stack 内部绕自己的
  `query`/`bashJobs` 去读全局属于本末倒置，而且多一层「发布者是否是本 stack」的不确定性。
- **武装是瞬时判定**：tick 时重算。后台全清、主会话停在提示符 ⇒ 不武装 ⇒ 不再 ping。
- `tool_execution_*` / `ui_prompt_*` 这些计数**也走 port + sessionId 校验**（I-K6）：钩子是
  activate 级的，不校验就会把旧会话的计数记到新 service 上。

**“真实请求在途”判定**（真实请求进行中不 ping）：`before_provider_request` 置位；
`message_end` / `tool_execution_start` / `turn_end` / `agent_end` / `agent_settled` 任一清零
（都经 `noteRequestSettled(sessionId)`）。

- 不能只用 `turn_end`：它带 `toolResults`，在工具执行**之后**才触发；而“前台 Agent 工具阻塞
  40 分钟”正是主场景，只认 `turn_end` 会让标志一直挂着 ⇒ 永不 ping。
- 不用 `ctx.isIdle()` 作唯一判据：整个 agent loop（含工具执行）期间为 false，同样错杀主场景。
- **失败方向安全**：漏清零 ⇒ 不 ping（省钱），不是乱 ping。

---

## 5. 状态机（问题 1）

### 5.1 状态图

```
                      ┌──────────────────────────────────────────────┐
                      │                                              │
                      ▼                                              │
              ┌───────────────┐   noteRequest(sessionId 匹配)  ┌──────┴──────────┐
 stack build →│  IDLE         │ ─────────────────────────────► │  CAPTURED       │
   (无捕获)    │ (无定时器)     │  (捕获+窗口重置+arm tick)       │  requestInFlight │
              └───────────────┘                               └──────┬──────────┘
                      ▲                                              │ noteRequestSettled
                      │ invalidate(安全/有效性漂移)                    │
                      │ 或 sessionId 失配 / dispose                    ▼
                      │                                     ┌─────────────────┐
                      │        ┌──────────────────────────► │  WAITING        │
                      │        │  proven hit                │  (等待到期)      │
                      │        │  → 窗口时钟前移 + 续期 tick  └────────┬────────┘
                      │  ┌─────┴──────┐                               │ tick: G1..G9 全过
                      │  │  PINGING   │ ◄─────────────────────────────┘
                      │  │ (单飞)      │
                      │  └─────┬──────┘
                      │        ├── unproven（失败/无 usage/断连/HTTP/abort）
                      │        │      → 本窗口停 + 会话级计数 ↑ → 阈值即 DISABLED(session)
                      │        └── cache_creation > 0（proven write）→ 立刻 DISABLED(session)
                      │
                      └── STOPPED(budget) ◄─ pings == maxPings（置 upgradePending，停 tick）
                          STOPPED(expired) ◄─ now ≥ aliveUntil − margin（停 tick）
```

- `STOPPED(*)` 由下一次真实请求拉回 `CAPTURED`（窗口重置）。
- `DISABLED(session)` **不可恢复**（I-K7）：真实请求不重置它，只有新会话/新 stack 才清零。
- **tick 自续期、自停止**（`UsageBroadcaster` 范式）：`noteRequest` 时 arm；tick 返回的
  `skip` 属于“本窗口终局”（`no-capture` / `disabled` / `session-disabled` / `budget-exhausted` /
  `cache-expired`）则**不再续期** ⇒ 空闲会话零定时器（可用 `FakeClock.pendingTimers` 断言）。

### 5.2 迁移表（`evaluateTick` 判定顺序）

| #   | 条件（自上而下短路）                                                                          | 结果                                                                                |
| --- | --------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------- |
| 1   | `!config.enabled`（设置或 `/cache-ttl keepalive off`）                                        | `skip("disabled")`，终局（不续期）                                                  |
| 2   | `session.disabled`（I-K7 熔断）                                                               | `skip("session-disabled")`，终局                                                    |
| 3   | `capture === undefined`                                                                       | `skip("no-capture")`，终局                                                          |
| 4   | `ctx.mode` 不是 `tui`/`rpc`                                                                   | `skip("mode")`，终局（G2）                                                          |
| 5   | `capture.fingerprint.api !== "anthropic-messages"` 或 provider 在拒绝名单                     | `skip("not-anthropic")`，终局                                                       |
| 6   | `shape.ephemeralBreakpoints === 0`                                                            | `skip("no-cache-control")`，终局                                                    |
| 7   | `shape.ttl1h`                                                                                 | `skip("ttl-1h")`，终局                                                              |
| 8   | `capture.prefix.source !== "usage"` 或 `prefix.tokens < minPrefixTokens`                      | `skip("prefix-unproven")` / `skip("prefix-too-small")`，终局                        |
| 9   | `compareFingerprint(...)` 有差异（含 `sessionId`、`ctxModelId`、`baseUrl`、`authHeaderKeys`） | `invalidate("fingerprint-drift:<field>")`，终局                                     |
| 10  | `window.requestInFlight`                                                                      | `skip("request-in-flight")`，续期                                                   |
| 11  | `window.pingInFlight`                                                                         | `skip("ping-in-flight")`，续期（并发去重）                                          |
| 12  | `!armed`                                                                                      | `skip("not-armed")`，续期                                                           |
| 13  | `now ≥ aliveUntil − TTL_SAFETY_MARGIN_MS`                                                     | `skip("cache-expired")`，**终局**（缓存推定已死，再 ping 就是全量写——最重要的一条） |
| 14  | `window.pings ≥ config.maxPings`                                                              | `skip("budget-exhausted")` + 置 `upgradePending`（§6.3），**终局**                  |
| 15  | `now < window.nextPingAt`                                                                     | `skip("not-due")`，续期                                                             |
| 16  | 其余                                                                                          | **`ping`**                                                                          |

### 5.3 reducer（纯函数，`keepalive-state.ts`）

```ts
onRealRequest(w, s, captured, now):
  // 窗口关闭时先结算 M2 审计分类（§9.2）
  closeWindowAccounting(w, s, now);
  w.windowEpoch += 1;                         // ★ I-K8：旧 ping 的迟到结果从此一律被丢弃
  w.capture = captured; w.windowStartAt = now; w.lastReadStartedAt = now;
  w.aliveUntil = now + ASSUMED_TTL_MS;
  w.nextPingAt = now + config.intervalMs;     // 锚点 = 请求"开始"时刻
  w.pings = 0; w.requestInFlight = true;
  // ★ 不动 s.*（会话级熔断计数不被真实请求重置 —— I-K7 / B3）

onPingStarted(w, now): w.pingInFlight = true; w.pings += 1; w.pingStartedAt = now;  // 预算先扣
  // 调用方（§8.4）在此之前把 w.windowEpoch 快照成 pingEpoch

// ★ I-K8：下面两个结果 reducer 都以 `pingEpoch === w.windowEpoch` 为前置条件（内部断言）；
//    失配时调用方根本不会调它们 —— 否则旧的 aliveUntil / breaker 状态会被带进新窗口。

onProvenHit(w, s, outcome):                   // cache_read > 0 && cache_creation === 0
  w.pingInFlight = false;
  w.lastReadStartedAt = w.pingStartedAt;      // ★ 发起时刻，不是回包时刻
  w.aliveUntil = w.pingStartedAt + ASSUMED_TTL_MS;
  w.nextPingAt  = w.pingStartedAt + config.intervalMs;
  s.pings += 1; s.cacheReadTokens += outcome.cacheReadTokens;
  s.consecutiveUnproven = 0;                  // 只有 proven hit 能清零

onUnproven(w, s, kind, now):                  // 失败/无 usage/双 0/断连/HTTP/abort
  w.pingInFlight = false; w.capture = undefined;         // 本窗口停
  s.unprovenTotal += 1; s.consecutiveUnproven += 1;
  s.lastUnproven = { kind, at: now };
  if (kind === "proven-write") s.provenWrites += 1;
  if (s.provenWrites >= 1 || s.consecutiveUnproven >= UNPROVEN_STREAK_LIMIT /*2*/ ||
      s.unprovenTotal >= UNPROVEN_TOTAL_LIMIT /*3*/) s.disabled = { reason: kind, at: now };

invalidate(w, reason): w.capture = undefined; w.upgradePending = false; w.windowEpoch += 1;
```

`onProvenHit` 用 **ping 发起时刻**推进时钟：官方口径“寿命从写/读该条目的请求**开始**时刻起算”，
用回包时刻会把间隔算长，正好朝危险方向偏。

### 5.4 门控（问题 4，“净省钱才 ping”）

| 门                        | 判据                                                                                  | 理由 / 备选                                                                                                                                               |
| ------------------------- | ------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------- |
| G1 设置开关               | `settings.cacheTtl.keepalive`（+ `/cache-ttl keepalive off` 的进程内覆盖）            | 默认 **true**（用户维持）                                                                                                                                 |
| G2 运行模式               | `ctx.mode === "tui" \|\| "rpc"`                                                       | `print`/`json` 是一次性批处理，不存在“长空档后恢复”                                                                                                       |
| G3 API 风格               | `api === "anthropic-messages"` 且 payload 为 `{messages:[…]}`                         | 只有 Anthropic 有“读免费刷新 TTL”；OpenAI 系是自动缓存、无 `cache_control`                                                                                |
| G4 provider 拒绝名单      | `provider !== "github-copilot"`                                                       | Copilot 按“premium request 次数”计费，一次 ping = 一次付费请求，成本模型不成立。常量 `PING_DENY_PROVIDERS` 写死 + 注释，不做设置项（避免误配出账单，T10） |
| G5 确有 5m ephemeral 断点 | `ephemeralBreakpoints > 0 && !ttl1h`                                                  | 无 `cache_control` ⇒ 根本没开缓存，ping 纯浪费；已是 1h ⇒ 用户已付 2× 买了一小时，v1 不保活（T5）                                                         |
| G6 前缀实测下界           | `prefix.source === "usage" && prefix.tokens ≥ keepaliveMinPrefixTokens`（默认 20000） | M3：只认 pi 官方账本的 `cacheRead + cacheWrite` 实测值；测不到直接不 ping（§3.4）                                                                         |
| G7 指纹一致               | `compareFingerprint` 全等（含端点/认证/模型）                                         | M4：安全关键漂移一律拒                                                                                                                                    |
| G8 武装                   | §4                                                                                    | —                                                                                                                                                         |
| G9 存活期 + 预算 + 熔断   | 迁移表 #13/#14/#2                                                                     | —                                                                                                                                                         |

**为什么不按模型分档阈值**：`ping/miss` 比值对所有 Anthropic 模型一致（Fable 的 read 更便宜，
只会让 ping 更划算）。统一取最保守的 11.5 上限，少一个配置维度与一类“模型换了阈值没换”的 bug。

---

## 6. 间隔、预算与升级（问题 2）

### 6.1 间隔 = 240 秒（4 分钟）

- TTL 300s，寿命从请求**开始**起算 ⇒ 相邻两次 ping 的**发起时刻**间隔必须 < 300s。
- 取 240s 留 60s 余量；`TTL_SAFETY_MARGIN_MS = 45_000` 在 #13 门再把一次关；tick 15s 精度。
- **被否决**：280s（余量 20s，抖动即越界，越界就是全量写，赔率不对称）；120s（次数翻倍，
  11 次只覆盖 22 分钟）。
- `TICK_INTERVAL_MS = 15_000`：对 60s 余量无威胁，且能快速响应“后台刚结束”的降级。
- **m2**：tick 判定通过后还要 `await` 解析 auth，POST 前**重新**检查 `now < aliveUntil − margin`
  （auth 可能走网络刷新 OAuth），不通过就放弃本次（不计 unproven，因为请求从未发出）。

### 6.2 预算 = 11 次 / 窗口

- `0.1 × 11 + 0.1 = 1.2P` ≈ `1.25P`（情景 A）⇒ 11 次是不亏的最大整数（§0.3 判据 1）。
- 11 × 4 分钟 ≈ **44 分钟**覆盖。第 12 次开始亏，硬顶取 11。
- 会话累计 ping 次数不设上限（每次真实请求都是“用户真的在用这个会话”的证据），但 I-K7 的
  会话级熔断不可绕过。

### 6.3 预算耗尽后：只在「反正要写」时升级 1h（M1 口径）

```
pings == maxPings 且仍 armed
      └─► w.upgradePending = true          // 只记标志，不花钱
              │
              ▼
   下一次 before_provider_request：consumeUpgrade(sessionId) 返回 true 当且仅当
       w.upgradePending
    && sessionId === ownSessionId                       // I-K6
    && mode === "auto"                                  // I-K5：不篡改显式 on/off
    && settings.cacheTtl.keepaliveUpgradeAfterBudget
    && now − w.lastReadStartedAt > ASSUMED_TTL_MS        // 缓存推定已死 ⇒ 这次本来就要全量写
   ⇒ effectiveMode = "on"（复用现有 rewrite()，写 ttl:"1h"）；标志清零
```

- **口径修正（M1）**：这条**不是**由 `n = 11` 推导出来的。它的判据只有一个：
  «这次请求必然是全量写» ⇒ 比较 `1.25P`（5m）与 `2P`（1h），**边际 0.75P** 买一小时覆盖。
  是否值得取决于“预期还会有多少次长空档”，因此做成可关的独立开关，默认 true（长后台任务
  通常不止一轮），而**不**声称“预算耗尽就应该升级”。
- `now − lastReadStartedAt > TTL` 是诚实性前置：否则就变成主动付 2×。
- `upgradePending` 在 `invalidate()`、`dispose()`、消费后清零。
- `mode === "off"` 不升级（尊重用户显式 5m）；`mode === "on"` 已是 1h（G5 早已关门）。

---

## 7. ping 客户端（`src/cache-ttl/ping-client.ts`，pi-free）

### 7.1 为什么必须裸 POST

`modelRegistry.complete()` 需要 pi-ai 的 `Context`，等于**重建**请求；重建的序列化只要差一个
字节（工具顺序、system 块拆分、`cache_control` 落点……）就会 miss 并触发 1.25P 全量写——反向亏钱。
必须重放捕获到的原始 payload。（任务书已定，此处只记理由。）

### 7.2 payload 准备（`preparePingPayload`，纯）

```ts
export function preparePingPayload(captured: Record<string, unknown>): Record<string, unknown> {
  const body: Record<string, unknown> = { ...captured, stream: true };
  const thinking = captured.thinking;
  const thinkingActive = isObjectRecord(thinking) && thinking.type !== "disabled";
  if (!thinkingActive) body.max_tokens = 1; // 唯一允许的改动
  return body;
}
```

- **不能对开了 thinking 的 payload 改 `max_tokens: 1`**：Anthropic 要求
  `max_tokens > thinking.budget_tokens`，改了直接 400。
- **更不能摘掉 `thinking`**：官方文档明确 thinking 参数变化作废 messages 缓存块 ⇒ 会变成一次
  1.25P 全量写，是本方案最昂贵的踩雷方式。
- thinking 会话靠 §7.4 的**早停 abort** 控制输出成本；pi 自己的注释即佐证：
  `anthropic-messages.js:399-404` “Capture initial token usage from message_start event / This
  ensures we have input token counts **even if the stream is aborted early**”。
- 其余字段（`system`/`tools`/`messages`/`temperature`/`tool_choice`/`metadata`…）**逐字不动**。
- `max_tokens` 键名为 Anthropic snake_case wire 名（`explore.md §5.2` 已取证）。

### 7.3 URL 与 headers（`buildPingRequest`，纯）

```
POST  {auth.baseUrl ?? model.baseUrl}（去尾斜杠）+ "/v1/messages"
```

headers 构造顺序（后者覆盖前者）：

1. `content-type: application/json`、`accept: text/event-stream`、`anthropic-version: 2023-06-01`
2. OAuth 分支（`apiKey.includes("sk-ant-oat")`，判据抄 `anthropic-messages.js:660-662`）：
   `authorization: Bearer <apiKey>`、`anthropic-beta: claude-code-20250219,oauth-2025-04-20`、
   `user-agent: claude-cli/2.1.75`、`x-app: cli`（缺这些 OAuth 请求会被拒，见 `:692-706`）
3. 否则 `x-api-key: <apiKey>`
4. `model.headers`（模型目录静态 header）
5. `auth.headers`（`getApiKeyAndHeaders` 返回，可能自带 authorization）

`getApiKeyAndHeaders(model): Promise<{ok, apiKey?, headers?, baseUrl?, env?}>`
（`dist/core/model-registry.d.ts:5-14,29`）；`ok === false` ⇒ 放弃本次 ping，**不计 unproven**
（请求从未发出），仅记 `lastSkip = "no-auth"`。

**不带** interleaved-thinking / fine-grained-tool-streaming 等 beta：不影响缓存键，只影响流式行为，
而我们收到第一个事件就断。

### 7.4 早停读取与资源释放（m3）

```ts
const controller = new AbortController();
const onParentAbort = () => controller.abort();
parent?.addEventListener("abort", onParentAbort, { once: true });
const timer = setTimeout(() => controller.abort(new Error("keepalive ping timeout")), timeoutMs);
timer.unref(); // I-K4
let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
try {
  const res = await fetchImpl(url, { method: "POST", headers, body: JSON.stringify(body), signal: controller.signal });
  if (!res.ok) return http(res.status, await readCapped(res, 2048)); // 读取后 body 已终结
  reader = res.body?.getReader();
  if (!reader) return malformed("no body");
  // 逐块 decode → 按行扫 "data: " → JSON.parse；见到 type === "message_start" 即取 usage 并返回。
  // 扫描上限 64KB：超限仍未见 message_start ⇒ malformed（防御畸形代理）。
} catch (error) {
  return classify(error); // aborted / network；永不抛
} finally {
  clearTimeout(timer);
  parent?.removeEventListener("abort", onParentAbort); // m3：listener 必须摘
  controller.abort(); // m3：确保 socket 断开
  try {
    await reader?.cancel();
  } catch {} // m3：reader 显式取消，不依赖 GC
}
```

- `timeoutMs` 默认 20_000（常量，非设置项）。
- **本函数永不抛异常**；错误消息经 `redactSecrets`（`src/web-search/resilience.ts:92-101` 同款思路，
  把 apiKey 传进去打码）。
- 四条路径（成功早停 / 超时 / 外部 abort / 非 2xx）都必须走到同一个 `finally`，测试逐条断言
  `reader.cancel` 被调用、`signal.aborted === true`、parent listener 计数归零（§13.2）。

字段名依据：`anthropic-messages.js:400-404` 读的就是
`event.message.usage.{input_tokens, output_tokens, cache_read_input_tokens, cache_creation_input_tokens}`。

### 7.5 结果分类与熔断（B3 + B4 修订，第三道护栏的技术核心）

```ts
export type PingOutcome =
  | { kind: "proven-hit"; cacheReadTokens: number; inputTokens: number }
  | { kind: "proven-write"; cacheWriteTokens: number } // cache_creation > 0
  | { kind: "no-usage" } // 200 但 usage 缺失 / cache_read 与 cache_creation 都是 0
  | { kind: "accepted-then-lost" } // 已拿到 200 响应头，但流在 message_start 前断/超时/被 abort
  | { kind: "http"; status: number } // 任何非 2xx
  | { kind: "network" } // fetch 直接失败
  | { kind: "malformed" }; // 无 body / 64KB 内无 message_start
```

| 分类                                                                                | 判定                                        | 动作                                                                       |
| ----------------------------------------------------------------------------------- | ------------------------------------------- | -------------------------------------------------------------------------- |
| `proven-hit`（`cache_read > 0 && creation === 0`）                                  | **唯一**被认可的成功                        | `onProvenHit`：推进时钟、累计 tokens、`consecutiveUnproven = 0`            |
| `proven-write`                                                                      | 有正面证据发生了写入                        | `onUnproven("proven-write")` ⇒ `provenWrites ≥ 1` ⇒ **立即整会话永久停用** |
| 其余全部（`no-usage`/`accepted-then-lost`/`http`/`network`/`malformed`/超时/abort） | **无法证明纯命中** ⇒ 一律按“可能已写入”处理 | `onUnproven(kind)`：本窗口停 + **会话级**计数 ↑                            |

会话级停用阈值（三条，任一命中即 `disabled`，**真实请求不重置**）：

- `provenWrites ≥ 1`（有证据的昂贵失败，一击）；
- `consecutiveUnproven ≥ 2`（**B4 裁决后保留的唯一可靠性卫生**）；
- `unprovenTotal ≥ 3`（堵住“命中/失败交替”长期烧钱的路径）。

**为什么 N = 2**：整个功能在一个窗口里最多能省 `1.25P`（§0.3 情景 A），而每次 unproven 最坏
是一次隐形全量写 `1.25P`。容忍 1 次瞬时抖动（网络闪断很常见，一次的期望损失 ≤ 一次 miss）、
第 2 次连续失败就停 ⇒ 最坏累计暴露 `2 × 1.25P`，与「省下的量级」同阶；N = 3 会让最坏暴露
`3.75P`，超过功能全部收益，所以不取 3。`unprovenTotal ≥ 3` 是同一算式在非连续场景下的镜像。

**B3 关掉的漏洞**：原方案把 timeout/abort/HTTP 归为“本窗口失败、不计会话级”，而真实请求会
重置窗口 ⇒ 每轮真实请求都能再烧一次隐形写入。现在窗口重置**只**动窗口字段
（`onRealRequest` 里明确不碰 `s.*`），会话级计数单调递增，所以“反复烧写”被闭合。

**abort 与迟到返回的交互语义（B5，必须照此实现）**：`AbortController.abort()` **不会**同步取消
已在飞的 promise，所以每次 abort 之后都必然存在“结果迟到返回”的窗口，且有两条路径：

1. **fetch / body 读取 reject**（`AbortError`）⇒ 本会被分类成 `network` 或 `accepted-then-lost`；
2. **abort 之前已拿到响应头甚至 `message_start`** ⇒ 本会被分类成 `proven-hit` / `proven-write` / `no-usage`。

**两条路径都必须先过 `sameEpoch(pingEpoch)`（§8.4）**：

- **epoch 未变**（同窗口内的超时、或 `dispose()`）：按上表正常分类；`dispose()` 场景下
  `this.disposed` 已让 `sameEpoch` 返回 false，等价于丢弃——实例即将消失，计数也无意义。
- **epoch 已变**（真实请求抢占 / `invalidate` / 会话或实例切换）：**一律静默丢弃**——
  不计 proven、不计 unproven、不推进 `aliveUntil`/`nextPingAt`、不动 `consecutiveUnproven`
  与 `provenWrites`/`unprovenTotal`，只加 `dropped.epochMismatch`。

**为什么迟到结果必须“不计数”而不是“照常计入”**（v2 在此是错的，见复核 B5）：

- 迟到的 `proven-hit` 若被计入，会 ① 用**旧的** `pingStartedAt` 推进新窗口的 `aliveUntil`，
  让状态机误判缓存仍活着，下一次 ping 就可能撞在已过期的条目上 ⇒ **1.25P 全量写**；
  ② 把 `consecutiveUnproven` 清零 ⇒ 掩盖 I-K7 的熔断。这与 B3 是同一类经济漏洞，只是漏在并发边界。
- 迟到的 `unproven` 若被计入新窗口的 breaker，则一次抢占就能凭旧窗口的失败误杀新窗口的保活。
- 两个方向都错，所以统一按“不属于本窗口 ⇒ 对本窗口不产生任何影响”处理。
- **取舍（明写）**：被抢占那次 ping 若真在服务端造成写入，我们会失去这条证据（不进 breaker）。
  可接受：新窗口的起点本身是一次**真实请求**（它已把条目写/读到最新），epoch 守卫又保证旧结果
  无法伪造存活期，因此“反复烧写”的路径仍由 I-K7 + epoch 联合闭合。

### 7.6 花费估算（M5）

`cacheReadCostUsd(cost, tokens)`（`keepalive-state.ts`，纯）：镜像 pi-ai `models.js:527-545` 的分档
选择（`cost.tiers` 中取 `inputTokensAbove < tokens` 的最高档）再 `rates.cacheRead / 1e6 * tokens`。
**返回 `number | undefined`**：`cost` 或 `cacheRead` 缺失/为 0 ⇒ `undefined`（= 未知），
展示层必须显示“费用未知”，**禁止显示 `$0`**（M5）。

**被否决**：`import { calculateCost } from "@earendil-works/pi-ai"`。`src/` 目前对 pi-ai 只有类型级
依赖、零运行时 import；peer 是 optional、由 pi 在加载时 alias，引入运行时值 import 会给 jiti
加载路径与单测添一层不确定性。十行本地实现更划算。

---

## 8. 调度服务（`src/service/cache-keepalive.ts`｜stack service）

### 8.1 依赖与状态

```ts
export interface CacheKeepaliveDeps {
  clock?: Clock; // 默认 systemClock（setTimer 已 unref）；测试注入 FakeClock
  ctx: ExtensionContext; // 构建期 ctx（会话身份 + ui + modelRegistry）
  sessionId: string; // currentSessionId(ctx)
  settings: CacheTtlSettings; // 引用传递
  backgroundBusy: () => boolean; // query.list() + bashJobs（§2.2）
  /** I-K9：本实例是否仍是 holder 上的当前实例；stack.ts 传 `(self) => holder.current?.keepalive === self`。 */
  isCurrent: (self: CacheKeepaliveService) => boolean;
  readLatestUsage: () => { tokens: number; source: "usage" } | undefined; // §3.4
  fetchImpl?: typeof fetch;
  appendEntry?: (customType: string, data: unknown) => void;
  emit?: (channel: string, payload: unknown) => void;
}
export interface CacheKeepaliveService extends KeepalivePort {
  dispose(): void;
}
```

内部状态（全在实例字段里，**无模块级可变状态**）：`disposed`、`ownSessionId`、
`instanceId`（不可复用即可，不要求全局单调：构造时取 `${sessionId}#${createdAt}#${randomUUID().slice(0, 8)}`）、
`enabledOverride`、`timer`、`abortController`、`pingEpochInFlight`、
`window: WindowState`（含 `windowEpoch`）、`session: SessionTotals`、`activeTools`、`uiPrompts`、
`dropped: { sessionMismatch, instanceMismatch, epochMismatch }`、`lastSkip`。

### 8.2 入口的统一前置（I-K6）

```ts
/** 入口守卫（I-K6 + I-K9）：挡“别的会话/实例的调用进来”。 */
private accept(sessionId: string, instance: string): boolean {
  if (this.disposed) return false;
  if (sessionId === "" || sessionId !== this.ownSessionId) {
    this.dropped.sessionMismatch += 1;
    return false;
  }
  if (instance !== this.instanceId || !this.deps.isCurrent(this)) {
    this.dropped.instanceMismatch += 1; // 同 sessionId 的 /reload 重建窗口
    return false;
  }
  return true;
}

/** 回写守卫（I-K8）：挡“自己的旧 ping 结果迟到回写新窗口”。 */
private sameEpoch(pingEpoch: number): boolean {
  if (this.disposed || pingEpoch !== this.window.windowEpoch) {
    this.dropped.epochMismatch += 1; // 不计 proven、不计 unproven、不回写任何字段
    return false;
  }
  return true;
}
```

`noteRequest` / `noteRequestSettled` / `invalidate` / `consumeUpgrade` / 武装计数入口一律先过
`accept`；`runPing()` 的每个 await 返回点、以及每次调 reducer 之前一律先过 `sameEpoch`。

### 8.3 定时器（UsageBroadcaster 范式）

- `arm()`：`this.timer = this.clock.setTimer(TICK_INTERVAL_MS, () => { this.timer = undefined; this.onTick(); })`。
  `systemClock.setTimer` 内部已 `unref()`（`src/core/clock.ts:12-22`）⇒ 天然满足 AGENTS.md 铁律，
  且 `FakeClock` 可断言 `pendingTimers`。
- `onTick()`：`evaluateTick` → `ping` 则 `void this.runPing()`（**不 await**，tick 永不阻塞）
  并在 ping 结束后按结果决定是否 `arm()`；`skip` 为终局原因 ⇒ 不 `arm()`（空闲会话零定时器），
  否则 `arm()`。
- `noteRequest` 时若 `timer === undefined` ⇒ `arm()`。
- **被否决**：`setInterval` 常驻 + `unref()`。理由：与仓库 `Clock` 抽象不一致、不可用 FakeClock
  精确断言、空闲会话白转。

### 8.4 `runPing()` 骨架（B1 + m2）

```
const pingEpoch = this.window.windowEpoch;   // ★ I-K8：开局绑定窗口代际
this.pingEpochInFlight = pingEpoch;
onPingStarted(now)
  ├─ model = safeRead(() => this.ctx.model)             // stale ctx ⇒ dispose 并返回
  ├─ auth  = await ctx.modelRegistry.getApiKeyAndHeaders(model)
  │     └─ await 后：if (!this.sameEpoch(pingEpoch)) return;   // 含 disposed（I-K6 + I-K8）
  │        auth.ok === false ⇒ lastSkip="no-auth"，回退预算（pings -= 1），不计 unproven
  ├─ 指纹复核 compareFingerprint（含 authHeaderKeys）      // G7 / M4
  ├─ m2：重新检查 now < aliveUntil − margin，不过则放弃并回退预算
  ├─ this.abortController = new AbortController()
  ├─ outcome = await sendKeepalivePing(buildPingRequest(...), { fetchImpl, signal })
  │     └─ await 后：if (!this.sameEpoch(pingEpoch)) return;   // ★ 迟到结果在此被丢弃
  ├─ if (!this.sameEpoch(pingEpoch)) return;            // ★ reducer 写入前最后一道
  ├─ reducer：onProvenHit(w, s, outcome, pingEpoch) / onUnproven(w, s, kind, now, pingEpoch)
  │     （reducer 内部再断言一次 `pingEpoch === w.windowEpoch`，纯函数层自证，不依赖调用方）
  ├─ 可见性：setStatus（try/catch）、appendEntry 审计（带 pingEpoch/windowEpoch 便于复盘）、
  │         emit("subagent:keepalive", …)
  └─ finally：if (this.pingEpochInFlight === pingEpoch) {
                this.abortController = undefined; this.pingEpochInFlight = undefined;
              }                                        // 不抢新窗口的槽位
```

- “回退预算”只用于**请求从未发出**的两条路径（no-auth、m2 越界）；一旦 fetch 发出就绝不回退
  （防止失败风暴绕过 I-K2）。
- **epoch 失配时连 `pingInFlight` 也不清**——那已经是新窗口的字段，不属于这次 ping；只加
  `dropped.epochMismatch`，其余一概不动。新窗口的 `pingInFlight` 由 `onRealRequest` 置 `false`。
- `windowEpoch` 自增点（全在 reducer 里，纯函数可测）：`onRealRequest`、`invalidate`、
  `setEnabled(false)`、以及身份失配后的自我 dispose。`onProvenHit` **不**自增
  （同一窗口继续续期，epoch 保持不变才能让后续 ping 正常回写）。

---

## 9. 三道护栏与可观测性（问题 5｜M2 + M5 修订）

### 9.1 护栏 a：可见（M5）

状态栏 key 用独立的 `"cache-keepalive"`（不挤占 `"cache-ttl"` 的模式徽标；HUD footer 会聚合渲染
其他扩展的 status，见 `src/hud/footer.ts:4`）。文案（纯函数 `renderKeepaliveStatus`）：

| 情形                       | 文案                                               |
| -------------------------- | -------------------------------------------------- |
| 会话内未 ping 且当前未武装 | `undefined`（不占地方）                            |
| 武装中、窗口内已 ping k 次 | `♻ 保活 k/11 · 会话 N 次 · 读 620k tok · ≈$0.31`   |
| 同上但费率未知             | `♻ 保活 k/11 · 会话 N 次 · 读 620k tok · 费用未知` |
| 预算耗尽                   | `♻ 保活 11/11 上限（下次必写将转 1h）`             |
| 本窗口停（unproven）       | `♻ 保活 本轮已停：<kind>`                          |
| 整会话禁用                 | `♻ 保活 已禁用（<reason>，N 次）`                  |

- `会话 N 次 / 读 X tok` 只要 `session.pings > 0` 就一直显示到会话结束——**花过的钱必须一直看得见**
  （I-K3）；`≈$` 前缀表示 estimated，费率缺失时改成“费用未知”，**绝不显示 $0**（M5）。
- 费用后可带 `?` 标注前缀来源（`prefix.source`）与是否发生过 unproven。

### 9.2 M2 审计：区分「ping 救了一次 miss」与「ping 白花」

窗口关闭（`onRealRequest`）或会话结束时结算（`closeWindowAccounting`）：

```
若 w.pings === 0                          → 不计
否则 若 now < w.windowStartAt + ASSUMED_TTL_MS   // 无 ping 时缓存本来也活着
      → s.unnecessaryWindows += 1; s.unnecessaryPings += w.pings
否则  → s.loadBearingWindows += 1; s.loadBearingPings += w.pings;
        s.avoidedMissTokens += w.capture?.prefix.tokens ?? 0
```

- 判据直击 §0.3 判据 2：无 ping 的条目会在 `windowStartAt + 300s` 死掉，真实请求早于该时刻
  ⇒ ping 没避免任何 miss（纯亏 `0.1P × k`）；晚于该时刻 ⇒ ping 确实顶住了一次全量写。
- 两组计数进 `/cache-ttl status` 与审计条目，**让用户事后能用实测数据重评默认开启是否划算**
  （用户要求的唯一 M2 补偿动作）。

### 9.3 护栏 b / c 与 HUD 回填结论

- **护栏 b（硬上限）**：每窗口 `maxPings`（默认 11，迁移表 #14）；存活期门 #13 限制密度；
  I-K7 的三条会话级停用阈值；`maxPings = 0` 等价关闭。
- **护栏 c（净省钱）**：§5.4 的 G1–G9 + §7.5 的 proven-hit-only 自证。
- **带外 usage 不能回填 HUD**（`explore.md §3` 已取证）：`src/hud/footer.ts:143-189` 只统计
  `ctx.sessionManager.getEntries()` 里 `role === "assistant"/"toolResult"` 的 `message.usage`；
  ping 不产生 message entry。**伪造 entry 明确禁止**（污染上下文与轮次统计，T9）。
  退路（全部实现）：① 状态栏（§9.1）；② `/cache-ttl status`；③ 审计条目
  `pi.appendEntry("subagent:cache-keepalive", {...})`（未注册 renderer ⇒ 不进 UI、不进上下文，
  只落 session 文件；先例 `src/compact-hint/threshold.ts:12` 的 `subagent:usage-tick`）；
  ④ 可选：`pi.events.emit("subagent:keepalive", …)` + HUD footer 一个 `ka` 段（步骤 7）。

### 9.4 `/cache-ttl status` 必须打印的字段

开关（设置值 + 进程内覆盖）· 间隔/上限 · 当前窗口 `k/上限` · 武装原因 · 会话 ping 次数 ·
实测 cache-read tokens · 费用（estimated 或“费用未知”）· `prefix.source` ·
`loadBearing/unnecessary` 窗口与 ping 数 · `avoidedMissTokens` · 最近一次结果与时间 ·
`unprovenTotal / consecutiveUnproven / provenWrites` · 是否 `disabled` 及原因 ·
`dropped.sessionMismatch` / `dropped.instanceMismatch`（B1 / I-K9 可观测）· `dropped.epochMismatch`（I-K8：抢占后迟到丢弃次数）· `lastSkip`。

---

## 10. 设置项（问题 6）

### 10.1 五个 spec（m1：数量统一）

| 键（存储/展示）                        | 内部字段                   | 类型          | 默认           | 说明                                    |
| -------------------------------------- | -------------------------- | ------------- | -------------- | --------------------------------------- |
| `cacheTtl.keepalive`                   | `keepalive`                | boolean       | **true**       | 保活总开关（用户维持默认开）            |
| `cacheTtl.keepaliveIntervalS`          | `keepaliveIntervalMs`      | 秒（内部 ms） | 240（240_000） | ping 间隔；parse 钳位 [60s, 280s]       |
| `cacheTtl.keepaliveMaxPings`           | `keepaliveMaxPings`        | count         | 11             | 每窗口硬上限；0 = 关闭                  |
| `cacheTtl.keepaliveMinPrefixTokens`    | `keepaliveMinPrefixTokens` | count         | 20000          | 前缀实测下界门槛                        |
| `cacheTtl.keepaliveUpgradeAfterBudget` | 同名                       | boolean       | true           | 允许「下一次必写请求」升级成 1h（§6.3） |

**不做设置项**（写死常量 + 注释）：`ASSUMED_TTL_MS`、`TTL_SAFETY_MARGIN_MS`、`TICK_INTERVAL_MS`、
`PING_TIMEOUT_MS`、`UNPROVEN_STREAK_LIMIT = 2`、`UNPROVEN_TOTAL_LIMIT = 3`、`PING_DENY_PROVIDERS`。
理由：这些是安全护栏，暴露出去等于允许用户把护栏调没（T10 同理）。

### 10.2 与 `cacheTtl.mode` 的关系（I-K5）

- 保活是**独立开关**，不改 `auto/on/off` 三档语义。
- `mode = on`（已 1h）⇒ payload 带 `ttl:"1h"` ⇒ G5 关门，保活自动休眠。
- `mode = off`（显式 5m）⇒ 保活照常，但 §6.3 的 1h 升级**不生效**。
- `mode = auto` ⇒ 保活工作；升级仅此档、且一次性。
- **disarm 一律回落 passthrough**：保活从不写 `cacheTtl.mode`、不持久化任何东西。
- 配额：按用户裁决**不做**任何配额感知（§15 R7）；唯一的可靠性卫生是 §7.5 的连续 2 次停用。

### 10.3 改动点（锚点来自 `explore.md §1`）

1. `src/config/settings.ts:133-135` — `CacheTtlSettings` 加 5 字段。
2. `src/config/settings.ts:327` — `DEFAULT_SETTINGS.cacheTtl` 补默认值。
3. `src/config/settings.ts:591-596` — `parseCacheTtlSettings` 改逐字段容错（抄 `parseMemorySettings`
   的内联 `bool()/num()`，`settings.ts:624-643`；`keepaliveIntervalMs` 用 `num(raw, d, 60_000, 280_000)`）。
4. `src/config/settings.ts:390-416` — `TIME_SETTING_MS_PATHS` 追加 `"cacheTtl.keepaliveIntervalMs"`。
5. `src/config/setting-specs.ts:236-240` 之后 — **5 条** spec：`bool` ×2、
   `seconds("cacheTtl.keepaliveIntervalMs", {min:60, max:280, …})`（spec key 为 `…IntervalS`）、`count` ×2。
6. **不动 `src/ui/`**（编辑器直接读 `SETTING_SPECS`）。

运行时快捷开关：`/cache-ttl keepalive on|off`（经 `port.setEnabled`，仅当前进程、不写盘；
持久化走 `/agent settings`）。

---

## 11. 失败语义与零悬挂（问题 7）

| 要求                     | 落实                                                                                                                                                                                                                          |
| ------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| ping 失败静默不重试      | `sendKeepalivePing` 永不抛；`onUnproven` 停本窗口；不打 `console.error`（TUI 噪音），只写 `session.lastUnproven` + 审计条目；仅**会话级停用**打一条 `console.warn`                                                            |
| 定时器                   | `clock.setTimer`（`systemClock` 内已 `unref()`）；`ping-client` 的超时 `timer.unref()`                                                                                                                                        |
| reader/socket/listener   | §7.4 的 `finally`：`clearTimeout` + `removeEventListener` + `controller.abort()` + `reader.cancel()`（m3）                                                                                                                    |
| stack dispose / shutdown | §2.5 的四条路径都调 `dispose()`；幂等                                                                                                                                                                                         |
| `/reload` 无残留         | 状态全在 service 实例；`session_shutdown` 里 `stack.keepalive?.dispose()`（模块级 `previousKeepalive` 在 reload 后不可达，必须 shutdown 兜底）                                                                                |
| 跨会话丢弃               | §2.4 + §8.2 的 `accept()` 四重校验（disposed / sessionId / instanceId / `isCurrent`）；`dropped.sessionMismatch`、`dropped.instanceMismatch` 可观测                                                                           |
| 并发 ping 去重           | `window.pingInFlight`（#11）+ 单个 `abortController` 槽                                                                                                                                                                       |
| 真实请求抢占             | `noteRequest` 若 `pingInFlight` ⇒ 立即 `abortController.abort()`（释放连接）并经 `onRealRequest` 自增 `windowEpoch`；被抢占那次 ping 的结果无论早到晚到、成功失败，**一律 epoch 失配丢弃**（取舍见 §7.5「abort 与迟到返回」） |
| abort 语义               | 同窗口内的 abort（超时）属 unproven，不推进时钟、不重试；跨窗口（抢占 / invalidate / 切换）的 abort 结果按 I-K8 丢弃——两者由 `sameEpoch` 区分；预算已在 `onPingStarted` 扣过                                                  |
| 不影响 pi 主流程         | ping 全程在 tick 里 fire-and-forget；`before_provider_request` 只做同步捕获与标志读写，绝不 await                                                                                                                             |

---

## 12. 取舍记录（被否决的备选）

| #   | 备选                                                           | 否决理由                                                                                                                                           |
| --- | -------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------- |
| T1  | `modelRegistry.complete()` 重建请求                            | 需重建 `Context`，序列化差一点就 miss + 1.25P 全量写（任务书已定）                                                                                 |
| T2  | 无条件 `max_tokens: 1`                                         | thinking 会话 400；摘掉 thinking 又作废 messages 缓存块 ⇒ 全量写                                                                                   |
| T3  | 非流式请求 + 读 body                                           | thinking 会话压不低 `max_tokens`，可能真生成几千 token；流式 + `message_start` 早停对两种会话都安全                                                |
| T4  | payload 全量 hash 指纹                                         | MB 级 payload 每请求一次全量序列化；用 §3.3 的结构化便宜指纹即可覆盖 M4 要求                                                                       |
| T5  | 给 1h TTL 会话也做 50 分钟 ping                                | v1 范围外（用户已付 2× 买了一小时）；留作后续（`ASSUMED_TTL_MS` 改为从 capture 推导）                                                              |
| T6  | 独立 `/cache-keepalive` 命令                                   | 同一主题，做成 `/cache-ttl` 子命令                                                                                                                 |
| T7  | **在 `wireCacheTtl` 闭包里自建 `setInterval`（v1 方案）**      | 生命周期由两个不相干 handler 管理，无法由 stack dispose 统一释放，且引入 B1 的“新盒子先建、stack 后换”窗口。**上游已拍板改为 stack service**（§2） |
| T8  | 用 `ctx.isIdle()` 作唯一“无请求在途”判据                       | 工具执行期间为 false，错杀“前台 Agent 阻塞”主场景                                                                                                  |
| T9  | 伪造 session entry 让 HUD 计入花费                             | 污染上下文与轮次统计，pi 无 usage-only 追加 API                                                                                                    |
| T10 | provider 允许名单 / 护栏常量做成设置项                         | 误配即账单事故；写死 + 注释                                                                                                                        |
| T11 | 常驻 `setInterval` + `unref()`（而非 `Clock.setTimer` 自续期） | 与仓库 `Clock` 抽象不一致、FakeClock 不能精确断言、空闲会话白转（§8.3）                                                                            |
| T12 | 用 `readBackgroundStatus()` 读后台状态                         | 那是给跨模块消费者的 `Symbol.for` 全局；stack 内部应直接用自己的 `query`/`bashJobs`（上游明确要求）                                                |
| T13 | 配额感知（`Retry-After`、429/402 分类、每日上限）              | 用户已裁决不需要；只保留连续 2 次 unproven 停用（§7.5、§15 R7）                                                                                    |

---

## 13. 测试矩阵（问题 9｜M6 + B1/B3 覆盖）

vitest，`tests/` 镜像 `src/`；沿用“各模块手搓极简 stub、不共享 harness”风格（`explore.md §2`）。
**服务层用 `FakeClock`**（`src/core/clock.ts:26+`，`pendingTimers` 可断言；先例
`tests/delivery/usage-broadcast.test.ts:2,58,86`），装配/集成层用 `vi.useFakeTimers()`。

### 13.1 `tests/cache-ttl/keepalive-state.test.ts`（纯状态机）

| 用例                   | 断言                                                                                                                                                          |
| ---------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 迁移表 #1–#16 逐条短路 | 表驱动，每个 `skip`/`invalidate` 原因命中且**终局/续期分类正确**                                                                                              |
| 存活期边界             | `now = aliveUntil − margin − 1` ⇒ ping；`= aliveUntil − margin` ⇒ `cache-expired`（必须覆盖）                                                                 |
| 时钟锚点               | `onRealRequest` 后 `nextPingAt = now + interval`；`onProvenHit` 用 `pingStartedAt` 推进                                                                       |
| 预算                   | 第 11 次后 `budget-exhausted` + `upgradePending`；第 12 次不 ping                                                                                             |
| 升级消费               | 仅 `mode==="auto"` + 设置开 + 距上次读 > TTL + sessionId 匹配时返回 true，且只一次                                                                            |
| **B3 会话级熔断**      | `proven-write` 一次 ⇒ `disabled`；`no-usage`/`accepted-then-lost`/`http`/`network`/`malformed` 连续 2 次 ⇒ `disabled`；交替命中/失败累计 3 次 ⇒ `disabled`    |
| **B3 窗口重置不复活**  | `onRealRequest` 后 `s.unprovenTotal/consecutiveUnproven/provenWrites/disabled` **全部不变**                                                                   |
| **M4 指纹**            | `provider/api/ctxModelId/baseUrl/authHeaderKeys/sessionId` 逐字段差异 ⇒ `fingerprint-drift:<field>`；`breakpointPath`/`toolsDigest`/`systemDigest` 变化被识别 |
| 事件作废               | 表中每个事件 ⇒ `capture === undefined` 且 `upgradePending` 清零                                                                                               |
| `inspectPayload`       | 嵌套/自引用成环（抄 `cache-ttl.test.ts:41-43`）、`ttl:"1h"`、`thinking:{type:"disabled"}`、无 `cache_control`                                                 |
| **M3 前缀**            | `source==="usage"` 且 ≥ 门槛 ⇒ 过；`source==="unknown"` ⇒ `prefix-unproven`（**即使 tokens 很大**）；“总 context 大但 cacheRead+cacheWrite 小” ⇒ 拒           |
| **M2 窗口分类**        | 真实请求早于 `windowStartAt + TTL` ⇒ `unnecessary*` 累加；晚于 ⇒ `loadBearing*` + `avoidedMissTokens`                                                         |
| **M5 成本**            | 分档 tiers 命中/不命中；`cost` 缺失或 `cacheRead === 0` ⇒ `undefined`；文案显示“费用未知”且**不含 `$0`**                                                      |
| 状态栏文案             | §9.1 六种情形逐一断言                                                                                                                                         |

### 13.2 `tests/cache-ttl/keepalive-ping.test.ts`（ping 客户端，注入假 fetch）

| 用例                                | 断言                                                                                                                                              |
| ----------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------- |
| 无 thinking / 有 thinking           | 前者 `max_tokens === 1`；后者保持原值且 `thinking` 原样；其余字段逐字相同（深比）                                                                 |
| URL / header                        | 去尾斜杠 + `/v1/messages`；`auth.baseUrl` 覆盖；非 OAuth ⇒ `x-api-key`；`sk-ant-oat…` ⇒ Bearer + 三个 claude-code header；`auth.headers` 覆盖默认 |
| SSE 分片                            | `data: {…}` 跨 chunk 切断后仍能取到 `message_start` usage                                                                                         |
| 成功早停                            | `proven-hit`；`reader.cancel` 被调用、`signal.aborted === true`、parent listener 已移除（m3）                                                     |
| **accepted-then-disconnect（B3）**  | 200 + 流在 `message_start` 前 `close`/`error` ⇒ `accepted-then-lost`（**不是** network）                                                          |
| **无 body / 无 usage / 双 0（B3）** | 分别 `malformed` / `no-usage` / `no-usage`                                                                                                        |
| 超时                                | `accepted-then-lost`（已收到响应头）或 `network`（未收到）分类正确；`clearTimeout` 被调用                                                         |
| 非 2xx                              | `{kind:"http", status}`；body 截断 2KB；reader/socket 释放（m3）                                                                                  |
| 64KB 内无 `message_start`           | `malformed` 且已 abort                                                                                                                            |
| **m2 auth 后越界**                  | 注入慢 auth 使 `now` 越过 `aliveUntil − margin` ⇒ **0 次 fetch**、预算回退                                                                        |
| 打码                                | 错误消息不含 apiKey 原文                                                                                                                          |

### 13.3 `tests/service/cache-keepalive.test.ts`（stack service，FakeClock）

| 用例                       | 断言                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            |
| -------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| tick 自续期/自停止         | `noteRequest` 后 `pendingTimers === 1`；终局 skip 后 `=== 0`；空闲会话 `=== 0`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  |
| **dispose 释放（B2/M6）**  | `dispose()` ⇒ `pendingTimers === 0`、在途 `abort()` 被调、`setStatus("cache-keepalive", undefined)`、二次 `dispose()` 幂等                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| **跨会话失配（B1）**       | `noteRequest({sessionId:"other"})` / `sessionId:""` ⇒ 状态不变、`dropped.sessionMismatch` 递增、0 次 fetch                                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| **实例失配（I-K9）**       | 同 sessionId 但 `instance` 为旧值 ⇒ `dropped.instanceMismatch` 递增、状态不变；`isCurrent()` 返回 false（模拟 `/reload` 后的旧实例）时即使 sessionId 与 instanceId 都对也丢弃                                                                                                                                                                                                                                                                                                                                                                                   |
| **epoch 失配（I-K8/B5）**  | ①**抢占后旧 ping 迟到返回**：ping 在飞时 `noteRequest` 抢占（abort + `windowEpoch+1`），随后让假 fetch **成功**返回 `proven-hit` ⇒ `dropped.epochMismatch === 1`、`session.pings` 不变、`consecutiveUnproven` **未被清零**、`aliveUntil`/`nextPingAt` **逐字段等于新窗口真实请求写入的值**（不被旧 `pingStartedAt` 推进）；②同场景下假 fetch 返回 `accepted-then-lost` ⇒ `unprovenTotal`/`consecutiveUnproven`/`provenWrites` 全不变；③`invalidate()` / 自我 dispose 造成的 epoch 变化同样丢弃；④失配路径不清新窗口的 `pingInFlight`、不占 `abortController` 槽 |
| **await 后 dispose（B1）** | fetch pending 期间 `dispose()` ⇒ 回调不写状态栏/审计、不推进时钟                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                |
| stale ctx                  | `ctx.model` / `ctx.sessionManager` getter 抛错 ⇒ 自我 `dispose()`，不冒泡                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       |
| 武装来源                   | `backgroundBusy()` true / `activeTools>0` / `uiPrompts>0` 三路各自可触发；`agent_settled` 归零 `activeTools`                                                                                                                                                                                                                                                                                                                                                                                                                                                    |
| 抢占                       | ping 在途时 `noteRequest` ⇒ `abort()` 被调 + 窗口重置 + `windowEpoch` 自增；该次 ping 的任何结果都不回写（见下一行 epoch 用例）                                                                                                                                                                                                                                                                                                                                                                                                                                 |
| no-auth                    | `ok:false` ⇒ 不 fetch、预算回退、`lastSkip==="no-auth"`、**不计** unproven                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      |

### 13.4 `tests/cache-ttl/cache-ttl.test.ts`（扩充现有文件）

- 现有 6 个用例的 handler 第二参数从 `{}` 换成最小 ctx（`ui` / `model` / `sessionManager.getSessionId`），
  `explore.md §2` 已预警签名变化。
- **holder 为空（M6）**：`deps.keepalive` 未注入 / 返回 `undefined` ⇒ handler 返回值与今天一致、
  不抛、不 warn（三种空态各一例）。
- `auto` 模式仍返回 `undefined`，但 `noteRequest` 收到**独立副本**（改捕获副本不影响 `event.payload`）。
- `upgradePending` 时 `auto` 走 `on` 改写，且只一次；`off` 模式不升级。
- `structuredClone` 失败 ⇒ `invalidate("clone-failed")` 且现有 warn 行为不变。
- `/cache-ttl keepalive on|off`、`/cache-ttl status` 输出（含“费用未知”与 `dropped` 字段）。

### 13.5 `tests/config/cache-ttl-settings.test.ts`（新建，m1）

5 条 spec 的 `kind/path/min/max/time` 断言 + `isTimeSettingKey("cacheTtl.keepaliveIntervalS") === true`

- ms↔s 映射（`msKeyOf/secondsKeyOf`）+ `parseCacheTtlSettings` 容错矩阵（缺失/类型错/越界钳位）。
  范式：`tests/config/extend-settings.test.ts:45-72`。

### 13.6 `tests/integration/cache-keepalive-wiring.test.ts`（新建；命名对齐 `tests/integration/*-wiring.test.ts`）

假 pi + 假 fetch + `vi.useFakeTimers()`，驱动**真实的** `buildSessionStack` + `wireCacheTtl`：

1. `session_start` → 真实请求（带 ephemeral 的 payload + 已有 assistant usage）→ 无后台 ⇒ 推进 5 分钟 ⇒ **0 次 fetch**。
2. 制造后台忙（`query.list()` 有 running run 或 `bashJobs.backgroundJobCount() > 0`）⇒ 推进 4 分钟
   ⇒ 恰好 1 次 fetch，body `max_tokens === 1`。
3. **stack 重建（B2/M6）**：再次 `session_start`（`/new`）⇒ 旧 service 被 build 顶部 dispose：
   `vi.getTimerCount()` 不累积、旧 ctx 的 `setStatus`/`appendEntry` 再不被调用。
4. **跨会话 / 跨实例丢弃（B1、I-K9）**：新 session 建立后，用**旧 sessionId** 触发一次
   `before_provider_request` ⇒ 新 service 捕获不变、`dropped.sessionMismatch === 1`、0 次新增 fetch；
   再用**同 sessionId + 旧 instanceId**（模拟 `/reload` 重建）触发一次 ⇒
   `dropped.instanceMismatch === 1`、捕获仍不变。
5. **抢占后迟到返回（B5、I-K8）**：让假 fetch 挂住，期间发一次真实请求（抢占 ⇒ abort +
   `windowEpoch+1`），再放行假 fetch 返回 `proven-hit` ⇒ `dropped.epochMismatch === 1`；
   断言新窗口 `aliveUntil` 未被旧 ping 推进、`consecutiveUnproven` 未被清零、会话 ping 次数不增、
   且后续 tick 的到期时刻仍由真实请求锚定。
6. **B3 反复烧写闭合**：让 fetch 连续返回 accepted-then-disconnect，在**每次失败后都插入一次真实请求**
   ⇒ 第 2 次连续 unproven 后 `disabled`，此后任意真实请求 + 推进时间都 **0 次 fetch**。
7. `cache_creation_input_tokens > 0` ⇒ 立即 `disabled`，状态栏显示禁用原因。
8. 预算耗尽 ⇒ 第 12 次不发；随后一次「距上次读 > TTL」的真实请求 ⇒ 返回 payload 带 `ttl:"1h"`。
9. **第三方后置 handler**：注册一个在我们之后改写 payload 的假扩展 handler ⇒ 首个 ping 的结果被
   假 fetch 判为 `proven-write` ⇒ 立即 `disabled`（验证兜底链路，而非验证能识别第三方）。
10. `session_shutdown` ⇒ `getTimerCount() === 0`、在途 fetch signal `aborted`。

---

## 14. 分步施工顺序（问题 10｜按两层拆分）

每步独立可提交、可回滚，Conventional Commits。验证统一为 `npm run typecheck && npx vitest run <相关测试>`，
最后一步跑全量四件套。**顺序原则（M6）：先定 holder + stack service 生命周期，再写装配集成测试。**

| 步骤                                | 提交                                                                               | 涉及文件                                                                                                                                                                                                                                              | 验证                                                                                    |
| ----------------------------------- | ---------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------- |
| **1. 设置项**                       | `feat(config): cache-ttl keepalive settings`                                       | `src/config/settings.ts`、`src/config/setting-specs.ts`、`tests/config/cache-ttl-settings.test.ts`                                                                                                                                                    | `npx vitest run tests/config tests/ui/settings-editor.test.ts`                          |
| **2. 纯层：状态机 + 指纹 + 文案**   | `feat(cache-ttl): keepalive state machine, fingerprint and accounting (pure)`      | `src/cache-ttl/keepalive-state.ts`、`tests/cache-ttl/keepalive-state.test.ts`                                                                                                                                                                         | `npx vitest run tests/cache-ttl/keepalive-state.test.ts`                                |
| **3. 纯层：ping 请求构造 + 客户端** | `feat(cache-ttl): anthropic keepalive ping request builder and client`             | `src/cache-ttl/ping-client.ts`、`tests/cache-ttl/keepalive-ping.test.ts`                                                                                                                                                                              | `npx vitest run tests/cache-ttl/keepalive-ping.test.ts`                                 |
| **4. 生命周期骨架（B1+B2 先行）**   | `feat(stack): own the cache-keepalive service lifecycle`                           | `src/service/cache-keepalive.ts`（骨架：accept/dispose/tick，ping 走注入）、`src/stack.ts`（`previousKeepalive`、`Stack.keepalive`、dispose 块、构造）、`src/index.ts`（holder read-through + 两处 dispose）、`tests/service/cache-keepalive.test.ts` | `npx vitest run tests/service/cache-keepalive.test.ts tests/integration/wiring.test.ts` |
| **5. 捕获接缝**                     | `feat(cache-ttl): capture the outgoing payload for keepalive`                      | `src/cache-ttl/cache-ttl.ts`（handler 加 `ctx`、捕获、`invalidate`）、`tests/cache-ttl/cache-ttl.test.ts`（含 holder 空态）                                                                                                                           | `npx vitest run tests/cache-ttl`                                                        |
| **6. 真正发 ping + 熔断**           | `feat(service): send prompt-cache keepalive pings with proven-hit-only breaker`    | `src/service/cache-keepalive.ts`（auth、m2 复查、结果分类、B3 计数）、`tests/service/*`、`tests/integration/cache-keepalive-wiring.test.ts`                                                                                                           | `npx vitest run tests/service tests/integration/cache-keepalive-wiring.test.ts`         |
| **7. 可见性 + M2 审计**             | `feat(cache-ttl): keepalive status bar, /cache-ttl status and window accounting`   | `keepalive-state.ts`（文案/分类）、`src/service/cache-keepalive.ts`（setStatus/appendEntry/emit）、`src/cache-ttl/cache-ttl.ts`（`status` 子命令）、对应测试                                                                                          | `npx vitest run tests/cache-ttl tests/service`                                          |
| **8. 预算耗尽升级**                 | `feat(cache-ttl): upgrade the next unavoidable write to 1h after keepalive budget` | `keepalive-state.ts`（`consumeUpgrade`）、`cache-ttl.ts`（effectiveMode）、集成测试第 7 步场景                                                                                                                                                        | `npx vitest run tests/cache-ttl tests/integration/cache-keepalive-wiring.test.ts`       |
| **9.（可选）HUD 段**                | `feat(hud): show keepalive read/cost segment`                                      | `src/service/cache-keepalive.ts`（emit）、`src/hud/index.ts`、`src/hud/footer.ts`、`tests/hud/*`                                                                                                                                                      | `npx vitest run tests/hud`                                                              |
| **10. 文档**                        | `docs: document prompt-cache keepalive`                                            | `README.md:98,210`、`README.en.md:102,214`、`AGENTS.md`（`src/cache-ttl/` + `src/service/` 条目）、`CHANGELOG.md`                                                                                                                                     | `npm run format:check`                                                                  |
| **收尾**                            | —                                                                                  | —                                                                                                                                                                                                                                                     | `npm run format && npm run typecheck && npm test && npm run build`                      |

依赖关系：1–3 可并行；**4 必须在 5/6 之前**（先立生命周期与会话身份，再接捕获与发包）；
7/8 依赖 6；9 可选、最后做。

---

## 15. 风险登记

| 风险                                           | 影响                                                   | 缓解                                                                                                                                                                                  |
| ---------------------------------------------- | ------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **R1 重放前缀对不上 ⇒ 1.25P 全量写**           | 最贵的失败模式                                         | 逐字重放（仅允许下调 `max_tokens`）+ 存活期门 #13 + M4 指纹 + **I-K7 proven-hit-only 熔断**（proven write 一击停、连续 2 次 unproven 停、累计 3 次停）                                |
| **R2 跨会话捕获（B1）**                        | 旧 payload 记入新窗口 ⇒ R1                             | 服务随 stack 诞生（窗口结构性消失）+ `accept()` 四重校验（disposed / sessionId / instanceId / `isCurrent`）+ 每个 await 返回点复查 + `dropped.*Mismatch` 可观测                       |
| **R3 OAuth/网关 header 复刻不全**              | ping 恒失败                                            | 失败即停（连续 2 次整会话停）；`/cache-ttl status` 展示 `lastUnproven`；header 逐条对齐 `anthropic-messages.js:660-716`                                                               |
| R4 `requestInFlight` / `activeTools` 漏清零    | 永不 ping / 空闲期误武装                               | 五路事件冗余清零、`agent_settled` 归零、预算硬顶 11 次；失败方向安全                                                                                                                  |
| R5 pi 升级改了 payload 组装或 hook 语义        | 捕获失真                                               | peer 版本区间 + `src/adapters/pi-compat.ts` + R1 熔断兜底                                                                                                                             |
| R6 短空档纯亏（M2）                            | 每窗口最多多花 `0.1P × k`                              | **用户已裁决接受**；不加严武装、不加成本上限；改为 `loadBearing/unnecessary` 分类计数，供日后用实测数据重评                                                                           |
| **R7 配额/限流消耗**                           | 订阅额度被 ping 分摊                                   | **用户已裁决为可接受，不加护栏**（无 `Retry-After`/429 分类/每日上限）；仅有的间接约束是连续 2 次 unproven 即整会话停（§7.5）与每窗口 11 次硬顶                                       |
| R8 `readLatestAssistantCacheTokens` 扫 entries | 轻微 CPU                                               | 从后向前、命中即停；与 HUD 每秒一次全量遍历（`footer.ts:143`）相比可忽略；read-back 不可用即不 ping                                                                                   |
| **R2b 抢占后迟到 ping 回写（B5）**             | 误判缓存存活 ⇒ 下次 ping 撞死条目 ⇒ 全量写；并掩盖熔断 | `windowEpoch` 绑定 + 每个 await 返回点与 reducer 前 `sameEpoch()`；失配一律不计数、不回写（I-K8、§7.5）。残余：被抢占那次 ping 若真造成写入，该证据不进 breaker（取舍已在 §7.5 写明） |
| **R9 漏发 `session_shutdown` 且此后无 build**  | 在途 fetch/reader/socket 不被显式释放                  | **上游已裁决为过度防御，不加任何机制/hook**：该场景意味着进程正在退出或永久空闲，unref 的定时器不阻塞退出、在途 socket 随进程消亡。作为**可接受残余风险**登记在此，不再新增释放路径   |
