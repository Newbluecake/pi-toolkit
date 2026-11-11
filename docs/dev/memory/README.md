# 项目记忆 · 开发者要点

> 何时读：改动 `src/memory/**`、`memory.*` 设置键、`/mem` 命令、trash/block restore之前；涉及 `src/memory/jev/**`、`memory.jev.*` 时另读下方「Jev」一节。
> 来源：AGENTS.md@fcbf71dc 的对应条目，原文搬运，未改写（仅路径按目录移动更新）。新的实现细节直接写在这里，不要再写回 AGENTS.md。
> 相关：`memory-plan.md`、`jev-arch.md`（v2.1）、`jev-plan.md`（v2）。

## src/memory/

`src/memory/` — merged armory-memory: cwd-keyed project memory under `~/.pi/agent/memory/<slug>/`, with default `layout:blocks` injection; `toolSurface:v2` remains the configured files-layout tool surface, while enabled plain main/child sessions with an actual blocks/v3 surface publish unified v4 (v3 storage/operations underneath); secure/locked sessions retain the original factory. Explicit `legacy` settings retain the byte-compatible files-layout opt-out. With blocks configured and files still on disk, effective layout falls back to tiered for injection and doctor; existing blocks take precedence over tiered/legacy configuration. The tiered renderer enforces whole-file/whole-section admission and a UTF-8 byte budget; topic index lines carry `description`/`read_when` metadata, while `/mem doctor` reports layout-specific health findings and its summary is surfaced by `/mem` and `memory.view`. Slug directories are canonicalized once and may be user-trusted symlinks; file-level symlinks and non-regular files are rejected. All v2 writes, imports, and trash restore operations serialize under the directory lock. Registers a `pi_project_memory` section into the shared prompt-section hub (`src/sysprompt/hub.ts`, pre-guard, created before `wireMemory` runs so fold order stays memory → agent types → models) instead of owning its own `before_agent_start` hook (sysprompt-stable M3); the hub decides snapshot vs. tail update, `src/memory/inject.ts`'s `memorySection` provider only renders the current live block (pin frontmatter, agent-source fence, tail sentinel, fingerprint-keyed render cache). The project `memory` commands use the existing v3 view/create/update/delete/search operations in blocks layout (whole-block update with rev/CAS); explicit files layouts retain v2/legacy surfaces. Child sessions are read-only by default, and scopes-on children keep project/Hub content hard read-only even with the old write opt-in. `/mem` covers layout-specific list/path/doctor, read-only review/expired, migration and restore; init/import retain their files-oriented workflows (not block CRUD). `/mem tidy` and all `memory.tidy.*` settings were removed (breaking, 2026-11-09). Standalone `restore --trash` and blocks `restore --block` remain; legacy tidy backup restores are explicitly refused, without parsing or modifying their journals/manifests. Unverifiable directory lock owners require manual operator inspection; age alone never breaks a lock. `paths|frontmatter|store|render` are pi-free; `index.ts` (`wireMemory`) is the only pi-facing assembly and holds all mutable state in its closure; registered pre-guard. Design: `docs/dev/memory/memory-plan.md`.

## Blocks section repair

V3 inline write metadata accepts `section=value` or `section="multi word"`; `section=none`
clears it. Create persists the explicit value; update inherits an omitted value and replaces
or clears an explicit one. The normal 120 UTF-8 byte limit still applies, without truncation.
A migrated oversize section remains readable but an update that inherits it is refused with
repair instructions. Supplying a shorter section or clearing it repairs the block under the
same locked revision check. The legacy Jev inline guard remains strict; v3 removes this
blocks-only token before invoking it. Tool descriptions and frozen fixtures are unchanged.

## `/mem` discovery and removal compatibility

All layouts omit the removed tidy command and completions. Files advertise `restore --trash`;
blocks additionally advertise `restore --block`. Migration and `jev reset-index` are maintenance actions.
Jev-off command/doctor fields changed only for the declared tidy removal and manual D01 guidance;
the frozen contract's other fields remain unchanged. The `jev-off-golden.json` registration is missing
from AGENTS.md's frozen table; its local generate-once contract still applies outside this approved update.

`/mem tidy` was redundant: blocks never supported it, and #50 incremental inspection is the intended
replacement (P50.1 exists; P50.2/3 are still pending, not a complete replacement today).
Root `archive/`, `.backup/` manifests/journals and `.tidy-run.json` are deliberately ignored by scanning
and startup; they are neither recovered nor deleted. Native `restore [id]` / `restore --legacy [id]`
reach the error/notification exit with the safe [manual recovery runbook](../../guide/memory.md#legacy-tidy-backup-recovery). Deleted files remain recoverable via `restore --trash [id]`, under the directory
lock, write gate and strict atomic no-clobber link; conflicts leave both copies intact. No hard-link
support means refusal (never rename fallback). Link/unlink partial failures are marked mutated, notify
that the destination may have changed, invalidate caches, and require inspecting both paths before retrying. Existing trash ID bytes remain
unchanged in `trash.ts` (`newMemoryId` and `listTrashEntries`). No old lease or manifest is read during
trash recovery. Block archives remain supported and separate from obsolete root tidy archives.

D01 degraded-primary guidance is manual: rename the stand-in to `core.md` when absent; if an archived
`core.md` already exists, merge the always-on rules into it and ensure `status: active`.
This is **D01, not D02** (D02 is primary `coreBytes` overflow). `/mem migrate` converts files to blocks;
it does not rename the root file or preserve non-core pinned user rules as global residents.

## Web `/mem` context-free reads

The direct executor retains list/path, trash listing and supported migration previews. Removed tidy
previews/status are unknown and never read-only-whitelisted. Bare `restore`, backup IDs and
`restore --legacy` return `E_MEM_WEB_UNSUPPORTED` with the manual-recovery steps/runbook, not successful
read output. Only exact `restore --trash` is a trash listing; Web trash/block mutations remain unsupported.
No backup refusal enumerates `.backup`. Direct reads retain bounded completion-ledger
settlement and never invoke native write handlers, recover journals, acquire leases or call models.
The separate #65 session-add write port below is unchanged.

## Web confirmed-step building block (B1 partial, not wired)

`command-confirmed-step.ts` combines the existing private call/receipt kernel with a
one-attempt synchronous check/consume/commit boundary. Its adapter is responsible for
holding the appropriate domain lock, performing the complete frozen-plan comparison,
and confining **all** effects to the synchronous `apply` callback. Abort settles a
waiting caller and invalidates a late commit; it cannot cancel effects performed by an
unguarded adapter, or make a detached/asynchronous `apply` safe. The helper's callback
signature rejects Promise-returning apply functions, including for `void` results; its runtime
rejects native async functions before consume and reports `E_MEM_EFFECT_UNKNOWN` for a
thenable returned by an already-invoked callback. These checks cannot detect detached work
or undo effects already started; `runLocked` remains an unbranded, trusted callback. This helper is not a
production domain adapter and is not connected to Web dispatch: no write command is
thereby enabled. Real domain-specific plans, store guards and end-to-end Web tests are
still required before enabling any command.

## #65 B1 包4：session add 装配与真实 SDK / 浏览器门

`wireMemory.webWrite` 是独立可选 facade：main/plain/memory enabled/session scope 才构造；
每次 `start` 重新读取 `scopes.current()`，核对实际 SDK context 的 manager 引用，不缓存 owner、
不制造 context、不调用 native handler。根只在原 plain+memory gate 追加这个可选端口；缺端口
仍为 `E_UNSUPPORTED`。不加 hook、setting、原语 callback 或第二 owner/store。

`scopes/owner.ts` 在第一次真实 start 时惰性创建同 owner kernel，store 通过 getter 取它。
任务先同步返回并让 commands attach，再从 microtask prepare；确认不占 FIFO。call 绑定 manager、
incarnation、sid/file、sessionEpoch/branchGen 和 command admission。完成/取消先复制 store 的最终
观察，commands 唯一 settle ledger 后 finally release；normal done 只 close kernel，不提前删除计划。
owner dispose 先 cancel task/kernel 再 dispose store，复用既有 scopes 生命周期，不另加 abort hook。

验收修订 B1/B2：S1 在 running/rejected/completed/unknown 每个阶段重新读取 DOM 的
`data-cmd-id`，与真实 ledger entry.id 严格比较，逐态记录 `commandIdentity`（phase/domPhase/
domCmdId/ledgerCmdId/ledgerState）；汇总输出 `/tmp/65-pkg4-s1-command-ids.json`，不以领域 n1
或运行开始时的样本代替终态身份。缺失的可选 rev 仍不补 wire 值，DetailDock 另显示
「Revision 不可得：宿主未提供版本标识，未生成推测值。」，history on/off DOM 测试钉住该提示。

成功字段不拼进 message：bridge 在既有开放 command data 中携带 `memoryWrite:{id,rev?,persistence}`，
DetailDock 直接消费结构化字段；output 保留原领域提示。`appended` 只说明 file-backed 目标，
不是已 flush/fsync：真实 SDK custom-only 会话即使已有 sessionFile，首次 conversation 前也可能无文件。
三类实际 SDK（memory-only / buffered / 已 conversation flush）均验证恰一次 entry、领域计划/观察
同 hash、不 poison；随后 conversation flush 不重复 entry。SDK settled barrier 超过 5s capture TTL
仍走即时 seam，drain 后 native mem 与 sendUserMessage mem 均为零。

S1 probe：`npx tsx scripts/web-hub/memory-command-confirm-probe.ts`。使用离线缓存 Chromium、隔离
实际 SDK session、真实 HTTP/SSE、生产 DetailDock/useHub/useControl/reducer、remote AskUserForm +
dialog bridge、commands/controller/store/ledger；不脚本化成功/失败响应，不以按钮 spy 替代。
28 组（history on/off）覆盖等待确认撤销、批准后 commit barrier、点击先而 handleAbort 晚、
同步 attempted 可重入 unknown、store 已观察但 done 尚未消费时 completed、29 分钟判定，以及
permission/session/epoch/同名替换/断网/隐藏/真实模型后启/页面刷新；快照和完整 ledger/append/顺序证据写 `/tmp/65-pkg4-s1-*`。
probe 的 barrier/计数仅在测试 host，生产同步 apply 不加 await；浏览器 unavailable 退出 2，不算通过。
该 probe 是隔离 seam 全链证据，不是生产 Hub daemon 的认证/部署或真模型调用验收。

保留限界：FIFO 不约束外部 writer；最后文件 guard 后仍有跨进程竞态；100ms 是协作软预算，
同步 syscall 不能抢占；已提交 entry/两阶段标签不可回滚。会话级停止可能影响模型，点击时刻
不是 cancel 线性化时刻，unknown 不等于未写且不得盲重试。reentrant cancel 已发布 unknown 后，
后来的明确观察只用于清理，不升级 ledger。设计详见 `web-write-seam-design.md`。

**`.trash` ids (invariant).** File and block soft-deletes retain the historical millisecond/hex grammar
`\d{8}T\d{9}Z-<pid>-[0-9a-f]{6}-<name>` through `trash.ts`; files restore requires a v2-safe name.
The shared ID helper is also used by blocks migration and Hub trash; removing tidy must not change their bytes.

## Jev（`src/memory/jev/`）

Jev 是一个分类器驱动的核心 memory 子系统，职责三项：召回（U/A/E/B 四层注入）、写入时自动打标、周期整理（建议制，不自动执行）。**高危动作拦截（gate）已于 2026-11 彻底移除**；**用户令守卫的人工确认（TUI 确认框/Web 弹卡/超时与无 UI 拒绝）也已于 2026-11（#26）移除**——agent 改动/删除用户令直接写入：tool_call 只剩 A 层注入；`gate`/`gate=hold`/`nogate` 行内注释仅为旧记忆文件保留解析（`entries.ts`/`entry-edit.ts`），不再有任何行为；`jev/readonly.ts`、`jev/probes.ts`、`wire-gate.test.ts` 等随功能删除。设计全文见 `jev-arch.md`（架构，v2.1）与 `jev-plan.md`（实施方案，v2，J0–J9 分包）；下面只列不变式与门禁，细节以代码为准，与架构稿冲突时以代码为准并在交付报告列出。

**#36 P6b U 相关性问句**：单条 bool 的正例除应遵循的规则、陷阱、流程外，也涵盖有助于正确回答或避免误解的子系统设计、边界、原理与已知限制，即便当下无需执行；只有关键词或领域相同不够。`jev/questions.ts` 与 `scripts/dev/jev-eval.mjs` 模板必须同步（`questions-eval-parity.test.ts`）。判据变更会改变分类请求和评测缓存键，也可能改变分批；阈值与名额未变。实际召回/噪声改善尚待 LIVE 验证，不能由离线测试推断。

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

## #36 blocks 治理 · 核心与生产装配（2026-11-09 更新）

治理核心位于 `src/memory/govern/{sweep-plan,sweep,supersede,review-lite}.ts`，pi-free；下列预算数据来自 P5a，生产装配已由后续 I1/C3 完成（见本节及文末的装配记录）。当前默认 `layout: blocks`、`migrate.auto: true`，但不代表用户真实数据已完成迁移或验收。显式 files/tiered 行为与既有 golden 保持不变。

### 预算口径与一致性

- `runSweep` 的 **50 操作**指**写类安全原语的保守成本**，不是所有读取与写入总计 50，也不是 50 个归档块。一次完整归档计 6：确保 archive 目录、临时写映射、原子替换映射、移动块、临时写归档正文、原子替换正文；治理侧车 index 写计 3：确保目录、临时写、替换。已有目录的确保也计费；不把原语内部的 syscall 单独累加。
- **1000 ms 总墙钟包含扫描读取、规划、锁等待和写入**；锁等待最多 500 ms，并按剩余时间收紧。线性扫描逐读检查 deadline/gate/abort，块读取每 128 个 yield；写原语边界再次检查。同步文件系统原语不能在执行中被 JS 抢占。
- 扫描捕获一次目录身份/列表，no-follow 读取常规块文件后复核 dev/ino，避免旧通用 reader 逐块重枚举造成的二次复杂度。快照只提供候选：写锁内仍复核 rev、authority、active、expires，移动前再次做 rev 校验；取代同样走锁内七条件与旧块单边 CAS。
- 真实 2000 块临时目录基准：开发复跑 **371 ms / 48 写成本 / 8 归档**；独立验收 **418/419/457 ms**，同为 48/8。性能数据不替代边界检查，不承诺任意同步 I/O 都能被硬中断；生产门槛仍为 1000 ms / 50 写成本 / 500 ms 锁等待。

### 当前接线与范围边界

- **#50 为 #36 子项**；P50.1 触发/聚合实现见文末，activity owner 窄补丁待接；当前已有的「写入时比较 + 周期 review + sweep」不等于 P50.2 生成/提交或 P50.3 审计/恢复。
- **已接**：`wireMemory` 复用已有 `session_start` 和 `onAfterWrite` 触发 startup/write sweep；shutdown/reload abort；sweep-origin 写入只失效缓存，不自触发。显式 `supersedes=`、分类关系执行、单边恢复及永久 dismissed 已接工具/命令路径；Jev off 仍可显式取代，agent 永不取代 user。
- **I1 已装配**：task-done/push/release 的 Jev 事件信号、turn_end 消费，以及 render 预算/索引溢出信号已接生产；复用既有 handler，不新增唤醒。详见文末「#36 I1 事件与预算装配」的保守识别、合并、重试与生命周期边界；后台 bash job 终态关联仍未接生产，复杂 shell 不推断成功。
- **C3 已装配**：迁移后首次 user↔user review 由 `createFirstUserReviewHost` 在自然 startup 或真实治理事件的 turn_end 机会驱动；只写建议，不自动取代，完成后交由 C5 markers 持久化。下节保留核心/host 的预算与提交协议，不再将它描述为未装配。
- **默认值已翻转**：`memory.layout=blocks`、`memory.migrate.auto=true`（见文末 F1）。真实数据迁移仍须按 [migration-runbook](migration-runbook.md) 暂停、备份、预演和核验，不能用源码门禁替代真实数据批准流程。

### P7 行为核对的当前结论

- 迁移后 reload 提醒已由 C5 接入独立代际标记（下节），不再由 sweep 重复显示。
- **C4 已消除治理子集限制**（`fc3230d2` / `6ae35450`）：blocks `/mem review` 合并现有侧车建议（包括非治理类型）与即时治理建议；`/mem expired` 独立展示 active 块的 expires/until、区分权威。两者均为只读，`--run` 不启动整理；详见文末「`/mem review` 与 `/mem expired` 只读展示」。历史 P5a/P7 交接中关于“仅 review-lite 子集”的描述已不代表当前状态。
- **删除恢复与归档/取代恢复分开**：`restore --block` 用于归档或已取代的块；已删除块在 `blocks/.trash/`，`restore --trash` 自 `e0993f03` 起按磁盘实际布局分派（blocks 读 `blocks/.trash`、files 读根 `.trash`，互不混合；恢复走块存储入口，保留锁/写入门/rev 复核与同名冲突拒绝）。真实 command 链路（create→delete→列出→按 id 恢复→校验正文/rev）由 `tests/memory/blocks/trash-command.test.ts` 覆盖。

P5a 核心证据：`tests/memory/govern/{sweep-plan,sweep,supersede,review-lite}.test.ts`、`tests/integration/memory-blocks-{governance,supersede-race}.test.ts`；相邻门禁包含工具 v3/Jev、命令/restore、pi-free、activate-trace 与既有 memory golden。

### #36 C5 治理标记与迁移 reload 提醒（2026-11-08）

`govern/markers.ts` 是 `blocks/.jev/governance-markers.json` 的唯一读写 owner，v1 只保留当前已提交
`source:migrate` 的 `(gen, runId)`。读取分为 current / missing / different-generation / invalid /
unavailable；缺失合法、旧代际不抑制新迁移，坏 JSON/版本/字段/超 64KiB/symlink/非正规文件整份拒收，
不视为完成、不覆写，并按 owner 最多一次诊断。`.layout.json` 只读，Jev index/review/report 不扩字段。

- `read()` 返回目录身份、迁移 identity 与原文件 revision；`writeFirstUserReview(snapshot, marker)`
  在原目录锁内重新读取、CAS 并合并另一 marker。它只是存储端口，**不是 C3 首检 host 或完成证明**；
  调用方必须先证明整个有界 pass 的结果/建议提交成功。未知策略和越界计数拒写。
- `deliverReloadReminder(syncNotify)` 在同一短锁内复核身份/代际/已送达状态，先同步通知再原子写 delivered。
  `.jev` 仅在已有合法 blocks 下按 gate 创建；0600 临时文件 + rename，失败清理本次 temp，不动坏用户文件。
  并发 startup 锁内复查；普通写端口陈旧 revision 拒绝覆盖。无 module-scope 状态/新计时器/模型或消息回合。
- `wireMemory` 复用 startup 的发现已迁移目录及迁移完成机会，独立于 Jev/governance enabled；按实际
  blocks 目录而非配置的 renderer 布局准入，不改变 migration/sweep 原有配置门。只在真实 UI notify
  端口存在且 `doctor.notifyOnStart` 允许时准入。无 UI/端口、notify 抛错/返回 Promise、锁忙、
  gate/abort/epoch 失效、落盘失败均不消费；notify 后再次取消检查。正文、预算及同代际 resume/reload
  不重发，新迁移可重发。sweep 不再发此提醒，doctor 的原 notifiedSessions 语义不改。
- 通知成功而持久失败时下次自然机会允许再提醒；已经 rename 成功的标记不因之后 abort 撤销。
  这是可重试语义，不承诺跨 UI/文件系统 exactly-once 或多文件事务；同步 I/O 不能被 JS 抢占，
  no-follow/身份复核也不宣称抵御同 uid 恶意进程在任意 syscall 间替换路径。

证据：`tests/memory/govern/{markers,markers-wire}.test.ts`（真实临时文件系统 + 实际 wireMemory 接线）及
`tests/integration/memory-blocks-governance.test.ts`（sweep 移交无两条）。C5 owner 本身不启动 C3、不消费 I1 事件；这些生产调用由 I1 装配承担，见文末。历史 C5 单包未改变默认值或任何 golden。

### #36 C3 首次 user↔user 有界 review（核心与 host 已装配）

`govern/review-lite.ts::firstUserReviewPass` 是结构化核心：逐块扫描 project blocks，仅保留按 ID 排序前 32 个 active、非 private/secret/residue 的 user；完整合格集合按 ID 顺序以 `(id, rev, authority, status, private)` 和 `bounded-neighbours-v1` 做 SHA-256。按距离 1、2 取对（最多 61），在 judge 前剔除已 dismiss；judge 只收到本地 ID 与 `redactForJev(entry)` 摘录。锁内复核双方 live rev/authority/status/privacy/dismiss，重扫完整指纹后才合并建议；缺失、重复、未知/非法答案、CAS 丢弃、锁/写失败都不返回完整。新 core 沿用常规 Jev relation 的 0.75 建议阈值；低置信答案仍计入完整。数字接口改名 `firstUserReviewCount`，保留新增建议计数与旧阈值，但**不是完整兼容旧语义**：严格要求所有计划 pair 的答案齐全，缺答案即不完整并抛错，不返回部分新增计数。调用方需显式迁移名称。

`jev/first-user-review.ts::createFirstUserReviewHost` 独立持有在飞状态，先验证迁移 markers、owner、gate、Jev、主会话及 registry；向现有 client 仅发批内 alias、两边≤400 code point 的脱敏摘录及固定 bool conflict 问句。每批≤16、最多 4 批、同时受现有 token/client 配额约束；跨批失败或取消保留已验证答案数，并报告已尝试批次数、已申请预算、已耗墙钟及 client 已报告费用（失败调用的未知费用不猜测）。6000ms 总期限贯穿扫描、请求和提交，超时或取消撤销提交权，已有建议不回滚。所有结果及建议提交成功后才请求 markers owner 写完成；marker 写失败允许未来自然机会重试。同步文件系统调用无法在单次 syscall 内被 JS 抢占，不声称跨建议和 marker 的事务性。

核心/host 自身不注册 hook、不主动续跑；生产 I1 装配复用已有 startup 和真实治理事件的 turn_end 自然机会调用 `run()`，不在 render 或空转 turn_end 重试。`wireMemory` 提供当前 registry/client、主会话标记、gate、owner/session epoch 的 `isCurrent` 与生命周期 signal，并在取消/shutdown/reload 撤权或 dispose。完成标记由 C5 owner 持久化；详见文末 I1 装配节。历史 C3 单包的“未装配”结论已被该生产接线覆盖，但上述同步 I/O 与非事务性限界不变。

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
  Web scoped read routes 沿用原通路；除下述 #65 可选端口明确支持的 session add 外，write routes 在 transport policy 前于 override 强制 deny，completion
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
- **leaf hint 缺失时的兼容性（2026-11-08 默认开启回归修复）**：owner 只把 `manager.getLeafId` 当作可选的 fold-cache hint；裁剪宿主未提供该方法时，仍读取真实 manager 的 branch/sid/file。leaf 未知时 store 不复用缓存（同长度 branch 也重新折叠），不能把 `noleaf:length` 当稳定身份。真实 sid/branch 异常、owner 变化或非法 seed 仍拒绝捕获，不降级为空继承。该缺陷曾使 workflow `agent()` 在捕获时提前 `script_error`，因此尚未到 deadline 就终结而无 grace 通知；不涉及预算或通知策略变更。

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

### #39 默认开启后的宿主能力边界（2026-11-08）

- `owner.ts` / `wire.ts` 在构造 owner、解析 Hub paths、创建 poison/授权状态之前检查实际 manager：
  `sessionManager` 缺失，或 `getSessionId` / `getSessionFile` / `getBranch` 不是方法时，返回
  `undefined`、不发布 group/runtime/store。Stack 因没有 session port 而不安装 parent/workflow
  捕获端口；不是伪造 `state:empty`、不是要求上游 try/catch，也不会阻断其他 session hooks。
  `getSessionFile()` **存在且返回 undefined** 是合法 memory-only 会话，不等同于方法缺失。
  `getLeafId` 仍只是可选缓存提示，不是准入能力。
- 仅“能力缺失”可以 effective-off：存在的方法/访问器抛错、非法 sid/file、已绑定 owner 的
  sid/file/manager/epoch/tree 变化都不允许变成空继承。旧 owner 在能力丢失时被撤销，已持有旧
  捕获端口的调用仍拒绝；新完整上下文可建立新 owner，不能复活旧授权。
  例外（既有行为，本包未收紧）：`wire.ts` 的 `context()` 刷新路径整体 `catch`，能力探测之后的真实
  getter 异常也会降级为 dispose + effective-off，而不是上抛；严谨性要求落在 `open()`/捕获/seed
  路径上（那三处没有兜底 catch）。
- `session-store.snapshot()` 在未锁定/未关闭时读取真实 branch（绕过 fold 缓存），前后复核
  owner/实际 manager/sid/file；branch 必须为数组，坏 scoped entry（fold 的 dropped）和非法
  seed（包括编号耗尽）拒绝捕获。合法空 branch 才返回 `state:empty`；locked/off 维持零 branch
  读取的旧契约。普通只读 view 的宽容折叠、持久化 poison/恢复协议不变。
- 此兼容修复不兜底其他子系统的直接 manager 调用，也不放宽“每次返回随机 sid”的宿主夹具。
  独立的 launcher 版本夹具、Fast hook/identity 与 bundle 契约问题须单独归因；不得靠这里吞掉
  真实异常或关闭产品默认值使其假绿。
- **未绑定子会话的 project 注入（2026-11-08 release-blocker 回归修复）**：安装 scopes shell
  不等于已经建立实际 owner/group。独立 `PiSessionDriver` 未收到 `memoryBinding` 时，不发送
  `subagent:memory-bind`；此时三层投影 effective-off，`pi_project_memory` 仍走原只读 renderer，
  不依赖 session/Hub owner，也不从普通 ctx 伪造 child binding。已建立但被撤销的 group 不走
  此回退，仍由原 owner 校验 fail closed。project 的 `injectInChildSessions`/`childProfile`
  开关、scopes-on child 的内容硬只读及 scoped 授权门均不变。真实 driver + SDK 回归用例
  `tests/integration/child-session-marker.test.ts` 同时断言快照只有 `pi_project_memory`、包含
  临时 core 正文，且实际模型请求收到该正文。源码验证用 `PI_TOOLKIT_ENTRY=src`；若仓库已有
  `dist/bundle`，须先 rebuild 再跑默认入口，避免旧 bundle 掩盖源码修复。

### Hub authority 参数确认陷阱修复（v0.11.0 hotfix）

`scoped_memory` 的 `authority` 仅决定 session 写入的权限，hub 作用域忽略该参数（无论 `agent`、`user` 或省略），hub 写入和删除仍必须经过原文确认与一次性 opCap；TUI 和 Web 的确认入口均可到达。此前 hub 对任何显式 authority 在弹框前返回 `E_AUTHORITY`，而 view 又返回 user authority，诱导模型传参后导致无法确认。

### Web 命令只读函数（A2d，已接生产）

`command-readonly.ts` 提供不依赖 command ctx 的 `executeMemoryRead`：支持空参数、`list`、`path`、精确 `restore --trash` 列表及单目录 `migrate --dry-run`/`--report`；裸 `restore`、旧备份 ID 与 `restore --legacy` 经最终错误出口返回带安全手工恢复步骤和 runbook 链接的 `E_MEM_WEB_UNSUPPORTED`，不是成功列表。其余输入也返回 `E_MEM_WEB_UNSUPPORTED`。缺目录的迁移预览拒绝，报告读取失败抛错。仅 plain domain 且 memory 已启用时，宿主把该只读函数引用注入 Web bridge；经过 command handler 的 ledger 与宿主 idle/pending、手动 compact 和 session switch 准入后同步直调，cwd 来自当前宿主 ctx，不进入 SDK slash/capture/native handler。缺端口、抛错、飞书来源及不支持的命令均拒绝，写命令始终拒绝；显式 Web 命令策略 deny/confirm 仍生效。默认 history 模式下同步只读输出直接展示，不依赖 transcript record。输出暂不包含 native 列表的 doctor/Jev 尾注。该函数本身不认证调用者，函数引用只提供只读通道，并非方案中的逐次 MemoryWebCall/owner/lease 证明，不得用于开放写入。测试覆盖真实临时目录及 hub socket 返回；完整 session-add 写确认、终态和生命周期现由上文 #65 独立可选端口承担，不改变这个只读函数。

### Web session add consumer（B1 第 1 包；包4 现已装配）

`scopes/session-store.ts` 在现有有界 FIFO 中提供 `prepareWebAdd` / `ownsWebPlan` /
`enqueueConfirmedCommand` / `cancelWeb` / `releaseWeb`；确认等待在 FIFO 外。仅同 store 注册的
冻结计划、同 kernel 有 binding 的 call 和 reserved receipt 可进入提交；最后同步重读 branch、
重算 planner/entry、检查文件及 gate 后 consume，恰一次 SDK append，观察真实 fold。异常或
结果不符在 attempt 后为 unknown 并 poison，不重试。append 若返回 thenable，安装 rejection
observer 但不等待、不改 unknown 结果；这不能撤回已开始的 effect。Web hash 唯一使用
`session-memory-fold/v1`：保留有序完整 item/rev、nextN、opsSinceSnap、dropped，唯独剔除
fold 外层派生 inherited；不改变 native 继承规则。`session-web-file.ts` 只读观察整个 JSONL，
8MiB 字节硬界；每段 100ms 是单调时钟协作预算，无法抢占同步 syscall。文件身份/字节 guard
不是跨进程原子 CAS；SDK 可缓冲，appended 不代表已 flush/fsync。取消时保留已同步观察，
最终观察由控制器复制后 release。第 1 包交付时没有控制器/远程入口；包4 现已通过上文的
同 owner lazy controller 与生产 facade 接入，仍只支持 session add，其余写保持拒绝。

## Migration metadata byte limits

The block migration planner truncates copied `title`, `when`, `section`, `heading`, and `until` at UTF-8 code point boundaries, reserving three bytes for `…`. Nonempty `metaTruncated` report entries contain the block id, field, original and truncated values; the same report is exposed by dry-run and persisted with migration. No entry is emitted when no field is truncated, retaining the existing report shape. Block corpus and Jev entry reads truncate over-limit fields in memory only; legacy frontmatter is similarly normalized for files-layout rendering and blocks-layout root scans. Tiered reading accepts legacy `when` as a fallback only when `read_when` is absent. Missing/invalid block kind or name retains the existing stray behavior; length softening never makes it a valid block. Raw revisions and source files remain unchanged and write serialization remains strict.

Soft-diagnostic contract: **startup never emits soft-metadata warnings; `/mem doctor` displays them on demand**. `soft-meta.ts` keeps a bounded (4096) process-global, reload-safe set keyed by SHA-256 of directory + field + original value; raw values are never retained. `/mem doctor` exposes one `E_META_SOFT` line per distinct observed key with the field, original UTF-8 byte count and limit, without the original value or any diagnostic disk write. Legacy `when` read normalization serializes as a JSON string and the consuming `parseMemoryMeta(..., { legacyWhen: true })` uses the same JSON scalar decoder, then enforces the 70B limit on the final decoded value; the strict parser and `read_when` contract are unchanged. Diagnostics are observational, not persistent: entries disappear on restart or capacity eviction and may remain visible after source edits until then. Existing `E_SECTION_TOO_LARGE` per-block doctor findings remain for compatibility. This is not a proof that all possible sources of a historical `E_META` notification have been identified.

### Session Web exact file observation primitives

`safe-fs.ts` is the sole runtime fs import under memory. Its internal-only
`*SessionObservation*` primitives preserve raw errno and the exact no-follow,
non-blocking, bigint-stat and chunked-read semantics needed by
`scopes/session-web-file.ts`; they do not independently validate file type or
identity. The caller performs those checks and retains the 8 MiB limit. Closing
is raw `closeSync`, not idempotent; a second close propagates `EBADF`.

### `/mem review` 与 `/mem expired` 只读展示

这两个命令只列出结果，不运行 sweep、分类器或交互式写入；`--run` 也只显示现有建议。blocks 的 review 合并现有侧车建议和 `planSweep` 的瞬时治理建议，并沿用 review-lite 的锚点有效性检查；非治理类型同样可见。expired 独立列出 active 块的过期 `expires` 和所有 `until` 条件，按权威标识；同一块可占两行。已取代或归档的块不参与。files 布局使用现有条目和建议索引；未启用建议索引时明确提示不可用。日期判定仍沿用既有规则，until 不是日期到期断言。

### #36 I1 事件与预算装配（2026-11-08）

生产路径复用 Jev 现有 `tool_call` / `tool_result` / `turn_end` 和 memory 既有 startup、write、shutdown；不新增 hook 或主动唤醒。`govern/signals.ts` 是每个目录/session epoch 的唯一候选、事件 pending 与预算 key owner：关联表最多 128 项，只留输入指纹而不留命令原文；task 完成要求先前状态快照、仅改 status 的请求和匹配的结构化成功结果；bash 只接受保守的单条字面 push/release 命令及可信结构化零退出码，后台 job、复杂 shell 和未知终态跳过。turn_end 合并 detach，优先级 budget > release > push > task-done。Jev off 不注册 turn_end，预算只在既有 startup/write 机会消费。

预算观察按独立 key 去重；同 key 成功后不因后续外部机会重跑，失败及 sweep-origin 的新观察可在下一外部机会重试，不在渲染或空 turn 中自旋。单次在飞 sweep 最多执行一个合并尾随 pass；每个被接纳批次获取其实际 pass 的结果，尾随执行中到达的新请求返回 `not-executed`，预算与事件转为 dormant，不能借旧 pass 的成功结算，也不会自动递归 drain。`sweep.ts` 仅为 signals owner 已准入的预算观察绕过普通 corpus 去抖，预算 key 不写入 `sweepCorpusFp`。自动路径按 canonical memory/blocks 目录与迁移身份、主会话 epoch、memory/governance 开关、abort 和 `MemoryWriteGate` 准入；额外 epoch gate 在写入前复核目录身份。身份变化、shutdown/reload 或 abort 撤销旧候选和在飞提交权；abort 撤权先于 registry 检查，registry 暂不可用也不能阻止撤权。自动路径不创建缺失的 memory/blocks。迁移首次 user review 仅在自然 startup 或真实治理事件的 turn_end 启动；空 turn 不重试，完成标记仍由 `markers.ts` 持久化。secure 域遵循 Jev 强制关闭并走预算 Jev-off 分支；locked 与 child 不执行新增自动治理。同步 filesystem 调用不能在单个 syscall 中抢占；后台 bash 终态关联尚未接生产，无可信关联的后台 job 终态不会被推断成功，复杂 shell 保守不支持。

## #36 F1 默认布局翻转（2026-11-09）

`memory.layout` 默认 `blocks`；`memory.migrate.auto` 仍默认 true。主会话启动时只对当前 cwd 的 files 目录、且写入闸门通过时惰性迁移；旧文件保留。`/mem migrate --status` 查看配置和磁盘状态，`/mem doctor` 查看诊断；`/mem migrate --rollback` 后 `/reload`，回退保留 blocks 快照，迁移后新增内容需人工核对。G2 正式 PASS，G1 仍长期 BLOCKED 且其风险已由用户显式接受；自动取代误判率没有 G1 数据背书。

注入（普通、scoped、外部 agent、pointer）与 files doctor 统一使用 `effectiveLayout`：blocks 配置加 files 格式时回退 tiered，blocks 目录优先于显式 tiered/legacy；迁移准入本身仍按配置和安全门执行。

## Scoped memory failure guidance

`scopes/error-messages.ts` provides an exhaustive, pi-free `Record<ScopedMemoryErrorCode, string>`.
The tool and native scoped command add `message` to failure results at their boundaries, preserving
`code`, other fields and any more specific message. Hub management retains its existing specific
error detail alongside the general guidance. This changes no authorization or persistence rules:
Hub operations still use user authority and require the existing approval path; an explicitly supplied
`authority: agent` is ignored for Hub, not independently rejected. A create request must omit `id` and
`rev`, including empty strings.

## Unified tool · phase 1 (historical internal-routing baseline)

`wireMemory` creates one activation-local `unified/dispatcher.ts` instance. The registered blocks/v3
`memory` execute port passes through the project adapter without changing its arguments, text/usage
result or thrown error. `toolSurfaceFor` and the v2/legacy factory branches remain unchanged; neither
schema publishes `scope`, `all` or v4. `wireMemoryScopes.attachDispatcher` supplies the same dispatcher
to the already-registered scoped facade; each execute resolves `wiring.current()?.tool` anew, never
caching an owner across calls or approvals. Factory-only scoped callers use the same stateless
`dispatchScopedMemory` function, not a second implementation or dispatcher instance.

The old `scopes/tool.ts` implementation is split without changing its checks: dispatcher-side shape
validation → child authority → unknown fields → storageScope → read gate → string fields/authority/
body/from/topic → op/hub state/rev checks. Session and Hub adapters only forward to the shared
`scopes/tool-operations.ts` view and original approval/enqueue path. `scopes/tool-surface.ts` holds the
unchanged read gate/projection and host port types; the old exports remain re-exported by `tool.ts`.
Failure messages still come from `scopes/error-messages.ts`, with the original `run` boundary applying
`withScopedMessage` once and preserving specific messages. No store/authorization/cap semantics,
paths, approval owners or registration hooks move into the dispatcher.

Scopes wiring owns a closure-local `closed` flag: shutdown/dispose prevent context, tree or child
binding from reopening an owner. A real main-session `session_start` re-enables owner construction;
ordinary calls with a fresh context cannot do so. Production-registration tests in
`tests/memory/scopes/dispatcher-lifecycle.test.ts` verify zero appends after either close path, then a
real start restoring writes in a new SessionManager while leaving the old branch unchanged.
`tests/memory/unified/wire.test.ts` additionally pins the production surfaces, error text, tree approval
abort, shutdown and actual layout predicates. `tests/boundary/pi-free.test.ts` scans the unified roots
and their shared operation/read ports, including transitive value imports.

## Unified tool · phase 2 core (factory delivery; production switch below)

`unified/index.ts` exports the pi-free v4 surface, closed `MemoryToolParamsV4`, normalizer, DTOs and
UTF-8 surface measurement. `createMemoryToolV4` takes host-owned `project.run/inspect` and a fresh
`currentScoped()` resolver; it creates no owner, approval, store, path resolver, timer or hook. This
core-only delivery did **not** change `wireMemory`'s actual registration decision or any existing fixture.
The assembly below selects v4 only when the actual `toolSurfaceFor` result is v3,
and continues using the phase-1 scoped-registration and effective child-settings predicates.

- Public params require `command`; `scope` alone defaults to project. `op/storageScope` are not
  published. Internal alias normalization is opt-in, refuses either mixed field pair even when
  values agree, and never gives a legacy call the default-project fallback. The old alias itself
  still runs its original validation/gate sequence, not the new normalizer.
- All command/field preflight completes before any port resolves. `all` accepts only view with
  command/scope or search with command/scope/nonempty query. Every write and forbidden field is
  rejected without dispatch, storage or approval. Whitespace-only queries are rejected; accepted
  scoped queries are otherwise used literally, without trimming/tokenizing/regex interpretation.
- The scoped factory exposes `inspect` and undecorated `dispatch` ports alongside the original
  `run`. v4 writes call `dispatch`, reusing the phase-1 operation path and the sole approval/enqueue
  implementation. Only alias `run/execute` can add deprecation metadata. Scoped reads/search use
  current visible bodies, case-insensitive substring matching, lexicographic id order and a cap
  of 50 per scope. Entries preserve full nested items and current revisions.
- `createProjectInspectorV4` (in tool-v3.ts, outside the pi-free root) reuses the original listing
  renderer and project search, with an optional `readCorpus` error observer which runs before
  the old fallback. Corpus read failures are reported as poisoned. Absent is a successful empty
  group. Before a blocks corpus exists, the original v3 no-blocks listing (including the files
  migration hint) is retained with absent status. No observer is passed by legacy callers: their
  fallback/text/errors are unchanged.
- Aggregation always reports project/session/hub statuses; only ok/empty/absent retain a group.
  All other states omit the entire group and set partial. Status objects contain diagnostics only,
  never item/id/rev/grant fields. A session view's poisoned bit is persistence poison; a throwing
  getter is error/E_INTERNAL with originalMessage. Child Hub and disabled scopes never resolve
  their read ports. Assembly must not pre-collapse getter exceptions into an absent owner before
  the inspector can observe them (the old `wiring.current()` owner filter is not a diagnostic port).
- Only v4 maps project exceptions: the eleven declared project codes retain their code, normalized
  message and complete originalCode/originalMessage. This includes explicitly typed inline validation
  `E_META_INVALID` (0.12 contract update below); it is not inferred from refusal text. Other prefixed
  MemoryErrors become E_INTERNAL with originalCode; unclassified unprefixed MemoryErrors and ordinary
  Errors remain E_INTERNAL with the complete originalMessage. The old project factory/dispatcher
  continues throwing the same exception, including its original message.
- `createScopedMemoryTool` optionally takes a host-only `v4Registration()` returning active and
  registered. Both must be true, and the call must pass the unchanged old schema, before appending
  `{deprecation:{replacement:{tool:"memory",params}}}`. Success view replacements keep only
  command/scope/id, dropping fields the old view ignored (e.g. session topic, forbidden in v4).
  Other calls rename op/storageScope and retain the remaining fields, including actual rev.
  The assembly caller is responsible for asserting these flags only for a registered blocks v4.

Core tests live in `tests/memory/unified/v4-*.test.ts`; production tests now live in `wire.test.ts`.
They cover full aggregate JSON, real temporary SessionManager and Hub writes through production
approval/store kernels, executable replacements and the exact description+snippet+joined-guidelines+
JSON-schema UTF-8 budget formula. Existing v3, alias, off-golden and phase-1 wire tests remain the
inactive-path differential baseline; no old text or schema was shortened to meet the new budget.

## Unified tool · phase 2 production registration (2026-11-09)

- `wireMemory` computes the actual `toolSurfaceFor(settings, activationFormat, secureLocked)` result once. Only
  `v3` **and** memory enabled **and** plain main or child session selects `createMemoryToolV4`, through the single
  activation-local dispatcher. Returned `v2` or `legacy` always keeps the old factory. Thus held normally
  stays v2; files+auto can return v3 and publish v4; secureLocked files stays v2. No config-label or directory-name
  shortcut exists. Disabled-memory and secure/locked direct callers retain the old project factory even
  if the selector returns v3. Plain child sessions also publish v4; readonly and authority gates do not change:
  scopes-on forces the effective allowWriteInChildSessions=false and the denying project gate; scopes-off
  retains the original write opt-in. Scopes registration remains `wiringExists && (!child || scopes.session)`.
- The v4 project port runs the original v3 operations and uses `createProjectInspectorV4` with the same deps
  for read-only aggregate/search inspection. The scoped v4 resolver takes `scopes.group()?.runtime()` on each
  call, never `scopes.current()?.tool`: the latter filters through the owner's catch-and-false identity check.
  The owner exposes a read-only `inspect` using the unchanged read inspector with a diagnostic capability
  that does **not** swallow `getSessionFile/getSessionId` exceptions. Session `view` still distinguishes
  observed poison from getter failures; `getBranch/getLeafId/getSessionFile` errors reach error/E_INTERNAL,
  retain originalMessage and omit the failed group. Legacy capability/read/write gates remain unchanged.
  v4 writes use `runtime.tool.dispatch`, never alias `run`, and share the existing owner/approval/enqueue path.
- After successful `pi.registerTool`, `v4Registered` becomes true. Alias execution passes
  `v4Registration: () => ({ active, registered })` to `dispatchScopedMemory`; only both true, old-schema-valid
  calls with `result.ok === true` receive a replacement. Failures, v2/files and secure/locked paths do
  not. No schema/description change is made to scoped_memory and no new hook/owner/store is created.
- `memory-tool-surface.json` declares only complete canonical `blocksUnified`, `blocksUnifiedJev`,
  `blocksUnifiedChild` variants plus their `bytes.*` counters: **2231B / 2315B / 2295B**, measured with the
  existing description+snippet+newline-joined-guidelines+JSON-schema UTF-8 formula. All preexisting keys
  remain exact, pinned by canonical comparisons, fixed byte counters and pre-v4 per-key SHA-256 assertions.
  `scoped-memory-tool-surface.json` is registered as a B-level golden, unchanged; Agent nested golden stays
  unchanged. v4's single boundary sentence identifies scoped_memory as the session/Hub compatibility alias;
  its existing first sentence already fixes that alias's boundary. Scope-selection strategy lives only in
  `skills/memory-jev/SKILL.md`, including Hub capacity and human-turn invalidation by background notifications.
- Production tests execute both registered approval entrypoints through tree abort and shutdown, real v4
  session writes, executable alias view replacement, failed-alias no-replacement, the actual surface selector
  matrix, raw-getter diagnostics, and real tiered/files session+Hub create/view/update/delete with precise
  approval. Existing factory v3 tests remain the old operation/throwing-error baseline; the production Jev
  test now expects v4 but still proves real tagging, g1, sidecar and supersede behavior. Child production tests
  pin all four scopes-on/off × allow-true/false project CRUD cells (including the real effective settings),
  authority-before-unknown-field validation in both tools, Hub group omission with diagnostics-only status and
  zero Hub reads, and close/tree registration/write behavior. The actual registered child surface is compared
  to all four canonical blocksUnifiedChild fields in tool-surface.test.ts, never the Agent golden.

### 0.12 inline authority guidance and validation contract (2026-11-11)

This is an approved outward description/error-contract change, not a parser or authority-policy change.
The actual v4 Jev main/child descriptions now show first-line `user|lesson` syntax and an executable
`<!-- mem user -->` example. `authority: user` is stored frontmatter, not an inline key; project still
rejects top-level `authority`, and inline `authority=` remains invalid (no new alias). The skill keeps
selection/authority strategy and defers input spelling to the current tool's concrete examples.

The B-level tool-surface fixture only adds complete `blocksUnifiedJevInlineAuthority` (2625B) and
`blocksUnifiedChildJevInlineAuthority` (2689B) variants and their `bytes.*` counters. Production
`wireMemory` selects these through `memoryV4Surface({jev:true})`, including child sessions; the old
`blocksUnifiedJev` key is retained byte-for-byte as a historical contract, not republished. Non-Jev,
v2/legacy and scoped alias descriptions/schemas remain unchanged. Per-key SHA-256 assertions cover
**all** pre-fix keys and counters; registration tests cover main/child × Jev on/off × blocks/v2/legacy.

V3 create/update attach `MemoryError.code = E_META_INVALID` only to parser-reported inline syntax
refusals and the existing Jev `checkInline` validation refusal. Their original exception messages stay
unchanged; v4 preserves this typed code with safe normalized message `invalid project memory inline
metadata` and originalCode/originalMessage. The existing prefixed-code mapping and all other unclassified
E_INTERNAL fallbacks are unchanged; no error-text heuristic classifies metadata. Rejection remains before
the directory lock/bootstrap/store commit, with zero partial block or afterWrite callback. Tests use own
temporary stores, prove unchanged snapshots for create and update, and exercise the real Jev guard's
non-first-line refusal without classifier calls. Scope/child/approval gates and user-rule changes are not
relaxed or automated. Source tests do not prove deployment into an existing session.

## #50 P50.1 增量触发与聚合（2026-11-09，fail-closed 交付）

设计：[p50-design.md](../memory-governance/p50-design.md) §2/3/7。`govern/incremental.ts`
是每 session 的唯一调度闭包，按 canonical memDir 的 `(realpath,dev,ino,sessionEpoch)` 聚合，
实现 idle / quiet-wait / idle-wait / running / cooldown / stopped。计数或成功 TaskUpdate completed
只赋予资格；quiet 与 host-idle 两处都检查资格，task-done 不跳 quiet、实时空闲或 cooldown。
新外部写重置 quiet；running 只合并一个 trailing 批，settle 才起算 cooldown；cooldown-elapsed
在 cooldown/quiet-wait/idle-wait 均有真实释放路径。cap 保留一份证据并 dormant，无 timer 重试；
abort/shutdown/reload 撤销 signal，旧 epoch/身份不复活，迟到结果只允许有界诊断。

- **设置与 off**：新增且仅新增 `memory.incremental.{enabled,changeThreshold,quietSec,idleSec,cooldownSec,taskDoneTrigger}`，
  默认 `false / 5 / 15 / 2 / 300 / true`（公开时长单位为秒），均非 live；运行时时长分别为
  15000 / 2000 / 300000 毫秒。旧 `*Ms` 配置仍按毫秒读取，秒键优先；非整秒旧值保留精度，显式设置或重置对应秒键时移除旧键。
  有效时长经 `clampSpanMs`（最长一年）；唯一 timer 使用已有 segmented/unref systemClock，长等待不溢出。
  P50 off 不接 activity recorder，不改变现有 client/classify/工具回显；设置 corpus 只投影并显式断言新增块，
  原 corpus 不重生；setting-specs pin 仅追加六键和逐键原因，所有旧键 hash/顺序保留。
- **origin 唯一谓词**：`govern/write-origin.ts::isExternalWriteOrigin` 由 index 与 sweep 共用。
  `sweep/revision/p50-auto` 只失效渲染/缓存，不入 sweep/P50；undefined、external 与其它值均为外部。
  internal memory 写仍可记录 activity，但不增加计数或重置 quiet。
- **候选非授权**：`incremental-corpus.ts` 只读 project blocks，不用会做 soft-meta 修复/旧缓存回退的 reader。
  只选 active、本目录、非 private/secret/residue/origin/Hub 的块，按 ID 排序；输出 id/rev/topic/authority、
  corpus 指纹、变更次数与 omittedCount，不含正文。每 session 至多 8 目录、16 待处理候选；超额低优先级
  工作不加队列，只合并证据。批次只冻结候选元数据，**不是 §4.2 rawBefore 冻结点，也不是 §5 审计证据**；
  不创建 before/after/audit、不推断 data-applied/finalized。P50.2 必须在首请求前另行冻结精确字节/rev，
  提交与审计遵循 prepare → data-applied → finalized，不得拿 corpus fingerprint 冒充提交证明。
- **P50.2 seam**：`WireMemoryOpts.incrementalBatchHandler` 与 `incrementalAdmission` 是唯一注册点；
  缺 handler 为 revision-unavailable；批次预算准入必须先于 running/pending 消费/handler，缺 admission、抛错或拒绝均保留一次证据并 dormant，attempt 前仍独立复检。`IncrementalBatch` 包含选择键 batchId、
  目录身份/epoch、候选/指纹/计数、taskDoneEligible、lastExternalWriteAt 与 `{generation,lastActivityAt}` lease。
  `IncrementalAttemptContext` 提供 signal/isCurrent/leaseValid/tryStartGenerate/capReached。handler 每 await 后
  复核 isCurrent，自动提交前还须复核 lease；返回 cap-reached 后不得继续写建议。单批 generate 请求上限 2、
  auto 动作契约上限 2、jobCostCapUsd 默认 0；本包不调用模型，不执行 auto 动作。P50.2 仍须在唯一 JevClient
  实现 §7 的 bounded channel queue、provider attempt/费用预留、zombie 与真实费用对账，不能只靠此计数器。
- **窄 task-done**：只在既有 Jev governanceCandidate/governanceResult → govern/signals 的匹配成功
  TaskUpdate completed 回调置 eligible。失败/unchanged/未知 task/普通 Agent 或 bash 完成不扩大来源。

### Activity owner 已补齐与生产边界

唯一 owner 仍必须是 `web-hub/agent/human-dispatch-proof.ts::createHumanDispatchProof` 的原闭包，
`govern/activity.ts` 只定义 snapshot/optional subscribe/recorder 类型，**没有第二套活动状态**。
`scopes/wire.ts::activity()` 仅转发 `current()?.proof.activity`；`8fa58ede` 已为同一 proof owner
补齐 activity，且该单文件窄补丁已独立验收。完整生产 incremental handler/admission 与 revision
binding 仍未接通；activity 可用不代表 P50 已能生成、提交或自动治理。本 B 集成不修改
`src/web-hub/agent/**`。

P50 只在 plain 主会话、memory/governance/incremental 开、至少一层 scopes 开且 current runtime/activity
存活时可用；其余 fail closed：P50 零 timer、零 client、零 revision 写。既有确定性 sweep/Jev traffic
不因此关闭，测试用 P50-off 对照证明相同 classifier 请求与既有 index 行为。无 owner 的诊断每 epoch
最多一次（无 UI 输出 console，UI 不新增弹窗/落盘）。timer 每次实时 snapshot，必须同时 running=false、
toolsInFlight=0、isIdle===true、pendingMessages===false 与连续 idle 窗口齐备，unknown 一律不运行。

订阅型 owner 每次自然更新通知后重算一次 timer。无 subscribe 的 owner 仍由 Jev 已有 tool_call/tool_result/
turn_end 唤醒，且每个自然事件最多附带一个 idleMs 后的实时检查（照顾 turn_end 早于 onSettled），
不会自重排忙宿主轮询。该回退粒度更粗：纯 onInput/onSettled 更新不能立即重排；若 onSettled 晚于那次
单次检查，只能等下个既有自然事件；实时门依然阻止旧 lease/忙宿主运行，绝不以猜测 idle 补齐。
Jev 临时缺 registry 时 tool activity recorder 仍先执行，不能漏掉长工具；不增加任何 hook 注册。

测试：`tests/memory/govern/incremental*.test.ts`（fake clock、真实临时 blocks、实际 wireMemory/wireJev），
覆盖 count=3 成对、§2.4 时间线、三条 cooldown 释放、origin 极性、scopes-off/no owner、长工具/unknown、
无 subscribe 两个既有唤醒与一次检查非轮询、生命周期/cap/epoch、长 timer 分段 unref。测试 fake owner
只是注入端口，**不能替代生产 proof activity 的独立窄验，也不证明完整 P50 生产接线已完成**。

增量时长公开键 `quietSec` / `idleSec` / `cooldownSec` 以秒计（默认 15 / 2 / 300）；运行时仍为毫秒。旧 JSON 的 `*Ms` 保持毫秒语义，秒键同时存在时优先；整秒旧值迁移为秒，非整秒旧值保留原键和值以免丢精度。设置编辑器接受整数秒。

## #50 P50.2 A+B：受控 client 内核与生成 seam（未启用生产）

Q1/Q2 已获用户批准；`p50-design.md` 中早期「Q1 待批」为历史状态，不是本包阻塞。
A（`c2b1b16e`）及本 B 包只交付 **host 显式 opt-in 的 client factory 能力**，不代表
P50.2/P50.3 产品闭环。现有 `wireJev` 没有传入 `p50`，没有生产 revision adapter/binding、
提案持久化、`commitAction`、审计或 revision 恢复，也没有自动提交或默认开启。
本节只追加交付边界；集成时须保留主树已有的 tidy 文档/代码变更。

### A：唯一预算与来源 owner（补 A 交付文档）

`createJevClient({...,p50:{enabled:true,transport?}})` 才切换 bounded classify 通道。
未传/false 时仍走原 `askInner/callOnce`：原无界 queue、timeout failover、calls/费用口径、
工具回显与 off golden 不变。启用但没有受控 classify transport 时，ask 不外发；不是把
普通 SDK classify 的可选字段假称为硬上限。stock pi 1.5 classify 没有可核输出 token cap，
因此 A/B **均未提供默认生产 controlled-classify adapter**。

A 的同一闭包拥有 `reserveClientAttempt`、sync=3/background=4 的原 semaphore、每通道 queue≤4、
`assertDispatchAdmission` 和 `dispatchProvider<T>`。calls 在真实 dispatch 计数；排队后/每次
failover 前复查 disposed/abort/zombie/费用；原 provider Promise 才解除 outstanding。
高层 timeout/abort 可以归还逻辑槽，但仍保留 zombie 并阻止两个通道的新请求。
unknown usage 先按 reserve，晚到有效 usage 只调整一次；actual 超预留如实入账并锁住后续准入，
不裁到 reserve。`usage().budget` 是同一账本的 settled/reserved/outstanding/zombies、costSource、
overReserved/adjustment/exhausted 观察，不是第二份账。费用只是单 client/activation 内的条件性
估算准入限制，不是跨进程、provider 超报或晚到 usage 的绝对金额保证。

### B：可执行 registry adapter、最后出站边界与共享校验

- `JevClientHandle.generateRevision` 与 `judgeRevisionCoverage` 在 **同一 client** 内走
  A 的 reservation → 原 semaphore → dispatchProvider → settle；没有第二 client/worker pool。
  `p50.revision` 指定 `transport/models/coverageModels`，各链最多 4 档，预留整条 failover 链。
  revision 缺省 `jobCostCapUsd=0`；报价、输入上界、正整数已核输出 token cap 或可用预算缺失
  一律 `revision-unavailable`，不借 1024B 本地正文门估算 token。named job 复用 A 的不可变 cap。
- `RevisionBlockInput` 是调用方本地冻结的准入证据：必须显式 private=false、secret=false、
  parseErrors=[]、active；再检查完整未截断正文 `looksSecret`，拒绝 Hub/residue/origin、坏 id/rev/
  authority/topic 与额外字段。rewrite 不带 context，merge 恰好两个块；不接完整 corpus/文件路径/
  frontmatter/会话/工具输出/关系概率。此 seam 不替调用方读取或冻结真实文件，也不证明同目录授权。
- `prepareRevisionOutbound` 在 **client 调用 adapter.prepare 的最终 payload 边界** 对双方正文及
  section 重新 `redactForJev(...,"entry")`，只交付深冻结的字段 allowlist；不信任上游 redacted 标志。
  原 privacy/parse 证据不进入 adapter。已准备的 dispatch 闭包只持有该 DTO，不在排队后重取原正文。
  entry 的既有 400 code-point 截断仍生效：generation 标 `inputComplete=false` 时只能作建议；
  coverage 若任一正文/section/candidate 经脱敏或截断改变，直接拒绝，不冒充完整原文已判定。
- `createRegistryRevisionTransport(bindings)` 是 **实际执行的受控 adapter 工厂**：按同一 registry
  引用与 requestChainId 绑定真实 model，恰一次 `registry.complete`，传 signal/maxTokens/
  maxRetries=0；最后 `onPayload` 强制已核 outputLimitField 并移除冲突 token-cap alias，避免
  model sampling 合并覆盖。原 Promise 交给 A 的 observer（包括迟到结果），不直接 fetch；
  SDK 的 requested-alias model 与默认零 usage **不能**当实际身份/已知费用，观察契约见下。
  binding 必须由宿主代码证明该版本 serializer 支持这个末跳、无隐藏重试、输出 cap 的语义及精确
  prompt+adapter overhead 的输入 token 上界/价目；`maxTokensEnforced:true` 是**可信宿主证明契约**，
  不是从设置或 SDK 方法存在性自动探测出来的事实。缺 binding/报价/能力时不可调用。
  A 的 classifier `FetchLike` 只有 JSON response，没有 chat streaming `Response.body`：本 B 包
  **不支持配置了 Jev proxy 的 revision**，非空 proxy 在 reservation 前拒绝，不静默直连，
  也不把窄 fetch 强转成 SDK streaming fetch。真正的 streaming proxy binding 留待后续。
- `govern/revision-output.ts::validateRevisionOutput(unknown)` 是唯一正文校验器：只收一个字符串，
  UTF-8≤1024B（不是 token 门）、规范化 CRLF/首尾空白后摘要；拒绝空、frontmatter、JSON/schema/
  操作 envelope、额外 content、tool/thinking 输出、控制符/非法 surrogate、秘密及占位符回填。
  client 成功返回前必经；后续提案保管/提交方必须复用同一函数，不得另写较宽校验。
  确定性机器操作格式（apply_patch、git/unified diff、YAML 列表映射/flow mapping、正文夹 JSON
  操作 envelope）在任意位置命中均拒绝**整个结果**，不剥包装/抽取正文。正常标题、列表和不含
  操作键的配置示例仍可通过；保守语法拒绝不是 Markdown 事实正确性或自然语言语义安全证明。
  B3 窄补：`delete: rules.001\nreason: obsolete` 及 delete/remove/rename 等 verb-as-key
  映射仅在值是明确 file-like scalar（块 id/路径）或结构化集合时拒绝，包含引号、列表与嵌入
  JSON/flow 形式；不因普通正文出现 delete/remove 或 `Delete: only after confirmation.` 而拒绝。

### Coverage / provenance 与仍需验证的生产能力

coverage 是独立 `registry.complete` 请求，只看冻结旧文本（可含 merge context）和候选正文，
不接 relation kind/p、生成自评或复用 cN；响应严格只有 verdict=complete/partial/unknown。
没有可信实际来源的 complete 降为 unknown。**即使 complete 也不是自动许可**：后续提案必须用
A 的 `independentCoverageSources`，将 relation/generation/coverage 三套 provenance 与独立从
冻结 DTO 计算的 request/input digest 绑定，检查实际 provider/model、canonical route/alias 分离。
revision provenance 分别保留 `requestedProvider/requestedModel`（SDK 请求身份）、
`provider/model`（经 raw stream 观察且与 SDK responseModel 复核的实际身份）和
`canonicalProvider/canonicalModel + routeIdentity/routeAliases`（与可信本地 route 相符时才发布）。
unknown 不从 requested id 或 canonical 倒推；无实际身份的 complete 降 unknown。
同实际 model、别名相交、同 route、缺来源/版本或 digest 不符都只建议；证明的是路由分离，
不是统计独立。`prepareRevisionOutbound`、`revisionTransportContext`、`revisionRequestDigests`
供后续调用方独立重算；不能把返回 provenance 自己复制一遍充当预期证据。

`beforeDigest/candidateDigest` 只绑定此次完整 body 文本；输出 digest 只绑定校验后的规范化正文，
都不冒充 rawBefore 文件快照、CAS/目录身份、审计屏障或提交观察。未知正文质量、权限、来源或
存储状态不得由此抬升为自动资格。未来生产装配仍须验证真实 SDK/provider 的 maxTokens 最末跳、
输入 tokenizer+格式开销/价目、禁重试、认证、后续 streaming proxy binding、实际返回身份（不是请求 alias 的回填）及 usage；
还须补提案 owner、冻结文件/目录门、异源证据保管、commit/audit/恢复、生命周期和 secure/child 门。

### B 返工：真实 SDK 观察与离线门（2026-11-10）

binding 可显式指定 `resultEvidence:"openai-completions"`，由 factory 的每 dispatch 闭包监听
pi 1.5 `onProviderStreamEvent`（在 SDK normalization 前），只留有界计数/型号，不存正文帧。
必须看到完整非负整数 prompt/completion/total 且 total 一致，cache counters 合法，并与 SDK
最终计数匹配、费用有限非负，stop/length 完整结束，才将 cost 交 A 作为 known。
missing/null/incomplete/malformed usage、error/aborted 或没有观察能力时一律 unknown → reserve；
SDK 初始化的 cost=0 不算证据；完整 usage 下的免费价目/显式零计数才可 known zero。
实际响应身份由一致 raw chunk model 与 bound provider/request id、SDK responseModel（仅不同
时存在）共同核对；缺失或矛盾都 untrusted，不能只看 SDK result.model 或补一个类型字段。
费用/身份的证据独立：费用未知不抹掉已核实际身份，也不反向证明身份。

factory 在原 Promise 上先注册一个只写 WeakMap 观察的 continuation，再把**同一个原 Promise**
交 A；费用 ledger、outstanding/zombie、settle/late adjustment 没有新 owner。late SDK aborted
结果仍按未知保留 reserve；原受控协议的迟到 known usage 正负 adjustment 回归仍在。
其它 host-controlled 非 SDK 协议可注入可信 `resultEvidence(result)`；它必须有独立的实际
身份/费用证据，不可把 SDK 默认 cost/model 照抄作为证明。省略时费用保守、来源 untrusted。
这不是 provider 自动识别器，也不是生产 binding；不能把该 callback 当模型自证字段。

本包门禁：新增 `tests/memory/jev/client-p50-sdk.test.ts` 正式执行 **真实 ModelRegistry.complete
→ ModelRuntime → openai-completions → OpenAI SDK → fakeFetch SSE**，只有 HTTP 被离线替换。
使用 own /tmp models/auth、synthetic key、禁止网络 refresh；实际序列化 payload 断言 cap=128、
冲突 sampling cap 被移除。报价 4096 input / 128 output、2/3 USD/M 的 reserve=0.008576；
同 job 仅够一 reserve 时，无 usage/坏 usage/error/incomplete stream 后第二调用零 dispatch。
另覆盖 known/free/explicit-zero、choice.usage、alias1/alias2 同 backend、合法异源正向、
实际成功 failover、无响应身份/冲突型号/canonical 不符的 fail-closed，以及 patch/YAML/夹 JSON
经完整 client 链的 invalid-output。不是 mock complete 手造 AssistantMessage；不验证真实
provider 执行 token cap、认证、网络/proxy 或 live 计费。新增 strict tsc 与原定向门一起运行。

原门禁 `tests/memory/jev/client-p50-generate.test.ts` 与
`tests/memory/govern/revision-output.test.ts`，另跑整个 `tests/memory/jev`、pi-free、tiers、
typecheck/build/格式。合法正文正例真实经过上述工厂 → local controlled registry →
可核 cap serializer → 原 Promise → client validator/账本；这个本地 byte-token 协议不发网络、
不代表真实生产 provider conformance；新增真实 SDK 离线门也不冒充 LIVE 验收。fixture 未改，未 install/push，未做 commitAction/audit。

### #50 C0：跨 C/D 契约与原始字节 reader（factory-only，未接线）

`jev/contracts.ts` 是 C/D 共享类型的唯一 owner：追加 `ReviewSuggestion.revision?`、
冻结输入、完整提案判别联合、证据绑定、审计/恢复结果与同步 `RevisionAuditPort`，并提供
C 工厂/恢复的 callable 类型（不是实现）。复用 B 的 `RevisionBlockInput`、`ClientProvenance`、
生成结果与 `JevUsage.budget`，不复制 validator/账本；后续 D 必须复用
`govern/revision-output.ts`。D 独享的 FreezeSpec/Deps/PlanInput/PrepareDeps/ReviewDeps 留在
D 模块内部定义，C0 **没有冻结这些内部参数的字段，也没有实现 §3.3 的函数**。

- `safe-fs.ts::readRegularBytes(dir,name,{maxBytes?})` 经 `openRegular` 的 no-follow/regular
  守卫与 nonblocking open，先检查文件长度再有界分配/分段读取、探测 EOF，并复核 fd 与路径的
  身份/长度/元数据。默认沿用现有 observation 的 64 MiB 硬界，显式上限只能收紧；D 仍须按
  块正文/元数据规则设置更紧上限。返回 `{bytes:Buffer,stat:RegularStat}`，超界拒绝而不截断。
  legacy `readRegular` 完全不变；reader 不解码，非法 UTF-8 的无损 round-trip/parse 拒绝留给 D。
- `readonly`/`Object.freeze` 不会冻结 Buffer 字节。冻结 owner 必须 ingress 复制并私有保管，
  每次对外读取再复制；C0 reader 返回的是调用方拥有的新 Buffer，不宣称实现了冻结保管。
  syscall 间身份/元数据检查也不宣称是对任意并发 writer 的原子文件快照。
- **root 技术澄清（沿用已批准语义，不新增产品授权）**：旧设计单一 rename 观察形状不能表达
  expected missing，故 `ApplyObservation.applied` 内按 `expectedAfter.kind` 区分：file 必须带真实
  digest/rev，proof 仅 rename-observed/link-observed；missing 禁止伪 digest/rev，proof 仅
  unlink-observed（目标 source unlink 已同步成功）。只 link 到 trash、随后 unlink 失败仍是
  unknown，绝不能当删除成功。C/E 后续只能凭真实 syscall 观察构造，不能由 proposal 推断。
  独立 C0 测试含编译期非法组合负例，须另行 strict tsc，不能把 vitest 擦除类型当作类型验收。

本包没有审计屏障、applier、commitAction、冻结/提案/review 实现、恢复命令、生产 binding 或设置
变更，未动 fixture。C0 独立验收后才能并行实施 C/D；不代表 P50 产品闭环已交付。

## #50 C/D 串行整合：raw 审计与 review 保管（factory-only，2026-11-10）

本节收口独立交付的 C `cf28c624` / D `26d0ae86`；上文 A+B/C0 的「尚无审计/提案实现」
是当时的历史边界，不再代表 factory 代码现状。**C/D 已实现但仍未接生产**：没有 E 的
统一 `commitAction` / 受控正文 applier，没有 F 的 `wireMemory/wireJev` revision binding、
restore slash、设置翻转或自动提交。`autoEligible` 始终只是提示，不是写权限。

### C：严格 raw-byte 屏障与恢复内核

`govern/revision-audit.ts::createRevisionAuditPort` 是同步 Locked 工厂，调用方必须持有同一
canonical memDir 锁；不另造账本/锁/模型通路。每动作保管在
`blocks/.jev/revisions/<batchId>/<actionId>/`，`before.md` 精确保留原 Buffer，
`audit.json` 绑定最终 proposalDigest、原 rev/raw SHA256、目录身份及双方证据；before/body digest
不可混用。目录 0700、文件 0600，no-follow/正规文件/uid/dev/ino/有界读取守卫；不收编或 chmod
已有宽权限路径。缺审计端口时 D 拒绝，不退回未审计 index。

- prepared 先保存 before 与最终提案证据，再完成文件和 action→batch→revisions→.jev→blocks→memory
  全目录屏障，才可返回 ok。匹配重放也重做证据文件 fsync 与完整目录链；合法 JSON/已有 marker
  不是上次 fsync 成功的证明。证据不一致/残缺拒绝，绝不覆盖旧快照。
- expected-after 只接受未来 E 提供的精确 Buffer/digest/rev 或 missing，不从 proposal/current 文件
  serialize 推导；finalize 只消费可信真实 syscall 观察。这些 seam **不是 E commitAction**。
  写后 gate/fsync/审计失败保留实际字节并报 effect-unknown，不补偿、不重试 applier。
- `scanPendingLocked` 只读分类，不把 proposed 的 expected-after 命中自动升级 committed。
  `restoreRevisionRaw` / `restoreRevisionRawLocked` 仅 committed、同目录同 id、raw SHA256+rev CAS，
  恢复原 Buffer 而不 bump version/规范化；持久 restore intent 阻止写后未知状态被盲重试。
  这些恢复 API 没有注册命令，也不以可丢弃 review index 授权恢复。

### D：冻结输入、真实 B 准备与唯一 review owner

`govern/revision.ts` 在真实锁中冻结原 Buffer/rev/目录身份，私有保管 Buffer 并通过 getter 返回
副本；DTO 仅含 allowlist，拒绝不能无损 UTF-8 round-trip、parse/权限/位置等不合格输入。模型阶段不占锁。
`prepareRevisionProposal` 只调用既有 A/B client，同一个预算/来源 owner；从冻结 DTO 独立重算
relation/generation/coverage bindings，复用唯一 `revision-output` validator。截断/partial/unknown/
同源/缺证据/lease 失效只建议，epoch 失效连建议也不写。完整提案 codec 严格拒绝未知字段、
半生成 bundle、坏 digest，非法 revision 整条丢弃，不剥 revision 后回退成 legacy 可执行建议。

`review-lite.ts::upsertRevisionSuggestion` 在同一个真实锁内重读 live rev/raw/身份/authority/status、
检查 epoch/dismiss/resolved，先调用 C prepared barrier，再经现有 `writeGovernIndexLocked` 写
review index；prepared 失败零 index 发布。index 失败可能留下 prepared 证据，但不动正文。
`index-store` 完整往返提案；稳定 key 为 `["revision",action,...sortedTargetContextIds]`，不含
rev/hash/batch，dismiss/resolved 不因改正文、新 rev/epoch/batch 或迟到结果复活。
revision 交互仅 open/keep/skip，展示冻结 rev/日期与 stale，不进入旧 extend/delete 分支。

### CD-01 闭合与证据身份

真实 B 在无法核验 actual identity 时合法返回 `trusted:false, provider:"", model:"",
routeIdentity:"unknown", routeAliases:[]`，保留 requested 身份作诊断但不回填 actual/canonical。
D 会保存完整生成 bundle 为 suggestion-only；原 C parser 要求 provider/model 非空，导致这条合法
提案在 prepared 被拒。现在 C 与 D provenance schema 对齐：只有 `trusted:false` 可接受空 actual
字段与 unknown route；`trusted:true` 仍要求非空 provider/model 和 64 位十六进制 route identity，
adapter/version/requestChainId、request/input digest、封闭字段等校验保持。**不伪造身份、不删
provenance、不提升 autoEligible**；翻 trusted、缺 provenance/digest、未知字段均拒绝读取。

联合证据：`tests/memory/govern/revision-cd.test.ts` 的 19 项测试运行真实临时 BOM/CRLF/非 ASCII/
旧 version 文件 → 真实锁内 freeze → 实际 B client + 受控离线 registry transport/预算 → D prepare
→ **真实 C** prepared 文件/目录屏障 → 真实 review index → 新 C/command 工厂及 fresh index 读取、
dismiss 后新 rev/batch/epoch 抑制。包含 trusted 异源正向、真实 B unknown suggestion-only、epoch/
变 rev 拒绝、prepared 写入/rename/目录同步/重放 fsync 故障零 index，精确 raw 与所有 provenance/
bindings/digest 往返。审计端口不 mock；仅在故障 case 注入底层 safe-fs 原语失败，顺序观察仍委托
真实原语。C/D 邻接加 SDK 离线门合计 22 文件 / 706 测试通过。

测试是本地 byte-token 协议的 synthetic actual identity/cost，不冒充 LIVE provider 验证；邻接
`client-p50-sdk.test.ts` 才是实际 SDK + 离线 HTTP 门。这里的「重启」是丢弃工厂/缓存后读真实磁盘，
不是进程 kill/掉电持久性实验。不执行 expected-after/finalize/E 正文 commit，不开启 F，fixtures
保持原字节。单次限 2 worker tier1 与 typecheck/build/format 的精确命令、结果及日志交接在
`/tmp/p50-cd-integration.json`；同步 syscall 不可抢占、任意同 uid writer 的跨 syscall 竞态、真实
生产 tokenizer/cap/认证/费用/proxy conformance 仍是后续门禁，不能据此宣称产品闭环上线。

## #50 E：唯一受控提交入口（factory-only，2026-11-10）

> 以下是 `6d292477` 初版 E 与安全返工的历史交付边界；后续自动 retire 的已实现 factory 能力见下一节。

`govern/revision-commit.ts` 导出唯一 `commitAction(memDir, request, deps)`；
`createRevisionCommitter` 仅将同一入口绑定到宿主私有端口，不注册 hook、tool、命令或设置。
上文 C/D 交付时的“没有 E”是历史状态；**F 生产 binding、默认/auto 开关、restore slash、
真实 B3 确认装配仍未做**。本包没有在 `wireMemory`/`wireJev` 接线，也没有新确认 UI。

- request 只有 origin/actionId/expectedRev/proposalDigest/signal，拒绝未知字段、accessor 和非字符串
  摘要，不接受可替换正文/日期/来源。宿主 `actionLocked` 提供 D 原工厂保管的 frozen input 与完整
  proposal；不能用反序列化对象冒充 D 私有 live guard。`runtime/isCurrent/leaseValid` 是可信宿主
  能力，必须连接同 owner/epoch/plain-main/运行开关，不能由模型或配置字符串自证。
- 全部提交在同一 canonical memDir 锁内同步执行；依次复核完整 D validator/digest、目录与 blocks
  身份、epoch/lease/gate/abort、policy、active 根位置、raw SHA256+rev、authority/privacy/Hub/
  residue/origin 和 review 的 dismiss/resolved。review 的容错 sanitizer 不可静默丢掉坏 tombstone
  后授权：E 要求实际 review JSON 与完整 sanitize 结果一致，并保有完全匹配的 live revision 行。
- 自动 rewrite 不使用 `autoEligible` 授权：从冻结 DTO 和宿主私有保管的**真实 generation/coverage
  maxOutputTokens** 独立重算三套 request/input bindings，再调用 B 的唯一异源函数；完整 coverage、
  `p >= 0.90`、body validator/digest 与 authority 都须通过。agent expires 只应用冻结 set/clear 日期，活动
  dateRuleVersion 改变即 stale，不按提交日期重新推导；agent delete 用既有 `isExpired`/本地日历
  规则复核。**user delete 是所有 origin 的硬禁**，确认不能覆盖该禁令；user expires 不自动，
  agent context 不得改写或取代 user。C 的 user delete 恢复拒绝保持不变。
- merge-survivor 的自动首步仍只建议；显式确认后只改 survivor，绝不隐式 retire context。
  retire 可经同入口的宿主既有一次精确确认能力执行真实单边更新。**自动 retire 仍拒绝**：现有
  C0/D retire 联合禁止 generation bundle，不能表达 Q2 三套来源；本包没有伪造 generation 证明，
  没有借 #36 explicit/legacy 路径放行。将来若需自动 retire，须先补经审阅的来源保管契约。
  `consumeConfirmedLocked` 只是未来 B3 既有 capability 的同步消费 seam，缺端口/返回非 true 拒绝；
  测试注入的批准函数不是物理人类/Web 生产确认验收。
- `revision-applier.ts` 是内部 one-attempt adapter；共享 store 的 `prepareBlockReplacement` 与
  supersede 的 `prepareGovernReplacement/prepareSupersedeOne` 纯序列化 seam，同一 now/meta/body
  构造 expected Buffer 与实际临时源。先重做 C prepared 全屏障，再 expected-after 全屏障，随后
  才执行 C strict observed replace 或严格 trash link→source unlink。无 legacy fallback；rename
  已进入却没有成功观察的 opaque I/O 异常为 unknown，trash link 不等于 source 删除。
- C0 唯一必要 append：`RevisionAudit.commitOrigin?` 和 expected-after port 的同名可选输入。
  D 已持久 prepared 的 `origin:p50-suggestion` 必须保持 immutable；否则后续 auto/web 调用重做
  prepared 会 replay-mismatch。`commitOrigin` 在 proposed 屏障中冻结实际提交意图来源，原 origin
  保留提案来源；codec 仅接受原始 string 的封闭枚举，不做 String 强转。E 在所有重放/终态快速
  返回前核对已冻结 commitOrigin 与 request.origin；换来源返回 digest 拒绝，零 applier、零审计改写。
  旧 C 记录缺字段仍可读取/恢复，旧调用不产生该字段；E 不从旧 origin 推断或补造提交来源：
  旧 prepared 可在首次 expected-after 屏障冻结真实来源，已 attempted 的旧记录缺来源则 unavailable。
  旧 C/D 调用和 legacy/off 字节行为保持。未改 wire/fixtures。
- 每批最多 2 个实际动作的限制读同批真实审计，跨 fresh factory/进程仍有效；proposed 与 unknown
  保守占额（可能屏障已完成但没有数据 syscall，也不猜未写）。not-applied 的 skipped 不占额。
  proposed 本身是持久 attempt fence：重入只能报告 unknown/committed，不重跑 applier。写后 gate/
  fsync/audit/观察失败保留实际字节、before/expected-after/双路径证据，不补偿、不清理、不盲重试。
  committed 的幂等返回不再写数据；restored 不复活旧提交权。屏障失败可能留下不完整证据，须人工
  检查，不通过覆盖快照或自动重建证据“修好”。

定向证据：`tests/memory/govern/revision-commit{,-faults,-security}.test.ts` 与独立 helper/worker，
`tests/integration/memory-revision-commit.test.ts`（两个真实 Node 进程在任何提交前冻结，再同时竞争
真实目录锁/CAS；只有一个数据效果，另一个 stale）。覆盖真实 B→D→C→E 自动 user/user 与 agent
rewrite、expires set/clear、确认 retire/merge、严格 delete 及 C raw-byte 恢复，写前/写后实际 syscall
故障、no-clobber 拒绝、双路径未知、晚到门/日期/权限/来源、unknown 占额和 fresh-factory 零重试。
独验返工增加真实文件的 confirmed user delete 零 applier/零正文变更、历史 user delete C 恢复拒绝、
双方来源的各 attempted/终态同源与换源重放矩阵、非法来源类型、旧记录/旧调用字节保持，以及
merge survivor commit→C raw restore 的双向单文件往返。本轮安全修复不扩展 retire 契约；最小证据
保管方案单独位于 `/tmp/p50-e-retire-gap.md`，**完整 E 的批准自动 retire 能力仍待补齐**。
这些是 own `/tmp`、离线受控 provider 协议与注入宿主能力，不是 LIVE/provider/真实 B3 UI 或掉电实验。
同步 I/O 不可抢占、任意同 uid writer 在 syscall 间的竞争、fsync 非绝对掉电保证、F 的生命周期/
缓存失效/来源与真实 tokenizer/cap/认证/usage/proxy conformance 等既有限界仍在。

## #50 E 自动 retire：持久生成规格与历史来源保管（factory-only，2026-11-10）

在 `6d292477` 的两项安全修复上补齐自动 retire 的 factory 链；上述初版的“自动 retire 仍拒绝”
是历史状态。**仍未接 F**：没有 wire/index/settings/默认/auto 开关、生产调度或第二确认 UI 变更。
源 survivor 仍须先通过原 host-confirmed 端口提交；retire 是另一个只改 old target 的单文件动作。

### 契约与历史准入

- 正文 proposal 和源 C audit 追加可选 `generationRequest:{v:1,promptVersion,maxOutputTokens}`。
  D 在真实 generate 前复制并冻结 spec 与 request，成功后复用唯一 body validator，spec 随完整
  生成 bundle 进入 proposalDigest，再由源 prepared 屏障保管，E 之后才可写。字段存在而半 bundle、
  非法版本/cap/digest 不回退旧路径；source commit 也从冻结输入和持久 spec 重算 generation binding。
  旧无字段正文仍读/确认/恢复，不回填 spec，不可作自动 retire 来源。
- `retireEvidence` 是 retire 独享的封闭可选元数据：source 的 batch/action/proposalDigest 引用、
  successorRawDigest、generationRequest/provenance/inputComplete=true/outputDigest 与独立
  coverageRequest；沿用顶层 target/context id/rev、relation/coverage/evidenceBindings。retire 顶层或
  evidence 内均不接 generatedBody/raw/path/额外执行参数；candidate 只取本次真实冻结 successor。
  新增字段全部进完整 digest，getter/toJSON/toString 不执行，坏 revision 整条拒绝而非 strip 后执行。
- `revisionBlockFromRaw` 从既有 live reader 提取纯严格准入，复用无损 UTF-8、parse/重复字段/
  全元数据、secret/private/Hub/residue/origin/active 规则。历史 before/after 与 live reader 用同一
  构造器；Buffer ingress/egress 都复制。它只给 DTO，不授 LIVE；只有真实 locked freeze 可授
  原私有 LIVE 和新的私有 source custody。C 对 D 只消费纯 codec，D 通过注入原 audit port 读 C，
  不引入反向 runtime import、第二审计/建议/费用 owner。

### 源、准备与提交

- source 必须同目录、同受支持 policy、action=merge-survivor、state=committed，file expected-after
  与真实 applied 观察匹配，且**不存在任何 restoreAttempt 字段**。源 audit/before/after/spec/生成
  元数据必须完整；源 context 必须等本次 old target 的 id/rev/rawDigest。restored/unknown/缺观察，
  或手工放回相同 after，均不恢复资格。源 review GC 不影响完整 audit 的正向使用。
- 源 before survivor + 本次 old bytes + 源持久 spec 独立重建 generation；fresh relation 用 old +
  successor-after；fresh coverage 固定 old + successor context + 原样候选 body + 调用前冻结的
  coverage spec。三份 expected 各自重算，不照抄结果、不用当前配置补签；候选须经唯一 validator
  原样 body/digest 通过，脱敏/截断不完整或 partial/unknown 不自动。
- D 的真实 retire prepare 分支仅调用现 A/B client 的新 relation/coverage，**不重跑 generation，
  不消耗新的 generate 槽**；继续原 queue/预算/abort/zombie/费用。每次自动资格复核固定调用一次
  `independentCoverageSources(R,G,C,expected)`，只要求 coverage 分别异于 relation/generation，
  允许 R=G；真实异源 failover 可以通过。同 coverage 来源、低于 `0.90` 或不可信实际身份只建议。
- review 与 E 都在原同一 memDir 锁内重读 source；E 最后 data-syscall 守卫再复核。私有 freeze
  同时保存源 audit 摘要，防止调用后 source/proposal 协同改 spec/provenance 冒充冻结历史。
  source 读取显式区分 qualified / legacy-no-evidence / invalid-unavailable；只有未提供 source，或
  已核对引用/原始输入/输出/既存绑定一致的合法旧 source 缺 spec，才可给 confirmed-only 建议。
  指定 source 缺失、非 committed、引用 digest 错、cap 与历史 binding 不符或任何语义不自洽，在
  freeze 即拒绝，不把 undefined/lack-of-custody 当兼容许可；无 retire review/audit 或确认消费。
  模型始终在锁外；source restore/retire 的锁序决定先后，不宣称两独立动作的跨文件事务。
- E 仍是唯一提交入口，原 applier 不变，只对 old target 写 superseded/supersededBy；successor 与
  source evidence 不写。source 身份/活体 raw+rev/authority/status/位置、owner/epoch/lease/gate、
  dismiss/resolved、全来源 user-delete 硬禁及 commitOrigin 重放规则均保留。缺 retireEvidence 的
  旧合法 retire 仍 confirmed-only；合法但不足自动资格的证据不能凭 autoEligible 越权。
- 当前 admitted pass 的完整 frozen action set 决定 batch，不按动作/重试重造 batch。实际动作最多
  两个，proposed/unknown 保守占额，低置信建议不占实际额；fresh factory/进程不清零。写前两
  全屏障、一次真实 syscall、写后 fsync/finalize、effect-unknown 禁重试/补偿，以及 C raw 恢复协议
  不变。retire 恢复也只恢复 old target 的精确 Buffer。

新证据位于 `tests/memory/govern/revision-retire{,-codec,-faults}.test.ts`、独立 helper/worker 和
`tests/integration/memory-revision-retire.test.ts`：真实 B→D→C→E 源 merge 确认→丢弃工厂/源 review
GC→fresh relation+coverage→自动 retire→raw restore；包含 user↔user、R=G、真实 failover、未知
实际身份/partial/同源拒自动、历史无 spec、getter/闭合/digest/独立 cap/provenance 伪造、源各状态/
真实恢复 intent/恢复后放回 after、最后 syscall 门、同批 unknown cap、模型晚到，以及真实两进程
CAS/源恢复竞争与两个确定锁序。successor 在 retire/恢复动作自身的成功和失败中精确不变。

测试仍是 own `/tmp`、受控离线 registry 协议及 synthetic 实际身份/费用，不是 LIVE provider 或
真实 B3 确认验收；实际 SDK serializer/观察门继续由既有 client-p50-sdk 邻接覆盖。没有扩大 B
helper/validator、引入 provider/client/ledger 或修改 fixtures。同步 syscall 不可抢占、恶意同 uid
跨 syscall 竞争、fsync 非绝对掉电保证及生产 tokenizer/cap/认证/usage/proxy conformance 等既有
限界仍在；本包不能被解释成 F 已上线或自动治理默认开启。

## #50 F S0：有向身份与共享 suppression 基础包（factory-only）

本节只记录最小共享契约，**不是完整 F/selector 上线**。incremental 默认 false、auto 未接线、
job cap 仍默认 0；没有生产 adapter/binding、settings、wire、hook、模型路由或日期 producer 变更。
仅代码/own temporary data 离线验证，不授权真实请求/费用，也不推导 expires。

- D 新 freeze 的 actionId 固定为 SHA256(canonical JSON
  `["p50-action-v2", batchId, [action, [targetId,targetRev,targetRawDigest], contextTripleOrNull]]`)；
  `REVISION_ACTION_ID_VERSION` 导出这个固定域，供后包组合固定 selector policy，不能用时间/页号/nonce
  换 policy 或 job 绕过额度。完整 action set 的 batch 计算与规范排序不变。AB/AC 可相交，反向与
  context 缺省有独立身份；相同有向 row 不允许靠不同 source 复制成两项。
- proposal codec 仍核完整 proposalDigest/封闭 schema/64hex ID，但不再从缺少 raw 的 proposal 重算
  旧 actionId 公式。历史 audit/actionId/proposalDigest/source 引用是 **opaque 原引用**：不迁移路径、
  不重签、不补 generation spec；读取/恢复不采用新公式。可读不授 LIVE，执行仍须匹配 D 私有冻结输入。
  source 的 policy 必须严格等于当前 policy；跨代/非法源明确拒绝，不能降为无 source/plain 建议。
- `jev/index-store.ts::revisionSemanticSuppression(index, subject)` 是原 owner 的唯一只读语义谓词。
  subject 为 `{action, reason?, target:{id,hash}, context?:{id,hash}}`；返回
  `false | "dismissed" | "resolved"`。无 fresh reason 时只核 revision-action key 与 kindless legacy；
  有 reason 时兼容现 legacy keyed/resolved（含 semantic/governance 前缀）、kind/hash/anchor。
  expired→expired-user、budget→oversize，其余按真实 reason；不能为绕 dismiss 改 reason。
  比较副本严格规范裸 block ID、`id.md`、`id.md|section|head`，不猜 basename/跨目录；无法规范者
  保留原严格 hash/anchor/key fallback。head 是生产者未经转义的正文片段，合法换行、`+`、`|`
  不参与 block 身份校验；不能用单行正则或 `split("+")` 拆正文。持久 suggestionKey/anchor/schema 字节不改，无迁移/新表。
  revision dismissal 仅对应 action；typed legacy dismissal 仅对应 fresh kind，duplicate 不全禁后续
  supersedes/retire，kindless 仍保留原跨 kind 语义。普通非 revision 的 mergeReview 分支不变。
- 现 `revisionSuggestionSuppressed` 在原锁中消费同谓词，新增可选第 4 参数 reason；
  D `RevisionPrepareDeps.isSuppressed(input, reason)` 传递本次已声明真实 reason，后包 host 必须转发，
  而非只用 frozen key。现 upsert 锁内、C prepared **之前**重复检查；index merge 的 revision 分支
  同样消费该谓词。E `checkReview` 的入口及最终 beforeSyscall 都重读 live index 并消费同谓词；
  E 原 raw JSON vs sanitize 一致性、LIVE/CAS/权限/来源/lease 门完整保留。

### 留后包的固定状态契约（本包未实现）

原 r2 S0 列出的 selector/DTO helper、C source 枚举 optional seam、contracts 扫描字段、wire/host
job guard、8 目录固定页生命周期、incremental cap 类型、adapter/settings/生产 wire **全部后移**。
不得提交空壳实现后称其完成。selector 的 bounded pool/menu/reducer 接口沿 r2；状态由同一现有
activation/client owner 私有持有，不新建费用 ledger。后包必须满足以下两项实施硬条件：

1. **claim 前后分界**：临时 admission 拒绝保留 pending/dormant，不消费页。claim 成功后任何失败
   （包括零 dispatch、reservation 拒绝）都令该 job 未完成项 blocked-job、不可重入；后续固定页只可
   下一个自然机会推进。全局预算/128 容量阻断 dormant，不能循环 claim、换菜单或淘汰 guard 腾额。
2. **空页与 freeze 分型**：全页 suppressed/无动作立即结束，零 freeze/claim/请求，本次不续页。
   确定性 source/policy/action 拒绝整页 freeze-rejected，合法同行为 blocked、不是已分类；不删失败项
   重造 job。临时锁等待保留同页 pending；输入变化则旧 snapshot invalidated、重建新输入，二者不能
   混成确定性拒绝或复活旧 claim。页/job 状态和 LIVE 不持久化成执行凭据。

后包接口/测试交接见 `/tmp/p50-f-s0.json` 与 selector r2 §13 状态表。后包须真实断言上述调用计数、
状态终态和下一自然机会边界；本包没有伪造 host 测试。现基础证据为
`tests/memory/govern/revision-s0.test.ts`（真实 D→C→review、相交 merge/retire/source、旧公式 source
读取/精确 raw restore、跨 policy 拒绝、generation 等待中新 legacy tombstone 阻止 prepared/save、
E 入口/末 syscall 拦截与不同真实语义正向）以及 `tests/memory/jev/revision-suppression.test.ts`
（纯比较/不改输入 bytes/key、跨 rev/hash/方向、legacy kindless/keyed/resolved/前缀、严格 anchor）。
既有 incremental off 请求/index 差分、Jev off/tool golden 门仍须通过，fixtures 不刷新。

限界不变：测试是 synthetic 离线协议，不是 LIVE provider/生产 F 或物理人类确认验收；同步 syscall
不可抢占、跨 syscall 的恶意同 uid writer 竞争、fsync 非绝对掉电保证。本包不新增定时器、后台追扫、
确认入口或实际数据治理开关；完整 host 公平遍历、job 栅栏与真实 adapter 能力仍未认证。

### S0 R1：真实 legacy anchor 生产者兼容返工

独验 `r_0Y6D89ZX` 的 R1 反例成立：原比较正则误拒 head 换行，且复合 anchorKey 的
`split("+")` 误拆 C++ 等正文。前者是相对旧 `isDismissedRelation` 的回归；后者旧 owner 也
不支持，但本共享契约必须覆盖实际 producer。此前绿测未覆盖该输入，不能作为兼容性证明。

修复只在原 index-store 共享谓词的比较解析：严格解析从字符串起点开始的 block ID/file 前缀，
要求 legacy anchor 的两个 `|`，其余 section/head 当未转义 payload（保留换行/加号/竖线）。
复合 pair 在每个可能的 `+` 边界尝试两个完整严格 block 身份，而不是按所有加号切词。原格式
无法唯一表达正文中形似另一 anchor 的内容；有多个合法解析时，仅保守阻断与其中一个完整候选
pair 相符的 subject，仍受原 typed kind/reason 门约束，不全局禁其它 pair/action。kindless 保留
原跨 kind 语义。比较用原 hashKey 的 arity（entryHash 不含 `+`）区分 singleton/pair，
不会因整个复合串像一个长 head 就禁止该单块所有动作，也不把单块 head 中形似 anchor 的文字
当成 pair 禁令。未知 key 的原精确 fallback 不变。

新增测试通过实际 `parseBlockFile`、`blockAnchor`、`entryHash` 生成历史 tombstone，验证双方
rev/hash 已改变后，换行、C++/A+B、歧义候选及跨目录拒绝；真实锁内 upsert 在 C prepared 前
拦截，generation await 中新增的真实 tombstone 不发布建议。E 入口和 safe-fs 最后
beforeSyscall 均有真实 producer 反例；测试同时证明 raw review 与 sanitize 完全一致，不能借
另一个 fail-closed 门假装共享谓词生效。R1 不改 action-v2、既有 key/schema bytes、持久化
producer、迁移、fixtures 或任何 host/adapter/wire。

## #50 F bounded selector/source/host 内核包（factory-only，2026-11-10）

S0 已提交后的下一包实现了真实可执行内核，**不是生产 F 完成**：新增
`govern/revision-selector.ts` 与 `govern/revision-host.ts`，由未来既有 wireJev activation owner
**恰一次**构造 host，注入其唯一 `JevClientHandle` 与稳定 binding 引用；不另建 client、费用账、
activity owner、hook、timer、确认入口或权限。现 wire/settings/root/adapter/restore slash 未改。

**最新用户决定覆盖此前“默认保持关闭”的最终目标**：后续实际 wire 串行包接线完成时总开关
默认开启，沿用建议模式；auto 正文提交仍 false。不得因为尚未真实付费验收而保持总开关默认关。
本内核包不抢改 settings（当前生产默认仍是原值）；正预算、可信 binding/路由、独立来源、D8、
plain-main/owner/epoch 等门不撤。用户没有授权真实付费验收或任何金额/模型路由；离线正向不提供
生产 tokenizer/模板开销、cap、auth、usage 或代理证明。

### 有界发现与建议语义

- 锁内只严格读 batch 原前16的精确 id/rev/raw，复用 `revisionBlockFromRaw` 与 raw 上限；不补第17块。
  tags 用当前严格块适配器、当前 body hash 且 file 相同的 sidecar + inline +/-，不触发 tagging/soft-meta。
  旧 hint 只接受严格本地 anchor、当前 hash，revision 行另核双方 rev/方向；旧 supersedes a 是 survivor，
  revision a 是 target，旧 p 不作为 fresh。无旧 review 的同 topic、同正文、共享 tag、跨 topic 正分
  lexical Jaccard top2 都可发现，最多本地120 pair；无词法/tag/topic交集的语义关系不承诺召回。
- 固定页最多4 ordinary +2 source，先过滤 source user-old/agent-survivor 再占配额；每 old 对不同
  survivor 的歧义源整项拒绝并诊断，同映射按 opaque source tuple 稳定去重。普通同 authority pair
  预声明 merge +双向 retire（mixed 无 agent 取代 user 方向）；最大14动作，入口/D都硬拒>16。
  同 authority 较小 ID、mixed agent 只是 merge 建议载体，不是覆盖真值或自动权限。
- 全菜单在首模型前 D freeze，同一完整菜单取得同 D batchId/action-v2。普通双向 DTO 复用新纯
  `revisionRelationContextForBlocks`；原 `revisionRelationContext` 输出字节不变。每向 dispatch 前
  独立算 request/input expected，核唯一问题/唯一 source/完整 missing、可信实际身份和精确 digest；
  互换、错 digest、缺身份不生成正文，失败终止该 job 剩余工作。不会把返回 digest 复制为 expected。
- 双向 fresh 唯一 supersedes 仅建议 retire；conflict 仅 merge 建议；双向 covers/无向 duplicate
  仅 bodyless merge，不能按 ID 授权删一侧。普通 retire 无 source 永不 auto，merge 第一阶段永不 auto；
  不生产 pair rewrite、expires 或 delete，不抢原 sweep/archive owner。

### C 唯一只读 seam 与 host 状态门

`RevisionAuditPort.listRetireSourceHintsLocked?()` 是 append-only optional seam，真实 C 工厂复用
Kernel enumerate/read/check 的128 batch/256 total action 硬界、权限/no-follow/raw完整性守卫，
按 `(batchId,actionId)` 返回 committed merge、无任何 restoreAttempt、真实 file expected-after/
commit observation 的 metadata/ref；不返回正文/path/LIVE。旧无 spec 可列举，但只有 D 可判为
legacy-no-evidence，历史提示不含本次 relation/coverage，绝不冒称 fresh。显式坏源或不同 policy
在 D freeze 拒绝，不降无 source。扫描权限/损坏/截断返回 unavailable，不当空；host 保守暂停
整个机会并保留 pending/dormant，不 freeze/claim/模型工作。首次扫描成功前不建立稳定发现池，
只保留有界待扫描目录标记；下一真正自然机会可在 raw/epoch 不变时重新枚举。待扫描目录与
完整 snapshot 合计最多8项，不轮询、不在本批另造 job；诊断对该待扫描状态有界一次。

- host 每 client/activation 至多8目录当前 snapshot；key 只由 identity/epoch、前16 id/rev/rawDigest
  与固定 policy 决定。tags/hints/source 池首次捕获后不随自己写 review/时间戳重排；最新 suppression
  每次实时检查，仍由原共享 `revisionSemanticSuppression`、review 锁内与 E 末 syscall 最终裁决。
  稳定输入下固定队列不重复、页只在下一真正自然机会取；不在当前 handle 内续页、开新 job 追扫。
  公平只在 owner存活、输入稳定、未来自然机会/预算可用、guard容量未满时成立（ordinary最多30页、
  source最多128页）；前16外/无限变化/容量耗尽不承诺公平。
- claim 前临时 admission/gate/锁忙保持 pending，使用原 scheduler `cap-reached` 结果保留证据并 dormant，
  不新增定时器/重试；输入变化另标 invalidated。空页终止本机会，零 freeze/claim/模型，不自动补下页。
  确定性 source/policy/action freeze 拒绝整页 `blocked-freeze`，合法同行不冒称已分类，不重造子菜单。
- full freeze 后同步 claim 同 D job。128项不可淘汰 execution map 不计费，只防重入与扣 G 槽；
  所有终态不可重发。claim 后任何失败（含 reservation/零 dispatch）将未完成项 `blocked-job`，
  同 job 不退款/重放/换 cap；临时全局预算与容量满闭锁进入 dormant，不能 LRU/TTL 腾额。
  `reset(abort|tree|session)` 撤在飞/清页但保留原 client 的 guard；`dispose` 先 dispose 原 client，
  再释放 fences。guard 是单 client/activation 保证，非跨进程持久生成账；原 A 仍独占所有费用/calls。
- 静态最多2个 generation，进入 prepare 前查 lease/共享 suppression/剩余槽；lease 已失效走 bodyless
  planner，零 G。同步 wrapper 再查后调用原 `tryStartGenerate`，成功立即扣不可返还槽；suppression await
  到扣槽间的竞态拒绝保守停，绝不试探第三 G。source 直接复用 D 内部 fresh R/C，不先重发 relation。
  4 ordinary +2 source 的真实离线正例为10 R、2 G、4 C，共16高层调用（不是 provider attempt 上限）。
- 严格全部 discovery→全部 prepare→全部 review/C save→最后 E。save 后锁内读取最终 proposal digest，
  保管原 D frozen，再交 E；不拿保存前 auto hint/JSON 当能力。首次 committed/effect-unknown 即调用
  原 `onAfterWrite(...,"p50-auto")` 并停止本页，之后零模型、零第二自动写；unknown 不盲重试。
  E 持久<=2实际动作门保持（本 host 更保守最多一次效果）。

`IncrementalBatch.limits.jobCostCapUsd` 从 literal0 扩成 number；scheduler 工厂新增可选
`IncrementalDeps.jobCostCapUsd`，只消费宿主显式解析的有限正预算并冻结入 batch，缺省/非法仍0。
没有新增设置、默认路由或生产预算旁路；现生产装配仍未传该 seam。后续 wire 必须将显式已解析
预算冻结进 batch，而非让 host 绕读另一个值；effective-off 不能关闭原 Jev legacy traffic。policy 默认固定组合
`p50-selection-v1/selector-v1/action-v2`，factory 可显式注入既有受支持 policy，不能用时间/nonce/页号
更换 job。source policy 严格相等，不迁移/重签旧源。

### 独验 r_4CG185MQ 返工：scheduler ownership 与首次 unavailable

原自验未覆盖真实 scheduler 的 attempt 回查：`tryStartGenerate` 会再次调用同一 admission，
原 host 的 `!running` 导致初始 true、运行后 false，真实普通生成始终零 G。现在 `canAttempt`
明确区分两条路：新批只在 host 非 running 时准入；运行中只允许**引用相同的已拥有 batch**
执行只读重查，且须已 claim、execution running、epoch/registry/binding/预算/gate/lease 当前有效。
`handle` 仍全程互斥，同 batch 再调用或另一新 batch 均不能并发进入，不能把 recheck 当新授权。

首次 C scan unavailable 曾被 `sources=[]` 固化进稳定 snapshot，使修复权限后同 raw/epoch 永久
漏源；现在未完整枚举的目录只占 pending 标记，不创建固定池或 job。真实 committed 源的
`audit.json` 0644→0600 后，下一个自然机会可发现原引用并走 fresh R/C→C/review→E；无自动重试。

新增 `revision-host-scheduler.test.ts` 使用真实 `createIncrementalScheduler` + `FakeClock`、
显式正 cap seam、原唯一 client/D/C/review/E，不手写 attempt context：普通生成真实 admission
`[true,true]` 后 G/C/审计建议成功；真实预算变化 `[true,false]` 保持 2R、零G/slot0、blocked-job
与 dormant；exact-owned recheck 不接纳并发、epoch/lease 失效仍拒绝。另覆盖 scheduler 的 source
实际 E 效果、首次 unavailable 无 timer/claim/模型，以及同 raw/epoch 在下一外部机会恢复。
原全量绿不能替代这两项反例；本次返工仍需独立复验，不自称原独验已 PASS。

独立新增测试为 `revision-{selector,source-discovery,host-selector}.test.ts` 与 own-temp 离线 helper：
真实注入唯一 client→D→C/review→E 正向及 raw restore，14菜单/16调用、cold跨 topic、方向/权限、
legacy/source坏证据、30页120 pair公平、128 guard满、8目录满、零dispatch blocked、同 job G槽重入、
lease/registry/epoch/restore竞争、全保存先于E与首效果后停止。断言精确 raw/C barrier/最终提案，不以
“不抛异常”充数。原 govern/jev/off、SDK离线、S0、E两进程门仍须通过，fixtures不刷新。
这不是实际 settings→wireMemory/wireJev 正向、生产可信 adapter、native恢复命令或 LIVE 认证；
独立验收后由下一串行装配包完成这些门并统一默认开启。同步 syscall不可抢占、恶意同uid跨 syscall
竞争、fsync非绝对掉电保证、原client晚费用结算等既有限界不变。

## #50 F 实际 settings → wireMemory → wireJev 装配（2026-11-10）

本节覆盖前述 factory 包的“尚未接 wire/settings”历史状态；**不是完整 F/LIVE/provider 认证**。
现有 `wireMemory` 已默认装配 scheduler 的真实 handler/admission，`wireJev` 同 activation 恰一次
构造 `createRevisionHost`，只传它原来创建的唯一 `JevClientHandle`。根 `src/index.ts` 无业务变化，
没有增加 hook、client、费用账、activity owner、建议库或确认 UI。显式旧 handler/admission seam
保留，但生产不依赖它们。native `restore --revision` 入口仍留独立包，本包没有该命令或确认接线。

### 设置、预算和 effective-off

- 最新用户令明确 **`memory.incremental.enabled=true` 默认建议模式**，不以缺 LIVE 阻止翻转；
  **`auto=false`、`jobCostCapUsd=0`**。cap 是显式有限非负 number，保留小数、不整数化、不向上夹取；
  缺省/字符串/负数/NaN/Infinity 一律0。没有新增默认 generation/coverage 路由或金额。
- scheduler 消费已解析 cap 冻结到原 batch.limits；host 所有 R/G/C 使用 D 的同一个 batchId 和
  同 cap，仍只有 A 的不可变 named job 预算。不足预算、queue/zombie/exhausted 不走 legacy 逃逸。
  HC-1/HC-2、host 同client128 job/G fences 和原 E/C 屏障不变。
- plain main、memory/governance/incremental、scopes 实际 runtime/activity/current ctx registry、
  session epoch/gate/signal 和可信 binding 都齐备才生产准入。缺预算/binding 不启动 P50 timer，
  不创建 revision 证据，不把所有旧 ask 卡死。缺 exact quote 的普通 Jev ask 在 **尚未 reservation**
  时可回原 legacy；带 jobId 的 P50 ask 永不这么回退。仍有 controlled reservation/outstanding/
  zombie/exhausted/disposed 时不借 effective-off 绕过共享容量。P50 完全 off 仍走原 client 分支。
- 两个 settings loader 的 D8 同时强制 `incremental.enabled=false / auto=false / jobCostCapUsd=0`；
  wire 另有 independent plain/main gate，child/secure/locked 不构造本 host。显式设置不能绕过。
- 诊断用有限 reason 集、每 session epoch 每 reason 一次：job-budget-zero、activity-owner-unavailable、
  current-registry-missing、provider-contract-missing/binding-invalid/binding-ambiguous、
  streaming-proxy-contract-missing、classify/revision-quote-or-bounds-unavailable 等。没有正文/凭据/模型
  猜测；TUI 只进已有内存 errors/report，非UI main warning。P50 诊断不走现有持久 diag sink、
  不弹窗/写盘/发消息/唤醒/轮询。观察前尚无真实 ctx 的暂态不谎报 registry 缺失。

### 可执行 SDK binding 与真实硬阻塞

`jev/p50-binding.ts::createSdkP50Binding` 是实际执行的窄协议适配器，不是恒 unavailable scaffold。
默认 resolver 只查询当前 SDK `getRegisteredNativeProvider()` 上的
`Symbol.for("pi-subagent:memory-p50-sdk-binding-v1")` 函数；native provider 的 trusted CODE 返回
为**该精确 registry**创建的稳定 binding。`models.json` 的字符串/boolean/自签 trusted 字段均不
作为能力证据。主宿主代码可通过 `WireMemoryOpts.p50BindingResolver` 注入同边界；测试不 mock handler。

构造前 trusted provider 集成必须提供真实、有出处的协议/tokenizer/template contract、纯有界
`quoteInput` 和最终 `countPayload`、有限已核价目、完整 canonical alias 集和具体可执行的
classifier/generation/coverage model 描述。没有隐式 model ID、bytes/2 等启发式或测试4096报价。
SDK 的 model.contextWindow/maxTokens 或方法存在不是这些能力的证明，填写 evidence 字符串本身也
不是证明；只有审计过该 server/serializer/tokenizer 的宿主代码能提供这个 port。

- classifier 支持**经认证的 bounded SystemOne 扩展协议**：在最后 `onPayload` 强制
  `max_output_tokens`、去除冲突 cap、逐字核 state/questions（bool→noul）和 allowlist，再重算 exact
  payload token 上界。恰一次 `registry.classify`、maxRetries=0，保持 SDK request-time auth；
  fetch observer 在 SDK normalization 前读 raw `p50:{provider,model}` 与合法整数 usage。
  raw身份与费用独立；SDK请求model/默认usage0不补证。未知usage按reserve；已核raw counters和已核
  SDK价目/usage一致才known。适配器把同一个原 SDK Promise 交回 A，晚结算仍是原 ledger owner。
- revision 复用原 `createRegistryRevisionTransport`，只追加 optional 最后 payload verifier；本窄
  binding 必须核 exact system/user messages、model、cap 和报价，支持的末跳是已核
  openai-completions/max_tokens。原 raw SSE observer 保持实际身份/unknown usage 的独立判据。
  不通过 SDK 默认 response.model 或 cost0 自证；不增加 auth、retry 或直接 HTTP complete 旁路。
- 实读 SDK 1.5：composed providers 每次 lookup 可生成新的 model 对象。因此绑定检查是
  **registry/provider/method 精确引用 + 完整 model 描述快照**，不是不可能成立的 model 对象引用。
  同registry重映射、描述/价目/serializer变更、provider换代均撤销；不能因新对象相同字段就另造client。
- **stock SDK/SystemOne 不提供上述扩展硬输出 cap、raw实际身份、可信 tokenizer/模板开销或完整
  canonical route 契约。当前没有任何 stock provider 被本包认证。** 缺这些真实能力时生产 P50
  明确 unsupported，旧 Jev 照常工作；这是真正的生产硬阻塞，不是离线测试能消除的条件。
- 非空 Jev proxy 在没有可信 streaming binding 时继续 P50 effective-off。旧 classifier 仍用其
  原 proxy，不清空、不静默直连、不把窄 FetchLike 强转成 streaming fetch。完整 streaming proxy
  adapter/conformance 是独立包；这里不声称 proxy 正向 revision 已上线。

### 生命周期和离线证据

当前真实 ctx 在 Jev 原 observe 路径更新；每次 admission/dispatch/await 都消费实际 registry、
原 scopes runtime/owner epoch、实际 ctx.sessionManager 引用和 gate/signal，不缓存旧 owner 作为授权。
仅 registry 刷新可在下一自然机会重新准入，binding-loss 观察不能重开已被用户 abort 的 scheduler。session/tree/abort 重置
原 host/page，保留同client job/G fences。真实 scopes owner在manager-context替换时可无session/tree事件重建；
原owner signal/activity先撤在飞，新owner的下一自然机会重建其scheduler，写入burst在捕获microtask代际前
同步辨别owner以免丢计数，仍不重建client/host或清job fences。registry/model/provider变化撤销 scheduler signal 和
在飞 host，late结果零review/正文提交。shutdown/reload 由同 owner 先 dispose 原 client，再清 host
fences，A 的原 Promise 仍结算 outstanding/zombie/晚费用；P50-off 保持原 abortBackground 语义。
internal p50-auto effect 回到原 onAfterWrite 的 cwd/cache/activity/origin 路径，撤lease且不自入队。
原handle的有界单槽只保管callback cwd至其finally，不授执行权、不计费；即使实际E效果后发生
同步abort而清了scheduler目录映射，committed/effect-unknown仍失效原cwd缓存，不能漏报真实效果。

证据：`tests/memory/govern/revision-wire.test.ts`（实际 wireMemory/wireJev + 实际 scopes/proof +
SDK ModelRegistry/ModelRuntime + 原scheduler/D/C/review/E），以及
`tests/integration/memory-revision-wire.test.ts` 的实际根 activate。只有 provider/HTTP 边界离线：
local byte-token协议是明确的 synthetic contract，不认证生产 tokenizer 或server付费/cap能力。
正 cap来自真实 parser，实际自然写→quiet→scheduler→唯一client；真实D/E先提交source，再自然批次
fresh R/C→C/review→E retire，零再次G、successor原字节不变、internal write不自触发。
同时验证 cap0/不足cap/缺binding/缺quote/child/scopes-off/secure/locked/off、exact last payload拒绝/
SDK无隐藏重试、registry remap/tree/abort/shutdown/reload的late结果、raw身份和usage独立、原proxy
仍消费所有legacy请求。缺binding与P50-off在同cwd/隔离存储的真实请求、tool回显、index文件和hook/
tool surface逐字节差分；原 frozen fixtures 不改。D8门用fake domain，不冒称真实mount验收。

未完成范围：native revision恢复命令/精确确认预览、生产provider认证/真实tokenizer与价目/路由来源、
streaming proxy、LIVE付费及物理UI。没有实际用户数据/设置变更、install/reload/commit/push。
单client/activation预算不是跨进程绝对费用上限；同uid syscall竞态、不可抢占同步I/O和非绝对掉电
保证等既有限界保持。总开关默认翻转并不授权付费或默认自动改正文。

### F wire 独验 R1：dynamic effective-off 不得绕过 A 的队列与撤权

独验 `r_KJ90J4G4` 的两条反例均真实复现：原 dynamic fallback 只在入队前查一次状态，
`sem.acquire()` 无上限/取消，9 个 sync ask 产生 active3+queued6；dispose 后 queued 请求仍可
发模型并成功。另有 effective-off 排队→controlled named background 在飞→off+abort 形成
A zombie 后，旧 queued fallback 仍 dispatch 的绕过。原自验未覆盖，不能由此前 daily 绿否定。

返工只在原唯一 client 中分开 dynamic fallback 与**完全 P50-off** legacy：

- dynamic fallback 仍用原 sync3/background4 semaphore，每通道最多4个 waiter，第5个立即 budget
  拒绝；无新 pool、费用账或 named-job 旁路。缺 binding/quote 的普通 legacy classifier 仍能运行。
- 入队前即接 lifecycle、caller/epoch、background abort 和同请求总期限；queue 时间计入预算，
  queued 取消立即移除 waiter。原 client 内只保留一个观察到的 registry/capability epoch，
  off/on/off、registry 或 binding 引用变化撤销旧 waiter；未观察到的外部变化不靠猜测补证。
- 出队后和**每个 legacy failover/context-split provider dispatch 前**重新检查该 epoch、signal、
  disposed、A reservations/reservedCalls/reservedCost/outstanding/zombie/exhausted 与 calls/cost
  余额。registry/model/proxy host callbacks在最终检查之前，检查到实际调用之间不插 await。
  dynamic fallback 的 calls 在真实 dispatch 扣减，不再等成功返回才计数，不能用并发在飞绕过 cap。
  legacy 已报告的有限费用由原 Promise 一次观察写回同一usage counter；epoch/caller/dispose撤权
  不能抹掉晚到费用，超全局cap闭锁新准入。它仍只是legacy报告估算，不冒充受认证raw usage。
- dispose/caller/background abort 后的旧结果不能成功；capability 已换代的在飞 legacy 结果只允许
  有界结束，不能再 failover、续发或变成新的 controlled-job 权利。无 quote 的兼容调用仍不是
  受认证 token/cost proof；保留既有 legacy response-usage 口径，不伪造未知 token/usage 为0的证明。
- 完全 `p50` 未传/false 时保留原 legacy unlimited queue、dispose 和输出/usage 字节契约；
  不用修复 dynamic fallback 的名义改变原 off 行为。新用例与原 off golden/请求差分共同证明。

`tests/memory/jev/client-p50-fallback.test.ts` 直接运行真实 client 与原 semaphore/A reservation，
仅 provider original Promise 可控；复现前为6失败/1通过，覆盖上述两个反例、queued4/第5拒绝、
正常 fallback、caller/epoch/background/dispose、实际 A reservation 的 dequeue 拦截、registry
callback 后最后 guard、并发 maxCalls、queue deadline 和完全off parity。未改旧30ms probing测试
阈值、fixtures、C/D/E或任何生产provider认证条件；不将 stock unsupported 改成 ready。

### F wire 窄验 R2：current 同步重入后的最终复检

`r_JR9DPET1` 确认 R1 queue/dispose/zombie 两反例关闭，但指出最后 guard 的真实重入缺口：
`deps.p50.current` 可同步 dispose/abort，仍返回原 capability（包括 undefined）；只比较 epoch
会继续发出 `disposed=true / signal.aborted=true` 的请求。新增真实client用例先复现了这三个
非法 dispatch（dispose/caller abort/background abort），不以 mock guard 替代 provider 边界。

现 `guard.current` 在宿主 callback **返回后**再读 disposed/active.signal/epoch；`guard.check`
读取可能重入的设置值后，再执行一次纯撤权读取，并用最新原 A 余额检查。callOnce 在计 calls
及调用已捕获的 provider 方法前还复核本 attempt signal（包括 callback 同步触发 per-try deadline）。
最后这些读取不再调用宿主 callback，不使用 callback 前的状态作为放行依据。无新授权/账本/pool，
完全off旧链不改。相同cap且无撤权的正常fallback、callback新增A reservation及旧R1反例仍通过。
本轮只跑窄门与strict/types/build/format，不重跑全daily；stock能力和native恢复的未完成边界不变。

## #50 F native 精确 revision 恢复（2026-11-10，离线包）

前述 F wire 的“没有 native revision 恢复”历史限界由本包覆盖；不覆盖生产 provider 认证、
streaming proxy、LIVE 付费或物理 TUI viewport 验收。命令实际注册链为
`wireMemory → createMemCommand → pi.registerCommand("mem", …)`（没有名为
`registerMemoryCommand` 的函数）。只接受 `restore --revision <64-lowercase-hex actionId>`，
在 legacy backup 拒绝及 block/trash 路径之前分派；混合/重复 flag、额外参数一律拒绝。
不新增工具、completion/help 文案、Web read allowlist、owner、审计库或确认系统。

- **真实宿主门先于发现**：`command.ts::restoreNativeRevision` 要求 memory enabled、main、
  `ctx.mode=tui`、hasUI、实际 `ctx.ui.confirm` 且非 Web、actual blocks、write gate。
  `index.ts` 只在既有命令构造处提供可选 `revisionRecovery`，绑定原 scopes/current runtime、
  实际 manager、owner/epoch 与原 lifecycle signal，且只在 plain main/enabled 下提供。
  无 seam/owner、RPC 即使 hasUI=true、child、secure/locked 均在 C preview 前拒绝。
  不从配置 layout 字符串或 provider/budget/auto 状态推导恢复权限；scopes-off 没有 owner 时拒绝。
- **C 唯一只读 preview**：`revision-audit.ts::previewRevisionRestore` 与原 raw 恢复共用
  `Kernel.recovery` 的 bounded enumerate/read；不另写 scanner、不取锁、不创建/修复目录。
  preview 要求 committed、无任何 restoreAttempt、唯一 actionId、完整 before/after/audit 与真实
  applied commit observation，校验当前 exact expected-after；user delete 历史记录仍硬拒。
  返回冻结的字符串/scalar 和冻结 expectedAfter，没有 mutable Buffer。摘要绑定 canonical memory
  identity、blocks/private namespace 的 dev/ino/uid、证据文件身份/权限、原 audit 字节及 raw digest。
- **仅一次原生确认**：展示 canonical memory dir、actionId/batch/target/action、原 expectedRev、
  精确 expectedAfter、before SHA256/字节数与完整原文，明确单目标 raw restoration、不 bump version。
  不持锁等确认；120s clamped/unref timer 与原 signal 竞速不合作 popup，取消/缺失/抛错/超时零恢复写。
  晚到 true 不复活 continuation；这不是物理真人来源证明或新的 B3/Web 授权流。
- **原 C 锁内提交**：确认后重查实际宿主，调用且仅调用原 `restoreRevisionRaw`。
  `RestoreRevisionRequest.expectedAuditDigest?` 是 append-only 的可选 native binding；在原锁内重新
  发现并核对相同证据/命名空间摘要，然后沿用原 raw CAS、durable intent、单次 data syscall 和 final
  marker。省略此字段的原 raw 协议不变；不迁移/重签历史 actionId，不 serialize 原字节。
  同内容 audit inode 或 namespace 替换也使 native 确认过期。retire 只恢复 old，merge 只恢复 survivor。
- **效果与禁重试**：restored/effect-unknown 恰一次回到原 `onAfterWrite(cwd,"revision")`，失效原
  render/Jev/activity 缓存且 internal origin 不自入队；拒绝不报成功、不触发该 callback。
  unknown 明示目标可能已改变、禁止盲重试，C intent/fence 留存，无补偿/force/repair/retry 按钮。
  Web `--revision`（含混合形式）返回专用 `E_MEM_WEB_UNSUPPORTED`，不再误报旧 tidy backup 指引；
  command-policy 仅将精确有效语法标 destructive，其余 unknown，绝不标 read。

证据：`tests/integration/memory-revision-native.test.ts` 通过实际生产注册链及真实 SDK
SessionManager/scopes owner，以原 D/C/E 临时文件生成 committed rewrite/merge/retire/delete，
恢复 BOM/CRLF/非 ASCII/version7 的精确 Buffer，检查单边效果、原 C intent/锁/CAS、原 render/Jev/
activity invalidator；另测 provider/registry 不可用、无 seam、RPC/Web/child/secure、全部语法与
状态拒绝、取消/异常/abort/timeout/late popup、owner/manager/sid/tree/gate 变化、audit 字节/inode/
namespace 替换及最后 syscall 竞争、unknown fence。测试在 `tests/integration/`，按
`tests/tiers.ts::TIER2_DIRS` 显式目录规则归 tier2；另跑 dedicated strict tsc，不改 manifest 或 fixture。

**可选 startup pending-audit 诊断本轮未接**（用户明确保留）：后续若批准，在原自然
`session_start` 内 native/plain/main/enabled/current owner/epoch/gate 检查后，仅对当前 blocks
在原目录锁中调用 C `scanPendingLocked`，输出有界只读 pending/unknown 诊断；绝不跨项目扫描、
自动 finalize/repair/restore 或另加 hook/timer。source discovery 不冒充此 operational scan。

限界沿用 C：同步 syscall 不可抢占，路径/摘要检查不是抵御恶意同 uid writer 任意 syscall 间
替换的文件系统事务，fsync 非绝对掉电保证；native popup 的内容断言不替代真实终端滚动/裁切验收。
本包不读改用户数据/配置，不 install/reload/commit/push，不发送真实模型或网络请求。

## Hub capacity and scopes-on child guidance (#84)

Hub capacity is fixed, not a setting: 32 active items, 4096 UTF-8 body bytes total and 1024 bytes
per item. Only the three exact known local capacity failures receive specific item-count, total-body
or per-item guidance; arbitrary error text is not echoed and uncertain persistence is not overwritten
with a capacity diagnosis. Inspect current Hub items and use actual id/rev and the required human
approval for any authorized cleanup; do not treat guidance as permission.

With scopes on, child project/Hub content remains hard read-only even if the legacy child write opt-in
is true. The child should hand the proposed change to the main session rather than bypassing that gate.
`tests/memory/scopes/{hub-store,hub-commit-approval,tool}.test.ts` and
`tests/memory/{tool,tool-v2,wire}.test.ts` cover the relevant failure surfaces. Source/offline evidence
does not establish that an existing session has loaded the changes.

## #50 I1：实际 Web revision / custody / startup 装配（2026-11-10）

本节覆盖前述 factory 包与 native 恢复包中「Web 未接线 / startup 诊断未接 / streaming 后移」
的历史边界。生产 source 已形成 `wireMemory → wireJev 原 revisionHost → 原 scopes owner →
Web bridge/commands → R4 → 原 E/C` 闭环；不是 stock provider、生产 Hub 部署或付费 LIVE 认证。
`incremental.enabled=true / auto=false / jobCostCapUsd=0` 不变；没有第二 client、费用账、activity
owner、建议库、命令账本、hook、setting 或 wire 字段。根 `src/index.ts` 原 plain 透传已足够，本次未改。

- **能力不是 facade 存在性**：可选 `webWrite` 在 plain/main/memory-on 且任一 scopes 开时构造，
  `capabilities(actualCtx)` 每次只读取现有 current owner/manager/capability/write gate；不造 owner、
  kernel、锁或读取 branch/正文。session-only 返回 sessionAdd，hub-only 不返回 sessionAdd；两者仅在
  原 host 窄端口存在时返回 revisionReview。all-off、无 actual owner、错误 manager、unknown、child、
  secure/locked 均 false。completion 在异步 completer 返回后再读；start 与每次提交仍独立复核。
  旧 `session.add` store/原 gate/结果结构未改，不能把 hub-only facade 当成 session 写权限。
- **唯一 custody 与 NEW command lease**：`WireJevDeps.p50.custody` 只转发 actual scopes owner、SDK
  manager、epoch、原 owner 的稳定 signal 与原 migration/session lifetime/current；不捕获 attempt 或
  execution.running。R2 原 host 仍保管 ORIGINAL 首冻引用，仅经原 C/review 屏障与回读后发布。
  `p50.webReview` 是冻结的只读 `actionLocked` 原闭包，不暴露 reset/dispose，不从历史 JSON 重建 LIVE。
  Web 每次另取真实 MemoryWebCallBinding；同一个惰性 owner kernel、原 proof.activity 的 generation /
  lastActivityAt lease 与自然活动订阅共同撤权，绝不拿 ctx.isIdle 或恒 true 代替该 lease。
- **封闭 Web grammar**：只接 `review` / `review --list`。导航只走认证 Web remote 的 nonce/id/epoch、
  确切选项与 loopback/lan origin，再核 call lease，不 mint receipt、不借 TUI/RPC 或模型人类回合。
  当前同 owner LIVE 才显示 apply；history 仅 view/keep，keep 仍须完整原文确认和原 review CAS。
  `tidy`、旧模型 effect、`review --run`、rebind 均不开放。所有 bare mem 都在 generic SDK slash/capture
  前截获；SDK 重名的 `mem:n` 别名明确拒绝，prompt/held 最终边界也拒绝这些别名，不能逃回 native。
- **效果先于清理**：R4 每步继续用原 receipt/E/C，取消或 finalization 故障不能抹去已 applied /
  unknown。index 在观察到 data/review changed 或 unknown 后恰一次调用原 `onAfterWrite(cwd,"revision")`，
  清原 render/Jev caches 并记录原 activity；内部 origin 不自触发 P50。commands 仍是唯一 32 槽 /
  29min once ledger，顺序是 observe/cancel → ledger settle → finally release；重复 id / queryOnly /
  late / ctl 乱序均不新执行。partial/unknown 在失败 message 的原 R1 codec 中传输，绝不塞 failure data。
- **P1 已接自然 startup**：原 session_start 中，在实际 native TUI/main/plain/enabled/current owner、
  epoch、write gate 通过后，对当前 cwd（含 worktree-origin）的 actual blocks 调一次原 C 锁内扫描。
  无 provider/budget/auto 依赖；仅既有 warning 通道、有问题才发有界 counts/actionId samples。
  锁忙跳过无重试，不创建缺目录，不跨项目、修复、finalize、restore 或写诊断侧车。

### I2 streaming 的条件支持与纯见证边界

已验收的 I2 `84d69e83` 仅在 trusted CODE 提供精确 registry/version/proxy 的标准 streaming
capability 时解除 P50 proxy gate；classifier 仍用原 buffered fetch。revision 走实际 SDK
request-time auth → onPayload 的真实 cap/payload recount → raw SSE observer → 原 Promise/费用账；
不清 proxy、不直连、不缓存凭据、无额外重试。末跳先执行可重入的 current/stream/provider 观察，再由
factory-private binding 与 client-private terminalCurrent 纯见证检查原 data descriptors、SDK public
raw provider/config Map 读口、模型源快照、方法引用、原 epoch/signal/配置，最后立即调用捕获的标准
fetch；不再插入另一个可重入 callback。缺能力、accessor/不匹配/换代均拒绝，不装恒真 witness。

信任的是该已审计 SDK 的 captured public raw readers、native signal accessors 与未被篡改的 JS
intrinsics；任意 custom registry 需履行同一 trusted-CODE pure-reader 契约。恶意 Proxy reflection、
伪 raw reader、SDK 私有对象图/全局 intrinsic 篡改不在保证内；provider 私有可变 catalog 闭包须由
provider 自身认证稳定发布纪律，公开 API 不能替其证明。token/header/queue 资源界不是 heap/tokenizer
认证。**stock tokenizer/template overhead/canonical routes/classifier hard-cap/prices 仍 BLOCKED**；
synthetic byte-token/loopback TLS SDK 门不是生产 provider、认证或付费语义证明。

### I1 离线生产链证据与限界

`tests/integration/memory-i1-startup.test.ts` 直接触发实际 wireMemory 的自然 startup，覆盖原 SDK
scopes、worktree、C 锁扫描、bytes/inodes 与生命周期反例；不再只测 test-owned consumer。
`tests/integration/memory-revision-web-i1.test.ts` 使用 own temp 的真实 SDK/scopes/wire/client/host/D/C/E，
验证能力矩阵、首个真 E 成功后第二拒绝/opaque rename unknown、原缓存失效、internal 不自触发、
实际 activity lease（即便 ctx.isIdle=true）、29min、observe→ledger→release，以及真实 SDK
树导航/reload/new-session 后历史仅 view/keep。新测试均由 integration 目录规则归 tier2。

`node --import tsx scripts/web-hub/memory-revision-confirm-probe.ts` 是独立离线 feature probe：真实
HTTP/SSE、AskUserForm/dialog bridge、生产 reducer/useControl/DetailDock 与上述 SDK/E/C。13 组覆盖
同一 real partial/unknown 样本 direct duplicate / late / queryOnly 的一致 DOM、ctl 乱序/重复、
history on/off、实际旁路 recorder I/O 故障、实际 >30s 确认，以及真实 E 已观察但 ledger 前的
测试宿主 completion barrier >30s、29min、取消后迟到批准、owner/tree/reload 历史边界。barrier 只在
测试宿主，不给生产同步 applier 加 await；不宣称同步 syscall 可抢占或模拟 provider 长执行。
每态 DOM data-cmd-id 与真实 ledger.get(id).id 比较。UI 只存 summary+parsed facts，不双存完整 appendix。
Web mem 独立结果从不依赖 recorder：history off 不构造 recorder；on 的真实 record fault 仅旁路观测，
不伪称 mem record 已保存，也不改变领域效果。浏览器可显式选已存在的离线资产；不可用退出 2，绝非 PASS。
产物在 `/tmp/pi-toolkit-i1-browser-results.json` 及 `/tmp/pi-toolkit-i1-*.{png,html}`。

未对真实 Hub、用户数据/配置或运行中会话 reload；不做 LIVE/付费、安装、commit/push。
未知不重试，无全局回滚；同步 I/O 不可抢占、同 uid syscall 间竞态、fsync 非掉电事务、SDK elsewhere
flush 与单 activation 非绝对费用上限等既有限界保持。离线源码/组件闭环不能证明已部署。
