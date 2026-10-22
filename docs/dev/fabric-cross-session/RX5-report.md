## RX5 交付结果

实施完成，未 commit；冻结面与所有 golden 均未修改。

### 改动文件（绝对路径）

**实现**

- `/home/bluecake/ai/pi-toolkit/src/fabric/xs/receiver.ts`
- `/home/bluecake/ai/pi-toolkit/src/fabric/xs/format.ts`
- `/home/bluecake/ai/pi-toolkit/src/fabric/xs/membership.ts`
- `/home/bluecake/ai/pi-toolkit/src/fabric/root-wake.ts`
- `/home/bluecake/ai/pi-toolkit/src/fabric/xs/wake-ledger.ts`
- `/home/bluecake/ai/pi-toolkit/src/commands/fabric-xs.ts`
- `/home/bluecake/ai/pi-toolkit/src/web-hub/agent/command-policy.ts`

**测试**

- `/home/bluecake/ai/pi-toolkit/tests/fabric/xs-receiver.test.ts`
- `/home/bluecake/ai/pi-toolkit/tests/fabric/xs-truth-table.test.ts`
- `/home/bluecake/ai/pi-toolkit/tests/fabric/root-wake.test.ts`
- `/home/bluecake/ai/pi-toolkit/tests/fabric/root-wake.property.test.ts`
- `/home/bluecake/ai/pi-toolkit/tests/commands/fabric-xs.test.ts`
- `/home/bluecake/ai/pi-toolkit/tests/web-hub/agent/command-policy-fabric.test.ts`

### §6.3 分支覆盖

以下实现坐标均在 `src/fabric/xs/receiver.ts`；测试位于 `tests/fabric/xs-receiver.test.ts`。

| 分支                                                    | 实现位置                  | 测试名/测试组                                                                                                                            |
| ------------------------------------------------------- | ------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------- |
| 阶段 5 栅栏拒绝，不 reserve                             | 323–328                   | `first dispatch guard rejection releases; stage-5 fence never reserves`                                                                  |
| 回复预占；异常满载不消费                                | 343–351                   | `reply inbox anomaly refuses without consuming`                                                                                          |
| reserve 后同步重入，同凭证拒收                          | 344；289–303              | `synchronous reentry sees consuming; only one possibly effective dispatch`                                                               |
| Controller 前 guard 拒绝 ⇒ release                      | 366–370                   | `first dispatch guard rejection releases; stage-5 fence never reserves`                                                                  |
| guard wakeOnly ⇒ quiet                                  | 372                       | `goal at dispatch guard downgrades to quiet and commits`                                                                                 |
| Controller dispatched applied/deferred ⇒ commit trigger | 386–401                   | `Controller dispatched %s commits trigger and passes solicited returnLevel`                                                              |
| Controller none ⇒ release                               | 403–404                   | `Controller none %s releases; another xid can retry`                                                                                     |
| Controller downgrade ⇒ 保持 consuming，转 quiet         | 406                       | `Controller downgrade keeps consuming through quiet send and commits`                                                                    |
| 降级后第二次 guard 拒绝 ⇒ release                       | 419–422                   | `second guard after Controller downgrade rejects and releases`                                                                           |
| 宿主同步抛错 ⇒ release                                  | 443–445                   | `host synchronous throw releases reservation`；`RX5 Controller downgrade followed by host rejection releases and retry remains possible` |
| quiet 返回 applied/queued/unverified ⇒ commit           | 447–482                   | `successful quiet send %s always commits`                                                                                                |
| verify 失败/异常后仍 commit                             | 391–394；447–452；222–247 | `RX5 Controller dispatched then verify throws/fails…`                                                                                    |
| dispatched 前异常 release；后异常 commit                | 222–247                   | `exception before dispatched releases; after dispatched commits conservatively`                                                          |

另有普通 inbox 满载、入站限额为零仍收回复、human quiet 累积挡住新签发、block/allowFrom、重启失效及迟到状态测试。

### 真值表

原有行未改，追加 **18 行回复真值表**，覆盖方案 §6.6 的全部类别；另加连续 13 次回复测试，验证：

- wire `wake:false` 不阻止凭证驱动的回复唤醒；
- 前 12 次共用入站唤醒额度，第 13 次降级 `inbound_wake_rate`；
- return level 不递增；
- quiet 回复继续占用 replyInbox。

### Controller、格式与命令

- `RootWakeRequest` 增加 `solicited`、`returnLevel`，以及不透明透传的 `reply`/`inReplyTo`。
- replies 模式仅 solicited 可唤醒；deliver 仍降级 `receiver_policy`。
- solicited 跳过 `hopAllowed`，以 `levelMode:"return"` 提交原 requester level，不 `+1`。
- 保留原 deadline、B1 孤儿中止、deferred 真启动提交及额度逻辑。
- 请求头增加 `reply_to`、ISO `due` 与边界外回复指引；无 reply 的格式通过 golden 字节检查。
- membership 写出 `receive:"off" + receivePref:"replies"`；restore 保留偏好，功能关闭时有效值为 off。
- 增加 `/fabric replies`、状态统计、receive replies 补全；关闭回复功能时拒绝设置。
- web policy 的 replies 基线 allow，override 生效，未知子命令默认 deny；飞书 mutation 硬拒保留。

### RXW 装配端口

1. **Receiver**

   ```ts
   replyLedger?: XsReplyLedger
   ```

   RXW 先绑定：

   ```ts
   ledger.bindSession({
     sessionId,
     inbox: createXsReplyInboxPort(replyInbox),
     appendIssue,
     appendSettle,
   });
   ```

   Receiver 自行执行 classify/reserve/commit/release，不另行调用 replyInbox.accept。

2. **replyInbox**
   独立 `new XsInbox(reply.maxPending)`；挂接与普通 inbox 相同的 run-start、settled、trigger-release、session-start 生命周期。

3. **Membership**
   传入实际 `replyEnabled`；`receive` getter 已返回有效值，`receivePref` 返回原偏好。

4. **命令**

   ```ts
   replies?(): { ledger: XsReplyLedger; maxPending: number } | undefined
   onPolicyChange?(): void
   ```

   `onPolicyChange` 连接 NoticeGate.flush，触发点为 join、receive、fence reset。

5. **inbound**
   wake/quiet 两路均保存 `details.reply:{requestId,dueAt}` 与 `details.from`。RXW 为 RX4 的 `inbound(requestId)` 提供 getBranch 最新优先、最多 2000 条扫描，返回 `{fromSessionId}`。

6. **NoticeGate**
   `RootWakeController` 可直接传给 `controller`，无需适配层；已有真实 NoticeGate＋Controller 测试验证。

### 自验命令与真实输出尾部

指定测试命令，另追加 `tests/web-hub/agent/command-policy-fabric.test.ts`：

```text
 Test Files  9 passed (9)
      Tests  179 passed (179)
```

```sh
npx vitest run tests/fabric tests/commands tests/web-hub/agent --maxWorkers=2
```

```text
 Test Files  124 passed (124)
      Tests  2272 passed (2272)
   Duration  31.05s
```

```sh
npm run typecheck
```

```text
> tsc --noEmit -p tsconfig.json && tsc --noEmit -p tsconfig.typecheck.json && vue-tsc --noEmit -p src/web-hub/ui/tsconfig.json
```

退出码 0，全仓无类型错误。

```sh
npx prettier --check <上述13个改动文件>
```

```text
Checking formatting...
All matched files use Prettier code style!
```

`git diff --check -- <上述13个文件>`：退出码 0。三份 off golden 均通过，未修改。

### 解释与遗留

- 经 `consult plan:xs-reply-r2` 确认：**证据理由优先于迟到分类**。仅 applied 返回 `reply_late`；unknown 保留 `queued`/`accept_unverified`/`receiver_error`，凭证仍依据 priorState 提交为 `late_replied`。已加四类测试。
- 无 RX5 未决阻塞项。RXW 装配、真实双会话集成与 C-X8 conformance 留给后续包。
