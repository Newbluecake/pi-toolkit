# 外部 CLI agent（droid 等）接入接缝调研报告

仓库：`/home/bluecake/ai/pi-toolkit`。分层：core（纯领域，无 pi 依赖）→ runtime（runner/driver/watchdog/reaper/pool/tool-scope）→ service（spawn/query/adapter）→ tools/commands/index.ts 装配。

## 1. 驱动抽象：SessionDriver / SessionHandle / DriverEvent

**契约坐标**

- `SessionDriver`：`src/runtime/session-driver.ts:236-244` —— `create(spec)` 必需；`resume?(sessionFile, spec)` 可选；`bind(handle, onEvent)` 必需；`onLateArrival(promise, cb)` 必需；`resolveModelRef?(provider, id)` 可选。
- `SessionHandle`：`src/runtime/session-driver.ts:152-235`。必需：`sessionId`、`sessionFile`、`prompt()`、`steer()`、`requestAbort()`、`dispose()`（同步返回 `DisposeReport`，`:148-151`）、`killableHandles`、`setActiveTools()/getActiveTools()`、`getLastAssistantText()`、`getUsage()`。可选：`measureInputBudget?`、`consultIdentityPrediction?`、`getToolSources?`、`getTurnError?`、`getModelRef?`、`setModel?`、`getThinkingLevel?/setThinkingLevel?`、`getSwitchTail?`、`getLeafId?`、`getBranchEntries?`、`observe?`、`childExtensionMissing?`。
- `DriverEvent` 联合类型：`src/core/types.ts:620-848`（`turn_start/turn_end/message_end{usage?,absorbedRunIds?}/context_usage/tool_start/tool_end/tool_update/retry_*/compaction_*/settled/text_delta/thinking_delta/model_changed/context_switch/compaction_failed/switch_*/exit_facts/final_leaf/child_extension_missing/dispatch_measure`）。
- `SessionSpec`（driver 实际消费的面）：`src/core/types.ts:1404-1463`；`KillableHandle`：`:1465-1469`；`UsageDelta`：`:608-613`。

**生产实现（PiSessionDriver/PiSessionHandle）**

- `PiSessionHandle`：`session-driver.ts:526-761`（薄封装 `AgentSession`；`killableHandles` 恒为空集 `:528` —— 全仓库无任何生产者 add，是为外部资源预留的缝）。
- `PiSessionDriver`：`session-driver.ts:814-1014`。
  - 模型解析：构造器注入 `resolveModel`（`stack.ts:1923` 接 `ctx.modelRegistry.find`）；`withResolvedModel()` `:825-838` 把 `{provider,id}` 急切解析为 pi Model，失败即 throw（fail-fast）；`resolveModelRef()` `:840`。
  - `create()` `:844-874`：`SessionManager.create/inMemory` → `markChildSession()`（`:62`，写 `subagent:child` 标记）→ activation 计数快照 → `toCreateOptions()`（`:799-812`，`systemPrompt` 经 `DefaultResourceLoader({systemPromptOverride})` 注入）→ `createAgentSession` → `installPrefixProbe` → new handle。
  - `resume()` `:875-963`：`SessionManager.open(sessionFile)`；consult C2 分支在 `createAgentSession` 后、`bind` 前跑 `consultGuard.preflight/install`，失败即 dispose 并 throw `[consult-preserve:<code>]`。
  - `bind()` `:964-1009`：先同步发 `child_extension_missing`（若 flagged）→ `session.subscribe` → `mapEvent()`（`:460-514`，导出）映射 pi 事件 → `message_end/compaction_end/context_switch` 后重采样 `context_usage`。`mapEntryAppended()`（`:388-444`）识别子会话扩展写的 custom entry（switch 自检/capability/rejected/keepalive 成本折成 `message_end{usage}`）。
  - `onLateArrival()` `:1010-1013`：`p.then(cb)` 容错。
  - prompt 拒绝解释：`explainPromptRejection()` `:767-797`（识别「子会话模型注册表过期」）。

**可选方法的降级路径（调用方现状）**

- `resume` 缺失：runner 拒绝 `"session driver does not support resume"`（`src/runtime/runner.ts:898-905`）。
- `measureInputBudget` 缺失：runner 用 `systemPrompt+tools+prompt` 字节数兜底估算（`runner.ts:975-990` 附近）。
- `getTurnError` 缺失：runner 拿不到 turn 错误（`runner.ts:1066` 附近，`handle.getTurnError?.()`）。
- `setModel/resolveModelRef` 缺失：`setModelForRun` 返回 `{ok:false, reason:"unsupported"}`（`runner.ts:470-500` 附近）。
- `getToolSources` 缺失：仅 readonly 域的 provenance 检查用，缺失即 fail-closed 剥离（`src/runtime/tool-scope.ts:206-235`）。
- `getSwitchTail` 缺失：结算自检回退跳过（`runner.ts:1076-1090`）。
- `getLeafId/getBranchEntries/observe` 缺失：`finalLeafId` 缺席（下游报 `leaf_unknown`）、`peekRunBranch` undefined、`observeRun` 返回 `no_session`（`runner.ts:575-660`）。

**对外部驱动的含义**：契约本身已是进程无关的窄接口；外部驱动可实现全量必需方法 + 按需可选方法。关键是 `dispose()` 必须同步、幂等、真正杀死子进程；`bind()` 的事件流决定 watchdog/用量/UI 的一切。

## 2. 谁持有驱动 + 完整调用链

- 构造：`src/stack.ts:1923` `new PiSessionDriver(settings.rememberAgents, (p,id)=>ctx.modelRegistry.find(p,id))`，注入 `createRuntimeRunnerAdapter`（`stack.ts:1921`）；adapter 把它装进 `RunnerDeps.driver`（`src/service/runtime-adapter.ts:455` 附近）→ `new RuntimeRunner(runnerDeps)`（`runtime-adapter.ts:505` 附近）。**全局唯一调用 `driver.create/resume/bind/onLateArrival` 的地方是 `RuntimeRunner.run()`**（`runner.ts:713` 起）：enqueued(`:730`)→ pool.acquire guard(`:760-790`)→ `driver.resume ?? create`(`:898-905`)→ `session_created` dispatch(`:935-950`，含 `markLiveSessionFile`)→ bind guard(`:953-965`)→ toolScope.onBind(`:1047`)→ watchdog.arm → `guardUntil(handle.prompt(...))` 跟随活 deadline(`:1055-1065`)→ `getLastAssistantText()/getTurnError()` → `sealBeforeTerminal`(`:680-712`，读 leafId + sealSession)→ `prompt_settled` → finally：late-arrival 处理、`beforeReap`+`reaper.reap`、`notifyReaped`。
- 上游链：Agent 工具 `execute` → `prepareSpawn`（`src/tools/agent-tool.ts:410-515`）→ `SpawnService.spawn()`（`src/service/spawn-service.ts:565`，准入：CC4/toolDomain/pool-full/类型/模型 hint/modelExists/quota/load/nesting/label/resume 锁/timeoutPolicy 解析）→ `start()`（`:458`）→ `RunnerSpec` → adapter `run()`（`runtime-adapter.ts:601`）→ 注入 customTools、H2 `resolveSessionSpec`、readonly 域强制、构造 `ResolvedSpawnRequest`（`:1130-1165`，`threadThroughRequestFields`）→ `runtime.run(req, budget)`（`:1165`）→ X10 host 端二次校验（`:1168`）。
- **最佳分派点**：`RunnerDeps.driver` 是 adapter 构造期单例，run 级分派最小爆炸半径的做法是一个 **router driver**（实现 `SessionDriver`，按 `SessionSpec` 上的新 `runtime` 字段把 `create/resume/bind` 转发给 `PiSessionDriver` 或 `DroidDriver`），在 `stack.ts:1923` 处替换构造。备选：在 `runtime-adapter.ts:601` 的 `run()` 里按 `spec.type.runtime ?? spec.request.runtime` 选 driver 再传给一个参数化的 RuntimeRunner —— 改动更大。router driver 方案下 runner/watchdog/reaper/状态机零改动。

## 3. 请求/类型入口：加 `runtime` 字段要改哪里

- Agent 工具参数：`agent-tool.ts:167-283`（`leadingFields`/`trailingFields`/`topLevelTrailingFields`；`AgentToolParams:283`、`NestedAgentToolParams:287`）；`prepareSpawn` 组装 `SpawnRequest`（`:410-515`）。
- `SpawnRequest`：`src/core/types.ts:337-560`；**每加一个字段必须同步**：`src/service/request-threading.ts` 的 `threadThroughRequestFields`（Gate C 编译期守卫，漏了会被类型系统抓住，但字段若不经它会被静默丢弃——注释见 `SpawnRequest.deadlineAt`/`parentRunId`）、`ResolvedSpawnRequest`（`runner.ts:46-105`，继承 SessionSpec 之外的部分要显式加）、`SessionSpec`（若 driver 需要看见，`types.ts:1404`）。
- agent 类型 frontmatter：`src/config/agent-types.ts:115-145`（`AgentTypeConfig`）、`parseFile()`（`:68-137`，加 `runtime:` 解析）、`configHashInput()`（`:46-59`，workflow journal 的 config hash 必须含 runtime，否则换 runtime 会错误命中回放）。
- 模型解析拦截点（外部模型不在 pi 注册表会死在哪儿）：
  1. 严格对解析 `parseStrictModelRef`（`src/config/model-hint.ts:49`）；
  2. spawn 准入 fuzzy hint 解析（`spawn-service.ts:640-680` 附近，`resolveModelHint`，不可解析即 config error）；
  3. spawn 准入严格对存在性 `deps.modelExists`（`spawn-service.ts:685` 附近；`stack.ts:2019-2030` 接 `registryModelExists`，`src/config/available-models.ts`）；建议文案 `suggestModelRefs`/`formatUnknownModelError`（`model-hint.ts:125/159`）；
  4. quota 闸门（`spawn-service.ts` quotaGate 段）；
  5. driver `withResolvedModel` fail-fast（`session-driver.ts:825-838`）；
  6. prompt 拒绝时 `explainPromptRejection`（`:767`）。

  **含义**：`runtime!="pi"` 的 run 必须在 spawn-service 准入层整体旁路 2/3/4（否则外部模型名必被拒），并改走 runtime 自己的模型语义（或干脆不允许 `model` 参数）。

## 4. 依赖「子会话加载了 pi-toolkit 扩展」的特性清单

| 特性                                                   | 挂载点                                                                                                                                                                                                                             | 外部驱动下的处置                                                                                                                                                                     |
| ------------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| StructuredOutput / schema                              | customTools 注入（`runtime-adapter.ts:770-790`）；工具 `src/tools/structured-output-tool.ts:1-61`；host 二次校验 `applyStructuredOutputPolicy`（`runtime-adapter.ts:1168`）                                                        | 无法注入工具。降级：prompt 里要求输出 JSON + host 端从 `getLastAssistantText()` 提取并走同一 validator；或拒绝带 schema 的派发（/goal verifier、tidy 依赖它，见 §8）                 |
| consult（含 C2 preserve、"main" 专家）                 | 工具注入 `runtime-adapter.ts:732-745`；fork pi 会话文件 `src/consult/fork-store.ts`、spawn 端口 `src/consult/tool.ts:164/:959`（要求 `expectAck:true`+`forkSessionFrom`）；driver resume 的 guard 分支 `session-driver.ts:875-963` | fork 的是 pi jsonl —— 外部 run 无此文件。**双向拒绝**：外部 run 不能当 asker（不注入 consult 工具）也不能当 expert（`resolveExperts` 处按 runtime 过滤）                             |
| message_agent（fabric）                                | 注入 `runtime-adapter.ts:700-730`（依赖 `runtime.getRunState` 取 generation）                                                                                                                                                      | 不注入；`can_message` frontmatter 失效                                                                                                                                               |
| 嵌套 Agent（canSpawn）                                 | 注入 `runtime-adapter.ts:747-765`；spawn-service 深度/白名单 `spawn-service.ts:695-725`                                                                                                                                            | 外部 CLI 不是 pi 会话，customTools 无处生根 → 声明了 `can_spawn` 的类型在 `runtime!=pi` 下应拒绝或忽略嵌套能力                                                                       |
| switch_context                                         | `grantedReserved.push("switch_context")`（`runtime-adapter.ts:800` 附近，`childSwitchContextGrant` live gate）；子会话侧 `src/context-switch/child.ts`；事件经 `mapEntryAppended`（`session-driver.ts:388-444`）                   | 无 turn_end hook → 永不 grant；相关 diag 事件天然不产生                                                                                                                              |
| bash settle-hold / bash_job                            | 子会话自身 activate：`src/index.ts:194-195` + `src/bash/child.ts`；grant 判定 `bashJobGrant`（`tool-scope.ts:bashJobGrant`）；seal 回调 `stack.ts:1981`（`sealSession`→`exit_facts`）；`onReaped` 清理 `stack.ts:1978`             | 子进程里没有 pi-toolkit → 全无；sealSession 返回 undefined 即可（runner 容忍）                                                                                                       |
| cache keepalive                                        | `src/cache-ttl/child.ts` + `child-registry.ts`；成本经 `CHILD_CACHE_KEEPALIVE_CUSTOM_TYPE` 折成 `message_end{usage}`（`mapEntryAppended`）                                                                                         | 无；成本只来自驱动自己上报的 usage                                                                                                                                                   |
| memory 注入                                            | pre-guard `wireMemory`（`index.ts:185`），child 只读                                                                                                                                                                               | 无系统提示注入；如需记忆，由 adapter 把内容拼进 prompt                                                                                                                               |
| tool-scope 只读域（consult / `toolDomain:"readonly"`） | enforcer 走 `handle.getActiveTools/setActiveTools/getToolSources`（`src/runtime/tool-scope.ts` 全文；`RESERVED_TOOL_NAMES`、`CONSULT_READONLY_TOOLS`）；runner 在 bind/turn_end/turn_start 触发（`runner.ts:953-965、1047`）       | 外部 CLI 无 pi 工具注册表 → enforcer 无意义；必须用 CLI 自有沙箱/只读标志实现，否则**拒绝** readonly 域请求                                                                          |
| set_model                                              | 注入工具 + `runtime.setModelForRun`（`runner.ts:470-500`），需 `handle.setModel` + `driver.resolveModelRef`                                                                                                                        | 缺方法即 `unsupported`；不注入工具                                                                                                                                                   |
| child_extension_missing 诊断                           | `src/child/activation-signal.ts`；判定 `computeChildExtensionMissing`（`session-driver.ts:78`）；bind 发事件（`:968-969`）；文案 `formatChildExtensionMissing`（`src/tools/result-text.ts`）                                       | pi 专属语义，外部驱动不要置 flag（或另立 diag 字段区分「不适用」与「缺失」）                                                                                                         |
| input-budget 测量                                      | runner 注册 `getInputBudgetRegistry().register`（`runner.ts:1000-1045`）；payload 实测由子会话扩展回调 `src/child/wire.ts:38`；preflight 用 `handle.measureInputBudget?.()`                                                        | 只有 preflight 兜底估算；飞行中 payload 测量/中止不可用；`handle.childExtensionMissing` 为 true 时带 budget 的 run 直接 failed(config)（`runner.ts:966-975`）——外部驱动切勿置该 flag |

## 5. 防卡死与清理

- **Watchdog**：`src/runtime/watchdog.ts` —— 1Hz tick（`:48-70`），`timerReason` 映射（`:20-33`）：queue→queue_timeout、startup→session_create、bind→extension_bind、first_event→no_first_event、idle/tool→idle、compaction、total/total_grace/abort_grace/reap→total。到期时间由 `dueAtFor(phase, diag, budget)`（`src/core/deadline.ts`）从 diag 读出，依赖事件：**idle 需要任意事件刷新 `lastEventAt`**（text_delta 即可）；tool 子阶段需要 `tool_start` 置 `currentTool`；compaction 需要 `compaction_start`；turns/相位迁移需要 `turn_start/turn_end`；`prompt_dispatch` 后 firstEventMs 内必须见**任意第一个事件**，否则按 no_first_event 杀掉。**外部驱动最低事件集**：prompt 后立刻发一个事件（如 `turn_start`）、周期 `text_delta`、`message_end{usage}`、`tool_start/tool_end`、`turn_end`。
- **Reaper**：`src/runtime/reaper.ts:85-175` `EscalatingReaper.reap`：L0 `cancel.cancel("reap")` → L1 `handle.steer("wrap up now")`（bounded min(steerMs, abortGraceMs)）→ L2 `handle.requestAbort()`（bounded abortGraceMs）→ L3 `handle.dispose()`（同步）→ L3p 遍历 `killableHandles` 逐个 `kill()`；失败入 `MemoryOrphanRegistry`。注意 L1 会真的调用 `steer` —— 外部 CLI 不支持 steer 时 `steer()` 应实现为立即 resolve 的 no-op（不要 throw/悬挂）。
- **外部子进程可靠清理的硬性要求**：`requestAbort()` → SIGTERM（进程组）；`dispose()` 同步幂等、关闭 stdio、reap 子进程；`killableHandles` 注册 `{kind:"process", kill: ()=>process.kill(-pid,"SIGKILL")}` 兜底（这个集合目前全仓库无生产者，`session-driver.ts:528`，就是为外部资源留的）；子进程 `detached:true` 自成进程组；所有 timer `unref()`、stdio 在 dispose 后销毁（print 模式 `pi -p` 不能被子进程/计时器挂住，AGENTS.md 硬性规则）。
- **late arrival**：`driver.onLateArrival` 必须实现（runner `:917-922` 与 finally `:1190-1203`），保证 create 超时后迟到的句柄被 `reaper.disposeLate` 同步销毁——外部驱动里意味着进程已 spawn 但会话未就绪时被杀了要收尸。

## 6. 用量/费用/诊断

- 累积：`accumulateUsage`（`src/core/state-machine.ts:46-58`）；`message_end` 在非终态分支 `:885-911`、终态后仍累积 `:535-552`；`finish()` 把 `diag.usage` 拷进 `outcome.usage`（`:367-390`）。成本在驱动反腐层钳成有限数：`mapUsage`（`session-driver.ts:287-305` 附近，`cost.total→costUsd`，NaN 归零——外部驱动上报 usage 时必须自己保证有限数，否则 fleet 会出现 `$NaN` 的同类事故）。X12 `absorbedRunIds` 由 `toolResultRunIds`（`session-driver.ts:424-457`）从 toolResult details 提取，外部驱动若不支持嵌套 run 吸收则永远不填。
- 展示依赖：进度行 `buildProgressLines`（`src/tools/agent-tool.ts:75-100`，用 `diag.model/turns/usage.costUsd/toolHistory/argsPreview/text`）；汇总 `formatOutcomeSummary`（`:112-134`）；`get_subagent_result`（`src/tools/result-tool.ts:124-174` usage 去重上报 pi、`:393-467` 字段；尾部 `formatExitFacts/formatContextSwitches/formatChildExtensionMissing` 来自 `src/tools/result-text.ts`）；fleet widget/web-hub 读 diag 各字段（含 `finalLeafId` 用于 transcript 抽屉，`runner.ts:680-712` seal 时写入）。**工具调用要显示出来**，外部驱动必须把 CLI 的工具事件映射成 `tool_start{toolCallId,toolName,argsPreview}/tool_end`（进 `toolHistory` 环，cap `TOOL_HISTORY_CAP=30`，`state-machine.ts:65`；`argsPreview` 生成参考 `previewToolArgs`，`session-driver.ts:316-360` 附近）。
- transcript/runlog：终态快照 + journal 经 `wrapWithRunLog` 写 `subagent:run` custom entry（`src/adapters/pi-run-log.ts:26-70`，`RUN_CUSTOM_TYPE:11`）；子会话文件本身由 pi 持久化（驱动写 `subagent:child` 标记，`session-driver.ts:62`）。外部驱动没有 pi 会话文件 → `truncateResultText` 的「full session transcript」后缀（`result-text.ts:40`）和 resume（§7）依赖 `diag.sessionFile`；**外部驱动应把自己落盘的 transcript 路径作为 `handle.sessionFile` 返回**（它只被当 opaque 路径用：existsSync/statSync、resume 时回传给 `driver.resume`）。

## 7. resume / sessionFile

- `handle.sessionFile` → `session_created` 输入 → `diag.sessionFile`（`state-machine.ts:832、844-848`）→ 随 `subagent:run` 终态条目 + journal 持久化 → `resolveResumeTarget`（`src/service/resolve-target.ts:67-78` `snapshotWithSessionFile` 等）找回 → spawn resume 分支加锁、`isLiveSessionFile` 检查（`spawn-service.ts:770-830` 附近）→ runner `openFile = req.forkSessionFrom ?? req.resumeFrom` → `driver.resume(openFile, req)`（`runner.ts:898-905`）→ `PiSessionDriver.resume` 用 `SessionManager.open`（`session-driver.ts:877`）。timeoutPolicy 经 resume 继承（`resolve-target.ts` 的 `timeoutPolicy` 字段）。
- **外部会话 id 放哪**：`driver.resume(sessionFile, spec)` 的第一个参数是字符串路径；外部驱动可以让 `sessionFile` 指向自己管理的文件（内含外部会话 id），或直接把外部会话 id 编码进路径。无需改 core——SpawnRequest/ResolvedSpawnRequest 全程把它当 opaque 字符串。注意 `resolveResume` 准入会 statSync 该路径，所以文件必须真实存在。

## 8. 各 spawn 入口对外部驱动的适配矩阵

| 入口                                     | 坐标                                                                                                 | 外部驱动可行性                                                                                                                                                                                                       |
| ---------------------------------------- | ---------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 顶层 Agent 工具（background）            | `src/index.ts:463` 注册；`agent-tool.ts:537` `spawnInBackground`                                     | 天然可用（准入层旁路模型检查后）。`isolation:"worktree"` 是 H2/H3 扩展（`src/extensions/worktree.ts:258` resolveSessionSpec 改 cwd、`:370` beforeReap 提交 git）——**runtime 无关**，外部 CLI 只要在 cwd 里干活就可用 |
| 嵌套 Agent（canSpawn 注入）              | `runtime-adapter.ts:747-765`                                                                         | 不可用（父 run 是外部 CLI，无 customTools 注入点）；pi 父 → 外部子 OK                                                                                                                                                |
| workflow `agent()`                       | `src/workflow/host.ts:1323` → `src/workflow/spawner-adapter.ts:88` → `SpawnService.spawn`            | 天然可用（固定 deadline、占 slot）；前提是类型注册表里有 runtime 标记的类型，且 `configHashInput` 纳入 runtime 字段                                                                                                  |
| consult                                  | `src/consult/tool.ts:164/:959`（fork pi 会话文件）                                                   | **必须拒绝**（双向，见 §4）                                                                                                                                                                                          |
| `/goal` verifier                         | `src/goal/hook.ts:223-268`，`spawnAndWait` + `schema`                                                | 取决于 schema 降级方案（§4 第 1 行）；无 StructuredOutput 等价物则拒绝                                                                                                                                               |
| `/mem tidy`                              | `src/memory/tidy/command.ts:333-342`、`batch-command.ts:592-602`（`toolDomain:"readonly"` + schema） | 只读域无法强制 → 拒绝，除非 CLI 有可靠只读模式                                                                                                                                                                       |
| RPC spawn / @mention / cron              | `src/rpc/server.ts:111`、`src/fabric/mention.ts:60`                                                  | runtime 无关，准入过了即可                                                                                                                                                                                           |
| steer_subagent                           | `runner.ts` `steerRun`（`handle.steer`）                                                             | 多数 CLI 不支持中途 steer → `steer()` no-op + 工具层提示，或在外部 run 上拒绝                                                                                                                                        |
| extend_subagent_timeout / abort_subagent | `runner.ts:382-460`（纯状态机 + cancel）                                                             | 天然可用（不碰会话能力，只需要 cancel/kill 可靠）                                                                                                                                                                    |

## 9. 测试里的驱动替身与一致性测试模式

- **最小 SessionHandle 工厂**：`tests/runtime/runner-session-hooks.test.ts:50` `handle(overrides)` —— 新驱动测试直接照抄。
- **fake SessionDriver 范式**（捕获 spec / 脚本化事件 / late arrival）：`tests/service/runtime-adapter-x3-x10.test.ts:107`（及 `:550` `capturingDriver`）、`runtime-adapter-readonly-domain.test.ts:76`、`runtime-adapter-consult.test.ts:72`、`extension-hooks.test.ts:103`（验证 H2 改写后的 spec 到达 driver）、`deadline-cap.test.ts:122+`、`timeout-policy.test.ts:80`、`runtime-adapter-child-switch.test.ts:105`、`runtime-adapter-set-model.test.ts:94`、`h2-failure-visibility.test.ts:63`。runner 层：`tests/runtime/runner-*.test.ts`（13 个文件，配 FakeClock 驱动 deadline）。
- **PiSessionDriver 自身的真机单测**：`tests/runtime/session-driver.test.ts`、`session-driver-system-prompt.test.ts`、`session-driver-child-marker.test.ts`、`session-driver-consult-preserve.test.ts` —— 新驱动可对照建 `droid-driver.test.ts`（假 CLI = 一个吐 NDJSON 的 shell 脚本/node 子进程，断言事件映射、killable、dispose 幂等）。
- **conformance 模式**：`tests/conformance/`（`npm run test:conformance` 单独跑；非全量门禁但升 pi peer 前必跑）。核心范式：`pi-boundary.test.ts:1-60` —— 真实 `createAgentSession` + 假 `ModelRuntime`（`streamSimple` 返回 `createAssistantMessageEventStream` 脚本化事件），不经网络；`steer-hold-ref-driver.ts` 是「参考实现 diff」范式（内联重实现 + 真实实现互相对拍）；`consult-preserve.test.ts` 用真实 pi + 本地 Anthropic stub 做 C1-C7 硬门。外部驱动的一致性测试建议照 `pi-boundary` 的「真组件 + 假对端」结构：真 droid CLI + 假模型后端（若 droid 支持自定义 endpoint），或真驱动 + 假 droid 二进制。
- 集成参考：`tests/integration/rpc-spawn.test.ts`（真 pi 全链路 spawn）、`child-bash-jobs-real-session.test.ts`、`child-context-switch.test.ts`。

## 推荐的接入点（按优先级）

1. **`runtime` 字段贯通**：`AgentTypeConfig.runtime`（frontmatter `runtime:`，默认 `pi`）→ `SpawnRequest.runtime?`（可选覆盖）→ `request-threading.ts` → `ResolvedSpawnRequest`/`SessionSpec.runtime` → `configHashInput` 纳入。这是最上游、一次到位的事实来源。
2. **router driver**（新增 `src/runtime/external/driver-router.ts`）：实现 `SessionDriver`，按 `SessionSpec.runtime` 转发；`stack.ts:1923` 处由 `new PiSessionDriver(...)` 换成 router。runner/watchdog/reaper/状态机/持久化零改动。
3. **spawn 准入旁路**（`spawn-service.ts:640-700` 区域）：`runtime!="pi"` 时跳过 hint/modelExists/quota（或换成 runtime 专属检查），未知类型检查不变。
4. **runtime-adapter 注入门控**（`runtime-adapter.ts:601` 的 `run()`）：`runtime!="pi"` 时跳过全部 customTools 注入与 reserved grants、跳过 toolScope enforcer（或换外部等价物）、schema 走「prompt 指令 + host 端文本提取 + 同一 validator」降级。
5. **DroidDriver**（新增 `src/runtime/external/droid-driver.ts`）：child_process spawn（detached 进程组）+ NDJSON 事件流 → DriverEvent 映射；`killableHandles` 首个真实生产者；`sessionFile` 指向自管 transcript；`dispose` 同步幂等收尸。

## 必须新增/修改的文件清单（预估）

**新增**

- `src/runtime/external/droid-driver.ts`（SessionDriver/SessionHandle 实现 + 进程管理 + 事件映射）
- `src/runtime/external/driver-router.ts`（按 runtime 分派）
- `src/runtime/external/events.ts`（droid NDJSON → DriverEvent 纯函数，可单测）
- `tests/runtime/external-droid-driver.test.ts`、`tests/runtime/external-driver-router.test.ts`
- `tests/conformance/droid-driver.test.ts`（真 droid + 假后端 / 假 droid 二进制）
- `docs/dev/external-agent/{plan.md,explore-seams.md}`

**修改**

- `src/core/types.ts`（`AgentTypeConfig.runtime`、`SpawnRequest.runtime?`、`SessionSpec.runtime?`；可能加 `DiagSummary`/展示徽标字段）
- `src/config/agent-types.ts`（frontmatter 解析 + `configHashInput`）
- `src/service/request-threading.ts`（字段贯通，Gate C 会编译期强制）
- `src/service/spawn-service.ts`（准入旁路 + 外部 runtime 的 consult/experts/readonly 拒绝）
- `src/service/runtime-adapter.ts`（注入门控、schema 降级、toolScope 跳过）
- `src/stack.ts:1923`（router 构造）
- `src/tools/agent-tool.ts`（可选：Agent 工具加 `runtime` 参数或仅靠类型 frontmatter）
- `src/tools/result-text.ts` / `fleet-widget`（可选：runtime 徽标）
- `src/consult/index.ts`（resolveExperts 按 runtime 排除外部 run）
- `src/core/state-machine.ts` 预计**不动**（事件驱动设计已兼容）；若外部运行无法提供 turn 概念，需确认 `turns` 计数与 `model_turn` 相位的退化行为可接受。

---

## 10 行摘要

1. 驱动契约已天然分层：`SessionDriver`（session-driver.ts:236）+`SessionHandle`（:152）+ 纯数据 `DriverEvent`（types.ts:620），唯一生产实现是 `PiSessionDriver`（:814）。
2. 全局只有 `RuntimeRunner.run()`（runner.ts:713）调用 driver；驱动由 stack.ts:1923 构造、经 runtime-adapter 注入 —— **router driver 是最小改动的分派点**。
3. 加 `runtime` 字段要动 types.ts、agent-types.ts（含 configHashInput）、request-threading.ts、spawn-service 准入、runtime-adapter 注入门控。
4. 外部模型会死在三层：spawn 准入 hint/modelExists（spawn-service.ts:640-700）、driver `withResolvedModel`（session-driver.ts:825）、quota 闸门 —— 非 pi runtime 须整体旁路。
5. 依赖子会话扩展的特性（consult/message_agent/嵌套 Agent/switch_context/bash_job/keepalive/memory/tool-scope 只读域）全部不可用；schema 只能降级为「文本提取 + host 端校验」；consult 与 readonly 域必须拒绝。
6. watchdog 子阶段靠事件续命：外部驱动至少要发 turn_start/text_delta/message_end{usage}/tool_start/tool_end/turn_end，否则 first_event/idle 超时杀 run。
7. reaper 五级升级（reaper.ts:85）依赖 `dispose()` 同步收尸 + `killableHandles`（目前无生产者，专为外部资源预留）+ SIGTERM/SIGKILL 进程组；print 模式要求全部 timer/子进程 unref。
8. usage 由 `message_end` 事件累加（state-machine.ts:46），成本必须在驱动侧钳成有限数；外部工具调用映射成 tool_start/tool_end 即可进 fleet/进度行。
9. `sessionFile` 全程 opaque：外部驱动返回自管 transcript 路径即可接通 resume（`driver.resume`）与「full session transcript」展示。
10. 测试照抄点：最小 handle 工厂 tests/runtime/runner-session-hooks.test.ts:50；conformance 范式 tests/conformance/pi-boundary.test.ts（真组件 + 假模型后端）。

（再次提示：因只读约束，以上内容未写入 `docs/dev/external-agent/explore-seams.md`，请将其落盘。）
