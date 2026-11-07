# #61 I2 包报告：集成与文档

基线：`dev@0c62defc`（C0/C1/H2+F2/C2/W2 已提交）。零 git 写操作；未碰 `tests/fixtures/`（`git diff --quiet HEAD -- tests/fixtures/` 干净，`governance/activate-trace.json` 未变——本包不新增任何注册）。

## 改动

### 1. F2 遗留接线：reconcile 规则 4「任务已删除」

- `src/web-hub/hub/feishu/schedule-confirm.ts`：`ledgerText(t, since)` 现在先读 H2 的结构化可选证据端口 `(port as HubSchedulePort).ledgerTask?.(sid, taskId, {since: anchor.createdAt})`：
  - `deleted`（hub 一次起点晚于 anchor 创建的成功扫描里没有该任务）⇒ 中性 PATCH「任务已删除」；
  - `present ∧ approved ∧ defHash 相同` ⇒「已批准」；旧的 `list()` 同 hash 已批准仍作为第二见证；
  - `unknown/stale/degraded/root-degraded/no-session`、无该端口、端口抛错 ⇒ 无证据，**保留卡片**（fail-closed，绝不凭空 recall）。
  - 三个调用点（reconcile 的 `inspect`、decide 被 refused 后重读、迟到的第二击）都改为使用返回文案（不再把任何证据硬写成「已批准」）。`offersSeen` 未用：规则 3 的 reattach 判断 F2 已有自己的路径，rule 4 只依赖账本证据。
- 单测 `tests/web-hub/hub/feishu/schedule-confirm.test.ts` +6（45 个全绿）：deleted ⇒「任务已删除」且 `since==anchor.createdAt`、无 DELETE/decide；4 种 unknown 保留；present 不同 hash / 未批准保留、同 hash 已批准 PATCH；端口抛错不崩；refused 后证明已删 ⇒「任务已删除」非「已批准」非 recall；迟到第二击不说「已在其他端处理」。变异验证：注释掉 `deleted` 分支，集成用例「deleted behind the hub's back」超时失败。

### 2. 端到端集成测试（新）`tests/integration/schedule-confirm.test.ts`（16 例）

真 hub 子进程（H2 service、F2 卡片、真 nonce 状态、真 HTTP 前端）× 真 agent 栈（S1 账本、`createScheduleAgent`+hub 协调器、`wireScheduleSurface`/confirm 与 TUI presenter、真 `schedule` 工具与 `/schedule` 命令、C2 链路走真 unix socket）× fake 飞书（HTTP+pbbp2 ws）× fake pi/TUI（`ui.select`/`notify`/`isIdle`）。web 侧用真 `GET /api/schedules` 投影的 `offer`，web 命令用 web-claimed 的真 `/schedule approve|reject`。

1. create ⇒ TUI 三选项框（`select` 恰两个参数）/ web `offer` / 飞书卡（完整 prompt、两个按钮 nonce 持久、anchor 绑 sid/taskId/defHash）同时出现，工具结果 `confirm:"offered"`。
2. 飞书先批准：卡保留「已通过飞书批准」（无 DELETE）、web offer 消失、TUI 框之后（idle+`agent_settled`）也不再弹、账本 `approval.hash==defHash`、AI 只收到一条 notice。
3. web 先批准：飞书卡 DELETE 恰一次、offer 消失、TUI 不弹、对旧按钮的迟到点击不产生任何 `sched_decide`。
4. TUI 先批准：卡 DELETE、offer 消失、`via:"tui"`。
5. 飞书批准时 TUI 框已开：框不被 abort，只 `notify`「已在飞书批准…可直接关闭」；之后在框里选批准不改账本、仍只一条 notice。
6. 飞书拒绝 create ⇒ 账本与 web 投影里任务都被删，卡「已通过飞书拒绝」，TUI 不弹。
7. web `/schedule reject` update ⇒ 恢复原批准定义且重新可执行（`defHash` 回到原值），**`name` 不回滚**，第二张卡被收回。
8. create→update：旧卡 DELETE、旧 nonce 点击无 decide、新卡（新 hash）可批准，decide 帧带新 hash。
9. TUI 与飞书同时批准 ⇒ 一条 notice、≤1 个 decide、卡与账本终态一致；web 命令与飞书同时批准 ⇒ 账本批准一次，飞书侧文案中性（无「未确认/离线」）。
10. agent 离线：web 不出 offer（任务仍 pending）、飞书点击回「会话离线」、无 decide、账本未批准。
11. `/reload`（agent 崩溃重连、无 withdrawn 帧）后：任务被删 ⇒ 卡「任务已删除」（无 DELETE）；他处已批准 ⇒「已批准」；无证据 ⇒ 卡保留不 recall。
12. schedule 关（hub 无 `schedule` 配置）：caps 无 `sched.v1`/`sched.confirm.v1`、`/api/schedules` 404、无飞书卡、TUI-only agent 对 hub 零 `sched_*` 帧；新 agent × 无 confirm cap 的 hub：`confirmReady()=false`、无 offers 帧、无卡。

### 3. `tests/integration/web-hub-feishu-bot.test.ts` 新 block「#61 I2 — owner-only schedule approval cards」（6 例）

`boot` 新增 `schedule?: storeDir` 选项（写 `HubConfig.schedule`）；脚本化 agent（手写 `sched_offers`/`sched_decide_ack`）+ 真账本任务。覆盖：owner 私聊发 1 张卡（PATCH 出完整 prompt/hash/两按钮），点击恰发 1 个 `sched_decide`（reqId 合规、全 hash、决策 approve），ack 变终态 PATCH，按钮单次使用、重放无第二个 decide；**owner 证明 fail-closed**（只 `/use` 绑定、无 owner 请求 ⇒ 无卡、不泄露 prompt；首个 owner 请求后卡出现）；陌生人点击（合法 nonce、错 operator）不到 agent 且卡仍活；agent 回 `refused offer-gone` ⇒ 卡被 recall；agent `closed(approved, by tui)` ⇒ 卡被 recall 且不 decide；hub 无 schedule ⇒ 同样帧不发卡、无 decide。

### 4. 文档

- `docs/dev/scheduled-reports/README.md`：新节「当场确认 AI 创建/修改的任务（#61）」——流程、三渠道竞速与账本仲裁、拒绝语义、重载/离线、门禁、残留风险（含 **R1 pi 共享对话框槽位风险**与 R2–R12），门禁清单加入 `schedule-confirm`。
- `docs/dev/feishu-bot/README.md`：命令表补「审批卡片（非命令）」一行；安全模型补 owner-only fail-closed 条目；开发者要点补 F2/账本证据端口一段。
- 用户文档：根 `README.md` 的「定时任务」节（批准段补当场确认/拒绝语义、命令表补 `reject`、网页与飞书段更新）；`docs/guide/subagents.md` 定时任务指引补一句。（`docs/guide` 无其它 schedule 专页。）

## 自验

- `npm run typecheck`：0 error（TS7 ×2 + vue-tsc）。
- `npx vitest run tests/integration/schedule-confirm.test.ts tests/integration/web-hub-feishu-bot.test.ts tests/web-hub/hub/feishu tests/schedule --maxWorkers=3`：67 文件 / 2009 通过 / 0 失败。
- `npm run test:conformance`：34 文件 / 352 通过 / 16 skipped（自门控）。
- `npx vitest run tests/web-hub/boundary.test.ts tests/governance`：23 通过。
- prettier --check（README、docs、`src/web-hub/hub/feishu`、`tests/integration`、`tests/web-hub/hub/feishu`）通过；`git diff --quiet HEAD -- tests/fixtures/` 干净。

## 遗留 / 说明

- 工作树里另有**非本包**的改动（`src/secure/*`、`tests/secure/*`、`tests/web-hub/boundary.test.ts`、`tests/web-hub/ui/highlight-j1-batches.test.ts`、`docs/dev/ci/ci-leftovers-63.md` 等），提交时请用精确路径，勿 `git add -A`。
- `offersSeen`（H2 提供）当前无消费者；若以后要做规则 3 的「已重新 attach」判定可直接用。
- 未覆盖：真 pi 的共享对话框 R1 行为（仅 fake `ui.select`），仍需真机验收；`docs/dev/scheduled-reports/acceptance.md` 未追加真机清单。

## 建议 commit message

```
test(schedule): end-to-end confirm chain + feishu evidence wiring + docs (#61 I2)

Real hub child × real agent stack × fake Feishu/pi: TUI / web / Feishu card race for one decision, the ledger CAS
is the referee, losers are recalled (TUI box never aborted), reject deletes/restores, concurrent approvals take
effect once, offline and schedule-off are inert. The Feishu card's "offer neither open nor closed" branch now
consults H2's ledgerTask evidence: proven deletion ⇒ 「任务已删除」, proven approval ⇒ 「已批准」, no proof ⇒ keep.
Docs: scheduled-reports/feishu-bot READMEs, user README.
```

## 改动文件清单

- src：`src/web-hub/hub/feishu/schedule-confirm.ts`
- tests：`tests/integration/schedule-confirm.test.ts`（新）、`tests/integration/web-hub-feishu-bot.test.ts`、`tests/web-hub/hub/feishu/schedule-confirm.test.ts`
- docs：`README.md`、`docs/guide/subagents.md`、`docs/dev/scheduled-reports/README.md`、`docs/dev/feishu-bot/README.md`、`docs/dev/scheduled-reports/confirm-I2-report.md`
