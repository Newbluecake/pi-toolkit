# X1 报告：hub 中继（fabric 二期，phase2-plan §8.3 / §8.1 / §8.5 / §4.6）

状态：已实现并自验通过。范围只在 hub 侧（`src/web-hub/hub/**`）；未碰 agent/、ui/、protocol/、stack.ts、index.ts。

## 1. 交付内容

| 文件                                  | 作用                                                                                                                                                                                            |
| ------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `src/web-hub/hub/xs/members.ts`（新） | 成员表：`XsRegistryObserver`（registry 转发的事件）、读时校验 `effective()`、`clampMemberLimits`（按 `XsMemberLimitsSchema` 上下界夹紧）                                                        |
| `src/web-hub/hub/xs/limits.ts`（新）  | 发送方限额预占→结算；`normalizeHubCrossSessionConfig`（main.ts 复核）；`HubCrossSessionConfig` 类型                                                                                             |
| `src/web-hub/hub/xs/router.ts`（新）  | `info/list/resolve/send` 路由 + `createXsRelay`（装配 members+limits+router，安装 registry observer）                                                                                           |
| `src/web-hub/hub/agent-server.ts`     | `xs_req` 先于 registry 分派给 router（不进 bus/逐帧日志）；超 16 KiB 的 `xs_req` 回 `E_XS_TOO_LARGE`；**坏 JSON 日志改 `{agentKey, bytes}`**（无条件）                                          |
| `src/web-hub/hub/registry.ts`         | `setXsObserver`/`xsView`；`case "xs_member"`、`case "xs_ack"`（按 rid + agentKey + `requestType==="xs_deliver"` 结算，无 pending ⇒ `onLateAck` 计数）；session/detached/close/reclaim/down 转发 |
| `src/web-hub/hub/hub.ts` / `main.ts`  | `config.crossSession` 存在才建 relay、`XS_HUB_CAP` 尾部追加到 `extraHubCaps`（两面同源）、两条关闭路径 dispose；main.ts 复核，非法 ⇒ 丢整个 key                                                 |
| `src/web-hub/hub/audit.ts`            | `auditXs`（白名单 + token 形状过滤；session 只留前 8 位；无正文/哈希）                                                                                                                          |
| `src/web-hub/hub/ports.ts`            | **偏离**：`HubConfig.crossSession?: HubCrossSessionConfig`（类型，必须有；不在 §11.1 名单里，仅加一个可选字段）                                                                                 |

## 2. 路由 / 成员 / 限额

**成员（§8.1）**：有效成员 = 记录存在 ∧ 当前连着且 `phase==="live"` ∧ `!detached` ∧ `session.sessionId === member.sessionId` ∧ hello caps 含 `xs.v1`，**读时**联表判定（`registry.xsView`），不依赖 `StatusInfo.xs`。同时做急切作废：`session` 帧换 id、`session_detached`、连接断开、reclaim、down 都直接删记录——只有新的 `xs_member` 才能复活（同 id 的 detach→session 之后也一样，见 §6）。

**origin 盖章**：所有 op 都要求「该 socket 的有效成员 ∧ `origin.sessionId/epoch` 一致」，`send` 另需 `joined`，否则 `E_XS_STALE_ORIGIN`（effect `none`）。`from` 全部来自 hub 记录（`agentId` = hub agentKey），帧里别的身份字段忽略。

**list**：有效 ∧ `joined` ∧ `receive≠off` ∧ 非自己；`scope:"cwd"` = 相同/祖先/后代目录（路径边界感知，只过滤列表）；query = 名称前缀（不区分大小写）或 sessionId 前缀（≥8）；最多 20 行，最近活跃在前；行里无 agentKey/pid/工具/模型。
**resolve**：sessionId 精确 → 前缀(≥8) → 名称精确 → 名称忽略大小写；歧义 ⇒ `ok:true` + ≤5 候选（`ref`/`name`）；同一 sessionId 两个有效持有者 ⇒ `E_XS_AMBIGUOUS`；保留地址 ⇒ `E_XS_BAD_TARGET`；无匹配（含未加入）⇒ `E_XS_NO_TARGET`（与不存在逐字节一致，测试钉死）。resolve 包含 `receive:"off"` 的已加入成员（供 `/fabric block` 用），list 不含。
**send**：①origin → ②目标唯一 → ③`receive:"off"` 早拒 `none{rejected}` → 盖章后的 deliver 帧体积检查（>16 KiB ⇒ `E_XS_TOO_LARGE`，避免接收端 decoder 静默丢帧造成 5s 假 unknown）→ ④限额预占 → ⑤⑥ `registry.request(xs_deliver, 5s)` → ⑦按 ack/截止结算回 `xs_res`。
**r3 M2（hub 侧）**：⑥ 发出之后，除接收端自己 ack 的 `none` 外，所有结局（截止、断连、hub 关闭、xid 不符、handler 异常）一律 `unknown`；`none` 只来自 ①–④。

**限额（§4.6）**：admission 预占 sendsOutPerMin/Hour、inFlight、pair 间隔、`hubSendsPerMin`，请求 wake 且 `wakesOutPerHour`/`pairWakesPerHour` 有余量才预占 wake，否则降级只投递（`outbound_wake_rate`/`pair_wake_rate`）。结算：inFlight 总是释放；发送计数从不退；**仅**「收到 ack 且 `woke:false`」退 wake 预占；无 ack（截止/断连/teardown）一律不退。被拒的 admission 不消耗任何计数。滑动窗口、无定时器、map 超阈值惰性清扫。

## 3. 真实 socket 往返（`xs-socket.test.ts`，完整 `startHub` 装配）

list → resolve → send → `xs_deliver`（含 hub 盖章的 `to.epoch`、`from`、`xid`、`expiresAt`）→ `xs_ack` → `xs_res` 往返；重复/迟到 ack 不产生第二个回复、只计数；真实 5s 截止 ⇒ `unknown{deliver_deadline}`；接收端断连 ⇒ `unknown{link_lost}`；`/new`（detached→新 session）后旧身份被拒且不可 list，新 `xs_member` 后可见；无 `xs.v1` 的 agent 不可见/不可达；无 `crossSession` 的 hub 对 xs 帧完全无响应；真实 hub.log 文件里无正文。

## 4. 日志修复（`agent-server-log.test.ts`）

坏 JSON：`{agentKey, bytes}`（无 `sample`）。被拒 xs 帧、handler 异常、超大帧、decoder 判非法的帧：日志/审计无正文（异常日志仅 `{code, op, textLen}`，`explode …` 之类异常文本不入日志）；schema 非法的 xs 帧（如带 `from.run`）沿用静默忽略，**不新增日志、不回复**。xs 关闭时：`xs_req` 仍是原样忽略，`xs_ack` 无 pending 不产生日志。

## 5. 自验

```
npx vitest run tests/web-hub/hub tests/web-hub/http tests/web-hub/boundary.test.ts   → 258 files / 5311 tests passed
npx vitest run tests/web-hub/protocol tests/web-hub/contract tests/integration/fabric-xs-off-golden.test.ts → 47 files / 1555 passed (3 skipped)
tsc --noEmit -p tsconfig.json / -p tsconfig.typecheck.json → clean
prettier --check src/web-hub/hub tests/web-hub/hub → clean
```

新增测试：`xs-members`(16) `xs-limits`(20) `xs-router`(41) `xs-socket`(9) `agent-server-log`(11) + `caps-coexist` 8 个新用例（xs on/off × 可选 hub 特性：两面同源、尾部追加、关闭字节一致）；共享构件 `xs-fixtures.ts`。

## 6. 偏离与观察（请 X2 / XW / 主会话知悉）

1. **`ports.ts` 越界一行**：`HubConfig.crossSession` 类型无处可放，只加了可选字段 + import。
2. **limits 夹紧在 decode 层已被「拒收」抢先**：`XsMemberLimitsSchema` 是带 min/max 的 Integer，越界的 `xs_member` 在 `decodeAgentFrame` 就被静默丢弃，hub 的 `clampMemberLimits` 实际不会碰到越界值（保留为防御，函数单测过）。结果：越界配置 ⇒ 成员帧被丢 ⇒ 会话不是有效成员。**X2 必须在发出前自己夹紧**（settings 解析已夹紧，应无问题）。
3. **`listPerMin`(默认 6) 与 resolve 合计**：每次 `message_session` 先 resolve 一次，所以实际发送上限被压到 ≤6/min，低于 `sendsOutPerMin`(10)。按 §4.6/§5.1「list 与 resolve 合计」实现；若想让两者匹配，应由 X3 缓存 resolve 或调高默认值（主会话裁定）。
4. **新增一个错误码字符串 `E_XS_RATE_LIMITED`**（仅 list/resolve 超 `listPerMin`，`ok:false effect:none reason` 无）。不在 `XsErrorCode` 联合里（协议冻结没动），`xs_res.code` 本就是 string；X3 现状会把它映射为 `status:"error"`（resolve 阶段 effect `none`，正确）。send 阶段的限额拒绝是 `ok:true, effect:"none"`，**不**用错误码（否则 X3 会把未知码的 send 当 `unknown`）。
5. **hub 侧 reason 词汇**（`xs_res.reason`，均 token 形状）：`none`：`rejected`（早拒）、`rate_in_flight|rate_pair_interval|rate_sends_min|rate_sends_hour|rate_hub`；`unknown`：`deliver_deadline`、`link_lost`、`ack_mismatch`；对端 ack 的 reason/wakeDowngraded 不符合 `^[A-Za-z0-9_:.{}-]{1,64}$` 时转成 `unverified`/丢弃。
6. 成员只在**新 `xs_member`** 到达后复活：`session_detached` → 同 id 的 `session` 之后也需要一次 `xs_member`（§8.1「attach 时 epoch+1 并 setSlot」已覆盖，X2 的重连/reload 路径务必重发）。
7. 超 16 KiB 的 `xs_req` 在 agent-server 里用原始帧判定并回 `E_XS_TOO_LARGE`（rid 合法时），否则 decoder 的静默丢弃只会让发送端等满 8s 客户端截止。
8. 测试注意：hub 的 tick 会按 pid 存活性清掉假 pid 的记录（5s 后），真 hub 测试里的假 agent 必须用 `process.pid`（nonce 区分）。
9. `src/web-hub/hub/xs/**` 不 import pi，boundary 测试通过；`abbreviateHome` 在 router 内联（hub 不得 import `src/git/path-label.ts`，boundary 白名单只含 run/worktrees/diff/graph）。

## 7. 给 X2 / XW 的接口说明

- **HubConfig**：X2 的 `buildHubConfig` 在 `xsOn` 时写 `crossSession: { limits: { hubSendsPerMin } }`（整数 1..600，否则 hub 丢 key ⇒ xs 关）；key 缺省 ⇒ hub 与现在字节一致。`hello_ack.caps`/`HubInfo.caps` 尾部出现 `xs.v1` 即可门控 X2 的 slot/请求。
- **xs_member slot**：`{t:"xs_member", sessionId, epoch, joined, receive, limits(7 键，全在 schema 界内)}`，须排在 `session` 帧之后；每次 attach/join/leave 重发（epoch+1）。`receive` 变更不改 epoch。
- **xs_req** → 同 socket 上 `xs_res{rid}`：
  - `info`：`{ok:true, hubLimits:{hubSendsPerMin, expiresMs, deliverMs}}`
  - `list`：`{ok:true, rows}`；`resolve`：`{ok:true, target:{ref,name?}}` | `{ok:true, candidates}` | `{ok:false, code}`
  - `send`：`{ok:true, effect, reason?, wakeDowngraded?, target}`（含限额拒绝与全部 unknown）；`{ok:false, code:E_XS_STALE_ORIGIN|BAD_TARGET|NO_TARGET|AMBIGUOUS|BAD_FRAME|TOO_LARGE|INTERNAL}`
  - `E_XS_INTERNAL` 带 `effect` 字段（send 路径 `unknown`）。
- **xs_deliver**（hub→接收端）：`rid` 由 registry 分配，`from.agentId` = hub agentKey，`wake` 为 hub 预占后的有效值（hub 降级时已是 `false`，`wakeDowngraded` 由 hub 在 `xs_res` 里带回），`level` 原样透传发送方值；接收端必须恰好回一次 `xs_ack{rid, xid, effect, reason?, wakeDowngraded?, woke}`，**xid 要原样回显**（不符 ⇒ hub 记 `unknown{ack_mismatch}`）。
- **ack 的 `woke:false`** 会退还 hub 侧 wake 预占（接收端降级/拒收时务必如实填）。
- 审计行（`msg:"xs"`, `audit:"xs"`）：`op, xid?, fromSession?, toSession?(前 8 位), textLen?, wake?, outcome, reason?, code?, ms?`。`XsRouter.lateAcks()` 提供迟到 ack 计数（`xs_late_ack`），未接 UI/status（XW/X5 如需展示再接）。
