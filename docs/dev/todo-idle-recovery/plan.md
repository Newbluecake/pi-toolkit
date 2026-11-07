# Task59 Stage B：有界 TODO 空闲恢复（已批准；B1 纯内核已交付，B2/B3 待依赖与能力门）

## 2026-11-08 用户新裁定（覆盖旧 strong-window 前置）

用户明确「59 也同步简化」：可信 Host TUI/Web **新用户聊天到达即重置恢复额度**，不等实际模型消费、不依赖 root-level persist 变化，也不等 #61 整项或新 SDK 消费回执。原 Root level 0 连续消息每次新到达都开新窗口；相同到达重复 proof 不重置。下文历史 strong-consumption/Q2 前置以本节为准，不重排历史调研。

- B1 已实现纯 API：`HumanEpochPort` / `parseRecoveryHumanProof` / `applyHumanProof` 接受明确 host provenance `user-arrival`；legacy `strong-consumption` 兼容但不是前置。`admission` / `interactive` 原始标签、`role:user`、机器通知和 Task 操作仍不能开窗。
- 实际 producer 是未来 Host TUI/Web 新聊天入站 callback；由 host 分配/去重单调 epoch 与 inputId、绑定当前 sid/owner，重复到达复用 proof。模型不得通过工具参数传 epoch/owner/inputId 自称 human。本包不构造实际来源，不新增认证框架；parse 只验证形状，不认证任意对象。
- 每窗口最多 2 次、同组合全 sid 一次、seen256 满闭不淘汰、Stop 仅新合格输入解除；旧 owner/stale epoch/异 sid/重复 proof 不清 Stop。全树 high-water 与进程内 open 不变，replay/tree/reload 不造窗，new/fork 不继承权限；reserve 先 append attempt 再 send，unknown 不退款/不重试。
- 当前仅纯内核/store 与测试已实现，**没有生产接线**。B2 专用 runner、owned deadline、队列/触发/teardown 能力仍需真实 SDK 本地 conformance 验证，不预判缺字段即不可能，不引入新 SDK 改造。B3 共享入口须等 #39 当前包独验并 commit 后才触碰。
- #61 的简化 counter 独立；todo 不 import fabric 内核，不新增 ticket 或消费回执依赖。默认 on 是已批准的未来设置，不表示当前运行已激活。

## 一页摘要 / Root 决策

- 基线由调用方给定：主 HEAD `773a65f7`；阶段 A `fbad9b28` 已独验合主。本包不核验 git、不包含其他冻结包或 finalGate 私有快照。
- 目标：主会话真正结束后，若只有可推进的 `in_progress` 工作留下，最多启动一次可见的「检查并继续原授权范围」回合；不是自动批准任务。
- 双限额：每个 `(fingerprint, progressKey)` 在同 session 最多一次尝试；每个真实用户输入窗口最多两次。先记账再发送，未知结果也消费，不退款、不重试。
- 只在 main `agent_settled` 评估；让其余 settled 处理者先入队后再同步复核。无周期扫描、短 sleep、后台自驱无限 root 循环。
- Root 技术裁定：B2 唯一拥有本特性专用 `idle-recovery-runner.ts`；借鉴现 RootWake 的监督模式，不改 xs/fabric、不伪造 XS，不等待外部 owner 提供悬空端口。独立预算和非 XS customType 是拆分理由，不是旧类缺陷。
- 默认（用户已确认 2026-11-07）：`todo.idleRecovery.enabled=true`；安全门不完整时有效状态仍关闭。收益是兑现默认续做；成本是每窗口至多两个额外检查回合。
- 窗口来源（2026-11-08 新裁定）：可信 Host TUI/Web 新用户聊天到达即开窗，见上节；只读 `HumanEpochPort` 是唯一注入点，模型侧无法提供 epoch 或人类声明。
- 可信 arrival producer 尚未接线：B1 以内核 + fail-closed 端口交付，生产不激活；B2（专用 runner）与 B3（host 接线）仍待能力验证与依赖，不等强消费 producer。
- #61 的默认 on / 未知 RPC 不归零及强消费选择不自动成为 #59 的强制 SDK 方案。普通机器 RPC 在两方案中都不得续额。
- 方案异源 review 与用户确认已完成（默认 on + 强消费窗口）；B1 纯内核（`src/todo/idle-recovery.ts`、`src/todo/idle-recovery-store.ts` + 两个定向测试）已交付，不接线、不改真实配置。B2/B3 待依赖与能力门；不得启动原排队 #22/#50，不绕 #36 质量门。

## 1. 已读证据与真实 SDK 边界（r2：落实 Root 五项技术裁定）

| 索引 | 证据（仓库相对路径；SDK 前缀为 node_modules/@earendil-works/pi-coding-agent/dist）                      | 结论                                                                                                                                   |
| ---- | ------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------- |
| E1   | `docs/dev/todo-web/README.md`; `src/todo/index.ts:158-206,240-285,677-780`; `src/todo/settings.ts:1-97` | A 为 display:true / triggerTurn:false；Task 触碰重置旧 nudge，不是恢复预算；已有 getTodoSnapshot 只读口                                |
| E2   | `src/todo/state.ts:11-39`                                                                               | 状态只有 pending/in_progress/completed；等待原因不是可信枚举，metadata 不具授权力                                                      |
| E3   | `docs/dev/subagent-core/README.md:131-177`; `src/stack.ts:1955-1972`                                    | dispose 三路径；query 非终态 + bash backgroundJobCount + workflowActivity.list 可读忙状态                                              |
| E4   | `src/workflow/activity.ts:1-85`                                                                         | list 不含终态 linger，且覆盖 workflow 子任务间隙；不要用 listForDisplay 判忙                                                           |
| E5   | `src/goal/hook.ts:395-475`                                                                              | goalBusy 会含 evalInFlight/active；旧注释称 settled 无载荷，不能当作当前 SDK 契约                                                      |
| E6   | SDK `core/agent-session.js:695-719,1085-1087,1862-1900,1972-2001,2834-2844`                             | 当前 settled 带 aborted；isIdle 实现仅 !runActive && !isCompacting；pendingMessageCount 仅 steer/followUp；两者不是全部宿主队列        |
| E7   | SDK `modes/interactive/interactive-mode.js:2468-2484,3961-3979`; `core/agent-session.js:1989-2001`      | streaming Escape → abort；abort 设置本 run 标记；空闲 Escape 不是 Stop，idle abort 不保证产生新的 settled 标记                         |
| E8   | SDK `core/agent-session.js:1649-1670,1947-1955`; interactive `2762-2774`                                | TUI prompt 默认 interactive，扩展 sendUserMessage 固定 extension；任意 host JS 可仿形不等于普通 LLM 工具可达                           |
| E9   | `src/fabric/root-wake.ts:295-570,760-845`                                                               | xs 专用 request/message；public dispatch/state/busy/recover；私有 arm/deadline/pollIdle 不可越权调用；有固定 rootRunMaxS 与 owner 管理 |
| E10  | `src/web-hub/agent/commands.ts:796-814`; `src/schedule/agent/surface.ts:1-110`                          | Web abort 有明确宿主入口；schedule settled 会另启 digest 工作，必须考虑事件内竞争                                                      |
| E11  | SDK `core/session-manager.js:790-827,913-925`; `core/session-manager.d.ts:178,318,341`                  | appendCustomEntry 同步写；getEntries 全树与 getBranch 不同；无会话文件/未形成 conversation 时不能假定已持久化；不是 fsync 保证         |
| E12  | `src/fabric/decision-input.ts:1-125`; `docs/dev/fabric-cross-session/README.md:589-612`                 | #61 现口径/注释不能直接外推 #59；本方案不修改其 owner 源码，也不重复「TUI 天然不安全」结论                                             |

补充五项源码核验（实际 API；下文标「新增」的均尚未实现）：

1. `src/fabric/root-wake.ts:499-521` 已有 ledger.put → claim → arm **先于 send**；只有 chargeInboundWake 在 send 后。撤回任何「旧类没有先记账」暗示。
2. SDK `core/extensions/types.d.ts:230-238` 的 **ExtensionContext.mode 是公开字段**；`core/extensions/runner.js:355-357,613-628` 返回宿主 runner.mode。hasUI 在 TUI/RPC 都可 true，不能单凭 hasUI 判真人。
3. SDK `core/extensions/types.d.ts:739-761,820-824` 公开 before_agent_start 的 custom message/details 与 settled.aborted；`core/agent-session.js:1441-1506` 起跑先置 busy，pre-start compaction 在 BAS 之前。
4. `src/adapters/pi-compat.ts:280-314` 已有 readBeforeAgentStartTrigger/readContextTrailingCustom；可只读复用解析器，不复用 fabric.classifyHumanInput（它的 RPC 口径不适合本恢复功能）。
5. `src/goal/hook.ts:73-82,392-400` 是 goalBusy；`src/index.ts:1199-1204` 已读 goal.record.state 的 active/paused。B3 同时读两者，paused 不抢；状态未知不激活。

## 2. 候选与权限边界

- 读取 `getTodoSnapshot()` 全量状态，不用 Web 的截断投影。无任务、全 completed/pending/archived：零动作。
- 候选必须 `in_progress`、未归档、所有 blockedBy 指向已完成任务；依赖缺失/循环/状态未知均排除。
- 明确等待 user/审批/external/timer、paused、非本执行者可接手的 owner、定时任务均排除；metadata 可收窄资格，不能授予权限。
- 建议把 `metadata.idleRecovery` 作为可选排除提示（disabled/waiting），不要求历史任务补标，不引入「每 TODO 人工签名」。标题/说明里的明确等待也须在模型检查阶段遵守。
- 宿主筛出「可能可推进」并不等于证明授权：恢复消息必须先核对原对话授权/依赖/人工闸门，未知即停止并标明等待；不得把模型自填 metadata 当授权证据。
- 消息固定约束：仅检查列出的既有任务；有原授权且无需新决策才能继续；否则说明等待并停止，不创建/启动未授权 pending 工作，不自主批准计划/提交/发布。
- 状态层无法识别所有自然语言审批条件是明确残留：最多允许一次检查，不许以候选资格越过人工门。
- 多候选按数字 taskId 稳定排序，消息只列未尝试的指纹/进度键组合；一次发送对列入的所有组合记账，但窗口只扣一次。

## 3. 纯状态机、停止与竞争

状态：`disabled → waiting → scheduled → attempted → running/unknown → waiting`；另有 `suppressed`（当前窗口 Stop）与 `disposed`。

1. `waiting + main settled`：event.aborted=true 即持久抑制当前窗口，直到下一真实用户输入；字段未知不激活，不猜 error 文案。
2. 读 owner/session、human epoch、候选和忙态；合格仅排一只 `setImmediate(...).unref()`，重复 settled 合并，无 async 等待/轮询。
3. 回调重新同步读取 owner/session/epoch/Stop/goal/忙态、fingerprint/**progressKey**/额度；任一变化取消，不自动再排。
4. 同步写 attempt（epoch计数+seen组合+attemptId），runner claim token、arm deadline；重入后再验所有门，同调用栈 send。失败/unknown 都消费，不退款、不重试。
5. 后续只有新的 main settled 可评估。后台完成通知本身不另起检查时钟；Task*、机器消息、树回滚、reload 不解除 Stop 或续额。
6. `enabled=false` 明确停用；删除无 producer 的「持续 pause 锁/可信 resume」设计。metadata.disabled/waiting 只排除，本模块不自动改；用户显式暂停任务仍由模型遵从，不造签名审批系统。
7. new/fork/switch/dispose 撤销 owner、取消 immediate；旧回调不得跨 session。可信输入接手与预算 reset 是两个事件（见 §5）。

**忙门逐类落到符号；B3 新口均同步只读、异常/缺失=unknown，unknown 不激活**：

| 门                  | 实际符号 / B3 新增口与精确 writer                                                                                                                                                                                                                    |
| ------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| SDK                 | `ctx.isIdle()`、`ctx.hasPendingMessages()`；仅证明运行/compaction和steer/followup，不能证明所有隐藏队列                                                                                                                                              |
| Agent/bash/workflow | `stack.query.list()` queued/starting/running/stopping；`bashJobs.backgroundJobCount()`；`workflowActivity.list()`（非 listForDisplay）                                                                                                               |
| 通知                | `Notifier.stats` staged/pending/batched（含 coalescer/ackHold/retry）；`src/delivery/notifier.ts:41-55` 现有公开口；不把 delivered/consumed 当待投递，不改该源                                                                                       |
| Web admission/Stop  | 新增 `CommandHandler.recoveryBusy()` 汇总 command ledger、pendingObservation、queueMirror、hold 的已接收未终结 prompt/steer；`commands.ts` → `agent/index.ts` 返回只读口；新增可选宿主 `recoveryObserver` 仅报告现真实 admission/abort，不改准入策略 |
| schedule内存        | 现 `MessageScheduler.status()/diagnostics()` queued/inflight/uiPrompts；新增 `recoveryBusy()` 包含内部 work.size、fence/dispatch中，writer `src/schedule/agent/dispatch.ts`；`message.ts` 经 install 透传                                            |
| schedule持久/到期   | 现 `ScheduleAgent.readState()`、`clock.status().nextAt/degraded`、`isTerminalRunState()`；B2 host 组合 runs 非终态、pending/unverified note、pendingReports、digest.inflight及 nextAt<=now；读取 degraded 为 unknown，absent 且确认未准入才为空      |
| 未来排期            | nextAt>now 且无上述实际待办即不忙；不扫描其他 session 未来任务，不因存在定时任务永久阻塞                                                                                                                                                             |
| goal/root           | `goalHook.goalBusy()` OR `stack.goal.record?.state` active/paused；record absence 仅已初始化且确认无goal才为空；xs.controller.busy/rootWakeRecovery.busy只读；新 runner.busy 包括unknown/aborting/stuck                                              |
| 人工/生命周期       | settled.aborted、Web已准入abort通知、owner/sid失效、SDK session boundary；未知来源错误不作 Stop 证据                                                                                                                                                 |

one-shot 不是「所有异步 settled handler 已完成」证明；最终发送与 BAS/context 都复核宿主门（忽略本 token 占用）。SDK 隐藏 deferred/custom/nextTurn 无完整查询口，不能发明 `ctx.pendingCustom()`。
当前公开 API 的确证边界：若安装组合允许未被上述宿主观测的队列/异步 settled 注入，或不能证明发送不会滞留跨 teardown，则该组合不开恢复；B2 用真实 SDK 并发用例钉住，失败不靠多 sleep 掩盖。
TUI streaming Escape→abort→settled.aborted 有实证；空闲 Escape 不是 Stop。Web idle Stop 由 commands 的实际 abort 入站通知锁当前窗口；未知 Stop 通路不自动恢复。

## 4. 指纹与持久预算（独立于阶段 A）

- 指纹版本 v1：SHA-256(canonical {taskId, createdAt, status, normalized subject/description, owner, sorted blockedBy + 各依赖完成状态, 选定 waiting/disabled 提示})。
- `progressKey = metadata.idleRecovery.progressKey`：可选 UTF-8 短字符串 ≤64 bytes，缺省空串；非法类型/超限排除，不截断造成碰撞。seen 存 `(fingerprint, progressKey)`，P0→P1 可给同一大任务新检查机会。
- progressKey、completed/status 都能由模型写，**不是授权或真实进度认证**；变更仍受每真人窗口最多两次约束。历史任务无 key 按原指纹可用，不强迁移。
- 不含 updatedAt、activeForm、无关 metadata、工具读取次数、nudge 计数；TaskList/Get/无意义 Update/仅 activeForm 变化不续额。回调必须重读组合。
- 同 session 全树记忆 seen 组合；人类新窗口不清空 seen。同组合不能通过改回原值、TaskList/Get、无意义 Update、reload/tree rollback 再醒。
- 新增 `subagent:todo-idle-recovery` 私有 custom entry（非消息），含 v/sid/inputId/epoch/attemptId/count/seen/stop；状态从 getEntries 全树折叠 high-water，不按活动 branch 倒退。
- 宿主可信 HumanEpochPort 只读 `{sid, owner, epoch, inputId, provenance}`；producer 去重、单调推进；无可信 epoch = 零额度。新窗口最多 2 次，时间经过不续额。
- 建议 seen 上限 256；满则当前 session fail-closed，不淘汰以恢复资格；不暴露机械参数设置。来源 dedup 同样有界满闭。
- 同 sid reload 继承额度/指纹/停止锁但重新绑定 owner；不得重发旧 attempt。new/fork/switch 不继承运行权，必须等该会话新的可信输入；fork 拷贝的旧 sid 条目不授权。
- 无 getEntries/会话持久能力、存储异常、格式未知：不 send；若窗口恢复不确定，预算按耗尽而非归零处理。无文件或尚无 conversation 时不激活；不新增旁路明文文件。
- 当前 SDK 为同步 append 而非 fsync，保证范围为正常 reload/tree replay，不宣称断电事务；不读写用户文件作能力探针。secure 仍遵从 D8/域守卫，不能借恢复重启强制关闭功能。
- 阶段 A Task* 触碰清零、turn 计时、归档完全不动；恢复是另一套预算与消息。

## 5. 特性专用 runner / 可信输入 / 可见性

**新增端口均由 B1/B2 定义，B3 供值，不是 SDK API：**

- `HumanEpochPort.current(): {sid,owner,epoch,inputId,provenance}|undefined` 只读；B2 host 内 producer 去重/单调推进。accepted 或 strong-consumed 策略须等 Q2。
- `RecoveryHostSnapshot` 含 owner/sid/epoch、stopped、candidatePairs、busy/goal 的 clear|busy|unknown；`readHostSnapshot()` 同步，B3 注入上述实际口，B2 组合判定。
- `RecoveryRunnerDeps`：currentOwner/readHostSnapshot/persistAttempt、SDK sendMessage/abort、now/Clock、只读触发形状能力；`start(attempt)`、beforeAgentStart(event)、context(event)、settled(event)、onTrustedHandover(proof)、dispose(reason) 由 B2 runner 实现。
- B2 `isRecoveryTrustedInput(event,ctx,owner)`：真实 `ctx.mode==='tui' && source==='interactive'` 且 owner/sid 当前，或真实 Web admission proof；mode 来自 SDK getter，绝不接工具参数。unknown RPC/extension/机器/定时/回放均 false。
- Web observer 只从 commands 现 beginOrReply 后合法原生/held dispatch seam 生成 cmdId/sid/owner proof，并 dedup；不靠文本匹配、role:user 或泛 RPC。此观察通知不授予新执行权限。
- **handover 与预算分离**：可信输入动作立即释放本 token 自动 abort 权；若 Q2=strong，预算只在实际 consume 后 reset。accepted 模式在 admission 开窗；strong 模式未 consume 不重新激活已抑制的旧窗口。human ask_user 答案本期建议不计窗口，仍是保守选择非既定需求。

**runner 的具体状态与监督契约（只管这一类检查回合，不排任务、不承接 XS）：**

1. `idle → claimed/unknown → bound → settled`；另有 handed、aborting、stuck、disposed/tombstone。随机 ownerToken 绑定 activation+sid+attemptId，绝不靠 isIdle=false 猜属于自己。
2. start 最终同步守卫→持久 attempt→claim（单飞）→arm deadline→再次守卫→`sendMessage(custom, {triggerTurn:true})`；守卫失败仍不退款已写 attempt，未发送 token 作废。claim/arm 在 send 前。
3. 固定内部 `deadlineMs=900000`（15min），从发起起算，不自动延长、不读 fabric 设置、不限制后台子 Agent 总寿命；deadlineAt 随 attempt 持久化，不因 BAS/重建重算。
4. `before_agent_start` 用现 readBeforeAgentStartTrigger 识别本 customType+token+attemptId+sid；仅当前 claim、未过期/未Stop/未失效、最终忙门clear（排除自身）才绑定当前 run serial。非法/迟到本 marker 在当前起跑点 `ctx.abort()`，不等其 Promise。
5. `context` 校验已绑定 token/当前run serial/owner/deadline；首个主请求要求 BAS 已确认，并核验该回合起始 marker（不能只假设历史末条就是本次触发）。解析形状未知不激活；context 不删改消息。历史完成 marker 不导致后继用户回合误 abort。
6. 既有 BAS 在 pre-start compaction 后，不能宣称它拦住第一条 compaction 请求；send 前复核+发起时deadline覆盖此窗口。是否接受该既有 SDK 边界由 Root 技术闭合，不能假造 pre-compaction token API。
7. send void/throw/未见 BAS 一律 unknown，预算已消费且保持单飞；无 retry/refund。deadline 到期未绑定只 tombstone/禁止新恢复，不盲 abort可能属于用户的run；迟到本marker由BAS/context拒绝。
8. 已绑定且仍拥有执行权：deadline 同步再验 token/owner/run serial，abort 一次并进入 aborting；用同 Clock 一只10s宽限计时，未 settled→stuck并停用自动恢复，不循环重试/轮询。
9. `settled` 无 token：只结束由 BAS 建立且未被外来 BAS 替换的本地 run serial；aborted=true 同时抑制当前窗口。外来 BAS 立即撤销旧 token 的自动 abort 权，预算不 reset，不把机器当 human。
10. 可信输入发生于 bound：持久 handed，取消该 token deadline/abort权，后续用户/机器继承的run不得被旧deadline杀掉。发生于 unknown未绑定：撤销旧claim而不把迟到自动marker当用户回合；迟到marker仍拒绝。
11. dispose：同步失效owner/持久tombstone/取消immediate和所有计时；仅仍可证明当前run属于未handed本token才单次abort，不等终结。正常reload回放预算/seen；旧attempt永不重发。new/fork/switch不继承运行权。
12. Clock 必须走 clampSpanMs/createSegmentedClock（现 systemClock），全部unref/可取消；无 isIdle polling。缺关键 abort/触发确认/时钟能力拒绝激活。

已知能力缺口不得隐藏：SDK 没有公开「撤销已 deferred 的 custom trigger」口；off 要零新hooks，不能为旧token偷偷常驻guard。B2 必须证明支持的装配发送走即时 `_startRun` 且 teardown 不留下可执行 deferred，不能证明则关闭该组合并报告 Root，不改 SDK、不新增全局平台。
消息为 `subagent:todo-idle-recovery-check`、display:true/triggerTurn:true，TUI/Web用现custom渲染；标「自动检查/原授权范围/N/2」，不是human，不重置预算。
off 不注册新hooks、不生成条目/消息/计时器；A路径字节、计数、归档不动。先前运行的清理必须在旧实例dispose完成，不能靠off分支补新执行权。

## 6. 三包 DAG / 精确 writer（未来实施；本轮仅两文档）

| 包                 | 依赖                  | 唯一 writer paths / 交付                                                                                                                                                                                                                                          |
| ------------------ | --------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| B1 纯内核          | review + 两项用户确认 | `src/todo/idle-recovery.ts`, `src/todo/idle-recovery-store.ts`, `tests/todo/idle-recovery.test.ts`, `tests/todo/idle-recovery-store.test.ts`；候选、组合指纹、预算/Stop重放、纯端口类型                                                                           |
| B2 特性适配/runner | B1                    | `src/todo/idle-recovery-host.ts`, **`src/todo/idle-recovery-runner.ts`**, `tests/todo/idle-recovery-host.test.ts`, **`tests/todo/idle-recovery-runner.test.ts`**, `tests/conformance/todo-idle-recovery.test.ts`；§3/§5全部状态与真实SDK能力证明，runner唯一owner |
| B3 Root 集成       | B1+B2                 | `src/index.ts`, `src/stack.ts`, `src/stack-teardown.ts`, `src/todo/settings.ts`, `src/todo/setting-specs.ts`, `docs/dev/todo-web/README.md`, `tests/integration/todo-idle-recovery.test.ts`, `tests/tiers.ts`；集中接线/设置/三路径teardown/忙态验收              |

B3 **本轮 Root 裁定的窄解冻 writer**：`src/web-hub/agent/commands.ts`, `src/web-hub/agent/index.ts`（只读recoveryBusy+真实admission/abort观察通知及依赖透传）；`src/schedule/agent/dispatch.ts`, `src/schedule/agent/message.ts`（只读recoveryBusy及透传）。这些源只归B3，不让B2顺手写，不改原准入/投递策略。
B3在index把goalHook与schedule installer只读口送入B2 host；stack注入query/bash/workflow/notifier/schedule/xs/rootWake现口；Web index把命令observer接到B2 host。所有新增观察者仅功能on时注入，缺口返回unknown，不默认clear。
`src/memory/**`、`src/fabric/**`及未列出的源继续冻结；不改RootWakeController/goal/delivery源，不再等未知外部owner补runner，不暗加B0/第四包。额外writer需求必须报Root，不能静默扩大解冻。
index/stack只装配，不堆恢复逻辑。A golden绝不重生；若激活trace需变更，`tests/fixtures/governance/activate-trace.json` 仅Root集中申报刷新。实现细节届时写todo README。

## 7. 验收表 / 退出门

| 测试          | 必须断言的行为                                                                                                                                                                          |
| ------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 候选          | 空/全 pending/等待/审批/缺依赖/定时无 wake；合法 in_progress 一次；metadata 不能批准 #22/#50/#36                                                                                        |
| 指纹/预算     | 同组合跨 epoch 仍最多一次；P0→P1可再检查但不超过窗口2次；模型伪写progressKey不能扩权；窗口第 3 次拒绝；TaskList/Get/无意义 Update/role:user/machine/schedule 不续额；新可信输入才开窗口 |
| 来源          | 真实 SDK TUI→interactive、扩展→extension；泛 RPC 不续额；Web cmdId 去重与 owner/sid；accepted 与 consumed 差异按用户选择断言                                                            |
| 忙与 goal     | queued Agent、workflow 间隙、bash、各待投递/hold、到期 schedule 阻止；仅未来 schedule 不阻止；goal active/evaluating/paused/unknown 阻止                                                |
| 竞争          | settled 后其他 handler 发送、用户输入、Stop、owner/sid 变化、持久化重入均取消；同批双 settled 不双醒                                                                                    |
| SDK Stop      | real aborted=true 抑制；idle Web abort 入站锁；缺失观测 fail-closed；不从 errorMessage 正则猜中断                                                                                       |
| 持久/失败     | append 失败零 send；send unknown/throw 不退款；reload/树回滚不洗额度；fork/new/switch 不继承运行权；容量满闭                                                                            |
| 监督/生命周期 | 固定 deadline、迟到启动、用户接手不误杀；dispose 三路径取消 timer、旧 owner 永不复活；无 ref timer/轮询                                                                                 |
| 可见/off      | TUI 与 Web 真实 custom 投影各一条；非 human；off 字节一致；A 计数、归档、triggerTurn:false 原断言不变                                                                                   |

实现阶段才运行针对测试 → typecheck/build → tier1，涉及 conformance/integration 补相应 tier2；不安装新依赖、不创建真实 scheduled task、不做用户数据/挂载/在线 API 探针。
本轮文档静态检查及现有 todo 纯测试65条通过，不冒充尚未实现的runner验证。B1 交付的是纯候选/指纹/预算-Stop 内核与 store 效果接口（不 send/abort/timer），定向测试为本包自验；B2/B3 的开发仍需上述 SDK 能力边界用真实 conformance 通过，且可信 arrival producer / B2 / B3 接线与验证完成前生产不激活。
