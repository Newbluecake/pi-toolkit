# fleet Bash 分组：全部归档后 `(+N more)` 孤立（omitted-orphan）修复

2026-10-27 · 纯 UI 修复（wire / agent / hub 均未动）

> 2026-10-28 更新：下文「agent 不知道哪些行被归档」已不再成立 —— `omitted` 现在是归档感知的，见 [`bash-omitted-archive.md`](./bash-omitted-archive.md)。

## 现象

fleet 抽屉的 Bash 分组标题为「Bash · 已完成 11 · 失败 2 · 已归档 12」，展开后没有任何可见行，
只有一行孤零零的 `(+1 more)`，再往下是「› 已归档 12」折叠。用户无法知道第 13 条是什么，
也无法归档它（它根本不在 wire 上）。

## 根因

- agent 侧投影 `src/web-hub/agent/bash-jobs.ts`（D1）：wire 最多 20 行、其中终态行最多
  `BASH_JOBS_MAX_TERMINAL_ROWS = 12`，超出的计入 `omitted = selected.length - rows.length`。
- 归档是 hub/UI 侧的纯显示隐藏（`FleetBashJobs.vue` 的 `liveRows`/`archivedRows` 按
  `props.archived` 二分），agent 不知道哪些行被归档。
- 因此当 wire 上的 12 条终态行全部被归档时 `liveRows` 为空，而第 13 条（最旧的终态任务）
  不在 wire 上 —— `(+1 more)` 挂在空列表里，成为孤儿行。

## 计数与 omitted 的关系（核实结论）

标题计数来自 `summaryCounts(wire)`（`bashJobsView.ts`），用的是 wire 的
`total`/`running`/`failed` —— 这三个是 **retention 过滤后全集的计数，不受行数上限裁剪**。
所以标题「已完成 11 · 失败 2」= 13 条终态 **包含** omitted 的那 1 条；而「已归档 12」只数
wire 上被归档的行。即 `done + failed = 13 = 12 (wire 终态行) + 1 (omitted)`。

## 修复

`FleetBashJobs.vue` 新增 `orphanOmitted` 判定：
`liveRows.length === 0 && archivedRows.length > 0 && omitted > 0`。

- 命中时：不再在空的 live 列表里渲染 `(+N more)`；改在归档折叠之后渲染说明行
  （`.bj-more.bj-more-orphan`），文案走新 i18n 键 `detail.bashJobsOlderOmitted`：
  zh「另有 {n} 条更早的已结束任务未显示」/ en "{n} older finished jobs not shown"。
- live 行非空时保持现状（`( +N more)` 原位）。
- 无任何归档行时渲染字节不变（`orphanOmitted` 必为 false，模板路径与旧版一致）。

i18n 键按 detail.ts 的既有约定追加在两个 locale 文件的末尾安全区。

## 同类面板排查

归档种类只有 `run | bash`（`contracts.ts` 的 archived map），行级归档折叠只存在于
FleetBashJobs：

- `worktreesMore`（WorktreePanel）、`linesMore`（CacheKeepalivePanel）：无归档概念，行不会被
  UI 侧隐藏 ⇒ 无此问题。
- `todoMore`（TodoPanel）：归档是 agent 侧 wire 计数行（`todoArchived`），`moreCount` 已按
  `max(0, omitted − completedHidden)` 折算，行不做 UI 侧二分 ⇒ 无此问题。
- `waitingMore`（`agentNotices.ts`）：只是通知文案的拼接后缀，不是列表行 ⇒ 无此问题。

故仅 FleetBashJobs 需要修复。

## 改动文件

- `src/web-hub/ui/src/components/fleet/FleetBashJobs.vue`
- `src/web-hub/ui/src/i18n/en/detail.ts`（新增 `bashJobsOlderOmitted`）
- `src/web-hub/ui/src/i18n/zh/detail.ts`（同上）
- `tests/web-hub/ui/fleet-bash-jobs.test.ts`（新增 describe：全归档+omitted / 有 live 行+omitted /
  全归档无 omitted / 无归档+omitted 字节不变）

## 自验

- `npm run typecheck` ✅
- `npx vitest run tests/web-hub/ui --maxWorkers=3` ✅ 268 files / 5921 tests
- `npm run build:web && npm run check:web` ✅
- `npx prettier --write`（四个改动文件，全部 unchanged）✅
- `git diff --quiet HEAD -- tests/fixtures/` ✅

## 建议 commit message

```
fix(web-hub): move the bash `(+N more)` marker next to the archived fold when all wire rows are archived

The wire caps terminal bash rows at 12 and archiving is display-only, so with
every wire row archived the `(+N more)` marker hung in an empty live list —
unidentifiable and un-archivable. Render a prose note ("{n} older finished
jobs not shown" / 「另有 {n} 条更早的已结束任务未显示」) after the archived
fold instead; live-rows-present and no-archive renders stay unchanged.
```
