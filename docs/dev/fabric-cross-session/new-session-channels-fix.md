# /new（web「清空」）后频道成员丢失 — 根因与修复

日期：2026-10-27 · 分支：dev · 状态：已修复（未提交）

## 用户现象

在 web-hub 详情头部点「清空」（同一 pi 进程内发送内置 `/new`，见
`src/web-hub/ui/src/components/detail/DetailHeader.vue:237-240` 与
`src/web-hub/ui/src/i18n/zh/detail.ts:92`），新会话里该会话此前 `/fabric join` 加入的频道
（channel）全部丢失；TUI `/new`（含 session-nav 的 `/clear` 别名）同样如此。

## 根因（一句话）

频道成员只持久化在**会话文件的分支 entry**（`subagent:xs-membership`，按 sessionId 校验）里，
`/new` 产生全新 sessionId + 空分支，agent 侧无从恢复，于是 attach 时向 hub 发布
`joined:false`，hub 成员表随之清空 —— 是 agent 侧状态没带过 /new，不是 hub 或 UI 的显示问题。

## 调用链证据

1. web「清空」→ `useControl` command op `{ confirm:true }` → hub cmd → `builtin-bridge.ts` 的
   `/new`（同一 pi 进程）。pi 触发 `session_shutdown{reason:"new"}` → `session_start{reason:"new"}`
   （事件 reason 定义：`pi-coding-agent/dist/core/extensions/types.d.ts` SessionStartEvent/
   SessionShutdownEvent）。
2. 成员持久化：`src/fabric/xs/membership.ts:24-28`（D2：entry 带 sessionId，读回用
   `getBranch()`；`restore()` 在 sessionId 不匹配时忽略 —— 那是给 fork/复制文件准备的 P10，
   见 `membership.ts` `restore()`）。
3. 新会话装配：`src/fabric/xs/stack.ts` `buildStackXs` —
   `readXsMembershipEntry(ctx.sessionManager.getBranch())` 在**新会话空分支**上返回
   `undefined` → `membership.restore(undefined)` → pref 为空；`autoJoin` 默认 false ⇒ 不会重join。
4. hub 侧（无需改）：同一 socket 上 `session` 帧换新 sessionId ⇒
   `src/web-hub/hub/xs/members.ts` `onSession` 的 r1 #4 规则丢弃旧 member 记录；随后 attach 路径
   `src/web-hub/agent/index.ts`（`emitSession("attach")` 后立即 `xsBridge?.publishMember()`）
   用**新 stack** 的成员状态发 `xs_member` —— 修复前它是 `joined:false` ⇒ hub 表保持空。
5. UI 显示 `status.xs.channels`（AgentCard 频道 chip / ChannelsDialog），数据源就是 agent 的
   statusProjection ⇒ agent 侧修好即恢复显示，UI 零改动。

## 与别名（alias）的对齐结论

别名**没有**跨 /new 继承机制可对齐：`docs/dev/fabric-cross-session/alias-plan.md` §「不做」明确
「别名转移或继承（fork 与 `/new` 都拿不到）」，别名记录 hub 侧按 sessionId 持有，/new 后旧 sid
离线、别名留在旧 sid 上（可被 take / 到期释放）。这是既定产品决策，本修复不动别名。

## 修复设计

语义裁定：`/new` = 「同一操作者、同一工作区、清空上下文」，会话级的人工运营状态（频道偏好、
receive 偏好、屏蔽列表、joinedAt）应随操作者走；`fork`/`resume` 语义不变（fork 仍按 P10 不继承，
resume 恢复目标会话自己的 entry）。

机制（全程进程内，零 wire 变化，I10 append-only 不受影响）：

- `src/fabric/xs/membership.ts`
  - 新增 `explicit` 追踪：restore 到匹配 entry 或任何 mutation flush（join/leave/setReceive/
    block/unblock/adopt）后置位。
  - `handoffSnapshot()`：仅当有显式人工状态时返回 `toEntryData()`（ pristine 会话不 stash ⇒
    autoJoin 对全新会话的行为一字不变）。
  - `adopt(entry)`：忽略 entry.sessionId 应用状态，并以**新 sessionId** 重新持久化（flush）——
    之后的 `/reload` 也能恢复。不额外 bump epoch（attach 已 bump；此刻无在途 origin）。
  - 进程级单槽 `Symbol.for("pi-subagent:xs-membership-handoff")` +
    `stashXsMembershipHandoff` / `takeXsMembershipHandoff`（consume-once；I4 合规：容量 1，
    TTL = 下一次 session_start）。
- `src/fabric/xs/activate.ts`
  - `stashMembershipHandoff(reason)`：仅 `reason === "new"` 时从 `holder.current`（旧 stack）
    取快照写入全局槽；fork/quit/resume 不写。
  - `beginSessionStart(ctx, reason)`：任何 reason 都消费并清空槽（防陈旧），仅 `reason === "new"`
    时把快照存进闭包 `pendingHandoff`。
  - `stackInput()`：把快照作为 `StackXsInput.membershipHandoff` 传给本次 stack 构建并清闭包。
- `src/fabric/xs/stack.ts`（`buildStackXs`）：`reason === "new" ∧ restored === undefined ∧
handoff.sessionId !== sessionId` 时 `membership.adopt(handoff)`；autoJoin 条件追加
  `handoff === undefined`（显式 leave 经 handoff 继承后同样压制 autoJoin —— 与既有
  「explicit persisted leave wins over autoJoin」一致）。
- `src/index.ts`：`session_shutdown` handler 在 dispose 前调
  `xs.stashMembershipHandoff(event.reason)`；`session_start` handler 把 `_event.reason` 传给
  `beginSessionStart`。无新注册 ⇒ activation-trace golden 不变。

## 边界与安全

- secure 域（I11）：`fabric.crossSession` 强制关闭 ⇒ xs 不装配 ⇒ 无 membership、无 stash，不绕过。
- fabric 关 ⇒ off 三个 golden 字节不变（`git diff --quiet HEAD -- tests/fixtures/` 已验证；
  本修复不加注册、不改 wire、off 时 `beginSessionStart`/`stackInput` 输出不变）。
- fork：`session_shutdown{fork}` 不 stash；fork 复制分支里的旧 entry 仍被 `restore` 的
  sessionId 校验拒绝（P10），既有 fork 测试继续通过。
- 旧会话保留自己的成员资格：它的会话文件 entry 原样保留，之后 resume 旧会话会恢复其频道。
  （两个会话同在一个频道是合法状态 —— 频道是 scope 不是凭据。）
- hub 侧零改动：`session` 帧换 sid → 旧 member 记录失效 → attach 的 `publishMember` 用继承后的
  状态重建记录（顺序本就有保证：member slot 在 session slot 之后）。

## 测试

- **复现（先失败后通过）**：`tests/integration/fabric-xs.test.ts` 新增
  「/new (web 清空） keeps the joined channels…」— 真 hub 子进程 × 两个真 activate stack × 真
  socket：join #team → `replace`（reason "new"）→ 断言 `/fabric status` 仍 `xs: joined` +
  `channels #team`、对端 `list_sessions` 看到新 sid、`message_session` 可送达、`reload` 后仍在。
  修复前该用例失败于 `channels - (0/4)`（已实际验证失败形态）。
- **单元**：`tests/fabric/xs-membership-handoff.test.ts`（5 例）：pristine 不 stash；fork 式
  restore 后不 stash；adopt 携带 pref/receive/blocklist/joinedAt 并按新 sid 重新持久化
  （§2.4 写出规则：named-only pref ⇒ `joined:false` + `channels`）；显式 leave 也可继承（压制
  autoJoin）；全局槽 consume-once。

## 自验结果

- `npm run typecheck` ⇒ 0
- `npx vitest run tests/fabric tests/session-nav --maxWorkers=3` ⇒ 52 文件 / 833 通过
- `npx vitest run tests/web-hub/hub tests/web-hub/agent --maxWorkers=3` ⇒ 308 文件 / 6863 通过
- `tests/integration/fabric-*.test.ts`（xs 全套 + wake 全套 + wiring + off goldens）⇒ 全绿
- `npm run test:conformance` ⇒ 357 passed / 20 skipped；唯一失败文件是 `secure-gocryptfs.test.ts`
  的测试锁获取（并发跑的锁竞争，与本次改动无关 —— secure 代码零接触），单独重跑该文件 6/6 通过；
  单独重跑 `tests/conformance/fabric-xs.test.ts` + `fabric-wake.test.ts`（C-X1…C-X11、C-P1…C-P5）⇒ 28/28 通过
- prettier：改动文件全部通过
- `git diff --quiet HEAD -- tests/fixtures/` ⇒ 无差异

## 产品取舍记录（已按最小 surprise 裁定，未改 fork/resume）

| 取舍点             | 裁定                                                               | 备选                                  |
| ------------------ | ------------------------------------------------------------------ | ------------------------------------- |
| fork 是否继承      | **不继承**（P10 既有裁定，不动）                                   | 若未来要改需另立评审                  |
| /new 继承范围      | 整个 membership entry（频道 + receive 偏好 + 屏蔽列表 + joinedAt） | 只继承频道（信息更损失，不推荐）      |
| 显式 leave 后 /new | 保持未加入（压制 autoJoin）                                        | autoJoin 重新加入（与既有规则不一致） |
| pristine 会话 /new | 不 stash，autoJoin 行为不变                                        | —                                     |
| 别名               | 不转移（alias-plan 既定「不做」）                                  | 另立需求再做                          |
| 旧会话成员         | 保留（resume 旧会话即恢复）                                        | 无                                    |

## 建议 commit message

```
fix(fabric): keep channel membership across /new (web 清空)

/new replaces the session with a fresh sessionId and an empty branch, so
the xs membership entry (keyed by sessionId) was never restored and the
channels were silently dropped — the attach then published joined:false
and the hub member table emptied too.

Stash the outgoing stack's explicit membership snapshot at
session_shutdown{new} in a consume-once process slot and let the
successor stack adopt() it (re-persisted under the new sessionId;
suppresses autoJoin like a restored entry). Fork semantics (P10),
resume, aliases and the off goldens are unchanged; secure stays
force-off; hub and UI need no change.
```
