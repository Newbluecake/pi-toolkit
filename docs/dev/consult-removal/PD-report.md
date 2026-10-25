# #40 PD（显示面）交付报告

基线：worktree 自 dev @ `b8f9a43e`（r3 坐标）。范围严格限附录 A 的 PD 文件域；未改 `tests/fixtures/**`、`src/web-hub/protocol/**`、`src/web-hub/hub/**`。

## 改动内容

### src（停止产出/渲染；模块本身推迟到 PS1b 物理删除，§4.1 R1）

- `src/ui/fleet-panel.ts`：删 `consultCacheMarkerOfDiag` import（:16）、`FleetRow.consultCacheMark` 字段（:104-108）、`toRow` 的赋值（:454）；:404 的 sentinel 折叠注释改为「#40 legacy read」措辞（`displayAgentType` 折叠行为保留，§3.1）。
- `src/ui/fleet-widget.ts`：删 widgetRowMain 的 `cc` 字段与 `drop("cc")`、widgetTerminalDetail 的 consult marker suffix 块。
- `src/tools/result-tool.ts`：停止调用 `formatConsultCacheLine`，去掉 `consult-cache-marker` import 与 exitSuffix 里的 consult 行；本地 diag 结构类型里的 `consultCache`/`consultThread` 字段保留（旧条目读取兼容，类型随 PS1b 删除）。
- `src/web-hub/agent/status.ts`：删 `consultCacheWire()`、`row.consult = true` 投影、`FleetRowConsultCacheWire`/`FLEET_CACHE_MARK_MAX` import（协议侧字段保留不动）。
- `src/web-hub/agent/run-transcript.ts`：删 `consultTranscript`/`ConsultTranscriptDiagnostics` import、`RunTxRunInfo.diag`、`replyTerminal` 的 `consultFallback` 产出。
- `src/web-hub/agent/index.ts`：`QueryControlPort.get` 的 diag 改用本地结构类型（只剩 `sessionFile`/`finalLeafId`），不再导入 `ConsultTranscriptDiagnostics`；`info()` 映射不再透传 diag。

### UI

- `RunTranscript.vue`：删 consultSummary/consultPrompt/consultMark computed 与 `.run-tx-consult` aside 块。
- `FleetTree.vue`：删 `activityOf` 的 consult 分支（line-2 回到「live activity，否则 phase」）、`cacheMarkOf()` 与两处 `run-cachemark` span；:120 注释去掉 consult-prefix 提法。
- `styles/drawer.css`：删 :178-200 的 `.run-tx-consult` / `.run-tx-cachemark` / `.run-tx-consult pre`。
- i18n：删 zh/en `drawer.consultSummary`/`consultFullPrompt`、`fleet.consultDone`/`consultIncomplete`/`consultRunning`。

### tests

- 删除：`tests/ui/fleet-consult-cache.test.ts`、`tests/tools/result-consult-cache.test.ts`、`tests/web-hub/agent/status-consult-cache.test.ts`、`tests/web-hub/ui/consult-cache-display.test.ts`。
- `tests/web-hub/agent/snapshot.test.ts`：删 `consult:true` 投影用例（投影已删）。
- `tests/web-hub/agent/wiring-control.test.ts:590`：改写为「终态 diag 带旧 `consultOf` 也**不再**产出 `consultFallback`」（断言 reply 无该键）。
- `tests/web-hub/hub/run-transcript.test.ts`：不再导入 `consultTranscript`，改用文件内写死的 `LEGACY_CONSULT_FALLBACK{,_SHORT}` 旧 wire entries（按现 `consultTranscript()` 输出字面量抄录，已用 tsx 实测核对）；缺文件 fallback、分页、leaf mismatch 断言原样保留。
- `tests/web-hub/ui/run-transcript.test.ts`：同样改用写死 entries；断言 UI 不再渲染 consult 提示（无 `[role=note]`/`details`），问答正文照常渲染，XSS 断言保留。
- `tests/web-hub/ui/fleet-tree.test.ts`：line-2 用例去掉 consult 行；新增「row 带旧 `consult:true`/`cacheMark` 也正常渲染（无 cachemark span）」一例。
- **未改** `tests/ui/{fleet,fleet-widget}.test.ts`、`tests/tools/result-tool.test.ts`：它们不含 consultCacheMark/consult 渲染断言（`consult:main-snapshot` 折叠用例测的是保留的 `displayAgentType`），改动后全绿。

## 自验结果

| 检查                                                                                                                                                                          | 结果                                                                                                                                                                                               |
| ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| §4.3 PD 闭合：`rg -n "consult-cache-marker\|consult-transcript" src -g '!…两个模块自身'`                                                                                      | 空 ✓                                                                                                                                                                                               |
| §4.3 PD 闭合：tests 导入方                                                                                                                                                    | 恰好 ⊆ {conformance/consult-preserve, core/consult-cache-marker, consult/prompt, web-hub/agent/consult-transcript} ✓（均 PS1a/PS1b 才删）                                                          |
| `npx vitest run tests/ui tests/tools/result-tool.test.ts tests/web-hub/agent tests/web-hub/hub/run-transcript.test.ts tests/core/consult-cache-marker.test.ts --maxWorkers=4` | 1938 passed / 1 failed：`resume-list.test.ts:174` 排序断言在并行下偶发；单独重跑 16/16 通过，`tests/web-hub/agent` 整目录重跑 1602/1602 通过（与 PD 无关的既有 flake，resume-list 不触及 consult） |
| `npx vitest run tests/web-hub/ui --maxWorkers=3`                                                                                                                              | 266 files、5792 passed（1 skipped）✓                                                                                                                                                               |
| `npm run typecheck`（tsc ×2 + vue-tsc）                                                                                                                                       | 通过，无输出 ✓                                                                                                                                                                                     |
| `npm run build:web && npm run check:web`                                                                                                                                      | 通过（first-screen 359488B gz 等全部限额内）✓                                                                                                                                                      |
| `npx prettier --check`（全部改动文件，先 --write 修 2 处后）                                                                                                                  | 全部通过 ✓                                                                                                                                                                                         |
| `git diff b8f9a43e -- src/web-hub/protocol src/web-hub/hub`                                                                                                                   | 0 行 ✓                                                                                                                                                                                             |
| `git diff b8f9a43e -- tests/fixtures`                                                                                                                                         | 0 行 ✓                                                                                                                                                                                             |

## 验收对照（§4.5 PD）

- fleet/result/web status 不再出现 consult 文案：`rg -i consult` 于 PD 各 src 文件只剩 legacy 注释与保留的类型字段 ✓
- protocol/hub diff 为空 ✓；hub fallback 兼容用例（缺文件、分页、leaf mismatch）在写死的旧 entries 上通过 ✓
- `build:web` + `check:web` 绿 ✓；`drawer.css` 不再有 `.run-tx-consult*`/`.run-tx-cachemark` ✓

## 遗留

- `src/core/consult-cache-marker.ts`、`src/web-hub/agent/consult-transcript.ts` 及其 4 个测试导入方按计划保留，PS1a/PS1b 物理删除。
- `result-tool.ts` 本地 diag 类型的 `consultCache`/`consultThread` 字段与 :607 的 A/B plan 注释留待 PS1b/PS2 收口。
- `resume-list.test.ts` 的并行排序 flake 为既有现象，非本次引入。
