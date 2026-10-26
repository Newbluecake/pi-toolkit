# #61 W2 包报告：web UI（schedule confirm offer）

基线：`dev@3d5b37f3`（C0 已合入）。范围：confirm-plan r2 §7 W2 行；设计 §4.6；测试 §8.24/25。零 git 写操作。

## 改动

- `src/web-hub/ui/src/logic/schedule.js`
  - `rejectArgs(taskId, defHash)`：`/schedule reject <id> <fullHash>`，与 `approveArgs` 同一哈希绑定纪律（C0 的 command-policy 已 allow 该形状）。
  - `offerOf(proj)`：会话投影里最早到期的结构合法 `offer`（`{taskId, offerId, expiresAt}`），松散校验、坏条目跳过、无 offer ⇒ undefined。DOM-free，bundle 纪律不变（仍不 value-import protocol）。
- `src/web-hub/ui/src/components/detail/DetailHeader.vue`
  - 监视 `schedules` 槽本会话任务的 `offer`（`immediate` watcher，覆盖挂载时已在 wire 上的 offer）：`schedUsable ∧ 控制面可写（「清空」同一 gate）∧ 在线` 且 offerId 未见且面板未开 ⇒ 自动打开 `SchedulePanel` 并定位该任务（`initialReviewTaskId`）；多 offer 由 `offerOf` 取最早到期。
  - 已呈现记忆：`window.sessionStorage["pwh_sched_offer_seen"]` 集合（上限 64，FIFO 截尾），关闭自动弹出的面板时记「已呈现」；读写全部 try/catch fail-open（隐私模式下最多同标签页重弹一次）。sessionStorage 先例：ControlNotice.vue；source-scan 只禁 localStorage，扫描通过。
- `src/web-hub/ui/src/components/schedule/SchedulePanel.vue`
  - 新 prop `initialReviewTaskId?: string | undefined`（`| undefined` 显式标注，过 exactOptionalPropertyTypes；F2 报的 vue-tsc DetailHeader.vue:736 已修）。
  - offer 打开的 review 中任务消失（自家拒绝删除/他端处理）⇒ 回落列表视图并显示「任务已删除」（`sched-note[data-kind=info]`）；store degraded 时**不**误报；手动打开的 review 任务消失仍静默回落（pre-feature 行为不变）。
- `src/web-hub/ui/src/components/schedule/ScheduleReview.vue`
  - `task.offer ∧ canWrite ∧ pendingApproval` ⇒ 新增「拒绝」按钮（`btn btn-danger`，既有全局样式；暗色/窄屏沿用现有 token 与 coarse-pointer 规则）：未批准过的 AI 新建 ⇒「拒绝（删除该任务）」；其余 ⇒「拒绝（恢复修改前定义）」（按 `task.approval` 是否存在区分）。经 `useTrackedCommand` 发 `/schedule reject <id> <defHash>`；E_REV 复用「内容已变更，请重新审阅」；成功提示按删除/恢复分文案。
  - 新 prop `fromOffer`：offer 打开的 review 中 offer 消失且任务已批准 ⇒「已在其他端批准」note，按钮随 `pendingApproval` 自动隐藏；offer 消失但任务仍 pending（supersede/过期）⇒ 不出 note，重渲染的新定义自明；本地已落定的操作结果优先于该 note。
- `src/web-hub/ui/src/i18n/schedule-extra.ts`：en/zh 同步追加 9 键（rejectDelete/rejectRestore/rejecting/rejectAria/rejectOkDelete/rejectOkRestore/rejectFailed/offerApprovedElsewhere/offerTaskGone），行内标记未加中文；parity 测试自动覆盖。
- `tests/web-hub/ui/schedule-logic.test.ts`：+`rejectArgs`、`offerOf`（最早到期、无 offer/坏投影 ⇒ undefined、坏条目跳过、NaN expiresAt 跳过）。
- `tests/web-hub/ui/schedule-panel.test.ts`：+20 用例 —— initialReviewTaskId 直落 review/未知 id 回落列表；reject 按钮文案两态、发命令参数、无 offer 无按钮、离线无按钮、E_REV、删除成功提示、**在途按钮各自 spinner（复审 #1）**、**reject-delete 结论文案跨快照保留（复审 #4）**；他端批准 note / 仍 pending 不出 note / 任务消失列表 note / 手动打开静默回落；DetailHeader 自动弹出并定位、关闭后不重弹（刷新与重新挂载均验证）、**打开期间到达的第二 offer 关闭时再弹（复审 #2）**、新 offerId 再弹、只读/离线不弹。文案断言用 `SCHEDULE_EXTRA` en/zh 双值比对，不依赖 happy-dom locale。

## 评审修复（deepseek 复审 3 minor + 1 nit，2026-10-26 二轮）

1. **ScheduleReview 双按钮共用一个 `tracked.phase` 互相冒充运行态**：新增 `busyAction: ref<"approve"|"reject"|null>`，只有在途的那个按钮显示 spinner/「…中」文案，另一个仅 disabled（`busy` 仍统一禁用两者）。新增用例：reject 在途时 approve disabled 且无 spinner、文案不变。
2. **DetailHeader 自动弹出只在 `schedOffer` 变化时检查、面板开着就 early-return**：`onSchedClose` 里延迟一拍（`nextTick`，保证旧面板先卸载——`initialReviewTaskId` 只在 setup 读取）重新检查「没见过且面板未开 ⇒ 打开」；面板打开期间到达的第二个 offer 或仍活的未见 offer 在关闭时弹出。已抽象共用 `schedOfferPop`。新增用例：打开期间到达新 offerId ⇒ 关闭后立刻再弹、再关才停。
3. **schedule.css 窄屏换行**（本包补上该文件域）：`@media (max-width: 480px)` 下 `.review-actions` `flex-wrap: wrap`，按钮 `flex: 1 1 100%` 填满整行、44px 触控高（spawn.css ≤480px 动作按钮语法），修 en 文案在 360–390px 横向溢出。
4. **nit：reject-delete 成功后的结论文案跨 SSE 快照保留**：ScheduleReview 成功时 `emit("decided", "reject-delete"|"reject-restore"|"approved")`；面板记下 taskId，任务消失回落列表时若系自家 reject-delete ⇒ 列表 note 显示「已拒绝——任务已删除。」而非通用「任务已删除。」。新增用例覆盖。

## 自验（二轮复跑）

- `npm run typecheck`：0 error（tsc ×2 + vue-tsc；含 F2 报告的 DetailHeader.vue:736 修复后复跑）
- `npm run build:web && npm run check:web`：✓（first-screen 366233B gz、lazy 84892B gz，均在预算内）
- `npx vitest run tests/web-hub/ui --maxWorkers=4`：**268 文件 5910 测试全绿**（schedule 两文件 52 测试：panel 33 + logic 19）
- `npx prettier --write <改动文件>`：全部符合格式（schedule-panel.test.ts 重排一次后复跑仍绿）
- `git diff --quiet HEAD -- tests/fixtures/`：**红 —— 非本包所为**：`tests/fixtures/governance/activate-trace.json` 被并行 C1 包按 §4.4 新增 `on(input)/on(before_agent_start)/on(ui_prompt_start)/on(ui_prompt_end)` 注册后有意刷新（B 级 trace 契约）。本包未触碰 tests/fixtures/ 任何文件。
- 同树另有一处非本包改动：`tests/web-hub/ui/logic-markdown-perf.test.ts`（perf 口径重写，与 #61 无关），未触碰。

## 设计取舍（§4.6 落实备注）

- 「offer 消失时自动收起并提示」按 §4.6 正文实现为**原位提示**：任务已批准 ⇒ review 原地显示「已在其他端批准」（按钮自动隐藏）；任务被删 ⇒ 面板自动回落列表视图并显示「任务已删除」。对话框不主动整个关闭，用户可继续浏览列表。
- reject 按钮以 `task.offer` 存在为门槛（无活 offer 时 `/schedule reject` 在 agent 侧本就 E_INVALID）。
- 自动弹出仅记在关闭时「已呈现」；会话切换导致未关闭即卸载 ⇒ 下次挂载会再弹一次（可接受，fail-open）。

## 建议 commit

`feat(web-hub): web UI confirm offer — auto-open review, reject button, elsewhere-handled notes (#61 W2)`

（复审修复可并入同一 commit，或单独 `fix(web-hub): schedule review per-action busy, close-re-check pop, narrow wrap (#61 W2 review)`）
