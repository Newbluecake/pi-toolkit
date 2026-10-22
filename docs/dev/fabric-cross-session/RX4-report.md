RX4 已完成。两个分支都已实现，自验全部通过，没有改冻结面，也没有 commit。

## 改动文件

- `/home/bluecake/ai/pi-toolkit/src/fabric/xs/sender.ts`
- `/home/bluecake/ai/pi-toolkit/src/tools/message-session-tool.ts`
- `/home/bluecake/ai/pi-toolkit/tests/fabric/xs-sender.test.ts`（新增 25 个用例，全文件 66 个）
- `/home/bluecake/ai/pi-toolkit/tests/tools/message-session-tool.test.ts`（新增 7 个用例，全文件 17 个）

## 两个分支流程（`sender.ts` 的 `message()`）

- **前置**：`expectReply` 与 `replyTo` 同时出现，在 resolve 之前本地返回 `bad_args`，不发帧。
- **replyTo**：
  1. 先查 `replyCapable()`，不满足返回 `reply_unsupported`，连 resolve 都不做。
  2. resolve 之后核对 `target.sessionId`，缺失同样 `reply_unsupported`。
  3. `inbound(replyTo)` 命中且来源 sessionId 与 `to` 不一致，返回 `reply_target_mismatch`。查不到则不拦。
  4. send 的 `to` 是完整 sessionId，只带 `replyTo`，不带 `wake` 和 `level`。结果带 `replyTo{requestId, accepted}`，`accepted` 仅在 effect 为 applied 时为 true。
- **expectReply**：
  1. resolve 之后依次核对 `replyCapable()`、`target.sessionId`、`receivable()`。
  2. 做 wake/level 预检和 16KiB 帧预算预检（含 expect 的最坏形状），都通过后才 `ledger.issue()`，所以超限不会留下账本条目。
  3. send 的 `to` 是完整 sessionId，带 `expect{requestId, timeoutMs}`。
  4. 每个返回出口都经过 `withReply` 调一次 `recordSend`：`none` 对应 `send_failed`，`applied` 和 `unknown` 保持 pending。
  5. 返回值带 `reply{requestId, dueAt(ISO), state}`。
- **human 来源**：`wakeOnReply=false`、`requesterLevel=0`，帧上 `level` 为 0。
- **其它**：
  - 返回值的 `to` 只含 `{ref, name}`，不暴露完整 sessionId。
  - send 端口抛异常按 `unknown` 处理，ticket 保持 pending。
  - 普通发送行为不变，仍然发原始 `to`。
  - hub 的 `E_XS_REPLY_UNSUPPORTED` 已加入 `PROVABLE_NONE_CODES`，状态映射为 `reply_unsupported`。

## 拒绝码与对应测试（全部不发 send 帧）

| 码                                                         | 测试名                                                              |
| ---------------------------------------------------------- | ------------------------------------------------------------------- |
| `bad_args`                                                 | `bad_args: expectReply together with replyTo …`                     |
| `reply_unsupported`（端口无 cap）                          | `reply_unsupported: port not capable …`（expect 与 replyTo 各一条） |
| `reply_unsupported`（无 sessionId）                        | `…no sessionId (old peer)…`（expect 与 replyTo 各一条）             |
| `reply_unsupported`（未接 reply deps）                     | `reply_unsupported: no reply deps wired at all`                     |
| `reply_unreceivable`（receive_off / blocked / not_joined） | `reply_unreceivable{%s}`                                            |
| `reply_quota`                                              | `reply_quota: the 4th request …`（reason 为 `per_target`）          |
| `reply_ledger_full`                                        | `reply_ledger_full: …`                                              |
| `reply_target_mismatch`                                    | `reply_target_mismatch: …`                                          |

其它覆盖：

- 地址固定与二次解析：`name rebind after resolve`、`ambiguous short ref`、`target gone between resolve and send`。
- 结果与 origin：send none ⇒ `send_failed`、unknown 保持 pending、origin 在 send 后变化保持 pending、origin 在 resolve 期间变化 ⇒ none 且不签发。
- 其它：`too_large` 不泄漏 ticket、replyTo 带 wake 被忽略、replyTo 的 none 与 unknown。

## 工具 schema 实例选择

- `createMessageSessionTool({sender, reply?})`：`reply === true` 用 `MessageSessionParamsReply`，否则（包括省略）用 `MessageSessionParamsLegacy`。选择函数是 `messageSessionParamsFor(replyEnabled)`。
- legacy 实例的 schema 和 description 与 `fabric-xs-reply-off-golden.json` 逐字节相同，已有断言。旧名 `MessageSessionParams` 保留为 legacy 的别名。
- reply 实例是 legacy 的属性加 `expectReply` 和 `replyTo`，description 另写。
- legacy 实例下，即使有人传入新字段，工具也不会转发给 sender。
- 提示文本：
  - expect 成功：`已登记期待回复 q…，截止 …，无需轮询…`。
  - replyTo 为 unknown：幂等重发提示。
  - replyTo 为 none 且 reason 是 `rejected`：不要再重发。
  - 普通 unknown：沿用原提示。

## 给 RXW 的装配端口

1. `XsSenderDeps.reply?: XsSenderReplyDeps`，仅在 `reply.enabled` 时接线：
   - `ledger`：`getXsReplyLedger()`，只用 `issue` 和 `recordSend`。
   - 设置值来自 `fabric.crossSession.reply`：`defaultTimeoutS`、`maxTimeoutS`、`lateGraceS`、`maxPending`、`maxPendingPerTarget`。
   - `receivable(targetSessionId)` 返回 `"ok" | "receive_off" | "blocked" | "not_joined"`：用本 stack 的 membership 判断 joined、`effectiveReceive` 是否为 off，并调用 `senderAllowed(target)`。
   - `inbound(requestId)` 返回 `{fromSessionId} | undefined`：从后往前扫 `getBranch()` 里 `customType:"subagent:xs"` 且 `details.reply.requestId` 匹配的条目，最多 2000 条。`fromSessionId` 取该条目的 `details.from.sessionId`。
2. **replyCapable 来源**：`XsHubPort` 新增可选方法 `replyCapable?()`，直接传 RX3 的 `bridge.hubPort()`（`XsReplyHubPort`），不需要额外接线。`XsPortSendArgs` 已加 `expect?` 和 `replyTo?`，所以 RX3 的 `XsPortSendReplyArgs` 现在是自身的结构子类型。
3. **工具**：`createMessageSessionTool({ sender, reply: <activate 时冻结的 reply.enabled> })`。
4. **@session（M/MW 包）**：调用 `sender.message({ origin:"human", levelOverride:0, wake:true, expectReply:{…} })`。这两个字段只能由代码传入，工具参数里没有。

## 自验结果

- 定向 5 个文件：`Test Files 5 passed (5)`，`Tests 91 passed (91)`。其中含两份 off golden（reply-off 和 off）和 `xs-tool-cancel`。
- `npx vitest run tests/fabric tests/tools --maxWorkers=2`：`Test Files 60 passed (60)`，`Tests 1118 passed (1118)`。
  - 第一次跑出现过 2 个失败，来自并行 RX5 在途改动，重跑后全绿。
- `npm run typecheck`：无输出，全仓 0 错误。
- `npx prettier --check` 四个改动文件：`All matched files use Prettier code style!`

## 未决事项

1. `expectReply.timeoutS` 超过 `maxTimeoutS` 时按上限截断而不是拒绝，`dueAt` 如实反映。若希望拒绝，需要改一行。
2. `replyTo.accepted` 在 unknown 时为 false，是否到达以 `effect` 和提示文本为准。
3. `XsSenderReplyDeps.now` 目前未使用，账本用自己的时钟，可由 RXW 决定是否删掉。
4. 测试里的 `makeReplyHarness` 内部带有一个未使用的 `makeHarness`，写法笨拙，功能无影响。
