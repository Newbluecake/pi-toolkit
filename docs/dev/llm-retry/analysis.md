# LLM 请求超时与重试：现状梳理（只读分析）

> 状态：调研文档，不含任何实现改动。范围覆盖 pi-ai（`node_modules/@earendil-works/pi-ai`）、
> pi-coding-agent（`node_modules/@earendil-works/pi-coding-agent`，仅有压缩打包产物）与本仓库
> `pi-toolkit` 自身的 run 级超时/重试代码。
>
> 证据格式：`文件路径:行号`。打包产物（`dist/bundle/**`）为单行压缩 JS，无法给出稳定行号，
> 以"函数名/字符串锚点，可用 `grep -o` 复现"标注；未能找到证据的结论一律写"未找到"，不作推测。

---

## 全局结论一览（六层各一句话）

1. **provider 级 HTTP 重试**：`pi-ai` 的 `retryProviderRequest` 把 Anthropic/OpenAI 官方 SDK 的
   `maxRetries: 0`（禁用 SDK 自带重试）后自行重放整条请求闭包，重试判定完全照抄两家 SDK 的
   HTTP 状态码/`x-should-retry`/`retry-after(-ms)` 规则，默认 `maxRetries` 由
   `settings.retry.provider.maxRetries`（**未设时为 `undefined`，等价 0 次重试**）决定——也就是说
   **provider 级默认不重试**，除非用户显式配置。
2. **流式中途失败**：pi-ai 把"用户/上游主动 abort"与"真错误"用同一行代码二分
   （`options?.signal?.aborted ? "aborted" : "error"`），部分已产出的文本/工具调用块保留在
   `output` 里返回给调用方，但**流本身一旦开始就不会被 provider 层重试**——中途断线直接冒泡为
   `stopReason: "error"`，交给上层的 turn 级重试（`retryAssistantCall`）决定是否整轮重放。
3. **上下文溢出重试**：溢出识别（`isContextOverflow`）与截断识别（`isRecoverableLength`）在
   pi-ai 里是纯文本正则/用量判定，实际的"压缩后重放"发生在 pi-coding-agent 内部
   （`willRetry = assistantMessage.stopReason !== "stop"`），且有 `_overflowRecoveryAttempted`
   一次性闸门防止死循环；`src/compact-hint/` 未接入这条事件（`reason==="overflow"`/`willRetry`
   在 `src/compact-hint/` 全仓搜索零匹配），二者互不干扰。
4. **run 级超时（pi-toolkit）**：`watchdog.ts` + `deadline.ts` 实现分层预算（子阶段 + 软截止 +
   宽限 + 硬天花板），`reaper.ts` 做 L0→L3p 逐级升级；provider 重试在 pi-toolkit 眼里只是
   `retry_backoff` 相位的一段"计划内等待"，用 `idleDueAt` 兜底，但**这只覆盖 turn 级重试
   （layer 2），provider 级重试（layer 1）在 pi-ai 内部完全不可见，没有对应的相位/timer**。
5. **UI 呈现**：`fleet-panel.ts:173` 的 `♻重试N/M` 读的是 pi-toolkit 自己状态机里的
   `diag.retry`，该字段由 `session-driver.ts:154-161` 把 pi 的 `auto_retry_start`/`auto_retry_end`
   事件（turn 级重试，layer 2）映射成 `retry_start`/`retry_end` 写入——**与 provider 级 HTTP 重试
   完全是两套机制**，后者永远不会出现在这个计数器里。
6. **其它子系统对比**：`web-search/resilience.ts` 是"HTTP 状态码白名单 + 指数退避 + 3 次总尝试"
   的经典重试，`cache-ttl/ping-client.ts` 则**设计上刻意不重试**（`I-K4` 不变量），因为它是
   非必要的旁路探测请求，重试本身就可能制造它要规避的缓存写入副作用。

---

## 第 1 层：provider 级 HTTP 重试（pi-ai / pi-coding-agent 内部）

### 1.1 重试入口与调用点

`retryProviderRequest` 定义于
`node_modules/@earendil-works/pi-ai/dist/utils/provider-retry.js:75-92`（`.d.ts` 版本注释见
`utils/provider-retry.d.ts:1-15`）。所有 API 适配器都用同一模式调用它：

| API 路径                | 调用点                                                                                                                              | SDK 侧设置                                           |
| ----------------------- | ----------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------- |
| Anthropic Messages      | `api/anthropic-messages.js:382`                                                                                                     | `requestOptions.maxRetries: 0`（同函数内，紧邻构造） |
| OpenAI Chat Completions | `api/openai-completions.js:213`                                                                                                     | 同上，`maxRetries: 0`                                |
| OpenAI Responses        | `api/openai-responses.js:111`（grep 命中，压缩产物无独立行号但同名函数唯一）                                                        | 同上                                                 |
| Azure OpenAI Responses  | `api/azure-openai-responses.js:85`                                                                                                  | 同上                                                 |
| OpenRouter Images       | `api/openrouter-images.js:31`                                                                                                       | 同上                                                 |
| Google（Gemini）        | `api/google-shared.js:384`，走独立包装 `retryGoogleRequest`（`api/google-shared.d.ts:82`），同样复用 `provider-retry.js` 的选项形状 | 同上（Google SDK 无内建重试概念，逻辑等价套用）      |

所有路径的共同点（`provider-retry.d.ts` 文档字符串原话，`utils/provider-retry.js:1-92`）：
**先让 SDK 自己的 `maxRetries` 归零，再用 `retryProviderRequest` 外包一层可中断（尊重
`AbortSignal`）的重试**——原因是两家 SDK 内建的重试计时器不响应外部 abort 信号，会在用户按
Esc 后继续傻等。

### 1.2 `maxRetries` / `maxRetryDelayMs` 默认值与覆盖链

- `retryProviderRequest` 自身默认值：`maxRetries = options.maxRetries ?? 0`
  （`utils/provider-retry.js:76`），即**调用方不传就是 0 次重试**。
  `maxRetryDelayMs` 未传时用 `DEFAULT_MAX_RETRY_DELAY_MS = 60_000`（`utils/provider-retry.js:1`,
  `:23`）。
- pi-coding-agent 侧的真实默认值（打包产物 `chunk-OMWWHBTG.js`，函数
  `getProviderRetrySettings()`）：

  ```
  getProviderRetrySettings(){return{timeoutMs:this.settings.retry?.provider?.timeoutMs,
  maxRetries:this.settings.retry?.provider?.maxRetries,
  maxRetryDelayMs:this.settings.retry?.provider?.maxRetryDelayMs??6e4}}
  ```

  （字符串锚点 `getProviderRetrySettings(){`，`dist/bundle/chunks/chunk-OMWWHBTG.js`）
  即 `timeoutMs`/`maxRetries` **没有内建默认值**——`settings.retry.provider` 未配置时两者都是
  `undefined`，`retryProviderRequest` 收到 `undefined` 就退回自己的 `?? 0`，**provider 级默认
  0 次重试**；`maxRetryDelayMs` 默认 60 秒（与 layer-1 wrapper 的默认值一致，双重兜底）。

- 该设置**可被用户 settings 覆盖**（`settings.retry.provider.{timeoutMs,maxRetries,
maxRetryDelayMs}`），但**未找到**任何 agent-type frontmatter / 模型配置级别的覆盖入口——
  `src/config/` 全仓搜索 `getRetrySettings|getProviderRetrySettings|settings\.retry` 零匹配，
  说明 **pi-toolkit 完全不触碰这层设置**，它是纯 pi 内部概念，模型无法感知也无法调整。

### 1.3 可重试条件判定

`isRetryableProviderError`（`utils/provider-retry.js:9-19`）：

1. 响应头 `x-should-retry: "true"|"false"` 优先于一切其它判定（`:10-13`）。
2. 若响应无 `status`（网络层失败，尚未拿到 HTTP 响应）⇒ 视为可重试（`:14`）。
3. 否则命中集合 `{408, 409, 429} ∪ [500, ∞)` 才重试（`:15-18`）。

### 1.4 退避算法

`getRetryDelayMs`（`utils/provider-retry.js:29-40`）优先级：

1. 响应头 `retry-after-ms`：直接取该毫秒数（`:30-32`）。
2. 响应头 `retry-after`：数字按秒解析，否则按 HTTP-date 解析算出 `Date.parse(...) - now()`
   （`:33-36`）。
3. 以上两者都命中 `validateServerRetryDelayMs`（`:22-28`）——若延迟超过 `maxRetryDelayMs`
   （默认 60s），**直接抛错终止重试**，不会真的等那么久（意图是把"该不该等一个超长退避"的
   决策权交还给上层，见 §4.6 的叠加关系）。
4. 都没有时用**纯指数退避 + 25% 抖动**：`min(0.5 * 2^retryIndex, 8) * 1000 * (1 - random()*0.25)`
   （`:37-38`）——即最大裸延迟封顶 8 秒，抖动只会让它更短，不会更长。

### 1.5 请求超时默认值

- Anthropic SDK 常量 `DEFAULT_TIMEOUT = 6e5`（10 分钟），锚点 `DEFAULT_TIMEOUT=6e5` 出现在
  `dist/bundle/chunks/anthropic-messages-JWX2WP65.js`（打包产物内 SDK 源码）。
- **非流式请求按 `max_tokens` 推算超时并强制要求流式**的逻辑确实存在，位于同一打包文件：
  锚点 `_calculateNonstreamingTimeout(maxTokens){if(3600*maxTokens/128e3>600)throw new
AnthropicError("Streaming is required for operations that may take longer than 10
minutes...")}`。判定公式等价于 `maxTokens/128000 tokens/s` 吞吐假设下预估耗时超过 10 分钟
  即拒绝非流式调用；`MODEL_NONSTREAMING_TOKENS` 表为特定型号（如 `claude-opus-4-*`）设了更保守
  的非流式上限（8192 tokens）。
- **但这条逻辑在 pi 的正常调用路径上是死代码**：pi-ai 对 Anthropic/OpenAI 请求硬编码
  `stream: true`（`api/anthropic-messages.js:382,744`、`api/openai-completions.js:587`），
  `completeSimple` 也只是 `streamSimple(...).result()` 的语法糖
  （`node_modules/@earendil-works/pi-ai/dist/models.js:397-398`），本质仍是消费流后拼装成完整消息。
  因此"非流式强制走流式"的分支只在直接绕过 pi-ai、拿裸 SDK 客户端发非流式请求时才会触发，
  **pi 正常对话流程不会碰到**。
- pi-coding-agent 侧的空闲超时（`httpIdleTimeoutMs`）默认值：`DEFAULT_HTTP_IDLE_TIMEOUT_MS=3e5`
  （5 分钟），锚点同名常量出现在 `chunk-OMWWHBTG.js`；`streamFn` 组装 `timeoutMs` 的优先级是
  `options2?.timeoutMs ?? providerRetrySettings.timeoutMs ?? effectiveTimeoutMs`（同文件，锚点
  `effectiveTimeoutMs=httpIdleTimeoutMs===0?2147483647:httpIdleTimeoutMs`），即
  `httpIdleTimeoutMs===0` 时超时被设为 `Number.MAX_SAFE_INTEGER` 量级的哨兵值（事实上不限时）。

### 1.6 流式 vs 非流式重试差异

pi 正常路径下**只有流式**（见上），因此本仓库讨论的"流式中途失败"就是唯一路径。`retryProviderRequest`
包裹的是**发起请求并拿到 Response 对象**这一步（`.withResponse()`/`.asResponse()`），也就是说
**重试只覆盖"连接建立/首字节返回前"的失败**；一旦拿到 200 响应开始读 SSE 流，`retryProviderRequest`
的 `try/catch` 已经退出，后续流中断不会被这层重试捕获（进入第 2 层）。

### 第 1 层默认值/阈值表

| 参数                                     | 默认值                                                | 来源                                                                        | 可覆盖                                                                           |
| ---------------------------------------- | ----------------------------------------------------- | --------------------------------------------------------------------------- | -------------------------------------------------------------------------------- |
| `retryProviderRequest` 默认 `maxRetries` | `0`（无覆盖时不重试）                                 | `provider-retry.js:76`                                                      | `options.maxRetries`（来自 `settings.retry.provider.maxRetries`，用户 settings） |
| `maxRetryDelayMs`                        | `60_000`ms                                            | `provider-retry.js:1,23` + `getProviderRetrySettings()` 的 `??6e4` 双重默认 | `settings.retry.provider.maxRetryDelayMs`                                        |
| 可重试 HTTP 状态码                       | `408, 409, 429, 5xx`                                  | `provider-retry.js:15-18`                                                   | `x-should-retry` 响应头优先覆盖                                                  |
| 无 `status` 的网络错误                   | 默认可重试                                            | `provider-retry.js:14`                                                      | 不可覆盖                                                                         |
| 纯指数退避封顶                           | `8_000`ms（含 −25%~0 抖动）                           | `provider-retry.js:37-38`                                                   | 不可配置，除非服务端给出 `retry-after(-ms)`                                      |
| Anthropic SDK 请求超时                   | `600_000`ms（10 分钟）                                | 打包产物 `DEFAULT_TIMEOUT=6e5`                                              | `options.timeoutMs`                                                              |
| pi 侧 HTTP idle 超时                     | `300_000`ms（5 分钟），`0` = 近似不限                 | `DEFAULT_HTTP_IDLE_TIMEOUT_MS=3e5`                                          | `settings.httpIdleTimeoutMs`                                                     |
| 强制流式的非流式耗时阈值                 | `600`s（10 分钟，按 `maxTokens/128000` token/s 估算） | 打包产物 `_calculateNonstreamingTimeout`                                    | 不适用（pi 硬编码流式，死代码）                                                  |

---

## 第 2 层：流式中途失败 / stopReason 错误

### 2.1 abort 与 error 的二分

Anthropic：`output.stopReason = options?.signal?.aborted ? "aborted" : "error"`
（`node_modules/@earendil-works/pi-ai/dist/api/anthropic-messages.js:598`）。
OpenAI Completions：同一行代码模式，`api/openai-completions.js:517`。

判定依据**只有一个**：产生错误的那一刻，调用方传入的 `AbortSignal` 是否已经处于 `aborted`
状态。**没有单独区分"用户按 Esc" vs "上游服务取消连接"**——只要调用方的 signal 没被
abort，无论断线原因是什么，一律记为 `"error"`；只有调用方（pi-toolkit 的 `runner.ts`/
`reaper.ts` 或 pi 自身的 `/esc`）主动 abort 了这个 signal，才记为 `"aborted"`。

### 2.2 是否重试、部分输出如何处理

- Layer 1（`retryProviderRequest`）只覆盖"拿到响应流之前"的失败（见 §1.6），流已经开始
  之后的中断**不会被这层捕获重试**——异常在读流循环里直接抛出，交由上层。
  `anthropic-messages.js:586,598` 所在的 catch 块把已经产出的 `output`（含部分 `content`
  数组、累计的 `usage`）原样保留在返回值里，只是把 `stopReason` 改写为 `error`/`aborted`，
  **不会丢弃已生成的文本/工具调用块**。
- Layer 2（`retryAssistantCall`，`utils/retry.js:114-153`）拿到这个
  `stopReason==="error"` 的完整 `AssistantMessage` 后决定要不要整轮重放：
  - `stopReason==="aborted"` ⇒ 直接返回，**永不重试**（`:120-124`）。
  - `stopReason!=="error"`（含正常 `"stop"`）⇒ 直接返回成功（`:126-130`）。
  - `stopReason==="error"` 但 `isRetryableAssistantError` 判否，或重试预算耗尽 ⇒ 直接返回
    这条错误消息（`:132-137`）。
  - 否则整轮重放：`produce()` 会重新发起一次完整请求（模型看不到"半截"的上一次尝试，
    上一次产出的部分文本**不会被拼接进下一次请求的上下文**——`produce` 闭包每次调用都是
    独立的一次 `stream()`/`completeSimple()`）。

### 2.3 可重试错误分类：基于文本正则，而非状态码

`isRetryableAssistantError`（`utils/retry.js:166-172`）完全依赖对 `errorMessage` 字符串做正则
匹配，两张模式表都在 `utils/retry.js`（压缩产物同名函数出现在
`dist/bundle/chunks/chunk-OMWWHBTG.js`，源文件即 `utils/retry.js`）：

- `NON_RETRYABLE_PROVIDER_LIMIT_ERROR_PATTERN`：配额/账单耗尽相关文案（`insufficient_quota`、
  `quota exceeded`、`billing`、`GoUsageLimitError` 等），命中则**永不重试**，即便同时命中下面的
  可重试表也优先判否（`utils/retry.js:166-169`）。
  这层判断**先于**下面的可重试表，即"永不重试"具有更高优先级。
- `RETRYABLE_PROVIDER_ERROR_PATTERN`：涵盖 `overloaded`/`rate.?limit`/`429`/`5xx`/网络传输失败
  （`fetch failed`/`ECONNRESET`/`timeout`/`socket hang up` 等）/流提前结束（`ended without`）/
  显式重试建议文案（`you can retry your request`）等约 30 条正则。

这意味着 **Layer 2 的可重试判定与 Layer 1 完全独立、互不复用**：Layer 1 看的是结构化的
HTTP 状态码/响应头，Layer 2 看的是拼进 `errorMessage` 里的自由文本，两套判断口径不保证一致
（例如 Layer 1 会重试的 `409`，Layer 2 的正则表里**未找到** `409` 对应的关键词，只有
`overloaded`/`rate.?limit` 等语义化词条，`409 Conflict` 类错误message若不含这些关键词就不会被
Layer 2 重试）。

### 2.4 与 Layer 4（run 级）的接口

pi-toolkit 只在 Layer 2 决定"要重试"时才能看到信号（`auto_retry_start`/`auto_retry_end`
事件），Layer 1 内部的重试对 pi-toolkit 完全透明——一次 provider 级重试从 run 状态机的视角看
就是"model_turn 相位里等待时间变长了一点"，不会经过 `retry_backoff` 相位，也不会写入
`diag.retry`（详见第 5 层）。

---

## 第 3 层：上下文溢出触发的重试

### 3.1 溢出检测

`isContextOverflow`（`node_modules/@earendil-works/pi-ai/dist/utils/overflow.js:130-155`）三种
情形：

1. `stopReason==="error"` 且 `errorMessage` 命中 `OVERFLOW_PATTERNS`（约 25 条 provider 专属
   正则，`utils/overflow.js:36-61`）且不命中 `NON_OVERFLOW_PATTERNS`（限流类文案排除表，
   `:69-73`）。
2. "静默溢出"（z.ai 类）：`stopReason==="stop"` 但 `usage.input + usage.cacheRead > contextWindow`
   （`:141-146`）。
3. "截断型溢出"（Xiaomi MiMo 类）：`stopReason==="length"` 且 `usage.output===0` 且输入几乎填满
   上下文窗口（`:148-153`）。

配套的 `isRecoverableLength`（`utils/overflow.js:163-165`）判定"长度截断是否值得一次压缩重试"：
`stopReason==="length"` 且实际产出的 `output` token 数小于调用方期望的 `desiredMaxOutput`。

### 3.2 `SessionBeforeCompactEvent.reason`/`willRetry` 语义

类型定义（`node_modules/@earendil-works/pi-coding-agent/dist/core/extensions/types.d.ts:442-452`）：

```ts
export interface SessionBeforeCompactEvent {
  reason: "manual" | "threshold" | "overflow";
  willRetry: boolean;   // true = 本次压缩后，刚才中断的那一轮会被重放
  ...
}
```

`reason:"overflow"` 三选一里专指"因溢出触发的自动压缩"（相对 `/compact` 手动触发的
`"manual"` 与上下文用量阈值触发的 `"threshold"`）。`willRetry` 语义在同文件
`SessionCompactEvent`/`SessionCompactFailedEvent` 上复现（`:454-475`）：**true 表示压缩完成后
pi 会自动把刚才因溢出而中断的那一轮请求重新发出一次**。

### 3.3 压缩后重放的实际实现

打包产物锚点（`chunk-OMWWHBTG.js`）：

```
contextOverflow||recoverableLength){let willRetry=assistantMessage.stopReason!=="stop";
if(!willRetry)return await this._runAutoCompaction("overflow",!1);
if(this._overflowRecoveryAttempted){..."Context overflow recovery failed after one
compact-and-retry attempt. Try reducing context or switching to a larger-context model."...}
```

判定逻辑：

1. `willRetry = stopReason !== "stop"`——只有当这一轮因溢出/截断而**没有正常结束**时才会重放；
   若是"静默溢出但仍拿到了 stop"（case 2），`willRetry=false`，只压缩不重放。
2. **一次性闸门 `_overflowRecoveryAttempted`**：如果压缩重试后再次溢出，**不会无限循环**，
   直接终态失败并给出明确错误信息（"reducing context or switching to a larger-context model"），
   同时触发 `session_compact_failed` 事件（`reason:"overflow"`）。

### 3.4 与 `src/compact-hint/` 的关系

`grep -rn "overflow|willRetry|session_before_compact|session_compact\"" src/compact-hint/`
**零命中**（已实际执行确认）。`src/compact-hint/` 是纯粹的"context usage 阈值提醒 +
`compact_context` 工具建议"，监听的是 `turn_end` 钩子和自己的用量估算，**完全不订阅**
`session_before_compact`/`session_compact`/`session_compact_failed` 事件，因此：

- 溢出触发的自动压缩重放**不经过** `src/compact-hint/` 的任何逻辑，二者是并行、互不感知的
  两条路径。
- `src/compact-hint/` 的"软提醒"是为了让模型**主动**在阈值前调用 `compact_context`，从而
  **减少**真正撞到溢出→自动压缩→重放这条路径被触发的概率，但它本身不参与、不拦截、不影响
  溢出恢复的执行细节。

### 第 3 层默认值/阈值表

| 项                         | 值/规则                                         | 来源                                                          |
| -------------------------- | ----------------------------------------------- | ------------------------------------------------------------- |
| 溢出识别正则数量           | ~25 条 provider 专属模式 + 3 条排除模式         | `utils/overflow.js:36-73`                                     |
| 压缩重试次数上限           | 1 次（`_overflowRecoveryAttempted` 闸门）       | 打包产物锚点 `_overflowRecoveryAttempted`                     |
| 重放触发条件               | `stopReason !== "stop"`（error 或 length 截断） | 打包产物锚点 `willRetry=assistantMessage.stopReason!=="stop"` |
| `src/compact-hint/` 参与度 | 无（零匹配确认）                                | 本仓库全文搜索                                                |

---

## 第 4 层：pi-toolkit 的 run 级超时

### 4.1 分层预算（`src/core/deadline.ts`）

默认预算常量 `DEFAULT_BUDGET`（`src/core/deadline.ts:5-23`）：

| 字段             | 默认值               | 含义                                                                            |
| ---------------- | -------------------- | ------------------------------------------------------------------------------- |
| `queueWaitMs`    | 600_000ms（10min）   | 排队等待启动                                                                    |
| `startupMs`      | 30_000ms             | 创建/解析配置阶段                                                               |
| `bindMs`         | 60_000ms             | 扩展绑定阶段                                                                    |
| `firstEventMs`   | 120_000ms            | 首个事件到达前                                                                  |
| `idleMs`         | 240_000ms（4min）    | 无事件流出的静默超时（`model_turn` 双重约束之一，见下）                         |
| `modelTurnMs`    | 900_000ms（15min）   | 单轮模型调用硬上限（`model_turn` 双重约束之二）                                 |
| `toolMs`         | 600_000ms            | 工具执行                                                                        |
| `compactionMs`   | 300_000ms            | 压缩阶段                                                                        |
| `totalMs`        | 1_800_000ms（30min） | run 总预算（软截止）                                                            |
| `abortGraceMs`   | 10_000ms             | 停机宽限（cancel 后等它体面退出）                                               |
| `steerMs`        | 5_000ms              | reaper L1 steer 等待                                                            |
| `reapMs`         | 5_000ms              | reaper 阶段自身超时                                                             |
| `startupRetries` | 2                    | 启动阶段重试次数（与本文档主题的 provider/turn 重试无关，是会话创建失败的重试） |
| `retrySlackMs`   | 5_000ms              | `idleDueAt` 里给重试退避额外留的余量（见 4.2）                                  |
| `totalGraceMs`   | 90_000ms             | 软截止到点后的续跑宽限（timeout-notify 特性）                                   |
| `maxExtensions`  | 3                    | 单个 run 可延长次数上限                                                         |
| `maxTotalFactor` | 2                    | 硬天花板 = `totalMs * maxTotalFactor`                                           |

`model_turn` 相位的双重约束（`src/core/deadline.ts:44-56`，注释原文）：
`静默超时 = lastEventAt + idleMs`（持续产出 delta 的活跃流不会被误杀）与
`硬上限 = phaseEnteredAt + modelTurnMs`（单轮无论如何不得超过该值）取**较早者**。

### 4.2 `retry_backoff` 相位与 provider 重试的关系

`dueAtFor`（`src/core/deadline.ts:61`）：`retry_backoff` 相位直接复用 `idleDueAt`，公式见
`src/core/deadline.ts:82-84`：

```
idleDueAt = (diag.lastEventAt ?? diag.phaseEnteredAt) + budget.idleMs
            + (diag.retry?.delayMs ?? 0) + budget.retrySlackMs
```

即：这个截止点把"计划内的重试等待时长"（`diag.retry.delayMs`，来自 Layer 2 的
`auto_retry_start` 事件）显式加进去，再叠加 `idleMs` 与 `retrySlackMs` 的余量——这样一次
正常的、按计划进行的 turn 级重试退避不会被误判为"卡死"。**但这条兜底只覆盖 Layer 2（turn 级
重试），Layer 1（provider HTTP 级重试）对 pi-toolkit 完全不可见**（见 §4.6 详述）。

### 4.3 `watchdog.ts`：子阶段预算与总预算判定

`EventWatchdog.tick()`（`src/runtime/watchdog.ts:47-73`）以 1Hz 轮询 `state.armedTimers`：

- `timer==="total"` 时直接读 `state.deadlines.deadlineAt`（不经 `dueAtFor` 重算）
  （`watchdog.ts:57-58`）。
- `timer==="total_grace"` 时读 `state.deadlines.graceUntil`（`:59-60`）。
- 其它所有子阶段 timer 都调用 `dueAtFor(state.phase, state.diag, budget)` 现算
  （`:61`）。
- 到点即 `dispatch({kind:"deadline_fired", timer, reason})`（`:64-69`），进入状态机的
  `abort_grace` 相位。

### 4.4 `reaper.ts`：孤儿升级策略

`EscalatingReaper.reap()`（`src/runtime/reaper.ts:98-146`）严格按序执行且各自独立记账：

| 级别 | 动作                                            | 超时预算                                   |
| ---- | ----------------------------------------------- | ------------------------------------------ |
| L0   | `cancel.cancel("reap")`（同步取消信号）         | 无（同步）                                 |
| L1   | `handle.steer("wrap up now")`（请模型体面收尾） | `min(budget.steerMs, budget.abortGraceMs)` |
| L2   | `handle.requestAbort()`（强制中止 pi 会话）     | `budget.abortGraceMs`                      |
| L3   | `handle.dispose()`（释放会话资源）              | 同步，但异常被捕获降级为 `orphaned`        |
| L3p  | 遍历 `killableHandles` 逐个 `kill()`            | 同步                                       |

任一级别失败都不阻塞后续级别执行（`bounded()` 辅助函数用 `Promise.race` 语义的手写实现，
`reaper.ts:170-186`），最终把无法回收的资源登记进 `OrphanRegistry`（孤儿注册表，含
`byReason` 分类计数与滑动窗口计数 `countInWindow`，用于熔断判定，`reaper.ts:17-24`）。

### 4.5 宽限窗口、延长机制与"显式 timeout 硬上限"规则

设计文档：`docs/dev/timeout-notify/arch.md`（已实施，v2）。核心实现点：

- 宽限期不是新相位，而是 `RunDeadlines.graceUntil` 这个正交字段
  （`docs/dev/timeout-notify/arch.md` §3.1 决策，D-1）——`abort_grace`（停机宽限，已有概念）
  与 `total_grace`（续跑宽限，本特性新增）是两个完全不同的东西，命名刻意区分。
- 判定"是否有资格进宽限/被延长"的唯一函数是 `extendability()`（`src/core/deadline.ts`，
  文档 §3.3 给出的完整实现），其中：
  ```
  if (!OVERTIME_PHASES.includes(state.phase)) return { ok:false, reason:"not_started" };
  if ((state.diag.overtime?.extensions ?? 0) >= budget.maxExtensions) return {ok:false, reason:"limit_reached"};
  const headroom = hardDeadlineAt - Math.max(now, deadlineAt);
  if (headroom <= 0) return { ok:false, reason:"no_headroom" };  // 含显式 timeout run 恒落此处
  ```
- `extend_subagent_timeout` 工具：`src/tools/extend-timeout-tool.ts:132-136`
  （`name:"extend_subagent_timeout"`），参数为增量秒数 `extend_s`（而非绝对值），由
  `arch.md` D-5 决策解释理由（"再给它 10 分钟"是模型的自然表达，双参数是已知混淆源）。
- **"显式 `timeout_s` 是硬上限、不可延长"的落地位置**：
  - 工具描述层：`src/tools/agent-tool.ts:162-165`（`timeout_s` 参数文档原话："An explicit
    timeout is a hard cap: the run always settles within it — no grace window, no
    extension."）。
  - 实现层：`src/service/spawn-service.ts:404-407`：
    ```ts
    const budget = applyBudgetPolicy(mergeBudget(deps.budget, config.budgetOverride, req.budgetOverride), {
      explicitTotal: req.budgetOverride?.totalMs !== undefined, // D-10
      extensionsEnabled: deps.extensionsEnabled ?? true,
    });
    ```
    `applyBudgetPolicy`（`src/core/deadline.ts:106` 起）在 `explicitTotal===true` 时把
    `maxTotalFactor` 钳为 `1`，使 `hardDeadlineAt === deadlineAt`，`extendability()` 的
    `headroom` 恒为 `0`，恒落 `no_headroom` 分支——不需要额外的 if 分支去"禁止"，而是让
    通用判定函数在这种配置下自然算出零余量，逻辑单一入口、无绕过路径。
- 宽限窗口本身也被硬天花板夹住（`graceUntil = min(at + totalGraceMs, hardDeadlineAt)`，
  `arch.md` D-7），保证 zero-hang 上界与今天同构：`H + abortGraceMs + reapMs`。

### 4.6 `session-driver.ts` 如何把模型错误映射成 `failed(model)`

`PiSessionHandle.getTurnError()`（`src/runtime/session-driver.ts:230-236`）：

```ts
getTurnError(): string | undefined {
  for (let i = this.session.messages.length - 1; i >= 0; i--) {
    const m = this.session.messages[i] as { role?: string; stopReason?: string; errorMessage?: string };
    if (m?.role === "assistant")
      return m.stopReason === "error" ? (m.errorMessage ?? "unknown model error") : undefined;
  }
  return undefined;
}
```

背景注释（`session-driver.ts:227-229`）：pi 的 `session.prompt()` 即使最后一轮 `stopReason`
是 `"error"` 也会正常 resolve（不抛异常），如果不主动检查会把"provider 崩溃"误判成"成功但
输出为空"。`runner.ts:549-559` 消费这个值：

```ts
const turnError = prompted.ok ? handle.getTurnError?.() : undefined;
dispatch({
  kind: "prompt_settled",
  ...(prompted.ok
    ? turnError === undefined ? {} : { error: error(turnError, "model") }
    : ...),
});
```

即：`prompt()` 正常返回但最后一条助手消息 `stopReason==="error"` ⇒ 状态机收到
`error(turnError, "model")`，最终 run 状态归类为 `failed(model)`（区别于 `failed(timeout)`/
`failed(aborted)`/`failed(internal)`）。**这一步发生在 Layer 2 的 `retryAssistantCall` 已经
用尽重试预算、把最终失败结果返回给 `session.prompt()` 调用方之后**——也就是说，pi-toolkit
看到的 `failed(model)` 是 pi 内部两层重试（provider 级 + turn 级）都已经失败退出后的结果，
中间的重试过程对 pi-toolkit 不可见（只有 turn 级重试会通过 `auto_retry_start`/`auto_retry_end`
事件间接可见，见第 5 层）。

### 4.7 run 级超时与 provider 级重试的叠加关系（关键判断）

**结论：会出现"provider 还在退避重试，run 的 deadline 先到"的情形，且这条路径对 provider 级
重试完全不可见。**

论证链：

1. Provider 级重试（Layer 1）发生在 pi-ai 内部，一次退避等待最长可达 `maxRetryDelayMs`
   （默认 60s，`provider-retry.js:1`），且如果 `maxRetries` 被 settings 配置为大于 0 的值，
   多次重试可以累计到分钟级（例如 3 次重试各等 60s 上限 = 3 分钟叠加）。
2. 从 pi-toolkit 状态机的视角看，这整个过程仍然处于 `model_turn` 相位（Layer 1 重试完全在
   `session.prompt()` 这一次调用内部完成，不会产生任何 `auto_retry_start`/`turn_end` 之类的
   中间事件），因此它只受 `model_turn` 双重约束的保护：`idleMs`（4min 静默超时，
   `DEFAULT_BUDGET.idleMs`）与 `modelTurnMs`（15min 硬上限）。
3. 若 provider 重试期间连接层完全静默（没有任何 SSE delta 产出，因为请求还没成功建立），
   `diag.lastEventAt` 不会被更新，`idleDueAt` 会用 `phaseEnteredAt`（或上一次事件时间）
   计算——**这个公式（`src/core/deadline.ts:82-84`）只在 `retry_backoff` 相位时才会加上
   `diag.retry?.delayMs`，而 provider 级重试根本不会让状态机进入 `retry_backoff` 相位**
   （那是 Layer 2 turn 级重试专属的相位转换，见 `state-machine.ts:736-745`）。因此 provider
   级重试的等待时长**完全叠加进 `model_turn` 相位的静默计时器**，没有任何"这是计划内等待"的
   豁免。
4. 结论：如果 provider 重试的累计退避时长超过 `idleMs`（默认 4 分钟），pi-toolkit 的 watchdog
   会在 provider 还在等待重试时就先判定"静默超时"，触发 `deadline_fired{idle}` →
   `abort_grace` → cancel。这会中断一个"本来很快就能重试成功"的请求，把它变成
   `timed_out`——**这是一个真实存在、有代码路径支撑的叠加冲突，而不是理论推测**：`idleMs`
   默认 240s，`maxRetryDelayMs` 默认 60s 但可被 settings 调大，且 `maxRetries` 次数不受
   run 级预算感知，两者之间**没有任何协调机制**。
5. 反向情形（run 级总预算 `totalMs` 先到）：即使 provider 重试正在等待退避，`total` 相位
   到点后走宽限逻辑（若为默认预算 run）而非直接杀死，因此总预算层面有缓冲；但**子阶段预算
   （`idleMs`/`modelTurnMs`）没有这层缓冲**，会直接判定超时。

### 第 4 层默认值/阈值表

| 项                                    | 默认值                             | 备注                                |
| ------------------------------------- | ---------------------------------- | ----------------------------------- |
| `idleMs`（静默超时，`model_turn`）    | 240_000ms                          | provider 重试的等待时长完整计入     |
| `modelTurnMs`（单轮硬上限）           | 900_000ms                          | 同上                                |
| `totalMs`（run 软截止）               | 1_800_000ms                        | 默认预算 run 到点进宽限而非直接杀   |
| `totalGraceMs`（续跑宽限）            | 90_000ms                           | 仅默认预算 run 享有                 |
| `maxExtensions`                       | 3                                  | 每次 `extend_s` 秒                  |
| `maxTotalFactor`（硬天花板倍数）      | 2（显式 timeout run 被钳为 1）     | `hardDeadlineAt = totalMs * factor` |
| `retrySlackMs`（turn 级重试兜底余量） | 5_000ms                            | 只覆盖 Layer 2                      |
| provider 级重试对 run 预算的可见性    | **不可见**（无相位/无 timer 标记） | 见 §4.7                             |

---

## 第 5 层：重试在 UI 上的呈现

`fleet-panel.ts:172-173`：

```ts
case "retry_backoff":
  return diag?.retry ? `♻重试${diag.retry.attempt}/${diag.retry.maxAttempts}` : "♻重试";
```

`diag.retry` 类型定义：`src/core/types.ts:391`
（`retry?: { attempt: number; maxAttempts: number; delayMs: Millis; startedAt: Millis }`）。

写入路径（状态机）：`src/core/state-machine.ts:736-745`：

```ts
if (e.t === "retry_start")
  return enter(..., "retry_backoff", ..., { retry: { attempt: e.attempt, maxAttempts: e.maxAttempts, delayMs: e.delayMs, startedAt: input.at } });
if (e.t === "retry_end" && state.phase === "retry_backoff") {
  const nextDiag = { ...state.diag, ...base };
  delete nextDiag.retry;
  return enter(..., "model_turn", ...);
}
```

`retry_start`/`retry_end` 事件的来源：`src/runtime/session-driver.ts:154-161`（`mapEvent`
函数）：

```ts
if (t === "auto_retry_start")
  return {
    t: "retry_start",
    attempt: Number(e.attempt),
    maxAttempts: Number(e.maxAttempts),
    delayMs: Number(e.delayMs),
  };
if (t === "auto_retry_end") return { t: "retry_end", success: Boolean(e.success) };
```

**结论：`diag.retry` 是 pi-toolkit 自己状态机的字段，唯一数据来源是 pi 的
`auto_retry_start`/`auto_retry_end` 事件——这两个事件正是第 2 层 `retryAssistantCall` 的
`onRetryScheduled`/`onRetryFinished` 回调对外发出的信号（turn 级重试，Layer 2）。**

**这个计数与第 1 层的 provider HTTP 重试不是同一回事**：Layer 1 的 `retryProviderRequest`
在 pi-ai 内部完成，不发出任何可被 pi-coding-agent 或 pi-toolkit 观测到的事件——一次 provider
级重试对 UI 完全静默，`♻重试N/M` 不会因为 provider 正在做 HTTP 重试而出现或递增。用户看到的
`♻重试` 只反映"pi 判定整轮 assistant 消息失败、正在重放整个请求"，而不反映"这次请求内部
底层做了几次 HTTP 重连"。

### 第 5 层默认值/阈值表

| 项                             | 值                                                                   | 来源                        |
| ------------------------------ | -------------------------------------------------------------------- | --------------------------- |
| `diag.retry` 数据源            | pi `auto_retry_start`/`auto_retry_end` 事件（= Layer 2 turn 级重试） | `session-driver.ts:154-161` |
| 是否反映 Layer 1 provider 重试 | 否，完全不可见                                                       | 结构性结论（无对应事件）    |
| UI 展示相位                    | `retry_backoff`（`fleet-panel.ts:172-173`）                          | —                           |

---

## 第 6 层：本仓库其它子系统的重试策略对比

### 6.1 `src/web-search/resilience.ts`：经典重试 + failover

- `MAX_ATTEMPTS = 3`（1 次初始 + 2 次重试），`REQUEST_TIMEOUT_MS = 15_000`
  （`src/web-search/resilience.ts:6-7`）。
- 可重试判定 `isRetryableError`（`:24-40`）：显式排除 `401/403`（认证问题重试无意义）；
  `429` 需进一步排除配额耗尽文案（`QUOTA_EXHAUSTION_PATTERN`）才算可重试；其余走
  `RETRYABLE_HTTP_STATUSES = {408,425,429,500,502,503,504}` 白名单；无状态码时退化为对
  错误消息做网络类关键词匹配。
- 退避公式 `backoffDelay`（`:59-62`）：`500 * 2^(attempt-1) + random()*200`（纯正抖动，只加不减，
  与第 1 层"抖动只减不增"的方向相反）。
- 每次请求都有独立的 `withRequestTimeout`（`:65-84`）包一层 `AbortController`，且所有定时器
  都显式 `unref()`（AGENTS.md 的"ref'd timers 会卡住 print mode"纪律在这里被遵守）。
- **provider 间切换（failover）**：本次调研在 `resilience.ts` 内**未找到** failover 逻辑本身
  （该文件只提供"重试/超时/脱敏"原语），failover 的编排逻辑应在调用 `resilience.ts` 的上层
  （工具主文件）——**本次调研未展开读该文件，如需要补充需另行审阅 `src/web-search/` 除
  `resilience.ts` 外的文件**。

### 6.2 `src/cache-ttl/ping-client.ts`：故意不重试

`sendKeepalivePing`（`src/cache-ttl/ping-client.ts`）本身没有任何重试循环——每次调用只发一次
裸 POST，失败就返回分类结果（`PingOutcome` 的 7 种取值之一），从不在内部重试。设计依据见
`docs/dev/cache-ttl-keepalive/plan.md:119`（不变量 I-K4 原文）：

> "ping + 释放 reader/listener；`/reload` 不残留；ping 失败静默、不重试、不阻塞 pi 任何流程。"

以及会话级熔断不变量 I-K7（`plan.md` 术语表附近）：

> "会话级 breaker 由 `unproven` 计数驱动，**不因真实请求重置**；`provenWrite ≥ 1` 或
> `consecutiveUnproven ≥ 2` 或 `unprovenTotal ≥ 3` ⇒ 整会话永久停用。"

**为什么不重试（推导自代码 + 设计不变量，而非直接声明的一句话理由）**：

1. 这是一个**旁路探测请求**，不是用户真正等待结果的主链路请求——它的唯一目的是"用一次极小
   payload（`max_tokens:1`）确认缓存前缀还活着"，探测本身失败不影响任何用户可见功能，重试
   带来的唯一收益是"多一次机会证明缓存还活着"，但代价是可能产生**它本身正是想规避的**
   缓存写入副作用（`I-K1`：宁可不 ping，绝不因前缀不匹配触发全量写）。
2. 更关键的是：`ping-client.ts` 的 `sendKeepalivePing` 结果分类里专门区分了
   `"accepted-then-lost"`（HTTP 200 已接受但流未见 `message_start` 就断开）——这正是"如果
   在这个状态下重试，可能会撞上刚才那次请求已经在服务端悄悄写入了缓存"的场景。设计选择是把
   这种不确定性状态**保守地计入 `unproven`**（等同失败），而不是重试去"确认"，因为重试本身
   在这个特定场景下**无法证明**上一次探测是否已经写入——重试成功只能证明"现在"缓存是活的，
   证明不了"探测请求"这个动作本身有没有额外副作用。
3. 会话级熔断（I-K7）用**跨窗口累计计数**（而不是单次请求内重试）来处理"探测持续失败"的
   情形：连续 2 次或累计 3 次 unproven 就永久停用整个会话的保活功能，这是"用更高层的熔断
   代替单次请求内重试"的设计选择。

### 6.3 三者与第 1 层的差异小结

| 维度     | Layer 1（provider HTTP 重试）         | `web-search/resilience.ts`         | `cache-ttl/ping-client.ts`                                                             |
| -------- | ------------------------------------- | ---------------------------------- | -------------------------------------------------------------------------------------- |
| 是否重试 | 默认不重试（需 settings 开启）        | 是，最多 2 次                      | **从不**（代码里没有重试循环）                                                         |
| 判定依据 | HTTP 状态码 + `x-should-retry` 响应头 | HTTP 状态码白名单 + 文案排除       | 不适用                                                                                 |
| 退避方向 | 抖动只减不增（更快）                  | 抖动只加不减（更慢）               | 不适用                                                                                 |
| 失败后果 | 冒泡给 Layer 2 决定是否整轮重放       | 耗尽后向上抛错，交给工具调用方处理 | 静默计入 `unproven`，触发会话级熔断                                                    |
| 设计取向 | "让用户的主请求尽量成功"              | 同左（搜索是主链路功能）           | "宁可不做，绝不制造副作用"——**非必要旁路请求，重试的期望收益不能覆盖它可能带来的成本** |

---

## 额外必答问题

### 问题 1：重试与提示词缓存的相互作用

1. **计费/缓存重复写入风险**：
   - Layer 1（provider 级）重试重放的是**完全相同的请求闭包**（`retryProviderRequest` 的
     `request` 参数是同一个 `() => client.messages.create(...)` 闭包，`sessionId`/`params`/
     `cache_control` 块逐字节不变，`anthropic-messages.js:382` 的调用点位于 `params` 构造
     之后）。若上一次尝试**在服务端已经处理到写缓存的阶段就断连**（客户端拿不到响应但服务端
     已完成缓存写入——这正是 §6.2 提到的 `"accepted-then-lost"` 场景在真实主请求上的对应
     情形），紧随其后的重试会命中刚写入的缓存，**表现为一次 write + 一次 cheap read**，
     而不是两次 write。但如果上一次尝试**在服务端写缓存完成前**就失败（例如网络层直接拒绝
     连接，请求根本没有到达 provider），则重试是"从零开始"的一次正常请求，只会产生一次
     正常的 write（不重复）。
   - **本次调研未找到**任何证据表明 pi-ai/pi-coding-agent 会在重试时**主动**改变 payload
     使其"看起来像新前缀"（例如改变 `cache_control` 断点位置）——重试请求与原始请求在
     `retryProviderRequest` 层面是完全同一个闭包，因此**不存在"重试导致同一前缀被人为地
     多次重复写入"的路径**；唯一的重复写入场景是"服务端确实在两次独立的物理请求里都完整
     处理了一遍"，这只会发生在"上一次尝试的响应完全没有被服务端处理"（真正的网络中断，
     无 accepted-then-lost）这种情况下，此时是两次**独立**的正常请求，谈不上"重复"写入
     同一逻辑请求。
   - Layer 2（turn 级）整轮重放同理：`produce()` 闭包每次调用都重新走一遍
     `session.prompt()`，请求 payload（含历史消息 + `cache_control`）逐字节相同（因为
     是重放同一轮，不是追加新一轮）；风险模式与 Layer 1 一致。

2. **429 长退避后缓存条目是否已过期**：**是，这是一个真实存在的风险，有量化证据支撑**。
   - Anthropic 的 ephemeral 缓存 TTL 是 5 分钟量级（本仓库 `cache-ttl-keepalive` 功能的
     `aliveUntil = lastReadStartedAt + 300s` 正是针对这个 TTL 设计的保活机制，
     `docs/dev/cache-ttl-keepalive/plan.md` 术语表）。
   - Layer 1 的 `maxRetryDelayMs` 默认上限是 60 秒（`provider-retry.js:1`），单次 429 退避
     不会超过这个值（除非被设置放宽或 `retry-after` 头本身给出更小值），**单次**退避通常
     不足以让 5 分钟 TTL 过期。但如果 `maxRetries` 被配置为大于 1（默认关闭，见 §1.2），
     多次 429 退避可以累计——例如 3 次都撞到 60 秒上限，累计 180 秒，仍在 5 分钟以内，但
     已经消耗了 TTL 剩余窗口的相当比例；若期间还叠加 Layer 2 的 turn 级退避
     （`baseDelayMs * 2^(attempt-1)`，默认 `baseDelayMs=2000ms`，3 次共 `2+4+8=14s`，
     量级较小），**理论上存在总退避时长接近或超过 5 分钟 TTL 窗口的组合**，此时重试真正
     发出时，原本命中的缓存条目**可能已经过期**，重试请求会被迫重新支付一次 cache write
     （1.25×/2× 成本），而不是命中缓存。
   - 与 `cache-ttl-keepalive` 保活机制的交互点（**本次调研未找到直接证据，是一个开放问题**）：
     `docs/dev/cache-ttl-keepalive/plan.md` 定义的"武装（armed）"状态列出的四种触发原因是
     "后台 subagent / 后台 bash / 前台工具阻塞 / ui_prompt 阻塞"（`plan.md` 术语表），**未
     列出**"本会话自身的模型调用正处于 provider 级或 turn 级重试退避中"这一种情形。也就是说，
     如果一次请求恰好卡在 provider 级重试退避里超过若干分钟，**当前保活机制的"武装"条件
     列表里没有覆盖这种场景**，如果退避时长足够长，缓存可能在无人保活的情况下真的过期
     ——这是本文档能给出的最接近的结论，具体是否触发需要更细致地读 `src/cache-ttl/cache-ttl.ts`
     的"armed"信号来源代码来确认，本次调研未展开到那一步。

### 问题 2：缺口清单（按严重度排序，以"零悬挂"为标准）

1. **【严重】provider 级重试的等待时长对 run 级子阶段预算完全不可见，可能导致"本可成功的
   请求被 run 超时误杀"，或反过来"provider 退避期间 run 的静默计时器在正常累加而没有任何
   豁免"**（见 §4.7）。证据：`retry_backoff` 相位的 `idleDueAt` 加成
   （`src/core/deadline.ts:82-84`）只对 Layer 2（turn 级重试）生效，Layer 1（provider 级）
   重试完全在 `model_turn` 相位内部发生，没有对应的 timer 分支或诊断字段区分"这段静默是
   provider 正在退避重试"还是"provider 真的卡死了"。影响：`idleMs` 默认 240s，若用户把
   `settings.retry.provider.maxRetries` 调大（该字段确实存在且可被设置，见 §1.2），累计
   provider 级退避完全可能超过 240s 静默阈值，导致一个"本来很快就会重试成功"的请求被
   pi 的 watchdog 提前判定超时中断——这既不是"零悬挂"想要防止的悬挂，也不是用户期望的行为，
   是**该省的等待没等，不该杀的杀了**。反向风险同样存在：若 provider 退避+turn 级退避
   组合被判定为"计划内"从而豁免 idle 检测，一旦 Layer 2 的 `retry_end` 事件因为某种异常
   （pi 内部 bug 或崩溃）永远不发出，`diag.retry` 会一直挂着，`idleDueAt` 里的
   `diag.retry?.delayMs` 项固定不变，静默计时器基准点仍然会正常推进（因为公式用的是
   `lastEventAt`/`phaseEnteredAt` 而非 `retry.startedAt`），**本次调研未找到**这种"retry_end
   丢失"场景的专门兜底测试，只在 `state-machine.ts:865` 注释里提到"pi 自动重试一旦卡住
   （backoff 结束后迟迟不来 retry_end），run 会无界地挂到总预算"——这说明设计者已经意识到
   这是一个已知的、未被子阶段预算完全覆盖的盲区，只能兜底到总预算层面（30 分钟量级），
   而不是更紧的 idle 层面（4 分钟量级）。

2. **【较严重】Layer 1 与 Layer 2 的"可重试错误"分类口径完全独立、互不复用，存在错误分类
   过粗/过细的双向风险**（见 §2.3）。证据：Layer 1 用结构化的 HTTP 状态码集合
   `{408,409,429,5xx}` + `x-should-retry` 响应头（`provider-retry.js:15-18`），Layer 2 用
   约 30 条自由文本正则（`utils/retry.js` 的 `RETRYABLE_PROVIDER_ERROR_PATTERN`）。二者
   没有共享的真值来源，可能出现：Layer 1 认为某个 `409` 可重试并已经在内部悄悄重试过，
   而如果这次内部重试最终仍失败、把错误文本冒泡给 Layer 2，Layer 2 的正则表里**没有**
   `409` 相关词条（正则表以 `overloaded`/`rate.?limit`/`5xx` 等语义化文案为主），可能导致
   一个"结构上可重试"的错误在文本层面因为 provider 返回的错误文案措辞不巧没有命中任何
   已知正则，从而在 Layer 2 被误判为不可重试直接失败——这是"错误分类过粗导致不该放弃重试
   的放弃了"的具体案例。反向地，`billing`/`quota` 类文案能被两层分别拦截（Layer 1 层面
   429 状态码会被判定可重试，但 Layer 2 的 `NON_RETRYABLE_PROVIDER_LIMIT_ERROR_PATTERN`
   会在文本层面正确拦下——这条路径本身工作正常，但依赖两层判断**恰好**给出一致结论，
   没有代码层面的强制保证）。

3. **【中等】pi-toolkit 完全不感知、不配置 provider 级重试参数
   （`settings.retry.provider.*`），运维盲区**。证据：`grep -rn
"getRetrySettings|getProviderRetrySettings|settings\.retry" src/` 零命中（已实际执行
   确认）。影响：当排查"某个 run 为什么在没有触发任何子阶段超时的情况下就是很慢"这类问题时，
   pi-toolkit 的诊断工具（`/agent status`、`diag.retry` UI 展示，见第 5 层）**看不到** provider
   级重试正在发生，用户/运维只能看到"model_turn 相位持续了很久"，无法区分"provider 正在
   静默重试"还是"provider 真的在慢慢生成"还是"网络卡住了但还没到 idle 阈值"。这不是一个
   悬挂风险，但是一个**用户不可见的静默重试**的具体案例（缺口清单要求里提到的"用户不可见的
   静默重试"这一类，此处是 Layer 1 对整个 pi-toolkit 诊断体系不可见）。

4. **【中等，开放问题】`cache-ttl-keepalive` 的"武装（armed）"条件列表未明确覆盖"本会话
   请求正处于 provider/turn 级重试退避中"这一场景**（见问题 1 第 2 点）。这不是一个
   悬挂风险，而是一个**成本风险**：如果长退避导致缓存 TTL 过期而保活机制未介入，用户会
   为一次重试多付一次全量 cache write 成本，且这个成本对用户不可见（重试本身是静默的，
   多付的缓存写入费用也不会被特别标注为"因重试退避导致"）。本次调研未深入
   `src/cache-ttl/cache-ttl.ts` 确认"armed"信号的完整触发列表，若要坐实此结论需要
   补充调研。

5. **【轻微，纪律但非悬挂风险】Layer 1 的重试指数退避封顶（8 秒，`provider-retry.js:37-38`）
   与 `web-search/resilience.ts` 的退避封顶（无显式上限，但 `500*2^(attempt-1)`，2 次重试
   下最大约 2 秒 + 抖动）在数值上没有统一的设计依据来源，两套系统各自独立选择了退避参数，
   若后续需要统一"重试节奏"体验（例如让所有子系统的重试对总 run 预算的占用比例一致），
   目前没有共享的退避参数配置层。这不影响 zero-hang，只是工程一致性问题。

---

## 跨层时序示意：一次请求从发出到失败到重试到 run 超时的全链路

```
run 状态机相位:  prompt_dispatch ─────────► model_turn ──────────────────────────────────────► ...
                      │                         │
pi-ai 内部     [发起 HTTP 请求]          [Layer 1: retryProviderRequest 包裹的一次 request() 闭包]
(不可见于        │                         │
 run 状态机)     │                    ┌────┴────────────────────────────────┐
                 │                    │  连接失败/5xx/429（命中重试判定）      │
                 │                    │  → getRetryDelayMs() 计算退避         │
                 │                    │  → abortableSleep(delay, signal)     │  ← 这段等待完全叠加进
                 │                    │  → 重试（maxRetries 次，默认 0 次）   │     model_turn 相位的
                 │                    └────┬────────────────────────────────┘     idleMs/modelTurnMs
                 │                         │                                       静默计时（§4.7）
                 │                    重试耗尽 or 拿到响应流
                 │                         │
                 │                    进入 SSE 流读取（真正开始产出 delta）
                 │                         │
                 │                    ┌────┴─────────────────────┐
                 │                    │ 流中途断开/报错             │
                 │                    │ stopReason = signal.aborted│
                 │                    │   ? "aborted" : "error"    │  ← 第 2 层判定（§2.1）
                 │                    └────┬─────────────────────┘
                 │                         │
                 │              stopReason==="error" 且非 overflow
                 │                         │
                 │         ┌───────────────┴────────────────────────┐
                 │         │  Layer 2: retryAssistantCall()          │
run 状态机相位:  │         │  isRetryableAssistantError() 判定       │
                 │         │  可重试 → retry_start 事件 ──────────► retry_backoff 相位
                 │         │           （diag.retry 写入，UI 显示    │  （fleet-panel ♻重试N/M）
                 │         │            ♻重试N/M，§第5层）           │
                 │         │  → baseDelayMs*2^(attempt-1) 退避后     │  idleDueAt = lastEventAt
                 │         │    重新调用 produce()（回到最上面）      │  + idleMs + retry.delayMs
                 │         │  不可重试/预算耗尽 → 返回最终错误消息    │  + retrySlackMs（有豁免）
                 │         └───────────────┬────────────────────────┘
                 │                         │
                 │              retry_end 事件 → 回到 model_turn 相位
                 │                         │
                 │              最终 stopReason==="error" 冒泡出 session.prompt()
                 │                         │
run 状态机:      │              session-driver.getTurnError() 检测到
                 │              → runner.ts dispatch prompt_settled{error("model")}
                 │                         │
                 │              状态机 finish() → run 状态 = failed(model)
                 │
                 │
【并行的另一条线】watchdog.tick() 每 1s 扫描 armedTimers：
   - 子阶段（idle/modelTurn/tool/…）到点 → deadline_fired → abort_grace → 杀
     （不管 provider/turn 重试是否正在进行，见 §4.7 缺口 1）
   - 总预算 total 到点：
       默认预算 run → 进 total_grace 宽限（90s）→ 通知主会话 → 可被 extend_subagent_timeout 延长
       显式 timeout run → 无宽限，直接 abort_grace → 杀
   - total_grace 到点仍未获救 → abort_grace → timed_out
   - abort_grace 到点 → reaper.reap() 走 L0→L1→L2→L3→L3p 逐级升级，兜底 zero-hang
```

---

## 附：本文档使用的关键文件清单

| 文件                                                                                | 层次     | 作用                                                               |
| ----------------------------------------------------------------------------------- | -------- | ------------------------------------------------------------------ |
| `node_modules/@earendil-works/pi-ai/dist/utils/provider-retry.js`                   | L1       | provider HTTP 重试实现（未压缩，逐行可读）                         |
| `node_modules/@earendil-works/pi-ai/dist/api/anthropic-messages.js`                 | L1/L2    | Anthropic 流式实现、stopReason 判定                                |
| `node_modules/@earendil-works/pi-ai/dist/api/openai-completions.js`                 | L1/L2    | OpenAI 流式实现、stopReason 判定                                   |
| `node_modules/@earendil-works/pi-ai/dist/utils/retry.js`                            | L2       | turn 级重试（`retryAssistantCall`）、可重试分类正则                |
| `node_modules/@earendil-works/pi-ai/dist/utils/overflow.js`                         | L3       | 溢出/截断检测                                                      |
| `node_modules/@earendil-works/pi-ai/dist/models.js`                                 | L1       | `completeSimple`/`streamSimple` 关系                               |
| `node_modules/@earendil-works/pi-coding-agent/dist/bundle/chunks/chunk-OMWWHBTG.js` | L1/L3    | 压缩产物，settings 默认值、溢出重放逻辑（字符串锚点定位）          |
| `node_modules/@earendil-works/pi-coding-agent/dist/core/extensions/types.d.ts`      | L3       | `SessionBeforeCompactEvent` 等类型定义                             |
| `src/core/deadline.ts`                                                              | L4       | `DEFAULT_BUDGET`、`dueAtFor`、`extendability`、`applyBudgetPolicy` |
| `src/core/state-machine.ts`                                                         | L4/L5    | `retry_start`/`retry_end` 转换、相位集合                           |
| `src/core/types.ts`                                                                 | L4/L5    | `DeadlineBudget`/`RunDiagnostics.retry`/`overtime` 类型            |
| `src/runtime/watchdog.ts`                                                           | L4       | 1Hz 扫描、`deadline_fired` 派发                                    |
| `src/runtime/reaper.ts`                                                             | L4       | L0-L3p 逐级升级回收                                                |
| `src/runtime/session-driver.ts`                                                     | L4/L5    | `mapEvent`（pi 事件→内部事件）、`getTurnError`                     |
| `src/runtime/runner.ts`                                                             | L4       | `failed(model)` 映射位置                                           |
| `src/tools/agent-tool.ts`                                                           | L4       | `timeout_s` 参数文档                                               |
| `src/tools/extend-timeout-tool.ts`                                                  | L4       | `extend_subagent_timeout` 工具                                     |
| `src/service/spawn-service.ts`                                                      | L4       | `applyBudgetPolicy` 调用点（硬顶判定）                             |
| `src/ui/fleet-panel.ts`                                                             | L5       | `♻重试N/M` 展示                                                    |
| `src/web-search/resilience.ts`                                                      | L6       | 重试/退避原语                                                      |
| `src/cache-ttl/ping-client.ts`                                                      | L6       | 故意不重试的探测请求                                               |
| `docs/dev/timeout-notify/arch.md`                                                   | L4       | 宽限/延长/硬顶设计文档                                             |
| `docs/dev/cache-ttl-keepalive/plan.md`                                              | L6/问题1 | 保活不变量、TTL 术语                                               |
