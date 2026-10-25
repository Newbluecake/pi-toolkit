# PS1a 报告 — 运行时 / service 清理（#40，dev @ 19d15657 工作区，未提交）

## 改动

**src（6 个）**

- `src/runtime/session-driver.ts`：删除 anchor / prefix-probe / preserve-guard 安装、`compareConsultIdentity`、`isConsultForkSpec` 及其豁免、`consultIdentityPrediction`、`takeConsultCacheFirst` / `consult_cache_first` 发射、consult `tool_end` 分类、`consultRunId` 吸收。`computeChildExtensionMissing(activationBefore)` 与 `markChildSession(sm, persist)` 去掉 consult 参数。`PiSessionHandle` 构造只剩 `(session, childExtensionMissing)`。不再导入 `src/consult/**` 和 `core/consult-summary`。
- `src/runtime/runner.ts`：`openFile` 只看 `resumeFrom`；删除 `consultIdentityPrediction` 透传。`onReaped(runId, forkSessionFrom?, …)` 签名与 `req.forkSessionFrom` 透传保留（R6，值恒为 undefined）。
- `src/runtime/tool-scope.ts`：`BashJobGrantInput.consult` → `readonlyDomain`；删除 `reportBlockedOnBind`（类型、`buildToolScopePolicy` 选项、enforcer 分支）。`READONLY_DOMAIN_TOOLS`、`CONSULT_READONLY_TOOLS` 别名、`RESERVED_TOOL_NAMES` 里的 `"consult"` 不动。
- `src/service/runtime-adapter.ts`：删除 `isConsultRun`/`consultC2`/shadow 工具/`createConsultGuard`/consult 工具注入/`askerCwd`/`consultDisplayMeta` 使用/`diag.experts` 与 `toExpertRecords`/`consultOf`。`readonlyDomain = toolDomain==="readonly"`；StructuredOutput 闸门 `!isExternal && schema`；`readonlyProvenance` 闸门 `readonlyDomain`；nested Agent 不再透传 `resolveExperts`；adapter 层的 consult `onReaped` 早退调用删除。deps 的 `consult`/`consultResolveExperts`/`consultDisplayMeta` 保留并标 `@deprecated #40`、不读（stack 还在传）；`onReaped` 转发保留。
- `src/service/spawn-service.ts`：删除 `MAIN_SNAPSHOT_TYPE_CONFIG` 与 `CONSULT_MAIN_AGENT_TYPE` bypass、fork 准入分支（含 statSync、parent stopping、与 resume 互斥）、canSpawn 的 fork 例外、nesting 的 `!forkSessionFrom`、droid 对 experts/fork 的拒绝（`MSG_EXPERTS_UNSUPPORTED` 使用点）、`wakeExclusion` 的 `consult_fork` 产出、readonly 互斥文案里的 `forkSessionFrom`、以及 D19 的 `stopping` 集合（只服务 fork 准入，删后无读者，整个移除）。
- `src/service/request-threading.ts`：**未删**四个 consult 字段条目，只加 legacy 注释——`SpawnRequest` 字段按 R6 保留到 PS1b，而 Gate C 是类型级穷举，删条目会让 tsc 红。已用 message_agent 通知 root，默认做法：PS1b 与类型字段一并删除。

**tests**

- 删除文件：`tests/service/runtime-adapter-consult.test.ts`、`tests/runtime/{session-driver-consult-anchor,session-driver-consult-preserve,session-driver-prefix-probe,runner-consult-reap}.test.ts`、`tests/conformance/consult-preserve.test.ts`、`tests/conformance/fixtures/{consult-production,permissive-guard}.ts`、`tests/integration/{consult,consult-worktree-cwd}.test.ts`。
- `tests/conformance/fabric-xs.test.ts`：C-X6 标题与子运行列表移除 consult-preserve（C-P1–C-P5 保留），断言由 `/2 passed/` 改为 `Test Files 1 passed (1)`（原正则会被 "Tests 12 passed" 误匹配）。
- 修改：`tests/conformance/input-budget.test.ts`（`computeChildExtensionMissing` 单参）、`tests/runtime/{session-driver,session-driver-child-marker,nested-run-usage,tool-scope,runner-reaped-disposed}.test.ts`、`tests/service/{admission-reason,runtime-adapter-child-switch,runtime-adapter-instrumentation,runtime-adapter-journal,runtime-adapter-prompt-notes,spawn-fork-admission,spawn-readonly-domain,spawn-service-external,spawn-wake-exclusion}.test.ts`、`tests/integration/consult-wiring.test.ts`。
- `tests/fixtures/**`：零改动。

### 被删 / 改写的用例（逐条）

- `session-driver.test.ts`：删 3 例 consult tool_end 分类（改为 1 例「consult 名工具不再分类，plain shape」）、删 `isConsultForkSpec` 2 例与「consult 豁免」1 例（`computeChildExtensionMissing` 改单参 2 例）。
- `session-driver-child-marker.test.ts`：删「consult fork spec 不写 marker」1 例，其余改单参调用。
- `nested-run-usage.test.ts`：consult 用例改为「usage 仍累计，但 consultRunId 不再进入 absorbedRunIds」。
- `tool-scope.test.ts`：`bashJobGrant({consult})` → `{readonlyDomain}`，文案同步。
- `runner-reaped-disposed.test.ts`：触发 `driver.resume` 的方式由 `forkSessionFrom` 改 `resumeFrom`，去掉对 `fork` 值的期望；`{disposed}` 语义断言不变。
- `spawn-fork-admission.test.ts`：整体改写为 7 例——保留 canSpawn 门禁、control 组、notifyTerminalFailure 两例、abort 期间嵌套准入；删 fork 准入 T-7 全组（6 例）、consult("main") 无 type 准入（3 例）、D19 fork-vs-stopping（6 例）；新增 2 例「legacy `forkSessionFrom` 不再绕过 canSpawn / 不再校验文件」「legacy fork 请求在允许的 parent 下按普通嵌套 run 准入」。
- `admission-reason.test.ts`：删 5 个 case（external consult experts、external fork、fork parent stopping、fork+resume、fork file missing）；计数 29→24、`retryable` 静态计数 30→25。
- `spawn-service-external.test.ts`：删「consultExperts / forkSessionFrom ⇒ MSG_EXPERTS_UNSUPPORTED」1 例。
- `spawn-wake-exclusion.test.ts`：「consult_fork 优先」改为「legacy forkSessionFrom 不再产出 consult_fork（expectAck→caller_owned，否则 none）」。
- `spawn-readonly-domain.test.ts`：互斥矩阵去掉 `forkSessionFrom` 一行。
- `runtime-adapter-instrumentation.test.ts`：META 去掉 `abArm`；删 experts granted true/false、consultOf、consult-fork、cap=16 共 5 例，改写为 5 例（dispatchMeta/schemaPreset 折叠、带 consultExperts 不注入 consult 且无 diag.experts、readonly 域、legacy forkSessionFrom 是普通 run 且无 consultOf、零变化键集）。
- `runtime-adapter-journal.test.ts`：「consult forks 与 readonly 不 journal」拆成只含 readonly 的 1 例。
- `runtime-adapter-prompt-notes.test.ts`：删「consult run prompt 为原问题」1 例。
- `runtime-adapter-child-switch.test.ts`：该例改用 `toolDomain:"readonly"`。
- `consult-wiring.test.ts`：「consultExperts 注入 consult 工具」改为断言**不**注入；删「consult('main') fork 实时 main 文件」端到端 1 例（依赖已删运行时路径）。其余 `tests/consult/**`、`consult-reload-dispose`、`tests/core/consult-*` 未改且全绿。

## 自验（均为本地实跑）

- 闭合检查（方案 §4.3 PS1a）`rg -n "isConsultRun|consultC2|createConsultGuard|shadow-tools|installConsultAnchor|installPrefixProbe|classifyConsultToolEnd" src -g '!src/consult/**'`：使用点为空；剩 3 行都在 PS1b 域——`src/core/consult-summary.ts:251`（函数定义，按方案保留）、`src/core/types.ts:636,886`（注释）。
- `npm run typecheck`（tsc 主配置 + typecheck 配置 + vue-tsc）：通过，无输出错误；`src/consult/**` 仍可编译。
- 定向 vitest：`tests/runtime tests/service`（67 文件 691 过）；`tests/integration tests/consult tests/core tests/fabric`（213 文件 3028 过 2 skip）；其中含 tidy readonly 三组（runtime-adapter-readonly-domain、readonly-domain-shadow-real-session、tool-scope-provenance）、consult-wiring、consult-reload-dispose。
- `npx vitest run tests/conformance/fabric-xs.test.ts tests/conformance/fabric-wake.test.ts tests/conformance/input-budget.test.ts`：3 文件 30 例全过（C-X6 含）。
- `npx prettier --check` 改动的 .ts：全部通过。
- `git diff --stat -- tests/fixtures | wc -l`：**0**。
- 全量与 `npm run test:conformance` 未跑（留给 I2）。

## 遗留 / 备注

- request-threading 四个条目的保留见上，PS1b 同步删除。
- `runner.ts` 仍把 `req.forkSessionFrom` 传给 `onReaped`（恒 undefined），`stack.ts` 的 consult 接线（`wireConsult`/`onReaped` 的 fork 清理）不动，PS1b 处理。
- `RuntimeAdapterDeps.{consult,consultResolveExperts,consultDisplayMeta}`、`tests/consult/**` 里依赖旧别名的测试按 R6 原样保留。
