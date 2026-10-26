# #61 AI 建定时任务后当场确认（TUI / web / 飞书卡片）· 实施方案 r2

> 车道 L3。只读调研后产出，未改任何代码。改动 `src/schedule/**`、`src/web-hub/hub/feishu/**`、`src/ask-user/**` 前仍须先读
> `docs/dev/scheduled-reports/README.md`、`docs/dev/feishu-bot/README.md`、`docs/dev/ask-user-async/README.md`。
> 基线：`dev@3831a2bd`（v0.10.0），pi peer 1.3.0。
> r2：按方案评审（kimi）4 major + 4 minor + 2 nit 修订，并纳入文末「用户拍板（2026-10-26）」。逐条对照见 §11。

## 1. 背景与目标

现状：AI 用 `schedule` 工具 `create`，或用 `update` 改执行字段（批准随之失效）以后，任务一直停在「待确认」，直到用户自己去终端敲
`/schedule approve <id>`，或打开 web 定时面板点「审阅 → 批准」。用户常常不知道 AI 建了任务，或者人不在终端前。

目标（已拍板）：

- 工具一返回 `pending`，就**异步**在三个渠道同时请求确认，不阻塞模型本轮。**谁先确认算谁，其余渠道自动收回。**
  - ① TUI：本地**三选项 select**（批准 / 拒绝 / 稍后）。它和 `/schedule approve` 走同一条 CAS 路径：弹框前先采样 `defHash`，确认后在锁内 CAS，`E_REV` 时提示重新审阅。
  - ② web：复用 `ScheduleReview` 对话框（自动弹出），新增「拒绝」。
  - ③ 飞书：向**绑定该会话的 p2p 私聊**推卡片，只给 owner。卡片展示完整定义，带「批准 / 拒绝」两个按钮；按钮绑定定义哈希，定义一变卡片就失效。已在别处处理时撤回卡片，撤回失败就中性 PATCH（照 ask_user 卡片的 recall 机制）。超过 20 KB 时截断 prompt、注明「完整内容见 web」、**保留按钮**。
- 拒绝 = **撤销 AI 未确认的改动**：拒绝 AI 新建 ⇒ 删除；拒绝 AI 修改 ⇒ 恢复到改动前的定义（原来的批准随之自动重新生效）。
- 安全模型不变：仍必须由人确认。print/json/无 UI 模式不弹框，任务保持 pending。子会话、secure 照旧拒绝（`E_CHILD`/`E_SECURE`）。
- **不新增设置项**，随 `schedule.enabled` 生效。
- 约束：I1（零悬挂：所有等待都有界）、I4（不加模块级可变状态）、I5（timer 全部 unref）、I9（`schedule-off-golden` 不变）、
  I10（wire 只追加：新帧、新 cap、新可选字段，不 bump PROTO）、I11（secure 下 schedule 强制关闭，不变）。

非目标：用户自己建的任务（本就自动批准）、用户 `/schedule edit` 一个 pending 任务，都不弹确认；`--all` 管理的他会话任务也不弹；`/reload` 或重启之后不补弹旧的 pending 任务（「当场」语义）。

## 2. 现状摘要（调研结论）

| 位置                                                              | 事实                                                                                                                                                                      | 对本方案的意义                                                                                                                              |
| ----------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------- |
| `src/tools/schedule-tool.ts`                                      | `create`/`update` 走 `ops.createTask/updateTask`（origin `agent/tool`），结果 `details.pending`；工具描述是冻结串（缓存前缀）                                             | 在这里挂「发起确认」；**不改** `SCHEDULE_TOOL_DESCRIPTION`，只改动态结果文本                                                                |
| `src/schedule/agent/ops.ts`                                       | AI 写入从不写 `approval`；`updateTask` 在 `changeTask` 锁内改字段                                                                                                         | update 需要拿到「改之前」的定义（拒绝即回滚用），新增锁内回调                                                                               |
| `src/schedule/core/claim.ts:425` `approveTask(store,id,hash,via)` | 锁内只比 `defHash(task)!==hash ⇒ E_REV`，否则写 `approval`                                                                                                                | **三渠道批准的唯一仲裁点**；但**缺幂等守卫**（同 hash 并发两次都 `changed`，见 §11-1），r2 补锁内 `isApproved ⇒ refused "already-approved"` |
| `src/schedule/core/claim.ts:384` `changeTask`                     | mutate 之后按 hash 变化 / 由不可执行变可执行跳水位 `voidUntil`                                                                                                            | `rejectTask` 回滚直接复用它                                                                                                                 |
| `src/schedule/core/spec.ts:318` `SCHED_EXECUTION_FIELDS`          | `defHash` 不含 `name`                                                                                                                                                     | 回滚**不能**动 `name`（否则冲掉用户手工改名，见 §11-5）                                                                                     |
| `src/commands/schedule.ts:310` `approveFlow`                      | 先采样 hash，再 `ctx.ui.confirm`，再 `approveTask`；早检 `isApproved`；`FEISHU_REFUSED` 含 approve；web 只接受 `approve <id> <64hex>`                                     | TUI 渠道照抄这个顺序（改 select 三选项）；新增 `reject` 子命令                                                                              |
| `src/web-hub/agent/command-policy.ts:154` `schedulePolicy`        | 冻结表：`approve <id> <hash>` allow，其余写操作 confirm/deny                                                                                                              | 只追加 `reject <id> <hash>` 一行（allow，形状同 approve）                                                                                   |
| `src/schedule/core/spec.ts` / `reader.ts:115`                     | `ScheduleApproval.via ∈ {tui,web}`，reader 严格校验                                                                                                                       | 飞书批准记 `via:"web"`（拍板 Q3），账本零改动                                                                                               |
| `src/schedule/agent/coordinator.ts`                               | `sched_run`→恰好一个 `sched_run_ack`，按 reqId 去重；只在 `link.ready()`（hello_ack∋`sched.v1`）时发帧                                                                    | 飞书审批通道照搬这个形状                                                                                                                    |
| `src/web-hub/hub/schedule/service.ts`                             | hub 只读扫描账本；`port.run()`：在线视图唯一 + cap 检查 + 发帧 + ≤10 s 等 ack；`onAgentFrame` 的 else 分支**默认当成 run_ack**                                            | 新增 offers 存储、`decide()`；`onAgentFrame` 必须改成按 `t` 分派                                                                            |
| `src/web-hub/hub/agent-server.ts:265`                             | 按 `t` 白名单把 `sched_*` 截给 coordinator                                                                                                                                | 白名单追加两个新 t                                                                                                                          |
| `src/web-hub/hub/feishu/admission.ts`                             | F6 `dispatch()` 只放行 `prompt(followUp)`/`dialog_answer`/`dialog_cancel`；`/schedule run` 走的是 `port.run` 而不是 `dispatch`                                            | 审批也走 port 通道，**F6 的 op 白名单不放宽**                                                                                               |
| `src/web-hub/hub/feishu/service.ts:796`                           | `operator: (binding) => lastRequest(binding)?.senderOpenId ?? credentials.current()?.ownerOpenId` —— **fail-open**                                                        | 定时审批卡**不得复用**这个 fallback，必须 fail-closed（见 §11-3）                                                                           |
| `src/web-hub/hub/feishu/dialogs.ts`                               | ask_user 卡片：`recall:"pending"→"attempted"` 先落盘再 DELETE，失败只做一次中性 PATCH；按 bindings 推卡**含群话题**                                                       | 复用它的 recall 语义，但**不复用 dialog 通道**（它会推群，也展示不了完整定义）                                                              |
| `src/web-hub/hub/feishu/session-card.ts`                          | 卡片权威 = 服务端 nonce（anchor nonce + 按钮 nonce），**不新增 state 顶层键**                                                                                             | 定时审批卡照此只用 nonce 表持久化                                                                                                           |
| `src/web-hub/hub/feishu/state.ts:1313`                            | `ingest` 严格 `onlyKeys(doc, TOP_KEYS)`；nonce 的 `action` 是任意 `^[a-z0-9_.-]{1,32}$`，`target` 是任意 JSON 串                                                          | 新 action 名对 old hub 无害（回调链对未知 action 静默忽略）                                                                                 |
| `src/web-hub/ui/src/components/schedule/ScheduleReview.vue`       | 批准发 `/schedule approve <id> <defHash>`，hash 只取自投影；`E_REV` 提示重审；按钮只在 `canWrite ∧ pendingApproval` 时出现                                                | 加「拒绝」按钮和「已在其他端处理」提示；由 `DetailHeader` 自动打开                                                                          |
| `src/web-hub/ui/src/logic/schedule.js`                            | `approveArgs(id, hash)` 等纯 helper                                                                                                                                       | 追加 `rejectArgs`                                                                                                                           |
| pi 1.3.0 `interactive-mode.js:2109` / `:2153`                     | 扩展对话框**共用编辑器槽**：后开的直接覆盖 `this.extensionSelector`，**前一个的 promise 永不 resolve**；abort/timeout 的收尾 `hideExtensionSelector()` 关的是**当前**那个 | 确认框必须排队；**绝不用 pi 的 `timeout`，且无法证明所有权时绝不自 abort**（§4.3、§11-2）                                                   |
| pi `runner.js:368` `withUIPrompt`                                 | `ui_prompt_start/end` 只在最外层（depth 0↔1）发，嵌套的对话框**不发事件**；事件经 microtask 投递                                                                          | 「我的框是否仍被显示」**不可证**（见 §11-2）                                                                                                |
| `src/schedule/agent/dispatch.ts:239` `QUIET_KINDS`                | 带 `SCHED_CUSTOM_TYPE`、但 `details.kind` 不在 quiet 集合里的消息，会被当成 wake，在 `before_agent_start` 被孤儿中止                                                      | 决定通知消息用新的 `kind:"confirm"`，**必须加进 QUIET_KINDS**                                                                               |
| `src/topic-switch/confirm.ts`                                     | TUI select 与 remote dialog 竞速：`createDialogRace`；rpc 有 remote 时只用 remote                                                                                         | rpc 规则照搬；仲裁不用 race，改由账本 CAS 承担                                                                                              |

## 3. 总体设计

### 3.1 核心思想：账本是唯一仲裁者，offer 是短命的「请求确认」

- **仲裁**：三个渠道的批准最终都落到 `approveTask` 的锁内 CAS（拒绝落到新加的 `rejectTask`，同样是锁内 CAS）。谁的事务先提交谁就赢；**r2 起 `approveTask` 自带幂等守卫**：锁内发现 `isApproved(task)` 立即 `refused "already-approved"`，所以同 hash 的并发/连点只会有一个 `approved`。后到者拿到 `already-approved` 或 `E_REV` 或「任务没了」。不需要新的跨进程竞速原语。
- **offer**（确认请求）：只存在 agent 内存里，一个 session stack 一份。形如 `{offerId, taskId, defHash, origin, expiresAt}`，只由 AI 的 create/update 产生。三个渠道都只是 offer 的呈现，**offer 一失效，三个渠道统一收回**。
  - 失效条件按优先级列：已决定（本 offer 的批准/拒绝）、账本里该任务已批准、`defHash` 变了（再次 update）、任务被删、过期（`SCHED_CONFIRM_TTL_MS`）、被挤出（上限 8 个）、stack 销毁（会话切换、`/reload`、退出）。
  - 每个 offer 另有一个**同步的** `deciding` 位（不是持久状态）：`decide()` 进入时同步置位并缓存 promise，同一 offer 的并发调用复用同一个 promise，保证「一次决定 ⇒ 一条 notice、一个 `closed.by`」。
- **收回**：agent 每次重新校验 offer（自己写了账本、或 15 s 轮询）后，向 hub 发一份**全量** `sched_offers`（open + 最近 closed，形状仿 dialogs 帧）。hub 据此更新 web 投影的 `offer` 字段和飞书卡片；TUI 框由 agent 本地处理（r2：**不 abort**，见 §4.3）。

### 3.2 模块划分（文字结构图）

```
 agent 进程（主会话，post-guard，仅 schedule.enabled）
 ┌───────────────────────────────────────────────────────────────────────────┐
 │ tools/schedule-tool.ts ──create/update 成功且 pending──► confirm.offer()  │
 │ commands/schedule.ts  ──/schedule reject──────────────► confirm.decide()  │
 │                                                                           │
 │ schedule/agent/confirm.ts（新，pi-free 核心 + 注入 ui 端口）               │
 │   OfferRegistry ── revalidate(ledger snapshot) ── publish(offers) ──┐      │
 │   TuiPresenter（排队/开框纪律/不自 abort）── ctx.ui.select ──► decide()     │
 │   decide(): approveTask / rejectTask（core/claim.ts，锁内 CAS）      │      │
 │        │ 成功 ⇒ agent.changed() ⇒ revalidate ⇒ publish                │      │
 │        └► notice(sendMessage kind:"confirm", triggerTurn:false)      │      │
 │ schedule/agent/coordinator.ts  offers()→sched_offers；onDecide→ack ◄─┘      │
 │ web-hub/agent/{connection,index}.ts  路由 sched_decide；hello.caps          │
 └──────────────────────────────┬────────────────────────────────────────────┘
          sched_offers ↑ / sched_decide ↓ / sched_decide_ack ↑   （cap sched.confirm.v1）
 hub 进程                       │
 ┌──────────────────────────────┴────────────────────────────────────────────┐
 │ hub/schedule/service.ts  offersBySid（内存）+ decide() 等 ack ≤10 s          │
 │   ├─ project.ts  投影 ScheduleTaskProjectionWire.offer?（仅在线 ∧ 哈希一致）│──SSE──► web
 │   └─ feishu-port  offers()/closedOffers()/decide()/onOffersChanged          │
 │ hub/feishu/schedule-confirm.ts（新）  p2p∧owner(fail-closed)、完整定义卡、   │
 │   anchor+按钮 nonce、回调→port.decide、recall/中性 PATCH                     │
 │ hub/feishu/service.ts  组装 + 回调分派（action sched-card/sched-ok/sched-no）│
 └───────────────────────────────────────────────────────────────────────────┘
 web UI：DetailHeader 监视 offer → 打开 SchedulePanel(initialReviewTaskId) → ScheduleReview（批准/拒绝）
```

依赖方向不变：`core/` 不依赖 pi（`rejectTask` 放 `core/claim.ts`）；`confirm.ts` 只依赖 core 与注入端口；hub、protocol 不 import `src/schedule/agent/**`。

### 3.3 三渠道竞速与收回时序

```
模型        tool          confirm(agent)        账本/锁          hub(H)            web              飞书(owner p2p)
 │ create ──►│ createTask ──────────────────────► 写 task(pending)
 │           │ ◄─ ok(pending)
 │           │ offer(task,create) ─►│ 注册 O1{h1}
 │ ◄─ "已请求确认"                  │ changed()→sched_changed ─────► 重扫
 │ (回合继续)                       │ publish ─ sched_offers{open:[O1]} ─► offersBySid
 │                                  │                                  │ 投影 offer ─SSE─► 自动开 Review(h1)
 │                                  │                                  │ 卡片 C1(h1) ──────────────────────► 卡片[批准][拒绝]
 │ agent_settled ─────────────────► │ 静默且空闲 ⇒ TUI select（弹框前采样 h1）
 ════════ 竞速：A 飞书先点（B、C 是其他渠道先点的对称情形）════════
 │                                  │                                  │◄── 回调(nonce) ─────────────────── 点「批准」
 │                                  │◄── sched_decide{O1,h1,approve} ──│ port.decide 等 ack
 │                                  │ decide：O1.deciding 置位 ∧ offer 活 ∧ 哈希一致
 │                                  │ approveTask(h1,"web") ─► 锁内 !isApproved ∧ hash 相等 ⇒ 写 approval
 │                                  │ ack approved ───────────────────►│ PATCH C1「已通过飞书批准」
 │                                  │ changed ⇒ revalidate：O1 closed{approved,by:feishu,offerId}
 │                                  │ TUI 框保留，notify「已在其他端批准」（不 abort，§4.3）
 │                                  │ publish ─ sched_offers{closed:[O1]} ─► 投影去掉 offer ─SSE─► Review：已在其他端批准
 │                                  │ notice：用户已通过飞书批准 s_x（下一轮可见）
 ════════ B：TUI 先选「批准」 ════════
 │                                  │ decide(by:"tui") ─► 锁内 CAS 成功 ⇒ closed{approved,by:tui}
 │                                  │ publish ─► H：C1 的 offerId 已 closed 且 by≠feishu ⇒ recall
 ════════ C：web 点批准（/schedule approve id h1） ════════
 │                                  │ 命令路径 approveTask 成功 ⇒ agent.changed() ⇒ revalidate ⇒ closed{approved,by:elsewhere}
 │                                  │ notify TUI；publish ⇒ 飞书 recall
 ════════ D：作废（AI 再 update 成 h2） ════════
 │ update ──►│ updateTask ─────────────────────► 写 h2（approval 不匹配）
 │           │ offer(task,update,base) ─►│ O1 closed{superseded}；注册 O2{h2, origin 继承 O1}
 │                                  │ 排队 O2；旧框若在 ⇒ notify「定义已变更，稍后会再问你」
 │                                  │ publish{open:[O2],closed:[O1]} ─► H：recall C1，发 C2(h2)；web 投影切到 h2
 │   （若有人拿旧 h1 来批：锁内 !isApproved ∧ defHash=h2≠h1 ⇒ E_REV；飞书旧 nonce 先在 hub 侧挡住：anchor 已 purge ⇒「已失效」）
 ════════ 晚到 / 失败 ════════
 │  两端几乎同时：锁串行化；先到者写 approval，后到者锁内 isApproved ⇒ refused "already-approved"。
 │  同一 offer 的两次 decide 在同一进程：deciding 位 ⇒ 复用同一 promise，不产生第二条 notice。
 │  飞书拿到 already-approved：PATCH「已在其他端处理」，不重试。
 │  另一进程（--all approve）先批：本进程最长 15 s 后由轮询发现 ⇒ closed{approved,by:"elsewhere"}。
```

## 4. 接口契约

### 4.1 协议（`src/web-hub/protocol/schedule.ts`，只追加）

```ts
/** 两侧都用同一个串；hub 在 HubConfig.schedule 存在时广播，agent 在 schedule port 存在时广播。 */
export const SCHED_CONFIRM_CAP = "sched.confirm.v1";
export const SCHED_CONFIRM_OFFERS_MAX = 8; // open 上限（agent 侧挤出最旧）
export const SCHED_CONFIRM_CLOSED_MAX = 8; // closed 回显上限
export const SCHED_CONFIRM_TTL_MS = 2 * 3_600_000; // offer 寿命（常量，不做设置项）
export const SCHED_DECIDE_TTL_MS = 30_000; // sched_decide.expiresAt = now + 30 s
export const SCHED_DECIDE_ACK_WAIT_MS = 10_000;

export type SchedOfferOutcome = "approved" | "rejected" | "superseded" | "expired" | "withdrawn";
export interface SchedOfferWire {
  offerId: string;
  taskId: string;
  defHash: string;
  expiresAt: number;
}
export interface SchedOfferClosedWire {
  offerId: string;
  taskId: string;
  defHash: string;
  outcome: SchedOfferOutcome;
  /** 谁赢的；"elsewhere" = 账本在 confirm 之外被批准（web 命令 / --all / 他进程 / reload 后）。 */
  by?: "tui" | "web" | "feishu" | "elsewhere";
}
/** agent→hub：本会话 offer 的权威全量（每次变化 + 每次 hello_ack 都发；空列表也发）。 */
export interface SchedOffersFrame {
  t: "sched_offers";
  sessionId: string;
  open: SchedOfferWire[]; // ≤ OFFERS_MAX
  closed: SchedOfferClosedWire[]; // ≤ CLOSED_MAX，agent 保留 120 s
}
/** hub→agent：飞书卡片的决定。 */
export interface SchedDecideFrame {
  t: "sched_decide";
  reqId: string;
  sessionId: string;
  offerId: string;
  taskId: string;
  defHash: string;
  decision: "approve" | "reject";
  expiresAt: number;
}
/** agent→hub：每个未过期的 sched_decide 恰好回一个。 */
export interface SchedDecideAckFrame {
  t: "sched_decide_ack";
  reqId: string;
  result: "approved" | "rejected" | "refused";
  /** 静态原因：E_REV | already-approved | offer-gone | expired | E_NOT_OWNER | E_SECURE | E_DEGRADED | E_BUSY … ≤128 字符 */
  reason?: string;
}
```

- schema 全部 `additionalProperties:false`；`offerId`、`reqId` 用 `SCHED_REQ_ID_RE`；`defHash` 用 `HashSchema`；数组带 `maxItems`。
- 折叠进注册表（追加）：`SCHED_AGENT_FRAME_SCHEMAS += { sched_offers, sched_decide_ack }`，`SCHED_HUB_FRAME_SCHEMAS += { sched_decide }`；`messages.ts` 的 `AgentFrame`/`HubFrame` 联合类型同样追加。
- **卡片关闭判定只看 `closed` 的 `(offerId, by)`**；r2 删掉了 `reqId` 回显（它没有持久化来源，重启后会误判，见 §11-4）。`reqId` 仍作为 agent 侧的去重键保留在 `sched_decide`/`ack` 里。
- **投影追加可选字段**：`ScheduleTaskProjectionWire.offer?: { offerId: string; expiresAt: number }`。只在以下条件同时成立时出现：会话恰好一个在线视图、`offer.defHash === projection.defHash`、`pendingApproval`、未过期。W1 本来就忽略未知键，旧 UI 不受影响。
- **发帧门**：agent 发 `sched_offers` 要求 `link.ready() ∧ hello_ack.caps ∋ SCHED_CONFIRM_CAP`；hub 发 `sched_decide` 要求 `getCaps(agentKey) ∋ SCHED_CONFIRM_CAP`。新旧互配时缺 cap 的一侧就是 TUI-only（旧 hub）或无卡片（旧 agent），不会误发帧。
- 不 bump PROTO，`sched.v1` 帧形状不动（`SchedChangedSchema` 严格；**不得**往里加字段）。

### 4.2 agent 侧

#### `src/schedule/core/claim.ts`

**① `approveTask` 加锁内幂等守卫（r2，见 §11-1）**

```ts
export function approveTask(store, taskId, reviewedHash, via): Promise<TaskChange> {
  return changeTask(store, taskId, (task, now) => {
    if (isApproved(task)) return { refuse: "E_INVALID", detail: "already-approved" }; // ← 新增：幂等
    if (defHash(task) !== reviewedHash) return { refuse: "E_REV", detail: "definition changed since review" };
    task.approval = { hash: reviewedHash, by: "user", via, at: now };
    return undefined;
  });
}
```

- 这是**行为变化**：重复批准从「再次 changed」变成 `refused E_INVALID "already-approved"`（复审核实：仓库里没有「重复批准期望 changed」的旧断言，`claim.test.ts:471` 不需改；以新增的并发同 hash 用例作回归守卫；`/schedule approve` 已有早检，用户文案不变）。
- 不新增 `ScheduleErrorCode`（error code 词表冻结），原因放 `detail`。

**② 新增 `rejectTask`**

```ts
/** 拒绝 = 撤销 AI 未确认的改动。revertTo 缺省 ⇒ 该任务是 AI 新建的，删除；有 ⇒ 恢复 AI 改动之前的执行定义。 */
export function rejectTask(
  store: SessionStore,
  taskId: string,
  reviewedHash: string,
  revertTo?: Pick<ScheduleTask, "form" | "when" | "prompt" | "feishu" | "bg">,
): Promise<TaskChange | { kind: "removed" }>;
```

- 锁内按顺序检查：任务不存在 ⇒ `refused E_INVALID "no-task"`；`isApproved(task)` ⇒ `refused E_INVALID "already-approved"`；`defHash(task) !== reviewedHash` ⇒ `E_REV`。
- 删除分支：在**同一事务**里 `removeTask`，成功后由调用方补做 `opts.revoke` 和 `dropQueuedRuns`（和 `deleteTask` 共用抽出的 helper）。
- 回滚分支：`changeTask` 内恢复 `form/when/prompt/feishu/bg` 这组执行字段，**不动 `name`**（`name` 不参与 `defHash`，回滚它只会冲掉用户的手工改名，见 §11-5），**不碰 `approval`**。原来已批准的定义 ⇒ `approval.hash` 仍等于恢复后的 `defHash`，任务自动恢复可执行；原来是 pending ⇒ 回到 pending。`changeTask` 的「哈希变化 ⇒ 水位跳到 now」照常生效，不补跑。

#### `src/schedule/agent/ops.ts`：`UpdateOpts` 追加

```ts
/** 锁内、mutate 之前回调一次（结构化克隆）；供 confirm 记录回滚基线。只读，不得抛出。 */
onBase?: (before: ScheduleTask) => void;
```

#### `src/schedule/agent/confirm.ts`（新）

```ts
export type OfferOrigin =
  | { kind: "create" } // 拒绝 ⇒ 删除
  | { kind: "update"; base: TaskBaseSnapshot }; // 拒绝 ⇒ 回滚到 base
export interface ScheduleConfirmDeps {
  agent: Pick<ScheduleAgent, "sessionId" | "mode" | "store" | "gate" | "changed" | "readState">;
  /** 由 surface.start(ctx) 提供；undefined ⇒ 无本地 UI（print/json/!hasUI）。 */
  ui?: {
    mode: string;
    hasUI: boolean;
    select(title: string, options: string[], o?: { signal?: AbortSignal }): Promise<string | undefined>;
    notify(text: string, level: "info" | "warning"): void;
    isIdle(): boolean;
  };
  /** hub 确认通道可用（link ready ∧ hub caps ∋ sched.confirm.v1）。rpc 模式下为 true 则不弹本地框。 */
  hubConfirmReady(): boolean;
  publish(frame: Omit<SchedOffersFrame, "t">): void; // coordinator.offers
  notice(text: string, details: { kind: "confirm"; taskId: string; outcome: SchedOfferOutcome; by?: string }): void;
  revoke?(taskId: string): void;
  clock: Clock; // setTimer 均 unref（systemClock）
}
export interface ScheduleConfirm {
  /** 工具 create/update 成功且 pending 后调用；返回是否真的发起了确认（给工具结果文本用）。 */
  offer(task: ScheduleTask, origin: OfferOrigin): "offered" | "unavailable";
  /** 统一决定入口：TUI select、/schedule reject、sched_decide 都走这里。 */
  decide(req: {
    taskId: string;
    defHash: string;
    decision: "approve" | "reject";
    via: "tui" | "web" | "feishu";
    offerId?: string;
  }): Promise<DecideResult>;
  hasLiveOffer(taskId: string, defHash: string): boolean;
  /** 本地账本写入或轮询后调用；重新校验所有 offer。 */
  revalidate(): void;
  onUiPrompt(open: boolean, info?: { kind?: string; title?: string }): void;
  onInput(): void;
  onBeforeAgentStart(): void;
  onAgentSettled(): void;
  /** 重连：重发全量 offers。 */
  onHubCaps(): void;
  dispose(): void; // 关闭本地框队列，publish 全部 withdrawn，清 timer（**不** abort 已显示的框）
}
export type DecideResult =
  | { kind: "approved" }
  | { kind: "rejected"; removed: boolean }
  | { kind: "refused"; code: ScheduleErrorCode | "already-approved" | "offer-gone" | "expired"; detail: string };
```

**decide 规则**（三渠道一致）：

1. **同 offer 串行（r2）**：进入时同步查 `offer.deciding`；已有在途 promise 就直接复用（`feishu` 的重复 `reqId` 也走这里），保证一条 notice、一个 `closed.by`。不同 offer 之间由账本锁串行。
2. 过 `agent.gate()`，失败直接 refused（`E_SECURE`、`E_NOT_OWNER`、`E_DEGRADED`……）。
3. 校验 offer：`via:"feishu"` 与 `reject` 必须带活的 offer，且 `offerId`（有则比）和 `defHash` 都对得上，否则 `offer-gone`。`via:"tui"` 来自本地框，offer 必然在。web 的批准不经过这里（走现有 `/schedule approve`）。
4. `approve` ⇒ `approveTask(store, id, defHash, via === "tui" ? "tui" : "web")`（含新幂等守卫）；`reject` ⇒ `rejectTask(store, id, defHash, origin.base?)`。
5. CAS 结果映射：`changed` ⇒ approved/rejected；`refused E_REV` ⇒ `E_REV`；`E_INVALID "already-approved"` ⇒ `already-approved`。
6. 成功后：`agent.changed()`，把 offer 记为 `closed{outcome, by: via}`，publish，再发一条 notice。

**revalidate 规则**：读一次 `store.read()`，对每个 open offer 判断：任务缺失 ⇒ `withdrawn`；`isApproved` ⇒ `approved{by:"elsewhere"}`；`defHash ≠ offer.defHash` ⇒ `superseded`（若是本模块因新 offer 主动作废，offer() 里已先关掉）；过期 ⇒ `expired`。触发点：`agent.changed()` 的订阅；offer 存活期间每 15 s 的 unref timer（兜住他进程 `--all` 改账本）；`turn_start`；`agent_settled`。账本读不出来（`degraded`）时**不关闭** offer，等下一轮再判。

**offer 规则**：

- 前置条件：`agent.mode.kind === "interactive"`，`task` 未批准，`sessionId` 存在，否则返回 `unavailable`。
- 同一 `taskId` 已有活 offer 时：旧的记 `superseded`，新 offer **继承旧 offer 的 origin**（create 后再 update，拒绝仍删；approved→update→update，拒绝回到第一次改动之前）。
- 超过 `SCHED_CONFIRM_OFFERS_MAX` 时，挤出最旧的一个（记 `withdrawn`）。

**模型通知**：`pi.sendMessage({customType: SCHED_CUSTOM_TYPE, content, display:true, details:{kind:"confirm",…}}, {triggerTurn:false})`，照 digest 先例。内容一行，例如 `[schedule] 用户已通过飞书批准任务 s_x「日报」` / `… 已拒绝：任务已删除` / `… 已拒绝：已恢复到修改前的定义`。expired、withdrawn 不通知。`dispatch.ts` 的 `QUIET_KINDS` 必须加上 `"confirm"`。

#### 4.3 TUI 呈现（`TuiPresenter`，在 `confirm.ts` 内）

**r2 的关键修正**：pi 的嵌套对话框不发 `ui_prompt_*` 事件，「我的框是否仍被显示」**无法证明**；而任何 abort 都经 `onAbort → hideExtensionSelector()` 关掉**当前**那个框并让它 promise 悬挂（§11-2）。因此本地框的纪律从「可以礼让/自关」改为「**只做开框前判断，一旦打开就不接管收尾**」。

- **何时弹**：`ui !== undefined ∧ ui.hasUI`；`mode === "tui"`，或 `mode === "rpc" ∧ !hubConfirmReady()`（照搬 topic-switch：rpc 有远端就只用远端，避免双渲染）；print/json 不弹。
- **控件**：`ctx.ui.select` 三选项（拍板 Q1）：
  - 标题：`AI 新建了定时任务 s_x，请确认` / `AI 修改了定时任务 s_x（原批准已失效），请确认`
  - 正文：`taskDetail(task, occ)` 全量（含 prompt 与 hash 前 8 位）
  - 选项：`批准` / `拒绝（删除该任务）`｜`拒绝（恢复到修改前的定义）` / `稍后（保持待确认）`
- **CAS 顺序**同 `approveFlow`：弹框**之前**从 `store.read()` 取 task，要求 `defHash(task) === offer.defHash`，否则作废该 offer、不弹。选「批准」⇒ `decide({via:"tui", defHash: 采样值})`，锁内 CAS；`E_REV` ⇒ `notify("E_REV: 审阅期间任务定义已变更，未批准；请重新审阅")`（新的 offer 已在队列里）；`already-approved` ⇒ `notify("已在其他端批准")`。
- **开框纪律（只挡开框，不管收尾）**：
  1. 全局 FIFO，一次只开一个本地框。
  2. 只有同时满足才开：`ui.isIdle()`；自己维护的 ui-prompt 开放计数为 0（`onUiPrompt`，按 `(kind,title)` 配对、宁可多算）；**没有进行中的回合**（`agent_start` 之后还没 `agent_settled`）；最近 2 s 内没有 `input`。这四条都是为了不把框开在别的对话框前面（我们无法判断它已经存在）。
  3. **不传 pi 的 `timeout`**，也不自带 abort 定时器去关框（两者都会关错人）。
  4. 用户选「稍后」/Esc：只关自己的框（这是用户操作，安全），本地标记「已呈现」，不再自动重开，`notify("任务 s_x 仍待确认：/schedule approve s_x")`。
  5. 框开着无人值守：它最迟由 offer 的 TTL 结束（框里显示的是打开时的定义，此时点「批准」会得到 `E_REV` 或 `already-approved`，无副作用）。**残留**：开着的 `select` 会让调度消息派发一直等待（`dispatch` 把 UI 打开当栅栏），直到用户回来、或 `/schedule repair` / `/fabric fence reset` 清栅栏；后台 subagent 任务不受影响。
- **收回**：offer 关闭时，若本地框正开着：**不 abort**，只 `notify("任务 s_x 已在其他端批准 / 已作废")`；框内点「批准」会拿到 `already-approved` 或 `E_REV`。
- **rpc/无 UI**：rpc 有 UI（pi rpc-mode 建真 uiContext）——`hubConfirmReady()` 为真时 rpc 不弹本地框、交给 web/飞书，否则回落本地 select（与首条一致）；只有无 UI 的 print/json ⇒ `unavailable`。（r2 复审 minor 修正）

#### 4.4 其他 agent 侧改动

- `wire.ts`：`ScheduleAgent` 追加 `onChanged(fn): () => void`，`changed()` 时同步调用订阅者。
- `coordinator.ts`：`ScheduleCoordinator` 追加 `offers(frame)`（门控 `ready ∧ confirmCap`）和 `onDecide(frame)`。`onDecide` 照 `onRun`：sessionId 不符 ⇒ `E_NOT_OWNER`；过期 ⇒ `expired`；按 `reqId` 在途去重；回**恰好一个** ack。`ScheduleWebHubPort`/`ScheduleHubRouter` 追加 `onSchedDecide`，无会话 attach 时回 `refused E_NOT_OWNER`。`SchedHubLink` 追加 `confirmReady(): boolean`。
- `surface.ts`：`start(ctx, agent)` 构建 `ScheduleConfirm`（session 级 ctx 的 `ui`/`mode`/`hasUI`/`isIdle`），`teardown` 里 dispose。`pi.on("input"|"agent_start"|"agent_settled"|"before_agent_start"|"ui_prompt_start"|"ui_prompt_end")` 每次 activate 只注册一次，转发给当前 confirm。`ScheduleSurface` 追加 `confirm(): ScheduleConfirm | undefined`。
- `tools/schedule-tool.ts`：`ScheduleToolDeps.confirm?()`。create/update 成功且 `!isApproved` ⇒ `offer(...)`（update 先经 `onBase` 拿 base）。结果文本把 `PENDING_NOTE` 换成 `CONFIRM_NOTE`（"The user has been asked to confirm it now (terminal/web/Feishu). Do not ask them to run /schedule approve unless they say they dismissed it."），否则沿用原 `PENDING_NOTE`。`details.confirm: "offered" | "unavailable"`。**描述串不改。**
- `commands/schedule.ts`：新增 `reject <id> [<hash>]`，加入 `SUBS`、`FEISHU_REFUSED`、`USAGE`、补全列表。不带 hash ⇒ `ctx.ui.confirm` 展示「将删除 / 将恢复到修改前」（先采样 hash）；带 hash ⇒ 直接 decide。没有活 offer ⇒ `E_INVALID: 没有待确认的 AI 改动（可用 /schedule rm 删除）`；`--all` 拒绝。web 调用记 `via:"web"`。
- `web-hub/agent/command-policy.ts`：`reject` 规则与 approve 相同（`!all ∧ tokens.length===3 ∧ 64hex ⇒ allow`，否则 deny）。
- `web-hub/agent/connection.ts`：`case "sched_decide"` 加 live-link-only 分支；`index.ts` 接线 + `confirmReady` 门 + `hello.caps` 尾部追加 `SCHED_CONFIRM_CAP`（仅当 schedulePort 存在）。
- `src/index.ts`：仅组装，把 `confirm: () => scheduleSurface.confirm()` 传给 tool deps 和 command deps（I2）。

### 4.5 hub 侧

- `hub/hub.ts:541`：`config.schedule` 存在时 caps 尾部追加 `SCHED_CONFIRM_CAP`（两处 cap 表面同一 fold）。
- `hub/agent-server.ts:265`：白名单追加 `sched_offers`、`sched_decide_ack`。
- `hub/schedule/service.ts`：
  - `onAgentFrame` 改为按 `t` 穷尽 switch（**修掉现在 else 分支把一切都当 run_ack 的写法**）。
  - `offersBySid: Map<sid, {agentKey, open, closed, at}>`，只在内存。收到帧时校验 agentKey 的会话就是 `frame.sessionId`，不符丢弃并计数 `offers-sid-mismatch`。agent 断线后**保留**；投影只对在线会话出 `offer`。容量 ≤256 会话。
  - 投影：`projectPayload` 的 deps 追加 `offerOf(sid, taskId, defHash)`。
  - `port.offers()`：只列账本扫描结果里 `defHash(task) === offer.defHash` 的 offer，附完整 `ScheduleTaskDef`、`sessionLabel`、`online`。哈希暂时对不上（扫描落后于帧）时**不列出，也不当成关闭**。
  - `port.closedOffers(sid)`：本会话最近的 closed。
  - `port.decide(req)`：仿 `run`。视图唯一且在线、agent caps 含 confirm cap，否则 `offline/multi/refused no-cap`；发 `sched_decide`（`expiresAt = now + SCHED_DECIDE_TTL_MS`），等 ack 最多 `SCHED_DECIDE_ACK_WAIT_MS`，超时 `timeout`；dispose 时把等待者结算为 `unavailable`。
  - offers 变化（收到帧，或重扫后对应任务 defHash 变了）⇒ `delivery.offersChanged?.(sid)`。
- `hub/feishu/schedule.ts`（端口类型，C0 先落）：

```ts
export interface FeishuScheduleOfferRow {
  sessionId: string; sessionLabel: string; online: boolean;
  offerId: string; expiresAt: number; task: ScheduleTaskDef; defHash: string;
}
export interface FeishuScheduleOfferClosed { sessionId: string; offerId: string; outcome: SchedOfferOutcome; by?: string; }
export interface ScheduleDecideRequest { reqId: string; sessionId: string; offerId: string; taskId: string; defHash: string; decision: "approve" | "reject"; }
export type ScheduleDecideResult =
  | { kind: "approved" } | { kind: "rejected" } | { kind: "refused"; reason: string }
  | { kind: "offline" } | { kind: "multi" } | { kind: "timeout" } | { kind: "unavailable" };
// FeishuSchedulePort 追加（可选成员 ⇒ 旧实现照常编译）：
offers?(): readonly FeishuScheduleOfferRow[];
closedOffers?(sessionId: string): readonly FeishuScheduleOfferClosed[];
decide?(req: ScheduleDecideRequest): Promise<ScheduleDecideResult>;
// ScheduleDelivery（service.schedule）追加：
offersChanged?(sessionId: string): void;
```

- `hub/feishu/schedule-confirm.ts`（新，不依赖 pi，闭包状态，timer 注入）：

  **目标选择（fail-closed，r2 / §11-3）**：会话 `sessionId` 的 bindings 中，同时满足 ① `chatType === "p2p"`、② `offline === undefined`、③ 该 binding 的聊天对象**能证明**是 owner：`FeishuBinding` 本身没有 operator 字段，唯一证据是 `lastRequest(binding)?.senderOpenId`（p2p 里只有一位人类发送者），要求它**存在且逐字等于** `installation.ownerOpenId`；`lastRequest` 缺失（无请求记录 / 已过 24 h 元数据保留期）⇒ 视为未证明。**禁止**使用 `service.ts:796` 的 `?? ownerOpenId` 回退（它把「没有证据」当成「是 owner」）。实现上在 `schedule-confirm.ts` 注入独立的 `provenOwner(binding): boolean`，不复用 dialogs 的 `operator` 依赖。无法证明 ⇒ 不发卡、计数 `sched-confirm-no-owner`，绝不作「大概是 owner」的猜测。owner 还必须在 allow-list 里。群和话题**一律不发**。

  **身份与持久化**：卡片 id `fsc<feishuKey(sid:offerId:defHash:bindingKey)>`。每张卡持有 1 个 anchor nonce（`action:"sched-card"`，`target` 为 JSON `{sid,offerId,taskId,defHash,bindingKey}`，`expiresAt` = offer 的 expiresAt，从不渲染到卡面）+ 2 个按钮 nonce（`sched-ok`、`sched-no`，绑定 installGen/tenant/owner/chatId/messageId，`target` 含 anchor）。nonce 预算受 `FEISHU_CAPS.nonces - noncesReservedForOthers` 约束。

  **容量（r2 明确降级，§11-7）**：开放卡全局 16、每会话 4。第 5–8 个 offer **不发卡**，只在 web/TUI 呈现；卡槽空出后（前一张 settled），下一次 reconcile 按 `expiresAt` 升序补发剩余未决 offer（仍在 TTL 内、未 closed）。日志计数 `sched-confirm-card-cap`。

  **发送流程**（照 session-card）：先 `sendCard(id, target, 占位卡, lane)` 拿 messageId，再签发 anchor 与按钮 nonce，`commit()` 成功后才 PATCH 出按钮。commit 失败 ⇒ 卡片保持无按钮、「状态未知 — 在 web 查看」。

  **卡面**：schema 2.0；页头「定时任务待确认 · 会话名 · sid6」；正文含名称、`when`+tz、form、feishu、bg 全字段、完整 prompt（`neutralizeMarkdown` 后放入代码块）；末尾 hash 前 8 位、「在 web 中打开」链接、过期时间。`Buffer.byteLength(card) > 20_000` ⇒ **截断 prompt、加「完整内容见 web」、保留按钮**（拍板 Q4；hash 绑定全文，web 链接可审全文）。

  **回调**（经 service 分派）：nonce 赎回（一次性）后依次 `admission.callback(identity)`（安装代、租户、allow-list、`feishu:cb` 速率），再核对 `identity.senderOpenId === installation.ownerOpenId`（owner-only），anchor 仍在、`port.offers()` 里仍有 `(offerId, defHash)`，然后 `port.decide({reqId: feishuKey(eventId) 映射成 SCHED_REQ_ID_RE 形状, …})`。**同一张卡用 `inFlight` 集合串行**：第一击未落定前的第二击直接回「处理中，请稍候」，不排第二个 decide（§11-10）。
  - `approved` ⇒ PATCH「已通过飞书批准」，purge anchor 及其余按钮 nonce。
  - `rejected` ⇒ PATCH「已通过飞书拒绝（已删除 / 已恢复修改前定义）」。
  - `refused` 且 reason ∈ {`E_REV`, `offer-gone`} ⇒ 走 recall（新卡由 offersChanged 发出）。
  - `refused already-approved` / `refused E_REV`-之外 ⇒ **PATCH 前重读** `port.offers()/closedOffers()`：若该 offer 已 closed 且 `outcome:"approved"`（含本卡另一击）⇒ PATCH「已批准」；否则「已在其他端处理」。
  - `offline` / `timeout` / `unavailable` ⇒ PATCH「未确认是否生效，请在 web 或终端查看」，anchor 保留，后续 reconcile 推到终态。

  **reconcile(sid)**：
  - 对每个活 offer × 目标：没卡且槽位够 ⇒ 发。
  - 对每张 anchor 存在的卡，按序判断（**r2：不再看 reqId**）：
    1. `closed` 里存在 `offerId === anchor.offerId ∧ by === "feishu"` 的条目 ⇒ 本卡所赢 ⇒ 只 PATCH 终态，**不 recall**。
    2. `closed` 里存在 `offerId === anchor.offerId ∧ by !== "feishu"` ⇒ recall：先 `nonces.purge(anchor+按钮)` + `commit()`（这就是 recall 认领，对应 dialogs 的 `recall:"attempted"`），再 `deleteMessage`；失败只做一次中性 PATCH，按 outcome 说「已在其他端批准」「已在其他端拒绝」「定义已变更，本卡作废」或「已过期，请在终端 /schedule approve <id>」。
    3. `closed` 里存在该 offer 的 `withdrawn`/`expired`，且该会话 agent **已重新 attach 并确认过权威列表** ⇒ 按对应文案 recall。
    4. **`closed` 里没有该 offer，但 anchor 仍在**（典型：`decide` 落账后 agent `/reload`，新 stack 的 open 列表为空、closed 里也不再有它）⇒ **先对照账本**：`port.offers()` 所在投影里该 task 已 `approved` 且 hash 相同 ⇒ 中性 PATCH「已批准」；投影里任务已删除 ⇒ PATCH「任务已删除」；投影滞后/不可读 ⇒ 保留卡片，下一轮再判。**不得**凭「open 列表里没有」直接 recall（§11-6）。
    5. anchor 过期 ⇒ PATCH「已过期」。
  - agent 离线**不算**处理完毕：卡片保留，点击回「会话离线，未处理」，按钮 nonce 重签。
  - **触发点（r2 补齐，§11-8）**：`offersChanged(sid)`；60 s 扫描后对受影响会话；agent attach（`sched_offers` 到达）；**本会话新建 binding**；**binding 被移除/解绑**；**connector 重连成功**；**installation gen 变化**（`setup --replace` / allow-deny 撤销）；卡自身 settle；anchor 到期。重连队列上限 8 个会话，超出只做 attach 与 60 s 扫描那两次。

  **hub 重启**：anchor 在 nonce 表里持久存在，offers 在内存里没了 ⇒ 只在该会话 agent attach 并发来 `sched_offers` 之后，或 anchor 过期，或上面规则 4 的账本对照给出结论时，才关卡片。PATCH/DELETE 前不会把卡当作已处理。

- `hub/feishu/service.ts`：构建 `scheduleConfirm`（前提 `deps.schedule?.offers` 存在）。回调分派链追加 `record.action === "sched-ok" | "sched-no"`（旧 hub 不认识，静默忽略）。`offersChanged` 接到 `service.schedule`。把 binding 增删、connector 重连、installation gen 变化的 tap 传给 `scheduleConfirm.reconcile()`；注入 `provenOwner`（基于 `lastRequest`，无 fallback）。`service.ts` 与 `schedule-confirm.ts` 都归 F2。`dispose` 顺序遵守 `bot.stop()` 最先。

### 4.6 web 侧

- `logic/schedule.js`：新增 `rejectArgs(id, hash)`；`offerOf(proj)`。
- `SchedulePanel.vue`：新增 prop `initialReviewTaskId?: string`，挂载时直接切到 review 视图。
- `DetailHeader.vue`：`schedUsable ∧ 控制面可写` 时监视 `schedules` 槽里本会话带 `offer` 的任务；遇到本标签页没处理过的 `offerId`（sessionStorage 集合，上限 64）且 SchedulePanel 未开 ⇒ 打开并定位；多个时按最早到期。用户关闭后记「已呈现」。
- `ScheduleReview.vue`：`task.offer ∧ canWrite` ⇒ 多一个「拒绝」按钮，文案按任务状态区分（未批准过的 AI 新建：「拒绝（删除）」；其余：「拒绝（恢复修改前定义）」），发 `/schedule reject <id> <defHash>`（`useTrackedCommand`）。由 offer 打开的 review：offer 消失且任务已批准 ⇒ 提示「已在其他端批准」；任务消失 ⇒ 「任务已删除」。按钮随 `pendingApproval` 自动隐藏。
- i18n：`schedule-extra.ts` 追加中英文案；中文只用于多行散文提示，行内标记保持英文。

## 5. 关键决策

| #   | 决策                                                                                                                         | 理由 / 被拒的备选                                                                                                                                                                                   |
| --- | ---------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| D1  | **仲裁 = 账本 CAS + `approveTask` 锁内幂等守卫**，不引入跨进程竞速原语                                                       | 三个渠道分布在 agent、hub、浏览器、飞书，只有账本锁是全局串行点。`createDialogRace` 只能仲裁同进程回调。幂等守卫是「后到者 already-approved」语义的**唯一**落实点（§11-1）。                        |
| D2  | TUI 用 `ui.select` 三选项（批准 / 拒绝 / 稍后），仍走 approveTask CAS                                                        | 拍板 Q1。`ui.confirm` 只有两态，分不清「拒绝」与「稍后」。                                                                                                                                          |
| D3  | **拒绝 = 撤销 AI 未确认的改动**：create 链 ⇒ 删除；update 链 ⇒ 恢复改动前的执行定义（原批准随之自动生效）；**不恢复 `name`** | 拍板 Q2 + §11-5。「标记 rejected」要新增账本字段并改全线展示；「统一删除」会删掉用户批准过的长期任务；「保持 pending」让任务变僵尸。                                                                |
| D4  | 飞书批准记 `approval.via:"web"`                                                                                              | 拍板 Q3。`via` 联合类型被 reader 严格校验，加 `"feishu"` 会让降级端把新账本判 degraded。                                                                                                            |
| D5  | **不复用 ask_user dialog 通道**承载飞书 / web 确认                                                                           | dialog 通道会推所有 binding（含群话题），违反 owner-only + p2p；卡面只有题目+选项放不下完整定义；web 端也只是通用对话框，用不上 ScheduleReview。                                                    |
| D6  | 飞书审批走 `port.decide → sched_decide` 新帧，**F6 `admission.dispatch` op 白名单不变**                                      | 先例 `/schedule run` 走 `port.run → sched_run`。准入 = `admission.callback` + owner 校验。                                                                                                          |
| D7  | offer 只存内存，`/reload`/重启不补弹                                                                                         | 「当场」语义；账本不该放 UI 状态。遗留 pending 仍可 `/schedule approve` 或 web 审阅。                                                                                                               |
| D8  | 收回由 agent 的权威全量 `sched_offers{open,closed}` 驱动；**卡片归属只按 `(offerId, by)` 判**                                | 账本重扫与帧有时序差；`reqId` 没有持久化来源（§11-4），dialogs 的 open+closed 模式已经过验证。                                                                                                      |
| D9  | 飞书卡片只用 nonce 表持久化（anchor 模式），不新增 state 顶层键                                                              | `TOP_KEYS` 严格白名单（`state.ts:1313`），新增键会让降级 old hub 判 `state-corrupt`。session-card 先例。                                                                                            |
| D10 | 不新增设置项，随 `schedule.enabled`                                                                                          | 拍板 Q5。飞书侧另受 `feishuBot.enabled` 与 owner p2p 绑定约束。                                                                                                                                     |
| D11 | 工具描述串不改，只改结果文本                                                                                                 | 保住 prompt-cache 前缀；结果文本本就是动态的。                                                                                                                                                      |
| D12 | TUI 框**不自 abort**（无超时、无礼让关闭），只保留开框前判断                                                                 | pi 的嵌套对话框不发 `ui_prompt_*`，被顶掉（promise 悬挂、不再显示）无法与「还开着」区分；此时 abort 会经 `hideExtensionSelector()` 关掉别人的框。宁可泄漏（已悬挂的）promise，也不关错人（§11-2）。 |

## 6. 状态机与不变式

offer 状态（agent 内存）：

```
open(+deciding?) ──decide(approve/reject) 成功──► closed{approved|rejected, by:tui|web|feishu}
open ──revalidate: 已批准────────────────────► closed{approved, by:elsewhere}
open ──新 offer 同 taskId / 哈希变──────────► closed{superseded}
open ──任务消失 / 挤出 / dispose────────────► closed{withdrawn}
open ──now ≥ expiresAt──────────────────────► closed{expired}
closed ── 120 s 后从 closed 回显移除
```

TUI 子状态：`queued → showing → answered | dismissed(稍后/Esc) | presented`（**没有** `yielded`、**没有** 定时自关）。

不变式：

- **S1 必须人确认**：只有 `decide` 与现有 `/schedule approve` 会写 `approval`，触发源只有人操作（TUI 选择、web 点击、飞书 owner 点击）。`schedule` 工具不增加任何 action。
- **S2 哈希绑定**：所有批准都在锁内比较「审阅时采样的 hash」与当前 `defHash`；飞书多一道 hub 侧校验（渲染时 `defHash(扫描 task) === offer.defHash`）与 agent 侧校验（offer 活着且哈希一致）。
- **S3 恰好一次**：每个未过期的 `sched_decide` 恰好一个 ack（含无会话 attach）；每个 offer 至多一次 `decide` 落账（`deciding` 位 + 锁内 `isApproved` 幂等守卫 + 每条 notice 一次）。
- **S4 有界**：offer ≤2 h；decide 等待 ≤10 s（飞书侧再包 `bounded` 12 s）；所有 timer 经注入 clock 且 unref（I1、I5）。TUI 框本身**不再有**自关期限（见 D12），其占用时长由 offer TTL 与用户操作界定。
- **S5 关闭态**：schedule 关闭时以上模块都不构造、不注册新事件钩子，无新 cap，`HubConfig.schedule` 不存在 ⇒ `schedule-off-golden.json` 不变（I9）。secure/child 下模式矩阵已拒绝 create，自然无 offer（I11）。
- **S6 fail-closed**：任何「无法证明」的分支都不推进安全动作 —— 飞书端无法证明 owner ⇒ 不发卡；hub 无法证明某个 offer 已 closed ⇒ 不 recall，只 PATCH 或等待；TUI 无法证明框属己 ⇒ 不 abort。

## 7. 实施拆包（文件域 · 共享热点 · 串行顺序）

| 包                    | 文件域                                                                                                                                                                                                                                                                                                                                                                                                     | 依赖                        | 备注                                         |
| --------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------- | -------------------------------------------- |
| **C0 协议与端口类型** | `web-hub/protocol/schedule.ts`🔥、`web-hub/protocol/messages.ts`🔥、`web-hub/hub/feishu/schedule.ts`（**只动类型**）、`web-hub/agent/command-policy.ts`（reject 一行）、`tests/web-hub/protocol/*`                                                                                                                                                                                                         | —                           | 最先合入；之后其他包不再碰这两个协议文件     |
| **C1 agent 核心**     | `schedule/core/claim.ts`（`approveTask` 幂等守卫 + `rejectTask` + 并发同 hash 新用例）、`schedule/agent/ops.ts`（`onBase` + 共用 revoke helper）、**新** `schedule/agent/confirm.ts`、`schedule/agent/surface.ts`、`schedule/agent/wire.ts`（`onChanged`）、`schedule/agent/dispatch.ts`🔥（`QUIET_KINDS` 一行）、`tools/schedule-tool.ts`、`commands/schedule.ts`、`src/index.ts`🔥（只组装）、对应 tests | C0                          | `src/index.ts`、`dispatch.ts` 只允许最小改动 |
| **C2 agent↔hub 链路** | `schedule/agent/coordinator.ts`、`web-hub/agent/connection.ts`、`web-hub/agent/index.ts`🔥（cap + binding）、`tests/schedule/agent/{coordinator,webhub-wiring}.test.ts`                                                                                                                                                                                                                                    | C0、C1                      | 可对着 C1 接口桩先开工                       |
| **H2 hub 协调**       | `web-hub/hub/schedule/{service,project,feishu-port}.ts`、`web-hub/hub/agent-server.ts`、`web-hub/hub/hub.ts`（cap）、`tests/web-hub/hub/schedule-service.test.ts`                                                                                                                                                                                                                                          | C0                          | 可与 C1 并行                                 |
| **F2 飞书卡片**       | **新** `web-hub/hub/feishu/schedule-confirm.ts`、`web-hub/hub/feishu/service.ts`🔥（组装 + 回调分派 + reconcile 触发点 tap）、新测试 `tests/web-hub/hub/feishu/schedule-confirm.test.ts`                                                                                                                                                                                                                   | C0（端口类型）；联调依赖 H2 | `service.ts` 只由本包修改                    |
| **W2 web UI**         | `ui/src/components/schedule/{SchedulePanel,ScheduleReview}.vue`、`ui/src/components/detail/DetailHeader.vue`、`ui/src/logic/schedule.js`、`ui/src/i18n/schedule-extra.ts`、`tests/web-hub/ui/schedule-*.test.ts`                                                                                                                                                                                           | C0（投影类型）              | 可与 C1、H2 并行；`check:web` 要过           |
| **I2 集成与文档**     | `tests/integration/schedule-hub.test.ts`（或新建 `schedule-confirm.test.ts`）、`tests/integration/web-hub-feishu-bot.test.ts` 新 block、`docs/dev/scheduled-reports/README.md`、`docs/dev/feishu-bot/README.md`（命令表与安全模型各补一行）                                                                                                                                                                | 全部                        | 最后做                                       |

串行顺序：**C0 → {C1 ∥ H2 ∥ W2} → C2 → F2 → I2**。F2 可在 C0 后对着端口桩先写单测。热点文件（🔥）各归一个包：两个协议文件归 C0，`src/index.ts` 与 `dispatch.ts` 归 C1，`web-hub/agent/index.ts` 归 C2，`feishu/service.ts` 归 F2。并行时用 worktree 隔离。

## 8. 测试清单

**单元（core / agent）**

1. `approveTask` 幂等（r2）：同 hash 连续 `approveTask` 两次 ⇒ 第一次 `changed`，第二次 `refused E_INVALID "already-approved"`；两条并发 `Promise.all` 同 hash ⇒ 恰好一个 `changed`，另一个 `already-approved`，账本里 `approval` 只写一次。（无旧断言需改，见复审 nit。）
2. `rejectTask`：create 链删除；update 链恢复（原批准自动重新生效，`isExecutable` 为真）；**回滚后 `name` 仍是用户手工改的名字**（r2 / §11-5）；`E_REV`；`already-approved`；任务不存在；删除后 revoke 与 `dropQueuedRuns` 都被调用；回滚触发 `voidUntil`，不补跑。
3. `confirm.offer`：同一 taskId 连续 update 时 origin 继承（create→update→reject ⇒ 删除；approved→update→update→reject ⇒ 回到第一次改动之前）；挤出第 9 个；非交互模式 `unavailable`。
4. `decide` 竞态：同 offer 并发两次（tui + sched_decide）⇒ 复用同一 promise，**只有一条 notice、一个 `closed.by`**；不同 offer 并发由锁串行化，后到者 `already-approved`；同一 reqId 重复只执行一次；`E_REV`（采样之后 AI update 了）；offer 过期 ⇒ `offer-gone`/`expired`；`gate()` 返回 E_SECURE/E_NOT_OWNER 时拒绝。
5. revalidate：web `/schedule approve` 之后 offer 关闭为 `approved/elsewhere`；他进程 `--all` 改账本后 15 s 轮询能发现；账本 degraded 时 offer 不关。
6. TUI 呈现（fake ui）：回合中不弹，`agent_settled` + 空闲 + 2 s 无 input 才弹；有外部 ui prompt 计数时不开；选「稍后」/Esc 后不重开；**`select` 调用从不带 `timeout`，且从不持有会被我们自己 abort 的 signal**；rpc 模式且 `hubConfirmReady` 时不弹；`!hasUI` 时不弹。
7. 收回（r2）：offer 被 supersede / 在别处批准时，本地框**不被 abort**，只 notify；之后在框里选「批准」得到 `already-approved` 或 `E_REV`；`dispose()` 不 abort 已显示的框，publish 全量 withdrawn。
8. notice：`details.kind==="confirm"`；`readScheduleTrigger` 归为 `quiet`，孤儿守卫不中止它。
9. 工具：create/update 的结果文本与 `details.confirm`；**`SCHEDULE_TOOL_DESCRIPTION` 字节不变**（断言）。
10. 命令：`/schedule reject` 有无 hash 两种形式；飞书调用被拒；`--all` 被拒；没有 offer 时的文案。policy：`reject <id> <hash>` allow，`reject <id>`/`--all` deny（parity 测试）。

**协议 / 链路**

11. 新帧 schema 拒绝多余键、超长数组、坏 hash；`decodeHubFrame` 对旧 agent 未知帧返回 undefined。
12. coordinator：无 confirm cap 时不发 `sched_offers`；`onHubCaps` 必发全量（空列表也发）；`onDecide` 恰好一个 ack（覆盖 sessionId 不符、过期、无会话 attach）。
13. hub：`onAgentFrame` 穷尽分派（`sched_offers` 不被误当 run_ack，防回归）；offer 的 sid 与 agentKey 会话不符时丢弃；投影仅在在线 ∧ 哈希一致时出现 `offer`；扫描落后不列出也不关闭；`decide` 覆盖 offline/multi/no-cap/timeout，dispose 结算为 unavailable。
14. 兼容矩阵：旧 hub（无 confirm cap）× 新 agent ⇒ TUI-only、零新帧；新 hub × 旧 agent ⇒ 不发卡、不发 sched_decide、投影无 offer；schedule 关闭时 hub caps 与 `HubConfig` 字节不变。

**飞书**

15. 目标选择：只发 p2p ∧ 在线 ∧ **可证明 owner** 的 binding；群/话题/非 owner 的 allow-list 用户/离线 binding 都不发；**`lastRequest` 为第三方 open_id 的 binding 不发卡，`lastRequest` 缺失的 binding 也不发卡**（r2 fail-closed 回归，§11-3）。
16. 回调：非 owner 点击被拒；nonce 一次性；anchor 被 purge 后点击「已失效」；E_RATE；tenant/安装代变化被拒。
17. 竞速收回：TUI 先批 ⇒ recall（DELETE 成功）；DELETE 失败 ⇒ 只做一次中性 PATCH，不重试；**本卡所赢（`closed(offerId,by:"feishu")`）⇒ 保留并 PATCH「已通过飞书批准」，hub 重启后重放同样结论、不误 recall**（r2 / §11-4）；update 作废 ⇒ 旧卡 recall、新卡发出；过期 ⇒「已过期」。
18. 持久化与重启：anchor 在 commit 之前崩溃，重启后无按钮、不会误批；hub 重启后在 agent 权威列表到达前不关卡；列表到达且缺失 + 账本确认已批准 ⇒ PATCH「已批准」而非「已撤回」（r2 / §11-6）；列表缺失 + 账本已删 ⇒ 「任务已删除」；列表缺失 + 账本不可读 ⇒ 保留卡片等下一轮。
19. 离线：agent 离线时点击回「会话离线」并重签按钮；agent 回来且 offer 仍在 ⇒ 卡可用；agent 回来且 offer 已没（reload）⇒ 按测试 18 的账本对照分流。
20. 容量与补发（r2 / §11-7）：同会话 6 个 offer ⇒ 只发 4 张卡（按 `expiresAt` 升序）；第 5、6 个只 web/TUI；一张 settled 后 reconcile 在 TTL 内补发下一张；全局 16 张上限；nonce 预留不被侵占。
21. reconcile 触发点（r2 / §11-8）：新 binding、binding 移除、connector 重连、installation gen 变化、agent attach、60 s 扫描各触发一次，且不重复发卡（幂等）。
22. 双按钮连击（r2 / §11-10）：同一卡两次快速点击 ⇒ 第二次回「处理中」，只产生一次 decide；两击落在 decide 落定前后 ⇒ 后到者 PATCH 前重读最新结果，措辞不误导（不会把已批准说成「已在其他端处理」）。
23. 超长：8 KiB 全 CJK prompt 的卡片 ≤20000 B；超限截断 + 提示 + **保留按钮**（拍板 Q4）。

**web**

24. DetailHeader：新 offerId 自动打开并定位；同一 offerId 不重复弹（sessionStorage）；不可写/离线不弹。
25. ScheduleReview：带 offer 时出现「拒绝」，发出 `reject <id> <hash>`；`E_REV` 提示；offer 消失后显示「已在其他端批准 / 已删除」。

**集成（真 hub 子进程 × fake pi × fake 飞书）**

26. 端到端三渠道各赢一次（TUI、web 命令、飞书回调），断言其余两端都收回，账本里恰好一次 approval（旧实现的重复 approval 会让此断言失败 —— 回归守卫）。
27. 「create → update → 飞书点旧卡」：旧卡失效、新卡发出、旧 hash 永远批不进去。
28. `/reload` 中途：offer 被撤回（TUI 侧），飞书卡按账本对照落到「已批准 / 已删除 / 保留」之一，任务状态与卡片一致。
29. 门禁：`schedule-off-golden` 与其他 A 级 fixtures 不变（`git diff --quiet origin/dev -- tests/fixtures/`）；`npm run test:conformance` 的 schedule C-S1…C-S8（确认 `QUIET_KINDS` 与 ui_prompt 计数没破坏派发授权）。

## 9. 风险与残留

- **R1 pi 共用对话框槽（最大风险，r2 重写）**：pi 的扩展对话框共用编辑器槽，后开的直接覆盖前一个，前一个的 promise **永不 resolve**；而嵌套对话框在 depth≥1 时**不发** `ui_prompt_*`（`runner.js:368`），`interactive-mode.js:2153` 的 abort/timeout 收尾调用 `hideExtensionSelector()` 关的是**当前**那个框。结论：**「我的框是否仍在显示」不可证**。本方案因此只做开框前纪律（空闲 + 无回合 + 无最近 input + 计数为 0），一旦打开就不再由我们关闭（不自带超时、不礼让 abort）；被顶掉时**接受 promise 泄漏**（pi 的 `uiPromptDepth` 不复位、后续 ui_prompt 事件消失、dispatch 栅栏多算 —— 用 `/schedule repair` / `/fabric fence reset` 清），因为我们无法在不误伤别人的前提下收尾。根治需要 pi 给对话框加 id 或支持排队，建议到上游提 issue。ask_user 的 `queue.ts` 也只解决了它自己内部的串行。
- **R2 回滚基线只在内存**：`/reload` 之后不能「拒绝即回滚」。用户仍可 `/schedule rm` 或手工 edit 后 approve。
- **R3 跨进程改账本**（另一 TUI 用 `--all approve`）：最长 15 s 后才收回；期间点击由 `already-approved` 兜底。
- **R4 飞书 recall 认领与 DELETE 之间崩溃**：会留下原卡片，但按钮 nonce 已 purge，点了无效（与 ask_user 同级残留）。
- **R5 飞书记 `via:"web"`**：`/schedule show` 看不出批准来自飞书，只有会话 notice 与卡片本身能说明。
- **R6 web 多标签页**都会自动弹出，任一处理后其余页面显示「已在其他端处理」。
- **R7 卡面截断**：飞书用户批准时可能没看到全文（hash 绑定全文、web 链接可看全文）。
- **R8 卡槽不足**：第 5–8 个 offer 在飞书上静默（只 web/TUI），日志计数 `sched-confirm-card-cap`；用户可能只在 web 端看到。
- **R9 TUI 框长期占用**：无人值守的开框会让调度消息派发一直等待（后台 subagent 不受影响），直到用户回来或清栅栏。这是 D12 的代价，已在 §4.3 写明。
- **R10 双按钮连击**：已用 `inFlight` + PATCH 前重读把误措辞压到最低；两击落在同一 decide 落定前后的极端窗口仍可能多一次 PATCH（幂等文案，无副作用）。
- **R12 owner 证明依赖请求记录**：owner 的 p2p 绑定如果超过 24 h 没有发过请求（终结请求元数据已过保留期），`provenOwner` 判定为未证明，就收不到卡片（fail-closed 的代价）；在该私聊里发任意一条消息即可恢复。以后如果给 `FeishuBinding` 增加持久的 operator 字段，可以去掉这条残留（state schema 变更另立方案）。
- **R11 文案语言**：卡片与 TUI 用中文散文；行内状态标记保持英文 token。
- 更新运行中的系统需 `/reload` 再 `/webhub restart`。只升级 agent 时退化为 TUI-only，属设计内行为。

## 10. 已拍板（2026-10-26）

- Q1：TUI 用三选项 select（批准 / 拒绝 / 稍后），同一 CAS 路径。
- Q2：拒绝 = 撤销 AI 未确认的改动（拒绝新建 ⇒ 删除；拒绝修改 ⇒ 恢复修改前定义，原批准自动重新生效）。
- Q3：飞书批准记 via:"web"。
- Q4：飞书卡片超 20 KB ⇒ 截断 prompt、注明完整内容见 web、保留按钮（哈希绑定全文）。
- Q5：不新增开关，跟随 schedule.enabled。
- 可调常量（不需再拍板，有异议再改）：offer TTL 2 h、开框前静默 2 s、offer 上限 8、飞书开放卡全局 16 / 每会话 4、closed 回显 8 条 / 保留 120 s。

## 11. r2 修订对照表（逐条回应评审）

| #   | 级别  | 评审意见                                                                                                                                                                                                    | r2 处理                                                                                                                                                                                                                                                                                                                                                | 落点                                                                            |
| --- | ----- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------- |
| 1   | major | `approveTask` 只 CAS `defHash`、不查 `isApproved`，两渠道并发同 hash 都成功（双 notice、`closed.by` 被覆盖、飞书「本卡所赢」误判），与「后到者 already-approved」矛盾，测试 #3 必挂                         | **双层修复**：① `approveTask` 锁内首行 `if (isApproved(task)) return { refuse: "E_INVALID", detail: "already-approved" }`（唯一落实点，覆盖 TUI/web/飞书/`--all`）；② `decide` 入口同步置 `offer.deciding` 并复用同一 promise，保证单个 offer 只产生一条 notice、一次 `closed.by` 写入。同步改 `claim.test.ts:471` 旧断言，并新增并发同 hash 用例      | §2 表、§3.1 仲裁、§3.3、§4.2 `claim.ts`①/`decide` 规则 1、§5 D1、§8 测试 1/4/26 |
| 2   | major | 「计数证明我们仍是唯一框」在 R1 场景不成立：嵌套对话框 depth≥1 不发 `ui_prompt`，被顶掉后计数仍显示我们的框开着；此时自关/礼让 abort 会经 `onAbort→hideExtensionSelector()` 关掉别人的框并使其 promise 悬挂 | 撤回「计数证明所有权」这一前提。改为**只做开框前判断**（空闲 + 无进行中回合 + 2 s 无 input + 计数 0），打开后**不自带超时、不礼让 abort**；offer 关闭时只 notify 不 abort；明确写「无法证明所有权时宁可泄漏 promise 也不 abort」。新增 §5 D12、§6 S6，并重写 R1                                                                                        | §4.3 全节、§6 S4/S6、§5 D12、§9 R1/R9、§8 测试 6/7                              |
| 3   | major | `operator(binding)` 现有实现 fail-open（`lastRequest(binding)?.senderOpenId ?? ownerOpenId`），非 owner 的 p2p 绑定会收到含完整 prompt 的卡                                                                 | 定时审批卡**不复用**该 fallback：注入独立 `provenOwner(binding)`，只认 `lastRequest(binding)?.senderOpenId` 存在且与 `installation.ownerOpenId` **逐字相等**的 p2p binding（无请求记录 ⇒ 未证明）；无法证明 ⇒ 不发卡 + 计数 `sched-confirm-no-owner`（fail-closed）。新增 §6 S6 与测试 15 回归用例（`lastRequest` 是第三方 open_id 的 binding 不发卡） | §2 表（`service.ts:796`）、§4.5 目标选择、§6 S6、§8 测试 15、§9 R12             |
| 4   | major | 「reqId ∈ 本卡 reqIds」无持久化来源，hub 重启后会误 recall 本卡批准过的卡片                                                                                                                                 | 删掉 `reqId` 匹配：`SchedOfferClosedWire` 去掉 `reqId`，reconcile 规则 1 改为 `closed` 中存在 `offerId === anchor.offerId ∧ by === "feishu"`；`reqId` 仅保留在 `sched_decide`/`ack` 作 agent 侧去重键                                                                                                                                                  | §4.1 协议、§4.5 reconcile 规则 1/2、§5 D8、§8 测试 17                           |
| 5   | minor | `defHash` 不含 `name`，reject 回滚会冲掉用户手工改名                                                                                                                                                        | `rejectTask` 的 `revertTo` 类型与回滚实现只含 `form/when/prompt/feishu/bg`，**不碰 `name`**；§2 表与 §5 D3 写明理由；测试 2 加断言                                                                                                                                                                                                                     | §2 表（`spec.ts:318`）、§4.2 `rejectTask`、§5 D3、§8 测试 2                     |
| 6   | minor | decide 落账后 agent `/reload` ⇒ 卡片误显「已撤回」                                                                                                                                                          | reconcile 新增规则 4：`closed` 里没有该 offer 时**先对照账本投影** —— 已批准且 hash 相同 ⇒ 中性 PATCH「已批准」；任务已删 ⇒ 「任务已删除」；投影滞后/不可读 ⇒ 保留卡片下一轮再判；**禁止**凭「open 列表没有」直接 recall                                                                                                                               | §4.5 reconcile 规则 4、§9 R1 邻域、§8 测试 18/19/28                             |
| 7   | minor | offer 上限 8/会话 vs 飞书卡 4/会话：第 5–8 个行为未定义                                                                                                                                                     | 明确降级：第 5–8 个**不发卡**（只 web/TUI），卡槽空出后下一次 reconcile 按 `expiresAt` 升序在 TTL 内补发；计数 `sched-confirm-card-cap`；写入残留 R8；测试 20                                                                                                                                                                                          | §4.5 容量、§9 R8、§8 测试 20、§10 常量                                          |
| 8   | minor | reconcile 触发点补齐：bot 重连、新 binding、installation gen 变更                                                                                                                                           | 触发点清单补全为 9 条：`offersChanged`、60 s 扫描、agent attach、新 binding、binding 移除/解绑、connector 重连、installation gen 变化、卡自身 settle、anchor 到期；重连队列上限 8 会话（超出只依赖 attach 与扫描）；`service.ts` 提供 tap                                                                                                              | §4.5 触发点、§7 F2 备注、§8 测试 21                                             |
| 9   | nit   | 文件名/行号小偏差：`src/web-hub/ui/src/logic/schedule.js`；`state.ts` 的 `TOP_KEYS` 在 `:1313`                                                                                                              | 全文改为 `logic/schedule.js`；`state.ts:1313` 为 `onlyKeys(doc, TOP_KEYS)` 行；`service.ts:796` 的 `operator` 行也核对过                                                                                                                                                                                                                               | §2 表两行、§5 D9、§4.6、§7 W2                                                   |
| 10  | nit   | 双按钮连击时后到者的 PATCH 措辞误导                                                                                                                                                                         | 每卡 `inFlight` 串行：第一击未落定前第二击回「处理中，请稍候」，不排第二个 decide；后到者 PATCH 前**重读** `offers()/closedOffers()` 的最新结论再定文案（已批准不说成「已在其他端处理」）；写为残留 R10                                                                                                                                                | §4.5 回调段、§9 R10、§8 测试 22                                                 |

测试与拆包同步：§8 增补 1/2/7/15/17/18/20/21/22/26/28 的 r2 断言，§7 的 C1 显式含 `claim.test.ts:471` 断言更新、F2 显式含 reconcile 触发点 tap。
