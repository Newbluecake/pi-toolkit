# 子会话 switch_context + 缓存保活 ping — L2 实施方案（v1，待评审）

> 需求原话：「我觉得子会话可以支持switch context」「然后支持cache ttl ping即可」。
> 范围：subagent 子会话 ① 模型自写交接的上下文切换（含 compact-hint 的 tick / 提醒 / 兜底）；② 子会话等待期间的前缀缓存保活 ping。
> 不在范围：子会话的 TTL 改写（on/off/adaptive）、`compact_context` / `set_compact_threshold` 进子会话、主会话行为的任何变化。

## 0. 结论先行（三个决定方案形状的事实）

1. **主会话的 switch_context 在子会话里原样搬过去会直接把 run 结束掉。** 它靠 `ctx.compact()`，而 pi 的 `compact()` 第一步就是 `await this.abort()`（pi `agent-session.js:1865-1868`）。子会话 run 的生命就是 runner 里 `await handle.prompt(req.prompt)`（`src/runtime/runner.ts:673`）：abort 让 prompt() resolve，runner 立即 `prompt_settled` → 以切换前那句话作为最终结果完成，随后 dispose 会话，压缩打在已销毁的会话上，`onComplete` 里的 resume `sendUserMessage` 启动一个没人等的孤儿 prompt。
2. **pi 0.87 有不 abort 的原生通道：`turn_end` 边界草稿。** `turn_end` / `agent_before_settle` 的 handler 可以返回 `{ entries: SessionBoundaryDraft[], continue?: true }`，草稿类型包含 `compaction`（`firstKeptEntryId: string | null`，null = 什么都不保留）（`types.d.ts:575-618`；docs `extensions.md:109`）。pi 在 `finishTurn` 里同步提交（`agent-session.js:332-364, 366-377`）：`appendCompaction(..., fromHook=true)` 后 `_refreshFinalizedContext()`（`:426-450, 483-488`），下一轮请求直接用压缩后的上下文，**同一个 prompt() 不中断**。它不发 `compaction_start/end`，也不走 `session_before_compact`。子会话切换就用这条路：零 abort、零摘要 LLM、零新 phase，也不会碰看门狗。
3. **子会话里 `session_start` 从不触发，`ctx.mode === "print"`。** `session_start` 只在 `bindExtensions()` 里发（`agent-session.js:2293-2314`），我们的 session driver 从不调它（`src/runtime/session-driver.ts:381-415` 只 `createAgentSession` + `subscribe`）；ExtensionRunner 默认 `mode = "print"`、UI 为 noop（pi `extensions/runner.js:168`）。所以子会话的新装配**不能依赖 session_start**，只能在首个用得上的事件里惰性初始化。现有 keepalive 的 G2 闸门只放行 `tui`/`rpc`（`src/cache-ttl/keepalive-state.ts:46, 378`），子会话会被永久拦下。（这条对并行中的 bash-timeout-grace P5 也有影响：它的 §3.4 在子会话 `session_start` 里建 manager，见 §7 冲突预检。）

## 1. 现状证据

### 1.1 注册位置（src/index.ts）

| 模块                                                                             | 位置                 | 区域       |
| -------------------------------------------------------------------------------- | -------------------- | ---------- |
| web_search / todo                                                                | `:107-109`           | pre-guard  |
| `HOST_KEY` / `isChildSession`（HOST_KEY 已被认领 ⇒ 子会话）                      | `:113-119`           | pre-guard  |
| prompt hub / memory（传入 `isChildSession`）                                     | `:125-137`           | pre-guard  |
| **HOST_KEY 守卫** `if (g[HOST_KEY]) return;`                                     | `:154`               | —          |
| `wireCacheTtl`（TTL 改写、capture、keepalive 事件转发、`/cache-ttl`）            | `:187-190`           | post-guard |
| `PendingHandoffStore`（每次 activate 新建）                                      | `:214`               | post-guard |
| compact-hint `turn_end` 钩子                                                     | `:215-223`           | post-guard |
| 动态阈值 `tool_call`/`session_compact`/`model_select`                            | `:226-240`           | post-guard |
| `switch_context` 工具 + `session_before_compact` + `session_compact_failed` 清槽 | `:377-402`           | post-guard |
| `compact_context`（仅 switchTool 关或 keepCompactTool）                          | `:405-407`           | post-guard |
| `set_compact_threshold`                                                          | `:408-415`           | post-guard |
| `session_start` → `buildSessionStack`                                            | `:559-583`（`:575`） | post-guard |
| `session_shutdown` → `keepalive.dispose()` 等                                    | `:591-603`           | post-guard |

结论：上下文切换、compact-hint、cache-ttl/keepalive 全部在守卫之后，**子会话里一个都没有**。

### 1.2 栈构建（src/stack.ts）

- `buildSessionStack` 只由主会话 `session_start` 调（`src/index.ts:575`）；子会话不建栈（没有 session_start，而且在守卫之后）。
- `CompactHintState` 构造：`:1068-1083`；compact-hint 钩子 `createCompactHintHook`：`:668`，首行 `if (ctx.mode === "print" || ctx.mode === "json") return;`（`:691`）；强制兜底 `ctx.compact({...})`：`:838`。
- keepalive：`:1627-1650`，`backgroundBusy` = 本栈 run / bash job / workflow（`:1633-1637`）；上一实例在下次 build 顶部 dispose（`:1042`），模块级 `previousKeepalive`（`:168`）。
- adaptive：`:1656-1691`，依赖 keepalive 的 `provenCacheReadAt` / `gapHorizonMs`。
- 动态阈值：`:1721-1756`（print/json 返回惰性 runtime）。

### 1.3 子会话如何启动

- `PiSessionDriver.create/resume` → `createAgentSession`（`src/runtime/session-driver.ts:381-400`）；每个子会话各有一个 resource loader，会重新 import 并 `activate()` 本扩展，所以**每个子会话都有自己的闭包**。它和主会话同进程，共享 `globalThis`，靠 HOST_KEY 区分（`src/index.ts:139-154` 注释）。
- `bind()` 只 `session.subscribe` 映射事件（`:401-420`），`compaction_start/end`、`agent_settled` 已经映射（`:196-198`）；`entry_appended` 目前没映射。
- runner：create → bind → `watchdog.arm` → `prompt_dispatch` → `guardUntil(handle.prompt(...), effectiveDeadlineAt)`（`src/runtime/runner.ts:590-690`）；prompt resolve 就进 `prompt_settled`（终态）。
- 状态机已经有 `compaction` phase：`compaction_start` 进入、`compaction_end` 回到 `model_turn`（`src/core/state-machine.ts:817-825`），预算 `compactionMs`（`src/core/deadline.ts:74-75`；本机 `budget.compactionS=600`）。它只覆盖 pi 自己的自动压缩。
- 工具授权：`sessionSpec.tools` = 类型 `tools` ∪ `grantedReserved`（`src/service/runtime-adapter.ts:533-645`），consult 固定只读域（`:688`）。另外每个 turn_end 按 `RESERVED_TOOL_NAMES` 做 deny-by-default 复核（`src/runtime/tool-scope.ts:21-50, buildToolScopePolicy`）。先例：`bash_job` 就是这样授予的（`bashJobGrant`，`tool-scope.ts:101-131`）。

### 1.4 pi 在子会话（print 模式、未 bind）里的能力

| 能力                                                          | 结论                                                                                                                                                              | 证据                                                                       |
| ------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------- |
| `ctx.compact()`                                               | 可用，但会先 abort 当前 run ⇒ 子会话不可用                                                                                                                        | `agent-session.js:1865-1868, 2462-2473`                                    |
| `pi.sendUserMessage`                                          | 可用，但空闲时会起一次新的 `prompt()`，runner 不会等它 ⇒ 子会话不能用来 resume                                                                                    | `:1547-1573`                                                               |
| `turn_end` 边界草稿（compaction / custom_message + continue） | 可用，不 abort；pi 自己算 tokensBefore                                                                                                                            | `:332-364, 426-450`                                                        |
| pi 自动压缩（阈值 / 溢出）                                    | 子会话里本来就在跑（pi 的 `compaction.enabled` 默认开），会发 `session_before_compact` 与 compaction 事件                                                         | `:297-307, 2027-2138, 2152-2270`                                           |
| `session.abort()`                                             | 会连带 `abortCompaction()`                                                                                                                                        | `:1608-1619`                                                               |
| `session.dispose()`                                           | 不发 `session_shutdown`；`extensionRunner.invalidate()` 之后 ctx 的 getter 会抛错                                                                                 | `:822-842`；runner `assertActive`                                          |
| pi 原生缓存预热 `CacheWarmer`                                 | 默认 `cacheWarming="streaming"`，在活跃 run 期间预热，但只对声明了 `promptCache` 的模型生效。本机 `models.json` 里 `promptCache` 出现 0 次 ⇒ 对 `cr-*` 路由不生效 | `cache-warmer.js`；`settings-manager.js:637-640`；docs `settings.md:19-21` |

### 1.5 子会话空闲的真实场景

子会话没有人类空档，只在**有工具在执行、模型不发请求**时空闲：

| 场景                                                              | 典型时长                | 当前约束          | 需不需要 ping                      |
| ----------------------------------------------------------------- | ----------------------- | ----------------- | ---------------------------------- |
| 阻塞 bash（pi 内置）                                              | ≤ `toolMs`（默认 600s） | `tool_exec` phase | >≈4min 时 1-2 次                   |
| 嵌套 `Agent`（X3 注入，spawnAndWait 阻塞）                        | 可达数十分钟            | `tool_exec`       | 主要收益场景                       |
| `consult`                                                         | ≤150s 硬顶              | 同上              | 永不触发（< 240s 间隔）            |
| `web_search` / `bash_job wait`                                    | 秒级-分钟级             | 同上              | 偶尔                               |
| bash P5 的 settle-hold（`agent_before_settle` 挂起 ≤120s 后续轮） | 每段 ≤120s              | 不是工具          | 不需要：续轮请求本身就刷新 5m 缓存 |
| `retry_backoff`                                                   | 秒级                    | —                 | 不需要                             |

现有 keepalive 的「武装」= `backgroundBusy || activeTools > 0 || uiPrompts > 0`（`src/service/cache-keepalive.ts:313-318`）。子会话里只剩 `activeTools > 0`，正好对应上表。首个 ping 在最后一次真实请求后约 `keepaliveIntervalMs`（默认 240s）才发，并且要求请求不在途（`keepalive-state.ts:403`），所以短工具天然零 ping。

## 2. 总体设计

子会话的新能力放在一个 pre-guard 装配入口里，只在 `isChildSession` 时生效，**不建栈、不碰 HOST_KEY**：

```
src/index.ts (pre-guard, wireMemory 之后)
  if (isChildSession) wireChildSession(pi, preGuardSettings)   // src/child/wire.ts（新）
      ├─ wireChildContextSwitch(pi, settings)   // src/context-switch/child.ts（新）  gate: compact.enabled && compact.switchTool && compact.childSessions
      └─ wireChildKeepalive(pi, settings)       // src/cache-ttl/child.ts（新）      gate: cacheTtl.keepalive && cacheTtl.childKeepalive
```

在子会话里保持惰性（不变）：fleet widget、HUD、scheduler、fabric 路由主体、quota、adaptive、动态阈值、`/cache-ttl`、TTL 改写、`compact_context`、`set_compact_threshold`、Agent/workflow 工具面。

### 2.1 子会话 switch_context（边界草稿方案）

**工具**：复用 `createSwitchContextTool`，新增 `deps.mode: "compact" | "boundary"`，默认 `"compact"`，主会话逐字节不变。`"boundary"` 模式下：

- 跳过 print/json 拒绝分支（`switch-context-tool.ts:116`）；不调 `ctx.compact()`（`:167`）；不 `sendUserMessage`。
- 校验通过后 `store.stageForTool({ toolCallId, core, keepRecent })`，返回**非 terminate** 的结果（`terminate: true` 会让 pi 的 `previousDecision.action === "end"` 压过扩展的 continue，见 `agent-session.js:370-374`）。文案（英文、模型可见）："Context switch staged; it takes effect at the end of this turn and work continues automatically from your handoff."
- `resume` 参数在子会话里忽略，总是继续：不继续等于 run 以切换前那句话结束，没有意义。工具描述去掉 "Only available in interactive sessions"，改成 boundary 变体的 description / promptGuidelines（单独常量，主会话文案不动）。
- 闸门：保留 in-flight 与 60s 冷却；另加每会话最多 `CHILD_MAX_SWITCHES = 5` 次（常量，防止切换→续→再切换的空转）。

**唯一的 turn_end handler**（`src/context-switch/child.ts`），职责按顺序：

1. `event.outcome !== "completed"` ⇒ 清掉暂存，返回 undefined（abort/error 时绝不续轮，runner 的取消语义保持不变）。
2. 暂存存在，**且** `event.toolResults` 里有该 `toolCallId`、`details.ok === true` ⇒ 调用纯函数 `buildChildSwitchDrafts()`（`src/context-switch/boundary.ts`，新）：
   - `firstKeptEntryId`：`keep_recent:false` ⇒ `null`；`true` ⇒ 在本分支最近一次 compaction 之后用 pi 导出的 `findCutPoint(entries, start, end, keepRecentTokens)` 求切点（`keepRecentTokens` 读 pi 设置，`src/compact-hint/pi-settings.ts` 增加一个读取函数，缺省用 `DEFAULT_COMPACTION_SETTINGS`）。子会话整个任务就是一个 turn，切点几乎总落在 turn 中间，这时直接用 `firstKeptEntryIndex`（交接文本代替 pi 的 turn-prefix 摘要，与主会话 hook 取 `preparation.firstKeptEntryId` 等价）。
   - `summary` = `composeHandoff(core, appendix)`；appendix 取 `collectSessionFacts(undefined, ctx, settings)`（会话文件 + todos，`src/context-switch/session-facts.ts` 已支持 stack 缺席），加上从分支 toolCall 推出的读/改文件列表（新增纯函数 `fileListsFromBranch`，有上限），`droppedEverything` 照旧。
   - `details: { source: "pi-toolkit:switch_context", seq, keepRecent }`（供测试/诊断识别）。
   - 返回 `{ entries: [compactionDraft, { type:"custom_message", customType:"subagent:switch-context", content: SWITCH_RESUME_TEXT, display:false }], continue: true }`。
   - 消费即清（consume-once）。**新鲜度按结构判断，不按时钟**：只认同一 turn 的 toolCallId；只要到了下一个 turn_end 没被采用就作废。不用 120s TTL，否则并行的长工具（一起调用的 600s bash）会让交接过期。
   - 任何异常：清槽，只返回一条 custom_message 说明切换失败、历史未替换、继续当前任务（不 continue，循环会因为有 tool results 自然继续）。
3. 没有切换时，运行无头版 compact-hint（§2.2），把它产出的消息作为 `custom_message` 草稿返回（不 continue）。

作用域：store 和 handler 都在本子会话 activate 的闭包里，跨会话不会串。每个子会话 activate 一次，`/reload` 的影响见 §3。

**为什么不给子会话注册 `session_before_compact`**：边界草稿不经过它；pi 自动压缩在子会话里仍用 pi 的通用摘要（今天就是这样）。暂存只活在「工具执行 → 同一 turn_end」之间，而 pi 的阈值/溢出压缩都发生在 turn_end 之后的下一次请求准备阶段（`_compactBeforeNextAssistantResponse`，`agent-session.js:297-307`），那时我们的压缩已提交、用量已降，所以没有竞态。

### 2.2 compact-hint 在子会话（无头版）

改 `createCompactHintHook`（`src/stack.ts:668`），加两个可选 deps，默认值保持今天逐字节的行为：

- `headless?: boolean`：跳过 `:691` 的 print/json 早退；**绝不调用 `ctx.compact()`**（强制分支在 demand 用尽后直接 return）；不调用 `ctx.ui.notify`。
- `getState?: () => CompactHintState | undefined`：替代 `holder.current?.compactHint`，子会话不需要伪造 Stack。

子会话策略：

| 层               | 行为                                                                                                                                                                                              |
| ---------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| tick             | 与主会话同一网格（`compact.usageTickStepPercent`），经草稿注入                                                                                                                                    |
| hint（L1）       | 与主会话同一条静态线；**动态阈值在子会话强制关闭**（不写遥测，不构造 runtime）                                                                                                                    |
| 强制（L2，先礼） | 越过（窗口缩放后的）强制线 ⇒ 发 demand，最多 `forceDemandTurns` 次                                                                                                                                |
| 兜底（后兵）     | **交给 pi 自己的自动压缩**（阈值 = window − reserve；我们的强制线本来就被 reserve 钳在它下面，`resolveReserveTokens` 同源）。子会话不做扩展侧的强制压缩：它只能靠 abort 触发，而 abort 会结束 run |
| 窗口差异         | 百分比线天然按子会话自己的模型窗口算；`forceScaling` 按窗口缩放；绝对 tokens 线超出窗口时自动失效（`threshold.ts` 现有规则），无需新配置                                                          |

子会话额外的闸门：`event.toolResults.length === 0`（最后一个 turn，run 即将结束）⇒ 不发 tick/hint/demand；`pi.getActiveTools()` 里没有 `switch_context`（未授予、consult）⇒ 整个 compact-hint 不运行（提示文案里的工具名不可用时不提示）。

状态：闭包内的 `CompactHintState`，在首个 turn_end 用 `ctx.cwd` 惰性构造（字段取值与 `stack.ts:1068-1083` 相同，`dynamic` 为 undefined）。

### 2.3 与 runner / 看门狗 / deadline 的交互

- **切换期间没有新 phase**：边界提交在 pi 的 `finishTurn` 里同步完成（毫秒级），夹在 turn_end 与下一个 turn_start 之间。runner 看到的是普通的 `turn_end` → `turn_start` → `model_turn`。看门狗不会误判卡死，也不需要为切换加预算。
- **总预算 / deadline**：切换不延长也不重置任何 deadline（`deadlineAt/graceUntil/hardAt` 原样）。切换后第一次请求是新前缀的冷写入，受 `firstEvent/idle/modelTurn` 正常约束。
- **失败**：只有我们的 handler 自身会失败（草稿构造出错）⇒ 降级为提示消息，run 继续。pi 自动压缩（兜底）的失败沿用现状（`compaction_end` → `model_turn`，`session_compact_failed`）。
- **取消**：runner 取消 ⇒ `session.abort()`（同时 `abortCompaction`）⇒ `outcome=aborted` ⇒ handler 清槽不续轮。
- `prompt()` 全程不 resolve，runner 的最终文本仍取最后一条 assistant 文本（切换后继续干活产生的那条）。

### 2.4 子会话缓存保活 ping

**装配**（`src/cache-ttl/child.ts`，新）：

- 把 `wireCacheTtl` 里 `before_provider_request` / `before_provider_headers` 的 passthrough capture 与配对逻辑抽成共用 helper `createRequestCapture(port)`（`src/cache-ttl/cache-ttl.ts`，主会话行为不变）。子会话只做 capture，**永不改写 payload**。
- 在首个 `before_provider_request` 用事件 ctx 惰性构造 `createCacheKeepaliveService`，deps 为：
  - `backgroundBusy: () => false`（武装只看 activeTools）；`isCurrent: (self) => self === local`；不接 adaptive / `adaptiveCoversPrefix` / `switchImminent`；`emit` 不接。
  - `settings`：派生视图，`keepaliveUpgradeAfterBudget=false`（子会话没有 TTL 改写，1h 升级无从谈起），`intervalMs/maxPings/minPrefixTokens` 复用 `cacheTtl.*`。
  - 新 deps（见下）：`allowHeadless: true`、`maxSessionPings`、`acquirePingSlot`、`reportCost: true`、`statusBar: false`。
- 转发 `tool_execution_start/end`、`message_end`、`turn_end`、`agent_end`、`agent_settled`（→ `noteAgentSettled` + **dispose**），以及漂移事件 `model_select` / `thinking_level_select` / `session_compact` / `session_compact_failed`（子会话 pi 自动压缩时会发）→ `invalidate`。

**service / 纯函数改动**：

| 改动                                  | 文件                          | 说明                                                                                                                                                                                    |
| ------------------------------------- | ----------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `KeepaliveConfig.allowHeadless`       | `keepalive-state.ts:46, 378`  | 为 true 时 G2 额外放行 `"print"`；缺省 false ⇒ 今天的行为                                                                                                                               |
| `KeepaliveConfig.maxSessionPings`     | `evaluateTick`（`:417` 附近） | `session.pings >= maxSessionPings` ⇒ `skip("session-cap", true)`；缺省 `Infinity`                                                                                                       |
| 新 skip 原因 `"global-cap"`（非终态） | 同上 + service `onTick`       | 进入 `ping` 决策前 `acquirePingSlot?.()`，拿不到就 skip，15s 后重试；TTL 余量 45s 足够重试 ≥2 次                                                                                        |
| 陈旧 ctx 自毁                         | `cache-keepalive.ts:296-318`  | 每个 tick 先读 `ctx.mode`，抛错（会话已 dispose/invalidate）⇒ `dispose()` 并 return，早于其它任何闸门                                                                                   |
| 审计带成本                            | `audit()`（`:364`）           | 仅 `reportCost` 时：proven-hit 带 `costUsd = cacheReadCostUsd(model.cost, cacheReadTokens)` 与 `cacheReadTokens`；proven-write 带 `cacheWriteTokens` 与写入成本；主会话审计条目字节不变 |
| `statusBar:false`                     | `publishVisibility`/`dispose` | 子会话不写 status key                                                                                                                                                                   |

**全局并发槽**（`src/cache-ttl/ping-slots.ts`，新）：挂在 `Symbol.for("pi-subagent:child-keepalive-slots")` 的进程级 try-acquire 信号量。上限 `cacheTtl.childKeepaliveMaxConcurrent`，lease 带 30s 过期回收（ping 本身 20s 硬超时，`ping-client.ts:76`），`release` 放在 finally。**从不 await**，没有模块级状态，能挺过 `/reload`。

**成本计入子 run**：`src/runtime/session-driver.ts` 的 `mapEvent` 新增一条映射：`entry_appended` 且 `entry.type === "custom" && customType === "subagent:cache-keepalive" && data.costUsd > 0` ⇒ `{ t: "message_end", usage: { input:0, output:0, cacheRead, cacheWrite, costUsd } }`。这样 X9 累加器（`state-machine.ts:491-500, 719`）→ run 成本、fleet widget、HUD 实时子 agent 成本、`/agent costs` 全都自动包含，**状态机零改动**。副作用 `lastEventAt` 被刷新，这是无害的：ping 只在「请求不在途 且 有工具在跑」时发（`tool_exec` 的截止只看 `phaseEnteredAt`，`deadline.ts:72-73`），掩盖不了静默的 model_turn。测试会钉死这一点（T-K7）。

**终态**：① `agent_settled` ⇒ 立即 dispose（子会话一个 prompt 对应一次 settle；resume 会新建会话和实例）；② 陈旧 ctx 自毁（≤1 个 tick，15s 内，期间不会发出 ping）；③ 在 P3 里补一个进程级 `Symbol.for("pi-subagent:child-keepalive")` 注册表（sessionId → dispose），由 runner 的 `onReaped(runId, forkSessionFrom, sessionId)`（`runner.ts:274`，第三个参数已存在）经 runtime-adapter 转发调用，保证 reap 时同步 dispose。三条路径幂等。

**adaptive**：子会话禁用（也没有 TTL 改写通道）。理由：子会话由机器驱动，没有人类长空档，1h 入场费（plan §16.3）得不偿失；keepalive 与 adaptive 的相互依赖（§17-§20）也不带进子会话。

**与 pi 原生预热的关系**：若子会话模型声明了 `promptCache`（原生 `CacheWarmer` 有资格在 streaming 期间预热），子 keepalive 退让，新 skip 原因 `"native-warmer"`（终态），避免双 ping。本机 `cr-*` 路由没有 `promptCache`，所以实际仍由我们 ping。主会话的同类重叠不在本方案范围内，列入风险。

**成本估算**：每次 ping ≈ 0.1× 前缀的 input 价（cacheRead）；一次 miss 要付 1.25× 重写。每窗口 11 次（现有默认，按「ceil(T/4min)×0.1P < 1.25P」的保本线定的）对子会话同样适用。100k 前缀、sonnet 价位：单次约 $0.03，每 run 上限 24 次 ≈ $0.72，最坏总额 ≈ `concurrencyLimit × 24 × 0.1P`。

## 3. HOST_KEY、/reload 与惰性

- 装配入口只看 pre-guard 已有的 `isChildSession`（`src/index.ts:119`），不读也不写 HOST_KEY；主会话走 `isChildSession=false`，一行新代码都不执行。与 memory 共用同一个布尔，已知边界相同（`:115-118` 注释）。
- 所有状态都在 activate 闭包里（store、CompactHintState、keepalive 实例）；进程级只有两个 `Symbol.for` 注册表（并发槽、dispose 注册表），都不需要 reset（语义同 `child-registry.ts:16-27`）。
- 主会话 `/reload`：`session_shutdown` 会停掉所有子 run ⇒ 子会话 abort → `agent_settled`/dispose ⇒ 子 keepalive 自毁；在途 ping 被 abort；并发槽靠 lease 过期兜底。子会话自己从不 `/reload`。
- 设置用 `readSettingsNoMigrate`（子会话不写设置文件，review B1 约束）。

## 4. 设置（新增键）

| 键                                      | 默认   | 关闭（false/0）时                                           | 理由                                                                   |
| --------------------------------------- | ------ | ----------------------------------------------------------- | ---------------------------------------------------------------------- |
| `compact.childSessions`                 | `true` | 子会话不注册工具和 turn_end handler，runtime-adapter 不授予 | 用户明确要这个功能；另受 `compact.enabled && compact.switchTool` 约束  |
| `cacheTtl.childKeepalive`               | `true` | 子会话不注册 capture/keepalive，不写审计条目                | 有上限且经济上为正；另受 `cacheTtl.keepalive` 总开关约束               |
| `cacheTtl.childKeepaliveMaxPingsPerRun` | `24`   | `0` = 子会话不 ping                                         | 每窗口 11 次覆盖约 48min 的单次等待，24 覆盖两段长等待                 |
| `cacheTtl.childKeepaliveMaxConcurrent`  | `4`    | 钳到 [1, 32]                                                | 限流卫生（多个子会话同时 ping 时避开 429），与 `concurrencyLimit` 解耦 |

- 每窗口上限、间隔、最小前缀复用 `cacheTtl.keepaliveMaxPings/IntervalMs/MinPrefixTokens`，不新增。
- 常量（不做成设置）：`CHILD_MAX_SWITCHES = 5`、并发槽 lease 30s。
- 加载与钳位：`src/config/settings.ts`（接口 `:151-202` 附近、默认 `:534/:569` 附近、loader `:970-979` 附近）；`/agent settings` 通用树自动出现（实现时核对 `src/ui/settings-editor.ts`）。
- **关闭即字节级回到今天**：两个开关都 false 时，子会话 activate 零新增 `registerTool/pi.on` 调用；runtime-adapter 不授予；主会话所有路径不变。`RESERVED_TOOL_NAMES` 新增 `"switch_context"` 是无条件的，但今天子会话里不存在这个名字的工具（主会话注册在 post-guard），所以有效工具集不变（T-S9 断言）。

## 5. 零 hang 与 unref

- turn_end handler 全同步，**不 await 任何 I/O**（它阻塞的是 pi 的 finishTurn）；facts 收集、`findCutPoint`、组装都是同步纯函数。
- keepalive 定时器走 `systemClock.setTimer`（已 unref）；ping 有 20s 硬超时；重试退避可被 dispose 取消（`cache-keepalive.ts:385-406`）；并发槽 try-acquire 不 await。
- 子会话没有新的 ref 定时器，`pi -p` 退出不受影响（T-K8 在 print 模式跑完即退出）。
- 切换不引入任何「等压缩完成」的等待；pi 兜底压缩的等待由现有 `compaction` phase 预算约束。

## 6. 测试清单（全部为验收项）

| #    | 文件                                                                                  | 断言                                                                                                                                                                                                                                                             |
| ---- | ------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| T-S1 | `tests/context-switch/boundary.test.ts`（新）                                         | `buildChildSwitchDrafts`：keep_recent false ⇒ `firstKeptEntryId:null`；true ⇒ 等于 `findCutPoint` 结果，且保留段不以 toolResult 开头；appendix 含会话文件/todos/文件列表；details 标记                                                                           |
| T-S2 | `tests/tools/switch-context-tool.test.ts`                                             | boundary 模式：print 不拒绝、不调 `ctx.compact`/`sendUserMessage`、非 terminate、按 toolCallId 暂存；冷却 / in-flight / 5 次上限；compact 模式快照不变                                                                                                           |
| T-S3 | `tests/context-switch/child.test.ts`（新）                                            | handler：同 turn toolCallId 匹配 ⇒ 返回 compaction + resume 草稿 + continue；outcome aborted/error ⇒ 清槽、无草稿；下一 turn 未匹配 ⇒ 作废；异常 ⇒ 降级消息无 continue；长并行工具（FakeClock 前进 700s）仍能采用                                                |
| T-S4 | `tests/compact-hint/headless.test.ts`（新）                                           | `headless`：print 模式发 tick/hint/demand 草稿；demand 用尽后**从不**调 `ctx.compact`；最后一个 turn 不发；工具不活跃时整体不运行；动态阈值缺席                                                                                                                  |
| T-S5 | `tests/integration/compact-dynamic-off-golden.test.ts`、`compact-hint-wiring.test.ts` | 主会话路径逐字节不变（golden fixture 不重新生成）                                                                                                                                                                                                                |
| T-S6 | `tests/integration/child-context-switch.test.ts`（新，`sandboxHome()`）               | 预先认领 HOST_KEY 后 activate（`merged-plugins-wiring.test.ts:23` 模式）：注册 `switch_context` 与唯一 turn_end；不注册 `compact_context`/`set_compact_threshold`/`session_before_compact`；`compact.childSessions=false` ⇒ 零注册                               |
| T-S7 | `tests/integration/child-switch-runner.test.ts`（新）                                 | 用真实 `AgentSession`（faux provider）跑 runner：子 run 调 switch_context 后 **prompt() 不 resolve**、分支出现 `fromHook` compaction、下一请求上下文 = 交接+resume、run 以切换后的最终文本 `completed`；状态机无 `compaction` phase、看门狗未触发；deadline 不变 |
| T-S8 | 同上                                                                                  | 切换发生在总预算临近时：仍按原 deadline 超时（不延长）                                                                                                                                                                                                           |
| T-S9 | `tests/runtime/tool-scope.test.ts`、`tests/service/runtime-adapter*.test.ts`          | `switch_context` 属于 RESERVED；开关开且非 consult ⇒ 授予（含声明了 `tools` 的类型）；consult / 开关关 ⇒ 不授予                                                                                                                                                  |
| T-K1 | `tests/cache-ttl/keepalive-state.test.ts`                                             | `allowHeadless` 放行 print；缺省仍 `skip("mode")`；`session-cap` 终态；`global-cap` 非终态；`native-warmer`                                                                                                                                                      |
| T-K2 | `tests/cache-ttl/ping-slots.test.ts`（新）                                            | 上限、release 幂等、lease 过期回收、跨「模块实例」共享同一 Symbol 槽                                                                                                                                                                                             |
| T-K3 | `tests/cache-ttl/keepalive-child.test.ts`（新，FakeClock）                            | 工具在跑 ≥ interval ⇒ ping；工具结束 ⇒ 不武装；`agent_settled` ⇒ dispose（timer 清零，在途 ping abort，重试取消）；ctx 抛错 ⇒ 下个 tick 自毁且不发 ping；每 run 24 次上限；并发槽满时跳过并重试                                                                  |
| T-K4 | 同上                                                                                  | 审计 `costUsd`/tokens 仅在 `reportCost` 时出现；主会话审计条目字节不变                                                                                                                                                                                           |
| T-K5 | `tests/runtime/session-driver.test.ts`                                                | `entry_appended`（keepalive 审计且 costUsd>0）⇒ `message_end` usage；其它 entry 不映射                                                                                                                                                                           |
| T-K6 | `tests/integration/child-keepalive.test.ts`（新，`sandboxHome()`，fetch 桩）          | 子 run 阻塞工具期间 ping ⇒ run `usage.costUsd` 包含 ping 成本、fleet 成本同步；`cacheTtl.childKeepalive=false` ⇒ 零 capture 零条目；主会话 keepalive 不受影响                                                                                                    |
| T-K7 | 同上                                                                                  | ping 不会与在途请求重叠；`model_turn` 静默超时不被 ping 推迟（请求期间注入 ping 结果的边界用例）                                                                                                                                                                 |
| T-K8 | 同上                                                                                  | `onReaped` 路径 dispose；print 模式整进程无残留 ref 定时器（`process.getActiveResourcesInfo` 断言）                                                                                                                                                              |
| T-A  | 状态机矩阵 / 属性测试                                                                 | 不改状态机 ⇒ 现有矩阵原样通过（作为回归门禁）                                                                                                                                                                                                                    |

门禁：`format:check → typecheck → test → build` 在干净 worktree 全绿。

## 7. 包拆分与冲突预检

| 包                         | 内容                                                                                            | 文件                                                                                                                                                                                                                                                                                          | 依赖                       | 冲突点                                                                                                                                                                                                                                                                |
| -------------------------- | ----------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **P1 `child-ka-core`**     | keepalive 纯函数/服务的 deps、并发槽、capture helper 抽取、全部 4 个设置键                      | `src/cache-ttl/keepalive-state.ts`、`src/service/cache-keepalive.ts`、`src/cache-ttl/ping-slots.ts`（新）、`src/cache-ttl/cache-ttl.ts`、`src/config/settings.ts`；T-K1/2/4                                                                                                                   | —                          | `settings.ts`：bash P5 若还要加键则需 rebase（P0-P4 的键已合入，`settings.ts:124-128, 534-536`）                                                                                                                                                                      |
| **P2 `child-switch-core`** | boundary 纯函数、工具 boundary 模式、store 按 toolCallId 暂存、compact-hint `headless/getState` | `src/context-switch/boundary.ts`（新）、`store.ts`、`handoff.ts`（`fileListsFromBranch`）、`src/tools/switch-context-tool.ts`、`src/compact-hint/pi-settings.ts`、**`src/stack.ts`（仅 `createCompactHintHook` 区，`:668-700` 与 `:838` 附近约 20 行）**；T-S1/2/4/5                          | —                          | `stack.ts`：与 workflow-worktree P2（`worktreeEnabled` 接线）、bash P5（`buildSessionStack` 的 bash manager 与 `onStateChange`）改的区域不同，**合入前 rebase**；P1 ∥ P2 可以并行                                                                                     |
| **P3 `child-wiring`**      | 装配入口、子会话 context-switch / keepalive wire、授予、driver 映射、dispose 注册表             | `src/index.ts`（pre-guard 一行）、`src/child/wire.ts`、`src/context-switch/child.ts`、`src/cache-ttl/child.ts`（新）、`src/runtime/tool-scope.ts`、`src/service/runtime-adapter.ts`（grantedReserved + onReaped 转发 sessionId）、`src/runtime/session-driver.ts`；T-S3/6/7/8/9、T-K3/5/6/7/8 | P1、P2、**bash P5 已合入** | **必须串行在 bash P5 之后**：P5 同样改 `src/index.ts` pre-guard（`wireChildBashJobs`，在 `wireMemory` 之后）、`runtime-adapter.ts` grantedReserved（`bash_job` 授予）、`tool-scope.ts` RESERVED。和 workflow-worktree P2 同时在途时，`runtime-adapter.ts` 也要 rebase |
| **P4 docs**                | AGENTS.md（子会话能力段、`src/child/` 条目）、本文件实施记录                                    | —                                                                                                                                                                                                                                                                                             | P3                         | —                                                                                                                                                                                                                                                                     |

开工闸门（P3）：① `git log` 确认 bash P5 与 workflow-worktree P2 已合入，或确认它们对上述文件的最终 diff；② 用隔离 worktree 开发（`git worktree add -b child-ctx-p3 /tmp/ccp3 HEAD` + 软链 node_modules）；③ `git diff --stat <基线>..HEAD -- src/index.ts src/service/runtime-adapter.ts src/runtime/tool-scope.ts src/stack.ts`，有他人改动先 rebase；④ 只提交本包路径。

**给 bash P5 负责人的提醒**（本方案 §0-3 的发现）：子会话从不触发 `session_start`（driver 不调 `bindExtensions`），P5 §3.4 的「`session_start` 建 manager」需要实测验证，或改为惰性初始化 / 由 driver 显式 `bindExtensions({ mode:"print" })`。如果 P5 选择让 driver 调 `bindExtensions`，本方案的惰性初始化不受影响（仍然成立），但子会话会开始收到 `session_start`。届时要复核主会话侧所有 `session_start` handler 在子会话里是否惰性：它们都在 post-guard，子会话并不注册，所以只是提醒复核。

## 8. 风险

| 风险                                                         | 缓解                                                                                                                                                           |
| ------------------------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 边界草稿是 pi 0.87 的新接口，未来版本可能改变                | 只用文档化的 `SessionBoundaryDraft`；`src/adapters/pi-compat.ts` 加能力探测（`CompactionEntryDraft` 路径），探测失败 ⇒ 子会话不注册 switch_context（回到今天） |
| 切点落在 turn 中间，保留段语义怪                             | 交接文本本身写了 progress；T-S1 钉住保留段起点合法；默认建议模型用 keep_recent:false（boundary 版 guideline）                                                  |
| 子会话提示消息增加上下文 / 成本                              | 只在有工具结果的 turn 发；tick 网格与主会话同；最后一个 turn 不发                                                                                              |
| 每个子会话多一个工具（约 600 token 的 schema，走 cacheRead） | 可用 `compact.childSessions=false` 关；Q1                                                                                                                      |
| ping 成本经 `message_end` 刷新 `lastEventAt`                 | ping 与在途请求互斥 + `tool_exec` 截止与 lastEventAt 无关；T-K7 钉住                                                                                           |
| 主会话与 pi 原生预热的双 ping（已存在，本方案不处理）        | 子会话已退让；主会话另立项                                                                                                                                     |
| 多子会话同时 ping 触发 429                                   | 全局并发槽 + 现有重试/断路器（连续 2 次 / 累计 3 次 unproven 即停）                                                                                            |
| 一次切换后又被 pi 自动压缩（交接被通用摘要再压一次）         | 边界压缩后用量骤降，pi 阈值不会触发；只有交接本身超过窗口才会，`validateHandoff` 已有长度约束                                                                  |

## 9. 需用户确认

1. **默认值**：`compact.childSessions` 与 `cacheTtl.childKeepalive` 是否都默认开？**推荐：都开**（这是需求本意；两者都有上限，关闭即回到今天）。
2. **授予范围**：`switch_context` 是否授予所有非 consult 子 run（包括声明了 `tools` 白名单的 Explore 等只读类型）？**推荐：是**（只管理自身上下文，不带外部权限；短 run 用不到也只多一个 schema）。
3. **兜底策略**：子会话越过强制线、demand 用尽后，交给 pi 自己的自动压缩（通用摘要），不做扩展侧的强制压缩？**推荐：是**（扩展侧强制只能靠 abort，会结束 run）。
4. **保活上限与计费**：每窗口 11（复用）/ 每 run 24 / 全局并发 4，并且 ping 成本计入子 run 成本（fleet/HUD 可见）？**推荐：按此**。
5. **pi 原生预热**：子会话模型声明了 `promptCache` 时，子 keepalive 退让给 pi 原生预热？**推荐：退让**（避免双 ping；本机 `cr-*` 路由不受影响）。

## 用户确认（2026-09-26）

1. `compact.childSessions` 与 `cacheTtl.childKeepalive` **都默认开**。
2. 子会话 `switch_context` 授权给**除 consult 外的全部子 run**（含 Explore 等 tools 白名单类型）。
3. 兜底选 **A：只靠 pi 自身的自动压缩**，扩展侧不强制压缩、也不做提示升级。
4. 保活限额按方案：**每窗口 11 次、每 run 24 次、全进程并发 4 个**；ping 费用计入子 run 成本。
5. （第 5 问 promptCache 让位）按方案推荐执行。
