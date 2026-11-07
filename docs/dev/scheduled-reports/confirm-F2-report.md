# #61 F2 包报告：飞书审批卡片

基线：`dev`（C0 已合 `3d5b37f3`）。本包零 git 写操作；仅改 F2 文件域。H2（hub/schedule/service、agent-server、hub.ts）并行开发中，本包按 C0 已提交的端口类型（`FeishuSchedulePort.offers?/closedOffers?/decide?`）编程，测试全部用 fake 端口。

## 改动文件清单

- `src/web-hub/hub/feishu/schedule-confirm.ts`（新，约 660 行）：owner-only 审批卡片的全部逻辑。pi-free、闭包状态、无模块级可变状态（I4）；所有等待经注入 `FeishuClock` 有界且生产时钟 unref（I1/I5）；持久化只用既有 nonce 表（anchor `sched-card` + 按钮 `sched-ok`/`sched-no`），不新增 state 顶层键（D9）。
- `src/web-hub/hub/feishu/service.ts`（+69/−1）：组装 `scheduleConfirm`（前提 `schedulePort?.offers !== undefined`）；回调分派链追加 `sched-ok|sched-no`（旧 hub 静默忽略）；reconcile taps：durable 阶段 binding 增删改/新请求（含 `/unbind`，先于回执）、`runs.transfer` 新旧 sid、bindFresh 新旧 sid、session-pick notice 包装（覆盖 `/list` 卡点击绑定）、connector 重连 open（队列上限 8）、installation gen 变化（`setup --replace` 后 `revoked(oldAnchors)` + `reconcileAll(8)`）、allow/deny、30 s maintain（`reconcileAll` 兜底，60 s 扫描 tap 由 H2 经 `offersChanged` 触发）；`service.schedule.offersChanged(sid)` 新增；dispose 在 `sessionCard.dispose()` 之后（`bot.stop()`/connector.stop 仍最先）。
- `tests/web-hub/hub/feishu/schedule-confirm.test.ts`（新，36 个用例）：fake 端口单测 + 真实 service × fake H2 的服务级用例（durable `/unbind` 撤回、新 binding 先无证明、owner 请求建立证明后自动补卡、真实 nonce 持久化下回调批准与重放不再 decide）。

未碰：`tests/fixtures/**`、`src/web-hub/protocol/**`、`hub/schedule/**`、`agent-server.ts`、UI、`src/schedule/**`、`src/index.ts`。

## §4.5 逐条对照

- **目标选择 fail-closed**：只发 `chatType==="p2p"` ∧ `offline===undefined` ∧ 注入的独立 `provenOwner(binding)`（service 注入：`lastRequest(binding)?.senderOpenId` 存在且逐字等于当前凭据 owner；无 fallback）∧ owner 在 allow-list；群/话题一律不发。测试：群/话题/离线/第三方 open_id/`lastRequest` 缺失均不发，计数 `sched-confirm-no-owner`。
- **身份与持久化**：卡片 id `fsc<feishuKey(sid:offerId:defHash:bindingKey)>`；1 anchor（action `sched-card`，target JSON 含 `{sid,offerId,taskId,defHash,bindingKey}`，expiresAt=offer 到期，从不渲染）+ 2 按钮 nonce（绑定 installGen/tenant/owner/chatId/messageId，target 含 anchor）。nonce 预算 `FEISHU_CAPS.nonces - noncesReservedForOthers`（发送前预检 ≥3 空位；测试验证 reserve 不被侵占）。
- **发送流程**：先 `sendCard` 占位卡（「状态未知 — 在 web 查看」）拿 messageId，再签发 anchor+按钮 nonce，**一次 barrier commit 成功后才 PATCH 按钮**；commit 失败 ⇒ 保持无按钮占位，测试覆盖 commit false ⇒ 无按钮无 decide，恢复后可补按钮。发送期间 offer 已 settled ⇒ messageId 到达后立即 recall，测试覆盖。
- **卡面**：schema 2.0，页头「定时任务待确认 · 会话名 · sid6」，正文含 name/when/tz/form/feishu/enabled/ownerCwd/bg 全字段 + 完整 prompt（`neutralizeMarkdown` 后代码块，反引号中和防逃逸）+ hash 前 8 位 + web 链接（`safeFeishuLink`）+ 过期时间。>20000 B ⇒ 二分截断 prompt + 「完整内容见 web」+ **保留按钮**（Q4）；8 KiB 全 CJK 用例通过。
- **回调**：nonce 一次性赎回（inbound 链）→ `admission.callback` → owner-only（sender 逐字等于 live owner，gen/tenant 再核）→ anchor 仍在 ∧ `port.offers()` 仍有 `(offerId,defHash)` → `port.decide`（reqId `fs<feishuKey(eventId)>`，符合 `SCHED_REQ_ID_RE`），外层 `bounded` 12 s。每卡 `inFlight` 在进入首个 await 前同步置位：双击第二次回「处理中，请稍候」，只产生一次 decide。
- **decide 结果映射**：approved/rejected ⇒ PATCH 终态并 purge；`refused E_REV|offer-gone` ⇒ recall；`refused already-approved`/其他 ⇒ **PATCH 前重读** `closedOffers()/list()`：该 offer `closed.approved`（含本卡另一击）或账本同 hash 已批准 ⇒ 中性 PATCH「已批准」，否则「已在其他端处理」；offline/timeout/unavailable ⇒ PATCH「未确认是否生效」，anchor 保留，按钮下轮 reconcile 重签，不自动重试 decide。离线点击单独回「会话离线，未处理」。
- **reconcile(sid)**：closed 中 `offerId===anchor.offerId ∧ by==="feishu"` ⇒ 本卡所赢 ⇒ 只 PATCH 终态不 recall；`by!=="feishu"` ⇒ recall（purge+commit 认领 → DELETE，失败只做一次中性 PATCH，重启不重复 DELETE）；`withdrawn/expired` ⇒ 对应文案；closed 缺失 ⇒ 先对照账本（见缺口节）；anchor 过期 ⇒「已过期」；agent 离线 ⇒ 保留卡、点击回离线、按钮重签。新卡补发按 `expiresAt` 升序、仍在 TTL 内、未 closed。
- **容量**：全局 16、每会话 4；第 5–8 个不发卡，计数 `sched-confirm-card-cap`，槽位空出后下一次 reconcile 补发（测试：6 offers 只发 4 张、settle 后补第 5 张、按时序升序）。
- **hub 重启**：anchor 在 nonce 表持久存在 ⇒ 重启后经 `inventory()` 恢复卡片控制器，agent 权威列表到达前不关卡；commit 前崩溃 ⇒ 无 anchor ⇒ 无按钮、不会误批（测试覆盖）。

## §11 r2 对照

- **#3**：不复用 `service.ts:796` 的 `?? ownerOpenId` fallback；注入独立 `provenOwner`，`lastRequest` 缺失或为第三方 ⇒ 不发卡 + 计数。✅
- **#4**：本卡所赢判定只用 `closed.by==="feishu" ∧ closed.offerId===anchor.offerId`；不依赖 reqId（无持久化来源）。测试含「无关 by:feishu 的其他 offer 不误判」。✅
- **#6**：closed 缺失时先对照账本（见缺口节），绝不凭「open 列表没有」直接 recall。✅
- **#7**：4/会话、16 全局上限与补发如上。✅
- **#8**：触发点 tap 全部落位（offersChanged 出口、binding 增删/转移/新建、connector 重连、installation gen、allow/deny、卡 settle 后、anchor 到期、maintain 兜底）；重连队列 `reconcileAll(8)`，幂等（重复 tap 不重复发卡，测试覆盖）。✅
- **#10**：双击 `inFlight` 串行 + 所有 PATCH 前重读最新 `closedOffers()/list()`（含迟到第二击在 anchor 已 purge 后的「已批准」而非「已在其他端处理」）。另加：物理 PATCH 进行中 settle 只排队一次终态 PATCH，不被按钮 PATCH 覆盖；已知失败的按钮 PATCH 下轮 reconcile 自愈。✅

## 接口缺口（H2 待补，本包 fail-closed 兜底）

`FeishuSchedulePort.list()` 是只读投影行数组，空数组/缺失行**无法区分**「任务已删 / 投影滞后 / 账本 degraded」。当前实现：只把「同 sid+taskId、同 defHash 且 approved 的行」当作**正向证据**给中性 PATCH「已批准」；无匹配行一律保留卡片等下一轮，绝不猜删除（已获用户拍板确认）。建议 H2 在 port 上追加可选证据成员（本包不改 C0/H2 域），例如：

```ts
ledgerTask?(sessionId: string, taskId: string, opts?: { since?: number }):
  | { kind: "present"; approved: boolean; defHash: string }
  | { kind: "deleted"; scannedAt: number }   // 扫描起点晚于 since 才能证明删除
  | { kind: "unknown"; reason: string };     // 不可读/滞后 ⇒ F2 保留卡片
```

有此端口后，规则 4 的「任务已删除」分支才能真正落地。H2 正在并行改 `src/web-hub/hub/schedule/**` 与 `agent-server.ts`；本报告时点 `npm run typecheck`/`build` 因 H2 进行中代码报错（`hub/schedule/service.ts:834 Expected 2 arguments, got 1`、`:906/:907/:1042 FeishuSchedulePort` 未导入）——**非本包错误**。本包此前在干净 H2 状态下 typecheck 与 build 均为 0 error；F2 三个文件自身经 `tsc`（tsconfig.json + tsconfig.typecheck.json）与 vue-tsc 全量验证通过（W2 的 DetailHeader 错误已由 W2 修复）。

## 自验

- `npx vitest run tests/web-hub/hub/feishu --maxWorkers=4 2>&1 | tail -4`（最终重跑）：

  ```
      Tests  1451 passed (1451)
     Start at  22:41:26
     Duration  41.54s (transform 2.74s, setup 623ms, collect 8.27s, tests 85.40s, environment 7ms, prepare 2.14s)
  ```

  39 个文件全绿；新增 36 个 F2 用例（§8 飞书清单 15–23 全覆盖）。

- `npm run typecheck`：H2 并行写盘期间报 H2 错（见上）；本包完成态单独验证 0 error，三个 F2 文件无类型错误。
- `npm run build`：同上，H2 阻断；本包文件此前 0 error。
- `npx prettier --check` 本包三文件：通过（已 `--write` 归一）。
- `git diff --quiet HEAD -- tests/fixtures/`：exit 1——唯一改动是并行 C1 包的 `tests/fixtures/governance/activate-trace.json`（+5/−1），F2 未写任何 fixture；`feishu-spawn-http-golden.json` 等 A/B 级 golden 单独核验 exit 0。
- 零 git 写操作（无 add/commit/stash）。

## 建议 commit

`feat(web-hub): owner-only feishu schedule approval cards (#61 F2)`
