# fabric 跨会话：请求-回复关联（reply）+ @会话 mention，实施方案（r2）

> 车道：**L3**（跨进程协议、凭证状态、自治唤醒都要改）。前置：phase2 全部包（XS0…X5、XW）已合入。
> 本文是 phase2-plan.md 的增量设计，凡未提及的部分均沿用 phase2 正文 + r3 裁定 + 2026-10-22 拍板。
> 坐标图：`docs/dev/fabric-cross-session/reply-explore.md`。评审：`reply-review-r1.md`（r1 打回）；r2 的逐条处置见文末「r2 处置表」。§12.3 的第三期扩展点（子 run、`from.run`、`toRun`）**不动**。
>
> **r2 最大的变化（为闭合 Blocker #1 而收窄承诺）**：凭证的「可接收」状态**只存在于签发它的 pi 进程的内存账本里**，磁盘上的任何内容都不会把凭证恢复成可接收。所以凭证在 `/reload`、`/tree`、会话切出再切回这些情况下都继续有效；**pi 进程重启后一律失效**（失败关闭），会话恢复时会收到一条「已失效」通知。session entry 降级为只用来生成这条通知。

### 修订声明（对 phase2 已拍板内容的修订，R0 已拍板）

| phase2 原文                                                                                                            | 本文修订                                                                                                                                                                                                                                                                                                           |
| ---------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| §2.4 D1（`phase2-plan.md:124`）：「发送端 pending 授权本期不需要（回复 = 对消息头 `from.ref` 普通发送）；第三期」      | **推翻**：本期实现发送端 pending 凭证（§3），只限主会话（第三期子 run 的凭证仍属第三期）                                                                                                                                                                                                                           |
| Q10「跨会话不回传结果」：§6.4（`:642`）、XR3（`:728`）、§12.2 明确不做（`:742`）中的「结果回传；跨会话 `wake_result`」 | **只修订一处**：允许「请求方用 `expectReply` 显式声明 + 被请求方的**模型**用 `replyTo` 主动发出」的回复关联。**仍然不做**：①自动 `wake_result`（B 的唤醒 run 结束时由系统回传摘要/终态）；②run 终态（completed/aborted/timed_out）跨会话回传；③没有 `expectReply` 的普通消息的任何结果回传；④revive/park、自动重试 |

**为什么不做自动 `wake_result` / 终态回传**：①B 的唤醒 run 结束不等于任务完成：B 的模型可能分多轮做完，可能被人接管（`handedOver`），也可能做完后还在做别的事，系统无法判断哪段输出算「结果」；②自动回传会把 B 的不可信最终文本，在 B 的模型没有确认的情况下注入 A，XR3 的注入面因此扩大；③「B 没回」这种情况由超时通知（§7.2）兜底。修订后 XR3 的处置改为：「不可信头 + nonce；只能发给显式加入的会话；**只有显式请求的回复会回传，且只接受 hub 盖章的原收件人**；agent 不能加入」。phase2 §9 末行（「与 `wake_result` 无关」）保持不变：回复是普通的 xs 消息。

---

## 0. 需求摘要（用户已确认，原样收录）

- 目标：会话 A 用 message_session 给会话 B 发一个「自然语言任务」（通常 wake:true 让 B 的模型起一轮执行），并声明期待回复（带超时）。B 的模型执行完后用一个明确的回复关联（如 message_session 的 replyTo 参数）把结果回给 A。A 能可靠拿到结果：结果到达时通知 A（应能唤醒 A 处理），超时未回也通知 A。
- A 可设置为「只接受回复、不接受主动触发」：未关联到 A 自己发出的有效请求的消息/唤醒一律拒收；有效回复可以投递并唤醒 A。
- 不做：B 端直接执行斜杠命令（不经模型）；子 run 参与跨会话（第三期）；飞书入口。
- 现状：回复只是对消息头 from.ref 的普通 message_session，无关联 id，A 不记 pending；A 的 receive 只有 off|deliver|wake + allowFrom/block，无法表达「只收回复」。message_session 返回值只是投递 effect。

**追加需求（主会话 2026-10-22 转达，§9 单独成节、单独分包）**：人在会话 A 输入 `@<会话> 消息` ⇒ 作为跨会话消息发给 B（等价于 `message_session` 带 `wake:true` 并自动加上 `expectReply`），因果 level 按人类输入记为 0；@ 补全追加会话条目；xs 关闭或本会话未 join 时，@ 的行为和补全逐字节不变。

**「可靠」的承诺边界（r2 明确写出）**：在 A 的 pi 进程存活期间（含 `/reload`、`/tree`、切走再切回），每个请求恰好得到「一条回复」或「一条超时/失效通知」二者之一（准入失败时通知可能被丢弃，但会计数，§7.2）。A 的进程重启后，未决请求一律失效，回复会被拒收，恢复会话时给出一条失效通知（branch 上看不到签发记录时没有这条通知，见 RR3）。

---

## 1. 现状与差距（已对照代码核实）

| #   | 位置                                                                                                                                                    | 现状                                                                                                                                            | 差距                                                                                |
| --- | ------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------- |
| G1  | `src/tools/message-session-tool.ts:20-39,56,61-70`                                                                                                      | schema 是冻结的模块常量 `{to,text,wake?}`；描述写「回复 = 对 from.ref 发消息」；返回值就是 `XsSendOutcome` 的 JSON                              | 没有 `expectReply`/`replyTo`，返回值没有 requestId                                  |
| G2  | `src/fabric/xs/sender.ts:306-420`                                                                                                                       | resolve → 预检 → 一次 send；send 发的是**原始 `to`**（`:368-374`），hub 会再解析一次（`router.ts:271-279`）；`resolvedTarget` 只有 `{ref,name}` | 拿不到完整 sessionId；**存在二次解析窗口**（评审 #3）                               |
| G3  | `src/web-hub/protocol/xs.ts:180,188,211,301,338,376`                                                                                                    | 帧 schema 全部 `additionalProperties:false`；`ReceiveSchema` 只有三个取值；`xs_res.target` 是宽松对象（`:277`）                                 | 旧解码器会**静默丢掉整帧**（`messages.ts:2252`），新字段必须按能力位门控            |
| G4  | `src/fabric/xs/format.ts:37-45`                                                                                                                         | 消息头固定写「回复请用 message_session 指向 header 的 from.ref」                                                                                | 没有 reply_to、截止时间和回复指引                                                   |
| G5  | `src/fabric/xs/receiver.ts:255-263,280-289,298-341,349-400`                                                                                             | 阶段 3 只看 joined/receive/allowFrom/block；阶段 6 统一做速率和 inbox 检查；Controller 降级后还会经过第二次 `beginDispatch`（`:348`）           | 不识别回复；replies-only 无法表达；消费与撤销的分支需要逐条写清（评审 #7）          |
| G6  | `src/fabric/xs/inbox.ts:61-66`                                                                                                                          | `accept()` 在满载时返回 false，并且**不登记**这条消息                                                                                           | 「绕过 inbox 拒收」不能直接复用（评审 #6）                                          |
| G7  | `src/fabric/root-wake.ts:47,248-258,291`                                                                                                                | receive 不等于 wake 就降级；hop 判定用 `level+1`；**Controller 不检查 joined**                                                                  | 不区分 solicited 唤醒；本地通知若直接调用 Controller，会绕开 joined 检查（评审 #2） |
| G8  | `src/fabric/xs/membership.ts:84,185-193,199-215`；`src/config/settings.ts:1804-1807`；`src/commands/fabric-xs.ts:37,105-109,181-184`                    | receive 被校验为三个取值之一；`leave` 不重置 receive；restore 会用 entry 里的 receive 覆盖默认值；配置值非法时回落到默认值 `wake`               | 新增 `replies` 后的降级方向必须是关闭（评审 #4）                                    |
| G9  | `src/web-hub/hub/xs/router.ts:129-160,216,231,281,294-314`；`limits.ts:135-152`；`members.ts:164-179`                                                   | hub 不区分回复；配对间隔对 B→A 的回复同样生效                                                                                                   | 缺少字段透传、replies-only 早拒、精确地址校验                                       |
| G10 | `src/web-hub/agent/connection.ts:173-186,414-433`；`agent/index.ts:862-867,1264-1267`                                                                   | `SlotFlush` 能在每次写出 slot（包括重放）时按 hub caps 改写帧；`onHubCaps` 只重发 commands 和 member                                            | status slot 需要同样的 flush（评审 #9）                                             |
| G11 | `src/stack.ts:1627-1782`；`src/index.ts:564-589`                                                                                                        | 每个 stack 一套 xs 组件；旧 stack 在会话切换时 dispose                                                                                          | 缺少凭证账本、超时调度、通知准入的装配                                              |
| G12 | `src/web-hub/agent/command-policy.ts:124-143,238-241`                                                                                                   | `FABRIC_KNOWN_SUBS` 是硬编码表，未列出的子命令一律 deny                                                                                         | `/fabric replies` 需要加进去（评审 #13）                                            |
| G13 | `src/mention/mention.ts:19-26,63-106,109-127`；`autocomplete.ts:51-98`；`src/index.ts:929,1034-1063,1145,1325`；`src/web-hub/agent/commands.ts:297-340` | parseMention 只认完整前导 `@label message`，只有在 registry 命中时才拦截，否则放行给 pi；补全只列 subagent；错误统一用 `subagent:mention-error` | 不识别会话；会话列表在 hub（异步）                                                  |

---

## 2. 总体设计

```
会话 A（请求方）                                   hub                                   会话 B（被请求方）
message_session{to,text,wake,expectReply}
 └ sender: resolve(to) ⇒ target.sessionId（双方都有 cap 才回填）
   → ReplyLedger.issue（进程内存账本；session entry 只供重启后生成通知）
   → xs_req{send, to:<完整 sessionId>, expect} ──▶ 精确地址校验，盖章 from，透传
                                                     xs_deliver.reply{requestId,dueAt} ──▶ receiver 常规管道；消息头带回复指引
                                                                                         message_session{to,text,replyTo}
                                                   ◀── xs_req{send, to:<完整 A sessionId>, replyTo} ── sender：inbound 核对 + 地址固定
 receiver 阶段 3b：classify ⇒ reserve（宿主调用之前）     ◀── xs_deliver.inReplyTo（wake:false，免配对间隔）
   ⇒ dispatch ⇒ commit / release（§6.3 状态机）
 ReplyLedger.sweep（惰性、进程级）+ 每 stack 一个调度器 ⇒ 超时通知走 NoticeGate（§7.2）
```

新增模块（全部 pi-free）：`src/fabric/xs/reply-ledger.ts`（账本、状态机、sweep、调度、通知队列）、`src/fabric/xs/reply-notice.ts`（NoticeGate 准入与文案）、`src/fabric/xs/directory.ts`（会话目录缓存，@mention 专用）、`src/mention/session.ts`。

---

## 3. 回复凭证（ticket）

### 3.1 签发与绑定

由请求方 A 的 agent 签发；hub 只透传、盖章，**不保存任何凭证状态**。

```ts
export type XsReplyState =
  | "pending" //       可接收（按时）
  | "consuming" //     已 reserve，派发进行中（同一同步块内的瞬态，§6.3）
  | "timed_out" //     可接收（迟到，now < lateUntil），超时通知已发出或在 noticeOwed 中
  | "replied" //       已消费（墓碑）
  | "late_replied" //  已消费（墓碑）
  | "send_failed"; //  send 被证明未送达
export interface XsReplyTicket {
  requestId: string; // "q" + 18 hex；用于关联，不是秘密
  requesterSessionId: string;
  replierSessionId: string; // 完整 sessionId，同时是 send 的固定地址（§4.2）
  replierRef: string;
  replierName?: string;
  origin: "model" | "human";
  wakeOnReply: boolean; // model ⇒ true；human ⇒ false（R4）
  requesterLevel: number; // human ⇒ 0
  issuedAt: number;
  dueAt: number;
  lateUntil: number; // dueAt + lateGraceS
  state: XsReplyState;
  priorState?: "pending" | "timed_out"; // 只在 consuming 时有值，release 时恢复到它
  sendEffect?: "applied" | "none" | "unknown";
  consumedBy?: string; // 回复的 xid
  noticeOwed?: "timeout"; // 超时通知还没有通过准入
}
```

- 只认 sessionId，不认 epoch（B 做 `/reload` 或 restore 后回复依然有效）。`maxReplies` 固定为 1（R5）。
- `wakeOnReply` 在签发时就定下来，之后不变。

### 3.2 不可伪造性

校验条件：`ledger.get(inReplyTo)` 存在 ∧ `ticket.requesterSessionId === 本 stack 的 sessionId` ∧ `frame.from.sessionId === ticket.replierSessionId` ∧ `state ∈ {pending, timed_out ∧ now < lateUntil}`。`from` 由 hub 根据四方绑定盖章（phase2 §8.1/XI4），第三方会话 C 即使拿到 requestId 也无法冒用；requestId 泄露无害。这一点已经核实：hub 构造 `from` 时只用自己的 socket/member 记录，不采信帧内字段（`router.ts:294-318`）。不防：同一个 B 用自己持有的另一张凭证回复（内容混淆，属于 B 模型本身的问题），以及同 uid 的恶意进程（不在威胁模型内）。

### 3.3 状态的存放位置（r2 重做，闭合 Blocker #1）

| 存储                                                                                                                                                                                                                 | 作用                                                              | 能否让凭证变成可接收   | 生命周期                                          |
| -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------- | ---------------------- | ------------------------------------------------- |
| 进程账本 `Symbol.for("pi-subagent:xs-reply-tickets")`：`Map<requestId, ticket>`                                                                                                                                      | **唯一的权威来源**：可接收性、消费墓碑、配额、noticeOwed 都在这里 | **能（唯一能的地方）** | 随进程存在；跨 `/reload`、`/tree`、会话切换都保留 |
| session entry `subagent:xs-reply`，`{v:1, op:"issue"\|"settle", requestId, requesterSessionId, replierRef, dueAt, lateUntil, state?}`（读回时 `requesterSessionId` 必须等于当前会话，fork/复制来的记录忽略，同 P10） | **只用来在进程重启后生成「已失效」通知**                          | **永远不能**           | 和普通 entry 一样；读回只走 `getBranch()`         |

**恢复规则**：账本里没有的 requestId，一律按 `invalid` 处理并拒收（失败关闭）。任何代码路径都不会根据磁盘记录把凭证恢复成 pending。所以：

- **`/tree` 回退复活**（评审给出的反例：消费发生在分支 X，回退到分支 Y）：可接收性不按分支区分，Y 分支上 entry 缺少 settle 记录也不会影响内存账本 ⇒ 墓碑仍在 ⇒ 重复回复被拒。
- **墓碑被淘汰后复活**：墓碑在 `lateUntil` 之前**不可淘汰**（§3.4 表）；过了 `lateUntil`，无论凭证处于什么状态都不可接收，删掉条目后查不到 = 拒收，结论不变。
- **进程重启复活**：重启后账本为空 ⇒ 拒收。这是有意收窄的承诺（RR3）。
- **持久化失败**：appendEntry 失败只会影响重启后那条失效通知（可能缺失，或者把实际已经收到回复的请求也列进去，文案里说明了这种可能），**不影响**可接收性，也不影响「至多一次」。

**重启失效通知**：新进程第一次构建 stack 时，扫描 branch 中的 `issue` 记录。对没有终态 settle 记录、账本里也没有、并且 `dueAt + lateGraceS` 还没过的请求（最多列 16 条，其余写成「另有 N 条」），通过 NoticeGate（§7.2）发出一条 quiet 通知：「以下跨会话请求在 pi 重启前未确认收到回复，凭证已失效，对方的回复将被拒收：q…→<ref>。若已收到请忽略。」发出后追加一条 `settle{state:"invalidated"}` entry，避免下次重启时重复通知（这条 entry 同样只影响通知，不影响凭证）。

### 3.4 状态表（评审 #5）

| 状态                           | 可接收     | 占每会话配额¹                    | 占进程槽位 | 可被 sweep 删除          | 转移                                                                  |
| ------------------------------ | ---------- | -------------------------------- | ---------- | ------------------------ | --------------------------------------------------------------------- |
| `pending`                      | 是（按时） | 是                               | 是         | 否                       | dueAt ⇒ `timed_out`；reserve ⇒ `consuming`；send none ⇒ `send_failed` |
| `consuming`                    | 否²        | 是                               | 是         | 否                       | commit ⇒ `replied`/`late_replied`；release ⇒ `priorState`             |
| `timed_out`（now < lateUntil） | 是（迟到） | 是                               | 是         | 否                       | reserve ⇒ `consuming`；lateUntil ⇒ 删除                               |
| `replied` / `late_replied`     | 否（墓碑） | 否（改由 replyInbox 占用，§6.4） | 是         | `now ≥ lateUntil` 时删除 | —                                                                     |
| `send_failed`                  | 否         | 否                               | 是         | 立即可删                 | —                                                                     |

¹ 每会话配额 = 可接收或 consuming 的凭证数 + 本 stack replyInbox 的占用数 ≤ `reply.maxPending`（默认 8）；按目标统计时只数可接收和 consuming 的，≤ `maxPendingPerTarget`（默认 3）。
² consuming 期间如果同一个 requestId 的重复回复（包括同步重入）到达，classify 结果为 `invalid`，拒收。

- **进程槽位**：总容量 64。签发时如果容量已满，先跑一次 sweep；仍然满就拒签，返回 `reply_ledger_full`，**从不淘汰**不可删除的条目（B1 精神）。因为每个条目都在 `lateUntil`（≤ maxTimeoutS + lateGraceS ≤ 25h）后可以删除，满载是会自愈的。
- **跨会话惰性过期**：`ledger.sweep(now)` 处理**进程内所有会话**的条目，不依赖某个会话自己的调度器还活着。在 issue、classify、restore、`/fabric status`/`replies`，以及当前 stack 的调度器触发时都会调用。sweep 对非当前会话的 pending 条目到期时：转成 `timed_out`，并设置 `noticeOwed:"timeout"`；到 `lateUntil` 时删除，如果此时通知还没发出，就给该会话的 `droppedNotices` 计数 +1（进程级 `Map<sessionId, count>`，最多 32 项，FIFO）。
- **切回旧会话**：restore 时先 sweep，然后把本会话的 `noticeOwed` 交给 NoticeGate 处理；如果 `droppedNotices[sessionId] > 0`，再补一条 quiet 汇总：「N 个请求在会话离开期间超时并已过期」，然后把计数清零。
- **restore 溢出**：restore 不会从磁盘重建任何条目，所以不存在溢出问题（r1 的溢出疑问随之消失）。

---

## 4. 工具面

### 4.1 `message_session` schema（新增参数）

```ts
expectReply: Type.Optional(Type.Object({
  timeoutS: Type.Optional(Type.Integer({ minimum: 60, maximum: 86_400,
    description: "How long to wait for the reply (default fabric.crossSession.reply.defaultTimeoutS = 1800)." })),
}, { additionalProperties: false, description:
  "Ask the recipient to reply with replyTo. You get a notification when the reply arrives (it may wake you) " +
  "or when the timeout passes without one. One reply per request. Pending requests do not survive a pi restart." })),
replyTo: Type.Optional(Type.String({ pattern: "^q[0-9a-f]{18}$", description:
  "Answer a request you received: copy the reply_to id from its header. Exactly one reply is accepted; " +
  "wake is ignored (the requester decides whether a reply wakes it)." })),
```

- `to` 仍然必填；`expectReply` 与 `replyTo` 同时出现 ⇒ 本地拒绝 `bad_args`（RR6）。
- 两个冻结实例：`reply.enabled=false` 用 `MessageSessionParamsLegacy`（与当前 `:20-39` 逐字节相同），否则用新实例。activate 时选定（同 wake 开关先例）。hub 或对端缺少 cap 时，在运行时返回 `reply_unsupported`。

### 4.2 发送端（`src/fabric/xs/sender.ts`）

`message(args)` 增加 `expectReply?`、`replyTo?`、`origin?: "model"|"human"`、`levelOverride?: 0`。

**地址固定（评审 #3）**：在 expectReply 和 replyTo 两个分支里，send 帧的 `to` **一律使用本次核对通过的完整 sessionId**，绝不再发原始名称或 ref。hub 对带 `expect`/`replyTo` 的帧要求 `to` 必须**精确等于**某个有效成员的 sessionId（不走前缀或名称解析），否则返回 `E_XS_BAD_FRAME`；唯一有效持有者检查照旧（两个持有者 ⇒ `E_XS_AMBIGUOUS`，目标已退出 ⇒ `E_XS_NO_TARGET`）。二次解析窗口因此消除：名称改绑或 ref 歧义变化最多导致 send 被拒（none），不会把请求发错对象。

**expectReply 分支**（在 `:347` 之后、`:368` 之前，中间没有 await）：

1. 若 `!port.replyCapable()` 或 `target.sessionId` 缺失（hub 只有在双方都声明 cap 时才回填，§5.2）⇒ `reply_unsupported`，不发送。
2. 可收性预检：本 stack 存在 ∧ joined ∧ **有效 receive**（§8.1）≠ off ∧ `senderAllowed(target)`；否则返回 `reply_unreceivable{receive_off|blocked|not_joined}`。
3. `ledger.canIssue(sessionId, target)`（配额见 §3.4）；否则返回 `reply_quota` 或 `reply_ledger_full`。
4. `ledger.issue()` 先写进程账本（同步），再 best-effort `appendEntry(issue)`。
5. 发送 `xs_req{send, to: target.sessionId, expect:{requestId, timeoutMs}, wake?, level?}`。
6. `ledger.recordSend(requestId, effect)`：`none` ⇒ `send_failed`；`applied`/`unknown` ⇒ 保持 pending。origin 守卫在发送前失败 ⇒ `send_failed`；在发送后失败 ⇒ 保持 pending（r3 M2）。

**replyTo 分支**：

1. 若 `!port.replyCapable()` ⇒ `reply_unsupported`。
2. `resolve(to)` 得到 `target.sessionId`（缺失 ⇒ `reply_unsupported`）。
3. inbound 核对：`inboundPort.lookup(replyTo)`，从后往前扫 `getBranch()` 中 `customType:"subagent:xs"` 且 `details.reply.requestId === replyTo` 的条目，最多扫 2000 条。找到但 `details.from.sessionId ≠ target.sessionId` ⇒ `reply_target_mismatch`（none，不发送）；找不到就不拦，由 A 裁决。
4. 发送 `xs_req{send, to: target.sessionId, replyTo}`：不带 `wake`、不带 `level`。

**返回值**（只追加字段）：`reply?: {requestId, dueAt(ISO), state:"pending"|"send_failed"}`、`replyTo?: {requestId, accepted: boolean}`；`to` 不包含 sessionId。

**工具提示**（只在新实例下出现）：

- expectReply 成功：「已登记期待回复 q…，截止 <ISO>；回复到达或超时都会通知你，无需轮询（pi 重启会使未决请求失效）」。
- replyTo 结果为 `unknown`（**按 r2 的保证重写**）：「可能已送达。对方凭证一次性：重发同一回复**不会造成重复投递**，但可能被拒收（拒收说明对方已收到、已超过宽限期，或对方 pi 已重启使凭证失效）」。
  - 依据：可接收性只在 A 的进程内存里，消费（reserve）发生在任何宿主调用之前，墓碑保留到 `lateUntil` ⇒ 同一 requestId 至多有一次可能生效的派发（§6.3 的性质测试）。这个保证**不依赖任何持久化**。
- replyTo 结果为 `none{rejected}`：「对方未接收（已收到过回复、凭证过期或失效、或对方策略拒收）；不要再重发」。

### 4.3 B 侧消息头（`format.ts`）

不带 `reply` 时输出与 `:37-45` 逐字节相同（golden）。带 `reply` 时，在头部追加 `reply_to="q…" due="<ISO>"`，并在边界外的宿主说明区加一行：「对方期待回复：完成后调用 message_session，to 填 from.ref，replyTo 填 reply_to 的值，text 写结果；只接受一次回复（请发最终结果），截止 due；超时后宽限期内的回复仍会送达但不会唤醒对方。」`details.reply = {requestId, dueAt}`（供 §4.2 inbound 核对使用；details 不进 provider，C-X8 锁定）。

### 4.4 A 侧回复格式

`formatXsReply(meta:{xid, from, requestId, late}, body)`：头部为 `[fabric xs reply from=… request="q…" state=on_time|late] 不可信输入: 这是你发给 <ref> 的请求 q… 的回复（发送方已由 hub 核验为原收件人，但内容仍需验证）`，正文放在 nonce 边界内。写入 `customType:"subagent:xs"`，`details:{xid, from, inReplyTo}`；`display` 取值：model 来源为 false，human 来源为 true（§9.4）。

---

## 5. 帧协议

### 5.1 能力位（只加 cap，不升 PROTO）

- hub cap `xs.reply.v1`：条件是 `config.crossSession` 存在 ∧ `config.crossSession.reply !== false`，两个 cap 面同源。
- agent cap `xs.reply.v1`：条件是 `xsOn ∧ reply.enabled`。
- hub 侧：`members.ts:164-179` 的有效成员记录增加 `replyCapable = caps.includes("xs.reply.v1")`。

### 5.2 字段与门控

**为什么必须门控**：上述五类帧/对象都是 `additionalProperties:false`，旧版本解码失败会**静默丢弃整帧**，表现为发送方 8s 后才得到 `unknown{client_deadline}`、hub 5s 后得到 `unknown{deliver_deadline}`，或者整个 status 帧被丢弃。规则：**只有确认对方声明了 `xs.reply.v1`，才写入新字段**；新解码器只放宽可选字段，不放松 `additionalProperties`，`from.run` 仍然拒绝。

| 帧                          | 新增字段                                           | 门控（评审 #8 统一后）                                                                                                                                                                                 |
| --------------------------- | -------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `xs_req{send}`              | `expect?:{requestId,timeoutMs}`、`replyTo?`        | 发送方：hub caps ∋ `xs.reply.v1`                                                                                                                                                                       |
| `xs_res`（resolve 与 send） | `target.sessionId?`（宽松对象，旧 agent 也能解码） | hub：**请求方 ∧ 目标**都 `replyCapable` 才回填；resolve 和 send 两条响应路径都按这个规则                                                                                                               |
| `xs_deliver`                | `reply?:{requestId,dueAt}`、`inReplyTo?`           | hub：目标 `replyCapable`；目标没有 cap 时（理论上 §4.2 第 1 步已经拦住）⇒ 在预占之前 `refuse("E_XS_REPLY_UNSUPPORTED")`，该码属于 `PROVABLE_NONE_CODES`                                                |
| `xs_ack`                    | 无新字段；reason 新增 `reply_late`                 | —                                                                                                                                                                                                      |
| `xs_member`                 | `receive` 取值加 `"replies"`                       | `SlotFlush`：hub 缺 cap ⇒ 写成 `"off"`                                                                                                                                                                 |
| `status` slot 的 `xs`       | 同上                                               | **status slot 也注册 SlotFlush**（评审 #9）：slot 里保存未降级的原始帧，每次实际写出（`setSlot` 的即时写和 hello_ack 重放）都按当前 hub caps 转换；旧 hub ⇒ `"off"`，再次连上新 hub ⇒ 恢复 `"replies"` |

**16 KiB 帧预算**：`sender.ts:177` 的 `sendFrameBytesOk` 最坏形状加上 `to` 为 128 字符、`expect:{requestId, timeoutMs: 86_400_000}`、`replyTo`；hub `router.ts:294` 的 `build(true,…)` 预检加上 `reply:{requestId, dueAt: MAX_SAFE_INTEGER}` 和 `inReplyTo`。`reply_late` 符合 `TOKEN_RE`（`router.ts:52`）。

**兼容矩阵**：

| 组合                 | 结果                                                                                 |
| -------------------- | ------------------------------------------------------------------------------------ |
| 新 A + 旧 hub        | `reply_unsupported`；普通发送不变；`replies` 在线上写成 off（member 和 status 都是） |
| 新 A + 新 hub + 旧 B | resolve 不回填 ⇒ 预检阶段直接 `reply_unsupported`（不会走到 send）                   |
| 旧 A + 新 hub + 新 B | A 不发 expect；B 的表现与现在相同                                                    |
| 新 hub、两端都旧     | hub 从不发新字段                                                                     |

### 5.3 hub 路由（`router.ts`、`limits.ts`）

- 带 `expect` 或 `replyTo` 的 send：`to` 必须精确匹配某个有效成员的 sessionId；校验目标 cap；`expect.timeoutMs` 范围 60s–24h（越界 ⇒ `E_XS_BAD_FRAME`）。
- ③ 早拒：`receive==="off"` ∨（`receive==="replies"` ∧ 没有 `replyTo`）⇒ `none{rejected}`。
- 回复帧：`build(wake=false)`，不预占 wake 配额；`admitSend({isReply:true})` 跳过 `rate_pair_interval`，其余计数照旧。
- list（`:216`）额外过滤 `receive==="replies"` 的会话；resolve 仍能找到它们。审计行增加 `reply:"expect"|"reply"`。

---

## 6. 接收端

### 6.1 `replies` 取值（R1 已拍板）

| 模式      | 主动消息              | 有效回复                            |
| --------- | --------------------- | ----------------------------------- |
| `off`     | 拒收                  | 拒收（发送端不让签发）              |
| `replies` | 拒收 `none{rejected}` | 投递；`wakeOnReply` 时走 Controller |
| `deliver` | 只投递                | 只投递（`receiver_policy`，R2）     |
| `wake`    | 原真值表              | 投递；`wakeOnReply` 时走 Controller |

### 6.2 管道（`receiver.ts`）

1–2. expiry、dedup：不变。3. 成员与策略：`joined ∧ receive ≠ off ∧ senderAllowed(from)`，不变。
**3b. 回复分类**：`classify(inReplyTo, from.sessionId, now)` 先调用 `ledger.sweep(now)`，结果为：

- `unsolicited`：`receive==="replies"` ⇒ `none{rejected}`；否则走原路径。
- `reply`/`late`：继续。
- `invalid`：统一返回 `none{rejected}`。

4. 目标身份：不变。
5. 栅栏：命中 ⇒ `none{fenced:*}`，**不 reserve**。
6. 回复类：**不检查也不计入** `recvPerHour`；**不使用普通 inbox**，改用 `replyInbox`（§6.4）。主动消息：不变。
7. 决策：`reply ∧ wakeOnReply ∧ 有效 receive ∈ {wake, replies} ∧ controller` ⇒ Controller 路径；其它回复 ⇒ 只投递（`late` 的 ack 带 `reason:"reply_late"`）。
8. 派发与结算：按 §6.3 状态机执行。

### 6.3 消费状态机（评审 #7：每个返回值都列出）

原则：**reserve 发生在任何可能重入的宿主调用（Controller.dispatch、host.sendMessage）之前**；只有在同步块内能证明「没有生效」时才 release，其余一律 commit。账本操作都是纯内存、同步的，不会失败；`appendEntry(settle)` 放在最后，best-effort。

```
classify ⇒ reply/late
  └─ reserve(requestId, xid)           // state → consuming，记录 priorState；replyInbox 预占 1 格
     ├─ [Controller 路径] guard = fence.beginDispatch()
     │    ├─ guard 拒绝（非 wakeOnly）                         ⇒ release；none{fenced:*}
     │    ├─ guard wakeOnly(goal)                               ⇒ 转只投递路径（wakeDowngraded:goal）
     │    └─ markDispatched(); r = controller.dispatch(...)
     │         ├─ r.dispatched=true（applied / unknown{start_deferred}） ⇒ commit；replyInbox.accept(trigger)
     │         ├─ r.dispatched=false ∧ effect:none（expired / guard reason / rejected / session_changed / host_rejected）
     │         │                                                ⇒ release；none{r.reason}（Controller 已证明没有调用宿主，或宿主同步抛错）
     │         └─ r.dispatched=false ∧ wakeDowngraded           ⇒ 保持 consuming，转只投递路径
     ├─ [只投递路径] guard2 = fence.beginDispatch()
     │    ├─ guard2 拒绝（非 wakeOnly）                         ⇒ release；none{fenced:*}
     │    └─ markDispatched(); host.sendMessage(...)
     │         ├─ 同步抛错                                      ⇒ release；none{host_rejected}
     │         └─ 返回（applied / unknown{queued} / unknown{accept_unverified}，含 verify 失败）
     │                                                          ⇒ commit；replyInbox.accept(mode)
     └─ 任意位置异常（receiver 的 catch）：dispatched=false ⇒ release，none{receiver_error}
                                          dispatched=true  ⇒ commit，unknown{receiver_error}
```

- release：`state ← priorState`，释放 replyInbox 的预占。凭证仍然可接收，B 可以重发。
- commit：`state ← replied|late_replied`，`consumedBy=xid`，replyInbox 的预占转为实际占用。
- **重入**：如果宿主调用里同步重入，又来一条同 requestId 的回复，classify 看到 `consuming` ⇒ `invalid` ⇒ 拒收。
- **性质测试**（`xs-reply-ledger.property.test.ts`）：随机组合重复回复、同步重入、Controller 各种返回值、栅栏开关、宿主抛错、异常注入、sweep 时点、`/reload`（stack 重建、账本保留）、分支切换、进程重启（清空账本）。不变量：
  - 对每个 requestId，「可能生效的派发」（commit 的派发 + 结果不是可证明 none 的宿主调用）**至多 1 次**；
  - release 之后一定还能被接收（`now < lateUntil` 时）；
  - 重启后 classify 永远返回 invalid；
  - replyInbox 从不出现 accept 返回 false 的情况。
  - 「终态不可逆」只对 `replied`/`late_replied`/`send_failed` 断言；`consuming → priorState` 是合法转移。

### 6.4 回复的有界记账（评审 #6）

- 每个 stack 有独立的 `replyInbox = new XsInbox(reply.maxPending)`，与普通 inbox 并列（同一个类，不同实例）。release 规则沿用 phase2 §8.4（appended/queued 在之后启动的 run 结束时释放，trigger 在 run 结束时释放，session_start 时清零），挂在同一组 `beforeAgentStart`/`settled` 钩子上。
- **签发不变量**：`可接收或 consuming 的凭证数 + replyInbox.occupied ≤ maxPending`（§3.4 配额）。每张可接收凭证都预留了一个 replyInbox 格子，因此回复到达时 `replyInbox.accept` 一定成功；reserve 时先检查 `replyInbox` 的空闲格数，异常满载（理论上不可能）⇒ 不 reserve，返回 `none{inbox_full}` 并计入 `replyInboxAnomaly` 计数。
- **硬上限**：每会话 xs 消息占用 ≤ `inboxCap`（12）+ `reply.maxPending`（8）。human 来源的 quiet 回复会一直占着 replyInbox，直到人下一次发言起 run 并结束；在此之前，新的 @会话 或 expectReply 都会因为配额返回 `reply_quota`（提示「已有 N 条回复尚未进入对话，请先查看」）。连续 human quiet 往返因此会被这个上限挡住，不会无限积累。
- `/reload`（session_start）会清空 replyInbox：沿用 phase2 普通 inbox 的已接受语义，即重建后视为「已在上下文中」。

### 6.5 RootWakeController 改动（`root-wake.ts`）

- `RootWakeRequest` 增加 `solicited?: true; returnLevel?: number`；`receive` 端口返回**有效 receive**（§8.1），类型包含 `"replies"`。
- `:256` 改为 `receive==="wake" || (receive==="replies" && solicited)`，否则返回 `receiver_policy`。
- `solicited` 时跳过 `hopAllowed`，提交 level 时用 `raise(root, returnLevel)`，不 +1（R3）；`XsWakeRecord.levelMode?: "hop"|"return"`，`commitLevel`（`:47`）按此分支。S1 规则（deferred 真正启动时才提交）不变。
- 其余前置条件照旧，包括 `wakesInPerHour`：回复唤醒计入该额度。B1 孤儿中止规则自动覆盖回复唤醒。
- **Controller 本身仍然不检查 joined**；所有调用方负责准入：receiver 由阶段 3 保证，超时通知由 NoticeGate 保证（§7.2）。

### 6.6 真值表新增行（`tests/fabric/xs-truth-table.test.ts`）

| 类别 | 有效 receive | 凭证                            | wakeOnReply | 其它                            | 结果                                                |
| ---- | ------------ | ------------------------------- | ----------- | ------------------------------- | --------------------------------------------------- |
| 主动 | replies      | —                               | —           | —                               | `none{rejected}`（hub 早拒，接收端再判一次）        |
| 回复 | off          | 任意                            | —           | —                               | `none{rejected}`，不 reserve                        |
| 回复 | 任意         | invalid（含 consuming、重启后） | —           | —                               | `none{rejected}`                                    |
| 回复 | replies/wake | pending                         | true        | 前置条件都满足                  | Controller(solicited)，level=requesterLevel，commit |
| 回复 | replies/wake | pending                         | true        | busy/host/goal/配额/ledger_full | 只投递 + 对应降级原因，commit                       |
| 回复 | replies/wake | pending                         | true        | Controller 返回 none            | release，`none{reason}`                             |
| 回复 | replies/wake | pending                         | true        | 降级后第二次 guard 被栅栏拒绝   | release，`none{fenced}`                             |
| 回复 | deliver      | pending                         | true        | —                               | 只投递 `receiver_policy`，commit                    |
| 回复 | 任意 ≠ off   | pending                         | false       | —                               | 只投递，display:true，commit                        |
| 回复 | 任意 ≠ off   | timed_out ∧ now < lateUntil     | —           | —                               | 只投递 `reply_late`，commit                         |
| 回复 | 任意         | 可接收                          | —           | 阶段 5 栅栏命中                 | `none{fenced}`，不 reserve                          |
| 回复 | wake         | pending                         | true        | 接收端 `wake.enabled=false`     | 只投递 `wake_disabled`，commit                      |

---

## 7. 交付、超时、迟到

### 7.1 到达

通知就是回复消息本身（§4.4），不再额外发 notice。

### 7.2 超时通知与 NoticeGate（评审 #2）

**触发**：每个 stack 一个调度器，只给本会话最早的 dueAt 武装**一个**定时器（`systemClock`，分段、unref），触发时调用 `ledger.sweep` 把到期条目转为 `timed_out` 并设置 `noticeOwed`，然后调用 `gate.flush()`。非当前会话由惰性 sweep 处理（§3.4）。

**准入**：`NoticeGate.flush()` 的所有判断与写入在**同一个同步块**内完成；任一条件不满足 ⇒ **不写入**，保留 `noticeOwed`：

1. stack 未 dispose，且 `ctx.sessionManager.getSessionId() === requesterSessionId`；
2. `membership.joined`；
3. 有效 receive ≠ off；
4. `fence.beginDispatch()` 通过。如果只是 `wakeOnly`（goal），允许 quiet 写入，但不唤醒；
5. 唤醒条件：`wakeOnReply ∧ 有效 receive ∈ {wake, replies}` ⇒ `controller.dispatch({xid:"t_"+requestId, from:{kind:"local", reason:"reply_timeout"}, solicited:true, returnLevel, expiresAt: now+5000, content})`；返回 `dispatched:true` ⇒ 完成；返回降级 ⇒ 在同一同步块内改为 quiet 写入；返回 `none` ⇒ 不写入，保留 owed。不满足唤醒条件 ⇒ quiet 写入：`pi.sendMessage({customType:"subagent:xs-reply", display:true, content, details:{requestIds}}, {triggerTurn:false})`，参照 `workflow-notice.ts:113-129`；
6. 写入成功后 `fence.verifyDispatch(gen)`；无论结果如何都清除 owed（verify 失败只计入 `noticeUnverified`，**不重发**，NQ3）；宿主同步抛错 ⇒ 保留 owed。

**同一会话的多条 owed 合并为一条通知**。重试点（事件驱动，不轮询）：stack restore、`beforeAgentStart`/`settled`、fence 收到关闭证据的事件（`session_compact`/`session_compact_failed`/`session_tree`/`session_start`）、`/fabric join`、`/fabric receive`、`/fabric fence reset`，另加一个兜底定时器：存在 owed 时每 30s 重试一次（unref），直到对应条目的 `lateUntil`。到 `lateUntil` 仍未通过准入 ⇒ 丢弃，`noticeDropped` 计数 +1（leave 或 off 状态下的超时也走这条路：人已经关闭了 xs 入口，所以不显示）。

**禁止**：栅栏期间用 quiet 写入兜底。r1 的这个做法已删除。

**重启失效通知**（§3.3）与**离开期间过期汇总**（§3.4）走同一个 NoticeGate，并且总是 quiet，不唤醒。

### 7.3 迟到

宽限期内的回复只投递、不唤醒，状态记为 `late_replied`；`lateUntil` 之后条目被删除，回复拒收。

---

## 8. 设置、限额、安全、可见性、off 路径

### 8.1 设置与「replies 不可用 ⇒ off」统一规则（评审 #4）

```jsonc
"fabric": { "crossSession": {
  "receive": "wake",             // 允许值新增 "replies"
  "reply": { "enabled": true, "defaultTimeoutS": 1800, "maxTimeoutS": 86400,
             "maxPending": 8 /*1..32*/, "maxPendingPerTarget": 3 /*1..8*/, "lateGraceS": 600 /*0..3600*/ }
}}
```

**有效 receive** 由纯函数 `effectiveReceive(pref, replyEnabled)` 计算：`pref === "replies" && !replyEnabled ⇒ "off"`，其余情况 `= pref`。所有使用 receive 的地方都只读有效值：

| 场景                                             | 规则                                                                                                                                                                                                                     |
| ------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| 配置解析                                         | `receive:"replies"` 总是被接受，作为偏好值。`reply.enabled=false` 时有效值为 off，并 `console.warn` 一次。**不回落到默认值 wake**                                                                                        |
| membership restore                               | entry 里保存的偏好值原样恢复，有效值按上面的函数计算；关闭再开启后，恢复为 replies                                                                                                                                       |
| membership 持久化（兼容旧插件，同时修复 r1 RR5） | 偏好为 replies 时，写 `{receive:"off", receivePref:"replies"}`。新代码优先读 `receivePref`；旧代码只认 `receive` ⇒ 读到 off ⇒ 失败关闭（旧版 `readXsMembershipEntry` 会忽略多出来的字段，`membership.ts:73-110` 已核实） |
| autoJoin                                         | autoJoin 只决定是否 join，不改 receive；默认 receive 为 replies 且回复功能关闭时，有效值为 off                                                                                                                           |
| `/fabric receive replies`                        | 回复功能关闭 ⇒ 拒绝，提示「回复功能未启用（fabric.crossSession.reply.enabled=false）」                                                                                                                                   |
| wire                                             | 回复功能开启但 hub 缺少 cap ⇒ slot flush 写成 off（本地有效值仍为 replies：主动消息照样在本地被拒，回复也无从到达，实际效果等同 off）                                                                                    |

### 8.2 防滥用与额度证明（评审 #10 重写）

- **B 刷回复**：凭证一次性；无效回复统一拒收；回复仍然计入 B 的 `sendsOutPerMin/Hour` 和 `hubSendsPerMin`。
- **凭证泄露**：绑定 replier，并由 hub 盖章。
- **堆积**：配额（含 replyInbox）加进程级 64，满了拒签，不淘汰。
- **回复唤醒形成循环（r2 修正后的上界）**：r1 说「每轮至少消耗一次出站唤醒 ⇒ 每对 ≤2 轮/小时」，这个论证不成立。`expectReply` 可以带 `wake:false`，双方都在运行时，交替发普通请求和关联回复不会消耗 `pairWakesPerHour`。实际上界是：每个会话由 xs 触发的自治 run（主动唤醒 + solicited 回复唤醒 + 超时通知唤醒）共用一个 `wakesInPerHour`（默认 12/h）；每次回复唤醒还必须对应一张由本会话签发的凭证，签发受 `sendsOutPerHour`（60/h）和配额 `maxPending`（8）约束；每个自治 run 受 `rootRunMaxS` 约束。因此，一对互相请求的会话，**每方每小时最多被 xs 唤醒 12 次**，而不是 2 次。产品没有要求「每对 ≤2 轮」，本期不另加 solicited 专用配额（列为 RR11）。
- **replies 模式下借道唤醒**：主动消息在 hub 和接收端都被拒收。

### 8.3 可见性（只用英文标记）

- `/fabric status` 增加一行：`replies pending 2/8 · inbox 1 · timedOut 1 · late 0 · rejected 3 · owed 0 · dropped 0 · ledger 5/64`。
- 新增只读子命令 `/fabric replies`：列出本会话的可接收和最近终态条目（requestId、ref、剩余秒数、状态、owed）。`FABRIC_KNOWN_SUBS`（`command-policy.ts:124`）加入 `replies`，基线 allow，`webCommandPolicy.fabric` 覆盖规则不变，未知子命令仍然 deny（评审 #13）。
- `/fabric receive` 的补全和用法加入 `replies`；`/agent status`（`status.ts:656`）显示 `recv replies · replies 2/8`；list 中不出现 replies 模式的会话；AgentCard 显示 `xs replies`。

### 8.4 off 路径与 golden

- xs 关闭 ⇒ 本方案的代码一行都不装配；`fabric-xs-off-golden.json`、`fabric-wake-off-golden.json` **不得重新生成，也不得修改**。
- xs 开启 ∧ `reply.enabled=false` ⇒ 新 golden `tests/fixtures/fabric-xs-reply-off-golden.json` 必须**在任何实现改动之前**从 dev 采集：message_session/list_sessions 的 schema 与描述、agent/hub caps、`formatXsMessage` 固定样例、`xs_member` 帧、status 的 xs 字段、membership entry 写出的形状（未设置 replies 偏好时）；之后这些都必须逐字节相同。
- `reply.enabled=true` 时，只有工具 schema 发生一次性的前缀变化。

---

## 9. 追加：@mention 寻址会话

### 9.1 语法与冲突规则（R6 已拍板，评审 #12 细化）

1. `parseMention`（`mention.ts:19`）**一行不改**：subagent label 优先。
2. 没有命中且 `sessions` 端口返回可用时，调用 `parseSessionMention`：
   - **显式形式** `^@session:(\S+)[ \t]+(\S[\s\S]*)$` ⇒ 拦截，交给 hub resolve。
   - **裸形式** `@x 消息`，必须**同时满足**：①`x` 匹配 `^[A-Za-z0-9_-]{1,64}$`（排除含 `.`、`/`、`~`、`\` 的路径形状）；②不是 subagent label；③可证明不存在同名文件：一次 `fs.lstatSync(resolve(cwd, x), { throwIfNoEntry: false })`，**仅当返回 `undefined`（ENOENT）时**视为不存在；返回 stat（存在，含悬空符号链接）或抛出任何其他错误（EACCES/ENOTDIR/ELOOP 等）一律按「冲突」放行给 pi（不用 `existsSync`——其 boolean 把错误折叠成 false，无法失败关闭）；路由与补全共用同一判定函数 `bareNameFileConflict(cwd, x)`，测试覆盖不存在/存在/检查报错三类（r2 复审 #12）；④目录缓存中 name 或 ref **唯一**精确等于 `x`。否则**放行**给 pi。
3. 语义对缓存新鲜度的依赖（列为残留 RR8）：缓存为空或过期（>10min）时裸形式被放行；显式形式不受影响。补全总是会给出确定的形式。

### 9.2 目录缓存（`src/fabric/xs/directory.ts`）

接口：`rows()`、`lookupExact()`、`refresh(reason)`、`ingest(rows)`、`dispose()`。规则：刷新间隔 ≥30s、single-flight、3s 截止、失败保留旧数据、10 分钟过期；epoch 变化、leave、`/new` 时清空。未 joined 时 `rows()` 返回 `[]`，`refresh` 什么都不做。**全部装配归 MW**（评审 #13），RXW 不碰。

### 9.3 路由

`MentionRouteDeps.sessions?: MentionSessionPort`：

- `parse(text)` 是同步的，**未 joined 或 xs 未连接时返回 undefined**（join 是 live 的，所以在调用时现查，不在装配时决定）。
- `send(target, message)` = `sender.message({to, text, wake:true, expectReply:{}, origin:"human", levelOverride:0})`。

`routeMention` 在 subagent 分支失败后尝试会话分支，新增返回值 `{handled:true; action:"session"; target; requestId?; effect}`（独立分支，不复用 runId 分支）。目标返回 `reply_unsupported` 时（还没有发过 send），去掉 expectReply 改为普通发送，并告知用户。web：`commands.ts:297-311` 的同步判定加上 `sessions?.parse`；`MentionResultData` 追加 `action:"session"` 变体（additive）。

### 9.4 回复呈现（R4 已拍板）

human 来源：`wakeOnReply:false`；回复与超时通知都是 `display:true` + `triggerTurn:false`。消息进入上下文，下一次人类发言时模型能看到。

### 9.5 补全

`MentionAutocompleteSource.sessions?()` 返回会话条目（数据来自目录缓存，触发 `refresh("complete")` 但不 await）。插入值规则：满足 §9.1 裸形式全部静态条件（①②③，以及名称在缓存中唯一）⇒ `@<name>`，否则 ⇒ `@session:<ref>`。也就是说，与 label、文件或路径冲突，或者名称有空格、有重名时，**必定插入显式 ref**。描述格式为 `session · <cwdLabel> · <receive> · <busy|idle>`；排在 agent 条目之后。没有会话条目时，原有 `:84` 分支原样返回。web composer：本期不做（坐标见 `Composer.vue:214`、`logic/mention.js:50`、`agentCardModel.ts:136`），手打 `@session:` 已能使用。

### 9.6 错误呈现

复用 `subagent:mention-error`，设置 `details.source:"mention-session"`。文案：

| 情形                      | 文案                                                                        |
| ------------------------- | --------------------------------------------------------------------------- |
| `no_target` / `ambiguous` | 找不到会话 / 有多个匹配                                                     |
| `none{rejected}`          | 对方拒收                                                                    |
| `none` 的其它原因         | 未送达（<reason>），可稍后重试                                              |
| `reply_quota`             | 已有 N 条回复尚未进入对话                                                   |
| `unknown`                 | 可能已送达，不要重发                                                        |
| 成功                      | 另发 `subagent:mention-session`（display）：→ 已发给 …（q…，等待回复 ≤30m） |

（「未 join」的文案已删除：未 join 时什么都不拦，见 §9.7。）

### 9.7 off 路径（评审 #11）

以下三种状态下，`sessions.parse` 都返回 undefined，`sessions()` 返回 `[]`，所有 `@` 输入（包括 `@session:`）都原样放行，补全输出逐字节不变：①xs off（端口不注入）；②xs on 但未 join；③leave 之后。测试 `tests/mention/session-off.test.ts` 对这三种状态分别做字节比对：TUI 的 parse/route/provider 输出，以及 web 的同步判定。

---

## 10. 需用户拍板的取舍点（推荐项放第一位）

| #   | 问题                                      | 推荐                                                                                                                                          | 理由（一句）                                                                      |
| --- | ----------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------- |
| R0  | 修订 Q10「跨会话不回传结果」的范围        | **只放开「显式 expectReply + 模型 replyTo」的回复关联**；仍然不做自动 wake_result / run 终态回传（备选：B 的唤醒 run 结束时自动回传终态摘要） | 只有 B 的模型知道什么才算「结果」；自动回传扩大注入面，可靠性已由超时 notice 兜底 |
| R1  | 「只收回复」的表达方式                    | **receive 新增取值 `replies`**（备选：独立维度 unsolicited accept/reject）                                                                    | 一条命令、线上降级只有一条规则（replies→off），没有难以理解的组合                 |
| R2  | 有效回复能否绕过 `receive=deliver` 去唤醒 | **不能，只投递**（备选：凭证即同意，可以唤醒）                                                                                                | deliver 的含义是「人不允许自治 run」，模型签发的凭证不应该推翻人的策略            |
| R3  | 回复唤醒的因果 level                      | **回到请求时 level，不 +1**（备选：照第一期 +1）                                                                                              | 回复是收尾而不是延长链条；循环已被请求方的出站唤醒额度限住                        |
| R4  | 人发起的 @会话，回复怎么呈现              | **只展示给用户，不唤醒 A**（备选：唤醒 A 的模型）                                                                                             | 答案给提问的人；省钱，也避免模型做未经要求的加工                                  |
| R5  | 凭证次数与迟到回复                        | **一次性；超时后 600s 宽限内的回复只投递、不唤醒**（备选：最多 N 次 / 超时即拒）                                                              | 一次性让「重发回复」变成幂等的；宽限期避免慢任务的结果白白丢掉                    |
| R6  | @会话的寻址语法                           | **subagent label 优先 + 显式 `@session:` + 缓存精确唯一时支持裸名**（备选：只支持显式前缀）                                                   | 兼顾顺手和零歧义，未命中照旧放行给 pi                                             |

> R0 与 R6 是主会话追加要求列入的，所以总数超出了 ≤5 的约定。建议 ask_user 只问 R0/R1/R2/R4/R6；R3、R5 若无异议直接按推荐执行。另外有一项实现层的取舍不提交拍板：`reply.enabled=false` 时按 wake 开关的先例选用 legacy schema 实例。这样工具形状只取决于 activate 时冻结的设置，与「形状不随运行时状态浮动」的约定（reply-explore 约束 2）一致：降级只出现在运行时结果字段里，例如 `reply_unsupported`。
>
> r2 注：R3 表中的理由「循环已被请求方的出站唤醒额度限住」已经由 §8.2 更正（实际上界是接收方的 `wakesInPerHour`），**拍板结论本身不变**。R5 的「重发回复幂等」在 r2 下依然成立（§4.2）。

### 10.1 用户拍板结果（2026-10-22）

- **R0**：按推荐执行（只放开显式 expectReply + replyTo；不做自动 wake_result / run 终态回传）。由需求本身确定，主会话裁定，未另行提问。
- **R1**：receive 新增取值 `replies`（用户拍板）。
- **R2**：不能——`receive=deliver` 下有效回复只投递、不唤醒（用户拍板）。
- **R3**：按推荐（回到请求时 level，不 +1），主会话裁定。
- **R4**：人发起的 @会话 回复只展示给用户、不唤醒 A 的模型（用户拍板）。
- **R5**：按推荐（一次性 + 600s 宽限，宽限内只投递不唤醒），主会话裁定。
- **R6**：subagent label 优先 + 显式 `@session:` + 缓存精确唯一时支持裸名（用户拍板）。

---

## 11. 分包计划（r2 更新）

文件所有权规则沿用 phase2 §11.1：`src/stack.ts`、`src/index.ts` 只属于串行的装配包（RXW、MW）。

| 包                                 | 文件域（允许新建）                                                                                                                                                                   | 冻结面                                             | 依赖                     | 测试 / 验收                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         | 估时 |
| ---------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | -------------------------------------------------- | ------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---- |
| **RX0** 契约 + golden              | **先采集** `fabric-xs-reply-off-golden.json`；`protocol/xs.ts`；`protocol/messages.ts`（MentionResultData）；`config/settings.ts`（`reply.*`、`replies`、`effectiveReceive` 纯函数） | 两份旧 golden；`formatXsMessage` 无 reply 时的输出 | —                        | `xs-frames.test.ts`（新字段可选，旧形状仍通过，`additionalProperties` 不放松）；`settings-fabric-xs.test.ts`（replies 在 enabled 开/关下的有效值，不回落 wake）；`fabric-xs-reply-off-golden.test.ts`                                                                                                                                                                                                                                                                                                                                                                                                               | 1d   |
| **RX1** 凭证账本                   | `src/fabric/xs/reply-ledger.ts`、`reply-notice.ts`（新）                                                                                                                             | —                                                  | RX0                      | `xs-reply-ledger.test.ts`：§3.4 状态表逐行；sweep 跨会话（≥9 个会话、64 满载拒签后自愈）；timed_out 宽限期内可接收且占配额；墓碑在 lateUntil 前不被删除；**Blocker 反例**：issue → 分支 X 消费 → 回退到分支 Y、重复回复 ⇒ 拒收；终态被删除后（lateUntil 已过）⇒ 拒收；**进程重启**（清空 Symbol 账本、branch 上只有 issue）⇒ 拒收 + 一条失效通知；**appendEntry 失败** ⇒ 可接收性不受影响、重启后通知缺失；`droppedNotices` FIFO；NoticeGate 准入矩阵（disposed/session/joined/receive/fence/wakeOnly）；`xs-reply-ledger.property.test.ts`（§6.3 的不变量）                                                        | 2d   |
| **RX2** hub                        | `hub/xs/{router,limits,members}.ts`、`hub.ts`、`main.ts`、`audit.ts`                                                                                                                 | 原 send/list 行为                                  | RX0                      | `xs-router.test.ts`：expect/replyTo 要求精确 sessionId（名称或 ref ⇒ BAD_FRAME）；目标缺 cap ⇒ REPLY_UNSUPPORTED 且不预占；**resolve 和 send 两条路径都只在双方都有 cap 时回填 sessionId**；replies 早拒/放行；回复 wake=false；list 过滤；`xs-limits.test.ts`：回复免配对间隔；caps-coexist                                                                                                                                                                                                                                                                                                                        | 1d   |
| **RX3** agent 连接                 | `agent/{xs.ts,connection.ts,index.ts}`                                                                                                                                               | slot 顺序                                          | RX0                      | `xs-client.test.ts`；`xs-member-slot.test.ts` 与 **`status-slot-flush.test.ts`**：真实 slot 重放「新 hub → 旧 hub → 新 hub」，期间没有新的 status 采样 ⇒ 旧 hub 收到 off，新 hub 收到 replies，旧 hub 从不丢 status 帧                                                                                                                                                                                                                                                                                                                                                                                              | 1d   |
| **RX4** 发送端与工具               | `fabric/xs/sender.ts`、`tools/message-session-tool.ts`                                                                                                                               | legacy 实例 = golden                               | RX0, RX1                 | `xs-sender.test.ts`：两个分支的 send `to` 一律是完整 sessionId；resolve 之后名称改绑 ⇒ 不发错对象；短 ref 歧义变化；原目标退出 ⇒ none；各种 `reply_*` 拒绝都不发帧；inbound mismatch；unknown/rejected 的提示文本；`message-session-tool.test.ts`                                                                                                                                                                                                                                                                                                                                                                   | 1.5d |
| **RX5** 接收端 + Controller + 命令 | `fabric/xs/{receiver,format,membership}.ts`、`fabric/root-wake.ts`、`fabric/xs/wake-ledger.ts`、`commands/fabric-xs.ts`、**`web-hub/agent/command-policy.ts`**                       | 原真值表各行                                       | RX1                      | `xs-receiver.test.ts`：§6.3 每条分支（同步重入、Controller 返回 none、降级后第二次 guard 被栅栏拒绝、宿主抛错、dispatched 前后的异常）；replyInbox（普通 inbox 已满时回复照样接收；连续 human quiet 往返在第 maxPending 次被 `reply_quota` 挡住；消息还没进入任何 run 时继续签发被拒）；`xs-truth-table.test.ts` 追加 §6.6；`root-wake.test.ts`（solicited / return level / replies 模式）；`membership` 的 receivePref 读写，以及旧版 reader 读到 off；`fabric-xs.test.ts`（receive replies 在关闭时拒绝，`/fabric replies`）；`command-policy-fabric.test.ts`（replies 为 allow，未知子命令 deny，override 生效） | 2.5d |
| **RXW** 装配                       | `stack.ts`（账本端口、调度器、NoticeGate 端口、replyInbox、inbound lookup）、`index.ts`（sender 端口、工具实例选择）                                                                 | —                                                  | RX1–RX5                  | §12.2 第 1–9 项                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     | 1.5d |
| **M** mention 核心                 | `mention/session.ts`（新）、`mention/{mention,autocomplete}.ts`、`fabric/xs/directory.ts`（新）、`web-hub/agent/commands.ts`                                                         | `parseMention` 的签名和行为                        | RX0（可与 RX1–RX5 并行） | `session.test.ts`（显式/裸形式；路径形状；真实文件与会话同名 ⇒ 放行；subagent 同名 ⇒ subagent；缓存过期前后）；`autocomplete-session.test.ts`（冲突时插入显式 ref）；`xs-directory.test.ts`；`session-off.test.ts`（三种状态）；`commands-mention-session.test.ts`                                                                                                                                                                                                                                                                                                                                                  | 1.5d |
| **MW** mention 装配                | `index.ts:929,1034,1145,1325`、`stack.ts`（只负责 directory 的构建与 dispose）                                                                                                       | —                                                  | RXW, M                   | §12.2 第 10 项                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      | 0.5d |
| **RX6** 可观测 + 终局              | `commands/status.ts`、UI 的 `AgentCard.vue`/`agentCardModel.ts`、AGENTS.md、conformance                                                                                              | —                                                  | RXW, MW                  | C-X8；终局命令：`npm run format:check && npm run typecheck && npm run build && npm run build:web && npm test && npm run test:conformance`；三份 off golden 都不变                                                                                                                                                                                                                                                                                                                                                                                                                                                   | 1d   |

**并行**：RX0 → {RX1 ∥ RX2 ∥ RX3 ∥ M} → {RX4 ∥ RX5} → RXW → MW → RX6。
**工作量**：约 13.5 人日；关键路径 RX0(1) → RX1(2) → RX5(2.5) → RXW(1.5) → MW(0.5) → RX6(1) ≈ 8.5 天。每包返回立即派 verifier，验收模型 ≠ 开发模型。r2 需要先过复审才能开工。

---

## 12. 测试计划

### 12.1 单测 / 表驱动

见 §11。另外：source-scan 门禁扩展到 reply-ledger、reply-notice、directory、mention/session；日志断言 hub.log 与审计不含正文。

### 12.2 集成（`tests/integration/fabric-xs-reply.test.ts`，真实 hub 子进程 + 两个真实 stack + 真实 socket）

1. **往返**：expectReply + wake ⇒ B 的消息头带 reply_to ⇒ B 回复（`to` 为完整 sessionId）⇒ A 的 Controller 起 run，level = requesterLevel。
2. **超时**：wake 路径与 quiet 路径；同一会话多条到期合并为一条通知。
3. **超时准入**：签发后 leave ⇒ 到期不写入，到 lateUntil 时 `noticeDropped`；`session_before_switch` 慢处理期间到期 ⇒ 不写入，切换取消后由 fence 关闭事件触发补发；compaction 期间到期 ⇒ 压缩完成后补发；到期后切到别的会话，再切回 ⇒ 补发；离开期间过期 ⇒ 切回时给出汇总。
4. **replies 模式**：主动消息被 hub 早拒，绕过 hub 注入也被拒；有效回复唤醒 A。
5. **迟到**：宽限期内只投递；宽限期后拒收。
6. **Blocker 反例端到端**：A 签发，B 回复并被消费，A `/tree` 回退到签发点之后、settle 之前的分支，B 用同一 requestId 重发 ⇒ `none{rejected}`；把 FakeClock 推到墓碑可删除之前再试一次 ⇒ 仍然拒收。
7. **reload 与重启**：`/reload` 后凭证仍有效；模拟进程重启后，回复被拒，并出现一条失效通知（只出现一次，再次重启不重复）。
8. **地址固定**：resolve 之后、send 之前把会话名改绑到 C ⇒ 请求不会到达 C。
9. **兼容与 hub 重启**：hub 关闭 reply 功能、旧 B；hub 重启时在途的回复 ⇒ B 得到 unknown ⇒ 重发 ⇒ 至多投递一次。
10. **@会话**（`fabric-xs-mention.test.ts`）：显式形式往返（level 0，A 显示回复且不触发轮次）；未 join 和 leave 后 `@session:` 原样放行；subagent 同名时走 subagent；cwd 下存在同名文件时裸形式放行。

### 12.3 conformance

新增 **C-X8**（真实 pi + 本地 stub）：①solicited 回复触发的 Controller run 能绑定 token；②provider 请求体中不出现 `details.reply`、`details.inReplyTo`、`wakeToken`；③quiet display 消息在 idle 时不起 run，并出现在下一次人类 prompt 的请求体里。在 pi peer 升级前与 C-X1…C-X7、C-P1…C-P5、consult-preserve C1–C7 一起运行。

---

## 13. 风险与残留窗口（r2）

| #    | 风险 / 残留                                                                                                                  | 处置                                                                                         |
| ---- | ---------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------- |
| RR1  | 签发之后、send 之前进程崩溃 ⇒ 重启后给出失效通知，但请求实际上从未发出                                                       | 通知文案写明「未确认」；不自动重发                                                           |
| RR2  | B 的回复丢失（hub 重启或断链）且 B 没有重发                                                                                  | 工具提示「重发不会重复投递」；最终由 A 的超时兜底                                            |
| RR3  | **A 进程重启 ⇒ 所有未决凭证失效（有意收窄的承诺）**；如果 branch 上看不到签发记录（`/tree` 跳分支 + 重启），连失效通知也没有 | 失败关闭方向；需要跨重启有效时，后续可以加分支无关的 sidecar 账本（需单独设计，见处置表 #1） |
| RR4  | A 会话之后一直不被 resume ⇒ 没有任何通知                                                                                     | 接受（没有人在等）                                                                           |
| RR5  | 用户在配置文件里写 `receive:"replies"` 后降级插件版本 ⇒ 旧解析器回落到默认值 wake                                            | membership entry 已经失败关闭（§8.1）；配置文件的问题写进发版说明                            |
| RR6  | 不支持「回复里再发起请求」                                                                                                   | 拒绝 `bad_args`                                                                              |
| RR7  | model 来源的回复 `display:false`                                                                                             | 与现有 xs 消息一致                                                                           |
| RR8  | 裸形式的语义取决于缓存新鲜度                                                                                                 | 显式形式和补全都是确定的；`/fabric status` 显示目录的年龄                                    |
| RR9  | 回复唤醒与主动唤醒共用 `wakesInPerHour` ⇒ 额度可能被耗尽，回复降级为只投递                                                   | 回复仍然送达；可以切到 replies 模式                                                          |
| RR10 | requestId 被 B 转告给第三方                                                                                                  | 不是秘密，绑定 replier                                                                       |
| RR11 | 每对会话的 solicited 往返上界是 12/h（共用 `wakesInPerHour`），不是 r1 声称的 2/h                                            | 如实写明；产品需要时再加 solicited 专用配额                                                  |
| RR12 | 超时通知准入一直不满足（长期 leave 或长期 stuck 栅栏）⇒ 通知被丢弃                                                           | 计入 `noticeDropped`，`/fabric status` 可见；人关闭了入口就不打扰                            |

---

## r2 处置表

| 评审 # | 严重度  | 处置                         | 说明                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      | 章节                                                |
| ------ | ------- | ---------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------- |
| 1      | Blocker | **已修（通过收窄承诺闭合）** | 可接收状态只存在于签发进程的内存账本中；磁盘内容永远不能把凭证恢复为可接收，查不到的 requestId 一律拒收；墓碑保留到 lateUntil，之后删除不影响结论。`/tree` 回退和墓碑淘汰两个复活路径都被消除；重启复活改为失败关闭，并给出失效通知。持久化失败只影响通知，不影响可接收性和「至多一次」。「unknown 重发安全」按新保证重写为「不会重复投递，但可能被拒收」。补了反例单测、端到端测试、appendEntry 失败测试和重启测试。**取舍**：没有采用「分支无关的独立 sidecar 账本」，因为它需要原子文件、多进程语义和持久化失败定义，设计明显变重；代价是凭证不跨进程重启（RR3），并在 §0 写明承诺边界 | §0、§3.3、§3.4、§4.2、§6.3、§11 RX1、§12.2-6/7、RR3 |
| 2      | Major   | 已修                         | 新增 NoticeGate：session、disposed、joined、有效 receive、fence 的同步准入；任一条件不满足就不写入，保留 owed，在事件驱动的重试点重试，兜底定时器 30s，到 lateUntil 仍不满足就丢弃并计数。删除了「栅栏期间 quiet 写入兜底」。Controller 仍不检查 joined，准入责任明确落在调用方。补了 leave、慢 before_switch、compaction、到期后切换会话的测试                                                                                                                                                                                                                                           | §6.5、§7.2、§12.2-3                                 |
| 3      | Major   | 已修                         | expectReply 和 replyTo 两个分支的 send `to` 都固定为核对过的完整 sessionId；hub 对这两类帧要求 `to` 精确匹配 sessionId，并保留唯一持有者检查。补了名称改绑、ref 歧义变化、目标退出的测试                                                                                                                                                                                                                                                                                                                                                                                                  | §4.2、§5.3、§11 RX2/RX4、§12.2-8                    |
| 4      | Major   | 已修                         | 由 `effectiveReceive` 纯函数统一计算；配置解析、restore、命令、wire 都遵循「replies 不可用 ⇒ off，绝不回落到 wake」。持久化时写 `receive:"off"` + `receivePref`，旧版本插件读到的也是 off（顺带修复 r1 RR5 的错误描述）                                                                                                                                                                                                                                                                                                                                                                   | §8.1、§11 RX0/RX5                                   |
| 5      | Major   | 已修                         | 给出精确状态表（可接收、占配额、占槽位、可删除）；sweep 是进程级、惰性的，覆盖非当前会话；满载拒签不淘汰，lateUntil 后自愈；restore 不再从磁盘重建，溢出问题消失；被清理的旧会话切回时给出汇总通知（droppedNotices）。补了 ≥9 个会话、timed_out 宽限期、满载测试                                                                                                                                                                                                                                                                                                                          | §3.4、§11 RX1                                       |
| 6      | Major   | 已修                         | 新增独立的 `replyInbox`（XsInbox 新实例，容量 maxPending）；签发不变量「可接收凭证 + replyInbox 占用 ≤ maxPending」保证 accept 必定成功；未进入上下文的回复会继续占配额，从而挡住新的签发；明确硬上限为 inboxCap + maxPending；回复不检查也不计入 recvPerHour。补了普通 inbox 满载、连续 human quiet 往返的测试                                                                                                                                                                                                                                                                           | §6.2、§6.4、§11 RX5                                 |
| 7      | Major   | 已修                         | 写出 reserve/commit/release 状态机，列出 Controller 的每个返回值、降级后的第二次 guard、宿主抛错、dispatched 前后的异常；reserve 在任何宿主调用之前；性质测试改为「每个 requestId 至多一次可能生效的派发」，consuming→priorState 是合法转移。appendEntry 失败不再影响任何不变量                                                                                                                                                                                                                                                                                                           | §6.3、§11 RX1/RX5                                   |
| 8      | Minor   | 已修                         | 统一为请求方和目标都 replyCapable 才回填；resolve 和 send 两条路径都有测试                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                | §5.2、§11 RX2                                       |
| 9      | Minor   | 已修                         | status slot 也注册 SlotFlush，保存原始帧、每次写出时转换；补了「新 hub → 旧 hub → 新 hub」的重放测试                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      | §5.2、§11 RX3                                       |
| 10     | Minor   | 已修（只更正论证）           | 重写额度证明，实际上界是 `wakesInPerHour` 12/h 加上签发配额；不另加 solicited 专用配额（产品没有这个要求，列为 RR11），R3 拍板结论不变；补了双方都在运行、请求全部 wake:false 的交替往返测试（放在 RX5 真值表与 §12.2-1 的变体中）                                                                                                                                                                                                                                                                                                                                                        | §8.2、§10 注、RR11                                  |
| 11     | Minor   | 已修                         | 未 join 时所有形式都放行，删除「需要先 join」的报错；off 测试覆盖三种状态                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 | §9.3、§9.6、§9.7                                    |
| 12     | Minor   | 已修                         | 裸形式增加路径形状排除和真实文件优先（同步 stat）；补全遇到冲突必定插入显式 ref；缓存新鲜度依赖列为 RR8                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   | §9.1、§9.5、RR8                                     |
| 13     | Minor   | 已修                         | `command-policy.ts` 及其测试归 RX5；directory 的构建全部移到 MW，RXW 不碰                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 | §8.3、§9.2、§11                                     |
