# fabric 二期 X2 包报告：agent 侧连接

状态：**完成**。基线 `dev` @ `86b2e5a4`（XS0/R1/T1/X1/X3/X4 已合入；参数补全 P0–P3 已在 `agent/{connection,index}.ts` 上先落，本包在其基础上做局部增量，未重排 `index.ts`）。依据 `phase2-plan.md` §8.1/§8.2/§4.6/§5.3/§10.3/§11.1 X2 行 + §13/§14 拍板 + r3 主会话裁定；`src/web-hub/protocol/xs.ts`（XS0）是唯一 wire 事实源；X1/X3/X4 报告的接口逐条对齐（见 §6 装配说明）。2026-10-21。

## 交付物

| 文件                                     | 改动                                                                                                                                                                                                                                                                                                                                                                                                                                                         |
| ---------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `src/web-hub/agent/xs.ts`（新，~330 行） | `XsAgentPort`/`XsStackPort`（XW 注入面）+ `createXsAgentBridge`：member slot 发布、X3 `XsHubPort` 适配器、`xs_deliver`→X4 receiver 交接（恰好一次 ack）、`StatusInfo.xs` 投影、`/fabric block` resolve 端口、`op:"info"` hub 限额端口、ref→full-sessionId 学习表                                                                                                                                                                                             |
| `src/web-hub/agent/connection.ts`        | `SlotKind`/`SLOT_ORDER` 加 `"xs"`（紧跟 `"session"`）；`slotCap("xs") = xs.v1`（XS0 未动 `version.ts` 的 `SLOT_REQUIRED_CAP`，门控落在本包文件域内）；`request()` 新增 `XsReqFrame` 重载 + 按 op 截止表（`xsReqDeadlineMs`：list/resolve/info 3s、send 8s；`fsb_req` 12s 与 3s 缺省不变）；`onFrame` 加 `case "xs_res"`（rid 结算）与 `case "xs_deliver"`（仅 `link==="live"` 才交给 binding）；`BindingPort.onXsDeliver?`                                   |
| `src/web-hub/agent/index.ts`             | 全部局部 hunk：`WebHubDeps.xs?`（存在即 xsOn）、closure `xsBridge`、binding 条件挂 `onXsDeliver`、`onHubCaps` 钩子重发 member slot、`capsExtra` 尾部追加 `xs.v1`（镜像 X1 hub 侧尾部追加）、`buildHubConfig` 写 `crossSession` 键、`publishStatus` 投影 `s.xs`、`connectWith` 在 `emitSession("attach")` 后发布 slot、`WebHubControl.webExecBusy?`（T1 §7.2 `web_exec` 栅栏输入）与 `WebHubControl.xs?`（XW 面：publishMember/hubPort/resolveBlock/hubInfo） |
| `src/web-hub/agent/command-policy.ts`    | `PI_TOOLKIT_TABLE` 新增 `fabric` 行：`status`/`blocks`（含裸形式默认 status）⇒ allow，其余 ⇒ deny                                                                                                                                                                                                                                                                                                                                                            |
| `src/web-hub/agent/commands.ts`          | prompt op 文本拒绝 `/^\s*\/fabric\s+(?:join\|leave\|receive\|block\|unblock\|fence)(?:\s\|$)/`（照抄 `/webhub 2fa\|passwd\|user` 先例，固定文案 E_COMMAND_DENIED）                                                                                                                                                                                                                                                                                           |
| 测试 ×4（新）                            | `xs-client.test.ts`（19）、`xs-member-slot.test.ts`（7）、`command-policy-fabric.test.ts`（5）、`commands-prompt-fabric.test.ts`（12）                                                                                                                                                                                                                                                                                                                       |

未触碰 `src/stack.ts`/`src/index.ts`（XW 域）；未触碰 `protocol/version.ts`（XS0 域，xs slot 门控放进了 `connection.ts` 的 `slotCap`）；未改两份 golden。

## 1. slot 生命周期（§8.1）

- **发布点**：`connectWith` 里 `emitSession("attach")` 之后（session 帧先行，与 hello_ack 的 `SLOT_ORDER` 重放顺序一致：session → xs）；XW 在 join/leave/receive 变更后经 `control.xs.publishMember()` 重发（receive 变更不 bump epoch——epoch 归 X4 membership 管，X2 只读取）；**每次 `hello_ack`** 经 `onHubCaps` 钩子从**新鲜** membership 状态重发一次（覆盖「断链期间 join/leave、重连后旧 stored slot 被重放」的竞态——X1 报告 §6 note 6 要求只有新 `xs_member` 才能复活成员）。
- **帧体**：`{sessionId（当前栈）, epoch, joined, receive, limits}`；7 个 sender 限额在发出前**再次夹紧**（X1 note 2：越界帧被 hub decoder 整帧丢弃，settings 解析已夹紧，这里是第二道门）。
- **门控**：无 `xs.v1`（旧 hub / xs 关）⇒ 存 slot 但**永不写出**（`slotCap` 机制）。
- **撤销/重发**：hub 侧在 `session` 换 id / `session_detached` / 断连时作废成员记录；agent 侧下一次 attach 的新 `xs_member`（新 sessionId + 新 epoch）复活它——同进程 `/new` 的 FIFO 顺序（session_detached → session → xs_member）由单 socket 保证。
- **澄清（相对派单摘要「仅已加入时发」）**：按方案 §8.1 原文（「在 stack 构建（attach）、join、leave 时 +1……每次变化都 setSlot」）与 X1 已合入的语义，slot 在**每次 attach 都发**（`joined:false` 也发）——hub 的 origin 准入（list/resolve 只要求有效成员、不要求 joined）依赖成员记录存在；只在 joined 时发会让未加入会话连 list 都拿 `E_XS_STALE_ORIGIN`。可见性（list 只列 joined）由 hub 过滤，不受影响。

## 2. 端口接口

**给 X3（sender）**：`XsHubPort = {list|resolve|send} → Promise<XsPortReply>`。适配器补 `t`/`rid`（`newAdminRid`）、`origin` 原样透传、wake 仅在 `true` 时携带（Q1 omit=false）、level 仅在有值时携带；截止表由 `connection.request(frame,"xs.v1")` 内部执行。传输归一：`E_NO_CAP` 且仍 live ⇒ `{kind:"off"}`（断链也走 E_NO_CAP ⇒ `{kind:"link_lost"}`，用 `conn.status().state` 区分）；`E_TIMEOUT` ⇒ `{kind:"deadline"}`；`E_CONN_LOST`/`E_CLOSED`/无连接 ⇒ `{kind:"link_lost"}`。**X2 绝不合成 `xs_res`**（X3 拥有全部 effect 决策）。

**给 X4（receiver）**：connection 的 `case "xs_deliver"`（live-only）→ `binding.onXsDeliver` → `bridge.onDeliver(frame)`：同步调 `port.stack().deliver(frame)`，把返回的 `XsAckVerdict` 加 `t/rid/xid` 组成 `xs_ack` **恰好一次**；栈缺失（detached/已切换）⇒ `none{session_changed}`；receiver 抛异常（X4 契约上不会）⇒ `none{receiver_error}` 兜底。stale link（非 live）不进 handler、不造 ack——hub 的 5s registry 截止自行结算 unknown。

**给 XW（`WebHubDeps.xs` / `WebHubControl`）**：见 §6。

## 3. web 门禁（§5.3/#9/XI13，两层）

1. `PI_TOOLKIT_TABLE.fabric`：`status`/`blocks`/裸形式 ⇒ allow；join/leave/receive/block/unblock/fence（含 fence reset）⇒ deny。用户 override 在 `resolveCommandPolicy` 里对任何名字**先于**本表生效——这是已知且被测试钉死的第一层语义（测试 `command-policy-fabric.test.ts` 明示该 residual）；真正的硬门禁是 X4 handler 第一行的 `isWebInvocation`（不读策略，结构上无法被 override 放开）。
2. prompt op 文本拒绝：`/fabric <mutation>` 前缀即拒（E_COMMAND_DENIED，固定英文文案照 `/webhub` 先例），`status`/`blocks` 与提及命令的自由文本不受影响。

## 4. 自验（全部带 timeout；未跑全量 `npm test`——按任务约束）

```text
timeout 400 npx vitest run tests/web-hub/agent tests/integration/fabric-xs-off-golden.test.ts
  → 79 files / 1412 tests passed（golden 两用例原样通过，fixture 未动）
timeout 400 npx vitest run tests/web-hub/protocol tests/web-hub/contract tests/commands tests/config \
                   tests/integration/fabric-wake-off-golden.test.ts tests/integration/fabric-xs-off-golden.test.ts
  → 95 files / 2285 passed / 3 skipped（一期 golden 亦未动）
timeout 400 npx vitest run tests/web-hub          → 605 files / 13598 passed / 3 skipped
timeout 280 npm run typecheck                     → tsc ×2 + vue-tsc 通过（0 error）
npx prettier --check <9 个 X2 文件>               → 通过（--write 后复检）
```

新增 43 用例锚点：无 cap ⇒ off（且零写出）；截止表 3s（list/resolve/info）与 8s（send，显式验证 3s 处仍 pending）；断链/无连接 ⇒ link_lost；stale link 不处理 deliver 且不造 ack；deliver 恰好一次 ack（verdict 原样回显 xid / 异常 / 无栈三路）；slot 顺序 session→xs→status；重连 hello_ack 重放新 slot；无 cap / 无 bridge 不发；越界 limits 夹紧；resolveBlock 全 id 透传 / 学得的 full id / ambiguous / offline；hubInfo 往返；策略表与 prompt 拒绝矩阵。

## 5. 偏差与裁量（供 XW / 验收核对）

1. **`resolveBlock` 的 full-sessionId 缺口（X1↔X4 接缝，X2 折中）**：X4 的 `/fabric block` 端口期望 `{sessionId}`（完整 id），但 X1 的 hub resolve 出于防枚举**只回 12 位 ref**。X2 的折中（按优先级）：① query 本身是完整 id 且被 hub 精确匹配 ⇒ 用 query；② 本进程收到过该 ref 的 `xs_deliver.from.sessionId`（wire 上唯一出现完整 id 的地方；refMap 容量 64 FIFO，使用时校验前缀一致）⇒ 用学得的完整 id；③ 都没有 ⇒ 回 12 位 ref——**条目无效但无害**（`senderAllowed` 按完整 id 精确比对，永不误伤；`/fabric blocks` 可见、可 unblock），与 X4 自己的「离线长名字」裁量（X4 报告偏差 3）同类。如需 100% 有效屏蔽，主流程仍是「对方 `/fabric status` 显示完整 id → 本方 `/fabric block <完整 id>`」（① 覆盖）。
2. **slot 门控位置**：`protocol/version.ts` 不在 X2 文件域，`SLOT_REQUIRED_CAP` 未加 `xs` 行；门控落在 `connection.ts` 的 `slotCap()`（`kind === XS_SLOT_KIND ⇒ XS_HUB_CAP`）。行为等价（写入与重放两处都过 `slotCap`）。
3. **`onHubCaps` 重发 member slot**：方案未明说，但 X1 note 6 + 「断链期间变更」竞态需要它；实现为 `cmdCompleteOn ∨ xsBridge` 时挂钩子，两者皆关时 binding 与之前字节一致。
4. **`xs_member` attach 即发（含 `joined:false`）**：见 §1 澄清。
5. **`E_XS_RATE_LIMITED`（X1 新增码）**：X2 的 resolveBlock 把它归入 `{ok:false, kind:"no_target"}`（fall-through 到 X4 的完整 id 规则）；X3 的 sender 已按自己的映射处理 send 路径（X3 报告已知裁量 1），两侧一致不需要额外码。
6. **`webExecBusy` 恒存在**（非条件挂载）：读 `resumeExec.switchInFlight() ∨ execGate.held()`，包 `safe()`；接口上仍是可选字段（旧 double 兼容）。

## 6. 给 XW 的装配说明

1. **注入**：`src/index.ts`（主会话 post-guard）在 `xsOn(fabric, webHub)` 为真时给 `wireWebHub` 传 `deps.xs`：
   `xs: { stack: () => xsHolder.current, memberLimits: () => ({…settings.fabric.crossSession.limits 7 键}), hubSendsPerMin: () => settings.fabric.crossSession.limits.hubSendsPerMin }`。
   `xsHolder` 是 XW 自己的 late-bound ref，每个新栈（`buildSessionStack`）重建后指向 `{sessionId, member(), deliver, status()}`（直接包 X4 的 membership/receiver：`sessionId: ctx.sessionManager.getSessionId()`，`member: () => ({epoch: membership.epoch, joined: membership.joined, receive: membership.receive})`，`deliver: (f) => receiver.deliver({xid: f.xid, to: f.to, from: f.from, text: f.text, wake: f.wake, ...(f.level !== undefined ? {level: f.level} : {}), expiresAt: f.expiresAt})`，`status: () => ({joined, receive, blocked: membership.blockedCount})`）。**stack() 每次调用都要现读 holder**（X2 的 bridge 靠它跨会话边界取新栈）。
2. **工具与命令**：X3 的两个工具用 `control.xs.hubPort()` 做 `XsHubPort`；`origin` 端口 `() => ({sessionId: current sessionId, epoch: membership.epoch})`；X4 的 `/fabric` 命令 `resolve` 端口绑 `control.xs.resolveBlock`，statusView 的 hub 限额行用 `control.xs.hubInfo()`（差异提示：与本地 `crossSession.limits` 对比）。
3. **成员变更重发**：`/fabric join|leave|receive` 处理成功后调 `control.xs.publishMember()`（join/leave 已由 membership bump epoch；receive 不 bump）。
4. **T1 fence 的 `web_exec` 端口**：`() => control.webExecBusy?.() === true`（端口约定：true = 活动；undefined/false = 不活动）。
5. **无需再动的**：hello caps、slot 重放、HubConfig `crossSession` 键、`StatusInfo.xs`、`xs_deliver`→ack、截止表——全部由 `deps.xs` 的存在自动驱动；XW 只负责「线程化端口 + 调 publishMember」。
6. **测试建议（XW 集成包）**：真 hub × 双 fake-stack 的 socket 级端到端（join→list→send→deliver→ack→res）按 X1 `xs-socket.test.ts` 的 fake-hub 套路即可，本包的 4 个测试文件可直接当 harness 参考。

## 7. 遗留

- 无未解阻塞。真实 hub × 真实 stack × 真实 pi 的端到端（`tests/integration/fabric-xs*.test.ts`）、conformance C-X* 归 XW/X5。
- `resolveBlock` 的 full-id 缺口若主会话认为不可接受，可选修法（都需要动 X1 或 X4 的域）：hub resolve 回完整 id（打破防枚举）；或 hub 增加 `xs_req{op:"resolve", full:true}` 变体（仅限 block 用途）；或 X4 改为存 ref 并按前缀比对（改 `senderAllowed` 语义）。
