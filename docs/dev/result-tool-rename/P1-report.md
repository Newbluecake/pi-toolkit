# P1 报告 — get_subagent_result → get_run_result（src + tests + golden + conformance）

基线 HEAD 490d8ce9，主工作区，未提交、零 git 写操作。P2（web UI）、P3（文档/skills/README/package.json）、残留门禁均未做（r3：门禁只在最后一个包引入）。

## 实现要点

- `src/core/tool-names.ts`（新，零 import）：`RESULT_TOOL_NAME`、`LEGACY_RESULT_TOOL_NAME`、`migrateToolNames`。`SCHEDULE_RESULT_TOOL` 已删，schedule 的 note/report-file 直接用 `RESULT_TOOL_NAME`。
- 模型可见文案全部插值引用常量（agent-tool、agent-types、format、abort/extend/workflow/list、poll-guard、task 等）；其余注释为字面替换。
- `result-tool.ts`：新名 / label `Get Run Result` / 新描述（含 `(Formerly named get_subagent_result.)`、r_/wf_/定时任务）/ promptSnippet / run_id 描述；导出 `legacyResultToolRenderer`。
- `RESERVED_TOOL_NAMES`：旧名原位（index 1）保留，新名追加末尾。
- `src/tools/result-tool-activation.ts`（新）：r3 R2-B1 三条件——transcript 声明含旧名；新名已注册（pi 注册表已按 `--tools/--exclude-tools` 过滤）且未 active；进程 argv 含任何 `--tools/-t/--exclude-tools/-xt/--no-tools/-nt/--no-builtin-tools/-nbt`（含 `--flag=value`）即不迁移，argv 读不到也不迁移。只追加。挂在已有 `session_start`（函数首行）和 `session_tree` 处理器里（后者改为 `restoreArchive(ctx); activateResultTool(ctx)`），**未新增处理器**，schedule-off 的 handlerCounts 未变。
- `src/index.ts`：`registerToolRenderer` 先探测再注册历史 renderer。
- 飞书 `waitNotifyTools`：`parseConfig` 读取时 `migrateToolNames`（保序去重）。

## 3 份 golden（D3 授权，字节级）

脚本：`docs/dev/result-tool-rename/golden-assert.mjs`（`BASE=HEAD node …`；提交后用 `BASE=HEAD~1`）。按出现位置构造期望：fabric-xs-off 的 `reservedToolNames` 旧名原位保留、末尾追加新名（先自检：旧名 1 次、index 1，新名 1 次且在末尾），其余位置按精确次数替换（schedule-off 4、nested 2）；逐字节比较；断言 `git diff --name-only BASE -- tests/fixtures` 恰为这 3 个文件且无未跟踪 fixture。输出：

```
golden rename diff OK (byte-exact)
```

文件由独立的 python 变换生成，不是脚本自己产出，避免循环验证。`prettier --check` 三份均通过。

## 新增/更新测试

- `tests/conformance/result-tool-rename.test.ts`：真实 `createAgentSession` + 真实 toolkit `activate` + 脚本化假模型。R1 前提钉（pi 1.3 resume 后新工具已注册但不 active）、R2 resume、R3 fork、R4 `/tree` 回旧节点、R5a 用户停用保持停用 / R5b `--tools -get_run_result` 不激活且同一 resume 无修饰则激活 / R5c `--exclude-tools`、R6 `/reload`、R7 旧名调用得 `Tool get_subagent_result not found` 且 tool_call/tool_result 钩子都没触发、R8 历史 renderer 接线。变异验证：去掉迁移 ⇒ R2/R3/R4/R5b/R6 失败；去掉 argv 守卫 ⇒ R5b 失败。
- 单测：`tests/tools/result-tool-activation.test.ts`、`tests/core/tool-names.test.ts`，并更新 tool-scope / result-tool（renderer）/ model-facing-strings / feishu core；其余测试期望机械替换。

## 自验

- `npm run typecheck 2>&1 | tail -3`：tsc ×2 + vue-tsc 无错误输出。`npm run build` 通过。
- `npx vitest run tests/tools tests/runtime tests/service tests/schedule tests/delivery tests/feishu-notify tests/commands tests/integration --maxWorkers=4`：276 files / 3056 passed, 2 skipped。
- 其余非 web-hub 目录（adapters…workflow，含 boundary/docs/hud/core/config）：507 files / 10391 passed, 1 skipped。
- `npm run test:conformance`：33 files passed；341 passed, 16 skipped（自门控）。
- 未跑 `tests/web-hub/**`（P2 在同一工作区并行改动）。
- `prettier --check` 全部改动文件通过。

## 建议提交说明（你不提交，由主会话决定）

```
refactor(tools): rename get_subagent_result to get_run_result

The tool that reads a background run (r_…) or workflow (wf_…) is now
get_run_result; only the new name is registered and calling the old one
gives pi's "Tool get_subagent_result not found". The description keeps a
transition note "(Formerly named get_subagent_result.)".

- Sessions recorded under the old name get the new tool activated
  automatically on resume / fork / /tree (pi >= 1.3 restores active tools
  from the transcript). Never overrides a user choice: skipped when the
  process has --tools / --exclude-tools / --no-tools style arguments.
- Historic cards of the old name still render in the TUI; the web UI
  follows in a later change.
- Feishu waitNotifyTools entries naming the old tool are mapped to the new
  name on read.
- Manual: --tools / defaultTools / traffic rewrite rules that spell the
  old name must be updated.
- Expect one prompt-cache miss per session after upgrading (tool set
  changes).
- Frozen goldens fabric-xs-off, schedule-off and agent-nested-surface were
  updated once by a byte-exact rename (authorized 2026-10-26); this is a
  baseline migration, not an off-behaviour change.
```

## 改动文件（git status，绝对路径前缀 /home/bluecake/ai/pi-toolkit/）

```
src/adapters/workflow-notice.ts
src/archive/control.ts
src/commands/status.ts
src/commands/task.ts
src/config/agent-types.ts
src/context-switch/child.ts
src/core/state-machine.ts
src/core/types.ts
src/delivery/format.ts
src/delivery/usage-broadcast.ts
src/feishu-notify/core.ts
src/hud/footer.ts
src/index.ts
src/runtime/runner.ts
src/runtime/session-driver.ts
src/runtime/tool-scope.ts
src/schedule/agent/note.ts
src/schedule/agent/report-file.ts
src/schedule/agent/result-reference.ts
src/service/run-registry.ts
src/service/spawn-service.ts
src/stack.ts
src/tools/abort-tool.ts
src/tools/agent-tool.ts
src/tools/extend-timeout-tool.ts
src/tools/list-subagents-tool.ts
src/tools/poll-guard.ts
src/tools/result-text.ts
src/tools/result-tool.ts
src/tools/run-ref.ts
src/tools/steer-tool.ts
src/tools/workflow-target.ts
src/tools/workflow-tool.ts
src/ui/capped-body.ts
src/web-hub/agent/status.ts
src/workflow/background.ts
tests/adapters/workflow-notice.test.ts
tests/commands/task.test.ts
tests/config/agent-background-only.test.ts
tests/config/agent-config.test.ts
tests/core/usage.test.ts
tests/delivery/format.test.ts
tests/feishu-notify/core.test.ts
tests/fixtures/fabric-xs-off-golden.json
tests/fixtures/schedule-off-golden.json
tests/fixtures/tools/agent-nested-surface-golden.json
tests/hud/footer.test.ts
tests/integration/child-bash-exit-facts.test.ts
tests/integration/child-compaction-failure.test.ts
tests/integration/consult-legacy-entries.test.ts
tests/integration/explicit-timeout-e2e.test.ts
tests/integration/explicit-timeout-producers.test.ts
tests/integration/notification-complement.test.ts
tests/integration/stack-terminal-failure.test.ts
tests/integration/task-command.test.ts
tests/integration/timeout-policy-persistence.test.ts
tests/integration/workflow-background-wiring.test.ts
tests/integration/workflow-grace-wiring.test.ts
tests/runtime/runner-start-errors.test.ts
tests/runtime/tool-scope.test.ts
tests/schedule/agent/note.test.ts
tests/schedule/agent/report-file.test.ts
tests/service/spawn-service.test.ts
tests/tools/agent-tool.test.ts
tests/tools/extend-timeout-tool.test.ts
tests/tools/model-facing-strings.test.ts
tests/tools/result-text.test.ts
tests/tools/result-tool.test.ts
tests/tools/result-wake.test.ts
tests/tools/workflow-management.test.ts
tests/tools/workflow-tool.test.ts
docs/dev/result-tool-rename/golden-assert.mjs
src/core/tool-names.ts
src/tools/result-tool-activation.ts
tests/conformance/result-tool-rename.test.ts
tests/core/tool-names.test.ts
tests/tools/result-tool-activation.test.ts
```

## 遗留

- P2/P3 未做；web UI 在 P2 合入前新名卡片回落 `<pre>`。
- 真机 smoke（plan §7.4 S1–S4）未做；若服务端对历史旧名调用返回 400，按 r3 停工另立方案。
- `src/web-hub/ui/**`、`tests/web-hub/ui/**`、README/docs/skills 里仍有旧名（P2/P3 范围）。
