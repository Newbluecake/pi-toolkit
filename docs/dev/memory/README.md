# 项目记忆 · 开发者要点

> 何时读：改动 `src/memory/**`、`memory.*` 设置键、`/mem` 命令、tidy/restore 事务之前；涉及 `src/memory/jev/**`、`memory.jev.*` 时另读下方「Jev」一节。
> 来源：AGENTS.md@fcbf71dc 的对应条目，原文搬运，未改写（仅路径按目录移动更新）。新的实现细节直接写在这里，不要再写回 AGENTS.md。
> 相关：`memory-plan.md`、`tidy-batch-plan.md`、`jev-arch.md`（v2.1）、`jev-plan.md`（v2）。

## src/memory/

`src/memory/` — merged armory-memory: cwd-keyed project memory under `~/.pi/agent/memory/<slug>/`, with default `layout:tiered` injection and `toolSurface:v2` official-field tool surface; explicit `legacy` settings remain the byte-compatible opt-out. The tiered renderer enforces whole-file/whole-section admission and a UTF-8 byte budget; topic index lines carry `description`/`read_when` metadata, while `/mem doctor` reports D01-D14 health and its summary is surfaced by `/mem` and `memory.view`. Slug directories are canonicalized once and may be user-trusted symlinks; file-level symlinks and non-regular files are rejected. All v2 writes, imports, tidy, and restore operations serialize under the directory lock; batch tidy calls the post-write invalidation once. Registers a `pi_project_memory` section into the shared prompt-section hub (`src/sysprompt/hub.ts`, pre-guard, created before `wireMemory` runs so fold order stays memory → agent types → models) instead of owning its own `before_agent_start` hook (sysprompt-stable M3); the hub decides snapshot vs. tail update, `src/memory/inject.ts`'s `memorySection` provider only renders the current live block (pin frontmatter, agent-source fence, tail sentinel, fingerprint-keyed render cache). The `memory` tool lists/writes/appends (child sessions read-only by default, writes carry `source: agent` provenance); `/mem` covers list/path/init/import/doctor/tidy/restore (`init` creates an agent-source `core.md` skeleton stamped `source: agent` — deleting that line locks it as user-authored — and refuses an existing, archived or pin-stand-in primary). Tidy and restore are journaled transactions (`src/memory/tidy/{txn,manifest,journal}.ts`, design `docs/dev/memory/tidy-batch-plan.md` v3.2): the run event records the full planned op list before any intent, every MOVE/CREATE/REPLACE is CAS- and owner-epoch-checked and its result carries a mandatory final observation, an interrupted run stays resumable and is recovered before new work, and manifests are strict v2 (v1 backups restore only with `--legacy`, also through the txn layer). Hard-link-less filesystems refuse txn tidy (fail closed). Directory locks follow M-T4: a lock whose holder cannot be proven dead (old-format, cross-host) is never broken by age — writers get an actionable busy error and only the TUI-only `/mem tidy --break-lock` (epoch bump BEFORE lockBreak) clears it. `/mem tidy --batch` (P3a, `batch-command.ts`) archives stale entries into `archive/` (+ `ARCHIVE.md`, index pruning) and rewrites the rest in model batches sized by the dispatch-time `SpawnRequest.inputBudget` measurement (re-splitting on `input-budget` failures), holding one run lease for the whole command, bounded by `memory.tidy.batch.*` (bounded cost cap, max model runs, activity clock excluding dialog time); `--dry-run`/`--status` are read-only and web-allowed, `--triage` (P3b) is not implemented. `paths|frontmatter|store|render` are pi-free; `index.ts` (`wireMemory`) is the only pi-facing assembly and holds all mutable state in its closure; registered pre-guard. Design: `docs/dev/memory/memory-plan.md`.

## 局部类型兼容注记（pi 1.5，2026-11-06）

`tidy/cost.ts` 的 `ModelCostLike.tiers` 为显式 `…[] | undefined`：pi 1.5 的价目 DTO 可显式携带 `tiers: undefined`，type-only 边界兼容；本地 pi 1.4 下 typecheck/门禁保持通过，runtime JS 未变，不代表 TESTED_PI_RANGE 已升。详见 `docs/dev/pi-version-adaptation/plan.md`。

**`.trash` ids (invariant).** Every soft-delete into `<memDir>/.trash/` (the `memory` tool's `delete` in `tool-v2.ts`, Jev review edits in `jev/entry-edit.ts`; tidy and restore only read it) names the file `<id>-<name>` with `id = newTidyId(now, pid, 6 hex)` — `\d{8}T\d{9}Z-<pid>-[0-9a-f]{6}` (millisecond stamp). That is the only shape `tidy/manifest.ts` `listTrashEntries` and `safe-fs.ts` `TRASH_NAME_RE` accept, so `/mem restore --trash` can list and restore it; a hand-rolled stamp (the pre-9bc556b8 second-precision/base36 one) silently makes deletions unrecoverable from the command. Pinned by `tests/memory/tool-v2.test.ts` (list + restore) and `tests/memory/jev/entry-edit.test.ts`. Residual: the trash name segment must also be a v2-safe name (`[A-Za-z0-9][A-Za-z0-9._-]*.md`); a legacy-named file deleted by review is listed but `restoreFromTrash` rejects it (`INVALID_LOC`).

## Jev（`src/memory/jev/`）

Jev 是一个分类器驱动的核心 memory 子系统，职责三项：召回（U/A/E/B 四层注入）、写入时自动打标、周期整理（建议制，不自动执行）。**高危动作拦截（gate）已于 2026-11 彻底移除**；**用户令守卫的人工确认（TUI 确认框/Web 弹卡/超时与无 UI 拒绝）也已于 2026-11（#26）移除**——agent 改动/删除用户令直接写入：tool_call 只剩 A 层注入；`gate`/`gate=hold`/`nogate` 行内注释仅为旧记忆文件保留解析（`entries.ts`/`entry-edit.ts`），不再有任何行为；`jev/readonly.ts`、`jev/probes.ts`、`wire-gate.test.ts` 等随功能删除。设计全文见 `jev-arch.md`（架构，v2.1）与 `jev-plan.md`（实施方案，v2，J0–J9 分包）；下面只列不变式与门禁，细节以代码为准，与架构稿冲突时以代码为准并在交付报告列出。

**不变式**：

1. Markdown 记忆文件是唯一权威数据源；`.jev/` 是可丢弃的派生侧车，以条目内容哈希为键，Jev 从不写行内注释。
2. `jevWired` 判定（plan §1.1）为假时，`wireMemory` 与 Jev 之前逐字节相同——由 `tests/fixtures/memory/jev-off-golden.json`（A′，永不重生）证明；唯一例外是 Q34「classifiers 全部非法」的启动提醒一行。`off(pi-api)`（设置开、运行时无 `ctx.modelRegistry`）由同一 golden 的 `pi-api` 配置逐字段比对加 `PI_API_ALLOWED_DIFF`（只许追加）证明。
3. 全仓只有 `jev/client.ts` 调用模型 `ctx.modelRegistry.classify()`（`src/fabric/xs/receiver.ts:318` 有同名 `classify` 方法，但那是 XS 回执账本的分类，与模型无关）；`ctx.modelRegistry` 每次从 ctx 取，不跨 activation 缓存。
4. `jev/*` 除 `wire.ts`、`segment.ts` 外 pi-free（`tests/boundary/pi-free.test.ts`）；`settings.ts` 不新增 import。
5. 进程级共享只有健康表（32 项）与令牌桶；其余缓存属于 `wireJev` 闭包。
6. `tool_call` handler 整体 try/catch，粗筛在第一个 await 前完成；异常放行。`before_agent_start` 只返回 `message`；`tool_result` 恒返回 `undefined`。
7. 侧车合并只在 `withMemoryDirLock` 内同步完成，Jev 调用绝不进锁。
8. 外发先截断后脱敏；文件正文、成功工具结果、system prompt、助手消息与推理永不外发；`private`/`secret` 条目整条剔除；进程证据只收录被点名程序且仅 Linux（非 Linux 退化为只看本会话 bashJobs）。
9. secure/locked 域双重关闭（D8 + 不接线：强制关闭在 `src/config/settings.ts:430`（`applySecureDomainOverrides` 把 `memory.jev.enabled` 打 false），接线判定在 `src/memory/index.ts:126` 的 `resolveJevWiring(opts.settings, opts.secureDomainKind)`；`src/index.ts` 只负责把 `secureDomain.kind` 传给 `wireMemory` 的 `secureDomainKind` 形参，不自己判定。行号会漂，以函数名为准）。
10. 注入只走消息通道、只追加；customType `subagent:memory-inject` 的 details 只追加字段（I10）。
11. 用户令变更判定域（`str_replace`/`insert`/`write`/`append`/`create` 覆写 + `delete`，外加手写→非手写 provenance 翻转、未归档→归档两条判定；`rename` 不在域内；命中 ⇒ **直写 + voided 回显（字节不变）+ 主会话 TUI warning 通知（`noticeId` 只有序号和行号，不含 heading/正文）+ CAS/abort 检查点；无任何确认**，见 `no-user-guard-confirm/plan.md`）与打标触发域（`JevWritePort` 覆盖的五个写操作，不含 `delete`/`rename`）是两个不同的集合，详见 `jev-arch.md` §6.2.5。手写文件的 write/delete 拒绝条件保留，但它已不再是不可绕过的保护——先插入 `source: agent` 翻转 provenance（只有通知）再 write/delete 即可绕开。
12. 诊断日志不破坏 TUI：`wire.ts` 的唯一 `log` 闭包（分类器 failover 失败 + 全部 handler catch）在 `session_start` 探测到 `ctx.hasUI` 时只进闭包内环形缓冲（50 行，带 `HH:MM`），不写 stderr、不 notify（状态变化另有 notify）；`/mem jev` 末尾 `errors` 段展示最近 5 条，无错误时报告逐字节不变。无 UI 主会话（print/rpc）仍 `console.warn`，逐字节不变；**子会话例外**：子会话与主 TUI 同进程，写 stdout 会污染主界面，诊断同样只进环形缓冲（2026-11-03 用户报障修复）。由 `tests/memory/jev/wire-error-log.test.ts` 钉住。
13. （已随 gate 移除，2026-11）粗筛步骤 2b 纯只读豁免随 `jev/readonly.ts` 与 gate 通路一并删除；shell-parse 结果仍由 A 层与 tool_result 的标签匹配使用。
14. **A 层准入收窄（2026-11-03 噪音修复，用户拍板；数据：48h 内 A 层占注入 71%，release.sh 中断恢复系列被注 172 次而分类器从未判相关）**：tool_call 快速通道只许 `risk:"high"` 标签触发（加 `memory.jev.fastPathAllowTags` 白名单、减 `memory.jev.fastPathDenyTags` 黑名单；testing/ci/docs/workflow/shell-env/build/background-jobs 等泛标签不再单独触发）。跨会话冷却：`.jev/index.json` 顶层 `aInjectedAt`（hash → ISO 时间，独立于打标 upsert，cap 512 逐最旧）记录 A 注入时间，同条目 `memory.jev.fastPathCooldownH`（默认 24h，0=关）内不再经 A 层注入；**U 层判定不受此收窄/冷却影响**。会话内另有一份闭包 overlay（`aStamps`）兜住 2s 数据缓存与异步落盘的空窗。 stamp 写入 fire-and-forget，锁忙丢弃只损失一次冷却。由 `tests/memory/jev/wire-recall.test.ts`（A 层六个用例）与 `tests/memory/jev/index-store.test.ts`（aInjectedAt 四个用例；P 层同构的 `pInjectedAt` 另有五个用例：合并/不互相覆写/sanitize/cap 512/gc）钉住。注意：tag 准入判定读 `TagDef.risk`，不动 tag 定义本身——改预设 tag 的 description 会 bump `taxonomyRev` 触发全量重打标，本修复刻意避开。
15. **P 层（预测性预注入，`src/memory/jev/predict/`，memory-predict plan v3.2；P1b 为规则版零调用）**：
    - 轮首把 P 与 U **合并为一条** `before_agent_start` 返回消息（`commitParts`：P 先认领、U 中重复条目去掉，再按 `segment.remaining()` 裁剪；`details.parts` 按层记账）；只有 U 部分时整条消息与 P 引入前**字节相同**，`predict.enabled=false` 时 wire 输出逐字节不变（I9；`tests/memory/jev/wire-recall.test.ts` 全量 + jev-off-golden）。
    - **P 从不调用 `sendMessage`**（P2 未及时的模型结果也只写一轮缓存，不迟到投递）；不新增 `pi.on` 注册，只复用 Jev 已有 handler。
    - 承接 `carryState` 每轮 `before_agent_start` 从 `getBranch()` **倒序第一条 `kind:"final"`** 条目恢复（空 final 恢复为 undefined；wire.ts `restoreCarryFromBranch`，非承接轮同样执行恢复——清空簿记 cancel/todo-replaced/empty 随之生效）；`kind:"call"` 记账条目永不参与恢复。
    - 40 槽优先入池（§5.4）：仅当 eligible 超过 `RECALL_MAX_CANDIDATES(360)` 时生效——带预测 tag（score ≥0.5）的条目保留最多 40 槽（排序：用户令 → `max p × importance` → file），其余 320 槽走现有 `prefilter`，两段合并后去重；配额实现为 `predict/select.ts` 的 `prioritizeCandidates`（`tests/memory/jev/predict/select.test.ts` 钉住），`recallCandidates` 已接线（wire.ts §5.4）；`hintU`（P1b）默认关。合并注入时 P 先认领、U 侧重复条目去掉（P→U 去重）。
    - 状态约束 S（`release-in-progress`，`predict/state.ts`）不是动作判断：**不进 tag 投票、不受 negate/readonly/cancel 修饰影响**，至多注入 1 条（tag 含 `release` 且 authority=user 或 type=rule），job 结束（状态重算）后自动消失；S 走独立的 `SCandidate` 形状，**不受 `pInjectedAt` 冷却影响**（冷却只作用于 P 层候选）。
    - 由 `tests/memory/jev/predict/*.test.ts` 与 `tests/memory/jev/wire-predict.test.ts` 钉住（含「P 路径零次 `sendMessage`」断言）；评测入口 `node scripts/dev/predict-eval.mjs`（Tier 3，标注集结构与 §12.2 指标，见 `docs/dev/memory-predict/plan.md`）。
16. **P2 模型通路（`predict/{outbound,llm,flight,ledger,cache}.ts`，plan §6–§9、§11.2）**：
    - **唯一外发 DTO** 是 `PredictOutboundV1`（`outbound.ts`，§6.1）：逐字段 allowlist、先截断后脱敏、序列化 ≤6144B（裁剪顺序 previous_request → recent_tools 尾 → todo 尾 → request 尾）；shape 只发程序/枚举子命令，永不外发参数、flag 值、URL、路径、记忆正文、todo description、助手文本与子会话内容。
    - **turnKey 组成**（§7.1）：`sha1(canonicalJson(dto) ∥ 模型链 ∥ PROMPT_VERSION ∥ RULES_VERSION ∥ taxonomyRev ∥ threshold)`——键覆盖模型看到的全部字段；request 只脱敏截断，保留标点与大小写；LRU 64，TTL `cacheTtlMin`。会话内缓存，无跨会话（D4）。
    - **pendingModel 单槽**（§7.2）：等待窗口后才返回的模型结果只写缓存（turnKey + pendingModel），不投递；下一轮且**仅相邻轮**（turnSeq 相邻、未超 TTL）做意图兼容兑现——承接短语全权重、`cancel` 修饰丢弃、**其他新指令**只保留「当轮规则也命中或有 T/W 状态支撑」的 tag 且 M 分值封顶 `PENDING_CAP_P=0.6`（单独达不到注入门槛）；兑现后仍过 §4.2 最终修饰（否定/只读置 0），用过一次即清空。
    - **flight（§8.2，pi-free 状态机）**：全链硬期限 `requestBudgetMs`（外层 race 宽限 +500ms，不依赖 provider 响应 abort）；逐档 `attemptTimeout = min(剩余, ceil(budget/2))`，每档独立 reserve、计时器与 abort 监听（尝试结束即移除）；provider 永不 settle ⇒ 外层期限同步按预留结算并记 **zombie**，`zombies>0` 期间拒绝一切新准入直至 zombie settle；**breaker** 连续 3 败打开 10 分钟（segmented clock，unref）；用户长时间不输入后无任何存活计时器、不投递任何东西；shutdown abort 在飞、清计时器、置 disposed，此后 settle 无副作用。
    - **结账口径（M1）**：usage 与价目都过 `usableUsage`/`usablePrice`（三字段有限且非负）才按 usage×价目结算，否则一律按预留额；flight 报的 `costSource`/`costUsd` 与 ledger 实际入账严格一致——非法 usage/价目绝不出现 flight 报 `"usage"` 且 `costUsd=0` 而账本按预留入账的背离；非法价目的估算退回保守缺省价目（不产生 NaN 预留、不静默拒发）；结算额 ≤ 预留额（`spent + reserved ≤ maxUsdPerDay` 恒成立）。
    - **估算日账非绝对上限**（§9.3）：账本挂 `Symbol.for("pi-subagent:memory-predict-ledger")`（cap 8 天、跨 /reload 与同进程会话共享、本地日历日）只是有条件估算上限——无 usage 计费、reasoning 计费口径、N 个 pi 进程、zombie 晚完成均可超额，不承诺绝对金额硬上限。
    - **`predict.model.enabled=false` ⇒ 回退 P1b**：无 flight、无模型调用、无 `kind:"call"` 记账，规则路径输出与 P1b 逐字节一致。
    - **不迟到 send**：P 永不调用 `sendMessage`；窗口外完成的模型结果只写一轮缓存（§7.2），等待窗口 = max(`waitMs`, U 实际完成时刻)，上限 `recall.waitMs`，不增加额外等待（§8.3）。
    - 评测脚本模型部分（`--fetch-replies`）的真实调用由 `PI_TOOLKIT_PREDICT_EVAL_LIVE=1` + `DEEPSEEK_API_KEY` 显式门控，缺一即拒（零网络）；失败行如实记 `ok:false`，缺数据时 M9 等模型指标恒 NOT-EVALUATED，不生成假标注、不伪称达标。由 `tests/memory/jev/predict/{flight,ledger}.test.ts` 与 `tests/memory/jev/predict-eval.test.ts` 钉住。

17. **写入打标可靠性四件套（2026-11-04 用户批准，修复偶发 all-failed）**：
    - **预算**：写入打标总预算与单条同步预算 3s→6s（`write-port.ts` `WRITE_TAG_TOTAL_BUDGET_MS`、`tagging.ts` `TAG_ONE_SYNC_BUDGET_MS`）；client 每 try 上限 = ceil(total/2)（§5.2 规则不变）⇒ 每档 ~3000ms，付费兜底档不再被免费档挤到 1500ms。外层 abort timer 加 +500ms 纯僵尸兜底 slack（`WRITE_TAG_OUTER_SLACK_MS`），末档超时先由 client 自身期限结算（transient + detail），不被外层 abort 抢先变 `aborted`；I1/I5 不变（clampSpanMs + unref）。
    - **尝试顺序**（`client.ts` `usableIds` 的 `tierRank`）：lastModel（本次激活最近成功档）→ 健康 `ok` → 干净 unknown → 带未清 transientFails 的档垫底；同秩按配置顺序稳定 tie-break（全部同秩时输出与配置序完全一致）。未达 3 连败隔离阈值的免费档在下一 ask 即被降位，不再每次先吃预算。
    - **失败回显**：`all-failed` 的 `JevOutcome.detail` 携带逐档错误（`id: msg` 以 `·` 拼接，≤300 chars；`client.ts askInner`）；`write-port` 仅对 `all-failed` 追加 ` — detail`（经 `redactForJev("error")` + 200 cp 截断，`format.ts` `WriteEchoNotTagged.detail`）。off/pi-api/partial/aborted 等无 detail 路径字节不变（jev-off-golden 不重生）。
    - **诊断持久化**：`diag-log.ts` 把环形日志同步落到 `<memDir>/.jev/diag.jsonl`（≤200 行 JSONL，`{at,line}`；lock 内 read-merge-原子替换，busy/错误一律丢弃，fail-soft；落盘前过 `redactForJev` + 300 cp 截断 + 换行压平，不落记忆正文/凭证）。wire 的 log sink（UI/子会话环形路径）fire-and-forget 追加；无 UI 主会话仍只 console.warn，不读不写。`/mem jev` errors 段在内存环为空且（有 UI 或子会话）时回落读文件（重启/`/reload` 后可见最近错误）。

**门禁**：`tests/memory/jev/**`、`tests/memory/{tool-v2-jev,tool-v2-jev-guard-direct,command-jev,doctor-jev,inject-jev}.test.ts`、`tests/integration/memory-jev-*.test.ts`、`tests/integration/memory-user-rule-direct.test.ts`（#26 生产接线）、`tests/conformance/memory-jev-channels.test.ts`（C-J1–C-J15；C-J7/C-J8/C-J15 由 `PI_TOOLKIT_JEV_CONFORMANCE=1` 门控）、`tests/boundary/pi-free.test.ts`、`tests/governance`；评测 `node scripts/dev/jev-eval.mjs`（Tier 3，基线见 `docs/dev/memory/eval/jev-baseline.md`）。

**残留风险**：gate 拦截已移除（2026-11），不再有误拦形态，也不再有进程/git 证据收集（`probes.ts` 已删）；#26 移除用户令确认后——用户令可被 agent 静默作废（缓解只有三样：TUI warning、工具结果回显、skill 要求向用户转述；print、子会话、Web/headless 都没有通知；delete 可从 `.trash` 找回（保留 20 份），edit 无自动备份），手写文件保护可先翻转 provenance 再操作绕开，voided 回显仍带 heading（进入工具结果与 transcript，通知侧已不含）；Jev 判断质量依赖评测；默认开启使工具描述一次性变化、前缀缓存失效一次；dismissed 改写条目开头会重新提示整理建议；P 层的 W 信号端口（bashJobs/fleet）只在主会话 post-guard 挂载（`src/index.ts`，plan §11.1），子会话虽按 `predict.childSessions` 跑规则与 S，但 bashJobs 恒为空 ⇒ **S（发版进行中）在子会话永不触发**（R12/R13 的 git branch/dirty 部分照常）。

**默认值、分类器列表、阈值以代码为准**：`src/memory/settings.ts`、`src/memory/setting-specs.ts`（28 个 `memory.jev.*` 键：原 14（#26 删 `confirmTimeoutS`）+ memory-predict 的 14 个 `memory.jev.predict.*`，plan §10；其中 `model.*` 7 键在 P1b 只解析不使用，P2（§11.2）接线后生效）。各包交付报告见 `docs/dev/memory/reports/J*-report.md`。

## #36 blocks 治理 · P5a 开发状态（2026-11-06）

本节是当前开发状态，不表示 #36 的全部接线、默认布局翻转或真实数据迁移已经完成。治理核心位于 `src/memory/govern/{sweep-plan,sweep,supersede,review-lite}.ts`，pi-free；既有 files/tiered 行为与 golden 保持不变。

### 预算口径与一致性

- `runSweep` 的 **50 操作**指**写类安全原语的保守成本**，不是所有读取与写入总计 50，也不是 50 个归档块。一次完整归档计 6：确保 archive 目录、临时写映射、原子替换映射、移动块、临时写归档正文、原子替换正文；治理侧车 index 写计 3：确保目录、临时写、替换。已有目录的确保也计费；不把原语内部的 syscall 单独累加。
- **1000 ms 总墙钟包含扫描读取、规划、锁等待和写入**；锁等待最多 500 ms，并按剩余时间收紧。线性扫描逐读检查 deadline/gate/abort，块读取每 128 个 yield；写原语边界再次检查。同步文件系统原语不能在执行中被 JS 抢占。
- 扫描捕获一次目录身份/列表，no-follow 读取常规块文件后复核 dev/ino，避免旧通用 reader 逐块重枚举造成的二次复杂度。快照只提供候选：写锁内仍复核 rev、authority、active、expires，移动前再次做 rev 校验；取代同样走锁内七条件与旧块单边 CAS。
- 真实 2000 块临时目录基准：开发复跑 **371 ms / 48 写成本 / 8 归档**；独立验收 **418/419/457 ms**，同为 48/8。性能数据不替代边界检查，不承诺任意同步 I/O 都能被硬中断；生产门槛仍为 1000 ms / 50 写成本 / 500 ms 锁等待。

### 已接线与待接线

- **已接**：`wireMemory` 复用已有 `session_start` 和 `onAfterWrite` 触发 startup/write sweep；shutdown/reload abort；sweep-origin 写入只失效缓存，不自触发。显式 `supersedes=`、分类关系执行、单边恢复及永久 dismissed 已接工具/命令路径；Jev off 仍可显式取代，agent 永不取代 user。
- **P5b 待接**：task-done/push/release 的 Jev 事件信号、turn_end 消费，以及 render 预算/索引溢出信号；不能据此宣称全部治理事件已经上线。复用 `createSweepRunner(options).runSweep(memDir, reason, signal?, origin?)`，保持同目录重入合并、session abort 和 sweep-origin 屏蔽。
- **P5b 待接**：迁移后首次 user↔user review 的 host judge 与首轮信号/执行标记。核心端口为 `firstUserReviewPass(memDir, judge, { gate?, signal? })`；judge 接收 `readonly { a: string; b: string }[]`（块 id pair），返回 `Promise<readonly { a: string; b: string; p: number }[]>`。核心过滤非 active/private/secret 用户块，锁内丢弃 rev 已变化的迟到答案，只写建议、不自动取代；host 仍须负责准入、模型预算和外发脱敏。
- 默认布局翻转与真实数据治理不属于 P5a 完成状态；实际迁移必须继续遵守 #36 后续门禁和用户批准流程。

### P7 交接：需核对的行为缺口（未在本轮改行为）

- 迁移后 reload 提醒目前可能在每次 startup 重复显示，尚不是持久化的一次性提醒。
- blocks 的 `/mem review`、`/mem expired` 当前路由到 review-lite 治理子集，尚未完整呈现非治理 Jev 建议及原 expired 四组视图。这是命令能力/需求覆盖缺口，不是文档措辞问题；P7 应逐项核对需求与实现并安排补齐或显式裁定，不能仅靠更改文档宣称完成。

本包证据：`tests/memory/govern/{sweep-plan,sweep,supersede,review-lite}.test.ts`、`tests/integration/memory-blocks-{governance,supersede-race}.test.ts`；相邻门禁包含工具 v3/Jev、命令/tidy、pi-free、activate-trace 与既有 memory golden。

### #36 自动取代收窄（2026-11-07 用户新裁定）

仅完整取代才自动：新块整体覆盖或明确废弃旧块全部有效信息；部分冲突旧块保持 active 并给建议。`supersede` 非 explicit 只接受 supersedes，write-port 只将 supersedes 高 p 且未超 cap 标 auto；conflict 即使 p=1 也不自动。`CONFLICT_AUTO_P` 仅历史 cutoff，SUPERSEDE_AUTO_P 与每写最多 2 条不变；显式路径、agent→user 永禁及 authority/CAS/cycle/residue/dismissed 均不扩域。

治理 on 的 tool-v3 自动 afterWrite 追加 `wholeRelation:true`，经 blocks write-port/tagOne 传到 builder，独立于 askScope/includeScope；off/v2/bulk 不传新键，legacy cN 和 g1 问句原字节不变。治理 cN 的 duplicate 也须「新含旧全部有效信息」（新子集不合格），supersedes 须 whole 覆盖/明确废弃 all，partial overlap/conflict 属于 conflict/complementary。

缓存核证：生产 write-port 正文 hash 未变只跳过，变更 fresh tagOne；decideTagging 不存 cN，client.callOnce 直接 classify，无生产 cN 答案缓存。评测完整 question 文本变化使完整请求 replyKey 自然失效；不清私有缓存、不改 taxonomyRev、不全量 retag。G1 真实正例 10 < 20 仍 block；本包不 live、不实际迁移、不补样本。详见 memory-governance arch §5.4 与 plan 的日期化裁定。

## #39 三层记忆 · P1 session 内核实装与限界（2026-11-07）

本节是 P1（session 内核 + 通用授权面）的实装记录。**只描述已存在的代码**；装配（P4）、seed 管线（P2）、hub 存储/来源桥（P3）尚未实现，`memory.scopes.*` 默认 off，本包未加任何 hook/section 注册/工具/设置变更。

### 已交付（全部 pi-free、闭包态、无新定时器）

- `src/memory/scopes/limits.ts` — 不可信形状先行校验（描述符读取，绝不执行 getter/toJSON；拒绝 accessor/sparse/symbol/异原型/循环/超深/非有限数）、字段 regex（id/sid/leaf/from/24 字符 ISO 等）、三预算实测（raw UTF-8 / 最终 DTO JSON / render）、`META_MAX`/`ENVELOPE_MAX`、`sessionItemRevision`（sha1/8）与全字段 `opDigest`（sha256，canonical key 序）。fold 模式用 FOLD_HARD 界（64 项/每项 1024B/总 65536B/DTO 428032B），write 模式用产品界（48/8192/75776）；同一 validator 双档，不重复实现。
- `session-fold.ts` — `foldSessionMemory(branch, currentSid)`：以最近一条**整体合法** snap 为基（坏 snap 整条拒收并继续向前找），其后合法 put/del 顺序应用；非法条目记 `dropped`（≤16，保最近）；fork 继承（写入方 sid ≠ currentSid）与 spawn 继承（seed snap `inherit`）逐条标注；`currentSid === undefined` ⇒ 全部继承；历史 del 缺失 id 容忍为 no-op（折叠宽容、写入严格）；nextN 不回退（snap 项与 del 引用都参与下界）。
- `session-ops.ts` — `planSessionOp`：每操作恰好生成**一个** entry；`opsSinceSnap+1 ≥ 32` 时改为含本次效果与 `cause` 的完整 snap；单条 1024B/总数 8192B/48 项产品界（`E_TOO_LARGE`/`E_FULL`，拒收不截断）；update/delete 强制 expectRev CAS（`E_REV_REQUIRED`/`E_CONFLICT`）；最终 entry 过实际 JSON 字节门后才返回。
- `session-store.ts` — `createSessionMemoryStore`（`SessionMemoryPort` + `poisonedNow`/`verifyRecovery`）：串行 FIFO（默认界 64，超界 `E_BUSY`）；出队时**全新折叠**（leafId+条目数仅作只读缓存键）；last-await 同步复核（owner 引用身份/sid/epoch/branchGen/sessionFile、signal、cap、sessionWriteGate）后 cap 一次性 consume 再**单次 append**；append 后重新折叠核对效果，不可见 ⇒ `E_PERSIST_UNKNOWN`。**Poison（Root C0 裁定）**：本 writer 在自己 scoped append 上观察到的 E_PERSIST/E_PERSIST_UNKNOWN 即毒化本 store——后续 enqueue 一律带 `SessionPersistenceFailure{recovery:"explicit-reopen-and-verify"}` 拒绝；不重试/不修复/不删尾/不私有回滚；`verifyRecovery()` 仅在宿主 `isReopened()===true` 且真实 branch 折叠不抛时清除（普通 reload 不算）。locked ⇒ fold/view/snapshot 返回空且**零次 getBranch**。user 级写入的持久化 `grant` 完全由 cap 派生（turn8/capId8/channel），模型参数不进入。
- `op-cap.ts` — 私有 OpCap 注册表（mint→reserve→consume 一次性、revoked 终态；brand 符号不可构造，宿主外无 mint 路径）；reserve/check 校验 owner（incarnation 按**引用**）与 tracker 当前回合；审计行只来自 cap 字段（无正文）；`HumanTurnTracker`（interactive/web 新回合、非人类清空、生命周期撤销、每回合 3 框上限 + 单次拒绝记忆）。
- `authorize.ts` — `createOpApprovalPort`（`ApprovalPort`）：TUI select ⟂ `AskUserRemotePort` 经 `createDialogRace` 竞速；拒绝项恒第一；AFFIRM 标签内嵌 opDigest 前 8 位、题干含冻结原文全文；binding 摘要与冻结操作重算比对（篡改 ⇒ `E_META_INVALID` 不开框）；web 答案仅接受 `originKind ∈ {loopback, lan}`（飞书/缺省/字符串来源 ⇒ 回调 false），且回调时同步复核回合绑定，mint 前再次复核；取消/超时/abort/异值 ⇒ `E_HUB_DECLINED` 并记回合拒绝（同回合再请求 `E_HUB_DECLINED_TURN`，第 4 框 `E_HUB_RATE`）；无渠道 `E_HUB_CONFIRM_UNAVAILABLE`；rpc 模式不开本地 select；默认时钟 unref + `clampSpanMs`（I1/I5），测试注入 ManualClock。**生产 HumanDispatchProofPort（P3）未接**：tracker 回合由宿主喂入，authorize 不把任何字符串当 proof。
- `render.ts` / `session-section.ts` — authority-first 跨层去重（NFKC+空白压缩+去行内 meta 后 sha1；同权威取更具体层，败者 `(dup of …)` 标注，低权威 session 副本永不容遮 hub user 副本）；优先级说明行；English 行内标记；`pi_session_memory` 内容工厂：locked ⇒ SKIP 且**不调 view**（不读 branch）、空 ⇒ SKIP、超 render 预算退化为 pointer 残句（正文永不截断）。注册进 PromptSectionHub 属 P4。
- `src/secure/memory-gate.ts` 追加 `secureSessionWriteGate(domain, deps?)`（`SessionWriteGate`）：plain ok / locked 拒 / secure 每次实时读 mountinfo 判真挂载 + 目标（`sessionDir ?? dirname(sessionFile)`）canonical 化后必须在写区**严格内部**（sentinel 本身拒）；无文件（inMemory）仅查挂载；无状态无定时器。与 D3 同口径（`canonicalPath`/`inVaultWriteZone`/`vaultMountState`）。

### 门禁与证据

- 新测试：`tests/memory/scopes/{limits,session-fold,session-ops,session-store,session-section,op-cap,authorize}.test.ts`、`tests/secure/memory-session-gate.test.ts`（fake mountinfo + own tmp，无真实挂载，tier1）。覆盖：种子化随机序列与参考模型等价（4 seeds）、坏 snap 整拒、dropped≤16、每操作恰一次 append（含失败尝试计数）、第 32 次 cause-snap、1024/1025 与 8192/8193 与 48/49（及历史 64/65、65536/65537）±1、getter/toJSON 零执行、poison 三态与显式 reopen 复原、owner 死亡/迟到 cap/abort/门拒零 append、子会话 `E_CHILD_AUTHORITY`/继承 user 条目 `E_AUTHORITY`、locked 零 branch 读、TUI/Web 竞速各通道、originKind 门、绑定复核、rate/rejected、nonce/digest 篡改。
- 定向命令（PI_TOOLKIT_TEST_WORKERS=2）：`npx vitest run tests/memory/scopes tests/secure/memory-session-gate.test.ts` = 9 files / 114 tests 全绿；`tests/governance/test-tiers.test.ts` + `tests/boundary/pi-free.test.ts` 同跑 = 11 files / 157 tests 全绿；`npm run typecheck`（TS7×2 + vue-tsc）与 `npm run build` 通过；18 个改动路径过 prettier。未跑 full tier1/tier2/secure/conformance（按 P1 任务边界）。

### 限界（不得据此声称已完成的东西）

- **生产装配未实现**：P0 冻结文件与 `src/index.ts`/`src/stack.ts`/settings 均未动；无 section 注册、无 `scoped_memory` 工具、无 `/mem session` 子命令、无子会话写闸接线；flags-off 字节不变性由 P0/P4 门负责，本包零装配改动。
- **seed 管线未接**：`snapshot()` 是 P2 `MemoryParentPort`/`MemoryWorkflowPort` 的稳定缝（深拷贝+全冻结），driver/spawn/workflow 均未改。
- **hub 侧未实现**：P3 才有 hub-slot/hub-store/来源桥；render 的 hub 分支只是纯渲染供其消费。
- **授权来源证明未接生产**：TUI select 与 remote port 均为注入端口（P1 测试用 fake）；真实 `ctx.ui.select`、`AskUserRemotePort` 生产实例、`RemoteOutcome.originKind` 生产者与 HumanDispatchProofPort 归 P3/P4。Web 组件 width 40/80/120 渲染已由 P0 C4 证，非本包。
- **poison 语义边界**：只覆盖本 writer 在自己 scoped append 上观察到的失败；SDK 会话 flush 在别处的失败不可观察、不承诺 fsync/崩溃事务；`appended ≠ persisted`。custom-only 写入报 `memory-only`。
- **测试身份**：`tests/secure/memory-session-gate.test.ts` 是 fake mountinfo 的 tier1 单元（真实挂载 17 文件未动）；真实 UI/TUI viewport 验收属 P5。
- **id 编号耗尽（2026-11-07 Sonnet 独验反例修复）**：fold 与 planner 不再把 nextN 双钳到 999999——存在 `n999999` 时内部 nextN 到达 **1_000_000 耗尽哨兵**（published snap 的 `nextN` 字段仍保持在合法 1..999999 内，哨兵可由条目 id 重构）；此后 `create` 明确 `E_FULL` 拒写（零 append、绝不复用/覆写已存在 id，符合 K9），`update`/`delete` 凭显式 id+rev 不受编号耗尽牵连，且删除不释放编号（nextN 对见过的所有 id 单调）。已知边界：耗尽是**合法可触达状态**（存在 n999999 即到达）；耗尽会话的 seed `nextN=1_000_000` 目前按 P0 冻结的 seed 校验拒绝，后续 P2 必须对此显式 fail-closed（拒绝 seed 操作并如实报错），而不是丢弃 seed 或降级为空继承（不扩大 seed 契约）。

### P3a 实际状态（2026-11-07，kernel-only 包；P3b Web/TUI 生产来源暂缓）

**已实现（可独立实装的内核）**：`src/memory/scopes/hub-slot.ts`（同源 `resolveHubPaths` 透传工厂，paths 优先 / launchHome → HOME非空 → homedir，cwd/memoryRoot/agentDir 不参与；只读 `checkHubSlot`：absent / ok / {inert}，namespace uid+dev/ino+realpath+host 身份比对，半状态惰化）；`hub-store.ts`（复用 blocks `create/replace/trash` + `withMemoryDirLock` + safe-fs 原语；block 为正文/id/topic/rev/CAS 载体并带 `storageScope:"hub"` 标记；`items.json` 0600 原子侧车持久 grant/src/from（严格绑定 block `rev` + `updated`，缺 rev 或不匹配整槽惰化）；`audit.jsonl` ≤256 行仅 cap 字段无正文；`namespace.json` 0600 为封印、最后写入；容量 32 条/4096B/单条 1024B 拒绝不截断；`createHubMemoryProvider` view/render/enqueue + 出队/锁内/正文提交前三段复核 + owner/signal/secure-gate 实时复查）；`hub-section.ts`（纯工厂，locked SKIP 不触盘、超预算降 pointer、P1 authority-first 去重）。`blocks/format.ts` 仅追加可选 `storageScope?:"hub"`（ORDER 中 `scope` 之后，agent 权威忽略同 scope；旧文件字节不变）。

**P3a 批准布局与原设计差异**：arch §3.2 行 123 原计划 BlockMeta 追加 `grant`/`src` —— 本包 Root 任务令只批了 `storageScope`，故 grant/src/from 持久化在 hub 私有 `items.json` 侧车（锁内原子写、读时严格比对 block `rev` 和 `updated` 防陈旧错配、损坏/缺失整槽惰化）。这是本包批准的实际布局；不扩 block 元数据，不迁移真实数据。旧私有侧车缺 rev 也 fail closed，不能盲重试或自动 adopt。

**目录安全与修复门（独验拒绝项修复）**：safe-fs 新增只读 `inspectDirSecurityNoFollow`，返回 uid/mode/dev/ino，不 readdir、不 mkdir、不跟随最终 symlink、不 chmod；原 `inspectDirNoFollow` 原样保留。`checkHubSlot` 每次读写验证 stateDir 实际 uid（不收紧其 mode 或 home/state 祖目录权限），hub-memory/blocks 则同时验证实际 uid 与 `(mode & 077) === 0`，缺安全元数据一律惰化。namespace 的 JSON 自证 uid 不能代替目录属主。首次授权初始化在 seal 前复核安全和目录身份；正文写入前再复核目录 uid/mode/dev/ino 和 namespace，变更拒写 `E_NAMESPACE`。不自动修复/收编用户目录，adopt 仍未接线。路径式原语与同步检查不是针对恶意同 uid 进程任意 syscall 间替换的文件系统事务。

**来源与历史界**：用户命令先经 P1 描述符安全读取，再与侧车读取共用 `parseProvenanceEntry` 校验，非法 project/sid8/label/from 或 getter 均在任何 mutating I/O 前报已有 `E_META_INVALID`。持久侧车只保留当前 blocks 中的来源，删除同步去掉对应来源，最多 32 live，不以时间排序淘汰 live 项；audit 单独持久截尾至 256 行，即使全为同毫秒也按追加顺序截尾，不含正文。

**失败效果与限界**：出队、锁内及正文提交前实时复核 owner（含 sessionFile）、回合/cap、signal、capability 和 gate；任何已观察到的失败都撤销该 cap，恢复条件不能复活。目录创建异常也转为结果并释放队列计数，不抛出悬挂 Promise。block/sidecar/audit 是多个独立原子文件交换，**不承诺 fsync/崩溃事务**：同毫秒更新也用 block.rev 判定错配，正文已写但来源未写则读惰化；mutating I/O 抛错返回 `E_PERSIST_UNKNOWN`，可能未写、部分写或已写，禁止盲重试。若侧车写成功后回调才抛，两个文件可能完整一致，后续可读的是与新 rev 精确绑定的新 grant/src，而非旧授权配新正文。成功 `persistence:"appended"` 沿用冻结 P0 枚举，只表示已写共享存储，不是 SDK append、也不是 fsync 保证。首次中断仍可能残留空 0700 hub-memory（absent）或 namespace 未封印的半状态（inert），不自动删除或修复。

**P3a 交付时未实现（P3b 来源桥/paths 的后续实装见下节）**：`/mem hub` TUI 子命令、adopt 动作及 hub restore；当时来源桥尚缺真实 TUI 正向证据，不据此推导 #61 专用 RPC 是 #39 前置；P4 装配（section 注册、`scoped_memory` 工具、子会话写闸、tiers/boundary 白名单）；多进程真实 fork 争用（当前为同进程双 provider + 真实锁原语/manual lockCreate 模拟）；`hub restore`。

**测试**：`tests/memory/scopes/{hub-slot,hub-store,hub-commit-approval}.test.ts`、`tests/integration/memory-scopes-hub.test.ts` 全部 own /tmp 真 I/O；授权只注入 fake TUI select，**不能称为生产 TUI 支持**。新增真实 0755/0777、wrong uid/缺元数据注入、namespace 伪装、symlink、目录 inode/提交前 chmod、固定时钟故障/直接改正文/缺或旧 rev、来源合法边界/getter 零执行、>256 churn 保留早期 live 来源及审计持久尾界、锁内 owner/turn/gate/abort/capability 失败后恢复不复活、mkdir 抛错队列释放等回归。scopes + integration + fs-guard + blocks format/store/write-gate + pi-free + tiers 定向通过（18 文件 / 242 测试；日志与精确命令见 `/tmp/memory39-p3a-fix-handoff.json`）。新增测试临时 noEmit、项目 typecheck 与私有 outDir 后端构建另列交接证据；未跑 full tier1/tier2/secure/conformance，没有真实 API/模型/用户目录/挂载/生产重载。

### #39 P3b 来源桥实际状态（2026-11-07；未做 P4 根装配）

**已交付**：`src/web-hub/agent/human-dispatch-proof.ts` 的 activation-private `createHumanDispatchProof`，消费冻结 P0 proof port 与同一个 P1 `HumanTurnTracker`/OpCap registry；不依赖 XS、文本 ledger、next-user、时间窗或 provider 对象 identity。WebHub 的 `WebHubDeps.memoryProof` 只消费 P4 传入的同实例：正常即时 `handlePrompt` 在实际 `sendUserMessage` 周围 `dispatchWeb`，原 cmdId/结构化 origin/owner/generation 在私有 ALS 内一次认领；`dispatchHeld`、topic-switch/replay 共用的 `dispatchItem` **不新 mint**。普通 native steer/followUp 投递不改，无新增 held adapter/重派队列。

**真实 TUI 门已证**：SDK 1.5 正常 native TUI `session.prompt` 的实际 `ctx.mode=tui`、input `source=interactive`、`isIdle()===true && hasPendingMessages()===false`；早期 handler 的私有 ALS `enterWith` 能贯穿真实 input await → user `before_agent_start`。后者到达时 SDK `_prepareRun` 已将 `isIdle()` 置 false，因此准入布尔只在真实 input（Web 另在 send 前）检查，**不偷偷放宽**任何门，也不在 BAS 要求尚空闲。BAS 必须是实际 `messageType=user`、当前 owner/generation、同 private scope/active candidate；custom BAS、nested input、并发候选、handled 后机器输入不能窃取待定候选。合法 transform/SDK 吞掉的 nonfatal input error 可保留原可信来源，不比较 prompt 字符串，不要求不可观察撤销。候选并发或前一 handled 候选仍未被生命周期清除时保守拒绝，不把“下一条同文”作为补证。

**Web 确认修复**：`dialogs.ts` 在实际 answer/cancel callback 前从 `CmdOrigin.listener` 与 `isFeishuCmdOrigin` 本地投影可选 `RemoteOutcome.originKind`；legacy display 字符串不填、unknown 不填、Feishu 标记为 feishu（P1 不授权）。没有新增 wire 字段，原 dialog nonce/id/epoch/选项校验和第一同步回调竞速保留。`createHumanOpApproval` 使用 P1 原状态机，本地 select 仅当**请求当时** `ctx.mode=tui` 且有真正 `ui.select`；RPC 即使 `hasUI=true` 也不能当本地确认，只能有效 Web remote。exact raw text/full op digest/rev/owner/sid/turn 的授权及提交复核仍全部由 P1/P3a 完成。

**P4 消费端口与唯一 hook owner**：P4 独占创建 tracker/registry/bridge 和 owner 生命周期；将同 bridge 传给 `WebHubDeps.memoryProof`，将 `WebHubControl.askUserRemote()` 提供给 `createHumanOpApproval`。`createHumanDispatchHookOwner(bridge)` 返回实例内幂等 wire helper；P4 在 secure guards 后、任何可重入/handled input interceptor 前调用，TUI-only（WebHub off）也用同 helper。WebHub index 本包**没有实际新增 hook 注册**，不改 FORWARDED_EVENTS，不刷新 activate trace；P4 装配时再集中收口 trace。helper 覆盖 input/BAS/agent_start/agent_end/settled/session/tree/shutdown；Root reload/teardown 仍必须 `bridge.dispose()`，并给 approval/store 传生命周期 AbortSignal，显式 abort 调 `revoke("abort")`。owner 必须在 incarnation/session/真正 tree 边界变化，不能把每次普通 append 的动态 leaf 当 branchGen。子会话不得提供 human source/UI port，硬只读仍归 P4。

**同源路径**：`effective-paths.ts` 的 `createEffectiveHubSlotPort` 在 scopes off/secure/locked 明确返回 absent，连 lazy paths getter 都不调用；plain scopes-on 时仅委托 P3a `resolveHubSlot`。Web 开启时传 `WebHubControl.memoryHubPaths()` 的同次解析对象；TUI-only 可独立用 default-slot，**不强绑 webHub.enabled**。不加第二套 HOME/agentDir/memoryRoot 推导，无磁盘创建。

**证据与限界**：`tests/conformance/memory-scopes-proof.test.ts` 使用 own HOME/agentDir、真实 SDK、scripted local runtime 和生产 bridge/commands/dialogs/approval/provider；native idle TUI 与正常 idle Web（实际 void ExtensionAPI send）均经过**真实 SDK toolCall → exact Web 确认 callback → cap reserve → P3a hub 写入 → 读取原文**。native queued steer/followUp 保持普通投递且工具得到 `E_HUB_NEEDS_HUMAN_TURN`，零 popup/写/重发；RPC、Feishu、机器同文、nested/custom/handled、owner-change、并发和 transform 有负/正门。另有三个 agent 单测文件覆盖 one-shot、owner/session/file/epoch/tree、未知 idle API、Promise reject、origin/race/旧 nonce/late popup、RPC local-select 禁门与路径 absent。没有模型/API/真实用户数据/挂载/安装/reload；不是 P4 根装配或真实终端/浏览器 viewport 首发验收，不宣称产品三层接线已经完成。

**真实最小缺口（回 Root，未在本包伪造）**：P3a provider 只有 view/render/enqueue CRUD/dispose，hub-slot 只有只读检查/解析；无授权 reseal/adopt 公共 kernel、无 hub-trash 列举/restore 公共 kernel。`/mem hub`、工具 surface 和 root/stack 唯一装配属于 P4；adopt/restore 不能以普通 enqueue 或无条件覆盖 namespace 冒充实现，需后续批准 kernel 端口包。#61 专用 RPC 强消费凭证不成为本包 SDK 前置。

## #39 P4c 实际装配（2026-11-08；独立验收与 P5 尚待）

前文 P1/P3 各节的“未装配”是当时交付记录；本节记录本次 source 接线，不将 factory 门禁冒充完整上线。
plain + `memory.enabled` + 任一 scopes flag 才构造早期 shell，secure/locked/off 不构造 port、resolver、
store 或 poison registry。根唯一 actual-manager owner 提供稳定 MemoryOwner 引用、tracker/caps/proof、
shared approval、command registry、session store 和 Hub provider。上下文在 proof hooks 前更新；普通
leaf append 不变 branchGen，真正 tree 边界才换 owner。child 只接 public-bus receiver，无 human hooks。

- Store 必传实际 SDK manager identity（`getManager`），root append 走 void `pi.appendEntry`，child 走原
  manager append；sid/file/leaf/branch 均来自真实 manager。仅 SDK 实际 resume/new-manager 首次合格尝试
  消费 recovery receipt，并立即 fresh fold + zero dropped 核验；created/reload/tree 不签发。raw append
  **不是 fsync**，首 SDK conversation flush 之前仍可能只在 buffer；不可观察的别处 flush 失败不在本 writer
  保证内。unknown 不重试、不删尾、不修复。
- I4 的 poison 例外仍是同一个有界全局：最多 256 tombstones + WeakMap 实际 manager 的小 opaque identity/
  首次尝试标记；无 manager backref、正文、UI/cap/ctx closure。legacy v1 shape 保留原容器并 fail closed；
  需要**进程重启后真实 reopen**，普通 reload/off-on 不能清除它。
- Native main/TUI/UI/not-Web `/mem session add`、Hub add/rm 走 host-private direct command，无额外弹框，
  不是物理人类来源证明。adopt/restore 保留完整 token-bound 原文/metadata/digest 的**一次**确认。
  模型 `scoped_memory` 的 Hub/user 写入仍走同一个 exact sharedApproval；RPC 不当作 local TUI。
  Web 只允许新 scoped read routes，write routes 在 transport policy 前于 override 强制 deny，completion
  复用相同策略；原 memory/mem description/schema 不变。未增加模型 `/mem` 入口或新 SDK 依赖。
- 单个 `createScopedProjection` 与真实 `memorySection.projectSources` 接入；project→session→Hub 连续注册，
  同一 input 同步捕获真实 view。`available` 不额外读取 view；inert 由该次 captured view 判定。
  write freeze 保存 SOURCE+manifest，migrate/clear/delete/tree/session 生命周期清除本地来源；Jev render key
  来自最终投影文字，不重新解析已标注 prompt 推导权威，不改渲染内核。
- scopes-on child 即使旧 allowWriteInChildSessions=true 也强制 effective false，另有独立 content gate
  覆盖 mkdir/bootstrap/capture/internal commit。legacy/v2/store/init 仅增加可选实际 gate seam；command
  只读白名单在 import/init 任何发现/写入前拒绝。scopes-off 不替换 settings 对象、不改旧描述/注册。
  Jev 仍传**原 secure gate**，保留现有 cooldown/diag 派生写；自动 tag/backfill/review 的 child 早退未改。
- parent/workflow 端口捕获 owning root store；nested 读真实 Runner state/branch，并在读后复核 generation/
  sessionId/handle identity。缺失/变化/非法 seed 拒绝，不变 empty，不 shadow registry、不 resume reseed。

定向证据包括 actual root activate + official SDK/local fake provider 的 native commands/三层 prompt、
actual settings-discovered child activation 的 pre-context receiver、seed/own-agent 写与旧 allow=true 的 project
拒写、actual adapter→Runner→Driver memory-only cancellation、owner reopen/ABA/live remote，以及既有
source-proof/projection/Jev/trace/teardown 回归。精确命令、日志、未覆盖矩阵见 `/tmp/memory39-p4c-handoff.json`。
**P5 未做**：真实 TUI viewport/键盘/默认拒绝/滚动竞态、真实 browser dialog→CmdOrigin→cap→store。
select title/payload 测试不算 viewport pass；如实际裁切只评估 feature-local scroll adapter，不升级 SDK。

### #39 三层记忆默认开启（2026-11-08 用户裁定）

`memory.scopes` 自 2026-11-08 起为**产品默认开启**：默认 `scopes = { session: true, hub: true }`（默认值定义在 `src/memory/settings.ts`，随 #39 默认翻转包更新）。要点：

- parser 尊重显式 `false` 与部分覆盖（显式只关一层时另一层仍按默认开）；`memory.enabled=false` 只阻止接线，不改 scopes 默认值本身。设置非 live，改后需 `/reload` 生效。
- **回滚**：显式 `scopes:{session:false,hub:false}` + reload；数据保留——不回滚存储、不擦除历史（session 条目留在会话文件、hub 条目留在 `hub-memory/`，旧扩展忽略）。
- **secure 域**：D8 继续强制 `memory.scopes.hub=false`，且现有装配要求 plain 域，secure/locked 实际不创建 scoped shell/工具/section/store。**默认翻转不等于 secure 内已启用**；secure 内启用属于另一个安全装配任务，不在 #39 默认翻转范围内。
- **影响面（事实，以源码为准）**：主会话多一个 `scoped_memory` 工具与 `pi_session_memory`/`pi_hub_memory` 两个 prompt section（沿 `pi_project_memory` 之后注册）；wire 侧 6 个 context hook（`session_start`/`input`/`before_agent_start`/`agent_start`/`session_tree`/`session_shutdown`，`src/memory/scopes/wire.ts`）+ proof hook owner 的 8 个 hook（`input`/`before_agent_start`/`agent_start`/`agent_end`/`agent_settled`/`session_start`/`session_tree`/`session_shutdown`，`src/web-hub/agent/human-dispatch-proof.ts`）。child 只有 public-bus receiver + 两 section，无任何 human proof hook；project/Hub 内容硬只读（旧 `allowWriteInChildSessions=true` 失效）。空 session/空 Hub 不注入占位 section。
- **预算**：正文 48 项/8192B（session）与 32 项/4096B（hub）；render ceiling 63488B/34816B，超限退 pointer、不截正文（arch.md §6.6）。
- 首次空 Hub 不创建目录；mkdir 只发生在获准写入的路径上。默认开启不会自动迁移或收编旧数据（旧 files/tiered project 记忆原样）。
- **已知边界**：P5 真实 TUI viewport/browser 验收仍未做；默认开启不替代该证据。

### P4c 装配门禁续包（2026-11-08）

新增 actual Stack→SpawnService→Runner→SDK 的 slot FIFO/direct-parent 捕获，actual Stack workflow worker 的
per-call/local FIFO 捕获，以及 terminal resume 原 history 无再采样/再 seed 的断言。真实反例表明仅检查
Runner state.sessionId 不够：SDK 原 manager 的 `newSession()` 可在同 handle 中换 sid；Driver branch
read 现在在读取前后复核实际 SDK sid 与构造时 manager identity，失败不发布 branch、不降 empty seed。
预算、取消顺序和 SDK 均未改。

scopes-on child 的 Jev 实验经过真实 wireMemory→wireJev：A cooldown 写入原 `aInjectedAt`；独立 P 例只开
既有规则且 `predict.model=false`，写入原 `pInjectedAt`。A/diag 例关闭 predict。fake classifier、own /tmp、
无付费调用；content/自动 tagging/review/promotion 均不因此放开。**child diag 的既有行为是 ring/report，
不是 diag.jsonl**（child 不初始化 sessionCwd）；本包按实际行为保留，不为测试新增落盘权。

实际 SDK Web 测试覆盖 sendUserMessage 的 expand=false 原始 slash-shaped prompt、expand=true 的受控
command-capture 环境拒写、最终 Web transport scoped deny、普通 prompt 保持原语义；native add/rm 无
额外框，restore/adopt 各一个完整框。三条实际 Stack teardown entry 在不合作 popup 下同步首先关闭本
owner。secure/locked 测试只用 fake mountinfo 的实际 activate/SDK construction，不声称真实挂载验收。
