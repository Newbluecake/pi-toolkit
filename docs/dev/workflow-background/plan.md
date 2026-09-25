# SubagentWorkflow 只保留后台模式

> 状态：已实施（2026-09-26）。与 [docs/dev/agent-background-only/plan.md](../agent-background-only/plan.md)
> 同一方向：主会话的 `Agent` 已经一律后台，本文把 `SubagentWorkflow` 也改成一律后台，并让
> `get_subagent_result` / `abort_subagent` 能管理工作流。

## 1. 动机

- **前台调用锁死主会话**：原 `SubagentWorkflow` 的 `execute` 同步 `await` 整个工作流（上限是
  `timeout_s` + 固定宽限，默认一小时量级），期间用户无法输入，模型也不能并行做别的事。唯一的控制手段是
  工具调用自身的 signal（Esc），一按就停掉整个工作流。
- **与 Agent 的语义分裂**：Agent 已经改成「立即返回 id → 完成通知 → `get_subagent_result` 取结果」，工作流却仍是
  另一套阻塞模型，工具描述里还要专门解释 "this call BLOCKS … (no background task-id + notification model)"。
- **管理面缺失**：工作流没有 id 级别的管理入口；想看进度只能盯着工具卡片的 1Hz partial 刷新。

## 2. 设计

### 2.1 工具：校验 → 启动 → 立即返回

`src/tools/workflow-tool.ts` 的 `execute`：

1. `signal?.aborted` → 直接返回 `aborted before starting`，不启动任何东西（与 Agent 的 `detachSignalOnStart`
   语义一致：已中止的 signal 在启动前拒绝）。
2. 同步校验：`validateScriptSize`（空脚本 / 超过 512 KiB 直接抛错，从 orchestrator 导出复用）、`timeout_s`
   覆盖预算、`heartbeatMs > 0` 时 `assertHeartbeatBudgetInvariant`。这些错误不再经通知绕一圈，而是本次工具调用
   直接失败。`meta` 解析仍在 worker 里做，失败走完成通知（`failed`）。
3. `runs.start(...)`：登记 activity、创建 per-run orchestrator、在后台驱动。
4. 返回 `workflowId`、脚本 `meta.name` 作为 label，以及一行 label marker
   `[workflow label: "<name>" · workflow_id: wf_… · status: running]`（工作流不能接收 `@mention`，所以不带
   Agent marker 里的 @ 提示）；正文说明会推送完成通知、用 `get_subagent_result` 取结果、可用 `abort_subagent`
   停止、不要阻塞或轮询。details：`{ workflowId, label, status: "running", background: true }`。

启动后工作流**脱离**本次工具调用的 signal（`OrchestratorRunRequest.signal` 不再传）：Esc / compact 打断主会话本轮
不会停掉工作流。停止只剩三条路：`abort_subagent`、自身预算、会话结束。

### 2.2 后台注册表（`src/workflow/background.ts`）

每个 session stack 一个 `BackgroundWorkflows`（`WorkflowSupport.runs`，在 `buildSessionStack` 里构造，**不在模块级**）：

- **有界驱动（零挂起）**：原工具里的 §4.3.2 WT13/WT17 序列原样搬进 `drive()`：
  1. `run()` 与 `runBoundMs = workflowTotalMs + tick + abortGrace + terminateConfirm + reconcile` 赛跑，同时监听
     「停止请求」；
  2. 超时 → 不 await 的幂等 `stop("timeout")`；停止请求 → 不 await 的 `stop(cause)`；
  3. `run()` / `settled()` 与宽限赛跑（超时路径 `SETTLEMENT_GRACE_MS = 3s`；显式停止路径
     `stopSettleBoundMs = tick + abortGrace + terminateConfirm + reconcile + 3s`）；
  4. 仍未落定 → `outcomeAt1()` 快照标 `degraded: "settlement_timeout"`，连快照都没有则合成诚实骨架
     （超时 `timed_out`/`workflow_total`，停止 `aborted`/cause）。`run()` reject 合成 `failed`。
     `drive()` 外层再兜一次 catch。结论：**每个启动的工作流必达终态条目**。
- **`finalize` 幂等**：第一份终态胜出（驱动、`seal()` 兜底、重复落定都只记一次），随后注销 activity、唤醒 waiter、
  调用 `onSettled`（异常被吞，通知失败不影响注册表）。
- **`stop(id, cause)`**：未知 → `unknown_workflow`；已终态 → `already_terminal`（不报错）；运行中 → 触发停止请求
  （首个 cause 记为 `stopRequested`），有界等待落定后返回。
- **`wait(id, { waitMs, signal })`**：有界等待，`wait_timeout` / `aborted` / 终态。
- **解析**：`resolve(handle)` = 精确 id → 唯一前缀（多个 → ambiguous）；`resolveLabel(name)` = 同名运行中的唯一一个，
  多个运行中 → ambiguous，否则取最近启动的一个。
- **保留**：终态条目上限 50、TTL 6h，惰性修剪（无定时器）。`seedTerminal()` 用于 /reload 后把补发通知对应的终态
  注册回来（保留期从 seed 时起算）。
- **关停**：`shutdown()`（对全部运行中的工作流请求 `stop("shutdown")`，之后的落定以 `phase: "shutdown"` 上报）→
  `drain(ms)`（有界等待）→ `seal()`（把仍未落定的用降级快照 finalize，之后的任何落定都不再上报）。
  `abandon()` 是防御路径：请求停止，但什么都不上报。

### 2.3 管理入口复用现有工具（不新增工具）

`src/tools/workflow-target.ts` 的 `resolveToolTarget` 是两个工具共用的解析规则：

1. 精确工作流 id → 唯一工作流 id 前缀（ambiguous 抛错）；以 `wf_` 开头却匹配不到 → 抛工作流专用错误
   （提示工作流按会话跟踪、不跨 /reload）；
2. run 解析器（精确 → 前缀 → Agent label），行为不变；
3. run 解析器找不到时才试工作流脚本名。

run id 是 `r_XXXXXXXX`，工作流 id 是 `wf_…`，前缀空间不相交；label 冲突时 run 优先。

- **`abort_subagent`**：工作流 → `runs.stop(id, "user_stop")`（orchestrator 的幂等 stop 会停掉全部子 run），返回
  `stopped: aborted (user_stop)`；已终态 → `already reached a terminal state`，不报错；停止仍在落定 → 说明通知会报告终态。
- **`get_subagent_result`**：
  - 运行中 → `Workflow wf_… ("name") is still running.` + `buildWorkflowProgressLines`（阶段、耗时、剩余预算、
    子 run 实时行）；
  - 终态 → `renderOutcomeText`（受 `resultMaxChars` 截断）+ `(duration · children · usage)` 尾巴；
  - `wait` / `wait_ms` 有界等待、1Hz partial 进度、连续超时升级文案（措辞换成 workflow）；
  - 非 wait 读走同一个 poll-guard（按 workflowId 计频），与 run 一致。
- 两个工具的 description 与 `run_id` 参数描述都写明接受 `wf_…`。

## 3. 完成通知

### 3.1 通道选择：仿 bash-job，不进 run outbox

调研结论：run 的通知管线（`src/delivery/notifier.ts` + `stack.ts` 的 `sendFormatted`）的载荷是
`DeliveryPayload { key: run:<runId>:<generation>, generation, diag: DiagSummary, status: RunOutcome["status"] … }`，
所有下游都按 run 读：格式化时 `store.get(runId)` 取 outcome/label、context-receipt tracker 按 runId 记账、
caller-ack hold 看 `spawn.expectsAck(runId)`、coalescer 按 run 合并、extension `onDelivery` 钩子假设 run 语义。
把工作流塞进去要伪造 generation/diag，还会被 receipt/ack 逻辑误处理——不是「自然承载」。

所以采用 bash-job 的做法：`src/adapters/workflow-notice.ts` 的 `createWorkflowNoticeSink` 作为注册表的
`onSettled`，每个工作流落定时一次 `pi.sendMessage({ customType: "subagent:workflow-notification", display: true,
details }, { triggerTurn: true })`。内容：`Workflow "<name>" (wf_…) <status> — <status · 耗时 · 子任务计数 · 花费>`、
`renderOutcomeText`（受 `resultMaxChars` 截断）、「用 get_subagent_result 重读」提示。details：
`{ kind: "workflow", workflowId, label, status, durationMs, summary, runIds, costUsd? }`。
同时在 `pi.events` 上发 `subagent:workflow:settled`（延迟 /reload 据此重新计数）。

### 3.2 实际保证

| 场景                                    | 行为                                                                                                                                                                                                                                                                                                            |
| --------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 会话存活时落定                          | 恰好一次 `sendMessage(triggerTurn)`：空闲时 pi 起新一轮，流式中 pi 当作 steer 排队——与 bash-job 通知同等保证（进入 pi 之后的排队由 pi 负责）。`sendMessage` 抛错（ctx 已失效）时转入下面的持久化路径。                                                                                                          |
| session_shutdown（/reload、切换、退出） | 运行中的工作流被 `stop("shutdown")`，与 run 的停止共用同一个 drain 上限（`min(abortGrace×3, 15s)`）；期间及 `seal()` 兜底产生的终态**不发送**（会话正在离开），而是 `pi.appendEntry("subagent:workflow-notice", { state: "pending", content, details, outcome, usage })` 写进**当前（旧）会话文件**。           |
| 下一次在同一会话文件上构建 stack        | `session_start` 里（在 `notifier.reconcile()` 之后）读 `getBranch()`，把未标记 delivered 的 pending（24h 内、最多 10 条）以 `triggerTurn: false` 补发、`seedTerminal` 注册回注册表（`get_subagent_result` 仍可读）、追加 `delivered` 标记——**恰好一次**。不触发新一轮：工作流随会话结束，没有等待它的后续动作。 |
| `/new` 等切到别的会话                   | pending 写在旧会话里；新会话看不到，等旧会话被 resume 时补发。                                                                                                                                                                                                                                                  |
| session_start 没有配对的 shutdown       | 防御路径 `abandon()`：工作流被停止（不留孤儿），**通知丢弃**（此时 `pi.appendEntry` 已指向新会话，写进去是错的）。                                                                                                                                                                                              |
| 超过 drain 仍未落定                     | `seal()` 用 `outcomeAt1` 降级快照（或骨架）立即 finalize 并持久化；之后真实的落定被忽略。                                                                                                                                                                                                                       |
| 进程崩溃 / 被 kill                      | 无保证（与 bash-job 一致；run outbox 的 staged 记录能跨崩溃，工作流没有等价物）。                                                                                                                                                                                                                               |

与 run outbox 的差别：run 通知在 staged/finalize 时即持久化、可跨崩溃对账；工作流通知只在「会话正在关闭」时持久化。
工作流本身不能跨 stack 存活（orchestrator 与 worker 都在 stack 里），所以 /reload 后能补的也只有通知与终态结果。

## 4. 生命周期

- 注册表是 `Stack.workflow.runs`，每次 `buildSessionStack` 新建；运行中的 orchestrator 与终态结果都在其闭包里。
- `index.ts` 的 `session_shutdown`：先 `runs.shutdown()`（避免脚本在子 run 被停后继续派新 child），再停全部非终态 run，
  `Promise.all([query.waitAll, runs.drain])` 共用 drain 上限，最后 `runs.seal()`。
- `buildSessionStack` 顶部：`previousWorkflowRuns?.abandon()`（与 `previousFleetWidget` 等同款 rebuild-dispose
  交接，只覆盖同模块的 session 切换）；`index.ts` 的 session_start 防御块也 `abandon()` 当前 stack。
- 延迟 /reload（`src/reload/`）：`/agent reload` 的 `countBusy` 原本就把 `workflow.activity.list()` 计入；本次补齐了
  两个缺口——`activeSubagentRunCount`（事件驱动的重新计数）也计入运行中的工作流，并订阅
  `subagent:workflow:settled`（工作流的最后一个子 run 可能早于脚本返回就结束，没有 run 事件标记工作流终态）。
- 其他「后台是否忙」的判定同步计入运行中的工作流：飞书通知的 background-status provider
  （`runningSubagents`）、cache-ttl keepalive 的 `backgroundBusy`、context-switch 交接附录的 live runs 行。

## 5. 花费记账

调研：后台 Agent run 的 usage 由 `get_subagent_result` 在**第一次**报告终态的工具结果上以 `usage` 字段挂给 pi
（`result-tool.ts` 的 `usageOnce`，按 runId 去重）；HUD（`src/hud/footer.ts`）把带 `usage` 的 toolResult 计入总计，
并用 `details.runId` / `details.runIds` 把这些 run 从实时费用（`subagent:usage` 广播）中剔除。原阻塞工作流把子 run
合计挂在自己的工具结果上并带 `details.runIds`。

现在：

- `SubagentWorkflow` 的立即返回结果**不带** usage；完成通知是 custom message，也不带（pi 不对 custom message 记账）。
- `get_subagent_result(wf_…)` 第一次读到终态时挂上 live 子 run 的合计 usage，`details.runIds` 列出这些子 run，
  与 run 共用**同一个**去重集合：子 run 先被单独读过就从工作流合计里扣除；工作流读过后再读子 run 也不再挂。
  重读工作流只展示花费（`details.costUsd` / 尾巴），不再挂 usage。
- /reload 之后子 run 已不在 query 里：用落定时捕获的合计（`view.usage`，随 pending 通知持久化）兜底，前提是它的子 run
  一个都没被单独记过账。
- 模型一直不调 `get_subagent_result` 时，这部分花费只出现在 HUD 的实时残差（灰色）里——与后台 Agent run 一致。

## 6. 子会话

调研：`SubagentWorkflow` 只在 `src/index.ts` 的 HOST_KEY 守卫之后注册（主会话），子会话注入的工具面
（`src/service/runtime-adapter.ts` 的嵌套 `Agent` 等）不含工作流工具。因此没有需要保留阻塞的子会话变体，本次只改主会话。

## 7. UI

- 工具卡片：`renderCall` 不变（名称 + journal/timeout 等）；`renderResult` 对立即返回的结果显示
  `▸ wf_… · running in background` + 正文；不再有 1Hz partial。旧会话里的阻塞结果（`details.summary`）与 partial
  （`details.progress`）分支保留，历史照常渲染。
- fleet widget（⚙ 组头）与 `/agent status` 的 WORKFLOWS 段都读 activity 注册表：运行中登记、终态注销，行为不变。
- HUD：子 run 仍通过 run 事件与 `subagent:usage` 显示；工作流终态读挂 usage 时按 `details.runIds` 去重。

## 8. 系统提示与描述

- 工具 description / promptSnippet 去掉 BLOCKS 措辞，写明 always runs in the background、返回 `wf_…`、完成通知、
  `get_subagent_result` / `abort_subagent` 管理、不要轮询。
- `formatAgentTypesForPrompt` 追加一行：SubagentWorkflow（启用时）同样一律后台，`get_subagent_result` /
  `abort_subagent` 接受工作流 id。这是 `pi_subagent_types` 冻结快照段的一次预期文本变化（按正常 tail-update 流程更新）。

## 9. 兼容性

- 参数 schema 不变（`script`/`args`/`journal`/`noReplay`/`replayScope`/`timeout_s`）。
- 行为变化：非 `completed` 的终态不再让 `SubagentWorkflow` 调用抛错——结果经通知与 `get_subagent_result` 返回
  （与 run 的 `get_subagent_result` 一致，不抛）。同步校验错误（空脚本 / 超限 / HB1）仍在调用时抛。
- `WorkflowToolDeps` 从 `{ defaultBudget, activity, createOrchestrator, usageOf?, snapshotOf? }` 收窄为
  `{ defaultBudget, runs }`；`runWithBoundedToolCall` / `computeToolCallMs` 移入 `background.ts`
  （`runBoundMs` / `stopSettleBoundMs`）。
- 新的会话条目类型 `subagent:workflow-notice`、消息类型 `subagent:workflow-notification`、总线事件
  `subagent:workflow:settled`。

## 10. 测试

- `tests/workflow/background.test.ts`：启动即返回且 activity 登记/注销；快路径不 stop；run 卡死 → `stop("timeout")`
  不 await、取 settled 的真实终态；run 与 settled 都卡死 → 预算 + 宽限内得到降级 `outcomeAt1`；EI5 骨架；run reject →
  failed；stop 幂等 + 终态 already_terminal + 只上报一次；stop 遇到永不落定的 orchestrator 仍得到降级 aborted；
  wait 超时/中止/终态；id/前缀/歧义/名称解析；保留上限与 TTL；shutdown/drain/seal/abandon；seedTerminal。
- `tests/tools/workflow-tool.test.ts`：立即返回（注册表里仍 running）+ marker；启动后中止 signal 不影响工作流
  （对照：启动前已中止则拒绝、什么都不登记）；同步校验；`timeout_s`；真实 worker 端到端（顺序、parallel、脚本异常、
  stage-error WARNING）；描述不再含 BLOCKS；通知格式（含 `resultMaxChars` 截断对照）。
- `tests/tools/workflow-management.test.ts`：`get_subagent_result` 运行中进度 + poll-guard、终态文本 + usage 恰好一次、
  子 run 先读的去重对照、/reload 后 seed 的 usage 兜底、截断、wait（超时升级 / 落定）、前缀与名称解析、未知 `wf_`；
  `abort_subagent` 按 id/前缀/名称停止、终态幂等、run id 仍走 QueryService（对照）；描述提到 `wf_`。
- `tests/adapters/workflow-notice.test.ts`：存活时恰好一次 triggerTurn 通知（内容、花费、事件）、截断、发送失败转持久化；
  关停时持久化 → 补发一次（triggerTurn false、seed、delivered 标记后第二次为零）；读回过滤。
- `tests/integration/workflow-background-wiring.test.ts`（真实 activate + stack + worker）：立即返回、按 id 管理、完成通知
  恰好一次、background-status 计入工作流；abort；session_shutdown 停掉运行中的工作流（orchestrator 自身的 aborted 事件
  为证）→ 持久化 → 下一次激活补发一次；无配对 shutdown 的 session_start 停掉旧工作流且不通知。
- `tests/reload/wiring.test.ts`：`subagent:workflow:settled` 触发重新计数；session_shutdown 退订三条订阅。
- `tests/context-switch/session-facts.test.ts`、`tests/config/agent-background-only.test.ts`：附录与系统提示的工作流行。

删除/改写：原 WT13/WT17 四个工具级用例迁到注册表测试；M10「1Hz 工具卡片 partial」两个用例删除（该机制不复存在，
进度改由 `get_subagent_result` 提供并在管理测试里覆盖）；「outcome 文本不重复子输出」三个用例改为直接测 `renderOutcomeText`。

## 11. 残余风险

- 通知在会话存活期间不持久化：崩溃 / kill 会丢（run outbox 可跨崩溃对账，工作流没有等价物）。
- 没有并发工作流数上限：模型可以一次启动多个后台工作流；子 run 仍受 SlotPool 与每个工作流的 `maxParallel` 约束（超额的 `agent()` 调用是 FIFO 排队，不是拒绝——见 [workflow-agent-queue/plan.md](workflow-agent-queue/plan.md)）。
- HUD 的「回合计时挂起」只看 run 事件：工作流在两个子 run 之间时 HUD 视为空闲。
- 通知正文包含受 `resultMaxChars` 截断的完整 outcome 文本；随后 `get_subagent_result` 会再给一次，存在一次重复。
