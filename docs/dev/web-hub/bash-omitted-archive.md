# fleet Bash 分组：`(+N more)` 一键归档（archive_omitted）与归档感知的 `omitted`

2026-10-28 · agent 投影 + 一个追加式 cmd op + 追加式 wire 字段（无 PROTO bump）

## 要解决的问题

wire 最多带 20 行（终态 ≤12，D1）并有 24 KiB 字节预算（D6）。装不下的终态任务计入
`BashJobsWire.omitted`，UI 渲染成 `(+N more)`。用户既看不到也清不掉它们，所以这一行变成按钮：
**归档 N 条更早的已完成任务**。

第一版（验收被打回）只做了「按钮 → 归档」，但 `omitted` 在 `rankJobs` 之后算出，完全不知道归档集合：
归档后 `omitted`、`rows` 都不变，界面毫无变化；`omitted` 全由字节预算造成时按钮会命中空集；
运行中行 >20 时 `omitted` 里混着不可归档的运行行，标记永远清不掉。

## 语义

- **归档是纯显示隐藏**：不影响 `get_run_result`、通知、`/agent status`，也不影响 job 本身；
  只是 `StatusInfo.archived` 里多了条目，UI 把对应行放进「已归档」折叠。
- **被归档的行仍占用 wire 名额**：「已归档」折叠需要它们的内容来展示和取消归档；12 条终态行上限不变。
- **`omitted`（新语义）** = 终态 job 中 _既不在 `rows` 里、也没有被归档_ 的条数，覆盖两个阶段：
  1. 行数上限阶段（20 行 / 12 终态）被挤出的终态行；
  2. D6 ⑤ 字节预算阶段被丢弃的终态行（被丢的行若已归档则不计）。
- **`rowsOverflowRunning?`（新增可选字段）** = 被 20 行上限或字节预算挤出 `rows` 的 _运行中_ 行数。
  运行中行不可归档，所以永远不进 `omitted`；UI 只显示一行静默小字「另有 N 条运行中的任务未显示」，不给按钮。
- **归档之后**：`omitted` 归零 ⇒ `(+N more)` 行与按钮消失；被归档的行（若在 `rows` 里）进入「已归档」折叠。
  下一帧由 1Hz 轻指纹（`bashJobsLightFingerprint` 含 `omitted` 与 `rowsOverflowRunning`，且 tick 里的
  `selectJobs` 也带上归档集合）或 `settleAndReply` 的 `onChanged()` 触发发布。
- **不变式**：`omittedTerminalJobIds(records, now, retentionMs, archived, tails)` 的条数恒等于
  `projectBashJobs(...)?.omitted ?? 0`；二者都是同一次 `projectBashJobsDetail` 的产物。
  门禁：`tests/web-hub/agent/bash-jobs-projection.test.ts`（固定种子 LCG 随机扫描）与
  `tests/web-hub/agent/commands-archive.test.ts`（三种形状的漂移测试 + 「归档后 omitted 归零」）。

## 接线

- `projectBashJobs(records, tails, now, retentionMs, archived?)`：`archived` 为可选的已归档 bash id 集合
  （`ArchiveControl.view().bash`）。缺省 ⇒ 与改动前逐字节一致（无 `rowsOverflowRunning` 之外的新键，
  且 `rowsOverflowRunning` 仅在确有运行行溢出时才出现）。
- `status-slots.ts` 的 `bashJobsProjection` 照 `archiveProjection` 的写法从 `sources.archive` 取集合；
  没有该 source 或 getter 抛错 ⇒ 传 `undefined`。
- `archive_omitted` 处理器用同一份投影（同一 list、同一 tail 缓存 `bashSampler.tails`、同一 retention、
  同一归档集合）算出 `omittedIds`，再 `setArchivedMany("bash", ids)`，一次批量提交 = 一条 session entry。

## 协议形状

- cmd op（追加式，closed schema）：`{ op: "archive_omitted", kind: "bash" }`，无 id —— id 集合由 agent 侧重算。
- 成功结果：`{ op: "archive_omitted", changed: number }`。`changed` = 本次 **新** 归档的条数；
  已归档（含 auto 归档被重标为手动）的 id 不计入；`0` ⇒ 没有任何 id 从「未归档」变成「归档」（若本批只有 auto 归档被重标为 manual，仍可能写一条 entry）。幂等：再点一次得到 `changed: 0`。
- 错误：无 archive control / 无 bash 来源 ⇒ `E_UNSUPPORTED`；`kind` 不是 `bash` ⇒ `E_BAD_REQUEST`。**旧 agent**（不认识该 op，闭合 schema 丢帧不回复）⇒ hub 等 ack 超时 ⇒ `E_DEADLINE`。
- `BashJobsWire.rowsOverflowRunning?: number`（append-only，`BashJobsWireSchema` 是开放 schema）。

## UI 反馈（`FleetDrawer.vue` 的共享 toast）

| 结果            | 文案（en / zh）                                         | 备注                                  |
| --------------- | ------------------------------------------------------- | ------------------------------------- |
| `changed > 0`   | `Archived {n} Older Job(s)` / `已归档 {n} 条更早的任务` | 无「撤销」（批量没有单一 id）         |
| `changed === 0` | `No Older Jobs to Archive` / `没有可归档的任务`         | 诚实的空操作                          |
| 错误码 / 超时   | `Archive Failed` / `归档失败`                           | 错误码写入 toast 的 `title`，停留 8 s |

按钮的渲染条件是 `omitted > 0`（加 provider / handle 门控）；单行归档的「撤销」toast 不变。

## 兼容性与升级

- **新 hub 需要 `/webhub restart` 才生效**：hub 进程缓存了 `archive_omitted` 的 closed `ArchiveOmittedArgsSchema`；
  旧 hub 收到这个 op 会按未知 op 拒绝（UI 显示「归档失败」+ 错误码）。
- **旧 agent × 新 hub/UI**：旧 agent 不发 `rowsOverflowRunning`，`omitted` 仍是旧语义（含运行行溢出、
  不感知归档）。按钮仍可点，但旧 agent 不认识该 op ⇒ `E_DEADLINE（旧 agent 闭合 schema 丢帧不回复，hub 等 ack 超时）` ⇒「归档失败」；不会比改动前更糟。
- **新 agent × 旧 hub/UI**：`rowsOverflowRunning` 被开放 schema 原样转发、旧 UI 忽略；`omitted` 在归档后
  会变小，旧 UI 只是少显示 `(+N more)`。无 PROTO bump（I10）。
