# #26 探索结论（原样落档）

> 来源：deepseek 只读探索，2026-11-05；坐标以当时 dev HEAD 为准，动手前请核实。方案见同目录 `plan.md`（plan 里核实过坐标，有一处订正）。

- 唯一的工具侧确认是用户令守卫：`src/memory/tool-v2.ts` 中 `guardConfirm` :299-341、`raceGuardConfirm` :343-467、`prepareJevGuard` :927-1011（硬拒绝 :978-984、确认 :990-1005、voided :1008）、`prepareJevDeleteGuard` :1020-1065；REFUSE 文案 :178、标题 :179；调用点 :1478/:1485/:1500/:1516/:1533/:1541；delete 的 voided 回显 :1519-1520。配对算法 `src/memory/jev/guard.ts:16-40`。会话取消与远程卡接线：`src/memory/index.ts:96-106`、`src/index.ts:228-242`（sessionAbort/sessionSignal）、`src/index.ts:1151`（askUserRemoteRef）。
- 触发守卫的条件：str_replace/insert/append/write 触及用户令（内容哈希配对），或手写→`source: agent` 的 provenance 翻转，或→`status: archived` 的归档翻转；delete 删除含用户令的 agent 文件。rename 不触发。
- 设置：`memory.jev.confirmTimeoutS`（默认 60s，`setting-specs.ts:207-212`，`settings.ts:103-104,382,450`）只服务于此守卫——去掉确认后它是否删除，要评估 settings pin/corpus 的刷新，以及旧配置文件里残留该键时的兼容（parse 必须容忍未知键）。
- 测试：`tests/memory/tool-v2-jev.test.ts:294-560`、`tests/memory/tool-v2-jev-remote-confirm.test.ts`（27 tests）、`tests/integration/memory-headless-confirm.test.ts`（3 tests）、`tests/memory/jev/guard.test.ts`。
- 冻结物：`jev-off-golden` 钉住 jev off 时 wireMemory 的注册列表（不得新增 `pi.on` 注册）；`activate-trace.json` 钉住注册顺序；工具描述 `MEMORY_TOOL_V2_TEXT_JEV` 若要改，只能按 B 级规则新增键（守卫文案不在描述里，原则上不用改描述）。
- 文档面：`skills/memory-jev/SKILL.md:23,37,42`、`docs/guide/memory.md:78-85,589`、`docs/dev/memory/README.md:29`（不变式 11）、`docs/dev/memory/headless-confirm/*`（标记作废或归档）。另有已移除的 memory gate 的文档残留：`docs/dev/memory/jev-arch.md:1327-1330`、`hygiene-plan.md:137,272,650`、`jev-plan.md:901-902`、`reports/acceptance-report.md:34,87`。是否顺带清理，由方案制定者判断后写进 plan（建议只加「已移除」标注）。
