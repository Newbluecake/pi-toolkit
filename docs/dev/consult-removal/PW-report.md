# PW — workflow experts removal report

基线：`dev@b8f9a43e`。按 `docs/dev/consult-removal/plan.md` r3 §3、§4.1、PW 文件域及 Q4 实施；仅修改附录 A 的 PW 文件，另新增本报告。未运行全量测试。

## 最终行为

- `agent(prompt, opts)` 只允许 `label, agentType, phase, fullResult, model, thinking, isolation` 七个 key。
- `experts` 是未知 key，返回专用英文提示 `opts.experts is no longer supported; expert consultation has been removed. Use message_agent to ask the parent agent.`，同时列出七个 allowed keys。`experts: []`、`experts: undefined` 和不可克隆值也拒绝；不会读取未知 key 的 getter 或把其值发给 host。脚本可 `.catch()` 后继续普通调用。
- 删除 expert-scope 实现、host 的解析/白名单/专家诊断生产及 replay 的 `experts` 输入和 skip reason。
- 保留 `replayTainted` / `chain_tainted`、isolation 准入、taint、verify 和链摘要 fold。拒绝的 experts 调用发生在 journal bookkeeping 前，不改变后续 task identity、taint 或 fold。
- 阶段 1 兼容接口仍保留：`WorkflowChildSpawnerOptions.resolveExperts?`、`ChildSpawner.resolveExperts?`、spawn request 的 `consultExperts?` 均标 `@deprecated #40 — removed in PS1b`。适配器不读取/调用 resolver；旧 `consultExperts` 请求透传仍保留至 PS1b。
- `journal.ts` 的解析器保持不变；replay 测试验证旧条目附带 experts/consultExperts/skipReason 额外字段仍可解析，投影后的 digest 与 replay identity 不变。

## 测试迁移

- 删除 expert-scope 专属测试；host admission 改测专用拒绝、零派发/零写入/不 taint，以及拒绝后继续派发。
- real-worker 与 integration 覆盖 `.catch()` 恢复后经 production spawner-adapter 正常派发，resolver 不调用、spawn 请求不含 consultExperts。
- 原 experts taint seeded property 改为 24 seeds 的拒绝无副作用测试；普通调用跨两次运行正常 journal/replay，且与删除拒绝调用后的 journal 完全一致。
- isolation property 遍历 chain/content × verify/off × 5 个隔离位置，验证 taint、fold、journal 数量与 replay。既有 content+verify isolation 命中会在 live admission 前返回，不重新 taint，此语义保留。
- host-iso-fold 原 experts_unresolved 用例改为 invalid_args 在 journal 前拒绝，验证后续摘要仍是 CHAIN_SEED；其他 fold property 和隔离测试保持通过。
- integration 旧 workflow-experts 用例整体改为移除入口的回归；consult-wiring 独立定向测试继续通过，证明 stack deprecated 接口仍兼容。

## 改动文件（绝对路径）

- `/tmp/pi-subagent-worktrees/r_TAZ53FHJ/src/tools/workflow-tool.ts`
- `/tmp/pi-subagent-worktrees/r_TAZ53FHJ/src/workflow/agent-opts.ts`
- `/tmp/pi-subagent-worktrees/r_TAZ53FHJ/src/workflow/expert-scope.ts`（删除）
- `/tmp/pi-subagent-worktrees/r_TAZ53FHJ/src/workflow/host.ts`
- `/tmp/pi-subagent-worktrees/r_TAZ53FHJ/src/workflow/replay.ts`
- `/tmp/pi-subagent-worktrees/r_TAZ53FHJ/src/workflow/spawner-adapter.ts`
- `/tmp/pi-subagent-worktrees/r_TAZ53FHJ/src/workflow/types.ts`
- `/tmp/pi-subagent-worktrees/r_TAZ53FHJ/src/workflow/worker-source.ts`
- `/tmp/pi-subagent-worktrees/r_TAZ53FHJ/tests/integration/workflow-experts.test.ts`
- `/tmp/pi-subagent-worktrees/r_TAZ53FHJ/tests/tools/workflow-tool.test.ts`
- `/tmp/pi-subagent-worktrees/r_TAZ53FHJ/tests/workflow/agent-opts.test.ts`
- `/tmp/pi-subagent-worktrees/r_TAZ53FHJ/tests/workflow/expert-scope.test.ts`（删除）
- `/tmp/pi-subagent-worktrees/r_TAZ53FHJ/tests/workflow/host-iso-fold.property.test.ts`
- `/tmp/pi-subagent-worktrees/r_TAZ53FHJ/tests/workflow/host.test.ts`
- `/tmp/pi-subagent-worktrees/r_TAZ53FHJ/tests/workflow/replay-taint-isolation.property.test.ts`
- `/tmp/pi-subagent-worktrees/r_TAZ53FHJ/tests/workflow/replay-taint.property.test.ts`
- `/tmp/pi-subagent-worktrees/r_TAZ53FHJ/tests/workflow/replay.test.ts`
- `/tmp/pi-subagent-worktrees/r_TAZ53FHJ/tests/workflow/spawner-adapter.test.ts`
- `/tmp/pi-subagent-worktrees/r_TAZ53FHJ/tests/workflow/worker-host-call.test.ts`
- `/tmp/pi-subagent-worktrees/r_TAZ53FHJ/docs/dev/consult-removal/PW-report.md`（本报告）

## 自验命令及尾部

所有下列验证均成功；shell 管道启用 `pipefail`，命令有外层 timeout。

```sh
rg -n "expert-scope" src tests
# 无输出，rg exit 1（符合 §4.3 PW 空结果预期）

rg -n "resolveExperts|consultExperts|@deprecated #40" src/workflow
# 仅 host.ts / spawner-adapter.ts 的 deprecated 接口与旧请求透传。
# 不再有 resolver 调用或 host 的 experts 请求生产。

rg -n 'reason: "experts"|readonly experts\?: boolean|input.experts' src/workflow/replay.ts
# 无输出，rg exit 1。

npx vitest run tests/workflow tests/tools/workflow-tool.test.ts tests/integration/workflow-experts.test.ts tests/integration/consult-wiring.test.ts
# Test Files  36 passed (36)
#      Tests  682 passed (682)
#   Duration  32.22s

npm run typecheck 2>&1 | tail -3
# > pi-toolkit@0.8.1 typecheck
# > tsc --noEmit -p tsconfig.json && tsc --noEmit -p tsconfig.typecheck.json && vue-tsc --noEmit -p src/web-hub/ui/tsconfig.json
# exit 0

npm run build
# > pi-toolkit@0.8.1 build
# > tsc -p tsconfig.build.json
# exit 0

npx prettier --check <本节清单中所有存在的改动文件，含本报告>
# All matched files use Prettier code style!

git diff --check
# 无输出，exit 0

git diff b8f9a43e -- tests/fixtures | wc -l
# 0

git log --oneline b8f9a43e..HEAD
# 提交完成后在交付摘要中记录实际输出；本报告与实现同一提交。
```

未修改 fixtures、其他包或 workflow README（README 更新明确归 PS2）。node_modules 只临时链接主仓依赖，不纳入提交，提交后移除并确认 `git status --short` 为空。未使用 stash、reset 或 `git add -A`。

## 遗留 / 交接

- 无 PW 阻塞项。PS1b 按方案物理删除上述 deprecated 接口和旧请求透传；PS2 负责 workflow README 中历史 experts 描述。它们不是本包遗漏。
- 独立异源 verifier 由 root 调度；本报告仅记录实施自验，不宣称独立验收已完成。
