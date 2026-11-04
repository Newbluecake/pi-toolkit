# schedule-auto-approve r2 — 验收记录

方案：`plan.md`（r2）。本文是 F 包（收尾）的验收记录；真机项（plan §9）由人工在升级后勾选。

## 自动化门禁（F 包）

| 项                                      | 命令 / 位置                                                                                  | 结果               |
| --------------------------------------- | -------------------------------------------------------------------------------------------- | ------------------ |
| agent/hub schedule 定向                 | `npx vitest run tests/schedule tests/web-hub/agent tests/web-hub/hub tests/web-hub/protocol` | 见交付报告         |
| webhub-wiring（hello 不含 confirm cap） | `tests/schedule/agent/webhub-wiring.test.ts`                                                 | 见交付报告         |
| governance / conformance schedule       | `npx vitest run tests/governance tests/conformance/schedule.test.ts`                         | 见交付报告         |
| format / typecheck                      | `npm run format:check`、`npm run typecheck`                                                  | 见交付报告         |
| 残留 grep（plan §8.5）                  | `rg -n "approveTask\|rejectTask\|isApproved\|isPendingApproval\|…" src tests`                | `src`/`tests` 为零 |
| A 级 fixtures                           | `git diff --quiet origin/dev -- tests/fixtures/`                                             | 见交付报告         |

## F 包落地内容

- 删除 `confirmReady`（`SchedHubLink`、`ScheduleLink` 的 agent 实现）、agent/hub 对 `SCHED_CONFIRM_CAP` 的声明与 import；协议常量与 schema 保留（deprecated，容忍解析）。
- 删除 `isApproved` / `isPendingApproval`（零调用方后）。
- 文档：scheduled-reports README「当场确认」改为已移除短节、「Approval = definition hash」改为「No approval」；feishu-bot README 三处审批卡标注已移除。

## 真机验收清单（plan §9，升级后人工勾选）

- [ ] 1 AI `schedule` create/update ⇒ 立即生效，无确认框 / 飞书卡 / web 弹窗；到点真实触发；`run_now` 放行
- [ ] 2 `/schedule approve x`、`__put` ⇒ 未知子命令；web 对 approve/reject/__put policy deny；`show`/`list`/状态栏无 pending
- [ ] 3 `/schedule add|edit` 立即生效；pause/resume/rm 行为不变
- [ ] 4 Web detail 面板同时有待办与定时分区；暂停/删除有效；run 可跳 fleet；「详情 »」打开 SchedulePanel；无审阅/批准/拒绝
- [ ] 5 composer chip 两段计数；steer/held 隐藏
- [ ] 6 飞书 `/schedule` 无「待批准」；`/schedule run <n>` 对新任务直接运行
- [ ] 7 `schedule.enabled` 关 ⇒ 与现状逐字节一致（off golden 绿）
- [ ] 8 `/reload` + `/webhub restart` 过渡窗口任务照常执行
