# Package U — consult 冷热展示（cache-thread plan §5.3 + 用户裁定 + §10 U 行 + §11 U 测试）

日期：2026-10-18。状态：实现与自验通过；**未提交 commit**。依赖 A 的冻结面（73554a3），
只读其类型，不与 B/C 的文件相交（B/C 已并行落盘，文件域无重叠）。

## 1. 范围与裁定落实

- **用户裁定（显示）**：请教前预判 `warm/cold/unknown` + 请教后 `cacheResult`
  `hit/partial/miss` 与 `readShare`，紧凑英文 token（AGENTS.md UI 文案分工）：
  `warm·hit 96%`、`cold·miss 3%`、`?·partial 41%`；线程序号 `t#2`（plan §5.3
  的「线程时前缀 `t#2 `」为准；任务摘要里的 `#2` 是同一事实的简写）。
- **展示位置（全部落地）**：
  1. TUI agent 树（fleet widget 主行 + 终态 linger 行）；
  2. web FleetTree 行（line-2 槽内嵌 `translate="no"` span）；
  3. `get_subagent_result` 文本（consult 段：预判、实测、锚点、线程）；
  4. web consult 记录页（RunTranscript 的 consult 侧栏 + d2 回退页的
     `consultMark` 自定义消息字段）。
- **缺席 ⇒ 不渲染任何新东西（逐面测试钉住）**：无 `consultCache`/`consultThread`
  的 run（旧 run、非 consult run、旧 agent 的 fleet 帧）在 TUI 行、web 行、
  result 文本、回退页 entries、wire key 集合上逐字节等同改前。

## 2. 纯函数层（新 `src/core/consult-cache-marker.ts`，无 pi import）

- `consultCacheMarker(input)`：紧凑 token。金标准（§5.3）：
  - 仅预判（首响应未到）：`warm·…` / `cold·…` / `?·…`；
  - 实测：`warm·hit 96%`、`cold·miss 3%`、`?·partial 41%`（`readShare` 四舍五入
    百分比，clamp 0–100；非有限数 ⇒ 无百分比后缀）；
  - `label:"n/a"` ⇒ `?·n/a`；`degraded` ⇒ 追加 `·degraded`；
  - 线程 ⇒ 前缀 `t#2 `；仅有线程事实无缓存事实 ⇒ 裸 `t#2`；
  - 全部缺席 ⇒ `undefined`（消费方据此保持逐字节不变）。
  - 持久化 JSON 防御：未知 state/label 降级为 `?`/`…`，非法 seq（<1、非整数）
    视为无线程，永不抛。
- `consultCacheMarkerOfDiag(diag)`：`diag.consultCache + diag.consultThread` →
  marker 的便捷投影（fleet-panel、status、consult-transcript 共用）。
- `formatConsultCacheLine(diag)`：`get_subagent_result` 的单行英文 consult 段，
  例：`Consult cache: predicted warm; first request hit 96% read share; anchor
added; thread c7k9q2mx #2`。首响应未到 ⇒ `first response pending`；`anchor`
  仅在真实放置/跳过（非 `n/a`）时出现；reason 折叠空白并截 32 字符；threadId
  截 24 字符。缺席 ⇒ `undefined`。

## 3. 各面实现

| 面            | 文件                                                        | 说明                                                                                                                                                                                                                                                            |
| ------------- | ----------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| TUI 行数据    | `src/ui/fleet-panel.ts`                                     | `FleetRow.consultCacheMark`（可选），`toRow` 里由 marker 投影；终态/活跃行同源。                                                                                                                                                                                |
| TUI 主行      | `src/ui/fleet-widget.ts`                                    | `widgetRowMain` 新 `cc` 字段，排在 type/wt 之后、model 之前；宽度吃紧时**第一个**被丢弃（identity/model/phase 优先）。                                                                                                                                          |
| TUI linger 行 | `src/ui/fleet-widget.ts`                                    | `widgetTerminalDetail` 末尾追加 marker —— 终态 consult 在 TUI 唯一可见实测值的地方。                                                                                                                                                                            |
| result 文本   | `src/tools/result-tool.ts`                                  | `formatOutcome` 的 `exitSuffix` 追加 `formatConsultCacheLine(outcome.diag)`（与 exitFacts/contextSwitches 同一折叠方式）。                                                                                                                                      |
| wire          | `src/web-hub/protocol/messages.ts`                          | `FleetRowWire.cacheMark?: string` + `consultCache?: FleetRowConsultCacheWire`（A 类型的显示子集：state + first{label,readShare,anchor?,degraded?}）+ schema 可选字段（`FLEET_CACHE_MARK_MAX=64`）。append-only、不升 proto。                                    |
| 投影          | `src/web-hub/agent/status.ts`                               | `projectFleet` 用行上已算好的 `consultCacheMark`（≤64 才上wire），结构字段逐项验证后下发；`fleetFingerprint` 保留两字段 ⇒ 只在真实变化时翻转。                                                                                                                  |
| web 树行      | `FleetTree.vue`（行组件已并入此文件，FleetNode.vue 不存在） | line-2 槽（run-activity span）内嵌 `<span class="run-cachemark" translate="no"> · mark</span>`，summary/div 两种行都加；无 CSS 新规则。                                                                                                                         |
| web 记录页    | `RunTranscript.vue`                                         | consult 侧栏（既有 `.run-tx-consult`）内加 `translate="no"` 行；来源二选一：回退 entries 的 `message.consultMark`（请求时从 diag 投影，权威）→ 回退 `runTx.lastRow.cacheMark`（文件仍在、走真 transcript 时）。无任何事实且无 consultSummary ⇒ 侧栏整个不渲染。 |
| d2 回退页     | `src/web-hub/agent/consult-transcript.ts`                   | `ConsultTranscriptDiagnostics` 增加 `consultCache`/`consultThread`（窄类型，core type-only import）；有 marker 时问题 entry 的 message 追加 `consultMark` 自定义字段（WireMessage 开放 schema、loose entries 校验原样透传，hub 无改动）。                       |

## 4. 与并行包的边界

- B/C 已落盘 `src/consult/**`、`src/runtime/**`、`src/service/runtime-adapter.ts`、
  `src/stack.ts`、`src/index.ts` —— 本包未触碰；U 只读 A 冻结类型与 run diag。
- `src/core/**` 除新文件外未动；`src/web-hub/ui/src/components/{preview,transcript,shell}/**`、
  i18n settings 文件、index.html、`src/web-hub/hub/feishu/**` 均未触碰
  （工作区里这些文件的改动属于其它包）。

## 5. 测试（§11 U 行）

- `tests/core/consult-cache-marker.test.ts`（18）：marker 金标准（含 `…`、
  `n/a`、`degraded`、`t#n`、边界百分比 0/100、F0 的 0.235→24%）；裸线程；
  缺席 ⇒ `undefined`（普通 RunDiagnostics fixture）；畸形值降级；detail 行
  金标准 + 截断/折叠 + 缺席。
- `tests/ui/fleet-consult-cache.test.ts`（8）：toRow 投影；widget 主行三种
  状态；终态 linger 行保留实测 marker；无字段行与 baseline 输出逐字节相等
  （含 `consultOf`-only 的 run）；窄宽度先丢 `cc`。
- `tests/tools/result-consult-cache.test.ts`（4）：result 文本 consult 段
  （完整/待定/仅线程）；无字段 ⇒ 输出与改前完全一致（整串断言）。
- `tests/web-hub/agent/status-consult-cache.test.ts`（5）：投影 + 结构字段；
  无字段 ⇒ wire key 集合与改前完全一致；畸形 readShare 降级 null；fingerprint
  只随真实变化翻转（elapsedMs 抖动不翻转）。
- `tests/web-hub/agent/consult-transcript.test.ts`（+3）：`consultMark` 只在
  问题 entry；实测后更新；无字段 entries 逐字节不变（`toEqual` 金标准）。
- `tests/web-hub/ui/consult-cache-display.test.ts`（9）：FleetTree 标记渲染
  （translate=no、含 live activity 时也在）；无标记 ⇒ 无节点；RunTranscript
  双来源与无事实不渲染。

## 6. 自验实录（真实输出）

```text
$ timeout 280 npm run typecheck
> pi-toolkit@0.5.5 typecheck
> tsc --noEmit -p tsconfig.json && tsc --noEmit -p tsconfig.typecheck.json && vue-tsc --noEmit -p src/web-hub/ui/tsconfig.json
TYPECHECK_EXIT=0

$ timeout 600 npx vitest run tests/ui tests/tools tests/web-hub/agent tests/web-hub/ui tests/core
 Test Files  312 passed (312)
      Tests  7440 passed (7440)
   Start at  14:38:17
   Duration  38.85s
VITEST_EXIT=0

$ timeout 300 npm run build:web && timeout 200 npm run check:web
✓ built in 4.91s
✓ check:web — dist/web-hub-ui/ OK (18 files, first-screen JS 281424B gz/524288B, lazy JS 44307B gz/131072B, CSS 30182B gz/65536B)
WEB_EXIT=0
```

附验（非任务要求，schema 消费方）：`tests/web-hub/protocol` 1344 passed / 3
skipped；`tests/web-hub/hub` 153 files passed（一次运行中 feishu 包并行写盘造
成过瞬态 transform 失败，与本包无关，复跑全绿）。

prettier：16 个触及文件 `--check` 全过（messages.ts / FleetTree.vue /
consult-cache-marker.test.ts 等 6 个文件被 `--write` 归一后复验）。

## 7. 样张

- TUI（真实 `buildFleetWidgetLines` 输出，`~/consult-u-preview/tui-sample.txt`）：

```text
● 7 active Agents
  main session general 🤔 30s Σ30s
  ↳ consult api-design consult t#2 warm·hit 96% 🤔 30s Σ30s
  ↳ consult db-schema consult cold·miss 3% 🤔 30s Σ30s
  ↳ consult release-notes consult t#3 ?·partial 41%·degraded 🤔 30s Σ30s
  ↳ consult security consult warm·… 🤔 30s Σ30s
  ↳ consult non-anthropic consult ?·n/a 🤔 30s Σ30s
  ↳ consult legacy-expert consult 🤔 30s Σ30s
✓ consult finished-hit consult completed 28s t#2 warm·hit 96%
```

- web（headless chromium 截图 `~/consult-u-preview/consult-cache-states.png`，
  800×900；HTML 源 `consult-cache-states.html`）：用**真实组件**（vue mount
  FleetTree.vue + RunTranscript.vue + IconSprite + tokens/base/fleet/drawer/
  detail/transcript.css 内联）渲染——FleetTree 六种状态行 + 无字段旧行，
  以及 consult 记录页侧栏的 `t#2 warm·hit 96%` 标记行。DOM 中逐个验证过
  全部六个 token 与 `run-cachemark`/`run-tx-cachemark` 节点存在。

## 8. 交付文件（绝对路径）

1. `/home/bluecake/ai/pi-toolkit/src/core/consult-cache-marker.ts`（新）
2. `/home/bluecake/ai/pi-toolkit/src/ui/fleet-panel.ts`
3. `/home/bluecake/ai/pi-toolkit/src/ui/fleet-widget.ts`
4. `/home/bluecake/ai/pi-toolkit/src/tools/result-tool.ts`
5. `/home/bluecake/ai/pi-toolkit/src/web-hub/protocol/messages.ts`
6. `/home/bluecake/ai/pi-toolkit/src/web-hub/agent/status.ts`
7. `/home/bluecake/ai/pi-toolkit/src/web-hub/agent/consult-transcript.ts`
8. `/home/bluecake/ai/pi-toolkit/src/web-hub/ui/src/components/fleet/FleetTree.vue`
9. `/home/bluecake/ai/pi-toolkit/src/web-hub/ui/src/components/drawer/RunTranscript.vue`
10. `/home/bluecake/ai/pi-toolkit/tests/core/consult-cache-marker.test.ts`（新）
11. `/home/bluecake/ai/pi-toolkit/tests/ui/fleet-consult-cache.test.ts`（新）
12. `/home/bluecake/ai/pi-toolkit/tests/tools/result-consult-cache.test.ts`（新）
13. `/home/bluecake/ai/pi-toolkit/tests/web-hub/agent/status-consult-cache.test.ts`（新）
14. `/home/bluecake/ai/pi-toolkit/tests/web-hub/agent/consult-transcript.test.ts`（扩展）
15. `/home/bluecake/ai/pi-toolkit/tests/web-hub/ui/consult-cache-display.test.ts`（新）
16. `/home/bluecake/ai/pi-toolkit/docs/dev/consult/U-report.md`（本文件）

## 9. 遗留与说明

- 线程前缀采用 plan §5.3 的 `t#2`（非任务摘要里的裸 `#2`）；两者同义，以已
  批准方案为准。
- `formatConsultCacheLine` 对 `anchor:"n/a"` 不输出锚点子句（非 Anthropic 路
  线无锚可报，避免噪音）；`added/relocated/skipped:*` 全部如实出现。
- RunTranscript 的标记来源优先 entries（d2 回退、请求时 diag 投影、跨
  fleet 帧稳定），`lastRow.cacheMark` 仅作文件仍在时的回退 —— 两个来源最终
  都是同一 marker 纯函数，不会出现两种口径。
- Phase 2 的 `pingsSince/pingUsdSince` 尚无生产者；marker 与 detail 行均不
  消费它们（A 报告 §7 已注明 Phase 1 可省略），届时无需改 U。
- 无新增设置、无新 timer、无 pi import 进入 core、未 commit。

## Verification (r_RPSVKPZZ, Sonnet — conditional pass) and main-session fixes

- Web consult record page: the marker no longer runs into the fallback sentence — `.run-tx-cachemark` is now its own block line (mono font) in `styles/drawer.css`.
- TUI running row: the cache marker is now dropped BEFORE the agent type (matches the comment); test added.
- TUI terminal line: the marker yields before the label gets truncated; test added (fails on the previous logic).
- Accepted nit: an over-long (>64 char) mark is dropped whole on the wire — cannot happen with the formatter's output.
