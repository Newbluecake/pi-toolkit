# 源码治理第二批 · ⑨-H1 实施报告（gov/step9h1）

> 基线：`dev@74703578`（worktree `/tmp/gov-step9h1`）。范围：`batch2-plan.md` §6 的 **H1** 行——
> `src/web-hub/agent/index.ts` 的 hold 接线、dialogs、StatusInfo slot 投影纯抽取到
> `agent/{hold-wire,dialogs-wire,status-slots}.ts`。**不做** slot 注册表（D9-1，另开包）。

## 行数前后

| 文件                                | 前（74703578） | 后   |
| ----------------------------------- | -------------- | ---- |
| `src/web-hub/agent/index.ts`        | 2538           | 2413 |
| `src/web-hub/agent/status-slots.ts` | —              | 138  |
| `src/web-hub/agent/dialogs-wire.ts` | —              | 58   |
| `src/web-hub/agent/hold-wire.ts`    | —              | 193  |

`wireWebHub` 闭包减重 125 行（净）；三个新文件均为纯工厂/装配函数，无模块级 `let`（I4）、无新增计时器（I5）。

## 提交列表（`74703578..HEAD`）

| sha        | 标题                                                                        | 移动了什么                                                                                                                                                                                                       |
| ---------- | --------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `bf18bb33` | refactor(web-hub): extract StatusInfo slot projections into status-slots.ts | `bashJobsProjection`、`todoArchiveCap`、`todoProjection`、`archiveProjection`、`cacheKeepaliveProjection`、`quotaProjection`、`quotaProblemsSafe` → `createStatusSlotProjections()`；index.ts 原位解构同名局部量 |
| `8b92b23b` | refactor(web-hub): extract dialog bridge wiring into dialogs-wire.ts        | `remoteAskUserEnabled` 门 + `createDialogBridge` 装配 → `wireDialogs()`；`attributePromptRef` 赋值行留在 index.ts（与 event tap 共享的胶水）                                                                     |
| `ebc28fc6` | refactor(web-hub): extract hold wiring into hold-wire.ts                    | 门块（`holdOn`/`holdBuffer`/`holdCap`/`capKnownAbsent`）+ `status.held` 投影 → `createHoldGates()`；`createHoldDriver` 装配 → `wireHoldDriver()`；五个事件处理器注册 → `registerHoldHandlers()`                  |

## 零行为证据

- **闭包捕获 → 显式 getter**：被移代码捕获的 `conn`/`attached`/`ctx` 全部改为调用时读取的 `conn()`/`isAttached()`/`getCtx()`；hold 处理器 guard 的 `ctx = c` 收养经 `adoptCtx` 回写，变更语义逐行等价。原代码两次读取同一 `conn` 变量处（`status()`+`caps`）改为两次调用 `conn()`，中间无 await，单线程语义相同。
- **计时器**：hold driver 的 `setRefTimer` 保持 REF'd（v4.3 Y3/T-REF，≤200ms 有界确认期）；其余 unref 一处未少；未新增任何计时器。
- **注册顺序**：hold 处理器仍在 FORWARDED 循环之后、仍仅 `holdOn` 时注册；`enabled: remoteAskUserEnabled()` 仍在同一构造点求值一次。
- **不改面**：无设置键/wire 字段/cap/tool schema/命令表/模型可见文本变更；`src/index.ts` 公开面未动；`WebHubDeps`/`WebHubControl` 等导出类型原样。
- **被钉住的代码段**（plan §6 H1 列出的三处）：`tests/web-hub/agent/restart.test.ts:250`（`pidAlive: (pid) => ctlLivenessProbe(pid)`）、`tests/web-hub/agent/admin-cmds.test.ts:292`（`const restart = …` 函数体）、`tests/web-hub/hub/commands.test.ts:725`（`createCommandLedger()`）——这三段代码**没有移动**（restart/ledger 不属于 H1 的抽取范围），测试无需改指向，钉住意图不变，全部仍绿。
- **冻结面**：`git diff --quiet 74703578 -- tests/fixtures/` 为空（fabric-xs-off、schedule-off 等 golden 逐字节不变，且对应测试实跑通过）。

## 自验命令与结果

| 命令                                                                                                                                                                                                                                               | 结果                                                                                      |
| -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------- |
| `npm run typecheck`（每个提交后 + 最终）                                                                                                                                                                                                           | ✅ 通过                                                                                   |
| `npx vitest run tests/web-hub --maxWorkers=3`                                                                                                                                                                                                      | ✅ 707 文件 / 15853 通过（4 skipped 为自带门控）                                          |
| `npx vitest run tests/integration/web-hub-{control,disabled,spawn,load,child-session-capture}.test.ts tests/integration/fabric-xs-{off-golden,reply-off-golden,alias-wiring,channel-compat}.test.ts tests/integration/schedule-off-golden.test.ts` | ✅ 55 通过（见「遗留」的 flakes 说明）                                                    |
| `npx vitest run tests/conformance/{web-resume,cmd-history,slash-args,history-restore}.test.ts`                                                                                                                                                     | ✅ 23 通过                                                                                |
| `npm run format:check`                                                                                                                                                                                                                             | ✅                                                                                        |
| `git diff --quiet 74703578 -- tests/fixtures/`                                                                                                                                                                                                     | ✅ 空                                                                                     |
| `npm run build:web && npm run check:web`                                                                                                                                                                                                           | **未跑**：本包未触碰 `src/web-hub/ui/**` 及任何 UI 资产，按任务口径（「涉及 UI 时」）跳过 |

## 遗留 / 说明

1. **并发 flake 一次**：把 `tests/web-hub` 全量与 integration 批次同时跑（两个 vitest 进程抢资源）时各出现 1 个超时型失败；两者单独重跑均全绿（web-hub 全量 707/707，`web-hub-control` 单跑 24/24）。与本次改动无关，属资源竞争；证据面以单独全绿运行为准。
2. **未做项（方案内排除）**：slot 注册表（D9-1）不在本包；⑨-H2/H3 属其它并行 worktree。
3. **新文件与 index.ts 的类型边界**：`status-slots.ts`/`dialogs-wire.ts`/`hold-wire.ts` 用窄结构类型（如 `{ control?: boolean; steerRecall?: boolean }`）承接 `WebHubSettings`/`WebHubDeps` 字段，避免与 index.ts 形成类型循环引用。
