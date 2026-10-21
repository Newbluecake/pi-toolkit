# fabric 第二期：C1 跨会话唤醒，实施方案（phase2 r2）

状态：**r2**（按评审 r1 打回意见 `phase2-review-r1.md` #1–#15 逐条修订；§13 拍板结果保持原样，r2 新增待拍板项见 §14）。作者：planning 子代理，2026-10-21。
基线：`dev` @ `37189c27`（第一期 S0…G 已全部合入；r1.1 = `240aacd4`，评审 r1 = `37189c27`）。pi peer 实测版本 **1.3.0**（`node_modules` 与全局安装一致），本文所有 pi 行为结论均直接读 1.3.0 `dist/core/{agent-session,agent-session-runtime}.js`、`extensions/{loader,runner}.js` 核实（§1.2）。
输入：`plan.md`（v3，§12 是 C1 的 v2 存档）、`W2..W6-report.md`、`G-report.md`、`phase2-review-r1.md`、AGENTS.md 的 fabric / runtime / tools / service / web-hub 段落。
锚点约定：**以符号名为准**，`~L` 行号只是截至 `37189c27` 的提示。本文档不修改 `plan.md`。

> 一句话：第一期把树内消息做成可唤醒、可 park、至多一次。第二期**只做独立启动的 pi 主会话之间**（终端 pi、web-hub 托管的 rpc 会话）的 root ↔ root 通信：同一台机器、同一个 web hub、同一个 uid 下，一个已显式加入的主会话可以发现、给另一个已显式加入的主会话发消息，并按需唤醒它。被唤醒的主会话 run **从派发那一刻起就归 RootWakeController 所有**（启动慢、压缩久、人类插话都不丢所有权），会话变更期间一律拒收（栅栏只会因真实完成事件打开，超时只告警、继续拒收），中继由 hub 负责，发送方身份由 hub 按「socket + 会话 + 成员代际」三重绑定盖章。**默认一切关闭，会话不显式加入就不可发现、不可达。** 子 agent 参与跨会话全部推迟到第三期（§12.3）。

---

## r2 修订记录

| 评审 # | 严重度  | 处理                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        | 章节               |
| ------ | ------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------ |
| #1     | Blocker | 能力判定改为**进程级四态机**（`unknown → observed → verified`，旁支 `absent`），可观察来源是**任何** `before_agent_start` 事件是否带 `messageType`（人类第一次输入即可判定，不需要先起一次 custom run）。`unknown`/`absent` ⇒ 跨会话 `wake:true` 一律只投递（失败关闭，不「先启动一次看看」）。监管本身不再依赖绑定事件（见 #2），绑定只用于「迟到识别」。补首次启动 / 旧 peer / 形状缺失三个用例                                                                                                                                           | §6.2、§6.7、§11 R1 |
| #2     | Blocker | 重画启动生命周期：**派发即拥有**——`pi.sendMessage(…,{triggerTurn:true})` 同步返回后 `ctx.isIdle()===false` 即证明 run 已由本次调用启动（pi 1.3 `_startRun` 在首个 await 前置 `_isAgentRunActive`）。执行看门狗从**派发**起算（覆盖预启动压缩），10s 只是 `wake_slow_start` 告警，不放弃所有权。启动中/运行中人类插话 ⇒ `handedOver`（永不 abort，但继续占位直到 run 结束）。延迟启动（settle 期间派发）⇒ `deferred` 所有权 + token 迟到识别，过期则在 `before_agent_start` 里 abort（首个请求前）。进程级 token 账本跨 `/reload` 认领或识别 | §6.2–§6.5          |
| #3     | Major   | 栅栏窗口**只因完成事件关闭**（成功、失败、取消都有对应事件的走事件；没有事件的取消路径靠「后续证据」关闭：之后的人类输入、run 启动、`session_start`）。30s 只告警并进入 `stuck`（**继续拒收**）+ `/fabric status` 可见 + 本地 `/fabric fence reset`。跨会话投递**彻底不用 steer / triggerTurn:true**（Controller 除外），区分「活动 run」与「非 idle」的需求随之消失                                                                                                                                                                        | §7、§6.3           |
| #4     | Major   | 新增 cap 门控的 `xs_member` slot 帧（`{sessionId, epoch, joined, receive, limits}`），hub 只在 `!detached ∧ session.sessionId === member.sessionId` 时承认成员资格，`session` 换 id / `session_detached` 立即作废；每个 `xs_req` 携带 `origin{sessionId, epoch}`，hub 比对后才盖章；发送端每个 await 之后重验 origin。`StatusInfo.xs` 降为纯展示                                                                                                                                                                                            | §8.1、§8.2、§4.4   |
| #5     | Major   | 定义接受证据表：只投递 = 同步块内 `getLeafEntry()` 就是本条（带 `xid`）⇒ `applied`；唤醒 = 同步启动证据 ⇒ `applied`；接收方忙（流式中，pi 只放内存队列）⇒ `unknown{queued}`；延迟启动 ⇒ `unknown{start_deferred}`；同步抛错 ⇒ `none`。观察全部在同一个同步块里，不等待、不重发                                                                                                                                                                                                                                                              | §6.3、§8.3         |
| #6     | Major   | 新增 §4.6 设置归属表：全局（HubConfig，hub 启动时冻结，`xs_req{op:"info"}` 可查有效值与本地差异）/ 发送方会话（经 `xs_member.limits` 下发，hub 按 schema 上下界夹紧）/ 接收方会话（只在接收端执行）/ 每请求（`scope`、`wake`）。限额「预占→结算」与 `unknown` 不退还规则成文。客户端总截止独立：list/resolve 3s、send 8s（> hub 5s 投递 + 余量）；列出 `connection.request()` 的签名改动                                                                                                                                                    | §4.6、§5.2、§8.2   |
| #7     | Major   | 删除「与树内共享 `rootInboxCap`」。新增独立的 `crossSession.limits.inboxCap`（默认 12，与原值一致），释放规则 = 消息已进入某个 run 的上下文且该 run 结束；树内 `FabricRouter.rootInbox()` 计数完全不动，补交叉测试                                                                                                                                                                                                                                                                                                                          | §5.2、§8.4         |
| #8     | Major   | 新增 §4.5 开关真值表：xs 收发只需 `xsOn`；Controller 需要 `wake.enabled ∧ rootRunMaxS>0 ∧ 能力 observed/verified ∧ receive=wake`，任一不满足 ⇒ **只投递**，跨会话永不走无监管 legacy。修正 r1.1「`rootRunMaxS:0` = 树内退回 legacy」的错误注释（P7：树内本来就不接 Controller）                                                                                                                                                                                                                                                             | §4.5、§4.1         |
| #9     | Major   | 硬门禁放到执行点：`/fabric` handler 对 `isWebInvocation(ctx)` 拒绝所有成员/策略变更（join/leave/receive/block/unblock/fence reset），只放行 `status`/`blocks`；web prompt op 再加一道 `/fabric` 变更文本拒绝（照抄 `/webhub 2fa\|passwd\|user` 先例）；策略表只是第一层                                                                                                                                                                                                                                                                     | §5.3、§10.3        |
| #10    | Major   | 回复关联契约进 XS0：`hub/registry.ts` 的 `onFrame` 加 `case "xs_ack"` 按 rid 结算，`connection.ts` 加 `case "xs_res"`/`"xs_deliver"`；registry、命令策略、prompt 门禁、AgentCard、格式 helper 全部指定所有者；`src/stack.ts`/`src/index.ts` 装配拆成**单独串行集成包 XW**，核心包只交付纯模块 + fake 测试；真实 socket ack 往返测试                                                                                                                                                                                                         | §11                |
| #11    | Minor   | 证明主线改为「协议无任何重发路径」；去重集合降为纵深防御，放进进程级 `Symbol.for` 表（跨 `/reload` 保留），条目活到 `expiresAt+1s`，满容量**拒收**而不是淘汰有效条目                                                                                                                                                                                                                                                                                                                                                                        | §9                 |
| #12    | Minor   | **本期不把 `list_sessions`/`message_session` 加入 `RESERVED_TOOL_NAMES`**（子会话本期根本拿不到它们，保留名只在第三期注入时才有意义）⇒ XI1 无例外成立；主会话同名冲突由 activate 时检测 + 状态提示处理                                                                                                                                                                                                                                                                                                                                      | §4.3、§10.1、§12.3 |
| #13    | Minor   | 完整传播表：只有 Controller 真正起了 run 才 `+1`；只投递、各类降级、忙时入队一律 carry 发送方 level；拒收不改；wake 关闭时不跟踪。补树内/跨会话混合因果链测试                                                                                                                                                                                                                                                                                                                                                                               | §6.6               |
| #14    | Minor   | `allowFrom` 只接受**完整 sessionId**，非法条目丢弃并告警，全部非法 ⇒ deny-all（照抄 `allowClients` 规则）；`/fabric block` 在操作时把 ref/name 唯一解析为完整 sessionId 并存名字快照，`/fabric blocks` 离线列出、`/fabric unblock` 按序号/完整 id/存储名字离线解除；前缀解析最短 8 位                                                                                                                                                                                                                                                       | §5.3               |
| #15    | Minor   | `agent-server.ts` 坏 JSON 分支改为只记 `{agentKey, bytes}`（无条件，所有帧类型受益）；xs 路由所有拒绝/异常分支只记错误码与长度；测试覆盖非法 JSON、被拒帧、handler 异常三条真实日志路径                                                                                                                                                                                                                                                                                                                                                     | §8.5、§10.4        |

r1.1 → r2 的其他修订：①按拍板 P6，`discoverScope` 设置键删除，改为 `list_sessions` 的可选参数 `scope:"hub"|"cwd"`（默认 hub），且只过滤列表、不限制 send；②按拍板 P1，删去 agent「只退出」工具的备选；③基线 pi 版本从 1.2 更正为 1.3.0（peer 区间 `>=1.0.0 <1.4.0` 不变）；④跨会话忙时投递不再 steer（见 #3/#5），`wake:true` 遇忙降级为只投递（`wakeDowngraded:"busy"`）；⑤规模重估为约 13.5 人日（§11.2）。

---

## 0. 目录

1. 复核方法（含 pi 1.3 行为核实）
2. 存档 vs 现状差异表
3. 总体架构与数据流
4. 设置、工具面、开关真值表、设置归属
5. 发现、限制与加入控制
6. R1：RootWakeController（所有权生命周期、能力判定、接受证据、level 传播）
7. T1：会话变更栅栏
8. X1–X5：跨会话投递（身份绑定、帧契约、请求 API、hub 中继、旧版本、managed rpc、hub 重启、provider payload、日志）
9. NQ3：去重
10. 安全与不变量
11. 拆包、依赖、测试锚点、规模、车道
12. 风险、明确不做、第三期扩展点
13. 拍板项（r1.1 原表，已拍板）
14. r2 新增待拍板项

文末：§13 拍板结果（原样保留）

---

## 1. 复核方法

### 1.1 仓库代码（以代码为准，不采信文档）

- fabric：`src/core/message.ts`（`NodeRef`/`MessageKey`/`CanMessage`/`authorize`）、`src/fabric/router.ts`（`admit`/`rootInbox`/`tryPark`）、`src/fabric/mailbox.ts`、`src/fabric/wake.ts`（`WakeService`、`formatWakeResult`/`formatInbox`）、`src/fabric/wake-level.ts`（`createCausalLevel`、`onDelivered` 的 carry/hop 区分）、`src/fabric/wake-input.ts`（人类输入判定，`level()===undefined` 时惰性）。
- 装配：`src/stack.ts` `buildFabric()`、`src/index.ts`（`input` 钩子注册顺序 ~L860、`session_start`）、`src/service/runtime-adapter.ts`（`message_agent` 只注入子会话）、`src/runtime/tool-scope.ts` `RESERVED_TOOL_NAMES`（无条件 deny-by-default）。
- 设置：`src/config/settings.ts` `FabricSettings`/`FabricWakeSettings`/`parseFabricWakeSettings`。
- 会话变更：`src/web-hub/agent/compaction-state.ts`（D13/D26）、`resume-exec.ts`（exec claim / `switchInFlight`）、`src/topic-switch/wire.ts`（B1）、`src/goal/hook.ts`。
- web hub：`protocol/messages.ts`（`StatusInfoSchema` 开放、`decodeAgentFrame` 未知帧返回 `undefined`）、`protocol/version.ts`；`hub/agent-server.ts`（`fsb_req`/`tfa_req`/`lan_req`/`hub_ctl` 先于 registry 分派；`NdjsonDecoder.onError` 的 bad-json 分支记 `sample.slice(0,80)`）；`hub/registry.ts`（`onFrame`：`session` 帧覆盖 `r.session` 但**保留** `r.status`，`session_detached` 只置 `r.detached=true`；`request()` 只在 `onFrame` 显式 `case` 中按 rid 结算 pending）；`agent/connection.ts`（`attach`/`detach`/`setSlot`、`SLOT_ORDER = session,status,fleet,prompts,dialogs,ctl,commands`、`slotCap()`；`request()` 截止固定 `ADMIN_REQUEST_TIMEOUT_MS=3_000`，`fsb_req` 特例 12s）；`agent/command-policy.ts` `resolveCommandPolicy()`（用户 override **先于**内置表）；`agent/command-capture.ts` `isWebInvocation(ctx)`；`agent/commands.ts` prompt op 对 `/webhub 2fa|passwd|user` 的文本拒绝先例（~L261）。
- UI：`src/web-hub/ui/src/components/agents/{AgentCard.vue,agentCardModel.ts}`。
- 测试面：`tests/conformance/`（`fabric-wake.test.ts` C-P1…C-P5、`consult-preserve.test.ts` C1–C7、`wake-run-sysprompt.test.ts`）、`tests/fixtures/fabric-wake-off-golden.json`、`tests/web-hub/hub/caps-coexist*`。

### 1.2 pi 1.3.0 行为核实（直接读安装的 dist，结论都会被 conformance 锁定）

| #     | 事实（pi 1.3.0）                                                                                                                                                                                                                                                                                                                      | 对方案的影响                                                                            |
| ----- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------- |
| Fpi1  | 扩展 API `pi.sendMessage` = `assertActive()`（失效 runtime 同步抛错）→ `runtime.sendMessage` → `this.sendCustomMessage(...).catch(emitError)`：**void 包装**，异步错误不回抛                                                                                                                                                          | 「同步返回不抛错」不是接受证据（#5）；同步抛错则证明未生效（`none`）                    |
| Fpi2  | `sendCustomMessage` 是 async，但各分支在首个 await 之前同步执行：`triggerTurn:true` 且非流式 ⇒ `await this._startRun(...)`，而 `_startRun` 第一句就是 `this._isAgentRunActive = true`（`_prepareRun` 里的首个 await 在其后）                                                                                                          | **派发同步返回后 `ctx.isIdle()===false` 即证明 run 已由本次调用启动**（#2 所有权证据）  |
| Fpi3  | `_prepareRun` 先 `await this._checkCompaction(lastAssistant)`（预启动压缩，时长无上界），然后才 `emitBeforeAgentStart(trigger)`；事件对象 `{...trigger, type}`，custom 触发时 `trigger = {messageType:"custom", message: appMessage}`（含 `details`）                                                                                 | 绑定事件可能远晚于 10s（#2）；custom 事件确实带 `message.details`（A7）                 |
| Fpi4  | `_prepareRun` 抛错 ⇒ `_startRun` 的 catch 置回 `_isAgentRunActive=false` 并 rethrow，**不发 `agent_settled`**；正常/中止路径 `finally` 里 `await _emitAgentSettled()`                                                                                                                                                                 | Controller 需要「idle 观察」兜底结束条件（§6.2）                                        |
| Fpi5  | `_isEmittingAgentSettled` 期间 `triggerTurn:true` 的消息被推入 `_deferredSettledActions`，在 settle 发射结束后**依次 await** 执行（可排在别的扩展的 run 之后）；此时 `isIdle` 为 true                                                                                                                                                 | 存在「派发后仍 idle、run 晚些才启动」的延迟路径 ⇒ `deferred` 所有权 + 迟到识别（§6.2）  |
| Fpi6  | `abort()`：run 活动时置 `_agentRunAbortRequested`，并 `abortCompaction()`/`abortBranchSummary()`；`agent_start` 时若已请求中止则 `agent.abort()`，「agent_start 在首个请求前被 await」                                                                                                                                                | 启动阶段（含预启动压缩中）abort 有效，且不发 provider 请求（§6.2，C-X1b 锁定）          |
| Fpi7  | `triggerTurn:false`：非流式 ⇒ `_appendCustomMessage` **同步**写会话树（`appendCustomMessageEntry`，leaf 前移）；流式 ⇒ 推入 `_pendingCustomMessages`（**只在内存**，turn_end 扩展处理器之后 flush）；`pendingMessageCount` 只数 steering/followUp，不含它                                                                             | 只投递在 idle 时可同步取证（leaf entry）；流式时不可取证 ⇒ `unknown{queued}`（#5）      |
| Fpi8  | `isIdle = !_isAgentRunActive && !isCompacting`，`isCompacting` 含自动/手动压缩与分支摘要的 controller；扩展 ctx 不暴露 `isStreaming`                                                                                                                                                                                                  | 「非 idle」≠「有活动 run」（#3）⇒ 跨会话不再依赖 steer 进活动 run                       |
| Fpi9  | 压缩：`session_before_compact` 被扩展取消 ⇒ 抛错 ⇒ `session_compact_failed{aborted:true}`；成功 ⇒ `session_compact`（在清 controller 之前，D26）。分支摘要：`session_before_tree` 被取消 ⇒ **直接 return，无完成事件**；`session_tree` 在 `finally` 清 controller 之前发出。切换：`session_before_switch` 被取消 ⇒ 无 `session_start` | 栅栏不能只靠完成事件，也不能靠超时打开 ⇒ 「后续证据」关窗（§7）                         |
| Fpi10 | 切换（`/new`、`/resume`、fork）：`teardownCurrent` 先 `await session.abort()` 再 `session_shutdown`、dispose；`/reload`：`session_shutdown{reload}` → 重建 → `session_start{reload}`，**不 abort 当前 run**，但交互模式 `handleReloadCommand` 在流式或压缩中拒绝执行                                                                  | 切换会杀掉旧 run；`/reload` 不杀但通常不会在 run 中发生 ⇒ 进程级 token 账本兜底（§6.5） |
| Fpi11 | `before_agent_start` 的 `messageType` 字段：1.2+ 对 user 与 custom 触发都有；1.0/1.1 只对 prompt 触发，且无 `messageType`（`pi-compat.ts` 注释与 `readBeforeAgentStartTrigger` 已据此实现）                                                                                                                                           | 能力判定的可观察来源（#1，§6.7）                                                        |

---

## 2. 存档 vs 现状差异表

图例：**推翻** = 存档假设与现状冲突，必须改设计；**满足** = 第一期已自然提供；**缺口** = 要新建；**待定** = 需拍板（已在 §13 拍板）。r2 改动的行标 ✱。

### 2.1 接口与类型

| #    | 存档（§12）假设                                      | 现状（代码）                                                                                                                              | 结论                                                                                                                                                                              |
| ---- | ---------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| A1   | 主会话也有发送工具                                   | 主会话没有 `message_agent`（只由 `runtime-adapter.ts` 注入子会话）                                                                        | **缺口**：主会话注册新工具 `message_session`/`list_sessions`（P4 已拍板）                                                                                                         |
| A2   | 跨会话复用 `NodeRef`/`MessageKey`/`FabricRecord`     | `NodeRef = RunId \| "root" \| "system"`；`router.admit()` 要求发送方在树里 running；`authorize()` 对 unrelated 拒绝                       | **推翻**：跨会话不经过 `FabricRouter`/`FabricMailbox`/outbox，新建 `src/fabric/xs/`                                                                                               |
| A3   | `CanMessage` 加 `"session"`                          | 联合里没有；frontmatter 未知值静默丢弃                                                                                                    | **推迟到第三期**                                                                                                                                                                  |
| A4   | `Verdict.effect` 区分 none / unknown                 | 第一期 W4 已实现                                                                                                                          | **满足**：沿用 `applied`/`none`/`unknown`，r2 给出每个取值的证据定义（§6.3、§8.3）✱                                                                                               |
| A5 ✱ | L5 与每小时唤醒预算                                  | `CausalLevel.onDelivered`：只有「起 turn」的投递 `+1`，其余 carry                                                                         | **满足 + 补表**：跨会话照第一期口径，只有 Controller 真正起 run 才 `+1`（§6.6）                                                                                                   |
| A6   | JSON 元数据 + nonce 边界                             | `formatWakeResult`/`formatInbox` 已实现                                                                                                   | **满足**：抽出 `src/fabric/format-fence.ts`（XS0，纯搬移，第一期输出逐字节不变）                                                                                                  |
| A7 ✱ | `before_agent_start{custom, details.wakeToken}` 绑定 | `readBeforeAgentStartTrigger` 只返回 `{kind:"custom"}`；pi 1.3 custom 事件带 `message.details`（Fpi3）；1.0/1.1 无 `messageType`（Fpi11） | **缺口 + 兼容性**：探针扩展为 `{kind:"custom"; customType?; details?}`，另加 `readTriggerShape(event)` 供能力判定；**监管不再以绑定为前提**，绑定只做迟到识别与确认（§6.2、§6.7） |

### 2.2 状态机与 reducer 输入

| #   | 存档                                   | 现状                                      | 结论                                                                               |
| --- | -------------------------------------- | ----------------------------------------- | ---------------------------------------------------------------------------------- |
| B1  | 未提                                   | `state-machine.ts` 17 种输入，矩阵 204 格 | **不新增 reducer 输入**；Controller 自己的状态机单独做全转移表与性质测试（§11 R1） |
| B2  | 树内显式 `wake:true` 也改走 Controller | `sendRootContext` legacy                  | P7 已拍板：**树内不接**，逐字节不变                                                |

### 2.3 设置键

| #    | 存档                                        | 现状                                               | 结论                                                                                                                                                            |
| ---- | ------------------------------------------- | -------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| C1   | `fabric.wake.crossSession.*`、`rootRunMaxS` | 注释写明 phase 2 才解析；解析器忽略未知键          | **满足（可加性）**                                                                                                                                              |
| C2 ✱ | `crossSession` 挂在 `wake` 下               | `fabric.wake.enabled` 默认 true；只投递不需要 wake | 独立叶子 `fabric.crossSession.*`；`rootRunMaxS` 放 `fabric.wake.rootRunMaxS`，**只**约束跨会话 Controller（P7 后树内不经过 Controller）；组合语义见 §4.5 真值表 |
| C3   | 接收方默认 `wake`                           | —                                                  | P2 已拍板：wake                                                                                                                                                 |
| C4   | fabric 默认值                               | `maxPerRun` 实为 progress 配额                     | 记录在 §5.2，不改语义                                                                                                                                           |
| C5 ✱ | —                                           | —                                                  | **新**：设置归属与传输契约（全局 / 发送方会话 / 接收方会话 / 每请求），§4.6                                                                                     |

### 2.4 持久化与 session entry

| #    | 存档                      | 现状 | 结论                                                                                                                                                |
| ---- | ------------------------- | ---- | --------------------------------------------------------------------------------------------------------------------------------------------------- |
| D1   | 发送端 pending 授权持久化 | —    | **本期不需要**（回复 = 对消息头 `from.ref` 普通发送）；第三期                                                                                       |
| D2   | 未提成员资格持久化        | —    | **缺口**：`subagent:xs-membership` entry（加入、receive 覆盖、屏蔽列表，带 sessionId 校验，fork 不继承），`session_start` 时只读 `getBranch()` 读回 |
| D3 ✱ | 去重 LRU（stack 内存）    | 没有 | 改为**进程级** `Symbol.for("pi-subagent:xs-dedup")`，跨 `/reload` 保留，满容量拒收（§9）                                                            |
| D4 ✱ | —                         | —    | **新**：进程级唤醒 token 账本 `Symbol.for("pi-subagent:xs-wake-ledger")`（cap 8），供 `/reload` 后的新 stack 认领或识别旧 token（§6.5）             |

### 2.5 hub 协议与能力位

| #    | 存档（§12.3）                        | 现状                                                                                                            | 结论                                                                                                                                                                                   |
| ---- | ------------------------------------ | --------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| E1 ✱ | 三个 cap                             | hello caps 静态；hub 两面 caps 必须逐字节一致                                                                   | 两个静态 cap：hub `xs.v1`（仅当 `HubConfig.crossSession` 存在）、agent `xs.v1`（`xsOn`）。动态成员资格改走 **`xs_member` slot 帧**（权威）；`StatusInfo.xs` 只做展示                   |
| E2 ✱ | 新帧 `xs_resolve`/`xs_send`          | agent→hub 请求帧先例；hub→agent 请求经 `registry.request`，**pending 只在 `onFrame` 的显式 case 中结算**        | 帧集合与 reply 关联契约在 XS0 冻结（§8.2）：`xs_req`/`xs_res`、`xs_deliver`/`xs_ack`、`xs_member`；`registry.ts` 加 `case "xs_ack"`，`connection.ts` 加 `case "xs_res"`/`"xs_deliver"` |
| E3   | 未提 PROTO                           | `PROTO={1,2}`，只比 major                                                                                       | P9 已拍板：只加 cap，不升 PROTO；**每条发送路径都必须 cap 门控**                                                                                                                       |
| E4   | `HubConfig.crossSession`，non-live   | 「功能关闭 = 键缺失」模式                                                                                       | **满足（照抄）**                                                                                                                                                                       |
| E5 ✱ | hub 盖章发送方身份                   | `Rec` 有 `agentKey`/`agentId`/`session`/`detached`/`status`；同一连接跨 `/new` 复用，`session` 与 `status` 分帧 | **socket 身份不够**：盖章前要求 `origin{sessionId,epoch}` 与该连接当前 `session` + 有效 `xs_member` 三者一致（§8.1）                                                                   |
| E6   | send 按 `agentId+sessionId` 精确匹配 | hub 重启 agentKey 重分配；restore 新 agentId 同 sessionId                                                       | 投递地址 = `sessionId`，send 时 hub 再校验「恰好一个有效成员」；`xs_deliver` 带目标的 `epoch`，接收端再比对                                                                            |
| E7   | 认证授权                             | agent socket 在 per-uid 状态目录                                                                                | **满足**：xs 帧只在 agent socket 上，无 HTTP 路由                                                                                                                                      |
| E8 ✱ | —                                    | `connection.request()` 截止固定 3s（`fsb_req` 12s）                                                             | **改 API**：按帧/op 的截止表（§8.2）                                                                                                                                                   |

### 2.6 栅栏

| #    | 存档                                         | 现状                                           | 结论                                                                                    |
| ---- | -------------------------------------------- | ---------------------------------------------- | --------------------------------------------------------------------------------------- |
| F1 ✱ | 压缩判定 = `!isIdle() && signal===undefined` | D13 明确否定；D26 延后一拍                     | **推翻**：事件窗口；r2 再改为「只因完成事件或后续证据关闭，超时只告警并继续拒收」（§7） |
| F2   | 无 `sessionGen`                              | 三个现有源分散在 web-hub / topic-switch / goal | **缺口**：`src/fabric/xs/fence.ts` + 迟绑定只读端口                                     |
| F3   | 生效前校验，有界拒绝或重试                   | NQ3 不自动重试                                 | 有界拒绝，不重试；goal 运行中只把 wake 降级                                             |

### 2.7 工具作用域与 consult-preserve

| #    | 存档                              | 现状                                         | 结论                                                                                                                                                                                                       |
| ---- | --------------------------------- | -------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| G1 ✱ | `list_sessions` reserved 名与影子 | `RESERVED_TOOL_NAMES` 无条件 deny-by-default | **r2 推翻 r1.1**：本期**不加** reserved 名（子会话拿不到这两个工具；无条件加名会剥离用户已有的同名 MCP/扩展工具、改变子会话前缀，与 XI1 冲突）。第三期注入子会话时再连同兼容说明、影子、C9 一起加（§12.3） |
| G2   | 与 consult 专家名共存             | 专家保留字只有 `"main"`                      | **无冲突**；`message_session` 拒绝 `root`/`system`/`main`/`r_…`/`@…`/`wf_…` 形式地址                                                                                                                       |

### 2.8 测试锚点

| #    | 存档                                  | 现状                                                                | 结论                                                                                                                                                                                                  |
| ---- | ------------------------------------- | ------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| H1   | consult-preserve C9                   | C1–C7（C8 跳过）                                                    | 本期只要求 C1–C7 不回归；C9 第三期                                                                                                                                                                    |
| H2   | hub 精确匹配 / 旧版本 / managed rpc … | 现成 harness：`web-hub-headless`、`rpc-spawn`、`web-hub-feishu-bot` | `tests/integration/fabric-xs-*.test.ts`（真实 hub 子进程 + 真实 socket）+ `tests/conformance/fabric-xs.test.ts` C-X1…C-X7                                                                             |
| H3 ✱ | 关闭状态 golden                       | `fabric-wake-off-golden.json`（不得改）                             | 新增 `fabric-xs-off-golden.json`（先采集）：xs 关闭时主会话工具表、`HubConfig`、hello caps、`StatusInfo`、slot 帧序列、`RESERVED_TOOL_NAMES` 逐字节不变；**开启时子会话工具表与 reserved 名单也不变** |

---

## 3. 总体架构与数据流

```
发送方会话 S（pi 进程 A）                         hub（per-uid 守护进程）                          接收方会话 R（pi 进程 B）
┌───────────────────────────┐ xs_member slot  ┌──────────────────────────────┐  xs_member slot ┌────────────────────────────────┐
│ /fabric join → membership │ ──────────────▶ │ members: agentKey→{sid,epoch, │ ◀────────────── │ membership（会话级，entry 持久） │
│ message_session 工具       │ xs_req{origin}  │  joined,receive,limits}       │                 │                                │
│ xs/sender: origin 守卫、    │ ──────────────▶ │ xs/router: origin 三重校验 →   │  xs_deliver     │ xs/receiver（同步块）：         │
│  每个 await 后重验           │                 │  精确匹配目标成员 → 限额预占 → │ ─────────────▶ │  expiry→dedup→成员/策略→目标    │
│                           │ ◀────────────── │  盖章 from/xid/expiresAt →     │                 │  sid+epoch→栅栏→inbox/速率→     │
│ 工具结果 effect/reason      │ xs_res{effect}  │  registry.request(5s)          │ ◀───────────── │  level/预算→dispatch→取证→ack   │
└───────────────────────────┘                 │  xs_ack 结算（registry onFrame）│   xs_ack        │ RootWakeController（拥有唤醒 run）│
                                              └──────────────────────────────┘                 └────────────────────────────────┘
```

- **模块边界**：`src/fabric/xs/` 是 pi-free 核心（`sender`、`receiver`、`fence`、`membership`、`inbox`、`dedup`、`format`），只依赖注入端口；`src/fabric/root-wake.ts` 是 pi-free 的 Controller 状态机；pi 侧装配**只在集成包 XW** 里改 `src/stack.ts`/`src/index.ts`；hub 侧 `src/web-hub/hub/xs/`；agent 侧连接 `src/web-hub/agent/xs.ts`。**不经过** `FabricRouter`/`FabricMailbox`/outbox。
- **为什么不复用 outbox**：跨会话不自动重试（NQ3）、不 park、接收方投递在一个同步块里完成，不需要 claim 协议与持久投递状态机。需要持久化的只有会话级成员资格与屏蔽列表。
- **at-most-once 的证明主线**：①发送端每条消息只发一次 `xs_req{send}`，工具不重试；②hub 每个 xid 只调用一次 `registry.request`，没有任何重放代码路径；③hub 重启丢失在途请求 ⇒ 发送方得到 `unknown`，不补发；④接收端在同一个同步块里完成校验与派发。去重集合（§9）只是纵深防御，不是证明依赖。

---

## 4. 设置、工具面、开关真值表、设置归属

### 4.1 设置（non-live：activate / stack 构建时读取，改动后 `/reload`；hub 侧另需 `/webhub restart`）

```jsonc
"fabric": {
  "enabled": false,                      // 既有总开关
  "wake": {
    // …第一期键不变…
    "rootRunMaxS": 900                   // NQ1；跨会话 Controller 的执行看门狗（从派发起算）；解析限定 60..3600；0 = 不启用 Controller ⇒ 跨会话 wake:true 一律只投递（§4.5）。树内不受此键影响（P7）
  },
  "crossSession": {
    "enabled": false,                    // Q2：默认关。只有 fabric.enabled ∧ webHub.enabled ∧ webHub.control!==false 时生效
    "autoJoin": false,                   // P1：默认会话不加入；true ⇒ 每个新主会话启动即加入
    "receive": "wake",                   // P2：已加入会话的默认接收策略 off | deliver | wake（会话级可用 /fabric receive 覆盖）
    "allowFrom": [],                     // 空 = 任何已加入会话；非空 = 只接收这些【完整 sessionId】（非法条目丢弃并告警；全部非法 ⇒ 拒收一切）
    "limits": { /* §5.2 表，全部可选，解析时按上下界夹紧 */ }
  }
}
```

- 解析：新增 `parseFabricCrossSessionSettings`（逐字段容错，从不抛错）；`rootRunMaxS` 进 `parseFabricWakeSettings`。旧配置文件的解析结果逐字节不变。r1.1 的 `discoverScope` 键按 P6 删除（改为 `list_sessions` 参数）。
- `xsOn = fabric.enabled ∧ crossSession.enabled ∧ webHub.enabled ∧ webHub.control !== false`，**activate 时冻结**（决定工具是否注册、hello caps、slot 是否发送）。

### 4.2 `CanMessage:"session"`（推迟到第三期）

本期不实现；wire 帧 `from` 预留可选 `run` 字段，本期 hub 遇到带 `run` 的帧一律拒绝（`E_XS_BAD_FRAME`）。

### 4.3 工具面（P4 已拍板：新工具，只在主会话注册）

| 工具              | 注册位置                                       | 参数                                                                                   | 返回                                                                                                                                                                |
| ----------------- | ---------------------------------------------- | -------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `list_sessions`   | 仅主会话：`src/index.ts` post-guard，仅 `xsOn` | `{ query?: string, scope?: "hub" \| "cwd" }`（P6：默认 `hub`，`cwd` = 同目录树过滤）   | ≤20 行：`{ ref, name?, cwd(~标签), kind, receive:"deliver"\|"wake", busy, lastActiveAgoS }`；`ref` = sessionId 前 12 位；不返回 agentKey、pid、工具、模型；不含自己 |
| `message_session` | 同上                                           | `{ to: string, text: string, wake?: boolean }`；`to` = `ref` / 完整 sessionId / 会话名 | `{ status, effect:"applied"\|"none"\|"unknown", reason?, to:{ref,name}, wakeDowngraded? }`                                                                          |

- 保留地址形式：拒绝 `root`/`system`/`main`/`r_…`/`@…`/`wf_…`（`E_XS_BAD_TARGET`）。kind 固定 finding 语义（P5）。省略 `wake` ⇒ `false`（Q1）。
- `from` 不由模型提供：hub 按 §8.1 的三重校验盖章。回复 = 对消息头 `from.ref` 普通 `message_session`。
- **同名冲突（#12）**：本期**不**动 `RESERVED_TOOL_NAMES`。主会话在 `session_start` 时检查是否已有别的来源注册了同名工具（`pi.getAllTools()` 结构化读取，读不到视为无冲突）；冲突 ⇒ `console.warn` 一次 + `/fabric status` 显示 `tool collision: <name>`。pi 对重名工具的实际裁决由 conformance C-X7 记录（只记录行为、不依赖它）。子会话完全不受影响。
- 工具描述里写明：`effect:"unknown"` 表示「可能已到达，**不要**盲目重发」；`reason:"queued"` 表示已进入对方进程的内存队列，会在对方下一个 turn 边界可见，除非对方进程崩溃。

### 4.4 web-hub 暴露（P3 已拍板：只读）

- `StatusInfo.xs?: { joined: boolean; receive: "off"|"deliver"|"wake"; blocked: number }`：append-only 可选字段，**只用于展示**（AgentCard 徽标），hub 的 list/send 授权**从不**读它（#4）；xs 关闭 ⇒ 字段不存在。
- 权威成员资格走 `xs_member` slot（§8.1），不进浏览器帧。
- 浏览器端没有加入/退出开关（P3）。

### 4.5 开关真值表（#8）

接收端对一条已通过成员、策略、栅栏、速率校验的消息，按下表决定派发方式（**跨会话任何一行都不会走 legacy `triggerTurn:true` 或 steer**）：

| `wake` 请求 | `fabric.wake.enabled` | `rootRunMaxS` | 主机能力（§6.7）        | 会话 `receive` | root 状态                                                               | 结果                                                                                   |
| ----------- | --------------------- | ------------- | ----------------------- | -------------- | ----------------------------------------------------------------------- | -------------------------------------------------------------------------------------- |
| false/省略  | 任意                  | 任意          | 任意                    | deliver/wake   | idle                                                                    | 只投递（`triggerTurn:false`，同步追加，取证 ⇒ `applied`）                              |
| false/省略  | 任意                  | 任意          | 任意                    | deliver/wake   | 流式中                                                                  | 只投递（pi 内存队列）⇒ `unknown{queued}`                                               |
| 任意        | 任意                  | 任意          | 任意                    | off            | 任意                                                                    | 拒收 `none{rejected}`                                                                  |
| true        | **false**             | 任意          | 任意                    | wake           | 任意                                                                    | 只投递，`wakeDowngraded:"wake_disabled"`；不跟踪 level（CausalLevel 未装配）           |
| true        | true                  | **0**         | 任意                    | wake           | 任意                                                                    | 只投递，`wakeDowngraded:"controller_disabled"`                                         |
| true        | true                  | >0            | `unknown` / `absent`    | wake           | 任意                                                                    | 只投递，`wakeDowngraded:"host_unverified"` / `"host_unsupported"`                      |
| true        | true                  | >0            | `observed` / `verified` | deliver        | 任意                                                                    | 只投递，`wakeDowngraded:"receiver_policy"`                                             |
| true        | true                  | >0            | `observed` / `verified` | wake           | 非 idle / Controller 占位 / goal 运行中 / level 超限 / 入站 wake 配额尽 | 只投递，`wakeDowngraded` 分别为 `busy`/`busy`/`goal`/`level_limit`/`inbound_wake_rate` |
| true        | true                  | >0            | `observed` / `verified` | wake           | idle 且以上都满足                                                       | **Controller.dispatch**（§6）                                                          |

发送端：`xsOn` 才有工具；发送方 `wake.enabled=false` ⇒ `wake:true` 在本地降级（`wakeDowngraded:"sender_wake_disabled"`），以只投递发出、不带 level。树内路径不受本表影响（P7），`src/config/settings.ts` 中 `FabricWakeSettings` 关于 `rootRunMaxS` 的注释同步改为「仅跨会话 Controller」。真值表由 `tests/fabric/xs-truth-table.test.ts` 逐行锁定（表驱动，行即用例）。

### 4.6 设置归属与传输契约（#6）

| 归属            | 键                                                                                                                                  | 谁读取                                    | 如何到达执行方                                                                                          | 冲突/更新规则                                                                                                                                                                                               |
| --------------- | ----------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------- | ------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **全局（hub）** | `hubSendsPerMin`；常量 `expiresMs=5000`、帧上限 16 KiB、`XS_HUB_DELIVER_MS=5000`                                                    | 拉起 hub 的那个 agent 的 `buildHubConfig` | `HubConfig.crossSession = { limits: { hubSendsPerMin } }`，`hub/main.ts` 复核（非法 ⇒ 丢键 ⇒ xs 关）    | **hub 启动时冻结**（与所有 `HubConfig` 键相同：「拉起者生效，改动需 `/webhub restart`」）。`xs_req{op:"info"}` 返回 hub 有效值；`/fabric status` 若与本地设置不同显示 `hub limits differ — /webhub restart` |
| **发送方会话**  | `sendsOutPerMin`、`sendsOutPerHour`、`wakesOutPerHour`、`pairMinIntervalMs`、`pairWakesPerHour`、`inFlightPerSession`、`listPerMin` | 发送方进程（stack 构建时）                | 随 `xs_member.limits` 下发；hub 用 **schema 上下界夹紧**后执行（同 uid 进程本就可信，夹紧只防配置事故） | stack 重建（`/reload`、`/new`…）时随新 `xs_member` 更新；每个会话按**自己的**设置受限，互不影响                                                                                                             |
| **接收方会话**  | `receive`（及会话级覆盖）、`allowFrom`、屏蔽列表、`recvPerHour`、`wakesInPerHour`、`inboxCap`、`rootRunMaxS`、`maxLevel`            | 接收方进程                                | **只在接收端执行**，不下发（hub 只知道 `joined`/`receive` 以便过滤 list 与早拒）                        | 本地权威；hub 侧的 `receive:"off"` 早拒只是优化，接收端仍再判                                                                                                                                               |
| **每请求**      | `wake`、`text`、`to`、`scope`（仅 list）                                                                                            | 工具参数                                  | `xs_req`                                                                                                | —                                                                                                                                                                                                           |

**限额预占与结算**（hub 侧，`hub/xs/limits.ts`）：

1. admission 时**预占**：`sendsOutPerMin/Hour` 计数 +1、`inFlightPerSession` +1、`pairMinIntervalMs` 记时间戳、`hubSendsPerMin` +1；若请求 `wake:true` 且 `wakesOutPerHour`/`pairWakesPerHour` 有余量 ⇒ 预占一次 wake，否则 hub 侧降级为只投递（`wakeDowngraded:"outbound_wake_rate"`/`"pair_wake_rate"`）。
2. 结算（`xs_ack` 到达或截止）：`inFlight` **总是**释放；`applied` ⇒ 全部保留；接收端回 `woke:false`（被降级或拒收）⇒ **只退还 wake 预占**；`none` ⇒ 发送计数**不退**（防止对拒收方无限探测，拒收本身便宜）；`unknown`（截止、断链、hub 重启）⇒ **一律不退**（保守）。
3. 计数全在 hub 内存，hub 重启清零（可接受：频率上限只防风暴；接收端入站限额不受 hub 重启影响）。

---

## 5. 发现、限制与加入控制

### 5.1 发现机制

| 维度     | 树内（第一期）                                  | 跨会话（第二期）                                                                                                                        |
| -------- | ----------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------- |
| 地址形式 | run id、`"root"`、`@label`                      | `ref`（sessionId 前 12 位）、完整 sessionId、会话名；只能指向主会话                                                                     |
| 怎么知道 | 派发返回 run id；`list_subagents`；父子天然已知 | `list_sessions`；收到消息时从消息头得知对方 `ref`；没有广播，不注入 system prompt                                                       |
| 授权     | kind × relation × `can_message`                 | 发送方：工具存在 ∧ 本会话已加入（hub 用有效 `xs_member` 校验）；接收方：已加入 ∧ `receive ≠ off` ∧ `allowFrom`（完整 id）∧ 不在屏蔽列表 |
| 范围     | 同进程同一棵树                                  | 同一 hub（per-uid、同机）上**已加入**的主会话                                                                                           |

`list_sessions` 的返回范围（hub 侧执行，agent 侧再校验）：

1. 同 hub / 同用户：天然成立。
2. **只列有效成员**：`phase==="live"` ∧ hello caps 含 `xs.v1` ∧ `!detached` ∧ `xs_member.joined` ∧ `xs_member.sessionId === session.sessionId`（#4）。未加入或成员帧无效 ⇒ 不可见、send 返回与「不存在」相同的 `E_XS_NO_TARGET`。
3. `scope:"cwd"`（P6 可选参数）：只列 cwd 相同或互为父子目录的会话。**只过滤列表，不限制 send**（P6：发现范围是 hub 上所有已加入会话）。

防枚举：list 限流（`listPerMin`）；最多 20 行；名称只做前缀与精确匹配；resolve 前缀最短 **8** 位；歧义 ⇒ ≤5 个候选（只含 `ref`/`name`）。

### 5.2 限额

**第一期现有限额**（`DEFAULT_SETTINGS.fabric`，r1.1 已核对，本期不改语义）：

| 键                                                       | 默认            | 作用（按代码）                                       |
| -------------------------------------------------------- | --------------- | ---------------------------------------------------- |
| `fabric.enabled`                                         | `false`         | 总开关                                               |
| `fabric.maxPerRun`                                       | 20              | 每个发送 run 的 **progress** 配额（名称有误导性）    |
| `fabric.findingQuota` / `directiveQuota`                 | 10 / 5          | 每个发送 run 的 finding / directive 配额             |
| `fabric.deadLetterQuota`                                 | 5               | 每个接收者的死信与系统回执配额                       |
| `fabric.maxChars`                                        | 2000            | 正文截断（前 75% + 后 25%）                          |
| `fabric.minIntervalMs` / `rootMinIntervalMs`             | 30 000 / 10 000 | 链路 / 投递到 root 的最小间隔                        |
| `fabric.rootInboxCap`                                    | 12              | 树内 root 未消费 context 消息上限（**只数 outbox**） |
| `fabric.progressTtlMs` / `reconcileTtlMs`                | 15 min / 24h    | TTL                                                  |
| `fabric.wake.maxLevel`                                   | 2               | 因果跳数上限                                         |
| `fabric.wake.perRunQuota`                                | 3               | 每个发送 run 有效 `wake:true` 次数                   |
| `fabric.wake.resumesPerHour` / `resumesPerTargetPerHour` | 6 / 2           | revive 次数                                          |
| `fabric.wake.parkCapPerTarget` / `resumeBudgetS`         | 8 / 600         | park 上限 / revive 预算                              |

**第二期新增**（`fabric.crossSession.limits.*` 与 `fabric.wake.rootRunMaxS`；数值即 P8 拍板的推荐值，r2 只把共享 `rootInboxCap` 改为独立 `inboxCap`，默认值仍为 12）：

| 维度            | 键                              | 默认（上下界）          | 归属 / 执行方（§4.6）           | 说明                                                                                          |
| --------------- | ------------------------------- | ----------------------- | ------------------------------- | --------------------------------------------------------------------------------------------- |
| 正文            | （复用 `fabric.maxChars`）      | 2000 字符               | 发送端截断；hub 帧硬上限 16 KiB | 超 16 KiB 的帧 hub 拒绝（`E_XS_TOO_LARGE`），不截断                                           |
| 每会话出站      | `sendsOutPerMin`                | 10 (1..60)              | 发送方 / hub（发送端预检）      |                                                                                               |
|                 | `sendsOutPerHour`               | 60 (1..600)             | 发送方 / hub                    |                                                                                               |
|                 | `wakesOutPerHour`               | 6 (0..60)               | 发送方 / hub                    | 0 = 只能只投递                                                                                |
| 每会话入站      | `recvPerHour`                   | 30 (1..600)             | 接收方 / 接收端                 | 超出 ⇒ `none{inbound_rate}`                                                                   |
|                 | `wakesInPerHour`                | 12 (0..60)              | 接收方 / 接收端                 | 超出 ⇒ 降级只投递（`inbound_wake_rate`）                                                      |
|                 | `inboxCap` ✱                    | 12 (1..64)              | 接收方 / 接收端                 | **独立**于树内 `rootInboxCap`；超出 ⇒ `none{inbox_full}`；释放规则见 §8.4                     |
| 每对会话        | `pairMinIntervalMs`             | 30 000 (5 000..600 000) | 发送方 / hub                    |                                                                                               |
|                 | `pairWakesPerHour`              | 2 (0..20)               | 发送方 / hub                    | 压制会话之间互相 ping-pong                                                                    |
| 全局（hub）     | `inFlightPerSession`            | 4 (1..16)               | 发送方 / hub                    |                                                                                               |
|                 | `hubSendsPerMin`                | 60 (1..600)             | 全局 / hub（HubConfig）         |                                                                                               |
|                 | `listPerMin`                    | 6 (1..60)               | 发送方 / hub                    | list 与 resolve 合计                                                                          |
| 时效            | `expiresMs`                     | 5 000（常量）           | hub 盖章、接收端校验            | 同机同时钟                                                                                    |
| 主会话 wake run | `fabric.wake.rootRunMaxS`       | 900 (60..3600；0 = 关)  | 接收方 / Controller             | **从派发起算**的墙钟上限；`wake_slow_start` 告警 10s、`abortGraceMs` 10s、idle 观察 2s 为常量 |
| 跳数            | （复用 `fabric.wake.maxLevel`） | 2                       | 发送端预检 + 接收端权威         | 跨会话一跳与树内一跳在同一条因果链上累计（§6.6）                                              |

### 5.3 加入控制（P1 已拍板：两层人控，agent 无权加入或退出）

| 层           | 谁  | 机制                                                                                                                   | 默认    | live？                                                                                                   |
| ------------ | --- | ---------------------------------------------------------------------------------------------------------------------- | ------- | -------------------------------------------------------------------------------------------------------- |
| ① 能力开关   | 人  | `fabric.crossSession.enabled`（及 fabric、webHub、control 前置）                                                       | `false` | non-live（`/reload` + `/webhub restart`）                                                                |
| ② 会话级加入 | 人  | `/fabric join` · `/fabric leave`（本地 TUI 与本地 RPC 客户端；**web/LAN/飞书来源一律拒绝**，见下）；或 `autoJoin:true` | 不加入  | live；持久化 `subagent:xs-membership`（entry 内记 sessionId，读回时不一致视为未加入 ⇒ fork 不继承，P10） |

命令全集（`src/commands/fabric-xs.ts`）：

| 命令                                                       | 作用                                                                                                                                                      | web 来源 |
| ---------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------- | -------- |
| `/fabric status`                                           | 成员状态、receive、自己的完整 sessionId（供别人写 `allowFrom`）、计数、栅栏状态（含 `stuck`）、主机能力态、hub 有效限额及差异提示、工具冲突               | 允许     |
| `/fabric blocks`                                           | **离线**列出屏蔽列表：序号、完整 sessionId、屏蔽时的名字快照、时间                                                                                        | 允许     |
| `/fabric join` / `leave`                                   | 加入 / 退出（每次都使 `epoch` +1，在途的旧 epoch 请求被 hub 拒绝）                                                                                        | **拒绝** |
| `/fabric receive off\|deliver\|wake`                       | 会话级覆盖                                                                                                                                                | **拒绝** |
| `/fabric block <ref\|name\|sessionId>`                     | 操作时经 hub `resolve` **唯一**解析为完整 sessionId（歧义 ⇒ 列候选、不屏蔽；目标离线时只接受完整 sessionId），存 `{sessionId, nameSnapshot, at}`，上限 64 | **拒绝** |
| `/fabric unblock <序号\|完整 sessionId\|前缀≥8\|名字快照>` | **离线**对本地屏蔽列表解析，不依赖目标在线；歧义 ⇒ 列候选                                                                                                 | **拒绝** |
| `/fabric fence reset`                                      | 手动清除 `stuck` 栅栏窗口（§7.3）                                                                                                                         | **拒绝** |

- **web 来源硬门禁（#9）**：`/fabric` handler 第一行判 `isWebInvocation(ctx)`，对上表「拒绝」行返回固定文本「跨会话成员资格只能在本地终端修改」，**不读** `webCommandPolicy`（用户 override 无法放开）；`agent/command-policy.ts` 的 `PI_TOOLKIT_TABLE` 另加 `fabric` 规则（`status`/`blocks` ⇒ allow，其余 ⇒ deny），只是第一层与 UI 提示；`agent/commands.ts` 的 prompt op 增加 `/^\s*\/fabric\s+(?:join|leave|receive|block|unblock|fence)(?:\s|$)/` 文本拒绝（照抄 `/webhub 2fa|passwd|user` 先例，防 pi 未来改变 `expandPromptTemplates` 默认值）。本地 RPC 客户端（非 hub 转发）不带 `webInvocation`，保持允许。
- **allowFrom（#14）**：只接受完整 sessionId（与 pi `assertValidSessionId` 同规则校验）；非法条目丢弃并 `console.warn` 一次；非空但全部非法 ⇒ 拒收一切（失败关闭，照抄 `webHub.lan.allowClients`）。名字不进授权，只在人操作命令时用于唯一解析。
- 拒收原因对发送方统一为 `none{rejected}`（不区分 off / allowFrom / 屏蔽，避免泄露策略）。
- **managed rpc 会话**：默认不加入；`autoJoin:true` 时加入。没有人类输入 ⇒ Controller 不会 `handedOver`，靠 `rootRunMaxS` 兜底。注意能力判定可能停在 `unknown`（§6.7、§14 N1）。

---

## 6. R1：RootWakeController

### 6.1 定位

主会话上**由跨会话消息触发的自治 run 的唯一入口**。只服务跨会话 `wake:true`（P7：树内 root 投递保持第一期 legacy）。不负责完成通知、`/goal`、topic-switch 回注等扩展自己发起的 run。

文件：`src/fabric/root-wake.ts`（pi-free 状态机，R1）+ `src/fabric/xs/wake-ledger.ts`（进程级 token 账本，R1）+ `src/fabric/xs/host-cap.ts`（进程级能力态，R1）；`src/stack.ts`（每 stack 一个实例）与 `src/index.ts`（`before_agent_start`、`agent_settled`、`input`、`session_start`/`session_shutdown` 转发）的装配属于集成包 XW。

### 6.2 所有权生命周期（#1、#2）

核心原则：**派发即拥有，所有权只因「run 已结束」的证据或人类接管而释放，从不因超时被遗忘。** 监管不依赖 `before_agent_start` 绑定事件；绑定只用于确认与「延迟启动的迟到识别」。

**dispatch 前置条件**（同步检查，任一不满足 ⇒ 不起 run，按 §4.5 降级为只投递）：`ctx.isIdle()` ∧ `!ctx.hasPendingMessages()` ∧ 栅栏通过（§7）∧ Controller 处于 `idle` ∧ `now < expiresAt` ∧ 能力 ∈ {`observed`,`verified`}（§6.7）∧ `wake.enabled` ∧ `rootRunMaxS>0` ∧ `receive=wake` ∧ `hopAllowed(senderLevel)` ∧ 入站 wake 配额有余 ∧ goal 不在运行。

**派发**（与栅栏检查、接收管道在同一个同步块里，无 await）：

```ts
const token = newRunId(); // 只放 details，不进 content（§8.6）
ledger.put({ token, sessionId, dispatchedAt: now, deadlineAt: now + rootRunMaxS * 1000, state: "live" });
try {
  pi.sendMessage(
    { customType: "subagent:xs", content, display: false, details: { xid, from, level, wakeToken: token } },
    { triggerTurn: true },
  );
} catch {
  ledger.delete(token);
  return ack({ effect: "none", reason: "host_rejected" });
} // Fpi1：assertActive 同步抛错
if (!ctx.isIdle()) {
  enter("starting");
  return ack({ effect: "applied", woke: true });
} // Fpi2：同步启动证据
enter("deferred");
return ack({ effect: "unknown", reason: "start_deferred", woke: true }); // Fpi5：settle 期间被延迟
```

**状态与转移**（定时器全部 `systemClock` 分段 + unref；`dispose()` 清空本 stack 的定时器，账本条目保留给下一个 stack）：

| 当前                                               | 事件                                                              | 下一状态              | 动作                                                                                                                                       |
| -------------------------------------------------- | ----------------------------------------------------------------- | --------------------- | ------------------------------------------------------------------------------------------------------------------------------------------ |
| `idle`                                             | 派发，同步后 `!isIdle()`                                          | `starting`            | 武装：截止定时器（`deadlineAt`，**从派发起算**，覆盖预启动压缩）、10s `wake_slow_start` 告警定时器（只计数，不改状态）、2s idle 观察定时器 |
| `idle`                                             | 派发，同步后仍 `isIdle()`                                         | `deferred`            | 武装截止定时器（不启 idle 观察：此时 idle 是正常的）                                                                                       |
| `starting`/`deferred`                              | `before_agent_start{custom, message.details.wakeToken === token}` | `bound`               | 能力 → `verified`；记录 `boundAt`（诊断用）                                                                                                |
| `deferred`                                         | `before_agent_start{user}` 或别的 token / 别的 customType         | `deferred`            | 别的 run 先启动（Fpi5 的排队顺序）；继续等                                                                                                 |
| `deferred`                                         | `before_agent_start{custom}` 但 `message`/`details` 读不到        | `bound`（推定为本次） | 能力 → `absent`（进程级粘滞）+ `console.warn` 一次。推定归属是失败关闭方向：最多把别人的 run 纳入 `rootRunMaxS` 监管                       |
| `starting`                                         | 任何 `before_agent_start` 非本 token                              | `starting`            | 依 Fpi2 不应发生；计数 `wake_foreign_start`，不改归属                                                                                      |
| `starting`/`bound`                                 | `agent_settled`                                                   | `idle`                | 账本删除；若从未 `bound` 且 leaf 中找不到本 xid ⇒ 计数 `wake_lost_after_accept`（预启动失败导致的至多一次丢失，§8.3）                      |
| `deferred`                                         | `agent_settled`                                                   | `deferred`            | 那是别人的 run                                                                                                                             |
| `starting`/`bound`/`handedOver`/`aborting`/`stuck` | 连续两次 idle 观察（间隔 2s）都 `isIdle()`                        | `idle`                | Fpi4：`_prepareRun` 抛错不发 `agent_settled`；计数 `wake_end_unobserved`；账本删除                                                         |
| `starting`/`deferred`/`bound`                      | 人类输入（`classifyHumanInput`，与 `wake-input.ts` 同一判定）     | `handedOver`          | 撤销截止定时器，**永不 abort**；继续占位（防止叠派），直到 run 结束证据                                                                    |
| `handedOver`                                       | `agent_settled`（仅当曾 `starting`/`bound`）/ 连续两次 idle 观察  | `idle`                | 账本删除                                                                                                                                   |
| `handedOver`（源自 `deferred`、未见 token）        | 截止到点                                                          | `idle`                | 账本条目转为墓碑 `{abortOnSight:false}`（迟到启动时不打断人）                                                                              |
| `starting`/`bound`                                 | 截止到点（`now ≥ deadlineAt`，且自派发以来无人类输入）            | `aborting`            | `ctx.abort()` 发出即走（Fpi6：启动中也有效）；武装 `abortGraceMs`=10s                                                                      |
| `deferred`                                         | 截止到点，token 未见                                              | `idle`                | 账本条目转为墓碑 `{abortOnSight:true}`：它日若以该 token 启动，立即 abort（首个请求前）                                                    |
| 任意                                               | `before_agent_start` 携带墓碑 token（`abortOnSight:true`）        | 不变                  | `ctx.abort()`；计数 `wake_late_aborted`；C-X1b 锁定「零 provider 请求 + 有 `agent_settled{aborted:true}`」                                 |
| `aborting`/`stuck`                                 | `agent_settled` / 连续两次 idle 观察                              | `idle`                | 账本删除                                                                                                                                   |
| `aborting`                                         | `abortGraceMs` 到点                                               | `stuck`               | `console.warn` + 计数 `abortStuck`；**不二次 abort、不阻塞**；只保留 idle 观察；占位意味着后续跨会话 wake 降级为只投递（安全方向）         |
| 任意                                               | `session_shutdown`                                                | （stack 销毁）        | 定时器清空；账本条目保留（§6.5）                                                                                                           |

**三个评审场景的结论**：

- **预启动压缩超过 10s 才启动**：状态停在 `starting`（10s 只记 `wake_slow_start`），截止定时器从派发起算照常运行；绑定事件晚到 ⇒ `bound`；若压缩拖过 `rootRunMaxS` ⇒ `ctx.abort()` 会同时中止压缩与这个 run（Fpi6）。不存在「Controller 已回 idle、run 随后无监管启动」的路径。
- **启动期间人类插话**：`handedOver`——人的消息会进入这个 run（pi 在 run 活动期间把人类输入作为 steer/followUp 处理），run 交还给人，永不被 Controller abort；Controller 继续占位直到 run 结束。
- **其他 run 抢先启动**：只在 `deferred` 下可能（Fpi5）；本次 token 迟到出现时 `bound`（未过期）或被立即 abort（已过期墓碑）。

### 6.3 接受证据（#5）

Controller 与只投递路径共用一个证据规则：**观察全部在派发的同一个同步块内完成，不等待、不重发。**

| 情形                                  | 同步可观察证据                                                                   | `effect`                                | 说明                                                                                                                                |
| ------------------------------------- | -------------------------------------------------------------------------------- | --------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------- |
| `pi.sendMessage` 同步抛错             | 抛错（`assertActive` 在任何状态改动之前）                                        | `none{host_rejected}`                   | 证明未生效                                                                                                                          |
| 只投递，接收端 idle                   | `ctx.sessionManager.getLeafEntry()` 是 `custom_message` 且 `details.xid === xid` | `applied`                               | Fpi7：同步追加到会话树；证据 = 已在会话树里（是否已落盘取决于会话持久化模式，与第一期一致）                                         |
| 只投递，接收端 idle，但 leaf 不是本条 | 无                                                                               | `unknown{accept_unverified}`            | 宿主吞掉了异步错误等                                                                                                                |
| 只投递，接收端流式中                  | 无（pi 只放 `_pendingCustomMessages`，不可观测）                                 | `unknown{queued}`                       | 工具描述明确「已入对方内存队列，不要重发」；崩溃会丢，属 NQ2 至多一次（§14 N2 给出备选）                                            |
| Controller 派发，同步后 `!isIdle()`   | run 已由本调用启动（Fpi2），本条是该 run 的触发消息                              | `applied` + `woke:true`                 | 线性化点 = pi 接受为 run 触发（与第一期 `input_accepted` 同口径）；随后若预启动失败丢失 ⇒ `wake_lost_after_accept` 计数，不回改 ack |
| Controller 派发，同步后仍 idle        | 无（已进入 pi 的 settle 延迟队列）                                               | `unknown{start_deferred}` + `woke:true` | 所有权已由 `deferred` 持有                                                                                                          |

接收端从不使用 `deliverAs:"steer"` 或 Controller 以外的 `triggerTurn:true`：r1.1 的「忙时 steer 进当前 run」被删除（Fpi8：`!isIdle()` 可能只是压缩/分支摘要，`triggerTurn:true` 在非流式时会**新起一个无监管 run**）。`wake:true` 遇忙 ⇒ 只投递 + `wakeDowngraded:"busy"`。

### 6.4 与 switch_context / compaction / topic-switch / goal 并发

- **compaction**（任何 reason）：栅栏窗口内拒收（§7）。Controller 已拥有 run 时发生压缩：不撤销监管，压缩时间计入 `rootRunMaxS`（墙钟上限，宁紧勿松）。
- **switch_context**：handoff 到 `session_before_compact` 才生效，由 compaction 窗口覆盖；暂存期间 root 必非 idle ⇒ 只投递。
- **topic-switch**：hold 等待确认与 PONR 迁移两个窗口都进栅栏（§7）。
- **web resume / `/new` / fork**：exec claim 与 `switchInFlight` 进栅栏；切换时 pi 会先 abort 当前 run（Fpi10），旧 stack 的 Controller 随 `session_shutdown` 销毁，账本条目留给新 stack 识别（§6.5）。
- **`/goal` 运行中**：只阻止唤醒（降级只投递），不阻止投递。

### 6.5 跨 `/reload` 与会话切换的所有权：进程级 token 账本

`src/fabric/xs/wake-ledger.ts`：`Symbol.for("pi-subagent:xs-wake-ledger")` 上的 Map（容量 8，先淘汰最老的墓碑；墓碑在 `deadlineAt + 3600s` 后惰性清理；无定时器）。条目 `{token, sessionId, dispatchedAt, deadlineAt, state:"live"|"tombstone", abortOnSight, handed}`。

- `src/index.ts` 的 `before_agent_start` 处理器（每次 activate 注册一次，post-guard）**直接查账本**做墓碑识别与能力观察，即使 stack 正在重建也有效。
- 新 stack 构建时扫描账本：
  - `state:"live"` ∧ `sessionId` 等于当前会话 ∧ `!ctx.isIdle()` ∧ `!handed` ⇒ **认领**为 `bound`，截止定时器按剩余时间重新武装（剩余 ≤0 ⇒ 立即进入 `aborting`）；
  - `state:"live"` ∧ 当前 idle ⇒ 那个 run 已结束（或从未启动的延迟启动——同进程 settle 队列在 `/reload` 前已执行完，Fpi10 交互模式不会在流式中 reload）⇒ 转墓碑 `{abortOnSight:true}`；
  - 其他会话的条目 ⇒ 墓碑（切换时 pi 已 abort 旧 run；迟到启动一律 abort）。
- 这是对 r1.1「新 stack 不认领旧 token」的推翻：旧口径会在 `/reload` 时留下无监管 run。

### 6.6 level 传播表（#13）

发送方在 `xs_req{send}` 里携带自己 root 的 `levelOf("root")`（发送方 `wake.enabled=false` ⇒ 不带 level）。hub 只做范围校验不改写。接收端：

| 接收端结果                                                  | root level 变化             | 与第一期对应                       |
| ----------------------------------------------------------- | --------------------------- | ---------------------------------- |
| Controller 派发成功（`starting`/`deferred`，即真正起 turn） | `raise(root, L_s + 1)`      | `onDelivered` 中「起 turn 的投递」 |
| 只投递（`wake` 省略/false，idle 追加或流式入队）            | `raise(root, L_s)`（carry） | root `wake:false` carry            |
| `wake:true` 但被任何原因降级（§4.5 各行）                   | `raise(root, L_s)`（carry） | 降级 = 只投递                      |
| 拒收（`none`：过期、未加入、策略、栅栏、速率、inbox 满…）   | 不变                        | 未投递                             |
| 消息不带 level（发送方 wake 关）                            | 不变                        | —                                  |
| 接收端 `wake.enabled=false`                                 | 不跟踪（无 CausalLevel）    | 第一期 wake 关时同样不装配         |

hop 判定：Controller 派发前 `hopAllowed(L_s)`（接收端的 `maxLevel`）；发送端用自己的 `maxLevel` 预检，不通过 ⇒ 本地降级 `wakeDowngraded:"level_limit"`。只有 `wake-input.ts` 证实的人类输入让 root 归零（不新增归零点）。混合链测试：树内 child→root（carry L）→ 跨会话 wake（L+1）→ 对方 root 派子 run（继承）→ 子 run 回报对方 root 唤醒（L+2 ≤ maxLevel?）。

### 6.7 主机能力判定（#1）

`src/fabric/xs/host-cap.ts`：进程级 `Symbol.for("pi-subagent:xs-host-cap")`，粘滞到进程退出（同一进程内 pi 版本不会变；`/reload` 不清）。

| 状态       | 进入条件（可观察来源）                                                                                                                          | 跨会话 `wake:true`                 |
| ---------- | ----------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------- |
| `unknown`  | 进程启动后尚未观察到任何 `before_agent_start`                                                                                                   | 只投递（`host_unverified`）        |
| `observed` | 观察到任一 `before_agent_start` 带 `messageType` 字符串（`"user"` 或 `"custom"`）——pi 1.2+ 的联合形状（Fpi11）；人类或 web 的第一次 prompt 即可 | Controller                         |
| `verified` | Controller 自己的 token 在 `before_agent_start.message.details.wakeToken` 中被读到                                                              | Controller                         |
| `absent`   | 观察到 `before_agent_start` 无 `messageType` 但有 `prompt`（pi 1.0/1.1）；或 `deferred` 中遇到读不到 `message.details` 的 custom 触发           | 只投递（`host_unsupported`），粘滞 |

- **首次调用协议**：能力态只由「已经发生的事件」推进，从不为了探测而起 run。`unknown` 时的安全降级是只投递（消息照样送达，只是不起 turn），可执行、无副作用。
- 为什么 `observed` 足够安全：在 `observed` 下 Controller 的同步所有权（Fpi2）不依赖 custom 形状；custom 形状只影响 `deferred` 的迟到识别，而形状异常会被识别为 `absent` 并按「推定归属」失败关闭；C-X1 在 peer 升级前锁定形状。
- 已知局限：hub restore 出来、从未收到过任何 prompt 的 managed rpc 会话会停在 `unknown`，只能只投递，直到第一次 web/人类 prompt（§14 N1）。
- `src/adapters/pi-compat.ts`：`readBeforeAgentStartTrigger` 扩展为返回 `{kind:"custom"; customType?: string; details?: unknown}`（结构化读取，I14，旧调用方只看 `kind`，行为不变）；新增 `readTriggerShape(event): "union" | "legacy" | "unknown"`。

### 6.8 零挂起

每个状态都有出口且出口不依赖单一事件：`starting`/`bound` ≤ `rootRunMaxS` 后进入 `aborting`，`aborting` ≤10s 后进入 `stuck`；所有占位状态都有 2s idle 观察兜底；`deferred` ≤ `rootRunMaxS` 后转墓碑。Controller 从不 await pi，`ctx.abort()` 发出即走。占位（`handedOver`/`stuck`）只会让后续跨会话 wake 降级为只投递，从不阻塞任何别的路径。

---

## 7. T1：会话变更栅栏（#3）

### 7.1 何时需要

接收端每一次派发（含只投递）之前。原因：会话变更窗口内写入的 custom 消息会落进即将被替换、压缩或切走的上下文，而发送方已拿到 `applied`。r1.1 的「T2 地址绑定」在 r2 里由 §8.1 的 `origin`/`epoch` 三重校验与接收端 `to.sessionId + to.epoch` 比对承担。

### 7.2 实现（`src/fabric/xs/fence.ts`，pi-free）

```ts
type FenceName = "compaction" | "tree" | "switch" | "web_exec" | "topic_switch" | "goal";
interface SessionFence {
  onEvent(e: FenceEvent): void; // index.ts 转发的 pi 事件（XW 装配）
  check(): { ok: true } | { ok: false; reason: `fenced:${FenceName}`; wakeOnly?: true };
  status(): { open: FenceName[]; stuck: FenceName[]; oldestOpenMs?: number };
  reset(): void; // /fabric fence reset（仅本地）
  dispose(): void;
}
```

**原则**：窗口**只**因「操作已结束」的证据关闭；超时从不打开栅栏。

| 窗口           | 打开                                           | 关闭证据（任一）                                                                                                                                                   | 无完成事件的路径（Fpi9）与处理                                                                                            |
| -------------- | ---------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------- |
| `compaction`   | `session_before_compact`（任何 reason）        | `session_compact` 后 `setTimeout(0)`（D26：pi 在清 controller 前发出）；`session_compact_failed`（覆盖失败、abort、被扩展取消）后 `setTimeout(0)`；`session_start` | pi 1.3 每条压缩路径都以两者之一收尾；仍按通用 stuck 规则兜底                                                              |
| `tree`         | `session_before_tree`                          | `session_tree` 后 `setTimeout(0)`（`session_tree` 在 `finally` 清 controller 之前发出）；`session_start`；**后续证据**：之后的 `input` 或 `before_agent_start`     | 被扩展取消时 pi 直接 return、不发事件 ⇒ 窗口保持关闭，直到后续证据（人取消 `/tree` 后的下一次输入或 run 启动）            |
| `switch`       | `session_before_switch`、`session_before_fork` | `session_shutdown`（stack 随之销毁，新 stack 从干净状态开始）；**后续证据**：之后的 `input` 或 `before_agent_start`（说明切换被取消、旧会话继续）                  | 被取消时无 `session_start` ⇒ 同上；异步 `session_before_switch` 处理器耗时任意长 ⇒ 窗口一直关闭（正确：切换确实还在进行） |
| `web_exec`     | —（迟绑定端口，检查时读取）                    | 端口返回 false                                                                                                                                                     | `resumeExec.switchInFlight()` ∨ exec claim 被持有（`src/web-hub/agent/index.ts` 新增只读 getter）                         |
| `topic_switch` | —（端口）                                      | 端口返回 false                                                                                                                                                     | pending hold ∨ B1 mid-switch 标记（`src/topic-switch/wire.ts` 新增只读 `fenceActive()`）                                  |
| `goal`         | —（端口）                                      | —                                                                                                                                                                  | goal 运行中 ⇒ `wakeOnly`（只降级唤醒，不拒收）                                                                            |

- 端口约定：`() => boolean | undefined`；`undefined` = 不活动；**抛错 = 活动**（失败关闭）。
- 事件窗口之外不读 `ctx.isIdle()`：「非 idle」只用于 Controller 前置条件（§6.2），不参与栅栏判定。

### 7.3 超时 = 告警 + 继续拒收（不是失败开放）

- 任一窗口打开超过 30s ⇒ 标记 `stuck`（unref 定时器只负责打标记和 `console.warn` 一次），**窗口仍关闭**；`/fabric status` 显示 `fence stuck: tree 45s`。
- `stuck` 的清除只有三条：上表的关闭证据、`session_start`（stack 重建）、本地 `/fabric fence reset`（web 来源拒绝，§5.3）。
- 零挂起成立的理由：栅栏从不让任何调用等待——命中即同步返回 `none{fenced:<name>}`；`stuck` 的代价只是跨会话消息被拒收（发送方模型看到 `none`，自己决定稍后重发），属于评审建议中的「拒收降级」。

### 7.4 校验时机

接收管道在**同一个同步块**里依次 `fence.check()` → 证据观察前的 `pi.sendMessage()` → 取证 → ack，无 await，无 TOCTOU。

---

## 8. X1–X5：跨会话投递

### 8.1 身份与成员资格绑定（#4）

**`xs_member` slot 帧**（agent→hub，cap `xs.v1` 门控，`SLOT_ORDER` 追加 `"xs"`，排在 `"session"` 之后；重连时随 slot 重放）：

```ts
{ t: "xs_member", sessionId: string, epoch: number, joined: boolean, receive: "off"|"deliver"|"wake",
  limits: { sendsOutPerMin, sendsOutPerHour, wakesOutPerHour, pairMinIntervalMs, pairWakesPerHour, inFlightPerSession, listPerMin } }
```

- `epoch`：进程级单调计数（`Symbol.for("pi-subagent:xs-epoch")`），在 **stack 构建（attach）、join、leave** 时 +1（receive 变更不加，以免误伤在途请求）。每次变化都 `setSlot("xs", …)`。
- **hub 规则**（`hub/xs/members.ts`，registry 记录旁的 xs 专用表，`registry.ts` 只负责把 `xs_member`/`session`/`session_detached`/断连事件转给它）：
  1. 收到 `xs_member` ⇒ 存为 `members[agentKey]`；
  2. 收到 `session` 帧且新 `sessionId ≠ members[agentKey].sessionId` ⇒ 作废该成员记录；`session_detached` ⇒ 作废；连接断开 / reclaim / reap ⇒ 作废；
  3. **有效成员** = 记录存在 ∧ `!r.detached` ∧ `r.session.sessionId === member.sessionId` ∧ `r.phase === "live"` ∧ hello caps 含 `xs.v1`。`StatusInfo.xs` 不参与（#4：旧 status 不会被套到新 session 上）。
- **请求的 origin 校验**：每个 `xs_req` 携带 `origin:{sessionId, epoch}`。hub 只有在「发送帧的 socket 对应的记录是有效成员 ∧ `origin.sessionId === member.sessionId` ∧ `origin.epoch === member.epoch` ∧（send 还要求）`member.joined`」时才处理，否则 `E_XS_STALE_ORIGIN`（effect `none`）。盖章的 `from` 完全由 hub 从该成员记录与 `r.session` 推导，帧里其它身份字段忽略。
- **发送端守卫**（`src/fabric/xs/sender.ts`）：工具开始时快照 `origin = { sessionId, epoch }`；`resolve` 往返之后、`send` 发出之前、以及结果返回之前，各检查一次「`signal` 未 abort ∧ 当前 stack 仍是同一个 ∧ 当前 `(sessionId, epoch)` 未变」，任何一项失败 ⇒ 不再发帧，返回 `none{origin_changed}`。即使检查遗漏，hub 侧的 origin 校验也会拒绝旧 epoch 的帧（单 socket FIFO 保证：`/new` 时 `session_detached`→`session`→新 `xs_member` 先于旧调用的后续帧到达 hub）。
- **接收端比对**：`xs_deliver.to = { sessionId, epoch }`（hub 填入目标成员当时的值）；接收端在同步块开头比对当前值，不一致 ⇒ `none{session_changed}`。
- **leave 在途竞态**：leave 本地同步生效（接收端以本地成员态为准立即拒收）；hub 在收到新 `xs_member{joined:false}` 前已转发的消息由接收端本地拒绝；发送方在 leave 后发出的旧 epoch 请求被 hub 拒绝。

### 8.2 帧契约、回复关联与请求 API（#6、#10，XS0 冻结）

| 帧           | 方向      | 字段                                                                                                                                            | 关联与截止                                                                                                                                                                                                               |
| ------------ | --------- | ----------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `xs_member`  | agent→hub | 见 §8.1                                                                                                                                         | slot，无应答                                                                                                                                                                                                             |
| `xs_req`     | agent→hub | `rid`, `op:"list"\|"resolve"\|"send"\|"info"`, `origin`, `query?`, `scope?`, `to?`, `text?`, `wake?`, `level?`                                  | agent 侧 `connection.request()` pending 按 `rid`；hub 在 `agent-server.ts` 里先于 registry 分派给 `hub/xs/router.ts`（不进 bus、不进逐帧日志）                                                                           |
| `xs_res`     | hub→agent | `rid`, `ok`, `code?`, `effect?`, `reason?`, `wakeDowngraded?`, `rows?`, `candidates?`, `target?`, `hubLimits?`                                  | `connection.ts` 的应答 `case` 列表（现 `tfa_res`/`fsb_res`/`lan_res`/`hub_ctl_ack`）加入 `"xs_res"`                                                                                                                      |
| `xs_deliver` | hub→agent | `rid`（registry 分配）, `xid`, `to:{sessionId,epoch}`, `from:{sessionId, ref, name?, cwdLabel, agentId}`, `text`, `wake`, `level?`, `expiresAt` | hub 侧 `registry.request(targetKey, frame, XS_HUB_DELIVER_MS=5000)`；agent 侧 `connection.ts` 新 `case "xs_deliver"`（`link==="live"` 才处理），**必须恰好回一次 `xs_ack`**（同步管道，异常也回 `none{receiver_error}`） |
| `xs_ack`     | agent→hub | `rid`, `xid`, `effect`, `reason?`, `wakeDowngraded?`, `woke`                                                                                    | `hub/registry.ts` 的 `onFrame` 新增 `case "xs_ack"`：`pending.get(rid)` 结算（照抄 `snapshot_reply`/`cmd_result`）；无 pending（hub 已超时）⇒ 只计数 `xs_late_ack`，不记正文                                             |

**`connection.request()` 签名改动**（X2）：

- 新增重载 `request(frame: XsReqFrame, requiredCap: "xs.v1"): Promise<XsResFrame>`；
- 截止由帧类型/op 查表 `requestDeadlineMs(frame)`：`fsb_req` 12 000（不变）、`xs_req{list|resolve|info}` 3 000、`xs_req{send}` **8 000**、其余 3 000（不变）。send 的 8s = hub admission（同步，<1s）+ `XS_HUB_DELIVER_MS` 5s + 2s 余量 ⇒ 正常情况下 hub 的 `xs_res` 总先于客户端截止到达；客户端截止只在 hub 死亡/卡死时触发 ⇒ `unknown{client_deadline}`；
- 链路断开时 pending 全部 reject（现有行为）⇒ `unknown{link_lost}`；无 cap ⇒ `E_XS_OFF{hub}`。
- `expiresAt` 由 hub 生成（`hubNow + 5000`），与客户端截止相互独立；接收端用本机时钟判断（同机同钟）。

### 8.3 X1：hub 中继（`src/web-hub/hub/xs/`）

- `router.ts`：
  - `list`：遍历有效成员（§8.1 规则 3）∧ `joined` ∧ 非发送方自身 ∧（`scope:"cwd"` 时）cwd 关系 ⇒ 投影 ≤20 行。
  - `resolve`：sessionId 精确 → 前缀（≥8）→ 名称精确 → 名称忽略大小写；歧义 ⇒ ≤5 候选；无匹配 ⇒ `E_XS_NO_TARGET`。
  - `send`：①origin 校验；②目标精确匹配：恰好一个有效、`joined` 的成员持有该 `sessionId`（两个 ⇒ `E_XS_AMBIGUOUS`，不投递）；③目标 `receive:"off"` ⇒ `none{rejected}`（早拒优化，接收端仍再判）；④§4.6 限额预占；⑤盖章 `from`、`xid`（hub 生成）、`expiresAt`、`to.epoch`；⑥`registry.request`；⑦按 `xs_ack` 或截止结算并回 `xs_res`。
  - `info`：返回 hub 有效全局限额与常量。
  - 处理器整体 try/catch：异常 ⇒ `xs_res{ok:false, code:"E_XS_INTERNAL"}` + 只记错误码的日志（§8.5）。
- `members.ts`（§8.1）、`limits.ts`（令牌桶/滑动窗口 + 预占/结算，§4.6）。
- 装配：`hub.ts` 仅当 `config.crossSession` 存在时构建，`xs.v1` 进 `extraHubCaps`（两面同源）；`main.ts` 复核配置。

### 8.4 接收端管道（`src/fabric/xs/receiver.ts`）与独立 inbox（#7）

有序阶段（同一个同步块，任一阶段失败即 ack 并返回）：

1. `expiresAt` 未过期，否则 `none{expired}`；
2. 去重（§9），命中 ⇒ 回放首次 ack；满容量 ⇒ `none{dedup_full}`；
3. 本地成员态 `joined` ∧ `receive ≠ off` ∧ `allowFrom` ∧ 不在屏蔽列表，否则 `none{rejected}`；
4. `to.sessionId`/`to.epoch` 与当前一致，否则 `none{session_changed}`；
5. 栅栏 `check()`（§7），命中 ⇒ `none{fenced:<name>}`；goal ⇒ 记 `wakeOnly`；
6. 入站速率 `recvPerHour`，超出 ⇒ `none{inbound_rate}`；inbox `inboxCap`，满 ⇒ `none{inbox_full}`；
7. 按 §4.5 决定 Controller 派发或只投递（level、`wakesInPerHour`、goal、busy 降级）；
8. `pi.sendMessage` + §6.3 取证 ⇒ ack；level 按 §6.6 更新；inbox 记账。

**独立 inbox 计数**（`src/fabric/xs/inbox.ts`，stack 内存）：每条 `applied`/`unknown{queued|start_deferred}` 记一条 `{xid, acceptedAt, mode:"appended"|"queued"|"trigger"}`。释放规则：

- `appended`（idle 时追加）：在**之后启动**的某个 run 结束（`agent_settled`）时释放——该 run 的上下文必然包含它；
- `queued`（流式时入内存队列，turn_end 才 flush）：同理，在 flush 之后启动的 run 结束时释放（实现：记 `acceptedAt`，`before_agent_start` 时把 `acceptedAt < runStartAt` 的条目标记为「已在上下文」，该 run 的 `agent_settled` 释放已标记条目）；
- `trigger`（Controller 派发）：该 run 结束（Controller 回 `idle`）时释放；
- `session_start` ⇒ 清零（新 stack）。

树内 `FabricRouter.rootInbox()` 一行不改，交叉测试证明「xs 占满 inbox 不影响树内 `target_backpressure` 判定，反之亦然」。

### 8.5 审计与日志（#15）

- hub 审计行（`audit.ts` 新增 `xs` 行，字段白名单）：`op`、`xid`、`fromSession`/`toSession` 前 8 位、`textLen`、`wake`、`outcome`、`reason`。**不记正文、不记正文哈希**。
- **`agent-server.ts` 坏 JSON 分支**：从 `{agentKey, sample: err.sample.slice(0,80)}` 改为 `{agentKey, bytes: err.sample.length}`（无条件，对所有帧类型生效——这是纯卫生修复，任何帧的正文都不该进 hub.log）。
- xs 路由所有拒绝/异常分支只记 `{code, op, textLen}`；`decodeAgentFrame` 判为非法的 xs 帧沿用「静默忽略」（不新增日志）。
- 接收端 `console.warn("[pi-subagent] fabric xs …")` 只含计数与 reason，不含正文。

### 8.6 旧版本对端降级

| 情形                                     | 行为                                                                                |
| ---------------------------------------- | ----------------------------------------------------------------------------------- |
| 发送方新、hub 旧（hello_ack 无 `xs.v1`） | 工具返回 `E_XS_OFF{hub}`，提示 `/webhub restart`；`xs_member` slot 不发（cap 门控） |
| 接收方旧（hello 无 `xs.v1`）             | 不是有效成员 ⇒ 不出现在 list；send ⇒ `E_XS_NO_TARGET`                               |
| hub 新、两端都旧                         | hub 不会主动发 `xs_*` 帧                                                            |
| 接收方新但 xs 关闭                       | 同「接收方旧」                                                                      |

### 8.7 managed rpc 与 hub 重启

- **managed rpc**：与 TUI 一视同仁；restore 后新 agentId、同 sessionId，成员资格从 entry 读回，`xs_member` 重发 ⇒ 仍可达。能力态在新进程里重新从 `unknown` 开始（§6.7）。
- **hub 重启**：在途 send ⇒ `unknown`（不补发）；所有 agent 重连后 slot 重放（含 `xs_member`）⇒ 成员表自动重建；hub 限额清零；接收端去重表、能力态、账本都在 agent 进程里，不受影响。

### 8.8 provider payload 不被污染

- `details`（`wakeToken`、`xid`、来源元数据）不发给 provider：pi `convertToLlm()` 只投影 custom 的 `content`。由 conformance C-X5 锁定（真实 pi + 本地 Anthropic stub：请求体无 token；system 不变）。注意：主会话开启 xs 时工具表多两个工具，是**预期**的一次性前缀变化，C-X5 不断言「开关前后前缀相同」，只断言「开启后各次请求间 tools/system 稳定」。
- `content` 格式：宿主说明在边界外，元数据 JSON 编码后截断 64 字符，正文在接收方 nonce 边界之间（A6），头部写明「不可信输入」。nonce 与说明只是卫生措施，不构成模型权限隔离（XR3）。
- system prompt 不变：不注入会话清单，sysprompt hub 不新增 section。

---

## 9. NQ3：去重（#11）

- **证明主线**是 §3 的「无重发路径」；去重是纵深防御，承诺收窄为：**同一进程内**，任一未过期 xid 至多派发一次，**含跨 `/reload`**。
- 存储：`src/fabric/xs/dedup.ts`，进程级 `Symbol.for("pi-subagent:xs-dedup")` Map `xid → firstAck`，条目存活到 `expiresAt + 1s`（惰性清理，无定时器）。
- 容量 256；满且无可清理的过期条目 ⇒ **拒收** `none{dedup_full}`（不淘汰有效条目）。容量足够：`recvPerHour` 上限 600 ⇒ 6s 窗口内远小于 256。
- 跨进程（pi 重启）：新进程拿不到旧 socket 的帧，hub 又不重发 ⇒ 无需持久化。
- 与 `wake_result` 无关：跨会话不回传结果（Q10）、不产生 `wake_result`。

---

## 10. 安全与不变量

### 10.1 不变量（每条都有测试，见 §11）

| ID   | 不变量                                                                                                                                                                                                                                                                                                                                                                |
| ---- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| XI1  | xs 关闭（或任一前置开关关闭）⇒ 主会话工具表、`message_agent` schema、`HubConfig`、hello caps、`StatusInfo`、slot 帧序列、`RESERVED_TOOL_NAMES`、session entry 全部逐字节不变（`fabric-xs-off-golden.json`）；xs 开启 ⇒ **子会话**工具表与 `RESERVED_TOOL_NAMES` 仍不变；第一期 golden 不改。唯一的无条件变化是 hub.log 坏 JSON 行不再含样本（日志不是线上契约，§8.5） |
| XI2  | 主会话新增的自治 run **只有**一条路径：`RootWakeController.dispatch`；每个这样的 run 从派发起就被拥有，直到 run 结束证据或人类接管；跨 `/reload` 被认领或在启动时被识别中止；跨会话路径**从不**使用 steer 或 Controller 以外的 `triggerTurn:true`                                                                                                                     |
| XI3  | 每条跨会话消息至多派发一次：协议无重发路径（主证明）；同进程内（含跨 `/reload`）未过期 xid 去重；满容量拒收不淘汰                                                                                                                                                                                                                                                     |
| XI4  | 发送方身份**只**来自 hub 盖章，且盖章要求「socket 记录 + 当前 session + 有效 `xs_member` + 请求 `origin{sessionId,epoch}`」四者一致；帧内身份字段忽略；带 `from.run` 的帧拒绝                                                                                                                                                                                         |
| XI5  | 未加入（或成员帧无效）的会话对 list 不可见、对 send 不可达，与「不存在」不可区分                                                                                                                                                                                                                                                                                      |
| XI6  | 正文不进 hub.log（含错误分支）、`console.warn`、审计行、telemetry；只记长度、码与计数                                                                                                                                                                                                                                                                                 |
| XI7  | 每个等待点有界：客户端 list/resolve 3s、send 8s；hub 投递 5s；Controller 截止 `rootRunMaxS` + abort 宽限 10s + idle 观察 2s；所有定时器 unref                                                                                                                                                                                                                         |
| XI8  | 栅栏检查、派发、取证、ack 在同一个同步块里                                                                                                                                                                                                                                                                                                                            |
| XI9  | level 按 §6.6 表传播：只有 Controller 真正起 turn 才 `+1`；只有人类输入让 root 归零                                                                                                                                                                                                                                                                                   |
| XI10 | `details.wakeToken` 永不出现在 provider 请求体里                                                                                                                                                                                                                                                                                                                      |
| XI11 | `effect:"applied"` 只在 §6.3 表中的同步证据成立时返回；其余为 `unknown` 或 `none`                                                                                                                                                                                                                                                                                     |
| XI12 | 栅栏只因完成事件、后续证据或本地手动重置而打开；超时从不打开栅栏                                                                                                                                                                                                                                                                                                      |
| XI13 | web/LAN/飞书来源无论 `webCommandPolicy` 如何配置，都不能改变成员资格、接收策略、屏蔽列表或栅栏状态                                                                                                                                                                                                                                                                    |

### 10.2 零挂起

hub `registry.request` 5s；agent `connection.request` 按表截止；接收端派发同步；Controller 不 await pi；成员资格写盘走 `appendEntry`（同步、失败吞掉）；栅栏命中同步拒绝。print 模式（`pi -p`）下 web hub 不装配 ⇒ xs 惰性；即使装配，定时器也都 unref。

### 10.3 认证与授权

- 能发消息的只有本机、同 uid、连同一 hub 的 pi 进程（agent socket）。浏览器、LAN、飞书没有直接的 xs 入口。
- LAN/飞书用户只能通过已有 prompt 路径让某会话里的模型调用工具，等价于他本来就能操作那个会话（U1）。成员与策略变更在 `/fabric` 执行点对 web 来源硬拒绝（XI13，§5.3）。
- 没有死信记录；失败经工具结果同步回给发送方；计数进 `/agent status` 与 `/fabric status`。

### 10.4 门禁

- source-scan：`src/fabric/xs/**`、`src/fabric/root-wake.ts` 禁止 import pi；`src/web-hub/hub/xs/**` 禁止 import pi。
- 日志断言：真实 hub 子进程里分别发送「含正文的非法 JSON」「被拒的 xs 帧」「触发 handler 异常的 xs 帧」，断言 hub.log 与审计里不含正文子串。
- conformance：C-X1…C-X7 并入 `npm run test:conformance`；pi peer 升级前与 consult-preserve、fabric-wake 一起跑。

---

## 11. 拆包

### 11.1 文件所有权（同一文件同一时刻只有一个包写；`src/stack.ts`、`src/index.ts` 只属于集成包 XW）

| 文件 / 域                                                                                                                                                                                                                                                                                                                                                                                               | 包  |
| ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --- |
| `src/config/settings.ts`（解析 + `FabricWakeSettings` 注释修正）；新建 `src/fabric/xs/switch.ts`（`xsOn` 纯函数）；`src/web-hub/protocol/messages.ts`（帧联合、decode、`StatusInfo.xs`）+ 新建 `protocol/xs.ts`（帧 schema、cap 常量、截止常量、错误码）；新建 `src/fabric/format-fence.ts` + `src/fabric/wake.ts`（仅把格式化搬到 helper，输出逐字节不变）；`tests/fixtures/fabric-xs-off-golden.json` | XS0 |
| `src/adapters/pi-compat.ts`；新建 `src/fabric/root-wake.ts`、`src/fabric/xs/{wake-ledger,host-cap}.ts`；`src/fabric/wake-input.ts`（抽出 `classifyHumanInput`，行为不变）                                                                                                                                                                                                                               | R1  |
| 新建 `src/fabric/xs/fence.ts`；`src/topic-switch/wire.ts`（只加只读 `fenceActive()`）；`src/goal/hook.ts`（只加只读 getter）                                                                                                                                                                                                                                                                            | T1  |
| 新建 `src/web-hub/hub/xs/{router,members,limits}.ts`；`src/web-hub/hub/{agent-server.ts,registry.ts,hub.ts,main.ts,audit.ts}`                                                                                                                                                                                                                                                                           | X1  |
| 新建 `src/web-hub/agent/xs.ts`；`src/web-hub/agent/{connection.ts,index.ts,command-policy.ts,commands.ts}`（slot、request 重载与截止表、`xs_res`/`xs_deliver` 分支、caps、`buildHubConfig`、`StatusInfo.xs` 投影、exec-claim getter、`fabric` 策略规则、prompt 文本拒绝）                                                                                                                               | X2  |
| 新建 `src/fabric/xs/sender.ts`、`src/tools/{list-sessions-tool.ts,message-session-tool.ts}`                                                                                                                                                                                                                                                                                                             | X3  |
| 新建 `src/fabric/xs/{receiver,inbox,dedup,membership,format}.ts`、`src/commands/fabric-xs.ts`                                                                                                                                                                                                                                                                                                           | X4  |
| `src/stack.ts`、`src/index.ts`（全部装配：Controller、fence 事件转发、`before_agent_start` 账本识别与能力观察、receiver 迟绑定、工具与命令注册、成员 slot 发布）                                                                                                                                                                                                                                        | XW  |
| `src/commands/status.ts`（xs 行读 stack 的 xs 视图，**不改** `wake.ts`）、`src/web-hub/ui/src/components/agents/{AgentCard.vue,agentCardModel.ts}`（徽标）、AGENTS.md                                                                                                                                                                                                                                   | X5  |

### 11.2 包表

| 包                      | 内容                                                                                                                                                                                                                     | 依赖                   | 验收锚点（每包都要求 typecheck、format:check、全量 `npm test`）                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               | 估时 |
| ----------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ---------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---- |
| **XS0** 契约            | **先采集** off golden；设置解析；帧与 reply 关联契约（§8.2）；`StatusInfo.xs`；`xsOn`；format-fence 纯搬移                                                                                                               | —                      | `tests/config/settings-fabric-xs.test.ts`（容错、上下界、`allowFrom` 完整 id 校验、全非法 ⇒ deny-all 标记、未知键、`discoverScope` 不再解析）；`tests/web-hub/protocol/xs-frames.test.ts`（每帧 decode/reject、16 KiB、带 `from.run` 拒绝）；`tests/integration/fabric-xs-off-golden.test.ts`（含 `RESERVED_TOOL_NAMES` 与 slot 序列）；`tests/fabric/format-fence.test.ts` + 现有 wake 格式测试逐字节不变；第一期 `fabric-wake-off-golden` 不变                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              | 1.5d |
| **R1** Controller       | 探针扩展；`root-wake.ts` 全转移表；账本；能力态；`classifyHumanInput`                                                                                                                                                    | XS0                    | `tests/fabric/root-wake.test.ts`（FakeClock，§6.2 表逐行；10s 只告警不改状态；截止从派发起算；`handedOver` 永不 abort；`deferred` 迟到 bound / 过期墓碑 abort；idle 观察兜底；abort 宽限后 `stuck` 不二次 abort）；`tests/fabric/root-wake.property.test.ts`（随机事件序列：同一时刻至多一个被拥有 token；每个占位状态都有定时器或 idle 观察；每个 token 至多一次 abort；`handedOver` 后零 abort）；`tests/fabric/xs-wake-ledger.test.ts`（认领、墓碑、容量、惰性清理）；`tests/fabric/xs-host-cap.test.ts`（**首次启动 `unknown` ⇒ 只投递**、**旧 peer 形状 ⇒ `absent`**、**custom 形状缺失 ⇒ `absent`**、粘滞、跨 reload 保留）；`tests/adapters/pi-compat-trigger.test.ts`                                                                                                                                                                                                                                                                 | 2d   |
| **T1** 栅栏             | `fence.ts`；只读 getter                                                                                                                                                                                                  | XS0                    | `tests/fabric/xs-fence.test.ts`（每个窗口的开/关；D26 延后；**超时只标 stuck 仍拒收**；tree/switch 无事件取消路径靠后续证据关闭；`reset`；端口抛错视为活动；goal ⇒ wakeOnly）                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 | 1d   |
| **X1** hub 中继         | router/members/limits；`agent-server` 分派 + 坏 JSON 日志修复；`registry` 的 `xs_ack` case 与成员事件转发；`hub.ts`/`main.ts`/`audit.ts`                                                                                 | XS0                    | `tests/web-hub/hub/xs-router.test.ts`（list/resolve/send/info；`E_XS_AMBIGUOUS`；origin 不符 ⇒ `E_XS_STALE_ORIGIN`）；`xs-members.test.ts`（session 换 id 作废、detached 作废、reclaim、**session/status 分帧**下旧 joined 不外溢）；`xs-limits.test.ts`（预占/结算/退还矩阵）；`xs-socket.test.ts`（**真实 agent-server socket**：`xs_deliver`→`xs_ack` 往返、迟到 ack 只计数）；`agent-server-log.test.ts`（坏 JSON / 被拒帧 / handler 异常，日志无正文）；`caps-coexist` 更新                                                                                                                                                                                                                                                                                                                                                                                                                                                              | 2d   |
| **X2** agent 连接       | `agent/xs.ts`；`connection.ts`；`agent/index.ts`；`command-policy.ts`；`commands.ts`                                                                                                                                     | XS0                    | `tests/web-hub/agent/xs-client.test.ts`（无 cap ⇒ `E_XS_OFF`；截止表 3s/8s；断链 ⇒ unknown；stale link 不处理 deliver；`xs_deliver` 恰好一次 ack）；`xs-member-slot.test.ts`（slot 顺序在 session 之后、重连重放、xs 关时不发）；`command-policy-fabric.test.ts`（`status`/`blocks` allow，其余 deny）；`commands-prompt-fabric.test.ts`（prompt op `/fabric join` 文本被拒）；`StatusInfo` 关闭时逐字节不变                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  | 1.5d |
| **X3** 发送端与工具     | `sender.ts`（origin 守卫、预检、resolve→send、effect 映射、level 预检）；两个工具                                                                                                                                        | XS0                    | `tests/fabric/xs-sender.test.ts`（**resolve 往返期间 `/new` ⇒ `none{origin_changed}` 且不发 send 帧**；leave 在途；signal abort；8s 客户端截止）；`tests/tools/message-session-tool.test.ts`（保留地址被拒、省略 wake=false、`scope` 参数、结果形状、工具冲突提示）                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           | 1d   |
| **X4** 接收端与加入控制 | receiver 管道；inbox；dedup；membership；`/fabric` 命令                                                                                                                                                                  | R1, T1                 | `tests/fabric/xs-receiver.test.ts`（管道每阶段拒收原因；证据表每行：同步抛错 ⇒ none、leaf 取证 ⇒ applied、流式 ⇒ unknown{queued}、延迟 ⇒ unknown{start_deferred}）；`tests/fabric/xs-truth-table.test.ts`（§4.5 逐行）；`tests/fabric/xs-inbox.test.ts`（释放规则；与树内 `rootInbox()` 交叉独立）；`tests/fabric/xs-dedup.test.ts`（未过期重复、**reload 后重复仍被拦**、满容量拒收）；`tests/fabric/xs-level.test.ts`（§6.6 表）；`tests/commands/fabric-xs.test.ts`（`allowFrom` 完整 id；block 唯一解析；**离线** blocks/unblock；**`webCommandPolicy.fabric:"allow"` 下 web 来源仍不能 join/receive/unblock/fence reset，status 仍可读**；fork 不继承）                                                                                                                                                                                                                                                                                  | 2d   |
| **XW** 集成装配         | `stack.ts`/`index.ts` 全部装配                                                                                                                                                                                           | R1, T1, X1, X2, X3, X4 | `tests/integration/fabric-xs.test.ts`（**真实 hub 子进程 + 两个真实 stack + 真实 socket**：只投递与唤醒、反向回复、栅栏命中、旧对端、hub 重启 ⇒ unknown 且成员表重建、managed rpc restore 后可达、fork 不继承、resolve 期间 `/new`、leave 在途、`/reload` 后认领 Controller 所有权）；`tests/integration/fabric-xs-level-mixed.test.ts`（树内 + 跨会话混合因果链）；`tests/integration/fabric-xs-child-scope.test.ts`（xs off/on 下子会话工具表与 reserved 名单不变；子会话里预置同名 MCP 工具 `message_session` 在 off/on 下都不被剥离；旧专家快照含同名工具时 consult-preserve 不受影响）                                                                                                                                                                                                                                                                                                                                                   | 1.5d |
| **X5** 可观测与终局闸门 | `/agent status` xs 行（`xs joined · recv wake · cap verified · in 3/30h · out 2/60h · wakes 1/12h · fenced 1 · stuck 0 · unbound 0 · lateAbort 0 · abortStuck 0`，只用英文标记）；AgentCard 徽标；AGENTS.md；conformance | XW                     | **C-X1** 真实 pi：custom 触发的 `before_agent_start` 带 `message.details.wakeToken`；`sendMessage(triggerTurn:true)` 同步返回后 `isIdle()===false`；`ctx.abort()` 后有 `agent_settled`。**C-X1b** 真实 pi + 慢 stub：预启动压缩 >10s 后才启动仍被监管并可被截止 abort；压缩中 abort ⇒ 零 provider 请求；`agent_settled` 发射期间派发 ⇒ 延迟启动带 token；启动中人类输入 ⇒ `handedOver` 不被 abort。**C-X2** 压缩 >30s 全程拒收；扩展取消压缩 ⇒ `session_compact_failed` 关窗；`/tree` 取消 ⇒ 直到下一次输入才关窗；切换被取消；慢异步 `session_before_switch`。**C-X3** quiet 与 ask_user 互不干扰。**C-X4** 内存会话的成员资格 durability。**C-X5** provider payload。**C-X6** 第一期 C-P1…C-P5、consult-preserve C1–C7 不回归。**C-X7** 记录 pi 对重名工具的裁决。终局：`npm run format:check && npm run typecheck && npm run build && npm run build:web && npm test && npm run test:conformance`；两份 off golden 不变；新定时器全部 unref | 1d   |

**并行**：XS0 → {R1 ∥ T1 ∥ X1 ∥ X2 ∥ X3} → X4 → XW → X5。核心包只交付纯模块与 fake/真实 socket 级测试，**不碰** `src/stack.ts`/`src/index.ts`；XW 是唯一的装配包，串行。
**规模**：约 13.5 人日（比 r1.1 多出：所有权生命周期与账本、成员 slot 与 origin 校验、设置传输与结算、独立 inbox、命令硬门禁、集成包拆分、更多真实 pi conformance）；关键路径 XS0(1.5) → R1(2) → X4(2) → XW(1.5) → X5(1) ≈ 8 天。新代码约 4–4.5k 行（测试约 60%）。
**车道**：**L3**。每包返回立即派 verifier（验收模型 ≠ 开发模型）；XS0 开工前本文需再过一轮方案评审（r2）。

---

## 12. 风险与明确不做

### 12.1 风险

| #    | 风险                                                              | 处置                                                                                          |
| ---- | ----------------------------------------------------------------- | --------------------------------------------------------------------------------------------- |
| XR1  | pi 的 `before_agent_start` custom 形状或同步启动语义变化          | 能力判定落到 `absent`（只投递）；C-X1/C-X1b 在 peer 升级前必跑                                |
| XR2  | 两个会话互相 `wake:true` 形成循环                                 | 每对 2 次/小时 + maxLevel 2 + 出入站 wake 配额；人类输入才归零                                |
| XR3  | 提示注入                                                          | 不可信头 + nonce；只能发给显式加入的会话；Q10 不回传结果；agent 不能加入                      |
| XR4  | 流式期间入队的消息只在 pi 内存，崩溃会丢                          | 返回 `unknown{queued}` 而不是 `applied`（§6.3）；§14 N2 给出「直接拒收」备选                  |
| XR5  | 同一会话文件被两个 pi 打开                                        | `E_XS_AMBIGUOUS`                                                                              |
| XR6  | 栅栏因无事件取消路径长时间 `stuck`                                | 只拒收不阻塞；后续证据自动清除；`/fabric status` 可见；本地 `/fabric fence reset`             |
| XR7  | restore 出来、从未有 prompt 的 managed rpc 会话能力停在 `unknown` | 只投递仍可用；第一次 web/人类 prompt 后即可唤醒；§14 N1                                       |
| XR8  | hub 重启 ⇒ 在途 unknown                                           | NQ3 交给模型；成员表随 slot 重放自动重建                                                      |
| XR9  | `deferred` 推定归属可能把别的扩展的 custom run 纳入监管           | 只在形状异常时发生且同时降为 `absent`；最坏结果是该 run 受 `rootRunMaxS` 约束（失败关闭方向） |
| XR10 | 主会话已有同名第三方工具                                          | 检测 + 状态提示；C-X7 记录 pi 裁决                                                            |
| XR11 | 第三期子会话注入后 consult-preserve 影子漏项、reserved 名兼容     | 第三期 C9 门禁与 reserved 名兼容说明；本期由 child-scope 测试保证子会话完全不受影响           |

### 12.2 明确不做（本期）

- 跨机器、跨用户、跨 hub；HTTP / LAN / 飞书直接发送。
- 所有子 agent 参与跨会话的形态（第三期）。
- 跨会话 revive / park；自动重试；结果回传；跨会话 `wake_result`。
- web UI 加入/退出开关（P3）。`directive`/`progress` 跨会话（P5）。
- 会话清单注入 system prompt。
- 修改第一期树内语义、outbox、reducer 输入、golden；树内 `rootInboxCap` 计数。
- 为探测主机能力而主动起 run。
- 消除第一期 `/reload` 的 60s 回退（G-report 残留 1）。

### 12.3 第三期（子 agent 参与跨会话）：只列扩展点

| 第三期议题                                   | 本期留的扩展点                                                                                                                                                                      |
| -------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `CanMessage:"session"`、子会话获得跨会话工具 | `CanMessage` 与过滤数组不改；**`list_sessions`/`message_session` 届时才加入 `RESERVED_TOOL_NAMES`**，并附同名工具兼容说明（升级会剥离子会话里的同名第三方工具）与旧专家快照影子处理 |
| 子 run 发往别的会话（`from.run`）            | 帧预留 `run` 字段（本期拒绝）；`sender.ts` 的 `SendOrigin` 判别联合（本期只有 `{kind:"root"}`）                                                                                     |
| 回复给子 run 与回复授权                      | `agentId` 已盖章、进审计；`epoch` 已提供会话代际                                                                                                                                    |
| 别的会话投给某个子 run 的 `toRun` 授权       | receiver 是有序阶段数组，`toRun` 作为新阶段插在栅栏与 level 之间；地址联合 `XsAddress` 本期只有 `{kind:"session"}`                                                                  |
| consult-preserve 影子与 C9                   | `shadow-tools.ts` 本期不改；C9 预留编号                                                                                                                                             |
| 树内 `wake:true` 改走 Controller（P7 备选）  | `RootWakeController.dispatch` 不绑定 xs                                                                                                                                             |

---

## 13. 拍板项（r1.1 原表，已拍板，结果见文末）

r2 对已拍板项的落实说明：P3 的 `StatusInfo.xs` 保留但降为纯展示，权威成员资格改走 `xs_member`（不影响拍板的「只读暴露」）；P6 的「同目录过滤作为可选参数」落实为 `list_sessions{scope}`，删除 `discoverScope` 设置键；P8 数值全部保留，仅把「共享 `rootInboxCap`」改为同默认值的独立 `inboxCap`（评审 #7）。

| #   | 问题                                                | 推荐（放第一位）                                                                                                                | 备选                                                                                                                |
| --- | --------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------- |
| P1  | 加入控制模型（只针对主会话）                        | **A：两层，全部由人控制**（设置 `enabled` + 会话级 `/fabric join` 或 `autoJoin`），默认不加入，agent 不能自己加入；加入即可收发 | B：A + agent 可调用「只退出」工具；C：只有设置（enabled + autoJoin），没有会话级命令；D：拆开「可发送」与「可接收」 |
| P2  | 已加入会话的默认接收策略                            | **保留 Q7 = `wake`**（加入本身已经是显式 opt-in）                                                                               | `deliver`（更保守：加入后默认只投递，需要再 `/fabric receive wake`）                                                |
| P3  | web-hub 暴露程度                                    | **只读**：`StatusInfo.xs` + AgentCard 徽标；`/fabric join` 对 web 为 deny                                                       | 本期加 UI 开关（需要 cap、CSRF、策略）；或完全不暴露                                                                |
| P4  | 工具形态                                            | **新工具** `message_session` + `list_sessions`，只在主会话注册（不动 `message_agent` 及其 golden）                              | 在主会话注册 `message_agent` 并扩展 `to` 支持 `session:…`（引入树内语义，改 schema）                                |
| P5  | 跨会话允许的 kind                                   | **只有 finding 语义**（工具没有 kind 参数）                                                                                     | 允许 directive（无 parent 关系，语义存疑）                                                                          |
| P6  | `list_sessions` 默认范围                            | **`hub`**：所有已加入的会话（加入已经是 opt-in）                                                                                | `cwd`：只列同一目录树                                                                                               |
| P7  | Controller 是否也接管树内显式 `wake:true` 唤醒 root | **本期不接管**：Controller 只服务跨会话，树内保持第一期 legacy（零行为变化，golden 不变）                                       | 本期接管（多一个 900s 上限，Controller 拒绝时退回 legacy；属于对 fabric 用户的行为变化）                            |
| P8  | 新增限额默认值                                      | **按 §5.2 表**（出站 10/min、60/h、wake 6/h；入站 30/h、wake 12/h；每对 30s、wake 2/h；在途 4；全 hub 60/min）                  | 更紧：入站 wake 6/h、每对 wake 1/h                                                                                  |
| P9  | 协议版本                                            | **只加 cap `xs.v1`，不升 PROTO**                                                                                                | 升 minor 到 1.3（与 fleet F0 的先例一致，但 `protoCompatible` 只比较 major，实际没有作用）                          |
| P10 | fork / 复制会话是否继承成员资格                     | **不继承**（读回时校验 sessionId）                                                                                              | 继承                                                                                                                |

---

## 14. r2 新增待拍板项

| #   | 问题                                                                                                                                | 推荐（放第一位）                                                                                                                               | 备选                                                                                                                          |
| --- | ----------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------- |
| N1  | 主机能力为 `unknown`（进程启动后还没见过任何 `before_agent_start`，典型是 restore 出来的 managed rpc）时，跨会话 `wake:true` 怎么办 | **只投递**（`wakeDowngraded:"host_unverified"`；消息照常送达，第一次人类/web prompt 后即可唤醒）——失败关闭，不违反 I14                         | 以 pi 包版本 ≥1.2 作为临时证据直接允许 Controller（对 I14「只做形状探测、不做版本门控」开一个例外；版本号不能证明运行时形状） |
| N2  | 接收方正在流式运行时（pi 只能放进内存队列，无法同步取证）的投递语义                                                                 | **照常投递，返回 `effect:"unknown", reason:"queued"`**，工具说明「已进入对方内存队列、对方下一个 turn 边界可见，不要重发」；对方进程崩溃才会丢 | 直接拒收 `effect:"none", reason:"busy"`，由发送方模型稍后重发（语义最确定，但向忙碌会话发消息几乎总会被弹回）                 |

---

## §13 拍板结果（用户，2026-10-21）

- P1 加入控制：**两层人控**（`fabric.crossSession.enabled` + 会话级 `/fabric join|leave` / `autoJoin`），默认不加入，agent 无权加入或退出。
- P2 加入后默认接收模式：**wake**（可唤醒，受 RootWakeController 900s 与限额约束）。
- P6 发现范围：**hub 上所有已加入会话**（同目录过滤作为可选参数）。
- P3、P4、P5、P7、P8、P9、P10：**全部按推荐**。
