# #61 H2 包报告：hub 协调

## 结论

H2 完成（plan §4.5 hub 侧、§6、§8 测试 13）。**零 git 写操作**；未碰 C0 协议文件、F2 文件、`src/schedule/**`、web ui、`tests/fixtures/`。

## 改动

- `src/web-hub/hub/schedule/service.ts`
  - `onAgentFrame` 改为按 `t` 的**穷尽 switch**（`default` 用 `never` 兜底）；`sched_offers`/`sched_decide_ack` 不再可能被当成 `run_ack`（回归测试：pending `run()` 不被这两帧结算）。
  - `offersBySid`（内存，≤256 会话，按帧近因淘汰）：收到 `sched_offers` 时校验 ①发送 agentKey 在 registry 里的会话 == `frame.sessionId`，②该 agent 的 hello caps ∋ `sched.confirm.v1`；不符丢弃并计 `counters.offersDropped`。agent 断线后保留。
  - 投影 `offer?`（经 `project.ts` 的 `offerOf` 钩子）：仅当 会话**恰好一个**在线视图 ∧ 该视图就是发帧的 agentKey ∧ offer.defHash == 投影 defHash ∧ `pendingApproval` ∧ 未过期。帧到达 / view 掉线 立即重建投影（指纹去重，沿用原 SSE 门）。
  - `port.offers()`：只列「账本扫描里任务仍存在 ∧ defHash 相同 ∧ 未批准 ∧ 未过期」的 offer，附完整 `ScheduleTaskDef`、`sessionLabel`、`online`（离线会话的 offer 仍列出，`online:false`）；扫描落后时**不列出也不当成关闭**。`port.closedOffers(sid)`：该会话最近一帧的 closed。
  - `port.decide(req)`：入参形状校验（`bad-request`）→ 同 `reqId` 在途则**加入同一 promise**（不重复发帧）→ `offline` / `multi` / `refused no-cap`（getCaps 缺失或不含 confirm cap 同样 no-cap）/ `refused busy`（并发 waiter ≤64）→ 发 `sched_decide`（`expiresAt = now + 30 s`）→ 等 ack ≤10 s（`SCHED_DECIDE_ACK_WAIT_MS`，timer 经注入 timer，真实实现 unref）→ `timeout`。ack 只认**被询问的那个 agentKey**，陌生/迟到的 ack 计 `decideAcksIgnored`。`dispose()` 把全部 waiter 结算为 `unavailable` 并清 timer，之后的 decide 直接 `unavailable`。
  - `delivery.offersChanged?.(sid)`（尽力、不 await、异常吞掉并记 log）：每个被接受的 `sched_offers` 帧**必触发**（含 hello_ack 的相同内容重发——F2 的「agent 重新 attach 并确认权威列表」靠它）；重扫后「可见 offer 集合 / closed / online」指纹变化（如账本 defHash 追上或错开）；view 掉线（bus `agent_down`/`agent_removed`）；`bindDelivery` 时对已有会话补报一次。
  - 新计数器（`status().counters`，append-only）：`offersFrames offersDropped decidesSent decideAcks decideAcksIgnored decideTimeouts`。
  - `scannedAt: Map<sid, 扫描开始时间>`（见下「给 F2 的接入」）。
- `src/web-hub/hub/schedule/project.ts`：`ProjectDeps.offerOf?`；`taskProjection` 在 `pendingApproval` 时附 `offer`（无钩子 ⇒ 输出字节不变）。
- `src/web-hub/hub/schedule/feishu-port.ts`：re-export C0 的端口类型；`ScheduleDelivery` 增加可选 `offersChanged?`；新增 `HubScheduleExtras` / `HubSchedulePort` / `ScheduleLedgerEvidence` / `ScheduleOffersSeen`（**不改** `hub/feishu/schedule.ts`）。
- `src/web-hub/hub/agent-server.ts`：白名单追加 `sched_offers`、`sched_decide_ack`。
- `src/web-hub/hub/hub.ts`：`config.schedule` 存在时 caps 尾部追加 `sched.confirm.v1`（与 `sched.v1` 同一数组，`HubInfo.caps` 与 `hello_ack.caps` 同源）；schedule 关闭 ⇒ caps 不变。
- 测试：新增 `tests/web-hub/hub/schedule-confirm-hub.test.ts`（19 例）；`tests/web-hub/hub/schedule-frames.test.ts` 追加 1 例（新帧经真 agent-server 路由、畸形帧被 decoder 丢弃）。

## 给 F2 的接入方式：账本证据（回应 F2 报告的缺口）

`coordinator.port()` 返回的对象在 C0 的 `FeishuSchedulePort` 之上多了两个**可选**成员（类型 `HubSchedulePort`，在 `hub/schedule/feishu-port.ts`；C0 协议/端口类型文件未改）。F2 按结构读取即可：

```ts
import type { HubSchedulePort } from "../schedule/feishu-port.js"; // 或在 F2 里本地声明同形结构
const hub = port as HubSchedulePort;
const ev = hub.ledgerTask?.(sessionId, taskId, { since: anchorCreatedAt });
```

`ledgerTask` 返回：

| 返回                                             | 含义 / F2 该怎么做                                                                                                                                                                   |
| ------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `{kind:"present", approved, defHash, scannedAt}` | 任务仍在账本。`approved && defHash === anchor.defHash` ⇒ 中性 PATCH「已批准」（reload 后规则 4）；`defHash` 不同 ⇒ 定义已变（旧卡作废）。`approved` 是 `approval.hash === defHash`。 |
| `{kind:"deleted", scannedAt}`                    | **已证明删除**：该会话账本被一次**开始时间 ≥ `since`** 的扫描成功读取，且里面没有这个任务 ⇒ PATCH「任务已删除」。                                                                    |
| `{kind:"unknown", reason}`                       | 无证明，保留卡片等下一轮：`no-session`（hub 没缓存该会话）/ `degraded`（账本不可读）/ `root-degraded`（根目录降级）/ `stale`（最近一次扫描早于 `since`，任务可能当时还没建出来）。   |

- `since` 建议传**卡片/anchor 的创建时间**（hub 时钟，`clock.now()`）：offer 帧在 agent 写完账本之后才发，所以任何在建卡之后才开始的扫描都能证明「账本里没有它 = 已删」；省略 `since` 时默认只要求有一次成功扫描。
- `offersSeen(sessionId)` → `{at, online} | undefined`：agent 最近一次被接受的 `sched_offers` 帧到达时间 + 当前是否「恰好一个在线视图且就是发帧者」。F2 规则 3（「agent 已重新 attach 并确认过权威列表」）用 `offersSeen(sid)?.online === true && at >= 本次 reattach 之后` 判断即可；`undefined` 表示 hub 没收过该会话的帧（hub 重启后、agent 尚未重连）。
- 另需 F2 做一处小接线（**不在 H2 域**）：`hub.ts` 把 `bot.schedule`（F1 `FeishuSchedule`）交给 `scheduleHub.bindDelivery(...)`，H2 调的是它上面的可选 `offersChanged(sid)`。F2 要让 `service.schedule` 暴露这个成员，例如 `schedule: { ...scheduleSurface, offersChanged: (sid) => void runtime?.scheduleConfirm?.reconcile(sid) }`。没有它 hub 不会报错，只是卡片对 offer 变化的响应退回到 F2 自己的 60 s/30 s 维护 tap。

## 与计划的差异 / 实施中的判断

1. `port.offers()` 额外要求「任务未批准」：账本已批准而 agent 帧尚未关闭 offer 的瞬间，不会让 F2 给已批准任务重新发卡。
2. `sched_offers` 的 sid/cap 校验在 registry 尚无该 agent 的 session（`session` 帧未到）时同样丢弃——agent 侧 `session` slot 在 hello_ack 回放里先于 `onHubCaps`，且同 socket 保序，实际不可达；若以后改了发送顺序，需要改成「暂存到 session 到达」。
3. `decide` 同 reqId 在途时合并，而不是像 `run()` 那样覆盖 waiter（覆盖会让第一个调用被第二个的 timer 误结算）。
4. hub 对 offer 不做第二次 hash 校验（plan 把「`port.offers()` 里仍有 (offerId, defHash)」放在 F2 回调侧；agent 侧 `decide` 才是权威）。

## 自验

- `npm run typecheck`：通过（TS7 ×2 + vue-tsc）。
- `npx vitest run tests/web-hub/hub tests/web-hub/protocol --maxWorkers=4`：269 文件 / 7256 通过 / 3 skipped / 0 失败（含并行 F2 已落盘的 `feishu/schedule-confirm.test.ts`）。
- `npx vitest run tests/integration/schedule-hub.test.ts tests/integration/schedule-off-golden.test.ts tests/web-hub/boundary.test.ts`：26 通过（schedule 关闭 ⇒ caps/HubConfig 不变）。
- `npx prettier --check`（本包改动文件）：通过。
- `tests/fixtures/` 里唯一改动仍是 C1 的 `governance/activate-trace.json`，H2 未碰。

## 建议 commit message

```
feat(web-hub): hub coordination for AI-created schedule confirmation (#61)

Route sched_offers / sched_decide_ack through an exhaustive onAgentFrame switch
(an unknown frame is no longer treated as a run ack), keep the agent's offers in
bounded hub memory (sid and sched.confirm.v1 validated), project an optional
`offer` on pending tasks of online single-view sessions, and add port
offers/closedOffers/decide (offline|multi|no-cap|timeout; dispose settles
waiters as unavailable). Advertise sched.confirm.v1 next to sched.v1 and expose
ledger evidence (ledgerTask/offersSeen) for the Feishu card.
```
