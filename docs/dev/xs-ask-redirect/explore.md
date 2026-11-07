# #21 xs 委派中途提问（ask_user 重定向）· 代码探索

> 基线：`dev@735642ff`（2026-11-05）；r2 复核于 `HEAD=bfa16784`（#26 已提交 `src/index.ts` 与 settings corpus/pin，工作区除本目录外干净）。[F] = 读代码确认的事实；[I] = 推断/设计含义。
> 来源：GLM 探索结论 + 方案制定者抽查（行号以本次抽查为准，与 GLM 原稿不一致处见 §9）。
> r1 时 `src/index.ts` 有未提交改动；现已随 #26 提交，下文 `src/index.ts` 行号即 HEAD 行号（括注为 735642ff 旧行号）。

## 1. ask_user 现状

- [F] ask_user 只在主会话注册：`src/index.ts:298`（735642ff 时为 :303）的 `if (g[HOST_KEY]) return;` 早退在前，`wireAskUser(pi, {remote, background, interrupt})` 在 `:418-426`（735642ff 时为 :423-430）。子会话没有 ask_user。
- [F] `wireAskUser` 选项 `AskUserWireOptions`（`src/ask-user/index.ts:491-504`）全部是 late-bound 函数端口；注释约定「选项本身缺席 ⇒ 与功能前逐字节一致」（background 先例）。
- [F] execute（`index.ts:607-773`）顺序：dismissParked → normalize/validate → 非 tui/rpc 抛 `HEADLESS_TEXT` 并禁用工具（`:643-646`，文本 `:71`）→ `signal.aborted` 早退（`:648`）→ 组装 background 上下文 → `runTuiInteraction`（`:139-334`）/`runRpcInteraction`（`:336-466`）→ 按 outcome 生成结果。
- [F] 竞速原语 `createDialogRace`（`src/ask-user/remote.ts:52-64`），参与者 `tui|web|abort|error|background`；同步 claim、不用 Promise。web 远程端口 `AskUserRemotePort`（`remote.ts:26-41`）由 `src/web-hub/agent/dialogs.ts` 实现（DialogBridge）。
- [F] execute 没有自带超时，只受 abort 约束（`index.ts:221-230` 监听 signal）。
- [F] 结果 details 类型 `AskUserDetails = Result & {interrupted?, dismissed?}`（`src/ask-user/types.ts:124`），渲染在 `index.ts:789` 起。
- [F] 其他按工具名感知 ask_user 的地方：`src/feishu-notify/index.ts:380,547`（等待提醒，默认 `waitNotifyTools=["ask_user"]`）、`src/topic-switch/hold.ts:119`。
- [I] ask_user 的 schema/description 不需要改：重定向由宿主判定，模型面不变，off/on 的工具面都保持稳定。

## 2. xs 委派唤醒与「本回合委派来源」

- [F] `RootWakeController.dispatch`（`src/fabric/root-wake.ts:461-560`）以 `customType:"subagent:xs"` 发送，details 为 `{xsWake:true, xid, from, wakeToken, reply?{requestId,dueAt}, inReplyTo?, level?, bc?, activateFor?}`（`:521-545`），`triggerTurn:true`。
- [F] `from` 的结构 `{sessionId, ref, name?, cwdLabel, agentId, alias?}`（`src/fabric/xs/receiver.ts:103`），由 hub 盖章；ticket 校验也只认 `fromSessionId === ticket.replierSessionId`（`reply-ledger.ts:536`）。
- [F] Controller 只暴露 `state`/`activeToken`（`:409`）/`busy`/`activeMessageId`（`:417`）；wake ledger 记录（`src/fabric/xs/wake-ledger.ts:9-36`）含 `token/sessionId/xid/deadlineAt/handed/authorizedAt/abortIssuedAt`，**不含 from / requestId**。
- [F] B1：BAS 授权后 `ledger.update(...authorizedAt)`（`root-wake.ts:129-136`），Controller 进入 `bound`（`:617`）；人类输入接管 ⇒ `handed:true`、`handedOver`（`:707-719`）。
- [F] 运行截止：`bound/starting` 状态按 `record.deadlineAt` 挂计时器（`arm()` `:753-765`），到点 `deadline()` 发 abort（`:780-794`）。预算 = `fabric.wake.rootRunMaxS`（默认 900s，`src/fabric/settings.ts:703`）。
- [F] 既有有界反扫先例：`StackXsReply.inbound(requestId)`（`src/fabric/xs/stack.ts:603-616`）按 `details.reply.requestId` 从分支尾部扫描 ≤2000 条 `custom_message/subagent:xs`；`host.hasXid`（`:422-430`）同理。
- [I]（r1 设想，**r2 已弃用**：custom message 无写入者认证，改为 dispatch 时宿主 tap 捕获，见 §10）「本回合委派来源」= `controller.activeToken` → 分支里 `details.wakeToken === token ∧ xsWake` 的那条宿主写入 → `from.sessionId` + `reply{requestId,dueAt}`。只读宿主写入的 custom_message，模型无法伪造；`/reload` 后 Controller `recover()` 重新认领 token，反扫仍可用。

## 3. 发送端与人类授权

- [F] `message_session` schema 无来源/目标覆盖字段（`src/tools/message-session-tool.ts:23-74`）；`LEGACY_DESCRIPTION` `:135-140`、`REPLY_DESCRIPTION` `:142-149`。legacy 实例与 legacy 描述由 A 级 `tests/fixtures/fabric-xs-reply-off-golden.json` 钉住；`REPLY_DESCRIPTION` 没有测试逐字节钉住（grep 无命中）。
- [F] 发送端 `XsSender.message(args)`（`src/fabric/xs/sender.ts:414-428,505-`）：`invocation` 可选，缺席 ⇒ origin `"model"`、不碰 human grant；`wantWake = replyTo 缺席 ∧ (wake===true ∨ defaulted)`（`:645`）；本地层级 `hopAllowed(levelBase)` 不过 ⇒ `localDowngrade="level_limit"`（`:649`），仍按只投递发送。
- [F] expectReply 在发送前同步签票（`:668-700`）：`wakeOnReply:true`（`:679`）、`requesterLevel` = 当前根层级、`timeoutS` 夹在 `[60, maxTimeoutS]`。
- [F] 唯一的 sender 实例建在 `src/fabric/xs/activate.ts:352-402`（`xsSender = sender`）；子会话 P2c 的宿主 Proxy 先例在 `src/runtime/human-runtime.ts:150-163`（只代理 `message`，凭宿主捕获的 InvocationRef）。
- [I] 宿主代发 = 直接调用 `xsSender.message({to: requesterSid, text, wake:true, expectReply})`，不带 invocation；不需要也不应该伪造 grant。

## 4. 一次性票据

- [F] 票据账本 `src/fabric/xs/reply-ledger.ts`（进程级 `Symbol.for("pi-subagent:xs-reply-ledger")`，64 槽）；接收侧 classify（`receiver.ts:395`）→ reserve（`:454`）→ commit/release（`settleReply` `:291-298`）；只有能证明无效的派发才 release。
- [F] 用原委派的 replyTo 发中间问题 ⇒ 票据被这条中间消息消费，最终结果再用同一 replyTo 会被拒收（坑 1 的根因）。
- [F] 反向 expectReply 今天可用；A 回复后 receiver 以 solicited + `returnLevel` 走 Controller（`receiver.ts:465,484-501`），solicited 不检查 `hopAllowed`（`root-wake.ts:491`）。

## 5. 关键阻塞：B 正在跑时答案只投递

- [F] `dispatch` 在 `busy ∨ ledger.hasOwner ∨ !isIdle ∨ hasPendingMessages` 时降级 `busy`（`root-wake.ts:483-489`）⇒ receiver 走只投递分支，`host.sendMessage(..., {triggerTurn:false})`（`receiver.ts:540-559`），且 `!idleBefore` ⇒ 判 `unknown/queued`（`:575-580`）。
- [F] pi 1.4.0 `sendCustomMessage`（`node_modules/@earendil-works/pi-coding-agent/dist/core/agent-session.js:1844-1882`）：流式中且 `triggerTurn:false` ⇒ 放进 `_pendingCustomMessages`，**在本 turn 的工具结果入库之后追加**（`_flushPendingCustomMessages`）。
- [I] 因此 B 阻塞在 ask_user 时，A 的答复**确实会写进 B 的会话**，只是排在 ask_user 工具结果之后；问题只在 ask_user 的 Promise 不知道答案到了。坑 2 的「死等」上限其实是 `rootRunMaxS`：Controller 到点 abort。

## 6. 宿主写出口（可挂观察的位置）

- [F] `buildStackXs`（`src/fabric/xs/stack.ts:280`）里的 `host`（`:398-431`）由 receiver 和 Controller 共用，`sendMessage` 先 `pi.sendMessage` 再 `tapWritten(message)`（`:403-406`）——unread 计数就是这样「只观察、吞异常」挂上的（`:375-397`）。NoticeGate 的 quiet 写出口是另一条（`:574-576`），超时提醒走它。
- [I] 在 `host.sendMessage` 之后加一个只观察的 tap：看到 `details.inReplyTo === <问题 requestId> ∧ from.sessionId === 请求方` 就解开等待中的 ask。receiver 管线、ledger、property 测试都不用改。

## 7. 配额与层级

- [F] hub pair 键有方向：`${self}>${target}`（`src/web-hub/hub/xs/router.ts:874`）⇒ B→A 和 A→B 各算各的。
- [F] 非回复帧受 pair 间隔约束（默认 30s，`limits.ts:268`），pair 唤醒默认 2/h（`settings.ts:721`），出站唤醒 6/h；回复帧跳过 pair 间隔且强制 wake:false。
- [F] 层级上限 `fabric.wake.maxLevel=2`（`settings.ts:696`）。A 由人触发（L0）⇒ B 运行在 L1 ⇒ B 的提问到 A 为 L2，允许；A 本身是被唤醒的（L1）⇒ B 在 L2 ⇒ 提问 `level_limit`。
- [I] 默认配额下每小时每对最多 2 次可唤醒的提问 ⇒ per-run 上限默认 2 与之对齐。

## 8. 冻结面与门控

- [F] A 级：`fabric-xs-off-golden.json`、`fabric-wake-off-golden.json`、`fabric-xs-reply-off-golden.json`、`legacy-xs-v071/`、`secure-off-golden.json`；B 级：`governance/activate-trace.json`（只记录注册调用，不含描述）。
- [F] 设置：`tests/config/__corpus__/setting-specs-pin.json` + `settings-corpus.json`（`settings-corpus.test.ts:17` 写明 `GOV_CORPUS_GENERATE` 只能在基线提交上用；`GOV_CORPUS_DUMP=<dir>` 可导出实际输出做逐条 diff）。
- [F] D8：secure 让 `xsOn` 为假（`activate.ts:94-97`），xs 的 sender/stack/工具都不存在。
- [F] `fabric.crossSession.*` 写进 HubConfig 时用的是显式键（`src/web-hub/agent/xs.ts`），新增仅 agent 侧使用的键不会改变 hub 字节（`alias.autoFromCwd` 先例）。
- [F] `tests/conformance/ask-user-wired.test.ts` 驱动真实 `wireAskUser` + background hub。

## 9. 对 GLM 原稿的更正

- `createDialogRace` 在 `remote.ts:52-64`（原稿 56-74，文件只有 64 行）。
- HEADLESS 分支在 `index.ts:643-646`（原稿 666-669）。
- human-runtime Proxy 在 `:150-163`（原稿 159-176，偏差小）。
- 原稿说答案唤醒「降级为只投递后 B 只能死等」：实际答复会进入 pi 的 pending 队列，排在工具结果之后入库（§5）；B 的 run 最长活到 `rootRunMaxS` 被 abort。
- 原稿建议用 Symbol.for 全局 park 登记 resolver：不需要。等待者跟着 xs stack 走（stack dispose 时一并结算），`/reload` 时 ask 本身已被打断，不用跨 activation 共享。

## 10. r2 补充事实（评审 r_FKNQBKA8 后复核）

- [F] pi 的 custom message 不认证写入者：`SessionManager.appendCustomMessageEntry`（`node_modules/@earendil-works/pi-coding-agent/dist/core/session-manager.js:947-959`）只拼装条目并追加，任何扩展都能写出 `customType:"subagent:xs"` 的条目 ⇒ 分支反扫取来源不可信（r2 改为在 dispatch 时由宿主 tap 捕获）。
- [F] Controller 的 dispatch 顺序：`ledger.put` → `claim` → `this.token = token` → `arm()` → `host.sendMessage`（`root-wake.ts:499-545`）⇒ 宿主 tap 在同一个同步调用里能核对 `ledger.get(wakeToken)` 与 `activeToken`。
- [F] wake ledger：进程级 `Symbol.for("pi-subagent:xs-wake-ledger")`、容量 8（`wake-ledger.ts:7`）、满了拒绝而不淘汰（`put` `:67-80`），只凭终态证据 `release`（`:121-134`）；`update` 可写任意非键字段（`MutableFields` `:45`）。
- [F] sender：resolve 往返后检查 `guardOk(signal) ∧ invocationLive()`（`sender.ts:536`）；从这里到签票（`:673`）、发帧（`:760`）之间没有 await；`woke = wantWake ∧ 无降级 ∧ effect==="applied"`（`:802`）；成功回执映射在 `:799-845`。
- [F] hub 对限流的拒绝是 `res({ok:true, effect:"none", reason:admit.reason})`（`router.ts:879-880`），reason 为 `rate_in_flight`/`rate_pair_interval`/`rate_sends_*`/`rate_hub` ⇒ sender 得到 `status:"sent", effect:"none"`。
- [F] 原因词表：`XsNoneReason`、`XsUnknownReason`（`queued`/`start_deferred`/`accept_unverified`/`origin_changed_after_send`/`receiver_error`/`client_deadline`/`link_lost`）、`XsWakeDowngraded`（含 `controller_disabled`/`host_unverified`/`ledger_full`/`broadcast_*`），见 `src/web-hub/protocol/xs.ts:263-311`。`queued` 是 unknown 的 reason，不是降级。
- [F] receiver 的迟答：`wantWake = !late ∧ ticket.wakeOnReply`（`receiver.ts:465`）⇒ 过了 dueAt 的回复固定只投递。
- [F] 测试先例：`tests/conformance/fabric-xs.test.ts` 用 `createAgentSession` + `AnthropicStub`；`tests/conformance/ask-user-wired.test.ts:701` 用 `session.bindExtensions({uiContext, mode:"tui"})` 驱动真实 wireAskUser；`tests/web-hub/hub/xs-fixtures.ts` 的 `rig()` 提供进程内真实 `createXsRelay`（`fabric-xs-activate-session.test.ts` 在用）。XsHarness 的 peer 固定 `rootRunMaxS: 60`（`tests/integration/helpers/fabric-xs-process.ts:285`）。
- [F] `fabric.maxChars` 默认 2000（`src/fabric/settings.ts:689`）；ask_user 最多 4 问，每问 ≤1000 字（`src/ask-user/types.ts:8,45`）⇒ 存在放不下的情况。
- [I] 同一进程只能有一个 HOST_KEY 宿主 ⇒ 两会话闭环无法在一个进程里各跑一个 `activate()`，只能直接组装 stack/sender/wireAskUser，`activate()` 接线另由 wiring 测试覆盖。
