# SubagentWorkflow `agent()` 排队 · 方案 v2

> 状态：**已实施**（2026-09-25 合入 master）。阶段 A（排队 + 修复 + 事件 + UI）：`87b3396..db440e0` + `efbeb82`；阶段 B（宽限与延长）：`8a06b0b..cc09dc2`；工具描述与本批文档随 docs 提交。
> 制定：claude-opus-5-5（Plan，只读调研）。替换 v1；v3 修订见 §0′；实施记录与已知限制见 §0″。
> 依据：v1 + 用户决定、`review.md`（评审 v1）、`docs/dev/timeout-notify/{plan,arch}.md` 及其已落地实现。

## 0. v2 相对 v1 的变更与评审处置

**结构**：拆成两个交付阶段——**A = 排队本体 + 既有缺陷修复 + 事件**；**B = workflow 宽限与延长**。
UI 渲染拆为 A-UI / B-UI，等 fleet-widget 的另一任务合入后再做。新增 §4 宽限与延长、§5 事件契约、§9 交付顺序。

| 评审项                    | 处置                                                                                                                                                                                                                                                                                                      |
| ------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Blocker-1 迟到 spawn 孤儿 | 派发**不再用 `withDeadline` 包 spawn**，改为「单续体 + 独立超时计时器」：`sp.then(onSpawned)` 永远执行，迟到的 runId 一定走 `registry.bind` → `cancelNow` → `retryOrphanAbort`（§3.3 D5）                                                                                                                 |
| Major-1 全出口守卫        | 规则：**谁把调用翻成 settled，谁记录并发 settle**。所有异步出口先查 `registry.resolve(id)?.phase === "settled"` 或 `registry.cancel()` 返回值是否为 `"withheld"`，否则直接 return（D6）                                                                                                                   |
| Major-2 BW10 排队误杀     | **配置层取消 BW10**：`workflow.budget.workflowTotalS` 必须 > 0，0 回退默认并 WARN（与 subagent D-11 同构）。证据：`background.ts:160-168` 的 `runBoundMs` 在 `workflowTotalMs=0` 时约 14s 就结束 driver race，BW10 在后台模式下本来不可用。取消后 `ack.deadlineAt` 恒有值；阶段 B 改用静态 hardAt（§4.4） |
| 4 跳过分支 ack            | pre-ack 跳过分支一律回 `{ok:false, cancelled:true, cause}`，与 bind-cancelNow 对齐（D7）                                                                                                                                                                                                                  |
| 5 文案与时长              | 每个出口带真实 cause/文案；未派发调用 `durationMs` 从 `enqueuedAt` 算，另记 `queueWaitMs`（D8）                                                                                                                                                                                                           |
| 6 缺测试                  | 全部补进 §7                                                                                                                                                                                                                                                                                               |
| 7 `⚠ N` 形状              | §5 定下 kind 名与字段                                                                                                                                                                                                                                                                                     |
| 8                         | 维持选项 C                                                                                                                                                                                                                                                                                                |

## 0′. v3 修订（评审 v2 处置，**以本节为准，覆盖下文冲突处**）

评审 v2（`review.md` 第 2 轮）：阶段 A、B 均有条件通过。处置如下：

- **#1（Blocker）采纳更简单的替代——子任务截止钉在 `W.hardAt`，不做「跟随 owner」**：
  - 派发时 `budgetOverride.totalMs = W.hardAt − now`，保持今日 explicit / hard 语义（D-10 不变），
    子任务 soft = min(enq + totalMs, cap) = `W.hardAt`（`state-machine.ts:522-528`）。
  - workflow 在 `killAt` 结束时由 `stopOwned → cancelAll → forceSettleActive` 结构性截停子任务，
    所以子任务不会晚于 workflow；workflow 被延长时子任务本来就不会在旧截止被杀——满足用户要求。
  - **删除**：§4.4 的 `deadlinePolicy` / `owner_extendable`、`spawn-service.ts:469` 改动、`ExtendSource "workflow"`、
    `ChildSpawner.extendTo`、`createWorkflowChildSpawner` 的 query 注入、`lagging` 重试计时器、
    `host.onDeadlineMoved` 对在跑子任务的同步。阶段 B **不再改 `src/core/**` 与 `src/service/spawn-service.ts`**。
  - 保留：extend 工具层拦截 `parentRunId` 以 `wf_` 开头的 run（子任务是硬顶，本来就延长不了，拦截给出更好的提示）。
  - 代价（接受）：stop 重试穷尽的孤儿子任务自灭点从 `killAt` 推迟到 `hardAt`（仍有界）；子任务行 ⏳ 显示到 `hardAt`。
  - 排队项：派发时按上式推导，不变。worker `ack.deadlineAt = W.hardAt`（阶段 B 起，静态），不变。
- **#2（Major，A 必修）未处理 rejection**：worker-source 增加全局 `unhandledRejection` 兜底——记录并通过
  现有 `stage_error` 通道上报（`source: "unhandled"`，计入 `⚠ N`），绝不让 worker 线程因此 `worker_died`；
  工具描述同时写明「派发失败会 reject，fire-and-forget 调用应自行 catch」。事件契约 `stage_error.source` 扩为
  `"parallel" | "pipeline" | "unhandled"`。
- **#3（Minor）BW2 不对称**：保留（到达时耗尽 → reject；排队中耗尽 → withheld → null），在工具描述与本文档写明：
  阶段 B 起排队中耗尽只会在 workflow 自身即将 timed_out 时出现。
- **#4** `onSpawnThrew` = `onSpawned` 的 error 分支：`clearTimer`；已 settled 则 return；否则
  `settleUnspawned({cause:"spawn_error", rejected:true})`。
- **#5** `finish()` / cleanup **同步**调用 `deadline.close()`；`orchestrator.extend` 只认 `controller.closed`
  （不依赖 background entry 状态，避免 finish→finalize 窗口）。
- **#6** host.ts 的 `ChildSpawner.spawn` 请求类型保持 `{totalMs?, queueWaitMs?}` 即可（#1 采纳后无需透传其它字段）。
- **#7** `workflow-tool.ts` `mergeBudget` 对 `timeoutMs ≤ 0` 回退默认，与 settings 层同构。
- **#8** `WorkflowDeadlineNotice` 类型放在 `src/workflow/deadline.ts`（B1）。

**交付（用户决定 A、B 一起交付）**：

- **P1 引擎 A**：§9 阶段 A 的 commit 1–5（host / call-registry / types / worker-source / orchestrator / activity / config）+ #2 #4 #7。
- **P2 引擎 B**（P1 合入后）：`src/workflow/deadline.ts`、orchestrator WT8 重 arm + `extend`、background `extend` / runBoundMs、
  host 读 `killAt`、run-budget、workflow-tool、extend-timeout-tool / workflow-target / deadline-notice、stack / index 接线。
- **P3 UI**（P1 合入后，可与 P2 并行，只改 `src/ui/fleet-widget.ts` + 测试）：`⧗ N` / `⚠ N` / 排队行；
  宽限标记在 P2 合入后补。
- **P4 文档**：工具描述、workflow-background/plan.md、AGENTS.md、README。
- 整体验收（verifier + 全量门禁 + 真机 workflow）后一起合入 master。

## 0″. 实施记录（2026-09-25 合入 master）

阶段 A：`87b3396`（单所有者结算）→ `282e84d`（BW10 配置层取消，`workflow.budget.workflowTotalS` 必须 > 0）→ `828062a`（CallRegistry `queued` 阶段）→ `6f7b7e0`（FIFO 排队）→ `db440e0`（queued/rejected/stage_error 事件）+ UI `efbeb82`（`⧗ N` / `⚠ N` 与排队行）；阶段 B：`8a06b0b`（纯 deadline controller）→ `d060fba`（宽限 + 子任务钉 `hardAt`）→ `293acd5`（`extend_subagent_timeout` 接受 wf id）→ `8019b68`（通知接线）→ `e5465c5`（UI 宽限/延长标记）→ `969ae0a`（属性测试补强）→ `cc09dc2`（进度头宽限倒计时）。§7 测试计划全部落地：`tests/workflow/{host,call-registry,activity,worker-host-call,journal-replay-e2e,deadline,host-queue.property}.test.ts`、`tests/tools/{workflow-tool,extend-timeout-tool}.test.ts`、`tests/integration/workflow-grace-wiring.test.ts`。与 §0′/§3/§4 的偏离（以代码为准）：

- **端口可选化**：`Orchestrator.extend` / `Orchestrator.deadline`（orchestrator.ts）与 `WorkflowQueryPort.extend`（端口本体在 `src/tools/workflow-target.ts`——§4.5 只写了「加 extend」）落地为**可选方法**：缺省 ⇒ 调用方拿到 `unsupported`，结构化测试替身不必补实现（生产 orchestrator / `index.ts` 转发恒有实现）。`OrchestratorDeps.onDeadlineNotice` 同为可选。
- **background view 增加 `hardDeadlineAt`**：§4.3 只列了 `graceUntil?` / `extensions?`；实现补了静态硬顶字段（`background.ts` view 与 activity snapshot 各一份），extend 工具的硬顶文案与 widget 头部标记都读它。
- **进度头宽限倒计时（计划外，`cc09dc2`）**：`get_subagent_result` 运行中读数的进度头（`workflow-tool.ts` `buildWorkflowProgressLines`）在宽限期改为倒计时宽限（`grace 1m28s left`），延长过的工作流显示 `58s left (+N)`——§4.5 未列，验收时补的模型可见性。
- **通知里用完整 wf id**：§4.5 的可抄命令示例是 8 位短 id；实现里 who-行用 `wf_`+8 短 id、**可抄的 `extend_subagent_timeout(run_id: …)` 命令用完整 workflow id**（`deadline-notice.ts`，杜绝前缀歧义命中失败）。grace 通知 `triggerTurn:true`、extended 回执 `triggerTurn:false`，与计划一致。
- **头部截止标记只在宽限期或有延长时出现**：§5 写「阶段 B 头部截止沿用 run 行」；实现（`fleet-widget.ts`）只在 `graceUntil` 存在或 `extensions > 0` 时渲染，终态冻结快照不渲染（常显的剩余时间只挤头部而无信息增量）。宽限标记按用户决定统一英文 token：`⏳grace 58s`（run 行与 workflow 头共用 `deadlineMarker`），延长标记 `⏳9m48s+1` 不变。
- **lifecycle.ts 的 `stage_error` 白名单扩为 `parallel | pipeline | unhandled`**：持久化侧对事件字段做白名单校验，`"unhandled"` 是 §5 事件表之外新增的 `source`（与 worker 兜底配套）。
- **HR6 取消类 reject 带 `cancelled:true` 且兜底跳过**：worker 端收到 cancel 时，所有 pending 的 host call / settle 等待以带 `cancelled:true` 的 Error reject；全局 `unhandledRejection` 兜底对 `cancelled === true` 的 rejection 静默跳过——停止中的 workflow 的 fire-and-forget 调用不算脚本缺陷、不进 `⚠ N`。

已知限制：

- **`gate()` 不随延长**：`host.ts` `handleGate` 在调用时刻一次性算好 `timeoutMs = min(gateMs, remainingWorkflowMs())` 交给 gateRunner；workflow 被延长不会拉长在跑的 gate——跨越延长时刻的 gate 仍按旧截止失败（顶层脚本因此失败；`parallel()`/`pipeline()` 内计为 stage_error）。最小修法：gateRunner 改为轮询 `killAt()` 的动态截止。
- **gate 与 WT8 同刻到期结局不定**：`gate()` 自身超时与 workflow 截止落在同一时刻时谁先生效是竞态——结局可能是 gate 失败在前（script_error / 脚本失败），也可能是 `timed_out` 在前；不做确定性保证。
- **`/reload` 场景缺专门回归测试**：宽限/延长与「shutdown 停止 → 通知持久化 → 下一 stack 补发」的组合没有专门回归（现有覆盖：`tests/reload/wiring.test.ts` 只测重新计数，`workflow-background-wiring` 只测通知补发，deadline 路径只有单元/属性测试）。

## 1. 现状摘要（文件:行号）

- **host.ts**：`546-558` 活跃数达上限回 ack 失败；`560-569` maxChildren；`571-589` BW2；`591` submit；`597` `await spawn`；`752` ack。
  `460-541` replay 短路在准入检查前，occurrence / chain digest 每次提交都前进，命中同步发 settle。
  `~300-312` phase 计时器**忽略** `registry.cancel` 返回值（既有缺陷：admission 被撤下不进 `children[]`）。
  `604-616` spawn-error 分支无「已 settled」守卫（既有缺陷：双记录）。
  `785-812` HR2 `withDeadline` 包整个 `handleAgent`，超时后 admission 残留仍占名额直到 spawn 返回。
  `remainingWorkflowMs()` 读静态 `deps.workflowDeadlineAt`，同时决定 host call 界限与 `gate()` 超时。
  `824-831` `onTerminating` 与 `stopOwned`：先置 `terminated`，再 `cancelAll`，之后 `settleWithheld` / `forceSettleActive`。
- **call-registry.ts**：阶段 admission / pre_runner / running / settled；`cancel(admission)` → withheld + `cancelIntent`；已 settled 且带 intent 时迟到 `bind` → `cancelNow` + `retryOrphanAbort`。
- **worker-source.ts**：`157-165` `callHost(hostCallMs)` → `waitForSettle(callId, ack.deadlineAt)`；`111-126` 界限 `deadlineAt − now + 5s`（缺省 `hostCallMs + 5s`）；`530-548` `bufferedSettles`（5s TTL）不透传额外字段；心跳为 unref 的 `setInterval`，`runaway.ts` 不用改。
- **orchestrator.ts**：`576-581` WT8 `deadlineTimer` 只 arm 一次（WR2）；`450-453` `onStageError` 只累计 `diag.stageErrors`、不发事件；`502-507` 转发 `subagent:workflow:child` / `phase`。
- **background.ts**：`160-168` `runBoundMs = workflowTotalMs + …`；`348` driver race；`388-389` `activity.register(…, deadlineAt)` 只调一次。
- **budget.ts**：`deadlineAt ≡ workflowDeadlineAt`（phase 未接线）。**run-budget.ts:27**：`maxParallel = min(4, concurrencyLimit − 1)`。
- **subagent 宽限/延长（已落地）**：`core/deadline.ts:106-160` `applyBudgetPolicy`（显式 totalMs 时 factor=1）/ `hardDeadlineAtFor` / `extendability` / `graceWindow`；`runner.ts:284` `extendDeadline`（同步）；`spawn-service.ts:467-469` `explicitTotal = req.budgetOverride?.totalMs !== undefined`（workflow 子任务因此恒为硬顶，D-10）；`runtime-adapter.ts:139` CC2 丢弃子 run 的 deadline 通知；`extend-timeout-tool.ts` 只认 run，`workflow-target.ts` 的 `resolveToolTarget` 已能解析 `wf_`；`deadline-notice.ts` `subagent:timeout` 通道，grace 通知 `triggerTurn:true`、extended 只显示；已知坑：runner `extendability` 对非 OVERTIME 相位（queue_wait、startup）返回 `not_started`（D-14）。

## 2. 设计选项（维持 v1）

| 方案                                 | 结论                                            |
| ------------------------------------ | ----------------------------------------------- |
| A. 延迟 ack 到派发时                 | 破坏 HR1/HR2 双向界限，否决                     |
| B. worker 端信号量                   | 拿不到 host 真实活跃数，replay 命中也白等，否决 |
| **C. host 先 ack、再排队、异步派发** | **选定**，与 replay 命中路径同形                |
| C′. 所有 live 调用统一先 ack         | 改动面大，留作后续                              |

排队状态放在 CallRegistry 新增的 `queued` 阶段（cancel / cancelAll / listActive / CR4 / CR5 自动覆盖）。

## 3. 阶段 A 改动清单

### 3.1 `src/workflow/types.ts`

- `CallPhase` 加 `"queued"`（文档：不占名额，cancel 后为 withheld）。
- `HostSettleEnvelope` 失败分支加 `readonly rejected?: true`。
- `WorkflowChildSummary` 加 `queueWaitMs?: Millis`。

### 3.2 `src/workflow/call-registry.ts`

- `submit(callId, at, opts?: {queued?: boolean})`；新增 `admit(callId): boolean`（仅 `queued → admission`）。
- `cancel(queued)` 同 admission：返回 withheld、写 `cancelIntent`。`stats` / `countByPhase` 加 `queued`。

### 3.3 `src/workflow/host.ts`

- **D1** `activeCount()` = admission + pre_runner + running（显式排除 queued）；`totalSubmitted()` 含 queued 与 settled。
- **D2 `handleAgent` 新顺序**：① replay 短路（不变，命中不排队）→ ② maxChildren 按 `totalSubmitted()` → ③ 提交时 BW2 预检（保持 ack 失败）→ ④ 若 `waitQueue.length > 0 || activeCount() >= maxParallel`：`registry.submit(queued)`，记 phase / label / agentType / `enqueuedAt`，发 `queued` 事件，回 `ack{ok:true, value:{callId, deadlineAt: workflowDeadlineAt, queued:true}}`（「队列非空也入队」保证 FIFO）→ ⑤ 否则走现有立即派发。
- **D3 `pump()`**：同步循环 `!terminated && queue.length && activeCount() < maxParallel`；`shift` → `admit()` 失败跳过 → `void dispatchQueued(item)`；`pumping` 标志防递归；调用点 `recordSettled` 末尾。
- **D4** 抽出 `610-750`「bind 之后」为 `runBoundChild(callId, runId, meta)`，两路共用。
- **D5 `dispatchQueued`**（ack 已回，只发 `host_settle`）：
  1. 算 `deriveChildBudget`；expired → D6 结算为 withheld，**不带** `rejected`，文案 `workflow deadline reached while queued`（时间耗尽，按用户决定 2 不 reject；阶段 B 起被宽限覆盖，仅在 workflow 自身即将 timed_out 时出现）。
  2. `startedAt = now`，写 `queueWaitMs`。
  3. 持有 `const sp = spawner.spawn(…)`；另 arm `timer = clock.setTimer(min(hostCallMs, remaining), onSpawnTimeout)`；注册 `sp.then(onSpawned, onSpawnThrew)`。
  - `onSpawnTimeout`：`registry.cancel(id, "spawn_timeout") === "withheld"` 才 D6 结算（`rejected:true`，`spawn did not complete within Nms`），否则 return。
  - `onSpawned(r)`：先 `clearTimer`。error：已 settled 则 return，否则结算（`rejected:true, error`）。成功：`registry.bind(id, r.runId)`；`cancelNow` → return（孤儿 abort 已在跑）；已 settled 无 intent（防御）→ `spawner.abort(runId, "late_spawn")` 后 return；其余 → `runBoundChild`。
- **D6** `settleUnspawned(callId, {cause, message, rejected?})` 取代 `settleWithheld`：删 journal meta、记 withheld（`durationMs = now − (enqueuedAt ?? startedAt)`，带 `queueWaitMs`）、发事件、发 `host_settle{ok:false, error:{message}, rejected?}`。所有翻成 withheld 的地方都调它：`stopOwned` / `onTerminating`（`workflow terminating (cause)`）、phase 计时器（`withheld (phase_timeout)`）、D5。
- **D7 修两个既有缺陷**：phase 计时器在 `registry.cancel` 返回 `"withheld"` 时先移出 `waitQueue` 再 `settleUnspawned`；`604-616` spawn-error 分支已 settled 则回 `{ok:false, cancelled:true, cause: intent.cause}`、不再记录；pre-ack 路径 bind 返回 `cancelNow` 时回同样 ack（现状不变）。
- **D8 HR2 残留**：`onHostCall` 超时分支（op=agent）`registry.cancel(id, "host_call_timeout") === "withheld"` 时 `settleUnspawned(…, rejected)`——残留不再占名额、迟到 bind 走孤儿 abort（残留会卡住队列，因此与排队相关）。
- **D9** `stopOwned` / `onTerminating` 在 `cancelAll` 后 `waitQueue.length = 0`。
- **D10** 事件见 §5。

### 3.4 其它文件

- `worker-source.ts`：`agent()` 中 `!outcome.ok && outcome.rejected` 时 `throw new Error(message)`；`bufferedSettles` 与两处 `resolve` 透传 `rejected`。
- `orchestrator.ts`：`onStageError` 额外 `emit("subagent:workflow:stage_error", …)`（§5）。
- `activity.ts`：消费 §5 事件，snapshot 字段见 §5。
- `src/config/settings.ts`：`parseWorkflowSettings` 丢弃 `workflowTotalMs <= 0` 并 WARN、回退默认；`setting-specs.ts`：`workflow.budget.workflowTotalS` spec `min: 1`；`budget.ts`：BW10 注释改为「配置层禁止，仅防御分支」。
- `workflow-tool.ts`：描述补「超过每个 workflow 并发上限的 `agent()` 会 FIFO 排队而不再失败；停止或超时时排队中的调用解析为 null」。
- 文档：`docs/dev/workflow-background/plan.md:202` 补一句；`AGENTS.md` `src/workflow/` 条目补一句。

## 4. workflow 宽限与延长（阶段 B）

### 4.1 语义（与 subagent 对称）

- 默认预算（未传 `timeout_s`）：`hardAt = startedAt + ceil(workflowTotalMs × maxTotalFactor)`。软截止到点后若有额度（`extensions < maxExtensions` 且 headroom > 0）→ 进宽限 `graceUntil = min(now + totalGraceMs, hardAt)` 并发 grace 通知，否则 timed_out。宽限到点 → timed_out（`timeoutReason: "workflow_total"`）。宽限期内延长 = 救回（同 `rescuedFromGrace`）；延长后再次越过软截止且仍有额度可再进宽限。
- 显式 `timeout_s`：`maxTotalFactor = 1` ⇒ `hardAt = softAt`，无宽限无延长（D-10）。
- 配置复用 `settings.budget.{totalGraceMs, maxExtensions, maxTotalFactor}` 与 `settings.extend.{enabled, notify}`；`extend.enabled=false` ⇒ workflow `maxExtensions=0`、宽限与延长一并关闭、工具不注册（D-16）。

### 4.2 新增纯模块 `src/workflow/deadline.ts`（不 import pi）

- 状态 `{softAt, hardAt, graceUntil?, extensions, grantedMs, graces, closed}`。
- `extendability(now)`（`already_terminal | stopping | limit_reached | no_headroom`，口径照搬 `core/deadline.ts:132`）；`onTimer(now)` → `{kind:"grace", until} | {kind:"expire"}`；`extend(now, extendMs, reason?)`：`newSoft = min(max(now, softAt) + extendMs, hardAt)`、清 `graceUntil`、`extensions++`；`nextTimerAt() = graceUntil ?? softAt`；`killAt(now) = graceUntil ?? (宽限可得 ? min(softAt + totalGraceMs, hardAt) : softAt)`；`close()`。
- 不变式：`softAt` 单调不减；`softAt ≤ killAt ≤ hardAt`；`hardAt` 恒定。

### 4.3 接线

- **orchestrator.ts**：WT8 改为 controller 驱动 `rearm(nextTimerAt)`（仅 grace / extend 重 arm；WR2 文档改为「单调、hardAt 上界、至多 1 + 2 × maxExtensions 次」）；接口加同步 `extend(workflowId, extendMs, {reason?})` → `WorkflowExtendOutcome`（与 `ExtendOutcome` 同构）；进宽限或延长时 ① `emit("subagent:workflow:deadline", …)` ② `deps.onDeadlineNotice?.(notice)` ③ `hostHandler.onDeadlineMoved(killAt)`；`WorkflowOutcome.diag` 加 `overtime?: {graces, extensions, grantedMs}`。
- **background.ts**：新增 `extend(workflowId, extendMs, opts)`（未知 → `unknown_workflow`；终态 → `already_terminal`；已请求停止 → `stopping`；否则转发 orchestrator 并更新 `entry.deadlineAt`）；`runBoundMs` 改用 `ceil(workflowTotalMs × max(1, maxTotalFactor))`（race 上界仍静态有界）；view 加 `graceUntil?`、`extensions?`。
- **run-budget.ts / types.ts**：`WorkflowRunBudget` 加 `totalGraceMs? / maxExtensions? / maxTotalFactor?`，由 `buildWorkflowRunBudget(settings)` 填入。
- **workflow-tool.ts**：传 `timeout_s` 强制 `maxTotalFactor = 1`；描述补宽限与延长。
- **host.ts**：`remainingWorkflowMs()`、`deriveChildBudget` 的 `workflowDeadlineAt`、HR2 `boundMs`、`gate()` 超时一律改读可变的 `deps.deadline.killAt()`（宽限期内不触发 BW2）。

### 4.4 截止时间传播

- **子任务改「跟随 owner」截止**：`core/types.ts` `SpawnRequest` 加 `deadlinePolicy?: "hard" | "owner_extendable"`；`spawn-service.ts:469` 改为 `explicitTotal = totalMs !== undefined && deadlinePolicy !== "owner_extendable"`。host 派发时：`deadlineAt`（CC4 cap）= `W.hardAt`；`budgetOverride.totalMs = killAt − now`；`maxTotalFactor = (hardAt − now) / totalMs`；`maxExtensions = W.maxExtensions`；`totalGraceMs = 0`（宽限归 workflow，子任务不发通知，CC2 本来也丢）。⇒ 子任务初始软截止 = `killAt`、hard = `W.hardAt`。workflow 自身为硬顶时仍用 `"hard"`（行为与现在一致）。`ExtendSource` 加 `"workflow"`（仅类型扩展，matrix 不变）。
- **同步在跑子任务**：`ChildSpawner` 加 `extendTo?(runId, targetAt, reason)`，适配器用 `query.get` 取子任务当前截止、`delta = targetAt − max(now, deadlineAt)` 后调 `query.extendTimeout(…, {source:"workflow"})`（`createWorkflowChildSpawner` 多一个 query 参数，由 stack 注入）。`host.onDeadlineMoved(t)` 对所有已 bind 的 active 调用 `extendTo`：`ok` / 已 ≥ t → 已同步；`already_terminal` / `stopping` → 丢弃；`not_started`（核心 `queue_wait` / startup，D-14）→ 进 `lagging` 集合，由**单个** 1s 重试计时器（`deps.clock`，unref）继续同步，集合清空 / 子任务 settle / workflow 终止时清掉。重试次数 ≤ (子任务当前截止 − now) / 1s，子任务截止恒 ≤ `W.hardAt`。
- **排队项**：尚无 runId，派发时用当时 `killAt` 推导预算，无需同步。
- **worker 端**：阶段 B 起 `ack.deadlineAt` 统一为静态 `W.hardAt`（live 与排队同）；`waitForSettle` 界限 = `hardAt + 5s`，永不早于 host 终止点（`killAt ≤ hardAt`）且恒有界，**无需新协议消息**。
- **模型直接延长子任务**：`extend-timeout-tool.ts` 工具层拦截 `snapshot.parentRunId` 以 `wf_` 开头的 run，提示改为延长 workflow（`extend_subagent_timeout(run_id:"wf_…")`）；子任务截止只由 owner 推动。

### 4.5 工具与通知

- `extend-timeout-tool.ts`：先 `resolveToolTarget`，workflow 走 `workflows.extend()`；成功文案 `Extended workflow wf_… by …, N of M extensions left, at most X more`；显式 `timeout_s` 拒绝文案 `workflow wf_… was started with an explicit timeout_s, which is a hard cap; … abort_subagent and restart with a larger timeout_s`；描述与 `run_id` 说明补「也接受 SubagentWorkflow id（wf_…）」。`workflow-target.ts` `WorkflowQueryPort` 加 `extend`。
- `deadline-notice.ts`：新增 `WorkflowDeadlineNotice` + `formatWorkflowDeadlineNotice`，通道仍为 `subagent:timeout`，grace `triggerTurn:true`。文案要点：`⏳ Workflow "<name>" (wf_xxxxxxxx) hit its <1h> time budget and is STILL RUNNING.` / `Grace: 90s left — then it stops as timed_out and its children are aborted.` / `Now: phase "<p>" · N running · N queued · N settled` / 可复制的 `extend_subagent_timeout(run_id: "wf_xxxxxxxx", extend_s: <min(total, headroom)>)` / 额度一行 / `Doing nothing lets it expire — that is a valid choice if its partial result is enough.`。策略：`off` 不投递，`background` / `always` 投递（workflow 恒为后台）。
- `stack.ts`：新增 `sendWorkflowDeadlineNotice`，注入 `createOrchestrator({ onDeadlineNotice })`，把 query 传给 `createWorkflowChildSpawner`。`index.ts`：`createExtendTimeoutTool({ …, workflows: forwardWorkflowQuery(holder) })`。

## 5. 事件契约（公共字段 `workflowId`、`at`）

| 通道 / kind                                         | 字段                                                                                                                                                                                                                 | 来源                                                         |
| --------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------ |
| `subagent:workflow:child` `"queued"`                | `callId, label?, agentType?, phaseId?`                                                                                                                                                                               | D2 入队                                                      |
| `subagent:workflow:child` `"spawned"` / `"settled"` | 不变；settled 增加 `queueWaitMs?`                                                                                                                                                                                    | 现有                                                         |
| `subagent:workflow:child` `"rejected"`              | `callId, label?, agentType?, phaseId?, stage: "admission" \| "dispatch", reason: "invalid_args" \| "max_children" \| "budget_exhausted" \| "spawn_error" \| "spawn_timeout" \| "host_call_timeout", message`（≤200） | ack 失败路径（非 cancelled）及所有 `rejected:true` 的 settle |
| `subagent:workflow:stage_error`                     | `source: "parallel" \| "pipeline", itemIndex, stageIndex?, message`（≤200）                                                                                                                                          | orchestrator `onStageError`                                  |
| `subagent:workflow:deadline`（阶段 B）              | `kind: "grace" \| "extended", deadlineAt, graceUntil?, hardDeadlineAt, extensionsUsed, maxExtensions`                                                                                                                | orchestrator                                                 |

- 顺序：派发被拒 = `rejected` → `settled`(withheld)；cancelled 类（stop、phase 超时）只发 `settled`，**不**计入 `⚠`；queued 之后要么 spawned → settled，要么直接 settled，绝不先 spawned 后 queued。
- activity snapshot 新增：`queuedChildren: readonly {callId, label?, agentType?, phaseId?, queuedAt}[]`（FIFO，spawned / settled 时移除）；`rejectedTotal`、`stageErrorTotal`；阶段 B：`graceUntil?`、`hardDeadlineAt?`、`extensions?`，`deadlineAt` 就地更新。
- 渲染规格（A-UI / B-UI 实施于 fleet-widget）：头部 `⧗ N`（有排队时）、`⚠ N`（`rejectedTotal + stageErrorTotal > 0`）；排队行 `⧗ <label ?? agentType ?? callId> waiting for slot · <formatDuration(now − queuedAt)>`，dim，排在 active 行之后、计入行预算、溢出并入 `+N more`；阶段 B 头部截止沿用 run 行 `⏳12m` / `⏳12m+1` / `⏳grace 58s`，宽限期内永不丢弃；所有符号后跟空格并通过 `WIDE_RISK_GLYPHS` / `findGlyphCollisions`；紧凑标记只用英文 token。

## 6. 不变式论证

- **有界**：排队时长 ≤ `killAt − enqueuedAt` ≤ `hardAt − enqueuedAt`；WT8 触发 `finish` → `stopOwned` 同步 withheld 排队项；队列长度 ≤ `maxChildren − active`；派发 spawn 超时 ≤ `min(hostCallMs, remaining)`；worker `waitForSettle` 界限 `deadlineAt + 5s` 恒有值（BW10 已取消）；延长次数 ≤ `maxExtensions`，截止 ≤ `hardAt`；子任务同步重试 ≤ 子任务截止 ≤ `hardAt`；background race 上界静态。
- **确定终态**：stop / abort / worker 死亡 / runaway / timed_out 都经 `stopOwned` 或 `onTerminating` → `cancelAll` → `settleUnspawned`；phase 超时与 HR2 超时各走 `settleUnspawned`；「谁翻成 settled 谁记录」+ 全出口守卫 ⇒ 每个 callId 恰好一条 `children` 记录、至多一次 `host_settle`；迟到 spawn 一定走 bind → cancelNow → 孤儿 abort。
- **不死锁**：`activeCount()` 排除 queued；`recordSettled` 中 `pump` 同步派发队首；活跃子任务受 watchdog 与 CC4 约束必然结算；HR2 残留已及时释放。
- **replay / journal**：occurrence 与 chain digest 在入队**前**按到达顺序分配，与派发顺序无关（「至多复用一次」不变）；命中不排队；withheld 删除 journal meta、永不写入（RP3）。
- **D-10 / CC4**：模型面显式 `timeout_s` 仍为硬顶；workflow 子任务不是模型面显式预算，由 owner 驱动延长、模型无法直接延长（工具层拦截）；子任务 hard = `W.hardAt` 且 workflow 终止时 `stopOwned` 会中止它们 ⇒「子任务不晚于 workflow 结束」仍是结构性保证；子任务截止靠 reducer 现有 `deadline_extended` 移动（watchdog 每 tick 读 deadlines、runner `guardUntil` 重 arm），**核心状态机与 watchdog 零改动**。
- **计时器卫生**：新增仅三类——每项派发 spawn 超时计时器（随 settle 清）、单个同步重试计时器、单个 controller 驱动的 WT8 计时器；终止时全部清掉，`FakeClock.pendingTimers` 应为 0。

## 7. 测试计划

**阶段 A**

- `call-registry.test.ts`：queued 转移（admit、cancel→withheld 且不调 abort、cancel 后 admit=false、CR4、cancelAll 归入 withheld、`stats.queued`）；新增阶段转移表（5 阶段 × {admit, bind, settle, cancel}）。
- `host.test.ts`：maxParallel 用例改为排队（`ack{queued:true}`、FIFO、不插队）；stop / terminate 时排队项 withheld（settle `ok:false`、`children` 恰好一条、spawn 未调用、计时器残留 0）；phase 超时只撤同 phase 排队项；派发时 BW2 → 非 rejected withheld；派发 spawn error → `rejected`；**Blocker-1 回归**（派发 spawn 超时后迟到 runId 触发 abort，且无第二条 settle）；**Major-1 回归**（spawn 在途时被 phase 超时 / `stopOwned` 撤下 × spawn 以 error / 成功 / 超时结束，每种组合恰好一条记录）；两个既有缺陷各一条回归；HR2 超时释放名额使排队项得以派发；maxChildren 计入排队项；满载时 replay 命中不排队；事件顺序与 `rejected` / `stage_error` 字段。
- `worker-host-call.test.ts`（真实 worker）：复现现场（未 await 慢任务 + `await parallel([4 thunks])`，全部非 null、无 stage_error）；`rejected` settle 让 `agent()` reject、脚本可 catch；缓冲中的 settle 带 `rejected` 仍 reject。
- `journal-replay-e2e.test.ts`：含排队的运行二次全部命中、occurrence 一致；排队项 withheld 时 journal 零写入（RP3）。
- 配置：`workflowTotalS: 0` 回退默认并 WARN；spec `min === 1`。
- `activity.test.ts`：`queuedChildren` 增减、`rejectedTotal`、`stageErrorTotal`。
- 属性测试 `host-queue.property.test.ts`（带种子）：随机交错 submit / settle / phase 超时 / spawn 迟到或报错 / stop；断言任意时刻 `active ≤ maxParallel`、派发顺序 = 入队顺序、每个 callId 恰好一次记录、stop 后队列 / `listActive` / 计时器皆空。

**阶段 B**

- `tests/workflow/deadline.test.ts`：转移表 {软截止到点, 宽限到点, extend} × {有额度, 无额度, 显式预算, closed}；属性测试 `softAt` 单调、`killAt ∈ [softAt, hardAt]`。
- orchestrator / host 集成：宽限期仍可派发、排队项不因 BW2 判死；宽限期内 extend 救回、WT8 重 arm、在跑子任务 `extendTo` 到新 `killAt`；`not_started` 子任务经重试同步；不延长时 `graceUntil` timed_out 并中止子任务；显式 `timeout_s` 不进宽限、回 `no_headroom`（显式预算文案）。
- `spawn-service` / `deadline-cap`：`owner_extendable` 子任务 hard = cap、可延长、不进宽限；`"hard"` 不变。
- `extend-timeout-tool.test.ts`：wf id 成功与各拒绝文案；workflow 子 run 被拦截。
- `deadline-notice.test.ts`：workflow grace / extended 文案快照。
- `background.test.ts`：`extend` 各分支、`runBoundMs` 用 hard ceiling、view 字段。
- 集成 `tests/integration/workflow-grace-wiring.test.ts`：通知进主会话、`triggerTurn` 取值、不进 outbox。
- 核心 `state-machine` matrix 与属性测试**无需同步**（无新输入 / 相位，`ExtendSource` 仅扩类型）。

每阶段结束跑全量门禁：`format:check`、`typecheck`、`test`、`build`。

## 8. 风险与未决

- 语义变化：以前被拒的 `agent()` 现在成功；派发时准入失败从 ack 失败变为 `rejected` settle（worker 仍 reject）；`workflowTotalS: 0` 从「名义无界、实际约 14s」变为回退默认 1h + WARN（修复性质）。
- 核心 `queue_wait` / startup 中的子任务在 workflow 延长后靠重试同步；若 SlotPool 饥饿超过旧 `killAt`，该子任务可能先被自身截止杀掉（null）。已知限制，写入文档。
- `owner_extendable` 子任务理论上可被其它 owner 路径延长，目前无此路径；工具层拦截只防模型，将来开放 RPC 延长需复查。
- 宽限默认复用 90s；子任务多时模型决策可能更慢，真机验证后复核。

### 需要用户拍板

> **用户已决定（v2）**：① 复用 subagent 的 `budget.totalGraceMs / maxExtensions / maxTotalFactor` 与 `extend.*`；
> ② 取消 BW10（`workflowTotalS` 必须 > 0）；③ **阶段 A 与 B 一起交付**——仍按 §9 拆提交、按顺序开发，
> 但不单独发布阶段 A，整体验收后一起合入。

1. workflow 直接复用 subagent 的 `budget.totalGraceMs / maxExtensions / maxTotalFactor` 与 `extend.*`，不新增 `workflow.budget.*` 键。**建议：复用。**
2. 取消 BW10（`workflowTotalS` 必须 > 0）作为 Major-2 的处置。**建议：接受。**
3. 阶段 B 在阶段 A 合入后单独交付。**建议：接受。**

> 已由用户确认的 v1 决定：不加单次排队上限（改由宽限/延长覆盖）；时间耗尽类派发失败由宽限/延长覆盖、其余派发失败 reject；UI 显示 `⧗ N` / `⚠ N`；一起修两个既有缺陷；不向脚本 `budget` 暴露 maxParallel / 排队数。

## 9. 交付顺序与拆包

**阶段 A：排队本体（约 1.5–2 人日，主会话串行）**

1. `fix(workflow): single-owner settlement for phase-timeout, spawn-error and HR2 residual admissions` —— host.ts D6–D8 + host.test 回归。
2. `fix(config): workflow.budget.workflowTotalS must be > 0 (BW10 unsupported in background mode)` —— settings.ts、setting-specs.ts、budget.ts 注释 + 配置测试。
3. `feat(workflow): queued call phase in CallRegistry` —— types.ts、call-registry.ts + 测试。
4. `feat(workflow): FIFO-queue agent() calls beyond maxParallel` —— host.ts D1–D5 / D9、worker-source.ts + host / worker / journal / 属性测试。
5. `feat(workflow): queued/rejected/stage_error activity events` —— host.ts D10、orchestrator.ts、activity.ts + 测试。
6. `docs(workflow): agent() queueing` —— workflow-tool.ts 描述、本文件、workflow-background/plan.md、AGENTS.md。

- 冻结面：`src/workflow/types.ts`（第 3 个 commit 定稿后）；`src/ui/fleet-widget.ts`（另一任务占用，阶段 A 不碰）；`src/core/**`、`src/service/**`（阶段 A 不碰）。

**A-UI（约 0.5 人日，fleet-widget 任务合入后）**：`feat(ui): workflow ⧗/⚠ header markers and queued rows`，只改 fleet-widget.ts 及测试（可选 workflow-tool 卡片 `⧗` 行）。

**阶段 B：宽限与延长（约 3–4 人日）**

- **B0（主会话，冻结面）**：`feat(core): owner-extendable spawn deadline policy`（core/types.ts `deadlinePolicy`、`ExtendSource "workflow"`，spawn-service.ts:469 + deadline-cap 测试）；`WorkflowRunBudget` 字段、`WorkflowExtendOutcome`、`Orchestrator.extend` / `BackgroundWorkflows.extend` 签名先以存根提交（返回 `unsupported`）。
- **B1**：`feat(workflow): pure workflow deadline controller`（`src/workflow/deadline.ts` + 测试），与 B2-tools 无交集可并行。
- **B2-engine**：`feat(workflow): workflow grace window and deadline propagation`（orchestrator.ts、host.ts `killAt` / `onDeadlineMoved` / 同步重试、background.ts、run-budget.ts、spawner-adapter.ts、workflow-tool.ts + 集成测试）。
- **B2-tools**：`feat(tools): extend_subagent_timeout accepts workflow ids`（extend-timeout-tool.ts、workflow-target.ts、deadline-notice.ts + 测试）。
- **B3（主会话）**：`feat(workflow): wire workflow deadline notices`（stack.ts、index.ts + `workflow-grace-wiring` 集成测试）。
- **B-UI**：`feat(ui): workflow grace deadline marker`，只改 fleet-widget.ts。
- **B-docs**：`docs(workflow): grace & extension`（本文件 §4 状态行、timeout-notify arch.md 补「workflow 已接入」、AGENTS.md、README）。
- 阶段 B 冻结面：`core/types.ts`、`service/spawn-service.ts`、`stack.ts`、`index.ts`（仅主会话在 B0 / B3 修改）；`workflow/types.ts` 在 B0 定稿。

**顺序**：A →（A-UI ∥ B0）→（B1 ∥ B2-tools）→ B2-engine → B3 → B-UI → B-docs。
