# I1 报告 — 集成包（定时任务 #32，最后一包）

方案：`plan.md` r3 §12 I1 行、§14。前序：S0 ec4297b0 · S1 47d07e95 · W1 b272dfb9 · F1 7766997b · A0 85961b04 · A1 74c53459 · A3 0658b8ac · A2 d7124d4e · H1 69170deb。本包**零 git 写操作**（未提交）。

## 1. 改动清单

### 生产代码

| 文件                                                                                    | 改动                                                                                                                                                                                                                                                                                                                       |
| --------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `/home/bluecake/ai/pi-toolkit/src/schedule/agent/executors.ts`                          | **新增**：`installScheduleExecutors`——每会话装配 message attach + background executor（notes 端口接 `pi.sendMessage`/`ctx.isIdle`/sessionFile）+ handoff 适配（`enqueueHandoff`；dropped/unknown ⇒ 同 noteId 的 `handoff-recap` quiet 消息；无 message installer ⇒ handoff 返回 false）                                    |
| `/home/bluecake/ai/pi-toolkit/src/stack.ts`                                             | `createAgent` 后调用 `installScheduleExecutors`；`Stack.scheduleBackground`                                                                                                                                                                                                                                                |
| `/home/bluecake/ai/pi-toolkit/src/index.ts`                                             | 装配：`installMessageScheduler`（fence 端口晚绑定、rootWake busy、attributeInput、agentKey）；关闭时只装孤儿 guard；`wireScheduleSurface(..., revokeQueued)`；`agent_settled`→notes.settled；session_start 末尾 notes.flush；shutdown/防御性重建处 dispose；`/schedule` 传 `resetBlockers`、`/fabric` 传 `afterFenceReset` |
| `/home/bluecake/ai/pi-toolkit/src/schedule/agent/wire.ts`                               | `ScheduleWiring.message?`                                                                                                                                                                                                                                                                                                  |
| `/home/bluecake/ai/pi-toolkit/src/commands/fabric-xs.ts`                                | `afterFenceReset?`——`/fabric fence reset` 本地分支后调用                                                                                                                                                                                                                                                                   |
| `/home/bluecake/ai/pi-toolkit/src/commands/schedule.ts`                                 | `/schedule repair` 调 `resetBlockers`（web 冻结表 deny，且 web 调用不重置）；pause/resume/rm 经 `revokeOpts()`（`--all` 仅同会话才传 in-memory revoke）；help 文案                                                                                                                                                         |
| `/home/bluecake/ai/pi-toolkit/src/schedule/agent/ops.ts`                                | `RevokeOpts`/`dropQueuedRuns`：pause 与 delete 成功后撤销该任务排队中的 message run（S1 `finishRun(dropped,"task-changed")`）并调 in-memory `revoke`                                                                                                                                                                       |
| `/home/bluecake/ai/pi-toolkit/src/tools/schedule-tool.ts`                               | pause/delete 经 `revokeOf()` 传入撤销端口                                                                                                                                                                                                                                                                                  |
| `/home/bluecake/ai/pi-toolkit/src/schedule/agent/surface.ts`                            | `ScheduleSurfaceDeps.revokeQueued?` → opsPorts                                                                                                                                                                                                                                                                             |
| `/home/bluecake/ai/pi-toolkit/src/schedule/agent/dispatch.ts`                           | A2 增量（root 批准）：`revokeTask(taskId)`（CAS 中条目标 `revoked`，pump 在 CAS 后丢弃且绝不发送）；**C-S5 修复**（见 §5）                                                                                                                                                                                                 |
| `/home/bluecake/ai/pi-toolkit/src/schedule/agent/message.ts`                            | install 暴露 `revokeTask`                                                                                                                                                                                                                                                                                                  |
| `/home/bluecake/ai/pi-toolkit/src/schedule/agent/view.ts`                               | `runLine` 对 dropped 已知原因追加英文说明                                                                                                                                                                                                                                                                                  |
| `/home/bluecake/ai/pi-toolkit/src/web-hub/ui/src/logic/schedule.js`                     | `runReasonKey`                                                                                                                                                                                                                                                                                                             |
| `/home/bluecake/ai/pi-toolkit/src/web-hub/ui/src/logic/state.js`                        | `SCHEDULES_EVENT = pinnedEvent(SCHED_EVENT)`（加载期漂移钉）                                                                                                                                                                                                                                                               |
| `/home/bluecake/ai/pi-toolkit/src/web-hub/ui/src/i18n/schedule-extra.ts`                | en/zh 平价 `runReason.*`（含 `task-changed`）                                                                                                                                                                                                                                                                              |
| `/home/bluecake/ai/pi-toolkit/src/web-hub/ui/src/components/schedule/SchedulePanel.vue` | dropped 运行显示映射文案（未知原因显示原文）                                                                                                                                                                                                                                                                               |

### 测试 / 夹具

| 文件                                                                                                                     | 内容                                                                                                                                                                                       |
| ------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `/home/bluecake/ai/pi-toolkit/tests/integration/helpers/schedule-activate.ts`                                            | 新增：真实 `activate()` × 假 pi 的集成夹具（resetGlobals）                                                                                                                                 |
| `/home/bluecake/ai/pi-toolkit/tests/integration/schedule-off-golden.test.ts` + `tests/fixtures/schedule-off-golden.json` | 新增 off golden（工具表/命令表/handler 计数/system prompt/hello caps 无 `sched.`/HubConfig 无 schedule key/不写旧文件与 schedules 目录/孤儿 guard 行为）。**仅 fixtures 目录里新增这一份** |
| `/home/bluecake/ai/pi-toolkit/tests/integration/schedule-wiring.test.ts`                                                 | 新增 12 条：真实 activate × 假 pi × mock spawn-service 的端到端装配                                                                                                                        |
| `/home/bluecake/ai/pi-toolkit/tests/integration/schedule-hub.test.ts`                                                    | 新增：真实 hub 子进程 × 假飞书 × 真实 agent 侧 A0/A1/router（SC2、SC5）                                                                                                                    |
| `/home/bluecake/ai/pi-toolkit/tests/integration/schedule-fault-matrix.test.ts` + `fixtures/schedule-matrix-child.ts`     | 新增：9 个 SIGKILL 点 + control                                                                                                                                                            |
| `/home/bluecake/ai/pi-toolkit/tests/conformance/schedule.test.ts` + `fixtures/schedule-print-child.mts`                  | 新增：C-S1…C-S8（11 条），真实 pi + 本地 AnthropicStub                                                                                                                                     |
| `/home/bluecake/ai/pi-toolkit/tests/schedule/agent/dispatch.test.ts`                                                     | +revokeTask 4 条、+自引 compaction 8 条（95 通过）                                                                                                                                         |
| `/home/bluecake/ai/pi-toolkit/tests/schedule/agent/ops.test.ts`                                                          | +3 条撤销                                                                                                                                                                                  |
| `/home/bluecake/ai/pi-toolkit/tests/web-hub/ui/schedule-logic.test.ts`                                                   | +`runReasonKey`                                                                                                                                                                            |
| `/home/bluecake/ai/pi-toolkit/tests/integration/schedule-surface-wiring.test.ts`                                         | 足迹断言更新（ON 相对 OFF 基线的 handler 增量：agent_settled+2 等，因 OFF 现在有 3 个孤儿 guard hook）                                                                                     |
| flaky 加固（只改测试/夹具）                                                                                              | `tests/schedule/core/fault-injection.test.ts` + `fixtures/crash-child.ts`、`tests/schedule/core/session-proof.test.ts`、`tests/schedule/agent/bg.test.ts`（见 §6）                         |

### 文档

`docs/dev/scheduled-reports/{I1-report,acceptance}.md`（新）· `A2-report.md` §9（追加）· `AGENTS.md`（`src/schedule/` 段替换旧一行；顶部概述与 secure 段里的旧 cron 表述同步）。

## 2. 接线点

| 接线点                                     | 位置                                                            | 说明                                                                                      |
| ------------------------------------------ | --------------------------------------------------------------- | ----------------------------------------------------------------------------------------- |
| message scheduler 安装                     | `index.ts`（enabled）                                           | 端口：fence 的 webExec/topicSwitch/goal（晚绑定）、rootWakeBusy、attributeInput、agentKey |
| background / handoff 执行器                | `stack.ts` → `executors.ts`                                     | spawn、consult 已可用后装配；无 holder/无 sid/非 arm ⇒ 不装                               |
| agent_settled → notes.settled              | `index.ts`                                                      | 仅 schedule 开启时注册                                                                    |
| session_start 末尾 flush                   | `index.ts`                                                      | `void stack.scheduleBackground?.notes.flush()`                                            |
| shutdown / 防御性重建                      | `index.ts`                                                      | `await stack.schedule?.shutdown()` 之后 `scheduleBackground.dispose()`                    |
| `/schedule repair` / `/fabric fence reset` | `commands/schedule.ts`、`commands/fabric-xs.ts`                 | 都调 `resetBlockers()`，web deny                                                          |
| pause/rm 撤销排队                          | `ops.ts`/`schedule-tool.ts`/`commands/schedule.ts`/`surface.ts` | ledger 半边（`--all` 也覆盖）+ in-memory `revokeTask`（仅本进程）                         |
| 关闭时孤儿 guard                           | `index.ts`                                                      | 仅 hooks，零 IO                                                                           |

## 3. §14 覆盖映射（诚实标注）

| 编号                                        | 落点                                                                                                                                                                                                                                         | 备注                                                                                         |
| ------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------- |
| SC1 双进程同会话只执行一次                  | **S1 单元**（`tests/schedule/core/claim.test.ts`、`fault-injection.test.ts` 的 N 进程竞争）。I1 没有再起双 pi 进程的集成；真机补 acceptance #0（评审第 1 轮验收 minor）。                                                                    | 间接                                                                                         |
| SC2 background 结果 + 飞书报告 + 回执清索引 | `schedule-wiring`（报告文件、quiet note、`pendingReports`）+ `schedule-hub`（真实 hub：发现→飞书推送恰 1 次→`sched_receipts`→agent 清 `pendingReports`）                                                                                     | 直接                                                                                         |
| SC3 handoff                                 | `schedule-wiring`（接手 + defHash + 授权 + settled；capability absent ⇒ recap）+ A2 `dispatch.test.ts`。**done 通知精确抑制（`sched_bound` 在 hub/F1 侧生效）I1 无法在真实 hub 子进程里观测**：只有 H1/F1 既有单测，需真机（acceptance #13） | 部分                                                                                         |
| SC4 message                                 | `schedule-wiring`（忙时排队、token 授权、伪造 token abort、settled+报告）+ `dispatch.test.ts`（D13、人工抢先 ⇒ continued、60 min 上限）+ conformance C-S2/C-S4                                                                               | 直接                                                                                         |
| SC5 离线错过                                | `schedule-hub`（离线会话 S1 sweep 的 missed → hub 启动对账推 1 张合并卡且不重复）。「同小时合并/整点汇总」由 F1/H1 单测覆盖；digest 只出现一次由 A1 `digest.test.ts` 覆盖                                                                    | 部分                                                                                         |
| SC6 运行中关闭会话                          | `schedule-wiring`（shutdown ⇒ `unknown(owner-closed)` 先于迟到 outcome）+ 故障矩阵（SIGKILL ⇒ `unknown(crash)`）+ H1 对账单测。飞书推送「结果未知」的真实 hub 端到端 I1 没做                                                                 | 部分                                                                                         |
| SC7 hub 停机/24h 补推                       | H1 `schedule-reconcile`/`schedule-service` 单测；`schedule-hub` 的 SC5 场景覆盖「hub 启动后对账」。24h 边界与「归属会话关闭也补推」只在单测层                                                                                                | 间接                                                                                         |
| SC8 飞书 `/schedule run`                    | F1 `schedule-router/service` 单测 + H1 `schedule-service`；**`sched_run` 立即运行未做子进程 e2e**（acceptance #14）                                                                                                                          | 间接                                                                                         |
| SC9 gate 关闭字节不变                       | `schedule-off-golden.test.ts` + `schedule-off-golden.json`                                                                                                                                                                                   | 直接                                                                                         |
| SC10 vault 路径被拒                         | A0 `mode.test.ts`/`wire.test.ts`/`stack-wiring.test.ts`（agent 侧 vault 谓词）；hub 侧无 vault 谓词（H1 遗留 #3）                                                                                                                            | 间接                                                                                         |
| SC11 web 审阅 + hash CAS                    | A3 `ops.test.ts`（`E_REV`）+ H1 `schedule-http` + W1 `schedule-panel.test.ts`                                                                                                                                                                | 间接                                                                                         |
| C-S1…C-S8                                   | `tests/conformance/schedule.test.ts`（C-S1,2,3,3b,4,5,5b,5c,6,7,8）；C-S6 需要 tsx（缺失 ⇒ 仅该条 skip），其余无需标志/凭据                                                                                                                  | 直接                                                                                         |
| 故障矩阵                                    | `schedule-fault-matrix.test.ts`：{claim, running, report} × {lock-held, tmp-written, renamed} + control，断言结果只会是「未 claim / dispatching                                                                                              | running→unknown(crash) / completed+索引」，孤儿报告过 retention 被 GC，已索引报告 2 h 后仍在 | 直接 |
| off golden                                  | 见 SC9；三份 fabric off golden、keepalive-legacy、secure-off、legacy-xs-v071 全部未改（`git status --short tests/fixtures` 只有新增 schedule-off-golden.json）                                                                               | 直接                                                                                         |

## 4. 变异验证（逐条改生产代码 → 测试红 → 还原）

stack 不装执行器 RED · 去 `agent_settled` 钩子 RED · repair 不重置 RED · handoff 无 recap RED · 不装 message installer RED · ledger 撤销 no-op RED · revoke 的 CAS 中分支去除 RED · pause 不调 in-memory revoke RED。**GREEN 的两条（均为等价变异，已分析）**：「revoke 不摘队列」——pump 的 CAS 看到 ledger 已非 queued 同样丢弃，属安全网；「compaction 结束不重 arm」——计时器到点自重 arm。自引 compaction 的变异见 A2-report §9。生产文件已全部还原（`git diff --stat` 抽查）。

## 5. C-S5 发现与修复

真实 pi 的 pre-start compaction 在 `sendCustomMessage` 同步栈内触发，原 `verifyDispatch` 把它当「会话身份移动」⇒ `unknown(owner-closed)`、触发变孤儿，上下文接近阈值时定时消息**永不执行**。已向 root 报告并获裁定在本包修复：同步栈归因（`sending` 标记）、仅 compaction 窗口豁免（`fence.status().open` 全为 compaction）、启动预算暂停 + 600 s 硬上限、compaction 失败/取消不重发，授权点与孤儿 abort 不变。完整说明、测试与残差见 `A2-report.md` §9（供 gpt 评审授权时序）。

## 6. 偏差与残差

1. **接线先于集成测试**写成，违反「先写失败测试」；以 §4 的变异验证补证（每个接线点撤销都有测试变红）。
2. **flaky 处置（只改测试/夹具）**：
   - `fault-injection`「8 processes race」：受害进程改为在 `lock-hold-wait` 持锁点阻塞（夹具新增该 mode，打印 HELD），测试等 HELD → 起 7 个竞争者 → 等 300 ms → SIGKILL；3 次连跑全绿。这一条是确定性重写。
   - `session-proof`：`find` 注入 `wallNow: () => Date.now()+60_000`。根因是**推断**：`settleMs:0` 时 `floor(Date.now() ms)·1e6 − 文件亚毫秒 ctime < 0` 会把同毫秒写入的文件判 unsettled ⇒ inconclusive。**未能稳定复现**，属加固。
   - `bg`「port ignores waitMs」：循环推进 FakeClock 至终态，dispose 后让出一拍再断言 `pendingTimers=0`。10 并发 + CPU 烧机下**未复现**，属加固。
3. **OFF 足迹不再是「零 handler」**：schedule 关闭时装孤儿 guard 的 3 个 hook（`before_agent_start`/`context`/`agent_settled`），不改工具表/命令表/prompt/HubConfig/IO；已入 off golden 的 handlerCounts，`schedule-surface-wiring` 的 ON−OFF 增量相应调整。
4. 状态栏 `msg off / msg ?` 已由 A3 `status.ts` 自带，**不需要**接 `install.statusSuffix()`。
5. `/schedule repair` 在 web 冻结表里是 deny（S0 冻结表未动），所以只有本地 TUI/RPC 可用；web 调用不重置。`/fabric fence reset` 同样触发 `resetBlockers()`。
6. **`--all` 撤销残差**：`pause/rm --all` 对他进程的 ledger 半边生效，但够不到他进程的内存队列（handoff 条目），那里靠发送 CAS 的任务快照逐字段比对兜底（A2 §8 #3）。已写入 AGENTS.md 残差摘要。
7. F1 飞书卡片没有 run 原因文案（只有 view.ts 英文与 web i18n），本包未加。
8. `sched_bound`（done 通知抑制）与飞书 `sched_run` 立即运行没有真实 hub 子进程 e2e，见 §3 与 acceptance #13/#14。
9. `task-changed` 等 dropped 原因此前仓库没有「原因→文案」映射，本包新增（view.ts 英文、web `runReasonKey` + i18n en/zh 平价）。
10. A2 residual（`session_before_compact` handler 排在异步 handler 之后时不被识别为自引）见 A2-report §9。

## 7. 自验

| 命令                                                                                            | 结果                                                                                                                                                                                                                                                       |
| ----------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `npx prettier --check`（本包改动/新增的 35 个文件 + `tests/fixtures/schedule-off-golden.json`） | 通过（README*/`docs/guide/subagents.md`/`answer-codec*` 是预先存在的他人未提交改动，未碰）                                                                                                                                                                 |
| `npm run typecheck`                                                                             | 通过（tsc + typecheck 配置 + vue-tsc）                                                                                                                                                                                                                     |
| `npm run build`                                                                                 | 通过                                                                                                                                                                                                                                                       |
| `npx vitest run --maxWorkers=2`（全量，一次）                                                   | **1543 个文件 / 29298 passed / 23 skipped / 0 failed**（2070 s）。注：第一次全量被我设的 1500 s `timeout` 截断（无汇总，未当结果用），其间 `tests/web-hub/hub/cmd-history-runtail.test.ts` 出现 1 条失败（负载下，与 schedule 无关）；完整重跑时该文件通过 |
| `npx vitest run tests/conformance/schedule.test.ts` ×3                                          | 每次 11 passed（仅 C-S6 依赖 tsx，缺失则 skip；其余无需标志/凭据，provider 为本地 AnthropicStub）                                                                                                                                                          |
| `schedule-hub` + `schedule-fault-matrix` + `schedule-wiring` ×2                                 | 各 24 passed，无 flake                                                                                                                                                                                                                                     |
| `npx vitest run tests/web-hub/ui tests/web-hub/boundary.test.ts`                                | 266 个文件 / 5788 passed                                                                                                                                                                                                                                   |
| `npx vitest run tests/schedule/agent/dispatch.test.ts`                                          | 95 passed                                                                                                                                                                                                                                                  |
| `git status --short tests/fixtures`                                                             | 仅 `?? tests/fixtures/schedule-off-golden.json`（新增）；其它 fixture 零改动                                                                                                                                                                               |

## 8. 评审第 1 轮处置（验收 deepseek-flash：有条件通过 3 minor；评审 gpt：4 major + 1 minor；主会话裁定全部必修）

基线：`/tmp/i1-verify.json`、`/tmp/i1-review-r1.json`。每条的做法、论证、测试与撤销验证见 `A2-report.md` §9「评审第 1 轮处置」，此处是索引与偏差。

| #   | 条目                                                          | 处置                                                                                                                                                                                                                                      | 测试                                                                                                                                   |
| --- | ------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | 生产 handler 顺序下自引归因失效（major）                      | 归因改为「绑定 `dispatched` flight 的 5 s 窗口」（`SCHED_SELF_COMPACTION_ATTRIB_MS`），不再依赖同步栈；未选「保证 A2 handler 最先注册」（做不到：xs 与其它扩展先于调度器注册）                                                            | 单测 + 真实 pi **C-S5d**（A2 之前注册同步与异步 `session_before_compact` handler，即生产顺序）                                         |
| 2   | 压缩等待期间后开的 switch/fork 不撤销 pending flight（major） | `before_agent_start` 授权前与 `context` 首次模型调用前复核 fence（generation + 非自引窗口），命中 ⇒ `unknown(owner-closed)`、中止、不重发                                                                                                 | 单测（switch/fork/tree/外来 compaction/session_start/context 前开窗）+ 真实 pi **C-S5e**（压缩中挂起的 `newSession()` ⇒ 主请求不发出） |
| 3   | `revokeTask` 无撤销代次（major）                              | 调度器内 `revokedAt[taskId]`；enqueue 与发送 CAS 都检查来源 run 的 claim 时间；handoff 输入新增 `startedAt`                                                                                                                               | 单测 + wiring（auto once 运行中 pause ⇒ 后完成的 handoff 只写一条 recap、无唤醒；带 control）                                          |
| 4   | UI 配对 kind/title 歧义会少阻塞（major）                      | pi 的 ui 事件无唯一 id ⇒ 改为只会多阻塞：`end` 无已开对话即忽略（删 credit）；出口 `/schedule repair`、`/fabric fence reset`                                                                                                              | 单测（end(A)→start(B)→start(A) 全程阻塞；旧「end 先到」用例改为新语义）                                                                |
| 5   | `onEnd` 非幂等（minor）                                       | `endHandoff` 一次性 + 适配器 `recapped` 守卫                                                                                                                                                                                              | 单测（deferred CAS→revoke→D13→settle 只听到一次）+ 新增 `tests/schedule/agent/executors.test.ts`                                       |
| 6   | 验收 minor ×3                                                 | AGENTS.md 解除出口分别标注（`/fabric fence reset` 受 `webCommandPolicy.fabric` 管、默认 web 可执行；`/schedule repair` web deny）；acceptance.md 补 SC1 真机项（#0）、#10 改为不经 `/reload` 的构造，另补 #15（压缩中切换）#16（xs 开启） | —                                                                                                                                      |

**偏差 / 披露**

- 发送 CAS 里的 `revokedSince` 检查去掉后测试仍绿（等价变异）：入队检查与 `revoked` 标记已覆盖全部可达路径，保留为纵深防御；BAS 复核与 context 复核互为冗余，单独去掉其一真实 pi 测试仍绿，**两层同时去掉 C-S5e RED**，单测对每层分别钉住。
- 窗口归因的代价：窗口内（5 s）由别人触发、且发生在 pending 触发之前的 compaction 会被误归因，只导致预算暂停（≤600 s），授权由 #2 的复核兜住。
- **发现并修复的测试夹具缺陷**（只改测试）：conformance 夹具的 `queueRun` 任务默认是整点 cron，夹具推进 fake 时钟若跨整点会产生一次自动 run，污染 C-S5b 的请求计数（20% 左右概率，本轮首次全量后复跑时暴露）。改为年度 cron（`0 0 1 1 *`）。其它用例未发现受影响，但同类隐患在夹具层面已一并消除。
- `ui` 保守配对的代价是：end 先于 start 的乱序会留下一个只能靠本地出口清除的阻塞；pi 本身对同一对话的 start/end 按 microtask 保序，乱序只在前置 handler 耗时不均时出现。

### 自验（本轮，不跑全量）

| 命令                                                                                        | 结果                                                                                            |
| ------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------- |
| `npx vitest run tests/schedule --maxWorkers=3`                                              | 24 个文件 / **430 passed**                                                                      |
| `npx vitest run tests/integration/schedule-*.test.ts --maxWorkers=2`                        | 5 个文件 / **34 passed**                                                                        |
| `npx vitest run tests/conformance/schedule.test.ts` ×3                                      | 每次 13 passed                                                                                  |
| `tests/integration/schedule-off-golden.test.ts` + `tests/web-hub/ui/schedule-logic.test.ts` | 2 个文件 / 21 passed；`git status --short tests/fixtures` 仍只有新增 `schedule-off-golden.json` |
| `npm run typecheck`                                                                         | 通过                                                                                            |
| `npx prettier --check`（本包全部改动/新增文件）                                             | 通过                                                                                            |

## 9. 评审第 2 轮处置（主会话裁定，不再开评审）

第 2 轮复审 4 条 closed，剩 #4（UI 配对）not-closed：同 key 下 start(B) → end(A) → 迟到 start(A) 时 end(A) 消耗 B 的 open，B 仍打开而计数归零放行。无唯一对话 id，计数原理上无法区分 ⇒ 以**有界缓冲**收敛（详见 `A2-report.md` §9「评审第 2 轮处置」）：

- 命名导出 `UI_END_SETTLE_MS = 2_000`（`src/schedule/agent/dispatch.ts`）；`uiLastEndAt` 记录最后一次 ui end；派发 readiness 要求 `now − uiLastEndAt ≥ UI_END_SETTLE_MS`；end 分支 `schedulePump(UI_END_SETTLE_MS)`；`resetBlockers()` 清 `uiLastEndAt`。
- 残差：迟到超过窗口的交错仍可能放行一次，出口 `/schedule repair`、`/fabric fence reset`（AGENTS.md `src/schedule/` 段残差摘要已同步）。
- 测试 + 撤销验证：窗口内迟到 start 不派发 / 满窗口后恰派发一次 / 普通对话只延后一个窗口 / reset 跳过缓冲；去 settle 检查 RED（2 条）；「end 分支 pump 立即」为等价变异（披露）。
- 自验见本节下表（本轮不跑全量）。

| 命令                                                                                        | 结果                                  |
| ------------------------------------------------------------------------------------------- | ------------------------------------- |
| `npx vitest run tests/schedule/agent/dispatch.test.ts tests/schedule/agent/message.test.ts` | 2 个文件 / **138 passed**             |
| `npx vitest run tests/integration/schedule-*.test.ts --maxWorkers=2`                        | 5 个文件 / **34 passed**              |
| `npx vitest run tests/conformance/schedule.test.ts` ×2                                      | 每次 13 passed                        |
| `npm run typecheck` / `npx prettier --check`（本包全部改动/新增文件）                       | 通过                                  |
| `git status --short tests/fixtures`                                                         | 仍只有新增 `schedule-off-golden.json` |
