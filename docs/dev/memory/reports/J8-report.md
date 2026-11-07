## J8 交付报告

**改动文件清单**（绝对路径均在 `/home/bluecake/ai/pi-toolkit/` 下）：

新建：

- `src/memory/jev/entry-edit.ts`（248 行）— `deleteEntry`/`setInlineMeta`，CAS 锁内重定位 + `.trash` 备份
- `src/memory/jev/review-command.ts`（317 行）— `handleMemReview`
- `src/memory/jev/expired-command.ts`（143 行）— `handleMemExpired`
- `tests/memory/jev/entry-edit.test.ts`（191 行，11 例）
- `tests/memory/jev/review-command.test.ts`（339 行，15 例）
- `tests/memory/jev/expired-command.test.ts`（193 行，12 例）
- `tests/memory/doctor-jev.test.ts`（246 行，14 例）
- `tests/memory/tidy/prompt-jev.test.ts`（57 行，5 例）

修改（diff --stat 对 origin/dev）：

- `src/memory/contracts.ts` +20/-? — `DoctorId` 追加 `D17|D18|D19`
- `src/memory/doctor.ts` — `DoctorSnapshotFile.entries?`、`ID_ORDER` 追加、`runDoctor(snapshot, settings, jev?: {today})` 新 D17–D19 逻辑（原 findSecrets 搬家属 J1 既有 diff，非我所改）
- `src/memory/doctor-command.ts` +71 — `buildSnapshot`/`runDoctorFor`/`collectDoctorFindings` 透传 `jev`；`DoctorCommandDeps.jev?: JevDoctorPort`；`CreateStartupReminderDeps` 加 `jev?`/`settingsWarnings?`；`check()` 扩展提醒行
- `src/memory/command.ts` +331 — `review`/`expired` 分支、`jevDoctorPortFrom` 适配器、`toMemCommandUi`、`isInteractive`、`updatedAtOfFor`、补全表、DESCRIPTION_JEV
- `src/memory/tidy/prompt.ts` +11 — `preserveInlineMeta?` 规则
- `src/memory/tidy/command.ts`、`src/memory/tidy/batch-command.ts` — 按 plan 原文件域（"只透传该布尔"）把 `preserveInlineMeta` 从 `TidyCommandDeps`/`BatchCommandDeps.settings` 一路传到两处 `buildTidyPrompt` 调用（单次 tidy 路径与 batch normalize 路径各一处）；这两个文件**在 plan §4 J8 文件域内明文列出**，未越界
- `src/web-hub/agent/command-policy.ts` +24 — `mem()` 加 `review`/`expired` 子策略
- `tests/web-hub/agent/command-policy.test.ts` +35 — 对应用例

## 导出对照 §2

未定义任何新冻结接口；`entry-edit.ts` 的 `EntryEditResult`/`InlineMetaPatch` 为 J8 自有（非 §2 冻结表项，plan 仅给出示例签名，由我自行设计）。消费 J1 的 `JevCommandPort`/`JevDoctorPort`/`MemCommandUiLike`/`expiredEntries`/`untilEntries`/`splitEntries`，消费 J4 的 `JevCommandPort` 实现（`review.list/run/dismiss/resolve`）。

## `/mem review` 与 `/mem expired` 交互流程

- `review --list`：只读，子会话可用；`review`/`review --run`：主会话+交互专用；非交互（web/非 tui）降级为 `--list` 文本 + 终端提示。五类建议对应选项表（重复/取代/冲突/过时/疑似用户令），"删除较旧一条"在 sidecar `at` 均已知时自动判定，否则给出显式 A/B 选项。
- `expired`：无 `--list` 逃生口，主会话+交互专用；四选项（删除/延期30天/去掉期限/跳过）。

## D17–D19 定义

- D17：`expires` 已过 → warn；仅 `until` → info（取自 J1 `expiredEntries`/`untilEntries`，不自行解析日期）
- D18：`entry.inlineErrors` 非空 → error，一条/错误
- D19：primary 文件字节数 ≥ coreBytes 80% 且该文件未触发 D02/D03 → warn
  三者仅在 `runDoctor` 第三参 `jev` 存在时运行；`ID_ORDER` 末尾追加，不影响无 jev 时的输出。

## web 端放行/确认表

`mem review --list` allow；`mem review`、`mem review --run`、`mem expired` confirm（新增）。

## 自验输出

- `timeout 600 npm run typecheck` → exit 0
- 我改动文件 `npx prettier --check` → 全绿
- `npx vitest run tests/memory/doctor.test.ts tests/memory/doctor-jev.test.ts tests/memory/jev tests/memory/tidy tests/memory/tidy.test.ts tests/memory/command.test.ts tests/memory/jev/off-golden.test.ts tests/web-hub/agent/command-policy.test.ts tests/boundary/pi-free.test.ts tests/memory/fs-guard.test.ts` → **44 文件 / 963 例全绿**
- `npx vitest run tests/memory/jev/off-golden.test.ts tests/memory/fs-guard.test.ts tests/memory/doctor.test.ts tests/memory/command.test.ts tests/web-hub/agent/command-policy.test.ts` → **5 文件 / 184 例全绿**
- `git diff --stat origin/dev -- tests/fixtures/` → 仅 `governance/activate-trace.json`（J6）、`memory-tool-surface.json`（J5）、`memory/jev-off-golden.json`（J0 新建），无我的文件

全量 `npm run format:check`/`npm test` 未跑（J5/J6 文件同时在改，会被他们的未完成状态干扰），仅对我自己的文件单独跑 prettier --check，均通过。

## 遗留与上报事项

1. **"整段条目删标题"判定**（plan 列为风险项）：最终采用"该条目是其 `## ` 标题下唯一条目则连标题删，否则只删自身"——比 plan 建议的 heading/ordinal 判据更准确（实测 `MemEntry.heading` 在无 `### ` 时等于 `section`，并非 undefined，原判据会把所有 list 场景误判）。已在 `entry-edit.ts` 头部注释说明。
2. **`JevDoctorPort` 的组装位置**：plan 只冻结了端口形状，未指定由谁在 `command.ts` 里把 `JevCommandPort`→`JevDoctorPort` 适配；我在 `command.ts` 新增 `jevDoctorPortFrom()` 本地适配器（纯用现有只读方法拼装），J7 做生产接线时若有不同设计可直接覆盖，不影响接口契约。
3. **"delete older" 的判定来源**：复用 `readIndex(dir).index.entries[hash].at`（侧车已打标时间）比较新旧；双方都缺失打标记录时退化为显式 A/B 选项，不做猜测删除。
4. 未发现需要 `message_agent` 上报 root 的阻塞性缺口；以上均按默认方案落地并在代码注释中说明。
