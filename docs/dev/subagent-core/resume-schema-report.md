# #68 resume 默认沿用原 run 的 schema — 报告

## 改动

- `src/core/types.ts`：`SpawnRequest.inheritSchema?: true`；`RunDisplayMeta.schema?` / `RunDiagnostics.schema?`（内联 schema 记录，append-only）。
- `src/core/state-machine.ts`：`enqueued` 把 `meta.schema` 镜像进 `diag.schema`（写一次）。
- `src/core/run-journal.ts`：journal 白名单加 `schema`。
- `src/core/json-schema.ts`：`PERSISTED_SCHEMA_MAX_CHARS`(16384) + `isPersistableSchema`。
- `src/service/runtime-adapter.ts`：非预设且未超限的内联 schema 写入 display meta。
- `src/service/resolve-target.ts`：`resolveResumeTarget` 返回 `schemaPreset`/`schema`（仅终态快照 diag）。
- `src/service/spawn-service.ts`：`inheritSchema && schema===undefined` 时按 preset id（冻结预设）或内联 schema 补全；校验/复验链路不变。
- `src/service/request-threading.ts`：`inheritSchema` 归 NOT_THREADED。
- `src/tools/agent-tool.ts`：resume 且未传 schema ⇒ 置 `inheritSchema`；`schema: null` + resume ⇒ 取消继承；仅主会话 `schema` 描述补一句（嵌套面共享 `trailingFields` 未动，golden 不变）。
- 文档：`docs/dev/subagent-core/README.md` 新增段落。
- 测试：新增 `tests/service/resume-schema.test.ts`（7）；`tests/tools/agent-tool.test.ts` 新增 5。

## 语义

继承 / 显式覆盖 / `null` 取消；原 run 无 schema、旧 run 无记录、内联超限 ⇒ 不继承。@mention、fabric wake、RPC 的 resume 不带标志，行为不变。workflow `agent()` 不受影响。

## 自验

见最终回复（typecheck、vitest tools/service/runtime/core、conformance、prettier、fixtures diff）。

## 遗留

- tombstone 不带 schema：run 快照被逐出且只剩 tombstone 时不继承（与 dispatchMeta 同口径）。
- 嵌套 Agent 的 `schema: null` 也被 prepareSpawn 接受，但描述未宣传。

## 建议 commit message

`feat(agent): resume 未传 schema 时沿用原 run 的 schema（#68）`

正文：Agent resume 不带 schema 时继承原 run 的 preset 名或内联 schema（含 StructuredOutput 注入与 host 复验）；显式 schema 覆盖，`schema: null` 取消；run 诊断 append-only 新增 `diag.schema`（≤16KB），旧 run 无记录则维持原行为。
