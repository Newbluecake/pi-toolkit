# #21 xs 委派中途提问：约定层 + ask_user 宿主重定向 · 方案

> 状态：**r3**（r3 = 第 2 轮复审后 root 裁定的三处最小修改；r2：r1 被评审打回：3 Blocker / 6 Major / 3 Minor，见 run r_FKNQBKA8；逐条处置见文末「评审处置表」）。
> 探索：`./explore.md`（基线 `HEAD=bfa16784`）。范围：A（约定）+ B（平台）；C（对话框跨会话直达 UI/新帧）不做。
> 用户拍板（2026-11-05，覆盖 r1 §6）：可信委派回合里重定向不可用 ⇒ 立即返回明确文字，不弹本地对话框；默认**开启**；每 run 最多 2 次；not_woken 立即返回。

## §0 需求摘要

A 会话用 `message_session`+`expectReply` 把任务委派给 worker 会话 B。B 中途有澄清问题时：① 若用原委派的 `replyTo` 提问，一次性票据会被消费，最终结果随后被拒收；② 若调用 `ask_user`，A 看不到对话框，B 的 run 卡住，最后被 `rootRunMaxS` abort。
**A 约定层**：在 reply-on 的 `message_session` 描述里写明机制，策略写进 `skills/agent-handoff`；legacy 描述和参数一字不改。
**B 平台层**：可信 xs 委派回合中，宿主把 `ask_user` 改成「宿主代发、带 expectReply 的提问」，拿到答复后作为工具结果返回。off/非委派回合字节不变（I9）；secure 下自动关闭（I11）；每 run 上限 2 次；超时/失效/不可达时给明确文字；不信任任何模型自报的来源。

## §1 设计决定

**D1 等待方式：(a) 阻塞等待 + 宿主写出口 tap 带外解开（维持 r1）。** B 阻塞时，A 的答复被降级为只投递，pi 会把它排在工具结果之后入库（explore §5）。缺的只是通知 ask_user。实现方式：`buildStackXs` 的 `host.sendMessage` 后加一个只观察的 tap，命中本调用登记的 q2 就 resolve。receiver、ledger 状态机、Controller 均不改。不选 (b) 的理由：依赖模型主动结束回合；B 最后一个 turn 流式时到达的答复会搁浅；`receive:"deliver"` 时永远不会被唤醒；接答案的 run 里没有原 `reply`，无法再次重定向。

**D2 两类回合（B3 改写）。** 只在 tui/rpc 模式生效，判定位置在 execute 的 HEADLESS 检查（`index.ts:643`）和 `signal.aborted` 早退（`:648`）**之后**。print 模式不支持（无常驻 UI 的 worker 也无法常驻 xs），HEADLESS 路径与顺序不变。

- **O 类：off / 非委派。** `ask()` 同步返回 `undefined`，走原本地对话框，字节不变。条件（满足任一即 O 类）：选项未传（门控 off、D8）；`controller.state≠"bound"`；token 的 ledger 记录缺失，或 `sessionId≠本会话`，或 `state≠"live"`，或已设 `abortIssuedAt`，或 `authorizedAt` 未设；`handed:true`（人已接管，人就在 B 旁）；记录上没有 `askOrigin`（普通 wake、回复唤醒、activation 控制标记的 run）。
- **U 类：可信委派但重定向不可用。** 以上全满足（有 `askOrigin`），但出现下列任一情况：未 attached / 无 sender（`detached`）、`origin_window`、`run_window`、`level_limit`（本地 `hopAllowed` 不过）、`limit`、`too_large`、`send_none:<reason>`、`no_ticket`、排队后窗口不足（`queue_window`）。⇒ 立即返回明确文字（原因 token + 「不要假设答案；按可辩护的默认继续，并在给原 replyTo 的最终结果里列出问题与所选默认」），**不弹本地对话框**。

**D3 来源可信性（M4）：dispatch 时捕获不可变宿主快照，不做分支反扫。**

- 捕获点：`host.sendMessage` tap（Controller 与 receiver 共用的宿主写出口）。看到 `customType==="subagent:xs" ∧ details.xsWake===true ∧ typeof details.wakeToken==="string" ∧ details.activateFor===undefined ∧ details.reply` 时，只在以下全部成立时，把 `askOrigin={requesterSessionId, requestId, dueAt}` 写入 wake ledger 记录（写一次）：`rec=ledger.get(wakeToken)` 存在；`rec.sessionId===本会话`；`rec.xid===details.xid`；`controller.activeToken===wakeToken`；`rec.askOrigin===undefined`；`from.sessionId` 为非空字符串；`reply.requestId` 匹配 `XS_REPLY_REQUEST_ID_RE`；`reply.dueAt` 为有限数。任一项不满足就不写，该 run 归 O 类。
- 时序依据：Controller 在 `ledger.put`、`claim`、设置 `this.token` 之后才调用 `host.sendMessage`（`root-wake.ts:500-545`），tap 在同一个同步调用里执行；`pi.sendMessage` 抛异常时不会走到 tap。
- 信任边界：pi 的 custom message 不认证写入者（`session-manager.js:947-959`）。所以不从分支读来源，其他扩展写的 `subagent:xs` 条目不经过本 tap，无法注入来源。**不防御**同进程里能直接改 `Symbol.for` 全局（ledger）的恶意扩展——这一点与现有 B1/票据账本的信任边界一致（same-uid、同进程）。
- 成本（m10）：O(1)，无 `getBranch()`。`/reload` 后记录仍在进程级 ledger 中（Controller `recover()` 重新认领）；pi 重启后 token 不存在 ⇒ O 类。不做恢复重建。

**D4 计数与准入（B1/B2）：绑定 wake ledger 记录的生命周期，同步预留。**

- `XsWakeRecord` 追加两个可选纯数据字段：`askOrigin?`、`askUsed?: number`（`MutableFields` 自动可写）。容量与清理沿用 ledger：上限 8、从不淘汰、只凭终态证据 `release`；记录被释放时计数随之消失。计数跨 `/reload`、跨 stack，按 token 生效。
- 预留：`ask()` 内、任何 await 之前，同步执行 `if ((rec.askUsed ?? 0) >= min(maxPerRun, 2)) ⇒ U(limit)`（有效上限恒 ≤2，任何注入值都不放宽），否则 `askUsed+1`。这样 `askUsed` 本身就等于「已计费 + 在途」。
- 退还：只有该调用**尚未终态**且结果被 §1 D7 判为 `none`（可证明没发出去），或排队到队首时因窗口不足、从未发送，才 `askUsed−1`。unknown 一律计费；终态之后到达的任何结果都不退还。
- 并发：pi 默认并行执行工具，所以**每个 token 内串行**。stack 内维护每个 token 的 FIFO 队列；队首调用要等上一问进入终态，且距上一问发出 ≥ `limits.pairMinIntervalMs`（默认 30s，hub 对非回复帧要求同一对方向的发送间隔）才发送。排队时间计入该调用自己的绝对截止时间；第 3 个并行调用在预留时就被 `limit` 拒绝。等待 Promise、队列和计时器都只存在于 stack 内，stack dispose 时结算为 `disposed`（不退还）。

**D5 两个绝对期限（M7）。** 入口（同步）时计算 `waitUntil = min(t0 + timeoutS·1000, rec.deadlineAt − 60s, askOrigin.dueAt − 60s)`；若 `waitUntil − t0 < 60s` ⇒ U(`run_window`/`origin_window`，取先约束的那一项，不预留）。这个截止时间覆盖排队、resolve、send 和等待的全部耗时。发送前（队首）重算 `q2TimeoutS = ⌈(waitUntil − now)/1000⌉`，若 < 60 ⇒ U(`queue_window`)，并退还预留。sender 会把它夹到 `[60, reply.maxTimeoutS]`，ledger 按签票时刻计算真实的 `q2DueAt`（由 D6 的回调带回）。宿主等待结束时刻 = `min(waitUntil, q2DueAt)`，计时器走 `Clock`+`clampSpanMs`，`unref()`。
迟答语义（更正 r1）：receiver 中 `wantWake = !late ∧ ticket.wakeOnReply`（`receiver.ts:465`）。在宿主等待结束之后、`q2DueAt` 之前到达的答复（通常 <2s 的缝隙）按普通 solicited 路径处理；`q2DueAt` 之后、`lateUntil` 之前到达的**固定只投递、不起回合**——只有 B 的 run 仍在继续或之后有别的回合时模型才会看到。不承诺迟答会让 B 继续执行。

**D6 调用状态机与取消（M5/M6）。** `ask()` 在第一个 await 之前同步完成：预留 → 建 `call{state:"pending", waitUntil, ctl:AbortController}` → 注册 tool `signal` 的 abort 监听 → 挂截止计时器 → 入队。

- 终态只能 claim 一次：`answered | timeout | not_woken | unavailable | aborted | disposed`；claim 时清计时器、摘掉监听、`ctl.abort()`。
- sender 调用传 `signal = AbortSignal.any([toolSignal, call.ctl.signal])`，以及 `invocationLive: () => call.state==="pending" ∧ !stackDisposed`。sender 在 resolve 往返之后检查这两项（`sender.ts:536`）；从检查到签票再到发帧之间没有 await（`:537-759`），因此终态先于检查 ⇒ 不会发帧，结果为 `origin_changed`/none。
- 签票通知：`XsSenderMessageArgs` 新增可选 `onIssued?(t:{requestId, dueAt})`，在 `ledger.issue` 成功后、`port.send` 之前同步调用（不是 wire 字段，message_session 工具从不传它）。stack 用它在发帧前登记精确的 `q2 → call`，所以不需要答复环。
- tap 匹配条件（全部满足）：`customType==="subagent:xs"`、`details.xsWake!==true`、`typeof details.inReplyTo==="string"` 且命中已登记的 q2、`details.from.sessionId===call.requesterSessionId`、`call.state==="pending"`。命中 ⇒ claim `answered`，`answerText` = 消息 content 的文本（保留 receiver 的不可信输入围栏头）。
- 终态之后 send 的 continuation 只做保守记账：不退还、不复活 waiter、不弹 UI、不重发。答复先于 send 回执到达时，`answered` 已占住终态，后到的降级回执不能覆盖它。

**D7 发送结果分类（M8，对真实 `XsSendOutcome`，`sender.ts:799-845`）。** 纯函数 `classifyAskSend(o)`，effect、reason、wakeDowngraded 分别读取，按顺序判定：

1. `o.effect==="none"` ⇒ **none**（U `send_none:<o.reason ?? o.code ?? o.status>`；退还）。包括：本地 none 状态（`origin_changed`、`bad_target`、`too_large`、`not_joined`、`reply_unsupported`、`reply_unreceivable`、`reply_quota`、`reply_ledger_full`、`off`、`no_target`、`ambiguous`、`stale_origin`、`bad_frame`、`alias_unavailable`、`error`+none）；hub 准入拒绝（`ok:true, effect:"none", reason:"rate_*"`，`router.ts:879-880`）；接收端 none（`rejected`、`expired`、`fenced:*`、`inbox_full`、`inbound_rate`、`dedup_full`、`host_rejected`、`session_changed`、派发前的 `receiver_error`）。
2. `o.reply?.state!=="pending"` ⇒ **no_ticket**（U，计费；正常不会出现，属防御分支）。
3. `o.effect==="unknown"` ⇒ **wait**，不看 wakeDowngraded。覆盖 `queued`（A 正在流式，会在 turn 边界看到）、`start_deferred`、`accept_unverified`、`client_deadline`、`link_lost`、`origin_changed_after_send`、派发后的 `receiver_error`、`unverified`、`unspecified`。unknown 永远不进 none 或 not_woken，因为 q2 已登记，有界等待即可，不重发。
4. `o.effect==="applied" ∧ o.woke===true` ⇒ **wait**。
5. `o.effect==="applied" ∧ o.wakeDowngraded!==undefined` ⇒ **not_woken**（确定的降级证据：消息已入库但 A 没有起回合）。覆盖全部降级 token：`busy`（applied ⇒ A 空闲入库、无回合）、`goal`、`level_limit`、`receiver_policy`、`wake_disabled`、`controller_disabled`、`host_unsupported`、`host_unverified`、`inbound_wake_rate`、`outbound_wake_rate`、`pair_wake_rate`、`sender_wake_disabled`、`ledger_full`、`broadcast_*`。前提是终态仍为 pending（已答复则以答复为准）；票据保留，迟答照常投递。
6. 其余（`applied`、无 woke、无降级——当前代码不可达）⇒ **wait**（保守）。
   注意：`queued` 是 reason，不是 downgrade；`start_deferred` 是 unknown，不算 not_woken。测试对 `XsSendStatus`×`XsEffect`×reason×`XsWakeDowngraded` 全部组合做穷举。

**D8 模型可见文本与长度（m11）。**

- 发给 A 的文本：fabric 侧负责首行 `[ask_user→requester] attempt n/2 · origin <originRequestId>`，加一段中文说明：「我在处理你的请求时需要你拍板；请用 message_session 回复**本消息**（replyTo 填本消息头的 reply_to）；原请求仍未完成，不要用它回答；答复格式 `1: a；2: <自定义>`」。
- 正文预算 `budget = fabric.maxChars(默认 2000) − 首行与说明的长度`，fabric 把它传给 ask-user 的 `render(budget)`。ask-user 按顺序压缩：完整 → 去掉 option description → 把 context 截到 120 字 → 去掉 context。question 文本一律完整保留（不截断），每个 option label 也都保留；仍超出 ⇒ 返回 undefined ⇒ U(`too_large`)，不发送、不预留。被截断的内容绝不当作已获得的决策。
- ask_user 结果（英文）：
  - answered：`The requester answered (host-redirected ask_user, n/2 this run). Treat it as the requester's decision; deliver your FINAL result with the ORIGINAL replyTo <origin>. The same reply also appears as a separate xs message — do not answer it again.\n<answerText>`
  - 其他终态：以 `Do not assume an answer.` 开头，接原因 token 与 D2 的 U 类指引；timeout/not_woken 额外说明「本次 ask 已结束；之后的答复仍按票据与接收策略处理：dueAt 之前到达的普通答复可能唤醒你，票据到期后宽限期内的迟答只投递、不唤醒」。
  - `details.redirected = {state, attempt?, limit, requestId?, reason?}`，`cancelled = state!=="answered"`，`answers:{}`。`renderResult` 显示 `↪ requester answered 1/2` / `↪ requester <state>`。ask_user 的 schema、description、promptSnippet 都不改。

**D9 设置键（用户拍板：默认开）。** `fabric.crossSession.askRedirect.{enabled:true, timeoutS:600 (60..3600), maxPerRun:2 (1..2)}`，非 live，在 activate/stack build 时冻结，只在 agent 侧使用，从不写进 HubConfig。生效条件 = `xsOn ∧ reply.enabled ∧ wake.enabled ∧ askRedirect.enabled`；secure 下 `xsOn` 恒为假，自动关闭。`maxPerRun` 解析时 clamp 到 1..2，`createXsAskRedirect` 内部再取 `min(注入值, 2)`，任何注入路径的有效上限都不超过 2。`/agent settings` 只加 `enabled` 一个 bool spec。上线门禁：§3 T11 必须为绿。

**D10 与 grant / B1 / 层级 / A 侧的关系。** 代发不带 `invocation` ⇒ origin 为 `model`，不预留也不消耗 grant，不重置层级和配额。B 侧不新建 run 或 token：答复在 B 忙时一律只投递，B1 不受影响。A 正在流式 ⇒ unknown/queued ⇒ 等待；A 空闲但未被唤醒、配额或层级耗尽 ⇒ not_woken；A 的 receive 为 replies ⇒ none(rejected) ⇒ U。

**D11 A 约定层文本**：只在 `REPLY_DESCRIPTION` 末尾追加一句：`While working on a request that carried reply_to, send any intermediate question to its requester as a NEW message with expectReply (wake:true) — never the original replyTo (it accepts exactly one reply: your final result) — and do not block on ask_user: the requester cannot see your local dialog (the host redirects ask_user for you when it can).` skill 新增一节，写策略：先自查能否自行决定；问题一次问全并附默认做法；A 用**该问题**的 replyTo 回答，原请求保持打开；用户在 A 侧时，由 A 用 ask_user 问人后转答。

## §2 共享契约（并行前冻结，m12）与改动清单

**§2.0 冻结契约**（B1/B2 以此为准；签名是契约，不是实现）：

```ts
// src/ask-user/redirect.ts（B2 所有；fabric 只做结构兼容，不 import）
export type AskRedirectReason =
  | "detached"
  | "origin_window"
  | "run_window"
  | "queue_window"
  | "level_limit"
  | "limit"
  | "too_large"
  | "no_ticket"
  | `send_none:${string}`;
export type AskUserRedirectResult =
  | { kind: "answered"; answerText: string; requestId: string; attempt: number; limit: number }
  | { kind: "timeout"; requestId: string; attempt: number; limit: number; waitedS: number }
  | { kind: "not_woken"; requestId: string; downgrade: string; attempt: number; limit: number }
  | { kind: "unavailable"; reason: AskRedirectReason; limit: number; attempt?: number; requestId?: string }
  | { kind: "aborted" }
  | { kind: "disposed" };
export interface AskUserRedirectPort {
  /** 同步：undefined ⇔ O 类（调用方走原路径）。render(budget) 返回 undefined ⇔ too_large。 */
  ask(input: {
    render: (budgetChars: number) => string | undefined;
    signal?: AbortSignal;
  }): Promise<AskUserRedirectResult> | undefined;
}
// src/fabric/xs/sender.ts（B1）：XsSenderMessageArgs.onIssued?: (t: { requestId: string; dueAt: number }) => void
// src/fabric/xs/wake-ledger.ts（B1）：XsWakeRecord.askOrigin?: { requesterSessionId: string; requestId: string; dueAt: number }; askUsed?: number
```

**包 A · 约定层**（L1，与 B 并行）

- `src/tools/message-session-tool.ts:142-149`：在 `REPLY_DESCRIPTION` 末尾追加 D11 的句子。**冻结**：`LEGACY_DESCRIPTION`（:135-140）与两个 schema 实例。
- `skills/agent-handoff/SKILL.md`：在 `## 反模式`（:166）前加一节，≤20 行。
- 测试：新建 `tests/tools/message-session-reply-description.test.ts`（reply-on 含新句、legacy 不含）；`tests/integration/fabric-xs-reply-off-golden.test.ts` 不改且保持绿。

**包 B1 · fabric 侧**（L2；settings corpus/pin 的唯一所有者）

- `src/fabric/xs/wake-ledger.ts:9-36`：追加两个可选字段（不改 `put`/`release`/容量）。
- `src/fabric/xs/sender.ts:392-412`：加 `onIssued?`；在 `:673-700` 签票成功后、`:760` 发送前同步调用（try/catch，吞掉异常）。
- **新文件** `src/fabric/xs/ask-redirect.ts`（pi-free）：`createXsAskRedirect(deps)` 提供 `{ ask, observeWrite, dispose }`，实现 D2–D8 与 `classifyAskSend`；deps 为 `{sessionId, clock, ledger, controller(), attached(), wakeHopAllowed(), maxChars, pairMinIntervalMs, timeoutS, maxPerRun, send(args)}`。把它加进 `tests/fabric/xs-reply-ledger.test.ts:616` 的源码扫描列表。
- `src/fabric/xs/stack.ts`：`StackXsInput.askRedirect?: {send, wakeHopAllowed, attached}`（:50-88）；`StackXs.askRedirect?`（:91-121）；在 controller 与 replyLedger 都存在、`config.askRedirect.enabled`、`input.askRedirect` 存在时，于 Controller 构造之后创建；`host.sendMessage`（:403-406）在 `tapWritten` 之后调用 `askRedirect?.observeWrite(message)`（try/catch）；`dispose`（:900-925）在 `controller?.dispose()` 之前调用 `askRedirect?.dispose()`。
- `src/fabric/xs/activate.ts`：`XsActivation.askRedirectOn`（:51-90，activate 时冻结）；`stackInput()`（:638-）注入 `send: (a) => xsSender?.message(a)`、`wakeHopAllowed`、`attached`。
- `src/fabric/settings.ts`（接口约 :306-318、:366-372，clone :411-420，parse :598-608/:678，默认值 :754 后）、`src/fabric/setting-specs.ts:112` 后加 bool spec。
- 测试：新建 `tests/fabric/xs-ask-redirect.test.ts`（D2–D8 单测、`classifyAskSend` 穷举）、`tests/fabric/xs-ask-redirect-origin.test.ts`（D3 伪造与歧义）、`tests/fabric/xs-sender-on-issued.test.ts`；`tests/config/__corpus__/{setting-specs-pin,settings-corpus}.json` 的迁移（§4）。

**包 B2 · ask-user 侧**（L2，与 B1 并行）

- **新文件** `src/ask-user/redirect.ts`：§2.0 的类型、`renderRedirectBody(questions, budget)`（D8 压缩顺序）、各终态文本。
- `src/ask-user/index.ts`：`AskUserWireOptions.redirect?: () => AskUserRedirectPort | undefined`（:491-504）；在 `:648` 之后、`:650` 之前加分支——`ask()` 返回 undefined ⇒ 原代码原样继续；否则 await 结果并直接返回（不进 queue/bg/parked/remote）。`renderResult`（:789-）加 `redirected` 分支。
- `src/ask-user/types.ts:124`：`AskUserDetails` 加可选 `redirected?`。
- 测试：新建 `tests/ask-user/redirect.test.ts`（render 预算：question 永不截断、只压缩 context/description，放不下 ⇒ too_large；各终态文本、O 类与选项缺席字节不变、print 模式仍走 HEADLESS）；`tests/conformance/ask-user-wired.test.ts` 不改且保持绿。

**包 B3 · 接线 + 闭环门禁 + 文档**（B1/B2 合入后）

- `src/index.ts:418-426`（HEAD 行号，#26 已提交）：仅当 `xs.askRedirectOn` 为真时传 `redirect: () => holder.current?.xs?.askRedirect`。不新增 `pi.on`/`registerTool` ⇒ `activate-trace.json` 不刷新。
- 测试：`tests/integration/fabric-xs-ask-redirect-session.test.ts`（T11 门禁）、`tests/integration/fabric-xs-ask-redirect-wiring.test.ts`（真实 `activate()` × 假 hub socket，验证选项传递与 D8 关闭）、`tests/integration/fabric-xs-ask-redirect.test.ts`（真实 hub 子进程 harness；在 `tests/integration/helpers/fabric-xs-process.ts` 加 `XW_ROOT_RUN_MAX_S` 旋钮，本套件设 600，默认值仍为 60）、`tests/conformance/fabric-xs.test.ts` 加 C-X16。
- 文档：`docs/dev/fabric-cross-session/README.md` 新增「Ask redirect (#21)」一节；`docs/dev/ask-user-async/README.md` 加一句指引。

## §3 测试矩阵

| #   | 覆盖                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                | 文件                                                                       |
| --- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------- |
| T1  | off 字节不变：选项缺席 ⇒ execute 路径不变；xs on ∧ askRedirect off ⇒ 无 `askRedirect`、tap 不调用；三个 xs off golden、`legacy-xs-v071/`、`secure-off-golden.json` 零 diff；`tests/governance` 不刷新也为绿                                                                                                                                                                                                                                                                                                                                                                                                                                                                         | 现有 golden 套件、`xs-ask-redirect.test.ts`                                |
| T2  | D8：secure 强制关闭 ⇒ `askRedirectOn=false`、不传选项                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               | `fabric-xs-ask-redirect-wiring.test.ts`                                    |
| T3  | 来源（M4）：同 token 但 xid 不符、`activeToken` 不符、重复候选（第二次写被拒）、`from`/`reply` 类型被篡改、`activateFor` 标记、其他扩展直接 `appendCustomMessageEntry` 写的伪 wake 条目、ask_user 参数里塞 `to/from/replyTo` ⇒ 全部 O 类或无效                                                                                                                                                                                                                                                                                                                                                                                                                                      | `xs-ask-redirect-origin.test.ts`                                           |
| T4  | 两类回合：O 类各条件 ⇒ undefined；U 类各 reason ⇒ 明确文字、不弹对话框；`handed` ⇒ O                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                | `xs-ask-redirect.test.ts`、`redirect.test.ts`                              |
| T5  | 准入（B1）：同一 tick 并行 3 个 ask ⇒ 第 3 个立即 `limit`；第 2 个排队，等第 1 个终态且满足 pair 间隔后才发；排队超窗 ⇒ `queue_window` 并退还；unknown 计费；none 退还；终态后到达的 none 不退还；`maxPerRun` 配置为 3、4 或异常大值（如 1e9）时，解析结果与直接注入 deps 两条路径下，第三次计费提问都被 `limit` 拒绝                                                                                                                                                                                                                                                                                                                                                               | `xs-ask-redirect.test.ts`                                                  |
| T6  | 跨 reload（B2）：2 次计费后连续 reload 两次（新 stack + 同一个 ledger + `recover()`），第 3 次仍为 `limit`；dispose 让在途调用结算为 `disposed` 且仍计费                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            | `xs-ask-redirect.test.ts`                                                  |
| T7  | 取消（M5）：resolve 期间 abort ⇒ 不发帧（sender 收到 none）；send 期间 abort ⇒ `aborted`，后到的回执只记账；timeout 与答复在同一 tick ⇒ 只有一个终态；dispose 后答复不复活                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          | `xs-ask-redirect.test.ts`                                                  |
| T8  | 早答与竞态（M6）：答复先于 send 回执；两问交叉答复；同一答复重复写入；错误 q2；`from` 不符；超时后答复；dispose 后答复；NoticeGate quiet 写出口不命中                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               | `xs-ask-redirect.test.ts`                                                  |
| T9  | 期限（M7）：`waitUntil` 被三者夹住；`q2TimeoutS` 被 maxTimeoutS 夹住后等待取 `min`；q2 pending 期（宿主等待结束后、`q2DueAt` 之前）到达的普通答复按 solicited 路径处理（B 空闲 ⇒ 可能唤醒），`q2DueAt` 之后、lateGrace 内的迟答只投递、不起回合；两期的行为不同，timeout/not_woken 文案与 D8 原文逐字一致，且不含「不会再唤醒」                                                                                                                                                                                                                                                                                                                                                     | `xs-ask-redirect.test.ts` + 真实 receiver                                  |
| T10 | `classifyAskSend` 穷举（M8）：status×effect×reason×downgrade 全组合；unknown 不落入 none/not_woken；`applied+busy` ⇒ not_woken；`unknown+queued+busy` ⇒ wait                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        | `xs-ask-redirect.test.ts`                                                  |
| T11 | **上线门禁**：两个真实 `AgentSession`（`createAgentSession` + `bindExtensions({mode:"rpc"})`，脚本模型）+ 真实 `wireAskUser` + 两个真实 `buildStackXs`/`createXsSender`，经进程内真实 `createXsRelay` + `createXsAgentBridge` 相连（`tests/web-hub/hub/xs-fixtures.ts` 的 `rig()`，先例 `fabric-xs-activate-session.test.ts`），`rootRunMaxS=900`。链路：A 委派 → B 调 ask_user → A 收到问题后用 q2 回答 → B 在同一 run 拿到答案并继续 → B 用原 replyTo 交付，A 接受。另覆盖：A 不答 ⇒ timeout；A 为 replies 模式 ⇒ `send_none`；第 3 问 ⇒ `limit`。**模拟边界**：不走 web-hub socket 和 `activate()`（同一进程只能有一个 HOST_KEY）；这两部分由 wiring 测试与 hub harness 分别覆盖 | `fabric-xs-ask-redirect-session.test.ts`                                   |
| T12 | 网络与 receiver：真实 hub 子进程 × 真实 stack，覆盖 pair 间隔与 2/h 唤醒的降级、票据单次语义（原票据在问答后仍可用；同一 q2 第二次回复被拒），且 `xs-reply-receiver.property.test.ts` 不改；**模拟边界**：peer 的宿主由 harness 模拟                                                                                                                                                                                                                                                                                                                                                                                                                                                | `fabric-xs-ask-redirect.test.ts`（integration）                            |
| T13 | pi 事实 C-X16：工具 execute 期间 `sendMessage(triggerTurn:false)` 排在工具结果之后入库，并出现在同一 run 的下一次 provider 请求中；details/token 不进 payload                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       | `tests/conformance/fabric-xs.test.ts`                                      |
| T14 | A 层描述；sender `onIssued` 只在签票成功时、发帧前同步调用一次                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      | `message-session-reply-description.test.ts`、`xs-sender-on-issued.test.ts` |

## §4 门禁命令

```sh
npm run format:check && npm run typecheck
npx vitest run tests/fabric tests/ask-user tests/tools tests/config tests/governance tests/boundary
npx vitest run tests/conformance/ask-user-wired.test.ts tests/integration/fabric-xs-reply*.test.ts \
  tests/integration/fabric-xs-ask-redirect*.test.ts tests/integration/stack-teardown-matrix.test.ts
npx vitest run tests/conformance/fabric-xs.test.ts      # C-X1…C-X16，真实 pi
npm test && npm run build
git diff --quiet origin/dev -- tests/fixtures/           # A/B 级 fixture 零 diff
```

settings corpus/pin（B1 负责）：以**当前 HEAD**（含 #26 `bfa16784` 的 corpus/pin）为基线逐条迁移，禁止 `GOV_CORPUS_GENERATE` 全量重抓。步骤：在 HEAD 与改动后分别跑 `GOV_CORPUS_DUMP=<dir>`，逐条 diff；确认每个差异 case 只是 `crossSession` 里多了 `askRedirect` 块（default-on 改变的是解析结果而非输入，必须逐条确认）；只更新这些 case 的哈希。pin 只追加一个 spec 的哈希并重算 `all`。commit 正文写明原因（B 级规则）。

## §5 风险与残留

- **R1 正文重复**：答复正文同时出现在 ask_user 结果和随后的 xs 消息中。结果文本提示「不要再回答」。
- **R2 预算占用**：等待计入 B 的 `rootRunMaxS`（默认 900s）。期限已夹住，但两问会挤占 B 干活的时间；文档建议重度委派时调大。不延长期限（I1）。
- **R3 A 侧回执 `unknown/queued`**：B 忙时 A 的回复回执为 unknown，A 会看到「可能已送达」提示，语义正确但易混淆。
- **R4 A 层手动做法的搁浅窗口**：按约定手动提问的模型，若在 B 最后一个 turn 流式时收到答复，答复会以 pending 入库而不起回合（现有行为；B 层不受影响）。
- **R5 飞书等待提醒误报**：`feishu-notify` 按工具名提醒，重定向时也会发。
- **R6 abort/超时后 q2 票据仍挂着**：ledger 没有 cancel；之后的答复按 D5 处理：`q2DueAt` 之前到达的普通答复可能唤醒 B，到期后宽限期内的迟答只投递、不唤醒。
- **R7 activation 控制标记的 run 归 O 类**：`wake_session activate` 唤醒的 run 暂不重定向，可作为后续扩展点（复用原 messageId 的来源）。
- **R8 默认开启的影响面**：已开 xs+reply+wake 的用户，在被委派的 run 里不再弹 ask_user 对话框（按设计；人接管 ⇒ O 类）。
- **R9 信任边界**：不防御能改进程级 ledger 的同进程恶意扩展（D3）。

## §6 需用户拍板的开放问题

无（r1 的 4 项已由用户 2026-11-05 拍板，见 D2/D4/D7/D9）。

## 评审处置表（r1 → r2）

| 评审项                                                            | 处置                                                                                                                                                                         | 章节                |
| ----------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------- |
| B1 并发准入                                                       | 接受。入口同步预留，`askUsed` 即「已计费 + 在途」；只有可证明 none 才退还，unknown 计费；同 token 内串行 FIFO，满足 pair 间隔；排队计入绝对期限；第 3 个并行调用立即 `limit` | D4、D6、T5          |
| B2 上限跨 reload                                                  | 接受。计数和来源写进进程级 wake ledger 记录（上限 8、不淘汰、凭证据释放）；Promise、队列、计时器留在 stack；补连续 reload 测试                                               | D3、D4、T6          |
| B3 回退矩阵                                                       | 接受，按用户拍板改写：O 类走原对话框且字节不变，U 类立即返回明确文字、不弹对话框                                                                                             | D2、D8、T4          |
| M4 来源可信性                                                     | 接受。改为 dispatch 时宿主 tap 捕获不可变快照，核对 token/xid/activeToken/会话/字段类型，写一次；删除分支反扫；写明同进程信任边界                                            | D3、T3、R9          |
| M5 取消覆盖发送阶段                                               | 接受。首个 await 前完成预留、状态、监听、计时器；signal 与 `invocationLive` 传入 sender；终态单次 claim；终态后只做保守记账                                                  | D6、T7              |
| M6 早答与竞态                                                     | 接受。sender 新增 `onIssued`，发帧前登记精确的 q2（不改 wire，不用答复环）；tap 限定消息类型、q2、from；已接受的答复不被后到的回执覆盖                                       | D6、T8              |
| M7 两个绝对期限                                                   | 接受。宿主 `waitUntil` 与真实 `q2DueAt` 分开计算，覆盖 resolve/send，尊重 maxTimeoutS；更正迟答为固定只投递、不起回合                                                        | D5、T9              |
| M8 发送结果分类                                                   | 接受。对真实 `XsSendOutcome` 写有序分类，effect/reason/downgrade 分别读取，unknown 只能等待，列全 none/unknown/降级 token；穷举测试                                          | D7、T10             |
| M9 测试接线                                                       | 接受。只支持 tui/rpc，HEADLESS 顺序不变；新增真实 AgentSession × 真实 wireAskUser × 两个真实 xs stack 的闭环测试作为上线门禁；hub harness 加 rootRunMaxS 旋钮并标注模拟边界  | D2、§2 B3、T11、T12 |
| m10 getBranch 成本                                                | 接受（彻底消除）：不再反扫，来源在 dispatch 时 O(1) 捕获；reload 由 ledger 保留，重启即 O 类                                                                                 | D3                  |
| m11 长度预算                                                      | 接受。fabric 给出预算，ask-user 按固定顺序压缩，保留全部问题与 label；放不下就返回 `too_large`，不发送                                                                       | D8                  |
| m12 契约与基线                                                    | 接受。§2.0 冻结共享契约；逐包列出测试文件；B1 唯一负责 corpus/pin；以 HEAD `bfa16784` 为基线逐条迁移；`src/index.ts` 按 HEAD 重新定位为 :418-426                             | §2、§4              |
| 用户拍板（默认开 / 上限 2 / not_woken 立即返回 / U 类不弹对话框） | 照办；T11 为上线门禁                                                                                                                                                         | D2、D4、D7、D9      |
| r3（root 裁定）原第 1 条：maxPerRun 上限                          | `maxPerRun` 取值范围改为 1..2，解析时 clamp，模块内再取 `min(·,2)`；T5 补配置为 3/4/异常大值时第三问仍被拒                                                                   | D4、D9、T5          |
| r3（root 裁定）原第 7 条：迟答文案                                | timeout/not_woken 文案改为区分 dueAt 前（可能唤醒）与到期后宽限期（只投递、不唤醒），删去「不会再唤醒你」；R6 同步改正；T9 分别断言两期的文案与行为                          | D8、R6、T9          |
| r3（root 裁定）原第 11 条：question 截断                          | 删除「question 截到 300 字」；question 一律完整保留，只压缩 context/description，放不下 ⇒ too_large；B2 测试同步修改                                                         | D8、§2 B2           |
