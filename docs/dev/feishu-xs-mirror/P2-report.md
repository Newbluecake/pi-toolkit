# P2 报告：xs 观测点（feishu-xs-mirror）

## 改动

- `src/web-hub/hub/xs/mirror.ts`（新）：`XsQuietDelivered`、`XsQuietObserver`、`XS_MIRROR_QUEUED=true`、`quietVerdict`、`emitQuiet`（缺省/空 ⇒ 不排微任务；`queueMicrotask`；每个 observer 调用 try/catch，仅 `log.warn("xs mirror observer failed",{code:"E_XS_MIRROR"})`）。
- `router.ts`：`XsRouterDeps.onQuietDelivered?`；`createXsRelay` 透传；broadcast deps 透传；send 的 `ack.xid===xid` 分支在 `settleOut` 之后 `quietVerdict` 命中则 `emitQuiet`。
- `broadcast.ts`：`XsBroadcastDeps.onQuietDelivered?`；逐行 `build()` 结果复用于 request 与候选；逐行 `.then` 只往局部 `quiet[]` push；聚合 `.then` 末尾（releaseSlot→res→auditLine 之后）与 `.catch` 末尾（releaseSlot→res→warn 之后）各一次 `emitQuiet`。
- 未传 observer：只多 `undefined` 判断，不构造事件、不排微任务。hub 未 import `src/fabric/**`。

## 真值表 ↔ 测试（`xs-mirror-tap.test.ts`）

| §3.2 行                                                       | 判定                                                                                                                                                                           | 测试                                                                                   |
| ------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | -------------------------------------------------------------------------------------- |
| woke:true                                                     | 否                                                                                                                                                                             | verdict 表（含 `unknown{queued}+woke`、`start_deferred`）；send「woke:true」；广播混合 |
| applied/woke:false 无 reason                                  | 是                                                                                                                                                                             | verdict；send 字段；广播                                                               |
| applied+reply_late                                            | 是 late                                                                                                                                                                        | verdict；send reply late                                                               |
| unknown{queued}                                               | 是 queued                                                                                                                                                                      | verdict；send message/reply；广播 queued 行                                            |
| accept_unverified / receiver_error / none                     | 否                                                                                                                                                                             | verdict；send it.each；广播混合                                                        |
| 非 token reason                                               | 否                                                                                                                                                                             | verdict（applied/unknown 各一）                                                        |
| deadline / ack_mismatch / 超时后迟到 ack / 重复 ack           | 否                                                                                                                                                                             | send 专项用例                                                                          |
| wakeDowngraded 来源                                           | ack / admit(outbound_wake_rate) / row(pair_wake_rate) / step1(sender_wake_disabled, level_limit) / admit whole(broadcast_wake_fanout, broadcast_wake_rate, outbound_wake_rate) | send 与广播各用例                                                                      |
| 广播 partial 仍镜像成功行；ambiguous 行不观测；`channel` 正确 |                                                                                                                                                                                | 广播混合                                                                               |

## 时序保证

- send：observer 在 `settleOut`（res+audit）之后，且 `queueMicrotask` 推迟（测试：order `res → observer`，audit 行已存在）。
- 广播：order `slot → res → observer`，聚合 audit 已写；`.catch` 分支（以 broadcast 聚合 audit 抛错模拟）order `slot → res-ok → res-E_XS_INTERNAL → warn → observer`。（`res-ok` 先于 internal 是既有行为：audit 在 res 之后抛。未改动。）
- observer-on / off / 抛错：`xs_deliver` 帧、sender `xs_res`、审计行、limits 快照（rid/xid 归一化后）逐字节相同（send 与广播各一）。

## 偏离

无。注：`tests/web-hub/hub/xs-fixtures.ts` 的 rig 没有 observer 注入口且不在文件域，测试内自带等价 `mrig`。

## 自验输出（尾部）

- `npx vitest run tests/web-hub/hub tests/web-hub/boundary.test.ts --maxWorkers=3`：Test Files 195 passed (195)，Tests 4686 passed (4686)（含 xs-router-v071-diff、xs-router/broadcast/alias-router、新增 39 项）。
- 三份 off golden（`tests/integration/fabric-{xs,wake,xs-reply}-off-golden.test.ts`）：3 files / 6 tests passed。
- `npx tsc --noEmit -p tsconfig.json`：无输出（通过）。
- `npx prettier --check` 四个改动文件：All matched files use Prettier code style!
