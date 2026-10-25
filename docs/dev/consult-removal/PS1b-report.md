# PS1b 报告 — 装配 / 类型物理删除（#40，dev @ d6e49e7c 工作区，未提交）

## 改动

**物理删除**：`src/consult/**`（14 文件）、`src/core/{consult-summary,consult-cache-marker}.ts`、`src/web-hub/agent/consult-transcript.ts`；`tests/consult/**`、`tests/core/consult-{summary,cache-marker,cache-diag,cache-persistence}.test.ts` + `consult-cache-fixtures.ts`、`tests/web-hub/agent/consult-transcript.test.ts`、`tests/integration/{consult-wiring,consult-reload-dispose}.test.ts`。

**src（修改）**

- `core/types.ts`：删 `ConsultExpertRef`/`RunExpertRecord`/`EXPERTS_REFS_CAP`/`capExpertRefs`/`CONSULT_MAIN_EXPERT_ID`/`ForkExpertSessionResult`/`ToolDeclaration`/`ExpertRequestSnapshot`/`ConsultGuard*`/`ConsultIdentityPrediction`/`AnchorIdentity`/`ConsultAnchor*`/`ConsultCacheResult`/`ConsultWarmPrediction`/`ConsultThreadRef`/`ConsultCacheDiagnostics`；`SpawnRequest` 去 `consultSnapshot/consultAnchor/consultExperts/forkSessionFrom`；`RunDisplayMeta`/`RunDiagnostics` 去 `experts/consultOf/consultCache/consultThread/consults/consultIdentityPrediction`；`SessionSpec` 去 `consultAnchor/consultGuard/consultSnapshot/forkSessionFrom`；DriverEvent 去 `consult_cache_first` 与 `tool_end.consult`；`session_created` 事件去 `consultIdentityPrediction`。`CONSULT_MAIN_AGENT_TYPE` → `LEGACY_CONSULT_MAIN_AGENT_TYPE`，`displayAgentType` 保留（折叠为字面量 `"main"`）。
- `core/state-machine.ts`：删 consult 折叠（`foldConsultCall`）、`consult_cache_first` 分支、enqueued 的 experts/consultOf/consultCache/consultThread、session_created 的 identity prediction、tool_end 非法路径的 consults 合并（回到 `illegal(state,input)`）。状态机矩阵仍 12 phase × 17 input = 204 键，无需改键数。
- `core/run-journal.ts`：`JOURNAL_DIAG_FIELDS` 去 6 个 consult 字段，删 experts 封顶逻辑。`core/message.ts`：`consult_fork` 标注 legacy-read-only（字面量保留）。
- `stack.ts`：删 `wireConsult`/`consultRef`/`previousConsult`/`consultForkStore`/`mainSessionFactsFrom`/`priceOf`、adapter 的 consult deps、`dispatchSnapshot` 分接口、workflow `resolveExperts`、executors 的 `consult`、`StackHandle.consult`；`onReaped` 改 `(runId, sessionId, info)`；保留 `sweepLegacyConsultForks()` 每次 build 一次。`index.ts`：删 `resolveExperts` 与两处 `consult.close()`。
- `service/runtime-adapter.ts`：删 deprecated deps（`consult`/`consultResolveExperts`/`consultDisplayMeta`）；`onReaped` 签名收窄。`service/resolve-target.ts`：`matchRunId` 不再导出（ExpertIndex 钩子）。`service/request-threading.ts`：删 4 个 legacy 条目（PS1a 遗留）。
- `runtime/runner.ts`：`onReaped` 收窄，删 RunnerSpec 的 `forkSessionFrom`。`runtime/tool-scope.ts`：删 `CONSULT_READONLY_TOOLS` 别名；`RESERVED_TOOL_NAMES` 的 `"consult"` **保留**（fabric-xs-off golden），注释改为 legacy。
- `tools/agent-tool.ts`/`schedule/agent/{bg,executors}.ts`/`workflow/{host,spawner-adapter}.ts`：删 deprecated `resolveExperts`/`consult` 成员与 `consultExperts` 透传；`tools/result-tool.ts`：去 consult 类型；`external-agent/messages.ts`：删 `MSG_EXPERTS_UNSUPPORTED`/`msgExpertIsExternal`；`commands/status.ts`、`cache-ttl/child-registry.ts`：仅注释。
- `runtime/{cap-watcher,legacy-consult-forks}.ts`：仅改注释（去掉对已删路径的引用）。保留资产本体未动。

**tests**

- 新建 `tests/integration/consult-legacy-entries.test.ts`（4 例）：带全部旧字段（experts/consults/consultOf/consultCache/consultThread/consultIdentityPrediction、`dispatchMeta.abArm`、`consult:main-snapshot`、`wakeExclusion:"consult_fork"`）的条目 ① 经 `seedRunStoreFromEntries` 读回且不剥字段；② `get_subagent_result`/`list_subagents`/`renderRunDetail`/`buildFleetViewModel`/`projectFleet` 渲染且无 consult 文案，agentType 折叠为 `main`；③ resume 打开旧 session 文件，新 run diag 无旧字段、`dispatchMeta` 无 `abArm`、`wakeExclusion` 不再是 `consult_fork`；④ wake preflight 对旧 `consult_fork` 返回 `{ok:false,reason:"consult_fork"}`，对照组可唤醒。
- `tests/secure/guard-points.test.ts`：改写为两条——plain/secure 的 `legacyConsultForkDir()`；secure 下默认清扫只清 vault 根（过期 + 碎片删除、新鲜保留），根外文件与 plain agentDir 下同名文件不受影响。`tests/secure/stack-roots.test.ts` **未改且通过**。
- `tests/runtime/legacy-consult-forks.test.ts`：去掉 fork-store 委托用例。`tests/core/{core,run-journal,presentation-diag}.test.ts`：删 `consult_cache_first` 矩阵行/consult fold property；run-journal 用 `LEGACY_CONSULT_DIAG` 证明旧字段被投影丢弃；presentation-diag 改为「旧 consult 事实/meta 被忽略」。
- 其余按删除的 API 同步：request-threading、runtime-adapter-{instrumentation,readonly-domain}、spawn-{fork-admission,wake-exclusion,pool-full}、runner-{reaped-disposed,session-hooks}、child-bash-{exit-facts,resume-driver}、explicit-timeout-producers、fabric-xs-child-scope（删仅验证 consult guard 的一例）、workflow 系列（host/spawner-adapter/worker-host-call/两份 taint property/host-iso-fold）、workflow-experts、schedule bg/stack-wiring、commands/task、external-agent/messages、tools/agent-tool-experts、external-disabled-bytes（标题）。
- `tests/fixtures/**`：零改动。

## 自验

- `npm run typecheck`（tsc ×2 + vue-tsc）：通过；`npm run build`：通过。
- 闭合检查 `test ! -e src/consult && rg "consult/|consult-summary|consult-cache-marker|consult-transcript|ConsultExpertRef|consultExperts|forkSessionFrom|@deprecated #40" src tests -g '!tests/fixtures/**'`：`src/consult` 已不存在；残留命中全部是**允许项**，逐条：
  - PS2 范围（本包不碰）：`src/config/settings.ts:396`、`src/core/verdict-schema.ts:2`（注释里的 `docs/dev/consult/…` 路径）。
  - 旧数据/兼容断言（刻意保留）：`tests/workflow/replay.test.ts:853`（旧 journal 行输入）、`tests/tools/agent-tool-experts.test.ts` 的 `not.toHaveProperty("consultExperts")`（PT 的兼容用例）。
  - 另有 `tests/integration/consult-legacy-entries.test.ts` 的 `/consult/i` 否定断言。
- 定向测试（全绿）：`tests/core`（24 文件 1019 例，含状态机矩阵与全部 property）；`tests/service tests/runtime tests/fabric tests/schedule tests/commands tests/secure/{guard-points,stack-roots} tests/workflow tests/tools tests/external-agent`（234 文件 3500 例）；`tests/integration`（127 文件 872 过 2 skip，含 fabric-xs-off-golden/reply-off-golden、schedule-off-golden、secure-off、新 compat 测试）；`tests/web-hub/agent tests/fabric tests/boundary tests/memory tests/docs` + `tests/conformance/{fabric-xs,fabric-wake}`（170 文件 3168 例）。
- `npx prettier --check` 全部改动文件：通过。`git diff --stat -- tests/fixtures | wc -l`：**0**。
- 全量与 `npm run test:conformance` 全套、`build:web` 未跑（留给 I3）。

## 遗留 / 备注

- `rg -i consult src/config` 仍有 31 行（PS2 域，按方案不动）。
- `tests/service/spawn-fork-admission.test.ts` 内容已只剩嵌套准入用例，文件名保留（不做 git mv）。
- `docs/dev/**` 里仍有对已删 `src/consult/*` 的引用，归 PS2。
