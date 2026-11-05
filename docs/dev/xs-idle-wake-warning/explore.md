# #20 xs 错配警告 · 代码探索结论

> 来源：Explore run r_XCJXF1GT（deepseek-flash，只读，2026-11-05），由主会话落盘。行号以 2026-11-05 dev（v0.10.6 / f86860e4）为准。

## 需求（来自 brain 会话委派，2026-11-05 用户经 ask_user 确认接下，含超时区分）

1. `message_session` 在「expectReply 已设 ∧ 实际 wake=false（显式或省略后的默认）∧ 发送时目标会话 idle」时，工具结果附 warning，不阻断发送；文案提示该组合大概率超时，补救是 `wake_session` 激活这条已送达的请求（未送达时才考虑 `wake:true` 重发）。
2. 不误报：可信人类代发默认升级 wake 的路径不出 warning；已有 `wakeDowngraded` 显式原因时不重复。
3. 超时通知区分「停在 delivered（对方没处理）」与「停在 started（处理了没回）」——现状**完全没有区分**，需补。

## 1. 结果组装 / wakeDowngraded / 默认 wake

- 结果唯一出口：`src/tools/message-session-tool.ts:164-191`；`:191` 结果 = `JSON.stringify(outcome) + hint`，`details: outcome`。hint 依次追加（`:179-190`）；唯一的降级中文提示 `xsWakeDowngradedHint` `:196-200`，门控 `deps.activation === true && outcome.wakeDowngraded`（`:189-190`）。
- `wakeDowngraded` 字段 `src/fabric/xs/sender.ts:180`；本地降级 `localDowngrade` `sender.ts:647-651`（`sender_wake_disabled` / `level_limit`）+ hub/receiver 回包；落盘 `sender.ts:801-810`（sent 分支），统一装饰 `sender.ts:722-736`。
- 默认 wake：`sender.ts:621` stateNegotiated（三端 `xs.state.v1`）；`:624-626` defaultCandidate（仅显式省略 wake）；`:643` humanGrants.reserve；`:644-645` `defaulted` / `wantWake`。
- 判据：「已带 wake 不算错配」⇔ `wantWake === true`（含 `outcome.wake?.defaulted === true`）；「降级已有原因」⇔ `outcome.wakeDowngraded !== undefined` 或 `localDowngrade !== undefined`。

## 2. 发送时目标 idle 信息

- busy 单一来源：`src/web-hub/agent/status.ts:57`（`!ctx.isIdle()`）→ status 槽帧（`agent/index.ts:1051`，事件驱动 `:580/:1937`）→ hub `registry.ts:518-522` / `xsView().busy` `:306-320` → `xs/members.ts:262,362` → list_sessions `router.ts:748`。
- 发送路径**目前没有** busy：resolve/send 的 target 只有 `ref/alias/name`（`router.ts:231-236`）+ `sessionId`（`router.ts:524-529` `targetOf`）+ `xsState`（`router.ts:778-782`）；agent 侧只提 `targetState`（`agent/xs.ts:1374-1375`）。
- 推荐取数：复用 `sender.ts:533` 已有的那一次 resolve，在 hub `targetOf` 追加 `busy`（门控同 `xsState`：仅 state-capable 请求方，`router.ts:212` `stateCapable`）；`xs_res.target` 是 `additionalProperties:true`（`protocol/xs.ts:572`）⇒ 只追加、无 PROTO bump。**不要**新加 `list` 往返（`list`/`resolve` 共享 `listPerMin` 6/min，`xs/limits.ts:162-163,251`）。
- 新鲜度：事件即时推送，同机毫秒级；目标卡死时值冻结；resolve→send 存在竞态；`busy=false` 不含 `pending`（`status.ts:57-58`）。⇒ 只能 warning，绝不阻断。
- 备选 `StackXs.directory`（`fabric/xs/stack.ts:664-675`）staleMs 10min，新鲜度不足，不用。

## 3. 超时通知

- 生成：`src/fabric/xs/reply-notice.ts:317-341` `buildTimeoutNoticeContent`；flush `:130-199`（NoticeGate 的 checks+write 是**无 await 的单一同步块**，`:13-25`，不可做 hub receipt 往返）。同族：invalidation `:344-357`、dropped summary `:360-364`。
- ticket（`reply-ledger.ts:73-98`）只有 `state/sendEffect`，无 phase、无 messageId。
- 超时那一刻可取进度：bridge 的 source mirror `src/web-hub/agent/xs.ts:535`（`XsProgressBag`，行含 `requestId` + `phase/queuedAt/deliveredAt/startedAt`，`progress.ts:117-133`；按 requestId 遍历的先例 `agent/xs.ts:590-596`），仅三端 `xs.state.v1` 时存在。
- 接入：`XsReplyNoticePorts`（`reply-notice.ts:58-98`）加可选 `progressOf(requestId)`；照 `listRows` 晚绑定姿势（`stack.ts:52-56`、`activate.ts:663-666`）从 bridge 注入；`stack.ts:561` 构造 gate 时塞入。已知 phase 才在行尾追加英文 token（如 `· delivered (not started)` / `· started`），未知 ⇒ 逐字节原样。按 requestId 查 mirror 无需改 ledger。

## 4. 钉住面

- A 级 off golden 都**不钉**工具结果字节与通知文本：`fabric-xs-off-golden.json`（工具表/schema/wiring）、`fabric-wake-off-golden.json`（message_agent）、`fabric-xs-reply-off-golden.json`（message_session LEGACY schema + description，`tests/tools/message-session-tool.test.ts:181-212` 逐字节）⇒ **不得改 schema / LEGACY_DESCRIPTION**。
- 需同步的测试：`tests/tools/message-session-tool.test.ts:49-95`、`tests/fabric/xs-sender*.test.ts`、`tests/fabric/xs-sender-human-grant.test.ts:171-230`、`tests/integration/fabric-xs-human-default-wake.test.ts`、`tests/fabric/xs-reply-notice.test.ts:127-224,405-422`、hub `tests/web-hub/hub/xs-router*.test.ts`。
- conformance C-X7/C-X8/C-X11/C-X13/C-X14 钉 provider payload 卫生与阶段语义；通知里加 phase 安全，**不得加 sid/xid/messageId**。
- 不新增注册 ⇒ `activate-trace.json`、settings corpus/pin 不刷新。

## 5. 建议最小改动

1. hub `router.ts` `targetOf` 追加 `busy`（state-capable 门控）。
2. bridge `agent/xs.ts:1374` 旁透传 `targetBusy`；`XsPortReply` 加 `targetBusy?: boolean`（`sender.ts:68-73`）。
3. sender `sender.ts:621-654` 计算 `deliverOnlyIdleRisk = !wantWake ∧ replyToId===undefined ∧ expectReq!==undefined ∧ targetBusy===false ∧ localDowngrade===undefined`；sent 分支仅 `effect==="applied" ∧ wakeDowngraded===undefined` 时写新 outcome 字段（`XsSendOutcome` `sender.ts:171-191`）。
4. tool 追加中文 warning，门控 `deps.activation === true`。
5. 超时通知 phase 端口（见 §3）。

风险：I9（activation 门控；老端无 busy ⇒ 不告警）、I10（只追加开放对象字段）、误报（纯 warning）、NoticeGate 同步块不可破坏。
