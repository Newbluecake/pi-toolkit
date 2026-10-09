# topic-switch 架构设计（v1）

> 输入：`docs/dev/topic-switch/requirements.md`（用户拍板，权威）。本文只定架构与契约，不含实现代码。
> pi 路径前缀约定：`PI=…/@earendil-works/pi-coding-agent/dist`、`PIAI=…/pi-coding-agent/node_modules/@earendil-works/pi-ai/dist`。

## 1. 背景与目标

用户在**空闲**时发来新请求；如果它与本会话历史**无关**，而且在本会话继续处理**很贵**（缓存已过期 + 预计下一次请求
成本 > 阈值，默认 $0.5），就请用户确认要不要把**这条请求原样**（文本 + 图片）带进一个**干净的新会话**。

硬约束（要求文档的「不变式」节）：任何失败都 fail-open（请求照常进当前会话）；绝不吞消息；print 模式或无 UI 时不弹窗；
timer 一律 unref；模块级不放可变状态；只在主会话做；默认开启。

## 2. 现状摘要（设计依赖的事实）

| 主题                      | 事实                                                                                                                                                                         | 位置                                                                                                                    |
| ------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------- |
| `input` 事件              | `{text, images?, source: interactive\|rpc\|extension, streamingBehavior?}`；结果 `continue\|transform\|handled`                                                              | `PI/core/extensions/types.d.ts:873-893`                                                                                 |
| 分发                      | `emitInput` 按注册顺序**串行 await**，`handled` 立即短路；handler 抛错 ⇒ emitError 后当作 continue                                                                           | `PI/core/extensions/runner.js:1202-1238`                                                                                |
| prompt 管线               | `/` 开头且 `expandPromptTemplates` ⇒ 先做扩展命令分发（流式中也立即执行）→ 压缩中直接抛错 → input handlers → 流式中无 `streamingBehavior` 则抛 "Agent is already processing" | `PI/core/agent-session.js:1481-1520`                                                                                    |
| `pi.sendUserMessage`      | 走 `prompt(source:"extension", expandPromptTemplates 默认 false)`；扩展 API 包装成 fire-and-forget，异常只 emitError（**静默丢消息**）                                       | `agent-session.js:1812-1840`、`2676-2683`                                                                               |
| TUI 提交                  | 主循环串行：`await getUserInput(); await session.prompt()`；非流式时的提交进 `pendingUserInputs`；流式时走 steer                                                             | `PI/modes/interactive/interactive-mode.js:909-911,2675-2690`                                                            |
| 新会话                    | 只有 `ExtensionCommandContext.newSession({withSession})`；`ReplacedSessionContext.sendUserMessage` 返回 **Promise**（可 await、可 catch）                                    | `types.d.ts:288-339`                                                                                                    |
| 对话框                    | `ctx.ui.select(title, options, {signal, timeout})`，自带倒计时                                                                                                               | `types.d.ts:40-45,74`                                                                                                   |
| 自发命令先例              | deferred reload 用 `pi.sendUserMessage("/agent reload fire", {expandPromptTemplates:true})` 进命令分发                                                                       | `src/reload/index.ts:13-22,44-47`                                                                                       |
| 一次性 nonce 跳板先例     | web-hub `/webhub __exec new <nonce>`：5s TTL、只能消费一次，然后 `ctx.newSession()`                                                                                          | `src/web-hub/agent/index.ts:322-337,1381-1397`；`src/commands/webhub.ts:358-366`                                        |
| web 端跟随                | `/new` 之类在同一进程内复用连接，新的 `session_start` 会重新挂接并发出新的 session 帧                                                                                        | `src/web-hub/agent/index.ts:10-14,1033-1056`                                                                            |
| web prompt 来源           | web prompt 通过 `pi.sendUserMessage` 注入（source=`extension`），事先写入 ledger，`onInputEvent` 按文本匹配                                                                  | `src/web-hub/agent/commands.ts:246-256,621-665`                                                                         |
| 双端竞速                  | `AskUserRemotePort.open({toolCallId, questions, allowCancel})` 加上同步的 `createDialogRace()`                                                                               | `src/ask-user/remote.ts:26-54`；TUI 竞速 `src/ask-user/index.ts:146-320`，RPC `343-430`                                 |
| remote 端口装配           | `askUserRemoteRef`，只在 `webHub.remoteAskUser` 开且已连接时有值                                                                                                             | `src/index.ts:146,291-298,943`                                                                                          |
| 便宜模型直调先例          | 标题生成直接调 `ctx.modelRegistry.complete(model, {systemPrompt, messages}, {signal, maxTokens})`，不起子会话                                                                | `src/title/index.ts:24-28,182-199`；默认模型 `zai-coding-cn/glm-5.3-flash`（`src/config/settings.ts:960-966`）          |
| 账本                      | `readLatestAssistantUsage`：反向扫描找最近一条带 usage 的 assistant，读出 cacheRead/Write/1h 拆分和 modelId                                                                  | `src/cache-ttl/usage-ledger.ts:71-107`                                                                                  |
| 冷暖判据                  | adaptive：`lastReadAt = max(lastRequestStartedAt, provenCacheReadAt)`，`warm = now-lastReadAt < WARM_WINDOW_MS`                                                              | `src/cache-ttl/adaptive.ts:129,786-790`                                                                                 |
| TTL 常量                  | `ASSUMED_TTL_MS=300_000`、`TTL_SAFETY_MARGIN_MS=45_000`                                                                                                                      | `src/cache-ttl/keepalive-state.ts:31-33`                                                                                |
| 保活证据                  | `KeepalivePort.provenCacheReadAt()`                                                                                                                                          | `src/service/cache-keepalive.ts:161`                                                                                    |
| 1h 覆盖                   | `AdaptiveSnapshot.coverRemainingMs`、`isPrefix1hCovered`                                                                                                                     | `src/cache-ttl/adaptive.ts:1312-1316,621-630`                                                                           |
| 本次请求 TTL 动作         | `before_provider_request` 里由 mode 和决策算出 `force-1h \| strip-ttl \| passthrough`；`wireCacheTtl` 目前返回 void                                                          | `src/cache-ttl/cache-ttl.ts:321,340-388`                                                                                |
| 价格                      | pi-ai `calculateCost`：按 tier 计价，**1h 写 = 2×input**，5m 写 = `cost.cacheWrite`                                                                                          | `PIAI/models.js:660-680`                                                                                                |
| 仓库自有 pi-free 价格模型 | `buildPriceModel`、`rateAt`（tier 语义与 calculateCost 一致）                                                                                                                | `src/compact-hint/dynamic/pricing.ts:49-67`                                                                             |
| 后台忙判定                | `activeSubagentRunCount`；Stack 上的 `bashJobs`/`workflow.activity`/`goal`                                                                                                   | `src/index.ts:632`；`src/stack.ts:880-934,2205-2215`                                                                    |
| 已有 input handler        | mention（`@label` handled）、feishu（关键词 transform）、session-nav（交互式 exit）、web-hub 转发                                                                            | `src/index.ts:724`；`src/feishu-notify/index.ts:494`；`src/session-nav/index.ts:164`；`src/web-hub/agent/index.ts:1122` |
| 有界等待                  | `withDeadline(p, ms, clock, label)`（systemClock 已 unref）                                                                                                                  | `src/core/deadline.ts:236`                                                                                              |

浏览器不渲染 `input` 事件（`event-tap.ts:339-343` 转发了，但 `src/web-hub/ui/src` 里没有消费方），所以截留再回注不会出现重复气泡。

## 3. 总体设计

### 3.1 模块划分

```
src/topic-switch/                ← pi-free 决策核心（不 import pi）
  types.ts        TopicSwitchSettings / GateFacts / GateVerdict / JudgeInput / JudgeVerdict / HoldItem / Outcome
  filters.ts      零成本消息过滤（前缀、长度、承接词、上一条回复在提问）
  economics.ts    estimateNextRequestUsd()：tokens × 价格（5m/1h 写价，tier 感知）
  gate.ts         evaluateSyncGates()：按序跑门 1-3，返回第一个失败原因码
  judge.ts        buildJudgePrompt() / parseJudgeReply()（纯函数）；judgeRelevance(port) 带硬超时
  state.ts        冷却记录（序列化/读回）、hold 状态机、nonce 表、诊断计数
src/topic-switch/wire.ts         ← pi-facing：wireTopicSwitch(pi, deps)；input handler、/topic-switch 命令、
                                   回注、会话切换、shutdown/压缩跟踪、状态栏
src/topic-switch/confirm.ts      ← 结构化 pi-facing：ui.select ⟂ AskUserRemotePort 竞速（复用 createDialogRace）
src/cache-ttl/warmth.ts          ← 新增，pi-free：assessWarmth()；缓存冷暖知识留在 cache-ttl
src/cache-ttl/cache-ttl.ts       ← 改：记录 lastSent，wireCacheTtl 返回 { warmth: CacheWarmthPort }
src/cache-ttl/usage-ledger.ts    ← 改（只追加字段）：LedgerUsage.at?（该 assistant 消息的 timestamp）
src/web-hub/agent/index.ts       ← 改（可选，见 D2）：WebHubControl.isWebPrompt(text)
src/config/settings.ts           ← topicSwitch 块 + parseTopicSwitchSettings
src/index.ts                     ← 只做装配：post-guard、wireWebHub 之后调用 wireTopicSwitch
```

### 3.2 依赖方向

```
index.ts ──► topic-switch/wire.ts ──► topic-switch/{gate,economics,filters,judge,state}.ts (pi-free)
                 │                            │
                 │                            └──► compact-hint/dynamic/pricing.ts (pi-free，复用)
                 ├──► CacheWarmthPort ◄── cache-ttl/cache-ttl.ts ──► cache-ttl/warmth.ts (pi-free)
                 │                                   └── 读 keepalive / adaptive（holder 透传）
                 ├──► holder.current (Stack: query / workflow.activity / bashJobs / goal)
                 ├──► askUserRemoteRef（web 确认）、webHubRef?.isWebPrompt（web 来源判定）
                 └──► ctx.modelRegistry.complete（便宜模型）
```

topic-switch 不 import cache-ttl 内部状态，只经端口读取；cache-ttl 完全不知道有 topic-switch 这个功能。

### 3.3 触发管线（有序门；1–3 同步零 I/O，4–5 异步）

handler 必须是**同步快速路径**：门 1–3 任何一个不过就立刻 `return {action:"continue"}`，99% 以上的消息零额外延迟。
只有门 1–3 全过，才 `return {action:"handled"}` 截留，然后在 handler 之外异步跑门 4–5。

| #   | 门                  | 数据来源                                                                                                                                                                  | 失败行为                                                 | 成本                                       |
| --- | ------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------- | ------------------------------------------ |
| 1a  | 开关、主会话、有 UI | `settings.topicSwitch.enabled`；post-guard 装配（子会话/consult 结构上不可达，`src/index.ts:225`）；`ctx.mode∈{tui,rpc} && ctx.hasUI`                                     | continue                                                 | O(1)                                       |
| 1b  | 空闲新一轮          | `event.streamingBehavior===undefined && ctx.isIdle() && !ctx.hasPendingMessages()`（`types.d.ts:236,244`）                                                                | continue                                                 | O(1)                                       |
| 1c  | 冷却                | state.ts 冷却记录（§6）                                                                                                                                                   | continue                                                 | O(1)                                       |
| 1d  | 后台不忙            | `activeSubagentRunCount()>0`、`stack.workflow.activity.list().length>0`、`stack.bashJobs?.backgroundJobCount()>0`（同 `stack.ts:2208-2213` 的口径）                       | continue                                                 | O(runs)                                    |
| 1e  | 会话级占用          | `stack.goal.phase ∈ {active,paused}` ⇒ 跳过；有 `in_progress` 的 todo ⇒ 跳过（`replayState`，同 `session-facts.ts:78-85`）                                                | continue                                                 | O(branch)                                  |
| 2a  | 来源                | `interactive`/`rpc` 放行；`extension` 只在 `isWebPrompt(text)` 为真时放行（D2），其余（goal/cron/reload/通知/我们自己回注的）一律跳过                                     | continue                                                 | O(1)                                       |
| 2b  | 文本                | trim 后以 `/`、`//`、`!` 开头 ⇒ 跳过；码点数 < `minChars` ⇒ 跳过（只有图片、没有文字也算短）                                                                              | continue                                                 | O(n)                                       |
| 2c  | 承接                | 整句命中短回复表（继续/好的/嗯/ok/push/commit/方案X/选X/数字…）或前 12 个码点内有指代词（这个/那个/刚才/上面/上述/前面/接着/还是/再/它/this/that/above/again/same）⇒ 跳过 | continue                                                 | O(n)                                       |
| 2d  | 上文在提问          | 最近一条 assistant 文本以 `?`/`？` 结尾，或上一轮有 `ask_user` 工具调用 ⇒ 跳过                                                                                            | continue                                                 | 反向扫描，遇到第一条 assistant 就停        |
| 2e  | 首轮                | 分支里还没有 assistant 消息 ⇒ 跳过                                                                                                                                        | continue                                                 | 同上                                       |
| 3a  | 缓存已过期          | `warmth.assess(ctx, now).state === "cold"`（§4.1）；`warm`/`unknown` ⇒ 跳过                                                                                               | continue                                                 | 一次账本扫描                               |
| 3b  | 足够贵              | `estimateNextRequestUsd(...)`：`kind==="priced" && usd > costThresholdUsd`；`unpriced`/`unknown` ⇒ 跳过                                                                   | continue                                                 | O(tiers)                                   |
| —   | **截留**            | 推入 hold，`return {action:"handled"}`，状态栏显示 `topic check…`                                                                                                         | —                                                        | —                                          |
| 4   | 便宜模型判相关      | §5；`withDeadline(judgeTimeoutMs)`；只有 `related===false && confidence ≥ minConfidence` 才往下走                                                                         | 超时/报错/解析失败/判相关 ⇒ **回注当前会话**（不进冷却） | ≈2k 输入 token、≤64 输出，约 $0.001，1–3 s |
| 5   | 用户确认            | §7；`confirmTimeoutMs`                                                                                                                                                    | 选留下/Esc/超时/UI 出错 ⇒ 回注当前会话 + 进冷却          | 用户时间                                   |
| —   | 选「切换」          | §6.2 命令跳板                                                                                                                                                             | 跳板失败 ⇒ 回注当前会话                                  | —                                          |

排序原则：先过最便宜、最常命中的门；只读账本的门（2d/3a）放后面。每个门都只认「证据充分」：拿不准的 ⇒ 不问。
这就是本功能的 fail-open 方向：**少问是安全的，错问才是代价**。

## 4. 接口契约

### 4.1 CacheWarmthPort（cache-ttl 提供，复用其知识，不重算经济学）

```ts
// src/cache-ttl/warmth.ts（pi-free）
export type CacheWarmth =
  | { state: "warm"; reason: "within-ttl" | "keepalive-proven" | "1h-cover"; expiresAt: number }
  | {
      state: "cold";
      reason: "ttl-elapsed" | "model-changed";
      lastReadAt: number | undefined;
      ttlMs: number;
      nextWriteTtl: "5m" | "1h" | "none";
    }
  | { state: "unknown"; reason: "no-ledger" | "unsupported-api" | "read-error" };

export interface WarmthInput {
  now: number;
  route: { api: string; provider: string; modelId: string }; // 下一次请求的 ctx.model
  ledger: LedgerUsage; // readLatestAssistantUsage(ctx)，追加了 at
  lastSent?: { at: number; sessionId: string; modelId: string; ttl1h: boolean; cached: boolean };
  provenCacheReadAt?: number; // keepalive?.provenCacheReadAt()
  coverRemainingMs?: number; // adaptive?.snapshot().coverRemainingMs
  mode: "auto" | "on" | "off" | "adaptive"; // wireCacheTtl 闭包里的实时 mode
  sessionId: string;
  slackMs: number; // settings.topicSwitch.expirySlackMs
}
export function assessWarmth(input: WarmthInput): CacheWarmth;

// cache-ttl.ts 新增返回值（目前是 void，line 321）
export interface CacheWarmthPort {
  assess(ctx: ExtensionContext, now: number): CacheWarmth;
} // 永不抛
```

`assessWarmth` 的判定按顺序：

1. `route.api !== "anthropic-messages"` ⇒ `unknown/unsupported-api`（D1）；账本 `source==="unknown"` ⇒ `unknown/no-ledger`。
2. `ledger.modelId !== route.modelId` ⇒ `cold/model-changed`（别的模型读不到这个前缀）。
3. `lastReadAt = max(ledger.at, lastSent.at（仅当 sessionId 相同）, provenCacheReadAt)`。用三者中**最晚**的，偏向判 warm。
4. 有效 TTL：只要出现任一 1h 证据就取 1h，否则取 5m（`ASSUMED_TTL_MS`）。1h 证据包括：`mode==="on"`、`lastSent.ttl1h`、`ledger.cacheWrite1h>0`、`coverRemainingMs>0`。
5. `coverRemainingMs>0` ⇒ `warm/1h-cover`；`now - lastReadAt < ttl + slackMs` ⇒ `warm`；否则判 `cold/ttl-elapsed`。
   这里故意用名义 TTL + slack，**不**扣 `TTL_SAFETY_MARGIN_MS`：那个余量是给保活「提前续命」用的，判过期要反过来留余量。
6. `nextWriteTtl`：`mode==="on"` 或 `lastSent.ttl1h` ⇒ `1h`；`lastSent.cached===false`（payload 里没有 ephemeral 断点）⇒ `none`；
   其余（auto 默认 / off / adaptive 可能升级）⇒ `5m`。估价取较低的那一档，偏保守。

`lastSent` 在 `before_provider_request` 末尾写入 wireCacheTtl 闭包：`ttl1h = action==="force-1h" || shape.ttl1h`，
`cached = shape.ephemeralBreakpoints>0`。`/reload` 之后闭包清空，就退回到 `ledger.at` 加证据 4（结果仍然偏保守）。
`LedgerUsage.at` 读 `entry.message.timestamp`（pi-ai 消息自带的 number 毫秒），读不到就填 `undefined`。在
`usage-ledger.ts:84-96` 只追加这一个字段，现有消费方行为不变。

### 4.2 economics.ts

```ts
export type CostEstimate =
  | { kind: "priced"; usd: number; prefixTokens: number; newTokens: number; writeTtl: "5m" | "1h" | "none" }
  | { kind: "unpriced"; reason: "no-cost" | "rate-invalid" }
  | { kind: "unknown"; reason: "no-usage" };

export function estimateNextRequestUsd(i: {
  prefixTokens: number | null | undefined; // ctx.getContextUsage()?.tokens；null（刚压缩）⇒ unknown
  newText: string;
  imageCount: number; // newTokens ≈ ceil(utf8Bytes/3) + imageCount×1600
  cost: unknown; // ctx.model.cost（原样传入，在内部 buildPriceModel）
  writeTtl: "5m" | "1h" | "none"; // 来自 warmth.nextWriteTtl
}): CostEstimate;
```

公式：`T = P + N`，`r = rateAt(price, T)`；`writeRate = 5m ? r.cacheWrite : 1h ? 2×r.input : r.input`（与
`PIAI/models.js:671-676` 一致）；`usd = T × writeRate / 1e6`。输出 token 不计入（偏保守）。需要用到的单价不是有限正数
（5m 要 `cacheWrite`，1h/none 要 `input`）⇒ `unpriced`，跳过本次判断。订阅类模型只要 models.json 里配了价就照价估算：
它反映的是配额的消耗，和用户的「$0.5」口径一致。

### 4.3 gate.ts

```ts
export type SkipReason =
  | "disabled"
  | "no-ui"
  | "busy-turn"
  | "cooldown"
  | "background"
  | "goal"
  | "todo"
  | "source"
  | "prefix"
  | "short"
  | "continuation"
  | "asked"
  | "first-turn"
  | "warm"
  | "warmth-unknown"
  | "unpriced"
  | "cheap"
  | "hold-busy";
export type GateVerdict =
  | { pass: true; estimate: Extract<CostEstimate, { kind: "priced" }>; warmth: CacheWarmth }
  | { pass: false; reason: SkipReason };
export function evaluateSyncGates(facts: GateFacts, settings: TopicSwitchSettings): GateVerdict;
```

`GateFacts` 是 wire 层在 handler 同步段采齐的纯数据（布尔/数字/字符串、最近一条 assistant 摘要、warmth、cost
入参）。wire 层负责采集，并且每个读取都包一层 `safe()`，读失败的项按「不通过」处理。

### 4.4 judge.ts

```ts
export interface JudgeInput {
  sessionName?: string;
  compactionSummary?: string;
  recentUserMessages: string[];
  lastAssistantExcerpt?: string;
  request: string;
  imageCount: number;
}
export type JudgeVerdict =
  | { kind: "ok"; related: boolean; confidence: number; ms: number }
  | { kind: "timeout" | "error" | "parse-error" | "no-model"; ms: number };
export interface JudgePort {
  complete(systemPrompt: string, userPrompt: string, signal: AbortSignal): Promise<string>;
}
export function buildJudgePrompt(i: JudgeInput): { systemPrompt: string; userPrompt: string };
export function parseJudgeReply(text: string): { related: boolean; confidence: number } | undefined;
export function judgeRelevance(port: JudgePort, i: JudgeInput, timeoutMs: number, clock: Clock): Promise<JudgeVerdict>;
```

### 4.5 hold 与命令

```ts
export interface HoldItem {
  text: string;
  images: ImageContent[] | undefined;
  source: InputSource;
  at: number;
}
type HoldPhase = "judging" | "confirming" | "releasing-stay" | "switching" | "done";
// 一次只允许一个 hold；hold 期间新来的 input（无论来源）一律 handled 并追加到 bundle，最后与首条去同一目的地
```

命令：`/topic-switch [status]` 显示设置、计数和最近 5 条结果（不含文本和路径）；`/topic-switch __go <nonce>` 是内部跳板，
nonce 一次性、TTL 10 s，参照 `web-hub/agent/index.ts:322-337` 的做法。

## 5. 便宜模型判定

- **选型：直接调 `ctx.modelRegistry.complete`，不起子 agent。** 子会话要建 session、激活扩展、组装系统提示加工具表，冷启动
  通常要好几秒，输入 token 也是十几 k 起步。直调就是一次 ≤2k token 的请求，flash 模型 1–3 s，约 $0.001。仓库里标题生成已经
  验证过这条路（`src/title/index.ts:24-28`），鉴权由 registry 处理。
- **模型解析**：`topicSwitch.model`（strict `provider/id`，经 `parseStrictModelRef`）→ `title.model` → 会话模型（D3）。
  解析不到或调用抛错 ⇒ `no-model`/`error` ⇒ fail-open。
- **硬超时**：`AbortSignal.timeout(judgeTimeoutMs)` 传给 complete，外层再套 `withDeadline(…, judgeTimeoutMs+500, systemClock)`
  兜底那些不响应 abort 的 provider。超时之后迟到的结果直接丢弃（用 hold epoch 校验）。
- **prompt**（`maxTokens: 64`，temperature 用默认值）：
  - system：「判断 NEW REQUEST 是否延续 CURRENT CONVERSATION。只要它引用、依赖或明显受益于先前上下文（同一任务、同一文件或功能、
    后续、修先前的产出），就判 related=true。只有完全自足、不需要那些上下文的新任务才判 false。拿不准就判 true。
    只输出 JSON：{"related":bool,"confidence":0..1}」
  - user：分块给出 `Session title`、`Latest compaction summary`（≤1500 字符）、`Recent user messages`（最近 3 条，每条 ≤400）、
    `Last assistant reply`（≤400）、`NEW REQUEST`（≤2000，并注明 `[n images attached]`）。按 UTF-8 码点截断。
    数据来自 `getBranch()` 反向扫描（compaction 条目的 `summary`、user/assistant 文本块），会话名来自 `pi.getSessionName()`。
- **解析**：取第一个 `{…}` 做 `JSON.parse`；`related` 必须是 boolean，`confidence` 必须是有限数，再 clamp 到 [0,1]。不符合 ⇒ `parse-error`。
- **隐私**：会把用户文本发给第三方便宜模型，与 title 功能同级。设置说明里要写明；关掉 `enabled` 即可停用。

## 6. 截留、回注与切换机制

### 6.1 为什么是「先 handled、再回注」，而不是在 async handler 里阻塞

在 handler 里阻塞，等判定和确认完再 `return continue/handled`，**会丢消息**：阻塞期间 `isStreaming` 仍为 false。如果有
web-hub prompt、cron 或通知唤醒并发调用 `prompt()`，它会先启动一轮；等我们 `return continue` 时，原消息没有
`streamingBehavior`，pi 抛出 "Agent is already processing"（`agent-session.js:1517`），交互循环只会 showError。另外它会把
web ledger 的 3 s 观测窗口和 TUI 主循环一起卡住几十秒。

采用 **B：门 1–3 同步判定 → `handled` 截留 → 异步决策 → 回注**。

- **留在当前会话**（判相关、超时、报错、用户拒绝、跳板失败）：
  `pi.sendUserMessage(content, { deliverAs: "followUp" })`，`content = [{type:"text",text}, ...images]`。
  **总是带 `followUp`**：空闲时 pi 会忽略它，按空闲路径执行（`agent-session.js:1502` 只在 isStreaming 时取它）；如果期间别的东西抢先
  启动了一轮，它就排进队列，不会抛错。
  - **防回环**：回注前登记一次性 bypass（key = 文本 + 图片数，TTL 10 s）。我们自己的 handler 看到它就消费并放行，web 来源判定也不再介入。
  - **送达确认**（因为 sendUserMessage 是 fire-and-forget）：bypass 在 3 s 内没被消费，说明 prompt 在 input 之前就抛了（典型是
    「压缩进行中」，`agent-session.js:1499`）。这时如果压缩标记为真（我们跟踪 `session_before_compact`/`session_compact`），就等到
    `session_compact` 再重试，最多等 120 s；否则 1 s 后重试一次。仍然失败 ⇒ `ctx.ui.setEditorText(text)` 加上 notify
    「原请求已放回输入框」（有图片时提示需重新粘贴）。
- **切换**：见 6.2。
- **hold 期间的新输入**：同样 `handled`，追加到 bundle。释放时按顺序投递，第 2 条起都带 `followUp`。
  极端并发下仍可能乱序，但不会丢（R5）。
- **整体看门狗**：hold 存活上限 `judgeTimeoutMs + confirmTimeoutMs + 15 s`，到点强制走「留在当前会话」。所有 timer 用 `systemClock`（unref）。

### 6.2 会话切换（命令跳板）

newSession 只能在命令 ctx 里调用，所以按 deferred reload 加 web-hub nonce 的现成套路做：

1. 生成 nonce，把 `{bundle, epoch}` 存进 state.ts 的 nonce 表，hold 进入 `switching`。
2. `pi.sendUserMessage("/topic-switch __go <nonce>", { expandPromptTemplates: true })`。空闲时直接进命令分发（`agent-session.js:1489-1495`），
   不进 LLM 上下文。如果 5 s 内 nonce 没被消费 ⇒ 回到 6.1 的「留下」路径。
3. 命令 handler 校验 nonce（一次性），先 `pi.appendEntry("subagent:topic-switch", {outcome:"switched",…})` 记到**旧**会话里，然后：
   `await ctx.newSession({ withSession: async (rctx) => { 依次 rctx.sendUserMessage(item, i===0 ? undefined : {deliverAs:"followUp"}) } })`。
   这里的 `rctx.sendUserMessage` 返回 Promise。首条**不 await 整轮跑完**：`void p.catch(fallback)`，避免把 newSession 的 promise 卡到整轮结束。
4. 失败分支：`{cancelled:true}` 或抛错 ⇒ 仍在旧会话 ⇒ 走「留下」回注。rctx 投递失败 ⇒
   `rctx.ui.setEditorText(text)` 加 notify。
5. **旧会话**原样留在磁盘上，那条请求从未进入旧会话，可以用 `/resume` 回去。不设 `parentSession`，和 `/new` 完全一致，「干净」也就名副其实。
6. **web 跟随**：同进程 newSession 触发新的 `session_start`，web-hub 会重新挂接并发出新的 session 帧（`index.ts:1033-1056`）。
   web 端 `/new` 本身走的就是 `newSession()`（`index.ts:1392`），跟随行为和用户手动 `/new` 一样，无需新增协议。
7. newSession 期间会触发旧 activation 的 `session_shutdown`。phase 为 `switching` 时，shutdown handler **不能**当作丢失处理；
   withSession 是旧 activation 的闭包，payload 已经捕获在闭包里，不依赖之后的状态。
8. 新会话的 input handler（新 activation）看到的是 `source:"extension"`、并且不是 web prompt ⇒ 门 2a 跳过，不会二次判定。

### 6.3 shutdown 与 /reload

`session_shutdown` 时，如果有 hold 且 phase ∉ {switching, done}：TUI 下 `setEditorText(合并文本)` 并 notify，然后丢弃 hold。
这是已接受的残余风险（R3）：图片无法恢复；退出进程时编辑器也不复存在。所有 hold、nonce、bypass 状态都放在 `wireTopicSwitch`
闭包里（每次 activate 重建），不放模块级。

## 7. 确认 UI（TUI + web-hub，先答者生效）

不改 ask-user，新增 `confirm.ts`，复用 `createDialogRace()` 和 `AskUserRemotePort`：

```ts
export type ConfirmOutcome =
  { kind: "switch" | "stay"; by: "tui" | "web" } | { kind: "timeout" | "cancel" | "unavailable" | "error" };
export function confirmSwitch(
  ctx: { mode: string; hasUI: boolean; ui: { select: ExtensionUIContext["select"] } },
  remote: AskUserRemotePort | undefined,
  q: { title: string; switchLabel: string; stayLabel: string },
  timeoutMs: number,
): Promise<ConfirmOutcome>;
```

- 问题文案（中文散文）：「这条请求看起来与当前会话无关（置信度 0.86）。缓存已过期，在本会话继续预计这一次就要 ≈$0.82。」
  选项：`切到新会话处理这条请求` / `留在当前会话（本会话不再提示）`。下方附原请求前 120 字符预览，因为截留后它还没出现在对话里。
- TUI：`ctx.ui.select(title, options, { timeout, signal })`，倒计时由 pi 渲染。
- web：`remote?.open({ toolCallId: "topic-switch:" + nonce, questions: [{ question, header: "新会话?", options, allowOther: false }], allowCancel: true })`，
  再 `setOnRemote(o => race.claim("web") …)`；本地胜出时 `session.close("tui", …)`，由 web 端关闭本地 select（通过 abort `signal`）。
- `mode==="rpc"`：有 remote 时只用 remote，没有就只用 `ctx.ui.select`，避免两个通道重复渲染（ask-user 的 RPC 竞速依赖
  `ASK_USER_MARKER` 做关联，`index.ts:343-430`，v1 不复制这套）。
- `!ctx.hasUI` 或 select 不存在 ⇒ `unavailable` ⇒ 留下，不进冷却。

## 8. 冷却与状态

- 「留下」「Esc」「确认超时」都进入冷却。冷却写成会话条目 `subagent:topic-switch`：`{v:1, kind:"cooldown", at, tokens}`。
  `session_start` / `session_tree` 时用 **`getBranch()`** 读回（不用 `getEntries()`，理由同 `ask-user/index.ts:526-528`），
  所以能跨 `/reload` 和 resume 保留。
- 解除条件（满足其一）：`ctx.getContextUsage().tokens − cooldown.tokens ≥ regrowTokens`（默认 100 000）；或者冷却之后分支上
  出现了 compaction 条目（新的上下文纪元，用户之前的「留下」针对的是旧上下文）。
- 判「相关」或 fail-open 都**不**进冷却：消息处理完缓存就热了，门 3a 自然关闭，不会每条消息都问。
- 诊断结果只在走到截留阶段时才落条目：`{v:1, kind:"outcome", at, outcome, estUsd(两位), prefixK(千 token 取整), judgeMs, confidence?}`，
  outcome ∈ `switched|stayed|declined|confirm-timeout|related|judge-timeout|judge-error|ui-unavailable|switch-failed`。
  不含文本、路径或模型名以外的标识。门 1–3 的跳过原因只在内存里计数（`/topic-switch status` 可查），不写磁盘。v1 不另开 jsonl 遥测文件。

## 9. 设置

`~/.pi/agent/pi-subagent.json` → `topicSwitch`，逐字段容错回落默认（照 `parseTitleSettings`，`settings.ts:1888-1904`），永不抛：

| key                | 默认     | 说明                                                               |
| ------------------ | -------- | ------------------------------------------------------------------ |
| `enabled`          | `true`   | 总开关（关闭 ⇒ 不注册 handler 和命令，零开销）                     |
| `costThresholdUsd` | `0.5`    | 门 3b；≤0 视为非法，回落默认值                                     |
| `model`            | `""`     | 判定模型 strict `provider/id`；空 ⇒ `title.model` ⇒ 会话模型（D3） |
| `judgeTimeoutMs`   | `6000`   | 门 4 硬超时，clamp 到 [1000, 30000]                                |
| `minConfidence`    | `0.7`    | 判无关的置信度下限                                                 |
| `confirmTimeoutMs` | `30000`  | 门 5，clamp 到 [5000, 300000]                                      |
| `minChars`         | `8`      | 门 2b，按码点计                                                    |
| `regrowTokens`     | `100000` | 冷却解除所需的上下文增长量                                         |
| `expirySlackMs`    | `30000`  | 判过期在 TTL 之上额外留的余量                                      |

UI 文本：状态栏 key 为 `topic-switch`，只用英文 token（`topic check…`），遵守 AGENTS.md 的语言分工；对话框正文用中文。

## 10. 与现有功能的交互

| 功能                             | 交互                                                                                                                                                                                                                              | 结论                                                                    |
| -------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------- |
| cache keepalive                  | 保活把前缀保持在热状态 ⇒ `provenCacheReadAt` 让门 3a 判 warm ⇒ 永不触发                                                                                                                                                           | **正确**：缓存热的时候继续留在原会话本来就便宜                          |
| cache adaptive / 1h              | 1h 覆盖期间判 warm；adaptive 下估价按 5m，偏保守                                                                                                                                                                                  | 不重复它的经济学，只读快照                                              |
| compact-hint 强制压缩 / 动态阈值 | 门 1b 要求空闲，压缩只在 turn 边界或 pi 自己的时机发生；压缩进行中，原消息在 input 之前就被 pi 拦下（`agent-session.js:1499`），回注时按 6.1 等压缩结束                                                                           | 切到新会话还顺带省掉一次即将到来的压缩                                  |
| switch_context                   | 待消费的 handoff 是会话级的、带 TTL（`context-switch/store.ts`），切走后自然作废；新会话不带交接，符合要求                                                                                                                        | 无需特判                                                                |
| `/goal`                          | active/paused ⇒ 门 1e 跳过（goal 状态绑定在会话上）；goal 自己注入的消息 source=extension ⇒ 门 2a 跳过                                                                                                                            | —                                                                       |
| deferred reload                  | `/agent reload fire` 是 `/` 命令 ⇒ 门 2b 跳过；reload 处于 pending 意味着 fleet 忙 ⇒ 门 1d 跳过                                                                                                                                   | —                                                                       |
| mention / feishu / session-nav   | 这些 handler 先注册：mention 已 handled 的我们看不到；feishu 已剥掉关键词的文本就是我们截留的文本（回注时不会二次触发）                                                                                                           | **注册顺序**：wireTopicSwitch 放在 `src/index.ts` 最末，wireWebHub 之后 |
| web-hub prompt ledger            | web-hub 的 input 转发先运行，原消息被标为 observed；留下回注时文本相同 ⇒ `idleWatch` 命中 ⇒ consumed。如果判定加确认超过 10 s 的 idle-started 计时（`commands.ts:659`），气泡状态可能先变 unconfirmed，属展示层瑕疵，消息本身不丢 | R4                                                                      |
| web-hub steer recall / hold      | 只作用于流式期间（门 1b 已排除）；空闲时 dispatchHeld 注入的消息是 web 来源，照常判定                                                                                                                                             | —                                                                       |
| ask_user 暂停的问题 / todo       | in_progress 的 todo ⇒ 跳过；暂停的 ask_user 条目随旧会话保留                                                                                                                                                                      | —                                                                       |
| title / memory                   | 新会话由新 activation 正常生成标题、注入同一个 cwd 的项目记忆                                                                                                                                                                     | 「干净」= 不带对话，仍带项目记忆                                        |

## 11. 关键决策

1. **判定放在 cache-ttl 端口后面，不在 topic-switch 里另写一套 TTL 逻辑。** 冷暖证据（保活、1h 覆盖、实际发出的 TTL）只有
   cache-ttl 知道，复制一份必然漂移（cache-ttl 的 §17–§20 事故都出在冷暖判据上）。备选「只看最后一条 assistant 的时间戳」
   在开着保活时会把被 ping 续命的前缀误判成冷 ⇒ 否决。
2. **价格复用 `compact-hint/dynamic/pricing.ts`**（pi-free），1h 写价按 pi-ai 规则 2×input。备选「直接调 pi-ai 的
   calculateCost」会让核心依赖 pi ⇒ 否决；两者的 tier 语义已在 pricing.ts:4-6 写明一致。
3. **handled + 回注**，不在 handler 里阻塞（§6.1，后者有确定的丢消息路径）。
4. **直调便宜模型**，不起子 agent（§5）。
5. **确认 UI 用 ui.select 加 remote 端口竞速**，不经过 ask_user 工具：ask_user 依附于工具调用（toolCallId、队列、后台中断），
   在 input 阶段没有工具上下文。端口本身是通用的，零改动就能复用。
6. **门 1–3 全同步**：不过门的消息零延迟、零网络请求，命中率低的功能必须是这个形状。

## 12. 实施要点（给方案和开发）

- 包划分建议：P1 `cache-ttl/warmth.ts` + `usage-ledger` 的 `at` 字段 + `wireCacheTtl` 返回端口（含单测：保活证据、1h 证据、
  model-changed、slack 边界）；P2 topic-switch 的 pi-free 核心（filters/economics/gate/judge/state，矩阵式单测）；P3 wire、confirm、
  命令、settings、index 装配；P4（可选）`isWebPrompt`。P1 和 P2 可以并行。
- 测试锚点：①任意一门抛错 ⇒ continue；②handled 之后五条释放路径（related/超时/拒绝/确认超时/切换失败）全都恰好投递一次（用 fake pi
  记录 sendUserMessage）；③bypass 防回环；④shutdown 时 hold 回填编辑器；⑤`enabled:false` 时不注册任何 handler；⑥timer 全部 unref
  （print 模式不挂起）。
- `wireCacheTtl` 的返回值改动要同步更新 `src/index.ts:300` 的调用，并保持 `tests/` 里所有 wireCacheTtl 用例不变（只是多了返回值）。
- `GateFacts` 采集只读一次 `getBranch()`，2d/2e/1e/judge 输入共用这一次读取。
- 门 3b 的 `prefixTokens` 用 `ctx.getContextUsage()?.tokens`。刚压缩完它是 null ⇒ unknown ⇒ 跳过，这是正确的，因为压缩后的前缀已经小了。

## 13. 风险

| #   | 风险                                                                   | 缓解                                                                                          |
| --- | ---------------------------------------------------------------------- | --------------------------------------------------------------------------------------------- |
| R1  | 便宜模型误判无关，用户被打扰                                           | 默认偏向判 true 的 prompt + `minConfidence 0.7` + 只在冷且贵时才问 + 拒绝后冷却               |
| R2  | 判定期间（≤6 s）TUI 上看不到刚发的消息                                 | 状态栏显示 `topic check…`；确认框里有原文预览；超时一律回注                                   |
| R3  | hold 期间 /reload 或退出：图片丢失                                     | 文本回填编辑器加 notify；hold 窗口有界（≤51 s）；已接受的残余风险                             |
| R4  | web 气泡可能短暂显示 unconfirmed                                       | 只是展示问题；可选后续：在 `isWebPrompt` 匹配时延长 idle 计时                                 |
| R5  | bundle 多条消息极端并发下乱序                                          | 全部带 followUp，不丢；概率极低（hold 期间 TUI 焦点在对话框里）                               |
| R6  | pi 不保证 `withSession` 在新会话的 session_start 之后执行              | 实施前用 `tests/conformance/` 跑一次真实 pi 验证；失败就退回「回注当前会话」                  |
| R7  | 非 Anthropic 路由永不触发（D1 推荐方案的代价）                         | 显式写进文档；之后有了路由 TTL 证据再放开                                                     |
| R8  | web 弹窗以 `topic-switch:<nonce>` 作 toolCallId，UI 找不到对应工具卡片 | P3 前先读 `ui/src` 的 dialog 渲染逻辑确认能独立展示；不行就加一个最小的 `kind` 字段（只追加） |

## 14. 待用户拍板（≤4）

- **D1 非 Anthropic 路由**：缓存 TTL 无据可依（OpenAI 可能是 5–10 min 到 24 h）。**推荐：v1 判 unknown，跳过**。备选：保守地按 60 min TTL 处理。
- **D2 web 端发来的 prompt 也判吗**：它在 pi 里是 source=extension，需要给 WebHubControl 新增 `isWebPrompt(text)`（基于 ledger 匹配，
  约 20 行）。**推荐：做**，web 是主要入口之一；不做的话，v1 只覆盖 TUI/RPC 输入，但 web 端仍能收到确认弹窗。
- **D3 判定模型兜底**：配置的模型和 title 模型都不可用时，**推荐：退回会话模型**（≈2k token，即使是 Opus 也 <$0.05，远低于 $0.5 的门槛）。备选：直接跳过。
- **D4 确认超时算不算拒绝**：**推荐：算**（留下并进入冷却，避免离开时反复弹窗）。备选：留下但不冷却。

## 15. r2 修订（2026-10-09，覆盖前文冲突处；施工细节见 plan.md r2）

r1 方案评审（review:topic-switch，14 条）+ 主会话裁定 R-A…R-D 改动了以下架构决策；前文与本节冲突时以本节为准。

| 前文                                                  | r2 决策                                                                                                                                                                                                                                                                                                      |
| ----------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| §3.3 门 2a、§4.5、§14 D2（`isWebPrompt` 按文本匹配）  | web prompt 不在 input 事件上识别：web-hub `handlePrompt` 在派发前同步调用 `PromptGatePort.tryClaim({cmdId,text}, ctx, release)`；认领后由 topic-switch 决定 `release.current()`（web-hub 走原派发路径）或 `release.elsewhere()`。身份 = cmd frame。D2 翻转点 = `src/index.ts` 的 `promptGateRef.current = …` |
| §6.1 bypass 防回环 + 3s/10s 送达确认 + 编辑器兜底     | **结构性不拦截**：input handler 只截 `interactive`/`rpc`；一切回注经 `pi.sendUserMessage`（恒为 `extension`）。删除 bypass 令牌与「发出后放编辑器」路径；只在已知压缩中先等压缩结束                                                                                                                          |
| §4.5、§6.1 hold bundle（hold 期新输入追加、同去同留） | 无 bundle：hold 期任何新输入立即以「留下」结束 hold，held 先投、新来者按序随后（有序屏障：观察到 extension input 且 agent 已开始/已排队，≤2s）；PONR 之后新输入直接放行。releasing 窗口内 extension 输入放行（无法与回注区分，顺序例外 R12）                                                                 |
| §6.2 会话切换失败一律回注                             | **PONR** = 调用 `ctx.newSession` 的时刻。之前任何失败 ⇒ 回当前会话；PONR 前把完整 payload（含图片）写入旧会话 `handoff` 记录 + 进程内 transfer；之后只 `withSession` 投递（consume-once 标志与 cancelled 回退仲裁），看门狗只通知；TUI fatal 为 R9（可 `/topic-switch last --send` 取回）                    |
| §6.3 shutdown 回填编辑器                              | 恢复记录 `pending → delivering → resolved`：同进程 reload 由新 activation 至多一次自动投递（先写 delivering 再发），`delivering` 永不重发；跨会话（new/resume/fork）只放编辑器（从未投递）；崩溃/quit 留下的 pending 只通知 + 可取回                                                                         |
| §4.1 冷热判据（mode/lastSent/1h 写痕迹算 1h 证据）    | warm 只来自证据：adaptive `coversPrefix(0)` 或 5m 内同路由的已证实触碰；mode/lastSent/1h 痕迹只把「冷」的证明门槛抬到 1h（Anthropic TTL 上界）并决定 `nextWriteTtl`；keepalive ping 在途/已排程 ⇒ unknown；拿不准 ⇒ unknown ⇒ 不弹                                                                           |
| §4.2 成本公式 `(P+N)×单一写价`                        | 逐项复刻 pi-ai `calculateCost`：prefix 按 cacheWrite（1h 部分 2×input）、新 token 按 input、tier 按 input+cacheRead+cacheWrite 整组替换；不复用 compact-hint pricing.ts                                                                                                                                      |
| §7 确认无取消通道                                     | `confirmSwitch` 接收 `AbortSignal`；所有异步效应绑定 `{activationId, holdId}`，迟到结果 no-op；abort 事件进 hold 状态机                                                                                                                                                                                      |
| §9 时长设置键                                         | 文件存 `*S`（judgeTimeoutS/confirmTimeoutS/expirySlackS），内部 `*Ms`；新增 JSON-only `debugAssumedTtlS` 真机验收缝                                                                                                                                                                                          |
