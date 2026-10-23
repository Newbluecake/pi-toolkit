实施完成，全部自验通过。以下为交付报告。

## RX1 交付报告（回复凭证账本 + 超时通知核心）

### 文件清单（全部新建，冻结面零改动）

| 文件                                                                         | 行数 | 内容                                                                                                 |
| ---------------------------------------------------------------------------- | ---- | ---------------------------------------------------------------------------------------------------- |
| `/home/bluecake/ai/pi-toolkit/src/fabric/xs/reply-ledger.ts`                 | 874  | 凭证账本（状态机、sweep、配额、replyInbox 端口、§3.3 持久化记录、重启失效规划、due 调度器），pi-free |
| `/home/bluecake/ai/pi-toolkit/src/fabric/xs/reply-notice.ts`                 | 350  | NoticeGate（§7.2 准入 + 30s 兜底重试 + 三类通知文案），pi-free                                       |
| `/home/bluecake/ai/pi-toolkit/tests/fabric/xs-reply-ledger.test.ts`          | 666  | 28 测试：状态表逐行、sweep、配额、Blocker 反例、调度器、§12.1 pi-free source-scan 门禁               |
| `/home/bluecake/ai/pi-toolkit/tests/fabric/xs-reply-ledger.property.test.ts` | 291  | 2 性质测试（fast-check，120/200 runs）：§6.3 不变量                                                  |
| `/home/bluecake/ai/pi-toolkit/tests/fabric/xs-reply-notice.test.ts`          | 399  | 17 测试：准入矩阵、唤醒/静默路径、NQ3、合并、lateUntil 丢弃、文案                                    |

### 导出 API（供 RX4/RX5/RXW）

**RX4 发送端用**：`XsReplyLedger.issue(input)` — canIssue 合并为一次调用（先 sweep 自愈，再查 per-target/per-session 配额含 replyInbox 占用、64 槽位），返回 `{ok,ticket}` 或 `{ok:false,code:"reply_quota"|"reply_ledger_full",perTarget?}`；`recordSend(requestId, "applied"|"none"|"unknown")` — none ⇒ send_failed（立即可淘汰）。

**RX5 接收端用**：`classify(inReplyTo, fromSessionId, requesterSessionId, now?)` — 先 sweep，返回 `unsolicited | reply | late | invalid{reason}`（consuming/墓碑/查无/换绑 replier 一律 invalid）；`reserve(requestId, xid)` — 任何宿主调用之前，consuming + priorState + replyInbox 预占（满载 ⇒ `{ok:false,reason:"inbox_full"}` 计异常、票不动）；`commit(requestId, mode)` — 永远落墓碑（priorState=timed_out ⇒ late_replied，并清 noticeOwed），返回 false 仅表示 inbox 异常；`release(requestId)` — 恢复 priorState 并即时按时间归一（过期即删 + dropped 计数）。

**RXW 装配用**：`getXsReplyLedger()`（`Symbol.for("pi-subagent:xs-reply-ledger")`，跨 /reload 保留）；`bindSession({sessionId, inbox?, appendIssue?, appendSettle?})` / `unbindSession`（appendEntry sink 为 best-effort，抛错不影响可接收性）；`createXsReplyInboxPort(inbox)` — 在不改 XsInbox 的前提下实现预占协议（预占不是 entry，配额公式不重复计数）；`XsReplyDueScheduler`（每 stack 一个定时器，本会话最早 dueAt，触发先 sweep 再 onDue，RXW 把 onDue 接 `gate.flush()`）；`XsReplyNoticeGate{flush, emitQuiet, emitDroppedSummary, status, dispose}`；`markRestartScanned(sessionId)`（每进程×每会话恰好一次返回 true）+ `parseXsReplyEntry(raw, currentSession)`（容错 + fork 过滤）+ `planReplyRestartInvalidation(records, ledger, now)`（≤16 条 + 「另有 N 条」，settle 覆盖全部未结算含已过期）+ `buildInvalidationNoticeContent`；`stats(sessionId)` / `repliesView(sessionId)`（§8.3 可见性：pending/inbox/timedOut/late/rejected/owed/dropped/ledger/anomaly）；`owedNotices` / `clearOwed` / `droppedNoticeCount` / `takeDroppedNotices`（切回汇总读清零）；`buildReplyIssueEntry` / `buildReplySettleEntry`。

**NoticeGate 端口**：`getSessionId/disposed/joined/receive/fence{beginDispatch,verifyDispatch}/controller.dispatch/host.sendMessage`，controller 请求为 `{xid:"t_"+requestId, from:{kind:"local",reason:"reply_timeout"}, solicited:true, returnLevel(=min), expiresAt:now+5s}`（RX5 给 RootWakeController 加 `solicited`/`returnLevel` 后做适配）；唤醒不满足 ⇒ 静默写 `customType:"subagent:xs-reply", display:true, triggerTurn:false`；栅栏命中（含 wakeOnly 之外的拒绝）双路皆禁（r2 #2），30s 兜底重试到 lateUntil 由 ledger sweep 自然终止。

### §3.4 状态表 ↔ 代码对应

| 状态                 | 可接收                                      | 占配额（`QUOTA_STATES`）          | 可淘汰                                              | 转移实现                                                                         |
| -------------------- | ------------------------------------------- | --------------------------------- | --------------------------------------------------- | -------------------------------------------------------------------------------- |
| pending              | classify `reply`（now<dueAt）               | 是                                | 否                                                  | sweep dueAt⇒timed_out+noticeOwed；reserve⇒consuming；recordSend none⇒send_failed |
| consuming            | 否（classify invalid{state}，同步重入同拒） | 是                                | 否（sweep 跳过）                                    | commit⇒replied/late_replied；release⇒priorState（含时间归一）                    |
| timed_out            | classify `late`（now<lateUntil）            | 是                                | lateUntil 删除（删时 owed 未发 ⇒ droppedNotices++） | reserve⇒consuming                                                                |
| replied/late_replied | 否（墓碑）                                  | 否（改由 replyInbox occupied 占） | now≥lateUntil 删除                                  | —（终态不可逆）                                                                  |
| send_failed          | 否                                          | 否                                | sweep 立即删                                        | —                                                                                |

进程槽位 64 满载：issue 内先 sweep 一次，仍满 ⇒ `reply_ledger_full` 拒签不淘汰（测试 9 会话×8 验证 + 过期自愈）；droppedNotices/rejected 均 32 会话 FIFO；「切回旧会话」由 RXW 在 restore 时调 sweep→gate.flush→`takeDroppedNotices`>0 时 `emitDroppedSummary`。

### Blocker 反例（r2 #1）测试名

- `branch rollback: consumption on branch X, back to branch Y, duplicate reply ⇒ refused (no branch awareness at all)` — 账本为进程内存，无任何分支维度可回退，墓碑权威。
- `tombstone eviction revival: after lateUntil deletion the id is simply unknown ⇒ refused`
- `process restart: empty ledger refuses every old id and the §3.3 scan yields ONE invalidation notice`
- `appendEntry failure: receivability unaffected; the restart notice is simply missing`
- 性质测试 `at-most-one possibly-effective dispatch per requestId; …`（120 runs × ≤200 随机事件：重复回复、同步重入、Controller none/downgrade/applied/deferred、宿主抛错、派发前后异常、栅栏拒绝、sweep 时点、/reload（账本存活+inbox 重建）、进程重启）及 `terminal states are one-way …`（200 runs）。

### 自验输出（真实尾部）

```
$ npx vitest run tests/fabric/xs-reply-ledger.test.ts tests/fabric/xs-reply-ledger.property.test.ts tests/fabric/xs-reply-notice.test.ts
 ✓ tests/fabric/xs-reply-notice.test.ts (17 tests) 20ms
 ✓ tests/fabric/xs-reply-ledger.test.ts (28 tests) 38ms
 ✓ tests/fabric/xs-reply-ledger.property.test.ts (2 tests) 155ms
 Test Files  3 passed (3)
      Tests  47 passed (47)

$ npm run typecheck
> tsc --noEmit -p tsconfig.json && tsc --noEmit -p tsconfig.typecheck.json && vue-tsc --noEmit -p src/web-hub/ui/tsconfig.json
（无输出 = 全仓 0 错误，含并行包在途改动）

$ npx prettier --check <5 个新建文件>
All matched files use Prettier code style!

$ npx vitest run tests/fabric/   （回归）
 Test Files  …  Tests  479 passed (479)
（另：tests/web-hub/protocol/ 70 文件 1925 通过）
```

### 未决事项（不阻塞，供 RXW/RX5 注意）

1. **Symbol key 命名差异**：plan §3.3 写 `Symbol.for("pi-subagent:xs-reply-tickets")`，派工指令写 `pi-subagent:xs-reply-ledger`（照抄 wake-ledger 先例）——按指令执行；纯内部 key 非线上契约，RXW 只用 `getXsReplyLedger()`，无下游影响。
2. `canIssue` 未作为独立 API，合并进 `issue()` 的返回码（`reply_quota{perTarget?}` / `reply_ledger_full`）——RX4 一次调用即得结果；如需纯查询可后续拆分。
3. NoticeGate 的 controller 端口是 `RootWakeDispatchResult` 的 pi-free 结构镜像；RX5 落地 §6.5（`solicited`/`returnLevel`）后需写适配层。
4. §7.2 的事件驱动重试点（restore/beforeAgentStart/settled/fence 关闭事件//fabric join 等）全部是 RXW 对 `gate.flush()` 的调用点，gate 只拥有 30s 兜底定时器。
5. 工作区中 `src/mention/*`、`src/web-hub/agent/commands.ts`、`src/fabric/xs/directory.ts` 等为并行 M 包的在途改动，未触碰；最终全量 typecheck 当时无错误。
