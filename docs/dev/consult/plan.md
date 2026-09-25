# consult：轮内同步请教 —— 实施方案 v3.1

> 状态：**v3.1（施工收口版）**，按针对性核验 `review-3.md`（「有条件通过」：无阻塞 / 无严重 + 6 一般 + 4 建议）逐条处置，10 条见 §15；v3 按复评 `review-2.md`（1 阻塞 + 3 严重 + 11 一般/建议）修订，15 条见 §14；上一轮 `review-1.md` 的 21 条处置见 §13。输入：`requirements.md`（F1–F7、§6 开放问题）、`explore-handoff.json`（代码探索交接包）、`review-1.md` / `review-2.md` / `review-3.md`（评审，含「已核查项」）。
> v2 相对 v1 的主轴变化：**fork 由工具侧同步完成、经受信字段交给既有 `driver.resume` 接缝**（删掉了 `driver.fork` 三态分派）；**spawn 准入为 fork 请求开专用分支**（跳过 canSpawn）；**experts 白名单在派发时即解析成 runId**；**新增轮次/成本/并发/上下文预检四道闸门**；**专家工具集 v1 默认只读工具域（方案 B，用户已最终确认，见 §12）**，P0 探针实测后再决定是否加 `consult.expertTools` 旋钮（§5.4）。
> v3 相对 v2 的主轴变化：**consult 工具改为 `spawn()` 拿 runId + `waitOutcome()` 等结果**（显式 `expectAck:true`，先例为顶层 Agent 工具），watcher 才挂得上活着的 run；**`onReaped(runId, forkSessionFrom?)` 由 runner 直接从请求取路径删除，`pendingDeletions` 删除**，清理竞态从结构上消失（§4.4）；**请教 run 在 H2 之后强制 `sessionSpec.tools = CONSULT_READONLY_TOOLS`**（pi 层 allowlist 与 toolScope 同源，§5.4）；**P0 拆为阻塞级 α（含 provider 兼容性矩阵）与决策级 β**（§11-1）；**成本帽只在 turn 边界判定 + fork 前首轮成本预检**（§4.1/§4.6）。
> v3.1 相对 v3 的变化（全部为口径收口，无架构变动，逐条见 §15）：**被帽中止映射到既有 `StopCause="user_stop"`，`src/core/types.ts` 的 `StopCause` 与状态机转移矩阵/属性测试零改动**（#1）；**`forkExpertSession` 改为返回结果对象、fork 失败走 nack**（#2）；**C1 桩与 `sessionSpec.tools` 同源生成、构造失败整体回退纯 B**（#3）；**成本闸门拆成 `maxFirstRequestUsd`（预检，默认 $2）+ `maxCostUsd`（累计帽，默认 $4）**，`maxTurns` 不再被恒压为 1（#4）；**`matchRunId` 导出并进冻结面**（#5）；**P0-α② 判定标准改为可机械判定、必测路由改为动态求并集**（#6）；单价计 `ModelCost.tiers` 且 `priceOf` 在 stack.ts 内用 pi 的 `Model` 类型窄化（#7）；§4.4 早退路径理由更正（#8）；§5.1 sweep 多进程安全论证（#9）；§13 #3 行与 watcher 判据理由措辞更正（#10）。
> 所有行号引用以评审「已核查项」+ 本次抽验为准（施工前以符号名为准重核）。

## 1. 背景与目标

多 agent 串行协作中，下游 agent 需要上游掌握但环境里读不到的知识（已拍板决策、被否决方案及理由、用户偏好）。
实验（fabric-v2 baseline §15/§17/§19）证明：**轮内同步请教**是唯一被验证有效的获取形态（自发请教 8/8，质量 2.25→7.0）。
本方案落地最小形态：专用工具 `consult({ expert, question })`，fork 已结束专家的会话副本，同一次工具调用内返回答案。

约束（来自 AGENTS.md 与需求 §5）：零挂死不变量（分层 deadline + watchdog + reaper + 可确认投递）、timer 全 unref、
无模块级可变状态（`/reload` 同进程重激活）、HOST_KEY 守卫、TS strict 全套、typebox 参数、pi peer `>=0.84.0 <0.86.0`。

**v1 非目标**（评审 #14 决议）：`SubagentWorkflow` 派发路径不支持 `experts`（`workflow/spawner-adapter.ts:46-60` 逐字段组装，穿透留待后续）；主会话不注册 consult 工具。**已被 `docs/dev/workflow-experts/plan.md` 解除**（v2，2026-09）：workflow 子 run 现在可以挂 `experts`，但规则比顶层更严——只接受 completed 且有持久化 session 的调用（`resolveExperts` 新增 opt-in `completedOnly` 选项），带 experts 的调用及其后续提交的调用不参与 journal 回放。

### F1–F7 回应总表

| 需求                                                             | 方案落点                                                                                                                                                                                                                                                                                                                                                                           |
| ---------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| F1 专用工具、expert 只指向已结束持久化 run、无「新起 agent」退路 | `consult` 工具（§4.1）；白名单在 `Agent({experts})` 派发时即解析校验（§4.2/§5.3），解析不到或有歧义当场 throw 配置错；consult 时解析缺失/会话缺失/类型已删/仍在运行一律 nack，**从不** spawn 全新会话（fork 是唯一建会话路径）                                                                                                                                                     |
| F2 不污染、可并发                                                | `SessionManager.forkFrom` 静态 fork（新 id + `flag:"wx"` + parentSession 溯源 + 原文件零写入，§5.1）；**fork 由工具侧同步完成**、fork 副本经 `driver.resume` 接缝打开（§4.4）；并发请教同一专家 = 各自 fork 各自文件                                                                                                                                                               |
| F3 跨 `/reload` 可用                                             | `ExpertIndex` 从主会话 `subagent:run` 条目重建（§4.5/§5.3）；白名单在派发时解析成 `{runId, sessionFile}` 存进 `SpawnRequest.consultExperts`，consult 按 runId 匹配；reload 后 live 与 index 对同一 label 命中不同 runId 时**报 ambiguous**，不会问错人（§4.5）                                                                                                                     |
| F4 有界、零挂死                                                  | 显式 `budgetOverride.totalMs` 硬顶（默认 150s）+ **轮次上限 maxTurns（默认 3，turn 边界判定）+ 成本双闸（`maxFirstRequestUsd` 默认 $2：fork 前首轮预检；`maxCostUsd` 默认 $4：turn 边界累计帽）+ 提问方级并发上限（默认 2）+ 全局 in-flight 上限（常量 8）+ 专家上下文占用预检（≥75% 快速 nack）**（§4.1/§4.6/§5 F4）+ 现有 watchdog/reaper 全覆盖 + 真 parentRunId 级联中止（§7） |
| F5 回答格式                                                      | 问题 prompt 注入「结论先行、≤N 字、只有只读工具」指令 + `truncateResultText` 硬截断兜底（**不传 sessionFile**，§5.5）；超时/被帽有已流出文本时返回部分答案（§4.1）；**专家 run 默认只读工具域（方案 B，用户已最终确认，§5.4/§12）**                                                                                                                                                |
| F6 可观测、不打扰                                                | parentRunId = 提问方真 runId → CC2 三路径通知抑制自动生效 + fleet 嵌套行自动出现 + 成本经工具结果 usage 回传 + `details.toolCounts`（§8）；顺手修 `notifyTerminalFailure` 缺口（理由已更正，§6 包 B-6）                                                                                                                                                                            |
| F7 谁能被问、谁能问                                              | `Agent({ experts: [...] })` 派发时白名单 + **派发时解析校验**（写错立即报错给调度方）；顶层与嵌套 Agent 工具都接 `resolveExperts`，未接的上下文传 experts 显式 throw（§4.2）；consult 只注入给带白名单的子 run；主会话与工作流派发 v1 不支持（§5.2）                                                                                                                               |

## 2. 现状摘要（与方案相关的既有件）

- **resume 全链路**（`src/tools/agent-tool.ts:288` → `src/service/spawn-service.ts:371-418` → `src/runtime/runner.ts:465-469` → `src/runtime/session-driver.ts:324-331`）：`driver.resume` 用 `SessionManager.open(sessionFile, undefined, cwd)` 打开既有文件再注入 `createAgentSession`。**fork 副本就是一个「既有会话文件」，直接复用此接缝，driver 零改动。**
- **pi SDK fork 能力**（`session-manager.js:1237-1276`，评审已核查）：`static forkFrom(sourcePath, targetCwd, sessionDir?, options?)` 同步执行——读源条目、在 `sessionDir` 下用 `flag:"wx"` 写新文件（新 id、header 带 `parentSession=源路径`）、逐条 append、返回新实例；**源文件零写入**，F2 论证成立。实例构造时会再全量读一遍 fork 文件（`_setSessionFile`，`:1275`），`driver.resume` 的 `open` 又读一遍（`session-driver.ts:326`）——一次请教同步整读会话文件三遍（评审-2 #14，§11-2）。
- **spawn 准入的 canSpawn 闸**（`spawn-service.ts:343-363`，位于所有状态写入之前）：`parentRunId` 在 nesting 里查得到就要求 `parent.canSpawn?.includes(req.type)`，否则返回 `config` 错误「nested delegation is not permitted」。**nesting 条目的 canSpawn 取自被派 run 自己的类型注册**（`:439` `...(config.canSpawn ? { canSpawn: config.canSpawn } : {})`）——请教 run 用专家类型，会继承专家的 canSpawn（评审-2 #6，§4.4 修）。
- **`spawn()` / `spawnAndWait()` / `waitOutcome()`**（`spawn-service.ts:34-37, 454-516`）：`spawnAndWait` = `spawn({...req, expectAck:true})` + 等 `outcomes` Map/waiter，只返回 `Promise<RunOutcome>`，**调用方在 run 结束前拿不到 runId**（`agent-tool.ts:20-23` 的 `NestedSpawnPort` 同形）；准入错误 → **throw**（`:456`）。`waitOutcome(runId, waitMs?)`：`outcomes` 已有即刻返回（**run 已结束也能取到**），否则挂 waiter；`waitMs` 省略则不起 timer；两条路径都调 `onOutcomeAcked`。**先例**：顶层 Agent 工具前台路径 `spawn({...baseRequest, expectAck:true, signal})` → `progress.waitOutcome(runId, …)`（`agent-tool.ts:343, 366`；端口接线 `src/index.ts:282-294`）。
- **label 注册表**（评审-1 #5/#11）：`labels` 是进程内 Map、只写不删；`deriveUniqueLabel` 只和当前 Map 比较，base ≤36 码点、最多 999 个后缀（`core/labels.ts:4-6`）。⇒ reload 后同名 label 会撞、consult 高频调用会耗尽显式 base 的后缀空间。对策：白名单派发时解析成 runId（label 仅显示用），live/index 跨源同名报 ambiguous（§4.5）；consult run 的 label base 带随机后缀（§4.1）。
- **resumeLocks 双键**（`spawn-service.ts:411-416`）：targetId + sessionFile；`Agent({resume})` 续跑是**新 runId、同一 sessionFile**——consult 的「仍在运行」判断必须同时按 sessionFile 查（§4.5）。
- **run 记录持久化**：`wrapWithRunLog`（`src/adapters/pi-run-log.ts:24-40`）把终态 RunSnapshot 整体 `appendEntry("subagent:run", snapshot)` 进**主会话**文件；`buildSessionStack` 的 `prefetchedEntries`（`src/stack.ts:850`）含这些条目，读取形状 `entry.type === "custom" && entry.customType === "subagent:run"`、负载在 `entry.data`（fabric 树 `stack.ts:263-273` 为先例）。`getEntries()` 返回全部 fileEntries、`open()` 全量加载（`session-manager.js:982-984`）。
- **runtime-adapter 注入与会话规格**（`src/service/runtime-adapter.ts`，均已抽验）：
  - `buildPrompt`（`:202-206`）：append 模式且有 `systemPrompt` 的类型，把**类型整段任务指令**拼在 `request.prompt` 前（评审-2 #5）；
  - sessionSpec 构造：`tools: spec.type.tools`（未声明则不设）；
  - 注入：message_agent（`:426`，`deps.fabric` 时）/ set_model（`:462`，无条件）/ 嵌套 Agent（`:470-484`，`spec.type.canSpawn?.length` 时；**不带 `resolveExperts`**）/ StructuredOutput（schema 时）；M1 合并（`sessionSpec.tools && grantedReserved.length`）；
  - H2 `resolveSessionSpec`（M1 之后调用，`extensions/registry.ts:44-50`，现只有 worktree 扩展，只处理 `isolation`）；
  - toolScope 构造在 H2 之后：`buildToolScopePolicy({ tools: spec.type.tools, granted })`；
  - `RuntimeRunner` 在 adapter 内构造（`:324`），runnerDeps 的 `onStateChange`（`:307-318`）**同步**回调 perRun onSnapshot → spawn-service `deps.onSnapshot`；
  - `settleConfigFailure`（deadlineAt 过期、H2 失败）在 runner 之前返回——**这些路径不经 runner finally**。
- **pi 层工具激活**（`sdk.js:139-144`、`agent-session.js:2098-2160`，评审-2 已核查）：`options.tools` 未设时默认激活 `read,bash,edit,write`（或 settings 的 defaultTools）；**grep/find/ls 只有写进 `tools` 才会被激活**；`options.tools` 同时是 registry 层 allowlist（`_refreshToolRegistry` → `isAllowedTool`），扩展/MCP 回合中途注册的工具只有它能当场挡住。pi 先放内置工具、再用**同名 customTools 覆盖**（Map 覆盖保留原位置，工具顺序不变），并导出 `create{Read,Bash,Edit,Write,Grep,Find,Ls}ToolDefinition`（`dist/index.d.ts:24`）——「保留定义、拦截执行」有现成接缝（评审-2 #8，§5.4）。
- **tool-scope**（`src/runtime/tool-scope.ts:21-110`）：`RESERVED_TOOL_NAMES` 默认 deny、granted 豁免；`buildToolScopePolicy({tools, granted})`（`:73-80`）；enforcer 在 bind 与每 turn_end 基于 `getActiveTools()` 重算——**只能删、不能加**。
- **provider 工具表来源**（评审-2 已核查）：pi-ai 不清理历史；anthropic 只转换 `context.tools`（`api/anthropic-messages.js:1022-1047`），bedrock 在工具列表为空时 `toolConfig` 为 undefined（`bedrock-converse-stream.js:899-914`）。本机实际路由（`~/.pi/agent/models.json`）：`anthropic-messages`（cloudrouter-anthropic〔默认〕/ newapi-aws / copilot-anthropic / moonshot）、`openai-responses`（cloudrouter-response / zhipu-pool）、`openai-completions`（droid-completion / copilot-completion / cloudrouter-kimi）；另有 `kimi-coding` / `zai-coding-cn` / `zai` 三个 `models: []`、**无显式 api** 的 provider（走 pi 内置 preset，api 需经 `ctx.modelRegistry.find` 反查，review-3 #6②）；**无 bedrock**。
- **thinkingLevel 不持久化**：`thinkingLevel = spec.request.thinkingOverride ?? spec.type.thinkingLevel`；RunDiagnostics 无 thinking 字段（`core/types.ts:395-440`）——专家若覆盖过 thinking，请教 run 无法对齐。
- **CC2 通知抑制**：`parentRunId !== undefined` 即拦完成/config-failure/deadline 三类顶层通知。
- **级联中止三链**：abort→cascadeChildren（`spawn-service.ts:522-535`）；任何取消→onChildAbort→`stack.ts:1109` 接线；前台工具 signal 直连 turn 中止。
- **runner finally 的 reap 是异步的**（`runner.ts:586-603`）：`void runReap().catch(...)` fire-and-forget，**没有完成回调**；与 `waitOutcome`/`spawnAndWait` 的返回是两条互不排序的微任务链。RunnerDeps（`runner.ts:195-215`，含 `beforeReap`/`onExtensionError` 先例）新增 `onReaped` 回调补上此缝（§4.4）。
- **迟到路径**（`runner.ts:473, 576`）：建会话超时/取消后 `driver.onLateArrival(createP, h => reaper.disposeLate(...))`；`onLateArrival` = `p.then(cb, () => undefined)`（`session-driver.ts:354-356`），`disposeLate` 同步（`reaper.ts:167`）。迟到的 `createAgentSession` 在会话无 thinking 条目时会 `appendThinkingLevelChange`（`sdk.js:240-244`）——**与 runReap 各跑各的**（评审-2 #10）。
- **`_persist` 是 `appendFileSync`**（`session-manager.js:726-755`）：文件被删后再写会重新生成**无 header 的残片 jsonl**——fork 文件删除必须排在 reap 与迟到 dispose 之后（§5.1）。
- **快照订阅缝**：spawn-service `deps.onSnapshot` 每个快照触发（含终态），`stack.ts:1214` 已消费——轮次/成本闸门经此挂 tap（§4.1），**不新增 timer**。RunDiagnostics：`turns` 在 **turn_end** 自增（`state-machine.ts:663`）；`lastTurnStartAt` 在 turn_start 写入且粘滞到下一个 turn_start（`:656-660`）；`usage.costUsd` 在 message_end 累加（X9）；`contextUsage{tokens,contextWindow,percent}`；`toolCounts`（`:115-118`）。
- **worktree-origin 注册表**：worktree 扩展 beforeReap 的 finally **无条件** `forgetWorktreeOrigin`（`worktree.ts:150-153`），与删除 worktree 同时——专家被回收后映射必然已不在（评审-2 #12，§5.1 删掉这一级）。
- **`truncateResultText` 实际行为**（`src/tools/result-text.ts:14-45`）：保留头部 70% + 尾部、省略中段；**传了 sessionFile 会追加 "full session transcript: … use the read tool"**——consult 调用时不传（§5.5）。
- **超时保留部分文本**（`state-machine.ts:769-775`）：failed/aborted/timeout 的 run 保留已流出的 deltas；但 `prompted.ok` 为假时 `finalText` 为 undefined（`runner.ts:548`）——**在最后一条回答写完后中止，会把完整答案降级成 partial**（评审-2 #4，§4.1 改为 turn 边界判定）。
- **模型单价**：`ctx.modelRegistry.find(provider, id)` 返回的 pi Model 带 `cost{input, output, cacheRead, cacheWrite}`（$/M tok，stack.ts:1081/1102 已在用 find）——首轮成本预检的单价来源（§4.1）。
- **线程穿透编译门**：`src/service/request-threading.ts` THREADED/NOT_THREADED + never 穷尽断言——SpawnRequest 加字段不分类就编译失败。
- **`RunnerSpec.request` 是完整 SpawnRequest**（`src/service/ports.ts:38-46`）：adapter 可直接读 `spec.request.consultExperts` / `forkSessionFrom`。
- **预算硬顶**：`budgetOverride.totalMs` 显式 → `applyBudgetPolicy` 钳 `maxTotalFactor=1`（无宽限无延长，`src/core/deadline.ts:96-110`）。
- **外部入口不泄漏**：RPC `SpawnParams` `additionalProperties:false`（`rpc/protocol.ts:15-48`）、workflow 逐字段组装（`spawner-adapter.ts:46-60`）——`forkSessionFrom`/`consultExperts` 无法从这两条路径注入。
- **测试基础设施现状**：`tests/integration/` 没有任何真正跑 pi 会话的测试；`tests/runtime` 下有 RuntimeRunner + 假 driver 的先例（`runtime.test.ts`、`runner-x3-x11.test.ts`）——fork 单元测试用**真实** `SessionManager.forkFrom` 操作临时目录；准入与时序测试用**真实** `createSpawnService` + RuntimeRunner + 假 driver（§9）。
- **cache-ttl 只挂主会话**：子 run/fork 会话不经任何 ttl 重写钩子；5m/1h 是分离命名空间，1h 实测存活 7–13.6min；判命中锚「读占上一次前缀 token 数」，不看 `cacheRead>0`（跨会话共享 system/tools 块恒命中）。

## 3. 总体设计

```
调度方(主会话 / 嵌套 canSpawn 调度方)
  │ Agent({ experts: ["X"], ... })                       ← Agent 工具新参数
  ▼
agent-tool execute：resolveExperts(experts)  ← 派发时解析（顶层 & 嵌套 Agent 工具都注入；未注入 ⇒ throw）
  │   每项 → {runId, label, sessionFile, agentType, model, contextPercent, contextTokens}
  │   解析不到 / live 与 index 同 label 不同 runId（ambiguous）→ throw 配置错（立即反馈）
  │   仍在运行 → 接受 + 警告行；每项回显 `expert "X" → run_id …`
  ▼
SpawnRequest.consultExperts: ConsultExpertRef[]（受信、已解析）
  ▼
runtime-adapter.run()：consultExperts?.length && !isConsultRun && enabled →
  注入 consult 工具（customTools + grantedReserved + M1 合并）
  │ consult({ expert:"X", question })
  ▼
src/consult/consult-tool.ts execute：
  ① 匹配白名单（expert ↔ resolved ref 的 runId/label；否则 throw）
  ② 并发闸门：本提问方 in-flight ≥ maxConcurrent 或全局 in-flight ≥ 8 → nack busy
  ③ 存活检查：runId live 终态？无运行中 run 指向同一 sessionFile？否则 nack still_running
  ④ 预检：contextPercent ≥ 75% → nack context_too_large；
          首轮成本估算 contextTokens × max(input, cacheWrite)/1e6 > maxFirstRequestUsd → nack cost_too_high
          （percent/tokens/单价缺失 ⇒ 对应预检跳过）
  ⑤ fork-store.forkExpertSession(sourceFile, requesterCwd) 同步 fork（**不抛**）
     → {ok:true, path}（路径已知）| {ok:false, reason} → nack unavailable（§15 #2）
     cwd：header cwd 存在即用 → 否则提问方 cwd（两级，§5.1）
  ⑥ started = await port.spawn({ type, modelOverride, forkSessionFrom: forkFile, cwd,
        parentRunId: selfRunId, slotless: true, expectAck: true, budgetOverride:{totalMs},
        signal, label:"consult-<rand4>", prompt })
     error / throw → 立即删 forkFile（尚无 run 碰过它）→ nack
  ⑦ unwatch = port.watchRun(started.runId, capWatcher)   ← run 活着时挂上（turn 边界判帽）
  ⑧ outcome = await port.waitOutcome(started.runId)       ← outcomes 已有也能取到，无竞态
  ⑨ outcome → 截断（不传 sessionFile）→ 工具结果（+usage/toolCounts；被帽/超时有文本则 partial）
     工具**不负责**删除已启动 run 的 forkFile —— 全部交给 runner onReaped
                                  ▼
        spawn-service 准入：fork 专用分支
          forkSessionFrom ⇒ 跳过 canSpawn；depth = parent.depth+1 照常受 maxNestedDepth 约束；
          existsSync+isFile；与 resumeFrom 互斥；不进 resumeLocks；
          nesting 条目**不写 canSpawn**（`!req.forkSessionFrom` 判据，评审-2 #6）
                                  ▼
        runtime-adapter：isConsultRun = forkSessionFrom !== undefined
          跳过 message_agent/set_model/Agent/StructuredOutput/consult 全部注入；
          H2 之后强制 sessionSpec.tools = CONSULT_READONLY_TOOLS；toolScope 用同一常量；
          prompt 绕过 buildPrompt 的类型前缀
                                  ▼
        runner session_create：forkSessionFrom → driver.resume(forkFile, req)（driver 零改动）
                                  ▼
        runner finally：runReap() 完成（成功或失败）→ onReaped(runId, req.forkSessionFrom)
        runner 迟到路径：disposeLate 之后 → onReaped(runId, req.forkSessionFrom)（幂等删除）
        adapter 未进 runner 的早退路径（settleConfigFailure 等）→ onReaped(runId, forkSessionFrom)
        buildSessionStack：sweepForkDir（TTL 24h + 无合法 header 的残片不受 TTL 限制）兜底
```

**新模块 `src/consult/`**（唯一新增目录；其余全部为现有文件的小改动）：

| 文件              | 职责                                                                                                                                                                                                                                                                                                                                                                                                  |
| ----------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `expert-index.ts` | 纯函数 + 闭包状态：`createExpertIndex({ consultDir })` → `rebuildFromEntries(entries)` / `resolve(ref)` / `findByLabel(label)`；pi-free，可单测                                                                                                                                                                                                                                                       |
| `consult-tool.ts` | `createConsultTool(deps)`：typebox schema + execute（匹配→闸门→预检→fork→spawn→watcher→waitOutcome→截断→nack 语义）；导出 `ConsultSpawnPort`、`createCapWatcher`（纯函数，可单测）                                                                                                                                                                                                                    |
| `fork-store.ts`   | **pi-facing fs/SDK 适配层**：`forkExpertSession(sourceFile, fallbackCwd) → {ok:true;path} \| {ok:false;reason}`（包 `SessionManager.forkFrom` + 两级 cwd 解析 + header 有限字节读取；**四种抛错全部 catch 成 `{ok:false}`**，§15 #2）、`consultSessionDir()`（`join(getAgentDir(),"cache","consult-sessions")`）、`sweepForkDir(dir, ttlMs, now)`、`removeForkFile(path)`（只删 consultDir 下的文件） |
| `index.ts`        | 装配：`wireConsult({...})` → `{ depsFactory, expertIndex, resolveExperts, sweep(), onReaped(runId, forkSessionFrom?), dispatchSnapshot(snapshot) }`；闭包持有并发计数器（每提问方 + 全局）、watcher 注册表、ConsultSpawnPort 的 owned-runId 集合（全部随栈重建；**无 pendingDeletions**）                                                                                                             |

依赖方向：`core/types` ← `consult/*`；`consult/fork-store` → pi SDK（SessionManager/getAgentDir）；`consult/*` → `service/spawn-service`（仅经 `ConsultSpawnPort` 窄端口，wireConsult 构造）；`consult/*` → `runtime/tool-scope`（只读 `CONSULT_READONLY_TOOLS` 常量，用于 prompt 文案）；driver/runner **不依赖** consult（runner 只回调通用 `onReaped`，删除判断在 consult 侧）。`stack.ts` 装配，`src/index.ts` 只加一行 holder 转发（§6 D-16）。

## 4. 接口契约

### 4.1 consult 工具（模型面）

```ts
// src/consult/consult-tool.ts
export const ConsultToolParams = Type.Object({
  expert: Type.String({
    description:
      "Which expert to consult: a label or run_id from this run's expert whitelist " +
      "(resolved and validated at dispatch time). The expert must be a FINISHED subagent run; " +
      "consult forks its persisted session and asks your question. The consulted copy runs in YOUR " +
      "checkout with read-only tools (read/grep/find/ls). There is no fallback to a fresh agent — " +
      "if the expert is unavailable you get a clear negative answer and should investigate yourself.",
  }),
  question: Type.String({
    description: "The question, self-contained. The expert sees its own history plus this question.",
  }),
  // 评审-1 #20：v1 无 timeout_s / max_answer_chars 模型面旋钮，上限全在 settings（§4.6）。
});
export type ConsultToolParams = Static<typeof ConsultToolParams>;

/**
 * 评审-2 #1：consult 专用窄端口（不复用 NestedSpawnPort——给嵌套 Agent 工具加 waitOutcome 会让它能
 * ack 任意 run 的 outcome，违反 X3 最小权限）。由 wireConsult 从 SpawnService 构造；
 * waitOutcome/abortRun/watchRun 只接受经本端口 spawn 出来的 runId（owned 集合），其余立即 reject/no-op。
 */
/** 被帽原因（consult 内部枚举）。**有意不进 `StopCause`**——见 §15 #1 的取舍。 */
export type ConsultCapReason = "turn_cap" | "cost_cap";

export interface ConsultSpawnPort {
  /** 透传 SpawnService.spawn；端口内断言 req.expectAck === true && req.forkSessionFrom !== undefined。 */
  spawn(req: SpawnRequest): Promise<{ runId: RunId; label?: string } | { error: ErrorInfo }>;
  /** = SpawnService.waitOutcome(runId)（不传 waitMs：不起 timer，由 run 的 totalMs 硬顶保证必结算）；
   *  outcomes 已有即返回。解包 BoundedWaitResult（无 waitMs 时恒为 settled）。结算后移出 owned 集合。 */
  waitOutcome(runId: RunId): Promise<RunOutcome>;
  /**
   * 中止被帽的请教 run：端口内部调用 **`SpawnService.abort(runId, "user_stop")`**；fire-and-forget
   * （调用方经 queueMicrotask，见 watcher）。`StopCause`（`src/core/types.ts:33`）保持闭合五值
   * **不扩**，因此 fleet 行/`diag.stopCause` 会把被帽中止显示成 user_stop——真实原因只经 watcher 的
   * `capReason` 与 `details.outcome="turn_cap"|"cost_cap"` 暴露（F6 可观测性的已知折扣，§15 #1）。
   */
  abortRun(runId: RunId, reason: ConsultCapReason): void;
  /** 订阅 run 快照（stack onSnapshot → wireConsult.dispatchSnapshot 分发），返回退订函数。 */
  watchRun(runId: RunId, cb: (s: RunSnapshot) => void): () => void;
}

export interface ConsultDeps {
  /** 本 run（提问方）的 runId —— parentRunId 与并发闸门键。 */
  selfRunId: RunId;
  /** 提问方 cwd（fork cwd 回退值）。 */
  selfCwd: string;
  /** 派发时已解析的白名单（SpawnRequest.consultExperts）。 */
  whitelist: readonly ConsultExpertRef[];
  port: ConsultSpawnPort;
  query: QueryService; // live 状态/终态快照（存活检查、最新 contextUsage）
  forkStore: ForkStore; // forkExpertSession / removeForkFile
  /**
   * 模型单价（$/M tok）。**按 contextTokens 选中匹配的最高 `ModelCost.tiers` 档**再取费率
   * （pi-ai `types.d.ts:687-694`：request-wide 分层定价，`inputTokensAbove` 之上整请求换档；
   * 不计 tiers 会低估长上下文专家，review-3 #7①）；无 tiers 时取顶层费率。
   * 未知模型/pi 默认模型 → undefined（成本预检跳过）。实现见 §6 D-14。
   */
  priceOf: (
    model: { provider: string; id: string },
    contextTokens: number,
  ) => { input: number; cacheWrite: number } | undefined;
  /** 并发闸门（wireConsult 闭包计数器）：acquire 失败返回 false；release 幂等。 */
  inflight: { tryAcquire(selfRunId: RunId): boolean; release(selfRunId: RunId): void };
  now: () => Millis;
  settings: () => ConsultSettings;
}
```

**问题 prompt 构造**（作为 run prompt 原样下发；adapter 对请教 run **不拼类型前缀**，§5.4）：

```
[consult] You are being consulted by a downstream agent that cannot see your session.
Answer from your own context. Lead with the conclusion (<=3 lines), then expand only as needed.
Hard limit: <= {maxAnswerChars} characters.
In this consult you ONLY have read-only tools: read, grep, find, ls. Do not attempt any other tool
(bash/edit/write/Agent/... from your history are unavailable). Prefer not to call tools unless the
answer strictly requires a fresh environment fact.

Question:
{question}
```

**label**：`consult-<rand4>`（base36 随机 4 字符，评审-1 #11）。fleet 行以 `consult-` 前缀可辨。

**执行时序（评审-2 #1 重写）**：

```ts
// 伪代码，省略 details 组装
if (!deps.settings().enabled) return nack("unavailable", "consult is disabled (consult.enabled=false)");
const ref = matchWhitelist(params.expert); // 白名单外 → throw
if (!deps.inflight.tryAcquire(selfRunId)) return nack("busy");
try {
  // ③ 存活 ④ 预检（均在 fork 之前，失败不产生文件）
  // ⑤ fork：forkStore 把 SessionManager.forkFrom 的四种抛错吞成结果对象，**从不 throw**（§6 C-9、§15 #2）
  const forkFile = deps.forkStore.forkExpertSession(ref.sessionFile, deps.selfCwd); // 同步
  if (!forkFile.ok) return nack("unavailable", `could not fork the expert's session: ${forkFile.reason}`);
  let started;
  try {
    started = await deps.port.spawn({
      ...req,
      forkSessionFrom: forkFile.path,
      expectAck: true,
      ...(signal ? { signal } : {}),
    });
  } catch (e) {
    deps.forkStore.removeForkFile(forkFile.path);
    return nack("unavailable", e);
  }
  if ("error" in started) {
    deps.forkStore.removeForkFile(forkFile.path);
    return nack("unavailable", started.error);
  }
  // 此后 forkFile 归 runner：onReaped / 迟到路径 / adapter 早退路径 / sweep 负责，工具不再碰它
  const watcher = createCapWatcher({
    maxTurns,
    maxCostUsd,
    onCap: (reason) => queueMicrotask(() => deps.port.abortRun(started.runId, reason)),
  });
  const unwatch = deps.port.watchRun(started.runId, watcher.onSnapshot);
  try {
    const outcome = await deps.port.waitOutcome(started.runId);
    return toToolResult(outcome, watcher.capReason);
  } finally {
    unwatch();
  }
} finally {
  deps.inflight.release(selfRunId);
}
```

- **注册窗口无漏判**：`spawn()` 在 `void start(...)` 后同步返回 runId；判帽只看 turn_start，而第一个 turn_start 必然晚于 session_create 相位的 I/O await，⑦ 的注册（同一 continuation）不可能错过任何需要判定的快照。
- **signal**：直接透传工具 signal（与 `spawnAndWait` 同语义：提问方 Esc 杀掉请教 run 是特性），**不用** `detachSignalOnStart`；无 auto-background（请教必须同步返回）。
- **`expectAck:true` 显式传**：`waitOutcome` 结算即 `onOutcomeAcked`，与顶层 Agent 工具先例一致；加上 parentRunId 的 CC2 抑制，请教 run 绝不产生顶层通知。

**cap watcher（评审-2 #4：只在 turn 边界判定）**：

```ts
export function createCapWatcher(o: {
  maxTurns: number;
  maxCostUsd: number; // 累计帽；0 = 成本帽关闭（首轮预检用的是另一个设置 maxFirstRequestUsd）
  onCap: (reason: ConsultCapReason) => void; // "turn_cap" | "cost_cap"，见 §15 #1
}): { onSnapshot(s: RunSnapshot): void; readonly capReason?: ConsultCapReason };
```

- 只在**新 turn 开始**时判：`s.diag.lastTurnStartAt` 相对上次观测值发生变化且 status 非终态。**理由**：`lastTurnStartAt` 是粘滞字段，即便将来引入快照节流/合并也不会漏判；（review-3 #10② 更正：现状 `onStateChange` 在每次 `dispatch` 后无条件触发、每个 `session_event` 一条快照，**快照并不合并**，与 `lastEventType==="turn_start"` 判据等价——选粘滞字段只是更保守，不是因为会合并。）
- 判据：`s.diag.turns >= maxTurns`（turns 在 turn_end 自增，新 turn 开始时 = 已完成 turn 数）→ `turn_cap`；否则 `maxCostUsd > 0 && (s.diag.usage?.costUsd ?? 0) > maxCostUsd` → `cost_cap`；
- **不在 message_end 上中止**：最后一条回答消息越过 cap 时不会再有 turn_start，run 正常 `completed`，完整答案保留；被中止的只可能是「上一 turn 以 tool_use 结束、正要开下一个付费 turn」的情形——此时尚无最终回答，已流出文本按 partial 返回；
- `onCap` 只触发一次（幂等）；调用方经 `queueMicrotask` 执行 abort（评审-2 #15①：watcher 在 onStateChange 同步回调栈内，不依赖 `spawn.abort` 的 async 行为）；端口把 `reason` 落成 `abort(runId, "user_stop")`，`reason` 本身只进 `capReason`/`details`（§15 #1）；
- **有效上界**：成本最坏 ≈ max(首轮预检估值, cap) + 一个 turn 的成本；轮次最坏 = maxTurns 个完整 turn。totalMs 硬顶始终兜底。

**首轮成本预检（评审-2 #4②；v3.1 按 review-3 #4 拆阈值、#7① 计 tiers）**：`est = contextTokens × max(price.input, price.cacheWrite) / 1e6`（B 形态首请求必然全量重写前缀，按写入单价保守估；`price` 由 `priceOf(model, contextTokens)` 选中匹配的最高 tier 后取值）。`contextTokens` 取 live 快照或 index 记录的专家终态 `contextUsage.tokens`（缺失退回 ref 快照值）；**`est > maxFirstRequestUsd`（且该值 > 0）→ nack `cost_too_high`**，**在 fork 之前**判，不产生文件；tokens 或单价缺失 → 跳过（`details.costEstimateUsd` 不出现），由 turn 边界的累计帽兜底。

**预检阈值与累计帽是两个设置（review-3 #4）**：预检管「第一请求负担得起吗」，累计帽 `maxCostUsd` 管「整次请教总共花多少」。二者共用一个值时，est 可以合法地逼近 cap（如 $1.9 / cap $2），第 1 个 turn 结束累计即越帽、turn 2 开始必被砍——`maxTurns` 实际恒为 1，且调度方与模型都看不见这个事实。默认 $2 / $4 保证 est 打满预检线时仍余 ≥1 个同量级 turn 的预算。

**余额不足一轮时明示模型**：派发前算 `remaining = maxCostUsd - est`；`maxCostUsd > 0 && est > 0 && remaining < est` 时在问题 prompt 尾部追加一行 `Budget note: you have roughly one turn — answer directly from your context, do not call tools.`；无论是否追加，成功结果的 `details` 都带 `costEstimateUsd` 与 `turnBudgetHint = max(1, floor(remaining / est) + 1)`（est 或单价缺失时两者都不出现），调度方可当场看出「这次只有一轮」。

**返回**（成功）：`content: [{type:"text", text: 截断后的回答}]`，
`details: { expertRunId, expertLabel, consultRunId, model?, costUsd?, costEstimateUsd?, turnBudgetHint?, truncated, partial?, durationMs, turns, toolCounts?, outcome }`（`toolCounts` 取 `outcome.diag.toolCounts`，评审-2 #15⑥），
`usage: toPiToolUsage(outcome.usage)`（成本回传父会话总账，同 Agent 工具先例）。

**错误与 nack 约定**：

| 情形                                                                                                                                                                              | 行为                                                | 文案（要点）                                                                                                                                                                                                                                                                                                    |
| --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| expert 不在白名单 / 空问题                                                                                                                                                        | **throw**（调用方错误，同 Agent allowedTypes 先例） | `consult: expert "X" is not in this run's expert whitelist (allowed: a, b). Ask your dispatcher to add it, or answer from your own context.`                                                                                                                                                                    |
| `consult.enabled=false`（派发后被关）                                                                                                                                             | nack                                                | `consult is disabled (consult.enabled=false).` + `details.outcome="unavailable"`                                                                                                                                                                                                                                |
| 会话文件缺失 / 类型已删 / 解析失效（reload 后条目丢失等）                                                                                                                         | nack                                                | `Expert "X" could not be consulted: <reason>. Fall back to your own investigation.` + `details.outcome="unavailable"`                                                                                                                                                                                           |
| 专家仍在运行（runId live 非终态，**或有运行中 run 指向同一 sessionFile**——覆盖 `Agent({resume})` 续跑）                                                                           | nack                                                | `Expert "X" is still running; use steer_subagent-style follow-up via your dispatcher instead.` + `details.outcome="still_running"`                                                                                                                                                                              |
| 上下文预检超标（contextUsage.percent ≥ 75%；percent 为 null/缺失则跳过，评审-2 #15③）                                                                                             | nack                                                | `Expert "X" session is ~{p}% of its context window; a consult would likely force compaction and blow the {timeout}s budget. Ask your dispatcher for a targeted resume instead.` + `details.outcome="context_too_large"`                                                                                         |
| 首轮成本预检超标（`est > maxFirstRequestUsd`，评审-2 #4②）                                                                                                                        | nack                                                | `Consulting "X" would cost ~${est} for the first request alone (first-request cap ${cap}; the expert's ~{tokens} tokens are re-sent uncached). Ask your dispatcher, or raise consult.maxFirstRequestUsd.` + `details.outcome="cost_too_high"`                                                                   |
| **fork 失败**（`SessionManager.forkFrom` 的四种抛错：源文件空/不可解析、无 `type:"session"` header、`flag:"wx"` 冲突、mkdir/写失败；`session-manager.js:1237-1276`，review-3 #2） | nack                                                | `Expert "X" could not be consulted: could not fork the expert's session: <reason>. Fall back to your own investigation.` + `details.outcome="unavailable"`；**此时未发任何 spawn**。已落盘的半截 fork 文件（header 已写、逐条 append 中途失败）路径由 `forkFrom` 内部生成、外部不可知，交 sweep 的 24h TTL 兜底 |
| 并发闸门（本提问方 in-flight ≥ maxConcurrent，或全局 in-flight ≥ `CONSULT_MAX_GLOBAL_INFLIGHT`）                                                                                  | nack                                                | `Too many concurrent consults (max {n}). Wait for one to finish or ask sequentially.` + `details.outcome="busy"`                                                                                                                                                                                                |
| 超时 / 被帽 / 失败 / 中止，**且 outcome.text 为空**                                                                                                                               | nack                                                | `Expert "X" did not answer within {timeout}s (consult run <id>, reason: <...>). Fall back to your own investigation.` + `details.outcome="timeout"\|"turn_cap"\|"cost_cap"\|"failed"\|"aborted"`                                                                                                                |
| 超时 / 被帽 / 失败，**但 outcome.text 非空**                                                                                                                                      | **返回部分答案**                                    | 截断后的部分文本 + 尾部一行 `⚠ partial answer — consult ended early (<reason>).` + `details.partial=true`                                                                                                                                                                                                       |
| `port.spawn` 返回 `{error}` 或 throw（深度超限、quota 闸门、模型未知等）                                                                                                          | nack                                                | `Expert "X" could not be launched: <error.message>` + `details.outcome="unavailable"`, `details.configError=<message>`；**同时立即删除 forkFile**（尚无 run 触碰它，删除无竞态）                                                                                                                                |

约定：throw 只用于「提问方自己错了」（白名单外、空问题）；其余一律**正常工具结果**。T-4 断言「白名单内从不 throw、从不发无 forkSessionFrom 的 spawn」。

### 4.2 Agent 工具新参数（F7 入口）+ 派发时解析

`AgentToolParams`（`src/tools/agent-tool.ts:117`）加：

```ts
experts: Type.Optional(Type.Array(Type.String(), {
  description:
    "Optional whitelist of subagent runs (labels or run_ids) this subagent may consult in-turn via the " +
    "consult tool — e.g. an upstream agent whose decisions it needs. Entries are resolved at dispatch " +
    "time: unresolvable or ambiguous entries fail the dispatch (use the run_id to disambiguate); " +
    "still-running entries are accepted with a warning and become consultable once they finish. " +
    "The consulted copy is read-only and runs in the consulting agent's checkout.",
})),
```

`AgentToolDeps` += `resolveExperts?: (refs: readonly string[]) => ResolveExpertsResult`。execute 内：

- `params.experts?.length && !deps.resolveExperts` → **throw** `experts is not supported in this context`（评审-2 #11③：不静默忽略）；
- `consult.enabled=false` → `resolveExperts` 直接 throw `consult is disabled (consult.enabled=false); remove "experts" or enable it`（评审-2 #15⑤）；
- **解析不到**（无此 run / 无 sessionFile / sessionFile `existsSync` 失败 / 非终态且拿不到 sessionFile）→ **throw 配置错**，列失败项与可解析候选；
- **ambiguous**（§4.5）→ **throw**，列出冲突的全部 runId 与各自 agentType/结束时间，提示改用 run_id；
- **仍在运行**（live 非终态但有 sessionFile）→ 接受，ref 标 `pending:true`，工具结果附 `⚠ expert "X" is still running; consult will nack until it finishes.`；
- 通过项 → `baseRequest.consultExperts = resolvedRefs`；**工具结果逐项回显** `expert "X" → run_id <id> (<agentType>)`（评审-2 #9），调度方可当场核对问的是谁。

**注入点**：顶层 Agent 工具（`src/index.ts:282`）经 holder 转发 `resolveExperts: (refs) => requireStack(holder).consult.resolveExperts(refs)`；嵌套 Agent 工具（`runtime-adapter.ts:474`）经 adapter deps `consultResolveExperts` 注入（与既有 `Agent({resume})` 同级信任，§5.2）。consult 工具本身不注册进主会话（§5.2）。
**工作流派发 v1 不支持**（非目标，§1）：`spawner-adapter.ts` 逐字段组装不带 `consultExperts`，也不经 agent-tool——workflow 子 run 永远拿不到 consult 工具，文档显式声明。**已被 `docs/dev/workflow-experts/plan.md` 解除**：`spawner-adapter.ts` 现在按显式字段转发已解析的 `consultExperts`（脚本本身传不了 ref 对象，只能传字符串 handle），workflow 只接受 completed 专家。

### 4.3 SpawnRequest / 穿透（冻结面，包 A）

```ts
// src/core/types.ts
/** 派发时解析过的可请教专家（agent-tool 产出，受信）。label 仅显示用；匹配以 runId 为准。 */
export interface ConsultExpertRef {
  runId: RunId;
  label?: string;
  sessionFile: string;
  agentType: string;
  model?: { provider: string; id: string };
  /** 派发时快照的上下文占用（0-100）；consult 时以最新快照/live 复核。 */
  contextPercent?: number;
  /** 派发时快照的上下文 token 数（首轮成本预检用，评审-2 #4）；consult 时同样复核。 */
  contextTokens?: number;
  /** 派发时仍在运行：consult 需等其终态（仍按 §4.1 still_running 处理）。 */
  pending?: boolean;
}

// SpawnRequest 增加：
/** F7: 已解析的可请教专家列表；runtime-adapter 据此注入 consult 工具。 */
consultExperts?: ConsultExpertRef[];
/**
 * consult 专用：fork 副本的 session 文件绝对路径。仅由 consult 工具内部产出
 * （fork-store 刚创建的副本），与 resumeFrom 互斥；spawn 准入只做 existsSync+isFile
 * 校验并走 fork 专用分支（跳过 canSpawn、nesting 不写 canSpawn），runner 经 driver.resume 打开，
 * reap 后 runner 以同一路径回调 onReaped。存在即表示「这是一次请教 run」（adapter 只读域判据）。
 */
forkSessionFrom?: string;
```

`src/service/request-threading.ts`：`THREADED += "forkSessionFrom"`（runner 分派与 onReaped 要用）；`NOT_THREADED += "consultExperts"`（adapter 消费）。编译门自动强制。

`ResolvedSpawnRequest`（`src/runtime/runner.ts:37`）+= `forkSessionFrom?: string`（经 `threadThroughRequestFields` 穿透）。

### 4.4 fork 路径：spawn 准入分支 + 复用 driver.resume + onReaped

**driver 零改动**——`PiSessionDriver.resume(sessionFile, spec)` 的 `SessionManager.open(file) + createAgentSession({sessionManager})` 对 fork 副本天然成立（`cwd` 经 `SpawnRequest.cwd` → SessionSpec 传入，覆盖 header cwd）。

```ts
// src/runtime/runner.ts — session_create 分派（465-469 处）改为：
const openFile = req.forkSessionFrom ?? req.resumeFrom;
createP = openFile
  ? this.d.driver.resume
    ? this.d.driver.resume(openFile, req)
    : Promise.reject(new Error("session driver does not support resume"))
  : this.d.driver.create(req);
```

```ts
// src/runtime/runner.ts — RunnerDeps（195-215 处）加（冻结面）：
/**
 * 物理回收完成回调（consult fork 清理缝）。每个 run 在 finally 的 runReap() 结束后（成功或失败）
 * 调用一次；迟到路径在 disposeLate 之后再调用一次。forkSessionFrom 由 runner 直接取自
 * req.forkSessionFrom（非 fork run 为 undefined）。实现必须幂等、同步、不抛（抛了也被吞）。
 */
onReaped?: (runId: RunId, forkSessionFrom?: string) => void;

// 私有 helper：
private notifyReaped(req: ResolvedSpawnRequest) {
  try { this.d.onReaped?.(req.runId, req.forkSessionFrom); } catch { /* 清理回调不得影响 runner */ }
}

// finally 内（603 处）：
void runReap()
  .catch(() => undefined)
  .then(() => this.notifyReaped(req));

// 迟到路径（473 与 576 两处，评审-2 #10）：
this.d.driver.onLateArrival(createP, (h) => {
  this.d.reaper.disposeLate(req.runId, gen, h); // 同步
  this.notifyReaped(req); // 迟到会话的 appendThinkingLevelChange 已在 createP resolve 前完成；dispose 后再删
});
```

**为什么不再需要 pendingDeletions（评审-2 #1②）**：删除所需的唯一事实（fork 路径）随请求一路穿透到 runner，runner 在「reap 之后」这个唯一正确的时点自己带着路径回调；工具拿没拿到结果、先拿后拿都与删除无关——「reap 早于工具拿到结果」不再是竞态，只是一个正常时序（T-21 锁定）。

```ts
// src/consult/index.ts — onReaped 实现：
onReaped(runId, forkSessionFrom) {
  if (forkSessionFrom === undefined) return;             // 非请教 run
  if (!isUnder(consultDir, forkSessionFrom)) return;     // 防御：只删 consultDir 下的文件
  forkStore.removeForkFile(forkSessionFrom);             // ENOENT 静默 → 幂等
}
```

**adapter 早退路径**（评审-2 #1 的配套：runner 从未运行则无 finally）：`runtime-adapter.run()` 中 `settleConfigFailure` 的所有返回点（deadlineAt 过期、H2 失败）以及 `runtime.run()` 之前的任何 throw，对 `isConsultRun` 调 `deps.onReaped?.(spec.runId, spec.request.forkSessionFrom)`。实现：`let runnerEntered = false; try { …; runnerEntered = true; await runtime.run(…) } finally { if (!runnerEntered && isConsultRun) deps.onReaped?.(…) }`。此时尚无会话打开该文件，立即删除无竞态。`RuntimeRunner.run` 进入其 try 之前的同步抛出——`runner.ts:394-412` 是 `createInitialState` / `createCancelHandle` 与 `states`·`activeCancels`·`dispatchers` 的写入，**不是参数断言**（review-3 #8 更正 v3 的错误依据）——不经任何 finally；而 `runnerEntered` 置位在 `await runtime.run(...)` **之前**，所以这条路径落 sweep（24h）。**有意不在 adapter finally 里无条件删**：无条件删会与 runner 尚未完成的 `runReap()` / dispose 的 `_persist`（`appendFileSync`）重新构成「删除后残片重生」竞态，正是 §4.4 从结构上消掉的那一个。

```ts
// src/service/spawn-service.ts — spawn() 准入加 fork 分支（resumeFrom 分支旁）：
if (req.forkSessionFrom) {
  if (req.resumeFrom)
    return {
      error: { kind: "config", message: "forkSessionFrom and resumeFrom are mutually exclusive", retryable: false },
    };
  if (!existsSync(req.forkSessionFrom) || !statSync(req.forkSessionFrom).isFile())
    return {
      error: { kind: "config", message: `fork session file missing: ${req.forkSessionFrom}`, retryable: false },
    };
  // 不进 resumeLocks：fork 副本是本 run 私有文件，无互斥需求（并发 consult 各自有副本）。
}
```

**canSpawn 分支**（343-363 区）：

```ts
if (req.parentRunId) {
  const parent = nesting.get(req.parentRunId);
  if (parent) {
    if (!req.forkSessionFrom && !parent.canSpawn?.includes(req.type)) return { error: /* 既有文案 */ };
    depth = parent.depth + 1; // fork 请求照常计深、照常受 maxNestedDepth 约束
    if (depth > maxNestedDepth) return { error: /* 既有文案 */ };
  }
}
// … nesting 写入（439 处，评审-2 #6）：
nesting.set(runId, { depth, ...(config.canSpawn && !req.forkSessionFrom ? { canSpawn: config.canSpawn } : {}) });
```

- **深度口径（写死）**：请教 run **计入** `parent.depth + 1` 并受 `maxNestedDepth` 约束，超限走 §4.1 的 spawn error→nack 路径。
- **请教 run 不可再派子 agent——两层独立保证**（v2 的「nesting 自然无 canSpawn」说法不成立，已更正）：① adapter 不为请教 run 注入嵌套 Agent 工具，且 pi 层 allowlist 只有只读四件（§5.4）；② spawn-service 对 fork run 的 nesting 条目不写 canSpawn，即便将来加 `expertTools:"preserve"` 旋钮把 Agent 工具带回来，它的派发也会被 canSpawn 闸拒掉。
- `label` 走正常注册（`consult-<rand4>`）。

### 4.5 ExpertIndex（F3）

```ts
// src/consult/expert-index.ts（pi-free）
export interface ExpertRecord {
  runId: RunId;
  label?: string;
  sessionFile: string;
  agentType: string;
  model?: { provider: string; id: string };
  status: "completed" | "failed" | "timed_out" | "aborted";
  contextPercent?: number;
  contextTokens?: number;
  updatedAt: Millis;
}
export interface ExpertIndex {
  /** 从主会话 prefetchedEntries 重建（buildSessionStack 调用一次）。 */
  rebuildFromEntries(entries: readonly unknown[]): void;
  /** runId 精确 → runId 唯一前缀（多候选 ambiguous）；与 resolve-target.ts 的 id 语义对齐。 */
  resolveId(ref: string): { ok: true; record: ExpertRecord } | { ok: false; ambiguous?: RunId[]; reason: string };
  /** label 精确匹配，返回**全部**命中记录（index 可跨多个 reload 代际含同名 label）。 */
  findByLabel(label: string): readonly ExpertRecord[];
}
```

- `rebuildFromEntries`：过滤 `entry.type === "custom" && entry.customType === "subagent:run"`，`entry.data as RunSnapshot`；只收终态 + `diag.sessionFile` 非空。
- **请教 run 排除（结构化判据）**：`diag.sessionFile` 位于 `consultDir` 之下的记录一律不收——fork 副本必落该目录，专家会话永不落该目录；live 查询路径用同一判据。
- **resolveExperts 解析语义（评审-2 #9 重写）**：对每个 ref
  1. **id 路径**：live（`query.list()`）与 index 各自按 id 精确 → 唯一前缀解析；两源得到的 runId 集合并集 >1 → ambiguous；=1 → 命中；
  2. **label 路径**（id 未命中时）：live 的 label（进程内唯一）∪ index 的 `findByLabel` 全部记录，按 runId 去重；**>1 个不同 runId → ambiguous**（列出全部 runId），=1 → 命中，=0 → 解析失败；
  3. v2 的「live 优先 / 同 label 后来者覆盖」**废弃**——正是它会在 reload 后把同名新 run 当成旧专家（e1-r2 问错人模式）。
- **与 resolve-target 对齐的范围（review-3 #5 补齐）**：id 精确/唯一前缀两级**复用 `matchRunId`**——它当前是 `src/service/resolve-target.ts:110` 的**模块私有函数**，包 C 把它 `export`（一行，进冻结面，§6 C-8b）。
  **deps 适配**：index 自己构造 `ResolveTargetDeps = { records: () => this.snapshots(), liveSnapshots: [], labels: new Map(), tombstones: { list: () => [], get: () => undefined } }`。可行性：`matchRunId` 只经 `knownIds()` 读 `records ∪ liveSnapshots ∪ tombstones` 的 **runId 集合**，不碰 label/candidate/sessionFile 逻辑，所以 `snapshots()` 只需把 `ExpertRecord` 投影成含 `runId`/`status`/`updatedAt`/`diag.sessionFile` 的最小 `RunSnapshot` 形状即可。
  若最终选「对齐实现」而非复用，T-1 的同一 fixture **必须双向跑两个实现**（`matchRunId` 与 index 版各跑一遍并断言结果相同），不能只跑 index 一侧。label 语义**有意不同**（resolve-target 只看进程内 labels Map，无跨代际歧义问题），文档声明。
- **consult 时存活复核**：按 runId 查 live 非终态 → still_running；再按 sessionFile 扫 live 运行中 run（`diag.sessionFile === ref.sessionFile`）→ still_running（覆盖 `Agent({resume})` 新 runId 续跑同文件）。已知残余窗口：resume 准入后、`session_created` 写入 diag.sessionFile 前（秒级）扫不到——接受（最坏后果是答案基于稍早上下文，不破坏源文件）。

### 4.6 设置（`src/config/settings.ts` + `setting-specs.ts`）

```ts
export interface ConsultSettings {
  enabled: boolean; // default true（暴露面由 experts 白名单控制）
  timeoutMs: number; // default 150_000（totalMs 硬顶）
  maxAnswerChars: number; // default 2_000（截断兜底 + prompt 指令）
  maxTurns: number; // default 3（turn 边界判定：第 maxTurns+1 个 turn 开始时 abort）
  maxFirstRequestUsd: number; // default 2（fork 前首轮预检阈值；0 = 关闭预检）
  maxCostUsd: number; // default 4（累计成本帽，turn 边界判定；0 = 关闭成本帽）
  maxConcurrent: number; // default 2（每提问方 in-flight consult 上限）
}
```

内部常量（不进 settings，防旋钮 creep）：`FORK_TTL_MS = 24h`（sweep 窗口）、`CONSULT_MAX_CONTEXT_PERCENT = 75`、`CONSULT_MAX_GLOBAL_INFLIGHT = 8`（评审-2 #15②：slotless 下的全局扇出上限，wireConsult 闭包计数）。`CONSULT_READONLY_TOOLS = ["read","grep","find","ls"] as const` 定义在 `src/runtime/tool-scope.ts`（adapter 与 consult 共用）。
`AgentSettings` 加 `consult: ConsultSettings`；`DEFAULT_SETTINGS` 给默认值；`setting-specs.ts` 加 `consult.*` 条目。

**$2 / $4 的依据（review-3 #4：预检与累计帽必须是两个值）**：`maxFirstRequestUsd` 管第一请求——B 形态首请求 = 专家整段前缀按写入单价重发。以 Opus 级写入单价（~$6.25/M）计，$2 覆盖约 320k token 的专家前缀——覆盖 200k 窗口 75% 预检线（150k，约 $0.94）与方案自估的「长上下文专家约 $1.5」；1M 窗口下更大的专家由首轮预检 nack（文案提示调度方或调高 `consult.maxFirstRequestUsd`）。`maxCostUsd` 管整次请教，取预检线的 2×：est 打满 $2 时仍余 $2 ≈ 至少一个同量级后续 turn，`maxTurns=3` 不会被成本帽压成 1（常态约束是 150s 硬顶与 `maxTurns`，成本帽是失控保险）。P0-α③ 给出实测首请求成本后，按「实测 P90 × 1.3」重定 `maxFirstRequestUsd`，`maxCostUsd` 随之取其 2×（§11-1）。**不推荐把两者配成相等**——那等价于 v3 的单值形态，`maxTurns` 退化为 1（T-11 锁定该退化行为）。

## 5. 关键决策（OQ1–OQ7 逐条）

### 5.1 OQ1 fork 机制 → **工具侧同步 `SessionManager.forkFrom` + `driver.resume` 接缝**

- **机制**：forkFrom 新 id、`flag:"wx"` 防覆盖、`parentSession` 溯源、源文件零写入、返回独立新实例（并发 fork 同一专家天然安全，F2）。
- **为什么在工具侧**：路径在 spawn 前已知；fork 成功的文件经 `forkSessionFrom` 交给**既有** `driver.resume` 打开；`driver.fork`/三态分派/运行时对 consult 的反向依赖全部不存在。
- **fork 文件生命周期（单一事实源，v3 重写）**：
  1. fork 成功、`port.spawn` 返回 error 或 throw → 工具**立即删**（尚无 run 触碰）；
  2. spawn 成功后文件归 runner，工具不再碰：
     - runner finally：`runReap()` 完成（含失败）→ `onReaped(runId, forkSessionFrom)` 删；
     - 迟到路径：`disposeLate` 之后再 `onReaped` 一次（幂等；覆盖迟到 `createAgentSession` 的 `appendThinkingLevelChange` 重生残片，评审-2 #10）；
     - adapter 早退（`settleConfigFailure` 等，runner 未运行）→ adapter 直接 `onReaped`；
  3. 崩溃/强杀/遗漏 → `buildSessionStack` 时 `sweepForkDir(dir, FORK_TTL_MS)` 兜底：mtime 超 TTL 的删；**首行不是合法 session header 的残片不受 TTL 限制直接删**（残片只可能是删除后被 `_persist` 重生的垃圾；合法 fork 文件首行必为 header，因为 forkFrom 以 wx 先写 header）。
     **多进程安全（review-3 #9）**：consultDir 位于 `~/.pi/agent/cache/`，**跨 pi 进程共享**，而 `sweep()` 在每次 `buildSessionStack` 同步执行——它不会误杀别的进程正在用的 fork 文件，依据两条：① 任何活着的请教 run 都在 150s 硬顶内，其 fork 文件 mtime 必远小于 24h TTL（TTL ≫ 硬顶，量级差 576 倍）；② 「无合法 header ⇒ 不受 TTL 直接删」也不会误杀**正在创建**的文件，因为 `forkFrom` 的第一个 `writeFileSync` 就是 header（header-first 写序），逐条 append 在其后。**改 sweep 规则的人必须保住这两条前提**（缩短 TTL 到分钟级、或改按「文件尾部完整性」判残片，都会破坏它）。
     **不新增任何 timer。**
- **落点**：`join(getAgentDir(), "cache", "consult-sessions")`（pi 官方访问器；pi `/resume` 只扫 `<agent>/sessions/`，不污染列表）。
- **cwd 解析（评审-2 #12：两级）**：`readHeaderCwd(sourceFile)`（只读首行、上限 8KB）→ `existsSync(cwd)` 成立即用（含 worktree 被保留的情形）→ 否则回退**提问方 cwd**。v2 的 worktree-origin 中间级删除：worktree 扩展在 beforeReap finally 里无条件 `forgetWorktreeOrigin`（`worktree.ts:150-153`），与删除 worktree 同时发生，生产中该级必然 miss。**语义声明**（写进工具描述与 details）：worktree 专家被请教时看到的是**提问方的 checkout**，看不到自己 worktree 里的改动或 `pi-agent-<runId>` 分支（只读域下安全无虞；若需要，调度方可在问题里点名分支让专家 `read` 不到时直接说明）。
- **否决项**（交接包 ruledOut）：`createBranchedSession`（原地 mutate、落点污染 `/resume`）、`branch/branchWithSummary`（仍写原文件）、手复制 jsonl（同 id、无 parentSession、无 wx）。

### 5.2 OQ2 专家指定 → **派发时白名单 `Agent({experts})` + 派发时解析；主会话与工作流 v1 不支持**（§4.2）

- 白名单理由：最小攻击面（实验 3 Q2 证明「有信息但读不到」时模型会越权翻文件）；派发时解析带来调度方即时反馈。
- **安全模型**：`AgentToolParams` 由主会话与嵌套 canSpawn 调度方共用——**任何能调用 Agent 工具的上下文都能把任意可解析的已终态 run 授权给自己派发的子 agent**，信任等级与既有 `Agent({resume})` 同级（resume 能打开任意可解析会话并续写，比只读 fork 更强）。不采纳「只能授权自己子树内的 run」：主用法恰是调度方把**兄弟**上游授权给下游。嵌套 Agent 工具因此同样注入 `resolveExperts`（§4.2），不做静默忽略。
- 主会话不提供 consult；workflow 穿透列为后续（非目标，§1）。

### 5.3 OQ3 reload 重建 → **ExpertIndex + live 查询合并，跨源同名报 ambiguous**（§4.5）

- reload 后新派发的提问方在派发时经 index 解析；resolved ref 里是 runId + 绝对路径，consult 按 runId/路径操作。同一 label 在 live 与 index 命中不同 runId → 派发 throw ambiguous（评审-2 #9），调度方改用 run_id。
- **降级路径（写清 + 文案）**：
  - `rememberAgents=false`：专家 run 无 sessionFile → 派发时解析失败，文案含 `agent type runs without persisted sessions (rememberAgents=false)`；
  - readBack 探测失败 → `prefetchedEntries=[]` → index 为空 → reload 前的专家全部解析失败（reload 后 live 路径仍可用），文案建议「重新派发专家」；
  - 主会话 `/resume`（非 reload）：`getEntries()` 全量语义已核查；T-9 为非阻塞行为锁定。

### 5.4 OQ4 模型/thinking/工具 → **v1 默认只读工具域（方案 B，✅ 用户已最终确认，§12）；P0-β 实测后再决定是否加 `consult.expertTools` 旋钮**

模型与 type 沿用专家原配置（`type: ref.agentType` + `modelOverride: ref.model`；换模型=缓存键全换，无争议）。工具集三种形态对比：

| 维度       | A. 保留专家原工具集                                                                                                                                                                                                                             | **B. 只读工具域（v1 默认，已确认）**                                                                                           | C. 保留定义、拦截执行（评审-2 #8，未来 preserve 模式首选 / B 兼容性失败的备选）                                                                                                                                                                                                                 |
| ---------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 缓存前缀   | **可能**命中，四个独立失效前提：① schema/experts 注入差异使工具块从头不同；② `thinkingOverride` 未持久化，覆盖过 thinking 即请求参数不同；③ 子会话 system prompt 含动态 memory 块；④ 5m 窗口在主用法时序下常已过期（1h 实测存活也仅 7–13.6min） | **必然全量重写**（工具块在前缀头部），首请求约 $1.5（长上下文专家，P0-α③ 校准）                                                | 工具块与 A **逐字节相同**（同名 customTools 覆盖保留原位置与 schema/description），命中前提同 A 的 ②③④                                                                                                                                                                                          |
| 副作用风险 | 150s 内持有 write/edit/bash、可能注入 Agent / message_agent                                                                                                                                                                                     | 零写能力；pi 层 allowlist 只有四件，扩展/MCP 中途注册的工具也被 registry 当场挡住                                              | 定义在、执行被拒：写能力为零；但模型看得到写工具会去试，白耗 turn（maxTurns 兜底）                                                                                                                                                                                                              |
| provider   | 与专家原请求同形，无兼容风险                                                                                                                                                                                                                    | **历史含未声明工具的 tool_use/tool_result 块**——从没跑过，P0-α② 阻塞级必测（评审-2 #3）                                        | 历史里的工具名全部有声明，无兼容风险                                                                                                                                                                                                                                                            |
| 实现       | adapter 无特判                                                                                                                                                                                                                                  | adapter `isConsultRun` 分支：跳过全部注入 + H2 后强制 `sessionSpec.tools` + toolScope 同常量 + prompt 绕过类型前缀（约 30 行） | pi 内置：`create{Bash,Edit,Write}ToolDefinition(cwd)` 同名覆盖、包一层拒绝 execute；adapter 自有 Agent/message_agent/set_model/StructuredOutput/consult 照常生成定义、包拒绝 execute；_*子会话扩展注册的工具（web_search/Task*/memory/MCP）能否同名覆盖、顺序是否不变待 P0-β 核验_*（约 80 行） |

**已确认（§12）**：v1 按 **B** 施工。A 的省钱前提要四个条件同时成立，而主用法时序使条件④在常见路径上天然不成立；B 付全价但零写风险，且翻转点集中在 adapter 一个分支。

**B 的落地规格（评审-2 #2/#5/#13）**——`runtime-adapter.run()` 内，`const isConsultRun = spec.request.forkSessionFrom !== undefined`：

1. 跳过 message_agent / set_model / 嵌套 Agent / StructuredOutput / consult 五处注入（consult 的跳过显式写 `!isConsultRun`，不依赖「请教请求不带 consultExperts」的隐含前提，评审-2 #13）；
2. **H2 之后**强制 `sessionSpec = { ...sessionSpec, tools: [...CONSULT_READONLY_TOOLS] }`——pi 会据此**激活** grep/find/ls（enforcer 只能删不能加）并把它作为 registry 层 allowlist；放在 H2 之后保证任何扩展都无法放宽；专家类型 `tools` 为 undefined（否则只剩 read）或 `["bash","write"]`（否则零工具）两种情形都被覆盖；
3. `toolScope.policy = buildToolScopePolicy({ tools: CONSULT_READONLY_TOOLS, granted: [] })`——与 2 同一常量，pi 层与 enforcer 两层同源；
4. `prompt: isConsultRun ? spec.request.prompt : buildPrompt(spec)`——append 模式类型的整段任务指令（「实现…、用 bash 跑测试」）已在 fork 历史首条用户消息里，不再重复拼接（评审-2 #5）；replace 模式的 `SessionSpec.systemPrompt` 保留（专家身份，历史即在它之下产生）；prompt 自带「只有 read/grep/find/ls」声明（§4.1）。

**P0 与旋钮（§11-1）**：

- **P0-α②（阻塞级）** B 形态 provider 兼容性。失败的备选按优先级：
  - **C1「历史引用名桩」**（首选备选）：fork 后扫描 fork 历史里出现过、但不在只读四件中的工具名，为每个名字声明一个桩定义（同名、宽松 schema、description `unavailable in consult mode`、execute 恒返回拒绝），并加入 `sessionSpec.tools`。安全性同 B（执行全拒），修复兼容性，**不**恢复缓存（工具块与专家不同），实现约 40 行，旋钮无关。
    **施工规格（review-3 #3：只读边界不得托付给两条需要逐项对齐的并行列表）**——C1 的前提「安全性同 B」只在「`sessionSpec.tools` 里每个非只读名都有对应桩」时成立；漏一项、桩构造被静默吞掉、或桩名大小写与 pi 内置（全小写 `bash/edit/write`、`read/grep/find/ls`）不一致，`tools` 里就会留下一个**裸内置名** ⇒ 请教 run 拿到真 bash（`agent-session.js:2147-2160`：registry 同名覆盖 + allowlist 内每个 registry 名都被激活）。因此：
    ① **同源生成**：`const stubNames = scanHistoryToolNames(forkFile).filter((n) => !CONSULT_READONLY_TOOLS.includes(n))`，然后 `tools = [...CONSULT_READONLY_TOOLS, ...stubNames]` 与 `customTools = stubNames.map(makeStub)` **由同一个数组一次派生**，禁止手写第二份清单；
    ② **失败即整体回退**：任一 `makeStub` 抛错 ⇒ **放弃 C1、回退纯 B**（`tools` 仍为 `CONSULT_READONLY_TOOLS`）——宁可该 provider 报错也不放宽工具域；回退记一条 `[pi-subagent]` 日志；
    ③ **名字不归一化**：桩名原样取自历史里的 tool_use `name` token（pi 内置全小写，扩展工具大小写各异），不做 lower/camel 转换；
    ④ **结构性断言测试**（包 C 单测）：给定含 `bash` / `Agent` / 未知名的历史 ⇒ `tools` 集合恰等于 `CONSULT_READONLY_TOOLS ∪ stubNames` 且每个 `stubNames` 成员都有对应 customTool；`makeStub` 抛错的 fixture ⇒ `tools` 深等于 `CONSULT_READONLY_TOOLS` 且无桩 customTool；
    ⑤ **会话级断言**（P0 探针内，§11-1 α②）：`session.getAllTools()` 中**每个非只读名的 `sourceInfo.source !== "builtin"`**（`agent-session.js:2146` 给内置工具打 `source:"builtin"`，桩走 customTools 则不是），确保没有裸内置名漏进 allowlist；
  - **C2 完整「保留定义、拦截执行」**（上表 C 列）：兼容性与缓存潜力兼得，但实现量大且扩展工具覆盖待核验——只在 P0-β 同时证明其命中率可观时才选；
  - fork 时剥离工具块：破坏上下文且改写历史，**不采纳**。
- **P0-β（决策级，不阻塞开工）**：测 C2 与 A 的实测命中率 + 主时序间隔分布；判定线（§11-1）满足 → 加 `consult.expertTools: "readonly" | "preserve"` 旋钮，preserve 用 **C2** 实现（不是 A：C2 在获得同等缓存潜力的同时保持零写能力）；否则 B 为终态。

### 5.5 OQ5 回答长度上限 → **指令自控 + 硬截断兜底**

- prompt 注入「结论先行 ≤3 行、总长 ≤N 字」（N = settings.maxAnswerChars，默认 2000）。
- 截断用 `truncateResultText(text, max)` **且不传 sessionFile**（传了会把提问方引去读一个马上要被删的 fork 文件）。实际形态为**保留头部 70% + 尾部、省略中段**，与「结论先行」相容。
- 超时/被帽/失败但 `outcome.text` 非空 → partial（`state-machine.ts:769-775`）。成本帽不再在 message_end 触发，完整答案不会被降级为 partial（§4.1）。

### 5.6 OQ6 集成点 → §8。OQ7 测试策略 → §9。

### F4 默认值与闸门汇总

| 闸门         | 值                                                                                           | 机制                                                                                                                                                                                                                                                                                                                  |
| ------------ | -------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 时间硬顶     | `consult.timeoutMs` 默认 150s                                                                | `budgetOverride.totalMs` 显式 → `maxTotalFactor=1`，无宽限无延长（`deadline.ts:96-110`）；也是 `waitOutcome` 无 timer 等待的结算保证                                                                                                                                                                                  |
| 轮次上限     | `consult.maxTurns` 默认 3                                                                    | cap watcher：新 turn 开始且 `diag.turns ≥ maxTurns` → `queueMicrotask(abortRun)`；不在 message_end 判                                                                                                                                                                                                                 |
| 成本上限     | `consult.maxFirstRequestUsd` 默认 $2（0=关预检）+ `consult.maxCostUsd` 默认 $4（0=关累计帽） | ① fork 前首轮预检：`contextTokens × max(input,cacheWrite)/1e6 > maxFirstRequestUsd` → nack cost_too_high（单价按 `ModelCost.tiers` 选档）；② turn 边界：新 turn 开始且累计 `costUsd > maxCostUsd` → abort（`StopCause` 记 `user_stop`，真实原因在 `capReason`）。**两值拆分**保证预检打满时仍有后续 turn 预算（§4.6） |
| 并发上限     | `consult.maxConcurrent` 默认 2（每提问方）+ 常量 8（全局）                                   | wireConsult 闭包计数器，超额立即 nack busy                                                                                                                                                                                                                                                                            |
| 上下文预检   | 常量 75%（percent 缺失跳过）                                                                 | 避免触发 pi 自动压缩（压缩相位预算 5 分钟 ≫ 150s）                                                                                                                                                                                                                                                                    |
| slotless     | `true`                                                                                       | 150s 短前台任务不占并发槽；queue-timeout 保护的缺失由 totalMs 硬顶 + 两级并发上限覆盖                                                                                                                                                                                                                                 |
| 深度         | 计入 parent.depth+1，受 `maxNestedDepth` 约束                                                | 超限 → spawn error → nack                                                                                                                                                                                                                                                                                             |
| 再派子 agent | 禁止（adapter 不注入 Agent + pi allowlist 只读 + nesting 不写 canSpawn）                     | 三层独立保证（§4.4）                                                                                                                                                                                                                                                                                                  |

## 6. 文件级改动清单（函数名级）

> 引用优先符号名；行号仅供定位，可能与并行改动漂移。

**包 A — 冻结面（types/threading/settings）**

1. `src/core/types.ts`：`ConsultExpertRef`（含 `contextTokens`）；`SpawnRequest` += `consultExperts?`、`forkSessionFrom?`（doc 注释见 §4.3）。**`StopCause` 不动**（review-3 #1：被帽中止复用 `user_stop`）⇒ `src/core/state-machine.ts` 的 stop_requested 分支、`diag.stopCause` 渲染、以及 `tests/core/core.test.ts` 的转移矩阵/属性测试**零改动**（AGENTS.md 要求的「改状态机须同步 matrix/property 测试」因此不触发）。
2. `src/service/request-threading.ts`：`THREADED += "forkSessionFrom"`；`NOT_THREADED += "consultExperts"`。
3. `src/config/settings.ts`：`ConsultSettings`（§4.6 **七字段**，`maxFirstRequestUsd` 默认 2 / `maxCostUsd` 默认 4）、`AgentSettings.consult`、`DEFAULT_SETTINGS.consult`、解析段（同款 number 校验模式）。
4. `src/config/setting-specs.ts`：`SETTING_SPECS` 加 `consult.enabled/timeoutMs/maxAnswerChars/maxTurns/maxFirstRequestUsd/maxCostUsd/maxConcurrent`。
   - **4b.** `src/runtime/tool-scope.ts`：导出 `CONSULT_READONLY_TOOLS`（冻结面：B/C 两包共用）；`RESERVED_TOOL_NAMES += "consult"`（注释同 set_model 先例；`index.ts:107` 的引用注释同步）。

**包 B — fork 路径（runner / spawn 准入）**

5. `src/runtime/runner.ts`：`ResolvedSpawnRequest` += `forkSessionFrom?`；session_create 分派加 fork→`driver.resume`（~3 行）；`RunnerDeps` += `onReaped?(runId, forkSessionFrom?)`；私有 `notifyReaped`；finally 的 `runReap()` 链尾回调；**迟到路径两处**（473/576）在 `disposeLate` 后回调（~12 行合计）。**`session-driver.ts` 零改动。**
6. `src/service/spawn-service.ts`：
   - spawn() 准入加 `forkSessionFrom` 分支（互斥校验、existsSync+isFile、不进 resumeLocks）；
   - canSpawn 检查加 `!req.forkSessionFrom` 豁免，深度照常计；
   - **nesting 写入加 `&& !req.forkSessionFrom`**（`:439`，评审-2 #6，一行）；
   - **顺手修缺口**：`start()` catch 的 `notifyTerminalFailure` 加 `req.parentRunId === undefined` 判据（该 catch 捕获 `runner.run()` 自身抛异常的路径——子 run 在此漏发顶层通知；session_create 失败走 runner 内部 catch → `prompt_settled`，不可达此处）。T-8 锁定。
7. `src/service/ports.ts`：`RunnerSpec` 不动。

**包 C — consult 模块与注入**

8. `src/consult/expert-index.ts`（新）：§4.5（`resolveId` / `findByLabel`，pi-free）。
   - **8b.** `src/service/resolve-target.ts`：把现有的 `matchRunId`（`:110`，现为模块私有）改为 `export`——**一行，进冻结面**（review-3 #5）。语义不变：在 `knownIds()`（records ∪ liveSnapshots ∪ tombstones）上做「精确 id → 唯一前缀」两级匹配，歧义返回 `{ambiguous:true}`。ExpertIndex 侧的 deps 适配见 §4.5。
9. `src/consult/fork-store.ts`（新）：`consultSessionDir()`、`readHeaderCwd(path)`（≤8KB 受限读）、`resolveForkCwd(sourceFile, fallbackCwd)`（两级）、**`forkExpertSession(sourceFile, fallbackCwd): { ok: true; path: string } | { ok: false; reason: string }`**、`sweepForkDir(dir, ttlMs, now)`（TTL + 无 header 残片）、`removeForkFile(path)`（consultDir 限定、ENOENT 静默）。全部同步 fs + try/catch 静默降级。
   - **`forkExpertSession` 从不抛（review-3 #2）**：`SessionManager.forkFrom` 的四种抛错（源文件空/不可解析、无 `type:"session"` header、`flag:"wx"` 冲突、mkdir/写失败）与 `readHeaderCwd` 的任何 I/O 错误全部 catch 成 `{ ok: false, reason }`（`reason` = 错误 message，单行化、截断 200 字符）。**理由**：靠抛异常穿透会直接踩翻方案自己的约定「throw 只用于提问方自己错了」与 T-4 的断言「白名单内从不 throw」。调用侧见 §4.1 伪代码与错误表的 fork 失败行。
10. `src/consult/consult-tool.ts`（新）：`ConsultSpawnPort`、`createCapWatcher`、`createConsultTool(deps)`（§4.1 全部语义）。
11. `src/consult/index.ts`（新）：`wireConsult({ settings, query, spawnService, priceOf, prefetchedEntries, consultDir })` → `{ depsFactory(selfRunId, selfCwd, whitelist), expertIndex, resolveExperts(refs), sweep(), onReaped(runId, forkSessionFrom?), dispatchSnapshot(snapshot) }`；闭包持有每提问方/全局并发计数器、watcher 注册表、端口 owned-runId 集合。
12. `src/service/runtime-adapter.ts`：
    - deps += `consult?: (selfRunId, selfCwd, whitelist) => ToolDefinition | undefined`、`consultResolveExperts?`、`onReaped?`；
    - **runnerDeps（`:324` 构造处）+= `onReaped: deps.onReaped`**（评审-2 #11①）；
    - consult 注入（set_model 注入后）：`if (spec.request.consultExperts?.length && !isConsultRun && deps.consult) { … customTools.push; grantedReserved.push("consult") }`；
    - 嵌套 Agent 工具（`:474`）+= `resolveExperts: deps.consultResolveExperts`（未注入时 agent-tool 自行 throw）；
    - **请教 run 只读域**（§5.4 B 规格四条）：跳过五处注入；H2 之后强制 `sessionSpec.tools`；toolScope 同常量；prompt 绕过 `buildPrompt`；
    - **早退路径 onReaped**：`runnerEntered` 标志 + finally（§4.4）。
    - 规模：约 45 行（v2 估 15 行，评审-2 #2 调整：加 tools 覆盖、prompt 分支、onReaped 两处、嵌套 resolveExperts）。
13. `src/tools/agent-tool.ts`：`AgentToolParams` += `experts`；deps += `resolveExperts?`；execute 内：无 dep 传 experts → throw；解析失败/ambiguous → throw；running 警告行；逐项回显 `expert "X" → run_id …`；`baseRequest.consultExperts` 穿透。

**包 D — stack 接线与文档**

14. `src/stack.ts`（buildSessionStack）：
    - `const consult = wireConsult({ …, priceOf })`——**`priceOf` 直接写在 stack.ts 里用 pi 的 `Model` 类型窄化**（review-3 #7②：`StackModelPort.find` 的返回是 `unknown | undefined`（`stack.ts:473`），strict 下取不到 `.cost`；`ctx.modelRegistry` 本身是 typed，不要绕经 `StackModelPort`；若确实需要经端口，则给 `StackModelPort` 加 `cost(provider, id)`）：
      ```ts
      const priceOf = (m: { provider: string; id: string }, contextTokens: number) => {
        const cost = ctx.modelRegistry.find(m.provider, m.id)?.cost; // ModelCost（$/M tok）
        if (!cost) return undefined;
        // review-3 #7①：request-wide 分层定价——选中 contextTokens 超过的最高档，否则用顶层费率
        const tier =
          [...(cost.tiers ?? [])]
            .filter((t) => contextTokens > t.inputTokensAbove)
            .sort((a, b) => b.inputTokensAbove - a.inputTokensAbove)[0] ?? cost;
        return { input: tier.input, cacheWrite: tier.cacheWrite };
      };
      ```
    - `consult.expertIndex.rebuildFromEntries(prefetchedEntries)`；`consult.sweep()`；
    - runtime-adapter deps（1107 一带）+= `consult: consult.depsFactory`、`consultResolveExperts: consult.resolveExperts`、`onReaped: consult.onReaped`；
    - spawn-service 的 `onSnapshot`（1214 处）尾部加 `consult.dispatchSnapshot(snapshot)`；
    - stack 对外暴露 `consult`（供 index.ts holder 转发）。
15. `docs/dev/consult/plan.md` 本文件；CHANGELOG 由 conventional commit 生成。
16. `src/index.ts`（评审-2 #11②，v2「不改」不成立）：顶层 `createAgentTool({...})`（`:282`）+= `resolveExperts: (refs) => requireStack(holder).consult.resolveExperts(refs)`——纯装配一行，符合 I7；不注册 consult 工具。

规模估算（v3）：新增 ~820 行（consult 模块 ~560），改动 ~170 行（runner ~15 / spawn ~15 / adapter ~45 / tool-scope ~5 / agent-tool ~35 / settings ~30 / stack ~20 / index ~2），测试 ~1050 行。

## 7. 零挂死论证（逐条不变量 → 保证代码）

| 不变量                   | 保证点                                                                                                                                                                                                                  |
| ------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 每个 run 有总预算硬顶    | consult 必传 `budgetOverride.totalMs = settings.consult.timeoutMs` → `maxTotalFactor=1`：无宽限、无延长、到时必死                                                                                                       |
| 工具等待必结算           | `waitOutcome(runId)` 不起 timer，但 run 必在 totalMs + abortGrace 内结算（硬顶 + 既有 L0→L4 升级）；`outcomes` 已有即返回，run 早于等待结束也不丢——与 `spawnAndWait` 等价的有界性                                       |
| 轮次/成本不失控          | cap watcher 在 turn 边界 `abortRun`（queueMicrotask 调度；端口落成 `abort(runId, "user_stop")`，§15 #1）；首轮成本由 fork 前预检（`maxFirstRequestUsd`）约束、累计由 `maxCostUsd` 约束；帽失效时 totalMs 硬顶兜底       |
| 准入不被误拒             | fork 专用分支跳过 canSpawn；深度照常计                                                                                                                                                                                  |
| 请教 run 不扩散          | adapter 不注入 Agent/message_agent + pi allowlist 只读四件 + nesting 不写 canSpawn（三层独立）                                                                                                                          |
| 子阶段 watchdog          | EventWatchdog 1Hz tick 对请教 run 同等生效                                                                                                                                                                              |
| 精确 deadline 第二生产者 | runner `guardUntil` 对 fork 路径无差别生效（fork 只改 session_create 的文件来源）                                                                                                                                       |
| reaper 孤儿回收          | fork 建会话超时/取消 → 既有 `onLateArrival` → `disposeLate` → **再 onReaped**；正常路径 onReaped 挂在 runReap 之后；adapter 早退路径直接 onReaped；残留由 sweep（TTL + 无 header 残片）兜底——**无 `_persist` 残片竞态** |
| 提问方中止级联           | 三条既有链全部命中（cascadeChildren / onChildAbort / 工具 signal 透传 `port.spawn`——**不用** `detachSignalOnStart`）                                                                                                    |
| 可确认投递               | `expectAck:true` + `waitOutcome` 同步 ack，结果随工具结果返回，不经 outbox                                                                                                                                              |
| 不产生顶层通知           | CC2 + expectAck + notifyTerminalFailure 修复（§6 包 B-6）                                                                                                                                                               |
| timer unref              | **不新增任何 timer**（watcher 走 onSnapshot tap；waitOutcome 不传 waitMs；sweep 只在 build 时同步执行）                                                                                                                 |
| 无模块级可变状态         | ExpertIndex/并发计数器/watcher 注册表/owned-runId 集合全在 wireConsult 闭包内，随栈重建                                                                                                                                 |
| 子会话惰性               | consult 不经 index.ts 注册；子会话激活被 HOST_KEY 守卫短路；注入仅发生在 adapter（本进程内）                                                                                                                            |
| forkSessionFrom 不可伪造 | RPC `additionalProperties:false`、workflow 逐字段组装；进程内唯一产出者是 consult 工具；`onReaped` 删除再加 consultDir 前缀校验                                                                                         |

## 8. 与现有子系统的集成

- **嵌套 Agent / tool-scope**：consult 注入走 customTools+grantedReserved 既有管线；M1 合并让声明了 `tools:` 白名单的类型也拿得到 consult。**请教 run 反向走只读域**（§5.4 B 规格）：pi 层 `tools` 与 enforcer 同源于 `CONSULT_READONLY_TOOLS`，顺带堵上 X11「回合中途注册工具到下一个 turn_end 前可用」的已知缺口（对请教 run 而言）。
- **通知抑制**：CC2 + expectAck + notifyTerminalFailure 修复。请教 run 终态仍写 `subagent:run` 条目（ExpertIndex 按 consultDir 排除）与 fleet 行——特性（可观测）。
- **fleet widget**：`parentRunId` 使 toRow `nested=true`、treeOrder 自动缩进；label `consult-<rand4>`。二层以上嵌套渲染未实测 → 验收 §10。
- **成本归集**：工具结果 `usage: toPiToolUsage(outcome.usage)` 进 pi 总账；fleet `usageTotal`、HUD `subagent:usage` 广播自动覆盖；`details.toolCounts` 展示只读工具使用情况。
- **cache-ttl**：无代码交互（子会话不经 wireCacheTtl 钩子）。**B 形态下缓存必然全量 miss**（工具块从头不同），首轮成本由预检约束；工具描述不再宣称「可能命中」。若 P0-β 后加入 preserve（C2）模式，命中条件清单为：① 同模型；② 专家结束在缓存窗口内（5m；`PI_CACHE_RETENTION=long` 时 1h，实测存活 7–13.6min）；③ memory 块等动态段未变；④ 专家未覆盖 thinking——届时再写进 preserve 模式的描述。判命中锚前缀 token 数比例，不看 `cacheRead>0`。
- **bash_jobs / delivery / workflow**：请教 run 是标准嵌套 run，backgroundBusy 计数在请教期间为忙——feishu 完成卡与 keepalive 判忙被按住，语义正确。

## 9. 测试锚点

**单元（tests/consult/、tests/runtime/、tests/service/）——fork 用真实 `SessionManager.forkFrom` 操作临时目录；准入与时序用真实 `createSpawnService`（+ RuntimeRunner + 假 driver，沿 `runner-x3-x11.test.ts` 先例）**

- T-1 expert-index：只收终态+sessionFile；consultDir 下记录被排除；id 精确/唯一前缀两级与 `resolve-target` 一致——**直接 import 包 C 导出的 `matchRunId`，用 index 构造的 `ResolveTargetDeps` 跑同一 fixture**（§4.5）；若改为对齐实现则两个实现双向跑同一 fixture 并断言结果相同；`findByLabel` 返回全部同名记录；缺字段容错。
- T-2 consult-tool 解析/闸门失败面：白名单外 → throw 含 allowed 列表；`enabled=false` → nack unavailable；会话缺失 → nack unavailable；按 sessionFile 命中运行中 run → nack still_running；上下文 ≥75% → nack context_too_large；percent 为 null → 不 nack；**首轮成本估值 > `maxFirstRequestUsd` → nack cost_too_high 且未调用 forkExpertSession**；est 略低于预检线（如 $1.9 < $2）→ 正常派发（拆值后不再顺带把 turn 预算压成 1，见 T-11）；单价未知 → 跳过预检；**`priceOf` 带 tiers 的模型：contextTokens 跨过 `inputTokensAbove` ⇒ 用高档单价估（review-3 #7①）**；**`forkExpertSession` 返回 `{ok:false}`（源文件被截断 / 无 `type:"session"` header 的 tmp 文件）→ nack unavailable、`port.spawn` 未被调用、且不 throw（review-3 #2）**；每提问方超帽 / **全局 8 超帽** → nack busy；nack 后并发计数已释放。
- T-3 consult-tool 成功面：假端口 spawn→runId、waitOutcome→completed → 文本 + usage 回传 + `details.truncated` + `details.toolCounts`；截断 marker 为「头 70%+尾」且不含 session transcript 指引；**spawn 请求的 prompt 含只读工具声明行**。
- T-4 consult-tool 失败面：timed_out/aborted/failed 无文本 → nack；有文本 → partial + `details.partial=true`；**`port.spawn` 返回 error / throw → nack + forkFile 已删**；断言白名单内从不 throw、从不发无 forkSessionFrom 的 spawn；**spawn 成功后工具在任何结局下都不调用 removeForkFile**（清理权属 runner）。
- T-5 入参与端口：`port.spawn` 收到 `expectAck:true`、`forkSessionFrom`=fork 路径、parentRunId = selfRunId、slotless=true、budgetOverride.totalMs = timeoutMs、cwd = 两级解析结果、同一 signal；**未调用 spawnAndWait**；端口对非 owned runId 的 waitOutcome reject、abortRun no-op；**`abortRun(runId, "turn_cap")` 实际调用的是 `SpawnService.abort(runId, "user_stop")`（断言第二参数，review-3 #1）**。
- T-6 fork-store（真实 forkFrom，tmp 目录）：源文件 sha256 不变（F2 核心断言）；fork 文件 header 含 `parentSession`、新 id、落在 consultDir；`wx` 不覆盖；**cwd 两级：header cwd 存在用之 / 不存在回退 fallback**（worktree-origin 级已删）；`readHeaderCwd` 截断与坏行容错；sweep：TTL 内合法文件保留、超 TTL 删除、**无 header 残片不论 mtime 一律删除**；`removeForkFile` 拒删 consultDir 外路径、ENOENT 静默。
- T-7 spawn-service 准入（真实 createSpawnService）：**fixture 专家类型带 `canSpawn`**（评审-2 #6）；父类型无 canSpawn + forkSessionFrom → 准入通过；无 forkSessionFrom 的同型嵌套 → 仍被拒；fork+resumeFrom → config；路径不存在 → config；不进 resumeLocks；深度超限 → config；**请教 run 的 nesting 条目无 canSpawn：以它为 parentRunId 再 spawn 专家 canSpawn 列表里的类型 → 被拒**。
- T-8 notifyTerminalFailure 修复：`runner.run` 自身抛异常 + parentRunId 非空 → 不发顶层通知。
- T-9 行为锁定（非阻塞）：主会话 jsonl 含 `subagent:run` 条目 → `getEntries()` 包含之。
- T-10 request-threading：never 断言编译门覆盖；`forkSessionFrom` 出现在 ResolvedSpawnRequest。
- T-11 cap watcher（`createCapWatcher` 纯函数 + 一条 RuntimeRunner 级）：
  - 快照序列 turn1 start/end、turn2、turn3 end、**turn4 start** → `onCap("turn_cap")` 恰好一次，且只在 turn4 start 那条快照上触发；
  - `costUsd` 在 turn2 的 message_end 越过累计帽 → 当下**不**触发；turn3 start → `onCap("cost_cap")`；
  - **最后一条消息越过 cap 仍返回 completed**：turn N 的 message_end 使 costUsd > cap，随后 turn_end + prompt 结束、无新 turn_start → 不 abort，outcome `completed`、`finalText` 完整、`details.partial` 不存在；
  - maxCostUsd=0 永不触发成本帽；终态快照后不再触发；退订后注册表为空；
  - **拆值回归（review-3 #4）**：`maxFirstRequestUsd === maxCostUsd`（$2/$2）且 est≈$1.9 的配置下，turn1 结束即累计越帽 ⇒ **turn2 start 被砍**（锁定「共用一个值 ⇒ maxTurns 恒为 1」这一退化事实）；同一快照序列在默认 $2/$4 下 turn2 **不**被砍，且 `details.turnBudgetHint ≥ 2`；`remaining < est` 的配置下断言 spawn 请求的 prompt 含 `Budget note:` 行；
  - 回调内 `onCap` 经 `queueMicrotask` 调度（断言同步栈内 abortRun 未被调用、微任务后被调用一次）。
- T-12 adapter 只读域（评审-2 #2/#5/#13）：两种 fixture——专家类型 `tools: undefined` 与 `tools: ["bash","write"]`（均带 canSpawn、systemPrompt append 模式、schema 请求、fabric 开启）：
  - **传给 driver 的 `req.tools` 深等于 `CONSULT_READONLY_TOOLS`**（H2 桩尝试放宽 tools 也被覆盖）；
  - customTools 无 Agent/message_agent/StructuredOutput/set_model/**consult**（即便请求同时带 consultExperts）；
  - `toolScope.policy.allow` = 同一常量集合；
  - `req.prompt === spec.request.prompt`（不含类型 systemPrompt 前缀）；replace 模式 fixture 下 `req.systemPrompt` 仍在；
  - 对照：普通子 run 的 tools/customTools/prompt 与改动前一致；
  - **（仅当 P0-α② 判定需要 C1）** C1 的结构性断言见 §5.4 C1 规格④：`tools` 集合 = `CONSULT_READONLY_TOOLS ∪ stubNames` 且逐名有对应 customTool；`makeStub` 抛错的 fixture ⇒ 回退纯 B（`tools` 深等于 `CONSULT_READONLY_TOOLS`、无桩 customTool）。

**集成（tests/integration/consult.test.ts，spawn-service + RuntimeRunner + 假 driver；真实 pi 会话端到端由 P0-α 一次性覆盖——仓库无假模型/录制层惯例）**

- T-13 端到端：派发带 experts 的提问方 → consult → 答案返回；断言假 driver 的 `resume` 被以 forkFile 调用、`create` 未被调用。
- T-14 并发：同专家两 consult 并行 → 各自 forkFile、各自返回、源文件字节不变。
- T-15 fork 文件清理矩阵（`onReaped(runId, forkSessionFrom)` 新签名）：
  - 正常终局 → onReaped 收到 `(consultRunId, forkFile)`，之后文件不存在；
  - 建会话失败（假 driver resume 立即 reject）→ 同上；
  - 建会话超时（resume 挂起，超时后再 resolve 出 handle，handle 的 dispose 桩在调用时往 forkFile appendFileSync 一行模拟 `_persist` 重生）→ runReap 后 onReaped 一次、`disposeLate` 后 onReaped 再一次，**最终文件不存在**；
  - adapter 早退（deadlineAt 已过期 / H2 桩 throw）→ runner 未运行，onReaped 仍被调用一次、文件已删；
  - `port.spawn` 准入 error → 工具 catch 立即删，runner/onReaped 未参与；
  - 非 fork run → onReaped 收到 `forkSessionFrom === undefined`，不删任何文件。
- T-16 reload 后同名 label（评审-2 #9）：冻结条目 → 重建栈（records/labels 空）→ 新 run 起同名 label X →
  - `Agent({experts:["X"]})` → **throw ambiguous，文案同时列出旧专家与新 run 的 runId**；
  - `Agent({experts:["<旧 runId>"]})` → 派发成功，结果回显 `expert "<id>" → run_id <旧 runId>`，consult 问到旧专家（假 driver 断言 resume 的文件 parentSession = 旧专家 sessionFile）。
- T-17 提问方中止：consult 进行中 abort 提问方 → consult run aborted、工具返回 nack/partial，forkFile 经 onReaped 清理。
- T-18 fleet：consult run toRow `nested===true` 且 parentRunId 指向提问方。
- T-19 零通知：全程主会话 `subagent:notification` 条目数为零、无 triggerTurn。
- T-20 派发时校验：experts 含不存在项 → throw 含候选列表；含运行中项 → 成功且含警告行；**嵌套 Agent 工具（无 resolveExperts 的构造）传 experts → throw**；`consult.enabled=false` 传 experts → throw。
- **T-21 「reap 早于工具拿到结果」时序（评审-2 #1）**：假 driver resume 立即 reject（无 handle，reap 近乎零耗时）；假端口包装在 `spawn()` 返回后、`waitOutcome()` 调用前挂起，直到观测到 onReaped 被调用（以一个 deferred 信号同步，不靠计时）再放行：
  - 断言 onReaped 已在工具调用 `waitOutcome` **之前**触发且 forkFile 已删；
  - 断言 `waitOutcome` 仍经 `outcomes` Map 立即取到 failed outcome，工具返回 nack `unavailable|failed` 而非挂起；
  - 断言整个过程无任何「按 runId 登记删除」的状态（wireConsult 闭包里无删除注册表可查——以 onReaped 的调用参数与文件系统状态为唯一判据）；
  - 反向时序（工具先进 waitOutcome、run 后结算、reap 更晚）同样通过。

## 10. 实施顺序与分包

| 包                                  | 内容                                                                                                                                  | 依赖 | 可并行                                                                                |
| ----------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------- | ---- | ------------------------------------------------------------------------------------- |
| **P0-α 验证**（阻塞一切）           | §11-1 α①–④：fork 链路端到端、**provider 兼容性矩阵**、B 首请求成本与越权工具调用、fork+open 整链耗时                                  | 无   | —                                                                                     |
| **A 冻结面**                        | §6 包 A（types/threading/settings/`CONSULT_READONLY_TOOLS`）；按 P0-α③ 结果写定 `maxFirstRequestUsd`（及其 2× 的 `maxCostUsd`）默认值 | P0-α | P0-β 可与 A–E 并行                                                                    |
| **B fork 路径**                     | §6 包 B（runner 分派 + onReaped 新签名 + 迟到路径回调 + spawn 准入分支 + nesting 修正 + notifyTerminalFailure 修复）                  | A    | 与 C 并行                                                                             |
| **C consult 模块**                  | §6 包 C（src/consult/\* + adapter 注入/只读域/早退 onReaped + agent-tool）；若 P0-α② 失败则含 C1 桩（§5.4）                           | A    | 与 B 并行（冻结面 = §4.3 字段 + §4.4 `onReaped(runId, forkSessionFrom?)` + 只读常量） |
| **D 接线收口**                      | §6 包 D（stack.ts + index.ts 一行）+ 单元 T-1..T-12                                                                                   | B+C  | —                                                                                     |
| **E 集成验收**                      | T-13..T-21 + fleet 二层嵌套手动验收 + `npm run format:check && typecheck && test && build`                                            | D    | —                                                                                     |
| **P0-β 决策**（不阻塞，结果入 §12） | §11-1 β⑤–⑦：C2/A 命中率 + 对照组 + 主时序间隔分布 → 是否加 `consult.expertTools` 旋钮                                                 | P0-α | 与 A–E 并行                                                                           |

包间冻结面 = §4.3 两个字段（含 `ConsultExpertRef` 形状）+ §4.4 `onReaped(runId: RunId, forkSessionFrom?: string) => void` 签名（**v3 变更：v2 的单参 `onReaped(runId)` 作废，必须在包 A 合并前以此为准**）+ `CONSULT_READONLY_TOOLS` 常量 + §4.5 `ExpertRecord` 形状 + **v3.1 追加三项**：`ConsultSettings` 的七字段形状（`maxFirstRequestUsd` / `maxCostUsd` 拆分，§4.6）、`resolve-target.ts` 导出的 `matchRunId`（§6 C-8b）、`forkExpertSession` 的结果对象签名（§6 C-9）。包 A 合并后不得再改。**明确不在冻结面内**：`StopCause`（review-3 #1 决定不扩，§15 #1）。

## 11. 风险与待验证项

1. **P0 探针**（最高危；评审-2 #3/#7 重设计）。载体：`scripts/exp/consult-fork-probe.ts`（经 jiti/tsx 运行，直接 import 仓库源码）。
   - **会话创建与真实子 run 同构**：import `toCreateOptions`（`session-driver.ts:264`，driver 实际使用的构造函数）+ `SessionManager.open(forkFile)`；**在创建会话前预占 `globalThis[Symbol.for("pi-subagent:host")]`**，使 pi-toolkit 扩展按子会话形态加载（pre-guard 的 web_search/todo/memory 照常注册，post-guard 惰性）——与真实子 run 的扩展/memory 前缀一致，且不会在探针进程里以宿主身份建出整套 stack（评审-2 #7①）；
   - **adapter 注入逐项复刻，清单写进探针输出**：A/C2 形态按专家当时的请求复刻 set_model（无条件）、message_agent（fabric 开启时）、Agent（类型有 canSpawn）、StructuredOutput（带 schema）、consult（带 experts）；B 形态按 §5.4 B 规格四条（tools 强制只读、prompt 无类型前缀）。

   **P0-α（阻塞级，全部通过才开工包 B/C）**：
   - ① fork 链路端到端：有回答且看得见历史；源文件 sha256 前后一致；fork 文件落点与 header parentSession 正确；systemPrompt 组装不报错。
   - ② **provider 兼容性矩阵（评审-2 #3；判定标准与路由枚举按 review-3 #6 改）**：用「历史含未声明工具（bash/edit/write/Agent/StructuredOutput/message_agent 等）的 tool_use/tool_result 块 + 只读四件工具表」发请求。
     **通过标准（三条全真，全部可机械判定——不再有「回答正常」这种要人肉看一眼的判据）**：(a) 最后一条 assistant 消息 `stopReason !== "error"`，等价于 `session-driver.ts:231` 的 `getTurnError()` 返回 `undefined`；(b) 未声明工具**零调用**——把本次会话的 `getActiveToolNames()` 作为白名单，比对实际 tool_use 名集合，交集之外为空；(c) 回答中出现**只有 fork 历史里才有的事实 token**：探针预先在专家会话里埋一个随机串（`CONSULT-PROBE-<rand8>`）并在问题里要求原样复述，命中才算「看得见历史且答出来了」。C1 形态额外加 §5.4 C1 规格⑤的 `getAllTools()` 断言（每个非只读名 `sourceInfo.source !== "builtin"`）。
     **必测路由 = 动态求并集**（不冻结清单）：探针启动时遍历已注册 agent 类型的 `model` / `modelHint` 加上 pi 默认模型，经 `ctx.modelRegistry.find(provider, id)` 反查 `api` 去重，得到本次必测集合；`anthropic-messages` 无论是否被类型引用都必测（默认路由）。冻结清单只作为「当前预期结果」写进探针输出以便比对——本机现状（`~/.pi/agent/models.json`，review-3 核对）：`anthropic-messages` = cloudrouter-anthropic〔默认〕/ newapi-aws / copilot-anthropic / moonshot；`openai-responses` = cloudrouter-response / zhipu-pool；`openai-completions` = copilot-completion / droid-completion / cloudrouter-kimi；**另有 `kimi-coding` / `zai-coding-cn` / `zai` 三个 `models: []`、无显式 api 的 provider（走 pi 内置 preset），其 api 只能靠反查得到——按冻结清单测就会漏**；`bedrock-converse-stream` 当前无配置，标 N/A，**首次配置 bedrock 路由前补测**。任一必测路由失败 → 该路由启用 C1 桩（§5.4），C1 同样过本项才算通过；C1 也失败 → 方案回到评审。
   - ③ **B 首请求成本**：在「中等（~50k）/ 长（~150k）上下文」两个真实专家上各测一次首请求 `usage.cost`，校准 §4.6 的 `maxFirstRequestUsd`（$2，`maxCostUsd` 取其 2×）与首轮预检公式（含 `ModelCost.tiers` 选档，review-3 #7①）（估值与实测偏差 >30% 则改公式系数）；同时记录**调用不存在工具的次数**（>0 说明 prompt 声明不够，需加强文案或考虑 C1 桩的拒绝文案）。
   - ④ **fork + open 整链耗时**（评审-2 #14）：造 ~10MB 会话文件，计时 `forkFrom`（读源 + 写 + 实例构造重读）+ `driver.resume` 的 `open`（再读）整条链，见 §11-2。

   **P0-β（决策级，不阻塞开工）**：
   - ⑤ **对照组**：同一专家、同配置、结束后 5 分钟内以 A 形态 resume（fork）一次，得到「最好情况」命中率基线——没有它，失败场景的数据无法解读；
   - ⑥ **C2 与 A 形态命中率**：fork 后首请求 `cacheRead` 占专家最后一次前缀 token 数的比例（锚前缀 token 数，不看 `cacheRead>0`）；场景「带 schema / thinkingOverride / 结束 >5min」各一次；C2 同时核验子会话扩展工具的同名覆盖与顺序不变（§5.4 C 列待核验项）；
   - ⑦ **主时序可测化**：从现有 `~/.pi/agent/sessions/**/*.jsonl` 的 `subagent:run` 条目统计「上一个 run 结束（终态 updatedAt）→ 同一主会话下一个 run 派发（createdAt）」的间隔分布（串行链的代理指标），给出 P50/P90。
   - **判定线**：C2 命中率 ≥ 60% **且** ⑦ 的间隔 P50 ≤ 7 min（TTL 实测存活下界）→ 加 `consult.expertTools: "readonly" | "preserve"` 旋钮（preserve = C2，默认仍 readonly，由用户决定是否改默认）；否则 B 为终态、旋钮不做。

2. **fork 同步读写的事件循环阻塞**（评审-2 #14）：一次请教整读会话文件三遍（forkFrom 读源、实例构造重读、open 再读）。阈值以**整条链**为准：10MB 下整链 >100ms 时，fork-store 改为手写流式 fork（保持 wx + 新 id + parentSession 语义，不构造 SessionManager 实例，~40 行）——只能省掉实例构造那一遍（3→2 遍），接口不变；若仍超阈，记录为已知限制（请教是低频前台操作，上下文预检已排除巨型会话中的大部分），不引入异步化改造。
3. **`onReaped` 时序**：正常路径在 `runReap()`（含 beforeReap + reaper.reap 内的 dispose）完成后触发，dispose 引发的 `_persist` 已落盘，删除在其后；**迟到路径**的 `createAgentSession` 与 runReap 各自独立——迟到会话的写入发生在 createP resolve 之前，runner 在 `disposeLate` 后再回调一次 onReaped 删除（幂等），sweep 对无 header 残片不受 TTL 限制兜底（评审-2 #10，v2「删除在其后，无竞态」的措辞只对正常路径成立，已更正）。reap 自身有 `budget.reapMs` 预算，onReaped 链在 promise 上，不阻塞 runner。T-15/T-21 锁定。
4. **fleet 二层以上嵌套渲染**：E 阶段手动验收；渲染异常不阻塞功能，单列 issue。
5. **B 形态下模型尝试不存在的工具**：历史里满是 bash/write 用法。缓解：prompt 明示只读四件（§4.1）、maxTurns 兜底；P0-α③ 量化，>0 次时加强文案。
6. **pi 核心按会话 id 的目录外索引未查**：fork 文件在 cache 目录且生命周期短，风险已消解。
7. **resume 续跑窗口**：resume 准入到 `session_created` 之间按 sessionFile 扫不到——秒级、后果有限，接受。
8. **并行改动冲突**：触碰 spawn-service 准入段、runtime-adapter 注入段、runner finally 三个热点；施工一律按符号名定位。

## 12. 用户确认记录（2026-09-24）

- OQ2：**v1 只给子 agent**（主会话不注册 consult，需要时继续用 `Agent({resume})`）——确认。
- OQ4（首次，v1 时）：被请教的专家保留其原工具集（换取缓存前缀命中）——确认；**已被下方最终确认取代**。
- 开工仍以 opus-5.5 评审结论为准（HARD GATE）。
- ✅ **OQ4 用户最终确认（2026-09-24，v2 之后）：方案 B「v1 默认只读工具域，P0 探针实测后再决定是否加 `consult.expertTools` 旋钮」**——用户曾短暂改选 A（保留原工具），听取缓存前提/写风险/可逆性分析后改回 B。施工以 §5.4 的 B 为默认；P0-β 满足判定线（C2 命中率 ≥60% 且主时序间隔 P50 ≤7min）时，再加 `consult.expertTools: "readonly" | "preserve"` 旋钮（preserve 用 C2「保留定义、拦截执行」实现，见 §5.4）。

## 13. 评审处置表（review-1.md，21 条）

| #   | 严重度 | 处置              | 方案改动位置                                                                                                                        | 理由                                                                                                                                                                                                                                                                                                                                                                                                                                     |
| --- | ------ | ----------------- | ----------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | 阻塞   | **采纳**          | §4.4（fork 准入分支跳过 canSpawn、深度计入 parent.depth+1、请教 run nesting 无 canSpawn）、§7、§9 T-7                               | 抽验 `spawn-service.ts:335-345/430/447` 属实：每个 run 都写 nesting，父类型无 canSpawn 时请教必被拒且 spawnAndWait throw。深度口径按评审要求写死为「计入并受 maxNestedDepth 约束」。T-7 用真实 createSpawnService。（v3 补：nesting 无 canSpawn 需显式 `!req.forkSessionFrom` 判据，见 §14 #6）                                                                                                                                          |
| 2   | 严重   | **采纳（方案①）** | §3、§4.4、§5.1、§6 包 B/C、§9 T-6/T-15                                                                                              | 方案①同时消解 (a) 路径不可知、(b) 失败路径泄漏、(c) reap 竞态与 #16 依赖反转：工具侧同步 fork 路径先知；`driver.resume` 接缝复用使 driver 零改动；删除挂 `onReaped`（runner 新增 ~5 行回调），崩溃残留由 TTL sweep 兜底。（v3 补：onReaped 改带 forkSessionFrom、去掉 pendingDeletions、覆盖迟到与早退路径，见 §14 #1/#10）                                                                                                              |
| 3   | 严重   | **部分采纳**      | §5.4（对比表+推荐只读+P0 探针+翻转点）、§4.4/§6 包 C-12（adapter 只读域）、§8（cache 措辞改「可能命中」+条件清单）、§9 T-12、§12 ⚠️ | **（v2 原文；结论已被 §12 用户最终确认与 §14 #8 取代——现行口径是方案 B）** 评审的四个前提质疑全部有代码证据（已抽验 444-457/371/395-440）。v2 当时的处理是「但用户已确认 A，不擅自推翻」：v2 默认按只读施工并把决策连同 P0 探针数据设计交还用户。「保留定义、拦截执行」无现成接缝（toolScope 只有 allow/deny），不构成第三条路。（**v3 更正**：用户已最终确认 B（§12）；「无现成接缝」判断有误——同名 customTools 覆盖即接缝，见 §14 #8） |
| 4   | 严重   | **采纳**          | §4.1（watcher）、§4.6（maxTurns/maxCostUsd）、§5 F4 表、§9 T-11                                                                     | 仓库确无 run 级 maxTurns（仅 goal 有）。经 `deps.onSnapshot` tap 实现，不新增 timer；超帽 abort 后按 #10 返回部分答案。（v3 补：改 turn 边界判定 + 首轮预检 + 默认 $2，见 §14 #4）                                                                                                                                                                                                                                                       |
| 5   | 严重   | **采纳**          | §4.2（派发时 resolveExperts：失败 throw、running 警告）、§4.3（consultExperts 改存 ConsultExpertRef）、§4.5、§9 T-16/T-20           | labels 只写不删 + reload 清空 + live 优先，确实会重放 e1-r2 问错人。准入时解析成 runId 后 label 仅显示用；解析失败当场反馈调度方。（v3 补：live 优先改 ambiguous，见 §14 #9）                                                                                                                                                                                                                                                            |
| 6   | 严重   | **采纳**          | §5.1（cwd 解析链 existsSync → worktree-origin → 提问方 cwd）、§9 T-6                                                                | `worktree.ts:90-123` beforeReap 删 worktree 属实；`core/worktree-origin.ts` 现成（pi-free、Symbol.for 全局），但 per-reap 清理后可能 miss，故需三级兜底。（v3 更正：worktree-origin 级生产中必然 miss，已删为两级，见 §14 #12）                                                                                                                                                                                                          |
| 7   | 严重   | **采纳**          | §9 全部重写；§10 P0                                                                                                                 | 核查属实（tests/integration 无真 pi 会话）。fork 单测改用真实 `forkFrom`+tmp 目录，F2 字节断言落在 T-6（真实 SDK）；准入用真实 createSpawnService（T-7）；评审列的缺失锚点全部补齐（T-7/T-4/T-15/T-6/T-16/T-12/T-2/T-11）                                                                                                                                                                                                                |
| 8   | 一般   | **采纳**          | §4.1 错误表（spawn 准入 throw → try/catch → nack + 立即删 forkFile）、§1 F1 行                                                      | `spawnAndWait` throw（:447）属实；两处口径统一为「白名单外/空问题 throw，其余一律 nack」。（v3：改用 `port.spawn` 的 `{error}` 返回值，语义不变）                                                                                                                                                                                                                                                                                        |
| 9   | 一般   | **采纳**          | §5.5、§9 T-3                                                                                                                        | 抽验 `result-text.ts:14-45`：确为头 70%+尾，且传 sessionFile 会追加读文件指引。调用时不传 sessionFile，文档写明实际截断形态                                                                                                                                                                                                                                                                                                              |
| 10  | 一般   | **采纳**          | §4.1 错误表（partial 行）、§5.5、§9 T-4                                                                                             | `state-machine.ts:769-773` 注释属实；「结论先行」下部分答案正是最有价值的部分                                                                                                                                                                                                                                                                                                                                                            |
| 11  | 一般   | **采纳**          | §4.1（label 改 `consult-<rand4>`）、§4.5（按 consultDir 排除，结构化判据）、§9 T-1                                                  | label 前缀排除三重不可靠（用户可仿冒/36 截断/live 路径未排除）属实；consultDir 判据两条路径通用且不可伪造；随机 base 消除 999 后缀耗尽                                                                                                                                                                                                                                                                                                   |
| 12  | 一般   | **采纳**          | §4.5（按 sessionFile 扫 live）、§4.1 still_running 行、§9 T-2、§11-7                                                                | resume=新 runId 同 sessionFile（`spawn-service.ts:411-416` 双键锁佐证）属实；resumeLocks 是 spawn-service 闭包私有，不为其开端口——live 扫描已覆盖主体，秒级残余窗口声明接受                                                                                                                                                                                                                                                              |
| 13  | 一般   | **采纳**          | §4.1（busy nack）、§4.6（maxConcurrent 默认 2）、§9 T-2                                                                             | slotless 绕过槽位池属实；每提问方计数器在 wireConsult 闭包，随栈重建                                                                                                                                                                                                                                                                                                                                                                     |
| 14  | 一般   | **部分采纳**      | §1 非目标（workflow 不支持 experts）、§4.2 声明、§5.2 安全模型段                                                                    | (a) workflow 穿透评估为超出 v1 爆炸半径（spawner-adapter/ChildSpawnRequest/journal 回放三面都要动），显式列非目标；(b) 不采纳子树限制（杀掉兄弟授权主用法），但把「任何 Agent 调用方可授权任意可解析终态 run，与 resume 同级信任」写入安全模型                                                                                                                                                                                           |
| 15  | 一般   | **采纳**          | §5.1、§6 包 C-9                                                                                                                     | `getAgentDir` 是 pi 官方访问器且 session-driver 已 import；上推两级在自定义 session 目录/`PI_CODING_AGENT_DIR` 下确实会算错                                                                                                                                                                                                                                                                                                              |
| 16  | 一般   | **采纳**          | §3 依赖方向、§4.4                                                                                                                   | 随 #2 方案①自然消解：driver 零改动，`readHeaderCwd` 留在 consult/fork-store，cwd 经 `SpawnRequest.cwd` 传入；header 读取限定首行 ≤8KB                                                                                                                                                                                                                                                                                                    |
| 17  | 一般   | **采纳**          | §5.3（两条降级路径 + nack 文案）、§9 T-9 降非阻塞、§10 P0 不再依赖                                                                  | rememberAgents=false 无 sessionFile（session-driver.ts:312-313）与 readBack 失败 prefetchedEntries=[]（stack.ts:849-850）属实；`getEntries` 全量语义（session-manager.js:982-984）支持风险降级                                                                                                                                                                                                                                           |
| 18  | 一般   | **采纳**          | §6 包 B-6（理由更正为「runner.run 自身抛异常」路径）、§9 T-8                                                                        | 抽验确认：driver 同步抛错走 runner 内部 catch → prompt_settled（`state-machine.ts:760` 合法相位），不可达 spawn-service.ts:243；修复保留                                                                                                                                                                                                                                                                                                 |
| 19  | 一般   | **采纳**          | §4.1（context_too_large nack）、§4.6（75% 常量）、§8（「可能命中」+条件清单）、§9 T-2                                               | 压缩相位预算 5min ≫ 150s 属实（`deadline.ts` DEFAULT_BUDGET）；`diag.contextUsage.percent` 现成（types.ts:248-252,403）                                                                                                                                                                                                                                                                                                                  |
| 20  | 建议   | **采纳**          | §4.1（schema 仅 expert/question）、§4.6（settings 收敛为 6 项；forkTtlMs/阈值转内部常量）                                           | 模型面旋钮与 settings 上下界重复属实；F4 上限由 settings 权威控制                                                                                                                                                                                                                                                                                                                                                                        |
| 21  | 建议   | **部分采纳**      | §4.5（三级解析与 resolve-target 语义对齐 + 一致性 fixture 测试）、§9 T-1                                                            | 不采纳「回灌 records/tombstones」为 v1 一部分：records 回灌会改变 fleet/query/outbox/backgroundBusy 等**全体消费者**的 reload 后行为，tombstone TTL 语义需凭空合成，爆炸半径远超 consult——但它确为「reload 后 `Agent({resume})` 失效」已知缺陷的正解方向，**单列为后续议题**（建议独立设计评审）。采纳其廉价部分：解析语义对齐，杜绝两边 drift                                                                                           |

## 14. 评审处置表（review-2.md，15 条）

| #   | 严重度   | 处置     | 方案改动位置                                                                                                                                                                                                                                  | 理由                                                                                                                                                                                                                                                                                                                                                                                                                                                                               |
| --- | -------- | -------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | **阻塞** | **采纳** | §2（spawn/waitOutcome 现状）、§3 流程 ⑥–⑨、§4.1（`ConsultSpawnPort` + 执行时序伪代码）、§4.4（`onReaped(runId, forkSessionFrom?)`、`notifyReaped`、adapter 早退路径）、§5.1 生命周期、§6 B-5/C-11/C-12、§7、§9 T-5/T-11/T-15/T-21、§10 冻结面 | 抽验 `agent-tool.ts:20-23`（NestedSpawnPort 只返回 outcome）、`spawn-service.ts:454-516`（waitOutcome 对已结算 run 即刻返回）、`agent-tool.ts:343/366` + `index.ts:282-294`（先例）、`runner.ts:603` 属实。另立 `ConsultSpawnPort`（owned-runId 限定）而非给 NestedSpawnPort 加 waitOutcome，避免嵌套 Agent 工具获得 ack 任意 run 的能力（X3）。删除事实随请求穿透到 runner，pendingDeletions 删除，竞态结构性消失；补上 v2 也漏掉的 adapter 早退路径（runner 未运行则无 finally） |
| 2   | 严重     | **采纳** | §2（pi 层工具激活）、§5.4 B 规格第 2/3 条、§4.6（`CONSULT_READONLY_TOOLS` 常量）、§6 A-4b/C-12（规模 15→45 行）、§8、§9 T-12                                                                                                                  | 抽验 `sdk.js:139-144`（未设 tools 默认 read/bash/edit/write；grep/find/ls 须显式写入）、sessionSpec `tools: spec.type.tools`、`tool-scope.ts` recompute 基于 getActiveTools 属实。强制点放 H2 之后，任何扩展无法放宽；pi 层与 enforcer 同源一个常量；T-12 断言传给 driver 的 tools 并覆盖 undefined / `["bash","write"]` 两种 fixture                                                                                                                                              |
| 3   | 严重     | **采纳** | §2（provider 工具表来源 + 本机路由清单）、§5.4（provider 行、C1/C2 备选及取舍）、§11-1 P0-α②（阻塞级矩阵）、§10                                                                                                                               | pi-ai 只转换 `context.tools`、历史原样透传属实；B 形态从未跑过。路由按本机 `models.json` 列出（anthropic-messages 必测、openai-responses/completions 视类型模型必测、bedrock N/A）。失败备选首选 C1「历史引用名桩」（安全同 B、~40 行、不依赖缓存假设），C2 只在 P0-β 证明命中率时选；剥离工具块破坏上下文，不采纳。（**v3.1 补**：C1 的桩列表与 `sessionSpec.tools` 必须同源生成、构造失败整体回退纯 B，见 §15 #3；α② 判定标准与路由枚举见 §15 #6）                               |
| 4   | 严重     | **采纳** | §2（turns/lastTurnStartAt/costUsd 时序、模型单价来源）、§4.1（`createCapWatcher` turn 边界判定、首轮成本预检、cost_too_high nack）、§4.3（`contextTokens`）、§4.6（默认 $2 + 依据）、§5 F4 表、§9 T-2/T-11                                    | 抽验 `state-machine.ts:656-663`（turns 在 turn_end 自增、lastTurnStartAt 粘滞）与 `runner.ts:548`（中止即 finalText undefined）属实。以 lastTurnStartAt 变化判「新 turn 开始」，最后一条回答越帽不会再有 turn_start，完整答案保留；首轮成本在 fork 前按写入单价预检；默认值 P0 前 $2，P0-α③ 实测后按 P90×1.3 重定。（**v3.1 更正**：单值同时当预检阈值与累计帽会把 `maxTurns` 压成 1，已拆成 `maxFirstRequestUsd` $2 + `maxCostUsd` $4，见 §15 #4）                                |
| 5   | 一般     | **采纳** | §2（buildPrompt 现状）、§4.1 prompt 模板（只读工具声明）、§5.4 B 规格第 4 条、§9 T-3/T-12                                                                                                                                                     | 抽验 `runtime-adapter.ts:202-206` 属实。请教 run 按 `isConsultRun` 绕过类型前缀（原任务指令已在 fork 历史中）；replace 模式 systemPrompt 保留（专家身份）；prompt 明示只读四件，P0-α③ 量化越权调用次数                                                                                                                                                                                                                                                                             |
| 6   | 一般     | **采纳** | §2（canSpawn 闸现状更正）、§4.4（nesting 写入加 `!req.forkSessionFrom`、「两层独立保证」替换 v2 的错误说法）、§5 F4 表、§6 B-6、§9 T-7                                                                                                        | 抽验 `spawn-service.ts:439` 用 `config.canSpawn`（被派 run 自己类型）属实，v2 说法错误。一行修复同时堵住将来 preserve 旋钮的口子；T-7 fixture 改用带 canSpawn 的专家类型                                                                                                                                                                                                                                                                                                           |
| 7   | 一般     | **采纳** | §11-1（P0 拆 α/β；HOST_KEY 预占 + `toCreateOptions` 同构建会话 + 注入清单；对照组；主时序改从 sessions jsonl 统计；B 形态三项；整链计时；新判定线）、§10                                                                                      | 选评审给出的「复刻 adapter 注入并写出清单」一路，并用预占 HOST_KEY 让扩展按真实子会话形态加载——既避免探针进程以宿主身份建栈，又保留 pre-guard 工具与 memory 前缀（禁用扩展会改变前缀，不采纳 `noExtensions`）。临时调试命令需先有包 B 的 fork 路径，与「P0 阻塞一切」矛盾，不选                                                                                                                                                                                                    |
| 8   | 一般     | **采纳** | §2（同名覆盖接缝事实）、§5.4 对比表新增 C 列、C1/C2 备选、旋钮 preserve 改用 C2、§12、§13 #3 行加更正注                                                                                                                                       | `agent-session.js:2098-2150` 同名 customTools 覆盖保留原位置、`dist/index.d.ts:24` 导出 `create*ToolDefinition` 已抽验，v2「无现成接缝」判断撤回。子会话扩展工具的覆盖行为未核实，列为 P0-β 核验项而非直接断言                                                                                                                                                                                                                                                                     |
| 9   | 一般     | **采纳** | §1 F3 行、§4.2（ambiguous throw + 逐项回显 `expert "X" → run_id`）、§4.5（`resolveId`/`findByLabel`，废弃 live 优先与后来者覆盖）、§5.3、§9 T-1/T-16                                                                                          | reload 清空 labels 后同名新 run 与旧专家确实会被 live 优先解析错。改为跨源 runId 去重后 >1 即 ambiguous；与 resolve-target 只在 id 两级对齐，label 语义有意不同并声明                                                                                                                                                                                                                                                                                                              |
| 10  | 一般     | **采纳** | §2（迟到路径现状）、§4.4（迟到回调 disposeLate 后再 onReaped）、§5.1 生命周期（sweep 对无 header 残片不受 TTL 限制）、§7、§11-3 措辞更正、§9 T-15                                                                                             | 抽验 `runner.ts:473/576`、`session-driver.ts:354-356`、`reaper.ts:167`（disposeLate 同步）属实。两项都做：回调覆盖可预期路径，sweep 覆盖回调之外的残片；合法 fork 文件首行必为 header（wx 先写），按 header 判残片不会误删                                                                                                                                                                                                                                                         |
| 11  | 一般     | **采纳** | §4.2（注入点、无 dep 时 throw）、§6 C-12（runnerDeps onReaped 透传、嵌套 Agent 注入 resolveExperts）、§6 D-16（index.ts 一行 holder 转发）、§9 T-20                                                                                           | 抽验 `runtime-adapter.ts:324`（runner 构造）、`:474`（嵌套 createAgentTool 无 resolveExperts）、`src/index.ts:282` 属实。嵌套调度方注入 resolveExperts（与 resume 同级信任）；任何未注入的上下文传 experts 显式 throw                                                                                                                                                                                                                                                              |
| 12  | 一般     | **采纳** | §2（worktree-origin 现状）、§3 流程 ⑤、§4.1 工具描述、§5.1（两级 cwd + 语义声明）、§6 C-9、§9 T-6                                                                                                                                             | 抽验 `worktree.ts:150-153` finally 无条件 forget 属实，第二级生产不可达。删除该级（fork-store 不再依赖 core/worktree-origin）；worktree 被保留时 header cwd 仍存在，第一级自然覆盖；「看到的是提问方 checkout」写进工具描述                                                                                                                                                                                                                                                        |
| 13  | 建议     | **采纳** | §3 流程、§5.4 B 规格第 1 条、§6 C-12、§9 T-12                                                                                                                                                                                                 | 显式 `!isConsultRun` 条件成本为零，消除隐含前提                                                                                                                                                                                                                                                                                                                                                                                                                                    |
| 14  | 建议     | **采纳** | §2（三次整读）、§11-1 α④、§11-2（阈值按整链；流式 fork 只省一遍，仍超阈则记已知限制）                                                                                                                                                         | `session-manager.js:1275` 与 `session-driver.ts:326` 两次重读属实                                                                                                                                                                                                                                                                                                                                                                                                                  |
| 15  | 建议     | **采纳** | ① §4.1 watcher `queueMicrotask`；② §4.6 `CONSULT_MAX_GLOBAL_INFLIGHT=8`（常量，不进 settings）；③ §4.1 错误表 percent 缺失跳过；④ §4.2 派发时 existsSync；⑤ §4.1/§4.2 enabled=false 行为；⑥ §4.1 `details.toolCounts`；§9 T-2/T-3/T-11/T-20   | 六项均为低成本补全；② 作为内部常量而非设置，沿用评审-1 #20 的防旋钮蔓延原则                                                                                                                                                                                                                                                                                                                                                                                                        |

## 15. 评审处置表（review-3.md，10 条：6 一般 + 4 建议，无阻塞/严重）

> review-3 结论为「有条件通过」，要求在**包 A 冻结前**定口径。下表 10 条**全部采纳**（其中 #1/#4 在评审给的两条出路里做了选择并写明代价），无「不采纳」项。

| #   | 严重度 | 处置                              | 方案改动位置                                                                                                            | 选定口径与理由                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 |
| --- | ------ | --------------------------------- | ----------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | 一般   | **采纳（选「复用既有 cause」）**  | §4.1（`ConsultCapReason` 类型 + `abortRun(runId, reason)` 注释）、§5 F4 表、§6 包 A-1、§7、§9 T-5/T-11、§10 冻结面      | **`StopCause` 保持闭合五值不扩**，`abortRun` 端口内部调 `SpawnService.abort(runId, "user_stop")`；被帽的真实原因留在 watcher 的 `capReason` 与 `details.outcome="turn_cap"\|"cost_cap"`（方案原本就有）。**理由**：扩 `StopCause` 会波及 `src/core/state-machine.ts` 的 stop_requested 分支（`:589-599`）、`diag.stopCause` 的全部消费者、以及 AGENTS.md 点名必须同步更新的**转移矩阵 + 属性测试**（`tests/core/core.test.ts`），而 `core/types.ts` 正是包 A 冻结面——为一个纯展示层的区分度付这笔钱不划算。**代价（写明、接受）**：fleet 行与 `diag.stopCause` 会把被帽中止显示成 user_stop，F6 可观测性打折；补偿是 T-5 断言第二参数确为 `"user_stop"`，防止将来有人「顺手」扩类型。本次改动对 `state-machine.ts` 与矩阵/属性测试**零触碰**。 |
| 2   | 一般   | **采纳**                          | §3 流程 ⑤、§3 模块表、§4.1 伪代码 + 错误表新增 fork 失败行、§6 C-9、§9 T-2                                              | `SessionManager.forkFrom`（`session-manager.js:1237-1276`）在四种情形抛异常（源文件空/不可解析、无 `type:"session"` header、`flag:"wx"` 冲突、mkdir/写失败），而 v3 伪代码里它裸跑在只有 `finally` 的 try 内 ⇒ 会白名单内 throw，踩翻自己的约定与 T-4 断言。改为 **`forkExpertSession` 返回 `{ok:true;path} \| {ok:false;reason}`、从不抛**（靠抛异常穿透等于把控制流交给 SDK），调用侧 `!ok` → nack `unavailable`，且此时**未发任何 spawn**。附带记下一条评审没提的事实：header 写成功、逐条 append 中途失败会留下半截 fork 文件，路径由 `forkFrom` 内部生成、外部不可知（且首行是合法 header，逃过「无 header 即删」规则）⇒ 只能由 24h TTL sweep 兜底，已写进错误表。                                                                        |
| 3   | 一般   | **采纳（保留 C1，补死施工规格）** | §5.4 C1 备选（新增施工规格①–⑤）、§9 T-12 末条、§11-1 α②                                                                 | 保留 C1 作为 P0-α② 失败时的首选备选，但把它的安全前提从「扫描别漏」变成**结构上不可能漏**：`sessionSpec.tools` 与桩 customTools 由同一个数组一次派生（禁止第二份清单）；任一 `makeStub` 抛错 ⇒ 整体放弃 C1 回退纯 B（宁可 provider 报错也不放宽工具域）；桩名原样取自历史 token 不做大小写归一化；并配两层断言——包 C 的结构性单测（`tools` = `READONLY ∪ stubNames` 且逐名有 customTool）+ 探针里的会话级断言（`getAllTools()` 中每个非只读名 `sourceInfo.source !== "builtin"`，`agent-session.js:2146` 为依据）。不降级为「不推荐备选」：C1 是 B 兼容性失败时唯一既保零写能力又不改历史的出路。                                                                                                                                              |
| 4   | 一般   | **采纳（选①拆两个设置）**         | §4.1 预检段 + `details.turnBudgetHint`、§4.6 settings 七字段 + 依据段、§5 F4 表、§6 A-3/A-4、§9 T-2/T-11、§10、§11-1 α③ | 拆成 **`maxFirstRequestUsd`（预检，默认 $2）+ `maxCostUsd`（累计帽，默认 $4）**。单值形态下 est 可合法逼近 cap（$1.9 / $2），turn 1 结束即越帽 ⇒ `maxTurns` 恒为 1，而方案此前既没承认这个交互、也没给模型/调度方任何信号。拆值后「打满预检线仍余一个同量级 turn」成为默认值的显式性质。同时采纳②的廉价部分：`details` 带 `costEstimateUsd` 与 `turnBudgetHint`，且 `remaining < est` 时 prompt 追加一行 `Budget note: you have roughly one turn …`。T-11 新增拆值回归（$2/$2 ⇒ turn2 被砍；$2/$4 ⇒ 不被砍）把退化行为锁成已知事实而非意外。                                                                                                                                                                                                   |
| 5   | 一般   | **采纳**                          | §4.5（复用规格 + deps 适配）、§6 包 C 新增 8b、§9 T-1、§10 冻结面                                                       | `matchRunId`（`resolve-target.ts:110`）确未导出，§6 文件清单也漏了该文件。包 C 加一行 `export`（进冻结面）；§4.5 写出 deps 适配：`matchRunId` 只经 `knownIds()` 取 runId 集合，所以 index 把 `ExpertRecord` 投影成最小 `RunSnapshot`（`runId`/`status`/`updatedAt`/`diag.sessionFile`）喂给 `records`，`liveSnapshots: []`、`labels: new Map()`、`tombstones: {list:()=>[],get:()=>undefined}` 即可，不触碰 label/candidate 逻辑。T-1 改为直接 import 该函数跑同一 fixture；若改走「对齐实现」，则必须双向跑两个实现。                                                                                                                                                                                                                         |
| 6   | 一般   | **采纳（两小条全收）**            | §2 路由清单、§11-1 α②                                                                                                   | ① 判定标准改为三条可机械判定：`stopReason !== "error"`（= `session-driver.ts:231` 的 `getTurnError()` 为空）+ 未声明工具零调用（比对 `getActiveToolNames()`）+ 回答含预埋的 `CONSULT-PROBE-<rand8>` 事实 token；删掉「回答正常」。② 必测路由改为**动态求并集**（遍历已注册类型的 `model`/`modelHint` + 默认模型，经 `ctx.modelRegistry.find` 反查 api 去重），冻结清单降级为「当前预期结果」；本次复核 `~/.pi/agent/models.json` 确认方案漏列 `kimi-coding` / `zai-coding-cn` / `zai` 三个 `models: []`、无显式 api 的 preset provider，已写进 §2 与 α②。                                                                                                                                                                                      |
| 7   | 建议   | **采纳（两小条全收）**            | §4.1 `ConsultDeps.priceOf` 签名、§4.6 预检段、§6 D-14（给出实现）、§9 T-2                                               | ① `ModelCost.tiers`（pi-ai `types.d.ts:687-694`，request-wide 分层定价）此前被忽略，恰落在 75% 预检线附近的长上下文专家会被**低估** ⇒ `priceOf` 改签名为 `(model, contextTokens)`，先按 `inputTokensAbove` 选中匹配的最高档再取 `input/cacheWrite`。② `StackModelPort.find` 返回 `unknown \| undefined`（`stack.ts:473`），strict 下取不到 `.cost` ⇒ `priceOf` 直接写在 stack.ts 里用 `ctx.modelRegistry`（typed）窄化，§6 D-14 给出可直接照抄的实现；单位 $/M tok 已由 `cache-ttl/keepalive-state.ts:814` 佐证。                                                                                                                                                                                                                              |
| 8   | 建议   | **采纳**                          | §4.4 早退路径段                                                                                                         | 依据更正：`runner.ts:394-412` 的 pre-try 代码是 `createInitialState`/`createCancelHandle` 与三个注册表写入，**不是参数断言**——照 v3 的写法，施工者可能以为「删掉断言这条路径就没了」。结论（落 sweep）不变，并补上评审点出的缺失理由：**有意不在 adapter finally 无条件删**，否则会与 runner 未完成的 `runReap()`/dispose 的 `_persist`（`appendFileSync`）重新构成「删除后残片重生」竞态，正是 §4.4 结构性消掉的那个。                                                                                                                                                                                                                                                                                                                        |
| 9   | 建议   | **采纳**                          | §5.1 生命周期第 3 条                                                                                                    | 补上 consultDir 跨 pi 进程共享时 sweep 的安全论证：① 活的请教 run 受 150s 硬顶，fork 文件 mtime 必远小于 24h TTL（量级差 576 倍）；② 「无合法 header 即删」不会误杀创建中的文件，因为 `forkFrom` 的第一个 `writeFileSync` 就是 header（header-first 写序）。并显式写明「改 sweep 规则必须保住这两条前提」，避免下一个人把 TTL 缩到分钟级或改按尾部完整性判残片。                                                                                                                                                                                                                                                                                                                                                                               |
| 10  | 建议   | **采纳（两小条全收）**            | §13 #3 行、§4.1 watcher 判据                                                                                            | ① §13（review-1）#3 的理由列开头补「**（v2 原文；结论已被 §12 最终确认与 §14 #8 取代——现行口径是方案 B）**」，只扫表的人不会再误读成「现在按 A 施工」。② 判新 turn 的理由改为「`lastTurnStartAt` 是粘滞字段，即便将来引入快照节流/合并也不会漏判」，并注明评审核实的事实：`onStateChange` 在每次 `dispatch` 后无条件触发、每个 `session_event` 一条快照，**快照并不合并**，两种判据当前等价——选择无害但理由原先不成立。                                                                                                                                                                                                                                                                                                                        |

**冻结前 checklist（包 A 合并门）**：① `StopCause` 未被修改（`git diff src/core/types.ts` 不含 `StopCause` 行）；② `ConsultSettings` 为七字段且 `maxFirstRequestUsd`/`maxCostUsd` 默认 2/4；③ `matchRunId` 已导出；④ `forkExpertSession` 签名为结果对象；⑤ `CONSULT_READONLY_TOOLS` 与 `onReaped(runId, forkSessionFrom?)` 与 v3 一致。

## §16 修订：请教主会话（保留 id `main`）

> 用户已拍板（见任务对话，非本文档评审轮次产物）：子 agent 能用 `consult` 请教**主会话**，与请教其它专家
> **完全相同的方案**（fork 专家持久化会话 → 只读请教 run 作答，B 形态），只是主会话用一个**保留的专家 id：
> `main`**。本节记录施工口径、与 v3.1 既有设计的差异点，以及为什么每一处差异都选了「代价最小」的实现。

### 16.1 规则（已定，逐条落实）

1. **授权 = 白名单**：只有派发时 `Agent({ experts: ["main", ...] })` 显式列出 `main` 的子 agent 才获得对主
   会话的 consult。不新增设置开关（`consult.enabled=false` 仍整体关闭两种形态）。嵌套子 agent 派发时列
   `main` 同样可用——`resolveExperts` 是 `wireConsult` 闭包里唯一一份实现，顶层与嵌套 Agent 工具共用同一
   个函数引用（`src/service/runtime-adapter.ts` 的 `consultResolveExperts` 与 `src/index.ts` 的顶层
   `resolveExperts` 都转发到它），因此“main 永远指向宿主主会话”这一点不需要在 agent-tool.ts 里做任何区分。
2. **保留名**：`CONSULT_MAIN_EXPERT_ID = "main"` 在 `resolveExperts` 的每个 handle 循环体最前面被检查——
   命中就直接构造 main 的 ref 并 `continue`，**从不落入**下面 id/label 并集的解析逻辑，因此即便某个真实
   run 用 label `"main"` 结束，也不会被误当成宿主主会话（反之亦然：写进白名单的 `"main"` 永远指向主会话，
   不会被同名 run 抢先）。见 `tests/consult/wire.test.ts` 的 “main” takes priority over a live run 用例。
3. **快照时机**：`consult("main", …)` 每次调用时才读 `mainSessionFacts()`（`src/consult/main-facts.ts`），
   而不是 `Agent({experts})` 派发时缓存的值——工具执行路径里 `sessionFile`/`model`/`tokens`/`percent` 全部
   来自这次调用现读的结果，`ref` 上缓存的（派发时）字段只在 `resolveExperts` 阶段短暂存在，consult 工具
   对 `kind:"main"` 的 ref 完全不读它们（见 16.3）。主会话 `--no-session`（`ctx.sessionManager.getSessionFile()`
   返回 `undefined`）⇒ 派发时 `resolveExperts(["main"])` 直接 throw 配置错，文案含 `--no-session`，与其它
   解析失败同类（不是 consult 调用时才发现，是**派发时**就能拒绝，节省一次来回）。
4. **守卫**：沿用全部现有守卫（`maxFirstRequestUsd` 首请求预检、上下文 ≥75% 预检、只读工具域、maxTurns /
   maxCostUsd、并发上限、`consult.timeoutMs` 硬顶）。差异仅两点，且都在 `src/consult/tool.ts` 的
   `execute()` 里用 `const isMain = ref.kind === "main"` 一次性分岔，不是散落各处的字符串比较：
   - **跳过「专家仍在运行」nack**：`isMain` 为真时完全不执行 `deps.query.get(ref.runId)` 与按 sessionFile
     扫描 live 运行中 run 的两段逻辑（主会话恒在运行，这两段本来就该永远判"否"——显式跳过比"让它自然
     判否"更诚实，也防着将来谁往 query registry 里塞进一条 `runId:"main"` 的记录）。
   - **首请求预检不得因数据缺失而跳过**：`tokens`/`model` 二者之一缺失（`mainSessionFacts()` 没拿到
     `ctx.model` 或 `ctx.getContextUsage()`）⇒ 直接 nack `unavailable`（文案："cannot estimate the
     first-request cost right now"），**不**像真专家那样静默跳过预检退回给 turn-boundary 帽兜底——因为
     宿主会话理应总是有模型/用量，缺失是异常信号，不是"这次没有这项数据而已"。上下文百分比预检本身仍是
     "缺失即跳过"（与真专家一致），只有**成本预检**的缺失口径更严格。
5. **fork 一致性**：主会话 jsonl 在 consult 调用瞬间可能正被追加，也可能被 `_rewriteFile` 整体重写（如
   `/compact`）。`forkExpertSession` 的字节区间拷贝在这种情况下可能拷出"横跨两代内容"的半成品——`pi` 的
   加载器只对**最后一行**的半截宽容，中间行解析失败说明真的错了。`checkForkConsistency`
   （`src/consult/fork-store.ts`）复制后重读整个 fork 文件：header 必须解析且是合法 session header；
   除最后一行外任何一行解析失败 ⇒ 判定不一致。**验收补强（2026-09，Minor 修复）**：逐行解析抓不住
   "每行各自合法但前后两代拼接"或"截断中的自洽前缀"，所以 `forkMainSessionSnapshot` 另在复制**前后**
   各取一次源文件 stat（size + mtimeMs，可得时含 ino）：size 变小、或 mtime 变了且非纯追加（size 未增长，
   含原地同长重写与 inode 替换）⇒ 同样判不一致，走同一条删 fork → 立即重试 → nack 路径；纯追加（size 增
   大）视为正常——快照截止到拷贝时刻，末行可半截的既有规则不变。>32MB 的大文件不再"直接信任"：跳过逐
   行解析，但仍做 stat 漂移检测与 header（首行 8KB 窗口）+ 尾部 8KB 窗口的非末行解析校验，且不把整个文
   件读进内存（测试可注入更小阈值与受限读窗口断言）。
   `forkMainSessionSnapshot` 包一层：不一致就删掉这次的 fork
   文件、**立即重试一次**（不 sleep——本模块全同步 fs，AGENTS.md 的零挂死不变量不允许为重试引入一个真的
   等待；由并发写者的时序自然错开来兜底），仍失败 ⇒ `{ok:false, reason:"fork_failed: inconsistent after
retry (...)"}`，consult 工具按现有"fork 失败"分支 nack `unavailable`，**不抛**，且此时还没有发生任何
   `spawn`。真专家的会话是终态文件，不会有这个问题，继续用未加检查的 `forkExpertSession`——两条路径都在
   `ConsultForkStore.forkMainSession?`（可选方法）与 `forkExpertSession`（必选方法）上分开，consult 工具
   在 `isMain` 时优先用前者、缺失时优雅退回后者（`tests/consult/consult-tool.test.ts` 两个用例分别锁定）。
   `/tree` 切换分支只改内存 leaf、不改会话文件本身，fork 以磁盘文件为准——这里也接受，理由与真专家一致
   （§5.1 已有的声明同样适用：fork 永远是"文件当前内容"的快照，不是"某个内存分支"的快照）。
6. **类型**：请教主会话的 consult run 需要一个 `agentType` 才能过 `spawn-service.ts` 的准入（构造
   `RunnerSpec` 要有 `config: AgentTypeConfig`）。两个候选方案：
   - **内置伪类型**：往 `AgentTypeRegistry` 里注册一个真实存在的类型（如 `main-snapshot`），靠
     `list()`/系统提示的"可派发类型"清单过滤把它排除在外。
   - **"无类型"分支**（**已选**）：`spawn-service.ts` 的 `spawn()` 在查 `deps.types.get(req.type)`
     **之前**先判一次 `req.type === CONSULT_MAIN_AGENT_TYPE && req.forkSessionFrom !== undefined`——命中
     就直接用一个模块级、`AgentTypeRegistry` 完全不知情的静态 `AgentTypeConfig`
     （`MAIN_SNAPSHOT_TYPE_CONFIG`）；不命中（没有 `forkSessionFrom`，即有人想直接拿这个哨兵名字去派发一
     个"新鲜"会话）就照常查注册表，几乎总是查不到，跟其它未知类型名一模一样地报错。
   - **理由（选"无类型"而非"内置类型"）**：往注册表里塞一个类型意味着必须再教会 `list()`/
     `formatAgentTypesForPrompt()`/`configHashOf()` 这三个消费者"这个类型是隐藏的"——每加一个消费者就多
     一处要记得同步排除的地方，而且 `AgentTypeRegistry` 是**跨会话共享**的抽象（每次 `session_start` 都
     `types.reload()`），往里注入东西天然有更大的作用域。"无类型"分支完全不碰 `AgentTypeRegistry`：
     `deps.types.get()`/`deps.types.list()` 的实现、返回值、调用者可见行为**全部零改动**——`spawn-service.ts`
     里唯一新增的是三行（一个模块级常量 + 一个三元表达式），且只在 `forkSessionFrom` 同时成立时才生效，
     真实爆炸半径就是"main-snapshot 请教 run 的准入"这一条路径。**收尾的碰撞风险**：为什么
     `CONSULT_MAIN_AGENT_TYPE`（`"consult:main-snapshot"`）不干脆直接用 `"main"`——如果一个用户真的在
     `.pi/agents/main.md` 里定义了名叫 `main` 的类型，并把某次这个类型的 run 当成**普通专家**（不是保留
     id，是 label/run_id 匹配到的真实专家）加进白名单，之后被正常请教时 `port.spawn({type: ref.agentType
/* = "main" */, forkSessionFrom, ...})` 会命中同一个分支，拿到的是我们的合成配置而不是用户在
     `main.md` 里写的真配置（对 consult run 而言唯一有实际影响的字段是 `thinkingLevel`，因为 tools/prompt
     早被 `isConsultRun` 分支强制覆盖）。用两个不同的哨兵值（`CONSULT_MAIN_EXPERT_ID="main"` 给
     `resolveExperts` 的 handle 匹配、`CONSULT_MAIN_AGENT_TYPE="consult:main-snapshot"` 给
     `ref.agentType`/spawn 准入）把这个极窄的碰撞面直接消掉，成本是一个字符串常量，值得付。
     `tests/service/spawn-fork-admission.test.ts` 里専门有一条用例断言"一个真的叫
     `consult:main-snapshot` 的注册类型在**不带** `forkSessionFrom` 的普通派发下完全走正常路径"，把这条
     不变量锁死。
7. **prompt**：`buildConsultPrompt`（`src/consult/prompt.ts`）新增可选 `isMain?: boolean`，为真时在只读
   工具声明之后多插两句：只回答与问题相关的决策/偏好/上下文，不要复述凭据或无关对话；上下文里没有就直接
   说没有、不要猜测（提醒它自己可能已经被 `compact_context`/`switch_context` 折叠过）。其余部分（结论先行
   /字数上限/只读工具清单/Budget note）与专家路径完全共享同一份模板。
8. **可观测**：
   - consult 工具结果 `details.expertRunId`/`expertLabel` 都是 `"main"`（`buildMainRef` 把 `runId`/`label`
     都设成 `CONSULT_MAIN_EXPERT_ID`），调度方/模型在工具输出里直接看到 `"main"`，不会看到内部哨兵类型名。
   - `renderExpertRoster`/`describeWhitelist`（`src/consult/tool.ts`）加了一条通用护栏——`label === runId`
     时不再重复拼 `"main (main)"`，只显示一次；顺带把 `kind:"main"` 的一行渲染成"the host main session"
     而不是 `ref.agentType || "agent"`（否则会在自己的工具描述里印出 `consult:main-snapshot` 这种实现
     细节）。
   - fleet 嵌套行：`RunDisplayMeta.agentType` 目前就是 `spec.type.name`，对 main 请教 run 而言就是
     `CONSULT_MAIN_AGENT_TYPE`——**本次未改** `runtime-adapter.ts` 去做展示层覆盖（评估过"一行把
     `agentType` 映射回 `main`"的方案，但 `consultOf` 这条展示通路本身在 fleet 面板里还没有被渲染消费者
     读取，见 `rg -n "consultOf" src` 只命中类型定义——为一个尚未被任何 UI 读取的字段加特判，价值现在是
     负的；等 fleet 真的开始渲染嵌套 consult 行时再一并处理，已记入"遗留"）。ExpertIndex 不受影响：main
     从不落盘为 `subagent:run` 条目（它根本不是一个被 spawn 的 run），`rebuildFromEntries` 天然不会收到它。
9. **`ConsultExpertRef` 扩展**：加了一个可选字段 `kind?: "run" | "main"`（默认省略 = `"run"`，即所有
   v3.1 已有的 ref 语义零改动）。`freeze-surface.test.ts` 原有的 "carries the dispatch-time snapshot
   fields" 用例继续用不带 `kind` 的 ref 断言，证明这确实是纯加法。

### 16.2 未采纳的备选（及理由）

- **给 `ConsultExpertRef` 单独开一个 `MainExpertRef` 联合类型**：会让 `whitelist: readonly
ConsultExpertRef[]` 这个到处传递的类型变成一个更复杂的判别联合，`matchExpertRef`/`renderExpertRoster`
  等函数要多写类型收窄。一个可选 `kind` 字段能达到同样的运行时区分效果，且对现有代码零侵入。
- **主会话也注册 `consult` 工具（能反过来问自己的子 agent）**：任务描述明确排除（"主会话不注册 consult
  工具"沿用 OQ2 结论），未实现。
- **`consult.expertTools`/`consult.mainReadonly` 之类的新旋钮**：任务要求"不新增设置开关"，两种形态共用
  同一套 `ConsultSettings`（`maxTurns`/`maxCostUsd`/`timeoutMs`/…）。

### 16.3 与 v3.1 既有设计的接缝（供后续维护者核对）

- `src/core/types.ts`：`ConsultExpertRef.kind?`、`CONSULT_MAIN_EXPERT_ID`、`CONSULT_MAIN_AGENT_TYPE`。
  **`StopCause` 依旧未动**——16.1 的两点差异都在 consult 工具内部的分支判断，从不触碰状态机。
- `src/service/spawn-service.ts`：`spawn()` 里 `deps.types.get(req.type)` 前面插一个三元表达式，见 16.1
  第 6 条。**`canSpawn` 分支、nesting 写入、resumeLocks 互斥全部沿用现有 fork 分支**——main 请教 run 只是
  "又一个 `forkSessionFrom` 请求"，深度计算、并发/预算硬顶、无 `canSpawn` 传递这些既有不变量原样生效。
- `src/consult/main-facts.ts`（新增，pi-free）：`MainSessionFacts`/`MainSessionFactsProvider` 类型。
- `src/consult/fork-store.ts`：新增 `checkForkConsistency`（导出为测试缝）、`forkMainSessionSnapshot`。
  `forkExpertSession` 本体**零改动**。
- `src/consult/tool.ts`：`ConsultForkStore.forkMainSession?`（可选方法）、`ConsultDeps.mainSessionFacts?`；
  `execute()` 内 `isMain` 分支（16.1 第 4/5 条）；`renderExpertRoster`/`describeWhitelist` 的展示护栏。
- `src/consult/prompt.ts`：`buildConsultPrompt` 新增 `isMain?` 可选参数。
- `src/consult/index.ts`：`WireConsultDeps.mainSessionFacts?`；`resolveExperts` 循环体最前面的保留字判断
  - `buildMainRef()`；`depsFactory` 把 `mainFacts` 转发进 `createConsultTool`。
- `src/stack.ts`：`mainSessionFactsFrom(ctx)`——直接读 `ctx.sessionManager.getSessionFile()` /
  `ctx.model` / `ctx.getContextUsage()`；这个 `ctx` 就是 `session_start` 传进 `buildSessionStack` 的那个,
  长期存活、可在会话生命周期内任意时刻调用（`src/hud/footer.ts` 的 `installFooter` 早就是这样用的——它把
  同一个 `ctx` 存进闭包，每次 footer 重绘都调 `ctx.sessionManager.getEntries()`/`ctx.model` 拿到当时刻的
  真实值，本仓库里这是"`ctx` 在会话内保持活对象"的既有证据，不是本次新引入的假设）。`consultForkStore`
  新增 `forkMainSession` 转发到 `forkMainSessionSnapshot`。
- `src/tools/agent-tool.ts`：`experts` 参数描述追加一句关于保留 id `main` 的说明；**参数 schema 本身
  不变**（仍是 `string[]`），`execute()` 逻辑不变——"main"只是白名单数组里合法的一个字符串，agent-tool.ts
  从头到尾不知道它有特殊含义（这正是 16.1 第 1 条"整个特性只活在 `resolveExperts` 里"想要的效果，见
  `tests/tools/agent-tool-experts.test.ts` 新增用例的断言标题）。

### 16.4 测试清单（新增，未在 v3.1 §9 出现）

- `tests/service/spawn-fork-admission.test.ts`：`main` 无类型分支准入通过 / 不带 `forkSessionFrom` 时按
  未知类型拒绝 / 真实同名注册类型的普通派发不受影响。
- `tests/consult/wire.test.ts`：`resolveExperts(["main"])` 走通（携带 model/context）/ 无会话文件（含
  provider 未注入的安全默认）报配置错 / 会话文件已从磁盘消失报配置错 / 与同名 label 冲突时 main 优先 /
  `consult.enabled=false` 时 main 同样被拦。
- `tests/consult/consult-tool.test.ts`：跳过 still_running（即便人为构造一个同 runId/sessionFile 的活跃
  run）/ 缺 tokens 或缺 model 均硬 nack（不静默跳过）/ 真专家路径的"缺失即跳过"行为不受影响（回归锚点）/
  ≥75% 上下文预检对 main 同样生效、且用的是实时值而非陈旧快照 / 优先走 `forkMainSession`、store 未提供时
  优雅退回 `forkExpertSession` / `modelOverride` 用的是实时模型而非派发时缓存值 / prompt 含 main 专属两句
  / 未被列入白名单的子 agent 请求 `main` 仍走"不在白名单"的通用 throw（不是绕过白名单的全局后门）。
- `tests/consult/fork-store.test.ts`：`checkForkConsistency` 的六种输入形状（正常/仅末行不完整/中间行损坏
  /header 非法 JSON/header 非 session 类型/空文件）；`forkMainSessionSnapshot` 的三种结局（一次成功、
  可复现的不一致重试一次后放弃且不留残留文件、`forkExpertSession` 本身硬失败时不重试直接透传）。
  验收补强（2026-09）另加：复制期间源被截断变小 ⇒ 重试后 nack 无残留；纯追加 ⇒ 通过且快照不含追加字
  节；mtime 变但 size 不变（注入 stat）⇒ 不一致；inode 替换 ⇒ 重试后成功；大文件（注入小阈值 + 受限
  读窗口 spy）仍做 stat 漂移与 header/尾窗校验、且从不整文件读入。
- `tests/tools/agent-tool-experts.test.ts`：`resolveExperts` 返回 `kind:"main"` 的 ref 时，agent-tool.ts
  原样转发（零特判）且回显文案含"the host main session"。
- `tests/integration/consult-wiring.test.ts`：经真实 `buildSessionStack` 的 `ctx.sessionManager
.getSessionFile()`/`ctx.model`/`ctx.getContextUsage()` 端到端解析出 main 的 ref；一次真实的
  `consult("main", …)` 调用让假驱动的第二次 `resume` 调用带着一个**不同于**主会话文件路径的
  `forkSessionFrom`（fork 副本，不是原文件）。

### 16.5 已知遗留 / 偏离

- fleet 面板尚未渲染 `consultOf`/嵌套 consult 行本身（v3.1 §11-1 已记录为"未实测"的既有缺口，仍未修）。
  ~~main 请教 run 的 `displayMeta.agentType` 会显示内部哨兵串 `consult:main-snapshot` 而不是 `"main"`~~
  —— 已修复（2026-09 验收 Minor）：`src/core/types.ts` 新增展示层映射 `displayAgentType(type)`
  （`CONSULT_MAIN_AGENT_TYPE → CONSULT_MAIN_EXPERT_ID`，其余类型原样返回），在
  `src/service/runtime-adapter.ts`（写入 `displayMeta.agentType` 时）与 `src/ui/fleet-panel.ts`（`toRow`
  渲染 `type` 字段时，同时覆盖旧快照里已经落盘的原始哨兵串）两处套用。spawn/admission 侧仍比较
  `spec.type.name` 的原始值（fork 绕行判断不受影响）——只在展示边界折叠。fleet widget/panel 各有一条测试
  锁定：main 请教 run 显示 `main`，普通 consult run（真实 expert type）保持原类型名不变。
- fork 一致性重试**不做真实的时间退避**（同步、立即重试）——已在 16.1 第 5 条写明理由（零挂死不变量 +
  本模块全同步 fs 的既有约束），这是有意选择，不是遗漏。
- ~~`checkForkConsistency` 对 >32MB 的 fork 文件直接信任拷贝、不重新解析~~ —— 已修复（2026-09 验收 Minor）：
  大文件跳过逐行解析，但**仍执行** stat 漂移检测与 header（首行 8KB 窗口）+ 尾部 8KB 窗口的非末行解析
  校验，且不再把整个文件读进内存（旧实现先 `readFileSync` 整个文件再判"太大"）。测试用注入的小阈值 +
  受限读窗口 spy 锁定（不再需要真写 32MB 文件），原"测试盲区"记录作废。
