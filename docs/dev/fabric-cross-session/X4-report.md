# fabric 二期 X4 包报告：接收端与加入控制

状态：**完成**。基线 `dev` @ `988f68a8`（XS0/R1/T1/X3 已合入）。依据 `phase2-plan.md` §8.4（接收管道、独立 inbox）、§9（dedup）、§5.3/§10.3（加入控制、命令硬门禁）、§4.5（真值表）、§6.3（接受证据表）、§6.6（level）、文末 §13/§14 拍板与 **r3 主会话裁定（M2/N2/S3 优先于正文）**；XS0 的 `src/web-hub/protocol/xs.ts` 是唯一 wire 事实源；接收端与 R1 `RootWakeController`、T1 `SessionFence` 的接口逐条对齐（见「给 XW 的装配说明」）。2026-10-21。

## 交付物（全部新建，未触碰任何既有文件）

| 文件                          | 内容                                                                                                                                                                                                                                                                                                                                                                     |
| ----------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `src/fabric/xs/dedup.ts`      | §9 进程级去重表：`Symbol.for("pi-subagent:xs-dedup")`（跨 /reload）、条目活到 `expiresAt+1s` 惰性清理（无定时器）、容量 256、满容量**拒收**不淘汰（r3 S2）；未结算槽位的重复回放保守 `unknown{receiver_error}`；`XsAckVerdict`（= `xs_ack` 去 t/rid/xid）定义于此供全链共用                                                                                              |
| `src/fabric/xs/inbox.ts`      | §8.4 独立 inbox 记账（栈内存，`inboxCap`）：`appended`/`queued` 在「接受时间 < run 启动时间」被 `onRunStart` 标记 in-context、该 run `onRunSettled` 释放；`trigger` 由 `releaseTrigger()`（Controller 回 idle）或自身 run 结束释放；`clear()`=session_start；released 条目即使被未释放条目压住也被清除（有界）                                                           |
| `src/fabric/xs/membership.ts` | §5.3/§8.1/D2 会话级成员资格：join/leave（epoch +1）、receive 覆盖（**不** bump epoch）、屏蔽列表（上限 64、名字快照、离线 unblock：序号/完整 id/前缀≥8/名字）、`senderAllowed`（blocklist → allowFromDenyAll → allowFrom 完整 id）、`subagent:xs-membership` entry 读写（tolerant read-back，**fork 不继承** P10）、进程级 `Symbol.for("pi-subagent:xs-epoch")` 单调计数 |
| `src/fabric/xs/format.ts`     | §8.8/A6 接收侧正文格式：`fenceMeta` 截断 64 字符元数据头 + `fenceNonce` 边界线 + `<<<fab-` 中和 + 「不可信输入」声明；token/xid 不进 content（XI10）                                                                                                                                                                                                                     |
| `src/fabric/xs/receiver.ts`   | §8.4 八阶段同步管道 + §6.3 证据表 + §6.6 level carry + §4.5 派发决策（真值表 wake 列经真实 RootWakeController）+ r3 M2 前后分界 + 入站滑动窗（recvPerHour 计收、wakesInPerHour 供 Controller 的 `inboundWakeAvailable`/`chargeInboundWake`）+ 审计计数器                                                                                                                 |
| `src/commands/fabric-xs.ts`   | `/fabric` 命令（§5.3 全集）：status/blocks/join/leave/receive/block/unblock/fence reset；**handler 第一行 isWebInvocation 硬门禁**；block 经 hub resolve 唯一解析（歧义列候选、离线只收完整 sessionId 且 ≥8 字符）、blocks/unblock 完全离线                                                                                                                              |
| 对应测试 ×6                   | `tests/fabric/{xs-receiver,xs-truth-table,xs-inbox,xs-dedup,xs-level}.test.ts` + `tests/commands/fabric-xs.test.ts`（§11.2 X4 行全部锚点）                                                                                                                                                                                                                               |

装配（stack/index 接线、`xs_member` slot 发布、命令注册）**不在本包**——按 §11.1 归 XW；未改 `src/stack.ts`/`src/index.ts`，未注册任何命令/工具。

## 接收管道（§8.4，同一同步块，任一阶段失败即 settle+ack）

1. `expiresAt` 过期 ⇒ `none{expired}`
2. dedup：命中 ⇒ **回放首次 ack 原文**；满 ⇒ `none{dedup_full}`
3. 成员/策略：`joined ∧ receive≠off ∧ senderAllowed`（blocklist/allowFrom/deny-all）⇒ 否则 `none{rejected}`（不区分原因，防策略泄露）
4. `to.sessionId`+`to.epoch` 比对当前栈 ⇒ `none{session_changed}`（leave 后的旧 epoch 帧在本地被拒）
5. 栅栏 `check()`：拒收窗 ⇒ `none{fenced:<name>}`；`goal`（wakeOnly）只降级唤醒、投递照常
6. 入站 `recvPerHour`（通过即计收）⇒ `none{inbound_rate}`；`inboxCap` 满 ⇒ `none{inbox_full}`
   7+8. §4.5 决策 → 派发 → 证据 → ack；level 按 §6.6；inbox 记账

派发点协议（T1 §7.4）：两条路径都是 `fence.beginDispatch() → send → 取证 → verifyDispatch(gen)`；verify 的 **gen_changed/拒收型 fenced ⇒ `applied` 不可记**，降为 `unknown{accept_unverified}`（保守 `woke:false`）；verify 的 wakeOnly（goal 中途激活/消失）不否定已发生的写入。

## 证据表（§6.3，逐行锁定于 `xs-receiver.test.ts`）

| 情形                                  | 结果                                                                                                  |
| ------------------------------------- | ----------------------------------------------------------------------------------------------------- |
| `sendMessage` 同步抛错（Fpi1）        | `none{host_rejected}`                                                                                 |
| 只投递、idle、leaf 是本条（Fpi7）     | `applied`                                                                                             |
| 只投递、idle、leaf 非本条             | `unknown{accept_unverified}`（保守占 inbox 槽）                                                       |
| 只投递、流式中（Fpi7 内存队列，N2）   | `unknown{queued}`                                                                                     |
| Controller 派发、同步后 !idle（Fpi2） | `applied` + `woke:true`                                                                               |
| Controller 派发、仍 idle（Fpi5）      | `unknown{start_deferred}` + `woke:true`                                                               |
| 管道异常（M2 分界 = send 调用点）     | 前 ⇒ `none{receiver_error}`；后 ⇒ `unknown{receiver_error}`（错误 ack 也会 dedup settle，重复不重派） |

## 真值表（§4.5，`xs-truth-table.test.ts` 逐行，真实 RootWakeController）

wake 列全部经 R1 的 `dispatch`：`wake_disabled`（无 Controller=接收端 wake 关）/`controller_disabled`/`host_unverified`/`host_unsupported`/`receiver_policy`/`busy`（root 忙 ⇒ 降级+`queued`；Controller 占位而 host idle ⇒ 降级+`applied`）/`goal`/`level_limit`/`inbound_wake_rate` ⇒ 一律只投递且 `wakeDowngraded` 随 ack 返回；全满足 ⇒ `Controller.dispatch`（applied+woke 或 start_deferred+woke）。附加不变量测试：**任何降级行都不存在 Controller 以外的 `triggerTurn:true`**（review #8——跨会话永不走无监管 legacy/steer）。

## level（§6.6 + S1，`xs-level.test.ts`）

Controller 起真 turn ⇒ root=L_s+1（deferred 先 carry、真启动才 +1，由 R1 的 commitLevel/B1 hook 承担，本包测试从 receiver 驱动验证）；只投递（idle/流式）与一切降级 ⇒ carry L_s；拒收/无 level ⇒ 不变；接收端 wake 关 ⇒ 无 CausalLevel 不跟踪；跨会话一跳与树内一跳同链累计（mixed 单元切片）；投递永不 reset root。

## 命令硬门禁（§5.3/#9/XI13）

- handler **第一行** `isWebInvocation(ctx)`：join/leave/receive/block/unblock/fence 全部返回固定文本「跨会话成员资格只能在本地终端修改」，**不读任何策略**——`webCommandPolicy.fabric:"allow"` 结构上无法放开（deps 面没有策略入口；测试锁定了 web 来源在策略 allow 语义下仍被拒、status/blocks 仍可读）。本地 TUI 与本地 RPC（无 `webInvocation`）可变更。
- 第二层（X2 的 `PI_TOOLKIT_TABLE` fabric 规则 + prompt op 文本拒绝）不在本包。
- `allowFrom` 只认完整 sessionId（消费 XS0 解析器的产物：非法条目已丢弃、全非法 ⇒ `allowFromDenyAll` 拒收一切，fail closed）；`block` 经 hub resolve **唯一**解析（歧义 ⇒ 候选、不屏蔽；离线/无 resolve 端口 ⇒ 只接受 ≥8 字符的完整 id 形态）；`blocks`/`unblock` **完全离线**（本地列表解析：序号/完整 id/前缀≥8/名字快照，歧义列候选）。

## 自验（全部带 timeout；未跑全量 `npm test`）

```text
timeout 120 npx vitest run tests/fabric/xs-dedup.test.ts tests/fabric/xs-inbox.test.ts        → 17 passed
timeout 120 npx vitest run tests/fabric/xs-receiver.test.ts                                     → 16 passed
timeout 120 npx vitest run tests/fabric/xs-truth-table.test.ts                                  → 15 passed
timeout 120 npx vitest run tests/fabric/xs-level.test.ts                                        → 10 passed
timeout 120 npx vitest run tests/commands/fabric-xs.test.ts                                     → 29 passed
timeout 300 npx vitest run tests/fabric tests/commands                                           → 37 files / 655 passed
timeout 300 npx vitest run tests/config tests/web-hub/protocol \
                   tests/integration/fabric-xs-off-golden.test.ts \
                   tests/integration/fabric-wake-off-golden.test.ts                               → 1935 passed / 3 skipped（两份 golden 未动）
timeout 200 npx vitest run tests/web-hub/boundary.test.ts tests/adapters tests/tools             → 38 files / 658 passed
timeout 240 npm run typecheck                                                                    → tsc ×2 + vue-tsc 通过（0 error）
timeout 240 npm run build                                                                        → exit 0
npx prettier --check <12 个 X4 文件>                                                             → 通过（--write 后复检）
```

pi-free 校验：`src/fabric/xs/**` 新增五文件的直接 import 无任何 `@earendil-works/*`（脚本扫描，含注释剥离）；`membership.ts` 对 `config/settings.ts` 的值引用与 `web-hub/hub/load.ts` 同型（settings 的 pi 相关 import 全部 `import type`，运行时擦除）。新增模块**零新定时器**（dedup 惰性清理、inbox 事件驱动、receiver 纯同步），不存在 unref 问题。

## 偏差与裁量（无行为冲突，供 XW/验收核对）

1. **`unknown{accept_unverified}` 占 inbox 槽**（保守）：idle 只投递但 leaf 非本条、或 verify 失败时，消息可能已在树里 ⇒ 按 `appended` 记账（宁可多占一个槽，不漏记一条可能已入上下文的消息）。
2. **Controller 路径 verify 失败 ⇒ `woke:false`**：run 可能已启动（Fpi2 证据已被 Controller 观察），但会话身份在派发点下移动 ⇒ 不向发送方宣称唤醒成功（monotonic level 可能已 +1，无法撤销，只会高估——安全方向）。
3. **离线 block 的「完整 sessionId」判定**：名字与 id 无结构差异，取「≥8 字符且过 `isValidXsSessionId`」（与 resolve 前缀下限一致）；误判代价 = 屏蔽一个不存在的 id，可随时 unblock。
4. **recvPerHour 通过即计收**（阶段 6 原子 check-and-charge）：被后续阶段拒绝的消息也占配额——阶段顺序（§8.4 把速率放在策略/栅栏之后）的直接后果，防方向正确。
5. **dedup 满容量时 stage-2 先于成员校验**：即使消息终将被拒也先占表（§8.4 顺序原文如此；容量 256 足够容纳拒收风暴）。
6. `/fabric status` 的 hub 有效限额/差异提示与工具冲突行经 `statusView().lines` 由 XW 注入（本包只渲染）；`xs_member` slot 帧的 limits 组装属 X2（membership 只提供 joined/receive/epoch）。

## 给 XW 的装配说明（接口清单）

1. **构建顺序**：`XsMembership`（`attach()` 一次 bump epoch）→ `restore(readXsMembershipEntry(ctx.sessionManager.getBranch()))`（fork/异 id 自动视为未加入）→ `XsInbox(inboxCap)` / `XsDedup()`（或进程全局 `getXsDedup()`）→ `XsReceiver({sessionId, membership, fence, inbox, recvPerHour, wakesInPerHour, host, level?, clock})` → `RootWakeController`（其 `inboundWakeAvailable: () => receiver.wakeAvailable()`、`chargeInboundWake: () => receiver.chargeWake()`、`guard: () => fence 最终复核`、`receive: () => membership.receive`、host 复用 receiver 的 host + `abort`/`hasXid`）→ `receiver.setController(controller)`（wake 关时不建 Controller、不传 level ⇒ 自动 `wake_disabled` 降级）。
2. **host 端口**（一个对象同时满足双方）：`isIdle`/`hasPendingMessages` 包 `ctx`；`sendMessage` 包 `pi.sendMessage`（deliver-only `triggerTurn:false`、customType `"subagent:xs"`）；`getLeafEntry` 包 `ctx.sessionManager.getLeafEntry()`；Controller 侧另需 `abort`（`ctx.abort()`）与可选 `hasXid`（branch 中找本 xid，lost-after-accept 诊断用）。
3. **事件接线**：`before_agent_start` ⇒ `inbox.onRunStart(now)` + Controller 的 `beforeAgentStart`（无栈窗口用 R1 的 `observeRootWakeTrigger`，勿双调）；`agent_settled` ⇒ `inbox.onRunSettled()` + `controller.settled()`；Controller 回 idle ⇒ `inbox.releaseTrigger()`（可挂在 settled 后读 `controller.busy===false`）；`session_start` ⇒ `inbox.clear()`（新栈重建即可，receiver/inbox 本就每栈新建）。
4. **X2 对接**：`xs_deliver` case 解出帧后同步调 `receiver.deliver({xid, to, from, text, wake, level?, expiresAt})`，把返回的 `XsAckVerdict` 加上 `t/rid/xid` 组成 `xs_ack` **恰好一次**（异常也如此——deliver 内部已保证返回 verdict）；`xs_member` slot 的 `joined/receive/epoch` 从 membership 读（receive 变更后需重发 slot，epoch 不变）。
5. **命令注册**：主会话 post-guard、`xsOn` 时 `registerCommand("fabric", createFabricXsCommand(deps))`；`resolve` 端口绑 X2 的 hub resolve（`query → {sessionId,name}`，可缺省=离线模式）；`statusView.capability` 取 `getXsHostCapability().state`，`lines` 里拼 receiver 计数（`countersSnapshot()`/`wakeQuota()`）、hub limits 差异（X2 info 端口）与 `detectXsToolCollisions` 结果。
6. **计数进 `/agent status`（X5）**：`receiver.countersSnapshot()` 全为英文 token（`applied/queued/unverified/wakeDispatched/…`），`wakeQuota()` 为 `in a/b h · wakes c/d h`。

## 遗留

- 真实 hub/socket/双栈端到端（`tests/integration/fabric-xs*.test.ts`）与真实 pi conformance（C-X4 成员资格 durability 等）属 XW/X5。
- `tests/integration/fabric-xs-child-scope.test.ts` 中「xs on/off 子会话工具表不变」由 XW 落地（本包未动任何工具面）。
