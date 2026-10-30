# memory 现状盘点（Jev 架构重设计的底图）

> Explore（deepseek/deepseek-flash，run r_6006J96Z），2026-10-30。只陈述事实，行号以盘点时的 dev 分支为准。

## 1. 模块地图（`src/memory/**`）

单文件职责（行号指各文件自己的首行注释或首个导出）：

- `index.ts` — 唯一面向 pi 的装配层 `wireMemory()`（`src/memory/index.ts:74`）；闭包内持有 `RenderCache` / `frozenBlocks` / `lastBlocks`，注册 section、`memory` 工具、`/mem` 命令，返回 `{attachTidy, renderForExternal}`（`:52-96`）。
- `paths.ts` — 纯路径/slug 层：`defaultPaths`（`~/.pi/agent/memory`，可被 `ARMORY_MEMORY_ROOT` 覆盖，`:26-31`）、`toSlug` `'/'→'-'`（`:37`）、`fromSlug`（`:44`）、`memoryDirFor`（`:50`）、`MemoryError`（`:17`）。
- `frontmatter.ts` — 行级 YAML 头解析/写入：`parseFrontmatter`（`:49`）、`stripFrontmatter`（`:88`）、`isPinned`（`:99`）、`frontmatterSource`（`:106`）、`upsertFrontmatterFields`（`:110`）、`stripLeadingDriftHeader`（`:37`）。
- `meta.ts` — §5 元数据契约 + §2.1 小节切分：`parseMemoryMeta`（`:63`）、`splitReadWhen`（`:50`）、`firstHeading`（`:134`）、`descriptionOrHeading`（`:141`）、`splitSections`（`:174`）、`truncateMetaField`（`:26`）。
- `contracts.ts` — 冻结类型/常量：`TIERED_TEMPLATES`（`:80`）、`MemoryCommand`（`:110`）、`DoctorId`（`:142`）、`TIDY_MAX_FILES=24` / `BATCH_MAX_FILES=20`（`:158,163`）、`TIDY_SCHEMA`/`TRIAGE_SCHEMA`（`:281,335` 起）、`TidyPort`/`TidySpawnRequest`（`:393,414`）、journal/manifest 契约（`:185-270`）。
- `store.ts` — 旧版 store：`listMemory`（`:60`）、`assertAllowWrite`（`:120`）、`resolveMemoryFile`（`:142`）、`writeMemoryFile`（`:186`）、CC 导入 `importProject/importAll/discoverCCProjects`（文件尾）。
- `render.ts` — legacy 注入块渲染：`AGENT_SOURCE_FENCE`（`:22`）、`injectionSentinel`（`:26`）、`truncateAtSection`（`:48`）、`memoryFingerprint`（`:83`）、`renderMemoryBlock`（`:118`）、`RenderCache`（`:194`）。
- `tiered.ts` — tiered 渲染器：`accessFromTools`（`:128`）、`MetaCache`（`:164`）、`tieredFingerprint`（`:203`）、`TieredRenderCache`（`:223`）、`buildIndexLine`（`:491`）、`renderTiered`（`:676`）、`minimalFrame`（`:776`）。
- `inject.ts` — hub section provider：`memoryTitle`（`:211`）、`renderLive`（`:219`）、`memorySection`（`:286`）、`renderExternalMemoryBlock`（`:373`）。
- `tool.ts` — legacy `memory` 工具（`list|write|append`），参数 `:27`，工厂 `:60`。
- `tool-v2.ts` — v2 工具（7 command + legacy 别名），工厂 `:412`，`execute` `:701`。
- `tool-surface.ts` — v2 冻结参数 schema `MemoryToolParamsV2`（`:20`）与冻结工具文案 `MEMORY_TOOL_V2_TEXT`（`:42`）、字节记账 `toolSurfaceBytes`（`:64`）。
- `normalize.ts` — `normalizeMemoryCall`（`:75`），别名/互斥归一化为 `NormalizedCall`。
- `edit.ts` — str_replace 匹配与插入定位：`findStrReplaceMatches`（`:31`）、`resolveInsertTarget`（`:89`）、`splitSectionsWithLines`（`:146`）、`resolveSectionMatch`（`:195`）。
- `search.ts` — `searchMemory`（`:83`）。
- `budget.ts` — T3 反馈行 + 精确重复行检测 `findExactDuplicates`（`:51`）、`computeBudgetReport`（`:110`）。
- `safe-fs.ts`（最大，59K）— 唯一 fs 原语层：目录信任 `canonicalDir`（`:106`）、私有目录（`:120`）、`listRegular`（`:186`）、regular-only open/read/write（`:290-359`）、原子替换/独占创建/no-clobber rename（`:403-490`）、`appendLegacy`（`:501`）、`removeFlatDir`（`:617`）、事务命名空间 `openRunDirs`（`:834`）/`resolveLoc`（`:886`）/`observeLoc`（`:923`）、epoch/lease。
- `lock.ts` — `withMemoryDirLock`（`:58`）目录锁（M-T4 不死锁判定）。
- `tmp-names.ts` — 事务临时名 `.pt-<nonce8>-<seq>-<kind>.tmp`（`:6-51`）。
- `settings.ts` — `MemorySettings`（`:19`）、`parseMemorySettings`（`:118`）、`DEFAULT_MEMORY_SETTINGS`（`:189`）。
- `setting-specs.ts` — `MEMORY_SETTING_SPECS`（`:9`），`/agent settings` 的表面。
- `doctor.ts` — 纯 `runDoctor`（`:302`）、`selectPrimaryCore`（`:118`）、`formatDoctorReport`（`:610`）、`summaryLine`（`:625`）。
- `doctor-command.ts` — fs 快照 + `/mem doctor` 处理（`:145`）、`collectDoctorFindings`（`:128`）、启动提醒 `createStartupReminder`（`:231`）。
- `command.ts` — `createMemCommand`（`:93`）：`path/init/list/import/doctor/tidy|restore/默认 list`（`:154-241`）。
- `init-command.ts` — `/mem init`：`coreSkeleton`（`:74`）、`runMemInit`（`:96`）、`handleMemInitCommand`（`:136`）。
- `tidy/`（21 文件）— 见第 5 节。

依赖方向（由 import 实测）：`paths/frontmatter/tmp-names/tool-surface/budget` 无内部依赖 → `meta`/`edit`/`search` 依赖 frontmatter → `safe-fs`（依赖 paths/tmp-names/contracts）→ `lock` → `store`/`render`/`tiered` → `tool-v2`/`inject`/`doctor`/`doctor-command`/`command`/`init-command` → `index.ts`（唯一 pi 面）。`tidy/*` 依赖 `safe-fs`+`contracts`+`meta`，`tidy/command` 上到 `config/settings`、`runtime/cap-watcher`、`core/types`。`contracts.ts` 只 type-import `core/types` 与 `service/spawn-service`（`src/memory/contracts.ts:11,14`）。边界：`tests/boundary/pi-free.test.ts:165` 钉 `paths|frontmatter|store|render` 无 pi。

## 2. 数据模型

- 目录：`~/.pi/agent/memory/<slug>/`，slug = cwd 的 `/`→`-`（`src/memory/paths.ts:27,37,50`）；secure 域用 `ARMORY_MEMORY_ROOT=<state>/memory`（`src/secure/domain.ts:690`）。
- 文件：目录内平面 `*.md`，无子目录；名字规则 `^[A-Za-z0-9][A-Za-z0-9._-]{0,127}\.md$`（`src/memory/store.ts:104`），v2 命名 `isV2Name`（`src/memory/safe-fs.ts:174`）。
- frontmatter 字段全集：`description`、`read_when`（`;`/`；` 分隔词表）、`topic`（`^[a-z0-9-]{1,48}$`，缺省=文件名）、`status`(`active|stale|archived`)、`updated`、`pin`、`source`（`src/memory/meta.ts:13,16-20,63-133`）。上限：frontmatter 40 行 / 2048B，`description` ≤300B，`read_when` ≤240B（`meta.ts:16-20`）。
- 主体：「primary core」= `core.md`，否则首个 `pin:true` 非 archived 文件（`src/memory/tiered.ts:705-708`，`src/memory/doctor.ts:118`）；其余为 topic；条目单位 = `## ` 小节（`meta.ts:174`）。
- 无独立索引文件：索引每轮由目录 readdir 现算（`tiered.ts:676`）；`ARCHIVE.md` 仅由 batch tidy 维护（`src/memory/tidy/batch-command.ts:514`）。
- cwd 键控：所有面统一先过 worktree origin（`src/memory/tool.ts:63`、`src/memory/inject.ts:216`、`src/memory/command.ts:48`、`tool-v2.ts:72`）。
- 辅助目录（仅 tidy/delete）：`archive/`、`.backup/<id>/`、`.trash/`、事务临时 `.pt-*.tmp`（`src/memory/safe-fs.ts:834-880`，`.backup` 名 `:58`，trash 名正则 `:933`，`MAX_BACKUPS=10` at `src/memory/tidy/manifest.ts:48`）。工具删除进 `.trash/<iso>-<pid>-<rand>-<name>`，保留 20 个（`tool-v2.ts:397-408,651-661`）。
- journal/manifest 落盘：每次 run 的 `manifest.json`（`src/memory/tidy/manifest.ts:30`）+ 事件流（`run` 事件先记全量 planned op，`JournalEvent` 见 `contracts.ts:216-228`）；run 状态 `applying|complete|aborted|interrupted|recovered|conflict-reported`（`contracts.ts:185`）；manifest 严格 v2，v1 需 `--legacy`。lease/epoch 文件在目录内（`src/memory/tidy/lease.ts`，`safe-fs.ts` `readEpoch/bumpEpoch/lockBreak`）。

## 3. 写入路径

- v2（默认 `toolSurface:"v2"`）`execute`：`resolveCwd` → `normalizeMemoryCall` → `assertWritable`（子会话门）→ `search`/`view` 只读分支 → 其余 `assertAllowWrite(true)` + `requireDir` → switch 到各 `do*`（`src/memory/tool-v2.ts:701-737`）。
- `view`：`resolveMemoryFile` 判目录/文件（`store.ts:142`），目录走 `renderDirectoryListing`（含 doctor 摘要，`tool-v2.ts:276-324`），文件支持 `view_range`/`section`（`:338`）。
- `create`：`maxWriteBytes` 闸 → 锁内 `statRegularIfExists` 拒已存在 → `upsertFrontmatterFields({source:"agent",updated})` → `maxFileBytes` → frontmatter 合法 → core/topic 硬上限（core 用 `coreBytes`，topic 用 `topicMaxBytes`）→ `writeTempRegular` + `createExclusive` → 预算行（`tool-v2.ts:484-501`）。
- `str_replace`：唯一匹配（`findStrReplaceMatches`，`edit.ts:31`）；命中 user-authored（无 `source: agent`）的 frontmatter 区则拒（`tool-v2.ts:520-527`）；手写文件不改 frontmatter（`:530-533`）；`assertNoNewFrontmatterErrors` + `commitReplace`（`:118`）。
- `insert`：`insert_line` 或 `section` 定位（`edit.ts:89`），同一套上限与 commit（`tool-v2.ts:549-586`）。
- `delete`：手写文件拒绝；`renameNoClobber` 到 `.trash/<id>-<name>`，`pruneTrash` 保 20（`tool-v2.ts:630-661`）。
- `rename`：v2 名字校验 + 手写拒绝 + `renameNoClobber`（`:664-679`）。
- `search`：`searchMemory` 全文/小节命中（`search.ts:83`，`tool-v2.ts:681-697`）。
- legacy 别名：`write`→`doOverwrite`（手写拒绝，`:588-607`）；`append`→`doAppend`：锁内读-改-写 + CAS 提交，但**不 upsert frontmatter**（`:610-627`）。
- legacy 工具（`toolSurface:"legacy"`）：`list|write|append` → `writeMemoryFile`（`store.ts:186`）；append 是纯 `appendLegacy` 追加、绝不改 frontmatter（`store.ts:147-148,177-197`）；子会话写需 `memory.allowWriteInChildSessions`（`tool.ts:130-136`）。
- 校验/上限：单次 payload ≤ `maxWriteBytes`(64K)、文件 ≤ `maxFileBytes`(256K)、topic ≤ `topicMaxBytes`(16K)、core ≤ `coreBytes`(1600)（`settings.ts:189-215`，`budget.ts:110` 输出 `<file> size/warn(hard) · core X/Yk · block X/Yk (LN)`）。所有写都在 `withMemoryDirLock` 内；成功后统一 `onAfterWrite(cwd)`（`index.ts:98-110`：freeze 则冻结上一轮块，否则失效缓存）。

## 4. 读取/注入路径

- 落点：memory 不是自己的 hook，而是向 `PromptSectionHub` 注册名为 `pi_project_memory` 的 section（`index.ts:112-133`）；hub 在 `before_agent_start` 折叠进 system prompt，`foldSections` 以 `\n\n` 追加（`src/sysprompt/hub.ts:329,349,407`）。
- 冻结快照机制：`prompt-sections/stable-section.ts` 状态机 —— 快照在头部只写一次，后续变化走尾部更新消息；每 section 上限 3 条 / 32KB，超限降级为 POINTED 指针（`src/prompt-sections/stable-section.ts:4,35-70`），更新消息由 `renderSectionUpdateMessage` 生成（`hub.ts:365`）。mode 由 `systemPrompt.mode` 决定（stable/live/legacy，`hub.ts:37`）。
- 顺序契约：hub 先建（`src/index.ts:205`）再 `wireMemory`（`:220-221`），故 fold 序 = memory → agent types → models（`src/index.ts:620-623`）。
- 每轮渲染：`renderLive`（`inject.ts:219`）按 `layout` 分派；tiered 走 `renderTiered` + `TieredRenderCache`（指纹=文件 name:size:mtime，`tiered.ts:203`），legacy 走 `renderMemoryBlock` + `RenderCache`（`render.ts:194`）。provider 同步、异常返回 SKIP，永不炸会话（`inject.ts:322-328`）。
- 字节预算：`blockBytes=2400` 硬上限、`coreBytes=1600`（clamp ≤ blockBytes−600）、`inlineMax=3`、`indexMax=15`、`byteCap=4000`（仅 legacy）（`settings.ts:189-215`，`tiered.ts:34-39,684`）。tiered 降级梯 L0–L5，L5 只留骨架（`tiered.ts:776`，`contracts.ts:62`）；索引行上限 200B，description 截 110B、read_when 截 70B（`tiered.ts:33-37,491-505`）；装不下时压成 `- also: a.md, b.md (+N more)`（`tiered.ts:540-550`）。
- 框架文本：header `## Memory (<slug>) — N file(s)`、guide（按 `access` 四态）、`- … +N more`、尾哨兵 `<!-- pi-toolkit:memory <slug> -->`（`contracts.ts:80-108`，`render.ts:26`）。
- `access` 判定来自会话活跃工具集（`tiered.ts:128`）：`memory+read | memory | read | none`，会话内粘滞（`inject.ts` 注释 §2.4）。
- 子会话：pre-guard 注册，`injectInChildSessions`(默认 true) + `childProfile`(默认 `core`) 控制（`inject.ts:296-306`，`settings.ts:21-40`）；legacy layout 只认 `none`。外部 droid：`renderForExternal` → `ExternalAgentsPort.memoryBlock`，受 `externalAgents.droid.injectMemory`（`src/stack.ts:910-912`，`src/external-agent/port.ts:234-236`）。

## 5. 维护路径

- `/mem` 命令族：`path · init · list · import [--force] [slug|all] · doctor · tidy [--dry-run|--frontmatter|--batch] · restore [--trash|--legacy] · 默认 list`（`src/memory/command.ts:42,154-241`）。
- `/mem doctor`：快照由 fs 构建（`doctor-command.ts:128`），`>20` 条改走 `ctx.ui.editor`（`:157-160`）。规则（`src/memory/doctor.ts`）：D01 无 core/降级 primary(`:312-357`)、D02 core 超 coreBytes(`:518`)、D03 pin 未整块进入(`:398-414`)、D04 topic 超 warn(`:389`)、D05 超 topicMax error(`:381`)、D06 缺 description/read_when(`:428-441`)、D07 frontmatter 结构错(`:445-455`)、D08 stale 或 `updated` 超 `staleDays`(`:458-476`)、D09 渲染降级 L1–L5(`:531-554`)、D11 topic 重复(`:497-505`)、D13 密钥扫描(`:478-489`)、D14 硬链接/不可寻址项(`:491-495,556-570`)。`DoctorId` 无 D10/D12/D15/D16（`contracts.ts:142`）。
- 启动提醒：主会话 + UI + `memory.doctor.notifyOnStart`，只看 error/D01，按 session + cwd 指纹去重，进程级 Symbol 表 256（`doctor-command.ts:191-260`）。
- tidy：`handleMemTidyCommand`（`src/memory/tidy/command.ts:90`）→ `snapshotMemoryDir` → `buildTidyPrompt`（`tidy/prompt.ts:1-40`，含 migrationMode / oversized 规则）→ `port.spawn({type: settings.tidy.agentType(默认 "Plan"), modelOverride: settings.tidy.model 或 ctx.model, schema: TIDY_SCHEMA, toolDomain:"readonly", budgetOverride})`（`tidy/command.ts:319-368`）→ `createCapWatcher(maxTurns, maxCostUsd)`（`:374-380`）→ `validateTidyProposal` → 逐文件确认/diff → `applyTidy`（`:525-540`）。预算：`timeoutMs 180s / maxInputBytes 49K / maxOutputBytes 64K / maxCostUsd 2.0 / maxTurns 4`（`settings.ts:236-250`）。
- `--frontmatter`：机械补 frontmatter（`planFrontmatterBackfill`，`tidy/frontmatter.ts`，应用 `:637`）。
- `--batch`：`handleBatchTidyCommand`（`tidy/batch-command.ts`）归档 + 模型分批改写（`ARCHIVE.md`、`index-edit` 剪枝、run lease、`TIDY_MAX_FILES-4`），`--triage` 未实现（`batch-command.ts:827-828`）。
- restore：`planRestore` / `applyRestore` / `restoreFromTrash`（`tidy/restore.ts`）；`/mem restore` 走 `tidy/command.ts:731`；trash 恢复冲突时 `ctx.ui.select` 三选（`:684-700`）。
- 事务：`tidy/txn.ts`（`runTransaction/recoverRun`）+ `journal.ts` 判定 roll-forward/roll-back/conflict + `manifest.ts` 严格 v2；中断的 run 在下次命令前恢复（`recoverInterruptedRuns`）。无硬链接的文件系统拒绝 txn tidy。

## 6. 外部调用点与约束

- `src/index.ts:219-221` — pre-guard：`memory.enabled` 时 `wireMemory(pi,{settings, isChildSession, sections: promptHub})`；`:333` post-guard 主会话 `attachTidy(createTidyPort(holder))`；`:862` 外部 agent 的 `memoryBlock` 端口。
- `src/stack.ts:450-455,910-912` — droid 注入记忆块的开关投影。
- prompt-sections：`pi_project_memory` 是四个合法 section 名之一（`src/prompt-sections/stable-section.ts:5`、`store.ts:23`），可持久化/回读。
- secure 域：不强制关闭 memory，而是重定向根目录 `ARMORY_MEMORY_ROOT=<state>/memory`（`src/secure/domain.ts:128,175,690`；`src/secure/env.ts:15-18`）；hub 派生进程会还原/删除该 env（`src/web-hub/hub/spawn/supervisor.ts:1875`）。`src/memory/**` 自身零 secure 引用（grep 无命中）。
- 设置键（`src/memory/setting-specs.ts:9-120`，全部非 live，改后 `/reload`）：`memory.enabled`、`injectInChildSessions`、`allowWriteInChildSessions`、`freezeInjectionAfterWrite`、`inlineMax`、`byteCap`、`indexMax`、`maxFileBytes`、`maxWriteBytes`、`layout`、`toolSurface`、`childProfile`、`coreBytes`、`blockBytes`、`topicWarnBytes`、`topicMaxBytes`、`doctor.notifyOnStart`、`doctor.staleDays`、`tidy.{agentType,model,timeoutS,maxInputBytes,maxOutputBytes,maxCostUsd,maxTurns,batch.*}`。

## 7. 测试与冻结面

- `tests/memory/`：33 个测试文件 + `helpers/fixture-dir.ts`（临时目录夹具）+ `tidy/{prompt,selection-view}.test.ts`；覆盖每个源文件（`tiered.test.ts` 34K、`doctor.test.ts` 36K、`tidy.test.ts` 62K、`tool-v2.test.ts` 39K、`legacy-golden.test.ts` 25K），另有 `fs-guard.test.ts`（store/manifest 不许直接 import `node:fs`）、`wire.test.ts`（装配）、`discoverability.test.ts`、`drift-header.test.ts`、`d04-d09-e2e.test.ts`、`eval-questions.test.ts`、`restore.test.ts`。
- `tests/fixtures/memory-legacy-golden.json` — 旧版渲染的 9 个 case（`a1_current5/single_file/over_index_max/inline_max_zero/byte_cap_zero/legacy_names`、`a2_main`、`a2_child` 等），generate-once，`UPDATE_MEMORY_GOLDEN=1` 在文件已存在时直接拒绝（`tests/memory/legacy-golden.test.ts:55-66`）→ 钉住 legacy 注入字节不变。
- `tests/fixtures/memory/tiered-golden/*.txt`（15 个：`g1_current5`、`g2_*` 覆盖 core 超 L2/L4、去重 pinned、huge/long slug、CJK/emoji、code-fence heading、many_files compact/L0/overflow、no_core、archived_only）→ 钉住 tiered L0–L5 决策与文本（`tests/memory/tiered.test.ts:41-49`）。
- `tests/fixtures/memory/doctor-golden/current-5.json` — 一份完整 `/mem doctor` 报告文本（`1 error · 6 warn · 1 info` 的 D01/D02/D06/D09…），`UPDATE_MEMORY_DOCTOR_GOLDEN=1` 同样 generate-once（`tests/memory/doctor.test.ts:800-811`）。
- `tests/fixtures/memory-tool-surface.json` — v2 参数 schema 的 canonicalJson + 工具文案字节预算（`src/memory/tool-surface.ts:42-80`）。
- `tests/fixtures/memory/` 另有语料：`current-5/`、`current-5-migrated/`、`synthetic/`、`cc-source/`、`tidy-payloads/`。
- 边界/治理：`tests/boundary/pi-free.test.ts:165`（memory 值闭包 pi-free）、`tests/web-hub/boundary.test.ts:197-204`（`memory/settings.ts` 只许 import `tidy/batch-settings`）、`tests/governance/activate-trace.json`（注册顺序）。

## 8. 已知痛点（代码/文档已记录）

- **append 不刷 `updated`**：legacy `append` 故意不读改写（`src/memory/store.ts:147-148,177`）；v2 `doAppend` 虽在锁内 CAS，但未 upsert frontmatter（`src/memory/tool-v2.ts:610-627`）→ D08 陈旧误判，`docs/dev/memory/hygiene-flow.md:9` 明确记录「`str_replace` 会刷、append 不刷」。
- **description 长度两套口径**：doctor/D06 用 `MAX_DESCRIPTION_BYTES=300`（`src/memory/meta.ts:19`），渲染层 `DESCRIPTION_MAX_BYTES=110`（`src/memory/tiered.ts:35`）→ 过了 doctor 仍被截断（`docs/dev/memory/field-study-claude2api.md:52` F3）。
- **索引按字母序贪心**：`activeTopics/staleTopics` 均 `sort(byName)`（`tiered.ts:716-717`），与重要性/新近度无关；默认预算下大量文件只剩裸名（field-study F4，`field-study-claude2api.md:64`；`hygiene-flow.md:44` 实测 13 文件仅 2 条完整行）。
- **无 core 时零常驻**：D01 原先沉默，现靠 warn（`doctor.ts:312-357`），field-study F2 记录了这一点。
- **drift banner 与 frontmatter 顺序**：`/mem import` 曾把 `> **pi copy**` 写在 frontmatter 之前使解析整体失效（F1，`docs/dev/memory/field-study-claude2api.md:25`）；现已双向兼容（`src/memory/frontmatter.ts:37,49-70`，`meta.ts:66`）。
- **D08 只依赖 `updated`/`status`**，mtime 不参与（field-study F5，`:74`）；D07/D06 逐文件罗列导致报告噪音（F3，`:52`；`doctor-command.ts:157` 仅 `>20` 条切编辑器）。
- **未实现面**：`renderTiered` 的 `extraTopics` 直接 throw（`tiered.ts:677`）、`--triage` 未实现（`tidy/batch-command.ts:828`）、近似重复检测 D12/`similar.ts` deferred（`src/memory/budget.ts:40`）、tidy 无 merge 原语与 core 引导（field-study F6，`:84`）。
- **手写文件保护是"拒绝"而非"合并"**：`write/delete/rename` 对无 `source: agent` 的文件一律拒（`tool-v2.ts:590-596,635-642,670-676`），`str_replace` 则允许但不动 frontmatter。
- **tidy 只知文件级、条目粒度的失效/权限无法表达**：`read_when` 只是给模型的自然语言（`hygiene-flow.md`「待技术方案回答」段），没有任何结构化过期/权限字段。

## 9. hygiene 增量方案计划触碰的文件（≤15 行，概述）

- `src/memory/hygiene/{contracts,entry-meta,entry-index,match,glob,strip,shell-parse,guard,echo,expire,expire-command,triggers-command}.ts` 新建：条目级元数据行 `<!-- mem … -->` 解析、条目索引、T1 匹配、shell argv 解析、写入回显/权限守卫、失效与 `/mem triggers|expired`。
- `src/memory/recall/{wire,state,t1,t2,t3,format,renderer,judge,classifier,chat-judge,prefilter,proxy-fetch,conditions,proc-scan,git-head,commit-scope,result}.ts` 新建：四层触发（动作/关键词/分类器/边界）全部走 custom message，不进 system prompt。
- `src/memory/contracts.ts`：加 `TieredRenderOptions.indexStyle/stripMemMeta`、`DoctorId` 加 D17–D19。
- `src/memory/tool-v2.ts` + `tool-surface.ts`：append 刷 `updated`、写入回显、元数据错误拒写、用户令二次确认。
- `src/memory/doctor.ts` / `doctor-command.ts` / `command.ts`：新增 D17–D19、启动提示、`/mem expired`/`/mem triggers` 分派。
- `src/memory/tiered.ts`：compact 极简目录行 + 剥离元数据行。
- `src/memory/settings.ts` / `setting-specs.ts`：新增 `memory.hygiene.*`、`memory.inject.*`（含 `judge.proxy`）等键（文中称 17 键）。
- `src/memory/index.ts`、`src/index.ts`：注册 `wireRecall`、传 judge 回退模型与 bashJobs 端口、`onRender` 带 `omittedSections`。
- `src/memory/tidy/{prompt,diff}.ts`：hygiene 开启时的增量提案。
- 新增 `skills/memory-hygiene/SKILL.md`；web UI：`src/web-hub/ui/src/components/transcript/entries.ts` 紧凑分支 + `src/web-hub/ui/src/logic/memMarker.ts`。
- 测试：`tests/memory/hygiene/**`、`tests/memory/recall/**`、`tests/integration/memory-recall*.test.ts`、`tests/conformance/memory-recall-channels.test.ts`、新 off golden；文档：`docs/dev/memory/README.md`、`docs/guide/memory.md`、`docs/dev/data-encryption/README.md`。
- 注：`hygiene-flow.md:Q19` 记录 2026-10-30 第七轮拍板「推翻 v4 重做，以分类器 Jev 为核心重新设计」，`hygiene-plan.md`(v4.1) 标记为被取代留档。

## 10. Jev 实测数据（主会话，2026-10-30）

调用方式：pi 1.4.0 `ModelRuntime.classify(model, {state, questions}, {fetch, signal})`，模型 `opencode/jev-1.13`（Zen 按量），`fetch` 为只走 HTTP 代理的单次 fetch（不装全局分发器）。脚本：`/tmp/jev-test/{test,test-perreq,scale}.mjs`（临时，不入库）。

**规模测试**（每个候选一个 bool 问题，约 70 token/问题，state 为一句用户消息）：

| 候选数 | 延迟       | 输入 token | 费用（美元） | 答案数 |
| ------ | ---------- | ---------- | ------------ | ------ |
| 4      | 650–820 ms | 632        | 0.0000265    | 4      |
| 10     | 786 ms     | 945        | 0.000040     | 10     |
| 40     | 790 ms     | 2,982      | 0.000125     | 40     |
| 100    | 880 ms     | 7,056      | 0.000296     | 100    |
| 200    | 1,148 ms   | 13,946     | 0.000586     | 200    |

- 延迟几乎与问题数无关（约 0.8–1.1 s）；成本线性，约 $0.042/百万输入 token，输出不计费。
- opencode 渠道上下文 32k（约 400 个问题）；openrouter 渠道 262k。
- 一致性：同主题不同措辞的变体给出相同概率（0.84）；无关条目 <0.1；沾边条目约 0.45–0.5。
- 质量样例（用户消息「帮我把 dev 推到 GitHub，顺便跑一下全量测试」）：推送走代理 0.81、发版期间禁止提交 0.48、gocryptfs 测试抖动 0.46、缓存设计 0.09。

**可用性与错误**（详见 hygiene-plan.md §2.4.1 / §14）：

- 直连本机出口 ⇒ HTTP 451 `Endpoint is unavailable`（按地区拦截）；经代理正常。pi 只有配置全局 `httpProxy` 才走代理；用户**不希望**全局配代理 ⇒ 需在扩展里给 `classify()` 传 `options.fetch`（Q18）。实现不能引入 undici 运行时依赖，须 pi-free 自写 CONNECT 隧道 fetch。
- Zen 余额为 0 ⇒ 402；凭证缺失 ⇒ `Provider is not configured`。`getAvailableOfType("classifier")` 在上述失败下仍列为可用 ⇒ 「有凭证 ≠ 可用」，需真实调用探测。
- 错误消息格式 `<Provider> API error (<status>): <body>`；`classify()` 从不 reject，失败为 `stopReason:"error"`。
- `opencode-go`（订阅）目录里没有分类器；Jev 只在 `opencode`（Zen）、openrouter、cloudflare、vercel、typesafe 名下。
- 能力边界：只能回答 choice / score / bool，带概率；**不能生成文字**。
