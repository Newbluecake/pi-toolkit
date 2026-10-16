# topic-switch 实施方案（r2）

> 输入：`requirements.md`（用户拍板）、`arch.md`（架构；**§15 r2 修订覆盖前文冲突处**）、`explore.md`、AGENTS.md。
> r1 被 review:topic-switch 驳回（14 条），主会话裁定 R-A…R-D；逐条处置见文末「修订记录 r2」。
> pi 前缀：`PI=…/@earendil-works/pi-coding-agent/dist`；`PIAI=…/pi-coding-agent/node_modules/@earendil-works/pi-ai/dist`。

## 0. 不变式与决策翻转点

**投递语义（全文以此为准）**

- **I1 结构性不拦截**：我们的 `input` handler 只在「无 hold」时截留 `source ∈ {interactive, rpc}`；我们自己的一切回注都走
  `pi.sendUserMessage` ⇒ `source:"extension"`（`PI/core/agent-session.js:1812-1839`）⇒ 不可能被门判定再截一次。没有 bypass 令牌、没有内容哈希放行。
- **I2 web 在派发点认领**：web prompt 不在 input 事件上推断，而由 web-hub `handlePrompt` 同步调用 `PromptGatePort.tryClaim`，身份 = cmd frame 本身（cmdId）。
- **I3 PONR 之前一律回当前会话**：hold 生命周期内，持有的请求在 PONR（调用 `ctx.newSession` 的那一刻）之前的任何失败/中止 ⇒ 恰好一次回注当前会话。
- **I4 PONR 之后不二次投递**：PONR 之后只有 `withSession` 投递；失败 ⇒ 可见通知 + 完整 payload（含图片）可经 `/topic-switch last` 取回；看门狗只通知。
- **I5 崩溃/重载窗口 = 至多一次自动投递**：持久记录 `pending → delivering`；`delivering` 永不自动重发；无法确认 ⇒ 可见通知 + 可取回，绝不自动放编辑器副本。
- **I6 判不清就不问**：冷热、成本、来源任一不能证明 ⇒ 跳过（直接 `continue`），这是本功能的 fail-open 方向。

| 决策                 | v1 取值                               | 唯一翻转点                                                                                                                                                      |
| -------------------- | ------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| D1 非 Anthropic 路由 | `unknown` ⇒ 跳过                      | `src/cache-ttl/warmth.ts`：`export const WARMTH_SUPPORTED_APIS = Object.freeze(["anthropic-messages"] as const)`                                                |
| D2 web prompt 也判   | 做                                    | `src/index.ts` 一行：`promptGateRef.current = topicSwitch.webGate`（删掉 ⇒ web-hub 永不认领）                                                                   |
| D3 判定模型兜底      | configured → `title.model` → 会话模型 | `src/topic-switch/judge.ts`：`export const JUDGE_SESSION_MODEL_FALLBACK: boolean = true`                                                                        |
| D4 确认超时 = 拒绝   | 留下 + 冷却                           | `src/topic-switch/state.ts`：`export const COOLDOWN_OUTCOMES = Object.freeze(["declined","confirm-timeout","confirm-cancel"] as const)` + `isCooldownOutcome()` |

常量规则（#14）：导出的集合一律 `Object.freeze` 的数组/对象 + 判定函数；**不导出** `Set`/`Map`（`Object.freeze(new Set())` 仍可 `add`）。

## 1. Step 0 — conformance 探针（S0 包；不阻塞 P1/P2/P3a/P4，阻塞 P3b 合并）

新文件：`tests/conformance/topic-switch-runtime-harness.ts`、`tests/conformance/topic-switch-hop.test.ts`。harness 复制 `tests/conformance/tui-harness.ts:290-330`
的 fake model runtime，但 `new AgentSessionRuntime(session, services, factory)` 的 factory 真正 `createAgentSession(...)`，并
`runtime.setRebindSession(() => runtime.session.bindExtensions({ mode:"rpc", uiContext, commandContextActions:{ waitForIdle, newSession:(o)=>runtime.newSession(o), switchSession, fork, navigateTree, reload } }))`
——照抄 `PI/modes/rpc/rpc-mode.js:225-262`。探针扩展经 `extensionFactories` 注入（不加载本包），每次 activation 带自增 `gen`。

静态阅读（探针钉死，pi 升级报警）：`newSession` = `emitBeforeSwitch → teardownCurrent(abort + session_shutdown) → apply(createRuntime) → finishSessionReplacement:
await rebindSession()(⇒ bindExtensions ⇒ emit session_start, agent-session.js:2582) → await withSession(rctx)`（`agent-session-runtime.js:101-172`）；
`emitInput` 为每个 handler **新建** event 对象、逐个 `await`（`runner.js:1202-1238`）⇒ 事件对象不可做身份；`pi.sendUserMessage` 异常只进 `emitError`（`agent-session.js:2676-2683`）。

| #   | 探针                                                                                                                                           | 断言                                                                                                                                                                                                                                                                     |
| --- | ---------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| S1  | 命令内 `ctx.newSession({withSession})`                                                                                                         | 序 = `[gen1 session_shutdown(new), gen2 session_start(new), withSession]`；回调中 `rctx.sessionManager.getSessionId()` = 新 id                                                                                                                                           |
| S2  | `rctx.sendUserMessage([text, image])`                                                                                                          | gen2 input：`source:"extension"`、1 图；fake 模型请求含文本+图；旧会话分支无此消息；promise 在整轮结束后才 resolve                                                                                                                                                       |
| S3  | 跳板 `pi.sendUserMessage("/probe __go n",{expandPromptTemplates:true})`（idle，从 timer 发）                                                   | 命令 handler 运行且 ctx 有 `newSession`；没有任何 input handler 被调用；LLM 上下文无该文本                                                                                                                                                                               |
| S4  | handler `handled` 后从 timer `pi.sendUserMessage(c,{deliverAs:"followUp"})`                                                                    | 第一次无 entry 无请求；回注 input `source:"extension"`、`streamingBehavior===undefined`、立即开轮；每次 sendUserMessage **恰好一次** input 事件到达后序 handler（2026-10-15 pi 1.2 修订：等待条件按启动窗口改写并新增 S4b 契约，见 `docs/dev/pi-1.2-compat/plan.md` §4） |
| S5  | 压缩中 `pi.sendUserMessage`                                                                                                                    | input handler 未被调用（`agent-session.js:1499` 前抛）⇒ 回注前必须等压缩结束                                                                                                                                                                                             |
| S6  | `session_shutdown(reason:"reload")` 中 `pi.appendEntry`；`session.reload()` 后新 activation 在 `session_start` 用 `getBranch()` 读回           | 读到；含 base64 图片的 data 原样往返；另记录 shutdown 中 `setEditorText` 在 reload 后是否仍可见（否 ⇒ §P3b.5 的未发新来者改为只 notify 文本预览）                                                                                                                        |
| S7  | `session_before_switch` 返回 `{cancel:true}`                                                                                                   | `newSession` → `{cancelled:true}`，旧 activation 仍活，`withSession` 未调用                                                                                                                                                                                              |
| S8  | 先 `sendUserMessage(A 带图)`，等屏障（`agent_start` 或 `isStreaming && hasPendingMessages()`）后再 `sendUserMessage(B,{deliverAs:"followUp"})` | 模型看到的顺序 A→B，各一次；不加屏障时记录实际顺序（文档化风险）                                                                                                                                                                                                         |
| S9  | 一次 prompt 的 user 消息 entry 是否在 `before_provider_request` 之前已落入 `getBranch()`                                                       | 是 ⇒ §P3b.7 的「首条 user 消息 digest」观测成立                                                                                                                                                                                                                          |

失败兜底（写进 `src/topic-switch/wire.ts` 头注释）：S1/S2 失败 ⇒ 改用 `newSession({setup})` 写 carry 记录 + 进程全局 transfer（§P3b.7 同一结构），由新 activation
在 `session_start(reason:"new")` 投递；再失败 ⇒ `SWITCH_SUPPORTED=false`（wire.ts 常量），确认框退化为「知道了，留在当前会话」。S3 失败 ⇒ 加 `deliverAs:"followUp"`
（`src/web-hub/agent/builtin-bridge.ts:303-313` 生产形状）。S4 失败 ⇒ `isIdle()? undefined : followUp`。S6 失败 ⇒ reload 期间只走进程内 transfer（不落盘），崩溃窗口只剩通知。
S8 无屏障乱序 ⇒ 屏障为必选（本方案已默认使用）。S9 失败 ⇒ 观测改为「`delivering` 之后第一个 user `message_start` 事件的 digest」（同进程），磁盘恢复只通知。

## 2. 包划分（文件域互斥）

```
S0 ─┐
P1 ─┤
P2 ─┼──► P3b ──► verifier ──► 真机验收        （S0/P1/P2/P3a/P4 同消息并行）
P3a ┤
P4 ─┘
```

| 包  | 新建                                                                                                                                                                                                             | 修改                                                                                                 |
| --- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------- |
| S0  | `tests/conformance/topic-switch-{runtime-harness,hop.test}.ts`                                                                                                                                                   | —                                                                                                    |
| P1  | `src/topic-switch/{types,settings,filters,economics,gate,judge,state,records}.ts`；`tests/topic-switch/{settings,filters,economics,gate,judge,state,records,hold.property}.test.ts`                              | —                                                                                                    |
| P2  | `src/cache-ttl/warmth.ts`；`tests/cache-ttl/{warmth,warmth-port,ledger-long-write}.test.ts`                                                                                                                      | `src/cache-ttl/cache-ttl.ts`、`src/cache-ttl/usage-ledger.ts`                                        |
| P3a | `src/topic-switch/confirm.ts`；`tests/topic-switch/confirm.test.ts`                                                                                                                                              | —                                                                                                    |
| P4  | `src/web-hub/agent/prompt-gate.ts`；`tests/web-hub/agent/prompt-gate.test.ts`                                                                                                                                    | `src/web-hub/agent/commands.ts`、`src/web-hub/agent/index.ts`                                        |
| P3b | `src/topic-switch/{wire,hold,release,recovery,command}.ts`；`tests/topic-switch/{wire,release,recovery,pi-free}.test.ts`、`tests/integration/topic-switch.test.ts`、`tests/config/topic-switch-settings.test.ts` | `src/config/settings.ts`、`src/config/setting-specs.ts`、`src/index.ts`、`AGENTS.md`、`CHANGELOG.md` |

冻结：`src/stack.ts`（只经 `holder.current` 读）、`src/ask-user/**`（P3a 只 import `remote.ts` 类型与 `createDialogRace`）、`src/compact-hint/**`（不再复用 pricing.ts，见 #6）。
热文件 `settings.ts`/`setting-specs.ts`/`index.ts`/AGENTS.md/CHANGELOG 只归 P3b。P1 不 import `src/cache-ttl/*`（用结构类型 `WarmthView`）。
pi-free：`src/topic-switch/{types,settings,filters,economics,gate,judge,state,records}.ts`、`src/cache-ttl/warmth.ts` 禁止 import `@earendil-works/*`（`pi-free.test.ts` 扫 import 行；`node:crypto` 允许）。

## P1 — pi-free 决策核心

### types.ts

```ts
export type InputSourceLike = "interactive" | "rpc" | "extension";
export interface ImageLike {
  type: "image";
  data: string;
  mimeType: string;
}
export interface HeldPayload {
  text: string;
  images?: ImageLike[];
  imagesOmitted?: number;
  digest: string;
}
export interface WarmthView {
  state: "warm" | "cold" | "unknown";
  reason: string;
  nextWriteTtl?: "5m" | "1h" | "none";
}
export type Outcome =
  | "switched"
  | "stayed"
  | "declined"
  | "confirm-timeout"
  | "confirm-cancel"
  | "related"
  | "judge-timeout"
  | "judge-error"
  | "judge-parse"
  | "no-model"
  | "ui-unavailable"
  | "hop-timeout"
  | "switch-cancelled"
  | "switch-failed"
  | "newcomer"
  | "watchdog"
  | "shutdown"
  | "preflight";
export type SkipReason =
  | "disabled"
  | "no-ui"
  | "busy-turn"
  | "compacting"
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
  | "no-usage"
  | "cheap"
  | "fact-error"
  | "draining";
export interface GateFacts {
  // 便宜字段给值；贵字段给 thunk（按门序惰性求值，抛错 ⇒ fact-error）
  hasUI: boolean;
  mode: string;
  streamingBehavior: "steer" | "followUp" | undefined;
  idle: boolean;
  pendingMessages: boolean;
  compacting: boolean;
  draining: boolean;
  cooldownActive: boolean;
  activeRuns: number;
  backgroundBash: number;
  goalBusy: boolean;
  origin: "input" | "web";
  source: InputSourceLike;
  text: string;
  imageCount: number;
  branch: () => BranchView;
  warmth: () => WarmthView;
  prefixTokens: () => number | null | undefined;
  modelCost: () => unknown;
}
export interface BranchView {
  hasAssistant: boolean;
  lastAssistantText: string | undefined;
  lastTurnAskedUser: boolean;
  todoInProgress: boolean;
  recentUserTexts: string[];
  lastCompactionSummary: string | undefined;
}
```

### settings.ts（`config/settings.ts` 只 import）

`TopicSwitchSettings`、`DEFAULT_TOPIC_SWITCH_SETTINGS`（frozen）、`parseTopicSwitchSettings(input): TopicSwitchSettings`（never throws；输入是 `normalizeTimeUnits` 后的 ms 形态）。

| 文件键             | 内部                | 默认     | 合法域（越界/错类型 ⇒ 回落默认；SETTING_SPECS min/max 必须镜像） |
| ------------------ | ------------------- | -------- | ---------------------------------------------------------------- |
| `enabled`          | 同                  | `true`   | boolean                                                          |
| `costThresholdUsd` | 同                  | `0.5`    | finite，`0 < x ≤ 100`                                            |
| `model`            | 同                  | `""`     | string（trim）；运行时 `parseStrictModelRef` 失败 ⇒ 视为空       |
| `judgeTimeoutS`    | `judgeTimeoutMs`    | 6 s      | 1–30 s                                                           |
| `minConfidence`    | 同                  | `0.7`    | `0 ≤ x ≤ 1`                                                      |
| `confirmTimeoutS`  | `confirmTimeoutMs`  | 30 s     | 5–300 s                                                          |
| `minChars`         | 同                  | `8`      | 整数 0–200                                                       |
| `regrowTokens`     | 同                  | `100000` | 整数 ≥ 0（0 = 冷却只随 compaction 解除）                         |
| `expirySlackS`     | `expirySlackMs`     | 30 s     | 0–600 s                                                          |
| `debugAssumedTtlS` | `debugAssumedTtlMs` | 0        | 0 或 10–3600 s；JSON-only 测试缝（不进 SETTING_SPECS）           |

### filters.ts

`sourceAllowed(origin, source)`：`origin==="web"` ⇒ true；`origin==="input"` ⇒ `source ∈ {interactive, rpc}`（I1）。
`classifyText(text, imageCount, minChars) → "ok"|"prefix"|"short"|"continuation"`；`assistantAsked(text, askedUser)`。

- trim 后 `/`、`//`、`!` 开头 ⇒ prefix；码点数 < minChars ⇒ short（纯图片也 short）。
- 短回复整句表（去尾标点、小写）：继续/好的/好/嗯/行/可以/ok/okay/yes/no/push/commit/merge/lgtm/方案[一二三四五1-9]/选[一二三abc1-9]/纯数字。
- 指代：CJK（这个/那个/刚才/上面/上述/前面/接着/还是/再/它/同样/上一个）在前 12 码点内子串；EN（this/that/it/above/again/same/also/continue/previous）在前 3 词内整词、不分大小写。
- 上文在提问：最近 assistant 文本 trimEnd 以 `?`/`？` 结尾，或上一轮有 `ask_user` 工具调用。
- 表以 `Object.freeze([...])` 导出。

### economics.ts（#6：与 pi-ai `calculateCost` 逐项一致，`PIAI/models.js:660-680`）

```ts
export const BYTES_PER_TOKEN = 3,
  IMAGE_TOKENS = 1600;
export type CostEstimate =
  | { kind: "priced"; usd: number; prefixTokens: number; newTokens: number; writeTtl: "5m" | "1h" | "none" }
  | { kind: "unpriced"; reason: "no-cost" | "rate-invalid" }
  | { kind: "unknown"; reason: "no-usage" };
export function estimateNextRequestUsd(i: {
  prefixTokens: number | null | undefined;
  newText: string;
  imageCount: number;
  cost: unknown;
  writeTtl: "5m" | "1h" | "none";
}): CostEstimate;
```

- `N = ceil(utf8Bytes/3) + imageCount×1600`；`P` 非有限或 ≤0 ⇒ unknown。
- 合成 usage：`none` ⇒ `{input:P+N, cacheWrite:0, cacheWrite1h:0}`；`5m` ⇒ `{input:N, cacheWrite:P, cacheWrite1h:0}`；`1h` ⇒ `{input:N, cacheWrite:P, cacheWrite1h:P}`；cacheRead=output=0。
- 档位：`inputTokens = input+cacheRead+cacheWrite`；取 `inputTokensAbove < inputTokens` 中阈值最大的 tier，**整组替换** base（同 pi-ai）。
- `usd = (rates.input×input + rates.cacheWrite×(cacheWrite−cacheWrite1h) + rates.input×2×cacheWrite1h)/1e6`。
- 本次用到的单价（input；5m 时另需 cacheWrite）非有限或 <0 ⇒ `unpriced/rate-invalid`；`cost` 非对象 ⇒ `unpriced/no-cost`。不复用 `compact-hint/dynamic/pricing.ts`（其 tier 缺字段回落 base，与 pi-ai 不同）。
- 输出 token 不计 ⇒ 估值是下界（少问方向）。

### gate.ts

`evaluateSyncGates(facts, s): { pass: true; estimate; warmth } | { pass: false; reason: SkipReason }`，整体 try/catch ⇒ `fact-error`。门序：
1a `!enabled`/`!(hasUI && mode∈{tui,rpc})` · 1b `streamingBehavior!==undefined || !idle || pendingMessages`⇒busy-turn · `compacting` · `draining` · cooldown ·
`activeRuns>0 || backgroundBash>0`⇒background · goalBusy · 2a `!sourceAllowed` · 2b prefix/short · 2c continuation ·（此时才求 `branch()`）todo · first-turn · asked ·
3a warmth：warm⇒warm、unknown⇒warmth-unknown · 3b estimate：unknown⇒no-usage、unpriced⇒unpriced、`usd ≤ threshold`⇒cheap。

### judge.ts（arch §5 不变，补）

`JUDGE_SESSION_MODEL_FALLBACK`（D3）；`judgeModelChain({configured,title,session}) → readonly {provider,id,origin}[]`（strict 解析、去重、保序）；
`JUDGE_MAX_TOKENS=512`（2026-10-16 由 64 调大：推理型判断模型 64 时 20–33% 空回复/截断）；`JUDGE_LIMITS`（frozen）；`buildJudgePrompt`、`parseJudgeReply`（首个平衡 `{…}`、related boolean、confidence finite→clamp）；
`judgeRelevance(port, input, timeoutMs, clock, signal: AbortSignal)`：内部 `AbortController` 同时受外部 `signal` 与超时驱动，外层 `withDeadline(timeoutMs+500)`；
结果 `ok|timeout|error|parse-error|aborted`。只有 `ok && related===false && confidence ≥ minConfidence` 视为「无关」。

### state.ts（冷却 + hold 归约器，纯函数）

```ts
export function cooldownActive(
  branch: readonly EntryLike[],
  tokensNow: number | null | undefined,
  regrowTokens: number,
): boolean;
// 最近 cooldown 之后有 compaction ⇒ false；tokensNow 有限且差 ≥ regrowTokens(>0) ⇒ false；否则 true
export type HoldPhase = "judging" | "confirming" | "hopping" | "switching" | "releasing" | "done";
export type HoldEvent =
  | { t: "judged"; v: JudgeVerdictLike }
  | { t: "confirmed"; o: ConfirmOutcomeLike }
  | { t: "newcomer" }
  | { t: "hop-timeout" }
  | { t: "ponr" }
  | { t: "preflight-failed" }
  | { t: "switch-entered" }
  | { t: "switch-cancelled" }
  | { t: "abort"; why: "watchdog" | "shutdown"; reason?: ShutdownReason }
  | { t: "released" };
export type HoldEffect =
  | { e: "judge" }
  | { e: "confirm" }
  | { e: "hop" }
  | { e: "cancel-async" } // abort judge/confirm、作废 nonce
  | { e: "release" }
  | { e: "persist-pending"; reason: ShutdownReason }
  | { e: "cooldown" }
  | { e: "record"; outcome: Outcome };
export function stepHold(
  s: HoldState,
  ev: HoldEvent,
  minConfidence: number,
): { s: HoldState; fx: readonly HoldEffect[] };
```

转移（未列出的组合 ⇒ 状态不变、`fx=[]`，即迟到事件无副作用 #9/#11）：

- judging：`judged` 无关 ⇒ confirming+`confirm`；其他 verdict ⇒ releasing+`release`+`record`。
- confirming：`confirmed switch` ⇒ hopping+`hop`；stay/cancel/timeout ⇒ releasing+`release`+`record`+（`isCooldownOutcome` 时）`cooldown`；unavailable/error ⇒ releasing+`release`+`record`。
- judging|confirming|hopping：`newcomer` ⇒ releasing+`cancel-async`+`release`+`record(newcomer)`；`abort watchdog` ⇒ 同上 `record(watchdog)`；
  `abort shutdown` ⇒ done+`cancel-async`+`persist-pending(reason)`。hopping：`hop-timeout`/`preflight-failed` ⇒ releasing+`release`；`ponr` ⇒ switching。
- switching（PONR 后）：`switch-entered` ⇒ done+`record(switched)`；`switch-cancelled` ⇒ releasing+`release`+`record(switch-cancelled)`；`newcomer` 不进入归约器（I4，输入放行）；`abort *` ⇒ 不变（只通知）。
- releasing：`released` ⇒ done；`newcomer` 不变（由 release 队列追加，不产生新 release）；`abort shutdown` ⇒ done+`persist-pending`（只针对尚未发出的队列项，见 P3b.5）。
- **性质**：held 在整个生命周期里恰好进入一次 {`release`, `switch-entered`, `persist-pending`}；done 后 fx 恒空。

### records.ts（持久记录 + 恢复决策，纯函数）

```ts
export const ENTRY_TYPE = "subagent:topic-switch";
export type TopicRecord =
  | { v: 1; kind: "cooldown"; at: number; tokens: number }
  | {
      v: 1;
      kind: "outcome";
      at: number;
      holdId: string;
      outcome: Outcome;
      estUsd: number;
      prefixK: number;
      judgeMs?: number;
      confidence?: number;
    }
  | { v: 1; kind: "pending" | "handoff"; at: number; holdId: string; payload: HeldPayload; reason?: ShutdownReason }
  | { v: 1; kind: "delivering"; at: number; holdId: string }
  | { v: 1; kind: "resolved"; at: number; holdId: string; how: "observed" | "noticed" | "manual" };
export const PAYLOAD_IMAGE_BYTES_CAP = 8 * 1024 * 1024; // 超出 ⇒ images 省略、imagesOmitted=n（通知里如实说明）
export function makePayload(text: string, images: readonly ImageLike[] | undefined): HeldPayload; // digest = sha256(text ‖ 每图 mimeType+data)
export function parseRecord(data: unknown): TopicRecord | undefined; // 严格；未知 v/kind ⇒ undefined
export type RecoveryAction =
  | { a: "none" }
  | { a: "deliver"; holdId: string; payload: HeldPayload }
  | { a: "editor"; holdId: string; text: string }
  | { a: "resolve"; holdId: string }
  | { a: "notice"; holdId: string; preview: string };
export function planRecovery(i: {
  branch: readonly EntryLike[];
  transfer: TransferLike | undefined;
  sessionId: string;
  reason: StartReason;
  now: number;
}): RecoveryAction[];
```

`planRecovery` 规则（I5）：

1. transfer 存在、`state==="pending"`、`reason==="reload"`、同 sessionId、≤60s ⇒ `deliver`（调用方先写 `delivering` 再发）。
2. transfer 存在、`state==="pending"`、`reason ∈ {new,resume,fork}`（来自别的会话，从未投递过）⇒ `editor`（只文本；有图则通知里说明可 `/topic-switch last --send`）。
3. 分支内每个未 `resolved` 的 `delivering`：其后**第一条** user 消息 entry 的 digest 相等 ⇒ `resolve(observed)`；否则 ⇒ `notice`（不重发、不放编辑器）。
4. 分支内未 `resolved`、无 `delivering` 的 `pending`（崩溃留下、无 transfer）⇒ `notice`（不自动投递）。`handoff` 记录不触发任何动作（成功切换的正常残留）。
5. 每个 notice 之后调用方写 `resolved(noticed)`，保证只通知一次。

### P1 测试

filters（边界码点、整词、表项与标点）；economics（三档 × tier 上下界 × **与真实 `calculateCost` 交叉核对**：测试里 `import { calculateCost } from "@earendil-works/pi-ai"`，
构造同一合成 usage 比较 `cost.total`，误差 ≤1e-12；缺字段/NaN/负数 ⇒ unpriced；P null ⇒ unknown）；gate（每门单独失败、门序、thunk 惰性计数、抛错）；
judge（截断、解析、超时、外部 abort ⇒ aborted 且迟到结果丢弃、链去重与 D3 开关）；state（冷却两解除条件；**完整转移矩阵表驱动** + 迟到事件全组合 fx=[]）；
`hold.property.test.ts`（固定种子 200 例随机事件序列，断言上面的性质与 `isCooldownOutcome` 一致）；records（解析严格性、digest 稳定、图片上限、`planRecovery` 五条规则逐条 + 组合）。

## P2 — cache-ttl CacheWarmthPort（#7、#12）

**usage-ledger.ts**（只追加）：`LedgerEntryLike.message.timestamp?: unknown`；`LedgerUsage.at?: number` 以条件展开 `...(finite(ts) ? {at: ts} : {})` 写入
（保证 `tests/cache-ttl/usage-ledger.test.ts:25` 等无 timestamp 夹具的 `toEqual` 不变）；新函数
`export function anyLongWriteSince(ctx, sinceMs: number, maxEntries = 400): boolean | "unknown"`——反扫 assistant usage，遇 `cacheWrite1h>0` ⇒ true；
扫到 `timestamp < sinceMs` ⇒ false；扫满上限或读失败 ⇒ "unknown"。

**warmth.ts**（pi-free）：

```ts
export const WARMTH_SUPPORTED_APIS = Object.freeze(["anthropic-messages"] as const); // D1
export const NOMINAL_5M_MS = 300_000,
  MAX_TTL_MS = 3_600_000; // Anthropic 最长 TTL = 1h
export interface WarmthEvidence {
  now: number;
  route: { api: string; provider: string; modelId: string };
  ledger:
    | { at?: number; provider?: string; modelId: string; cacheRead: number; cacheWrite: number; cacheWrite1h?: number }
    | undefined;
  lastSent?: { at: number; provider: string; modelId: string; ttl1h: boolean; cached: boolean }; // 端口已按 sessionId 过滤
  keepalive?: {
    provenReadAt?: number;
    lastReadStartedAt?: number;
    pingStartedAt?: number;
    pingInFlight: boolean;
    pingScheduled: boolean;
  };
  adaptive?: { covers: boolean; any1hWrites: boolean };
  recent1hWrite: boolean | "unknown";
  mode: "auto" | "on" | "off" | "adaptive";
  slackMs: number;
  ttlOverrideMs?: number;
}
export type CacheWarmth =
  | { state: "warm"; reason: "1h-cover" | "proven-recent" }
  | { state: "cold"; reason: "ttl-elapsed" | "uncached"; nextWriteTtl: "5m" | "1h" | "none" }
  | {
      state: "unknown";
      reason:
        "unsupported-api" | "no-ledger" | "route-changed" | "keepalive-active" | "not-provably-cold" | "read-error";
    };
export function assessWarmth(e: WarmthEvidence): CacheWarmth;
```

判定（顺序）：

1. api 不在 D1 表 ⇒ unknown/unsupported-api；无 ledger 或无 `ledger.at` ⇒ no-ledger；ledger 的 modelId（及 provider，若有）≠ route ⇒ route-changed。
2. **warm 只来自证据**：`adaptive.covers`（= `coversPrefix(0)`：已结算 1h 写 + cover 窗口开着，漂移即清，`adaptive.ts:621-630`）⇒ warm/1h-cover；
   `provenTouch = max(ledger.at 当 cacheRead+cacheWrite>0, keepalive.provenReadAt)` 且 `now − provenTouch < (ttlOverride ?? NOMINAL_5M_MS)` ⇒ warm/proven-recent。
3. `pingInFlight || pingScheduled` ⇒ unknown/keepalive-active。
4. ledger `cacheRead+cacheWrite===0` 且 `lastSent` 同 route 且 `cached===false` ⇒ cold/uncached（`nextWriteTtl:"none"`，本就每次全价）。
5. `latestPossibleTouch = max(ledger.at, lastSent?.at, keepalive.lastReadStartedAt, keepalive.pingStartedAt, keepalive.provenReadAt)`；
   `oneHourPossible = mode==="on" || lastSent?.ttl1h || (ledger.cacheWrite1h ?? 0)>0 || adaptive.any1hWrites || recent1hWrite !== false`；
   `maxLife = ttlOverride ?? (oneHourPossible ? MAX_TTL_MS : NOMINAL_5M_MS)`；`now − latestPossibleTouch ≥ maxLife + slackMs` ⇒ cold/ttl-elapsed；否则 unknown/not-provably-cold。
   说明：mode/lastSent/1h 痕迹**永不**让结果变 warm，只会把「冷」的证明门槛抬到 1h——超过 1h+slack 无任何触碰时，无论写的是哪档 TTL 都已过期（Anthropic 最长 1h），
   这是证明而非推测；1h 内拿不准 ⇒ unknown ⇒ 不弹（I6）。
6. `nextWriteTtl`（仅 cold）：`mode==="on" || lastSent?.ttl1h` ⇒ 1h；`lastSent?.cached===false` ⇒ none；其余 5m。

**cache-ttl.ts API 变更（#12）**：

```ts
export interface CacheWarmthPort {
  assess(ctx: ExtensionContext, now: number, opts: { slackMs: number; ttlOverrideMs?: number }): CacheWarmth;
} // 永不抛
export interface CacheTtlWiring {
  readonly warmth: CacheWarmthPort;
}
export function wireCacheTtl(pi: ExtensionAPI, settings: AgentSettings, deps: CacheTtlDeps = {}): CacheTtlWiring; // 原为 void（:321）
```

- 闭包新增 `let lastSent: {at, sessionId, provider, modelId, ttl1h, cached} | undefined`，在 `before_provider_request` 通过 payload 形状检查后、每个 return 前写入
  （`ttl1h = action==="force-1h" || shape.ttl1h`，`cached = shape.ephemeralBreakpoints>0`）；`shape` 只算一次、adaptive 复用；payload 零改动。
- 生命周期：`session_start` ⇒ `lastSent = undefined`（新会话/resume 不继承）；`assess` 只认 `lastSent.sessionId === readSessionId(ctx)`；keepalive/adaptive 端口
  每次 `assess` 现取 `deps.keepalive?.()` / `getAdaptive()`（stack 重建后自动换实例）；`/reload` 后闭包重建 ⇒ lastSent 为空 ⇒ 规则 5 只少一个证据（不会因此判 warm）。
- keepalive 证据取自 `report().window.{lastReadStartedAt,pingInFlight,pingStartedAt,nextPingAt}` 与 `provenCacheReadAt()`；`pingScheduled = report().armed && nextPingAt !== undefined`。
  adaptive 证据：`covers = coversPrefix(0)`、`any1hWrites = snapshot().confirmed1hWrites + unconfirmed1hWrites > 0`。
- 唯一生产调用点 `src/index.ts:300`（P3b 接收返回值）；`tests/` 14 处 `wireCacheTtl(` 调用不需改；仓库内无 `vi.mock` cache-ttl.ts。
- 测试：`warmth.test.ts` 逐条规则 + 边界（`maxLife+slack` 前后 1ms、override、1h 痕迹各来源单独生效、mode 不产生 warm 的反例）；
  `warmth-port.test.ts`（沿用 `tests/cache-ttl/cache-ttl.test.ts` 的 fake pi）：四种 mode 下 `before_provider_request` 后 `assess` 读到 lastSent；payload 深等不变；
  `session_start` 清 lastSent；跨 session 的 lastSent 被忽略；keepalive/adaptive 换实例后读新实例；ctx 抛错 ⇒ unknown/read-error；
  `ledger-long-write.test.ts`：`anyLongWriteSince` 三种返回。

## P3a — 确认 UI（`src/topic-switch/confirm.ts`，#8）

```ts
export type ConfirmOutcome =
  { kind: "switch" | "stay"; by: "tui" | "web" } | { kind: "timeout" | "cancel" | "unavailable" | "error" | "aborted" };
export interface ConfirmText {
  title: string;
  switchLabel: string;
  stayLabel: string;
  preview: string;
  header: string;
}
export function buildConfirmText(i: {
  confidence: number;
  estUsd: number;
  request: string;
  imageCount: number;
}): ConfirmText; // 中文；预览 120 码点
export function confirmSwitch(
  ctx: ConfirmCtx,
  remote: AskUserRemotePort | undefined,
  text: ConfirmText,
  o: { timeoutMs: number; clock: Clock; id: string; signal: AbortSignal },
): Promise<ConfirmOutcome>;
```

- 通道：`tui` ⇒ select ⟂ remote；`rpc` ⇒ 有 remote 只用 remote，否则只 select；`!hasUI` 或两者皆无 ⇒ `unavailable`。
- 仲裁 `createDialogRace()`。本地 select 收自有 `AbortController`（由 web 胜出、超时、外部 `signal` 触发）；外部 `signal` abort ⇒ claim("abort")、关闭 select、
  `remote.close("abort","aborted")`、resolve `aborted`。超时自管（`clock.setTimer`），select 仍传 `timeout` 显示倒计时；select 返回 undefined 时以耗时 ≥ timeoutMs−250 判 timeout，否则 cancel。
- web：`remote.open({ toolCallId:"topic-switch:"+id, questions:[{ question:title+"\n\n"+preview, header, options:[{label:switchLabel},{label:stayLabel}], allowOther:false }], allowCancel:true })`；
  答案任一值 === switchLabel ⇒ switch，=== stayLabel ⇒ stay，其他/cancel ⇒ cancel；`open` 抛错/undefined ⇒ 纯本地。web 端 `AgentDetail.vue:13-16` 对每个 open dialog 独立渲染表单，无需协议改动。
- 保证：resolve 前 remote session 已 close 恰一次、本地 select 已收到 abort、所有 timer 已清；resolve 之后到达的任何回调都是 no-op。
- 测试：tui switch/stay/Esc/超时；web 先答；同 tick 双答；rpc ±remote；`!hasUI`；open/select 抛错；外部 abort 于 select 打开时与 remote 打开时；abort 后迟到答；timer 计数归零。

## P4 — web-hub 认领端口（D2、#5）

`src/web-hub/agent/prompt-gate.ts`（新，pi-free 类型）：

```ts
export interface WebPromptRelease {
  current(): "dispatched" | "refused";
  elsewhere(): void;
} // 合计只生效一次，其余调用 no-op
export interface PromptGatePort {
  tryClaim(req: { cmdId: string; text: string }, ctx: unknown, release: WebPromptRelease): boolean;
}
```

`commands.ts`：`handlePrompt` 在 compaction 检查之后、hold-driver 分支之前，仅当 `!ctx.isStreaming`（`deps.isIdle?.()`）时调用 `deps.promptGate?.()?.tryClaim(...)`（try/catch，抛错 ⇒ 未认领）。
认领 ⇒ ledger `promptState:"observed"`（behavior `idle`）并 `settleAndReply(okResult({op:"prompt",delivery:"observed",behavior:"idle"}))`，HTTP 回复到此为止。
`release.current()`：内部 once 标志；前置（ctx 在、同 sessionId、非 manualCompacting）不满足 ⇒ `"refused"`（不做任何副作用）；否则走 `dispatchHeld` 同款无回复路径
（ledger dispatched + 文本、origin entry、`sendUserMessage(text,{deliverAs:"followUp"})`、30s CAS 计时、idleWatch），同步抛错 ⇒ `"refused"`。
`release.elsewhere()`：ledger 置 consumed（气泡定格）。`onSessionBoundary`/`dispose` 不触发 release（topic-switch 自己负责 shutdown 路径）。
`index.ts`：`WebHubDeps.promptGate?: () => PromptGatePort | undefined` 透传给 commands handler；无其他改动。
测试（`prompt-gate.test.ts`）：未认领 ⇒ 现有路径字节不变（与 `commands.test.ts` 同断言）；认领 ⇒ 一次 reply、无 sendUserMessage；current ⇒ 恰一次 sendUserMessage + 观测链照常；
current 两次/先 elsewhere 后 current ⇒ 只首次生效；refused 无副作用；tryClaim 抛错 ⇒ 原路径；流式中不调用 tryClaim；现有 `commands*.test.ts` 全绿。

## P3b — pi-facing 装配

### 1. 依赖与装配

```ts
export interface TopicSwitchDeps {
  settings: () => TopicSwitchSettings;
  titleModel: string;
  warmth: CacheWarmthPort;
  stack: () => { activeRuns(): number; backgroundBash(): number; goalBusy(): boolean } | undefined;
  remote: () => AskUserRemotePort | undefined;
  clock?: Clock;
}
export interface TopicSwitchWiring {
  readonly webGate: PromptGatePort;
}
export function wireTopicSwitch(pi: ExtensionAPI, deps: TopicSwitchDeps): TopicSwitchWiring;
```

`src/index.ts`：`const cacheTtl = wireCacheTtl(...)`；web-hub 块前声明 `const promptGateRef: { current?: PromptGatePort } = {}`，`wireWebHub` deps 加
`promptGate: () => promptGateRef.current`；`activate()` 最末（晚于 mention/feishu/session-nav/web-hub 的 input 注册）：
`if (settings.topicSwitch.enabled) { const ts = wireTopicSwitch(pi, {...}); promptGateRef.current = ts.webGate; /* D2 */ }`。
`activeRuns` 复用 `activeSubagentRunCount`；`backgroundBash = holder.current?.bashJobs?.backgroundJobCount() ?? 0`；`goalBusy = goal.record?.state ∈ {active,paused}`。
`settings.ts`：`AgentSettings.topicSwitch`、默认值、`parseTopicSwitchSettings(value.topicSwitch)`、`TIME_SETTING_MS_PATHS` 加四个 `topicSwitch.*Ms`。
`setting-specs.ts`：除 `debugAssumedTtlS` 外九键（enabled bool；costThresholdUsd number 0.01–100；model string；judgeTimeoutS seconds 1–30；minConfidence 0–1；
confirmTimeoutS 5–300；minChars count ≤200；regrowTokens count；expirySlackS 0–600），英文描述含隐私说明（"sends the new request and a short excerpt of the recent conversation to the judge model"）。

### 2. 身份与绑定（#9）

`activationId`（每次 wire 随机）、`holdId = activationId + ":" + seq`。每个异步效应（judge、confirm、hop 计时、release 屏障、看门狗、compaction 等待）在回调入口校验
`live && hold?.id === holdId`，不符 ⇒ no-op。每个 hold 一个 `AbortController`，`cancel-async` ⇒ abort（judge 与 confirm 收到）。`session_shutdown` ⇒ `live=false` 前先喂 `abort shutdown`。

### 3. input handler（同步，永不 await）

1. `releasing` 中：`source ∈ {interactive,rpc}` ⇒ handled + 追加 release 队列；`extension` ⇒ `continue`（可能是我们的回注；外来 extension 输入在此窗口可能先于 held，见 R12）。
2. `judging|confirming|hopping` 中：任何来源 ⇒ handled + 追加队列 + 喂 `newcomer`（这些阶段我们没有在途回注：hold 只能在 drain 完成后开始，见 5）。
3. `switching` 中：`continue`（I4，pi 的 `/new` 语义）。
4. 无 hold：组装 GateFacts（每读 `safe()`；`branch()` 一次 `getBranch()`）→ `evaluateSyncGates`；不过 ⇒ 计数 + `continue`；过 ⇒ `startHold`、
   `setStatus("topic-switch","topic check…")`、`queueMicrotask(runEffects)`、`handled`。handler 整体 try/catch：hold 未建立 ⇒ `continue`。

`webGate.tryClaim(req, ctx, release)`：无 hold ⇒ 用 `origin:"web"` 跑同一门（流式字段取 `ctx.isIdle()`）⇒ 过则以 `{kind:"web", release}` 建 hold 返回 true；
`judging|confirming|hopping` ⇒ 追加 `{kind:"web",release}` + 喂 newcomer、返回 true；`releasing` ⇒ 追加、返回 true；`switching` ⇒ false。

### 4. 效应执行（`hold.ts`）

- `judge`：链空 ⇒ `judged(no-model)`；否则取链上首个 `modelRegistry.find` 命中的模型（只试一个），`modelRegistry.complete(model,{systemPrompt,messages:[…]},{signal, maxTokens:64})`（title 先例 `src/title/index.ts:186-201`）。
- `confirm`：`confirmSwitch(ctx, deps.remote(), buildConfirmText(…), {timeoutMs, clock, id: holdId, signal})`。
- `hop`：`nonces.arm(nonce,{holdId})`、`pi.sendUserMessage("/topic-switch __go "+nonce,{expandPromptTemplates:true})`；5s 后 nonce 仍在 ⇒ 作废 + `hop-timeout`。
- `cooldown`/`record`：`pi.appendEntry(ENTRY_TYPE, …)`；冷却缓存同步更新。
- 看门狗：`judgeTimeoutMs + confirmTimeoutMs + 15s` ⇒ `abort watchdog`。所有 timer 经 `systemClock`（unref）。
- 效应执行抛错 ⇒ 喂 `abort watchdog`（PONR 前 ⇒ 回当前会话）。

### 5. release 队列（`release.ts`，R-A + 有序屏障，回应 E）

队列项：`{kind:"content", payload, deliverAs}`（held 或被截的 interactive/rpc 新来者，`deliverAs = 原 streamingBehavior ?? "followUp"`）| `{kind:"web", release}`。
held 永远是第一项。逐项串行：①若 `compacting` ⇒ 等 `session_compact|session_compact_failed`（≤120s 后照发）；②投递：content ⇒ `pi.sendUserMessage(toContent(payload),{deliverAs})`，
web ⇒ `release.current()`，`"refused"` ⇒ 改用 content 路径投递其文本（只此一次）；③屏障：等到「我方 handler 观察到一次 `source:"extension"` 的 input」**且**
（`agent_start` 已触发 或 `isStreaming && hasPendingMessages()`），上限 2s，再发下一项。队列空 ⇒ `released`，进入 drain：上一批发出的条数被 extension input 观察计满或 5s 到期后，
`draining=false`（门 `draining` 在此之前拒绝新 hold）。drain 超时后若迟到的我方回注在新 hold 的 judging 中被截：它只是被追加进新队列、随后投递一次——
恰好一次仍成立（门永不放行 extension 来源成为 held），只影响顺序。`abort shutdown` 时：held 若尚未发出 ⇒ 并入 `persist-pending`；尚未发出的新来者（interactive/rpc/web，
web 项调用 `release.elsewhere()` 定格气泡）⇒ 文本按序合并 `setEditorText` + notify（它们从未投递，安全；图片如实说明需重贴）；已发出的项不再动。

### 6. 会话切换与 PONR（`command.ts`，R-B）

`/topic-switch __go <nonce>`：

1. `nonces.consume(nonce)` 失败、或 `hold.id/phase` 不符（非 hopping）⇒ notify「链接已失效」返回（零投递）。
2. 预检（任一不过 ⇒ 喂 `preflight-failed` ⇒ 回当前会话）：`ctx.isIdle()`、`!compacting`、`ctx.model` 存在、`ctx.hasUI`。
3. 写**旧会话** `handoff{holdId, payload(含图片)}`；把 `{holdId, payload, fromSessionId, state:"pending", reason:"switch"}` 放进 transfer（§7）；喂 `ponr`（switching）。
4. `let taken = false; const r = await ctx.newSession({ withSession: async (rctx) => { if (taken) return; taken = true; transfer.markDelivering(holdId);`
   `void rctx.sendUserMessage(toContent(payload)).catch(() => rctx.ui.notify(中文：原请求未能在新会话送达，输入 /topic-switch last --send 重发)); } })`。
5. **（r3 主会话裁定 N2 修正）** `r.cancelled`（pi 只在 `session_before_switch` 阶段、teardown **之前**返回 cancelled，`agent-session-runtime.js:147-150`，旧会话完好）且 `!taken` ⇒ 经 transfer CAS（§7）`pending→cancelled` 成功后喂 `switch-cancelled`（回当前会话）。
   **抛错**（RPC；TUI 由 pi 走 fatal）：以「本 activation 是否已收到 `session_shutdown`」为判据（teardown 必先发 shutdown，`:102-112`）——未收到 ⇒ 同 cancelled；已收到 ⇒ 视为 PONR 之后，**绝不**回旧会话，transfer 保持 pending，只 notify + `/topic-switch last --send` 取回。
   `taken` ⇒ 喂 `switch-entered`。
   held 若来自 web：`switch-entered` 时调 `release.elsewhere()`（气泡定格；web 端随 `session_start` 跟到新会话）；`switch-cancelled` 走 release 队列 ⇒ `release.current()`。
6. PONR 后看门狗 30s：仍未 `taken` ⇒ 仅 notify（「切换未完成，原请求已保存，可 /topic-switch last 取回」），绝不投递。
   **（r3 N3 修正）** `taken` 局部布尔改为 transfer 记录上的**进程内 CAS**（同一个 `Symbol.for` 全局 transfer 条目，withSession 回调、`/topic-switch last --send`、看门狗、recovery 共用）：状态 `pending → delivering → resolved`，旁路 `pending → cancelled | manual`；看门狗触发时 CAS `pending→manual`（之后迟到的 withSession CAS 失败 ⇒ 不发送，只 notify「请求已转为手动取回」）；`last --send` CAS `pending|manual → delivering`；withSession 入口 CAS `pending → delivering` 失败即 return。持久化面沿用 §7 的 `delivering` 先写规则；进程崩溃窗口按 R-C at-most-once。必测：「watchdog → /last --send → 迟到 withSession」不双发；「withSession 已 delivering → /last --send」被拒并提示已送达/投递中。
7. 新 activation 的 `/topic-switch last [--send]` 先查 transfer（≤10 分钟）再查本分支记录：显示文本、有无图片、状态；`--send` = 用户显式重发完整 payload（含图片）到当前会话。

### 6b. r3 主会话裁定（评审第 2 轮后，按评审收敛规则，不再复审争论）

- **r1#1 / N1 不修，记为残余 R15**：`ctx.newSession()` 是 pi 自身的会话替换（与用户手动 `/new` 完全同一路径），pi 不提供取消，扩展无法让它「有界」；本功能自己的所有等待（judge/confirm/hop/屏障/看门狗）均有界，且没有任何本功能状态阻塞在该 await 上（看门狗独立计时）。switching 窗口中并发进入旧会话的 interactive/rpc 输入，其语义与手动 `/new` 期间的并发输入相同（pi teardown 先 `abort()` 再 shutdown），属 pi 平台行为，不在本功能范围内重新定义。
- **N2、N3 修**：见 §6 第 5、6 步的 r3 修正。

### 7. /reload 与崩溃恢复（`recovery.ts`，R-C、I5）

- **transfer**：`Symbol.for("pi-subagent:topic-switch-transfer")` 进程全局 Map（worktree-origin 先例；cap 4、TTL 10 分钟、FIFO），值 `{holdId, payload, fromSessionId, reason, state:"pending"|"delivering", at}`。
- `session_shutdown(reason)` 且 hold ∈ judging/confirming/hopping（`persist-pending`）：同步 `pi.appendEntry(pending{holdId,payload,reason})` + transfer 置 pending；
  `quit` 也写（进程退出后可经 resume + `/topic-switch last` 取回，改善 R3）。
- 新 activation `session_start`：`planRecovery(...)` 执行动作：`deliver` ⇒ **先**写 `delivering` 并置 transfer state=delivering，**再** `pi.sendUserMessage`（走 release 队列，享受压缩等待与屏障）；
  `editor` ⇒ `setEditorText` + notify（该请求从未投递，安全）；`resolve` ⇒ 写 `resolved(observed)`；`notice` ⇒ notify（「上次截留的请求可能未送达：<预览>，可 /topic-switch last 查看/重发」）+ 写 `resolved(noticed)`。
- `delivering` 永不自动重发；观测「其后第一条 user 消息 digest 相等」在下一次 `session_start`/`agent_settled` 时由 `planRecovery` 判定（同进程也用同一规则，不额外文本匹配）。

### 8. 事件跟踪

`session_before_compact`（只观测，返回 undefined）/`session_compact`/`session_compact_failed` ⇒ `compacting`；`agent_start` ⇒ 屏障信号；`session_start`/`session_tree` ⇒ 重算冷却缓存 + 恢复；
`session_shutdown` ⇒ `abort shutdown`、作废 nonce、清 timer 与状态栏、`live=false`。

### 9. 命令与诊断

`/topic-switch [status]`：开关、阈值、判定模型链（`provider/id`）、冷却、skip 计数、最近 5 条 outcome（英文 token 行 + 中文说明）；`last [--send]` 见 §6.7；`__go` 内部（补全只给 `status`/`last`）。
会话条目只在截留后写 `outcome`（estUsd 两位、prefixK 千 token 取整），恢复记录含 payload（与 user 消息落盘同级）；无路径、无模型名以外标识；v1 不开 jsonl。
状态栏 `topic-switch`：`topic check…` / `topic confirm…`（英文 token）。

### P3b 测试

- `topic-switch-settings.test.ts`：`*S` ⇄ `*Ms`、越界回默认、specs 镜像、`debugAssumedTtlS` 不在 specs。
- `wire.test.ts`（fake pi 记录 on/registerCommand/sendUserMessage/appendEntry/setEditorText/notify/setStatus；fake clock/warmth/remote/stack）：`enabled:false` 零注册；
  门不过零副作用且 handler 返回非 Promise；fact 抛错 ⇒ continue；**回注不被截**（回注产生的 extension input 经过 handler 得 continue，hold 不变）；web 认领三种阶段返回值；
  迟到 judge/confirm/hop 结果在 holdId 变化或 shutdown 后 no-op（#9）；外部 abort 让 judge/confirm 都收到 signal（#8）。
- `release.test.ts`：held 先于新来者；多个新来者保序；屏障超时仍各一次；web refused ⇒ content 路径一次；压缩中等待；drain 未完前门 `draining` 拒新 hold。
- `recovery.test.ts`：`planRecovery` 驱动的六类场景（同会话 reload、跨会话 new/resume、delivering 已观测、delivering 未观测、崩溃 pending、handoff 残留）+ 每个 notice 只一次。
- **fail-open 矩阵**（每格断言：held 恰好一次、目的地、无双投、冷却合 D4、outcome 正确）：

| 路径                                               | held 去向                                   | 冷却 |
| -------------------------------------------------- | ------------------------------------------- | ---- |
| judge related/timeout/error/parse/no-model/aborted | 当前                                        | 否   |
| confirm stay/cancel/timeout                        | 当前                                        | 是   |
| confirm unavailable/error                          | 当前                                        | 否   |
| hold 中新来者（TUI/RPC/web/extension 各一）        | 当前（held 先）                             | 否   |
| 看门狗                                             | 当前                                        | 否   |
| switch → hop 5s 未消费（随后迟到 `__go`）          | 当前（`__go` 零投递）                       | 否   |
| switch → 预检失败                                  | 当前                                        | 否   |
| switch → `{cancelled:true}` / RPC throw            | 当前                                        | 否   |
| switch → withSession → rctx.sendUserMessage reject | 新会话通知 + `last --send`                  | 否   |
| switch 成功                                        | 新会话（旧分支只有 handoff 记录）           | 否   |
| PONR 后 newSession 挂起 30s                        | 仅通知；之后若 withSession 到达照常投递一次 | 否   |
| shutdown reload（judging/confirming/hopping）      | 新 activation 自动一次（先写 delivering）   | —    |
| 再次 reload 于 delivering                          | 不重发；观测到 ⇒ resolved，否则通知         | —    |
| shutdown new/resume/fork                           | 新会话编辑器（文本）+ 通知                  | —    |
| shutdown quit / 进程崩溃                           | 磁盘 pending ⇒ resume 时通知 + `last`       | —    |
| shutdown 于 switching                              | withSession 照常                            | —    |

- `tests/integration/topic-switch.test.ts`：真实 `activate()`（`compact-hint-wiring.test.ts` 风格）：input 注册晚于 web-hub；`wireCacheTtl` 返回端口接入；`promptGateRef` 被赋值（D2）；
  子会话不注册；print 模式 continue；timer `hasRef()===false`；`/reload` 前后各自 activationId，旧 activation 回调 no-op。
- `pi-free.test.ts`：§2 列出的 pi-free 文件无 `@earendil-works/*` import。

## 3. 文档

AGENTS.md「Repository layout」加 `src/topic-switch/` 条目（≤12 行：post-guard、pi-free/wire 分层、I1–I6、web 认领端口、PONR、恢复记录、四翻转点、设计文档链接）；
`src/cache-ttl/` 条目加一句 warmth 端口（证据型冷热）；`src/web-hub/` 条目加一句 PromptGatePort。CHANGELOG `[Unreleased]` → `### Added`：topic-switch（默认开、$0.5、TUI+web 确认、
非 Anthropic 不触发、隐私说明、`/topic-switch last`）。

## 4. 验收清单（verifier）

- [ ] format:check / typecheck / test / build 全绿；`test:conformance` 的 S1–S9 全绿或已按 §1 兜底并在 wire.ts 头注释写明。
- [ ] 文件域与 §2 一致；`src/stack.ts`、`src/ask-user/**`、`src/compact-hint/**` 无 diff；pi-free 测试通过；导出集合均 frozen 数组 + 判定函数，无导出 Set/Map。
- [ ] 四个翻转点各只一处定义（grep 常量名/`promptGateRef.current =` 唯一）。
- [ ] I1：没有任何 bypass/内容哈希放行代码；回注经过 handler 得 continue 的测试存在。I2：web 无文本匹配判定。
- [ ] 归约器转移矩阵 + 200 种子性质测试；迟到事件全组合 fx=[]；所有异步回调校验 `{activationId, holdId}`。
- [ ] economics 与真实 `calculateCost` 交叉核对；warmth「mode/lastSent 不产生 warm」反例测试存在。
- [ ] fail-open 矩阵每格有测试；`delivering` 永不重发；不存在「发出后放编辑器副本」路径。
- [ ] `wireCacheTtl` 既有测试零修改；payload 零改动；`usage-ledger` 既有 toEqual 不变。
- [ ] timer 全 unref；无模块级可变状态（transfer 是唯一 `Symbol.for` 全局，cap/TTL 有测试）。
- [ ] UI 文案语言分工；设置描述含隐私说明；AGENTS.md/CHANGELOG 已更新；Conventional Commits。

## 5. 真机验收（tmux；见 memory live-acceptance-tmux）

隔离 HOME 后 `pi install /home/bluecake/ai/pi-toolkit`（不用 `-e`）；`~/.pi/agent/pi-subagent.json`：
`{"cacheTtl":{"mode":"auto","keepalive":false,"adaptiveEnabled":false},"topicSwitch":{"costThresholdUsd":0.01,"debugAssumedTtlS":20,"confirmTimeoutS":20},"webHub":{"enabled":true}}`
（keepalive 关：否则 ping 让门 3a 判 warm/unknown；模型用 Anthropic 路由）。`tmux new-session -d -s tsacc -x 220 -y 55 -c /tmp/ts-acc "pi --model <anthropic/sonnet> --thinking low"`；
`send(){ tmux send-keys -t tsacc -l "$1"; tmux send-keys -t tsacc Enter; }`（斜杠命令隔 1s 补 Enter）。

1. 建上下文：让模型读 ~20k token 文件并概括（5m 写价下 >$0.01）。
2. 立即发无关请求 ⇒ 不弹（`/topic-switch status` 中 warm 计数 +1）。
3. `sleep 60` 后发「写一首关于秋天的七言绝句」⇒ `topic check…` ⇒ 弹窗（估价 + 预览）⇒ 选切换 ⇒ 新会话处理；`/resume` 旧会话仍在且无该请求，`/topic-switch last` 在旧会话可见 handoff。
4. 留下 ⇒ 当前会话处理一次；再 `sleep 60` 发无关请求 ⇒ 不弹（冷却）。5. 不操作 20s ⇒ 留下并冷却（D4）。
5. 冷态发 `继续` / `这个再改一下` / `/topic-switch status` ⇒ 不弹。
6. 弹窗期间从 web 输入框另发一条 ⇒ 弹窗关闭，held 先、web 消息后，各一次。
7. web：`/webhub open`，冷态从 web 发无关请求 ⇒ TUI 与 web 同时弹；web 点切换 ⇒ TUI select 关闭、web 跟随新会话；气泡为 observed→定格。
8. `topicSwitch.model:"nope/x"`、`title.model:"nope/y"` ⇒ 用会话模型判定（D3）；`judgeTimeoutS:1` + 不可达模型 ⇒ 1s 后当前会话照常一次。
9. `topic check…` 期间 `/reload` ⇒ reload 后当前会话恰好处理一次；`/topic-switch status` 显示 delivering→resolved。
10. 收尾：`tmux kill-session -t tsacc`；按确切路径删 `/tmp/ts-acc` 与 `~/.pi/agent/memory/-tmp-ts-acc/`。

## 6. 残余风险

- R9 TUI 下 PONR 后 `newSession` 抛错由 pi 走 fatal（与手动 `/new` 同级）：旧会话 `handoff` 记录含完整 payload，resume 后 `/topic-switch last --send` 取回。
- R12 releasing 窗口内外来 extension 输入（cron/通知）不被截（无法与我方回注区分），可能先于 held 到达；不丢不重，仅顺序例外。
- R13 S9 观测规则依赖「delivering 后第一条 user 消息」：若期间用户先发了别的消息 ⇒ 判未观测 ⇒ 只通知（至多一次方向）。
- R14 payload 图片 >8MB 不持久化（通知中如实说明）；进程内 transfer 仍持有全量。

## 修订记录 r2

| #    | 评审意见                                                                                   | 处置                                                                                                                                                                                                                                         |
| ---- | ------------------------------------------------------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1    | newSession 无界、TUI fatal 违反 fail-open                                                  | 采纳（R-B）：§P3b.6 定义 PONR；PONR 前一切失败回当前（含预检、hop 超时、cancelled、RPC throw）；PONR 后只 withSession 投递，consume-once 标志仲裁；看门狗只通知；handoff 存完整 payload，`/topic-switch last --send` 取回；TUI fatal 记为 R9 |
| 2    | reload 恢复先写 pending-done 后投递                                                        | 采纳（R-C）：`pending → delivering → resolved`，先写 delivering 再发，`delivering` 永不重发，未观测只通知；终态只在观测/通知之后写（§P1 records、§P3b.7）                                                                                    |
| 3    | 文本+图数 bypass 可被伪造/超时后被再截                                                     | 采纳：删除 bypass；I1 结构性不拦截（handler 只截 interactive/rpc，回注恒为 extension）                                                                                                                                                       |
| 4    | switching 期间 append 丢项                                                                 | 采纳（R-A）：取消 bundle；hold 期新来者立即结束 hold（留下），switching 中输入直接放行                                                                                                                                                       |
| 5    | isWebPrompt 文本+2s 误归属                                                                 | 采纳（R-D）：改为 web-hub 派发点同步认领 `PromptGatePort`（cmd frame 身份），删除 isWebPrompt                                                                                                                                                |
| 6    | 成本公式错误                                                                               | 采纳：§P1 economics 逐项复刻 `calculateCost`，tier 按 input+cacheRead+cacheWrite，1h 只计 1h 部分 2×input；测试与真实 calculateCost 交叉核对；不再复用 pricing.ts                                                                            |
| 7    | 意图 ≠ 证据，缺 lineage/route                                                              | 采纳：warm 只来自 `coversPrefix(0)` 或 5m 内已证实触碰（同 route）；mode/lastSent/1h 痕迹只抬高「冷」的证明门槛与 nextWriteTtl；拿不准 ⇒ unknown ⇒ 不弹。超过 1h+slack 无触碰按 Anthropic 最长 TTL 判冷（证明而非推测）                      |
| 8    | confirmSwitch 无 AbortSignal                                                               | 采纳：`signal` 入参，abort 关闭 select 与 remote，resolve `aborted`                                                                                                                                                                          |
| 9    | 只有 judge 做 epoch 校验                                                                   | 采纳：所有异步效应绑定 `{activationId, holdId}`；归约器对迟到事件 fx=[]                                                                                                                                                                      |
| 10   | 发出后 10s 未消费放编辑器会双投                                                            | 采纳：删除该路径；发出后永不放编辑器副本；仅「从未投递」的跨会话 transfer 才放编辑器                                                                                                                                                         |
| 11   | abort 不在状态机/矩阵                                                                      | 采纳：`abort{watchdog,shutdown}`、`cancel-async`、`preflight-failed` 进归约器与矩阵                                                                                                                                                          |
| 12   | wireCacheTtl 返回类型/ledger `at`/mock/生命周期                                            | 采纳：§P2 写明 `CacheTtlWiring`、唯一调用点、无 mock、lastSent 生命周期（session_start 清空、按 sessionId 过滤、端口现取）、`at` 条件展开                                                                                                    |
| 13   | v1 范围过大                                                                                | 部分采纳（R-A）：保留 TUI+web 确认与 web 覆盖（D2）；删除多消息 bundle 迁移；debug TTL 缝保留（1 设置 + 1 字段）                                                                                                                             |
| 14   | ReadonlySet 仍可变                                                                         | 采纳：导出 frozen 数组 + 判定函数，不导出 Set/Map                                                                                                                                                                                            |
| 复核 | consult r2 预审：B/C 需完整 payload 与非文本关联；E 需 releasing 屏障与 extension 规则一致 | 采纳：payload 含图片 + digest；观测以「delivering 之后第一条 user 消息 digest」而非全文搜索；releasing 屏障 + drain 门；extension 规则按阶段定义（§P3b.3）。D 的「1h 内 unknown」保留，超 1h 判冷有 TTL 上界证明                             |
