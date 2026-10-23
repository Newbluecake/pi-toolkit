# fabric 二期 XW：集成装配报告

状态：**实施与自验完成，待独立 verifier / X5 终局闸门**。基线为隔离 worktree 的最新 dev HEAD（XS0/R1/T1/X3/X4/X1/X2 已合入）。依据 `phase2-plan.md` §10、§11.1/§11.2、§13/§14 拍板及优先级最高的 r3 裁定；逐条消费各包报告的 XW 接缝说明。2026-10-21。

## 文件范围

生产源码**只修改**：

- `src/stack.ts`：每 stack 的 membership / inbox / receiver / fence / Controller 装配；`Stack.xs` 与 recovery-only 监管端口。
- `src/index.ts`：activate 冻结门控；两个工具、`/fabric` 命令；X2 late-bound 端口；pi 生命周期事件转发。

新增：

- `tests/integration/fabric-xs.test.ts`：真实 hub 子进程 × 两个真实 activate/buildSessionStack 子进程 × Unix socket。
- `tests/integration/fabric-xs-level-mixed.test.ts`：真实树内 mailbox 与跨会话组成的混合 level 链。
- `tests/integration/fabric-xs-child-scope.test.ts`：子会话工具面 / reserved / 同名 MCP / 历史 consult 声明。
- `tests/integration/fabric-xs-lifecycle.test.ts`：teardown、stuck settle、关闭设置后的监管、RPC 文件恢复、off orphan。
- `tests/integration/fabric-xs-activation.test.ts`：四开关门控、工具 schema 不随 wake 改变、activate 后设置编辑不改变工具表。
- `tests/integration/helpers/fabric-xs-{harness,process}.ts`：有界 IPC、进程清理、真实 SessionManager 文件与可控 pi 宿主；无生产测试开关。
- 本报告。

未修改其他包的源码、协议、设置解析、保留工具名或两份 golden；未运行全量 `npm test`。

## 装配点

1. **门控**：`xsOn({fabric, webHub:{enabled, control:control !== false}})` 在 activate 冻结；stack 使用同一份 activate 捕获的 settings。仅 post-guard 注册 `list_sessions`、`message_session`、`/fabric`。`deps.xs` 仅在开启时传给 `wireWebHub`；关闭时无 xs 工具、cap、slot、HubConfig 键、StatusInfo 字段或 membership entry。
2. **接收链**：membership attach → `getBranch()` restore → inbox / fence / receiver → Controller → `receiver.setController()` / `recover()`。host 方法全部用闭包包装 ctx/pi，leaf/xid 证据来自真实 session tree。每次 deliver 仍完全同步，由原 X4 负责取证、dedup settle 与 verdict，X2 负责恰好一次 ack。
3. **成员发布**：membership persist 最佳努力 append `subagent:xs-membership` 后调用 X2 `publishMember()`，覆盖 join / leave / receive / blocklist 变动。旧 stack 的 persist 在 dispose 或身份变化后不再写当前会话。attach / reconnect 的 session→xs 顺序继续由 X2 管理。显式持久化 leave 胜过 autoJoin；fork / 不同 id 的复制不继承加入。
4. **发送链**：两个 X3 工具共用 sender；hub list/resolve/send 始终读取当前 `webHubRef`；origin 始终读取当前 attached stack 的 sessionId/epoch；level 接当前树内 `CausalLevel`。shutdown 或正在 rebuild 时 origin 为 undefined，resolve 期间切换不会发出 send。
5. **栅栏**：早于其他异步 mutation hook 注册并转发 `session_before_compact` / `session_compact` / `session_compact_failed` / `session_before_tree` / `session_tree` / `session_before_switch` / `session_before_fork`；shutdown 转发到旧 fence，新 stack 收到 `session_start`。live getter 分别接 X2 `webExecBusy()`、topic-switch `fenceActive()`、goal hook `goalBusy()`。Controller guard 在同一同步派发块末端复核身份与 fence。
6. **监管事件**：`before_agent_start` 调当前 Controller，或独立 `observeRootWakeTrigger`（不双调）；没有 owner 的 pre-stack 窗口撤销未监管授权，标记 trigger 必须走 B1。`input` 在 mention/topic-switch 之前转发 human handover，不增加 root reset 点；`agent_settled` 转发 Controller 与 inbox。
7. **状态面**：`/fabric status` 注入 capability、controller、inbox、入站/唤醒配额、receiver counters、audit counters、hub 有效限额与 local 差异、可检测工具冲突。hubInfo 等待沿 X2 的 3s 截止；mutation 仍直接调用 X4 第一行的 web 硬门禁。
8. **清理与零 hang**：旧 owner 在新 `recover()` 之前 dispose；正常 shutdown 与 defensive session_start 双路径清理；没有新增生产 timer 或 bus subscription。Controller/fence 的 timer 继续使用 unref 的 `systemClock`。Controller 的 fallback idle/deferred 到期后，trigger inbox 在下一次 ingress / start / settled 前惰性回收，不新增轮询。

## R1 minor 与额外关闭边界

- **teardown 的证据**：真实 pi 的 `teardownCurrent` 先 abort 出站 AgentSession，再发 `session_shutdown{new|resume|fork}`；这些 reason 与 quit 调 `ledger.teardown(outgoingSessionId)`。防御性 session_start 看见不同 sessionId 时也 teardown 旧 id。**reload 不是 teardown 证据**：只 dispose lease/timer，账本保留，新 Controller 显式 recover。
- **容量回归**：8 条 deferred 墓碑经 reload 仍是 8；new / resume / fork 后为 0，并可再次放入 8 条；quit 后为 0。
- **stuck 离开**：实际 recover 已超过 abort grace 的记录使 Controller 为 stuck；`agent_settled` 使其 idle、释放 owner/ledger，且没有第二次 abort。
- **设置关掉的 reload**：发现只保留 B1 hook 不够——live token 在 deadline 前仍可能被授权但无人监管。consult 方案作者确认 XI2 意图后，补上 **recovery-only Controller**：新派发始终关闭，未执行授权转墓碑；已启动 run 继续按原绝对 deadline 被认领、handover/abort/settled。xs-off 时仍无工具/cap/slot；wake-off 时 receiver 仍按 X4 降级。两种关闭均有实际 owner/deadline 断言。

## 集成测试取证

真实部分：`startHub`、registry / relay / member slots / quota / socket server、X2 connection / bridge、两端 `activate()` 与 `buildSessionStack()`、SessionManager JSONL。

fake 部分：pi 宿主的 send/idle/abort/provider；hub 的 HTTP frontend 用最小实现（xs 不依赖 HTTP）。不发外网请求、不使用用户凭据。

| 场景                         | 真实断言                                                                                                                                                                                 |
| ---------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| A/B join → list → send       | A 列出 B；只投递 leaf 证据为 applied；N1 初次 unknown host 降级；观察形状后 wake applied，专用标记与 Controller owner 存在；反向回复可达                                                 |
| 忙碌 / goal / mutation fence | streaming 为 unknown/queued 且内存队列计数增加；goal 为 applied + goal downgrade，无 trigger；compaction/switch 为 none/fenced，消息数不变；input 不开 switch fence；compact_failed 开窗 |
| 未加入 / leave / fork        | 未加入不列出且 no_target；已经盖章、暂停在途的 deliver 在 leave 后被本地拒收且零写入；fork 不继承成员资格                                                                                |
| resolve 期间 /new            | 保留真实 resolve 往返后再切换；结果 none/origin_changed；hub 收到的 send/deliver 数为 0                                                                                                  |
| /reload ownership / dedup    | owner 被重新认领、原 deadline 不延长；hub 经新 socket 重放同 xid，回首次 applied ack，实际消息数始终为 1                                                                                 |
| hub death / restart          | 接收端已 ack 而响应尚未返回时杀 hub，发送方为 unknown/link_lost；重启后 member slots 自动重建；不重发旧消息；新显式消息只新增一条                                                        |
| 旧能力对端 / hub             | 无 xs cap 的对端不可见/不可达；无 xs cap 的 hub 返回 off，不发送                                                                                                                         |
| RPC 进程恢复                 | 同一 JSONL 在新 RPC 宿主进程打开，sessionId 不变、agentKey 改变、加入资格从磁盘恢复，capability 重新 unknown，仍可达且 wake 降级                                                         |
| 混合链                       | 树内 pending mailbox L1→A L2；xs 真 wake →B L3；树内只投递 carry L4；xs 真 wake →A L5；再发送为 level_limit/carry；extension input 不归零，human input 归零                              |
| 子会话 / consult             | xs off/on 注册表与 reserved 相同；同名 MCP 工具在 bind/turn refresh 都保留；历史专家同名声明未重写/未 shadow，readonly guard 仍阻止其执行                                                |
| shutdown                     | 两端 quit 后 bus listeners=0、ledger=0；所有测试子进程在有界清理后退出                                                                                                                   |

**栅栏口径**：请求中的「栅栏期间只投递不唤醒」仅适用于 goal 的 wake-only fence。T1 / r3 M1 明确规定 compaction/tree/switch/web_exec/topic_switch 拒收；XW 没有把这些窗口改成可投递。

## 自验输出

全部命令均带 timeout，全部 exit 0：

```text
timeout 600 npx vitest run tests/fabric tests/integration/fabric* tests/web-hub/agent
→ Test Files 116 passed (116)
→ Tests      1891 passed (1891)
→ Duration   48.77s

# 其中新增 XW 锚点（已包含于上述范围）
# fabric-xs.test.ts:             5 passed
# fabric-xs-level-mixed:         1 passed
# fabric-xs-child-scope:         5 passed
# fabric-xs-lifecycle:           8 passed
# fabric-xs-activation:          6 passed
# 两份 off-golden:              各 2 passed；fixture 未变

timeout 240 npm run typecheck
→ tsc main + tsc typecheck contracts + vue-tsc，0 error

timeout 240 npm run build
→ tsc -p tsconfig.build.json，exit 0

timeout 120 npm run format:check
→ All matched files use Prettier code style!

git diff --check
→ exit 0
```

依赖安装：`timeout 180 npm ci --ignore-scripts`，lock 未改。Node 22.22.1 下 transitive abbrev/nopt 提示要求 22.22.2 的 engine WARN；构建/类型/测试无失败。回归 stderr 中既有 quota missing-credential 与 fabric persistence 审计是原测试的预期输出。

## 偏差 / 给 X5 的说明

1. **独立验收与真实 pi 仍未代替**：本包提供实现自验，不自称 verifier 通过。C-X1…C-X7 的真实 AgentSession/provider、慢启动压缩、真实 abort、payload 无 token、ask_user quiet、真实 peer 重名裁决，以及第一期 conformance/consult-preserve 全闸门仍归 X5。终局全量测试也归 X5；本包按要求未跑全量 npm test。
2. **RPC 恢复覆盖的边界**：验证的是新 RPC 宿主进程打开同一文件的 xs 恢复语义，不是重新运行 managed-spawn supervisor 的整个 kill-old/restore 生命周期；后者继续依赖现有 spawn-restore gate 与 X5 集成。
3. **reload fixture 的边界**：相同 agent 进程中销毁旧 activation 事件表，再真实 activate/build 新 stack，并强制新 socket；证明跨 activation 的进程级 ledger/dedup/epoch/能力态。它不是 jiti 本身的 module-cache 验证，真实 `/reload` 留给 conformance。
4. **可观测端口**：X5 可直接读取 `stack.xs.receiver.countersSnapshot()`、`wakeQuota()`、`fence.status()`、`controller.state`、`audit`、`inbox.occupied` 与 `getXsHostCapability().state`。`stack.rootWakeRecovery` 只在关闭设置但尚有旧授权时出现，不可用来新派发。
5. **工具冲突残留**：session_start 排除本包自己的 schema 后检测外来同名声明；宿主已合并掉的同 schema 重名无法检测。方案作者确认这只是提示、不是安全边界，C-X7 记录实际裁决。
6. **前包遗留未越界修复**：XS0 的 setting-specs 登记仍未补（不属于 XW 文件域）；X2 的 block ref→full-id 缺口沿用其报告；另发现 X3 两个工具的 execute 没有把第三参数 AbortSignal 传给 sender（sender 自身有 signal 守卫）。本包未改 X3 工厂或协议；已告知主会话，X5/集中修订可处理取消语义。本包已证明会话/epoch origin 守卫，不声称工具取消守卫被覆盖。
