# P3 报告 — 文档/skills 改新名 + 迁移说明 + 残留门禁

基线 HEAD 8ef0e7d3，零 git 写操作，未动 tests/fixtures。

## 改动文件（前缀 /home/bluecake/ai/pi-toolkit/）

- 旧名→新名：`package.json`、`README.md`、`README.en.md`、`AGENTS.md`、`docs/guide/subagents.md`、`docs/guide/context.md`（门禁扫出）、`docs/dev/{web-hub,subagent-core,fabric-cross-session,external-agent,context-switch,scheduled-reports}/README.md`、`skills/dev-flow/SKILL.md`、`skills/dev-flow/references/subagent-workflow.md`。`docs/dev/deferred-reload/README.md` 无旧名，未改。
- `scheduled-reports/README.md:9` 另把已删除的 `SCHEDULE_RESULT_TOOL` 改为 `src/core/tool-names.ts` 的 `RESULT_TOOL_NAME`（原名保留为历史说明）。
- `docs/guide/subagents.md`：加「原名 …」说明与迁移链接。
- `docs/guide/migration.md`：新增「结果工具改名」一节（新名；旧会话 resume/fork//resume//tree 自动启用，带 `--tools`/`--exclude-tools`/`--no-tools` 不自动；TUI/web 历史卡片；飞书 waitNotifyTools 自动映射；需手动改 `--tools`/`defaultTools`/traffic 规则/自写 prompt；cache miss；真机 smoke 结论）。
- `README.md`/`README.en.md` 的迁移指南索引行补一句。
- 新增 `tests/boundary/result-tool-residue.test.ts`。

## 残留门禁

扫描：src/、tests/、skills/、docs/guide/、docs/dev/_/README.md（仅一级 README）、根 README_.md、AGENTS.md、package.json。不扫：CHANGELOG、docs/research、scripts、docs/dev 非 README 档案。needle 运行时拼接，不自命中。

允许列表为「文件 → 精确次数 + 理由」，故允许文件内多一处也失败：

| 文件                                                                                                                                                                   | 次数           | 理由                      |
| ---------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------- | ------------------------- |
| src/core/tool-names.ts                                                                                                                                                 | 1              | LEGACY 常量               |
| src/runtime/tool-scope.ts                                                                                                                                              | 1              | 保留名注释（golden 冻结） |
| src/tools/result-tool.ts                                                                                                                                               | 2              | 注释：原名/历史 renderer  |
| src/tools/result-tool-activation.ts                                                                                                                                    | 1              | 迁移代码注释              |
| src/feishu-notify/core.ts                                                                                                                                              | 1              | 映射注释                  |
| src/web-hub/ui/src/logic/tools.js                                                                                                                                      | 2              | 历史 transcript 旧名      |
| src/web-hub/ui/src/components/transcript/ToolCard.vue                                                                                                                  | 2              | 同上                      |
| tests/{core/tool-names,runtime/tool-scope,tools/result-tool,tools/model-facing-strings,feishu-notify/core,conformance/result-tool-rename,web-hub/ui/tool-card}.test.ts | 1/2/2/1/3/2/15 | 兼容/迁移测试             |
| tests/fixtures/fabric-xs-off-golden.json                                                                                                                               | 1              | 保留名列表                |
| tests/fixtures/preview-perf/stack-3609.ts.txt                                                                                                                          | 1              | 预览语料                  |
| docs/guide/migration.md                                                                                                                                                | 3              | 兼容说明                  |
| docs/guide/subagents.md                                                                                                                                                | 2              | 原名说明 + 迁移锚点       |
| docs/dev/scheduled-reports/README.md                                                                                                                                   | 1              | 历史说明                  |

## 变异证明

1. `skills/dev-flow/SKILL.md` 末尾加一处旧名 → 失败：`expected ['skills/dev-flow/SKILL.md x1'] to deeply equal []`；撤回后恢复。
2. 在允许文件 `src/core/tool-names.ts` 多加一处 → 失败：`expected 1, found 2`；撤回。
   （撤回后 SKILL.md/tool-names.ts 仅剩本包预期改动。）

## 自验

- `npm run typecheck`：无错误输出。
- `npx vitest run tests/boundary tests/conformance/result-tool-rename.test.ts tests/docs --maxWorkers=4`：4 files / 51 passed。
- `npm run format:check`：通过。
- `git diff --quiet HEAD -- tests/fixtures/`：干净。
- 未跑全量 `npm test`（本包只动文档 + 一个只读扫描测试）。

## 建议 commit message

```
docs: rename get_subagent_result to get_run_result in guides and skills

Update README/AGENTS/guides/subsystem READMEs/dev-flow skill to the new
result-tool name, add upgrade notes to docs/guide/migration.md, and add a
residue gate (tests/boundary/result-tool-residue.test.ts) with a per-file
exact-count allow-list for legacy-name uses.
```
