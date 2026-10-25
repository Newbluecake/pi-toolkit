# #40 彻底移除 consult 子系统 — 施工方案（r3，S0 坐标已刷新，待开工）

> 状态：r2，按评审（gpt-6.1-sol：1 Blocker / 4 Major / 4 Minor）和主会话排期裁定修订。用户已拍板的内容见文末「用户拍板（2026-10-25）」，与该节冲突的以该节为准。
> **排期**：#40 的全部包都 **blockedBy 低风险治理批**（`docs/dev/source-governance/plan-lowrisk.md`，合入顺序 P6B→P2→P3→P6M→P1）**整批合入**之后才开工，第一步是 §4.0 的 S0 坐标刷新。两者不再并行。
> 基线：**r3 起坐标以 dev @ `88da5b81` 为准**（S0 于 2026-10-25 完成，结果见 §4.0.1）。低风险批对 #40 文件域的改动只有：`ui/fleet-panel.ts` 少 5 行、几处 import 行替换（`index.ts`/`stack.ts`/`commands/{schedule,status}.ts`/`web-hub/agent/index.ts`，这些文件行数不变）。所以 §1.3 的其余坐标与 b667d880 相同，已逐项复核。

## 修订记录

### r3（2026-10-25，S0 坐标刷新）

1. **前置确认**：低风险批 17 个提交（P6B、P2×4、P3×2、P6M×4、P1×4、302223c5、88da5b81）、#43 的 2 个提交、本方案 2c019f17，全部在 dev 祖先链上（§4.0.1 表）。
2. **路径替换**：按 P6M/P2/P3 报告套用。#40 文件域里需要更新的只有 `src/cache-ttl/keepalive-service.ts`（原 `service/cache-keepalive.ts`，只有注释命中，不改）和 `ui/fleet-panel.ts` 的行号（consult 行改为 :16、:104-108、:404、:454）。bash/context/compact 工具、command-capture、redact、rpc/client 的移动不触及 #40 文件域；`tests/tools/model-facing-strings.test.ts` 和 `commands/schedule.ts` 的 import 已被 P6M 改过，PT 在新内容上修改。
3. **grep 增删**（相对 r2/b667d880）：src 命中文件少了 `service/cache-keepalive.ts`、`tools/bash-tool.ts`，多了 `cache-ttl/keepalive-service.ts`、`bash/tool.ts`，四处都是英文动词或注释，不改。tests 少了 `web-hub/agent/command-capture.test.ts`，多了 `commands/capture.test.ts`（注释）和 **`tests/docs/agents-md.test.ts`**（K2 套件名单里有 `consult-preserve`，自带门控；K8 链接存在性），后者归 PS2。字符串复核新增 `extend-timeout-tool.ts:239`（工具描述，模型可见）归 PT，`settings.ts:1725` 归 PS2，`SchedulePanel.vue:16`（模板注释）不改；`convert.mjs` 行号变为 :2734。
4. **闭合检查基线**（§4.3.1）：`expert-scope` 的导入方多了 `tests/workflow/host.test.ts`、`tests/integration/workflow-experts.test.ts`，都在 PW 域内，闭合。**新发现**：`tests/service/spawn-service.test.ts:172-250` 断言 resume 原样继承带 `abArm` 的 META（:204 `toEqual(META)`），PT 的 `pickInheritableDispatchMeta` 会让它失败，所以**并入 PT 文件域**。`tests/service/runtime-adapter-instrumentation.test.ts:101` 只是原样镜像，不受影响，列入 abArm 允许列表（PS1a 处理）。
5. **P1 搬迁清单落到 PS2**（§4.2 PS2 表按实际行号重写）：AGENTS.md :82（peer bump 第 2 条的 consult-preserve）、:95、:110（`src/consult/` 行）、:134、:139；README 共 9 份 17 处，另有 `docs/dev/consult/README.md` 整删。`web-hub/README.md:201`、`fabric-cross-session/README.md:205` 是英文动词，不改。PS2 文件域加入 `tests/docs/agents-md.test.ts`（K2 名单去掉 `consult-preserve`）。
6. **P3 影响**：P3 没有删除 #40 依赖的导出。`core/message.ts` 只删了 `isMessageKey`，`WakeExclusion` 不受影响；P2 有意保留了 `consult/tool.ts` 自己的 `isTerminalStatus` 副本，它随 PS1b 删除。
7. **#43 已合入**：PS1b 改 `tests/secure/guard-points.test.ts` 不再需要等待（§4.2、§4.4）。
8. **冲突预检**：附录 A 的 spec 跑 `conflict-check.mjs` 结果 exit 0，五包零交集。
9. **无新增拍板项。**

- r2.1（2026-10-25，主会话）：复审有条件通过（7/9 闭合），收口两条：PT 的 abArm 检查拆为「生产者/schema」与「旧数据兼容用例精确允许列表」（复审 #1）；PDOC 文件域加入 `scripts/exp/topic-judge-eval/README.md`，只删引用 exp6 脚本的历史先例句（复审 #8）。

### r2（2026-10-25，评审 9 条处置）

| #   | 级别    | 评审意见                                                                                                           | 处置                                                                                                                                                                                                                                                                                                                                                                                                                                    |
| --- | ------- | ------------------------------------------------------------------------------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | Blocker | 阶段 1 各包不能独立验收：P0 删旧常量后仍有测试导入；PD 删模块后 PS1 才删的测试仍导入；`@deprecated` 解决不了值导入 | **采纳**。新增 §4.1「依赖闭合规则」：阶段 1 的包**只迁移消费者、不删任何还被他人导入的导出**。P0 保留 `CONSULT_READONLY_TOOLS` 别名、`consult/watcher.ts` re-export 垫片，`fork-store.ts` 的导出签名不变。PD 只停止调用，`core/consult-cache-marker.ts` 和 `web-hub/agent/consult-transcript.ts` 推迟到 PS1b 物理删除。§4.2 逐包写出「删除 / 保留 / 测试归属」，§4.3 给出逐包闭合检查命令。每包合入后 typecheck 和定向测试必须全绿      |
| 2   | Major   | 测试迁移未闭合（stack-wiring、port、guard-points、hub transcript）                                                 | **采纳**。`tests/schedule/agent/stack-wiring.test.ts:63` 归 PS1b；`tests/external-agent/port.test.ts:220` 归 PT；`tests/secure/guard-points.test.ts:99-112` 归 PS1b，改写为「新清扫的 vault 根选择 + 根外文件不受影响」，`stack-roots` 的真实装配测试保持不动；`tests/web-hub/{hub,ui}/run-transcript.test.ts`、`tests/web-hub/agent/wiring-control.test.ts:590` 归 PD，改用写死的旧 wire entries，保留缺文件、分页、leaf mismatch 断言 |
| 3   | Major   | 与 AGENTS.md 下沉的交接：consult 内容会被原样搬进各子系统 README                                                   | **采纳**。PS2 接收低风险 P1 交付的 `rg -n -i consult AGENTS.md docs/dev/*/README.md` 清单，**拥有这些 README 的修改权**：删功能入口和失效门禁（含 consult-preserve 作为 peer bump 门禁），保留标明 legacy 的磁盘布局和读取兼容说明。验收扫描 AGENTS.md 加全部开发者 README（§4.2 PS2、§4.5）                                                                                                                                            |
| 4   | Major   | 与低风险批并行 / 「schedule 文件搬家」冲突描述错误                                                                 | **采纳主会话裁定**。改为串行（全部 blockedBy 低风险 P1）；新增 §4.0 S0 坐标刷新；r1 §4.4 整表删除，含错误的「治理 #6 schedule 文件搬家」一行                                                                                                                                                                                                                                                                                            |
| 5   | Major   | `src/quota/render.ts:212` 是真实模型提示                                                                           | **采纳**。纳入 PT：只删「consult/」，保留「外部 Droid 以完整权限运行（不是 pi 子 agent），不能当验收」；测试 `tests/quota/{gate:923,hook:927,render:1212,1237}` 同步改。§1.3 新增「字符串命中复核」表：逐个区分注释与返回字符串，另外找出 3 处真实字符串（`setting-specs.ts:114`、`extend-timeout-tool.ts:126`、`secure/command.ts:131`）并分别归属                                                                                     |
| 6   | Minor   | 活动文档、演示、样式遗漏                                                                                           | **采纳**。PDOC 加入 `docs/guide/subagents.md:88-97,110`、`docs/guide/quota-load.md:45`、`scripts/dev/readme-shots/{make-fixture.mjs:274-284,tui/demo-ext.ts:72-85,README.md:15}`；`docs/dev/external-agent/README.md:73` 是低风险 P1 的追加目标，归 PS2。PD 加入 `styles/drawer.css:178-200`（`.run-tx-consult*`、`.run-tx-cachemark`），FleetTree 的 `run-cachemark` span 随渲染一起删                                                 |
| 7   | Minor   | nested golden 允许的 diff 过窄                                                                                     | **采纳（细化，不改变拍板）**。允许的差异 = 删掉 `properties.experts` 加上 `timeout_s.description` 去掉「consult, 」示例；其余字段、key 顺序、顶层 `description` 必须字节相同。PT 用 §4.5 的断言脚本核对，不做无约束重生                                                                                                                                                                                                                 |
| 8   | Minor   | PDOC「grep 必须为空」不可达                                                                                        | **采纳**。改为「活动文档零残留 + 历史文档精确允许列表 + 活动链接不指向被删的脚本或 skill」（§4.5 PDOC、PS2）                                                                                                                                                                                                                                                                                                                            |
| 9   | Minor   | 每包全量测试与 dev-flow 冲突；建议 PS1 再拆                                                                        | **采纳**。开发包只跑定向测试 + typecheck + format:check；verifier 查 diff 和关键定向门禁；全量由主会话在集成点 I1–I4 统一跑（限并发）。PS1 拆为 **PS1a 运行时/service 清理**（保留兼容接口，`src/consult/` 仍能编译）和 **PS1b 装配/类型物理删除**，两个串行验收点                                                                                                                                                                      |

**是否新增需用户拍板项：否。** 第 7 条是对已拍板 Q1 的范围细化，主会话已转述用户批准一次性更新。其余都是工程处置。

### r1（2026-10-25）

初稿，已被评审打回。

---

## 0. 需求摘要

- 用户 2026-10-25 拍板「彻底移除」consult：A/B 显示挂专家组一次通过率 52.5%，对照组 66%，成本更高；77% 挂专家的包从未调用。skill 已改为「子 agent 用 `message_agent` 问父 agent」（bbb88ba1）。
- 删除范围：`consult` 工具；`Agent({experts})`、workflow `agent({experts})`、保留的 `"main"` expert；`consult.*` 设置；C2 preserve（expert-keepalive）；consult A/B 埋点（`diag.experts`、`diag.consults`、`meta.abArm`）和分析脚本；AGENTS.md 及下沉 README 里的 consult 入口和「consult-preserve 是 peer bump 门禁」的条目；`tests/conformance/consult-preserve.test.ts` 等。
- 迁移保留三项共享资产：`CONSULT_READONLY_TOOLS`、`createCapWatcher`、`consultSessionDir`。
- 兼容：旧会话条目、旧 settings、旧 prompt 习惯、新旧 hub/agent 混跑，读取路径一律容忍（忽略、不报错）。
- 冻结面不动：3 份 fabric off golden、keepalive-legacy golden、secure-off golden、schedule-off golden、`tests/fixtures/legacy-xs-v071/`。
- 排期：等低风险治理批整批合入后串行开工，先做 S0 坐标刷新。

---

## 1. 影响面清单（坐标 @88da5b81，S0 已刷新）

### 1.1 冻结物核查

| 冻结物                                                                                                                                                                                    | consult/experts 命中                                                                                                                        | 结论                                                                                                                 |
| ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------- |
| `tests/fixtures/fabric-xs-off-golden.json`                                                                                                                                                | **1 处**：`reservedToolNames` 里有 `"consult"`（来源 `src/runtime/tool-scope.ts:21 RESERVED_TOOL_NAMES`）                                   | **`RESERVED_TOOL_NAMES` 必须保留 `"consult"`**，注释改为 legacy + golden 冻结。它只会剥掉同名的 MCP/后注册工具，无害 |
| `fabric-wake-off-golden.json`、`fabric-xs-reply-off-golden.json`、`web-hub-ui/keepalive-legacy-golden.json`、`secure-off-golden.json`、`schedule-off-golden.json`、`legacy-xs-v071/`      | 0                                                                                                                                           | 不受影响；集成点 I1–I4 都跑对应测试，确认字节不变                                                                    |
| `memory-legacy-golden.json`、`tests/fixtures/memory/**`                                                                                                                                   | 有（冻结的记忆**文本内容**）                                                                                                                | 不是代码契约。**禁止改 `tests/fixtures/memory/**`**                                                                  |
| `tests/fixtures/tools/agent-nested-surface-golden.json`                                                                                                                                   | 有：`properties.experts`、`properties.timeout_s.description`（"…with a fixed deadline (consult, /goal verifier, RPC, workflow children)…"） | 按拍板 Q1 在 PT 一次性更新。允许的 diff 见 §4.5 PT（r2 第 7 条）；顶层 `description` 不含 consult，必须不变          |
| 其余 golden（`available-models`、`bash-tools`、`message-agent-wake-schema`、`memory-tool-surface`、`secure-launcher-off`、`feishu-spawn-http`、`compact-hint`、`secure-contract-parity`） | 0                                                                                                                                           | 不受影响                                                                                                             |

### 1.2 src —— 最终整体删除（物理删除全部在 PS1b，P0/PW 例外见 §4.2）

- `src/consult/` 下 14 个文件，共 5505 行。其中 `watcher.ts` 在 P0 变成 re-export 垫片，`fork-store.ts` 的目录函数和清扫在 P0 改为委托给新模块；最终都在 PS1b 删除。
- `src/core/consult-summary.ts`、`src/core/consult-cache-marker.ts`（PD 先停止调用）、`src/web-hub/agent/consult-transcript.ts`（PD 先停止调用）。
- `src/workflow/expert-scope.ts`：在 PW 删除。导入方只有 `workflow/host.ts` 和它自己的测试，都在 PW 文件域内，闭合。

### 1.3 src —— 修改（坐标 @b667d880；括号内是 consult 相关词频）

**核心与运行时**

- `src/core/types.ts`（156，PS1b）
  - 删除：`ConsultExpertRef`、`RunExpertRecord`、`EXPERTS_REFS_CAP`/`capExpertRefs`、`CONSULT_MAIN_EXPERT_ID`、`ForkExpertSessionResult`、`ExpertRequestSnapshot`、`ConsultGuard*`、`ConsultIdentityPrediction`、`ConsultAnchor*`、`ConsultCacheResult`、`ConsultWarmPrediction`、`ConsultThreadRef`、`ConsultCacheDiagnostics`。
  - 删除 `SpawnRequest` 的 `consultSnapshot`/`consultAnchor`/`consultExperts`/`forkSessionFrom`/`consultOf`/`consultCache`/`consultThread`。
  - 删除 `RunDiagnostics` 的 `consultIdentityPrediction`/`experts`/`consultOf`/`consultCache`/`consultThread`/`consults`。
  - 删除 `SessionSpec` 的 `consultAnchor`/`consultGuard`/`consultSnapshot`、`ResolvedSpawnRequest.forkSessionFrom`、session_event `consult_cache_first`（:875）。
  - **保留** `dispatchMeta`、`schemaPreset`。
  - **保留** `displayAgentType()`，并把 `CONSULT_MAIN_AGENT_TYPE` 改名为 `LEGACY_CONSULT_MAIN_AGENT_TYPE`。
- `src/core/state-machine.ts`（33，PS1b）：删掉 :183-209、:729-741、:834-851、:925、:1052-1064。**矩阵和 property 测试同步改**。
- `src/core/run-journal.ts`（17，PS1b）：`JOURNAL_DIAG_FIELDS` 去掉 6 个 consult 字段，删除 :141。
- `src/core/message.ts`（PS1b，只改注释）：`WakeExclusion` 保留 `"consult_fork"`，标注 legacy-read-only。
- `src/core/dispatch-meta.ts`（20，PT）：删除 `abArm`；新增 `pickInheritableDispatchMeta`（§3.2）。
- `src/core/verdict-schema.ts`（PS2，只改注释）。
- `src/runtime/tool-scope.ts`（20）
  - P0：新增 `READONLY_DOMAIN_TOOLS`，**保留** `CONSULT_READONLY_TOOLS` 作为 `@deprecated` 别名。
  - PS1a：`BashJobGrantInput.consult` 改名为 `readonlyDomain`；删除 `reportBlockedOnBind`。
  - PS1b：删除别名；`RESERVED_TOOL_NAMES` 的 `"consult"` 保留并改注释。
- `src/runtime/session-driver.ts`（76，PS1a）：删除 anchor/prefix-probe/preserve 安装、`compareConsultIdentity`、`isConsultForkSpec` 豁免、consult tool_end 分类（:431）、`consultRunId` 吸收（:309-321）、`consult_cache_first` 发射（:1022）。对 `consult-summary`/`fork-store`/`anchor`/`prefix-probe` 的 import 全部去掉。只有 session-driver 自己从 `src/consult/` 拿东西，consult 不依赖 session-driver 的这些导出，所以闭合。
- `src/runtime/runner.ts`（17，PS1a）：`openFile` 改为只看 `resumeFrom`；删除 `consultIdentityPrediction` 透传。`onReaped` 签名到 PS1b 才收窄，PS1a 时 stack 仍按旧签名传参。
- `src/service/runtime-adapter.ts`（157）
  - P0：只改常量名，3 处。
  - PS1a：删除 `isConsultRun`/`consultC2`/shadow/guard/consult 工具注入/`consultDisplayMeta` 使用/`toExpertRecords` 写入 `diag.experts`；`readonlyDomain` 改为只判断 `toolDomain === "readonly"`；StructuredOutput 闸门改为 `!isExternal && schema`；`readonlyProvenance` 闸门改为 `readonlyDomain`。deps 成员 `consult`/`consultResolveExperts`/`consultDisplayMeta` **保留为 `@deprecated` 且不读**，因为 stack 还在传。
  - PS1b：删除这些 deps 成员。
- `src/service/spawn-service.ts`（62，PS1a）：删除 `CONSULT_MAIN_AGENT_TYPE` bypass（:48-62、:690-696）、fork 准入分支（:964-1003）、droid 的 experts/fork 拒绝（:819-823，`MSG_EXPERTS_UNSUPPORTED` 的使用点）、`!req.forkSessionFrom` 的 canSpawn 例外（:898、:1190）、`wakeExclusion` 的 consult_fork 分支（:1216）、D19 里与 fork 相关的部分（:291、:1419，核实后只删 consult 相关部分）、readonly 互斥文案里的 `forkSessionFrom`。
- `src/service/request-threading.ts`（10，PS1a）：删除 4 个 consult 字段条目。
- `src/service/resolve-target.ts`（9）
  - PT：dispatchMeta 继承改用 `pickInheritableDispatchMeta`（:221）。
  - PS1b：删除 ExpertIndex 钩子（:161）。consult 的 `expert-index.ts` 导入了它，所以必须等 PS1b。
- `src/stack.ts`（66）
  - P0：只改 :2266 一行清扫和 import。
  - PS1b：删除 wireConsult/consultRef/previousConsult/consultForkStore/main-facts（:758）/adapter 的 consult deps/onReaped consult 行/`dispatchSnapshot` 分接口（:2963）/workflow 的 `resolveExperts`（:3449-3458）/executors 的 `consult` dep/`StackHandle.consult`。
- `src/index.ts`（9，PS1b）：删除 :977 的 `resolveExperts`，以及 :1474、:1611 两处 `consult.close()`。

**工具、命令、设置**

- `src/tools/agent-tool.ts`（56）
  - PT：两份 schema 去掉 `experts`；`timeout_s.description` 去掉「consult, 」；`meta` 去掉 `abArm`；删除 A/B 一致性校验和 `expertEcho`；新增「收到 `experts` 时忽略并提示」（§3.4）。deps 的 `resolveExperts?` **保留为 `@deprecated` 且不读**，因为 index.ts 和 runtime-adapter 还在传。
  - PS1b：删除这个成员和对 `consult/index.js` 的类型导入。
- `src/tools/result-tool.ts`（11，PD）：停止调用 `formatConsultCacheLine`，去掉 import。
- `src/tools/list-subagents-tool.ts:322`（PT）：模型可见描述。
- `src/tools/extend-timeout-tool.ts:126`（PT）：运行时报错文本里的「e.g. a consult,」；**:239 工具描述里的「(consult, /goal verifier, RPC)」**（r3 新增）。
- `src/tools/workflow-tool.ts:67,87-95`（PW）。
- `src/tools/schedule-tool.ts:100-102,171`（PT）：删除参数。
- `src/commands/schedule.ts:44,77,145-146,204`（PT）。
- `src/commands/status.ts`（PS1b，只改注释）。
- `src/config/settings.ts`（16，PS2）、`src/config/setting-specs.ts`（15，PS2）：删除 :908-932 的 7 个旋钮；**:114 的 `budget.maxTotalFactor` 描述里有「consult,」**（`/agent settings` 可见），同步改。
- `src/external-agent/messages.ts`
  - PT：`capabilitiesText`（:118）、`externalModelsPromptHeader`（:138）。
  - PS1b：删除 `MSG_EXPERTS_UNSUPPORTED`、`msgExpertIsExternal`（PS1a 删掉使用点，`src/consult/index.ts:4` 仍导入 `msgExpertIsExternal`，所以 PS1b 再删）。
- `src/quota/render.ts:201,212`（**PT，r2 新增**）：只去掉「consult/」。

**workflow（PW）**：`host.ts`、`agent-opts.ts`、`worker-source.ts`、`replay.ts`、`types.ts`、`spawner-adapter.ts`（opts 的 `resolveExperts?` 和 `ChildSpawner.resolveExperts?` 保留为 `@deprecated` 且不读，因为 stack 还在填；PS1b 删）、删除 `expert-scope.ts`。`replayTainted`/`"chain_tainted"` **保留**（isolation 在用）。

**schedule（PT）**

- `bg.ts`、`executors.ts`（`consult?` dep 保留为 `@deprecated`）、`view.ts`。
- `schedule/agent/wire.ts` 在 P0 改用新模块。
- `schedule/core/{reader,spec}.ts`、`schedule/agent/ops.ts`、`web-hub/protocol/schedule.ts` **不动**（§3.7）。

**TUI / web 显示（PD）**

- `src/ui/fleet-panel.ts`（P2 D2 后为 :16 import、:104-108 字段、:404 注释、:454 赋值）、`src/ui/fleet-widget.ts`。
- `src/web-hub/agent/{status,run-transcript,index}.ts`：index 改用本地结构类型，不再导入 `ConsultTranscriptDiagnostics`。
- UI：`drawer/RunTranscript.vue`、`fleet/FleetTree.vue`（含 `run-cachemark` span 和 `cacheMarkOf`）、`styles/drawer.css:178-200`、i18n `{zh,en}/{fleet,drawer}.ts`。
- `ScheduleReview.vue` 和 `i18n/schedule-extra.ts` 归 PT。
- **不动**：`src/web-hub/protocol/**`、`src/web-hub/hub/**`（§3.8）。

**不动**

- `src/secure/**` 整体（#43；`domain.ts` 的 `consult` 字段被新模块使用；`bin/{helper,convert,sessions}.mjs` 的 consult-sessions 是 vault 布局和 foreign dir 报告，需要保留）。
- `secure/command.ts:131` 的 `/secure status` 文本「workflows / consult / memory」描述的是 vault 里**仍然存在**的目录（legacy 残留会在 24h 内清空，但目录本身会保留）。按 secure 冻结不改，列为后续项（§5 R-F1）。

*_字符串命中复核（r2 新增；方法：`rg -n -i consult src -g '!src/consult/**' | rg -v '^\S+:\d+:\s*(//|\*|/\*)' | rg -i "[\"'\`][^\"'\`]*consult"`）*_

| 位置                                                                                                                                                                                                                            | 性质                                                | 归属         |
| ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------- | ------------ |
| `quota/render.ts:212`                                                                                                                                                                                                           | 模型提示（`droidPoolAdviceLine`）                   | PT           |
| `extend-timeout-tool.ts:126`                                                                                                                                                                                                    | 运行时报错文本                                      | PT           |
| `extend-timeout-tool.ts:239`（r3 新增）                                                                                                                                                                                         | **工具描述**（`extend_subagent_timeout`，模型可见） | PT           |
| `config/settings.ts:1725`（r3 新增）                                                                                                                                                                                            | `TIME_SETTING_MS_PATHS` 条目                        | PS2          |
| `web-hub/ui/src/components/schedule/SchedulePanel.vue:16`（r3 新增）                                                                                                                                                            | 模板注释（「consult r1 Q3」）                       | 不改         |
| `setting-specs.ts:114`                                                                                                                                                                                                          | `/agent settings` 描述                              | PS2          |
| `secure/command.ts:131`                                                                                                                                                                                                         | `/secure status` 文本                               | 不动（R-F1） |
| `agent-tool.ts:206,221-230,477`、`list-subagents-tool.ts:322`、`schedule-tool.ts:101`、`workflow-tool.ts:88`、`external-agent/messages.ts:11,14,118,138`、`schedule/agent/bg.ts:152,157`、`commands/schedule.ts:77,145-146,204` | 模型或用户可见                                      | 已在各包     |
| `runtime-adapter.ts:840,921,1155,1174,1236`、`session-driver.ts:962-982`、`spawn-service.ts:62,1217`、`stack.ts:2772,3457`、`request-threading.ts:66-68`、`run-journal.ts:60-88`、`core/*`                                      | 代码标识或日志                                      | PS1a/PS1b    |
| `web-hub/hub/run-transcript.ts:349`、`web-hub/protocol/**`                                                                                                                                                                      | 协议兼容                                            | 不动         |
| `secure/bin/*.mjs`、`secure/domain.ts:176`                                                                                                                                                                                      | vault 布局                                          | 不动         |

r1 列为「仅注释命中」的其余文件（`cache-ttl/*`（含 P6M 移入的 `cache-ttl/keepalive-service.ts:178,307`）、`bash/tool.ts:135`、`traffic/warming.ts`、`bash/process.ts`、`hud/footer.ts`、`delivery/*`、`core/format.ts`、`tools/result-text.ts`、`fabric/*`、`external-agent/droid/session.ts`、`web-hub/agent/{xs,commands}.ts`、`web-hub/protocol/{feishu,worktree-graph}.ts`、`web-hub/ui/**` 的 logic/composables 等），经上面的过滤确认都只在注释里，或者是英文动词 consult，**不改**。S0 刷新时重跑同一条命令，确认没有新增。

### 1.4 tests（归属见 §4.2；完整清单以 S0 重跑的 `rg -li 'consult|experts|abArm|consultMain|forkSessionFrom' tests` 为准）

- **整目录/整文件删除**
  - `tests/consult/`（PS1b；其中 `watcher.test.ts` 在 P0 已 git mv 走）。
  - `tests/conformance/consult-preserve.test.ts` + `fixtures/{consult-production,permissive-guard}.ts`（PS1a；只有 consult-preserve 导入这两个 fixture，`traffic.test.ts:177` 只在注释里提到）。
  - `tests/core/{consult-summary,consult-cache-marker,consult-cache-diag,consult-cache-persistence}.test.ts`、`tests/core/consult-cache-fixtures.ts`（PS1b）。
  - `tests/service/runtime-adapter-consult.test.ts`、`tests/service/spawn-fork-admission.test.ts` 中 fork 部分、`tests/runtime/{session-driver-consult-anchor,session-driver-consult-preserve,session-driver-prefix-probe,runner-consult-reap}.test.ts`、`tests/integration/{consult,consult-worktree-cwd}.test.ts`（PS1a）。
  - `tests/integration/{consult-wiring,consult-reload-dispose}.test.ts`（PS1b；依赖 `stack.consult`）。
  - `tests/workflow/expert-scope.test.ts`（PW）。
  - `tests/tools/agent-tool-experts.test.ts`（PT，改写成 compat 测试）。
  - `tests/config/consult-settings.test.ts`（PS2，改写成「残留块被忽略」）。
  - `tests/ui/fleet-consult-cache.test.ts`、`tests/web-hub/ui/consult-cache-display.test.ts`、`tests/web-hub/agent/status-consult-cache.test.ts`、`tests/tools/result-consult-cache.test.ts`（PD）。
  - `tests/web-hub/agent/consult-transcript.test.ts`（PS1b，随模块一起删）。
  - `tests/exp/consult-{ab-analyze,ab-arm,cache-analyze}.test.ts`、`tests/fixtures/consult-{ab,cache}/`（PDOC）。
- **r2 补上的闭合缺口**（评审第 1、2 条）：
  - `tests/service/runtime-adapter-consult.test.ts:11`、`tests/consult/freeze-surface.test.ts:3`、`tests/consult/consult-tool.test.ts:24`：继续导入旧别名 `CONSULT_READONLY_TOOLS`，P0 期间保持绿，随 PS1a/PS1b 删除。
  - `tests/integration/readonly-domain-shadow-real-session.test.ts:34`：属于 readonly 域，**P0 改为新名**。
  - `tests/conformance/consult-preserve.test.ts:44`（导入 marker）、`tests/consult/prompt.test.ts:80`（动态导入 transcript）：模块在 PS1b 前一直存在，保持绿。
  - `tests/schedule/agent/stack-wiring.test.ts:63`（`stack.consult.close()`）：PS1b。
  - `tests/external-agent/port.test.ts:220`、`tests/external-agent/messages.test.ts`：PT。
  - `tests/quota/{gate:923,hook:927,render:1212,1237}`：PT。
  - `tests/secure/guard-points.test.ts:14,99-112`（`removeForkFile` 在新模块里不存在）：PS1b，改写方式见 §4.2。
  - `tests/web-hub/hub/run-transcript.test.ts:10,407-446`、`tests/web-hub/ui/run-transcript.test.ts:5,370`、`tests/web-hub/agent/wiring-control.test.ts:590-615`：PD，改用写死的旧 wire entries。
  - `tests/integration/explicit-timeout-producers.test.ts:323-327`（经 Agent `experts:["main"]` 走 consult-main）：PT 删除该用例。
  - `tests/integration/consult-ab-instrumentation.test.ts`：PT 删掉 abArm 用例，只保留 lane/packageId 继承和 verdict 断言，并改名为 `dispatch-meta-instrumentation.test.ts`；`diag.experts`/`consults` 断言随 PS1a 删除。
  - `tests/service/admission-reason.test.ts:240`（"external: consult experts unsupported"）：PS1a。
  - **r3 新增** `tests/docs/agents-md.test.ts:36,49`：K2 名单里有 `consult-preserve`，套件文件不存在时自动跳过，所以 PS1a 删套件不会让它变红；PS2 把这一项从名单里删掉。K8 要求 AGENTS.md 链接的 README 存在，所以删 `docs/dev/consult/README.md` 时必须同一提交删掉 AGENTS.md:110 那一行。
  - **r3 新增** `tests/service/spawn-service.test.ts:172-250`（resume 继承 dispatchMeta 的两例，META 带 `abArm`）：归 PT。`tests/service/runtime-adapter-instrumentation.test.ts:101`（原样镜像）：不受 PT 影响，留到 PS1a。
  - `tests/runtime/tool-scope.test.ts:43-49`（consult 是 reserved）：保留，因为 reservation 还在；`bashJobGrant({consult})` 的调用在 PS1a 改名。
- **其余修改**（按包，见 §4.2）：core（core、run-journal、presentation-diag、state-machine 矩阵和 property、dispatch-meta、verdict-schema）、service、runtime、workflow、tools、schedule、memory、sysprompt、web-hub、ui、commands、fabric/revive。
- **不动**：`tests/conformance/traffic.test.ts:299` 的 `consult: { enabled: false }`（正好证明残留键被忽略）、`tests/fixtures/**`（Q1 那份 golden 除外）、`tests/secure/stack-roots.test.ts`（清扫语义逐字保留，所以真实装配测试继续有效）。

### 1.5 scripts / skills / docs / 根文档

- **PDOC**
  - 删除 `scripts/exp/consult-{ab-analyze,ab-arm,ab-lib,anchor-probe,cache-analyze,cache-lib}.mjs`、`consult-fork-probe.ts`、`exp6-*`（拍板 Q6）。
  - `scripts/dev/readme-shots/{make-fixture.mjs:274-284,tui/demo-ext.ts:72-85,README.md:15}`：删 consult 演示行（r2）。
  - skills：删除 `skills/dev-flow/references/{consult.md,consult-ab.md}`；修改 `skills/dev-flow/SKILL.md`、`references/subagent-workflow.md`、`skills/agent-handoff/SKILL.md`。
  - `README.md`/`README.en.md`：:10、:68、:135、:365。
  - `docs/guide/subagents.md:9,47,88-97,110`、`docs/guide/quota-load.md:45`（r2）。
  - `docs/dev/consult/REMOVED.md`（新建）、`docs/dev/workflow-experts/plan.md` 头注。
- **PS2**：`AGENTS.md`，以及低风险 P1 下沉后所有含 consult 的开发者 README（§4.2 PS2）。`docs/dev/external-agent/README.md:73` 也在 PS2，因为它是 P1 的追加目标，归属以 P1 交付清单为准。
- **不动**（历史档案）：`docs/dev/consult/**`（README.md 除外，见拍板 Q9）、`docs/dev/workflow-experts/**`、`docs/dev/fabric-v2/**`、`docs/dev/source-governance/**`、`docs/dev/consult-removal/**`、其他目录的 `*plan*.md`/`*-report.md`/`acceptance.md`、`docs/research/**`、`CHANGELOG.md`。
- README 截图（`docs/images/*`）里可能还有 consult 行，是否重生由后续决定（§5 R-F2）。

---

## 2. 保留资产的迁移方案（P0 新增、PS1b 收尾）

| 资产                                                                                  | P0                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       | PS1b                                                                        |
| ------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------- |
| `CONSULT_READONLY_TOOLS`（`runtime/tool-scope.ts:75`）                                | 新增 `READONLY_DOMAIN_TOOLS`（值逐字不变），旧名改为 `/** @deprecated #40 */ export const CONSULT_READONLY_TOOLS = READONLY_DOMAIN_TOOLS;`。**非 consult 的消费者**改用新名：`memory/tiered.ts:17,131`、`runtime-adapter.ts:50,1070,1136`，以及 tests `memory/tiered`、`runtime/tool-scope{,-provenance}`、`service/runtime-adapter-readonly-domain`、`integration/readonly-domain-shadow-real-session`。consult 自己的源码和测试继续用旧名                                                                                              | 删除别名（届时导入方只剩已删的 consult 文件和测试）                         |
| `createCapWatcher`/`ConsultCapReason`（`consult/watcher.ts`）                         | 原样迁到 `src/runtime/cap-watcher.ts`，类型改名为 `RunCapReason`。`consult/watcher.ts` 变成垫片：`export { createCapWatcher } from "../runtime/cap-watcher.js"; export type ConsultCapReason = RunCapReason; export type { CapWatcher } …`。`memory/tidy/command.ts:13` 和 `cost.ts:3` 改用新路径。`git mv tests/consult/watcher.test.ts tests/runtime/cap-watcher.test.ts` 并改 import                                                                                                                                                  | 垫片随 `src/consult/` 一起删除                                              |
| `consultSessionDir`/`sweepForkDir`/`FORK_TTL_MS`（`consult/fork-store.ts:47,84,774`） | 新建 `src/runtime/legacy-consult-forks.ts`：`legacyConsultForkDir()`（公式不变）、`LEGACY_FORK_TTL_MS`、`sweepLegacyConsultForks(dir?, ttl?, now?)`，**逐字移植** TTL 规则和碎片规则，连同最小的 header 头扫描。`fork-store.ts` 的 `consultSessionDir`/`sweepForkDir`/`FORK_TTL_MS` **签名不变**，改为委托给新模块。`schedule/agent/wire.ts:26,278`、`stack.ts:2266` 改用新模块；`tests/schedule/agent/wire.test.ts:19` 改 import；新建 `tests/runtime/legacy-consult-forks.test.ts`，从 `tests/consult/fork-store.test.ts` 移植清扫用例 | `fork-store.ts` 删除；`tests/secure/guard-points.test.ts` 改写（§4.2 PS1b） |

- 新模块放 `runtime/` 是因为 `getAgentDir` 是 pi 的函数，不能放必须 pi-free 的 `core/`（低风险 P6B 的 `tests/boundary/pi-free.test.ts` 会守护这一点）。
- `secure/domain.ts` 的 `consult` 字段本轮不改名。
- 磁盘残留由清扫在 24h 内自然清空，不做整目录删除。

---

## 3. 兼容读取策略（与 r1 相同，仅补测试归属）

### 3.1 已持久化的 run 条目

- 读回（`adapters/pi-run-log.ts seedRunStoreFromEntries`）是强转，没有 strict 校验，所以旧 diag 里的 consult 字段会作为多余属性留在对象上。类型删掉后没有代码再读它们，天然被忽略。
- 新 journal 走白名单投影，这些字段自动丢弃。terminal 条目被二次持久化时会原样透传旧字段，无害。
- 旧 consult run 显示成普通 run，`displayAgentType` 把 `consult:main-snapshot` 折叠成 `main`。
- PS1b 新建 `tests/integration/consult-legacy-entries.test.ts`：用带全部旧字段的条目 seed，然后验证 `get_subagent_result`、`list_subagents`、fleet、`/agent status`、web status 投影能正常渲染且没有 consult 文案；resume 产生干净的 diag；wake preflight 返回 `consult_fork`。

### 3.2 `dispatchMeta`

保留 `lane/packageId/feature`。resume 继承改走 `pickInheritableDispatchMeta`（PT），丢掉旧条目里的 `abArm`。

### 3.3 `wakeExclusion: "consult_fork"`

`fabric/wake.ts:420-422` 把任何非 `"none"` 的值都当作排除。union 保留这个字面量，只读不产出。

### 3.4 Agent 工具收到 `experts`

- pi-ai 1.3.0 的 `validateToolArguments`（`dist/utils/validation.js:280`）用 typebox `Check` 校验。两份 Agent schema 都没有 `additionalProperties:false`，所以多余的 `experts` 会原样到达 execute。
- 处理：忽略，并在结果前加一行英文提示，run 照常派发。到下一个 minor 时删掉这行提示（拍板 Q2）。
- `meta` 是 `additionalProperties:false`，去掉 `abArm` 后旧调用会被 pi 拒绝，模型能自行修正（拍板 Q3）。

### 3.5 workflow `agent({experts})`

用专用文案拒绝（拍板 Q4）。没有旧数据需要读。

### 3.6 `schemaPreset: "verdict/v1"`

保留。

### 3.7 schedule `bg.consultMain`

持久化字段和 `defHash` 不动；工具参数删除；`--consult` 报错；执行端遇到 true 时忽略并提示；web review 只在值为 true 时显示（拍板 Q5）。

### 3.8 web-hub 协议

- `run_transcript` 类帧是 `additionalProperties:false`，所以协议里的 `consult`/`consultCache`/`consultFallback` 字段和 hub 的 fallback 分支都保留，用来兼容旧 agent。
- agent 端停止产出；UI 渲染删除（拍板 Q7）。
- hub 的兼容用例改用写死的旧 wire entries（PD）。

### 3.9 settings 残留 `consult.*`

解析器天然忽略，不改用户文件（拍板 Q8）。

### 3.10 其他

- `RESERVED_TOOL_NAMES` 保留 `"consult"`。
- `onReaped` 签名在 PS1b 收窄。

---

## 4. 拆包

### 4.0 S0：开工前坐标刷新（blockedBy 低风险批 P1 合入；L1，只读调研 + 主会话提交文档）——r3 已完成，结果见 §4.0.1

低风险批（P6B→P2→P3→P6M→P1）全部合入 dev 之后、#40 任何写包开工之前执行。产出是本文件的 r3（只改文档）。

1. **确认前置条件**：低风险 P1 的合入提交在 dev 祖先链上；拿到 P1 交付报告里的 `rg -n -i consult AGENTS.md docs/dev/*/README.md` 清单（plan-lowrisk §1.7）。
2. **套用路径替换**：以 plan-lowrisk 最终版（r2 或更新版）§4.3 替换表为准；下表是 b667d880 时的版本，供参考。与 #40 文件域有关的影响：

   | 旧 → 新（低风险 P6M/P2/P3）                                                                                                                            | 对 #40 的影响                                                                                                                                     |
   | ------------------------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------- |
   | `src/service/cache-keepalive.ts` → `src/cache-ttl/keepalive-service.ts`                                                                                | 只有注释命中（:178、:307），#40 不改；更新 §1.3 坐标                                                                                              |
   | `src/tools/bash-tool.ts`/`bash-job-tool.ts` → `src/bash/{tool,job-tool}.ts`；对应 tests 移到 `tests/bash/`                                             | PT 改的 `tests/tools/model-facing-strings.test.ts` 的 import 会被 P6M 改过，按新内容 rebase                                                       |
   | `src/tools/{switch-context,compact,set-compact-threshold}-tool.ts` → `src/context-switch/tool.ts`、`src/compact-hint/{compact-tool,threshold-tool}.ts` | 与 #40 无交集；`stack.ts`/`index.ts` 的 import 行位置变化，PS1b 按新行号操作                                                                      |
   | `src/web-hub/agent/command-capture.ts` → `src/commands/capture.ts`                                                                                     | PT 改 `commands/schedule.ts`，PD 改 `web-hub/agent/index.ts`，这两个文件的 import 已被 M4 改过，按新内容 rebase                                   |
   | P2 D1：`redactSecrets` → `src/core/redact.ts`                                                                                                          | 无交集                                                                                                                                            |
   | P2 D2：`isTerminalStatus` 统一（改 `ui/fleet-panel.ts:41`、`archive/control.ts:31`）                                                                   | PD 改 `ui/fleet-panel.ts`，按新内容 rebase                                                                                                        |
   | P3 死代码删除                                                                                                                                          | 已避开 `consult/preserve-identity.ts snapshotToolDeclarations` 和 `consult/tool.ts:362`。核对 #40 计划里要改的导出没有被 P3 删掉                  |
   | P1 AGENTS.md 下沉                                                                                                                                      | 文中 consult 内容分散到各开发者 README，交给 PS2（§4.2）                                                                                          |
   | P6B `tests/boundary/pi-free.test.ts`                                                                                                                   | 新文件 `src/runtime/{cap-watcher,legacy-consult-forks}.ts` 不在 pi-free 根里；`core/consult-*.ts` 被删时，boundary 测试按 glob 发现文件，不会误报 |
   | （P1 若拍了 Q6）`tests/docs/agents-md.test.ts`                                                                                                         | PS2 删 `docs/dev/consult/README.md` 时**必须同一提交**删掉 AGENTS.md 表里 `src/consult/` 那一行（规则 2/3）                                       |

3. **重跑影响面 grep**，刷新 §1.3/§1.4 的坐标和归属：
   - `rg -n -i consult src tests scripts skills docs/guide README.md README.en.md`
   - §1.3 的「字符串命中复核」过滤命令
   - `rg -li 'consult|experts|abArm|consultMain|forkSessionFrom' tests`
4. **重跑闭合检查**（§4.3 命令）的「开工前」版本：确认每包要删的导出，其导入方都在本包文件域内。
5. **冲突预检**：按 §4.2 文件域写 `/tmp/consult-removal-spec.json`，跑 `node skills/dev-flow/scripts/conflict-check.mjs /tmp/consult-removal-spec.json`。阶段 1 的五个包须零交集；`ext:#43` 用 `src/secure/**`、`tests/secure/**`、`tests/integration/traffic-lifecycle-process.test.ts` 表示，与阶段 1 零交集。
6. 把刷新结果写回本文件（r3 修订记录写明变化），主会话精确路径提交后，阶段 1 开工。

#### 4.0.1 S0 结果（r3，2026-10-25，dev @ `88da5b81`）

**① 祖先链**：`git merge-base --is-ancestor <c> dev` 全部通过。

| 批          | 提交                                                                   |
| ----------- | ---------------------------------------------------------------------- |
| 低风险 P6B  | `c1454719`                                                             |
| 低风险 P2   | `36b8857c`、`9fb9b96e`、`71942242`、`bcfd753a`                         |
| 低风险 P3   | `a1d4ccdd`、`fcbf71dc`                                                 |
| 低风险 P6M  | `ce76d830`（M1）、`99aa0cde`（M2）、`add4ec1f`（M3）、`930de1fa`（M4） |
| 低风险 P1   | `3b980ad1`、`611cf525`、`a488b429`、`0707b9df`                         |
| 其他        | `302223c5`、`88da5b81`                                                 |
| #43         | `0f74709d`、`4ea6bfec`                                                 |
| 本方案 r2.1 | `2c019f17`                                                             |

**② 路径替换**（以 P6M/P2/P3 报告为准）：

| 移动                                                                                                        | #40 文件域受影响处                                                                                                                                                |
| ----------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| M1 `service/cache-keepalive.ts` → `cache-ttl/keepalive-service.ts`                                          | 只有注释（:178、:307），不改                                                                                                                                      |
| M2 bash 工具 → `src/bash/{tool,job-tool}.ts`，测试 → `tests/bash/`                                          | `bash/tool.ts:135` 注释，不改；`tests/tools/model-facing-strings.test.ts` 的 import 已改，PT 在其上修改                                                           |
| M3 context/compact 工具 → `src/context-switch/tool.ts`、`src/compact-hint/{compact-tool,threshold-tool}.ts` | 无；`index.ts`/`stack.ts` 行数不变，#40 引用的行号（index :977/:1474/:1611，stack :143-154/:322/:758/:2173/:2266/:2772-2779/:2963/:3069-3127/:3449-3458）复核未变 |
| M4 `web-hub/agent/command-capture.ts` → `commands/capture.ts`                                               | `commands/schedule.ts`、`web-hub/agent/index.ts` 的 import 行已改，行数不变（`commands/schedule.ts` :44/:77/:145-146/:204、`web-hub/agent/index.ts:83` 未变）     |
| P2 D1 `core/redact.ts`                                                                                      | 无                                                                                                                                                                |
| P2 D2 `isTerminalStatus`                                                                                    | `ui/fleet-panel.ts` −5 行，consult 行改为 :16/:104-108/:404/:454；`consult/tool.ts` 的副本被 P2 有意保留，随 PS1b 删除                                            |
| P3 死代码、`rpc/client` → `tests/rpc/helpers/rpc-client.ts`、`lan-security-stubs` 删除                      | P3 报告写明「未触及 consult」；`core/message.ts` 只删了 `isMessageKey`，`WakeExclusion` 不变；#40 依赖的导出没有被删                                              |
| P1 AGENTS.md 下沉                                                                                           | consult 句子落到 9 份 README，归 PS2（§4.2 PS2 处理表）                                                                                                           |
| P6B `tests/boundary/pi-free.test.ts`                                                                        | 新文件放 `src/runtime/` 不在 pi-free 根内；删 `core/consult-*.ts` 不影响按 glob 发现文件                                                                          |

**③ grep 重跑与增删**

- `rg -li 'consult|experts|abArm|consultMain|forkSessionFrom'`：tests 由 183 个文件变为 184 个。
  - 减少 `tests/web-hub/agent/command-capture.test.ts`；增加 `tests/commands/capture.test.ts`（只是注释）和 `tests/docs/agents-md.test.ts`（归 PS2）。
  - src 减少 `service/cache-keepalive.ts`、`tools/bash-tool.ts`，增加 `cache-ttl/keepalive-service.ts`、`bash/tool.ts`（都是注释或动词）。
- 字符串过滤（§1.3）：新增 `extend-timeout-tool.ts:239`（PT）、`settings.ts:1725`（PS2）、`SchedulePanel.vue:16`（模板注释，不改）；`convert.mjs` 行号变为 :2734；其余与 r2 一致。

**④ 闭合基线**：见 §4.3.1。新发现 `tests/service/spawn-service.test.ts:172-250`，已并入 PT。

**⑤ P1 清单**：见 §4.2 PS2 处理表。AGENTS.md 新结构下，consult-preserve 门禁在 `## pi peer bump checklist` 第 2 条（:82），由 `tests/docs/agents-md.test.ts` K2 守护（自带门控）。

**⑥ 冲突预检**：附录 A 的 spec，`node skills/dev-flow/scripts/conflict-check.mjs /tmp/consult-removal-spec.json --cwd .` 输出 P0 18、PW 19、PD 25、PT 34、PDOC 50 个已存在文件，「无交集，可同树并行」，**exit 0**。新建文件（P0 的 4 个、PT 的 `dispatch-meta-instrumentation.test.ts`、PDOC 的 `REMOVED.md`）的路径互不重叠。

### 4.1 规则（r2：依赖闭合）

- **R1 闭合**：阶段 1 的包，只有在 `rg` 证明某个文件或导出的全部导入方（src + tests + scripts）都在本包文件域内时，才能删除它。否则只停止调用，并保留它：值导出用别名或垫片，接口成员标 `/** @deprecated #40 — removed in PS1b */` 且不读。
- **R2 入口归属**：关闭某个入口的包（Agent `experts`、workflow `experts`、schedule consult-main、UI 渲染、agent 端的 transcript fallback 产出），拥有所有经过该入口的测试的修改和删除权。
- **R3 每包合入即绿**：`npm run typecheck && npm run format:check` + 本包定向测试 + §4.3 闭合检查。开发包**不跑**全量测试。
- **R4 集成点全量**（主会话统一跑，限并发）：
  - I1：阶段 1 五包全部合入后
  - I2：PS1a 后
  - I3：PS1b 后
  - I4：PS2 后。最终版：`npm run format:check && npm run typecheck && npm test && npm run build && npm run build:web && npm run check:web && npm run test:conformance`，再加 §4.5 的冻结 golden 命令
- **R5 verifier**：对照 §1.3 清单审 diff，复跑本包关键定向门禁和闭合检查，不跑全量。验收模型 ≠ 开发模型。
- **R6 PS1a 的中间态**：`src/consult/` 必须仍能编译（typecheck 绿），可以作为死代码存在；PS1a 不删任何被 `src/consult/**` 导入的导出。中间态不发版。

### 4.2 包、文件域与「删除 / 保留 / 测试归属」

阶段 1（S0 后并行）：**P0 ∥ PW ∥ PD ∥ PT ∥ PDOC**。阶段 2 串行：**PS1a → PS1b → PS2**。

#### P0 共享资产迁移（L1）

- **文件域**：新建 `src/runtime/{cap-watcher,legacy-consult-forks}.ts`；`src/runtime/tool-scope.ts`（只加新名和别名）；`src/memory/tiered.ts`；`src/memory/tidy/{command,cost}.ts`；`src/schedule/agent/wire.ts`；`src/service/runtime-adapter.ts`（只改 :50、:1070、:1136 三处常量名）；`src/stack.ts`（只改 :2266 清扫调用和 import）；`src/consult/watcher.ts`（改为垫片）；`src/consult/fork-store.ts`（三个导出改为委托，签名不变）。
- **删除**：无（`watcher.ts` 的实现迁走，文件保留为垫片）。
- **保留**：`CONSULT_READONLY_TOOLS` 别名；`consult/watcher.ts` 垫片；`fork-store` 的 `consultSessionDir`/`sweepForkDir`/`FORK_TTL_MS`/`removeForkFile`。
- **测试**
  - `git mv tests/consult/watcher.test.ts tests/runtime/cap-watcher.test.ts` 并改 import。
  - 新建 `tests/runtime/legacy-consult-forks.test.ts`（plain 和 secure 两种根，TTL 和碎片规则，不碰子目录）。
  - 改新名：`tests/memory/tiered.test.ts`、`tests/runtime/{tool-scope,tool-scope-provenance}.test.ts`、`tests/service/runtime-adapter-readonly-domain.test.ts`、`tests/integration/readonly-domain-shadow-real-session.test.ts`、`tests/schedule/agent/wire.test.ts:19`；`tests/sysprompt/memory-tiered-section.test.ts`、`tests/service/runtime-adapter-child-switch.test.ts` 只改注释。
  - **不碰**：`tests/consult/**` 的其余文件、`tests/service/runtime-adapter-consult.test.ts`（继续用别名，保持绿）、`tests/secure/**`。
- **定向**：
  ```sh
  npx vitest run tests/runtime tests/memory tests/sysprompt/memory-tiered-section.test.ts tests/service/runtime-adapter-readonly-domain.test.ts tests/service/runtime-adapter-consult.test.ts tests/integration/readonly-domain-shadow-real-session.test.ts tests/schedule/agent/wire.test.ts tests/secure/stack-roots.test.ts tests/secure/guard-points.test.ts tests/consult
  ```

#### PW workflow（L2）

- **文件域**：`src/workflow/{host,agent-opts,worker-source,replay,types,spawner-adapter}.ts`、删除 `src/workflow/expert-scope.ts`、`src/tools/workflow-tool.ts`。
- **删除**：`expert-scope.ts`（导入方只有 host.ts 和它的测试，闭合）；`replay.ts` 的 `"experts"` skip reason 和输入；host 的 experts 解析段。
- **保留**：`SpawnerAdapterOpts.resolveExperts?`、`ChildSpawner.resolveExperts?`、`spawner-adapter` 对 `req.consultExperts` 的透传类型（都标 `@deprecated`，stack 仍在填，PS1b 删）；`chain_tainted`。
- **测试**：`tests/workflow/{host,agent-opts,replay,replay-taint.property,replay-taint-isolation.property,host-iso-fold.property,spawner-adapter,worker-host-call}.test.ts`；删除 `tests/workflow/expert-scope.test.ts`；`tests/tools/workflow-tool.test.ts`；`tests/integration/workflow-experts.test.ts` 改写为「`experts` 被专用文案拒绝，`.catch()` 可恢复」。
- **定向**：
  ```sh
  npx vitest run tests/workflow tests/tools/workflow-tool.test.ts tests/integration/workflow-experts.test.ts tests/integration/consult-wiring.test.ts
  ```
  最后一项用来证明 stack 那边填的 deprecated 成员仍能编译和运行。

#### PD 显示面（L2）

- **文件域**：`src/ui/fleet-{panel,widget}.ts`、`src/tools/result-tool.ts`、`src/web-hub/agent/{status,run-transcript,index}.ts`、UI `components/drawer/RunTranscript.vue`、`components/fleet/FleetTree.vue`、`styles/drawer.css`（:178-200）、`i18n/{zh,en}/{fleet,drawer}.ts`。
- **删除**：上述文件中的 consult 渲染和产出（fleet row 的 `consultCacheMark`/`consult`、result 的 consult cache 行、agent 端的 `consultFallback`）。
- **保留（R1）**：`src/core/consult-cache-marker.ts`、`src/web-hub/agent/consult-transcript.ts` **不删**，src 里不再有导入方；`tests/conformance/consult-preserve.test.ts:44`、`tests/core/consult-cache-marker.test.ts`、`tests/consult/prompt.test.ts:80`、`tests/web-hub/agent/consult-transcript.test.ts` 继续导入，保持绿，PS1a/PS1b 删。`src/web-hub/protocol/**`、`src/web-hub/hub/**` 不动。
- **测试**
  - 删除：`tests/ui/fleet-consult-cache.test.ts`、`tests/tools/result-consult-cache.test.ts`、`tests/web-hub/agent/status-consult-cache.test.ts`、`tests/web-hub/ui/consult-cache-display.test.ts`。
  - 修改：`tests/ui/{fleet-widget,fleet}.test.ts`、`tests/tools/result-tool.test.ts`、`tests/web-hub/agent/snapshot.test.ts`。
  - `tests/web-hub/agent/wiring-control.test.ts:590-615`：改为「终态 diag 带旧 `consultOf` 也**不再**产出 `consultFallback`」。
  - `tests/web-hub/hub/run-transcript.test.ts:10,407-446`：改用文件内写死的 `LEGACY_CONSULT_FALLBACK` 旧 wire entries 常量（按当前 `consultTranscript()` 的输出字面量抄下来，不导入模块），**保留**缺文件 fallback、分页、leaf mismatch 断言。
  - `tests/web-hub/ui/run-transcript.test.ts:5,370`：同样改用写死的 entries，断言 UI 不再渲染 consult 提示，但正文照常显示。
  - `tests/web-hub/ui/fleet-tree.test.ts`：去掉 consult 行；加一例「row 带旧的 `consult:true`/`cacheMark` 也正常渲染」。
- **定向**：
  ```sh
  npx vitest run tests/ui tests/tools/result-tool.test.ts tests/web-hub/agent tests/web-hub/ui tests/web-hub/hub/run-transcript.test.ts tests/core/consult-cache-marker.test.ts
  npm run build:web && npm run check:web
  git diff --exit-code <base> -- src/web-hub/protocol src/web-hub/hub
  ```

#### PT 工具与调度面（L2）

- **文件域**：`src/tools/agent-tool.ts`、`src/core/dispatch-meta.ts`、`src/service/resolve-target.ts`（**只改** :221 的继承调用）、`src/tools/{list-subagents,extend-timeout,schedule}-tool.ts`、`src/commands/schedule.ts`、`src/schedule/agent/{bg,executors,view}.ts`、`src/external-agent/messages.ts`（只改 `capabilitiesText`/`externalModelsPromptHeader`）、`src/quota/render.ts`（:201、:212）、UI `components/schedule/ScheduleReview.vue`、`i18n/schedule-extra.ts`、`tests/fixtures/tools/agent-nested-surface-golden.json`。 测试文件域以附录 A 的 PT 条目为准（r3 并入 `tests/service/spawn-service.test.ts`，只改 :172-250 两例）。
- **删除**：Agent 两份 schema 的 `experts`、`timeout_s` 描述里的「consult, 」、`meta.abArm`、A/B 一致性校验、`expertEcho`、`AB_ARM_EXPERTS_OPTIONAL_AGENT_TYPES`；schedule-tool 的 `consultMain` 参数；`/schedule` 的 consult flag（`--consult` 报错，`--no-consult` 静默接受）；bg 的 consult-main 解析（值为 true 时只给提示）；quota 和 external-agent 文案里的 consult。
- **保留（R1）**：`AgentToolCommonDeps.resolveExperts?`、`ScheduleExecutorsDeps.consult?`、`bg` deps 的 `consult?`（`@deprecated` 不读）；`MSG_EXPERTS_UNSUPPORTED`/`msgExpertIsExternal`（spawn-service 和 consult 仍在用）；schedule 持久化字段、`defHash`、reader、protocol。
- **测试**
  - `tests/tools/agent-tool.test.ts`；`tests/tools/agent-tool-experts.test.ts` 改写为 compat 测试（带 `experts` 照常派发，有一行提示，spawn 请求里没有 `consultExperts`）；`tests/tools/model-facing-strings.test.ts`（含 nested golden 断言）。
  - `tests/core/dispatch-meta.test.ts`（含「继承丢弃旧 abArm」）、`tests/service/resolve-target.test.ts:180-215` 中 dispatchMeta 部分、**`tests/service/spawn-service.test.ts:172-250`**（r3：期望改为继承结果不含 `abArm`，显式覆盖那一例不变）。
  - `tests/integration/explicit-timeout-producers.test.ts:323-327` 删除该用例。
  - `tests/integration/consult-ab-instrumentation.test.ts` → `git mv` 为 `dispatch-meta-instrumentation.test.ts`，删除 abArm 用例；`diag.experts`/`consults` 的断言留到 PS1a。
  - `tests/schedule/agent/{bg,dispatch}.test.ts`，新增 `/schedule --consult` 报错用例（放在 `tests/commands/schedule.test.ts`）；`tests/schedule/core/spec.test.ts` 增加「`consultMain:true` 的旧任务 `defHash` 不变、仍处于已批准状态」。
  - `tests/external-agent/{messages,port}.test.ts`（port.test.ts:220 改为断言不再包含 "consulting experts"）。
  - `tests/quota/{gate,hook,render}.test.ts`（期望文本改为「不能当验收」）。
  - `tests/web-hub/ui/schedule-panel.test.ts`（ScheduleReview 用例）。
- **定向**：
  ```sh
  npx vitest run tests/tools tests/core/dispatch-meta.test.ts tests/service/resolve-target.test.ts tests/schedule tests/commands tests/external-agent tests/quota tests/integration/explicit-timeout-producers.test.ts tests/integration/dispatch-meta-instrumentation.test.ts tests/integration/external-disabled-bytes.test.ts tests/web-hub/ui/schedule-panel.test.ts tests/service/spawn-service.test.ts
  npm run build:web && npm run check:web
  ```
  再加 §4.5 的 golden 断言脚本。

#### PDOC 文档/脚本/skill（L1）

- **文件域**：`scripts/exp/consult-*`、`scripts/exp/consult-fork-probe.ts`、`scripts/exp/exp6-*`；`scripts/dev/readme-shots/{make-fixture.mjs,tui/demo-ext.ts,README.md}`；`scripts/exp/topic-judge-eval/README.md`（只删 :68 引用 `scripts/exp/exp6-judge.ts` 的历史先例句，复审 r2 #8）；`tests/exp/consult-*.test.ts`；`tests/fixtures/consult-{ab,cache}/`；`skills/**`；`README.md`、`README.en.md`；`docs/guide/{subagents,quota-load}.md`；新建 `docs/dev/consult/REMOVED.md`；`docs/dev/workflow-experts/plan.md` 头注。
- **不碰**：`AGENTS.md`、`docs/dev/*/README.md`（PS2）。
- **验收**：见 §4.5。

#### PS1a 运行时/service 清理（L3，阶段 1 全部合入且 I1 绿后）

- **文件域**：`src/runtime/{session-driver,runner,tool-scope}.ts`（tool-scope 只做 `BashJobGrantInput` 改名和删 `reportBlockedOnBind`）、`src/service/{runtime-adapter,spawn-service,request-threading}.ts`。
- **删除**：§1.3 列出的 PS1a 项。运行时不再产生 consult run、fork 准入、C2、consult 事件、`diag.experts`。
- **保留（R6）**
  - 被 `src/consult/**` 导入的一切：`core/types.ts` 全部类型、`resolve-target` 的 ExpertIndex 钩子、`msgExpertIsExternal`、spawn/query 端口类型、`runner.onReaped` 签名。
  - `RuntimeAdapterDeps.{consult,consultResolveExperts,consultDisplayMeta}`（标 `@deprecated`，stack 仍在传）。
  - `src/core/consult-summary.ts`、`state-machine` 的 consult 折叠（不再有事件输入，成为死代码）。
- **测试**
  - 删除：`tests/service/runtime-adapter-consult.test.ts`、`tests/runtime/{session-driver-consult-anchor,session-driver-consult-preserve,session-driver-prefix-probe,runner-consult-reap}.test.ts`、`tests/conformance/consult-preserve.test.ts` + `fixtures/{consult-production,permissive-guard}.ts`、`tests/integration/{consult,consult-worktree-cwd}.test.ts`。
  - 修改：`tests/service/spawn-fork-admission.test.ts`（删 fork 用例，保留 readonly 互斥，文案改为不含 forkSessionFrom）、`tests/service/{runtime-adapter-instrumentation（删 diag.experts/granted）,runtime-adapter-readonly-domain,runtime-adapter-child-switch,runtime-adapter-prompt-notes,spawn-service,spawn-pool-full,spawn-service-external,spawn-wake-exclusion,request-threading,admission-reason:240}.test.ts`、`tests/runtime/{session-driver,tool-scope,nested-run-usage,session-driver-child-marker}.test.ts`、`tests/integration/{readonly-domain-shadow-real-session,fabric-xs-child-scope,child-session-marker,dispatch-meta-instrumentation}.test.ts`。
  - **规则**：`tests/consult/**`、`tests/integration/{consult-wiring,consult-reload-dispose}.test.ts`、`tests/core/consult-*` 必须继续绿。其中如果有用例端到端依赖已删的运行时路径，就在 PS1a 删除该**用例**，并在报告里逐条列出。
- **定向**：
  ```sh
  npx vitest run tests/service tests/runtime tests/fabric tests/integration tests/consult tests/core
  npm run test:conformance
  ```

#### PS1b 装配/类型物理删除（L3，PS1a 合入且 I2 绿后；#43 已合入，`tests/secure/guard-points.test.ts` 可以直接改）

- **文件域**
  - 删除：`src/consult/**`、`src/core/{consult-summary,consult-cache-marker}.ts`、`src/web-hub/agent/consult-transcript.ts`。
  - 修改：`src/core/{types,state-machine,run-journal,message}.ts`、`src/stack.ts`、`src/index.ts`、`src/service/{runtime-adapter（删 deprecated deps）,resolve-target（删 ExpertIndex 钩子）}.ts`、`src/runtime/{runner（onReaped 收窄）,tool-scope（删别名）}.ts`、`src/cache-ttl/child-registry.ts`（注释）、`src/tools/agent-tool.ts`、`src/workflow/{spawner-adapter,types}.ts`、`src/schedule/agent/{bg,executors}.ts`（删 deprecated 成员）、`src/external-agent/messages.ts`（删两个常量）、`src/commands/status.ts`（注释）。
- **测试**
  - 删除：`tests/consult/**`、`tests/core/{consult-summary,consult-cache-marker,consult-cache-diag,consult-cache-persistence}.test.ts` + `consult-cache-fixtures.ts`、`tests/web-hub/agent/consult-transcript.test.ts`、`tests/integration/{consult-wiring,consult-reload-dispose}.test.ts`。
  - 修改：`tests/core/{core,run-journal,presentation-diag}.test.ts` 和状态机矩阵/property；`tests/schedule/agent/stack-wiring.test.ts:63`（删 `stack.consult.close()`）；`tests/commands/status.test.ts`；`tests/fabric/revive.test.ts`。
  - `tests/secure/guard-points.test.ts:14,99-112` 改写为两条：①plain ⇒ `legacyConsultForkDir()` 等于 `<agentDir>/cache/consult-sessions`，secure（`freezeDomain(v)`）⇒ 等于 `<v.state>/cache/consult-sessions`；②secure 下 `sweepLegacyConsultForks()` 删掉 vault 根里的过期文件和碎片文件，而 `v.outside` 和 `<agentDir>/cache/consult-sessions` 下的同名文件不受影响。`tests/secure/stack-roots.test.ts`（真实装配）**不改**，必须仍然通过。
  - 新建 `tests/integration/consult-legacy-entries.test.ts`（§3.1）。
- **定向**：
  ```sh
  npx vitest run tests/core tests/service tests/runtime tests/integration tests/schedule tests/web-hub/agent tests/commands tests/fabric tests/secure/guard-points.test.ts tests/secure/stack-roots.test.ts
  npm run test:conformance
  ```

#### PS2 设置 + AGENTS.md + 下沉 README 收口（L2，PS1b 合入且 I3 绿后）

- **输入**：低风险 P1 交付报告里的 `rg -n -i consult AGENTS.md docs/dev/*/README.md` 清单（S0 时已取得），以及 PS2 开工时重跑的同一命令结果。
- **文件域**：`src/config/{settings,setting-specs}.ts`（含 `setting-specs.ts:114`、`settings.ts:1725`）、`tests/docs/agents-md.test.ts`（只删 K2 名单里的 `consult-preserve`）、`src/core/verdict-schema.ts`（注释）、`tests/config/**`（consult 部分；`consult-settings.test.ts` 改写成「残留块被忽略」）、`AGENTS.md`、清单命中的全部开发者 README，删除 `docs/dev/consult/README.md`（拍板 Q9）、`docs/dev/source-governance/analysis.md`（附录 D 末尾加一行指向本 plan）。
- **处理表**（r3：按 P1 交付清单 `docs/dev/source-governance/P1-report.md` §consult 清单，坐标 @88da5b81；PS2 开工时再重跑 `rg -n -i "consult|experts|consultSessionDir" AGENTS.md docs/dev/*/README.md` 核对）

  | 位置                                                                            | 现文要点                                                                                                                        | 处理                                                                                                                                                                                                                                                |
  | ------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
  | `AGENTS.md:82`（`## pi peer bump checklist` 第 2 条）                           | 「`consult-preserve.test.ts` C1–C7 (remove with #40)」                                                                          | 删除这一项；同时删 `tests/docs/agents-md.test.ts:36` 套件名单里的 `"consult-preserve"`（K2 自带门控，删不删都不会红，删掉是为了干净）                                                                                                               |
  | `AGENTS.md:95`（`skills/` 行）                                                  | 「`agent-handoff` (structured handoffs and consult usage …)」                                                                   | 改为「structured handoffs and asking the parent via message_agent」                                                                                                                                                                                 |
  | `AGENTS.md:110`（`src/consult/` 行）                                            | 「#40 将删除」                                                                                                                  | 删除整行，**与删除 `docs/dev/consult/README.md` 同一提交**（K8）；K9 在 `src/consult/` 消失后不再要求这一行                                                                                                                                         |
  | `AGENTS.md:134`（`src/workflow/` 行）                                           | 「`agent()` queue/experts/worktree」                                                                                            | 去掉 experts                                                                                                                                                                                                                                        |
  | `AGENTS.md:139`（`docs/dev/` 行）                                               | 列表里有「consult」                                                                                                             | 改为「consult（已移除，档案）」或删除；`docs/dev/consult/` 作为档案保留                                                                                                                                                                             |
  | `docs/dev/consult/README.md`（整份，24 处）                                     | 横幅「本文件由 #40 移除时整体删除」                                                                                             | 删除（拍板 Q9）；档案说明由 PDOC 新建的 `docs/dev/consult/REMOVED.md` 承担                                                                                                                                                                          |
  | `docs/dev/subagent-core/README.md:36`                                           | 「a non-consult `create()`/`resume()` call」                                                                                    | 改为「a `create()`/`resume()` call」                                                                                                                                                                                                                |
  | `docs/dev/subagent-core/README.md:40`                                           | 「Consult forks are exempt …」                                                                                                  | 删除该句；追加一段 legacy：旧 run 条目里的 `diag.experts/consults/consultOf/consultCache/consultThread/consultIdentityPrediction` 被忽略，`displayAgentType` 折叠 `consult:main-snapshot`；登记 `src/runtime/{cap-watcher,legacy-consult-forks}.ts` |
  | `docs/dev/subagent-core/README.md:54`                                           | 「Workflow children/consult/resume/`/task`」                                                                                    | 去掉 consult                                                                                                                                                                                                                                        |
  | `docs/dev/subagent-core/README.md:64`                                           | 「Program-derived runs (workflow children, consult, …)」                                                                        | 去掉 consult                                                                                                                                                                                                                                        |
  | `docs/dev/context-switch/README.md:19`                                          | 「every non-consult child run」                                                                                                 | 改为「every child run」                                                                                                                                                                                                                             |
  | `docs/dev/fabric-cross-session/README.md:44`                                    | 「`wakeExclusion`: consult fork, readonly domain …」                                                                            | 改为「readonly domain, caller-owned …；`consult_fork` 是 legacy 值，只读不产出，仍然排除 revive」                                                                                                                                                   |
  | `docs/dev/fabric-cross-session/README.md:62`                                    | 「run before any pi peer bump together with consult-preserve」                                                                  | 删掉「together with consult-preserve」                                                                                                                                                                                                              |
  | `docs/dev/fabric-cross-session/README.md:100`                                   | 「alongside fabric-wake C-P1–C-P5 and consult-preserve C1–C7」                                                                  | 删掉 consult-preserve                                                                                                                                                                                                                               |
  | `docs/dev/scheduled-reports/README.md:55`                                       | 「together with fabric C-P/C-X and consult-preserve」                                                                           | 删掉 consult-preserve；补一行 legacy：「`bg.consultMain` 保留为持久化字段（defHash），执行端忽略」                                                                                                                                                  |
  | `docs/dev/workflow/README.md:29-30`                                             | 允许的 8 个 key 含 experts，「malformed `experts` array」                                                                       | 改为 7 个 key；删掉 experts 的畸形数组条款                                                                                                                                                                                                          |
  | `docs/dev/workflow/README.md:33-38`                                             | `agent({ experts })` 整段（expert-scope、journal skip reasons）                                                                 | 删整段；改写为「chain taint 只由 isolation 触发」                                                                                                                                                                                                   |
  | `docs/dev/workflow/README.md:44`                                                | 「… exactly like `experts` does」                                                                                               | 改写为不比较 experts                                                                                                                                                                                                                                |
  | `docs/dev/workflow/README.md:5,72`                                              | 链接 `workflow-experts/` plan                                                                                                   | 保留（历史 plan 链接），后缀「（已随 #40 移除）」                                                                                                                                                                                                   |
  | `docs/dev/data-encryption/README.md:10`                                         | 「`consultSessionDir()` (`fork-store.ts`) routes create/main-fork/remove/sweep/index through `<state>/cache/consult-sessions`」 | 改为「`legacyConsultForkDir()`（`src/runtime/legacy-consult-forks.ts`）：legacy，`<state>/cache/consult-sessions` 只用于清扫旧 fork，不再创建」；vault 布局（`STATE_SUBDIRS` 里的 `consult`）按 legacy 说明保留                                     |
  | `docs/dev/external-agent/README.md:75`                                          | 「只读工具域（consult 专家、tidy）拒绝走 droid」                                                                                | 改为「只读工具域（tidy）拒绝走 droid」                                                                                                                                                                                                              |
  | `docs/dev/external-agent/README.md:111`                                         | 「(consult and tidy can never use it …)」                                                                                       | 改为「(tidy can never use it …)」                                                                                                                                                                                                                   |
  | `docs/dev/sysload/README.md:19`                                                 | 「consult / `/goal` verifier / tidy … are exempt」                                                                              | 去掉 consult                                                                                                                                                                                                                                        |
  | `docs/dev/web-hub/README.md:201`、`docs/dev/fabric-cross-session/README.md:205` | 英文动词「consults/consulted」                                                                                                  | 不改                                                                                                                                                                                                                                                |

- **定向**：
  ```sh
  npx vitest run tests/config tests/docs
  ```
  再加 §4.5 PS2 的扫描。

### 4.3 闭合检查（每包合入前跑，结果贴进报告）

```sh
# P0：旧名只剩 tool-scope 的别名，以及 consult 自身/消费者测试
rg -n "CONSULT_READONLY_TOOLS" src tests -g '!src/consult/**' -g '!tests/consult/**' -g '!tests/service/runtime-adapter-consult.test.ts'   # 期望：只有 src/runtime/tool-scope.ts 的别名行
rg -n "consult/watcher" src tests -g '!src/consult/**'                                                                                     # 期望：空
rg -n "consult/fork-store" src -g '!src/consult/**' -g '!src/stack.ts' -g '!src/runtime/session-driver.ts'                                  # 期望：空（schedule/wire 已迁）
# PW
rg -n "expert-scope" src tests                                                                                                              # 期望：空
# PD：src 里不再有导入方；测试导入方都是 PS1a/PS1b 才删的那几个
rg -n "consult-cache-marker|consult-transcript" src -g '!src/core/consult-cache-marker.ts' -g '!src/web-hub/agent/consult-transcript.ts'   # 期望：空
rg -ln "consult-cache-marker|consult-transcript" tests                                                                                      # 期望 ⊆ {conformance/consult-preserve, core/consult-cache-marker, consult/prompt, web-hub/agent/consult-transcript}
# PT
rg -n "abArm" src/tools src/core/dispatch-meta.ts src/service/resolve-target.ts   # 期望（生产者/schema）：只有 dispatch-meta.ts 的 legacy 丢弃注释；schema 不再接受、resume 不再写入 abArm
rg -ln "abArm" src tests scripts   # 期望（r3 按名列出）：命中文件 ⊆ {src/core/dispatch-meta.ts（legacy 丢弃注释）, src/core/run-journal.ts:30（注释，PS1b）, tests/core/dispatch-meta.test.ts、tests/core/run-journal.test.ts:71,246,318（旧元数据兼容输入）, tests/service/resolve-target.test.ts:186、tests/service/spawn-service.test.ts:172,226（PT 改为「输入带 abArm、继承结果不含」）, tests/tools/agent-tool.test.ts（只剩「abArm 作为未知 key 被拒」的输入）, tests/service/runtime-adapter-instrumentation.test.ts:101（原样镜像，PS1a 处理）}；scripts/exp/consult-ab-lib.mjs、tests/exp/consult-ab-analyze.test.ts、tests/fixtures/consult-ab/** 由 PDOC 删除后不得再出现
# PS1a：consult 运行时路径的使用点为空；typecheck 绿就证明 src/consult 仍可编译
rg -n "isConsultRun|consultC2|createConsultGuard|shadow-tools|installConsultAnchor|installPrefixProbe|classifyConsultToolEnd" src -g '!src/consult/**'   # 期望：空
# PS1b
test ! -e src/consult && rg -n "consult/|consult-summary|consult-cache-marker|consult-transcript|ConsultExpertRef|consultExperts|forkSessionFrom|@deprecated #40" src tests -g '!tests/fixtures/**'   # 期望：空，除 PS2 域与旧数据/否定断言允许列表外（见下；PS2 合入后 PS2 域一项不再命中）
# PS2
rg -n -i "consult" src/config                                                                                                               # 期望：空
rg -n -i consult src AGENTS.md docs/dev/*/README.md skills                                                                                  # 期望：只剩下面的允许列表；每条在 PS2 报告里归类
```

**允许列表（PS2 定稿）**——上面 PS1b 命令与 PS2 最终扫描的剩余命中只能属于这些类别：

- **PS2 域（PS2 合入后消失）**：`src/config/settings.ts` 的 consult 注释、`src/core/verdict-schema.ts` 里指向 `docs/dev/consult/…` 的注释（PS2 已改写为「档案 + #40 已移除」措辞）。
- **旧数据读取兼容输入 / 否定断言（刻意保留）**：`tests/workflow/replay.test.ts` 的旧 journal 行输入；`tests/tools/agent-tool-experts.test.ts` 的 `not.toHaveProperty("consultExperts")` 与 `not.toContain("consult")` 兼容断言；`tests/integration/consult-legacy-entries.test.ts`（旧字段输入 + `/consult/i` 否定断言）；`tests/core/{run-journal,presentation-diag}.test.ts` 的旧 consult 事实输入与 `not.toContain("consult")`。
- **保留资产**：`RESERVED_TOOL_NAMES` 里的 `"consult"`（fabric-xs-off golden）及其测试（`tests/runtime/tool-scope.test.ts`、`tests/service/runtime-adapter-readonly-domain.test.ts`）；`wakeExclusion: "consult_fork"` 字面量（`core/message.ts`、`fabric/wake.ts` 等只读不产出）；`src/runtime/legacy-consult-forks.ts`（`consult-sessions` 目录的只清扫）与 `src/runtime/cap-watcher.ts` 的 legacy 注释；`src/secure/**` 的 `STATE_SUBDIRS` `consult` 与 foreign-dir 白名单（#43 冻结面）及 `tests/secure/**` 对应断言；`LEGACY_CONSULT_MAIN_AGENT_TYPE`/`displayAgentType` 折叠；`src/commands/schedule.ts` 的 `--consult` 报错与 `--no-consult` 忽略；`bg.consultMain` 持久化字段。
- **legacy / 已移除说明**：带 `legacy|#40|removed|移除` 标记的注释与 README 说明（`docs/dev/{subagent-core,fabric-cross-session,scheduled-reports,data-encryption,workflow}/README.md`、`docs/dev/consult/REMOVED.md`）。
- **append-only wire / UI 兼容面（Q7）**：`src/web-hub/protocol/{messages,run-transcript}.ts` 的 `consult`/`consultCache`/`consultFallback` 字段与 `hub/run-transcript.ts` 的 fallback 分支；`src/web-hub/protocol/schedule.ts`、`ScheduleReview.vue`、`i18n/schedule-extra.ts`（`consultMain` legacy 展示，值为 true 时才显示）；`src/schedule/{core/reader,agent/ops,agent/bg,agent/view}.ts` 的 `consultMain` 持久化字段处理；`src/secure/**` 的 `consult-sessions` 目录与 `STATE_SUBDIRS`（#43 冻结面）。
- **历史出处注释（只引用被移除设计的章节号，不描述现行行为，本次不改）**：`consult plan §x`、`consult A/B instrumentation plan §x`、`(consult, …)`/`non-consult` 一类括注，例如 `src/{service,tools,core,delivery,memory,hud,traffic}/**` 与 `src/web-hub/protocol/{worktree-graph,feishu}.ts`（「作者 consult 裁定」= 向方案作者请教）。它们不影响行为；后续碰到相应文件时顺手清理，不单独成包。
- **英文动词用法**：`consulted/consults/consulting`（如 `web-hub/README.md:201`、`fabric-cross-session/README.md:205`）。

### 4.3.1 S0 闭合基线（r3，2026-10-25 @88da5b81，「开工前」各导出的导入方）

| 将在阶段 1 改动的导出 / 文件                                          | 当前导入方（src + tests + scripts）                                                                                                                                                                                                                                                          | 阶段 1 处置                                                                                                  | 闭合                                        |
| --------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------ | ------------------------------------------- |
| `workflow/expert-scope.ts`                                            | `src/workflow/host.ts`、`tests/workflow/{host,expert-scope}.test.ts`、`tests/integration/workflow-experts.test.ts`                                                                                                                                                                           | PW 删除                                                                                                      | 是（都在 PW 域内）                          |
| `core/consult-cache-marker.ts`、`web-hub/agent/consult-transcript.ts` | src：`tools/result-tool.ts`、`ui/fleet-panel.ts`、`web-hub/agent/{index,run-transcript,consult-transcript}.ts`；tests：`consult/prompt`、`conformance/consult-preserve`、`core/consult-cache-marker`、`web-hub/agent/consult-transcript`、`web-hub/{hub,ui}/run-transcript`                  | PD 停止 src 调用，并把两个 run-transcript 测试改用写死的 entries；模块保留                                   | 是（剩余导入方都是 PS1a/PS1b 才删的测试）   |
| `consult/watcher.ts` / `createCapWatcher`                             | `src/consult/{watcher,tool}.ts`、`src/memory/tidy/{command,cost}.ts`、`tests/consult/watcher.test.ts`                                                                                                                                                                                        | P0 迁移实现 + 垫片                                                                                           | 是                                          |
| `consult/fork-store.ts` 的三个导出                                    | 非 consult 导入方：`src/{stack,runtime/session-driver,schedule/agent/wire}.ts`、`tests/{secure/guard-points,runtime/runner-consult-reap,conformance/consult-preserve,schedule/agent/wire,integration/consult-reload-dispose}`、`tests/fixtures/preview-perf/stack-3609.ts.txt`（语料，不动） | P0 改为委托，签名不变；只迁 `schedule/agent/wire.ts`、`stack.ts:2266` 和 `tests/schedule/agent/wire.test.ts` | 是（不删导出）                              |
| `CONSULT_READONLY_TOOLS`                                              | 18 个文件（与 r2 一致），见 §2                                                                                                                                                                                                                                                               | P0 加新名 + 别名，迁移非 consult 消费者                                                                      | 是（不删导出）                              |
| `dispatch-meta` 的 `abArm`                                            | 见 §4.3 PT 允许列表                                                                                                                                                                                                                                                                          | PT                                                                                                           | 是（r3 把 `spawn-service.test.ts` 并入 PT） |

### 4.4 与并行工作的关系（r2：低风险批改为前置，不再并行）

- **低风险治理批**：#40 全部包 blockedBy 低风险 P1 合入（主会话裁定）。所有交互点都由 S0 处理（§4.0 表）。r1 的并行冲突表整表删除，包括其中错误的「治理 #6：schedule 文件搬家」一行：低风险批不搬 schedule 文件。
- **#43**：已合入（`0f74709d`、`4ea6bfec`）。#40 仍冻结 `src/secure/**`（`convert.mjs:2734` 的 consult-sessions foreign dir 保留）；PS1b 改 `tests/secure/guard-points.test.ts` 不再需要等待。P0 只**运行** `tests/secure/{stack-roots,guard-points}.test.ts` 作回归，不改它们。

### 4.5 验收判据

**冻结 golden**（I1–I4 每次都跑；`git diff --stat <base> -- tests/fixtures` 只允许出现 Q1 那份 golden 和 PDOC 删除的 `consult-{ab,cache}/`）：

```sh
npx vitest run tests/integration/fabric-xs-off-golden.test.ts tests/integration/fabric-xs-reply-off-golden.test.ts \
  tests/integration/schedule-off-golden.test.ts tests/memory/legacy-golden.test.ts \
  $(rg -l --glob "*.test.ts" "fabric-wake-off-golden|keepalive-legacy-golden|secure-off-golden|legacy-xs-v071" tests)
```

- **P0**：`createCapWatcher` 和清扫逻辑与原实现逐字等价（verifier 用 `git diff -M` 核对只有路径和名字变化）；`READONLY_DOMAIN_TOOLS` 的值不变；tidy readonly 行为不变；§4.3 P0 检查通过。
- **PW**：`agent({experts})` 返回专用拒绝文案；允许的 key 共 7 个；isolation 的 taint 和 fold property 测试全绿。
- **PD**：fleet/result/web status 不再出现 consult 文案；protocol 和 hub 的 diff 为空；hub fallback 兼容用例（缺文件、分页、leaf mismatch）在写死的旧 entries 上通过；`build:web` + `check:web` 绿；`drawer.css` 里不再有 `.run-tx-consult*`/`.run-tx-cachemark`。
- **PT**
  - 两份 Agent schema 都没有 `experts`；带 `experts` 的调用照常派发并有一行提示；`meta` 没有 `abArm`；schedule `defHash` 不变；quota 和 droid 文案不含 consult，但保留「不能当验收」和完整权限说明。
  - **nested golden 断言**（r2 第 7 条，PT 报告必须附结果）：
    ```sh
    node -e '
    const assert=require("node:assert");const {execSync}=require("node:child_process");
    const old=JSON.parse(execSync("git show <base>:tests/fixtures/tools/agent-nested-surface-golden.json","utf8"));
    const neu=JSON.parse(require("node:fs").readFileSync("tests/fixtures/tools/agent-nested-surface-golden.json","utf8"));
    assert.equal(neu.description, old.description);                                  // 顶层描述不变
    assert.deepStrictEqual(neu.allowedTypes, old.allowedTypes);
    const o=JSON.parse(old.parameters), n=JSON.parse(neu.parameters);
    delete o.properties.experts;                                                       // 允许差异 ①
    const before=o.properties.timeout_s.description;
    o.properties.timeout_s.description=before.replace("(consult, /goal verifier","(/goal verifier"); // 允许差异 ②
    assert.notEqual(o.properties.timeout_s.description, before);
    assert.equal(JSON.stringify(n), JSON.stringify(o));                                // 其余字段和 key 顺序逐字节相同
    console.log("nested golden diff OK");'
    ```
- **PDOC**（r2 第 8 条）
  - **活动文档零残留**：`rg -n -i "consult|\bexperts\b" README.md README.en.md docs/guide skills scripts/dev/readme-shots` 的每一行都必须同时匹配 `/移除|removed|#40/`，即每个文件最多一行「已移除」说明，也可以完全没有。
  - **历史文档精确允许列表**（不扫）：`docs/dev/consult/**`（README.md 由 PS2 删除）、`docs/dev/consult-removal/**`、`docs/dev/workflow-experts/**`、`docs/dev/fabric-v2/**`、`docs/dev/source-governance/{analysis,plan-lowrisk}.md`、`docs/research/**`、`CHANGELOG.md`、`docs/dev/**/{*plan*,*-report*,acceptance*,probe-results*,eval-*}.md`。
  - **活动链接**：`rg -n "scripts/exp/(consult|exp6)|references/consult(-ab)?\.md|consult-preserve|docs/dev/consult/README\.md" README.md README.en.md docs/guide skills scripts` 为空；再跑一个相对链接解析脚本，确认 README*、docs/guide、skills 里所有 `](相对路径)` 都指向存在的文件。
  - `npx vitest run tests/exp`（剩余实验脚本测试不引用已删的文件）。
- **PS1a**：§4.3 PS1a 检查为空；typecheck 绿（`src/consult` 仍可编译）；`tests/consult/**`、`tests/integration/consult-{wiring,reload-dispose}.test.ts`、`tests/core/consult-*` 绿（被删的用例在报告里列出）；`npm run test:conformance` 绿；tidy readonly 三组测试（`runtime-adapter-readonly-domain`、`readonly-domain-shadow-real-session`、`tool-scope-provenance`）绿。
- **PS1b**：§4.3 PS1b 检查为空；新建的 compat 测试绿；状态机矩阵和 property 绿；`stack-roots` 真实装配测试不改且通过；guard-points 改写后的两条断言通过。
- **PS2**
  - `rg -n -i consult src/config` 为空；带完整 consult 块的 settings 文件加载后不报错、不 warn，`/agent settings` 里没有 consult 旋钮。
  - `rg -n "consult-preserve" AGENTS.md docs/dev/*/README.md skills` 为空。
  - `rg -n -i consult AGENTS.md docs/dev/*/README.md` 的每一行必须匹配 `/legacy|#40|removed|移除/`（只剩 legacy 磁盘布局和读取兼容说明），或者是英文动词用法（逐条列在 PS2 报告里）。
  - `test ! -e docs/dev/consult/README.md`；`npx vitest run tests/docs` 绿。
- **I4 最终**：§4.1 R4 的全套命令 + 冻结 golden 命令全绿。

---

## 5. 风险与回滚

| 风险                                                                                             | 影响                                                       | 缓解                                                                                |
| ------------------------------------------------------------------------------------------------ | ---------------------------------------------------------- | ----------------------------------------------------------------------------------- |
| tidy readonly 域被连带改坏（`readonlyDomain` 与 `isConsultRun` 交织，runtime-adapter :652-1136） | `/mem tidy` 的提案 run 拿到写工具，或丢掉 StructuredOutput | P0 只改名；PS1a 改条件时由三组 readonly 测试守护；verifier 逐条对照 §1.3 的条件化简 |
| 阶段 1 某包删了仍被导入的导出（r1 的 Blocker）                                                   | 合入后 typecheck 或测试红                                  | §4.1 R1 + §4.3 闭合检查；PD/P0 的物理删除推迟到 PS1b                                |
| PS1a 中间态：consult 已接线但不起作用                                                            | 无用户影响（中间态不发版）                                 | R6 要求 `src/consult` 仍可编译；I2 全量绿才进 PS1b                                  |
| 状态机改动漏掉矩阵或 property                                                                    | 状态漂移                                                   | PS1b 硬性要求 `tests/core` 全绿，并人工复核矩阵 diff                                |
| fabric-xs-off golden 被误改（删了 `RESERVED_TOOL_NAMES` 里的 `"consult"`）                       | 冻结面破坏                                                 | §1.1 明确保留；I1–I4 都跑 golden 命令                                               |
| schedule hash 漂移                                                                               | 用户已批准的任务全部失效                                   | `consultMain` 字段不动；PT 新增 hash 稳定断言                                       |
| 新旧 agent/hub 混跑                                                                              | transcript 帧解析失败                                      | 协议和 hub 冻结；PD 用写死的旧 entries 保留 hub 兼容用例                            |
| 并发运行的旧版本进程的 fork 被误删                                                               | 旧进程里的 consult 失败                                    | 清扫语义逐字保留（24h TTL + 碎片规则），`stack-roots` 真实装配测试守护              |
| 下沉 README 漏改或误删 legacy 说明                                                               | 开发者读到失效门禁，或丢了兼容信息                         | PS2 以 P1 清单 + 重跑 rg 为输入；验收要求每条残留都带 legacy/#40 标记               |
| S0 坐标漂移（低风险批改了大量 import 行）                                                        | 包的文件域不准                                             | S0 重跑 grep、闭合检查和 conflict-check，写回 r3 后才开工                           |

**后续项（不阻塞 #40）**：

- R-F1：`secure/command.ts:131` 的 `/secure status` 文本和 `secure/domain.ts` 的 `consult` 字段名，等 #43 收口后再议改名或标 legacy。
- R-F2：README 截图（`docs/images/*`）若仍有 consult 行，用 `scripts/dev/readme-shots` 重生（PDOC 已把演示数据里的 consult 删掉）。
- R-F3：Agent 工具的 `experts` 忽略提示，到下一个 minor 时删除（拍板 Q2）。

**回滚**：每包是独立提交，全部在 dev 上，不发版。

- 阶段 1 任意一包都可以单独 `git revert`（R1 保证互不依赖）。
- PS1b、PS1a 按逆序 revert：PS1a 后的状态是「入口和运行时已关、consult 代码还在」，可以作为安全停靠点。
- PS2 可以单独 revert。
- 本方案不删除任何用户数据，也不改写 settings 文件。

---

## 6. 需用户拍板项

r1 的 Q1–Q11 已由用户拍板，见文末。r3（S0）也不新增拍板项。**r2 不新增拍板项**：第 7 条是 Q1 的范围细化（主会话转述用户已批准一次性更新），其余都是工程处置。

## 附录 A：阶段 1 冲突预检 spec（r3）

运行：`node skills/dev-flow/scripts/conflict-check.mjs <spec> --cwd .`，2026-10-25 @88da5b81 时 exit 0。

```json
[
  {
    "id": "P0",
    "globs": [
      "src/runtime/cap-watcher.ts",
      "src/runtime/legacy-consult-forks.ts",
      "src/runtime/tool-scope.ts",
      "src/memory/tiered.ts",
      "src/memory/tidy/command.ts",
      "src/memory/tidy/cost.ts",
      "src/schedule/agent/wire.ts",
      "src/service/runtime-adapter.ts",
      "src/stack.ts",
      "src/consult/watcher.ts",
      "src/consult/fork-store.ts",
      "tests/consult/watcher.test.ts",
      "tests/runtime/cap-watcher.test.ts",
      "tests/runtime/legacy-consult-forks.test.ts",
      "tests/memory/tiered.test.ts",
      "tests/runtime/tool-scope.test.ts",
      "tests/runtime/tool-scope-provenance.test.ts",
      "tests/service/runtime-adapter-readonly-domain.test.ts",
      "tests/service/runtime-adapter-child-switch.test.ts",
      "tests/integration/readonly-domain-shadow-real-session.test.ts",
      "tests/schedule/agent/wire.test.ts",
      "tests/sysprompt/memory-tiered-section.test.ts"
    ]
  },
  {
    "id": "PW",
    "globs": [
      "src/workflow/host.ts",
      "src/workflow/agent-opts.ts",
      "src/workflow/worker-source.ts",
      "src/workflow/replay.ts",
      "src/workflow/types.ts",
      "src/workflow/spawner-adapter.ts",
      "src/workflow/expert-scope.ts",
      "src/tools/workflow-tool.ts",
      "tests/workflow/host.test.ts",
      "tests/workflow/agent-opts.test.ts",
      "tests/workflow/replay.test.ts",
      "tests/workflow/replay-taint.property.test.ts",
      "tests/workflow/replay-taint-isolation.property.test.ts",
      "tests/workflow/host-iso-fold.property.test.ts",
      "tests/workflow/spawner-adapter.test.ts",
      "tests/workflow/worker-host-call.test.ts",
      "tests/workflow/expert-scope.test.ts",
      "tests/tools/workflow-tool.test.ts",
      "tests/integration/workflow-experts.test.ts"
    ]
  },
  {
    "id": "PD",
    "globs": [
      "src/ui/fleet-panel.ts",
      "src/ui/fleet-widget.ts",
      "src/tools/result-tool.ts",
      "src/web-hub/agent/status.ts",
      "src/web-hub/agent/run-transcript.ts",
      "src/web-hub/agent/index.ts",
      "src/web-hub/ui/src/components/drawer/RunTranscript.vue",
      "src/web-hub/ui/src/components/fleet/FleetTree.vue",
      "src/web-hub/ui/src/styles/drawer.css",
      "src/web-hub/ui/src/i18n/zh/fleet.ts",
      "src/web-hub/ui/src/i18n/en/fleet.ts",
      "src/web-hub/ui/src/i18n/zh/drawer.ts",
      "src/web-hub/ui/src/i18n/en/drawer.ts",
      "tests/ui/fleet-consult-cache.test.ts",
      "tests/ui/fleet-widget.test.ts",
      "tests/ui/fleet.test.ts",
      "tests/tools/result-consult-cache.test.ts",
      "tests/tools/result-tool.test.ts",
      "tests/web-hub/agent/status-consult-cache.test.ts",
      "tests/web-hub/agent/snapshot.test.ts",
      "tests/web-hub/agent/wiring-control.test.ts",
      "tests/web-hub/ui/consult-cache-display.test.ts",
      "tests/web-hub/ui/fleet-tree.test.ts",
      "tests/web-hub/ui/run-transcript.test.ts",
      "tests/web-hub/hub/run-transcript.test.ts"
    ]
  },
  {
    "id": "PT",
    "globs": [
      "src/tools/agent-tool.ts",
      "src/core/dispatch-meta.ts",
      "src/service/resolve-target.ts",
      "src/tools/list-subagents-tool.ts",
      "src/tools/extend-timeout-tool.ts",
      "src/tools/schedule-tool.ts",
      "src/commands/schedule.ts",
      "src/schedule/agent/bg.ts",
      "src/schedule/agent/executors.ts",
      "src/schedule/agent/view.ts",
      "src/external-agent/messages.ts",
      "src/quota/render.ts",
      "src/web-hub/ui/src/components/schedule/ScheduleReview.vue",
      "src/web-hub/ui/src/i18n/schedule-extra.ts",
      "tests/fixtures/tools/agent-nested-surface-golden.json",
      "tests/tools/agent-tool.test.ts",
      "tests/tools/agent-tool-experts.test.ts",
      "tests/tools/model-facing-strings.test.ts",
      "tests/core/dispatch-meta.test.ts",
      "tests/core/run-journal.test.ts",
      "tests/service/resolve-target.test.ts",
      "tests/service/spawn-service.test.ts",
      "tests/integration/explicit-timeout-producers.test.ts",
      "tests/integration/consult-ab-instrumentation.test.ts",
      "tests/integration/dispatch-meta-instrumentation.test.ts",
      "tests/schedule/agent/bg.test.ts",
      "tests/schedule/agent/dispatch.test.ts",
      "tests/schedule/core/spec.test.ts",
      "tests/commands/schedule.test.ts",
      "tests/external-agent/messages.test.ts",
      "tests/external-agent/port.test.ts",
      "tests/quota/gate.test.ts",
      "tests/quota/hook.test.ts",
      "tests/quota/render.test.ts",
      "tests/web-hub/ui/schedule-panel.test.ts"
    ]
  },
  {
    "id": "PDOC",
    "globs": [
      "scripts/exp/consult-*",
      "scripts/exp/exp6-*",
      "scripts/dev/readme-shots/**",
      "tests/exp/consult-*",
      "tests/fixtures/consult-ab/**",
      "tests/fixtures/consult-cache/**",
      "skills/**",
      "README.md",
      "README.en.md",
      "docs/guide/subagents.md",
      "docs/guide/quota-load.md",
      "docs/dev/consult/REMOVED.md",
      "docs/dev/workflow-experts/plan.md",
      "scripts/exp/topic-judge-eval/README.md"
    ]
  }
]
```

## 用户拍板（2026-10-25）

- Q1：`agent-nested-surface-golden.json` 在 PT 中一次性重生，验收核对 diff 只少了 experts 字段与描述。
- Q5：schedule 保留持久化字段 `bg.consultMain`（defHash 稳定），工具参数删除、`/schedule --consult` 报错、执行端遇到 true 忽略并提示。
- Q9（与低风险治理 Q8 冲突，主会话裁定 + 用户确认）：**AGENTS.md 瘦身（治理 ①）先合**；consult 段整段下沉到 `docs/dev/consult/README.md`（带「#40 将删除」横幅），PS2 改为删除该 README 与 AGENTS.md 目录表中的一行。
- Q2–Q4、Q6–Q8、Q10、Q11：全部按推荐。

## I1 结果与主会话裁定（2026-10-25，dev @ `bd50422e`）

- 全量 vitest（--maxWorkers=4）29295 过 / 6 失败，conformance 33 文件中 31 过。fixtures 只有授权改动（Q1 golden 一处 + PDOC 删除的 `consult-{ab,cache}/` 六个文件）。
- 失败全部同源：`tests/conformance/consult-preserve.test.ts`（C1/C1 shape/C2/C11 等）在阶段 1 后必然失败——PT 已让 Agent 忽略 `experts`，该 conformance 依赖 `Agent({experts})` 派 consult（`byResult: invalid`）。r3 「PS1b 前保持绿」的预期不成立；**裁定：这是停用入口的预期后果，不是回归**，由 PS1a 删除该套件。
- `tests/conformance/fabric-xs.test.ts` C-X6（「phase-1 C-P1–C-P5 and consult-preserve C1–C7 remain green」）连带失败——**r3 漏列**：PS1a 文件域加入 `tests/conformance/fabric-xs.test.ts`，把 consult-preserve 从 C-X6 的子运行列表与标题中移除（C-P1–C-P5 保留）。
- `tests/web-hub/hub/cmd-history-runtail.test.ts` 1 例为既知高负载 flake，与本批无关，另行跟踪。
- I2（PS1a 合入后）判据：全量 vitest 与 conformance 除既知 flake 外全绿。
