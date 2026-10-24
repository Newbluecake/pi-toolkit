# F1 飞书包报告 — 定时任务 + 飞书主动推送（#32）

> 依据 `plan.md` r3 §7.1–§7.5、§12 F1 行。零 git 写操作。

## 1. 改动文件

| 文件                                       | 内容                                                                                                                                                                                                                                                                                          |
| ------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `src/web-hub/hub/feishu/schedule.ts`（新） | F1 全部新逻辑：`createFeishuSchedule`（`pushReport` / `pushNotice` / `settled` / `reconcile` / `receiptsFor` / `hasReceipt`）、`FeishuSchedulePort`（H1→F1 端口）、`createScheduleLists`（列表冻结，10 min）、`scheduleListText` / `scheduleRunReply`                                         |
| `src/web-hub/hub/feishu/state.ts`          | 新增 `scheduleReceipts` 表（cap 4096、TTL 7d、`sid/state/code/at` 严格 schema）；空表时**不写该键**；旧文件可读；`adoptInstall` 换 app 时清空；`usage().counts.scheduleReceipts` 仅非空时出现                                                                                                 |
| `src/web-hub/hub/feishu/security.ts`       | `NoticeBudget.reserve(key, gap, {lane?})` + `remaining()`；三通道 critical/normal/schedule；安全告警调用点改 `lane:"critical"`                                                                                                                                                                |
| `src/web-hub/hub/feishu/router.ts`         | `parseFeishuCommand(text, {schedule})`；`/schedule`、`/schedule run <n>` 意图；仅 p2p，群聊回 `schedule-p2p-only` 通知；`deps.schedule` 缺省 ⇒ 仍是未知命令                                                                                                                                   |
| `src/web-hub/hub/feishu/service.ts`        | `FeishuBotServiceDeps.schedule?`、`FeishuServiceEvent` 增 `sched_bound`；运行时装配 schedule 套件；`settled()` 的 `sch:` 分支；`start()` 里 `outbox.start()` 前 reconcile；`/schedule` 意图处理；help 仅在端口存在时多一行；`service.schedule.{pushReport,pushNotice,receiptsFor,hasReceipt}` |
| 测试（新）                                 | `tests/web-hub/hub/feishu/schedule-{budget,state,push,router,service}.test.ts`（共 57 例）                                                                                                                                                                                                    |

`render.ts` / `notify.ts` / `inbound.ts` 未改（复用 `renderReply`/`renderNotice`，done 抑制在 service 的 proactive 表内完成）。`outbox.ts` 不在文件域，未改——通知 key 用 `schm:<hash24>` 不带 tag（至多一次，无需结算跟踪）。

## 2. 与 H1 的对接点（I1 联调清单）

**H1 → F1（调用 `service.schedule.*`，均不抛）**

- `pushReport(offer: ScheduleReportOffer): Promise<{reportId, outcome, reason?}>`。`offer.read()` 是惰性的——F1 在 n/a / 过期 / 已有回执 / 未就绪 / 预算 / 余量 全部通过后才读文件，H1 的 reader 把 `readReportFile` 包进去即可。`outcome`：`queued`｜`skipped`（已有回执/并发重复）｜`waiting`（凭据在但未 open，**不写回执**，下一轮重试）｜`n/a`（从未装凭据 / `endedAt` 早于凭据安装时间 / 未启用，不写回执）｜`expired`｜`refused`（已写 `refused(code)` 回执，不再重试）。发现 `expiresAt`/回执过滤可先用 `hasReceipt(reportId)` 省掉读文件。
- `pushNotice({key, sessionId, sessionLabel, taskId, taskName, kind:"missed"|"unknown"|"skipped", count?, at?, droppedIndex?})`：H1 先落自己的合并状态再调用（至多一次）。F1 自己再守一道「每任务每整点 ≤1、全局 ≤30/h、`schedule` 通道预算、余量」，被拒返回 `refused(reason)`（H1 视为已消耗）。budget 拒绝过的报告数会并入该任务的下一条通知。
- `receiptsFor(sessionId)`：hello 时补推 `sched_receipts` 用。

**F1 → H1（`deps.schedule: FeishuSchedulePort`，H1 在 `hub.ts` 装配并传入 `createFeishuBotService`；该键缺省 ⇒ 飞书侧字节不变）**

- `list(): FeishuScheduleRow[]`（投影行：会话/任务/online/approved/defHash/when/nextAt/lastStatus）。
- `run({reqId, sessionId, taskId, defHash}): Promise<ScheduleRunResult>`：H1 负责「恰好一个在线视图且声明 `sched.v1`」检查、`sched_run` 帧、≤10 s ack 等待，返回 `started|refused(reason)|offline|multi|timeout|unavailable`；F1 外加 12 s 兜底超时。`reqId` = `feishuBatchIdentity([messageId]).id`（`fs`+30 位，同消息重投递不变，满足 `^[A-Za-z0-9_-]{16,64}$`）。refuse reason 里 `defhash`/`task-changed` ⇒「任务已修改，请重新 /schedule」。
- `receiptsChanged(sessionId, [{reportId,state,code?}])`：每次回执变化（accepted/refused/sent/failed/uncertain、重启对账）都调；H1 转成 `sched_receipts{sessionId, reportIds}` 推给在线归属会话。
- 事件：H1 把 agent 的 `sched_bound` 帧以 `{type:"sched_bound", agentKey, runKey}` 投进现有 `deps.events` 总线即可（须在该 agent 的 `ev` 流中保持原序）。

## 3. 关键行为 / 决策

1. **回执与 outbox 同次 commit**：`pushReport` 在同一个同步段内 `scheduleReceipts.set(accepted)` → `outbox.enqueueFinal`（其 `store.add` 同步），二者由 enqueue 内的同一次 `state.commit()` 落盘。`requestId = sch:<64hex reportId>`。目标 = 机器人 owner 的 p2p（open_id）。
2. **偏离 plan 一处**：`enqueueFinal` 返回 `durable:false` 时**保持 `accepted`**（不记 refused）：outbox 部分已在内存/状态里，会随写盘重试发出；若重启后组不在了，由 reconcile 记 `uncertain`。记 refused 反而可能「标拒绝却实际送达」。`ok:false` 仍记 `refused(outbox-<code>)`。
3. **settle 回写**：`delivered`⇒`sent`；`failed`⇒`failed(code)`；`partial` / `swept` / `expired-uncertain`⇒`uncertain`。commit 失败抛 `persist-failed`，让 outbox 按既有机制重投 settle。未知 reportId（状态被清）声明已处理并忽略。
4. **重启对账**：`start()` 中 `outbox.start()` 前，`accepted` 且 outbox 无 `sch:` 组 ⇒ `uncertain(restart)`，不重发。
5. **预算/余量**：报告全局 20/h、每任务 6/h（超出 `refused(budget)`，计 `sched-budget`）；outbox 占用 ≥50% 上限、state 剩余 <512 KiB、work 队列余量 <64 ⇒ `refused(headroom)`；回执表满 ⇒ 不投递、计 `sched-receipt-cap`。上传并发 ≤1，单个 md ≤256 KiB，上传失败降级为截断。计数进入 `info().counters.dropped`（`sched-*`）。
6. **NoticeBudget**：`schedule` 通道需放行后剩余 ≥5 且本分钟 schedule 用量 < `max(1, G−5−2)`；critical/normal 与旧行为一致（无 opts 字节等价，测试钉住）。安全告警改 critical 并有测试证明 schedule 洪峰后仍能发出。
7. **`/schedule`**：仅名单内 + p2p；群聊回 `schedule-p2p-only`。列表每 (chat, 操作者) 一代、冻结 `{sid,taskId,defHash}`、10 min 有效、≤30 行；`run <n>` 过期/越界不触达 hub。执行点重新 `admission.authorize`。
8. **`sched_bound`**：service 的 proactive 表里 `p.sched`；`agent_settled` 时若 `p.sched` 且本次不是 failed ⇒ 跳过 done 通知（**failed 仍通知**——plan 只说 done）。兼容 bound 帧与该消息 `message_start` 的两种到达顺序；之后再出现的人工 user `message_start` ⇒ 清除标记恢复通知；无进行中的 run 时收到 bound ⇒ 忽略（保守）。已知边界：run 内出现多于一条的更早 user message 时不打标。

## 4. 自验

- `npx vitest run tests/web-hub/hub/feishu --maxWorkers=3` → 38 files / 1414 tests passed
- `npx vitest run tests/integration/web-hub-feishu-bot.test.ts` → 23 passed
- `npm run typecheck`（`tsc --noEmit`）→ 0 错误
- `npx prettier --check` 全部改动/新增文件 → 通过

## 5. 遗留 / 注意

- 联调（I1）：H1 端口实现、`sched_receipts` 推送、`sched_bound` 入总线、`createFeishuBotService` 的 `schedule` 传参均由 H1 完成，F1 侧只有契约测试（fake 端口）。
- 重启对账的 `start()` 接线没有独立的服务级测试（单元测试覆盖 `reconcile` 本身）；建议 I1 在真 hub 重启用例里补一条。
- `state.json` 一旦写入过回执，回退到旧版本会因未知顶层键判 corrupt（旧代码 strict）；功能关闭/从未写过则文件字节不变。
- 报告标题不含时间戳（避免时区歧义）；missed/unknown 通知时间用 UTC。
