# RXW 报告（reply 装配：RX1–RX5 接进运行时）

基线 HEAD 3ed8c087，未 commit，冻结面与三份 golden 未改。

## 改动清单

- `src/stack.ts`：`buildStackXs` 接入账本 / replyInbox / NoticeGate / due 调度器 / restore；`StackXs.reply`（`StackXsReply`）。
- `src/index.ts`：sender 的 reply 端口、工具实例选择、agent bridge 的 `replyEnabled`、`/fabric` 的 `replies`/`onPolicyChange`、fence 关闭事件 flush。
- `src/web-hub/agent/xs.ts`：仅类型层，删除 `XsPortSendReplyArgs`，并回 `XsPortSendArgs`（行为不变）。
- `tests/integration/fabric-xs-reply.test.ts`（新，15 用例）；helper：`tests/integration/helpers/fabric-xs-{harness,process}.ts`（新增 extraEnv、skew/clearReplyLedger/inject 等 op、inspect 字段，对原有用例无影响）。
- `tests/integration/fabric-xs-activation.test.ts`：原断言「message_session schema 恒为 legacy」在 reply 默认开启后不再成立，改为断言 reply 实例，并新增 `reply.enabled=false ⇒ legacy 字节同一实例` 用例（非计划内文件，属设计后果）。
- 未做：sender `XsSenderReplyDeps.now` 未删（`tests/fabric/xs-sender.test.ts` 仍传入它，删除会破坏该测试；无害）。

## 端口接线位置

| 端口                                                                                                                                                                    | 位置                                  |
| ----------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------- |
| 账本 `bindSession`（replyInbox 经 `createXsReplyInboxPort`、appendIssue/appendSettle sink = `pi.appendEntry("subagent:xs-reply")`，会话/dispose 守卫）/ `unbindSession` | stack.ts `buildStackXs` / `dispose`   |
| `XsReplyDueScheduler`（onDue=flush；appendIssue sink 里 `refresh()`）                                                                                                   | stack.ts                              |
| NoticeGate 端口：session/disposed/joined/`membership.receive`（有效值）/fence 包装/`controller`=RootWakeController 直传/`pi.sendMessage(triggerTurn:false)`             | stack.ts                              |
| receiver `replyLedger`；membership `replyEnabled`；独立 `replyInbox`（`maxPending`，同 run-start/settled/releaseTrigger 生命周期）                                      | stack.ts                              |
| sender `reply{ledger,limits,receivable,inbound}`、`replyCapable`（= web-hub bridge `hubPort().replyCapable`）、工具 `reply: replyEnabled`（activate 冻结）              | index.ts                              |
| bridge `replyEnabled`                                                                                                                                                   | index.ts（`wireWebHub` 的 `xs` 端口） |
| `/fabric replies` / `onPolicyChange`                                                                                                                                    | index.ts `createFabricXsCommand`      |

## NoticeGate flush 调用点

stack 构建 restore（含重启失效扫描、离开期间汇总）；`beforeAgentStart`；`settled`（`agent_settled`）；fence 关闭事件 `session_compact` / `session_compact_failed` / `session_tree`；`session_start`（即 restore）；`/fabric join|receive|fence reset`（`onPolicyChange`）；due 调度器；gate 自带 30s 兜底。

## §12.2 ↔ 测试

1 往返 → `#1`；2 超时 → `#2 quiet/wake`（合并一条）；3 准入 → `#3a` leave / `#3b` compaction / `#3c` before_switch / `#3d` 切走再切回 / `#3e` 离开期间过期汇总；4 replies 模式 → `#4`（hub 早拒 + 注入绕过 hub 被拒 + 有效回复唤醒；replies 成员按设计不在 list）；5 迟到 → `#5`；6 Blocker 反例 → `#6`（`/tree` 后及时钟推进后重复回复仍 none，且非 expired）；7 reload/重启 → `#7`（重启后拒收 + 仅一条失效通知，二次重启不重复）；8 地址固定 → `#8`；9 兼容 → `#9a` 旧 hub 无 cap（expectReply 不发帧、replies 降 off）/ `#9b` 旧收件人 + hub 重启在途回复至多一次。

## 遗留项处置

1. `member().receive` 已是有效值：membership 传入 `replyEnabled`，getter 返回 `effectiveReceive`；stack/gate/Controller 均读有效值（slotFlush 线上兜底保留）。
2. wakeOnly(goal) quiet 的 `verifyDispatch(gen=0)` 噪声：已在 stack 的 fence 包装里修复（记录 begin 时 generation，gen=0 时映射）。
3. release 恢复 timed_out 会重新欠超时通知（通知已发出后 `clearOwed` 删了标记，`release` 的 `noticeOwed ??= "timeout"` 会重欠，可能重复通知）：属 reply-ledger（冻结面），未改。建议后续在 ledger 保留「已通知」标记，或 release 仅在 priorState 为 pending 时补欠。窗口很窄（须是对 timed_out 票消费中、Controller none/宿主抛错导致 release）。
4. NoticeGate 的 controller 直接用 RootWakeController，类型检查通过，无适配层。

- 已知限制：切回会话时汇总若被准入拒绝，不会 `takeDroppedNotices`（计数保留，下次 restore 再试）；集成测试时钟靠 `Date.now` skew，hub 帧 expiresAt 由 hub 实时戳，故 #5 用 inject 绕过帧过期。

## 自验

- 8 个指定集成文件：`Test Files 8 passed (8) · Tests 50 passed (50)`（含三份 off golden）。
- `npx vitest run tests/fabric tests/tools tests/commands tests/web-hub/agent --maxWorkers=2`：`Test Files 155 passed (155) · Tests 2859 passed (2859)`。
- `npm run typecheck`：0 错误。
- `npx prettier --check`（stack/index/xs.ts/新测试/helpers/activation）：All matched files use Prettier code style!
