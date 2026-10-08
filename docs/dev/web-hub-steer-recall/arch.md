# web-hub 插话撤回（steer / followUp recall）— 架构设计 v1

> 范围：只做设计，不改代码。车道建议 L2（agent 侧新增一个模块 + 协议追加 + UI 小改；pi 时序已经实测确认，见 §2.3）。
> 上游：Explore run `r_H4CXT8Y6`（坐标），控制面 `docs/dev/web-hub/control-plan.md`（§3.4 幂等、§4.3 prompt 生命周期、§4.4 队列镜像、§4.5 台账）。
> 证据基线：pi `@earendil-works/pi-coding-agent` 1.0.2（全局安装与仓库 devDependency 同版本），`pi-agent-core` 1.0.2。

---

## 0. 结论先行（回答「中心问题」）

**交接点：agent 侧 `turn_end` 扩展 handler。pi 会在轮询队列之前 await 这个 handler，所以在这里交接没有额外延迟，可以严格证明。**

- pi 的 `turn_end` 扩展事件并不是 agent-loop 里 `emit({type:"turn_end"})` 的异步回声。它由 `AgentSession._installAgentBoundaryHooks` 装进 `agent.finishTurn`（`agent-session.js:510-519`），agent-loop 在 `:179` 执行 `await config.finishTurn(...)`，而 `getSteeringMessages()` 的轮询排在后面的 `:186`。`emitBoundary` 会逐个 await 每个 handler，且**没有超时**（`extensions/runner.js:759-800`）。
- 所以在 `turn_end` handler 里调用 `pi.sendUserMessage(text,{deliverAs})`，再等它入队完成（我们自己的 `input` 观测器看到它，再过一个 `setImmediate`），消息就会落进**本轮结束时的同一次轮询**。网页消息如果当时立即发出，也是在这次轮询被取走（运行中的轮次里，下一个取队点就是 `:186`）。**实测 E1 / E5 结果一致**（§2.3）。
- **何时开始扣留（arm）**：从**本轮最后一次取队之后**开始，也就是扩展 `context` 事件（`streamAssistantResponse` 内 `transformContext`，`agent-loop.js:263-264` → `sdk.js:266-270` → `runner.js:1006`）。这个点在 `:85`（首轮）和 `:111`（后续轮）的轮询都已结束之后。**不能用 `turn_start`**：首轮的 `turn_start`（`agent-loop.js:51`）早于 `:85` 轮询，实测 E9 显示此时入队的消息会进入本轮请求，在这里扣留会多等一轮。
- 未 arm 的窗口（`turn_end` 交接之后、下一个 `context` 之前，包括 prepareNextTurn 里的自动压缩和重试退避）里收到的消息**立即交给 pi**，和原生时序完全一样，只是这一小段时间不能撤回。
- followUp：只在「会停下的轮次」（assistant 没有 toolCall、本批没有 steer、`!ctx.hasPendingMessages()`）的 `turn_end` 交接，由 `:192` 取走，零额外轮次（E2）。预测失误时由 `agent_end` 兜底：`agent_end` 也在 loop 内被 await，`_handlePostAgentRun` 见到 `hasQueuedMessages()` 后会在同一个 run 内 `continue()`（`agent-session.js:1412-1414`，实测 E3）。代价是多一对 `agent_end`/`agent_start`，**不多一次 LLM 调用**。
- 残余延迟只在两种退化情况出现：①排在我们之后的第三方 `input` handler 耗时超过交接预算（实测 E4）；②pi 因找不到 assistant entryId 跳过了 turn_end boundary（`agent-session.js:478-487`）。两种都有界，且退化后的结果和「当时立即发出」的原生行为等价或只慢一个取队点，见 §2.4。

---

## 1. 背景与目标

### 1.1 问题

网页 composer 在 agent 忙时发出的消息（Enter = steer，Alt+Enter = followUp）现在会立刻调用 `pi.sendUserMessage(text,{deliverAs})`（`src/web-hub/agent/commands.ts:222`），进入 pi 的内部队列。pi 不提供逐条出队的接口：`AgentSession.clearQueue()` 是全清（`agent-session.js:1846-1855`），扩展也拿不到它（`ExtensionContext` 只有 `hasPendingMessages(): boolean`，`types.d.ts:244`）。所以消息一旦进了 pi 队列，就不可能真正撤回。

### 1.2 用户裁定（约束，不再讨论）

网页来的 steer/followUp 先存进 **pi-toolkit 自己的 agent 侧缓冲**，等到 pi 下一个取队点之前才交给 pi（`pi.sendUserMessage` + `deliverAs`）。交接前可以真实地撤回或编辑，交接后不可撤回，UI 要明说。TUI 会话和 managed rpc 会话都要支持。

### 1.3 目标 / 非目标

- G1：交接不引入额外轮次延迟（§0 已证明）；退化情况有界，并写进文档。
- G2：撤回和交接之间严格只有一方胜出，`cmd_result` 如实报告。
- G3：零丢失。中止、会话切换、`/reload`、hub 重启、能力降级时，被扣留的消息要么被交接，要么变为「已退回」（可编辑、可重发），不会静默消失。pi 进程崩溃不可避免会丢失（和 pi 自身队列一样），由浏览器侧保留的原文兜底，见 §7。
- G4：每一次扣留都有上界（zero-hang），所有新增 await 都有 deadline，所有 timer 都 `unref`。
- G5：设置关闭，或任一端缺能力时，行为与现状**逐字节一致**。
- 非目标：撤回已交给 pi 的消息（做不到）；改写 TUI 自己的 steer 路径；`command` op（模板/技能走 prompt 路径的那支）的扣留；持久化扣留正文到磁盘（与 control-plan U10「条目不含请求正文」冲突，见 Q3）。

---

## 2. 现状与证据

### 2.1 本仓库现状（坐标）

| 位置                                                               | 作用                                                                                                                                              |
| ------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------- |
| `ui/src/components/control/Composer.vue:563-582`                   | doSend → emit send（忙时 placeholder :333-338）                                                                                                   |
| `ui/src/components/detail/DetailDock.vue:210-242`                  | onSend：斜杠 → command；`@label` 命中运行中子 agent → `steerSub`；否则 `expandFileRefs(text)` → `sendPrompt`（**发出的是展开后的正文**，见 §6.4） |
| `ui/src/composables/useControl.ts:99-108`                          | `sendPrompt`：`newCmdId()`，乐观项 `ctl_send`                                                                                                     |
| `ui/src/logic/control.js:88-111`                                   | `mergeQueue(serverQueue, optimistic, dropped)`                                                                                                    |
| `ui/src/components/control/QueueList.vue:83-157`                   | 行模型：队列中的行**没有任何操作按钮**                                                                                                            |
| `hub/http.ts:1680-1707`                                            | `parseCmdBody` 逐 op 白名单解析                                                                                                                   |
| `hub/commands.ts:27-29, 90-100`                                    | hub LRU 幂等（2048/10min）；`requiredCaps(op)`                                                                                                    |
| `hub/registry.ts:190-202`、`hub/http.ts:395-398`                   | 从 agent hello caps 推导 card 字段（`control/upload/...`）；`toCard` 白名单复制                                                                   |
| `agent/index.ts:686`                                               | `hubCaps: () => conn?.caps ?? []`（dialog.bg 降级同款）                                                                                           |
| `agent/index.ts:689-698`                                           | `onCmd` → `commandHandler.handle`                                                                                                                 |
| `agent/index.ts:902-960`                                           | `session_start` / `session_shutdown` → `onSessionBoundary()`                                                                                      |
| `agent/index.ts:975-981`                                           | `FORWARDED_EVENTS` 同步观测循环：`input` → `onInputEvent`，`message_start` → `onMessageStart`                                                     |
| `agent/index.ts:596`                                               | 1Hz `hasPendingMessages()` 采样 → `onPendingSample`                                                                                               |
| `agent/commands.ts:198-227`                                        | `handlePrompt`：台账 `dispatched` → `appendOrigin` → `registerObservation`（3s HTTP 等待）→ `sendUserMessage`                                     |
| `agent/commands.ts:486-521 / 523-549 / 550-560 / 568-578`          | `onInputEvent`（observed→queued，入镜像）/ `onMessageStart`（consumed）/ `onPendingSample`（dropped）/ `onSessionBoundary`（dropped(session)）    |
| `agent/ledger.ts:28-30, 93, 135-150, 160-165, 213-215`             | `PromptSubState` / 进程级 `Symbol.for` 台账 / `sweep` 淘汰「generic 终态」项 / `wireState` / 越过 observed 即删 `text`                            |
| `agent/queue-mirror.ts`（全文）                                    | **严格镜像 pi 的队列**；`clearIfEmpty` 依赖 `hasPendingMessages()`，1.5s 宽限                                                                     |
| `agent/origin-entry.ts`                                            | `subagent:web-origin` 条目，**不含正文**（U10）                                                                                                   |
| `protocol/messages.ts:103-110, 393-394, 423-430, 443-447, 521-548` | `QueueItemWire` / `CmdOp` / `CmdArgs` / `CmdData` / `CtlItemWire`                                                                                 |
| `protocol/messages.ts:770-780, 924-939, 1168-1176, 1341-1386`      | `QueueItemSchema`（严格）/ `StatusInfoSchema`（开放）/ `PromptArgsSchema`（严格）/ `CtlItemSchema`（严格，`state` 是封闭枚举）                    |
| `protocol/version.ts:19-40`                                        | `P2_AGENT_CAPS` / `P2_HUB_CAPS` / `DIALOG_BG_HUB_CAPS`（本设计照抄后者的模式）                                                                    |
| `src/mention/mention.ts:108-121`                                   | `@label` input 拦截器（async，可能 await 子 agent steer）                                                                                         |

**影响兼容性的事实**：hub 侧的 `CtlItemSchema.state`、`QueueItemSchema`、`PromptArgsSchema`、`CmdData` 校验都是封闭的。旧 hub 收到 `state:"held"` 会**整帧丢弃 ctl**（和 dialog.bg 当初的问题同类）。因此 agent 只有在 hub 声明能力时才启用扣留，不能只靠「新字段可选」来兼容。

### 2.2 pi 证据表（`$AC` = `pi-coding-agent/node_modules/@earendil-works/pi-agent-core/dist`，`$PI` = `pi-coding-agent/dist`）

| #   | 事实                                                                                                                                                                                              | 坐标                                                                                              |
| --- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------- |
| P1  | 首轮：`agent_start` → `turn_start` → 初始消息 message 事件 → `runLoop`；首次取 steer 在 `turn_start` **之后**                                                                                     | `$AC/agent-loop.js:50-56, 85`                                                                     |
| P2  | 后续轮：`prepareNextTurn`（可含自动压缩）→ 若上次没取到则再取 steer → `turn_start`                                                                                                                | `:93, :110-113`                                                                                   |
| P3  | 取到的消息在请求前推入上下文（`message_start/end` 发出，此后无法收回）                                                                                                                            | `:116-121`                                                                                        |
| P4  | `streamAssistantResponse` 先 `transformContext`（扩展 `context` 事件）再调模型                                                                                                                    | `:141`；`:263-264`；`$PI/core/sdk.js:266-270`；`$PI/core/extensions/runner.js:1006-1035`          |
| P5  | error/aborted 轮：`await finishTurn` → `turn_end` → `agent_end` → return（**不取队**）                                                                                                            | `:147-153`                                                                                        |
| P6  | 正常轮：`await finishTurn(:179)` → `await emit turn_end(:180)` → **`getSteeringMessages()`（:186）**                                                                                              | `:179-189`                                                                                        |
| P7  | 将要停下时才取 followUp                                                                                                                                                                           | `:191-197`                                                                                        |
| P8  | `Agent.processEvents` 按订阅顺序 **await** 每个 listener                                                                                                                                          | `$AC/agent.js:395-435`（:432-434）                                                                |
| P9  | `getSteeringMessages` / `getFollowUpMessages` = `steeringQueue.drain()` / `followUpQueue.drain()`                                                                                                 | `$AC/agent.js:331-338`                                                                            |
| P10 | `AgentSession` 订阅 agent，`_handleAgentEvent` 内 **await `_emitExtensionEvent`**                                                                                                                 | `$PI/core/agent-session.js:190, 696, 735`                                                         |
| P11 | **扩展 `turn_end` 由 `finishTurn` 钩子分发**（`_boundaryDispatchedMessages` 防止 `:882-884` 再发一次）                                                                                            | `agent-session.js:510-519, 881-885`                                                               |
| P12 | `_dispatchTurnEndBoundary`：没有 turn_end handler 或**找不到 assistant entryId** 时直接返回，**handler 不会被调用**                                                                               | `agent-session.js:475-500`（:478-487）                                                            |
| P13 | `emitBoundary` 逐 handler await，无超时；返回值 `entries/continue` 有语义（**我们必须返回 undefined**）                                                                                           | `runner.js:759-800`                                                                               |
| P14 | `prompt()`：只有**手动**压缩期间才抛错；先 await `_runInputHandlers`（streamingBehavior 按**调用时**的 `isStreaming` 决定），再按**返回后**的 `isStreaming` 决定入队还是开新 run；入队是同步 push | `agent-session.js:1481-1527`（:1499, :1502, :1515-1525）；`_queueSteer/_queueFollowUp :1696-1720` |
| P15 | `isStreaming = _isAgentRunActive`（覆盖整个 run 及 post-run continue，到 `agent_settled` 前才清）                                                                                                 | `:1034-1036`；`_emitAgentSettled :671-690`                                                        |
| P16 | 扩展 `pi.sendUserMessage` 返回 void，`.catch` → `emitError`（fire-and-forget）                                                                                                                    | `$PI/core/extensions/loader.js:306-309`；`agent-session.js:2676-2683`；`types.d.ts:1230-1233`     |
| P17 | `emitInput` 逐 handler await，`handled` 短路                                                                                                                                                      | `runner.js:1202-1235`                                                                             |
| P18 | agent_end 之后入队的消息会在同一个 `_runAgentPrompt` 内 `continue()`（「Messages queued by agent_end handlers require a fresh run before pre-settlement handlers fire」）                         | `agent-session.js:1344-1377, 1412-1414`                                                           |
| P19 | `queue_update` 只走内部 `_emit`，扩展收不到                                                                                                                                                       | `agent-session.js:642-648`                                                                        |
| P20 | 手动 `compact()` 先 `abort()` 再设 `_compactionAbortController`                                                                                                                                   | `agent-session.js:2132-2134`                                                                      |
| P21 | TUI 的 `ctx.abort()` 走 `abortHandler` → `restoreQueuedMessagesToEditor({abort:true})`（把 pi 队列全清回 TUI 编辑器）                                                                             | `$PI/modes/interactive/interactive-mode.js:1472-1474, 3827-3846`                                  |
| P22 | `ctx.signal`：当前 run 的 AbortSignal                                                                                                                                                             | `types.d.ts:239-240`                                                                              |
| P23 | 默认 `steeringMode = "one-at-a-time"`                                                                                                                                                             | `$PI/core/settings-manager.js:526-527`                                                            |
| P24 | turn_end 事件带 `outcome: "completed"                                                                                                                                                             | "aborted"                                                                                         | "error"`（取自 stopReason） | `types.d.ts:753-758`；`agent-session.js:476-477` |

### 2.3 实测（已运行，脚本保留在 `/tmp/steer-hold-exp/exp.mjs`、`exp2.mjs`）

真实 `createAgentSession` + 假 `modelRuntime.streamSimple`（脚本化 toolCall/text 轮次，构造方式同 `tests/conformance/pi-boundary.test.ts:117-160`）+ `extensionFactories` 注入探针扩展。每次 LLM 调用都记录请求里的 user 消息序列。

| 编号 | 场景                                                                         | 结果                                                                                                    | 结论                                                      |
| ---- | ---------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------- | --------------------------------------------------------- |
| E1   | turn_end#1 内 `sendUserMessage("HELD-STEER",{steer})` + `await setImmediate` | `input` 在 turn_end handler 内触发（`sb=steer`）；**LLM#2 = [P0, HELD-STEER]**                          | 交接落在同一取队点                                        |
| E1b  | 同上，**不 await**                                                           | 仍落在 LLM#2                                                                                            | 无慢 handler 时微任务链在 `:186` 前就跑完；await 只是保险 |
| E5   | 基线：tool 执行期间立即 `sendUserMessage`                                    | LLM#2 = [P0, IMM-STEER]                                                                                 | 与 E1 **完全相同** ⇒ 零额外延迟                           |
| E2   | 单轮停下；turn_end#1 内交 followUp                                           | LLM#2 带 HELD-FU；**只有一次 agent_end**                                                                | 停下轮交接 followUp 走 `:192`                             |
| E3   | 在 `agent_end` 内交 followUp                                                 | LLM#2 带 HELD-FU；agent_end×2，agent_settled×1                                                          | `agent_end` 兜底仍在同一 run                              |
| E4   | 我们之后有一个 50ms 的第三方 input handler；只等一个 tick                    | 错过本 run 所有取队点；run settle 后**作为新 prompt** 进 LLM#4（P14：push 前 `isStreaming` 已为 false） | 慢的下游 handler ⇒ 退化，但**不丢**                       |
| E6   | tool 执行中 `ctx.abort()`                                                    | 该 turn_end 的 `outcome=completed, stop=toolUse`，但 **`ctx.signal.aborted=true`**                      | 判断中止要看 `ctx.signal.aborted`，`outcome` 不够         |
| E7   | turn_end#1 依次交两条 steer                                                  | LLM#2 带 S1，LLM#3 带 S2                                                                                | one-at-a-time 语义与原生一致；FIFO 保持                   |
| E8   | 在 LLM#1 的 `context` handler 内原生入队                                     | 落在 LLM#2，没有进 LLM#1                                                                                | `context` 晚于本轮所有取队点 ⇒ 以它为 arm 点是安全的      |
| E9   | 首轮 `turn_start` 内入队                                                     | 进了 LLM#1                                                                                              | `turn_start` 不能作为 arm 点（首轮会多等一轮）            |

> Plan/开发阶段：把 E1/E2/E3/E6/E7/E8/E9 固化为 `tests/conformance/steer-hold.test.ts`（升级 pi 时的绊线，同 `pi-boundary.test.ts` 的定位），外加 §9 的 C-x 断言。

### 2.4 延迟成本表（held 交接 vs 原生「当时立即发出」）

| 场景                                                                                        | 原生取队点                                                                    | 本设计                                      | Δ                                           |
| ------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------- | ------------------------------------------- | ------------------------------------------- |
| armed 期间（LLM 请求/流式/工具执行中）发 steer                                              | 本轮 `:186`                                                                   | 本轮 turn_end 交接 → `:186`                 | **0**                                       |
| 未 armed 窗口（turn_end 后到下一个 `context`，含自动压缩、重试退避、before_settle）发 steer | `:111`/`:186`/`:85`（重试）                                                   | 立即交                                      | **0**（同一路径）                           |
| followUp，停下轮预测正确                                                                    | `:192`                                                                        | 停下轮 turn_end 交 → `:192`                 | **0**                                       |
| followUp，预测失误（工具批 `terminate`、其它扩展 `continue:true`、停下轮又来了 TUI steer）  | `:192`                                                                        | agent_end 兜底 → 同 run `continue()`        | 0 次 LLM 调用；多一对 agent_end/agent_start |
| error 轮                                                                                    | 原生 steer 在队列里，被重试的 `:85` 或 `_handlePostAgentRun` 的 continue 取走 | error 轮 turn_end 照常交接                  | **0**                                       |
| 我们之后的 input handler 慢于交接预算（E4）                                                 | 原生同样要过这条链，但发送时刻更早                                            | 可能晚一个取队点；run 已结束则变成新 prompt | ≤ 1 个取队点                                |
| P12 跳过 boundary（无 entryId）                                                             | `:186`                                                                        | 下一个 turn_end 或 agent_end                | ≤ 1 轮（罕见；pi 会 emitError）             |
| 中止                                                                                        | TUI：pi 队列退回 TUI 编辑器（P21）                                            | 被扣留的项变为 `returned`，退回网页         | 语义对齐，不投递                            |

---

## 3. 总体设计

### 3.1 模块划分

```
browser (Vue)                         hub                                   agent (pi 进程, TUI 或 managed rpc)
──────────────                        ───                                   ─────────────────────────────────────
Composer ──send──► DetailDock          http.parseCmdBody(+recall)            commands.ts  handlePrompt ─┬─ armed? ──► hold.ts.HoldBuffer.hold()
QueueList ─recall─► useControl.recall ─► commands.requiredCaps(+hold.v1) ──►   handleRecall ───────────────┤             (process-level Symbol.for)
   ▲                                  registry: card.hold ← agent caps       dispatchToPi()  ◄──── hold-driver.ts（pi 钩子：context /
   │                                  caps: HOLD_HUB_CAPS                       │                     assistant message_start / turn_end /
   └─ status.held / ctl ◄────────────────── (透传) ◄──────────────────────────  │                     agent_end / agent_settled / input 屏障 /
                                                                             ledger.ts（+held/recalled/returned）   session 边界 / hubCaps 变化）
                                                                             queue-mirror.ts（不变：只镜像 pi 队列）
```

依赖方向：`hold-driver.ts` → `hold.ts`（纯数据，pi-free）+ `commands.ts` 导出的 `dispatchToPi`；`commands.ts` → `hold.ts`；`index.ts` 只做装配（注册钩子、注入端口）。`hold.ts` 不 import pi，也不 import 协议以外的东西。

### 3.2 新增 / 修改清单

| 文件                                                                                                | 类型         | 职责                                                                                                                                                                                                                                                       |
| --------------------------------------------------------------------------------------------------- | ------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `src/web-hub/agent/hold.ts`                                                                         | **新**       | `HoldBuffer`：进程级纯数据袋（`Symbol.for("pi-subagent:web-hub:hold-buffer")`，与 ledger 同模式，跨 `/reload` 复用）；FIFO、上限、TTL、撤回/取出的线性化点、投影 `HeldItemWire[]`。**pi-free**。                                                           |
| `src/web-hub/agent/hold-driver.ts`                                                                  | **新**       | 阶段机（`idle/armed/handing/between`）+ 交接编排（批次预算、确认等待）+ 中止/会话/能力变化处理。只依赖 `ExtensionContext` 类型和注入的 `dispatchToPi`。                                                                                                    |
| `src/web-hub/agent/commands.ts`                                                                     | 改           | `handlePrompt` 分支到 hold；抽出 `dispatchToPi(frame, {replyNow})`；新增 `handleRecall`；`handleAbort` 先通知 driver。                                                                                                                                     |
| `src/web-hub/agent/ledger.ts`                                                                       | 改           | `PromptSubState` + `held/recalled/returned`；`PromptReason` + `aborted/reload/stale`；`sweep` 不淘汰 `held`；`wireState(e, holdCap)` 在缺 cap 时降级（§5.4）。                                                                                             |
| `src/web-hub/agent/index.ts`                                                                        | 改           | 注册 `context`、`turn_end`（独立 async handler，**排在 FORWARDED 循环之后注册**，返回 `undefined`）、`agent_end`、`agent_settled`；`input` 观测器在需要时返回屏障 Promise；`publishStatus` 加 `held`；hello caps 加 `hold.v1`；`hubCaps` 变化通知 driver。 |
| `src/web-hub/agent/status.ts`                                                                       | 改           | `StatusInfo.held?: HeldItemWire[]`（仅 hub 有 cap 且非空时写）                                                                                                                                                                                             |
| `src/web-hub/protocol/messages.ts`                                                                  | 改（冻结面） | `CmdOp + "recall"`、`CmdArgs`、`CmdData`、`PromptDelivery + "held"`、`CtlItemWire.state/reason` 扩展、`HeldItemWire`、对应 schema                                                                                                                          |
| `src/web-hub/protocol/version.ts`                                                                   | 改           | `HOLD_AGENT_CAP = "hold.v1"`、`HOLD_HUB_CAPS = ["hold.v1"]`                                                                                                                                                                                                |
| `src/web-hub/hub/{http.ts,commands.ts,registry.ts,hub.ts,agent-server.ts}`                          | 改           | `parseCmdBody` 加 `recall`；`requiredCaps("recall") = ["cmd.v1","hold.v1"]`；card `hold` 字段 + `toCard` 白名单；两个 cap 面都加 `HOLD_HUB_CAPS`                                                                                                           |
| `src/config/settings.ts`                                                                            | 改           | `webHub.steerRecall: boolean`（默认见 Q1；与其它 `webHub.*` 一样是非 live 的 activate 时快照）                                                                                                                                                             |
| `ui/src/logic/control.js`、`QueueList.vue`、`DetailDock.vue`、`useControl.ts`、`contracts.ts`、i18n | 改           | 见 §6                                                                                                                                                                                                                                                      |

**不新建 hub 模块，也不改 queue-mirror**：被扣留的项不在 pi 队列里，绝不能进入镜像，否则 1Hz 的 `hasPendingMessages()=false` 采样会把它们误判为 `dropped`（`queue-mirror.ts` 头注释所述的机制）。

---

## 4. agent 侧：状态机与交接算法

### 4.1 阶段机（每会话一个，`hold-driver.ts` 闭包内，不放模块作用域）

| 阶段      | 进入                                                                 | 离开                                          | 新 prompt（busy）的处理                                            |
| --------- | -------------------------------------------------------------------- | --------------------------------------------- | ------------------------------------------------------------------ |
| `idle`    | `session_start`；`agent_settled`                                     | 收到 `context` → `armed`                      | pi 自己决定（idle ⇒ 开新 run；`isStreaming` ⇒ 入队）——**现状路径** |
| `armed`   | 扩展 `context` 事件；兜底：`message_start{role:"assistant"}`（幂等） | turn_end handler 开始 → `handing`             | **扣留**                                                           |
| `handing` | turn_end / agent_end / 屏障 / 超时 / cap 丢失触发的交接批次          | 批次结束 → `between`                          | 追加到缓冲尾部，由同一批次的循环接着交（保证网页消息之间 FIFO）    |
| `between` | 批次结束；`agent_end` 后                                             | `context` → `armed`；`agent_settled` → `idle` | 立即 `dispatchToPi`（与原生同一取队点，§2.4 第二行）               |

「busy」= `!ctx.isIdle()`。下列情况**一律不扣留**，走现状路径：`steerRecall` 关闭；hub 缺 `hold.v1`；阶段不是 `armed`/`handing`；正文首个非空白字符是 `@`（mention 拦截器要立即路由，否则子 agent 的 steer 会被拖到本轮末，见 Q4）；本会话缓冲已满（`HOLD_MAX_ITEMS = 16`，满了就退回原生，不报错）。

### 4.2 交接批次 `runHandoff(trigger, ctx)`（唯一实现，所有触发点共用）

```
trigger ∈ {"turn_end","agent_end","agent_settled","barrier","timeout","cap_lost"}
1. phase = handing；aborted = ctx.signal?.aborted === true || outcome === "aborted" || webAbortSeen
2. 若 aborted：held → returned{reason:"aborted"}（全部），publish，phase=between，return（不交接）
3. 选择本批：
   - steers：全部 held(deliver=steer)，FIFO
   - followUps：仅当 trigger ∈ {agent_end, agent_settled, barrier, timeout, cap_lost}，
     或 (trigger=turn_end 且 assistant 无 toolCall 且本批无 steer 且 !ctx.hasPendingMessages())
4. deadline = now + HANDOFF_BATCH_BUDGET_MS(500)；逐项（循环中会重新读缓冲，带上 handing 期间新到的项）：
   a. item = buffer.takeForHandoff(cmdId)   ← 同步线性化点：held → handing（不再可撤回）
   b. dispatchToPi(item)（同步调用 pi.sendUserMessage；同步抛 ⇒ item → returned{reason:"stale"}，继续下一项）
   c. 若剩余预算 > 0：await confirm(item, min(HANDOFF_ITEM_BUDGET_MS(200), 剩余))
        confirm = 我们的 input 观测器把该 cmdId 推到 observed，然后再过一个 setImmediate；
        超时不报错（项已在 pi 链上，后续由现有台账 30s unobserved 规则收尾）
      若预算已用完：剩余项依次 b 而不等待（仍按 FIFO 调用；只是不再保证落在同一取队点）
5. phase = between；publishStatus（held 列表 + ctl）
```

- turn_end handler 只在缓冲非空时返回 Promise，否则同步返回 `undefined`，没有扣留时零开销。最坏情况下给 pi 的 `:186` 轮询增加 `HANDOFF_BATCH_BUDGET_MS` 的延迟（受 P13 约束：pi 不会替我们兜底超时，所以这里必须自己设上界）。
- **必须返回 `undefined`**：返回 `{}` 无害，但绝不能返回 `entries`/`continue`（P13 的「整体替换」契约）。
- `agent_end` 触发：只做第 3 步的「全部」选择（steer + followUp）。`agent_end` 在 loop 内被 await，入队后由 P18 在同一 run 内续跑（E3）。
- `agent_settled` 触发：兜底，正常情况下此时缓冲应为空。若还有剩余（P12 等路径）：aborted ⇒ returned；否则 `dispatchToPi`（此时 idle ⇒ pi 开新 run，等价于原生「run 后才看到的 followUp」）。`_isEmittingAgentSettled` 期间 pi 会把 prompt 推迟到 settle 之后（`agent-session.js:1482-1485`），正确性由 pi 保证。
- `timeout`：每项 `HOLD_MAX_MS = 30 min`（unref timer）到期即单项交接。到期交接等价于原生（原生本来就一直在 pi 队列里），代价只是失去撤回能力。这个上界保证 hold 有界。
- `cap_lost`：hub 被降级替换（新 `hello_ack` 不含 `hold.v1`）或设置被关：立即交接全部 held（不退回，因为用户的意图是投递）。

### 4.3 TUI / rpc 屏障（顺序保持）

`input` 观测器看到 `source ∈ {"interactive","rpc"}` 且带 `streamingBehavior`，并且本会话还有 held 项时，返回 `runHandoff("barrier")` 的 Promise。pi 会 await input 链（P17），而 TUI 消息要到链返回后才同步 push（P14），所以 pi 队列中的顺序是**先网页 held、后 TUI**，与用户的时间顺序一致。代价：这条 TUI 消息的入队最多推迟 500ms；被屏障冲刷的网页项失去撤回能力（用户在两端同时打字的场景）。屏障是否默认开启见 Q2。

我们不能也不会保证的顺序：

- 其它扩展的 `sendMessage({deliverAs:"steer"})`（如通知、`message_agent` 投递）不走 `input`，相对网页 held 项的顺序不保证。
- 其它扩展经 `sendUserMessage` 发出的消息（`source:"extension"`，例如 `/goal` 续跑）不触发屏障。
- followUp 与 TUI followUp：TUI followUp 先进 pi 队列，网页 followUp 在下一个停下轮交接（在屏障开启时同样会被冲刷，顺序正确；屏障关闭时可能颠倒）。

### 4.4 单条消息状态机

```
                          recall（held 中）
             ┌───────────────────────────────────────────► recalled（终态，text 随 cmd_result 返回）
             │
 prompt(busy,armed) ──► held ──takeForHandoff（同步）──► handing ──► dispatched ─► observed ─► queued ─► consumed
             │            │                                │             └── 现有台账规则：unconfirmed(unobserved|timeout) / dropped
             │            │                                └─ sendUserMessage 同步抛 ──► returned{stale}
             │            ├─ 中止（ctx.signal / outcome=aborted / 网页 abort）──► returned{aborted}
             │            ├─ session_shutdown（new/resume/fork/quit）────────► returned{session}
             │            ├─ session_shutdown(reload) ──────────────────────► returned{reload}
             │            ├─ HOLD_MAX_MS 到期 / cap_lost ─────────────────────► handing（同上）
             │            └─ 屏障 / turn_end / agent_end / agent_settled ─────► handing
             │
 returned ──recall──► recalled        returned ──RETURNED_TTL_MS(30min)/容量淘汰──► 从缓冲删除（台账同步删项）
```

- 线性化点：`takeForHandoff` 与 `recall` 都是对同一个缓冲对象的**同步**读改写。agent 是单线程，所以撤回和交接严格只有一方胜出。
- `handing` 不上线（wire 上直接显示为 `dispatched`），因为它与 dispatched 的不可撤回语义相同。
- `returned` 是「未投递、可恢复」：正文保留在缓冲里，可通过 `recall` 取回（Edit / Discard 都用它）。
- 台账 `promptState`：`held`（新）、`recalled`（新，终态）、`returned`（新，终态）。`text` 字段**不**在 held 阶段写入台账（台账 `text` 是 `findDispatchedByText` 的匹配键，只在 `dispatchToPi` 时写），正文的唯一来源是 `HoldBuffer`。

---

## 5. 接口契约

### 5.1 `hold.ts`（pi-free）

```ts
export const HOLD_MAX_ITEMS = 16; // 每会话 held 上限（超出 ⇒ hold() 返回 false，调用方走原生）
export const RETURNED_MAX_ITEMS = 16; // 每进程 returned 保留上限（FIFO 淘汰最旧）
export const RETURNED_TTL_MS = 30 * 60_000; // 与台账 TTL 相同
export const HOLD_MAX_MS = 30 * 60_000; // 单项最长扣留，到期交接
export const HELD_CLIP_CHARS = 200; // wire 文本截断（同 queue-mirror）

export type HoldState = "held" | "handing" | "returned";
export type ReturnReason = "aborted" | "session" | "reload" | "stale";

export interface HoldItem {
  readonly cmdId: string;
  readonly sessionId: string;
  readonly text: string; // 完整正文（≤ 48 KiB，handlePrompt 已校验）
  readonly deliver: "steer" | "followUp";
  readonly origin: CmdOrigin; // 交接时写 origin entry 用（不含正文，U10）
  readonly at: number;
  state: HoldState;
  reason?: ReturnReason;
  updatedAt: number;
}

export type RecallOutcome =
  | { kind: "recalled"; item: HoldItem; from: "held" | "returned" }
  | { kind: "too_late" } // handing 或已不在缓冲：已交给 pi
  | { kind: "unknown" }; // 缓冲从未有过 / 已过期

export interface HoldBuffer {
  hold(item: Omit<HoldItem, "state" | "updatedAt">, now: number): boolean;
  /** FIFO 视图（只读），供 driver 选择批次。 */
  held(sessionId: string): readonly HoldItem[];
  /** 线性化点：held → handing；不是 held 时返回 undefined。 */
  takeForHandoff(cmdId: string, now: number): HoldItem | undefined;
  /** handing 完成（成功或失败）后从缓冲移除；失败转 returned 时用 markReturned。 */
  release(cmdId: string): void;
  markReturned(
    cmdIds: readonly string[] | "all-held",
    reason: ReturnReason,
    sessionId: string | undefined,
    now: number,
  ): HoldItem[];
  /** 线性化点：held|returned → 移除并返回。 */
  recall(cmdId: string, now: number): RecallOutcome;
  /** 当前会话的 held + 全部 returned（带 sessionId 供 UI 标注「上一会话」），按 at 升序。 */
  project(sessionId: string, now: number): HeldItemWire[];
  sweep(now: number): string[]; // 返回被 TTL/容量淘汰的 cmdId（调用方同步改台账）
  dispose(): void; // 进程级袋：不清空（与 ledger 同语义）
}
export function createHoldBuffer(): HoldBuffer;
```

### 5.2 `hold-driver.ts`

```ts
export interface HoldDriverDeps {
  buffer: HoldBuffer;
  enabled(): boolean; // settings.webHub.steerRecall && hubCaps 含 hold.v1 && control
  getSessionId(): string;
  dispatchToPi(item: HoldItem): { ok: true } | { ok: false }; // 同步；内部写台账 dispatched + appendOrigin + sendUserMessage
  isObserved(cmdId: string): boolean; // 台账 promptState ∉ {held, dispatched}
  onReturned(items: readonly HoldItem[]): void; // 台账 → returned{reason}
  publish(): void;
  now(): number;
  setTimer(ms: number, fn: () => void): { cancel(): void }; // unref
  barrier: boolean; // §4.3，见 Q2
}
export interface HoldDriver {
  /** handlePrompt 调用：true ⇒ 已扣留（调用方立即回 delivery:"held"）。 */
  tryHold(frame: CmdFrame & { cmd: { op: "prompt" } }, ctx: ExtensionContext): boolean;
  onContext(): void; // → armed
  onAssistantMessageStart(): void; // → armed（兜底）
  onTurnEnd(ev: { message: AgentMessage; outcome: string }, ctx: ExtensionContext): Promise<void> | undefined;
  onAgentEnd(ctx: ExtensionContext): Promise<void> | undefined;
  onAgentSettled(ctx: ExtensionContext): void;
  onInterruptingInput(ev: InputEventLike, ctx: ExtensionContext): Promise<void> | undefined; // 屏障
  onWebAbort(): void; // handleAbort 在 ctx.abort() 之前调用 ⇒ 立即 returned{aborted}
  onSessionShutdown(reason: string): void; // reload ⇒ returned{reload}，其余 ⇒ returned{session}；phase=idle
  onSessionStart(): void; // phase=idle；清 timer
  onCapsChanged(): void; // enabled() 由真转假 ⇒ runHandoff("cap_lost")（忙时）/ returned（不可能投递时）
  dispose(): void; // 清 timer；held 不丢（进程级袋）——下一次 session_shutdown 已转 returned
}
```

`dispatchToPi` 是从 `handlePrompt` 中抽出的现有逻辑（`commands.ts:213-226`），去掉了 3s HTTP 等待（held 的 HTTP 回执已经立即返回）。它保留：台账 `dispatched` + 写 `text` 匹配键、`appendOrigin`、30s `unobserved` 终结 timer、`sendUserMessage(text,{deliverAs, expandPromptTemplates:false})`。**origin entry 改在交接时写**，这样被撤回的消息不会在 transcript 留下孤儿 origin 行；交接时写入的 origin 紧挨着那条 user 消息。

### 5.3 协议追加（`protocol/messages.ts`，冻结面）

```ts
export type CmdOp = ... | "recall";
export type CmdArgs = ...
  | { op: "recall"; target: string; expect?: CmdExpect };   // target = 被撤回 prompt 的 cmdId

export type PromptDelivery = "observed" | "unobserved" | "held";      // "held" 仅在 hub 有 hold.v1 时出现

export type CmdData = ...
  | { op: "recall"; outcome: "recalled"; from: "held" | "returned"; deliver: "steer" | "followUp"; text: string }
  | { op: "recall"; outcome: "too_late" };   // 已交给 pi；前端显示「已交给模型，无法撤回」

// CmdErrorCode 不新增：target 从未见过 / 已过期 ⇒ E_NOT_FOUND（不可重试，effect none）；
// target 属于别的会话且不是 returned ⇒ E_SESSION_CHANGED。

export interface CtlItemWire {
  state: ... | "held" | "recalled" | "returned";
  reason?: ... | "aborted" | "reload" | "stale";
  op: CmdOp;                 // 现在可能是 "recall"
}

export interface HeldItemWire {
  cmdId: string;
  text: string;              // clip 200 字符（显示用；完整正文只经 recall 的 cmd_result 返回）
  deliver: "steer" | "followUp";
  state: "held" | "returned";
  reason?: "aborted" | "session" | "reload" | "stale";
  sessionId: string;         // ≠ 当前会话 ⇒ UI 标「上一会话」
  at: number;
}
export interface StatusInfo { ...; held?: HeldItemWire[] }   // 空 / 无 cap ⇒ 省略（逐字节等同现状）
```

Schema：`RecallArgsSchema`（`additionalProperties:false`，`target` 用 hub 的 cmdId 正则 `^[A-Za-z0-9_-]{16,64}$`）；`CtlItemSchema.op/state/reason` 扩展；`StatusInfoSchema.held` 是 `Optional(Array(HeldItemSchema))`，`HeldItemSchema` 严格（`text` maxLength 与 queue 一致）；`CmdData` 的 recall 分支 `text` 上限为 `PROMPT_TEXT_MAX_BYTES`。

### 5.4 能力协商与兼容矩阵

- agent `hello.caps` 加 `hold.v1` 的条件：`control && webHub.steerRecall`（pi-compat 探测失败 ⇒ 不加，与 cmd.v1 同规则）。
- hub：`HOLD_HUB_CAPS = ["hold.v1"]` 同时出现在 `hello_ack.caps` 与 `HubInfo.caps`（DIALOG_BG 模式，保持字节一致）。hub 侧 `requiredCaps("recall") = ["cmd.v1","hold.v1"]`（检查 agent caps）；`AgentCard.hold = r.caps.includes("hold.v1")`（`toCard` 白名单补字段）。
- agent 侧 `enabled()` = 设置开 **且** `conn.caps` 含 `hold.v1`。连接期间 caps 变化（hub 版本替换）⇒ `onCapsChanged`。
- ledger `wireState(e, holdCap)`：hub 无 cap 时 `held → "queued"`、`recalled|returned → "dropped"`（正常情况下不会出现，因为无 cap 时不扣留；这只是 cap 丢失瞬间残留项的降级，同 dialog `background → abort`）。`status.held` 在无 cap 时不发。

| hub \ agent | 新 agent（hold.v1）                               | 旧 agent / 设置关                                                                                                     |
| ----------- | ------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------- |
| 新 hub      | 完整功能                                          | `card.hold` 缺省 ⇒ UI 不显示撤回；`/api/cmd {op:"recall"}` ⇒ 409 `E_UNSUPPORTED`，不发帧；prompt 路径与现状逐字节一致 |
| 旧 hub      | agent 看不到 `hold.v1` ⇒ 不扣留，与现状逐字节一致 | 现状                                                                                                                  |

### 5.5 幂等与竞态（遵守 control-plan §3.4 / §4.5）

- `recall` 是独立的用户动作，用**新的 cmdId**；同一 id 重试 ⇒ 台账 dup，回放第一次的结果（`recalled` 时含原 `text`，所以重试也能拿回正文）。
- 第一次执行就决定胜负：`recall` 与 `takeForHandoff` 在同一个同步临界区里。之后 hub 重启、链路断开后重投，都只回放缓存，**不会二次判定**（不会出现「第一次 too_late、重试却 recalled」）。
- prompt 本身：held 时 `handlePrompt` 立即 `settleAndReply(ok{delivery:"held", behavior:deliver})`。之后的变化（交接 → observed/queued/consumed，或 recalled/returned）都只经 `ctl` 槽推送，与现有「HTTP 回执之后由 ctl 推进」的规则一致。
- 容量：held prompt 的 generic state 是 `ok`，不占 `LEDGER_MAX_RUNNING`；但 `sweep` 必须跳过 `promptState === "held"` 的项（否则 512 容量淘汰可能删掉仍在扣留的项，导致 ctl 投影和撤回幂等失效）。顺带建议 `dispatched/observed/queued` 也跳过（现有潜在问题，计划阶段决定是否一并修）。
- 内存上界：缓冲 ≤ (16 held + 16 returned) × 48 KiB ≈ 1.5 MiB/进程；recall 结果带正文，进入 agent 台账（512 项）和 hub LRU（2048 项）。理论最坏值分别为 24 MiB / 96 MiB，但受 per-principal 速率限制（`cmd-limit.ts`）约束，正常情况下远小于此。计划阶段可选：hub LRU 对 `recall` 结果只保留 10 min（已是 TTL）且不额外放宽。

### 5.6 与 abort 的交互

`handleAbort`：先 `holdDriver.onWebAbort()`（held → returned{aborted}，立即 publish），再 `ctx.abort()`。TUI Esc / 其它扩展的 abort：在下一个 turn_end（`ctx.signal.aborted`，E6）、agent_end 或 agent_settled 时转 returned。被 abort 的 run 期间，`armed` 阶段收到的新 prompt：`ctx.signal?.aborted` 已为真 ⇒ 不扣留，直接走原生路径（pi 自己决定入队或开新 run），以免新消息被立刻退回。

---

## 6. 前端

### 6.1 队列模型

`mergeQueue(serverQueue, optimistic, dropped, held = [])`。显示顺序 = 投递顺序：

1. 乐观 `sending` 项（现状）；
2. `status.queue` 中的 pi 队列项（已交给 pi）。web 来源的行在 `card.hold` 为真时加注「已交给模型，无法撤回」，无操作按钮；
3. `status.held` 中 `state:"held"` 的项（FIFO）——操作：**撤回**；
4. `state:"returned"` 的项——提示文案按 reason 区分，操作：**编辑**、**丢弃**。

乐观项去重时额外排除 `held` 中已有的 cmdId（与 serverCmdIds 同理）。`recall` 自身的待决项不作为独立行渲染，只让目标行显示 `recalling` 状态 chip；失败或 too_late 显示在目标行的 note 上。

### 6.2 「撤回」= 撤回到输入框（不做原地编辑）

点击撤回 ⇒ `useControl.recall(agentKey, targetCmdId)`，根据结果：

- `recalled` ⇒ 把正文放回 composer：`[recalledText, currentDraft].filter(nonblank).join("\n\n")`。这与 pi TUI `restoreQueuedMessagesToEditor` 的拼接规则一致（`interactive-mode.js:3827-3846`）。用户编辑后按普通发送提交，生成**新的 cmdId**，排在扣留队列末尾。
- `too_late` ⇒ 行内提示「来不及了：已交给模型，将在下一步被读取」。该行随后会在 `status.queue` 中以已交接状态出现。
- returned 行的「编辑」与撤回相同；「丢弃」也调用 recall，但丢掉返回的正文（服务端记录同样被清除）。

**为什么不做原地编辑**（edit op 带新正文、保留队列位置）：

1. control-plan §3.4 规定「修改后再提交是新动作、新 id」。原地编辑要么复用 cmdId（违反载荷摘要规则），要么引入「替换」语义，台账和 ctl 投影都要多一条分支。
2. 编辑要花人类时间（几十秒），这段时间里轮次随时可能结束。原地编辑要么锁住该项禁止交接（无界扣留，违反 G4），要么在提交时才发现已交接（用户白改）。先撤回会在点击那一刻就给出确定答案：拿回来了就是你的，之后不存在任何竞态。
3. 与 TUI 心智一致：pi 的出队就是「退回编辑器」。
   代价：编辑后的消息排到扣留队列末尾，不保留原位置。多条扣留时，用户可以依次撤回再按序重发。

### 6.3 文案（UI 文本语言拆分规则）

compact chip 用英文：`held`、`recalling`、`returned`、`handed`。中文用于长文案：`control.heldNote`「尚未交给模型，可撤回」、`control.handedNote`「已交给模型，无法撤回」、`control.tooLate`、`control.returnedAborted`「已中止，此消息未发送」、`control.returnedSession`「会话已切换，此消息未发送」、`control.returnedReload`「扩展已重载，此消息未发送」、`control.offlineHeld`「pi 已退出，此消息很可能未送达」。

### 6.4 原文保留（文件引用展开）

`DetailDock.onSend` 发出的是 `expandFileRefs` 展开后的正文（`@<路径>` 被替换为附件块），撤回拿回的也是展开后的正文，直接放回 composer 体验很差。`useControl` 按 cmdId 在内存里保留**展开前的原文**（`originalText`，与 drafts 同生命周期，页面刷新即丢失）：撤回时优先用原文，没有才用服务端返回的正文。

### 6.5 agent 离线

`agent_down` 或 stale 时，本地状态为 held 的乐观/服务端项标记为 `offlineHeld`。如果本地保留了原文，就提供「编辑」（用本地原文，不发 recall）；没有原文则只能丢弃。这就是 G3 中「pi 崩溃」那一项的兜底。

---

## 7. 失败模式表

| #   | 情况                                                                           | 处理                                                                                                                                                                       | 结果是否如实 / 是否有界                                  |
| --- | ------------------------------------------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------- |
| F1  | 撤回与交接同时发生                                                             | 同步临界区；先到者胜出                                                                                                                                                     | recall 回 `recalled` 或 `too_late`，严格二选一           |
| F2  | 网页 abort                                                                     | `onWebAbort` 在 `ctx.abort()` 之前把 held 转 returned                                                                                                                      | 立即可见；不投递                                         |
| F3  | TUI Esc / 其它扩展 abort                                                       | turn_end（`ctx.signal.aborted`，E6）/ agent_end / agent_settled 时转 returned；pi 队列中已交接的网页项按现状被 TUI 收回编辑器（`dropped`）                                 | 不投递；最迟到 run 结束                                  |
| F4  | 手动 `/compact`（先 abort，P20）                                               | 同 F3；压缩期间的新 prompt 仍是 `E_BUSY_COMPACTING`（现状）                                                                                                                | 同上                                                     |
| F5  | 自动压缩（prepareNextTurn / prepareRequest / overflow）                        | 处于未 arm 窗口，新消息立即交接；held 项不受影响，在下一个 turn_end/agent_end 交接                                                                                         | 0 额外轮次                                               |
| F6  | `/new` `/resume` `/fork` / quit                                                | `session_shutdown` ⇒ returned{session}，跨会话投影，30 min TTL                                                                                                             | 不会串到新会话；可编辑重发                               |
| F7  | `/reload`                                                                      | `session_shutdown(reload)` ⇒ returned{reload}；缓冲是进程级的，新 module 继续投影并接受 recall                                                                             | 不丢                                                     |
| F8  | hub 重启 / 链路断开                                                            | agent 不受影响，照常在 turn_end 交接；重连后 status/ctl 重放；在途 recall 走 unknown → 同 id 重投 → 台账裁决                                                               | 交接照常；撤回在断线期间不可用（UI 显示离线）            |
| F9  | hub 被降级为无 `hold.v1` 的版本                                                | `onCapsChanged` ⇒ 忙时立即交接全部 held（cap_lost），之后不再扣留；台账投影降级                                                                                            | 消息投递，不丢                                           |
| F10 | pi 进程崩溃 / 被 kill / managed 会话重启恢复                                   | 内存缓冲随进程丢失（与 pi 自身队列相同）；浏览器按 §6.5 兜底                                                                                                               | 浏览器显示「很可能未送达」；页面也刷新过时无法恢复（Q3） |
| F11 | `sendUserMessage` 同步抛错（stale ctx）                                        | 该项 → returned{stale}                                                                                                                                                     | 如实                                                     |
| F12 | `sendUserMessage` 异步失败（P16 `.catch` → emitError）                         | 交接后由现有台账 30s 规则收尾为 `unconfirmed(unobserved)`                                                                                                                  | 与现状一致                                               |
| F13 | 下游第三方 input handler 很慢（E4）                                            | 每项确认 ≤200ms、批次 ≤500ms，超时继续往下交                                                                                                                               | ≤ 1 个取队点；run 已结束则变成新 prompt，不丢            |
| F14 | 前序 handler 拦截了交接的消息（`handled`，或 mention 未被 `@` 预判覆盖的情况） | 现有台账：观测不到 ⇒ unconfirmed                                                                                                                                           | 与现状一致                                               |
| F15 | pi 跳过 turn_end boundary（P12）                                               | agent_end 兜底，再由 agent_settled 兜底                                                                                                                                    | ≤ 1 轮                                                   |
| F16 | 单轮极长（长 bash、等子 agent）                                                | 照常扣留（正是本功能的价值所在）；`HOLD_MAX_MS` 30 min 到期交接                                                                                                            | 有界                                                     |
| F17 | 缓冲满（16）                                                                   | 新 prompt 走原生路径（不扣留、不报错）                                                                                                                                     | 有界                                                     |
| F18 | 我们的 turn_end handler 内部抛错                                               | `runHandoff` 整体 try/catch：已 handing 的项照常走台账；未处理的保持 held，由 agent_end/settled 重试；pi 会 emitError 而不会挂住（P13 catch）                              | 有界                                                     |
| F19 | 同一 cmdId 被两个标签页同时撤回                                                | 第一个 recalled；第二个用的是不同 cmdId ⇒ 目标已不在缓冲 ⇒ `too_late`。UI 需把 too_late 的提示区分为「已被撤回或已交给模型」（为此 CmdData 可选携带 `targetState`，见 Q5） | 如实                                                     |

---

## 8. 关键决策日志

| ID  | 决策                                                                         | 备选与否决理由                                                                                                                                                                                                                       |
| --- | ---------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| D1  | 交接点 = `turn_end` 扩展 handler（finishTurn 内、被 await、早于 `:186`）     | `tool_execution_start/end`：不在取队路径上，且不知道是否是最后一个工具；`message_end{assistant}`：早于工具执行，交接太早，失去整个工具执行期的撤回窗口；「立即交接 + 撤回宽限」：pi 无法逐条出队，宽限期内无法真实撤回，违反用户裁定 |
| D2  | arm 点 = `context` 事件（兜底：assistant `message_start`）                   | `turn_start` 在首轮早于 `:85`（E9），会多等一轮；只用 assistant `message_start` 会损失 TTFT 窗口（思考模型可达数十秒）。`context` 已有 `structuredClone` 开销（runner.js:1008），多一个 O(1) handler 可以忽略                        |
| D3  | 未 arm 窗口立即交接                                                          | 若在这段时间也扣留，会错过 `:111`/`:85` 的取队，多等一轮                                                                                                                                                                             |
| D4  | followUp 只在预测为停下的轮次交接，agent_end 兜底                            | 每个 turn_end 都交：过早失去撤回能力；只在 agent_end 交：每次都多一对 agent_end/agent_start，可能触发其它扩展的「任务结束」逻辑                                                                                                      |
| D5  | 确认 = 自家 input 观测 + 1 个 `setImmediate`，有预算上界                     | 没有更精确的入队信号（P16/P19，`hasPendingMessages` 只是布尔值）；无预算的等待违反 G4（P13 不替我们超时）                                                                                                                            |
| D6  | 被扣留项放在独立的 `HoldBuffer` / `StatusInfo.held`，不进 queue-mirror       | 混入镜像会被 1Hz 空队列采样误判为 dropped；镜像应保持「pi 队列的真相」这一单一语义                                                                                                                                                   |
| D7  | 撤回 = 撤回到输入框；不做原地编辑                                            | 见 §6.2                                                                                                                                                                                                                              |
| D8  | recall 结果携带完整正文                                                      | status 中放完整正文会使帧变大（32 × 48 KiB）；浏览器本地原文在页面刷新后丢失。只有在点击撤回时才传正文                                                                                                                               |
| D9  | 中止 ⇒ returned（不投递）                                                    | 中止后投递违背「停下」的意图；保留在 pi 队列会被下一条 prompt 夹带（rpc 行为）。TUI 本身就是退回编辑器（P21），这里对齐                                                                                                              |
| D10 | 会话边界 / reload ⇒ returned（不跨会话投递）                                 | reload 后自动续交：reload 极少发生在轮次中途，而续交会引入「新 module 继承旧阶段」的复杂度（Q6）                                                                                                                                     |
| D11 | 缓冲在内存（进程级 `Symbol.for`），不落盘                                    | 写进会话 jsonl 违反 U10（条目不含请求正文）；另建 0600 文件则增加磁盘面与恢复协议。崩溃丢失与 pi 自身队列一致，由浏览器兜底（Q3）                                                                                                    |
| D12 | 双端 cap 门控（agent `hold.v1` + hub `hold.v1`），缺任一端即与现状逐字节一致 | 只靠可选字段：旧 hub 的 ctl/queue/CmdData schema 是封闭的，会整帧丢弃                                                                                                                                                                |
| D13 | 正文以 `@` 开头时绕过扣留                                                    | 否则 `@label` 的子 agent steer 会被拖到主 agent 的轮次末尾（mention 拦截器是在 input 时执行的）                                                                                                                                      |
| D14 | TUI/rpc 屏障（默认开，Q2）                                                   | 不做屏障：网页先发、TUI 后发的消息在模型侧顺序颠倒                                                                                                                                                                                   |
| D15 | 只扣留 `prompt` op                                                           | `command` op 的模板/技能分支走 builtin-bridge，交接语义不同，留作扩展点                                                                                                                                                              |

---

## 9. 实施要点与测试锚点

### 9.1 给 Plan / 开发的关键提示

1. **turn_end handler 单独注册**，不要并进 `FORWARDED_EVENTS` 的同步循环（那个循环的 handler 必须保持同步并返回 undefined）。返回值必须是 `undefined | Promise<void>`，**永远不返回 `entries`/`continue`**。
2. 所有新 timer 都要 `unref()`；每个 await 都包在 `Promise.race([p, deadline])` 里。`hold-driver` 的状态全部放在闭包里（AGENTS.md：模块作用域禁止放可变状态）；只有 `HoldBuffer` 的纯数据袋放在 `Symbol.for` 上。
3. `dispatchToPi` 必须保持「先登记观测、再 `sendUserMessage`」的顺序（`commands.ts:215-220` 的 finding 3）：交接时 `input` 会在同一调用栈内同步触发。
4. 判断中止看 `ctx.signal?.aborted`（E6），不能只看 `outcome`。
5. `sweep` 跳过 held（§5.5）。`wireState` 按 cap 降级。
6. `input` 屏障只对 `source ∈ {interactive, rpc}` 且带 `streamingBehavior`、且本会话有 held 项时返回 Promise；其余情况保持同步返回，现有观测语义不变。
7. web-hub 的 `input` 观测器仍须是最后注册的 pi-toolkit input handler（control-plan §4.1 已有注册顺序单测，扩展该测试即可）。
8. 设置关闭时：不注册 `context`/`turn_end`/`agent_end`/`agent_settled` 这几个新 handler，也不加 cap（目标是「不注册」，而不是「注册了但不起作用」，与 `systemPrompt.wakeReplay` 的做法相同）。这样才能做到逐字节一致。

### 9.2 测试锚点

**conformance（真实 pi，`tests/conformance/steer-hold.test.ts`）**：C1 = E1（turn_end 交接 steer 落在下一次请求）；C2 = E2（停下轮交接 followUp，单次 agent_end）；C3 = E3（agent_end 兜底在同一 run 内）；C4 = E6（工具执行中 abort 时 `ctx.signal.aborted=true` 而 `outcome=completed`）；C5 = E7（FIFO + one-at-a-time）；C6 = E8（`context` 内入队落在下一次请求）；C7 = E9（首轮 `turn_start` 早于取队——反证 arm 点的选择）；C8 = 在 turn_end 内 `pi.appendEntry` 写 origin，entry 顺序为 [assistant, toolResult, web-origin, user]。

**unit**：

- `hold.ts`：FIFO / 上限 / TTL / `takeForHandoff` 与 `recall` 的线性化（属性测试：随机交错 recall/take，每个 cmdId 恰好一个终局）/ returned 跨会话投影 / 进程级袋跨实例复用。
- `hold-driver.ts`（假 ctx + 假时钟）：阶段机转移矩阵；批次预算（慢确认 ⇒ ≤500ms 内返回）；followUp 选择规则；屏障排序；abort 的三条路径；cap 丢失；session/reload；`HOLD_MAX_MS` 到期。
- `commands.ts`：held 时立即回 `delivery:"held"` 且 `sendUserMessage` 调用 0 次；recall 的 dup 回放含 text；`E_NOT_FOUND`；`E_SESSION_CHANGED`；设置关闭时与现有 golden 行为一致（复用现有 commands 测试，期望不变）。
- `ledger.ts`：新状态的 wire 投影与降级；sweep 跳过 held。
- 协议：schema 往返；旧 hub schema 拒收 held（证明门控的必要性）。
- UI：`mergeQueue` 新签名与旧调用兼容（`held` 缺省）；QueueList 各行的操作按钮；撤回结果与草稿合并；原文优先。

**integration（真 socket + 真 HTTP，`tests/integration/web-hub-steer-recall.test.ts`）**：I1 端到端 held → recall → `cmd_result.text`；I2 recall 与 turn_end 交接竞态（注入 turn_end，二者恰好一方胜出，重投时 dup 一致）；I3 hub 重启后同 id recall 回 dup；I4 hub 缺 cap ⇒ `E_UNSUPPORTED` 且 agent 不扣留；I5 agent 缺 cap ⇒ card 无 hold。

**真机验收（tmux，沿 `live-acceptance-tmux.md`）**：TUI 会话与 managed rpc 会话各跑一遍，跑一条长 `sleep` 工具：网页 steer → 撤回 → 编辑 → 重发；不撤回则在工具结束后被模型读到（对照立即发送的原生行为，确认是同一轮）；Esc 中止 ⇒ returned；`/new` ⇒ returned（上一会话标注）；Alt+Enter followUp 在最终答复后被处理，且只有一次 agent_end。

### 9.3 风险

- R1：pi 升级后 `turn_end` 不再由 finishTurn 分发（P11），或 `context` 的时序变化。由 conformance C1/C6/C7 作为绊线；失败时把 pi-compat 探测置为不广播 `hold.v1`（自动回落到现状）。
- R2：其它扩展的慢 turn_end handler 会推迟 pi 的取队，但这与我们无关，是现有行为；我们的 handler 只增加 ≤500ms。
- R3：TUI 用户看不到网页扣留的消息（pi 的 pending 区只显示 pi 队列）。建议在 web-hub 现有状态行里加 compact 标记 `web held N`（Q7）。

---

## 10. 待用户确认的问题

- **Q1** `webHub.steerRecall` 的默认值：建议 `true`（这是用户要求的功能；关闭时逐字节回落）。
- **Q2** TUI/rpc 屏障（§4.3）默认开启？开启能保证「网页先发、TUI 后发」的顺序，代价是 TUI 插话最多推迟 0.5s，且被冲刷的网页消息失去撤回能力。建议开启。
- **Q3** 是否接受「pi 进程崩溃时被扣留的消息只靠浏览器内存兜底」？备选：opt-in 的 0600 本地文件持久化（另起计划，需要单独评估 U10 的豁免）。
- **Q4** `@` 开头一律绕过扣留（D13）是否可接受？备选：注入 mention 解析器，只对能解析到 label 的文本绕过。精确，但会把 mention 注册表依赖带进 web-hub。
- **Q5** 「撤回」的 too_late 是否需要区分「已被另一标签页撤回」和「已交给模型」？需要的话，CmdData 加可选的 `targetState`。
- **Q6** `/reload` 发生在轮次中途时，是否改为「继承并继续扣留」而不是 returned？建议维持 returned（简单，且 reload 时恰好在轮次中途的情况极少）。
- **Q7** TUI 侧是否显示 `web held N` 状态标记？

## 11. 用户裁定（2026-10-08）

| #   | 裁定                                                                                                                    |
| --- | ----------------------------------------------------------------------------------------------------------------------- |
| Q1  | `webHub.steerRecall` 默认 `true`（按建议）                                                                              |
| Q2  | **不做 TUI/rpc 顺序屏障（§4.3 整体删除）**：终端插话立即交给 pi，可能排在更早发出的网页暂存消息之前；暂存消息保持可撤回 |
| Q3  | 接受「pi 进程崩溃时暂存消息只靠浏览器内存兜底」，不做落盘（按建议）                                                     |
| Q4  | `@` 开头一律绕过扣留（D13）——接受（按建议）                                                                             |
| Q5  | too_late 不区分「另一标签页已撤回」与「已交给模型」，v1 不加 `targetState`                                              |
| Q6  | `/reload` 发生在轮次中途：维持 returned（按建议）                                                                       |
| Q7  | TUI 显示紧凑英文状态标记 `web held N`（N>0 时），遵守 AGENTS.md 行内标记英文 token 规则                                 |

### 11.1 补充裁定（2026-10-09 凌晨）

- **R7 接受**：hook 交接时的有界确认窗口（约 200ms）内新到的网页消息走 pi 原生队列，照常送达、不丢不重，只是不可撤回。
- **TUI 标记**：字面 `web held N`（不用 `web ● held N` 变体）。
- **开发授权**：方案评审达到「通过 / 有条件通过」即可按包开发（L3 用户闸门已由用户预先放行），每包异源验收后本地提交，不 push。
