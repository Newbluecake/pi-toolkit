# #61 C1 包报告：agent 核心

## 结论

C1 完成：账本仲裁（`approveTask` 幂等 + `rejectTask`）、`confirm.ts`（offer 注册表 / decide / revalidate / TUI 呈现）、工具与 `/schedule reject` 接线均已落地并通过自验。
**一处需要你拍板的 B 档 golden 变化**（见「阻塞 / 需说明」）：`tests/fixtures/governance/activate-trace.json` 在「schedule 开启」画像下 `count 232→236`（+4 个 `on(...)`），schedule 关闭画像不变。按指令**没有**改该 fixture，`tests/governance/activate-trace.test.ts` 因此当前为红。

## 改动

- `src/schedule/core/claim.ts`：`approveTask` 锁内先查 `isApproved ⇒ refuse E_INVALID "already-approved"`（r2 #1，三渠道 / `--all` 唯一落实点）；新增 `rejectTask(store, id, hash, revertTo?)`（无 revertTo ⇒ 同一事务 `removeTask`；有 ⇒ `changeTask` 恢复 `form/when/prompt/feishu/bg`，不动 `name`、不动 `approval`，r2 #5）及 `RejectRevertTo` 类型。
- `src/schedule/agent/ops.ts`：`UpdateOpts.onBase`（锁内、校验之后、改写之前给一份 structuredClone，抛错被吞）；导出 `dropQueuedRuns`（reject 删除分支共用，I1 撤销）。
- `src/schedule/agent/confirm.ts`（新）：`createScheduleConfirm`。offer 注册表（≤8、TTL 2 h、同 task 同 hash 不重复问、不同 hash ⇒ superseded 且继承旧 origin）、`decide`（同 offer 复用 `deciding` promise ⇒ 一条 notice、一个 `closed.by`，r2 #1；feishu/reject 必须有活 offer，本地 approve 可无 offer 直走 CAS；`gate()`、过期、E_REV/already-approved 映射）、`revalidate`（缺失 withdrawn / hash 变 superseded / 已批准 approved·elsewhere / 过期；账本 degraded 不关；15 s unref 轮询；`agent.onChanged` 同步触发）、TUI 呈现（见下）、`dispose`（全部 withdrawn + 发布 + 清 timer，不动已显示的框）。
- `src/schedule/agent/wire.ts`：`ScheduleAgent.onChanged(fn): () => void`，挂在内部 `changed()` 上（含 clock/executor 的写入），监听器抛错只 warn，`dispose` 清空。
- `src/schedule/agent/surface.ts`：`start()` 在交互会话里构建 confirm（`ui` 来自 session ctx：`select(title, options)` 只两个参数、`notify`、`isIdle`；`notice` ⇒ `pi.sendMessage({customType: SCHED_CUSTOM_TYPE, details:{kind:"confirm",…}}, {triggerTurn:false})`）；`teardown` 里 dispose；新增每次 activate 注册一次的转发钩子 `input`（忽略 `source:"extension"`，返回 `{action:"continue"}`）、`before_agent_start`、`ui_prompt_start/end`，`agent_settled` 现有钩子里追加转发；`ScheduleSurface.confirm()`。
- `src/schedule/agent/dispatch.ts`：`QUIET_KINDS` 加 `"confirm"`（仅此一行）。
- `src/tools/schedule-tool.ts`：`ScheduleToolDeps.confirm?()`；create/update 成功且 `!isApproved` ⇒ `offer(...)`（update 经 `onBase` 带回滚基线 + `wasApproved`）；offered 时结果文本换 `CONFIRM_NOTE`，`details.confirm: "offered"|"unavailable"`（无 confirm 依赖时与旧结果逐字相同、无 `confirm` 键）。**`SCHEDULE_TOOL_DESCRIPTION`、`promptGuidelines` 未动。**
- `src/commands/schedule.ts`：`reject <id> [<hash>]`（加入 SUBS / FEISHU_REFUSED / USAGE / 头注释）。无 hash ⇒ 先从 live offer 取 hash，`ctx.ui.confirm` 说明「将删除 / 将恢复」；带 hash 必须等于 live offer 的 hash 否则 E_REV；无活 offer ⇒ `E_INVALID: 没有待确认的 AI 改动（可用 /schedule rm 删除）`；`--all`、坏 hash、飞书调用均拒绝；web 记 `via:"web"`。`approveFlow` 对 `already-approved` 给友好文案。`ScheduleCommandDeps.confirm?()`。
- `src/index.ts`：仅两行，把 `confirm: () => scheduleSurface.confirm()` 传给 tool/command deps。

## TUI 呈现纪律（r2 §4.3 / D12）

- `ui.select(title, [批准, 拒绝（删除该任务｜恢复到修改前的定义）, 稍后（保持待确认）])`，**恰好两个参数**——不带 pi `timeout`、不带 abort signal；offer 关闭时只 `notify`，不 abort；`dispose` 不 abort。
- 只在开框前判断：`isIdle()` ∧ 无外部 ui-prompt（`onUiPrompt` 计数，我们自己框的标题忽略，未配对的 end 不减）∧ 无进行中回合（`before_agent_start`→`agent_settled`）∧ 最近 2 s 无 input；不满足就等事件或 3 s 轮询（offer 全部关闭后停）。全局 FIFO，一次一个；「稍后」/Esc 不再重开。
- 开框前从账本重读并要求 `defHash(task)===offer.defHash`；点「批准」走同一 CAS（`E_REV` ⇒ 提示重审，`already-approved` ⇒ 「已在其他入口批准」）。
- rpc：`hubConfirmReady()` 为真则不弹；否则回落本地 select；`!hasUI` 不弹。

## 与计划的差异 / 实施中发现

1. **`updateTask` 自身的 `agent.changed()` 会先于工具的 `offer()` 触发 revalidate，把旧 offer 关成 superseded**，计划里「offer() 里先关掉并继承 origin」因此对真实工具流不成立。处理：被 superseded 关闭的 offer 把 origin 记入 60 s 的 `chains` 表（≤8 条），紧随其后的 `offer()` 继承；超过宽限或遇到任何终态（approved/rejected/withdrawn/expired）即清除。测试 `a superseded chain is only inherited within the grace window` / `…FIRST origin` 覆盖。
2. `SCHED_MAX_TASKS_PER_SESSION = 8 = SCHED_CONFIRM_OFFERS_MAX`，所以「挤出第 9 个」经真实账本不可达，仅作防御；测试用合成 task id 驱动注册表。
3. 本地 approve（TUI）在没有 offer 时仍可直走 CAS（等价 `/schedule approve`），feishu / reject 必须有活 offer——与计划 decide 规则 3 一致，只是把「无 offer 的本地批准」显式化。
4. 被 refused 的 decide（如 `already-approved`）结束后立即 `revalidate()`，所以账本已批准的 offer 会被关成 `approved/elsewhere` 并发出一条 notice（计划没写这一点，属自然结果）。
5. AI 对**本来就 pending 且无活 offer** 的任务 update（例如 reload 之后）：offer 的回滚基线是「改动前的 pending 定义」，拒绝等于撤销这次改动、任务仍 pending（`wasApproved:false` 时标题不再写「原批准已失效」）。

## C2 衔接点（coordinator.ts / web-hub/agent 不在 C1 域，未碰）

surface 以**结构化可选成员**读取 `agent.coordinator`（`NULL_SCHEDULE_COORDINATOR` 与 pre-C2 coordinator 两者皆无 ⇒ 天然 TUI-only、零新帧）：

- `offers?(frame: Omit<SchedOffersFrame,"t">): void` — confirm 的 `publish`；C2 补门控 `ready ∧ confirmCap` 并补 `t:"sched_offers"`。
- `confirmReady?(): boolean` — confirm 的 `hubConfirmReady`（`link.ready() ∧ caps ∋ SCHED_CONFIRM_CAP`）。
- C2 还需：`onDecide(frame)` → `scheduleSurface.confirm()?.decide({ taskId, defHash, decision, via:"feishu", offerId })`，结果映射 ack（`approved|rejected|refused` + reason=`code`）；`onHubCaps()` 里调 `confirm?.onHubCaps()`（重发全量，空列表也发）。coordinator 拿 confirm 需要晚绑定入口（建议 `HubCoordinatorDeps` 加 `confirm?: () => ScheduleConfirm | undefined`，由 `createAgent`/index 组装）。
- 接口（`ScheduleConfirm.decide/onHubCaps/liveOffer`、`DecideResult`）见 `src/schedule/agent/confirm.ts`。

## 阻塞 / 需说明

**activate-trace golden（B 档）**：schedule 开启画像下新增 4 个 `on(...)` 注册——`on(input)`、`on(before_agent_start)`、`on(ui_prompt_start)`、`on(ui_prompt_end)`（计划 §4.4 要求 surface 注册的转发钩子；message scheduler 已有同名钩子，但属另一模块，不复用）。其余 profile（含 schedule 关闭）逐字不变。已用「备份 → `PI_TOOLKIT_UPDATE_TRACE=1` 生成 diff → 原样 cp 回」确认差异仅此一处，fixture 已还原（`git diff --quiet HEAD -- tests/fixtures/` 为干净）。
需要你声明性刷新：`PI_TOOLKIT_UPDATE_TRACE=1 npx vitest run tests/governance`，commit 里写明「#61 surface 增加 confirm 呈现转发钩子」。（若想零 trace 变化，只能把四个转发改挂到 message scheduler 现有钩子，需动 `message.ts`，超出 C1 域，未做。）

另：`tests/integration/schedule-surface-wiring.test.ts` 的「ENABLING 钩子足迹」断言是**测试内联常量**（非 fixture），已随之更新：`input 1→2`、`ui_prompt_start/end 1→2`、新增 `before_agent_start: 1`。

## 残留 / 范围外观察

- 工具的 `promptGuidelines` 仍写「tell the user to run /schedule approve…」（冻结的缓存前缀，计划只改结果文本）；offered 时结果文本已明确让模型不要再催用户敲命令，两者并存。
- R1（pi 共用对话框槽）按计划接受 promise 泄漏：开着的 select 在 offer TTL 内会让调度消息派发一直等待，`/schedule repair` 可清栅栏。
- `ScheduleCoordinator` 接口尚无 `offers/confirmReady/onDecide`，C2 补齐前 hub 渠道不可用（设计内退化）。

## 自验

- `npm run typecheck`：0 error（TS7 ×2 + vue-tsc）。
- `npx vitest run tests/schedule tests/tools tests/commands tests/governance --maxWorkers=4`：1279 通过 / 1 失败（仅 `tests/governance/activate-trace.test.ts`，原因如上，等 golden 刷新）。
- `npx vitest run tests/integration/schedule-off-golden.test.ts tests/integration/schedule-surface-wiring.test.ts tests/integration/schedule-wiring.test.ts tests/integration/schedule-hub.test.ts tests/integration/schedule-fault-matrix.test.ts tests/conformance/schedule.test.ts --maxWorkers=2`：6 文件 47 测试全过（含 `schedule-off-golden`：off 画像 handler 计数与字节不变；conformance C-S 通过）。
- `npx prettier --check`（src/schedule src/tools src/commands src/index.ts tests/schedule tests/tools tests/commands + 改动的集成测试）：通过。
- `git diff --quiet HEAD -- tests/fixtures/`：干净。
- 新增测试：`claim.test.ts`（approve 幂等 + 并发同 hash、rejectTask 删除/回滚/name 不回滚/E_REV/already-approved/no-task/approve×reject 竞态）、`confirm.test.ts`（32 项）、`surface.test.ts`（5 项）、`schedule-tool.test.ts`（confirm 块 5 项）、`commands/schedule.test.ts`（reject 8 项）、`ops.test.ts`（onBase 2 项）、`wire.test.ts`（onChanged）、`dispatch.test.ts`（`confirm` ⇒ quiet）。

## 建议 commit message

```
feat(schedule): confirm AI-authored tasks on the spot — offers, decide, reject (#61 C1)

approveTask is now idempotent under the ledger lock (already-approved) and rejectTask undoes the AI's
unconfirmed change (delete a created task / restore an edited one's old execution definition, name untouched).
New schedule/agent/confirm.ts keeps ≤8 in-memory offers (TTL 2 h), one decide() entry for TUI select,
/schedule reject and the hub's sched_decide, ledger revalidation and a TUI presenter that never aborts a box.
The schedule tool asks the user right after create/update leaves a task pending; QUIET_KINDS gains "confirm".
Surface adds input/before_agent_start/ui_prompt forwarders (activate-trace golden refresh needed).
```

## 改动文件清单

src：`src/schedule/core/claim.ts`、`src/schedule/agent/{ops,wire,surface,dispatch}.ts`、`src/schedule/agent/confirm.ts`（新）、`src/tools/schedule-tool.ts`、`src/commands/schedule.ts`、`src/index.ts`
tests：`tests/schedule/core/claim.test.ts`、`tests/schedule/agent/{confirm(新),surface(新),ops,wire,dispatch}.test.ts`、`tests/tools/schedule-tool.test.ts`、`tests/commands/schedule.test.ts`、`tests/integration/schedule-surface-wiring.test.ts`
docs：`docs/dev/scheduled-reports/confirm-C1-report.md`
