# 源码治理第二批 · ⑧ settings 子系统化实施报告（gov/step8）

> 基线 `dev@90dbb88e`。范围：`batch2-plan.md` §5 全部 + §0 总约束 + 文末拍板（D8-1 保留类型 `export type … from` 再导出；
> D8-2 规则不放宽、文件集合可变；D8-3 `setting-specs.ts` 本批分片并作为最后一个功能提交）。
> 未触碰 `src/stack.ts`、`src/index.ts`、`src/secure/**`（`git diff 90dbb88e -- src/stack.ts src/index.ts src/secure` 为空）。

## 行数前后

| 文件                                                                                                                                                       | 前（90dbb88e） | 后                                                                              |
| ---------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------- | ------------------------------------------------------------------------------- |
| `src/config/settings.ts`                                                                                                                                   | 3846           | **947**（目标 ≤1000）                                                           |
| `src/config/setting-specs.ts`                                                                                                                              | 1442           | **342**                                                                         |
| 新增 `<子系统>/settings.ts`（21 个，含 `delivery/extend-settings.ts`、`service/dispatch-settings.ts`）+ `config/enabled-group.ts` + `fabric/xs/receive.ts` | —              | 合计 3217 行（最大：`web-hub/agent/settings.ts` 687、`fabric/settings.ts` 581） |
| 新增 `<子系统>/setting-specs.ts`（18 个）+ `config/spec-helpers.ts`                                                                                        | —              | 合计 1330 行（最大：`web-hub/agent/setting-specs.ts` 314）                      |

`config/settings.ts` 现在只剩：读文件 / 迁移 / 锁（`prepareSettingsFile`、`loadSettingsFromFile`、`readSettingsNoMigrate`、
`persistSettingOverride` 及三个 `loadXxxWarnings`，#54 的文件名解析/迁移/锁整段原样保留）、`AgentSettings` 聚合、
`DEFAULT_SETTINGS`、`mergeBudget/mergeSettings`、`TIME_SETTING_MS_PATHS`、`parseSettingsSource` 编排、secure-domain 覆盖。
子系统类型在其中以 `export type {…} from` 再导出（D8-1）；值不再再导出（唯一例外见「遗留」第 1 条）。

## 提交列表（26 个，`90dbb88e..HEAD`）

1. `45ee9e27` test(config): pin the settings parse output byte for byte before the ⑧ decomposition`
2. `ac5628e6` refactor(fabric): move fabric settings into fabric/settings.ts`
3. `6a06ae13` refactor(web-hub): move webHub and feishuBot settings into web-hub/agent/settings.ts`
4. `de676e7c` refactor(cache-ttl): move cacheTtl settings into cache-ttl/settings.ts`
5. `2bee2a56` refactor(quota): move quota settings into quota/settings.ts`
6. `067efba2` refactor(sysload): move load settings into sysload/settings.ts`
7. `0df0825b` refactor(compact-hint): move compact settings into compact-hint/settings.ts`
8. `9529d7c8` refactor(bash): move bashJobs settings into bash/settings.ts`
9. `fdf37878` refactor(memory): move memory settings into memory/settings.ts`
10. `ef9ca395` refactor(workflow): move workflow settings into workflow/settings.ts`
11. `17206d34` refactor(traffic): move traffic settings into traffic/settings.ts`
12. `61a1905f` refactor(schedule): move schedule settings into schedule/settings.ts`
13. `79238cf7` refactor(external-agent): move externalAgents settings into external-agent/settings.ts`
14. `7ef7e0db` refactor(config): move the shared EnabledGroup helper into config/enabled-group.ts`
15. `1f19b8ec` refactor(ask-user): move askUser settings into ask-user/settings.ts`
16. `d6e8ff35` refactor(todo): move todo settings into todo/settings.ts`
17. `84bd1187` refactor(hud): move hud settings into hud/settings.ts`
18. `bdfb2d9f` refactor(goal): move goal settings into goal/settings.ts`
19. `d17f2c82` refactor(title): move title settings into title/settings.ts`
20. `fb3d92bc` refactor(reload): move reload settings into reload/settings.ts`
21. `1c1783ea` refactor(sysprompt): move systemPrompt settings into sysprompt/settings.ts`
22. `b05d0fea` refactor(delivery): move extend settings into delivery/extend-settings.ts`
23. `9384d592` refactor(service): move agent dispatch settings into service/dispatch-settings.ts`
24. `260d40a1` refactor(config): tidy the settings.ts header after the subsystem split`
25. `cfa5c2dc` test(config): pin SETTING_SPECS order and content before sharding it`
26. `fd2202af` refactor(config): split SETTING_SPECS into per-subsystem setting-specs.ts shards`

每个子系统提交的模式相同：把类型 + 默认值 + 纯解析整段移到 `<子系统>/settings.ts`（文本不改，只补 `export`/导入）；
`DEFAULT_SETTINGS` 里对应的内联字面量原样提成 `DEFAULT_<X>_SETTINGS`（同一个对象、同样的键序），parser 里的
`DEFAULT_SETTINGS.<x>` 改读它；值导入方（src/tests/scripts，含两处字符串内嵌的 `import`）改指新路径；边界表同步。

映射（§5 表 + 小块）：fabric → `fabric/settings.ts`（`effectiveReceive`/`isValidXsSessionId`/`FABRIC_XS_SESSION_ID_RE` →
`fabric/xs/receive.ts`，第一批 Q1）；webHub + feishuBot → `web-hub/agent/settings.ts`；cacheTtl；quota；load → `sysload/settings.ts`；
compact → `compact-hint/settings.ts`；bashJobs → `bash/settings.ts`；memory；workflow（含 `WorkflowBudget`/`DEFAULT_WORKFLOW_BUDGET`）；
traffic；schedule；externalAgents → `external-agent/settings.ts`；共用的 `EnabledGroup`/`parseEnabledGroup` → `config/enabled-group.ts`；
askUser；todo；hud；goal；title；reload；systemPrompt → `sysprompt/settings.ts`；extend → `delivery/extend-settings.ts`；
agent dispatch → `service/dispatch-settings.ts`。

## 零行为证据

1. **语料（第 1 个提交，基线上采集）**：`tests/config/settings-corpus.test.ts` + `tests/config/__corpus__/settings-corpus.json`。
   对 `loadSettings()`（= `applySecureDomainOverrides(parseSettingsSource())`）逐字节比对 `JSON.stringify`（带 undefined/NaN/∞ 标记，**键序在内**）：
   - `DEFAULT_SETTINGS` 序列化（值 + 键序）；
   - 368 个去重后的 `tests/config/**` 真实输入（插桩捕获）；
   - 300 个 seeded 整文件随机变异 + 644 个按顶层块的随机变异（由冻结在语料里的 DEFAULT_SETTINGS 模板和固定 seed 生成，
     与被测代码无关；变异覆盖错类型/越界/null/`*S` 秒键/未知键/键序打乱）；
   - 每个用例同时锁住解析期间的 `console.warn` 行，以及把同一输入写文件后 `loadWebHubLanSettingsWarnings` /
     `loadWebHubProxyWarnings` / `loadFeishuBotWarnings` 的输出（web-hub / feishu 块 parser 返回的 warnings 因此也被钉住）。
     语料存 sha256（不存 5KB 输出，文件 160KB）；失败时 `GOV_CORPUS_DUMP=<dir>` 导出实际串可与基线 diff。
     **灵敏度验证**：人为把 `coalesceWindowMs` 上限 5000→5001、`hintThresholdTokens` 500→501、`maxPendingPerTarget` 3→4，三种篡改均被测试抓到。
     基线 worktree（`git worktree` 的 90dbb88e）上同一份语料测试 4/4 通过，确认语料确实来自基线。
     26 个提交里每一个提交前该测试都通过（每步 `tests/config` 整目录含它）。
2. **`DEFAULT_SETTINGS` 深相等 + 键序**：同上语料第一条（sha 与冻结模板双重比对）。
3. **`tests/ui/settings-editor*`**：断言未改；唯一改动是 `settings-editor.test.ts` 把 `DEFAULT_WORKFLOW_BUDGET` 的导入路径从 `config/settings.js`
   改到 `workflow/settings.js`（该符号随 workflow 移走，不留垫片）。
4. **`setting-specs` 分片**：先单独提交 `tests/config/setting-specs-pin.test.ts`（基线上采集：289 个存储键的列表顺序 + 每个 spec 的 sha256 + 整体 sha），
   再分片；分片后该测试与 `settings-editor*` 均未改动通过。脚本在分片前断言每个子系统的条目在原表里是连续一段（单例键 `extend`×2、`hud`、`webSearch`、`date`、
   `feishuNotify`、`sessionNav`、`reload`、`worktree`、`fleet*` 与别的组交错，留在聚合文件里），因此 spread 位置 = 原位置。
5. **A 档 golden**：`tests/integration/secure-off-golden.test.ts`（含 `defaultSettingsUnchanged`、`loadSettingsIdentity`）每步通过；
   `git diff --quiet 90dbb88e -- tests/fixtures/` 通过（零 diff）。
6. **边界（D8-2）**：`tests/web-hub/boundary.test.ts` 的 `SYSLOAD_FILE_CLOSURE` 同步更新——`config/settings.ts` 的值导入集合换成各子系统 settings 文件
   （不再直接导入 `cache-ttl/keepalive-state`、`compact-hint/threshold`、`sysload/types`、`memory/tidy/batch-settings`、`fabric/xs/channel`、
   `web-hub/protocol/{lan,client-allow}`、`config/model-hint`），新增 21 个子系统文件各自的精确值导入表（多数是 `[]`，其余只导入同目录的纯文件
   或 `protocol/lan`/`protocol/client-allow`/`config/model-hint`）。没有放宽：闭包里仍无 pi 值导入、无 hub 白名单之外的值导入。
7. **反向值边**：`config/settings.ts` 不再值导入 `cache-ttl/keepalive-state`（`MAX_SAFE_KEEPALIVE_INTERVAL_MS` 现由 `cache-ttl/settings.ts` 在 cache-ttl 内部导入）。
   新文件不引入模块级 `let`/`var`（grep 为空）；没有任何子系统 settings 文件值导入 `config/settings.ts`。

## 最终自验

| 命令                                                                                                                                                                                                                             | 结果                                           |
| -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------- |
| 每步 `tsc --noEmit -p tsconfig.json` + `-p tsconfig.typecheck.json` + `vitest run tests/config tests/ui tests/web-hub/boundary.test.ts tests/integration/secure-off-golden.test.ts` + 该子系统自己的测试目录（`--maxWorkers=3`） | 全绿                                           |
| `npm run typecheck`（含 vue-tsc）                                                                                                                                                                                                | 通过                                           |
| `npx vitest run tests --maxWorkers=3 --exclude 'tests/secure/**'`                                                                                                                                                                | 1521 files、28647 passed、26 skipped、0 failed |
| `npm run test:conformance`                                                                                                                                                                                                       | 35 files、361 passed、16 skipped               |
| `npm run format:check`                                                                                                                                                                                                           | 通过                                           |
| `npm run build`                                                                                                                                                                                                                  | 通过                                           |
| `git diff --quiet 90dbb88e -- tests/fixtures/`                                                                                                                                                                                   | 零 diff                                        |

## 遗留 / 需要后续处理

1. **临时值再导出**：`config/settings.ts` 里保留了 `export { DEFAULT_DYNAMIC_THRESHOLD_SETTINGS }`（带 TEMPORARY 注释），原因是 `src/stack.ts:17`
   仍从 `config/settings.js` 导入它，而 `stack.ts` 属 7b 的文件域、本任务禁止触碰。**7b 合入后一行收尾**：把 `stack.ts` 的导入改指
   `./compact-hint/settings.js`，并删除 settings.ts 中这条再导出（只用于这一个符号；删除后边界表不用改）。
2. **`tests/secure/**` 未跑**（按任务口径排除）。`secure-off-golden` 与 secure 相关的 settings 路径（`applySecureDomainOverrides`、D8 强制关闭）仍在聚合文件里，原样。
3. 全量前我在某次 `tests/web-hub/agent + protocol + commands` 的混合并行运行里见过 1 个失败，同一组合重跑与单跑均通过，最终全量 0 失败；
   未查明是哪个用例（疑似负载下的计时用例），非本次改动引入的迹象。
4. 文档：AGENTS.md「Repository layout」的 `src/config/` 行仍写 “agent-type registry, fuzzy model hints, settings file”，没有提到 settings 已按子系统分布。
   未改（范围外），建议下批文档整理时补一句「各块的类型/默认值/解析在 `<子系统>/settings.ts`，`config/settings.ts` 只聚合」。
5. 小的形态残余：部分文件里 `DEFAULT_<X>_SETTINGS` 放在 parser 之后（运行时只在调用时读取，无 TDZ 问题）；`parseXxx` 里原有的注释仍提到
   `DEFAULT_SETTINGS.<x>` 的改成了对应常量名；`parseWorktree` 仍是 `parseSettingsSource` 里的内联块（类型已在 `extensions/worktree-settings.ts`，不在 §5 表内）。
6. 工具说明：移动用的是一次性脚本（按声明范围机械剪贴 + `tsc` 驱动补导入），不进仓库；未使用的导入由脚本按标识符出现与否清理，
   遇到只在注释里出现的标识符会保守保留（`parseStrictModelRef` 一例已手工删除）。
